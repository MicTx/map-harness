/**
 * The P0a map protocol: the plain-JSON persisted state of the `mapContainer`
 * projection, the candidate {@link MapChange} vocabulary tools propose, the
 * versioned durable `tool/result.meta.spatial` record that carries a change,
 * and the pure decode/validate/settle steps every map mutation passes through.
 *
 * Commit protocol (design §11.1, audit D01/D02): a mutation tool reads the
 * accepted projection, validates the candidate against the current revision
 * and the capacity bounds, and returns model content plus one versioned
 * `map-change` meta record. Only a successful, paired, first-settled
 * `tool/result` folds its change; failed, cancelled, unpaired, duplicated
 * (surface-replaced), version-unknown, and stale-revision results leave the
 * authoritative map unchanged and record a bounded read-only diagnostic. The
 * registry write path tools used before P0a is gone — the projection is the
 * single authority and every other face derives from it.
 *
 * Collaboration plane (design §11.3, single-server serial commit): the fold
 * IS the serial commit segment — the `targetRevision` CAS and the acceptance
 * run synchronously inside one `settleMapResult` call, so no interleaving
 * writer can slip between the check and the acceptance. Every applied change
 * appends a bounded {@link MapOperationRecord} (writer id, client operation
 * id, the computed inverse, and the post-state the undo target check reads),
 * so undo always proposes a NEW compensating revision while the original
 * history stays in the session log. A replayed `operationId` settles as an
 * idempotent no-op with a `duplicate-op` diagnostic — never a second apply.
 *
 * @module @map-harness/map-container/protocol
 */
import { z } from 'zod'
import { initialMapInteractionState, mapInteractionStateSchema } from './interaction-protocol.ts'
import { validateStyleSpec, type StyleSpec } from '@map-harness/spatial-viz'
import { featureIdOf } from '@map-harness/spatial-viz'
import {
  createBasemapSelection,
  parseBasemapSource,
  parseBasemapSelection,
  overridesVersionOf,
  validateFeatureOverrides,
  validateGroupName,
  validateImagerySpec,
  validateSymbolStyle,
  type FeatureOverride,
  type FeatureOverrides,
  type ImagerySpec,
  type SymbolStyle,
  type BasemapSource,
  type BasemapSelection,
} from '@map-harness/map-layers'
import { decodeCheckpoint } from '@map-harness/spatial-realtime'
import {
  mapObservationRecordSchema,
  type MapObservationRecord,
} from './observation-protocol.ts'
import {
  MAX_ACTIVE_VISUAL_PROPOSALS,
  visualProposalPairingCode,
  VISUAL_PROPOSAL_META_KIND,
  decodeVisualProposalMeta,
  type VisualProposalRecord,
  visualProposalRecordSchema,
} from './visual-proposal-protocol.ts'
import { visualProposalLayerOf } from './visual-proposal-layer.ts'
import { visualChangeLayerOf } from './visual-change-layer.ts'
import { stableDigestOf } from './stable-digest.ts'
import {
  MAX_MAP_OBSERVATION_HISTORY,
  MAX_VISUAL_CHANGE_CANDIDATES,
  MAX_VISUAL_COMPARISONS,
  VISUAL_CHANGE_LAYER_ID,
  VISUAL_PROPOSAL_LAYER_ID,
} from './comparison-limits.ts'
import { DISPLAY_GEOMETRY_TYPES, isSupportedDisplayWkid, validateGeoJsonValue } from '@map-harness/spatial-catalog'
import type { GeoJsonFeature, GeoJsonFeatureCollection, MapLayerLegend, MapLayerStream, MapLayerTerrain, MapViewRecord } from './registry.ts'
import { isWaybackComparison, type WaybackComparison } from './wayback-comparison.ts'
import { waybackReleaseOf } from './wayback.ts'
import {
  decodeVisualChangeMeta,
  mapComparisonRecordSchema,
  visualChangePairingCode,
  visualChangeRecordSchema,
  type MapComparisonRecord,
  type VisualChangeRecord,
} from './comparison-protocol.ts'

export { DISPLAY_GEOMETRY_TYPES } from '@map-harness/spatial-catalog'

/**
 * Persisted-state generation of the `mapContainer` unit. Bumped 2 → 3 with the
 * JSON re-serialization (Maps became ordered arrays), 3 → 4 with the P0b
 * layer identity fields, 4 → 5 with the P3-visualization layer style
 * records, 5 → 6 with the collaboration plane (AOI record plus the
 * bounded operation ledger), 6 → 7 with the terrain identity block on
 * layers, 7 → 8 with the realtime stream identity block (checkpoint
 * plus status) on layers, 8 → 9 with the layer presentation fields
 * (symbol, overrides, group) and the imagery layer identity, 9 → 10
 * with the bounded `latestObservation` evidence record, and 10 → 11 with the
 * explicit basemap selection, and 11 → 12 with the protected user-annotation
 * layer role, and 14 → 15 with the versioned visual-proposal candidate
 * records, and 15 → 16 with the bounded observation history, comparison
 * records, and visual-change candidates, so persisted cache rows carrying
 * previous shapes are discarded and refolded from the raw log.
 */
export const MAP_PROJECTION_STATE_VERSION = 21

/** Maximum persisted observation records retained for V7 comparisons. */
export { MAX_MAP_OBSERVATION_HISTORY, MAX_VISUAL_CHANGE_CANDIDATES, MAX_VISUAL_COMPARISONS, VISUAL_CHANGE_LAYER_ID, VISUAL_PROPOSAL_LAYER_ID }

/**
 * Wire/protocol version of the durable map `tool/result.meta` record. Bumped
 * 1 → 2 when layers gained their P0b identity fields, 2 → 3 when layers
 * gained their visualization style and the `set-style` change joined the
 * vocabulary, 3 → 4 when the collaboration plane added the optional
 * writer/operation/undo identity fields and the `patch`, `reorder-layers`,
 * and `set-aoi` changes, 4 → 5 when the layer-state changes
 * (`set-layer-state`, `set-symbol-style`, `set-feature-overrides`) and the
 * imagery layer identity joined the vocabulary, and 5 → 6 when
 * `set-basemap` joined the vocabulary; versions 1–5 records still decode
 * (v6 fields absent), while older builds refuse v6 records read-only instead
 * of misreading them.
 */
export const MAP_META_SCHEMA_VERSION = 8

/** The schema versions whose map-change records decode (1 = pre-P0b layer shape through 5 = pre-basemap shape). */
const DECODABLE_META_VERSIONS = [1, 2, 3, 4, 5, 6, 7, MAP_META_SCHEMA_VERSION] as const

/** The only meta kind P0a decodes; unknown kinds never apply. */
export const MAP_META_KIND = 'map-change'

/** One user decision on one visual candidate, with an optional human edit. */
export type VisualProposalUserChange = {
  readonly op: 'visual-proposal-accept'
  readonly proposalId: string
  readonly expectedRevision: number
  readonly name?: string
  readonly description?: string
  readonly geometry?: AnnotationGeometry
} | {
  readonly op: 'visual-proposal-reject'
  readonly proposalId: string
  readonly expectedRevision: number
}
/** One user decision on one visual-change candidate, with an optional human edit. */
export type VisualChangeUserChange = {
  readonly op: 'visual-change-accept'
  readonly changeId: string
  readonly expectedRevision: number
  readonly name?: string
  readonly description?: string
  readonly geometry?: AnnotationGeometry
} | {
  readonly op: 'visual-change-reject'
  readonly changeId: string
  readonly expectedRevision: number
}

/** Map mutation tool names whose successful results change the container. */
export const MAP_MUTATION_TOOL_NAMES = [
  'map_add_layer',
  'map_draw',
  'map_remove_layer',
  'map_set_view',
  'map_fit_view',
  'map_set_mode',
  'map_refine_aoi',
  'viz_classify',
  'viz_compare',
  'viz_aggregate',
  'map_apply_patch',
  'map_undo',
  'terrain_add_layer',
  'stream_open',
  'stream_advance',
  'stream_pause',
  'stream_resume',
  'stream_materialize',
  'layer_set_state',
  'layer_set_style',
  'map_set_basemap',
  'map_set_imagery',
  'map_use',
  'map_markup',
  'map_edit_annotation',
] as const

/** Tool calls that open a pending evidence fold without changing the map revision. */
export const MAP_PENDING_TOOL_NAMES = [
  'map_compare_views',
  'map_mark_changes',
] as const

/** The single protected layer that stores user-authored annotations. */
export const USER_ANNOTATION_LAYER_ID = 'user-annotations'
/** Default maximum active annotation features. */
export const MAX_ANNOTATION_FEATURES = 300

/** Maximum coordinates one annotation geometry may carry. */
export const MAX_ANNOTATION_FEATURE_COORDINATES = 1_024

/** Default maximum coordinates across all active annotations. */
export const MAX_ANNOTATION_TOTAL_COORDINATES = 20_000

/** Maximum serialized bytes of the annotation layer payload. */
export const MAX_ANNOTATION_LAYER_BYTES = 512 * 1_024

/** One map mutation tool name. */
export type MapMutationName = typeof MAP_MUTATION_TOOL_NAMES[number]

/** One tool name whose call opens a pending evidence fold. */
export type MapPendingToolName = typeof MAP_MUTATION_TOOL_NAMES[number] | typeof MAP_PENDING_TOOL_NAMES[number]

/** Maximum layers one container accepts; candidate validation rejects beyond. */
export const MAX_MAP_LAYERS = 32

/** Maximum unsettled pending calls kept in the persisted state. */
export const MAX_PENDING_MAP_CALLS = 64

/** Maximum read-only diagnostics retained (oldest dropped first). */
export const MAX_MAP_DIAGNOSTICS = 16

/**
 * Maximum applied-operation records retained in the state (oldest dropped
 * first). The ledger is the undo horizon and the idempotency window: once a
 * record is evicted, its operation can no longer be undone by id and a
 * replayed `operationId` may apply again — the bound keeps the persisted
 * state finite while the session log itself stays the full history.
 */
export const MAX_MAP_OPERATION_RECORDS = 32

/** Maximum operations inside one `patch` change. */
export const MAX_PATCH_CHANGES = 8

/** Maximum layer-state entries one `set-layer-state` change carries. */
export const MAX_LAYER_STATE_ENTRIES = MAX_MAP_LAYERS

/** Maximum entries one `set-symbol-style` change carries. */
export const MAX_SYMBOL_STYLE_ENTRIES = MAX_PATCH_CHANGES

/** Maximum entries one `set-feature-overrides` change carries. */
export const MAX_FEATURE_OVERRIDE_ENTRIES = MAX_PATCH_CHANGES

/** Maximum characters of one operation summary line. */
const MAX_OPERATION_SUMMARY_CHARS = 160

/**
 * Maximum serialized bytes of one durable map-change meta record. The GeoJSON
 * loader caps one file at 32 MiB; the envelope bound leaves headroom for the
 * record fields around the embedded display copy.
 */
export const MAX_CHANGE_META_BYTES = 34 * 1024 * 1024

/**
 * The geometry types the browser occurrence actually renders. Admission
 * refuses anything else BEFORE a layer is proposed — never silently skipped.
 */
const DISPLAY_GEOMETRY_SET: ReadonlySet<string> = new Set(DISPLAY_GEOMETRY_TYPES)

/** One layer's persisted payload: the durable projection of a successful `map_add_layer`. */
export interface MapProjectedLayer {
  /** Stable layer id; re-adding one id replaces the layer. */
  readonly id: string
  readonly name: string
  /** Protected authoring role; absence means an ordinary model/business layer. */
  readonly role?: 'user-annotation' | 'visual-proposal' | 'visual-change'
  /** WGS84 GeoJSON FeatureCollection the browser renders; absent on imagery layers. */
  readonly data?: GeoJsonFeatureCollection
  /** Source CRS the file was read as, when known; display-only metadata. */
  readonly sourceCrs: string
  readonly opacity: number
  readonly visible: boolean
  /** Seq of the `tool/call` whose accepted result added this layer (call identity). */
  readonly sourceCallSeq: number
  /**
   * Digest of the WGS84 display copy the layer renders. Required for layers
   * carrying catalog identity (resource/artifact refs); the browser keys its rendered identity on it
   * so a same-id, same-featureCount update still redraws.
   */
  readonly displayDigest?: string
  /** Exact artifact ref (`art-…@vN`) the layer renders, when added from a published artifact. */
  readonly artifactRef?: string
  /** Exact resource ref (`res-…@vN`) the layer's data came from, when added from the catalog. */
  readonly resourceRef?: string
  /** Minimal single-symbol legend, when the layer carries one. */
  readonly legend?: MapLayerLegend
  /**
   * The presentation style the layer renders (`layer_set_style`), when one is
   * set. Validated at the fold: a heatmap presentation additionally requires
   * an all-Point layer and the absence of a classification `style`.
   */
  readonly symbol?: SymbolStyle
  /**
   * The per-feature overrides layered above the symbol (`layer_set_style`),
   * when any are set. The fold derives and pins the `overridesVersion`.
   */
  readonly overrides?: FeatureOverrides
  /**
   * The display group the layer belongs to (`layer_set_state`), when one is
   * set. The group set is implicit — the names in use, never a registry.
   */
  readonly group?: string
  /**
   * The key-free tile-overlay identity, when the layer is an imagery layer
   * (`map_add_layer` tile branch). Carrying it requires the current meta
   * schema version, and `data` stays absent — the two are exclusive.
   */
  readonly imagery?: ImagerySpec
  /**
   * The visualization style the layer renders (P3-visualization workbench),
   * when `viz_classify`/`viz_compare` classified it. Validated at the fold:
   * structural issues or a `styleVersion` that does not re-derive refuse the
   * whole record read-only.
   */
  readonly style?: StyleSpec
  /**
   * The terrain identity, when the layer is a bounded terrain preview bound
   * to one exact surface version (`terrain_add_layer`). Carrying it requires
   * the current meta schema version, and the layer must also carry catalog
   * identity (its `resourceRef` is the surface ref).
   */
  readonly terrain?: MapLayerTerrain
  /**
   * The realtime stream identity, when the layer is a stream-workbench
   * projection (`stream_open` and friends). Carrying it requires the current
   * meta schema version, and the embedded checkpoint must decode — the layer
   * record is the durable workbench state, so a fold that could not resume
   * would strand the stream.
   */
  readonly stream?: MapLayerStream
}

/** One host-supported annotation geometry in WGS84 coordinates. */
export type AnnotationGeometry =
  | { readonly type: 'Point'; readonly coordinates: readonly [number, number] }
  | { readonly type: 'LineString'; readonly coordinates: readonly (readonly [number, number])[] }
  | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly (readonly [number, number])[])[] }

/** User-authored annotation operations; these never enter model map-change metadata. */
export type AnnotationUserChange =
  | {
    readonly op: 'annotation-create'
    readonly geometry: AnnotationGeometry
    readonly name: string
    readonly description?: string
    readonly symbol?: SymbolStyle
  }
  | {
    readonly op: 'annotation-update'
    readonly featureId: string
    readonly expectedUpdatedAt: string
    readonly geometry?: AnnotationGeometry
    readonly name?: string
    readonly description?: string
    readonly symbol?: SymbolStyle | null
  }
  | { readonly op: 'annotation-delete'; readonly featureIds: readonly string[] }
  | { readonly op: 'annotation-undo'; readonly operationId: string }

/** Maximum serialized bytes of one style payload inside a change record. */
export const MAX_STYLE_BYTES = 16 * 1024

/**
 * Maximum serialized bytes of the whole projection state (layers plus view).
 * Each add is legal on its own, yet layers accumulate: the cumulative budget
 * rejects the add that would push the persisted projection past this bound,
 * keeping the previous state untouched.
 */
export const MAX_PROJECTION_STATE_BYTES = 64 * 1024 * 1024

/** Measure serialized JSON with the wire's UTF-8 byte semantics. */
function utf8ByteLength(value: unknown): number {
  let text: string | undefined
  try {
    text = JSON.stringify(value)
  } catch {
    return Number.POSITIVE_INFINITY
  }
  const Buffer = (globalThis as typeof globalThis & {
    Buffer?: { byteLength(input: string, encoding: 'utf8'): number }
  }).Buffer
  const serialized = text === undefined ? 'null' : text
  return Buffer === undefined ? new TextEncoder().encode(serialized).byteLength : Buffer.byteLength(serialized, 'utf8')
}

/** One unsettled map mutation call tracked between its `tool/call` and `tool/result`. */
export interface MapPendingCall {
  /** ToolRuntime call id; pairs the result block within the current protocol. */
  readonly callId: string
  /** Seq of the `tool/call` event; the durable call identity meta must cite. */
  readonly callSeq: number
  readonly name: MapPendingToolName
}

/** Why one settled result did not change the authoritative map. */
export type MapDiagnosticCode =
  | 'failed-result'
  | 'unknown-schema-version'
  | 'unknown-kind'
  | 'invalid-meta'
  | 'oversized-meta'
  | 'call-pairing'
  | 'stale-revision'
  | 'capacity'
  | 'pending-overflow'
  | 'style-layer-unknown'
  | 'layer-unknown'
  | 'feature-unknown'
  | 'invalid-view'
  | 'duplicate-op'
  | 'observation-pairing'
  | 'observation-oversized'
  | 'annotation-limit'
  | 'geometry-invalid'
  | 'annotation-unknown'
  | 'annotation-protected'
  | 'visual-proposal-pairing'
  | 'visual-proposal-limit'
  | 'visual-proposal-unknown'
  | 'visual-proposal-protected'
  | 'comparison-pairing'
  | 'comparison-limit'
  | 'comparison-unknown'
  | 'comparison-protected'

/** One bounded read-only diagnostic: the fold refused a change and kept the map. */
export interface MapDiagnostic {
  /** Seq of the settled `tool/result` (or evicted `tool/call`) that produced it. */
  readonly seq: number
  readonly code: MapDiagnosticCode
}

/** One named AOI polygon: a closed WGS84 lon/lat ring (a bbox ring qualifies). */
export interface MapAoi {
  readonly name?: string
  readonly ring: readonly (readonly [number, number])[]
}

/** Maximum points in one AOI ring. */
export const MAX_AOI_RING_POINTS = 256

export { stableDigestOf }

/** The layer identity digest the collaboration plane compares (`displayDigest` when present, else the data or imagery digest). */
export function layerDigestOf(layer: Pick<MapProjectedLayer, 'displayDigest' | 'data' | 'imagery'>): string {
  if (layer.displayDigest !== undefined) return layer.displayDigest
  return stableDigestOf(layer.data !== undefined ? layer.data : layer.imagery)
}

/** The AOI identity digest the collaboration plane compares. */
export function aoiDigestOf(aoi: MapAoi | null): string | null {
  return aoi === null ? null : stableDigestOf(aoi)
}

/** Whether every feature of one data layer is a Point (the heatmap requirement). */
function isAllPointLayer(layer: Pick<MapProjectedLayer, 'data'>): boolean {
  const features = (layer.data as { features?: { geometry?: { type?: string } | null }[] } | undefined)?.features
  if (features === undefined) return false
  return features.every(feature => feature.geometry?.type === 'Point')
}

const ANNOTATION_FEATURE_ID = /^ann-[0-9a-f]{24}$/u
const ANNOTATION_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u

