/**
 * Host-owned World Imagery Wayback releases and point-scoped evidence.
 * The release id is durable; cache entries are never session truth.
 * @module @map-harness/map-container/wayback
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { BasemapSourceId, ESRI_WORLD_IMAGERY_ATTRIBUTION, type BasemapSource } from '@map-harness/map-layers'
import { SourceCatalogError, WaybackCatalogPreparingError } from './source-error.ts'
import { loadVerifiedWaybackRelease, loadWaybackCatalog, saveVerifiedWaybackRelease, saveWaybackCatalog } from './wayback-catalog-store.ts'
import type { WaybackCoreItem, WaybackCoreMetadata, WaybackCoreMetadataIdentity } from './wayback-core.ts'
import { WAYBACK_SOURCE_ID } from './wayback-id.ts'
import { normalizeWaybackCatalogItem, WaybackCatalogDecodeError } from './wayback-catalog-codec.ts'

/** Stable source id for every fixed historical release. */
export { WAYBACK_SOURCE_ID } from './wayback-id.ts'
/** Fixed official WMTS grid. */
export const WAYBACK_MATRIX_SET = 'default028mm'
export { WAYBACK_ENDPOINT } from './wayback-catalog-codec.ts'

/** One official fixed release; acquiredAt is never inferred from publishedAt. */
export interface WaybackRelease {
  readonly releaseId: number
  readonly itemId: string
  readonly title: string
  readonly publishedAt: string
  readonly layerIdentifier: string
  readonly acquiredAt: string | null
}

/** Local release evidence, independent from global catalog ordering. */
export interface WaybackLocalEvidence {
  readonly releaseId: number
  readonly title: string
  readonly publishedAt: string
  readonly acquiredAt: string | null
  readonly provider: string | null
  readonly resolution: string | null
  readonly accuracy: string | null
  readonly point: { readonly lon: number; readonly lat: number }
  readonly zoom: number
}

/** One bounded point sample for a fixed release inside the current view. */
export interface WaybackSample {
  readonly point: { readonly lon: number; readonly lat: number }
  readonly status: 'known' | 'unknown' | 'missing' | 'unavailable'
  readonly acquiredAt: string | null
  readonly provider: string | null
  readonly resolution: string | null
  readonly accuracy: string | null
}

/** A projected view to sample without asserting full-extent coverage. */
export interface WaybackViewport {
  readonly center: readonly [number, number]
  readonly extent: readonly [number, number, number, number]
  readonly wkid: number
}

/** Fixed-release local coverage across the center and four extent corners. */
export interface WaybackCoverage {
  readonly releaseId: number
  readonly viewport: { readonly extent: readonly [number, number, number, number]; readonly wkid: number }
  readonly zoom: number
  readonly coverage: 'sampled' | 'partial' | 'unknown'
  readonly samples: readonly WaybackSample[]
}

/** The user-facing historical source descriptor. */
export type WaybackDescriptor = BasemapSource

/** Configuration for a host Wayback service. */
export interface WaybackConfig {
  readonly cacheTtlMs?: number
  readonly localCacheMaxEntries?: number
  readonly maxConcurrentRequests?: number
  /** Reads the owning source network's concurrency cap; coverage samples must not exceed it. */
  readonly sampleConcurrency?: () => number
  readonly requestTimeoutMs?: number
  readonly now?: () => number
  readonly core?: WaybackCore
  readonly coreFactory?: () => WaybackCore
  readonly coreDispose?: () => Promise<void>
}

/** Injectable official reader; tests must not alter global Wayback configuration. */
export interface WaybackCore {
  getWaybackItems(signal: AbortSignal): Promise<WaybackCoreItem[]>
  getWaybackItemsWithLocalChanges(point: { readonly longitude: number; readonly latitude: number }, zoom: number, signal: AbortSignal): Promise<WaybackCoreItem[]>
  /**
   * Read official metadata for one release and point.
   * @param expected - catalog identity the live official config must still match.
   */
  getMetadata(point: { readonly longitude: number; readonly latitude: number }, zoom: number, releaseNumber: number, signal: AbortSignal, expected?: WaybackCoreMetadataIdentity): Promise<WaybackCoreMetadata | null>
}

