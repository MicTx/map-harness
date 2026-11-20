/**
 * Host-half visual observation: the bounded pairing registry that binds one
 * accepted `map_observe` tool execution to one client capture of the exact
 * same session/call/request-seq/revision. The flow is claim-then-capture:
 * the client occurrence claims the pending request (early claims park in a
 * bounded pool until the tool's {@link MapObservationService.waitFor} admits
 * the matching one and issues an opaque token), captures the view, and
 * submits the token plus its capture receipt through the single
 * `/api/map/observation` POST route this module registers when the host
 * Connection is present. Pure-Node hosts (tests) submit programmatically
 * through the same service.
 *
 * A wrong token or seq never consumes the valid wait; decline and wire
 * cancellation need the claim token; the ONE PNG decode happens inside an
 * async submit that revalidates the live entry, deadline, signal, and the
 * tool's trusted current-map snapshot (`readCurrent`) after the decode
 * boundary. Pure-Node hosts pass `readCurrent` as the projected-state
 * snapshot; untrusted submissions are validated field-by-field — never cast.
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { BasemapSelection } from '@map-harness/map-layers'
import {
  mapObservationCaptureSchema,
  type MapObservationCaptureShape,
  type ObservationComposition,
  type ObservationSource,
} from './observation-protocol.ts'
import { admitObservationPng } from './observation-png.ts'

/** Cordis service name for the observation registry. */
export const MAP_OBSERVATION_SERVICE = 'mapObservation'

/** Default limits the plugin resolves from config. */
export interface MapObservationLimits {
  /** Maximum accepted screenshot bytes. */
  readonly maxBytes: number
  /** Maximum decoded pixel count. */
  readonly maxPixels: number
  /** Maximum decoded width or height. */
  readonly maxDimension: number
  /** Maximum pending waits. */
  readonly maxPending: number
  /** Maximum parked early claims. */
  readonly maxEarlyClaims: number
}

/** The resolved default limits (positive integers; pending bounds cap at 1024). */
export const DEFAULT_OBSERVATION_LIMITS: MapObservationLimits = Object.freeze({
  maxBytes: 8_388_608,
  maxPixels: 16_777_216,
  maxDimension: 8_192,
  maxPending: 64,
  maxEarlyClaims: 64,
})

/** The absolute ceiling for pending waits and early claims. */
export const MAX_OBSERVATION_PENDING = 1024

/**
 * Compatibility export of the default PNG byte bound; deployments resolve
 * their own `maxBytes` through the plugin config, so this constant names
 * only the DEFAULT ceiling.
 */
export const MAX_OBSERVATION_BYTES = DEFAULT_OBSERVATION_LIMITS.maxBytes

/** The capture receipt fields the client attests inside one submission. */
export type MapObservationCapture = MapObservationCaptureShape

/** Why the client declined a pending request instead of capturing it. */
export type ObservationDeclineCode = 'no-view' | 'not-ready' | 'stale' | 'policy' | 'capture-failed' | 'oversized' | 'invalid-image'

/** One validated client submission (capture or decline; the wire adds a cancel action). */
export type MapObservationSubmission =
  | {
    readonly kind: 'capture'
    readonly sessionId: string
    readonly callId: string
    readonly requestSeq: number
    readonly revision: number
    readonly token: string
    readonly capture: MapObservationCapture
  }
  | {
    readonly kind: 'decline'
    readonly sessionId: string
    readonly callId: string
    readonly requestSeq: number
    readonly token: string
    readonly code: ObservationDeclineCode
  }

/** The trusted current-map snapshot the owning tool supplies per wait. */
export interface MapObservationCurrent {
  /** The live `observationRequest`, or `null` when none is pending. */
  readonly request: { readonly callId: string; readonly requestSeq: number; readonly revision: number } | null
  /** The current projected map revision. */
  readonly revision: number
  /** The host-computed expected sources for the live layer set. */
  readonly sources: readonly ObservationSource[]
  /** Exact accepted selection when the host resolved a version-2 capture. */
  readonly basemap?: BasemapSelection | null
  /** Host-derived visible-layer presentation identity at capture time. */
  readonly composition?: ObservationComposition
  /** Whether the current interaction still owns the capture. */
  readonly captureAllowed: boolean
}

