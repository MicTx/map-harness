/**
 * Browser owner of the official Wayback release catalog: one shared request at a time,
 * a versioned last-good record in BrowserStorage, and immutable snapshots for React-free subscription.
 * Only public catalog data is fetched, held in memory, and persisted.
 * @module @map-harness/map-container/client/wayback-catalog
 */
import type { BrowserStorage } from '@deepseek-ai/dsh-client-store'
import {
  WAYBACK_CATALOG_STORAGE_KEY,
  WAYBACK_CONFIG_URL,
  WaybackCatalogDecodeError,
  decodeWaybackCatalog,
  readWaybackCatalogRecord,
  writeWaybackCatalogRecord,
  type WaybackCatalogRelease,
} from '../wayback-catalog-codec.ts'

export { WAYBACK_CATALOG_STORAGE_KEY }

/** Why the latest load attempt did not produce a fresh catalog; fixed values only, never upstream text. */
export type WaybackCatalogReason =
  | 'storage' /** The persisted record is unreadable, or the last-good record could not be written. */
  | 'http' /** The response status is not 200. */
  | 'redirect' /** The request was redirected. */
  | 'network' /** The request or body stream failed. */
  | 'timeout' /** The request exceeded `timeoutMs` and was aborted. */
  | 'oversized' /** The body exceeded `maxBodyBytes`. */
  | 'invalid' /** The body is not an intact official catalog. */
  | 'aborted' /** The caller cancelled its own wait. */
  | 'disposed' /** The owner was disposed. */

/** Immutable owner state; `ready` keeps the last verified releases even when a refresh fails. */
export interface WaybackCatalogSnapshot {
  readonly phase: 'empty' | 'ready'
  readonly releases: readonly WaybackCatalogRelease[]
  /** Clock time in milliseconds of the successful fetch behind `releases`; null while empty. */
  readonly fetchedAt: number | null
  readonly digest: string | null
  /** True only while a request is in flight. */
  readonly refreshing: boolean
  readonly reason: WaybackCatalogReason | null
}

/** Injected dependencies; timers and the network are never global state. */
export interface WaybackCatalogOwnerOptions {
  readonly storage: BrowserStorage
  /** Fetch implementation; defaults to the current realm's `fetch`. */
  readonly fetch?: typeof globalThis.fetch
  /** Clock in milliseconds; defaults to `Date.now`. */
  readonly now?: () => number
  /** A verified catalog younger than this is reused without a request. */
  readonly ttlMs: number
  /** Request deadline, including the body stream. */
  readonly timeoutMs: number
  /** Largest accepted response body in bytes. */
  readonly maxBodyBytes: number
  /** Logical storage key; defaults to `WAYBACK_CATALOG_STORAGE_KEY`. */
  readonly storageKey?: string
}

/** Narrow subscription surface; bridge it to `ctx.resources` or `useSyncExternalStore`. */
export interface WaybackCatalogOwner {
  /** @param listener - Called after each published snapshot change. @returns Idempotent removal. */
  subscribe(listener: () => void): () => void
  /** @returns The current snapshot; referentially stable until the next change. */
  getSnapshot(): WaybackCatalogSnapshot
  /**
   * Reuse a fresh catalog or request one; concurrent callers share the in-flight request.
   * @param signal - Cancels this caller's wait only; the shared request continues for others.
   * @returns The settled snapshot; never rejects.
   */
  ensureFresh(signal?: AbortSignal): Promise<WaybackCatalogSnapshot>
  /** Request a new catalog regardless of the TTL; joins an in-flight request. @returns The settled snapshot; never rejects. */
  refresh(): Promise<WaybackCatalogSnapshot>
  /** Abort the in-flight request and release listeners; later calls report `disposed`. */
  dispose(): void
}

const REQUEST_INIT: Omit<RequestInit, 'signal'> = Object.freeze({
  method: 'GET',
  mode: 'cors',
  credentials: 'omit',
  referrerPolicy: 'no-referrer',
  redirect: 'error',
  cache: 'no-store',
  headers: Object.freeze({ accept: 'application/json' }),
})

const EMPTY: WaybackCatalogSnapshot = Object.freeze({
  phase: 'empty', releases: Object.freeze([]), fetchedAt: null, digest: null, refreshing: false, reason: null,
})

