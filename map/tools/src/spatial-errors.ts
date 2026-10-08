/**
 * Stable machine-readable failure codes for map-layer tool errors. Every
 * failure the internal provider reports is an error result whose text starts
 * with one of these codes; the code vocabulary is the contract, the text
 * after it is diagnostics. Codes are protocol constants, not configuration.
 */

/**
 * The failure families the spatial tools report. `OUTCOME_UNKNOWN` is
 * deliberately absent: the internal provider executes synchronous local
 * handlers only, a canceled or disposed call settles deterministically before
 * the provider answers, and no side effect can be "maybe committed" — the
 * run store reports it as a durable status instead. `OPERATION_NOT_PUBLISHED`
 * arrives with the P1 run tools' retry path, which refuses to resubmit an
 * original call that never produced a run.
 */
export type SpatialErrorCode =
  | 'CRS_UNKNOWN'
  | 'WORKSPACE_ESCAPE'
  | 'RESOURCE_TOO_LARGE'
  | 'INVALID_GEOJSON'
  | 'GEOMETRY_UNSUPPORTED'
  | 'INVALID_ARGUMENT'
  | 'CALL_CANCELED'
  | 'SPATIAL_SERVICE_UNAVAILABLE'
  | 'GOAL_REVISION_STALE'
  | 'PLAN_REVISION_CONFLICT'
  | 'UNKNOWN_EVIDENCE_REF'
  | 'BUDGET_EXHAUSTED'
  | 'OPERATION_NOT_PUBLISHED'
  | 'WRITER_UNKNOWN'
  | 'WRITER_OFFLINE'
  | 'WRITER_RELEASED'
  | 'WRITE_PERMISSION_DENIED'
  | 'TERRAIN_VERSION_CONFLICT'
  | 'STREAM_STATE_CONFLICT'

/** One map-layer failure with a stable code prefix in its model-visible text. */
export class SpatialError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: SpatialErrorCode
  constructor(code: SpatialErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}