/** A disposable official reader can also be supplied at the service edge. */
export type WaybackCoreFactory = () => WaybackCore

const DEFAULT_CONFIG = {
  cacheTtlMs: 300_000,
  maxConcurrentRequests: 4,
  requestTimeoutMs: 15_000,
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  const result = value === undefined ? fallback : value
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result <= 0 || result > maximum) throw new SourceCatalogError('SOURCE_CONFIG_INVALID')
  return result
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null
}

function boundedNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  return value
}

function releaseNumber(value: unknown): number {
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  const number = typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  return number
}

function optionalDate(value: unknown): string | null {
  if (value === null || value === undefined || value === '' || value === 0) return null
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const date = new Date(`${value}T00:00:00Z`)
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null
    }
    if (/^-?\d+$/.test(value)) return optionalDate(Number(value))
    return null
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value)
    return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 1900 ? date.toISOString().slice(0, 10) : null
  }
  return null
}

function measurement(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return String(value)
  return text(value)
}

type CatalogItem = Omit<WaybackCoreItem, 'releaseDatetime'>

function normalizeItem(value: unknown): { release: WaybackRelease; item: CatalogItem } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  const { releaseDatetime: _releaseDatetime, ...item } = value as Partial<WaybackCoreItem>
  if (typeof item.releaseNum !== 'number') throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  releaseNumber(item.releaseNum)
  if (typeof item.releaseDateLabel !== 'string' || item.itemTitle !== `World Imagery (Wayback ${item.releaseDateLabel})`) {
    throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }
  try {
    const result = normalizeWaybackCatalogItem(item)
    return { release: Object.freeze(result.release), item: result.item }
  } catch (error) {
    if (!(error instanceof WaybackCatalogDecodeError)) throw error
    throw new SourceCatalogError(error.reason === 'endpoint' ? 'SOURCE_RESOURCE_DENIED' : 'SOURCE_UNAVAILABLE')
  }
}

/** Build one stable public descriptor from a trusted official release. */
export function waybackDescriptor(release: WaybackRelease): WaybackDescriptor {
  const base: BasemapSource = {
    schemaVersion: 1,
    id: BasemapSourceId(WAYBACK_SOURCE_ID),
    title: release.title,
    provider: 'esri',
    role: 'basemap',
    adapter: 'wmts',
    configDigest: createHash('sha256').update(JSON.stringify({
      sourceId: WAYBACK_SOURCE_ID, releaseId: release.releaseId, itemId: release.itemId,
      title: release.title, publishedAt: release.publishedAt, layerIdentifier: release.layerIdentifier,
      attribution: ESRI_WORLD_IMAGERY_ATTRIBUTION,
    })).digest('hex'),
    nativeWkid: 3857,
    supportsDynamicExport: false,
    supportedModes: ['map'],
    minZoom: 0,
    maxZoom: 23,
    compatibleBasemapIds: [],
    attribution: ESRI_WORLD_IMAGERY_ATTRIBUTION,
    release: { version: String(release.releaseId), publishedAt: release.publishedAt, acquiredAt: release.acquiredAt },
    screenshot: 'allowed',
    automatedMapUse: 'allowed',
    availability: { kind: 'configured' },
    tileAdjustment: null,
  }
  return Object.freeze(base)
}

/** Extract the fixed release from a public descriptor without trusting its id. */
export function waybackReleaseOf(source: BasemapSource): number | null {
  if (source.id !== WAYBACK_SOURCE_ID) return null
  return releaseNumber(source.release.version)
}

/** Validate a complete fixed-release selection against the current official release. */
export function waybackSelectionMatches(source: BasemapSource, release: WaybackRelease): boolean {
  const expected = waybackDescriptor(release)
  return isDeepStrictEqual(source, expected)
}

