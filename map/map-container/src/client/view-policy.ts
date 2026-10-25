/**
 * Key-free ArcGIS view policy shared by the occurrence and pure tests.
 * @module @map-harness/map-container/client/view-policy
 */

/** Fields needed to construct the package's key-free ArcGIS Online imagery layer. */
export interface KeyFreeBasemapPolicy {
  readonly title: string
  readonly urlTemplate: string
  readonly copyright: string
}

/** Public World Imagery XYZ tiles; no API token is required. */
export const KEY_FREE_BASEMAP: KeyFreeBasemapPolicy = Object.freeze({
  title: 'World Imagery',
  urlTemplate: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{level}/{row}/{col}',
  copyright: 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
})

/**
 * Select the spatial reference ArcGIS must set explicitly.
 * @param wkid - display WKID from the session map record.
 * @returns projected WKID, or `undefined` when the default Web Mercator view must remain.
 */
export function explicitSpatialReferenceWkid(wkid: number): number | undefined {
  return wkid === 4326 ? undefined : wkid
}

/**
 * Whether the key-free World Imagery tiles are compatible with this display record.
 * Geographic (4326) and Web Mercator (3857) share the same engine and tiles;
 * other projected WKIDs cannot host 3857 raster tiles.
 * @param wkid - display WKID from the session map record.
 */
export function rasterBasemapEnabled(wkid: number): boolean {
  return viewEngineKey(wkid) === 3857
}

/**
 * Identity of the ArcGIS view engine for a display record.
 * Geographic records share the default Web Mercator engine (`3857`).
 * @param wkid - display WKID from the session map record.
 */
export function viewEngineKey(wkid: number): number {
  return explicitSpatialReferenceWkid(wkid) ?? 3857
}

/** Zoom-0 scale of the Web-Mercator LOD convention the map tools' `zoom` uses. */
export const WEB_MERCATOR_ZOOM0_SCALE = 591657527.591555

/**
 * Convert the tool contract's Web-Mercator zoom into a view scale. Projected
 * views carry no raster LODs, so `MapView.zoom` stays -1 there and the camera
 * must go through `scale`.
 * @param zoom - Web-Mercator zoom level from the session map record.
 */
export function scaleFromZoom(zoom: number): number {
  return WEB_MERCATOR_ZOOM0_SCALE / 2 ** zoom
}

/**
 * Basemap source kind for a display record: cached XYZ tiles on the Web
 * Mercator engine, server-side reprojected dynamic export elsewhere.
 * @param wkid - display WKID from the session map record.
 */
export function basemapKindFor(wkid: number): 'cached-xyz' | 'dynamic-export' {
  return rasterBasemapEnabled(wkid) ? 'cached-xyz' : 'dynamic-export'
}

/** One camera snapshot compared by value, not object identity. */
export interface ViewCameraRecord {
  readonly center: readonly [number, number]
  readonly zoom: number
  readonly wkid: number
}

/**
 * Compare two camera records by lon/lat/zoom/wkid values.
 * @param left - previously applied camera.
 * @param right - next camera from the projection.
 */
export function viewCameraEquals(left: ViewCameraRecord, right: ViewCameraRecord): boolean {
  return left.wkid === right.wkid
    && left.zoom === right.zoom
    && left.center[0] === right.center[0]
    && left.center[1] === right.center[1]
}

/** A WGS84 lon/lat bounding box (`west`/`south`/`east`/`north` degrees). */
export interface BoundsInput {
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
}

/** Zoom range the tool contract and the layer framing keep to. */
const MIN_ZOOM = 0
const MAX_ZOOM = 20

/**
 * Convert a view scale back into the tool contract's Web-Mercator zoom; the
 * exact inverse of {@link scaleFromZoom} through the same anchor constant.
 * @param scale - ArcGIS view scale, strictly positive.
 * @returns the zoom level, or `NaN` when the scale cannot express one.
 */
export function zoomFromScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return Number.NaN
  return Math.log2(WEB_MERCATOR_ZOOM0_SCALE / scale)
}

/**
 * Estimate the zoom that frames a bounding box: `log2(360 / maxDimension)`,
 * clamped to the tool contract's `[0, 20]`. A degenerate box (no positive
 * span) frames nothing and reports the whole-world zoom.
 * @param bounds - the WGS84 bounding box to frame.
 * @returns the estimated zoom level.
 */
export function boundsToZoom(bounds: BoundsInput): number {
  const maxDimension = Math.max(bounds.east - bounds.west, bounds.north - bounds.south)
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) return MIN_ZOOM
  const zoom = Math.log2(360 / maxDimension)
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom))
}

/**
 * The minimal view shape {@link viewportSnapshotOf} reads: ArcGIS `MapView`
 * and `SceneView` both satisfy it structurally, so this module stays free of
 * ArcGIS imports.
 */
export interface ViewSnapshotInput {
  readonly center: { readonly x?: number; readonly y?: number } | undefined
  readonly extent: { readonly xmin?: number; readonly ymin?: number; readonly xmax?: number; readonly ymax?: number } | undefined
  /**
   * ArcGIS declares `wkid` as required-but-nullable (`number | null | undefined`);
   * under `exactOptionalPropertyTypes` only that form accepts a live view's
   * `SpatialReference`.
   */
  readonly spatialReference: { readonly wkid: number | null | undefined } | undefined
  /** View scale; `-1` (or absent) on views that only report a zoom. */
  readonly scale?: number
  /** View zoom; `-1` on projected views without raster LODs. */
  readonly zoom?: number
}

/** One viewport fix in plain numbers; field-for-field the gesture snapshot. */
export interface ViewSnapshot {
  readonly center: readonly [number, number]
  readonly zoom: number
  readonly extent: readonly [number, number, number, number]
  readonly wkid: number
  readonly mode: 'map' | 'scene'
}

/**
 * Read one viewport fix from a live view. The engine zoom wins when it is
 * non-negative; otherwise the scale is inverted through
 * {@link zoomFromScale}. Any unreadable field makes the whole fix
 * unavailable rather than half-reported.
 * @param view - the ArcGIS view, structurally narrowed.
 * @param mode - which engine the fix came from.
 * @returns the viewport snapshot, or `undefined` when a field is unreadable.
 */
export function viewportSnapshotOf(view: ViewSnapshotInput, mode: 'map' | 'scene'): ViewSnapshot | undefined {
  const { center, extent } = view
  const wkid = view.spatialReference?.wkid
  if (center?.x === undefined || center.y === undefined) return undefined
  if (extent?.xmin === undefined || extent.ymin === undefined) return undefined
  if (extent.xmax === undefined || extent.ymax === undefined) return undefined
  if (wkid === undefined || wkid === null) return undefined
  const rawZoom = view.zoom
  const rawScale = view.scale
  const zoom = typeof rawZoom === 'number' && rawZoom >= 0
    ? rawZoom
    : typeof rawScale === 'number' ? zoomFromScale(rawScale) : Number.NaN
  if (!Number.isFinite(zoom)) return undefined
  return {
    center: [center.x, center.y],
    zoom,
    extent: [extent.xmin, extent.ymin, extent.xmax, extent.ymax],
    wkid,
    mode,
  }
}
