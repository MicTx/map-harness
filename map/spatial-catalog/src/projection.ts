/**
 * The `spatialCatalog` session projection: the pure fold that pairs a publish
 * tool's accepted `tool/call` with its result, giving handlers the durable
 * `sourceCallSeq` their publish operations and intents must cite — the same
 * trusted-binding discipline the map projection applies to map mutations.
 * State is plain JSON (ordered array, bounded) so the projection cache can
 * checkpoint it, and results without a pending entry change nothing.
 *
 * @module @map-harness/spatial-catalog/projection
 */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Host-only publish pairing state; no client wire view. */
    spatialCatalog: SpatialCatalogProjectionState
  }
}

/** Persisted-state generation of this unit; changing the shape bumps it. */
export const SPATIAL_CATALOG_STATE_VERSION = 1

/**
 * The tools whose calls create pending publish entries: the P0b originals,
 * the six P2 stat/pattern tools, the eight P3 decision-model tools, the
 * visualization style publisher, the terrain line-of-sight tool, the
 * stream materialization tool, and the scale scan publisher, whose result
 * artifacts publish through the catalog's accepted-call pairing.
 */
export const PUBLISH_TOOL_NAMES = [
  'catalog_register',
  'geo_buffer',
  'stats_zonal',
  'stats_autocorrelation',
  'stats_hotspot',
  'pattern_change',
  'pattern_cluster',
  'pattern_flow',
  'attribution_association',
  'attribution_explain',
  'attribution_effect',
  'forecast_validate',
  'forecast_fit',
  'forecast_predict',
  'scenario_compare',
  'location_allocate',
  'viz_create_style',
  'viz_aggregate',
  'geo_line_of_sight',
  'terrain_viewshed',
  'stream_materialize',
  'scale_scan',
] as const

/** Maximum pending publish calls retained (oldest evicted into a no-op). */
export const MAX_PENDING_PUBLISH_CALLS = 64

/** One unsettled publish call between its `tool/call` and `tool/result`. */
export interface PendingPublishCall {
  readonly callId: string
  /** Seq of the accepted `tool/call`; the trusted publish identity. */
  readonly callSeq: number
  readonly name: string
}

/** The plain-JSON persisted state of the `spatialCatalog` projection. */
export interface SpatialCatalogProjectionState {
  readonly stateVersion: typeof SPATIAL_CATALOG_STATE_VERSION
  readonly pendingCalls: readonly PendingPublishCall[]
}

const stateSchema = z.object({
  stateVersion: z.literal(SPATIAL_CATALOG_STATE_VERSION),
  pendingCalls: z.array(z.object({
    callId: z.string().min(1),
    callSeq: z.number().int().nonnegative(),
    name: z.string().min(1),
  }).strict()),
}).strict()

/** The initial plain-JSON state for a fresh session. */
export function initialSpatialCatalogState(): SpatialCatalogProjectionState {
  return { stateVersion: SPATIAL_CATALOG_STATE_VERSION, pendingCalls: [] }
}

/** The `spatialCatalog` projection unit registered on `ctx.sessionProjections`. */
export const spatialCatalogProjectionDefinition = {
  key: 'spatialCatalog',
  stateVersion: SPATIAL_CATALOG_STATE_VERSION,
  stateSchema: stateSchema as unknown as z.ZodType<SpatialCatalogProjectionState>,
  init: () => initialSpatialCatalogState(),
  apply: (state: SpatialCatalogProjectionState, event: SessionEvent): SpatialCatalogProjectionState => {
    if (event.type === 'tool/call') {
      if (!(PUBLISH_TOOL_NAMES as readonly string[]).includes(event.data.name)) return state
      const entry: PendingPublishCall = {
        callId: event.data.callId,
        callSeq: event.seq,
        name: event.data.name,
      }
      const pendingCalls = state.pendingCalls.length >= MAX_PENDING_PUBLISH_CALLS
        ? [...state.pendingCalls.slice(1), entry]
        : [...state.pendingCalls, entry]
      return { ...state, pendingCalls }
    }
    if (event.type !== 'tool/result') return state
    let callId: string | undefined = event.data.message.toolCallId
    if (typeof callId !== 'string') {
      for (const candidate of event.data.message.content) {
        if (typeof candidate !== 'object' || candidate === null) continue
        const block = candidate as { type?: unknown; toolCallId?: unknown }
        if (block.type !== 'tool-result' || typeof block.toolCallId !== 'string') continue
        callId = block.toolCallId
        break
      }
    }
    if (typeof callId !== 'string') return state
    const pendingIndex = state.pendingCalls.findIndex(pending => pending.callId === callId)
    if (pendingIndex < 0) return state
    return { ...state, pendingCalls: state.pendingCalls.filter((_pending, index) => index !== pendingIndex) }
  },
} satisfies ProjectionDefinition<'spatialCatalog'>
