/**
 * The continuous map-use protocol: one `map_use` action bound to one accepted
 * observation, a per-turn action/observation/time budget, and the bounded
 * client fence that proves the live view still depicts that observation.
 * Pure data and zod schemas only; host and browser share one contract.
 * @module @map-harness/map-container/interaction-protocol
 */
import { z } from 'zod'

/** Persisted-state generation of the map's interaction substate. */
export const MAP_INTERACTION_STATE_VERSION = 3

/** Default per-turn limits; null means that dimension is not limited. */
export const DEFAULT_MAP_USE_BUDGET: Readonly<MapUseBudget> = Object.freeze({
  maxActions: null,
  maxObservations: null,
  maxElapsedMs: null,
})

/** Absolute ceiling for pending interaction waits and early claims. */
export const MAX_INTERACTION_PENDING = 64

/** How long one accepted `map_use` call waits for its live-view fence. */
export const MAP_USE_REQUEST_TTL_MS = 30_000

/** One action `map_use` accepts. `finish` needs no observation. */
export type MapUseActionName = 'pan' | 'zoom' | 'click' | 'finish'

/** One pixel-space pan: positive values move the map content right/down. */
export interface MapUsePanAction {
  readonly action: 'pan'
  readonly observationId: string
  readonly dxPx: number
  readonly dyPx: number
}

/** One anchored zoom step; positive `deltaZoom` zooms in. */
export interface MapUseZoomAction {
  readonly action: 'zoom'
  readonly observationId: string
  readonly deltaZoom: number
  /** Anchor in output-image pixels; defaults to the map-content centre. */
  readonly anchorXPx?: number
  readonly anchorYPx?: number
}

/** One read-only click in output-image pixels. */
export interface MapUseClickAction {
  readonly action: 'click'
  readonly observationId: string
  readonly xPx: number
  readonly yPx: number
}

/** End continuous use without another map action. */
export interface MapUseFinishAction {
  readonly action: 'finish'
  readonly reason?: string
  readonly observationId?: string
}

/** One validated `map_use` action. */
export type MapUseAction = MapUsePanAction | MapUseZoomAction | MapUseClickAction | MapUseFinishAction

/** The resolved per-turn limits; null leaves a dimension unbounded. */
export interface MapUseBudget {
  readonly maxActions: number | null
  readonly maxObservations: number | null
  readonly maxElapsedMs: number | null
}

/** Why one continuous-use attempt is refused. */
export type MapUseBudgetRefusal = 'actions' | 'observations' | 'elapsed'

/** One active client request folded from an accepted `map_use` call. */
export interface MapUseClientRequest {
  readonly callId: string
  readonly requestSeq: number
  readonly turn: number
  readonly observationId: string
  readonly action: MapUseActionName
  readonly turnStartSeq: number
  readonly controlEpoch: number
  readonly arguments: string
  /** Click X in output-image pixels (click only). */
  readonly xPx?: number | undefined
  /** Click Y in output-image pixels (click only). */
  readonly yPx?: number | undefined
  readonly expiresAtMs: number
}

/** The plain-JSON interaction state within the mapContainer projection. */
export interface MapInteractionState {
  readonly stateVersion: typeof MAP_INTERACTION_STATE_VERSION
  /** Latest trusted numeric turn whose explicit start was folded. */
  readonly turn: number
  /** Whether that turn is still open. */
  readonly open: boolean
  readonly turnStartSeq: number | null
  readonly controlEpoch: number
  readonly stopped: MapInteractionStop | null
  readonly lastResult: MapUseReceipt | null
  readonly usedObservationId: string | null
  readonly lastCallSeq: number
  /** Epoch milliseconds of the trusted turn start. */
  readonly startedAt: number
  readonly observedAt: number
  /** `map_use` attempts in this turn, including refused/duplicate attempts. */
  readonly actions: number
  /** `map_observe` attempts in this turn, including refused attempts. */
  readonly observations: number
  /** The one live client fence request, or `null`. */
  readonly request: MapUseClientRequest | null
}

/** The initial state for a session with no turn yet. */
export function initialMapInteractionState(): MapInteractionState {
  return {
    stateVersion: MAP_INTERACTION_STATE_VERSION,
    turn: 0,
    open: false,
    turnStartSeq: null,
    controlEpoch: 0,
    stopped: null,
    lastResult: null,
    usedObservationId: null,
    lastCallSeq: -1,
    startedAt: 0,
    observedAt: 0,
    actions: 0,
    observations: 0,
    request: null,
  }
}