/** Annotation text rejects control characters while allowing normal multilingual prose. */
function annotationTextOf(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) return undefined
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return undefined
  }
  return value
}

/** Validate the one host-authored annotation layer invariant. */
function annotationLayerIssue(layer: MapProjectedLayer): string | null {
  if (layer.id !== USER_ANNOTATION_LAYER_ID || layer.sourceCrs !== 'EPSG:4326'
    || layer.opacity !== 1 || !layer.visible || layer.sourceCallSeq !== 0
    || layer.artifactRef !== undefined || layer.resourceRef !== undefined) {
    return 'the protected annotation layer has fixed identity and presentation fields'
  }
  const features = layer.data?.features
  if (features === undefined || features.length === 0 || features.length > MAX_ANNOTATION_FEATURES) {
    return 'the annotation layer carries 1..300 features'
  }
  const ids = new Set<string>()
  let coordinates = 0
  for (const feature of features) {
    if (typeof feature.id !== 'string' || !ANNOTATION_FEATURE_ID.test(feature.id) || ids.has(feature.id)) {
      return 'annotation feature ids are stable and unique'
    }
    ids.add(feature.id)
    const geometry = feature.geometry
    if (geometry?.type === 'Point') coordinates += 1
    else if (geometry?.type === 'LineString' && Array.isArray(geometry.coordinates)) coordinates += geometry.coordinates.length
    else if (geometry?.type === 'Polygon' && Array.isArray(geometry.coordinates)) coordinates += geometry.coordinates[0]?.length ?? 0
    else return 'annotations support Point, LineString, and Polygon'
    const properties = feature.properties
    if (typeof properties !== 'object' || properties === null) return 'each annotation carries host-authored properties'
    const keys = Object.keys(properties).sort()
    const required = ['dshAuthor', 'dshCreateOperationId', 'dshCreatedAt', 'dshRole', 'dshSource', 'dshUpdateOperationId', 'dshUpdatedAt', 'description', 'name'].sort()
    const mandatory = required.filter(key => key !== 'description')
    if (keys.some(key => !required.includes(key)) || !mandatory.every(key => keys.includes(key))
      || annotationTextOf(properties.name, 96) === undefined
      || (Object.hasOwn(properties, 'description') && properties.description !== '' && annotationTextOf(properties.description, 512) === undefined)
      || properties.dshRole !== 'user-annotation'
      || !(properties.dshAuthor === 'user' && properties.dshSource === 'manual'
        || properties.dshAuthor === 'agent' && (properties.dshSource === 'visual-proposal' || properties.dshSource === 'visual-change'))
      || typeof properties.dshCreateOperationId !== 'string' || properties.dshCreateOperationId.length === 0 || properties.dshCreateOperationId.length > 96
      || typeof properties.dshUpdateOperationId !== 'string' || properties.dshUpdateOperationId.length === 0 || properties.dshUpdateOperationId.length > 96
      || typeof properties.dshCreatedAt !== 'string' || !ANNOTATION_TIMESTAMP.test(properties.dshCreatedAt)
      || typeof properties.dshUpdatedAt !== 'string' || !ANNOTATION_TIMESTAMP.test(properties.dshUpdatedAt)) {
      return 'annotation properties are the fixed host-authored vocabulary'
    }
  }
  if (coordinates > MAX_ANNOTATION_TOTAL_COORDINATES) return 'annotation coordinates exceed the total budget'
  if (layer.overrides !== undefined) {
    const known = featureIdsOf(layer)
    if (layer.overrides.entries.length > 16) return 'at most sixteen annotation style overrides are retained'
    for (const entry of layer.overrides.entries) {
      if (entry.featureIds.some(id => !known.has(id))) return 'annotation style overrides name existing features'
    }
  }
  if (layer.displayDigest !== stableDigestOf(layer.data)) return 'the annotation display digest must match its data'
  if (utf8ByteLength(layer) > MAX_ANNOTATION_LAYER_BYTES) return 'the annotation layer exceeds its byte budget'
  return null
}

/** The stable feature-id set one data layer's features derive (`featureIdOf` semantics). */
function featureIdsOf(layer: Pick<MapProjectedLayer, 'data'>): Set<string> {
  const features = (layer.data as { features?: readonly { id?: unknown }[] } | undefined)?.features ?? []
  const ids = new Set<string>()
  for (const [index, feature] of features.entries()) {
    ids.add(featureIdOf(feature, index))
  }
  return ids
}

/**
 * The post-state one applied operation left, in the identity terms the undo
 * target check compares: which layers exist with which digest, which ids are
 * absent, the layer order, the view/mode values, the AOI digest, and the
 * style versions of restyled layers.
 */
export interface MapOperationPostState {
  readonly layers?: readonly { readonly id: string; readonly digest: string }[]
  readonly absentIds?: readonly string[]
  readonly order?: readonly string[]
  readonly view?: MapViewRecord
  readonly mode?: 'map' | 'scene'
  /** Stable identity of the accepted selection left by the operation (`null` is the legacy default). */
  readonly basemapDigest?: string | null
  /** Stable identity of the imagery visibility and blend state left by the operation. */
  readonly imageryDisplayDigest?: string | null
  readonly aoiDigest?: string | null
  readonly styleVersions?: readonly { readonly layerId: string; readonly styleVersion: string }[]
  readonly layerStates?: readonly { readonly layerId: string; readonly visible: boolean; readonly opacity: number; readonly group: string | null }[]
  readonly symbolVersions?: readonly { readonly layerId: string; readonly symbolVersion: string }[]
  readonly overridesVersions?: readonly { readonly layerId: string; readonly overridesVersion: string }[]
  /** Whole-layer annotation identity left by an annotation operation. */
  readonly annotationDigest?: string | null
  /** Candidate identity left by an agent decision. */
  readonly visualDecisionDigest?: string
  /** Stable digest of the request, used to distinguish a retry from id reuse. */
  readonly requestDigest?: string
}

/** Prior annotation layer and any candidate/order state retained for a compensating undo. */
export interface MapAnnotationInverse {
  readonly layer: MapProjectedLayer | null
  readonly order?: readonly string[]
  readonly visualProposal?: VisualProposalRecord
  readonly visualChange?: VisualChangeRecord
}

/** One applied operation in the bounded audit ledger: the undo and idempotency source of truth. */
export interface MapOperationRecord {
  /** Monotonic 1-based operation index within this state (stable undo reference). */
  readonly index: number
  /** Client operation id when the writer supplied one (idempotency key). */
  readonly operationId: string | null
  /** Operation index this record compensates, when it is an undo. */
  readonly undoOf: number | null
  /** Writer id resolved by the collab service, when the writer carried one. */
  readonly writerId: string | null
  /** ToolRuntime call id of the settled result. */
  readonly callId: string
  /** Seq of the settled `tool/result`. */
  readonly resultSeq: number
  /** Post-apply projection revision. */
  readonly revision: number
  /** Bounded human-readable one-line summary. */
  readonly summary: string
  /** The compensating change (applies as a NEW revision), or `null` when the change has no inverse. */
  readonly inverse: MapChange | null
  /** Annotation and candidate inverse snapshot; ordinary changes leave this absent. */
  readonly annotationInverse?: MapAnnotationInverse | null
  /** The post-state the undo target check judges against the current document. */
  readonly post: MapOperationPostState
}

/** One pending visual-observation request: the client captures the view for this exact revision. */
export interface MapObservationRequest {
  /** Call id of the `tool/call` (map_observe) that requested the observation. */
  readonly callId: string
  /** Seq of the `tool/call` (map_observe) that requested the observation. */
  readonly requestSeq: number
  /** Map revision the observation must depict. */
  readonly revision: number
  /** Fold-time expiry: results submitted after this event time are stale. */
  readonly expiresAtMs: number
}

/** The plain-JSON persisted state of the `mapContainer` projection (cache-writeable by contract). */
export interface MapProjectionState {
  readonly interaction: import('./interaction-protocol.ts').MapInteractionState
  /** Self-describing persisted-state generation; the unit's `stateVersion` equals it. */
  readonly stateVersion: typeof MAP_PROJECTION_STATE_VERSION
  /** Layers in add order; ordered array, never a Map. */
  readonly layers: readonly MapProjectedLayer[]
  readonly view: MapViewRecord
  readonly mode: 'map' | 'scene'
  /** Explicit accepted selection; `null` remains the historical fixed World Imagery default. */
  readonly basemap: BasemapSelection | null
  /** Visibility, blend, and fixed early-release selection for the three imagery resources. */
  readonly imageryDisplay: ImageryDisplayState
  readonly waybackComparison: WaybackComparison | null
  /** The study AOI, when one is set; `null` clears it. */
  readonly aoi: MapAoi | null
  /** Increments once per applied map change; the `targetRevision` candidates cite. */
  readonly revision: number
  /** Call id of the last settled mutation result that changed the map. */
  readonly lastCallId: string | null
  /** Unsettled mutation calls in call order; entries carry the call identity. */
  readonly pendingCalls: readonly MapPendingCall[]
  /** Bounded, newest-last diagnostics for refused changes; read-only facts, never a write gate. */
  readonly diagnostics: readonly MapDiagnostic[]
  /** Bounded applied-operation ledger, oldest dropped first (undo horizon + idempotency window). */
  readonly operations: readonly MapOperationRecord[]
  /** The live visual-observation request a client occurrence should capture; `null` when none is pending. */
  readonly observationRequest: MapObservationRequest | null
  /** The last accepted observation evidence record; `null` when no `map-observation` meta has folded. */
  readonly latestObservation: MapObservationRecord | null
  /** Bounded, newest-last observation evidence records from this session's accepted calls. */
  readonly observationHistory: readonly MapObservationRecord[]
  /** Bounded, newest-last comparison records derived only from saved observations. */
  readonly comparisons: readonly MapComparisonRecord[]
  /** Bounded visual-proposal candidates, including reviewed records retained as evidence. */
  readonly visualProposals: readonly VisualProposalRecord[]
  /** Bounded visual-change candidates, including reviewed records retained as evidence. */
  readonly visualChanges: readonly VisualChangeRecord[]
}

/** Visibility and blending for reference labels, recent imagery, and fixed early imagery. */
export interface ImageryDisplayState {
  readonly labelsVisible: boolean
  readonly recentVisible: boolean
  readonly recentOpacity: number
  readonly earlyVisible: boolean
  readonly earlySource: BasemapSource | null
}

/**
 * One layer a `set-style` change restyles: the target layer and its new
 * style, or `null` to clear the layer's style (the compensating undo of a
 * first classification).
 */
export interface StyleChangeEntry {
  readonly layerId: string
  readonly style: StyleSpec | null
}

/** One layer a `set-layer-state` change retunes: the sparse presentation fields it sets. */
export interface LayerStateEntry {
  readonly layerId: string
  readonly visible?: boolean
  readonly opacity?: number
  /** Display group; `null` clears the layer's group membership. */
  readonly group?: string | null
}

/** One layer a `set-symbol-style` change restyles: the new symbol, or `null` to clear it. */
export interface SymbolStyleChangeEntry {
  readonly layerId: string
  readonly symbol: SymbolStyle | null
}

/** One layer a `set-feature-overrides` change retargets: the bare entries, or `null` to clear them. */
export interface FeatureOverridesChangeEntry {
  readonly layerId: string
  readonly overrides: readonly FeatureOverride[] | null
}

/**
 * The base change vocabulary: every change except `patch` itself, so a patch
 * nests a bounded, non-recursive list of them.
 */
export type BaseMapChange =
  | { readonly op: 'add-layer'; readonly layer: MapProjectedLayer }
  | { readonly op: 'remove-layer'; readonly layerId: string }
  | { readonly op: 'set-view'; readonly view: MapViewRecord }
  | { readonly op: 'set-mode'; readonly mode: 'map' | 'scene' }
  | { readonly op: 'set-basemap'; readonly selection: BasemapSelection | null }
  | { readonly op: 'set-imagery-display'; readonly display: ImageryDisplayState }
  | { readonly op: 'set-style'; readonly styles: readonly StyleChangeEntry[] }
  | { readonly op: 'reorder-layers'; readonly layerIds: readonly string[] }
  | { readonly op: 'set-aoi'; readonly aoi: MapAoi | null }
  | { readonly op: 'set-layer-state'; readonly states: readonly LayerStateEntry[] }
  | { readonly op: 'set-symbol-style'; readonly entries: readonly SymbolStyleChangeEntry[] }
  | { readonly op: 'set-feature-overrides'; readonly entries: readonly FeatureOverridesChangeEntry[] }

/** A candidate pure change one successful map mutation proposes. */
export type MapChange =
  | BaseMapChange
  | { readonly op: 'patch'; readonly changes: readonly BaseMapChange[] }

/** The versioned durable record a successful map mutation returns as `tool/result.meta`. */
export interface MapChangeMeta {
  readonly schemaVersion: typeof MAP_META_SCHEMA_VERSION
  readonly kind: typeof MAP_META_KIND
  /** Seq of this session's `tool/call` the candidate belongs to. */
  readonly sourceCallSeq: number
  /** Projection revision the candidate was validated against. */
  readonly targetRevision: number
  readonly change: MapChange
  /** Client operation id (v4): the idempotency key the fold's ledger checks. */
  readonly operationId?: string
  /** Operation index this change compensates (v4): undo proposals cite their target. */
  readonly undoOf?: number
  /** Writer id the collab service resolved for this call (v4); audit attribution. */
  readonly writerId?: string
}

/** Decode outcome for one durable meta value: applied-ready or refused with a code. */
export type DecodedMapChangeMeta =
  | { readonly status: 'ok'; readonly meta: MapChangeMeta }
  | { readonly status: 'refused'; readonly code: Exclude<MapDiagnosticCode, 'failed-result' | 'pending-overflow'> }

const viewRecordSchema = z.object({
  center: z.tuple([z.number(), z.number()]),
  zoom: z.number(),
  wkid: z.number().int(),
  scale: z.number().finite().positive().optional(),
  rotation: z.number().finite().optional(),
}).strict().check((view) => {
  const [lon, lat] = view.value.center
  if (!Number.isFinite(lon) || lon < -180 || lon > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    view.issues.push({ code: 'custom', message: 'view center must be finite WGS84 lon/lat', input: view.value, path: ['center'] })
  }
  if (!Number.isFinite(view.value.zoom) || view.value.zoom < 0 || view.value.zoom > 24) {
    view.issues.push({ code: 'custom', message: 'view zoom must be finite in [0, 24]', input: view.value, path: ['zoom'] })
  }
  if (!isSupportedDisplayWkid(view.value.wkid)) {
    view.issues.push({ code: 'custom', message: `unsupported display WKID ${view.value.wkid}`, input: view.value, path: ['wkid'] })
  }
})

/**
 * The wire schema of one persisted style payload. Structural shape here;
 * the semantic rules (break monotonicity, palette arity, measure parenthesis,
 * and the `styleVersion` re-derivation) run in the `.check` below through the
 * viz contract validator, so a style that fails either face refuses the whole
 * record read-only.
 */
const styleSpecSchema = z.object({
  methodVersion: z.literal('spatial-viz@1'),
  field: z.string().min(1),
  unit: z.string().min(1),
  measure: z.enum(['total', 'rate', 'density']),
  seriesIdentity: z.enum(['observed', 'forecast', 'scenario']),
  denominatorField: z.string().min(1).optional(),
  encoding: z.enum(['fill', 'size']),
  classification: z.enum(['quantile', 'equal-interval', 'manual']),
  breaks: z.array(z.number()).min(1).max(11),
  domain: z.object({ min: z.number(), max: z.number() }).strict(),
  palette: z.array(z.string()),
  missingColor: z.string(),
  overflowColor: z.string(),
  missingLabel: z.string().min(1),
  timeBinding: z.object({
    timeField: z.string().min(1),
    timezone: z.string().min(1),
    granularity: z.enum(['hour', 'day', 'week', 'month']),
    window: z.object({ from: z.string(), to: z.string() }).strict(),
  }).strict().optional(),
  breaksSourceRef: z.string().min(1).optional(),
  unifiedDomain: z.boolean().optional(),
  styleVersion: z.string().min(1),
}).strict().check((style) => {
  for (const issue of validateStyleSpec(style.value)) {
    style.issues.push({
      code: 'custom',
      message: `style ${issue.field} rejected: ${issue.code}`,
      input: style.value,
      path: ['style', issue.field],
    })
  }
})

const styleChangeEntrySchema = z.object({
  layerId: z.string().min(1),
  style: styleSpecSchema.nullable(),
}).strict()

/**
 * The wire schema of one persisted symbol payload: the map-layers validator
 * is the single structural authority, so a symbol that fails any rule
 * (vocabulary, bounds, presentation exclusivity, `symbolVersion`
 * re-derivation) refuses the whole record read-only.
 */
const symbolStyleSchema = z.custom<SymbolStyle>(
  value => validateSymbolStyle(value).length === 0,
  { message: 'symbol payload rejected by the map-layers contract validator' },
)

/** The wire schema of one persisted overrides record (`overridesVersion` re-derivation included). */
const featureOverridesSchema = z.custom<FeatureOverrides>(
  value => validateFeatureOverrides(value).length === 0,
  { message: 'overrides payload rejected by the map-layers contract validator' },
)

/** The wire schema of one persisted imagery identity (normalized key-free template). */
const imagerySpecSchema = z.custom<ImagerySpec>(
  value => validateImagerySpec(value).length === 0,
  { message: 'imagery payload rejected by the map-layers contract validator' },
)

/** One bare override entry a `set-feature-overrides` change carries (the fold derives the version). */
const featureOverrideEntrySchema = z.object({
  featureIds: z.array(z.string().min(1)).min(1),
  patch: z.record(z.string(), z.unknown()),
}).strict()

const layerStateChangeSchema = z.object({
  op: z.literal('set-layer-state'),
  states: z.array(z.object({
    layerId: z.string().min(1),
    visible: z.boolean().optional(),
    opacity: z.number().min(0).max(1).optional(),
    group: z.string().min(1).max(64).nullable().optional(),
  }).strict().check((entry) => {
    if (entry.value.visible === undefined && entry.value.opacity === undefined && entry.value.group === undefined) {
      entry.issues.push({ code: 'custom', message: 'each set-layer-state entry needs at least one field', input: entry.value, path: [] })
    }
    if (entry.value.group !== undefined && entry.value.group !== null && validateGroupName(entry.value.group) !== null) {
      entry.issues.push({ code: 'custom', message: 'group names must be 1..64 display characters', input: entry.value, path: ['group'] })
    }
  })).min(1).max(MAX_LAYER_STATE_ENTRIES).check((states) => {
    const seen = new Set<string>()
    for (const entry of states.value) {
      if (seen.has(entry.layerId)) {
        states.issues.push({ code: 'custom', message: `duplicate set-layer-state entry for layer ${entry.layerId}`, input: states.value, path: [] })
        break
      }
      seen.add(entry.layerId)
    }
  }),
}).strict()

const symbolStyleChangeSchema = z.object({
  op: z.literal('set-symbol-style'),
  entries: z.array(z.object({
    layerId: z.string().min(1),
    symbol: symbolStyleSchema.nullable(),
  }).strict()).min(1).max(MAX_SYMBOL_STYLE_ENTRIES),
}).strict()

