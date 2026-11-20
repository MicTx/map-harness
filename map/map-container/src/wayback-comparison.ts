/**
 * Durable comparison candidates tied to the point that produced them.
 * @module @map-harness/map-container/wayback-comparison
 */
import { parseBasemapSource, type BasemapSource } from '@map-harness/map-layers'

/** Two distinct historical releases with their local query identity. */
export interface WaybackComparison {
  readonly early: BasemapSource
  readonly recent: BasemapSource
  readonly point: { readonly lon: number; readonly lat: number }
  readonly zoom: number
}

/**
 * Validate a persisted comparison without performing network I/O.
 * @param value - user or durable JSON value.
 * @returns whether both fixed releases and query coordinates are valid.
 */
export function isWaybackComparison(value: unknown): value is WaybackComparison {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 4 || !['early', 'recent', 'point', 'zoom'].every(key => Object.hasOwn(record, key))) return false
  const early = parseBasemapSource(record.early)
  const recent = parseBasemapSource(record.recent)
  if (!early.ok || !recent.ok || early.value.id !== 'esri-wayback' || recent.value.id !== 'esri-wayback'
    || early.value.release.version === null || recent.value.release.version === null
    || !/^[1-9]\d*$/.test(early.value.release.version) || !/^[1-9]\d*$/.test(recent.value.release.version)
    || early.value.release.version === recent.value.release.version
    || early.value.release.publishedAt === null || recent.value.release.publishedAt === null
    || early.value.release.publishedAt > recent.value.release.publishedAt
    || early.value.release.acquiredAt !== null || recent.value.release.acquiredAt !== null) return false
  if (typeof record.point !== 'object' || record.point === null || Array.isArray(record.point)) return false
  const point = record.point as Record<string, unknown>
  return Object.keys(point).length === 2 && typeof point.lon === 'number' && Number.isFinite(point.lon)
    && point.lon >= -180 && point.lon <= 180 && typeof point.lat === 'number' && Number.isFinite(point.lat)
    && point.lat >= -85.0511287798066 && point.lat <= 85.0511287798066
    && typeof record.zoom === 'number' && Number.isFinite(record.zoom) && record.zoom >= 10 && record.zoom <= 23
}