/** The bounded outcome of one observation wait. */
export type MapObservationOutcome =
  | {
    readonly status: 'observed'
    readonly png: Uint8Array
    /** Lowercase hex sha256 of the admitted PNG. */
    readonly sha256: string
    /** Decoded PNG width (equals the receipt's imageSize.width). */
    readonly width: number
    /** Decoded PNG height. */
    readonly height: number
    /** Map revision the capture depicts (the request's revision). */
    readonly revision: number
    /** The receipt's rendered revision — must equal the request's revision. */
    readonly renderedRevision: number
    /** The concrete view that rendered the capture. */
    readonly viewId: string
    /** The client's attested capture receipt. */
    readonly capture: MapObservationCapture
    /** Host-derived visible-layer presentation identity at capture time. */
    readonly composition?: ObservationComposition
  }
  | { readonly status: 'timeout' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'declined'; readonly code: ObservationDeclineCode }
  | { readonly status: 'stale' }
  | { readonly status: 'full' }

/** One wait admission request (one object per the protocol contract). */
export interface MapObservationWait {
  readonly sessionId: string
  readonly callId: string
  readonly requestSeq: number
  readonly revision: number
  readonly expiresAtMs: number
  readonly signal: AbortSignal
  /**
   * Runtime-only snapshot of the trusted current map, re-read after every
   * async boundary inside submit: the live request identity, revision,
   * host-computed expected sources, and resolved capture permission.
   * Required: an absent or thrown snapshot fails closed as stale.
   */
  readonly readCurrent: () => MapObservationCurrent | undefined
}

/** One claim admission request; the client waits for the matching wait. */
export interface MapObservationClaim {
  readonly sessionId: string
  readonly callId: string
  readonly requestSeq: number
  readonly revision: number
  readonly expiresAtMs: number
  readonly signal: AbortSignal
}

/** The claim verdict: an opaque host token on admission. */
export type MapObservationClaimOutcome =
  | { readonly status: 'claimed'; readonly token: string }
  | { readonly status: 'timeout' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'conflict' }
  | { readonly status: 'full' }

/** One cancellation identity; releases the matching early claim and wait. */
export interface MapObservationCancel {
  readonly sessionId: string
  readonly callId: string
  readonly requestSeq: number
}

/** Why one submission was refused. */
export type ObservationSubmitRefusal =
  | 'no-pending-request'
  | 'malformed'
  | 'wrong-token'
  | 'stale-revision'
  | 'oversized'
  | 'busy'

/** One synchronous wire cancellation carrying the claim token. */
export interface MapObservationWireCancel extends MapObservationCancel {
  readonly token: string
}

/** The host observation service surface. */
export interface MapObservationService {
  /** Wait for one client capture. Resolves on submission, timeout, decline, cancellation, supersession, or capacity — never rejects. */
  waitFor(wait: MapObservationWait): Promise<MapObservationOutcome>
  /** Claim one request; resolves once a matching wait admits this claim and issues its token. */
  claim(claim: MapObservationClaim): Promise<MapObservationClaimOutcome>
  /** Release every early claim and pending wait for one exact identity (trusted in-process cleanup). */
  cancel(cancel: MapObservationCancel): void
  /** Release a pending wait only when the wire cancel carries its claim token. */
  cancelWire(cancel: MapObservationWireCancel): { readonly ok: true } | { readonly ok: false; readonly code: ObservationSubmitRefusal; readonly detail: string }
  /** Submit one capture or decline; pairing, token, receipt, bytes, and post-decode freshness are validated here. */
  submit(submission: MapObservationSubmission): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: ObservationSubmitRefusal; readonly detail: string }>
  /** The number of currently pending waits (diagnostics). */
  readonly pendingCount: number
  /** The number of currently parked early claims (diagnostics). */
  readonly earlyClaimCount: number
  /** Release every pending wait, early claim, timer, and listener (plugin dispose). */
  dispose(): void
}