const featureOverridesChangeSchema = z.object({
  op: z.literal('set-feature-overrides'),
  entries: z.array(z.object({
    layerId: z.string().min(1),
    overrides: z.array(featureOverrideEntrySchema).min(1).nullable(),
  }).strict()).min(1).max(MAX_FEATURE_OVERRIDE_ENTRIES),
}).strict()

/** The AOI wire/persisted schema: an optional name plus a bounded closed WGS84 ring. */
const mapAoiSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  ring: z.array(z.tuple([z.number(), z.number()])).min(3).max(MAX_AOI_RING_POINTS),
}).strict().check((aoi) => {
  for (const [index, [lon, lat]] of aoi.value.ring.entries()) {
    if (!Number.isFinite(lon) || lon < -180 || lon > 180 || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      aoi.issues.push({
        code: 'custom',
        message: `aoi ring point ${index} is not finite WGS84 lon/lat`,
        input: aoi.value,
        path: ['ring', index],
      })
      break
    }
  }
}) as unknown as z.ZodType<MapAoi>

/** The persisted basemap selection schema; `null` is a distinct legacy default. */
const basemapSelectionSchema = z.custom<BasemapSelection>(
  value => parseBasemapSelection(value).ok,
  { message: 'basemap selection rejected by the map-layers selection validator' },
)

/** The persisted visibility and blending state for the three imagery resources. */
const imageryDisplaySchema = z.object({
  labelsVisible: z.boolean(),
  recentVisible: z.boolean(),
  recentOpacity: z.number().min(0).max(1),
  earlyVisible: z.boolean(),
  earlySource: z.custom<BasemapSource>(value => {
    const parsed = parseBasemapSource(value)
    return parsed.ok && parsed.value.role === 'basemap' && waybackReleaseOf(parsed.value) !== null
  }, { message: 'early imagery requires a fixed World Imagery Wayback release' }).nullable(),
}).strict().check((display) => {
  if (display.value.earlyVisible && display.value.earlySource === null) {
    display.issues.push({
      code: 'custom',
      message: 'visible early imagery requires a fixed release',
      input: display.value,
      path: ['earlySource'],
    })
  }
}) as unknown as z.ZodType<ImageryDisplayState>

const setBasemapChangeSchema = z.object({
  op: z.literal('set-basemap'),
  selection: basemapSelectionSchema.nullable(),
}).strict()

const setImageryDisplayChangeSchema = z.object({
  op: z.literal('set-imagery-display'),
  display: imageryDisplaySchema,
}).strict()

const waybackComparisonSchema = z.custom<WaybackComparison>(isWaybackComparison, { message: 'invalid historical comparison' })

const reorderChangeSchema = z.object({
  op: z.literal('reorder-layers'),
  layerIds: z.array(z.string().min(1)).min(1).max(MAX_PATCH_CHANGES * 8),
}).strict()

const setAoiChangeSchema = z.object({
  op: z.literal('set-aoi'),
  aoi: mapAoiSchema.nullable(),
}).strict()

const projectedLayerTerrainSchema = z.object({
  surfaceRef: z.string().min(1),
  revision: z.string().min(1),
  verticalDatum: z.string().min(1),
  verticalUnits: z.string().min(1),
  epoch: z.string().min(1),
  elevationField: z.string().min(1),
  gridColumns: z.number().int().positive(),
  gridRows: z.number().int().positive(),
  sourcePointCount: z.number().int().positive(),
}).strict()

/**
 * The wire schema of one stream-workbench identity. Structural shape here;
 * the semantic rules run in the `.check` below through the spatial-realtime
 * checkpoint decoder, so a block whose checkpoint could not resume refuses
 * the whole record read-only instead of stranding the workbench.
 */
const projectedLayerStreamSchema = z.object({
  streamId: z.string().min(1),
  scenarioRef: z.string().min(1),
  scenarioRevision: z.string().min(1),
  mode: z.enum(['realtime', 'materialized']),
  methodVersion: z.string().min(1),
  windowSizeMs: z.number().positive(),
  allowedLatenessMs: z.number().nonnegative(),
  watermarkMs: z.number().nullable(),
  lagMs: z.number().nullable(),
  paused: z.boolean(),
  revision: z.number().int().nonnegative(),
  closedWindows: z.number().int().nonnegative(),
  gapWindows: z.number().int().nonnegative(),
  lateRevisions: z.number().int().nonnegative(),
  duplicatesDropped: z.number().int().nonnegative(),
  offlineBatches: z.number().int().nonnegative(),
  checkpoint: z.unknown(),
  materialized: z.array(z.object({
    exportDigest: z.string().min(1),
    artifactRef: z.string().min(1),
  }).strict()).optional(),
}).strict().check((stream) => {
  const value = stream.value as MapLayerStream
  const decoded = decodeCheckpoint(value.checkpoint)
  if (decoded.status === 'refused') {
    stream.issues.push({
      code: 'custom',
      message: `stream checkpoint refused (${decoded.code}); the workbench could not resume`,
      input: value,
      path: ['stream', 'checkpoint'],
    })
  }
  if (value.mode === 'materialized' && (value.materialized === undefined || value.materialized.length === 0)) {
    stream.issues.push({
      code: 'custom',
      message: 'a materialized stream layer must cite at least one materialization pin',
      input: value,
      path: ['stream', 'materialized'],
    })
  }
}) as unknown as z.ZodType<MapLayerStream>

const projectedLayerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  role: z.enum(['user-annotation', 'visual-proposal', 'visual-change']).optional(),
  data: z.unknown().optional(),
  sourceCrs: z.string(),
  opacity: z.number().min(0).max(1),
  visible: z.boolean(),
  sourceCallSeq: z.number().int().nonnegative(),
  displayDigest: z.string().min(1).optional(),
  artifactRef: z.string().min(1).optional(),
  resourceRef: z.string().min(1).optional(),
  legend: z.object({
    title: z.string(),
    symbol: z.object({ color: z.string(), outline: z.string() }).strict(),
  }).strict().optional(),
  style: styleSpecSchema.optional(),
  symbol: symbolStyleSchema.optional(),
  overrides: featureOverridesSchema.optional(),
  group: z.string().min(1).max(64).optional(),
  imagery: imagerySpecSchema.optional(),
  terrain: projectedLayerTerrainSchema.optional(),
  stream: projectedLayerStreamSchema.optional(),
}).strict().check((layer) => {
  if (layer.value.role === 'user-annotation') {
    const issue = annotationLayerIssue(layer.value as MapProjectedLayer)
    if (issue !== null) {
      layer.issues.push({ code: 'custom', message: issue, input: layer.value, path: ['role'] })
    }
  }
  // An imagery layer is its tile template — it carries no feature data, and
  // a data layer never carries an imagery identity: exactly one of the two.
  const hasData = layer.value.data !== undefined
  const hasImagery = layer.value.imagery !== undefined
  if (hasData === hasImagery) {
    layer.issues.push({
      code: 'custom',
      message: 'a layer carries exactly one payload: GeoJSON data or an imagery identity',
      input: layer.value,
      path: ['data'],
    })
  }
  if (hasData) {
    try {
      validateGeoJsonValue(layer.value.data, {
        enforceWgs84Range: true,
        allowedGeometryTypes: DISPLAY_GEOMETRY_SET,
      })
    } catch (error) {
      layer.issues.push({
        code: 'custom',
        message: error instanceof Error ? error.message : 'layer data failed GeoJSON admission',
        input: layer.value,
        path: ['data'],
      })
    }
  }
  // A heatmap presentation and a classification style are both color
  // authorities for the whole layer; carrying both is refused rather than
  // averaged. (The all-Point data requirement is data-dependent and runs at
  // the candidate/fold boundaries, not in this structural schema.)
  if (layer.value.symbol !== undefined && layer.value.symbol.presentation === 'heatmap' && layer.value.style !== undefined) {
    layer.issues.push({
      code: 'custom',
      message: 'a heatmap presentation cannot coexist with a classification style',
      input: layer.value,
      path: ['symbol'],
    })
  }
  if (layer.value.group !== undefined && validateGroupName(layer.value.group) !== null) {
    layer.issues.push({
      code: 'custom',
      message: 'group names must be 1..64 display characters',
      input: layer.value,
      path: ['group'],
    })
  }
  // A terrain identity only makes sense bound to the surface version the
  // layer renders: the layer must carry catalog identity citing that ref.
  if (layer.value.terrain !== undefined && layer.value.resourceRef !== layer.value.terrain.surfaceRef) {
    layer.issues.push({
      code: 'custom',
      message: 'a terrain layer must cite the bound surface ref as its resourceRef',
      input: layer.value,
      path: ['layer', 'terrain', 'surfaceRef'],
    })
  }
  // A stream layer is its workbench: the layer id must be the stream id so
  // every later stream_* call resolves the same record deterministically,
  // and the layer carries catalog identity citing the bound scenario ref —
  // the derived windows come from that exact version.
  if (layer.value.stream !== undefined && layer.value.id !== layer.value.stream.streamId) {
    layer.issues.push({
      code: 'custom',
      message: 'a stream layer id must equal its streamId',
      input: layer.value,
      path: ['layer', 'stream', 'streamId'],
    })
  }
  if (layer.value.stream !== undefined && layer.value.resourceRef !== layer.value.stream.scenarioRef) {
    layer.issues.push({
      code: 'custom',
      message: 'a stream layer must cite the bound scenario ref as its resourceRef',
      input: layer.value,
      path: ['layer', 'stream', 'scenarioRef'],
    })
  }
})

const patchChangeSchema = z.object({
  op: z.literal('patch'),
  changes: z.array(z.discriminatedUnion('op', [
    z.object({ op: z.literal('add-layer'), layer: projectedLayerSchema }).strict(),
    z.object({ op: z.literal('remove-layer'), layerId: z.string().min(1) }).strict(),
    z.object({ op: z.literal('set-view'), view: viewRecordSchema }).strict(),
    z.object({ op: z.literal('set-mode'), mode: z.enum(['map', 'scene']) }).strict(),
    setBasemapChangeSchema,
    setImageryDisplayChangeSchema,
    z.object({ op: z.literal('set-style'), styles: z.array(styleChangeEntrySchema).min(1).max(8) }).strict(),
    layerStateChangeSchema,
    symbolStyleChangeSchema,
    featureOverridesChangeSchema,
    reorderChangeSchema,
    setAoiChangeSchema,
  ])).min(1).max(MAX_PATCH_CHANGES),
}).strict()

const changeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add-layer'), layer: projectedLayerSchema }).strict(),
  z.object({ op: z.literal('remove-layer'), layerId: z.string().min(1) }).strict(),
  z.object({ op: z.literal('set-view'), view: viewRecordSchema }).strict(),
  z.object({ op: z.literal('set-mode'), mode: z.enum(['map', 'scene']) }).strict(),
  setBasemapChangeSchema,
  setImageryDisplayChangeSchema,
  z.object({ op: z.literal('set-style'), styles: z.array(styleChangeEntrySchema).min(1).max(8) }).strict(),
  layerStateChangeSchema,
  symbolStyleChangeSchema,
  featureOverridesChangeSchema,
  reorderChangeSchema,
  setAoiChangeSchema,
  patchChangeSchema,
]).check((change) => {
  // Catalog-backed layers must cite their display digest, so the browser
  // identity is always derivable for versioned layers.
  if (change.value.op === 'add-layer') {
    const { layer } = change.value
    if ((layer.artifactRef !== undefined || layer.resourceRef !== undefined) && layer.displayDigest === undefined) {
      change.issues.push({
        code: 'custom',
        message: 'a layer with catalog identity must carry its displayDigest',
        input: layer,
        path: ['change', 'layer', 'displayDigest'],
      })
    }
  }
  if (change.value.op === 'patch') {
    for (const nested of change.value.changes) {
      if (nested.op === 'add-layer') {
        const { layer } = nested
        if ((layer.artifactRef !== undefined || layer.resourceRef !== undefined) && layer.displayDigest === undefined) {
          change.issues.push({
            code: 'custom',
            message: 'a layer with catalog identity must carry its displayDigest',
            input: nested,
            path: ['change', 'changes'],
          })
        }
      }
    }
  }
})

/** Durable map-change meta schema: v3 layers may carry styles; v4 adds collaboration changes; v5 adds layer-state changes; v6 adds basemap selection; v1–v5 records decode without the newer fields. */
export const mapChangeMetaSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(7), z.literal(MAP_META_SCHEMA_VERSION)]),
  kind: z.literal(MAP_META_KIND),
  sourceCallSeq: z.number().int().nonnegative(),
  targetRevision: z.number().int().nonnegative(),
  change: changeSchema,
  operationId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
  undoOf: z.number().int().nonnegative().optional(),
  writerId: z.string().min(1).max(64).optional(),
}).strict().check((meta) => {
  const viewChanges = meta.value.change.op === 'patch' ? meta.value.change.changes : [meta.value.change]
  if (meta.value.schemaVersion < 7 && viewChanges.some(change => change.op === 'set-view'
    && (change.view.scale !== undefined || change.view.rotation !== undefined))) {
    meta.issues.push({ code: 'custom', message: 'exact camera fields require meta version 7', input: meta.value, path: ['schemaVersion'] })
  }
  // A v1 or v2 record predates styles entirely; only v3+ records may carry a
  // set-style change, so an older record naming one refuses read-only.
  const carriesStyle = meta.value.change.op === 'set-style'
    || (meta.value.change.op === 'patch' && meta.value.change.changes.some(nested => nested.op === 'set-style'))
  if (carriesStyle && meta.value.schemaVersion < 3) {
    meta.issues.push({
      code: 'custom',
      message: 'set-style changes require meta schema version 3 or later',
      input: meta.value,
      path: ['schemaVersion'],
    })
  }
  // The collaboration plane (patch / reorder / set-aoi changes and the
  // identity fields) arrived with v4; an older record naming one refuses
  // read-only instead of being misread.
  const carriesCollabChange = meta.value.change.op === 'patch'
    || meta.value.change.op === 'reorder-layers'
    || meta.value.change.op === 'set-aoi'
  if ((carriesCollabChange || meta.value.operationId !== undefined || meta.value.undoOf !== undefined || meta.value.writerId !== undefined)
    && meta.value.schemaVersion < 4) {
    meta.issues.push({
      code: 'custom',
      message: 'collaboration-plane changes and identity fields require meta schema version 4 or later',
      input: meta.value,
      path: ['schemaVersion'],
    })
  }
  // The layer-state changes (set-layer-state / set-symbol-style /
  // set-feature-overrides) arrived with v5; an older record naming one
  // refuses read-only rather than folding a presentation it cannot track.
  const carriesLayerStateChange = meta.value.change.op === 'set-layer-state'
    || meta.value.change.op === 'set-symbol-style'
    || meta.value.change.op === 'set-feature-overrides'
    || (meta.value.change.op === 'patch' && meta.value.change.changes.some(nested =>
      nested.op === 'set-layer-state' || nested.op === 'set-symbol-style' || nested.op === 'set-feature-overrides'))
  if (carriesLayerStateChange && meta.value.schemaVersion < 5) {
    meta.issues.push({
      code: 'custom',
      message: 'layer-state changes require meta schema version 5 or later',
      input: meta.value,
      path: ['schemaVersion'],
    })
  }
  if (meta.value.change.op === 'set-basemap' && meta.value.schemaVersion < 6) {
    meta.issues.push({
      code: 'custom',
      message: 'set-basemap changes require meta schema version 6',
      input: meta.value,
      path: ['schemaVersion'],
    })
  }
  const carriesImageryDisplayChange = meta.value.change.op === 'set-imagery-display'
    || (meta.value.change.op === 'patch' && meta.value.change.changes.some(nested => nested.op === 'set-imagery-display'))
  if (carriesImageryDisplayChange && meta.value.schemaVersion < 8) {
    meta.issues.push({
      code: 'custom',
      message: 'set-imagery-display changes require meta schema version 8',
      input: meta.value,
      path: ['schemaVersion'],
    })
  }
  // Terrain identities arrived inside the v4 add-layer layers (an additive
  // field, not a new change): an older record naming one refuses read-only
  // rather than folding a layer whose revision it cannot track.
  const layersOf = (change: typeof meta.value.change): readonly unknown[] | undefined => {
    if (change.op === 'add-layer') return [change.layer]
    if (change.op === 'patch') return change.changes.filter(nested => nested.op === 'add-layer')
    return undefined
  }
  const carriesTerrain = layersOf(meta.value.change)?.some(layer =>
    layer !== null && typeof layer === 'object' && 'terrain' in layer && layer.terrain !== undefined)
  if (carriesTerrain && meta.value.schemaVersion < 4) {
    meta.issues.push({
      code: 'custom',
      message: 'terrain layer identities require meta schema version 4 or later',
      input: meta.value,
      path: ['schemaVersion'],
    })
  }
  // Stream workbench identities arrived inside the v4 add-layer layers (an
  // additive field, not a new change): an older record naming one refuses
  // read-only rather than folding a workbench whose checkpoint it cannot
  // track.
  const carriesStream = layersOf(meta.value.change)?.some(layer =>
    layer !== null && typeof layer === 'object' && 'stream' in layer && layer.stream !== undefined)
  if (carriesStream && meta.value.schemaVersion < 4) {
    meta.issues.push({
      code: 'custom',
      message: 'stream workbench identities require meta schema version 4 or later',
      input: meta.value,
      path: ['schemaVersion'],
    })
  }
  // The layer presentation fields (symbol / overrides / group) and the
  // imagery identity arrived inside the v5 add-layer layers: an older
  // record naming one refuses read-only.
  const carriesPresentationField = layersOf(meta.value.change)?.some(layer => {
    if (layer === null || typeof layer !== 'object') return false
    return ('symbol' in layer && layer.symbol !== undefined)
      || ('overrides' in layer && layer.overrides !== undefined)
      || ('group' in layer && layer.group !== undefined)
      || ('imagery' in layer && layer.imagery !== undefined)
  })
  if (carriesPresentationField && meta.value.schemaVersion < 5) {
    meta.issues.push({
      code: 'custom',
      message: 'layer presentation fields and imagery identities require meta schema version 5 or later',
      input: meta.value,
      path: ['schemaVersion'],
    })
  }
}) as unknown as z.ZodType<MapChangeMeta>

