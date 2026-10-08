/**
 * The `spatialAccessibility` session projection: the pure fold that pairs a
 * `run_submit` call with its result, giving the run tool the durable
 * `sourceCallSeq` its `operationRef` must cite — the same trusted-binding
 * discipline the catalog publish tools apply. State is plain JSON (ordered
 * array, bounded) so the projection cache can checkpoint it, and results
 * without a pending entry change nothing.
 *
 * @module @map-harness/spatial-accessibility/projection
 */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host-only run-submit pairing state; no client wire view. */
    spatialAccessibility: SpatialAccessibilityProjectionState
  }
}

/** Persisted-state generation of this unit; changing the shape bumps it. */
export const SPATIAL_ACCESSIBILITY_STATE_VERSION = 1

/** The tool whose calls create pending run-submit entries. */
export const RUN_SUBMIT_TOOL_NAME = 'run_submit'

/** Maximum pending run-submit calls retained (oldest evicted into a no-op). */
export const MAX_PENDING_RUN_CALLS = 64

/** One unsettled run-submit call between its `tool/call` and `tool/result`. */
export interface PendingRunCall {
  readonly callId: string
  /** Seq of the accepted `tool/call`; the trusted submit identity. */
  readonly callSeq: number
  readonly name: string
}

/** The plain-JSON persisted state of the `spatialAccessibility` projection. */
export interface SpatialAccessibilityProjectionState {
  readonly stateVersion: typeof SPATIAL_ACCESSIBILITY_STATE_VERSION
  readonly pendingCalls: readonly PendingRunCall[]
}

const stateSchema = z.object({
  stateVersion: z.literal(SPATIAL_ACCESSIBILITY_STATE_VERSION),
  pendingCalls: z.array(z.object({
    callId: z.string().min(1),
    callSeq: z.number().int().nonnegative(),
    name: z.string().min(1),
  }).strict()),
}).strict()

/** The initial plain-JSON state for a fresh session. */
export function initialSpatialAccessibilityState(): SpatialAccessibilityProjectionState {
  return { stateVersion: SPATIAL_ACCESSIBILITY_STATE_VERSION, pendingCalls: [] }
}

/** The `spatialAccessibility` projection unit registered on `ctx.sessionProjections`. */
export const spatialAccessibilityProjectionDefinition = {
  key: 'spatialAccessibility',
  stateVersion: SPATIAL_ACCESSIBILITY_STATE_VERSION,
  stateSchema: stateSchema as unknown as z.ZodType<SpatialAccessibilityProjectionState>,
  init: () => initialSpatialAccessibilityState(),
  apply: (state: SpatialAccessibilityProjectionState, event: SessionEvent): SpatialAccessibilityProjectionState => {
    if (event.type === 'tool/call') {
      if (event.data.name !== RUN_SUBMIT_TOOL_NAME) return state
      const entry: PendingRunCall = {
        callId: event.data.callId,
        callSeq: event.seq,
        name: event.data.name,
      }
      const pendingCalls = state.pendingCalls.length >= MAX_PENDING_RUN_CALLS
        ? [...state.pendingCalls.slice(1), entry]
        : [...state.pendingCalls, entry]
      return { ...state, pendingCalls }
    }
    if (event.type !== 'tool/result') return state
    const callId = event.data.message.toolCallId
    if (callId === undefined || !state.pendingCalls.some(pending => pending.callId === callId)) return state
    return { ...state, pendingCalls: state.pendingCalls.filter(pending => pending.callId !== callId) }
  },
} satisfies ProjectionDefinition<'spatialAccessibility'>
