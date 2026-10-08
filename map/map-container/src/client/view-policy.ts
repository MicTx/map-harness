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