/** Persisted projection state schema: validates cache rows and restore seeds. */
export const mapProjectionStateSchema = z.object({
  interaction: mapInteractionStateSchema,
  stateVersion: z.literal(MAP_PROJECTION_STATE_VERSION),
  layers: z.array(projectedLayerSchema).max(MAX_MAP_LAYERS),
  view: viewRecordSchema,
  mode: z.enum(['map', 'scene']),
  basemap: basemapSelectionSchema.nullable(),
  imageryDisplay: imageryDisplaySchema,
  waybackComparison: waybackComparisonSchema.nullable(),
  aoi: mapAoiSchema.nullable(),
  revision: z.number().int().nonnegative(),
  lastCallId: z.string().nullable(),
  pendingCalls: z.array(z.object({
    callId: z.string().min(1),
    callSeq: z.number().int().nonnegative(),
    name: z.enum([...MAP_MUTATION_TOOL_NAMES, ...MAP_PENDING_TOOL_NAMES]),
  }).strict()).max(MAX_PENDING_MAP_CALLS),
  diagnostics: z.array(z.object({
    seq: z.number().int().nonnegative(),
    code: z.enum([
      'failed-result',
      'unknown-schema-version',
      'unknown-kind',
      'invalid-meta',
      'oversized-meta',
      'call-pairing',
      'stale-revision',
      'capacity',
      'pending-overflow',
      'style-layer-unknown',
      'layer-unknown',
      'feature-unknown',
      'invalid-view',
      'duplicate-op',
      'observation-pairing',
      'observation-oversized',
      'annotation-limit',
      'geometry-invalid',
      'annotation-unknown',
      'annotation-protected',
      'visual-proposal-pairing',
      'visual-proposal-limit',
      'visual-proposal-unknown',
      'visual-proposal-protected',
      'comparison-pairing',
      'comparison-limit',
      'comparison-unknown',
      'comparison-protected',
    ]),
  }).strict()).max(MAX_MAP_DIAGNOSTICS),
  operations: z.array(z.object({
    index: z.number().int().nonnegative(),
    operationId: z.string().nullable(),
    undoOf: z.number().int().nonnegative().nullable(),
    writerId: z.string().nullable(),
    callId: z.string(),
    resultSeq: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    summary: z.string(),
    inverse: z.unknown().nullable(),
    annotationInverse: z.unknown().nullable().optional(),
    post: z.unknown(),
  }).strict()).max(MAX_MAP_OPERATION_RECORDS),
  observationRequest: z.object({
    callId: z.string().min(1),
    requestSeq: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    expiresAtMs: z.number(),
  }).nullable(),
  latestObservation: mapObservationRecordSchema.nullable(),
  observationHistory: z.array(mapObservationRecordSchema).max(MAX_MAP_OBSERVATION_HISTORY),
  comparisons: z.array(mapComparisonRecordSchema).max(MAX_VISUAL_COMPARISONS),
  visualProposals: z.array(visualProposalRecordSchema).max(MAX_ACTIVE_VISUAL_PROPOSALS * 3),
  visualChanges: z.array(visualChangeRecordSchema).max(MAX_VISUAL_CHANGE_CANDIDATES),
}).strict().check((state) => {
  if (utf8ByteLength(state.value) > MAX_PROJECTION_STATE_BYTES) {
    state.issues.push({ code: 'custom', message: `map projection exceeds the ${MAX_PROJECTION_STATE_BYTES} byte limit`, input: state.value, path: [] })
  }
}) as z.ZodType<MapProjectionState>

/** One observation evidence candidate accepted only for its live request and bounded projection. */
export type ObservationCandidateVerdict =
  | { readonly ok: true; readonly state: MapProjectionState }
  | { readonly ok: false; readonly code: 'observation-pairing' | 'invalid-meta' | 'observation-oversized' }

/**
 * Validate and settle one observation record without mutating the input
 * projection. Both the tool and projection fold use this same pure candidate
 * check, so metadata cannot publish a record the checkpoint reader rejects.
 * @param state - current authoritative projection.
 * @param record - untrusted record to pair and fold.
 * @returns the candidate state or its bounded refusal code.
 */
export function observationCandidateOf(
  state: MapProjectionState,
  record: MapObservationRecord,
): ObservationCandidateVerdict {
  const request = state.observationRequest
  if (request === null || request.callId !== record.callId || request.requestSeq !== record.requestSeq
    || request.revision !== record.mapRevision || state.revision !== request.revision) {
    return { ok: false, code: 'observation-pairing' }
  }
  const parsedRecord = mapObservationRecordSchema.safeParse(record)
  if (!parsedRecord.success) return { ok: false, code: 'invalid-meta' }
  if (parsedRecord.data.basemap !== undefined
    && JSON.stringify(parsedRecord.data.basemap) !== JSON.stringify(state.basemap)) {
    return { ok: false, code: 'observation-pairing' }
  }
  const history = [...state.observationHistory, parsedRecord.data].slice(-MAX_MAP_OBSERVATION_HISTORY)
  const candidate = { ...state, observationRequest: null, latestObservation: parsedRecord.data, observationHistory: history }
  if (utf8ByteLength(candidate) > MAX_PROJECTION_STATE_BYTES) {
    return { ok: false, code: 'observation-oversized' }
  }
  const parsedCandidate = mapProjectionStateSchema.safeParse(candidate)
  if (!parsedCandidate.success) return { ok: false, code: 'invalid-meta' }
  return { ok: true, state: parsedCandidate.data }
}

/**
 * Fold one accepted visual-proposal batch into the candidate records and
 * derive the read-only candidate layer. Every refusal leaves the input state
 * unchanged apart from a bounded diagnostic; a replayed proposal id never
 * creates a second candidate.
 * @param state - accepted projection state with the pending call removed.
 * @param input - settled result identity, error flag, durable meta, and citation.
 * @returns the next state.
 */
export function settleVisualProposalResult(
  state: MapProjectionState,
  input: SettleMapResultInput,
): MapProjectionState {
  const { resultSeq, pending, isError, meta, citedCallSeq, citedCallSeqs } = input
  if (pending.name !== 'map_markup') return state
  if (isError) return meta === undefined ? state : withDiagnostic(state, resultSeq, 'failed-result')
  if (meta === undefined) return state
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)
    || (meta as { kind?: unknown }).kind !== VISUAL_PROPOSAL_META_KIND) {
    return withDiagnostic(state, resultSeq, 'unknown-kind')
  }
  const decoded = decodeVisualProposalMeta(meta)
  if (decoded.status !== 'ok') return withDiagnostic(state, resultSeq, decoded.code)
  const citations = citedCallSeqs ?? (citedCallSeq === undefined ? undefined : [citedCallSeq])
  if (citations !== undefined && (citations.length !== 1 || citations[0] !== pending.callSeq)) {
    return withDiagnostic(state, resultSeq, 'call-pairing')
  }
  if (decoded.meta.record.proposals.some(proposal => state.visualProposals.some(existing => existing.proposalId === proposal.proposalId))) {
    return withDiagnostic(state, resultSeq, 'duplicate-op')
  }
  const code = visualProposalPairingCode(state, decoded.meta, pending.callId, pending.callSeq, state.visualProposals)
  if (code !== null) return withDiagnostic(state, resultSeq, code)
  const proposals = [...state.visualProposals, ...decoded.meta.record.proposals]
  const derived = visualProposalLayerOf(proposals)
  const ordinary = state.layers.filter(layer => layer.role !== 'visual-proposal'
    && layer.id !== VISUAL_PROPOSAL_LAYER_ID)
  const layers = derived === undefined ? ordinary : [derived, ...ordinary]
  const next: MapProjectionState = {
    ...state,
    layers,
    visualProposals: proposals,
    revision: state.revision + 1,
    lastCallId: pending.callId,
  }
  return mapProjectionStateSchema.safeParse(next).success ? next : withDiagnostic(state, resultSeq, 'visual-proposal-limit')
}

/**
 * Fold one complete accepted visual-change batch into candidate records and
 * derive the read-only change-candidate layer. Every refusal leaves the
 * input state unchanged apart from a bounded diagnostic; a replayed record
 * never creates a second candidate.
 * @param state - accepted projection state with the pending call removed.
 * @param input - settled result identity, error flag, durable meta, and citation.
 * @returns the next state.
 */
export function settleVisualChangeResult(
  state: MapProjectionState,
  input: SettleMapResultInput,
): MapProjectionState {
  const { resultSeq, pending, isError, meta, citedCallSeq, citedCallSeqs } = input
  if (pending.name !== 'map_mark_changes') return state
  if (isError) return meta === undefined ? state : withDiagnostic(state, resultSeq, 'failed-result')
  if (meta === undefined) return state
  const decoded = decodeVisualChangeMeta(meta)
  if (decoded.status !== 'ok') return withDiagnostic(state, resultSeq, decoded.code === 'unknown-kind' ? 'unknown-kind' : 'comparison-pairing')
  const citations = citedCallSeqs ?? (citedCallSeq === undefined ? undefined : [citedCallSeq])
  if (citations !== undefined && (citations.length !== 1 || citations[0] !== pending.callSeq)) {
    return withDiagnostic(state, resultSeq, 'call-pairing')
  }
  if (decoded.meta.record.changes.some(change => state.visualChanges.some(existing => existing.changeId === change.changeId))) {
    return withDiagnostic(state, resultSeq, 'duplicate-op')
  }
  const code = visualChangePairingCode(state, decoded.meta, pending.callId, pending.callSeq, state.visualChanges)
  if (code !== null) return withDiagnostic(state, resultSeq, code)
  const changes = [...state.visualChanges, ...decoded.meta.record.changes].slice(-MAX_VISUAL_CHANGE_CANDIDATES)
  const derived = visualChangeLayerOf(changes)
  const ordinary = state.layers.filter(layer => layer.role !== 'visual-change' && layer.id !== VISUAL_CHANGE_LAYER_ID)
  const layers = derived === undefined ? ordinary : [derived, ...ordinary]
  const next: MapProjectionState = {
    ...state,
    layers,
    visualChanges: changes,
    revision: state.revision + 1,
    lastCallId: pending.callId,
  }
  return mapProjectionStateSchema.safeParse(next).success ? next : withDiagnostic(state, resultSeq, 'comparison-limit')
}

/** The initial plain-JSON state for a fresh session's container. */
export function initialMapProjectionState(): MapProjectionState {
  return {
    interaction: initialMapInteractionState(),
    stateVersion: MAP_PROJECTION_STATE_VERSION,
    layers: [],
    // China-wide opening view (中国全境): center on the country's centroid
    // at a zoom that frames the mainland without clipping the coast.
    view: { center: [104.9, 36.4], zoom: 4, wkid: 4326 },
    mode: 'map',
    basemap: null,
    imageryDisplay: {
      labelsVisible: true,
      recentVisible: true,
      recentOpacity: 1,
      earlyVisible: false,
      earlySource: null,
    },
    waybackComparison: null,
    aoi: null,
    revision: 0,
    lastCallId: null,
    pendingCalls: [],
    observationRequest: null,
    latestObservation: null,
    observationHistory: [],
    comparisons: [],
    visualProposals: [],
    visualChanges: [],
    diagnostics: [],
    operations: [],
  }
}

/** Pre-commit failure: the candidate violates capacity or payload bounds against the current state. */
export type MapChangeErrorCode =
  | 'capacity' | 'oversized-meta' | 'style-layer-unknown' | 'layer-unknown'
  | 'feature-unknown' | 'invalid-view' | 'invalid-meta' | 'annotation-limit'
  | 'geometry-invalid' | 'annotation-unknown' | 'annotation-protected' | 'stale-revision'
  | 'visual-proposal-limit' | 'visual-proposal-unknown' | 'visual-proposal-protected'

/** Refusal raised when a map change candidate violates the current state bounds. */
export class MapChangeValidationError extends Error {
  /** Machine-readable refusal code for the model-facing error path. */
  readonly code: MapChangeErrorCode
  constructor(code: MapChangeErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

function annotationPointOf(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const [lon, lat] = value
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)
    || lon < -180 || lon > 180 || lat < -90 || lat > 90) return undefined
  return [lon, lat]
}

function pointsOf(value: unknown): readonly [number, number][] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ANNOTATION_FEATURE_COORDINATES) return undefined
  const points: [number, number][] = []
  for (const entry of value) {
    const point = annotationPointOf(entry)
    if (point === undefined) return undefined
    points.push(point)
  }
  return points
}

function orientation(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

function onSegment(a: readonly [number, number], b: readonly [number, number], point: readonly [number, number]): boolean {
  return point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0])
    && point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1])
}

function segmentsIntersect(
  left: readonly [readonly [number, number], readonly [number, number]],
  right: readonly [readonly [number, number], readonly [number, number]],
): boolean {
  const [a, b] = left
  const [c, d] = right
  const o1 = orientation(a, b, c)
  const o2 = orientation(a, b, d)
  const o3 = orientation(c, d, a)
  const o4 = orientation(c, d, b)
  return (o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)
    || (o1 === 0 && onSegment(a, b, c))
    || (o2 === 0 && onSegment(a, b, d))
    || (o3 === 0 && onSegment(c, d, a))
    || (o4 === 0 && onSegment(c, d, b))
}

/**
 * Validate one annotation geometry and return its coordinate count.
 * @param geometry - untrusted browser input.
 * @returns the finite WGS84 coordinate count, or throws a typed refusal.
 */
export function validateAnnotationGeometry(geometry: AnnotationGeometry): number {
  if (geometry.type === 'Point') {
    if (pointsOf([geometry.coordinates]) === undefined) throw new MapChangeValidationError('geometry-invalid', 'annotation coordinates must be finite WGS84 lon/lat')
    return 1
  }
  if (geometry.type === 'LineString') {
    const points = pointsOf(geometry.coordinates)
    if (points === undefined || points.length < 2) throw new MapChangeValidationError('geometry-invalid', 'an annotation line needs 2..1024 finite coordinates')
    if (points.some((point, at) => at > 0 && point[0] === points[at - 1]![0] && point[1] === points[at - 1]![1])) {
      throw new MapChangeValidationError('geometry-invalid', 'adjacent annotation line vertices must differ')
    }
    return points.length
  }
  const rings = geometry.coordinates
  if (!Array.isArray(rings) || rings.length !== 1) throw new MapChangeValidationError('geometry-invalid', 'first-version annotations carry exactly one polygon ring')
  const ring = pointsOf(rings[0])
  if (ring === undefined || ring.length < 4) throw new MapChangeValidationError('geometry-invalid', 'an annotation polygon needs three distinct vertices and a closed ring')
  const first = ring[0]!
  const last = ring[ring.length - 1]!
  if (first[0] !== last[0] || first[1] !== last[1]) throw new MapChangeValidationError('geometry-invalid', 'an annotation polygon ring must be closed')
  if (ring.some((point, at) => at > 0 && point[0] === ring[at - 1]![0] && point[1] === ring[at - 1]![1])) {
    throw new MapChangeValidationError('geometry-invalid', 'adjacent annotation polygon vertices must differ')
  }
  const segments = ring.slice(0, -1).map((start, at) => [start, ring[at + 1]!] as const)
  for (let left = 0; left < segments.length; left += 1) {
    for (let right = left + 2; right < segments.length; right += 1) {
      if (left === 0 && right === segments.length - 1) continue
      if (segmentsIntersect(segments[left]!, segments[right]!)) {
        throw new MapChangeValidationError('geometry-invalid', 'annotation polygon rings may not self-intersect')
      }
    }
  }
  return ring.length
}

/** Whether a model change targets the protected annotation layer. */
function namesProtectedAnnotationLayer(change: MapChange): 'annotation' | 'visual-proposal' | false {
  const proposalLayer = (id: string): boolean => id === VISUAL_PROPOSAL_LAYER_ID
  const annotation = (() => {
    if (change.op === 'add-layer') return change.layer.id === USER_ANNOTATION_LAYER_ID || change.layer.role === 'user-annotation'
    if (change.op === 'remove-layer') return change.layerId === USER_ANNOTATION_LAYER_ID
    if (change.op === 'set-style') return change.styles.some(entry => entry.layerId === USER_ANNOTATION_LAYER_ID)
    if (change.op === 'set-layer-state') return change.states.some(entry => entry.layerId === USER_ANNOTATION_LAYER_ID)
    if (change.op === 'set-symbol-style') return change.entries.some(entry => entry.layerId === USER_ANNOTATION_LAYER_ID)
    if (change.op === 'set-feature-overrides') return change.entries.some(entry => entry.layerId === USER_ANNOTATION_LAYER_ID)
    if (change.op === 'reorder-layers') return change.layerIds.includes(USER_ANNOTATION_LAYER_ID)
    return false
  })()
  if (annotation) return 'annotation'
  const proposal = change.op === 'add-layer' ? change.layer.id === VISUAL_PROPOSAL_LAYER_ID || change.layer.role === 'visual-proposal'
    : change.op === 'remove-layer' ? proposalLayer(change.layerId)
      : change.op === 'set-style' ? change.styles.some(entry => proposalLayer(entry.layerId))
        : change.op === 'set-layer-state' ? change.states.some(entry => proposalLayer(entry.layerId))
          : change.op === 'set-symbol-style' || change.op === 'set-feature-overrides' ? change.entries.some(entry => proposalLayer(entry.layerId))
            : change.op === 'reorder-layers' ? change.layerIds.some(proposalLayer) : false
  return proposal ? 'visual-proposal' : false
}

/**
 * Validate one candidate change against the accepted state before the tool
 * returns it: cumulative layer capacity, per-change meta bounds, and the
 * cumulative projection budget. A `patch` change validates its nested
 * changes sequentially against the state each earlier nested change would
 * produce, so the whole list is feasible atomically. Passing returns the
 * revision the candidate targets (the current one).
 * @param state - the accepted projection state the candidate was computed against.
 * @param change - the pure candidate the successful result will carry.
 * @returns the `targetRevision` the durable meta must cite.
 * @throws {MapChangeValidationError} when capacity, payload, or cumulative bounds refuse the change.
 */
