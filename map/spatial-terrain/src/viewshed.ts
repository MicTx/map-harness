/**
 * Area viewshed over a built terrain surface: a deterministic target lattice
 * around the observer, one run of the exact line-of-sight core per target
 * (ground targets at height zero), and honest per-target statuses with
 * tallies. The LOS core is reused, never reimplemented — sampling limits,
 * curvature/refraction correction, the indeterminate band, and the refusal
 * family are the single sightline's semantics applied across the area
 * (design §12: the sampling and error budget the answer holds for stay
 * declared, not implied).
 *
 * @module @map-harness/spatial-terrain/viewshed
 */
import { computeLineOfSight, type CurvatureRecord, type LosRefusal } from './los.ts'
import type { LosEndpoint, TerrainSpec } from './contract.ts'
import { fromPlane, planeAt, toPlane, type TerrainObstacles, type TerrainSurface } from './surface.ts'
import { TERRAIN_METHOD_VERSION } from './contract.ts'

/** The observer-to-target radius cap, meters; viewsheds answer locally. */
export const MAX_VIEWSHED_RADIUS_M = 20_000

/** The target-count cap; the lattice derives its step from this bound. */
export const MAX_VIEWSHED_TARGETS = 512

/** The per-target refusal codes that mean "the target is not answerable here". */
export type ViewshedOutsideCode = 'endpoint-outside-surface' | 'path-outside-surface'

/** One target lattice point's verdict. */
export interface ViewshedTarget {
  readonly lon: number
  readonly lat: number
  /** Straight-line distance from the observer, meters. */
  readonly distanceM: number
  readonly status: 'visible' | 'blocked' | 'indeterminate' | 'outside'
  /** The LOS refusal code for `outside` targets. */
  readonly outsideCode?: ViewshedOutsideCode
  /** The tightest effective clearance along the sightline, meters. */
  readonly minClearanceM: number
}

/** The honest tallies over the lattice. */
export interface ViewshedTallies {
  readonly visible: number
  readonly blocked: number
  readonly indeterminate: number
  readonly outside: number
  readonly refused: number
}

/** The computed area viewshed. */
export interface ViewshedResult {
  readonly methodVersion: typeof TERRAIN_METHOD_VERSION
  /** Canonical digest of the resolved spec every target ran under. */
  readonly specDigest: string
  readonly observer: { readonly lon: number; readonly lat: number }
  readonly radiusM: number
  /** Lattice step in meters (derived from radius and the target cap). */
  readonly latticeStepM: number
  readonly targets: readonly ViewshedTarget[]
  readonly tallies: ViewshedTallies
  readonly curvature: CurvatureRecord
  readonly sampling: { readonly intervalMeters: number; readonly sampleCountPerTarget: number }
  readonly limitations: readonly string[]
}

/** The named parameter refusals before any target runs. */
export type ViewshedParamCode = 'radius-too-large' | 'invalid-radius' | 'observer-outside-surface'

/** A refused viewshed: nothing was computed. */
export interface ViewshedRefusal {
  readonly status: 'refused'
  readonly code: ViewshedParamCode | LosRefusal['code']
  readonly message: string
}

export type ViewshedOutcome = { readonly status: 'computed'; readonly result: ViewshedResult } | ViewshedRefusal

/** The fixed limitations every viewshed declares (the LOS core's own limits apply per target). */
export const VIEWSHED_LIMITATIONS: readonly string[] = [
  'Each target runs the single sightline core at the declared interval: obstacles narrower than one interval can hide between samples.',
  'A sightline inside the clearance uncertainty reports indeterminate for that target, never visible.',
  'The lattice is a bounded sample of the area, not a surveyed boundary of visibility.',
] as const

/**
 * Compute the area viewshed: one exact LOS run per lattice target. The
 * lattice is a square grid at `radius / ceil(sqrt(maxTargets))` spacing,
 * row-major over the circle, observer excluded. Ground targets sit at
 * height zero; refusals that mean "not answerable here" (outside the
 * surface or the tangent plane) tally as `outside`, anything else as
 * `refused` — nothing is dropped silently.
 * @param spec - the resolved, validated TerrainSpec.
 * @param surface - the built surface grid.
 * @param obstacles - the built obstacle model.
 * @param observer - the observer endpoint (height above ground, or absolute override).
 * @param radiusM - the area radius in meters, up to {@link MAX_VIEWSHED_RADIUS_M}.
 * @param maxTargets - the lattice bound, up to {@link MAX_VIEWSHED_TARGETS}.
 * @returns the computed result, or the refusal that stopped it.
 * @throws nothing — every condition is a returned refusal or a tallied target.
 */
