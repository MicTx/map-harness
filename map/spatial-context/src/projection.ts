/**
 * The `decisionFrame` session projection: the pure synchronous fold of
 * accepted session events into the authoritative DecisionFrame state —
 * GoalContract from accepted real user messages, PlanState from accepted
 * `decision_update` results, EvidenceLedger and resource candidates from
 * settled spatial tool results, injections from snapshot messages that
 * actually entered the surface, and the budget ledger from the same events.
 *
 * State is plain JSON (ordered arrays, never `Map`/`Set`) so the projection
 * cache can checkpoint it. The fold never performs I/O and never throws on
 * protocol violations — those become bounded read-only diagnostics.
 *
 * @module @map-harness/spatial-context/projection
 */
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  DECISION_FRAME_STATE_VERSION,
  foldSpatialContextEvent,
  initialSpatialContextState,
  spatialContextStateSchema,
  type SpatialContextState,
} from './protocol.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host-plane decision-frame state; no client wire view. */
    decisionFrame: SpatialContextState
  }
}

/** The `decisionFrame` projection unit registered on `ctx.sessionProjections`. */
export const spatialContextProjectionDefinition = {
  key: 'decisionFrame',
  stateVersion: DECISION_FRAME_STATE_VERSION,
  stateSchema: spatialContextStateSchema,
  init: () => initialSpatialContextState(),
  apply: (state: SpatialContextState, event: SessionEvent): SpatialContextState =>
    foldSpatialContextEvent(state, event),
} satisfies ProjectionDefinition<'decisionFrame'>