export function validateMapChangeCandidate(state: MapProjectionState, change: MapChange): number {
  if (utf8ByteLength(change) > MAX_CHANGE_META_BYTES) {
    throw new MapChangeValidationError(
      'oversized-meta',
      `map change metadata exceeds the ${MAX_CHANGE_META_BYTES} byte limit`,
    )
  }
  if (change.op === 'patch') {
    // Sequential feasibility: every nested change validates against the
    // state its earlier siblings produce, so the whole list applies
    // atomically or refuses before the tool returns anything.
    let working = state
    for (const nested of change.changes) {
      validateMapChangeCandidate(working, nested)
      working = applyChangeLayers(working, nested)
    }
    validatePatchBudget(change, working)
    return state.revision
  }
  const protectedLayer = namesProtectedAnnotationLayer(change)
  if (protectedLayer === 'annotation') {
    throw new MapChangeValidationError('annotation-protected', 'user annotations change only through the confirmed user path')
  }
  if (protectedLayer === 'visual-proposal') {
    throw new MapChangeValidationError('visual-proposal-protected', 'visual proposals change only through their versioned candidate records')
  }
  if (change.op === 'add-layer') {
    if (change.layer.data !== undefined) {
      try {
        validateGeoJsonValue(change.layer.data, {
          enforceWgs84Range: true,
          allowedGeometryTypes: DISPLAY_GEOMETRY_SET,
        })
      } catch (error) {
        throw new MapChangeValidationError(
          'invalid-meta',
          error instanceof Error ? error.message : 'layer data failed GeoJSON admission',
        )
      }
    }
    if (change.layer.symbol !== undefined && change.layer.symbol.presentation === 'heatmap') {
      if (change.layer.style !== undefined) {
        throw new MapChangeValidationError(
          'invalid-meta',
          'a heatmap presentation cannot coexist with a classification style',
        )
      }
      if (!isAllPointLayer(change.layer)) {
        throw new MapChangeValidationError(
          'invalid-meta',
          'a heatmap presentation requires an all-Point layer',
        )
      }
    }
    const replacing = state.layers.some(layer => layer.id === change.layer.id)
    if (!replacing && state.layers.length >= MAX_MAP_LAYERS) {
      throw new MapChangeValidationError(
        'capacity',
        `map container accepts at most ${MAX_MAP_LAYERS} layers; this add would exceed the limit`,
      )
    }
  }
  if (change.op === 'remove-layer' && !state.layers.some(layer => layer.id === change.layerId)) {
    throw new MapChangeValidationError(
      'layer-unknown',
      `remove-layer targets unknown layer ${change.layerId}; remove an existing layer`,
    )
  }
  if (change.op === 'set-view') {
    const [lon, lat] = change.view.center
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90
      || !Number.isFinite(change.view.zoom) || change.view.zoom < 0 || change.view.zoom > 24
      || !isSupportedDisplayWkid(change.view.wkid)) {
      throw new MapChangeValidationError('invalid-view', `set-view contains an unsupported or invalid view (WKID ${change.view.wkid})`)
    }
  }
  if (change.op === 'set-basemap' && change.selection !== null) {
    const selection = createBasemapSelection(change.selection.basemap, change.selection.labels)
    if (!selection.ok) {
      throw new MapChangeValidationError('invalid-meta', 'set-basemap carries an incompatible or unavailable selection')
    }
  }
  if (change.op === 'set-imagery-display') {
    const display = change.display
    if (!Number.isFinite(display.recentOpacity) || display.recentOpacity < 0 || display.recentOpacity > 1) {
      throw new MapChangeValidationError('invalid-meta', 'recent imagery opacity must be finite in [0, 1]')
    }
    if (display.earlySource !== null && waybackReleaseOf(display.earlySource) === null) {
      throw new MapChangeValidationError('invalid-meta', 'early imagery requires a fixed World Imagery Wayback release')
    }
    if (display.earlyVisible && display.earlySource === null) {
      throw new MapChangeValidationError('invalid-meta', 'visible early imagery requires a fixed release')
    }
  }
  if (change.op === 'set-style') {
    for (const entry of change.styles) {
      if (!state.layers.some(layer => layer.id === entry.layerId)) {
        throw new MapChangeValidationError(
          'style-layer-unknown',
          `set-style targets unknown layer ${entry.layerId}; classify an existing layer`,
        )
      }
      if (utf8ByteLength(entry.style) > MAX_STYLE_BYTES) {
        throw new MapChangeValidationError(
          'oversized-meta',
          `style for layer ${entry.layerId} exceeds the ${MAX_STYLE_BYTES} byte limit`,
        )
      }
    }
  }
  if (change.op === 'set-layer-state') {
    for (const entry of change.states) {
      if (!state.layers.some(layer => layer.id === entry.layerId)) {
        throw new MapChangeValidationError(
          'layer-unknown',
          `set-layer-state targets unknown layer ${entry.layerId}; read map_get_state for the current layer ids`,
        )
      }
    }
  }
  if (change.op === 'set-symbol-style') {
    for (const entry of change.entries) {
      const layer = state.layers.find(candidate => candidate.id === entry.layerId)
      if (layer === undefined) {
        throw new MapChangeValidationError(
          'layer-unknown',
          `set-symbol-style targets unknown layer ${entry.layerId}; read map_get_state for the current layer ids`,
        )
      }
      if (entry.symbol !== null && utf8ByteLength(entry.symbol) > MAX_STYLE_BYTES) {
        throw new MapChangeValidationError(
          'oversized-meta',
          `symbol for layer ${entry.layerId} exceeds the ${MAX_STYLE_BYTES} byte limit`,
        )
      }
      if (entry.symbol !== null && entry.symbol.presentation === 'heatmap') {
        if (layer.style !== undefined) {
          throw new MapChangeValidationError(
            'invalid-meta',
            `layer ${entry.layerId} carries a classification style; a heatmap presentation is exclusive with it`,
          )
        }
        if (!isAllPointLayer(layer)) {
          throw new MapChangeValidationError(
            'invalid-meta',
            `layer ${entry.layerId} is not all-Point; a heatmap presentation requires point features`,
          )
        }
      }
    }
  }
  if (change.op === 'set-feature-overrides') {
    for (const entry of change.entries) {
      const layer = state.layers.find(candidate => candidate.id === entry.layerId)
      if (layer === undefined) {
        throw new MapChangeValidationError(
          'layer-unknown',
          `set-feature-overrides targets unknown layer ${entry.layerId}; read map_get_state for the current layer ids`,
        )
      }
      if (entry.overrides === null) continue
      if (utf8ByteLength(entry.overrides) > MAX_STYLE_BYTES) {
        throw new MapChangeValidationError(
          'oversized-meta',
          `overrides for layer ${entry.layerId} exceed the ${MAX_STYLE_BYTES} byte limit`,
        )
      }
      const known = featureIdsOf(layer)
      for (const override of entry.overrides) {
        for (const id of override.featureIds) {
          if (!known.has(id)) {
            throw new MapChangeValidationError(
              'feature-unknown',
              `overrides name unknown feature id ${id} on layer ${entry.layerId}; read the layer's feature ids first`,
            )
          }
        }
      }
    }
  }
  if (change.op === 'reorder-layers') {
    const ordinary = state.layers.filter(layer => layer.role !== 'user-annotation').map(layer => layer.id).sort().join('|')
    const current = state.layers.some(layer => layer.role === 'user-annotation')
      ? ordinary
      : state.layers.map(layer => layer.id).sort().join('|')
    const proposed = [...change.layerIds].sort().join('|')
    if (current !== proposed) {
      throw new MapChangeValidationError(
        'style-layer-unknown',
        'reorder must name exactly the current layer set',
      )
    }
  }
  const projected = applyChangeLayers(state, change)
  if (utf8ByteLength(projected) > MAX_PROJECTION_STATE_BYTES) {
    throw new MapChangeValidationError(
      'oversized-meta',
      `map projection would exceed the ${MAX_PROJECTION_STATE_BYTES} byte budget; drop a layer before adding more data`,
    )
  }
  return state.revision
}

/** The byte budgets one patch consumes: meta size plus the projected state size. */
function validatePatchBudget(change: Extract<MapChange, { op: 'patch' }>, working: MapProjectionState): void {
  if (utf8ByteLength(change) > MAX_CHANGE_META_BYTES) {
    throw new MapChangeValidationError(
      'oversized-meta',
      `map change metadata exceeds the ${MAX_CHANGE_META_BYTES} byte limit`,
    )
  }
  if (utf8ByteLength(working) > MAX_PROJECTION_STATE_BYTES) {
    throw new MapChangeValidationError(
      'oversized-meta',
      `map projection would exceed the ${MAX_PROJECTION_STATE_BYTES} byte budget; shrink the patch before applying it`,
    )
  }
}

/** The optional collaboration identity fields a v4 meta may carry. */
export interface MapChangeIdentity {
  /** Client operation id — the fold's idempotency key. */
  readonly operationId?: string
  /** Operation index this change compensates (undo proposals). */
  readonly undoOf?: number
  /** Writer id the collab service resolved for this call. */
  readonly writerId?: string
}

/**
 * Build the durable meta record for one validated candidate.
 * @param sourceCallSeq - seq of this session's `tool/call` the candidate belongs to.
 * @param targetRevision - the revision {@link validateMapChangeCandidate} returned.
 * @param change - the validated pure candidate.
 * @param identity - the optional collaboration identity fields (v4).
 * @returns the versioned `map-change` meta the tool returns.
 */
export function buildMapChangeMeta(
  sourceCallSeq: number,
  targetRevision: number,
  change: MapChange,
  identity: MapChangeIdentity = {},
): MapChangeMeta {
  const meta: MapChangeMeta = {
    schemaVersion: MAP_META_SCHEMA_VERSION,
    kind: MAP_META_KIND,
    sourceCallSeq,
    targetRevision,
    change,
    ...(identity.operationId === undefined ? {} : { operationId: identity.operationId }),
    ...(identity.undoOf === undefined ? {} : { undoOf: identity.undoOf }),
    ...(identity.writerId === undefined ? {} : { writerId: identity.writerId }),
  }
  if (utf8ByteLength(meta) > MAX_CHANGE_META_BYTES) {
    throw new MapChangeValidationError(
      'oversized-meta',
      `map change metadata exceeds the ${MAX_CHANGE_META_BYTES} byte limit`,
    )
  }
  return meta
}

/**
 * Whether one durable change vocabulary is legal for the tool that produced
 * it. This check runs again at fold time because `tool/result.meta` is an
 * untrusted persisted value and a caller can forge the nested operation.
 * @param name - pending mutation tool name.
 * @param change - decoded candidate change.
 * @returns `true` when the tool owns every operation in the candidate.
 */
export function mapChangeAllowedForTool(name: MapPendingToolName, change: MapChange): boolean {
  if (name === 'map_markup' || name === 'map_compare_views' || name === 'map_mark_changes' || name === 'map_edit_annotation') return false
  if (name === 'map_refine_aoi') return change.op === 'add-layer'
  if (name === 'map_apply_patch' || name === 'map_undo') return true
  if (change.op === 'patch') {
    // `layer_set_style` composes its own two words when one call restyles a
    // symbol and retargets overrides together; every other patch belongs to
    // the collaboration plane.
    return name === 'layer_set_style'
      && change.changes.every(nested => nested.op === 'set-symbol-style' || nested.op === 'set-feature-overrides')
  }
  switch (name) {
    case 'map_add_layer':
    case 'map_draw':
    case 'terrain_add_layer':
    case 'stream_open':
    case 'stream_advance':
    case 'stream_pause':
    case 'stream_resume':
    case 'stream_materialize':
      return change.op === 'add-layer'
    case 'map_remove_layer':
      return change.op === 'remove-layer'
    case 'map_set_view':
    case 'map_fit_view':
    case 'map_use':
      return change.op === 'set-view'
    case 'map_set_mode':
      return change.op === 'set-mode'
    case 'map_set_basemap':
      return change.op === 'set-basemap'
    case 'map_set_imagery':
      return change.op === 'set-imagery-display'
    case 'viz_classify':
    case 'viz_compare':
      return change.op === 'set-style'
    case 'viz_aggregate':
      return change.op === 'add-layer'
    case 'layer_set_state':
      return change.op === 'set-layer-state'
    case 'layer_set_style':
      return change.op === 'set-symbol-style' || change.op === 'set-feature-overrides'
  }
}

/** Check every nested layer identity against the outer call sequence. */
function sourceCallSeqMatches(change: MapChange, sourceCallSeq: number): boolean {
  if (change.op === 'add-layer') return change.layer.sourceCallSeq === sourceCallSeq
  if (change.op === 'patch') return change.changes.every(nested => sourceCallSeqMatches(nested, sourceCallSeq))
  return true
}

/**
 * Normalize the call-owned identity on layer additions before comparing an
 * undo proposal with its recorded inverse. Undo rebinds those additions to
 * the new `map_undo` call, while every other inverse field must remain exact.
 */
function undoComparisonValue(change: MapChange): unknown {
  if (change.op === 'add-layer') {
    return {
      ...change,
      layer: { ...change.layer, sourceCallSeq: 0 },
    }
  }
  if (change.op === 'patch') {
    return { ...change, changes: change.changes.map(undoComparisonValue) }
  }
  return change
}

/** Compare an accepted undo proposal with the inverse held by its target row. */
function undoInverseMatches(change: MapChange, inverse: MapChange): boolean {
  const sameValue = (left: unknown, right: unknown): boolean => {
    if (Object.is(left, right)) return true
    if (Array.isArray(left) || Array.isArray(right)) {
      return Array.isArray(left) && Array.isArray(right)
        && left.length === right.length
        && left.every((value, at) => sameValue(value, right[at]))
    }
    if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false
    const leftRecord = left as Record<string, unknown>
    const rightRecord = right as Record<string, unknown>
    const leftKeys = Object.keys(leftRecord).sort()
    const rightKeys = Object.keys(rightRecord).sort()
    return leftKeys.length === rightKeys.length
      && leftKeys.every((key, at) => key === rightKeys[at] && sameValue(leftRecord[key], rightRecord[key]))
  }
  return sameValue(undoComparisonValue(change), undoComparisonValue(inverse))
}

/** Compare the authoritative source/config identities of two selections. */
function basemapIdentity(selection: BasemapSelection | null): string | null {
  return selection === null ? null : JSON.stringify(selection)
}

/** Compare the persisted imagery display identity of two display states. */
function imageryDisplayIdentity(display: ImageryDisplayState): string {
  return JSON.stringify(display)
}


/**
 * Enforce the fold-side identity of `map_undo`: the target must be present in
 * the retained ledger, must retain an inverse, and the proposed change must
 * be exactly that inverse apart from rebound layer call sequences.
 */
function undoTargetMatches(
  state: MapProjectionState,
  change: MapChange,
  undoOf: number | undefined,
  sourceCallSeq: number,
): boolean {
  if (undoOf === undefined || !sourceCallSeqMatches(change, sourceCallSeq)) return false
  const target = state.operations.find(operation => operation.index === undoOf)
  return target?.inverse !== null
    && target?.inverse !== undefined
    && (target.post.basemapDigest === undefined
      || basemapIdentity(state.basemap) === target.post.basemapDigest)
    && (target.post.imageryDisplayDigest === undefined
      || imageryDisplayIdentity(state.imageryDisplay) === target.post.imageryDisplayDigest)
    && undoInverseMatches(change, target.inverse)
}

/**
 * Decode one durable meta value (step 1 of 3). Versions 1 and 2 decode
 * (v1 layers carry no identity fields); anything else — including newer versions —
 * is refused with its code and never silently defaulted.
 * @param meta - the untrusted `tool/result.meta` value from the log.
 * @returns the decoded record, or the refusal code.
 */
export function decodeMapChangeMeta(meta: unknown): DecodedMapChangeMeta {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
    return { status: 'refused', code: 'invalid-meta' }
  }
  const record = meta as Record<string, unknown>
  if (!DECODABLE_META_VERSIONS.includes(record.schemaVersion as 1 | 2)) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  if (record.kind !== MAP_META_KIND) {
    return { status: 'refused', code: 'unknown-kind' }
  }
  if (utf8ByteLength(record) > MAX_CHANGE_META_BYTES) {
    return { status: 'refused', code: 'oversized-meta' }
  }
  const parsed = mapChangeMetaSchema.safeParse(record)
  if (!parsed.success) return { status: 'refused', code: 'invalid-meta' }
  return { status: 'ok', meta: parsed.data }
}

/** Append one diagnostic, dropping the oldest beyond the bound. */
function withDiagnostic(
  state: MapProjectionState,
  seq: number,
  code: MapDiagnosticCode,
): MapProjectionState {
  const diagnostics = [...state.diagnostics, { seq, code }]
  return { ...state, diagnostics: diagnostics.slice(-MAX_MAP_DIAGNOSTICS) }
}

/** The fold-internal refusal for a replayed change, mirroring {@link validateMapChangeCandidate}: `null` admits it. */
function foldRefusalFor(state: MapProjectionState, change: MapChange): 'capacity' | 'style-layer-unknown' | 'layer-unknown' | 'feature-unknown' | 'invalid-meta' | 'annotation-protected' | 'visual-proposal-protected' | null {
  const protectedLayer = namesProtectedAnnotationLayer(change)
  if (protectedLayer === 'annotation') return 'annotation-protected'
  if (protectedLayer === 'visual-proposal') return 'visual-proposal-protected'
  if (change.op === 'patch') {
    // Sequential feasibility: every nested change must admit against the
    // state its earlier siblings produce — the whole patch applies or none.
    let working = state
    for (const nested of change.changes) {
      const refusal = foldRefusalFor(working, nested)
      if (refusal !== null) return refusal
      working = applyChangeLayers(working, nested)
    }
    return null
  }
  if (change.op === 'add-layer') {
    const replacing = state.layers.some(layer => layer.id === change.layer.id)
    if (!replacing && state.layers.length >= MAX_MAP_LAYERS) return 'capacity'
    if (change.layer.symbol !== undefined && change.layer.symbol.presentation === 'heatmap'
      && !isAllPointLayer(change.layer)) return 'invalid-meta'
    return null
  }
  if (change.op === 'remove-layer') {
    return state.layers.some(layer => layer.id === change.layerId) ? null : 'layer-unknown'
  }
  if (change.op === 'set-imagery-display') {
    const display = change.display
    return Number.isFinite(display.recentOpacity) && display.recentOpacity >= 0 && display.recentOpacity <= 1
      && (display.earlySource === null || waybackReleaseOf(display.earlySource) !== null)
      && (!display.earlyVisible || display.earlySource !== null)
      ? null : 'invalid-meta'
  }
  if (change.op === 'set-style') {
    return change.styles.every(entry => state.layers.some(layer => layer.id === entry.layerId)) ? null : 'style-layer-unknown'
  }
  if (change.op === 'set-layer-state') {
    return change.states.every(entry => state.layers.some(layer => layer.id === entry.layerId)) ? null : 'layer-unknown'
  }
  if (change.op === 'set-symbol-style') {
    for (const entry of change.entries) {
      const layer = state.layers.find(candidate => candidate.id === entry.layerId)
      if (layer === undefined) return 'layer-unknown'
      if (entry.symbol !== null && entry.symbol.presentation === 'heatmap'
        && (layer.style !== undefined || !isAllPointLayer(layer))) return 'invalid-meta'
    }
    return null
  }
  if (change.op === 'set-feature-overrides') {
    for (const entry of change.entries) {
      const layer = state.layers.find(candidate => candidate.id === entry.layerId)
      if (layer === undefined) return 'layer-unknown'
      if (entry.overrides === null) continue
      const known = featureIdsOf(layer)
      for (const override of entry.overrides) {
        for (const id of override.featureIds) {
          if (!known.has(id)) return 'feature-unknown'
        }
      }
    }
    return null
  }
  if (change.op === 'reorder-layers') {
    const current = state.layers.filter(layer => layer.role !== 'user-annotation').map(layer => layer.id).sort().join('|')
    const proposed = [...change.layerIds].sort().join('|')
    return current === proposed ? null : 'style-layer-unknown'
  }
  return null
}