interface PendingWait {
  readonly identity: string
  readonly revision: number
  readonly expiresAt: number
  readonly readCurrent: () => MapObservationCurrent | undefined
  readonly signal: AbortSignal
  timer?: ReturnType<typeof setTimeout>
  readonly abort: () => void
  resolve(outcome: MapObservationOutcome): void
  claimToken?: string
  /** Reserved while one submission's async validation is in flight. */
  validating: boolean
}

interface EarlyClaim {
  readonly identity: string
  readonly revision: number
  readonly expiresAt: number
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort: () => void
  resolve(outcome: MapObservationClaimOutcome): void
}

const identityOf = (sessionId: string, callId: string, requestSeq: number): string =>
  `${sessionId}\n${callId}\n${requestSeq}`

const DECLINE_CODES: ReadonlySet<string> = new Set(['no-view', 'not-ready', 'stale', 'policy', 'capture-failed', 'oversized', 'invalid-image'])

/** Whether one unknown wire code is an authored observation decline. */
function isDeclineCode(value: unknown): value is ObservationDeclineCode {
  return typeof value === 'string' && DECLINE_CODES.has(value)
}

/** Whether one unknown value is a nonnegative integer. */
function nonnegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Whether two client/host source lists agree field-for-field. */
function sourcesEqual(actual: readonly ObservationSource[], expected: readonly ObservationSource[]): boolean {
  return actual.length === expected.length && actual.every((source, index) => {
    const target = expected[index]
    return target !== undefined && source.id === target.id && source.kind === target.kind
      && source.version === target.version && source.attribution === target.attribution && source.policy === target.policy
  })
}

function basemapsEqual(actual: BasemapSelection | null | undefined, expected: BasemapSelection | null | undefined): boolean {
  return JSON.stringify(actual ?? null) === JSON.stringify(expected ?? null)
}

/** Whether two host-derived composition identities agree field-for-field. */
function compositionsEqual(actual: ObservationComposition | undefined, expected: ObservationComposition | undefined): boolean {
  return (actual === undefined && expected === undefined)
    || (actual !== undefined && expected !== undefined && JSON.stringify(actual) === JSON.stringify(expected))
}

/** Canonical RFC 4648 base64: syntax, trailing '=' placement, and a codec round-trip. */
function decodeBase64Canonical(value: string): Uint8Array | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return undefined
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value) return undefined
  return new Uint8Array(bytes)
}

/**
 * Create the observation service.
 * @param limits - resolved policy/limits (positive integers; pending bounds capped at 1024).
 * @param now - clock for expiry enforcement.
 * @param mintToken - opaque host token factory (default cryptographic).
 * @returns the service surface.
 */
