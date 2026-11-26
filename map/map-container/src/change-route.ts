/**
 * Host half of the user map change path: `POST /api/map/change`. The route
 * admits one bounded change against the session's accepted map state and
 * delivers it as a `map-user-change` notice into the live agent's next-step
 * inbox without waking the model. The inbox insertion commits to the
 * session log, and the `mapContainer` fold applies it at that commit, so
 * the response returns after the map state already changed. The Connection
 * carrier owns caller authentication, as it does for the artifact and
 * observation routes; the route checks the parameter set and the change.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  MAP_USER_CHANGE_SOURCE,
  MAX_USER_CHANGE_BYTES,
  admitUserChange,
  parseUserChangeRecord,
  userChangeNoticeText,
  type MapUserChangeRecord,
  type UserChangeRefusal,
} from './user-change.ts'
import { resolvePresetSymbol } from './projection.ts'
import { stableDigestOf, type MapProjectionState } from './protocol.ts'
import type { BasemapSelection, BasemapSource } from '@map-harness/map-layers'
import type { SourceCatalogFailureCode } from './source-error.ts'
import type { WaybackComparison } from './wayback-comparison.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A map change the user made in the layer panel, applied before the model reads it. */
    'map-user-change': { kind: 'map-user-change'; form: 'notice'; summary: string }
  }
}

/** Path of the user change route. */
export const MAP_CHANGE_ROUTE = '/api/map/change'

/** Maximum accepted session id length; the id is opaque. */
const MAX_SESSION_ID_CHARS = 128

/** The refusal vocabulary the route answers with. */
export type ChangeRouteRefusal = UserChangeRefusal | SourceCatalogFailureCode | 'unknown-session' | 'unavailable'

/** The live agent face the route writes through. */
export interface ChangeRouteAgent {
  readonly session: unknown
  inject(message: UserMessage): void
}

