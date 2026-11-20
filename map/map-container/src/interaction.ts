/**
 * Host-half continuous map-use fence: one accepted `map_use` call pairs with
 * one live browser claim that revalidates the observation's view identity,
 * camera/gesture epochs, layout, and interaction owner before any SDK read.
 * The browser submits a read-only hit result or a named decline through the
 * single `/api/map/use` route; the service owns pairing, tokens, deadlines,
 * and bounded waits.
 * @module @map-harness/map-container/interaction
 */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Session } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { MapContainerService } from './service.ts'
import {
  MAX_INTERACTION_PENDING,
  MAP_USE_REQUEST_TTL_MS,
  MAP_INTERACTION_NOTICE,
  mapInteractionNoticeSchema,
  mapInteractionOutcomeSchema,
  type MapInteractionDeclineCode,
  type MapInteractionOutcome,
  type MapInteractionWaitOutcome,
} from './interaction-protocol.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'map-interaction': { kind: 'map-interaction' }
  }
}

/** Cordis service name for the interaction registry. */
export const MAP_INTERACTION_SERVICE = 'mapInteraction'

/** The only client→host route for continuous map use. */
export const MAP_USE_ROUTE = '/api/map/use'

/** Default bounds for pending interaction waits and early claims. */
export const DEFAULT_INTERACTION_LIMITS = Object.freeze({
  maxPending: 16,
  maxEarlyClaims: 16,
})

/** Resolved interaction registry bounds. */
export interface MapInteractionLimits {
  readonly maxPending: number
  readonly maxEarlyClaims: number
}

/** One wait admission request. */
export interface MapInteractionWait {
  readonly sessionId: string
  readonly callId: string
  readonly requestSeq: number
  readonly expiresAtMs: number
  readonly signal: AbortSignal
  readonly readCurrent: () => boolean
}

/** One client claim. */
export type MapInteractionClaim = Omit<MapInteractionWait, 'readCurrent'>

/** The claim verdict: an opaque host token on admission. */
export type MapInteractionClaimOutcome =
  | { readonly status: 'claimed'; readonly token: string }
  | { readonly status: 'timeout' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'conflict' }
  | { readonly status: 'full' }

/** Why one submitted outcome was refused. */
export type MapInteractionSubmitRefusal =
  | 'no-pending-request'
  | 'malformed'
  | 'wrong-token'
  | 'busy'

/** One token-authenticated client outcome. */
export interface MapInteractionSubmission {
  readonly sessionId: string
  readonly callId: string
  readonly requestSeq: number
  readonly token: string
  readonly outcome: MapInteractionOutcome
}

/** One wire cancellation carrying the claim token. */
export interface MapInteractionWireCancel {
  readonly sessionId: string
  readonly callId: string
  readonly requestSeq: number
  readonly token: string
}

/** The host interaction service surface. */
export interface MapInteractionService {
  /** Wait for one client fence answer. Never rejects. */
  waitFor(wait: MapInteractionWait): Promise<MapInteractionWaitOutcome>
  /** Claim one request; parks until its matching wait admits it. */
  claim(claim: MapInteractionClaim): Promise<MapInteractionClaimOutcome>
  /** Submit one validated outcome. */
  submit(submission: MapInteractionSubmission): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: MapInteractionSubmitRefusal; readonly detail: string }>
  /** Cancel a claimed wait with its token. */
  cancelWire(cancel: MapInteractionWireCancel): { readonly ok: true } | { readonly ok: false; readonly code: MapInteractionSubmitRefusal; readonly detail: string }
  /** Release every pending wait and early claim for one identity. */
  cancel(cancel: { readonly sessionId: string; readonly callId: string; readonly requestSeq: number }): void
  interrupt(sessionId: string): void
  readonly pendingCount: number
  readonly earlyClaimCount: number
  dispose(): void
}

interface PendingWait {
  readonly sessionId: string
  readonly readCurrent: () => boolean
  readonly identity: string
  readonly expiresAt: number
  readonly signal: AbortSignal
  readonly abort: () => void
  timer?: ReturnType<typeof setTimeout>
  resolve(outcome: MapInteractionWaitOutcome): void
  claimToken?: string
  validating: boolean
}

interface EarlyClaim {
  readonly identity: string
  readonly expiresAt: number
  readonly timer: ReturnType<typeof setTimeout>
  readonly abort: () => void
  resolve(outcome: MapInteractionClaimOutcome): void
}

const identityOf = (sessionId: string, callId: string, requestSeq: number): string =>
  JSON.stringify([sessionId, callId, requestSeq])

/**
 * Create the bounded interaction registry.
 * @param limits - pending/early-claim bounds.
 * @param now - clock for expiry enforcement.
 * @param mintToken - opaque host token factory.
 * @returns the service surface.
 */
