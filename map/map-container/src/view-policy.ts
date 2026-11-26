/**
 * Application spatial-reference and scale conventions shared by host and client.
 * Native source LOD indices never define application zoom.
 * @module @map-harness/map-container/view-policy
 */

/**
 * Select the spatial reference explicitly passed to ArcGIS.
 * @param wkid - logical display WKID from the accepted map record.
 * @returns projected WKID, or undefined when the default Web Mercator engine applies.
 */
export function explicitSpatialReferenceWkid(wkid: number): number | undefined {
  return wkid === 4326 ? undefined : wkid
}

/**
 * Resolve the physical ArcGIS engine for a logical display record.
 * @param wkid - accepted logical display WKID.
 * @returns actual engine WKID; geographic records share Web Mercator.
 */
export function viewEngineKey(wkid: number): number {
  return explicitSpatialReferenceWkid(wkid) ?? 3857
}

/** Zoom-0 scale of the Web-Mercator convention used by map tools and state. */
export const WEB_MERCATOR_ZOOM0_SCALE = 591657527.591555

/**
 * Convert application zoom to ArcGIS view scale without a source LOD lookup.
 * @param zoom - validated application zoom.
 * @returns view scale under the fixed application convention.
 */
export function scaleFromZoom(zoom: number): number {
  return WEB_MERCATOR_ZOOM0_SCALE / 2 ** zoom
}

/**
 * Convert ArcGIS scale to application zoom, independent of native matrix indices.
 * @param scale - view scale.
 * @returns application zoom, or NaN for a nonpositive/nonfinite scale.
 */
export function zoomFromScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return Number.NaN
  return Math.log2(WEB_MERCATOR_ZOOM0_SCALE / scale)
}