export function computeViewshed(
  spec: TerrainSpec,
  surface: TerrainSurface,
  obstacles: TerrainObstacles,
  observer: LosEndpoint,
  radiusM: number,
  maxTargets: number,
): ViewshedOutcome {
  if (!Number.isFinite(radiusM) || radiusM <= 0) {
    return { status: 'refused', code: 'invalid-radius', message: `radius_m must be a positive finite number of meters, got ${String(radiusM)}` }
  }
  if (radiusM > MAX_VIEWSHED_RADIUS_M) {
    return { status: 'refused', code: 'radius-too-large', message: `radius ${Math.round(radiusM)} m exceeds the ${String(MAX_VIEWSHED_RADIUS_M)} m viewshed bound; run a smaller area or single sightlines` }
  }
  if (!Number.isInteger(maxTargets) || maxTargets < 1 || maxTargets > MAX_VIEWSHED_TARGETS) {
    return { status: 'refused', code: 'invalid-radius', message: `max_targets must be an integer in [1, ${String(MAX_VIEWSHED_TARGETS)}], got ${String(maxTargets)}` }
  }
  const divisions = Math.ceil(Math.sqrt(maxTargets))
  const stepM = radiusM / divisions

  // Generate the full lattice first, then run targets nearest-first: the cap
  // must never spend itself on distant off-surface points while near targets
  // (and the observer's own verdict) remain unanswered. Ties break by the
  // row-major offsets, so the order stays deterministic.
  const lattice: { readonly dxM: number; readonly dyM: number; readonly distanceM: number }[] = []
  const rows = divisions * 2
  for (let row = 0; row <= rows; row += 1) {
    const dyM = (row - divisions) * stepM
    for (let column = 0; column <= rows; column += 1) {
      const dxM = (column - divisions) * stepM
      const distanceM = Math.hypot(dxM, dyM)
      if (distanceM > radiusM || distanceM <= 0) continue
      lattice.push({ dxM, dyM, distanceM })
    }
  }
  lattice.sort((left, right) => left.distanceM - right.distanceM
    || left.dyM - right.dyM
    || left.dxM - right.dxM)

  const targets: ViewshedTarget[] = []
  const tallies = { visible: 0, blocked: 0, indeterminate: 0, outside: 0, refused: 0 }
  let specDigest: string | undefined
  let curvature: CurvatureRecord | undefined
  let sampling: { intervalMeters: number; sampleCountPerTarget: number } | undefined
  for (const point of lattice) {
    if (targets.length >= maxTargets) break
    // Local tangent plane at the observer: the same anchoring the LOS core
    // uses, so lattice meters and path meters agree.
    const lonLat = planeOffsetToLonLat(observer.lon, observer.lat, point.dxM, point.dyM)
    const target: LosEndpoint = { lon: lonLat[0], lat: lonLat[1], heightM: 0 }
    const run = computeLineOfSight(spec, surface, obstacles, observer, target)
    if (run.status === 'refused') {
      if (run.code === 'endpoint-outside-surface' || run.code === 'path-outside-surface') {
        tallies.outside += 1
        targets.push({ lon: lonLat[0], lat: lonLat[1], distanceM: point.distanceM, status: 'outside', outsideCode: run.code, minClearanceM: Number.NaN })
      } else {
        tallies.refused += 1
      }
      continue
    }
    specDigest = run.result.specDigest
    curvature = run.result.curvature
    sampling = { intervalMeters: run.result.sampling.intervalMeters, sampleCountPerTarget: run.result.sampling.sampleCount }
    tallies[run.result.status] += 1
    targets.push({
      lon: lonLat[0], lat: lonLat[1], distanceM: point.distanceM,
      status: run.result.status,
      minClearanceM: run.result.minClearanceM,
    })
  }
  if (specDigest === undefined || curvature === undefined || sampling === undefined) {
    return { status: 'refused', code: 'observer-outside-surface', message: 'every lattice target refused; the observer is likely outside the registered surface' }
  }
  return {
    status: 'computed',
    result: {
      methodVersion: TERRAIN_METHOD_VERSION,
      specDigest,
      observer: { lon: observer.lon, lat: observer.lat },
      radiusM,
      latticeStepM: stepM,
      targets,
      tallies,
      curvature,
      sampling,
      limitations: VIEWSHED_LIMITATIONS,
    },
  }
}

/** Convert a tangent-plane meter offset into WGS84 lon/lat (the LOS core's own anchoring). */
function planeOffsetToLonLat(lon: number, lat: number, dxM: number, dyM: number): [number, number] {
  const plane = planeAt(lon, lat)
  const [x, y] = toPlane(plane, lon, lat)
  return fromPlane(plane, x + dxM, y + dyM)
}
