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
import { validateStyleSpec, type StyleSpec } from '@map-harness/spatial-viz'
import { decodeCheckpoint } from '@map-harness/spatial-realtime'
import { DISPLAY_GEOMETRY_TYPES, isSupportedDisplayWkid, validateGeoJsonValue } from '@map-harness/spatial-catalog'
import type { GeoJsonFeatureCollection, MapLayerLegend, MapLayerStream, MapLayerTerrain, MapViewRecord } from './registry.ts'

export { DISPLAY_GEOMETRY_TYPES } from '@map-harness/spatial-catalog'

/**
 * Persisted-state generation of the `mapContainer` unit. Bumped 2 → 3 with the
 * JSON re-serialization (Maps became ordered arrays), 3 → 4 with the P0b
 * layer identity fields, 4 → 5 with the P3-visualization layer style
 * records, 5 → 6 with the collaboration plane (AOI record plus the
 * bounded operation ledger), 6 → 7 with the terrain identity block on
 * layers, and 7 → 8 with the realtime stream identity block (checkpoint
 * plus status) on layers, so persisted cache rows carrying the previous
 * shapes are discarded and refolded from the raw log.
 */
export const MAP_PROJECTION_STATE_VERSION = 8

/**
 * Wire/protocol version of the durable map `tool/result.meta` record. Bumped
 * 1 → 2 when layers gained their P0b identity fields, 2 → 3 when layers
 * gained their visualization style and the `set-style` change joined the
 * vocabulary, and 3 → 4 when the collaboration plane added the optional
 * writer/operation/undo identity fields and the `patch`, `reorder-layers`,
 * and `set-aoi` changes; versions 1–3 records still decode (v4 fields
 * absent), while older builds refuse v4 records read-only instead of
 * misreading them.
 */
export const MAP_META_SCHEMA_VERSION = 4

/** The schema versions whose map-change records decode (1 = pre-P0b layer shape, 2 = pre-style shape, 3 = pre-collab shape). */
const DECODABLE_META_VERSIONS = [1, 2, 3, MAP_META_SCHEMA_VERSION] as const

/** The only meta kind P0a decodes; unknown kinds never apply. */
export const MAP_META_KIND = 'map-change'

/** Map mutation tool names whose successful results change the container. */
export const MAP_MUTATION_TOOL_NAMES = [
  'map_add_layer',
  'map_remove_layer',
  'map_set_view',
  'map_set_mode',
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
] as const

/** One map mutation tool name. */
export type MapMutationName = typeof MAP_MUTATION_TOOL_NAMES[number]

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
  /** WGS84 GeoJSON FeatureCollection the browser renders. */
  readonly data: GeoJsonFeatureCollection
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
  readonly name: MapMutationName
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
  | 'invalid-view'
  | 'duplicate-op'

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

/**
 * Stable content digest of one value (FNV-1a over the canonical JSON) — the
 * identity token the collaboration plane compares instead of content.
 * @param value - the JSON value to digest.
 * @returns a 32-bit hex digest string.
 */
export function stableDigestOf(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null'
  let hash = 0x811c9dc5
  for (let at = 0; at < json.length; at += 1) {
    hash ^= json.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The layer identity digest the collaboration plane compares (`displayDigest` when present, else the data digest). */
export function layerDigestOf(layer: Pick<MapProjectedLayer, 'displayDigest' | 'data'>): string {
  return layer.displayDigest ?? stableDigestOf(layer.data)
}

/** The AOI identity digest the collaboration plane compares. */
export function aoiDigestOf(aoi: MapAoi | null): string | null {
  return aoi === null ? null : stableDigestOf(aoi)
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
  readonly aoiDigest?: string | null
  readonly styleVersions?: readonly { readonly layerId: string; readonly styleVersion: string }[]
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
  /** The post-state the undo target check judges against the current document. */
  readonly post: MapOperationPostState
}

/** The plain-JSON persisted state of the `mapContainer` projection (cache-writeable by contract). */
export interface MapProjectionState {
  /** Self-describing persisted-state generation; the unit's `stateVersion` equals it. */
  readonly stateVersion: typeof MAP_PROJECTION_STATE_VERSION
  /** Layers in add order; ordered array, never a Map. */
  readonly layers: readonly MapProjectedLayer[]
  readonly view: MapViewRecord
  readonly mode: 'map' | 'scene'
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

/**
 * The base change vocabulary: every change except `patch` itself, so a patch
 * nests a bounded, non-recursive list of them.
 */
export type BaseMapChange =
  | { readonly op: 'add-layer'; readonly layer: MapProjectedLayer }
  | { readonly op: 'remove-layer'; readonly layerId: string }
  | { readonly op: 'set-view'; readonly view: MapViewRecord }
  | { readonly op: 'set-mode'; readonly mode: 'map' | 'scene' }
  | { readonly op: 'set-style'; readonly styles: readonly StyleChangeEntry[] }
  | { readonly op: 'reorder-layers'; readonly layerIds: readonly string[] }
  | { readonly op: 'set-aoi'; readonly aoi: MapAoi | null }

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
  data: z.unknown(),
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
  terrain: projectedLayerTerrainSchema.optional(),
  stream: projectedLayerStreamSchema.optional(),
}).strict().check((layer) => {
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
    z.object({ op: z.literal('set-style'), styles: z.array(styleChangeEntrySchema).min(1).max(8) }).strict(),
    reorderChangeSchema,
    setAoiChangeSchema,
  ])).min(1).max(MAX_PATCH_CHANGES),
}).strict()

const changeSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add-layer'), layer: projectedLayerSchema }).strict(),
  z.object({ op: z.literal('remove-layer'), layerId: z.string().min(1) }).strict(),
  z.object({ op: z.literal('set-view'), view: viewRecordSchema }).strict(),
  z.object({ op: z.literal('set-mode'), mode: z.enum(['map', 'scene']) }).strict(),
  z.object({ op: z.literal('set-style'), styles: z.array(styleChangeEntrySchema).min(1).max(8) }).strict(),
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

/** Durable map-change meta schema: v3 layers may carry styles; v4 adds the collab identity fields and the patch/reorder/aoi changes; v1/v2 records decode without them. */
export const mapChangeMetaSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(MAP_META_SCHEMA_VERSION)]),
  kind: z.literal(MAP_META_KIND),
  sourceCallSeq: z.number().int().nonnegative(),
  targetRevision: z.number().int().nonnegative(),
  change: changeSchema,
  operationId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
  undoOf: z.number().int().nonnegative().optional(),
  writerId: z.string().min(1).max(64).optional(),
}).strict().check((meta) => {
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
    && meta.value.schemaVersion !== MAP_META_SCHEMA_VERSION) {
    meta.issues.push({
      code: 'custom',
      message: 'collaboration-plane changes and identity fields require the current meta schema version',
      input: meta.value,
      path: ['schemaVersion'],
    })
  }
  // Terrain identities arrived inside the current version's add-layer layers
  // (an additive field, not a new change): an older record naming one refuses
  // read-only rather than folding a layer whose revision it cannot track.
  const layersOf = (change: typeof meta.value.change): readonly unknown[] | undefined => {
    if (change.op === 'add-layer') return [change.layer]
    if (change.op === 'patch') return change.changes.filter(nested => nested.op === 'add-layer')
    return undefined
  }
  const carriesTerrain = layersOf(meta.value.change)?.some(layer =>
    layer !== null && typeof layer === 'object' && 'terrain' in layer && layer.terrain !== undefined)
  if (carriesTerrain && meta.value.schemaVersion !== MAP_META_SCHEMA_VERSION) {
    meta.issues.push({
      code: 'custom',
      message: 'terrain layer identities require the current meta schema version',
      input: meta.value,
      path: ['schemaVersion'],
    })
  }
  // Stream workbench identities arrived inside the current version's
  // add-layer layers (an additive field, not a new change): an older record
  // naming one refuses read-only rather than folding a workbench whose
  // checkpoint it cannot track.
  const carriesStream = layersOf(meta.value.change)?.some(layer =>
    layer !== null && typeof layer === 'object' && 'stream' in layer && layer.stream !== undefined)
  if (carriesStream && meta.value.schemaVersion !== MAP_META_SCHEMA_VERSION) {
    meta.issues.push({
      code: 'custom',
      message: 'stream workbench identities require the current meta schema version',
      input: meta.value,
      path: ['schemaVersion'],
    })
  }
}) as unknown as z.ZodType<MapChangeMeta>

