/**
 * Pixel-to-WGS84 conversion for model visual proposals. All geometry uses
 * output-image pixel coordinates from one accepted observation; the four
 * corners of a bbox are projected individually through the frozen affine
 * plane. Refusals name the reason instead of approximating a transform.
 * @module @map-harness/map-container/visual-proposal-math
 */
import {
  affineOfObservation,
  displayPointOf,
  imagePointInMapContent,
  wgs84OfDisplayPoint,
  type MapUseMathRefusal,
} from './map-use.ts'
import { validateAnnotationGeometry, type AnnotationGeometry } from './protocol.ts'
import type { MapObservationRecord } from './observation-protocol.ts'
import type { VisualProposalPixelGeometry, VisualProposalPixelPoint } from './visual-proposal-protocol.ts'

/** Why one candidate cannot be georeferenced. */
export type VisualProposalMathRefusal = MapUseMathRefusal | 'geometry-invalid'

/** One point in output-image pixels. */
type Pixel = VisualProposalPixelPoint
/** One point in WGS84 longitude/latitude. */
type World = readonly [number, number]

/** Convert one output-image pixel to WGS84 through the observation's frozen affine plane. */
function worldOfPixel(observation: MapObservationRecord, affine: readonly [number, number, number, number, number, number], point: Pixel): World | VisualProposalMathRefusal {
  const [u, v] = point
  if (!Number.isFinite(u) || !Number.isFinite(v)) return 'invalid-argument'
  if (!imagePointInMapContent(observation, u, v)) return 'outside-map'
  const display = displayPointOf(affine, u, v)
  if (observation.camera === null) return 'unsupported-georeference'
  return wgs84OfDisplayPoint(display, observation.camera.wkid)
}

/** Convert one list of pixels, preserving order and rejecting adjacent duplicate points. */
function worldLine(observation: MapObservationRecord, affine: readonly [number, number, number, number, number, number], points: readonly Pixel[]): readonly World[] | VisualProposalMathRefusal {
  if (points.length < 2 || points.length > 1024) return 'invalid-argument'
  const result: World[] = []
  for (const [index, point] of points.entries()) {
    const world = worldOfPixel(observation, affine, point)
    if (typeof world === 'string') return world
    if (index > 0 && world[0] === result[index - 1]![0] && world[1] === result[index - 1]![1]) return 'geometry-invalid'
    result.push(world)
  }
  return result
}

/** Whether the polygon ring is closed, finite, and free of non-adjacent intersections. */
function validRing(points: readonly Pixel[]): boolean {
  if (points.length < 4 || points.length > 1024) return false
  const first = points[0]!
  const last = points[points.length - 1]!
  if (!points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return false
  if (first[0] !== last[0] || first[1] !== last[1]) return false
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1]!
    const right = points[index]!
    if (left[0] === right[0] && left[1] === right[1]) return false
  }
  const orientation = (a: Pixel, b: Pixel, c: Pixel): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
  const onSegment = (a: Pixel, b: Pixel, point: Pixel): boolean => point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0])
    && point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1])
  const segments = points.slice(0, -1).map((start, index) => [start, points[index + 1]!] as const)
  for (let left = 0; left < segments.length; left += 1) {
    for (let right = left + 2; right < segments.length; right += 1) {
      if (left === 0 && right === segments.length - 1) continue
      const [a, b] = segments[left]!
      const [c, d] = segments[right]!
      const o1 = orientation(a, b, c)
      const o2 = orientation(a, b, d)
      const o3 = orientation(c, d, a)
      const o4 = orientation(c, d, b)
      if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)
        || (o1 === 0 && onSegment(a, b, c)) || (o2 === 0 && onSegment(a, b, d))
        || (o3 === 0 && onSegment(c, d, a)) || (o4 === 0 && onSegment(c, d, b))) return false
    }
  }
  return true
}

/**
 * Project one bounded candidate pixel geometry into a WGS84 annotation geometry.
 * @param observation - the current accepted observation record.
 * @param geometry - validated model pixel geometry.
 * @returns the projected geometry, or a named refusal.
 */
export function visualProposalGeometryOf(
  observation: MapObservationRecord,
  geometry: VisualProposalPixelGeometry,
): AnnotationGeometry | VisualProposalMathRefusal {
  const usable = affineOfObservation(observation)
  if (typeof usable === 'string') return usable
  const { affine } = usable
  if (geometry.type === 'point') {
    const world = worldOfPixel(observation, affine, geometry.point)
    return typeof world === 'string' ? world : { type: 'Point', coordinates: [world[0], world[1]] }
  }
  if (geometry.type === 'polyline') {
    const world = worldLine(observation, affine, geometry.points)
    return typeof world === 'string' ? world : { type: 'LineString', coordinates: world.map(point => [point[0], point[1]] as const) }
  }
  const pixels = geometry.type === 'polygon' ? geometry.points : geometry.corners
  if (geometry.type === 'polygon' && !validRing(pixels)) return 'geometry-invalid'
  const ring = geometry.type === 'bbox'
    ? [geometry.corners[0], geometry.corners[1], geometry.corners[2], geometry.corners[3], geometry.corners[0]]
    : pixels
  if (geometry.type === 'bbox' && !validRing(ring)) return 'geometry-invalid'
  const projected: [number, number][] = []
  for (const [index, pixel] of ring.entries()) {
    const world = worldOfPixel(observation, affine, pixel)
    if (typeof world === 'string') return world
    if (index > 0 && world[0] === projected[index - 1]![0] && world[1] === projected[index - 1]![1]) return 'geometry-invalid'
    projected.push([world[0], world[1]])
  }
  const result: AnnotationGeometry = { type: 'Polygon', coordinates: [projected] }
  try {
    validateAnnotationGeometry(result)
  } catch {
    return 'geometry-invalid'
  }
  return result
}
