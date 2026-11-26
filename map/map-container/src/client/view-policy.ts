/**
 * Key-free ArcGIS view policy shared by the occurrence and pure tests.
 * @module @map-harness/map-container/client/view-policy
 */
import { FIXED_BASEMAP_ATTRIBUTION } from '../observation-protocol.ts'
import { PUBLIC_SOURCE_PRESETS } from '../source-render-protocol.ts'
import { viewEngineKey, zoomFromScale } from '../view-policy.ts'

export { WEB_MERCATOR_ZOOM0_SCALE, explicitSpatialReferenceWkid, viewEngineKey, scaleFromZoom, zoomFromScale } from '../view-policy.ts'

/** Fields needed to construct the package's key-free ArcGIS Online imagery layer. */
export interface KeyFreeBasemapPolicy {
  readonly title: string
  readonly urlTemplate: string
  readonly copyright: string
}

/** Public World Imagery XYZ tiles; no API token is required. */
export const KEY_FREE_BASEMAP: KeyFreeBasemapPolicy = Object.freeze({
  title: 'World Imagery',
  urlTemplate: `${PUBLIC_SOURCE_PRESETS['esri-world-imagery'].url}/tile/{level}/{row}/{col}`,
  copyright: FIXED_BASEMAP_ATTRIBUTION,
})

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
  readonly scale?: number
  readonly rotation?: number
}

/**
 * Compare two camera records by lon/lat/zoom/wkid values.
 * @param left - previously applied camera.
 * @param right - next camera from the projection.
 */
export function viewCameraEquals(left: ViewCameraRecord, right: ViewCameraRecord): boolean {
  return left.wkid === right.wkid
    && left.scale === right.scale
    && (left.rotation ?? 0) === (right.rotation ?? 0)
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
  readonly center: { readonly x?: number; readonly y?: number; readonly longitude?: number | null | undefined; readonly latitude?: number | null | undefined } | undefined
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
  /** View rotation in degrees, when the engine reports one. */
  readonly rotation?: number
}

/** One viewport fix in plain numbers; field-for-field the gesture snapshot. */
export interface ViewSnapshot {
  readonly center: readonly [number, number]
  readonly zoom: number
  readonly extent: readonly [number, number, number, number]
  readonly wkid: number
  readonly mode: 'map' | 'scene'
  /** Live view scale when readable; lets a settled user camera restore exactly. */
  readonly scale?: number
  /** Live view rotation in degrees when readable. */
  readonly rotation?: number
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
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y) || wkid <= 0) return undefined
  const bounds = [extent.xmin, extent.ymin, extent.xmax, extent.ymax]
  if (bounds.some(value => !Number.isFinite(value)) || extent.xmin >= extent.xmax || extent.ymin >= extent.ymax) return undefined
  const scale = typeof rawScale === 'number' && Number.isFinite(rawScale) && rawScale > 0 ? rawScale : undefined
  const rotation = typeof view.rotation === 'number' && Number.isFinite(view.rotation) ? view.rotation : undefined
  return {
    center: [center.x, center.y],
    zoom,
    extent: [extent.xmin, extent.ymin, extent.xmax, extent.ymax],
    wkid,
    mode,
    ...(scale === undefined ? {} : { scale }),
    ...(rotation === undefined ? {} : { rotation }),
  }
}