function positiveInteger(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Wayback catalog option ${name} must be a positive integer`)
  }
}

function loadStored(storage: BrowserStorage, key: string): WaybackCatalogSnapshot {
  try {
    const raw = storage.getItem(key)
    if (raw === null) return EMPTY
    const record = readWaybackCatalogRecord(raw)
    if (record !== null) {
      return Object.freeze({
        phase: 'ready', releases: record.catalog.releases, fetchedAt: record.fetchedAt, digest: record.catalog.digest, refreshing: false, reason: null,
      })
    }
  } catch (_storageReadFailed: unknown) {
    return Object.freeze({ ...EMPTY, reason: 'storage' })
  }
  return Object.freeze({ ...EMPTY, reason: 'storage' })
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = response.headers.get('content-length')
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes) throw new BodyTooLargeError()
  if (response.body === null) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw new BodyTooLargeError()
    return text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const parts: string[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        // A failed cancel leaves the stream to the response's own teardown; the size refusal stands.
        try {
          await reader.cancel()
        } catch (error) {
          if (!(error instanceof Error)) throw error
        }
        throw new BodyTooLargeError()
      }
      parts.push(decoder.decode(value, { stream: true }))
    }
    parts.push(decoder.decode())
    return parts.join('')
  } finally {
    reader.releaseLock()
  }
}

class BodyTooLargeError extends Error {
  constructor() {
    super('Wayback catalog body exceeded the byte limit')
    this.name = 'BodyTooLargeError'
  }
}

/**
 * Create one catalog owner with its own request, cache, and listeners.
 * @param options - Storage, fetch, clock, and limits; every limit must be a positive integer.
 * @throws TypeError when a limit is not a positive integer or storage is absent.
 */
export function createWaybackCatalogOwner(options: WaybackCatalogOwnerOptions): WaybackCatalogOwner {
  const { storage } = options
  if (typeof storage !== 'object' || storage === null) throw new TypeError('Wayback catalog option storage is required')
  positiveInteger(options.ttlMs, 'ttlMs')
  positiveInteger(options.timeoutMs, 'timeoutMs')
  positiveInteger(options.maxBodyBytes, 'maxBodyBytes')
  const fetcher = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const now = options.now ?? (() => Date.now())
  const storageKey = options.storageKey ?? WAYBACK_CATALOG_STORAGE_KEY

  let snapshot = EMPTY
  let storedLoaded = false
  let inflight: { promise: Promise<WaybackCatalogSnapshot>; controller: AbortController } | undefined
  let disposed = false
  const listeners = new Set<() => void>()

  const publish = (next: WaybackCatalogSnapshot): void => {
    snapshot = Object.freeze(next)
    let failure: unknown
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) queueMicrotask(() => { throw failure })
  }

  const request = async (signal: AbortSignal): Promise<WaybackCatalogSnapshot> => {
    try {
      if (!snapshot.refreshing) publish({ ...snapshot, refreshing: true, reason: null })
      const response = await fetcher(WAYBACK_CONFIG_URL, { ...REQUEST_INIT, signal })
      if (response.redirected || (response.url !== '' && response.url !== WAYBACK_CONFIG_URL)) {
        return { ...snapshot, refreshing: false, reason: 'redirect' }
      }
      if (response.status !== 200) return { ...snapshot, refreshing: false, reason: 'http' }
      const body = await readBoundedBody(response, options.maxBodyBytes)
      signal.throwIfAborted()
      const catalog = decodeWaybackCatalog(body)
      const fetchedAt = now()
      let reason: WaybackCatalogReason | null = null
      try {
        storage.setItem(storageKey, writeWaybackCatalogRecord(catalog, fetchedAt))
      } catch (_storageWriteFailed: unknown) {
        reason = 'storage'
      }
      return { phase: 'ready', releases: catalog.releases, fetchedAt, digest: catalog.digest, refreshing: false, reason }
    } catch (error) {
      if (signal.aborted) return { ...snapshot, refreshing: false, reason: 'timeout' }
      if (error instanceof BodyTooLargeError) return { ...snapshot, refreshing: false, reason: 'oversized' }
      if (error instanceof WaybackCatalogDecodeError) return { ...snapshot, refreshing: false, reason: 'invalid' }
      return { ...snapshot, refreshing: false, reason: 'network' }
    }
  }

  const run = (force: boolean): Promise<WaybackCatalogSnapshot> => {
    if (disposed) return Promise.resolve({ ...snapshot, refreshing: false, reason: 'disposed' })
    if (!storedLoaded) {
      storedLoaded = true
      const restored = loadStored(storage, storageKey)
      if (restored !== EMPTY) publish(restored)
    }
    if (inflight === undefined && (force || snapshot.fetchedAt === null || now() < snapshot.fetchedAt || now() - snapshot.fetchedAt >= options.ttlMs)) {
      const controller = new AbortController()
      const promise = request(AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeoutMs)])).then(settled => {
        inflight = undefined
        const outcome = disposed ? { ...snapshot, refreshing: false, reason: 'disposed' as const } : settled
        if (!disposed) publish(outcome)
        return outcome
      })
      inflight = { controller, promise }
    }
    return inflight?.promise ?? Promise.resolve(snapshot)
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    async ensureFresh(signal) {
      const settled = await run(false)
      return signal?.aborted ? { ...settled, reason: 'aborted' } : settled
    },
    refresh: () => run(true),
    dispose() {
      if (disposed) return
      disposed = true
      inflight?.controller.abort()
      listeners.clear()
    },
  }
}
