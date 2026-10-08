/**
 * Runtime container types shared by the node read faces and the browser half:
 * one container per session, its layer records, and the view record. Since
 * P0a the authoritative persisted state lives in
 * {@link ./protocol.ts!MapProjectionState}; this module keeps only the
 * runtime read-model vocabulary the browser occurrence consumes
 * (the wire fold in `client/state.ts` rebuilds the Map-keyed view from the
 * projection's ordered layer array).
 */
import type { StyleSpec } from '@map-harness/spatial-viz'
import type { StreamCheckpoint } from '@map-harness/spatial-realtime'

/** One WGS84 GeoJSON feature exchanged between the tool domain and the view. */
export interface GeoJsonFeature {
  type: 'Feature'
  /** A GeoJSON geometry object, or `null` for a geometry-less feature. */
  geometry: { type: string; coordinates?: unknown } | null
  properties?: Record<string, unknown> | null
}

/** A WGS84 GeoJSON FeatureCollection exchanged between the tool domain and the view. */
export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection'
  features: GeoJsonFeature[]
}

/**
 * The single-symbol style and legend record a versioned layer minimally
 * carries: enough for the browser to draw and label one series, never a
 * second style authority. Classified layers carry the fuller
 * `spatial-viz` {@link MapLayerRecord.style} instead.
 */
export interface MapLayerLegend {
  readonly title: string
  readonly symbol: {
    readonly color: string
    readonly outline: string
  }
}

/**
 * The terrain identity a terrain-preview layer carries: the exact bound
 * surface version (ref plus content digest), its vertical metadata, and the
 * grid shape the bounded display copy decimates from. The occurrence keys
 * the rendered identity on the revision, so a same-id layer re-added at a
 * new terrain version redraws; the analysis seam (`geo_line_of_sight`)
 * refuses computations whose resolved revision differs from the displayed
 * one, keeping display and analysis on one terrain revision.
 */
export interface MapLayerTerrain {
  /** Exact surface resource ref (`res-…@vN`). */
  readonly surfaceRef: string
  /** Content digest of the exact bound bytes — the terrain revision token. */
  readonly revision: string
  readonly verticalDatum: string
  readonly verticalUnits: string
  readonly epoch: string
  /** Property the display points carry the elevation under. */
  readonly elevationField: string
  /** Grid lattice shape the display copy decimates from. */
  readonly gridColumns: number
  readonly gridRows: number
  /** True point count of the bound surface version. */
  readonly sourcePointCount: number
}

/**
 * The realtime stream identity a stream-workbench layer carries: the workbench
 * it drives, whether the displayed state is the live realtime projection or a
 * fixed materialized snapshot, the status facts the checklist requires to stay
 * visible (watermark, lag, late revisions, data gaps, pause), and the bounded
 * checkpoint the next `stream_*` call resumes from. The layer record is the
 * durable workbench state: replaying the session log refolds the same
 * checkpoint, so a stream survives a fresh process without any store beyond
 * the log.
 */
export interface MapLayerStream {
  /** Stable workbench id; also the layer id of the stream layer. */
  readonly streamId: string
  /** Exact scenario resource ref (`res-…@vN`) the controlled source replays. */
  readonly scenarioRef: string
  /** Content digest of the bound scenario version — the source revision the workbench cites. */
  readonly scenarioRevision: string
  /** `realtime` is the live derived projection; `materialized` is the fixed snapshot a report cites. */
  readonly mode: 'realtime' | 'materialized'
  /** The stream method identity the workbench runs under. */
  readonly methodVersion: string
  readonly windowSizeMs: number
  readonly allowedLatenessMs: number
  /** Event-time watermark, milliseconds; `null` before the first admitted event. */
  readonly watermarkMs: number | null
  /** Process time minus max event time, milliseconds; the visible lag. */
  readonly lagMs: number | null
  readonly paused: boolean
  /** Increments whenever the window set's conclusions change (close, late revision, gap). */
  readonly revision: number
  /** Windows closed by the watermark in the live retention set. */
  readonly closedWindows: number
  /** Data-gap windows materialized as `empty` — visible, never interpolated. */
  readonly gapWindows: number
  /** Windows a late event revised past their first close. */
  readonly lateRevisions: number
  /** Re-delivered event ids the dedup window dropped. */
  readonly duplicatesDropped: number
  /** Batches the source spent disconnected. */
  readonly offlineBatches: number
  /** The bounded checkpoint the next stream call resumes from. */
  readonly checkpoint: StreamCheckpoint
  /** The materialized pins (export digest → published artifact ref), when materialized. */
  readonly materialized?: readonly { readonly exportDigest: string; readonly artifactRef: string }[]
}