export function createMapInteractionService(
  limits: MapInteractionLimits = DEFAULT_INTERACTION_LIMITS,
  now: () => number = () => Date.now(),
  mintToken: () => string = () => randomBytes(16).toString('hex'),
): MapInteractionService {
  const pending = new Map<string, PendingWait>()
  const claims = new Map<string, EarlyClaim>()
  let disposed = false

  const dropWait = (identity: string, outcome: MapInteractionWaitOutcome): void => {
    const wait = pending.get(identity)
    if (wait === undefined) return
    pending.delete(identity)
    if (wait.timer !== undefined) clearTimeout(wait.timer)
    wait.abort()
    wait.resolve(outcome)
  }

  const dropClaim = (identity: string, outcome: MapInteractionClaimOutcome): void => {
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

  const service: MapInteractionService = {
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
      const identity = identityOf(wait.sessionId, wait.callId, wait.requestSeq)
      return new Promise<MapInteractionWaitOutcome>(resolve => {
        if (disposed || wait.signal.aborted) {
          resolve({ status: 'cancelled' })
          return
        }
        if (!wait.readCurrent()) { resolve({ status: 'stale' }); return }
        if (!Number.isFinite(wait.expiresAtMs) || wait.expiresAtMs <= now()) {
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
          sessionId: wait.sessionId,
          readCurrent: wait.readCurrent,
          identity,
          expiresAt: Math.min(wait.expiresAtMs, now() + MAP_USE_REQUEST_TTL_MS),
          signal: wait.signal,
          abort: () => wait.signal.removeEventListener('abort', onAbort),
          resolve: outcome => resolve(outcome),
          validating: false,
        }
        entry.timer = setTimeout(() => dropWait(identity, { status: 'timeout' }), Math.max(1, entry.expiresAt - now()))
        const onAbort = (): void => dropWait(identity, { status: 'cancelled' })
        wait.signal.addEventListener('abort', onAbort, { once: true })
        pending.set(identity, entry)
        const early = claims.get(identity)
        if (early !== undefined) {
          if (early.expiresAt <= now()) {
            dropClaim(identity, { status: 'timeout' })
          } else {
            entry.claimToken = mintToken()
            dropClaim(identity, { status: 'claimed', token: entry.claimToken })
          }
        }
      })
    },
    claim(claim) {
      sweep()
      const identity = identityOf(claim.sessionId, claim.callId, claim.requestSeq)
      return new Promise<MapInteractionClaimOutcome>(resolve => {
        if (disposed || claim.signal.aborted) {
          resolve({ status: 'cancelled' })
          return
        }
        if (!Number.isFinite(claim.expiresAtMs) || claim.expiresAtMs <= now()) {
          resolve({ status: 'timeout' })
          return
        }
        const wait = pending.get(identity)
        if (wait !== undefined) {
          if (wait.claimToken !== undefined) {
            resolve({ status: 'conflict' })
            return
          }
          wait.claimToken = mintToken()
          resolve({ status: 'claimed', token: wait.claimToken })
          return
        }
        if (claims.has(identity)) {
          resolve({ status: 'conflict' })
          return
        }
        if (claims.size >= limits.maxEarlyClaims) {
          resolve({ status: 'full' })
          return
        }
        const expiresAt = Math.min(claim.expiresAtMs, now() + MAP_USE_REQUEST_TTL_MS)
        const entry: EarlyClaim = {
          identity,
          expiresAt,
          timer: setTimeout(
            () => dropClaim(identity, { status: 'timeout' }),
            Math.max(1, expiresAt - now()),
          ),
          abort: () => claim.signal.removeEventListener('abort', onAbort),
          resolve: outcome => resolve(outcome),
        }
        const onAbort = (): void => dropClaim(identity, { status: 'cancelled' })
        claim.signal.addEventListener('abort', onAbort, { once: true })
        claims.set(identity, entry)
      })
    },
    async submit(submission) {
      sweep()
      const identity = identityOf(submission.sessionId, submission.callId, submission.requestSeq)
      const wait = pending.get(identity)
      if (wait === undefined) {
        return { ok: false, code: 'no-pending-request', detail: 'no pending map-use request for this identity' }
      }
      if (wait.claimToken === undefined || wait.claimToken !== submission.token) {
        return { ok: false, code: 'wrong-token', detail: 'the result does not carry this wait\'s claim token' }
      }
      if (wait.signal.aborted || !wait.readCurrent()) {
        dropWait(identity, { status: 'stale' })
        return { ok: false, code: 'no-pending-request', detail: 'the map-use owner is no longer current' }
      }
      if (wait.validating) {
        return { ok: false, code: 'busy', detail: 'a result for this wait is already validating' }
      }
      const parsed = mapInteractionOutcomeSchema.safeParse(submission.outcome)
      if (!parsed.success) {
        return { ok: false, code: 'malformed', detail: 'the map-use outcome is invalid' }
      }
      wait.validating = true
      try {
        dropWait(identity, parsed.data)
        return { ok: true }
      } finally {
        wait.validating = false
      }
    },
    cancelWire(cancel) {
      const identity = identityOf(cancel.sessionId, cancel.callId, cancel.requestSeq)
      const wait = pending.get(identity)
      if (wait === undefined) {
        return { ok: false, code: 'no-pending-request', detail: 'no pending map-use request for this identity' }
      }
      if (wait.claimToken === undefined || wait.claimToken !== cancel.token) {
        return { ok: false, code: 'wrong-token', detail: 'the cancellation does not carry this wait\'s claim token' }
      }
      dropWait(identity, { status: 'cancelled' })
      return { ok: true }
    },
    cancel(cancel) {
      const identity = identityOf(cancel.sessionId, cancel.callId, cancel.requestSeq)
      dropClaim(identity, { status: 'cancelled' })
      dropWait(identity, { status: 'cancelled' })
    },
    interrupt(sessionId) {
      for (const [key, wait] of pending) {
        if (wait.sessionId === sessionId) dropWait(key, { status: 'declined', code: 'user-interrupted' })
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

/** Whether one unknown value is a nonnegative integer. */
function nonnegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Validate the identity triple. */
function identityOk(fields: Record<string, unknown>): boolean {
  return typeof fields.sessionId === 'string' && fields.sessionId.length > 0 && fields.sessionId.length <= 256
    && typeof fields.callId === 'string' && fields.callId.length > 0 && fields.callId.length <= 256
    && nonnegativeInt(fields.requestSeq)
}

/** Whether one JSON object contains only the fields an action accepts. */
function exactKeys(fields: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(fields).every(key => keys.includes(key))
}

/** Serve one claim, cancel, or result on the interaction route. */
export async function serveMapUseRequest(request: Request, service: MapInteractionService, stop?: (sessionId: string, turnStartSeq: number) => Promise<boolean>): Promise<Response> {
  const bound = 256 * 1024
  if (Number(request.headers.get('content-length')) > bound) {
    await request.body?.cancel().catch((closedBody: unknown) => { void closedBody })
    return Response.json({ ok: false, code: 'oversized' }, { status: 413 })
  }
  const reader = request.body?.getReader()
  if (reader === undefined) return Response.json({ ok: false, code: 'malformed' }, { status: 400 })
  const cancelBody = (): void => { void reader.cancel().catch((closedBody: unknown) => { void closedBody }) }
  let timedOut = false
  const timeout = setTimeout(() => { timedOut = true; cancelBody() }, MAP_USE_REQUEST_TTL_MS)
  request.signal.addEventListener('abort', cancelBody, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (request.signal.aborted) cancelBody()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > bound) { await reader.cancel(); return Response.json({ ok: false, code: 'oversized' }, { status: 413 }) }
      chunks.push(chunk.value)
    }
  } catch (unreadableBody) {
    void unreadableBody
    return Response.json({ ok: false, code: request.signal.aborted ? 'cancelled' : 'malformed' }, { status: request.signal.aborted ? 408 : 400 })
  } finally {
    clearTimeout(timeout)
    request.signal.removeEventListener('abort', cancelBody)
    reader.releaseLock()
  }
  if (timedOut || request.signal.aborted) return Response.json({ ok: false, code: timedOut ? 'timeout' : 'cancelled' }, { status: 408 })
  const raw = Buffer.concat(chunks).toString('utf8')
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return Response.json({ ok: false, code: 'malformed' }, { status: 400 })
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return Response.json({ ok: false, code: 'malformed' }, { status: 400 })
  }
  const fields = body as Record<string, unknown>
  const action = fields.action
  if (action === 'stop') {
    if (!exactKeys(fields, ['action', 'sessionId', 'turnStartSeq']) || typeof fields.sessionId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/u.test(fields.sessionId)) return Response.json({ ok: false, code: 'malformed' }, { status: 400 })
    const parsed = mapInteractionNoticeSchema.safeParse({ turnStartSeq: fields.turnStartSeq })
    if (!parsed.success) return Response.json({ ok: false, code: 'malformed' }, { status: 400 })
    if (stop === undefined) return Response.json({ ok: false, code: 'unavailable' }, { status: 503 })
    const accepted = await stop(fields.sessionId, parsed.data.turnStartSeq)
    if (accepted) service.interrupt(fields.sessionId)
    return Response.json({ ok: accepted }, { status: accepted ? 200 : 409 })
  }
  if (action === 'claim' || action === 'cancel') {
    const allowed = action === 'claim'
      ? ['action', 'sessionId', 'callId', 'requestSeq', 'expiresAtMs']
      : ['action', 'sessionId', 'callId', 'requestSeq', 'token']
    if (!exactKeys(fields, allowed) || !identityOk(fields)) {
      return Response.json({ ok: false, code: 'malformed' }, { status: 400 })
    }
    const sessionId = fields.sessionId as string
    const callId = fields.callId as string
    const requestSeq = fields.requestSeq as number
    if (action === 'cancel') {
      if (typeof fields.token !== 'string' || fields.token.length === 0 || fields.token.length > 256) {
        return Response.json({ ok: false, code: 'malformed' }, { status: 400 })
      }
      const verdict = service.cancelWire({ sessionId, callId, requestSeq, token: fields.token })
      return Response.json(verdict, { status: verdict.ok ? 200 : 409 })
    }
    const expiresAtMs = fields.expiresAtMs
    if (typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) {
      return Response.json({ ok: false, code: 'malformed' }, { status: 400 })
    }
    const outcome = await service.claim({ sessionId, callId, requestSeq, expiresAtMs, signal: request.signal })
    return Response.json(outcome, { status: outcome.status === 'claimed' ? 200 : outcome.status === 'full' ? 503 : 409 })
  }
  if (action !== 'result') {
    return Response.json({ ok: false, code: 'malformed' }, { status: 400 })
  }
  if (!exactKeys(fields, ['action', 'sessionId', 'callId', 'requestSeq', 'token', 'outcome'])
    || !identityOk(fields)
    || typeof fields.token !== 'string' || fields.token.length === 0 || fields.token.length > 256) {
    return Response.json({ ok: false, code: 'malformed' }, { status: 400 })
  }
  const outcome = mapInteractionOutcomeSchema.safeParse(fields.outcome)
  if (!outcome.success) {
    return Response.json({ ok: false, code: 'malformed' }, { status: 400 })
  }
  const verdict = await service.submit({
    sessionId: fields.sessionId as string,
    callId: fields.callId as string,
    requestSeq: fields.requestSeq as number,
    token: fields.token,
    outcome: outcome.data,
  })
  return Response.json(verdict, { status: verdict.ok ? 200 : 409 })
}

/**
 * Register the `/api/map/use` route when the host Connection is mounted.
 * @param ctx - host root context.
 * @param service - the interaction registry.
 * @returns the async disposer, or `undefined` when no Connection is mounted.
 */
export function registerInteractionRoute(
  ctx: Context,
  service: MapInteractionService,
): (() => Promise<void>) | undefined {
  const connection = ctx.get('connection', false) as ConnectionFetchSurface | undefined
  if (connection?.fetch === undefined) return undefined
  let closed = false
  const unregister = connection.fetch.register({
    path: MAP_USE_ROUTE,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: request => closed ? Promise.resolve(Response.json({ ok: false, code: 'unavailable' }, { status: 503 })) : serveMapUseRequest(request, service, async (sessionId, turnStartSeq) => {
      const controller = ctx.get('sessionController', false) as {
        resolveAgent(id: SessionId): Promise<{ agent: { session: Session; inject(message: UserMessage): void } } | { error: unknown }>
      } | undefined
      const map = ctx.get('map', false) as MapContainerService | undefined
      if (controller === undefined || map === undefined) return false
      const resolved = await controller.resolveAgent(SessionId(sessionId))
      if (closed || request.signal.aborted || !('agent' in resolved)) return false
      const state = map.interactionOf(resolved.agent.session)
      if (!state.open || state.turnStartSeq !== turnStartSeq) return false
      const observation = map.stateOf(resolved.agent.session).observationRequest
      resolved.agent.inject({
        id: brandString<MessageId>(globalThis.crypto.randomUUID()), role: 'user', source: { kind: 'map-interaction' },
        content: [{ type: 'text', text: MAP_INTERACTION_NOTICE + JSON.stringify({ turnStartSeq }) }],
      })
      if (observation !== null) {
        const captures = ctx.get('mapObservation', false) as import('./observation.ts').MapObservationService | undefined
        captures?.cancel({ sessionId, callId: observation.callId, requestSeq: observation.requestSeq })
      }
      return map.interactionOf(resolved.agent.session).stopped !== null
    }),
  })
  return async () => { closed = true; await unregister() }
}

/** Re-export the decline vocabulary for callers that only import this module. */
export type { MapInteractionDeclineCode }

/** Fail-closed budget ceiling for route registration. */
export const MAX_INTERACTION_LIMIT_BOUND = MAX_INTERACTION_PENDING
