/**
 * Host-half visual observation: the pending-wait registry that pairs a
 * `map_observe` tool execution with one client-captured screenshot of the
 * session's map at an exact revision. The client occurrence sees the
 * projection's `observationRequest`, captures `view.takeScreenshot()`, and
 * submits the PNG through the `/api/map/observation` fetch route this module
 * registers when the host Connection is present; pure-Node hosts (tests)
 * submit programmatically through the same service.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Cordis service name for the observation registry. */
export const MAP_OBSERVATION_SERVICE = 'mapObservation'

/** Maximum accepted screenshot bytes (PNG); larger submissions refuse loudly. */
export const MAX_OBSERVATION_BYTES = 8 * 1024 * 1024

/** The bounded outcome of one observation wait. */
export type MapObservationOutcome =
  | {
    readonly status: 'observed'
    readonly png: Uint8Array
    /** Map revision the capture depicts (the request's revision). */
    readonly revision: number
    /** The receipt's rendered revision — must equal the request's revision. */
    readonly renderedRevision: number
    /** The concrete view that rendered the capture. */
    readonly viewId: string
  }
  | { readonly status: 'timeout' }
  | { readonly status: 'cancelled' }

/** One validated client submission. */
export interface MapObservationSubmission {
  readonly sessionId: string
  readonly callId: string
  readonly requestSeq: number
  readonly renderedRevision: number
  readonly viewId: string
  /** Base64-encoded PNG bytes of the capture. */
  readonly pngBase64: string
}

/** Why one submission was refused. */
export type ObservationSubmitRefusal =
  | 'no-pending-request'
  | 'session-mismatch'
  | 'call-mismatch'
  | 'stale-revision'
  | 'malformed-png'
  | 'oversized'

/** The host observation service surface. */
export interface MapObservationService {
  /**
   * Wait for one client capture. Resolves on submission, timeout, or caller
   * cancellation — never rejects.
   */
  waitFor(sessionId: string, callId: string, revision: number, timeoutMs: number, signal: AbortSignal): Promise<MapObservationOutcome>
  /** Submit one capture; the pairing, session, and revision freshness are validated here. */
  submit(submission: MapObservationSubmission): { readonly ok: true } | { readonly ok: false; readonly code: ObservationSubmitRefusal; readonly detail: string }
  /** The number of currently pending waits (diagnostics). */
  readonly pendingCount: number
}

/** One registered wait with its resolver. */
interface PendingWait {
  readonly sessionId: string
  readonly callId: string
  readonly revision: number
  readonly expiresAt: number
  resolve(outcome: MapObservationOutcome): void
}

/**
 * Create the observation service. Pure and carrier-free: the fetch route and
 * the projection field are wired by the plugin, this registry only pairs.
 * @param now - clock for expiry enforcement.
 * @returns the service surface.
 */