const requestSchema = z.object({
  callId: z.string().min(1).max(256),
  requestSeq: z.number().int().nonnegative(),
  turn: z.number().int().nonnegative(),
  observationId: z.string().max(256),
  action: z.enum(['pan', 'zoom', 'click', 'finish']),
  turnStartSeq: z.number().int().nonnegative(),
  controlEpoch: z.number().int().nonnegative(),
  arguments: z.string().max(4096),
  xPx: z.number().finite().optional(),
  yPx: z.number().finite().optional(),
  expiresAtMs: z.number().finite(),
}).strict()

/** Persisted-state schema: validates cache rows and restore seeds. */
export const mapInteractionStateSchema: z.ZodType<MapInteractionState> = z.lazy(() => z.object({
  stateVersion: z.literal(MAP_INTERACTION_STATE_VERSION),
  turn: z.number().int().nonnegative(),
  open: z.boolean(),
  turnStartSeq: z.number().int().nonnegative().nullable(),
  controlEpoch: z.number().int().nonnegative(),
  stopped: interactionStopSchema.nullable(),
  lastResult: mapUseReceiptSchema.nullable(),
  usedObservationId: z.string().max(256).nullable(),
  lastCallSeq: z.number().int().min(-1),
  startedAt: z.number().finite().nonnegative(),
  observedAt: z.number().finite().nonnegative(),
  actions: z.number().int().nonnegative(),
  observations: z.number().int().nonnegative(),
  request: requestSchema.nullable(),
}).strict())

/** Client-visible wire value of the projection. */
export type MapInteractionWire = MapInteractionState

/** Resolve one validated budget over the defaults. */
export function resolveMapUseBudget(overrides: Partial<MapUseBudget> | undefined): MapUseBudget {
  const budget = { ...DEFAULT_MAP_USE_BUDGET, ...overrides }
  for (const [key, value] of Object.entries(budget)) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 1)) {
      throw new RangeError(`map use budget.${key} must be a positive integer, got ${String(value)}`)
    }
  }
  return budget
}

/**
 * Refuse one attempt against the already-folded counters. The current call is
 * counted before execution, so `>` admits the last budgeted attempt and
 * refuses the next one.
 * @param state - the folded interaction state.
 * @param budget - the resolved per-turn budget.
 * @param nowMs - current wall time.
 * @returns the exhausted dimension, or `null` when the attempt may proceed.
 */
export function mapUseBudgetRefusalOf(
  state: MapInteractionState,
  budget: MapUseBudget,
  nowMs: number,
): MapUseBudgetRefusal | null {
  if (nowMs < state.startedAt || nowMs < state.observedAt) return 'elapsed'
  if (budget.maxActions !== null && state.actions > budget.maxActions) return 'actions'
  if (budget.maxObservations !== null && state.observations > budget.maxObservations) return 'observations'
  if (budget.maxElapsedMs !== null && nowMs - state.startedAt >= budget.maxElapsedMs) return 'elapsed'
  return null
}

/** One budget snapshot carried by tool results. */
export interface MapUseBudgetSnapshot {
  readonly actionsUsed: number
  readonly actionsRemaining: number | null
  readonly observationsUsed: number
  readonly observationsRemaining: number | null
  readonly elapsedMs: number
  readonly elapsedRemainingMs: number | null
}

/** Build the bounded budget snapshot for one result. */
export function mapUseBudgetSnapshotOf(
  state: MapInteractionState,
  budget: MapUseBudget,
  nowMs: number,
): MapUseBudgetSnapshot {
  return {
    actionsUsed: state.actions,
    actionsRemaining: budget.maxActions === null ? null : Math.max(0, budget.maxActions - state.actions),
    observationsUsed: state.observations,
    observationsRemaining: budget.maxObservations === null ? null : Math.max(0, budget.maxObservations - state.observations),
    elapsedMs: Math.max(0, nowMs - state.startedAt),
    elapsedRemainingMs: budget.maxElapsedMs === null ? null : Math.max(0, budget.maxElapsedMs - Math.max(0, nowMs - state.startedAt)),
  }
}

/** Why the browser refused one interaction fence. */
export type MapInteractionDeclineCode =
  | 'no-view'
  | 'not-ready'
  | 'stale'
  | 'user-interrupted'
  | 'edit-in-progress'
  | 'unsupported'
  | 'outside-map'
  | 'render-failed'

/** One bounded, text-only attribute field of a clicked feature. */
export interface MapInteractionField {
  readonly name: string
  readonly value: string
}

/** One SDK hit, in topmost-first order. */
export interface MapInteractionHit {
  readonly layerId: string
  readonly layerName: string
  readonly featureId: string
  readonly title: string | null
  readonly fields: readonly MapInteractionField[]
  readonly omitted: number
}