/** Apply one admitted change to the layer array / view / mode / aoi (pure). */
function applyChangeLayers(state: MapProjectionState, change: MapChange): MapProjectionState {
  switch (change.op) {
    case 'add-layer': {
      const layers = state.layers.filter(layer => layer.id !== change.layer.id)
      layers.push(change.layer)
      return { ...state, layers }
    }
    case 'remove-layer':
      return { ...state, layers: state.layers.filter(layer => layer.id !== change.layerId) }
    case 'set-view':
      return { ...state, view: change.view }
    case 'set-mode':
      return { ...state, mode: change.mode }
    case 'set-basemap':
      return { ...state, basemap: change.selection }
    case 'set-imagery-display':
      return { ...state, imageryDisplay: change.display }
    case 'set-style':
      return {
        ...state,
        layers: state.layers.map(layer => {
          const entry = change.styles.find(candidate => candidate.layerId === layer.id)
          if (entry === undefined) return layer
          // A `null` style clears the layer's classification (undo of a
          // first classification); a style record replaces it.
          if (entry.style === null) {
            const { style: _cleared, ...rest } = layer
            return rest
          }
          return { ...layer, style: entry.style }
        }),
      }
    case 'reorder-layers':
      return {
        ...state,
        layers: [
          ...state.layers.filter(layer => layer.role === 'user-annotation'),
          ...change.layerIds.map(id => {
          const layer = state.layers.find(candidate => candidate.id === id)
          if (layer === undefined) throw new Error(`fold reorder lost layer ${id}`)
          return layer
          }),
        ],
      }
    case 'set-aoi':
      return { ...state, aoi: change.aoi }
    case 'set-layer-state':
      return {
        ...state,
        layers: state.layers.map(layer => {
          const entry = change.states.find(candidate => candidate.layerId === layer.id)
          if (entry === undefined) return layer
          const { group: existingGroup, ...rest } = layer
          const nextGroup = entry.group === undefined ? existingGroup : entry.group
          return {
            ...rest,
            visible: entry.visible ?? layer.visible,
            opacity: entry.opacity ?? layer.opacity,
            ...(nextGroup === null || nextGroup === undefined ? {} : { group: nextGroup }),
          }
        }),
      }
    case 'set-symbol-style':
      return {
        ...state,
        layers: state.layers.map(layer => {
          const entry = change.entries.find(candidate => candidate.layerId === layer.id)
          if (entry === undefined) return layer
          const { symbol: _cleared, ...withoutSymbol } = layer
          if (entry.symbol === null) return withoutSymbol
          return { ...layer, symbol: entry.symbol }
        }),
      }
    case 'set-feature-overrides':
      return {
        ...state,
        layers: state.layers.map(layer => {
          const entry = change.entries.find(candidate => candidate.layerId === layer.id)
          if (entry === undefined) return layer
          const { overrides: _cleared, ...withoutOverrides } = layer
          if (entry.overrides === null) return withoutOverrides
          return { ...layer, overrides: { overridesVersion: overridesVersionOf(entry.overrides), entries: entry.overrides } }
        }),
      }
    case 'patch': {
      let working = state
      for (const nested of change.changes) {
        working = applyChangeLayers(working, nested)
      }
      return working
    }
  }
}

/**
 * The inverse (compensating change) and post-state one change leaves, both
 * computed against the state BEFORE the change applies — the fold's own
 * authority for undo material. `inverse === null` marks a change whose
 * compensation cannot be expressed (a no-op removal's undo, or a patch
 * containing one), so undo refuses it instead of guessing.
 */
function inverseAndPostOf(
  pre: MapProjectionState,
  change: MapChange,
): { inverse: MapChange | null; post: MapOperationPostState; summary: string } {
  switch (change.op) {
    case 'add-layer': {
      const replaced = pre.layers.find(layer => layer.id === change.layer.id)
      const inverse: MapChange = replaced === undefined
        ? { op: 'remove-layer', layerId: change.layer.id }
        : { op: 'add-layer', layer: replaced }
      const featureCount = (change.layer.data as { features?: unknown[] } | null)?.features?.length ?? 0
      return {
        inverse,
        post: { layers: [{ id: change.layer.id, digest: layerDigestOf(change.layer) }] },
        summary: `${replaced === undefined ? 'add-layer' : 'replace-layer'} ${change.layer.id} (${featureCount} features)`,
      }
    }
    case 'remove-layer': {
      const removed = pre.layers.find(layer => layer.id === change.layerId)
      return {
        inverse: removed === undefined ? null : { op: 'add-layer', layer: removed },
        post: { absentIds: [change.layerId] },
        summary: `remove-layer ${change.layerId}`,
      }
    }
    case 'set-view':
      return {
        inverse: { op: 'set-view', view: pre.view },
        post: { view: change.view },
        summary: `set-view [${change.view.center[0]}, ${change.view.center[1]}] z${change.view.zoom}`,
      }
    case 'set-mode':
      return {
        inverse: { op: 'set-mode', mode: pre.mode },
        post: { mode: change.mode },
        summary: `set-mode ${change.mode}`,
      }
    case 'set-style': {
      const priorStyles: StyleChangeEntry[] = []
      const styleVersions: { layerId: string; styleVersion: string }[] = []
      for (const entry of change.styles) {
        const prior = pre.layers.find(layer => layer.id === entry.layerId)?.style
        priorStyles.push({ layerId: entry.layerId, style: prior ?? null })
        if (entry.style !== null) styleVersions.push({ layerId: entry.layerId, styleVersion: entry.style.styleVersion })
      }
      return {
        inverse: { op: 'set-style', styles: priorStyles },
        post: { styleVersions },
        summary: `set-style ${change.styles.map(entry => entry.layerId).join(', ')}`,
      }
    }
    case 'reorder-layers':
      return {
        inverse: { op: 'reorder-layers', layerIds: pre.layers.map(layer => layer.id) },
        post: { order: [...change.layerIds] },
        summary: `reorder-layers (${change.layerIds.length})`,
      }
    case 'set-aoi':
      return {
        inverse: { op: 'set-aoi', aoi: pre.aoi },
        post: { aoiDigest: aoiDigestOf(change.aoi) },
        summary: change.aoi === null ? 'set-aoi (clear)' : `set-aoi ${change.aoi.name ?? '(unnamed)'}`,
      }
    case 'set-basemap':
      return {
        inverse: { op: 'set-basemap', selection: pre.basemap },
        post: { basemapDigest: basemapIdentity(change.selection) },
        summary: change.selection === null
          ? 'set-basemap (legacy default)'
          : `set-basemap ${change.selection.basemap.id}${change.selection.labels === null ? '' : ` + ${change.selection.labels.id}`}`,
      }
    case 'set-imagery-display':
      return {
        inverse: { op: 'set-imagery-display', display: pre.imageryDisplay },
        post: { imageryDisplayDigest: imageryDisplayIdentity(change.display) },
        summary: `set-imagery-display labels:${change.display.labelsVisible ? 'on' : 'off'} recent:${change.display.recentVisible ? 'on' : 'off'}@${change.display.recentOpacity} early:${change.display.earlyVisible ? 'on' : 'off'}`,
      }
    case 'set-layer-state': {
      const priorStates: LayerStateEntry[] = []
      const layerStates: { layerId: string; visible: boolean; opacity: number; group: string | null }[] = []
      for (const entry of change.states) {
        const layer = pre.layers.find(candidate => candidate.id === entry.layerId)
        if (layer === undefined) throw new Error(`fold set-layer-state lost layer ${entry.layerId}`)
        priorStates.push({
          layerId: entry.layerId,
          ...(entry.visible === undefined ? {} : { visible: layer.visible }),
          ...(entry.opacity === undefined ? {} : { opacity: layer.opacity }),
          ...(entry.group === undefined ? {} : { group: layer.group ?? null }),
        })
        layerStates.push({
          layerId: entry.layerId,
          visible: entry.visible ?? layer.visible,
          opacity: entry.opacity ?? layer.opacity,
          group: entry.group === undefined ? layer.group ?? null : entry.group,
        })
      }
      return {
        inverse: { op: 'set-layer-state', states: priorStates },
        post: { layerStates },
        summary: `set-layer-state ${change.states.map(entry => entry.layerId).join(', ')}`,
      }
    }
    case 'set-symbol-style': {
      const priorEntries: SymbolStyleChangeEntry[] = []
      const symbolVersions: { layerId: string; symbolVersion: string }[] = []
      for (const entry of change.entries) {
        const layer = pre.layers.find(candidate => candidate.id === entry.layerId)
        if (layer === undefined) throw new Error(`fold set-symbol-style lost layer ${entry.layerId}`)
        priorEntries.push({ layerId: entry.layerId, symbol: layer.symbol ?? null })
        if (entry.symbol !== null) symbolVersions.push({ layerId: entry.layerId, symbolVersion: entry.symbol.symbolVersion })
      }
      return {
        inverse: { op: 'set-symbol-style', entries: priorEntries },
        post: { symbolVersions },
        summary: `set-symbol-style ${change.entries.map(entry => entry.layerId).join(', ')}`,
      }
    }
    case 'set-feature-overrides': {
      const priorEntries: FeatureOverridesChangeEntry[] = []
      const overridesVersions: { layerId: string; overridesVersion: string }[] = []
      for (const entry of change.entries) {
        const layer = pre.layers.find(candidate => candidate.id === entry.layerId)
        if (layer === undefined) throw new Error(`fold set-feature-overrides lost layer ${entry.layerId}`)
        priorEntries.push({ layerId: entry.layerId, overrides: layer.overrides === undefined ? null : [...layer.overrides.entries] })
        if (entry.overrides !== null) overridesVersions.push({ layerId: entry.layerId, overridesVersion: overridesVersionOf(entry.overrides) })
      }
      return {
        inverse: { op: 'set-feature-overrides', entries: priorEntries },
        post: { overridesVersions },
        summary: `set-feature-overrides ${change.entries.map(entry => entry.layerId).join(', ')}`,
      }
    }
    case 'patch': {
      let working = pre
      const inverses: BaseMapChange[] = []
      const post: MapOperationPostState = {}
      const nestedSummaries: string[] = []
      for (const nested of change.changes) {
        const nestedResult = inverseAndPostOf(working, nested)
        if (nestedResult.inverse === null) return { inverse: null, post: {}, summary: `patch (non-invertible at: ${nestedResult.summary})` }
        inverses.unshift(nestedResult.inverse as BaseMapChange)
        mergePost(post, nestedResult.post)
        nestedSummaries.push(nestedResult.summary)
        working = applyChangeLayers(working, nested)
      }
      const summary = `patch ${change.changes.length} ops: ${nestedSummaries.join(', ')}`
      const inverse: MapChange = inverses.length === 1
        ? inverses[0] as BaseMapChange
        : { op: 'patch', changes: inverses }
      return {
        inverse,
        post,
        summary: summary.length > MAX_OPERATION_SUMMARY_CHARS ? `${summary.slice(0, MAX_OPERATION_SUMMARY_CHARS - 1)}…` : summary,
      }
    }
  }
}

/** Merge one nested post-state into the patch's aggregate (last write wins per slice). */
function mergePost(target: MapOperationPostState, addendum: MapOperationPostState): void {
  const mutable = target as {
    layers?: { id: string; digest: string }[]
    absentIds?: string[]
    order?: string[]
    view?: MapViewRecord
    mode?: 'map' | 'scene'
    basemapDigest?: string | null
    aoiDigest?: string | null
    styleVersions?: { layerId: string; styleVersion: string }[]
    layerStates?: { layerId: string; visible: boolean; opacity: number; group: string | null }[]
    symbolVersions?: { layerId: string; symbolVersion: string }[]
    overridesVersions?: { layerId: string; overridesVersion: string }[]
  }
  if (addendum.layers !== undefined) mutable.layers = [...(mutable.layers ?? []), ...addendum.layers]
  if (addendum.absentIds !== undefined) mutable.absentIds = [...(mutable.absentIds ?? []), ...addendum.absentIds]
  if (addendum.order !== undefined) mutable.order = [...addendum.order]
  if (addendum.view !== undefined) mutable.view = addendum.view
  if (addendum.mode !== undefined) mutable.mode = addendum.mode
  if (addendum.basemapDigest !== undefined) mutable.basemapDigest = addendum.basemapDigest
  if (addendum.aoiDigest !== undefined) mutable.aoiDigest = addendum.aoiDigest
  if (addendum.styleVersions !== undefined) mutable.styleVersions = [...(mutable.styleVersions ?? []), ...addendum.styleVersions]
  if (addendum.layerStates !== undefined) mutable.layerStates = [...(mutable.layerStates ?? []), ...addendum.layerStates]
  if (addendum.symbolVersions !== undefined) mutable.symbolVersions = [...(mutable.symbolVersions ?? []), ...addendum.symbolVersions]
  if (addendum.overridesVersions !== undefined) mutable.overridesVersions = [...(mutable.overridesVersions ?? []), ...addendum.overridesVersions]
}

/** Inputs to settling one paired `tool/result` against the accepted state. */
export interface SettleMapResultInput {
  /** Seq of the `tool/result` event being folded. */
  readonly resultSeq: number
  /** The pending entry the result settles (already removed from pending by the caller). */
  readonly pending: MapPendingCall
  /** Whether the result block is an error result (failure admission). */
  readonly isError: boolean
  /** The durable `tool/result.meta` value, when the event carried one. */
  readonly meta: unknown
  /** The call seq the event itself cites (`sourceEventSeqs[0]`), when present. */
  readonly citedCallSeq: number | undefined
  /** Complete source citation list; a map result may cite exactly one call. */
  readonly citedCallSeqs?: readonly number[]
}

/** Append one operation record, evicting the oldest beyond the ledger bound and enforcing the state-size budget. */
function withOperationRecord(
  state: MapProjectionState,
  entry: MapOperationRecord,
): MapProjectionState | undefined {
  let operations = [...state.operations, entry].slice(-MAX_MAP_OPERATION_RECORDS)
  let next: MapProjectionState = { ...state, operations }
  while (utf8ByteLength(next) > MAX_PROJECTION_STATE_BYTES && operations.length > 1) {
    // The undo horizon shrinks honestly: the session log keeps the history.
    operations = operations.slice(1)
    next = { ...next, operations }
  }
  // A replacement can make its inverse as large as the already-rendered
  // layer. Keep the audit row while dropping only the non-essential inverse
  // when retaining it would violate the persisted-state byte budget.
  if (utf8ByteLength(next) > MAX_PROJECTION_STATE_BYTES && entry.inverse !== null) {
    const { annotationInverse: _droppedAnnotationInverse, ...entryWithoutAnnotationInverse } = entry
    const boundedEntry: MapOperationRecord = { ...entryWithoutAnnotationInverse, inverse: null }
    operations = [...state.operations, boundedEntry].slice(-MAX_MAP_OPERATION_RECORDS)
    next = { ...state, operations }
    while (utf8ByteLength(next) > MAX_PROJECTION_STATE_BYTES && operations.length > 1) {
      operations = operations.slice(1)
      next = { ...next, operations }
    }
  }
  // Candidate validation runs before the operation row exists. Refuse the
  // whole change when the final row still cannot fit, rather than returning a
  // state that violates the persisted projection byte limit.
  return utf8ByteLength(next) > MAX_PROJECTION_STATE_BYTES ? undefined : next
}

/**
 * Fold one prepared historical comparison under the shared ledger bound and
 * persisted-state byte budget.
 * @param state - the accepted state.
 * @param pair - the prepared early/recent pair with its query identity.
 * @param operationId - the user change operation id.
 * @param seq - seq of the committing event.
 * @returns the next state, or undefined when the change cannot fit the budget.
 */
export function withWaybackComparison(
  state: MapProjectionState,
  pair: WaybackComparison,
  operationId: string,
  seq: number,
): MapProjectionState | undefined {
  const revision = state.revision + 1
  return withOperationRecord({ ...state, revision, waybackComparison: pair }, {
    index: (state.operations.at(-1)?.index ?? 0) + 1,
    operationId,
    undoOf: null,
    writerId: 'user',
    callId: `user:${operationId}`,
    resultSeq: seq,
    revision,
    summary: 'prepare historical comparison',
    inverse: null,
    post: { requestDigest: stableDigestOf({ op: 'set-wayback-comparison', pair }) },
  })
}

/**
 * Settle one paired mutation result (steps 2–3: validate, then fold).
 * Failure admission: error results never apply. Versioned records must cite
 * the pending call's seq and the current revision; violations and decode
 * refusals record a bounded diagnostic and keep the map unchanged. The
 * targetRevision CAS and the acceptance run in this one synchronous call —
 * the serial commit segment of the single-server model. A v4 record whose
 * `operationId` is already in the ledger replays idempotently as a
 * `duplicate-op` diagnostic instead of applying twice. Every applied change
 * appends its inverse and post-state to the bounded operation ledger so undo
 * proposes a NEW compensating revision against original history. Legacy
 * (pre-P0a) flat metas decode by the pending tool name and apply without
 * revision claims — the dedicated old-log path.
 * @param state - the accepted state with the pending entry already removed.
 * @param input - the settled result's identity, error flag, meta, and citation.
 * @returns the next state (new reference whenever anything settled).
 */
export function settleMapResult(state: MapProjectionState, input: SettleMapResultInput): MapProjectionState {
  const { resultSeq, pending, isError, meta, citedCallSeq, citedCallSeqs } = input
  if (isError) {
    if (meta === undefined) return state
    return withDiagnostic(state, resultSeq, 'failed-result')
  }
  if (meta === undefined) return state
  const decoded = decodeMapChangeMeta(meta)
  if (decoded.status === 'ok') {
    const { meta: record } = decoded
    if (record.operationId !== undefined
      && state.operations.some(applied => applied.operationId === record.operationId)) {
      // Idempotent replay is decided from the durable operation identity
      // before source/target fields, which may legitimately differ on a
      // re-emitted surface result.
      return withDiagnostic(state, resultSeq, 'duplicate-op')
    }
    const citations = citedCallSeqs ?? (citedCallSeq === undefined ? undefined : [citedCallSeq])
    if (record.sourceCallSeq !== pending.callSeq
      || (citations !== undefined && (citations.length !== 1 || citations[0] !== pending.callSeq))
      || !sourceCallSeqMatches(record.change, pending.callSeq)
      || !mapChangeAllowedForTool(pending.name, record.change)
      || (pending.name === 'map_undo'
        ? !undoTargetMatches(state, record.change, record.undoOf, pending.callSeq)
        : record.undoOf !== undefined)) {
      return withDiagnostic(state, resultSeq, 'call-pairing')
    }
    if (record.targetRevision !== state.revision) {
      return withDiagnostic(state, resultSeq, 'stale-revision')
    }
    try {
      validateMapChangeCandidate(state, record.change)
    } catch (error) {
      if (error instanceof MapChangeValidationError) return withDiagnostic(state, resultSeq, error.code)
      return withDiagnostic(state, resultSeq, 'invalid-meta')
    }
    const refusal = foldRefusalFor(state, record.change)
    if (refusal !== null) {
      return withDiagnostic(state, resultSeq, refusal)
    }
    const { inverse, post, summary } = inverseAndPostOf(state, record.change)
    const nextRevision = state.revision + 1
    const ledger: MapOperationRecord = {
      index: (state.operations[state.operations.length - 1]?.index ?? 0) + 1,
      operationId: record.operationId ?? null,
      undoOf: record.undoOf ?? null,
      writerId: record.writerId ?? null,
      callId: pending.callId,
      resultSeq,
      revision: nextRevision,
      summary,
      inverse,
      post,
    }
    const settled = withOperationRecord(
      { ...applyChangeLayers(state, record.change), revision: nextRevision, lastCallId: pending.callId },
      ledger,
    )
    return settled ?? withDiagnostic(state, resultSeq, 'oversized-meta')
  }
  const legacy = decodeLegacyMapChangeMeta(pending.name, meta, pending.callSeq)
  if (legacy !== undefined) {
    if (!mapChangeAllowedForTool(pending.name, legacy) || !sourceCallSeqMatches(legacy, pending.callSeq)) {
      return withDiagnostic(state, resultSeq, 'call-pairing')
    }
    try {
      validateMapChangeCandidate(state, legacy)
    } catch (error) {
      if (error instanceof MapChangeValidationError) return withDiagnostic(state, resultSeq, error.code)
      return withDiagnostic(state, resultSeq, 'invalid-meta')
    }
    const legacyRefusal = foldRefusalFor(state, legacy)
    if (legacyRefusal !== null) return withDiagnostic(state, resultSeq, legacyRefusal)
    const { inverse, post, summary } = inverseAndPostOf(state, legacy)
    const nextRevision = state.revision + 1
    const ledger: MapOperationRecord = {
      index: (state.operations[state.operations.length - 1]?.index ?? 0) + 1,
      operationId: null,
      undoOf: null,
      writerId: null,
      callId: pending.callId,
      resultSeq,
      revision: nextRevision,
      summary,
      inverse,
      post,
    }
    const settled = withOperationRecord(
      { ...applyChangeLayers(state, legacy), revision: nextRevision, lastCallId: pending.callId },
      ledger,
    )
    return settled ?? withDiagnostic(state, resultSeq, 'oversized-meta')
  }
  return withDiagnostic(state, resultSeq, decoded.code)
}

