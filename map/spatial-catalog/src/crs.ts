/**
 * CRS vocabulary shared by the catalog record and the file readers: the
 * well-known geographic family that needs no reprojection, the coordinate
 * convention labels, and the transform identity a convergence to WGS84
 * display coordinates reports in retrieval bundles.
 *
 * @module @map-harness/spatial-catalog/crs
 */
import { sha256Hex } from './refs.ts'

/** Well-known geographic CRSes that need no reprojection. */
const WGS84_FAMILY = new Set(['EPSG:4326', 'EPSG:4490', 'CRS84', 'OGC:CRS84'])

/** Display WKIDs with a tested ArcGIS/World-Imagery path in this harness. */
export const SUPPORTED_DISPLAY_WKIDS: ReadonlySet<number> = new Set([
  4326,
  3857,
  102100,
  102113,
  4490,
  ...Array.from({ length: 21 }, (_, index) => 4534 + index),
])

/** Whether one integer WKID is accepted by the map view protocol. */
export function isSupportedDisplayWkid(wkid: number): boolean {
  return Number.isInteger(wkid) && SUPPORTED_DISPLAY_WKIDS.has(wkid)
}

/** Coordinate conventions a resource version can declare. */
export type CoordinateConvention = 'wgs84-geographic' | 'projected-grid'

/**
 * Whether one declared CRS label belongs to the WGS84 geographic family.
 * @param crs - declared source CRS label.
 */
export function isWgs84FamilyCrs(crs: string): boolean {
  return WGS84_FAMILY.has(crs.trim().toUpperCase())
}

/**
 * The coordinate convention one declared CRS implies.
 * @param crs - declared source CRS label.
 */
export function coordinateConventionOf(crs: string): CoordinateConvention {
  return isWgs84FamilyCrs(crs) ? 'wgs84-geographic' : 'projected-grid'
}

/**
 * The transform identity recorded for converging one resource to WGS84
 * display coordinates: identity for the geographic family, otherwise the
 * proj4 class with the declared label's short digest — the bundle freezes the
 * transform identity, while the actual definition text stays derivable from
 * the recorded native CRS.
 * @param nativeCrs - the resource version's declared native CRS.
 */
export function transformVersionOf(nativeCrs: string): string {
  return isWgs84FamilyCrs(nativeCrs) ? 'identity' : `proj4:${sha256Hex(nativeCrs.trim()).slice(0, 12)}`
}
