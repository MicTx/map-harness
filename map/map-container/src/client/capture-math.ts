/**
 * Pure capture georeference math for visual observation: fit the affine-2d
 * coefficients mapping output-image `(u, v)` to display-plane
 * `[a*u+b*v+c, d*u+e*v+f]` from actual `toMap` samples at the three fitting
 * corners, then verify with four INDEPENDENT control points (never reused
 * for fitting) whose worst inverse residual must stay within 1 CSS pixel.
 * Unsupported projections, non-finite or singular mappings, world-wrap, and
 * excessive residuals degrade to `georeference: { kind: 'none', reason }` —
 * a read-only image is still returned.
 * @module @map-harness/map-container/client/capture-math
 */
import { GEORFFERENCE_WKIDS, type ObservationGeoreference } from '../observation-protocol.ts'

/** One world sample: CSS view point and its `toMap` world coordinate. */
export interface ControlSample {
  readonly css: readonly [number, number]
  readonly world: readonly [number, number]
}

/** The affine coefficients `[a, b, c, d, e, f]` of `world = (a*u+b*v+c, d*u+e*v+f)`. */
export type AffineCoefficients = readonly [number, number, number, number, number, number]

/** Web Mercator half-world bound (EPSG:3857 meters). */
const MERCATOR_BOUND = 20037508.342789244

/** Fit the coefficients from the three corner samples and the output image size. */
export function fitAffineCoefficients(
  p0: ControlSample, p1: ControlSample, p2: ControlSample,
  imageWidth: number, imageHeight: number,
): AffineCoefficients {
  const [x0, y0] = p0.world
  const [x1, y1] = p1.world
  const [x2, y2] = p2.world
  return [
    (x1 - x0) / imageWidth,
    (x2 - x0) / imageHeight,
    x0,
    (y1 - y0) / imageWidth,
    (y2 - y0) / imageHeight,
    y0,
  ]
}

/** Evaluate the affine at one image pixel `(u, v)`. */
export function affineForward(coefficients: AffineCoefficients, u: number, v: number): readonly [number, number] {
  const [a, b, c, d, e, f] = coefficients
  return [a * u + b * v + c, d * u + e * v + f]
}

/**
 * The largest inverse residual in CSS pixels across independent control
 * points: world error `(dx, dy)` maps through the inverse affine, then the
 * image→CSS scale, and the Euclidean norm is compared pointwise.
 * @returns the max residual in CSS px, or `NaN` on a singular mapping.
 */
export function maxCssResidual(
  coefficients: AffineCoefficients,
  controls: readonly ControlSample[],
  cssWidth: number, cssHeight: number,
  imageWidth: number, imageHeight: number,
): number {
  const [a, b, , d, e] = [coefficients[0], coefficients[1], 0, coefficients[3], coefficients[4]]
  const det = a * e - b * d
  if (det === 0 || !Number.isFinite(det)) return Number.NaN
  let worst = 0
  for (const control of controls) {
    const [px, py] = affineForward(coefficients, control.css[0] * (imageWidth / cssWidth), control.css[1] * (imageHeight / cssHeight))
    const dx = px - control.world[0]
    const dy = py - control.world[1]
    const rx = (e * dx - b * dy) / det
    const ry = (-d * dx + a * dy) / det
    const cssRx = rx * (cssWidth / imageWidth)
    const cssRy = ry * (cssHeight / imageHeight)
    const residual = Math.hypot(cssRx, cssRy)
    if (!Number.isFinite(residual)) return Number.NaN
    worst = Math.max(worst, residual)
  }
  return worst
}

/** Whether the world samples stay inside the V1 world bounds for one display WKID. */
function worldBoundsOk(wkid: number, samples: readonly ControlSample[]): boolean {
  const xs = samples.map(s => s.world[0])
  const ys = samples.map(s => s.world[1])
  const spanX = Math.max(...xs) - Math.min(...xs)
  if (wkid === 4326) {
    return xs.every(x => x >= -180 && x <= 180) && ys.every(y => y >= -90 && y <= 90) && spanX <= 180
  }
  return xs.every(x => Math.abs(x) <= MERCATOR_BOUND) && ys.every(y => Math.abs(y) <= MERCATOR_BOUND) && spanX <= MERCATOR_BOUND
}

/**
 * Derive the georeference contract for one capture.
 * @param mode - engine mode; only `'map'` (2D) may carry affine-2d.
 * @param wkid - actual display WKID.
 * @param p0/p1/p2 - fitting samples at CSS `(0,0)`, `(W,0)`, `(0,H)`.
 * @param controls - four INDEPENDENT validation samples.
 * @param cssWidth/cssHeight - full-view CSS size.
 * @param imageWidth/imageHeight - output image size in pixels.
 * @returns the affine-2d contract, or `{ kind: 'none', reason }`.
 */
export function deriveGeoreference(
  mode: 'map' | 'scene',
  wkid: number,
  p0: ControlSample, p1: ControlSample, p2: ControlSample,
  controls: readonly ControlSample[],
  cssWidth: number, cssHeight: number,
  imageWidth: number, imageHeight: number,
): ObservationGeoreference {
  if (mode !== 'map') return { kind: 'none', reason: 'not-2d' }
  if (!(GEORFFERENCE_WKIDS as readonly number[]).includes(wkid)) return { kind: 'none', reason: 'unsupported-projection' }
  const samples = [p0, p1, p2, ...controls]
  if (!samples.every(s => Number.isFinite(s.world[0]) && Number.isFinite(s.world[1]))) {
    return { kind: 'none', reason: 'non-finite-samples' }
  }
  if (!worldBoundsOk(wkid, samples)) return { kind: 'none', reason: 'world-wrap' }
  const coefficients = fitAffineCoefficients(p0, p1, p2, imageWidth, imageHeight)
  if (!coefficients.every(Number.isFinite)) return { kind: 'none', reason: 'non-finite-samples' }
  const det = coefficients[0] * coefficients[4] - coefficients[1] * coefficients[3]
  if (det === 0 || !Number.isFinite(det)) return { kind: 'none', reason: 'singular-mapping' }
  const residual = maxCssResidual(coefficients, controls, cssWidth, cssHeight, imageWidth, imageHeight)
  if (!Number.isFinite(residual)) return { kind: 'none', reason: 'singular-mapping' }
  if (residual > 1) return { kind: 'none', reason: 'excessive-residual' }
  return { kind: 'affine-2d', coefficients, wkid, maxResidualCssPx: residual }
}