/** Persisted projection state schema: validates cache rows and restore seeds. */
export const mapProjectionStateSchema = z.object({
  stateVersion: z.literal(MAP_PROJECTION_STATE_VERSION),
  layers: z.array(projectedLayerSchema).max(MAX_MAP_LAYERS),
  view: viewRecordSchema,
  mode: z.enum(['map', 'scene']),
  aoi: mapAoiSchema.nullable(),
  revision: z.number().int().nonnegative(),
  lastCallId: z.string().nullable(),
  pendingCalls: z.array(z.object({
    callId: z.string().min(1),
    callSeq: z.number().int().nonnegative(),
    name: z.enum(MAP_MUTATION_TOOL_NAMES),
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
      'invalid-view',
      'duplicate-op',
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
    post: z.unknown(),
  }).strict()).max(MAX_MAP_OPERATION_RECORDS),
}).strict().check((state) => {
  if (utf8ByteLength(state.value) > MAX_PROJECTION_STATE_BYTES) {
    state.issues.push({ code: 'custom', message: `map projection exceeds the ${MAX_PROJECTION_STATE_BYTES} byte limit`, input: state.value, path: [] })
  }
}) as unknown as z.ZodType<MapProjectionState>

/** The initial plain-JSON state for a fresh session's container. */
export function initialMapProjectionState(): MapProjectionState {
  return {
    stateVersion: MAP_PROJECTION_STATE_VERSION,
    layers: [],
    view: { center: [0, 0], zoom: 0, wkid: 4326 },
    mode: 'map',
    aoi: null,
    revision: 0,
    lastCallId: null,
    pendingCalls: [],
    diagnostics: [],
    operations: [],
  }
}

/** Pre-commit failure: the candidate violates capacity or payload bounds against the current state. */
export class MapChangeValidationError extends Error {
  /** Machine-readable refusal code for the model-facing error path. */
  readonly code: 'capacity' | 'oversized-meta' | 'style-layer-unknown' | 'layer-unknown' | 'invalid-view' | 'invalid-meta'
  constructor(code: 'capacity' | 'oversized-meta' | 'style-layer-unknown' | 'layer-unknown' | 'invalid-view' | 'invalid-meta', message: string) {
    super(message)
    this.code = code
  }
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
  if (change.op === 'add-layer') {
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
  if (change.op === 'reorder-layers') {
    const current = state.layers.map(layer => layer.id).sort().join('|')
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
export function mapChangeAllowedForTool(name: MapMutationName, change: MapChange): boolean {
  if (name === 'map_apply_patch' || name === 'map_undo') return true
  if (change.op === 'patch') return false
  switch (name) {
    case 'map_add_layer':
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
      return change.op === 'set-view'
    case 'map_set_mode':
      return change.op === 'set-mode'
    case 'viz_classify':
    case 'viz_compare':
      return change.op === 'set-style'
    case 'viz_aggregate':
      return change.op === 'add-layer'
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
function foldRefusalFor(state: MapProjectionState, change: MapChange): 'capacity' | 'style-layer-unknown' | 'layer-unknown' | null {
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
    return replacing || state.layers.length < MAX_MAP_LAYERS ? null : 'capacity'
  }
  if (change.op === 'remove-layer') {
    return state.layers.some(layer => layer.id === change.layerId) ? null : 'layer-unknown'
  }
  if (change.op === 'set-style') {
    return change.styles.every(entry => state.layers.some(layer => layer.id === entry.layerId)) ? null : 'style-layer-unknown'
  }
  if (change.op === 'reorder-layers') {
    const current = state.layers.map(layer => layer.id).sort().join('|')
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
        layers: change.layerIds.map(id => {
          const layer = state.layers.find(candidate => candidate.id === id)
          if (layer === undefined) throw new Error(`fold reorder lost layer ${id}`)
          return layer
        }),
      }
    case 'set-aoi':
      return { ...state, aoi: change.aoi }
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
    aoiDigest?: string | null
    styleVersions?: { layerId: string; styleVersion: string }[]
  }
  if (addendum.layers !== undefined) mutable.layers = [...(mutable.layers ?? []), ...addendum.layers]
  if (addendum.absentIds !== undefined) mutable.absentIds = [...(mutable.absentIds ?? []), ...addendum.absentIds]
  if (addendum.order !== undefined) mutable.order = [...addendum.order]
  if (addendum.view !== undefined) mutable.view = addendum.view
  if (addendum.mode !== undefined) mutable.mode = addendum.mode
  if (addendum.aoiDigest !== undefined) mutable.aoiDigest = addendum.aoiDigest
  if (addendum.styleVersions !== undefined) mutable.styleVersions = [...(mutable.styleVersions ?? []), ...addendum.styleVersions]
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
    const boundedEntry: MapOperationRecord = { ...entry, inverse: null }
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
function decodeLegacyMapChangeMeta(name: MapMutationName, meta: unknown, callSeq: number): MapChange | undefined {
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
      // Style and collaboration changes arrived with the versioned v3/v4
      // metas; no pre-P0a flat form exists.
      change = undefined
      break
  }
  if (change === undefined) return undefined
  return changeSchema.safeParse(change).success ? change : undefined
}
