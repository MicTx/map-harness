/**
 * CSV export serialization: RFC 4180 correct quote escaping with a UTF-8
 * BOM (never the lossy quote-stripping the source project shipped).
 * Geometry travels as `lon`/`lat` columns — the strong aliases the import
 * admission auto-selects — plus one flattened property column per key.
 * Point collections export one row per feature; MultiPoint collections
 * export one row per part; line and polygon geometries refuse honestly
 * instead of degrading to a sample coordinate.
 */
import type { GeoJsonFeatureCollection } from '@map-harness/map-container'
import { SpatialError } from '../spatial-errors.ts'

/** Fields needing RFC 4180 quote-wrapping: comma, quote, CR, or LF. */
const NEEDS_QUOTES = new RegExp('[",\r\n]')

/** RFC 4180 field escaping: quote-wrap when needed, double embedded quotes. */
function csvFieldOf(value: string): string {
  if (NEEDS_QUOTES.test(value)) return `"${value.replaceAll('"', '""')}"`
  return value
}

/** One CSV row as text (without the trailing newline). */
function rowOf(cells: readonly string[]): string {
  return cells.map(csvFieldOf).join(',')
}

/**
 * Serialize one WGS84 point collection as CSV text bytes.
 * @param collection - canonical WGS84 FeatureCollection.
 * @param options - serialization context (kept for symmetry with the other
 *   serializers; the CSV bytes carry no document name).
 * @returns UTF-8 bytes with a leading BOM.
 * @throws {SpatialError} `GEOMETRY_UNSUPPORTED` when a feature carries a
 *   line or polygon geometry.
 */
export function csvBytesOf(collection: GeoJsonFeatureCollection, _options: { readonly name: string }): Buffer {
  const features = collection.features as Array<{ geometry: { type: string; coordinates?: unknown } | null; properties?: Record<string, unknown> }>
  const propertyKeys: string[] = []
  for (const feature of features) {
    for (const key of Object.keys(feature.properties ?? {})) {
      if (!propertyKeys.includes(key)) propertyKeys.push(key)
    }
  }
  const rows: string[] = [rowOf(['lon', 'lat', ...propertyKeys])]
  for (const feature of features) {
    const geometry = feature.geometry
    if (geometry === null) continue
    const points: Array<[number, number]> = []
    if (geometry.type === 'Point') points.push(geometry.coordinates as [number, number])
    else if (geometry.type === 'MultiPoint') {
      for (const point of geometry.coordinates as Array<[number, number]>) points.push(point)
    } else {
      throw new SpatialError(
        'GEOMETRY_UNSUPPORTED',
        `CSV export carries point data only; feature geometry "${geometry.type}" refuses (export as geojson or kml instead)`,
      )
    }
    const properties = feature.properties ?? {}
    for (const [lon, lat] of points) {
      rows.push(rowOf([String(lon), String(lat), ...propertyKeys.map(key => {
        const value = properties[key]
        if (value === null || value === undefined) return ''
        if (typeof value === 'object') return JSON.stringify(value)
        return String(value)
      })]))
    }
  }
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(`${rows.join('\r\n')}\r\n`, 'utf8')])
}
