/** Shared community GCJ-02 approximation for vendor adapters; not an official lossless inverse. */
import type { LonLat } from './contract.ts'

/** Krassovsky ellipsoid constants of the community GCJ-02 approximation. */
const GCJ_A = 6378245
const GCJ_EE = 0.00669342162296594323

/** Whether a point lies inside the region China's offset datum applies to. */
function insideChina(lon: number, lat: number): boolean {
  return lon >= 72.004 && lon <= 137.8347 && lat >= 0.8293 && lat <= 55.8271
}

/** The latitude-side offset polynomial of the GCJ-02 approximation (input in local degree offsets). */
function transformLatOffset(x: number, y: number): number {
  let offset = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  offset += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  offset += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3
  offset += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3
  return offset
}

/** The longitude-side offset polynomial of the GCJ-02 approximation (input in local degree offsets). */
function transformLonOffset(x: number, y: number): number {
  let offset = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  offset += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  offset += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3
  offset += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3
  return offset
}

/** The GCJ-02 offset of one point, in degrees. */
function gcjOffset(lon: number, lat: number): [number, number] {
  const x = lon - 105
  const y = lat - 35
  const radLat = lat / 180 * Math.PI
  const magic = 1 - GCJ_EE * Math.sin(radLat) * Math.sin(radLat)
  const sqrtMagic = Math.sqrt(magic)
  const dLat = (transformLatOffset(x, y) * 180) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI)
  const dLon = (transformLonOffset(x, y) * 180) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI)
  return [dLon, dLat]
}

/**
 * Approximate WGS84 to GCJ-02; points outside the offset region pass through.
 * @param point - WGS84 longitude and latitude.
 * @returns GCJ-02 longitude and latitude.
 */
export function wgs84ToGcj02(point: LonLat): [number, number] {
  const [lon, lat] = point
  if (!insideChina(lon, lat) || !Number.isFinite(lon) || !Number.isFinite(lat)) return [lon, lat]
  const [dLon, dLat] = gcjOffset(lon, lat)
  return [lon + dLon, lat + dLat]
}

/**
 * Approximate GCJ-02 to WGS84 with residual metre-level error, not a survey-grade inverse.
 * @param lon - GCJ-02 longitude.
 * @param lat - GCJ-02 latitude.
 * @returns Approximate WGS84 longitude and latitude; outside-region points pass through.
 */
export function gcj02ToWgs84(lon: number, lat: number): [number, number] {
  if (!insideChina(lon, lat)) return [lon, lat]
  const [dLon, dLat] = gcjOffset(lon, lat)
  return [lon - dLon, lat - dLat]
}