/**
 * Decode one pre-P0a flat meta by its tool name (the dedicated old-log path;
 * new fields are never defaulted onto it).
 * @param name - the mutation tool name the pending call recorded.
 * @param meta - the legacy flat meta value.
 * @param callSeq - the pending call's seq, adopted as the legacy layer's call identity.
 * @returns the equivalent candidate change, or `undefined` when unrecognized.
 */
function decodeLegacyMapChangeMeta(name: MapPendingToolName, meta: unknown, callSeq: number): MapChange | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const record = meta as Record<string, unknown>
  if (record.schemaVersion !== undefined) return undefined
  let change: MapChange | undefined
  switch (name) {
    case 'map_add_layer': {
      const layer = record.layer
      if (typeof layer !== 'object' || layer === null) return undefined
      const legacy = layer as Record<string, unknown>
      if (typeof legacy.id !== 'string' || legacy.id.length === 0) return undefined
      change = {
        op: 'add-layer',
        layer: {
          id: legacy.id,
          name: typeof legacy.name === 'string' ? legacy.name : legacy.id,
          data: legacy.data as GeoJsonFeatureCollection,
          sourceCrs: typeof legacy.sourceCrs === 'string' ? legacy.sourceCrs : 'EPSG:4326',
          opacity: typeof legacy.opacity === 'number' ? legacy.opacity : 1,
          visible: typeof legacy.visible === 'boolean' ? legacy.visible : true,
          sourceCallSeq: callSeq,
        },
      }
      break
    }
    case 'map_remove_layer':
      change = typeof record.layer_id === 'string' && record.layer_id.length > 0
        ? { op: 'remove-layer', layerId: record.layer_id }
        : undefined
      break
    case 'map_set_view': {
      const view = record.view
      if (typeof view !== 'object' || view === null || !Array.isArray((view as Record<string, unknown>).center)) {
        return undefined
      }
      const legacy = view as { center: unknown[]; zoom?: unknown; wkid?: unknown }
      const [lon, lat] = legacy.center
      if (typeof lon !== 'number' || typeof lat !== 'number') return undefined
      change = {
        op: 'set-view',
        view: {
          center: [lon, lat],
          zoom: typeof legacy.zoom === 'number' ? legacy.zoom : 0,
          wkid: typeof legacy.wkid === 'number' ? legacy.wkid : 4326,
        },
      }
      break
    }
    case 'map_set_mode':
      change = record.mode === 'map' || record.mode === 'scene' ? { op: 'set-mode', mode: record.mode } : undefined
      break
    case 'viz_classify':
    case 'viz_compare':
    case 'map_apply_patch':
    case 'map_undo':
    case 'map_use':
      // Style and collaboration changes arrived with the versioned v3/v4
      // metas; no pre-P0a flat form exists.
      change = undefined
      break
  }
  if (change === undefined) return undefined
  return changeSchema.safeParse(change).success ? change : undefined
}

/** Locate the session's protected annotation layer. */
function annotationLayerOf(state: MapProjectionState): MapProjectedLayer | undefined {
  return state.layers.find(layer => layer.role === 'user-annotation')
}

/** Whole-layer annotation identity used by user undo conflict checks. */
function annotationDigestOf(layer: MapProjectedLayer | undefined): string | null {
  return layer === undefined ? null : stableDigestOf(layer)
}

/** Clone one JSON layer value without sharing mutable arrays or objects. */
function annotationClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Convert a full single-symbol style to the sparse override block for one geometry. */
function annotationOverridePatchOf(geometry: AnnotationGeometry, symbol: SymbolStyle): FeatureOverride['patch'] {
  if (symbol.presentation !== 'single') throw new MapChangeValidationError('annotation-limit', 'annotation styles must be single-symbol')
  const block = geometry.type === 'Point' ? symbol.point : geometry.type === 'LineString' ? symbol.line : symbol.fill
  if (block === undefined) throw new MapChangeValidationError('annotation-limit', 'the annotation style has no block for its geometry')
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(block)) {
    if (value !== undefined) patch[key] = value
  }
  if (Object.keys(patch).length === 0) throw new MapChangeValidationError('annotation-limit', 'an annotation style override may not be empty')
  return patch as FeatureOverride['patch']
}

/** Retarget one feature's override while preserving every other styled feature. */
function annotationOverrideWith(
  layer: MapProjectedLayer,
  featureId: string,
  symbol: SymbolStyle | null,
): FeatureOverrides | undefined {
  const entries = (layer.overrides?.entries ?? [])
    .map(entry => ({ ...entry, featureIds: entry.featureIds.filter(id => id !== featureId) }))
    .filter(entry => entry.featureIds.length > 0)
  if (symbol !== null) {
    const feature = layer.data?.features.find(candidate => candidate.id === featureId)
    if (feature === undefined) throw new MapChangeValidationError('annotation-unknown', `unknown annotation ${featureId}`)
    entries.push({ featureIds: [featureId], patch: annotationOverridePatchOf(feature.geometry as AnnotationGeometry, symbol) })
  }
  if (entries.length > 16) throw new MapChangeValidationError('annotation-limit', 'at most sixteen annotation features may carry custom styles')
  return entries.length === 0 ? undefined : { overridesVersion: overridesVersionOf(entries), entries }
}

/** Count active annotation coordinates under the current coordinate budget. */
function annotationCoordinateCountOf(layer: MapProjectedLayer | undefined): number {
  if (layer === undefined) return 0
  let count = 0
  for (const feature of layer.data?.features ?? []) {
    const geometry = feature.geometry
    if (geometry?.type === 'Point') count += 1
    else if (geometry?.type === 'LineString') count += (geometry.coordinates as unknown[]).length
    else if (geometry?.type === 'Polygon') count += ((geometry.coordinates as unknown[][])[0]?.length ?? 0)
  }
  return count
}

/** Validate the host-provided annotation notice context. */
function annotationContextOf(input: { readonly sessionId?: string; readonly at?: string; readonly featureId?: string }): { readonly sessionId: string; readonly at: string; readonly featureId: string } {
  if (input.sessionId === undefined || input.sessionId.length === 0 || input.sessionId.length > 128
    || input.at === undefined || !ANNOTATION_TIMESTAMP.test(input.at)
    || input.featureId === undefined || !ANNOTATION_FEATURE_ID.test(input.featureId)) {
    throw new MapChangeValidationError('invalid-meta', 'annotation notices require host identity and timestamp context')
  }
  return { sessionId: input.sessionId, at: input.at, featureId: input.featureId }
}

/** Rewrite the annotation layer around one create/update/delete and return it with its digest. */
function annotationLayerAfterChange(
  layer: MapProjectedLayer | undefined,
  change: AnnotationUserChange,
  context: { readonly sessionId: string; readonly at: string; readonly featureId: string; readonly operationId: string },
): MapProjectedLayer | undefined {
  if (change.op === 'annotation-create') {
    if (context.sessionId.length === 0 || context.sessionId.length > 128 || !ANNOTATION_TIMESTAMP.test(context.at)
      || !ANNOTATION_FEATURE_ID.test(context.featureId)) {
      throw new MapChangeValidationError('invalid-meta', 'annotation creation requires host identity and timestamp context')
    }
    const priorFeatures = layer?.data?.features ?? []
    if (priorFeatures.length >= MAX_ANNOTATION_FEATURES) {
      throw new MapChangeValidationError('annotation-limit', `a session retains at most ${MAX_ANNOTATION_FEATURES} annotations`)
    }
    const coordinateCount = validateAnnotationGeometry(change.geometry)
    if (annotationCoordinateCountOf(layer) + coordinateCount > MAX_ANNOTATION_TOTAL_COORDINATES) {
      throw new MapChangeValidationError('annotation-limit', 'the annotation coordinate budget is full')
    }
    if (priorFeatures.some(feature => feature.id === context.featureId)) {
      throw new MapChangeValidationError('annotation-unknown', 'the derived annotation feature id already exists')
    }
    const properties = {
      name: change.name,
      ...(change.description === undefined ? {} : { description: change.description }),
      dshRole: 'user-annotation',
      dshAuthor: 'user',
      dshSource: 'manual',
      dshCreateOperationId: context.operationId,
      dshUpdateOperationId: context.operationId,
      dshCreatedAt: context.at,
      dshUpdatedAt: context.at,
    }
    const features: GeoJsonFeature[] = [
      ...priorFeatures,
      { type: 'Feature', id: context.featureId, geometry: annotationClone(change.geometry), properties },
    ]
    const data: GeoJsonFeatureCollection = { type: 'FeatureCollection', features }
    const created: MapProjectedLayer = layer === undefined ? {
      id: USER_ANNOTATION_LAYER_ID,
      name: 'User annotations',
      role: 'user-annotation',
      data,
      sourceCrs: 'EPSG:4326',
      opacity: 1,
      visible: true,
      sourceCallSeq: 0,
      displayDigest: stableDigestOf(data),
    } : { ...layer, data, displayDigest: stableDigestOf(data) }
    if (change.symbol === undefined) return created
    const overrides = annotationOverrideWith(created, context.featureId, change.symbol)
    return overrides === undefined ? created : { ...created, overrides }
  }
  if (layer === undefined || layer.data === undefined) throw new MapChangeValidationError('annotation-unknown', 'the session has no annotations')
  const layerData = layer.data
  if (change.op === 'annotation-delete') {
    const ids = new Set(change.featureIds)
    const features = layerData.features.filter(feature => typeof feature.id === 'string' && !ids.has(feature.id))
    if (ids.size !== change.featureIds.length || layerData.features.length - features.length !== ids.size) {
      throw new MapChangeValidationError('annotation-unknown', 'delete names a missing or duplicate annotation')
    }
    if (features.length === 0) return undefined
    const deleted = new Set(change.featureIds)
    const entries = layer.overrides?.entries
      .map(entry => ({ ...entry, featureIds: entry.featureIds.filter(id => !deleted.has(id)) }))
      .filter(entry => entry.featureIds.length > 0) ?? []
    const data: GeoJsonFeatureCollection = { type: 'FeatureCollection', features }
    const { overrides: _previousOverrides, ...withoutOverrides } = layer
    return {
      ...withoutOverrides,
      data,
      displayDigest: stableDigestOf(data),
      ...(entries.length === 0 ? {} : { overrides: { overridesVersion: overridesVersionOf(entries), entries } }),
    }
  }
  if (change.op !== 'annotation-update') throw new MapChangeValidationError('invalid-meta', 'unsupported annotation operation')
  const feature = layerData.features.find(candidate => candidate.id === change.featureId)
  if (feature === undefined) throw new MapChangeValidationError('annotation-unknown', `unknown annotation ${change.featureId}`)
  const priorProperties = feature.properties as Record<string, string>
  if (change.expectedUpdatedAt !== priorProperties.dshUpdatedAt) {
    throw new MapChangeValidationError('stale-revision', 'the annotation changed after this edit started')
  }
  const geometry = change.geometry === undefined ? feature.geometry : annotationClone(change.geometry)
  if (change.geometry !== undefined) {
    const previousCount = validateAnnotationGeometry(feature.geometry as AnnotationGeometry)
    const nextCount = validateAnnotationGeometry(change.geometry)
    if (annotationCoordinateCountOf(layer) - previousCount + nextCount > MAX_ANNOTATION_TOTAL_COORDINATES) {
      throw new MapChangeValidationError('annotation-limit', 'the annotation coordinate budget is full')
    }
  }
  const properties = {
    ...priorProperties,
    ...(change.name === undefined ? {} : { name: change.name }),
    ...(Object.hasOwn(change, 'description') ? { description: change.description } : {}),
    dshUpdateOperationId: context.operationId,
    dshUpdatedAt: context.at,
  }
  const updatedFeature = { ...feature, geometry, properties }
  const features = layerData.features.map(candidate => candidate.id === change.featureId ? updatedFeature : candidate)
  const data: GeoJsonFeatureCollection = { type: 'FeatureCollection', features }
  const overrides = Object.hasOwn(change, 'symbol')
    ? annotationOverrideWith({ ...layer, data }, change.featureId, change.symbol ?? null)
    : layer.overrides
  const { overrides: _oldOverrides, ...layerWithoutOverrides } = layer
  return {
    ...layerWithoutOverrides,
    data,
    displayDigest: stableDigestOf(data),
    ...(overrides === undefined ? {} : { overrides }),
  }
}

/** Settle one user annotation operation and append its compensating audit row. */
function settleAnnotationUserChange(
  state: MapProjectionState,
  input: {
    readonly seq: number
    readonly operationId: string
    readonly targetRevision: number
    readonly change: AnnotationUserChange
    readonly sessionId?: string
    readonly at?: string
    readonly featureId?: string
    readonly writerId?: 'user' | 'agent'
    readonly callId?: string
  },
): MapProjectionState {
  const priorLayer = annotationLayerOf(state)
  let nextLayer = priorLayer
  let undoOf: number | null = null
  if (input.change.op === 'annotation-undo') {
    const undoOperationId = input.change.operationId
    const target = state.operations.find(operation => operation.operationId === undoOperationId)
    if (target === undefined || (input.writerId !== 'agent' && target.writerId !== 'user')
      || target.annotationInverse === undefined || target.annotationInverse === null
      || target.annotationInverse.visualProposal !== undefined || target.annotationInverse.visualChange !== undefined) {
      return withDiagnostic(state, input.seq, 'annotation-unknown')
    }
    if (target.post.annotationDigest !== annotationDigestOf(priorLayer)) {
      return withDiagnostic(state, input.seq, 'stale-revision')
    }
    if (target.annotationInverse.order !== undefined) {
      const currentOrder = state.layers.map(layer => layer.id)
      if (JSON.stringify(target.post.order) !== JSON.stringify(currentOrder)
        || JSON.stringify([...target.annotationInverse.order].sort()) !== JSON.stringify([...currentOrder].sort())) {
        return withDiagnostic(state, input.seq, 'stale-revision')
      }
    }
    nextLayer = target.annotationInverse.layer === null ? undefined : target.annotationInverse.layer
    undoOf = target.index
  } else {
    const context = { ...annotationContextOf(input), operationId: input.operationId }
    nextLayer = annotationLayerAfterChange(priorLayer, input.change, context)
  }
  const ordinaryLayers = state.layers.filter(layer => layer.role !== 'user-annotation')
  let layers = nextLayer === undefined ? ordinaryLayers : [nextLayer, ...ordinaryLayers]
  if (priorLayer !== undefined && nextLayer !== undefined) {
    layers = state.layers.map(layer => layer.id === USER_ANNOTATION_LAYER_ID ? nextLayer : layer)
  }
  if (input.change.op === 'annotation-undo') {
    const operationId = input.change.operationId
    const target = state.operations.find(operation => operation.operationId === operationId)
    const order = target?.annotationInverse?.order
    if (order !== undefined) {
      layers = order.map(id => {
        const layer = layers.find(entry => entry.id === id)
        if (layer === undefined) throw new MapChangeValidationError('stale-revision', `annotation undo lost layer ${id}`)
        return layer
      })
    }
  }
  const nextRevision = state.revision + 1
  let summary: string
  switch (input.change.op) {
    case 'annotation-create':
      summary = `annotation-create ${input.change.name}`
      break
    case 'annotation-update':
      summary = `annotation-update ${input.change.featureId}`
      break
    case 'annotation-delete':
      summary = `annotation-delete (${input.change.featureIds.length})`
      break
    default:
      summary = `annotation-undo ${input.change.operationId}`
      break
  }
  const undoOperationId = input.change.op === 'annotation-undo' ? input.change.operationId : undefined
  const undoTarget = undoOperationId === undefined ? undefined
    : state.operations.find(operation => operation.operationId === undoOperationId)
  const operation: MapOperationRecord = {
    index: (state.operations[state.operations.length - 1]?.index ?? 0) + 1,
    operationId: input.operationId,
    undoOf,
    writerId: input.writerId ?? 'user',
    callId: input.callId ?? input.operationId,
    resultSeq: input.seq,
    revision: nextRevision,
    summary: summary.slice(0, 160),
    inverse: null,
    annotationInverse: {
      layer: priorLayer === undefined ? null : annotationClone(priorLayer),
      ...(undoTarget?.annotationInverse?.order === undefined ? {} : { order: state.layers.map(layer => layer.id) }),
    },
    post: {
      annotationDigest: annotationDigestOf(nextLayer),
      ...(undoTarget?.annotationInverse?.order === undefined ? {} : { order: layers.map(layer => layer.id) }),
      requestDigest: stableDigestOf(input.change),
    },
  }
  const settled = withOperationRecord({ ...state, layers, revision: nextRevision }, operation)
  const parsedSettled = mapProjectionStateSchema.safeParse(settled)
  if (settled === undefined || !parsedSettled.success) {
    return withDiagnostic(state, input.seq, 'annotation-limit')
  }
  return settled
}

/** Operations that preserve annotation identity while allowing an agent to control its map. */
export type AgentAnnotationChange = Exclude<AnnotationUserChange, { readonly op: 'annotation-create' }>
  | { readonly op: 'annotation-layer-style'; readonly symbol: SymbolStyle | null }
  | { readonly op: 'annotation-layer-order'; readonly layerIds: readonly string[] }
  | { readonly op: 'visual-proposal-apply'; readonly proposalId: string }
  | { readonly op: 'visual-proposal-dismiss'; readonly proposalId: string }
  | { readonly op: 'visual-change-apply'; readonly changeId: string }
  | { readonly op: 'visual-change-dismiss'; readonly changeId: string }

/** Durable result of an agent-owned annotation or candidate operation. */
export interface AgentAnnotationMeta {
  readonly kind: 'map-agent-annotation'
  readonly schemaVersion: 1
  readonly sourceCallSeq: number
  readonly targetRevision: number
  readonly operationId: string
  readonly sessionId: string
  readonly at: string
  readonly featureId?: string
  readonly change: AgentAnnotationChange
}

/** Rebuild derived candidate layers without moving unrelated layers. */
function rebuildCandidateLayers(
  previous: readonly MapProjectedLayer[],
  ordinary: readonly MapProjectedLayer[],
  proposals: readonly VisualProposalRecord[],
  changes: readonly VisualChangeRecord[],
): MapProjectedLayer[] {
  const remaining = [...ordinary]
  const proposal = visualProposalLayerOf(proposals)
  const change = visualChangeLayerOf(changes)
  const rebuilt: MapProjectedLayer[] = []
  for (const prior of previous) {
    const next = prior.role === 'visual-proposal' ? proposal : prior.role === 'visual-change' ? change
      : remaining.find(layer => layer.id === prior.id)
    if (next !== undefined) {
      rebuilt.push(next)
      const index = remaining.findIndex(layer => layer.id === next.id)
      if (index >= 0) remaining.splice(index, 1)
    }
  }
  if (proposal !== undefined && !rebuilt.some(layer => layer.id === proposal.id)) rebuilt.unshift(proposal)
  if (change !== undefined && !rebuilt.some(layer => layer.id === change.id)) rebuilt.unshift(change)
  return [...rebuilt, ...remaining]
}