/** One data layer loaded into a container. Data is WGS84 GeoJSON; sourceCrs records the file's original CRS when known. */
export interface MapLayerRecord {
  readonly id: string
  readonly name: string
  /** The GeoJSON payload in WGS84; the view reprojects for display. */
  readonly data: GeoJsonFeatureCollection
  /** Source coordinate reference system the data was read as, when known (e.g. `EPSG:4547`). Display-only metadata. */
  readonly sourceCrs?: string
  readonly opacity: number
  readonly visible: boolean
  /**
   * Digest of the display data (or the tool-supplied display digest) — the
   * rendered-identity token: a same-id, same-featureCount layer with changed
   * coordinates or attributes produces a different token and must redraw.
   */
  readonly displayDigest?: string
  /** Exact artifact ref (`art-…@vN`) the layer renders, when added from a published artifact. */
  readonly artifactRef?: string
  /** Exact resource ref (`res-…@vN`) the layer's data came from, when added from the catalog. */
  readonly resourceRef?: string
  /** Minimal single-symbol legend, when the layer carries one. */
  readonly legend?: MapLayerLegend
  /**
   * The classification style the layer renders, when `viz_classify` or
   * `viz_compare` classified it. The style is the sole color/unit authority
   * for the layer; the workbench derives its legend from this value.
   */
  readonly style?: StyleSpec
  /**
   * The terrain identity, when the layer is a bounded terrain preview added
   * from a versioned surface (`terrain_add_layer`). The display points carry
   * elevation under `terrain.elevationField`; both 2D and 3D occurrences
   * render the same preview and cite the same revision.
   */
  readonly terrain?: MapLayerTerrain
  /**
   * The realtime stream identity, when the layer is a stream-workbench
   * projection (`stream_open` and friends). Carrying it requires the current
   * meta schema version, and the embedded checkpoint must decode — a fold
   * that could not resume would strand the workbench.
   */
  readonly stream?: MapLayerStream
}

/** The view state: center in WGS84 lon/lat, zoom, and the display projection's WKID. */
export interface MapViewRecord {
  readonly center: readonly [number, number]
  readonly zoom: number
  /** Display projection WKID; 4326 default. 3D local scenes accept projected WKIDs. */
  readonly wkid: number
}

/** One named study AOI polygon the occurrence draws as an outline. */
export interface MapAoiRecord {
  readonly name?: string
  readonly ring: readonly (readonly [number, number])[]
}

/** One operation in the bounded audit history the browser history face renders. */
export interface MapOperationSummary {
  /** Monotonic operation index within the session (stable undo reference). */
  readonly index: number
  readonly operationId: string | null
  readonly undoOf: number | null
  readonly writerId: string | null
  /** Post-apply revision. */
  readonly revision: number
  readonly summary: string
}

/** The runtime read model of one session's container as the browser occurrence applies it. */
export interface MapContainerState {
  readonly layers: ReadonlyMap<string, MapLayerRecord>
  readonly view: MapViewRecord
  /** Viewing mode: `map` is the 2D MapView, `scene` is the 3D SceneView. */
  readonly mode: 'map' | 'scene'
  /** The study AOI outline, when one is set; the occurrence draws it as a graphic. */
  readonly aoi: MapAoiRecord | null
  /** Increments once per applied map change; export manifests pin it. */
  readonly revision: number
  /** Newest-last bounded operation history (audit face; the full ledger stays host-side). */
  readonly operations: readonly MapOperationSummary[]
}