/** The browser's answer to one interaction request. */
export type MapInteractionOutcome =
  | { readonly status: 'validated' }
  | {
    readonly status: 'hits'
    readonly hits: readonly MapInteractionHit[]
    /** WGS84 no-hit/click coordinate; always the clicked point, hit or not. */
    readonly world: readonly [number, number]
  }
  | { readonly status: 'declined'; readonly code: MapInteractionDeclineCode }

/** The bounded wait result the tool consumes. */
export type MapInteractionWaitOutcome =
  | MapInteractionOutcome
  | { readonly status: 'timeout' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'stale' }
  | { readonly status: 'full' }

/** Maximum hits one click returns. */
export const MAX_INTERACTION_HITS = 5

/** Maximum attribute fields one hit carries. */
export const MAX_INTERACTION_FIELDS = 24

/** Maximum characters one attribute field value carries. */
export const MAX_INTERACTION_FIELD_CHARS = 256

const fieldSchema = z.object({
  name: z.string().min(1).max(64),
  value: z.string().max(MAX_INTERACTION_FIELD_CHARS),
}).strict()

const hitSchema = z.object({
  layerId: z.string().min(1).max(256),
  layerName: z.string().min(1).max(256),
  featureId: z.string().min(1).max(256),
  title: z.string().max(MAX_INTERACTION_FIELD_CHARS).nullable(),
  fields: z.array(fieldSchema).max(MAX_INTERACTION_FIELDS).readonly(),
  omitted: z.number().int().nonnegative(),
}).strict()

/** Untrusted client outcome schema; the route validates before the service sees it. */
export const mapInteractionOutcomeSchema = z.union([
  z.object({ status: z.literal('validated') }).strict(),
  z.object({
    status: z.literal('hits'),
    hits: z.array(hitSchema).max(MAX_INTERACTION_HITS).readonly(),
    world: z.tuple([z.number().finite().min(-180).max(180), z.number().finite().min(-90).max(90)]).readonly(),
  }).strict(),
  z.object({
    status: z.literal('declined'),
    code: z.union([
      z.literal('no-view'),
      z.literal('not-ready'),
      z.literal('stale'),
      z.literal('user-interrupted'),
      z.literal('edit-in-progress'),
      z.literal('unsupported'),
      z.literal('outside-map'),
      z.literal('render-failed'),
    ]),
  }).strict(),
]) as z.ZodType<MapInteractionOutcome>

const interactionStopSchema = z.enum(['user-interrupted', 'finished', 'failed', 'cancelled'])

/** Terminal reason for the current turn's map controller. */
export type MapInteractionStop = z.infer<typeof interactionStopSchema>

/** Accepted single-step result, paired with the trusted call and control epoch. */
export const mapUseReceiptSchema = z.object({
  callId: z.string().min(1).max(256),
  sourceCallSeq: z.number().int().nonnegative(),
  turnStartSeq: z.number().int().nonnegative(),
  controlEpoch: z.number().int().nonnegative(),
  observationId: z.string().max(256),
  targetRevision: z.number().int().nonnegative(),
  expiresAtMs: z.number().finite(),
  action: z.enum(['pan', 'zoom', 'click', 'finish']),
  viewId: z.string().max(256),
  view: z.object({
    center: z.tuple([z.number().finite(), z.number().finite()]),
    zoom: z.number().finite().min(0).max(24),
    wkid: z.number().int().positive(),
    scale: z.number().finite().positive(),
    rotation: z.number().finite(),
  }).strict().nullable(),
  hits: z.array(hitSchema).max(MAX_INTERACTION_HITS),
}).strict()

/** Durable map-use result. */
export type MapUseReceipt = z.infer<typeof mapUseReceiptSchema>

/** Accepted map-use metadata; old map-change readers do not interpret it. */
export const mapUseMetaSchema = z.object({ kind: z.literal('map-use'), schemaVersion: z.literal(1), record: mapUseReceiptSchema }).strict()

/** Close one turn's map controller without discarding accepted map state. */
export function stopMapInteraction(state: MapInteractionState, reason: MapInteractionStop): MapInteractionState {
  return !state.open || state.stopped !== null ? state : {
    ...state, stopped: reason, controlEpoch: state.controlEpoch + 1, request: null,
  }
}

/** Trusted user notice payload, applied at inbox insertion and idempotent on replay. */
export const mapInteractionNoticeSchema = z.object({ turnStartSeq: z.number().int().nonnegative() }).strict()

/** Marker for the map owner's user-takeover notices. */
export const MAP_INTERACTION_NOTICE = '[map-interaction v1]\n'