interface LocalCacheEntry {
  readonly at: number
  readonly value: readonly WaybackLocalEvidence[]
  readonly catalog: readonly WaybackRelease[]
}

type CatalogFailureStage = 'load' | 'fetch' | 'validate' | 'save'

interface CatalogSync {
  readonly path: string
  readonly report: (stage: CatalogFailureStage, error: unknown) => void
  firstAttemptSettled: boolean
  pending: Promise<void> | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Host-owned bounded official Wayback service. */
export interface WaybackService {
  readonly requestTimeoutMs: number
  /** Return the release from the last successful catalog snapshot; never start network I/O. */
  cachedRelease(releaseId: number): WaybackRelease | undefined
  /** Read one independently validated release by exact descriptor identity, without network I/O. */
  verifiedRelease?(releaseId: number, configDigest: string): WaybackRelease | undefined
  /** Persist a release after independent official verification; never changes the catalog. */
  rememberVerifiedRelease?(release: WaybackRelease, configDigest: string): void
  /** Read the last admitted catalog immediately, including after a refresh failure. */
  listReleases(signal?: AbortSignal): readonly WaybackRelease[]
  /** Resolve a fixed release from the local catalog only. */
  release(releaseId: unknown, signal?: AbortSignal): WaybackRelease
  /** Wait for an already-running refresh only when rendering or reading evidence without a snapshot. */
  waitForCatalog(signal?: AbortSignal): Promise<void>
  /** Load the SQLite snapshot and start owned periodic refreshes without awaiting upstream. */
  startCatalogSync(path: string, report: CatalogSync['report']): void
  /** Fetch and admit a complete snapshot in the owner, never on behalf of a read. */
  refreshCatalog(signal?: AbortSignal): Promise<readonly WaybackRelease[]>
  localChanges(point: { readonly lon: number; readonly lat: number }, zoom: number, signal?: AbortSignal): Promise<readonly WaybackLocalEvidence[]>
  metadataAt(point: { readonly lon: number; readonly lat: number }, zoom: number, releaseId: unknown, signal?: AbortSignal): Promise<WaybackLocalEvidence | null>
  /** Check the center and four corners for a fixed release, without asserting whole-extent coverage. */
  coverage(viewport: WaybackViewport, zoom: number, releaseId: unknown, signal?: AbortSignal): Promise<WaybackCoverage>
  dispose(): Promise<void>
}

/** Read-only face used by the source service without owning disposal. */
export type WaybackServiceReader = Omit<WaybackService, 'dispose' | 'refreshCatalog' | 'startCatalogSync'>

/**
 * Create one bounded service; every query has cancellation and a deadline.
 * @param config - cache limits and optional official reader for isolated tests.
 * @returns an independently disposable service.
 */
export function createWaybackService(config: WaybackConfig = {}): WaybackService {
  let coreInstance: WaybackCore | undefined
  const core = (): WaybackCore => {
    coreInstance ??= config.coreFactory?.() ?? config.core
    if (coreInstance === undefined) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    return coreInstance
  }
  const ttl = positiveInteger(config.cacheTtlMs, DEFAULT_CONFIG.cacheTtlMs, 86_400_000)
  const localCacheMaxEntries = positiveInteger(config.localCacheMaxEntries, 64, 256)
  const maxConcurrent = positiveInteger(config.maxConcurrentRequests, DEFAULT_CONFIG.maxConcurrentRequests, 16)
  const timeoutMs = positiveInteger(config.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 120_000)
  let snapshot: readonly WaybackRelease[] | undefined
  let catalogSync: CatalogSync | undefined
  const localCache = new Map<string, LocalCacheEntry>()
  // Verified catalog identity per accepted snapshot release; metadata reads must
  // still match it in the live official config rather than trusting the release
  // number alone. Keying by the release object keeps an in-flight older snapshot
  // bound to its own identity when a newer catalog generation lands first.
  const metadataIdentities = new WeakMap<WaybackRelease, WaybackCoreMetadataIdentity>()
  const active = new Set<AbortController>()
  const operations = new Set<Promise<unknown>>()
  let catalogGeneration = 0
  let cachedGeneration = 0
  let disposed = false
  let disposal: Promise<void> | undefined

  const run = <T>(work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (disposed || signal?.aborted) return Promise.reject(new SourceCatalogError('SOURCE_CANCELLED'))
    if (operations.size >= maxConcurrent) return Promise.reject(new SourceCatalogError('SOURCE_LIMIT_EXCEEDED'))
    const controller = new AbortController()
    active.add(controller)
    const timer = setTimeout(() => controller.abort('deadline'), timeoutMs)
    const onAbort = (): void => controller.abort('caller')
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    const task = Promise.resolve().then(() => work(controller.signal))
    operations.add(task)
    void task.then(() => operations.delete(task), () => operations.delete(task))
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        controller.signal.removeEventListener('abort', onOwnedAbort)
        active.delete(controller)
      }
      const onOwnedAbort = (): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(new SourceCatalogError(controller.signal.reason === 'deadline' ? 'SOURCE_TIMEOUT' : 'SOURCE_CANCELLED'))
      }
      controller.signal.addEventListener('abort', onOwnedAbort, { once: true })
      if (controller.signal.aborted) onOwnedAbort()
      void task.then(value => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }, error => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof SourceCatalogError ? error : new SourceCatalogError('SOURCE_UNAVAILABLE'))
      })
    })
  }

  const ensureActive = (signal?: AbortSignal): void => {
    if (disposed || signal?.aborted) throw new SourceCatalogError('SOURCE_CANCELLED')
  }

  const decodeCatalog = (raw: unknown): { releases: readonly WaybackRelease[]; items: readonly CatalogItem[] } => {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 256) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    const entries = Array.from(raw, normalizeItem).sort((left, right) =>
      right.release.publishedAt.localeCompare(left.release.publishedAt) || left.release.releaseId - right.release.releaseId)
    const releases = Object.freeze(entries.map(({ release }) => release))
    if (new Set(releases.map(item => item.releaseId)).size !== releases.length
      || new Set(releases.map(item => item.itemId)).size !== releases.length) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    for (const { release, item } of entries) {
      metadataIdentities.set(release, Object.freeze({ itemId: item.itemID, metadataLayerUrl: item.metadataLayerUrl }))
    }
    return { releases, items: entries.map(({ item }) => item) }
  }

  const refreshCatalog = async (signal?: AbortSignal): Promise<readonly WaybackRelease[]> => {
    let stage: CatalogFailureStage = 'fetch'
    const generation = ++catalogGeneration
    try {
      const raw = await run(ownedSignal => core().getWaybackItems(ownedSignal), signal)
      ensureActive(signal)
      stage = 'validate'
      const { releases, items } = decodeCatalog(raw)
      if (generation > cachedGeneration) {
        if (catalogSync !== undefined) {
          stage = 'save'
          saveWaybackCatalog(catalogSync.path, items)
        }
        snapshot = releases
        cachedGeneration = generation
      }
      return releases
    } catch (error) {
      if (!disposed && !signal?.aborted) catalogSync?.report(stage, error)
      throw error
    }
  }

  const startCatalogSync = (path: string, report: CatalogSync['report']): void => {
    ensureActive()
    if (catalogSync !== undefined) throw new Error('Wayback catalog synchronization has already started')
    const sync: CatalogSync = { path, report, firstAttemptSettled: false, pending: undefined, timer: undefined }
    catalogSync = sync
    try {
      const saved = loadWaybackCatalog(path)
      if (saved !== undefined) snapshot = decodeCatalog(saved).releases
    } catch (error) {
      report('load', error)
    }
    const settle = (): void => {
      sync.firstAttemptSettled = true
      sync.pending = undefined
      if (!disposed) sync.timer = setTimeout(tick, ttl).unref()
    }
    const tick = (): void => {
      sync.timer = undefined
      sync.pending = refreshCatalog().then(settle, settle)
    }
    tick()
  }

  const waitForCatalog = async (signal?: AbortSignal): Promise<void> => {
    ensureActive(signal)
    const pending = catalogSync?.pending
    if (snapshot !== undefined || pending === undefined) return
    if (signal === undefined) return pending
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => reject(new SourceCatalogError('SOURCE_CANCELLED'))
      signal.addEventListener('abort', onAbort, { once: true })
      void pending.then(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      })
    })
  }

  const listReleases = (signal?: AbortSignal): readonly WaybackRelease[] => {
    ensureActive(signal)
    if (snapshot !== undefined) return snapshot
    if (catalogSync?.firstAttemptSettled === false) throw new WaybackCatalogPreparingError()
    throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }

  const release = (releaseId: unknown, signal?: AbortSignal): WaybackRelease => {
    const id = releaseNumber(releaseId)
    const found = listReleases(signal).find(item => item.releaseId === id)
    if (found === undefined) throw new SourceCatalogError('SOURCE_NOT_FOUND')
    return found
  }

  const localChanges = async (point: { readonly lon: number; readonly lat: number }, zoom: number, signal?: AbortSignal): Promise<readonly WaybackLocalEvidence[]> => {
    boundedNumber(point.lon, -180, 180)
    boundedNumber(point.lat, -85.0511287798066, 85.0511287798066)
    const normalizedZoom = Math.round(boundedNumber(zoom, 10, 23))
    await waitForCatalog(signal)
    const catalog = listReleases(signal)
    const key = JSON.stringify([point.lon, point.lat, normalizedZoom])
    const cached = localCache.get(key)
    const now = config.now ?? Date.now
    if (cached !== undefined && cached.catalog === catalog && now() - cached.at < ttl) return cached.value
    return run(async ownedSignal => {
      const items = await core().getWaybackItemsWithLocalChanges({ longitude: point.lon, latitude: point.lat }, normalizedZoom, ownedSignal)
      if (ownedSignal.aborted || !Array.isArray(items) || items.length > 256) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
      const releases = items.map(item => normalizeItem(item).release)
      const official = new Map(catalog.map(item => [item.releaseId, item]))
      if (new Set(releases.map(item => item.releaseId)).size !== releases.length
        || releases.some(item => !isDeepStrictEqual(item, official.get(item.releaseId)))) throw new SourceCatalogError('SOURCE_CHANGED')
      // The normalized release cannot carry the metadata layer; bind the live
      // item identity separately so a changed official config is not mistaken
      // for the verified catalog. The expected identity comes from the catalog
      // snapshot this call captured, never from a newer cached generation.
      const drifting = items.some(value => {
        const expected = metadataIdentities.get(official.get(value.releaseNum)!)
        return expected === undefined || expected.itemId !== value.itemID || expected.metadataLayerUrl !== value.metadataLayerUrl
      })
      if (drifting) throw new SourceCatalogError('SOURCE_CHANGED')
      const evidence = Object.freeze(releases.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.releaseId - b.releaseId).map(item => Object.freeze({
        releaseId: item.releaseId, title: item.title, publishedAt: item.publishedAt, acquiredAt: null,
        provider: null, resolution: null, accuracy: null, point: Object.freeze({ ...point }), zoom: normalizedZoom,
      })))
      if (!ownedSignal.aborted && !disposed) {
        if (!localCache.has(key) && localCache.size >= localCacheMaxEntries) localCache.delete(localCache.keys().next().value!)
        localCache.set(key, { at: now(), value: evidence, catalog })
      }
      return evidence
    }, signal)
  }

  const readMetadata = async (
    point: { readonly lon: number; readonly lat: number },
    zoom: number,
    item: WaybackRelease,
    signal: AbortSignal,
  ): Promise<WaybackLocalEvidence | null> => {
    const identity = metadataIdentities.get(item)
    if (identity === undefined) throw new SourceCatalogError('SOURCE_CHANGED')
    const raw: WaybackCoreMetadata | null = await core().getMetadata({ longitude: point.lon, latitude: point.lat }, zoom, item.releaseId, signal, identity)
    if (signal.aborted) throw new SourceCatalogError('SOURCE_CANCELLED')
    if (raw === null) return null
    return {
      releaseId: item.releaseId, title: item.title, publishedAt: item.publishedAt, acquiredAt: optionalDate(raw.date),
      provider: text(raw.provider), resolution: measurement(raw.resolution), accuracy: measurement(raw.accuracy),
      point: { ...point }, zoom,
    }
  }

  const metadataAt = async (point: { readonly lon: number; readonly lat: number }, zoom: number, releaseId: unknown, signal?: AbortSignal): Promise<WaybackLocalEvidence | null> => {
    boundedNumber(point.lon, -180, 180)
    boundedNumber(point.lat, -85.0511287798066, 85.0511287798066)
    const normalizedZoom = Math.round(boundedNumber(zoom, 10, 23))
    await waitForCatalog(signal)
    const item = release(releaseId, signal)
    return run(ownedSignal => readMetadata(point, normalizedZoom, item, ownedSignal), signal)
  }

  const toWgs84 = (point: readonly [number, number], wkid: number): { readonly lon: number; readonly lat: number } => {
    if (wkid === 4326) return { lon: point[0], lat: point[1] }
    if ([3857, 102100, 102113].includes(wkid)) {
      const radius = 6_378_137
      return {
        lon: point[0] / radius * 180 / Math.PI,
        lat: (2 * Math.atan(Math.exp(point[1] / radius)) - Math.PI / 2) * 180 / Math.PI,
      }
    }
    throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  }

  const coverage = async (viewport: WaybackViewport, zoom: number, releaseId: unknown, signal?: AbortSignal): Promise<WaybackCoverage> => {
    const normalizedZoom = Math.round(boundedNumber(zoom, 10, 23))
    if (!Array.isArray(viewport.center) || viewport.center.length !== 2
      || !Array.isArray(viewport.extent) || viewport.extent.length !== 4
      || ![...viewport.center, ...viewport.extent].every(value => typeof value === 'number' && Number.isFinite(value))) {
      throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    }
    const [minX, minY, maxX, maxY] = viewport.extent
    if (minX >= maxX || minY >= maxY) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    const id = releaseNumber(releaseId)
    const points = [
      toWgs84([viewport.center[0], viewport.center[1]], viewport.wkid),
      toWgs84([minX, minY], viewport.wkid),
      toWgs84([minX, maxY], viewport.wkid),
      toWgs84([maxX, minY], viewport.wkid),
      toWgs84([maxX, maxY], viewport.wkid),
    ]
    boundedNumber(points[0]!.lon, -180, 180)
    boundedNumber(points[0]!.lat, -85.0511287798066, 85.0511287798066)
    await waitForCatalog(signal)
    const item = release(id, signal)
    const requestedSampleConcurrency = config.sampleConcurrency?.() ?? points.length
    const sampleLimit = Math.max(1, Math.min(points.length,
      Number.isFinite(requestedSampleConcurrency) ? Math.floor(requestedSampleConcurrency) : points.length))
    const evidence = await run(async ownedSignal => {
      const controller = new AbortController()
      const onAbort = (): void => controller.abort(ownedSignal.reason)
      ownedSignal.addEventListener('abort', onAbort, { once: true })
      if (ownedSignal.aborted) onAbort()
      const requests = new Map<string, Promise<WaybackLocalEvidence | null | undefined>>()
      const forPoint = (point: { readonly lon: number; readonly lat: number }): Promise<WaybackLocalEvidence | null | undefined> => {
        const key = JSON.stringify([point.lon, point.lat])
        const existing = requests.get(key)
        if (existing !== undefined) return existing
        const request = point.lon < -180 || point.lon > 180 || point.lat < -85.0511287798066 || point.lat > 85.0511287798066
          ? Promise.resolve(undefined)
          : readMetadata(point, normalizedZoom, item, controller.signal)
        requests.set(key, request)
        return request
      }
      const samples: Array<WaybackLocalEvidence | null | undefined> = new Array(points.length)
      let failed = false
      let next = 0
      const settle = async (): Promise<void> => {
        while (!failed && next < points.length) {
          const index = next
          next += 1
          samples[index] = await forPoint(points[index]!)
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(sampleLimit, points.length) }, settle))
      } catch (error) {
        failed = true
        controller.abort('sample-failed')
        if (!ownedSignal.aborted) await Promise.allSettled(requests.values())
        throw error
      } finally {
        ownedSignal.removeEventListener('abort', onAbort)
      }
      return samples
    }, signal)
    const decoded = evidence.map((item, index): WaybackSample => item === undefined
      ? { point: points[index]!, status: 'unavailable', acquiredAt: null, provider: null, resolution: null, accuracy: null }
      : item === null
        ? { point: points[index]!, status: 'missing', acquiredAt: null, provider: null, resolution: null, accuracy: null }
      : {
          point: points[index]!, status: item.acquiredAt === null ? 'unknown' : 'known',
          acquiredAt: item.acquiredAt, provider: item.provider, resolution: item.resolution, accuracy: item.accuracy,
        })
    const statuses = new Set(decoded.map(sample => sample.status))
    const knownDates = new Set(decoded.flatMap(sample => sample.acquiredAt === null ? [] : [sample.acquiredAt]))
    // The panel claims "dates or metadata differ", so metadata must take part
    // in the decision: same-day samples from different providers or
    // resolutions are not agreement.
    const knownMetadata = new Set(decoded.flatMap(sample => sample.status === 'known'
      ? [JSON.stringify([sample.provider, sample.resolution, sample.accuracy])] : []))
    const coverageState = (statuses.has('missing') && statuses.has('known')) || knownDates.size > 1 || knownMetadata.size > 1
      ? 'partial'
      : statuses.has('unknown') || statuses.has('unavailable') || statuses.has('missing') ? 'unknown' : 'sampled'
    return Object.freeze({
      releaseId: id,
      viewport: { extent: Object.freeze([...viewport.extent]) as readonly [number, number, number, number], wkid: viewport.wkid },
      zoom: normalizedZoom,
      coverage: coverageState,
      samples: Object.freeze(decoded),
    })
  }

  return {
    requestTimeoutMs: timeoutMs,
    cachedRelease(releaseId) {
      if (disposed) return undefined
      return snapshot?.find(item => item.releaseId === releaseId)
    },
    listReleases,
    release,
    verifiedRelease(releaseId, configDigest) {
      ensureActive()
      if (catalogSync === undefined) return undefined
      try {
        return loadVerifiedWaybackRelease(catalogSync.path, releaseId, configDigest)
      } catch (error) {
        catalogSync.report('load', error)
        if (error instanceof SourceCatalogError) throw error
        throw new SourceCatalogError('SOURCE_UNAVAILABLE')
      }
    },
    rememberVerifiedRelease(release, configDigest) {
      ensureActive()
      if (catalogSync === undefined) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
      try {
        saveVerifiedWaybackRelease(catalogSync.path, release, configDigest)
      } catch (error) {
        catalogSync.report('save', error)
        if (error instanceof SourceCatalogError) throw error
        throw new SourceCatalogError('SOURCE_UNAVAILABLE')
      }
    },
    waitForCatalog,
    startCatalogSync,
    refreshCatalog,
    localChanges,
    metadataAt,
    coverage,
    dispose() {
      if (disposal !== undefined) return disposal
      disposed = true
      clearTimeout(catalogSync?.timer)
      const pending = catalogSync?.pending
      snapshot = undefined
      localCache.clear()
      for (const controller of active) controller.abort('dispose')
      disposal = (async () => {
        try {
          await config.coreDispose?.()
        } finally {
          await Promise.allSettled([...operations, pending])
        }
      })()
      return disposal
    },
  }
}
