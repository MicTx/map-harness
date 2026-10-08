/**
 * Compute a WGS84 lon/lat envelope from GeoJSON so a conversation
 * `viewRequest` can `goTo` the focused layer. Degenerate envelopes
 * (a single point, or a line of zero width) are padded so ArcGIS
 * still has an extent to frame.
 */
export interface LonLatBbox {
  readonly west: number
  readonly south: number
  readonly east: number
  readonly north: number
}

/** Half-size in degrees applied when either axis collapses. */
export const DEGENERATE_BBOX_PAD_DEG = 0.01

/**
 * Envelope of one GeoJSON value, or `null` when it has no finite coordinates.
 * @param data - a FeatureCollection, Feature, geometry, or unknown payload.
 * @returns padded lon/lat bbox, or `null`.
 */
export function geoJsonBbox(data: unknown): LonLatBbox | null {
  const acc = { west: Infinity, south: Infinity, east: -Infinity, north: -Infinity }
  visit(data, acc)
  if (!Number.isFinite(acc.west) || !Number.isFinite(acc.south)
    || !Number.isFinite(acc.east) || !Number.isFinite(acc.north)) return null
  let { west, south, east, north } = acc
  if (east - west < Number.EPSILON) {
    west -= DEGENERATE_BBOX_PAD_DEG
    east += DEGENERATE_BBOX_PAD_DEG
  }
  if (north - south < Number.EPSILON) {
    south -= DEGENERATE_BBOX_PAD_DEG
    north += DEGENERATE_BBOX_PAD_DEG
  }
  return { west, south, east, north }
}

function visit(value: unknown, acc: { west: number; south: number; east: number; north: number }): void {
  if (value === null || value === undefined || typeof value !== 'object') return
  if (Array.isArray(value)) {
    if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number'
      && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      const lon = value[0]
      const lat = value[1]
      if (lon < acc.west) acc.west = lon
      if (lon > acc.east) acc.east = lon
      if (lat < acc.south) acc.south = lat
      if (lat > acc.north) acc.north = lat
      return
    }
    for (const item of value) visit(item, acc)
    return
  }
  const record = value as Record<string, unknown>
  if ('features' in record) visit(record.features, acc)
  if ('geometry' in record) visit(record.geometry, acc)
  if ('coordinates' in record) visit(record.coordinates, acc)
}
