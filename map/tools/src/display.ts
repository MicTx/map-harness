/**
 * Display-copy assembly for catalog-backed layers: the map adapter reads an
 * authorized resource or artifact version's immutable bytes, converges them
 * to WGS84 with the version's own recorded CRS (never a per-call guess),
 * digests the bounded display copy, and refuses geometry types the browser
 * occurrence cannot render. The display copy is a derived view — the catalog
 * bytes stay the computational authority.
 */
import { SpatialError } from './spatial-errors.ts'
import { DISPLAY_GEOMETRY_TYPES, type GeoJsonFeatureCollection, type MapLayerLegend } from '@map-harness/map-container'
import { sha256BytesHex } from '@map-harness/spatial-catalog'
import { loadGeoJsonString } from './geo-source.ts'

/** Minimal single-symbol style a versioned layer carries (deterministic palette, protocol constants). */
export const DEFAULT_SYMBOL: Readonly<{ color: string; outline: string }> = {
  color: '#1f77b4',
  outline: '#14405e',
}

/**
 * Digest one WGS84 display copy — the rendered-identity token the browser
 * caches per layer, so a same-id, same-featureCount update still redraws.
 * @param data - the WGS84 display collection.
 * @returns the display digest (sha256 hex of the canonical JSON).
 */
export function displayDigestOf(data: GeoJsonFeatureCollection): string {
  return sha256BytesHex(Buffer.from(JSON.stringify(data), 'utf8'))
}

/**
 * Check every feature's geometry against the display-supported types.
 * @param data - the WGS84 display collection.
 * @throws {SpatialError} `GEOMETRY_UNSUPPORTED` when a geometry type would
 *   otherwise render as an invisible empty layer.
 */
export function assertDisplaySupported(data: GeoJsonFeatureCollection): void {
  for (const feature of data.features) {
    const type = feature.geometry?.type
    if (type !== undefined && !(DISPLAY_GEOMETRY_TYPES as readonly string[]).includes(type)) {
      throw new SpatialError('GEOMETRY_UNSUPPORTED', `"${type}" geometries are not display-supported; register Point/LineString/Polygon data for the map`)
    }
  }
}

/**
 * Build the bounded WGS84 display copy from one catalog version's immutable
 * bytes, converging with the version's recorded native CRS.
 * @param bytes - the exact stored bytes of the resource or artifact version.
 * @param nativeCrs - the CRS the stored coordinates are in.
 * @returns the display copy and its digest.
 * @throws {SpatialError} with a stable code for malformed bytes, unknown CRS,
 *   unsupported geometry, or range violations.
 */
export function buildDisplayCopy(bytes: Uint8Array, nativeCrs: string): { data: GeoJsonFeatureCollection; displayDigest: string } {
  const parsed = loadGeoJsonString(bytes, nativeCrs)
  assertDisplaySupported(parsed)
  return { data: parsed, displayDigest: displayDigestOf(parsed) }
}

/** Minimal legend one versioned layer carries. */
export function legendOf(title: string): MapLayerLegend {
  return { title, symbol: { ...DEFAULT_SYMBOL } }
}
