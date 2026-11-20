/**
 * Shared, dependency-free bounds and identifiers for persisted visual
 * comparisons. Protocol modules import these literals without creating a
 * runtime cycle through the projection schema.
 * @module @map-harness/map-container/comparison-limits
 */

/** Durable comparison meta kind. */
export const VISUAL_COMPARISON_META_KIND = 'map-visual-comparison'
/** Durable change-candidate meta kind. */
export const VISUAL_CHANGE_META_KIND = 'map-visual-change'
/** Durable comparison id prefix; the host appends a deterministic digest. */
export const VISUAL_COMPARISON_ID_PREFIX = 'vcompare-'
/** Durable change-candidate id prefix; distinct from V6 proposal ids. */
export const VISUAL_CHANGE_ID_PREFIX = 'vchange-'
/** Maximum two-image comparisons retained by one session. */
export const MAX_VISUAL_COMPARISONS = 8
/** Maximum change candidates retained by one session, including reviewed records. */
export const MAX_VISUAL_CHANGE_CANDIDATES = 100
/** Maximum UTF-8 bytes of one serialized comparison or candidate meta. */
export const MAX_VISUAL_CHANGE_META_BYTES = 64 * 1024
/** Maximum persisted observation records retained for V7 comparisons. */
export const MAX_MAP_OBSERVATION_HISTORY = 8
/** Fixed role of the derived visual-change presentation layer. */
export const VISUAL_CHANGE_LAYER_ID = 'visual-changes'
/** Fixed role of the derived V6 visual-proposal presentation layer. */
export const VISUAL_PROPOSAL_LAYER_ID = 'visual-proposals'
