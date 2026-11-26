/**
 * Screen-space anchor derivation for one hovered feature card.
 *
 * The occurrence projects a feature's WGS84 envelope through the live view,
 * while the card placement stage stays independent of ArcGIS and React.
 * A point uses its exact coordinate; a line or polygon uses its geometry
 * envelope, so the card can sit around the feature rather than the pointer.
 *
 * @module @map-harness/map-container/client/feature-card-anchor
 */
import type { LonLatBbox } from './bbox.ts'
import type { FeatureInspection } from './popup.ts'

/** One screen-space rectangle in map-overlay pixels. */
export interface FeatureScreenRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** One projected screen point in map-overlay pixels. */
export interface FeatureScreenPoint {
  readonly x: number
  readonly y: number
}

/** Projects one WGS84 coordinate into map-overlay pixels. */
export type FeatureScreenProjector = (longitude: number, latitude: number) => FeatureScreenPoint | null

/** One feature inspection plus the screen anchor its card follows. */
export interface FeatureInspectionFrame extends FeatureInspection {
  readonly anchor: FeatureScreenRect
}

/**
 * Derive the screen rectangle around one WGS84 feature envelope.
 * @param bbox - the feature's WGS84 envelope, or `null` when unavailable.
 * @param project - projects WGS84 coordinates into overlay pixels.
 * @param fallback - an already-projected hit point used only when the envelope cannot project.
 * @returns the finite screen rectangle, or `null` when neither source projects.
 */
export function featureScreenRectOf(
  bbox: LonLatBbox | null,
  project: FeatureScreenProjector,
  fallback: FeatureScreenPoint | null = null,
): FeatureScreenRect | null {
  const points: FeatureScreenPoint[] = []
  if (bbox !== null) {
    for (const [longitude, latitude] of [
      [bbox.west, bbox.south],
      [bbox.west, bbox.north],
      [bbox.east, bbox.south],
      [bbox.east, bbox.north],
    ] as const) {
      const point = project(longitude, latitude)
      if (point !== null && Number.isFinite(point.x) && Number.isFinite(point.y)) points.push(point)
    }
  }
  if (points.length === 0 && fallback !== null && Number.isFinite(fallback.x) && Number.isFinite(fallback.y)) points.push(fallback)
  if (points.length === 0) return null
  return {
    left: Math.min(...points.map(point => point.x)),
    top: Math.min(...points.map(point => point.y)),
    right: Math.max(...points.map(point => point.x)),
    bottom: Math.max(...points.map(point => point.y)),
  }
}

/**
 * Compare two screen rectangles by their exact pixel edges.
 * @param left - the first rectangle.
 * @param right - the second rectangle.
 * @returns whether both rectangles have identical finite edges.
 */
export function featureScreenRectEqual(left: FeatureScreenRect | null, right: FeatureScreenRect | null): boolean {
  return left === right || (left !== null && right !== null
    && left.left === right.left && left.top === right.top && left.right === right.right && left.bottom === right.bottom)
}