/**
 * Settle an agent annotation result without impersonating a user notice.
 * @param state - accepted map state.
 * @param meta - validated agent annotation metadata.
 * @param callId - paired tool-call identity.
 * @param seq - result sequence.
 * @returns the updated state, or an unchanged revision with a diagnostic.
 */
export function settleAgentAnnotation(state: MapProjectionState, meta: AgentAnnotationMeta, callId: string, seq: number): MapProjectionState {
  if (state.operations.some(operation => operation.operationId === meta.operationId)) return state
  if (state.revision !== meta.targetRevision) return withDiagnostic(state, seq, 'stale-revision')
  try {
    const change = meta.change
    if (change.op === 'annotation-undo') {
      const target = state.operations.find(operation => operation.operationId === change.operationId)
      const inverse = target?.annotationInverse
      if (inverse?.visualProposal !== undefined || inverse?.visualChange !== undefined) {
        const priorProposal = inverse.visualProposal
        const priorChange = inverse.visualChange
        const current = priorProposal !== undefined
          ? state.visualProposals.find(entry => entry.proposalId === priorProposal.proposalId)
          : state.visualChanges.find(entry => entry.changeId === priorChange?.changeId)
        if (current === undefined || target?.post.visualDecisionDigest !== stableDigestOf(current)
          || target.post.annotationDigest !== annotationDigestOf(annotationLayerOf(state))) {
          return withDiagnostic(state, seq, 'stale-revision')
        }
        const proposals = priorProposal === undefined ? state.visualProposals
          : state.visualProposals.map(entry => entry.proposalId === priorProposal.proposalId ? priorProposal : entry)
        const changes = priorChange === undefined ? state.visualChanges
          : state.visualChanges.map(entry => entry.changeId === priorChange.changeId ? priorChange : entry)
        let layers = state.layers.filter(layer => layer.role !== 'visual-proposal' && layer.role !== 'visual-change')
        const currentAnnotation = annotationLayerOf(state)
        if (inverse.layer === null) layers = layers.filter(layer => layer.role !== 'user-annotation')
        else if (currentAnnotation === undefined) layers = [annotationClone(inverse.layer), ...layers]
        else layers = layers.map(layer => layer.id === USER_ANNOTATION_LAYER_ID ? annotationClone(inverse.layer as MapProjectedLayer) : layer)
        layers = rebuildCandidateLayers(state.layers, layers, proposals, changes)
        const revision = state.revision + 1
        const settled = withOperationRecord({ ...state, layers, visualProposals: proposals, visualChanges: changes, revision }, {
          index: (state.operations.at(-1)?.index ?? 0) + 1,
          operationId: meta.operationId, undoOf: target.index, writerId: 'agent', callId, resultSeq: seq, revision,
          summary: `annotation-undo ${change.operationId}`, inverse: null,
          annotationInverse: {
            layer: annotationLayerOf(state) === undefined ? null : annotationClone(annotationLayerOf(state) as MapProjectedLayer),
            ...(priorProposal === undefined ? {} : { visualProposal: current as VisualProposalRecord }),
            ...(priorChange === undefined ? {} : { visualChange: current as VisualChangeRecord }),
          },
          post: {
            annotationDigest: annotationDigestOf(inverse.layer ?? undefined),
            visualDecisionDigest: stableDigestOf(priorProposal ?? priorChange), requestDigest: stableDigestOf(change),
          },
        })
        return settled !== undefined && mapProjectionStateSchema.safeParse(settled).success
          ? settled : withDiagnostic(state, seq, 'annotation-limit')
      }
    }
    if (change.op === 'annotation-layer-style' || change.op === 'annotation-layer-order') {
      const previous = annotationLayerOf(state)
      if (previous === undefined) return withDiagnostic(state, seq, 'annotation-unknown')
      let layers: readonly MapProjectedLayer[]
      if (change.op === 'annotation-layer-style') {
        if (change.symbol?.presentation === 'heatmap'
          && (previous.style !== undefined || !isAllPointLayer(previous))) return withDiagnostic(state, seq, 'invalid-meta')
        const { symbol: _previousSymbol, ...withoutSymbol } = previous
        const updated = change.symbol === null ? withoutSymbol : { ...withoutSymbol, symbol: change.symbol }
        layers = state.layers.map(layer => layer.id === previous.id ? updated : layer)
      } else {
        const current = state.layers.map(layer => layer.id)
        if (change.layerIds.length !== current.length || new Set(change.layerIds).size !== current.length
          || change.layerIds.some(id => !current.includes(id))) return withDiagnostic(state, seq, 'style-layer-unknown')
        layers = change.layerIds.map(id => {
          const layer = state.layers.find(entry => entry.id === id)
          if (layer === undefined) throw new MapChangeValidationError('stale-revision', `annotation reorder lost layer ${id}`)
          return layer
        })
      }
      const nextLayer = layers.find(layer => layer.id === USER_ANNOTATION_LAYER_ID)
      const revision = state.revision + 1
      const settled = withOperationRecord({ ...state, layers, revision }, {
        index: (state.operations.at(-1)?.index ?? 0) + 1,
        operationId: meta.operationId, undoOf: null, writerId: 'agent', callId, resultSeq: seq, revision,
        summary: change.op, inverse: null,
        annotationInverse: {
          layer: annotationClone(previous),
          ...(change.op === 'annotation-layer-order' ? { order: state.layers.map(layer => layer.id) } : {}),
        },
        post: {
          annotationDigest: annotationDigestOf(nextLayer),
          ...(change.op === 'annotation-layer-order' ? { order: layers.map(layer => layer.id) } : {}),
          requestDigest: stableDigestOf(change),
        },
      })
      return settled !== undefined && mapProjectionStateSchema.safeParse(settled).success
        ? settled : withDiagnostic(state, seq, 'annotation-limit')
    }
    if (change.op === 'visual-proposal-apply' || change.op === 'visual-proposal-dismiss'
      || change.op === 'visual-change-apply' || change.op === 'visual-change-dismiss') {
      const proposalChange = 'proposalId' in change
      const apply = change.op.endsWith('-apply')
      const prior = proposalChange
        ? state.visualProposals.find(entry => entry.proposalId === change.proposalId)
        : state.visualChanges.find(entry => entry.changeId === change.changeId)
      if (prior === undefined || prior.status !== 'proposed') {
        return withDiagnostic(state, seq, proposalChange ? 'visual-proposal-unknown' : 'comparison-unknown')
      }
      const featureId = apply ? meta.featureId : undefined
      if (apply && featureId === undefined) return withDiagnostic(state, seq, 'invalid-meta')
      const reviewed = {
        ...prior, status: apply ? 'agent-applied' as const : 'agent-dismissed' as const,
        reviewedAt: meta.at, reviewedBy: 'agent' as const, humanEdited: false, acceptedFeatureId: featureId ?? null,
      }
      const proposals = proposalChange
        ? state.visualProposals.map(entry => entry.proposalId === change.proposalId ? reviewed as VisualProposalRecord : entry)
        : state.visualProposals
      const changes = proposalChange
        ? state.visualChanges
        : state.visualChanges.map(entry => entry.changeId === change.changeId ? reviewed as VisualChangeRecord : entry)
      let layers = state.layers.filter(layer => layer.role !== 'visual-proposal' && layer.role !== 'visual-change')
      if (apply) {
        const previous = annotationLayerOf(state)
        const created = annotationLayerAfterChange(previous, {
          op: 'annotation-create', geometry: prior.geometry, name: prior.category,
          ...(prior.note === '' ? {} : { description: prior.note }),
        }, { sessionId: meta.sessionId, at: meta.at, featureId: featureId as string, operationId: meta.operationId })
        if (created === undefined || created.data === undefined) return withDiagnostic(state, seq, 'invalid-meta')
        const features = created.data.features.map(feature => feature.id === featureId
          ? { ...feature, properties: { ...feature.properties, dshAuthor: 'agent', dshSource: proposalChange ? 'visual-proposal' : 'visual-change' } }
          : feature)
        const data: GeoJsonFeatureCollection = { type: 'FeatureCollection', features }
        const annotation = { ...created, data, displayDigest: stableDigestOf(data) }
        layers = previous === undefined ? [annotation, ...layers]
          : layers.map(layer => layer.id === USER_ANNOTATION_LAYER_ID ? annotation : layer)
      }
      layers = rebuildCandidateLayers(state.layers, layers, proposals, changes)
      const revision = state.revision + 1
      const settled = withOperationRecord({ ...state, layers, visualProposals: proposals, visualChanges: changes, revision }, {
        index: (state.operations.at(-1)?.index ?? 0) + 1,
        operationId: meta.operationId, undoOf: null, writerId: 'agent', callId, resultSeq: seq, revision,
        summary: change.op, inverse: null,
        annotationInverse: {
          layer: annotationLayerOf(state) === undefined ? null : annotationClone(annotationLayerOf(state) as MapProjectedLayer),
          ...(proposalChange ? { visualProposal: prior as VisualProposalRecord } : { visualChange: prior as VisualChangeRecord }),
        },
        post: {
          annotationDigest: annotationDigestOf(layers.find(layer => layer.role === 'user-annotation')),
          visualDecisionDigest: stableDigestOf(reviewed), requestDigest: stableDigestOf(change),
        },
      })
      return settled !== undefined && mapProjectionStateSchema.safeParse(settled).success
        ? settled : withDiagnostic(state, seq, 'annotation-limit')
    }
    return settleAnnotationUserChange(state, {
      seq, operationId: meta.operationId, targetRevision: meta.targetRevision,
      change, sessionId: meta.sessionId, at: meta.at,
      featureId: change.op === 'annotation-update' ? change.featureId : 'ann-000000000000000000000000',
      writerId: 'agent', callId,
    })
  } catch (error) {
    if (error instanceof MapChangeValidationError) return withDiagnostic(state, seq, error.code)
    throw error
  }
}

/**
 * Settle one user map change the panel wrote directly. The change was
 * admitted by the host route against the revision it targets; the fold
 * re-checks revision and feasibility because the inbox insertion may commit
 * after another writer. An `operationId` already in the ledger is a replay
 * (the same notice claimed later) and changes nothing. User records carry
 * no tool call: `callId` names the operation, `writerId` is `user`.
 * @param state - the accepted state.
 * @param input - the committing event seq, operation id, target revision, and lowered change.
 * @returns the next state (the input reference when nothing applies).
 */
export function settleUserChange(
  state: MapProjectionState,
  input: {
    readonly seq: number
    readonly operationId: string
    readonly targetRevision: number
    readonly change: MapChange | AnnotationUserChange | VisualProposalUserChange | VisualChangeUserChange
    readonly sessionId?: string
    readonly at?: string
    readonly featureId?: string
  },
): MapProjectionState {
  const { seq, operationId, targetRevision, change } = input
  if (state.operations.some(applied => applied.operationId === operationId)) return state
  if (targetRevision !== state.revision) return withDiagnostic(state, seq, 'stale-revision')
  if (change.op === 'annotation-create' || change.op === 'annotation-update'
    || change.op === 'annotation-delete' || change.op === 'annotation-undo') {
    try {
      return settleAnnotationUserChange(state, { ...input, change: input.change as AnnotationUserChange })
    } catch (error) {
      if (error instanceof MapChangeValidationError) return withDiagnostic(state, seq, error.code)
      return withDiagnostic(state, seq, 'invalid-meta')
    }
  }
  if (change.op === 'visual-proposal-accept' || change.op === 'visual-proposal-reject') {
    const proposal = state.visualProposals.find(candidate => candidate.proposalId === change.proposalId)
    if (proposal === undefined || proposal.status !== 'proposed' || change.expectedRevision !== state.revision) {
      return withDiagnostic(state, seq, 'visual-proposal-unknown')
    }
    const reviewedAt = input.at ?? new Date().toISOString()
    const humanEdited = change.op === 'visual-proposal-accept'
      && (change.name !== undefined || change.description !== undefined || change.geometry !== undefined)
    const acceptedFeatureId = change.op === 'visual-proposal-accept' ? input.featureId ?? undefined : undefined
    if (change.op === 'visual-proposal-accept' && acceptedFeatureId === undefined) return withDiagnostic(state, seq, 'invalid-meta')
    const reviewed: VisualProposalRecord = {
      ...proposal,
      status: change.op === 'visual-proposal-accept' ? 'accepted' : 'rejected',
      reviewedAt,
      humanEdited,
      acceptedFeatureId: acceptedFeatureId ?? null,
    }
    const nextProposals = state.visualProposals.map(candidate => candidate.proposalId === proposal.proposalId ? reviewed : candidate)
    let layers = state.layers.filter(layer => layer.role !== 'visual-proposal' && layer.id !== VISUAL_PROPOSAL_LAYER_ID)
    if (change.op === 'visual-proposal-accept') {
      const annotation = annotationLayerOf(state)
      const create: AnnotationUserChange = {
        op: 'annotation-create',
        geometry: change.geometry ?? proposal.geometry,
        name: change.name ?? proposal.category,
        ...(change.description !== undefined ? { description: change.description } : proposal.note === '' ? {} : { description: proposal.note }),
      }
      try {
        const annotationNext = annotationLayerAfterChange(annotation, create, {
          sessionId: input.sessionId ?? '', at: reviewedAt, featureId: acceptedFeatureId as string, operationId,
        })
        const ordinary = layers.filter(layer => layer.role !== 'user-annotation' && layer.id !== USER_ANNOTATION_LAYER_ID)
        layers = annotationNext === undefined ? ordinary : [annotationNext, ...ordinary]
      } catch (error) {
        if (error instanceof MapChangeValidationError) return withDiagnostic(state, seq, error.code)
        return withDiagnostic(state, seq, 'invalid-meta')
      }
    }
    const derived = visualProposalLayerOf(nextProposals)
    if (derived !== undefined) layers = [derived, ...layers]
    const nextRevision = state.revision + 1
    const next: MapProjectionState = {
      ...state,
      layers,
      visualProposals: nextProposals,
      revision: nextRevision,
    }
    const operation: MapOperationRecord = {
      index: (state.operations.at(-1)?.index ?? 0) + 1,
      operationId,
      undoOf: null,
      writerId: 'user',
      callId: operationId,
      resultSeq: seq,
      revision: nextRevision,
      summary: `${change.op} ${change.proposalId}`,
      inverse: null,
      annotationInverse: { layer: annotationLayerOf(state) ?? null },
      post: { annotationDigest: annotationDigestOf(annotationLayerOf(next)), requestDigest: stableDigestOf(change) },
    }
    const settled = withOperationRecord(next, operation)
    return settled !== undefined && mapProjectionStateSchema.safeParse(settled).success
      ? settled
      : withDiagnostic(state, seq, 'visual-proposal-limit')
  }
  if (change.op === 'visual-change-accept' || change.op === 'visual-change-reject') {
    const candidate = state.visualChanges.find(entry => entry.changeId === change.changeId)
    if (candidate === undefined || candidate.status !== 'proposed' || change.expectedRevision !== state.revision) {
      return withDiagnostic(state, seq, 'comparison-unknown')
    }
    const reviewedAt = input.at ?? new Date().toISOString()
    const humanEdited = change.op === 'visual-change-accept'
      && (change.name !== undefined || change.description !== undefined || change.geometry !== undefined)
    const acceptedFeatureId = change.op === 'visual-change-accept' ? input.featureId ?? undefined : undefined
    if (change.op === 'visual-change-accept' && acceptedFeatureId === undefined) return withDiagnostic(state, seq, 'invalid-meta')
    const reviewed: VisualChangeRecord = {
      ...candidate,
      status: change.op === 'visual-change-accept' ? 'accepted' : 'rejected',
      reviewedAt,
      humanEdited,
      acceptedFeatureId: acceptedFeatureId ?? null,
    }
    const nextChanges = state.visualChanges.map(entry => entry.changeId === candidate.changeId ? reviewed : entry)
    let layers = state.layers.filter(layer => layer.role !== 'visual-change' && layer.id !== VISUAL_CHANGE_LAYER_ID)
    if (change.op === 'visual-change-accept') {
      const annotation = annotationLayerOf(state)
      const create: AnnotationUserChange = {
        op: 'annotation-create',
        geometry: change.geometry ?? candidate.geometry,
        name: change.name ?? candidate.category,
        ...(change.description !== undefined ? { description: change.description } : candidate.note === '' ? {} : { description: candidate.note }),
      }
      try {
        const annotationNext = annotationLayerAfterChange(annotation, create, {
          sessionId: input.sessionId ?? '', at: reviewedAt, featureId: acceptedFeatureId as string, operationId,
        })
        const ordinary = layers.filter(layer => layer.role !== 'user-annotation' && layer.id !== USER_ANNOTATION_LAYER_ID)
        layers = annotationNext === undefined ? ordinary : [annotationNext, ...ordinary]
      } catch (error) {
        if (error instanceof MapChangeValidationError) return withDiagnostic(state, seq, error.code)
        return withDiagnostic(state, seq, 'invalid-meta')
      }
    }
    const derived = visualChangeLayerOf(nextChanges)
    if (derived !== undefined) layers = [derived, ...layers]
    const nextRevision = state.revision + 1
    const next: MapProjectionState = { ...state, layers, visualChanges: nextChanges, revision: nextRevision }
    const operation: MapOperationRecord = {
      index: (state.operations.at(-1)?.index ?? 0) + 1,
      operationId,
      undoOf: null,
      writerId: 'user',
      callId: operationId,
      resultSeq: seq,
      revision: nextRevision,
      summary: `${change.op} ${change.changeId}`,
      inverse: null,
      annotationInverse: { layer: annotationLayerOf(state) ?? null },
      post: { annotationDigest: annotationDigestOf(annotationLayerOf(next)), requestDigest: stableDigestOf(change) },
    }
    const settled = withOperationRecord(next, operation)
    return settled !== undefined && mapProjectionStateSchema.safeParse(settled).success
      ? settled
      : withDiagnostic(state, seq, 'comparison-limit')
  }
  const mapChange = change as MapChange
  try {
    validateMapChangeCandidate(state, mapChange)
  } catch (error) {
    if (error instanceof MapChangeValidationError) return withDiagnostic(state, seq, error.code)
    return withDiagnostic(state, seq, 'invalid-meta')
  }
  const refusal = foldRefusalFor(state, mapChange)
  if (refusal !== null) return withDiagnostic(state, seq, refusal)
  const { inverse, post, summary } = inverseAndPostOf(state, mapChange)
  const nextRevision = state.revision + 1
  const ledger: MapOperationRecord = {
    index: (state.operations[state.operations.length - 1]?.index ?? 0) + 1,
    operationId,
    undoOf: null,
    writerId: 'user',
    callId: operationId,
    resultSeq: seq,
    revision: nextRevision,
    summary,
    inverse,
    post: { ...post, requestDigest: stableDigestOf(mapChange) },
  }
  const settled = withOperationRecord({ ...applyChangeLayers(state, mapChange), revision: nextRevision }, ledger)
  return settled ?? withDiagnostic(state, seq, 'oversized-meta')
}