export function createMapObservationService(now: () => number = () => Date.now()): MapObservationService {
  const pending = new Map<string, PendingWait>()

  const keyOf = (sessionId: string, callId: string): string => `${sessionId}\n${callId}`

  const sweepExpired = (): void => {
    const current = now()
    for (const [key, wait] of pending) {
      if (wait.expiresAt <= current) {
        pending.delete(key)
        wait.resolve({ status: 'timeout' })
      }
    }
  }

  const service: MapObservationService = {
    get pendingCount(): number {
      sweepExpired()
      return pending.size
    },
    waitFor(sessionId, callId, revision, timeoutMs, signal) {
      sweepExpired()
      return new Promise<MapObservationOutcome>(resolve => {
        const entry: PendingWait = {
          sessionId,
          callId,
          revision,
          expiresAt: now() + timeoutMs,
          resolve: outcome => {
            pending.delete(keyOf(sessionId, callId))
            resolve(outcome)
          },
        }
        pending.set(keyOf(sessionId, callId), entry)
        const timer = setTimeout(() => entry.resolve({ status: 'timeout' }), timeoutMs)
        const onAbort = (): void => {
          clearTimeout(timer)
          entry.resolve({ status: 'cancelled' })
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    },
    submit(submission) {
      sweepExpired()
      const { sessionId, callId, requestSeq, renderedRevision, viewId, pngBase64 } = submission
      if (typeof sessionId !== 'string' || typeof callId !== 'string' || typeof requestSeq !== 'number' || typeof renderedRevision !== 'number' || typeof viewId !== 'string' || typeof pngBase64 !== 'string') {
        return { ok: false, code: 'malformed-png', detail: 'submission fields are malformed' }
      }
      const key = keyOf(sessionId, callId)
      const wait = pending.get(key)
      if (wait === undefined) {
        return { ok: false, code: 'no-pending-request', detail: `no pending observation for session ${sessionId} call ${callId}` }
      }
      if (renderedRevision !== wait.revision) {
        return { ok: false, code: 'stale-revision', detail: `capture depicts revision ${renderedRevision}; the request awaits revision ${wait.revision}` }
      }
      const png = decodeBase64(pngBase64)
      if (png === undefined) {
        return { ok: false, code: 'malformed-png', detail: 'the capture is not valid base64' }
      }
      if (png.length === 0 || png.length > MAX_OBSERVATION_BYTES) {
        return { ok: false, code: 'oversized', detail: `the capture is ${png.length} bytes; the bound is ${MAX_OBSERVATION_BYTES}` }
      }
      const signature = Array.from(png.slice(0, 8)).map(byte => byte.toString(16).padStart(2, '0')).join('')
      if (signature !== '89504e470d0a1a0a') {
        return { ok: false, code: 'malformed-png', detail: 'the capture does not carry a PNG signature' }
      }
      pending.delete(key)
      wait.resolve({ status: 'observed', png, revision: wait.revision, renderedRevision, viewId })
      return { ok: true }
    },
  }
  return service
}

/** The minimal host Connection fetch surface this module registers through. */
interface ConnectionFetchSurface {
  readonly fetch?: {
    register(route: {
      readonly path: string
      readonly methods: readonly ['POST']
      readonly requestBody: 'buffered' | 'streaming'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

/**
 * Register the `/api/map/observation` submission route when the host
 * Connection is present. The route is the only client→host surface: it
 * validates nothing about the caller's identity (the Connection carrier owns
 * trust and authentication) and everything about the pairing.
 * @param ctx - host root context.
 * @param service - the observation registry the route submits into.
 * @returns the async disposer, or `undefined` when no Connection is mounted.
 */
export function registerObservationRoute(ctx: Context, service: MapObservationService): (() => Promise<void>) | undefined {
  // Optional access: pure-Node hosts mount no Connection, and the plugin must
  // not require one —  reads absent services as undefined.
  const connection = ctx.get('connection', false) as ConnectionFetchSurface | undefined
  if (connection?.fetch === undefined) return undefined
  return connection.fetch.register({
    path: '/api/map/observation',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return Response.json({ ok: false, code: 'malformed-png', detail: 'the body is not JSON' }, { status: 400 })
      }
      const verdict = service.submit(body as MapObservationSubmission)
      return Response.json(verdict, { status: verdict.ok ? 200 : 409 })
    },
  })
}

/** Carrier-free base64 decode; invalid input returns `undefined`. */
function decodeBase64(value: string): Uint8Array | undefined {
  if (value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) return undefined
  let buffer = ''
  const bytes: number[] = []
  for (const character of value) {
    if (character === '=') break
    const code = BASE64_ALPHABET.indexOf(character)
    if (code === -1) return undefined
    buffer += code.toString(2).padStart(6, '0')
    while (buffer.length >= 8) {
      bytes.push(Number.parseInt(buffer.slice(0, 8), 2))
      buffer = buffer.slice(8)
    }
  }
  return Uint8Array.from(bytes)
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