/** The host faces the route needs, resolved per request. */
export interface ChangeRouteHost {
  /** Resolve or resume the agent that owns one session. */
  agentOf(sessionId: string): Promise<ChangeRouteAgent | undefined>
  /** Read the accepted map state of one agent's session. */
  stateOf(agent: ChangeRouteAgent): MapProjectionState
  /** Re-resolve and verify a source selection against the live host catalog/service. */
  admitBasemap?(
    state: MapProjectionState,
    selection: BasemapSelection,
    signal: AbortSignal,
  ): Promise<SourceCatalogFailureCode | undefined>
  /** Verify the fixed early release locally; rendering owns native preparation. */
  admitEarlyImagery?(state: MapProjectionState, source: BasemapSource, signal: AbortSignal): Promise<SourceCatalogFailureCode | undefined>
  admitComparison?(sessionId: string, pair: WaybackComparison, signal: AbortSignal): Promise<SourceCatalogFailureCode | undefined>
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

/** One refusal response. */
function refuse(code: ChangeRouteRefusal): Response {
  const status = code === 'unknown-session' ? 404 : code === 'stale-revision' ? 409
    : code === 'unavailable' ? 503 : sourceStatus(code)
  return Response.json({ ok: false, code }, { status })
}

function sourceStatus(code: ChangeRouteRefusal): number {
  if (code === 'SOURCE_VERSION_UNSUPPORTED' || code === 'SOURCE_CHANGED') return 409
  if (code === 'SOURCE_NOT_FOUND') return 404
  if (code === 'SOURCE_LIMIT_EXCEEDED') return 413
  if (code === 'SOURCE_RESOURCE_DENIED' || code === 'SOURCE_READ_ONLY' || code === 'SOURCE_POLICY_DENIED') return 403
  if (code === 'SOURCE_TIMEOUT') return 504
  if (code === 'SOURCE_UNAVAILABLE' || code === 'SOURCE_CREDENTIAL_REJECTED') return 502
  if (code === 'SOURCE_NOT_CONFIGURED') return 503
  if (code === 'SOURCE_CONFIG_INVALID') return 500
  if (code === 'SOURCE_CANCELLED') return 499
  return 400
}

/**
 * Build one identified, frozen notice message (the shape `createUserMessage`
 * produces; built here so this Node bundle imports no dsh-llm runtime).
 * @param text - the notice text block.
 * @param summary - the one-line summary the source records.
 * @returns the user-role message.
 */
function noticeMessage(text: string, summary: string): UserMessage {
  const content = Object.freeze([Object.freeze({ type: 'text' as const, text })])
  const source = Object.freeze({ kind: MAP_USER_CHANGE_SOURCE, form: 'notice' as const, summary })
  return Object.freeze({ id: globalThis.crypto.randomUUID() as MessageId, role: 'user' as const, content, source })
}

/** Remove caller-supplied host context; only this route can re-add it. */
function cleanRecord(record: MapUserChangeRecord): MapUserChangeRecord {
  const { sessionId: _sessionId, at: _at, featureId: _featureId, ...clean } = record
  return clean
}

/** Derive the host-owned identity and timestamp carried by an annotation notice. */
async function annotationRecordFor(sessionId: string, record: MapUserChangeRecord): Promise<MapUserChangeRecord> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${sessionId}:${record.operationId}`))
  const suffix = [...new Uint8Array(digest)].slice(0, 12).map(byte => byte.toString(16).padStart(2, '0')).join('')
  return { ...cleanRecord(record), sessionId, at: new Date().toISOString(), featureId: `ann-${suffix}` }
}

/**
 * Serve one change request.
 * @param request - the incoming POST request carrying `{ sessionId, summary, record }`.
 * @param host - the agent and state faces.
 * @returns `{ ok: true, revision }` after the change folded, or one refusal.
 */
export async function serveChangeRequest(request: Request, host: ChangeRouteHost): Promise<Response> {
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_USER_CHANGE_BYTES) return refuse('oversized')
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    // A body that is not JSON carries no change.
    return refuse('invalid-change')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return refuse('invalid-change')
  const { sessionId, summary, record: rawRecord } = body as { sessionId?: unknown; summary?: unknown; record?: unknown }
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS || !/^[A-Za-z0-9._:-]+$/u.test(sessionId)) {
    return refuse('unknown-session')
  }
  if (typeof summary !== 'string' || summary.trim().length === 0 || summary.length > 400 || /[\n\r]/u.test(summary)) return refuse('invalid-change')
  const record = parseUserChangeRecord(rawRecord)
  if (record === undefined) return refuse('invalid-change')
  const agent = await host.agentOf(sessionId)
  if (agent === undefined) return refuse('unknown-session')
  const existingResponse = (): Response | undefined => {
    const existing = host.stateOf(agent).operations.find(operation => operation.operationId === record.operationId)
    if (existing === undefined) return undefined
    if (existing.writerId !== 'user') return refuse('invalid-change')
    if (existing.post.requestDigest !== undefined
      && existing.post.requestDigest !== stableDigestOf(record.change)) {
      return refuse('invalid-change')
    }
    return Response.json({ ok: true, revision: existing.revision, duplicate: true })
  }
  const existing = existingResponse()
  if (existing !== undefined) return existing
  const durableRecord = record.change.op === 'annotation-create' || record.change.op === 'annotation-update'
    || record.change.op === 'annotation-delete' || record.change.op === 'annotation-undo'
    || record.change.op === 'visual-proposal-accept' || record.change.op === 'visual-change-accept'
    ? await annotationRecordFor(sessionId, record)
    : cleanRecord(record)
  if (durableRecord.change.op === 'set-basemap' && host.admitBasemap !== undefined) {
    const refusal = await host.admitBasemap(host.stateOf(agent), durableRecord.change.selection, request.signal)
    if (refusal !== undefined) return refuse(refusal)
  }
  if (durableRecord.change.op === 'set-imagery-display' && durableRecord.change.display.earlySource !== null) {
    if (host.admitEarlyImagery === undefined) return refuse('unavailable')
    const refusal = await host.admitEarlyImagery(host.stateOf(agent), durableRecord.change.display.earlySource, request.signal)
    if (refusal !== undefined) return refuse(refusal)
  }
  if (durableRecord.change.op === 'set-wayback-comparison') {
    if (host.admitBasemap === undefined || host.admitComparison === undefined) return refuse('unavailable')
    const refusal = await host.admitComparison(sessionId, durableRecord.change.pair, request.signal)
    if (refusal !== undefined) return refuse(refusal)
    for (const source of [durableRecord.change.pair.early, durableRecord.change.pair.recent]) {
      const refusal = await host.admitBasemap(host.stateOf(agent), { schemaVersion: 1, basemap: source, labels: null }, request.signal)
      if (refusal !== undefined) return refuse(refusal)
    }
    const finalRefusal = await host.admitComparison(sessionId, durableRecord.change.pair, request.signal)
    if (finalRefusal !== undefined) return refuse(finalRefusal)
  }
  const completedWhilePreparing = existingResponse()
  if (completedWhilePreparing !== undefined) return completedWhilePreparing
  const admitted = admitUserChange(host.stateOf(agent), durableRecord, resolvePresetSymbol)
  if (!admitted.ok) return refuse(admitted.code)
  const text = userChangeNoticeText(summary.trim(), durableRecord)
  if (text === undefined) return refuse('oversized')
  agent.inject(noticeMessage(text, summary.trim()))
  const after = host.stateOf(agent)
  const applied = after.operations.some(operation => operation.operationId === durableRecord.operationId)
  return applied
    ? Response.json({ ok: true, revision: after.revision })
    : refuse('stale-revision')
}

/** The session controller face this module reads, structurally narrowed. */
interface SessionControllerFace {
  resolveAgent(sessionId: SessionId): Promise<{ readonly agent: ChangeRouteAgent } | { readonly error: unknown }>
}

/**
 * Register the change route when the host Connection and the session
 * controller are mounted.
 * @param ctx - host root context.
 * @param stateOf - accepted map state of one session.
 * @param admitBasemap - optional verifier for basemap and label selection.
 * @param admitComparison - optional verifier for live historical evidence.
 * @param admitEarlyImagery - optional local verifier for a fixed early release.
 * @returns the async disposer, or `undefined` when either service is absent.
 */
export function registerChangeRoute(
  ctx: Context,
  stateOf: (session: never) => MapProjectionState,
  admitBasemap?: ChangeRouteHost['admitBasemap'],
  admitComparison?: ChangeRouteHost['admitComparison'],
  admitEarlyImagery?: ChangeRouteHost['admitEarlyImagery'],
): (() => Promise<void>) | undefined {
  const connection = ctx.get('connection', false) as ConnectionFetchSurface | undefined
  if (connection?.fetch === undefined) return undefined
  const host: ChangeRouteHost = {
    async agentOf(sessionId) {
      const controller = ctx.get('sessionController', false) as SessionControllerFace | undefined
      if (controller === undefined) return undefined
      const resolved = await controller.resolveAgent(sessionId as SessionId)
      return 'agent' in resolved ? resolved.agent : undefined
    },
    stateOf: agent => stateOf(agent.session as never),
    ...(admitBasemap === undefined ? {} : { admitBasemap }),
    ...(admitComparison === undefined ? {} : { admitComparison }),
    ...(admitEarlyImagery === undefined ? {} : { admitEarlyImagery }),
  }
  return connection.fetch.register({
    path: MAP_CHANGE_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => serveChangeRequest(request, host),
  })
}
