/**
 * Shared tool output shapes and render helpers: every map tool returns one
 * JSON value matching its declared schema and renders it as plain text the
 * model reads directly.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** One layer summary mirrored into tool results. */
export type LayerSummary = {
  readonly id: string
  readonly name: string
  readonly featureCount: number
  readonly sourceCrs: string
  readonly visible: boolean
}

/** Axis-aligned bounding box in WGS84: `[minLon, minLat, maxLon, maxLat]`. */
export type Bbox = [number, number, number, number]

/**
 * Compute the bbox over every numeric coordinate tuple in the collection.
 * @param data - a WGS84 GeoJSON FeatureCollection.
 * @returns `[minLon, minLat, maxLon, maxLat]`, or `undefined` for no coordinates.
 */
export function bboxOf(data: { features: Array<{ geometry: { coordinates?: unknown } | null }> }): Bbox | undefined {
  let minLon = Number.POSITIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLon = Number.NEGATIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  const walk = (coords: unknown): void => {
    if (!Array.isArray(coords)) return
    const lon = coords[0]
    const lat = coords[1]
    if (coords.length >= 2 && typeof lon === 'number' && typeof lat === 'number') {
      if (lon < minLon) minLon = lon
      if (lat < minLat) minLat = lat
      if (lon > maxLon) maxLon = lon
      if (lat > maxLat) maxLat = lat
      return
    }
    coords.forEach(walk)
  }
  for (const feature of data.features) walk(feature.geometry?.coordinates)
  if (minLon === Number.POSITIVE_INFINITY) return undefined
  return [minLon, minLat, maxLon, maxLat]
}

/** Round coordinates to six decimals for stable, readable tool output. */
export function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/**
 * Render a JSON value as one text content block.
 * @param value - the tool's canonical output.
 * @returns the model-facing content.
 */
export function renderJson(value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}