export function createMapObservationService(
  limits: MapObservationLimits = DEFAULT_OBSERVATION_LIMITS,
  now: () => number = () => Date.now(),
  mintToken: () => string = () => randomBytes(16).toString('hex'),
): MapObservationService {
  const pending = new Map<string, PendingWait>()
  const claims = new Map<string, EarlyClaim>()
  let disposed = false

  const dropWait = (identity: string, outcome: MapObservationOutcome): void => {
    const wait = pending.get(identity)
    if (wait === undefined) return
    pending.delete(identity)
    if (wait.timer !== undefined) clearTimeout(wait.timer)
    wait.abort()
    wait.resolve(outcome)
  }

  const dropClaim = (identity: string, outcome: MapObservationClaimOutcome): void => {
    const claim = claims.get(identity)
    if (claim === undefined) return
    claims.delete(identity)
    clearTimeout(claim.timer)
    claim.abort()
    claim.resolve(outcome)
  }

  const sweep = (): void => {
    const current = now()
    for (const [key, wait] of pending) {
      if (wait.expiresAt <= current) dropWait(key, { status: 'timeout' })
    }
    for (const [key, claim] of claims) {
      if (claim.expiresAt <= current) dropClaim(key, { status: 'timeout' })
    }
  }

  const service: MapObservationService = {
    get pendingCount(): number {
      sweep()
      return pending.size
    },
    get earlyClaimCount(): number {
      sweep()
      return claims.size
    },
    waitFor(wait) {
      sweep()
      const { sessionId, callId, requestSeq, revision, expiresAtMs, signal, readCurrent } = wait
      const identity = identityOf(sessionId, callId, requestSeq)
      return new Promise<MapObservationOutcome>(resolve => {
        if (disposed || signal.aborted) {
          resolve({ status: 'cancelled' })
          return
        }
        if (typeof readCurrent !== 'function' || !nonnegativeInt(revision)) {
          resolve({ status: 'stale' })
          return
        }
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now()) {
          resolve({ status: 'timeout' })
          return
        }
        if (pending.has(identity)) {
          resolve({ status: 'stale' })
          return
        }
        if (pending.size >= limits.maxPending) {
          resolve({ status: 'full' })
          return
        }
        const entry: PendingWait = {
          identity,
          revision,
          expiresAt: Math.min(expiresAtMs, now() + 60_000 * 2),
          readCurrent,
          signal,
          abort: () => signal.removeEventListener('abort', onAbort),
          resolve: outcome => resolve(outcome),
          validating: false,
        }
        entry.timer = setTimeout(() => dropWait(identity, { status: 'timeout' }), Math.max(1, entry.expiresAt - now()))
        const onAbort = (): void => dropWait(identity, { status: 'cancelled' })
        signal.addEventListener('abort', onAbort, { once: true })
        pending.set(identity, entry)
        // Admit a parked early claim for this exact identity; a mismatched
        // revision claims conflict rather than silently surviving.
        const early = claims.get(identity)
        if (early !== undefined) {
          if (early.expiresAt <= now()) {
            dropClaim(identity, { status: 'timeout' })
          } else if (early.revision === revision) {
            entry.claimToken = mintToken()
            dropClaim(identity, { status: 'claimed', token: entry.claimToken })
          } else {
            dropClaim(identity, { status: 'conflict' })
          }
        }
      })
    },
    claim(claim) {
      sweep()
      const { sessionId, callId, requestSeq, revision, expiresAtMs, signal } = claim
      const identity = identityOf(sessionId, callId, requestSeq)
      return new Promise<MapObservationClaimOutcome>(resolve => {
        if (disposed || signal.aborted) {
          resolve({ status: 'cancelled' })
          return
        }
        if (!nonnegativeInt(revision) || !Number.isFinite(expiresAtMs) || expiresAtMs <= now()) {
          resolve({ status: 'timeout' })
          return
        }
        const wait = pending.get(identity)
        if (wait !== undefined) {
          if (wait.revision !== revision || wait.claimToken !== undefined) {
            resolve({ status: 'conflict' })
            return
          }
          wait.claimToken = mintToken()
          resolve({ status: 'claimed', token: wait.claimToken })
          return
        }
        const early = claims.get(identity)
        if (early !== undefined && early.expiresAt <= now()) dropClaim(identity, { status: 'timeout' })
        if (claims.has(identity)) {
          resolve({ status: 'conflict' })
          return
        }
        if (claims.size >= limits.maxEarlyClaims) {
          resolve({ status: 'full' })
          return
        }
        const expiresAt = Math.min(expiresAtMs, now() + 60_000 * 2)
        const entry: EarlyClaim = {
          identity,
          revision,
          expiresAt,
          timer: setTimeout(
            () => dropClaim(identity, { status: 'timeout' }),
            Math.max(1, expiresAt - now()),
          ),
          abort: () => signal.removeEventListener('abort', onAbort),
          resolve: outcome => resolve(outcome),
        }
        const onAbort = (): void => dropClaim(identity, { status: 'cancelled' })
        signal.addEventListener('abort', onAbort, { once: true })
        claims.set(identity, entry)
      })
    },
    cancel(cancel) {
      const identity = identityOf(cancel.sessionId, cancel.callId, cancel.requestSeq)
      dropClaim(identity, { status: 'cancelled' })
      dropWait(identity, { status: 'cancelled' })
    },
    cancelWire(cancel) {
      const identity = identityOf(cancel.sessionId, cancel.callId, cancel.requestSeq)
      const wait = pending.get(identity)
      if (wait === undefined) {
        return { ok: false, code: 'no-pending-request', detail: 'no pending observation for this identity' }
      }
      if (wait.claimToken === undefined || wait.claimToken !== cancel.token) {
        return { ok: false, code: 'wrong-token', detail: 'the cancellation does not carry this wait\'s claim token' }
      }
      dropWait(identity, { status: 'cancelled' })
      return { ok: true }
    },
    async submit(submission) {
      sweep()
      const identity = identityOf(submission.sessionId, submission.callId, submission.requestSeq)
      const wait = pending.get(identity)
      if (wait === undefined) {
        return { ok: false, code: 'no-pending-request', detail: `no pending observation for session ${submission.sessionId} call ${submission.callId} seq ${submission.requestSeq}` }
      }
      if (submission.kind === 'decline') {
        if (!DECLINE_CODES.has(submission.code)) {
          return { ok: false, code: 'malformed', detail: 'the decline code is unknown' }
        }
        if (wait.claimToken === undefined || wait.claimToken !== submission.token) {
          return { ok: false, code: 'wrong-token', detail: 'the decline does not carry this wait\'s claim token' }
        }
        dropWait(identity, { status: 'declined', code: submission.code })
        return { ok: true }
      }
      const { revision, token } = submission
      if (wait.claimToken === undefined || wait.claimToken !== token) {
        return { ok: false, code: 'wrong-token', detail: 'the submission does not carry this wait\'s claim token' }
      }
      if (!nonnegativeInt(revision)) {
        return { ok: false, code: 'malformed', detail: 'the submission revision is not a nonnegative integer' }
      }
      if (wait.validating) {
        return { ok: false, code: 'busy', detail: 'a submission for this wait is already validating' }
      }
      wait.validating = true
      try {
        // Guard the untrusted capture before reading any receipt field.
        const rawCapture: unknown = submission.capture
        const captureFields = bodyFields(rawCapture)
        if (captureFields === undefined) {
          return { ok: false, code: 'malformed', detail: 'the capture receipt is missing or is not an object' }
        }
        const pngBase64 = captureFields.pngBase64
        if (typeof pngBase64 !== 'string' || pngBase64.length === 0) {
          return { ok: false, code: 'malformed', detail: 'the capture has no PNG payload' }
        }
        const encodedBound = 4 * Math.ceil(limits.maxBytes / 3)
        if (pngBase64.length > encodedBound) {
          return { ok: false, code: 'oversized', detail: 'the encoded capture exceeds the configured byte bound' }
        }
        const parsedCapture = mapObservationCaptureSchema.safeParse(rawCapture)
        if (!parsedCapture.success) {
          return { ok: false, code: 'malformed', detail: `the capture receipt is invalid: ${parsedCapture.error.issues[0]?.message ?? 'schema refusal'}` }
        }
        const capture = parsedCapture.data
        if (revision !== wait.revision || capture.renderedRevision !== wait.revision) {
          return { ok: false, code: 'stale-revision', detail: `capture depicts revision ${capture.renderedRevision}; the request awaits revision ${wait.revision}` }
        }
        let currentBeforeDecode: MapObservationCurrent | undefined
        try {
          currentBeforeDecode = wait.readCurrent()
        } catch {
          currentBeforeDecode = undefined
        }
        const currentRequestBeforeDecode = currentBeforeDecode?.request
        if (currentBeforeDecode === undefined || currentBeforeDecode.revision !== wait.revision
          || currentRequestBeforeDecode === null || currentRequestBeforeDecode === undefined
          || currentRequestBeforeDecode.callId !== submission.callId
          || currentRequestBeforeDecode.requestSeq !== submission.requestSeq
          || currentRequestBeforeDecode.revision !== wait.revision
          || !currentBeforeDecode.captureAllowed) {
          dropWait(identity, { status: 'stale' })
          return { ok: true }
        }
        const basemapBeforeDecode = currentBeforeDecode.basemap
      const compositionBeforeDecode = currentBeforeDecode.composition
        if (!sourcesEqual(capture.sources, currentBeforeDecode.sources)) {
          return { ok: false, code: 'malformed', detail: 'the capture sources do not match the trusted map' }
        }
        const png = decodeBase64Canonical(pngBase64)
        if (png === undefined) {
          return { ok: false, code: 'malformed', detail: 'the capture is not canonical base64' }
        }
        if (png.length === 0 || png.length > limits.maxBytes) {
          return { ok: false, code: 'oversized', detail: `the capture is ${png.length} bytes; the bound is ${limits.maxBytes}` }
        }
        // The ONE decode: strict PNG admission with dimension agreement.
        const admitted = await admitObservationPng(png, limits, capture.imageSize)
        if (!admitted.ok) {
          const code = admitted.code === 'oversized' || admitted.code === 'dimension-mismatch' ? 'oversized' : 'malformed'
          return { ok: false, code, detail: `the capture image failed admission: ${admitted.code}` }
        }
        // Post-decode freshness: the SAME live entry must still hold, its
        // deadline still pending, and the trusted current map unchanged.
        if (pending.get(identity) !== wait) {
          return { ok: false, code: 'stale-revision', detail: 'the pending request settled during decode' }
        }
        if (wait.expiresAt <= now()) {
          dropWait(identity, { status: 'timeout' })
          return { ok: false, code: 'stale-revision', detail: 'the request expired during decode' }
        }
        if (wait.signal.aborted) {
          return { ok: false, code: 'stale-revision', detail: 'the request was cancelled during decode' }
        }
        let current: MapObservationCurrent | undefined
        try {
          current = wait.readCurrent()
        } catch {
          current = undefined
        }
        if (current === undefined || current.revision !== wait.revision) {
          dropWait(identity, { status: 'stale' })
          return { ok: true }
        }
        const currentRequest = current.request
        if (currentRequest === null || currentRequest.callId !== submission.callId
          || currentRequest.requestSeq !== submission.requestSeq || currentRequest.revision !== wait.revision) {
          dropWait(identity, { status: 'stale' })
          return { ok: true }
        }
        if (!current.captureAllowed || !sourcesEqual(capture.sources, current.sources)) {
          dropWait(identity, { status: 'stale' })
          return { ok: true }
        }
        if (basemapBeforeDecode !== undefined && current.basemap !== undefined
          && !basemapsEqual(basemapBeforeDecode, current.basemap)) {
          dropWait(identity, { status: 'stale' })
          return { ok: true }
        }
        if (!compositionsEqual(compositionBeforeDecode, current.composition)) {
          dropWait(identity, { status: 'stale' })
          return { ok: true }
        }
        dropWait(identity, {
          status: 'observed',
          png,
          sha256: admitted.sha256,
          width: admitted.width,
          height: admitted.height,
          revision: wait.revision,
          renderedRevision: capture.renderedRevision,
          viewId: capture.viewId,
          capture,
          ...(compositionBeforeDecode === undefined ? {} : { composition: compositionBeforeDecode }),
        })
        return { ok: true }
      } finally {
        wait.validating = false
      }
    },
    dispose() {
      disposed = true
      for (const key of [...claims.keys()]) dropClaim(key, { status: 'cancelled' })
      for (const key of [...pending.keys()]) dropWait(key, { status: 'cancelled' })
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

/** Validate the request body is an object with the named fields' base types. */
function bodyFields(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  return body as Record<string, unknown>
}

/** Whether the submission identity triple is well-formed. */
function identityOk(fields: Record<string, unknown>): boolean {
  return typeof fields.sessionId === 'string' && fields.sessionId.length > 0 && fields.sessionId.length <= 256
    && typeof fields.callId === 'string' && fields.callId.length > 0 && fields.callId.length <= 256
    && Number.isSafeInteger(fields.requestSeq) && nonnegativeInt(fields.requestSeq)
}

/** Whether one JSON object contains only the fields an action accepts. */
function exactKeys(fields: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(fields).every(key => keys.includes(key))
}

/**
 * Serve one observation claim, cancel, decline, or capture submission on the
 * single `/api/map/observation` POST route. Every field is validated before
 * reaching the service; the body bound derives from the resolved byte limit
 * plus a bounded receipt allowance — never an unrelated fixed ceiling.
 */
export async function serveObservationRequest(
  request: Request,
  service: MapObservationService,
  limits: Pick<MapObservationLimits, 'maxBytes'> = DEFAULT_OBSERVATION_LIMITS,
): Promise<Response> {
  const encodedBound = 4 * Math.ceil(limits.maxBytes / 3)
  const bodyBound = encodedBound + 512 * 1024
  const declaredLength = request.headers.get('content-length')
  if (declaredLength !== null && Number.isFinite(Number(declaredLength)) && Number(declaredLength) > bodyBound) {
    return Response.json({ ok: false, code: 'oversized', detail: 'submission body exceeds the bound' }, { status: 413 })
  }
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > bodyBound) {
    return Response.json({ ok: false, code: 'oversized', detail: 'submission body exceeds the bound' }, { status: 400 })
  }
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return Response.json({ ok: false, code: 'malformed', detail: 'the body is not JSON' }, { status: 400 })
  }
  const fields = bodyFields(body)
  if (fields === undefined) {
    return Response.json({ ok: false, code: 'malformed', detail: 'the body is not an object' }, { status: 400 })
  }
  const action = fields.action
  if (action === 'claim' || action === 'cancel') {
    const allowed = action === 'claim'
      ? ['action', 'sessionId', 'callId', 'requestSeq', 'revision', 'expiresAtMs']
      : ['action', 'sessionId', 'callId', 'requestSeq', 'token']
    if (!exactKeys(fields, allowed)) {
      return Response.json({ ok: false, code: 'malformed', detail: 'the action contains unknown fields' }, { status: 400 })
    }
    if (!identityOk(fields)) {
      return Response.json({ ok: false, code: 'malformed', detail: 'claim fields are malformed' }, { status: 400 })
    }
    const sessionId = fields.sessionId
    const callId = fields.callId
    const requestSeq = fields.requestSeq
    if (typeof sessionId !== 'string' || typeof callId !== 'string' || typeof requestSeq !== 'number') {
      return Response.json({ ok: false, code: 'malformed', detail: 'claim fields are malformed' }, { status: 400 })
    }
    const identity = { sessionId, callId, requestSeq }
    if (action === 'cancel') {
      if (typeof fields.token !== 'string' || fields.token.length === 0 || fields.token.length > 256) {
        return Response.json({ ok: false, code: 'malformed', detail: 'the cancel needs the claim token' }, { status: 400 })
      }
      const verdict = service.cancelWire({ ...identity, token: fields.token })
      return Response.json(verdict, { status: verdict.ok ? 200 : 409 })
    }
    const revision = fields.revision
    const deadline = fields.expiresAtMs
    if (!nonnegativeInt(revision) || typeof deadline !== 'number' || !Number.isFinite(deadline)) {
      return Response.json({ ok: false, code: 'malformed', detail: 'claim revision or deadline is malformed' }, { status: 400 })
    }
    const outcome = await service.claim({
      ...identity,
      revision,
      expiresAtMs: deadline,
      signal: request.signal,
    })
    return Response.json(outcome, { status: outcome.status === 'claimed' ? 200 : 409 })
  }
  const kind = fields.kind
  if (kind !== 'capture' && kind !== 'decline') {
    return Response.json({ ok: false, code: 'malformed', detail: 'unknown submission kind' }, { status: 400 })
  }
  const allowed = kind === 'capture'
    ? ['kind', 'sessionId', 'callId', 'requestSeq', 'revision', 'token', 'capture']
    : ['kind', 'sessionId', 'callId', 'requestSeq', 'token', 'code']
  if (!exactKeys(fields, allowed)) {
    return Response.json({ ok: false, code: 'malformed', detail: 'the submission contains unknown fields' }, { status: 400 })
  }
  if (!identityOk(fields) || typeof fields.token !== 'string' || fields.token.length === 0 || fields.token.length > 256) {
    return Response.json({ ok: false, code: 'malformed', detail: 'submission identity or token is malformed' }, { status: 400 })
  }
  const sessionId = fields.sessionId
  const callId = fields.callId
  const requestSeq = fields.requestSeq
  const token = fields.token
  if (typeof sessionId !== 'string' || typeof callId !== 'string'
    || typeof requestSeq !== 'number' || typeof token !== 'string') {
    return Response.json({ ok: false, code: 'malformed', detail: 'submission identity or token is malformed' }, { status: 400 })
  }
  if (kind === 'decline') {
    const code = fields.code
    if (!isDeclineCode(code)) {
      return Response.json({ ok: false, code: 'malformed', detail: 'the decline code is unknown' }, { status: 400 })
    }
    const verdict = await service.submit({
      kind: 'decline',
      sessionId,
      callId,
      requestSeq,
      token,
      code,
    })
    return Response.json(verdict, { status: verdict.ok ? 200 : 409 })
  }
  const revision = fields.revision
  if (!nonnegativeInt(revision)) {
    return Response.json({ ok: false, code: 'malformed', detail: 'the submission revision is malformed' }, { status: 400 })
  }
  const rawCapture = fields.capture
  const captureFields = bodyFields(rawCapture)
  if (captureFields === undefined) {
    return Response.json({ ok: false, code: 'malformed', detail: 'the capture receipt is missing or is not an object' }, { status: 400 })
  }
  const pngBase64 = captureFields.pngBase64
  if (typeof pngBase64 !== 'string') {
    return Response.json({ ok: false, code: 'malformed', detail: 'the capture PNG is missing' }, { status: 400 })
  }
  if (pngBase64.length > encodedBound) {
    return Response.json({ ok: false, code: 'oversized', detail: 'the encoded capture exceeds the configured byte bound' }, { status: 413 })
  }
  const parsedCapture = mapObservationCaptureSchema.safeParse(captureFields)
  if (!parsedCapture.success) {
    return Response.json({ ok: false, code: 'malformed', detail: 'the capture receipt is invalid' }, { status: 400 })
  }
  const verdict = await service.submit({
    kind: 'capture',
    sessionId,
    callId,
    requestSeq,
    revision,
    token,
    capture: parsedCapture.data,
  })
  return Response.json(verdict, { status: verdict.ok ? 200 : 409 })
}

/**
 * Register the `/api/map/observation` route when the host Connection is
 * present. The route is the only client→host surface: the Connection
 * carrier owns trust; the service owns pairing, tokens, and bounds.
 * @param ctx - host root context.
 * @param service - the observation registry the route submits into.
 * @param limits - resolved bounds; the body ceiling derives from them.
 * @returns the async disposer, or `undefined` when no Connection is mounted.
 */
export function registerObservationRoute(
  ctx: Context,
  service: MapObservationService,
  limits: Pick<MapObservationLimits, 'maxBytes'> = DEFAULT_OBSERVATION_LIMITS,
): (() => Promise<void>) | undefined {
  const connection = ctx.get('connection', false) as ConnectionFetchSurface | undefined
  if (connection?.fetch === undefined) return undefined
  return connection.fetch.register({
    path: '/api/map/observation',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => serveObservationRequest(request, service, limits),
  })
}
