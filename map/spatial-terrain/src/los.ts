/**
 * The sampled line-of-sight (visibility) computation over a versioned
 * surface: the sightline is evaluated on the local tangent plane anchored at
 * the observer, at the spec's sampling interval, with the earth-curvature
 * and refraction correction applied per sample, against the terrain surface
 * and any bound building/voxel obstacles.
 *
 * The result is honest by construction: `visible` requires every obstructing
 * sample's clearance above the declared uncertainty; `blocked` requires a
 * sample below it by the same rule (and names the first such sample and its
 * source); anything in between — most importantly a grazing sightline — is
 * `indeterminate`, never a forced answer. A ground-level target does not
 * obstruct itself: the target endpoint only counts building/voxel
 * obstruction, while the observer endpoint also counts the local ground.
 * Distances carry their definition (`local-tangent-plane`) and the record
 * binds the exact sampling, curvature, and error budget the answer holds for.
 *
 * @module @map-harness/spatial-terrain/los
 */
import {
  EARTH_RADIUS_M,
  MAX_PATH_DISTANCE_M,
  TERRAIN_METHOD_VERSION,
  terrainSpecDigestOf,
  type LosEndpoint,
  type TerrainSpec,
} from './contract.ts'
import {
  checkControlPoints,
  elevationAt,
  fromPlane,
  insideFootprint,
  planeAt,
  toPlane,
  type TerrainObstacles,
  type TerrainSurface,
} from './surface.ts'

/** The sightline verdict. `indeterminate` is the honest grazing answer. */
export type LosStatus = 'visible' | 'blocked' | 'indeterminate'

/** Where a blocking sample's obstruction comes from. */
export type ObstructionSource = 'terrain' | 'building' | 'voxel'

/** The first sample the sightline dips below the obstacle model. */
export interface ObstructionDiagnostic {
  /** Zero-based sample index along the path. */
  readonly sampleIndex: number
  /** Distance from the observer along the path, meters. */
  readonly distanceM: number
  /** The sightline elevation at this sample, meters. */
  readonly rayElevationM: number
  /** The obstacle elevation the sightline failed to clear, meters. */
  readonly obstacleElevationM: number
  /** Which obstacle kind blocked. */
  readonly source: ObstructionSource
}

/** The bounded per-sample profile the result records alongside the verdict. */
export interface LosSample {
  readonly index: number
  /** Distance from the observer, meters. */
  readonly distanceM: number
  /** Corrected ground elevation at this sample (curvature applied), meters. */
  readonly groundElevationM: number
  /** Sightline elevation at this sample, meters. */
  readonly rayElevationM: number
  /** Sightline minus the governing obstacle elevation, meters. */
  readonly clearanceM: number
  /** The obstacle kind governing this sample's ground line. */
  readonly source: ObstructionSource
}

/** The curvature block one run applied (recorded, never implied). */
export interface CurvatureRecord {
  readonly kind: 'none' | 'refraction-corrected'
  readonly radiusM: number
  readonly refractionK: number
}

/** The full line-of-sight result one run produces. */
export interface LosResult {
  readonly methodVersion: typeof TERRAIN_METHOD_VERSION
  /** Canonical digest of the resolved spec this run executed. */
  readonly specDigest: string
  readonly status: LosStatus
  /** First sample below the obstacle model by more than the uncertainty; absent when none. */
  readonly firstObstruction: ObstructionDiagnostic | null
  /** The tightest effective clearance along the path, meters (negative = blocked depth). */
  readonly minClearanceM: number
  /** Distance of the tightest clearance, meters. */
  readonly minClearanceDistanceM: number
  /** Horizontal path length in the tangent plane, meters. */
  readonly horizontalDistanceM: number
  /** Straight-line endpoint-to-endpoint distance, meters. */
  readonly slantDistanceM: number
  /** Clearance uncertainty, meters: endpoint sigmas in quadrature plus the linear surface sigma. */
  readonly clearanceUncertaintyM: number
  readonly curvature: CurvatureRecord
  readonly distanceDefinition: 'local-tangent-plane'
  /** Resolved absolute endpoint elevations actually used, meters. */
  readonly observerElevationM: number
  readonly targetElevationM: number
  /** Sampling actually applied: the interval and the sample count including both endpoints. */
  readonly sampling: { readonly intervalMeters: number; readonly sampleCount: number }
  /** The full per-sample table the artifact keeps. */
  readonly samples: readonly LosSample[]
  /** The bounded profile for model-facing text (decimated to at most {@link RESULT_SAMPLE_CAP} rows). */
  readonly profile: readonly LosSample[]
  readonly limitations: readonly string[]
}

/** The most profile rows a result carries; the artifact keeps the full table. */
export const RESULT_SAMPLE_CAP = 128

/** The stable refusal codes a run can hit after spec validation (path and data level). */
export type LosRunCode =
  | 'degenerate-path'
  | 'endpoint-outside-surface'
  | 'path-outside-surface'
  | 'path-too-long'
  | 'beyond-sample-bound'
  | 'control-point-mismatch'

/** A refused run: the code names the reason, nothing was computed. */
export interface LosRefusal {
  readonly status: 'refused'
  readonly code: LosRunCode
  readonly message: string
}

/** A completed run. */
export interface LosOutcome {
  readonly status: 'computed'
  readonly result: LosResult
}

/** The fixed limitations every LOS result declares. */
export const LOS_LIMITATIONS: readonly string[] = [
  'Distances are local-tangent-plane meters anchored at the observer; paths beyond 100 km refuse instead of answering with undisclosed projection error.',
  'The verdict is sampled at the declared interval: obstacles narrower than one interval can hide between samples.',
  'Clearance uncertainty combines endpoint sigmas in quadrature and the surface sigma linearly (conservative); a sightline inside it reports indeterminate, not visible.',
  'Bilinear grid interpolation is the surface model; terrain between grid nodes is not surveyed truth.',
] as const

/**
 * Run one line-of-sight computation over a built surface model. The spec
 * must already be validated and the surface/obstacles already built — this
 * function is the numeric core and refuses path-level conditions only.
 * @param spec - the resolved, validated TerrainSpec.
 * @param surface - the built surface grid.
 * @param obstacles - the built obstacle model.
 * @param observer - the observer endpoint (lon/lat degrees, height above ground or absolute override).
 * @param target - the target endpoint, same rules.
 * @returns the computed result, or the refusal that stopped it.
 */
export function computeLineOfSight(
  spec: TerrainSpec,
  surface: TerrainSurface,
  obstacles: TerrainObstacles,
  observer: LosEndpoint,
  target: LosEndpoint,
): LosOutcome | LosRefusal {
  const plane = planeAt(observer.lon, observer.lat)
  const [ox, oy] = toPlane(plane, observer.lon, observer.lat)
  const [tx, ty] = toPlane(plane, target.lon, target.lat)
  const distanceM = Math.hypot(tx - ox, ty - oy)
  if (!Number.isFinite(distanceM) || distanceM <= 0) {
    return { status: 'refused', code: 'degenerate-path', message: 'observer and target must be two distinct points' }
  }
  if (distanceM > MAX_PATH_DISTANCE_M) {
    return { status: 'refused', code: 'path-too-long', message: `path is ${Math.round(distanceM)} m; the local tangent plane answers up to ${MAX_PATH_DISTANCE_M} m — longer paths refuse instead of answering with undisclosed error` }
  }
  // The epsilon keeps a path whose length is an exact multiple of the
  // interval (up to float error at meter scales) from gaining one phantom
  // sample — sample counts are a spec decision, not a float artifact.
  const sampleCount = Math.ceil(distanceM / spec.sampling.intervalMeters - 1e-9) + 1
  if (sampleCount > spec.sampling.maxSamples) {
    return { status: 'refused', code: 'beyond-sample-bound', message: `path needs ${sampleCount} samples at ${spec.sampling.intervalMeters} m spacing; the spec bounds it at ${spec.sampling.maxSamples} — coarsen the interval explicitly instead of oversampling silently` }
  }
  const observerGround = elevationAt(surface, observer.lon, observer.lat)
  if (observer.elevationM === undefined && observerGround === undefined) {
    return { status: 'refused', code: 'endpoint-outside-surface', message: 'the observer lies outside the surface grid hull; endpoint ground elevation is unknowable' }
  }
  const targetGround = elevationAt(surface, target.lon, target.lat)
  if (target.elevationM === undefined && targetGround === undefined) {
    return { status: 'refused', code: 'endpoint-outside-surface', message: 'the target lies outside the surface grid hull; endpoint ground elevation is unknowable' }
  }
  if (spec.controlPoints !== undefined && spec.controlToleranceM !== undefined) {
    const refusal = controlPointRefusalOf(spec, surface)
    if (refusal !== undefined) return refusal
  }
  const curvature = curvatureRecordOf(spec)
  const observerElevationM = observer.elevationM ?? (observerGround as number) + observer.heightM
  const targetElevationM = target.elevationM ?? (targetGround as number) + target.heightM
  const dropAtTarget = curvatureDrop(curvature, distanceM)
  const footprints = obstacles.buildings.map(building => ({
    building,
    ring: building.ring.map(([lon, lat]) => toPlane(plane, lon, lat)),
  }))
  const voxelCells = obstacles.voxels.map(cell => ({ cell, ...xyOf(plane, cell.lon, cell.lat) }))
  const samples: LosSample[] = []
  let minClearance = Number.POSITIVE_INFINITY
  let minClearanceDistance = 0
  for (let at = 0; at < sampleCount; at++) {
    const fraction = sampleCount === 1 ? 0 : at / (sampleCount - 1)
    const d = fraction * distanceM
    const x = ox + fraction * (tx - ox)
    const y = oy + fraction * (ty - oy)
    const [lon, lat] = fromPlane(plane, x, y)
    const ground = elevationAt(surface, lon, lat)
    if (ground === undefined) {
      return { status: 'refused', code: 'path-outside-surface', message: `sample ${at} at ${Math.round(d)} m lies outside the surface grid hull; the path answer would have a hole` }
    }
    const drop = curvatureDrop(curvature, d)
    const correctedGround = ground - drop
    const rayElevation = observerElevationM + fraction * (targetElevationM - dropAtTarget - observerElevationM)
    let obstacleElevation = correctedGround
    let source: ObstructionSource = 'terrain'
    for (const { building, ring } of footprints) {
      // The building stands on the corrected ground line: its top drops with
      // the same curvature correction the ground at this distance does.
      const top = building.topM - drop
      if (insideFootprint(ring, x, y) && top > obstacleElevation) {
        obstacleElevation = top
        source = 'building'
      }
    }
    let clearance = rayElevation - obstacleElevation
    for (const { cell, cx, cy } of voxelCells) {
      // A voxel is an occupied cell [z−half, z+half], not a column up from
      // the ground: it blocks only when the sightline actually crosses it.
      const half = cell.cellMeters / 2
      const top = cell.zM + half - drop
      const bottom = cell.zM - half - drop
      if (Math.abs(x - cx) <= half && Math.abs(y - cy) <= half && rayElevation >= bottom && rayElevation <= top) {
        const before = clearance
        clearance = Math.min(clearance, rayElevation - top)
        if (clearance < before) source = 'voxel'
      }
    }
    // The target endpoint does not obstruct itself on bare terrain: a
    // ground-level target ends there by construction. Buildings and voxels
    // above it still count, as does the observer's own ground.
    const effective = at === sampleCount - 1 && source === 'terrain' ? Number.POSITIVE_INFINITY : clearance
    if (effective < minClearance) {
      minClearance = effective
      minClearanceDistance = d
    }
    samples.push({
      index: at,
      distanceM: d,
      groundElevationM: correctedGround,
      rayElevationM: rayElevation,
      clearanceM: clearance,
      source,
    })
  }
  const uncertainty = clearanceUncertaintyOf(spec)
  const firstBelow = samples.find((sample, at) =>
    (at === sampleCount - 1 && sample.source === 'terrain' ? Number.POSITIVE_INFINITY : sample.clearanceM) < -uncertainty)
  const status: LosStatus = firstBelow !== undefined
    ? 'blocked'
    : minClearance > uncertainty ? 'visible' : 'indeterminate'
  const firstObstruction = firstBelow === undefined
    ? null
    : {
        sampleIndex: firstBelow.index,
        distanceM: firstBelow.distanceM,
        rayElevationM: firstBelow.rayElevationM,
        obstacleElevationM: firstBelow.rayElevationM - firstBelow.clearanceM,
        source: firstBelow.source,
      }
  return {
    status: 'computed',
    result: {
      methodVersion: TERRAIN_METHOD_VERSION,
      specDigest: terrainSpecDigestOf(spec),
      status,
      firstObstruction,
      minClearanceM: minClearance === Number.POSITIVE_INFINITY ? 0 : minClearance,
      minClearanceDistanceM: minClearanceDistance,
      horizontalDistanceM: distanceM,
      slantDistanceM: Math.hypot(distanceM, targetElevationM - observerElevationM),
      clearanceUncertaintyM: uncertainty,
      curvature,
      distanceDefinition: 'local-tangent-plane',
      observerElevationM,
      targetElevationM,
      sampling: { intervalMeters: spec.sampling.intervalMeters, sampleCount },
      samples,
      profile: decimate(samples, RESULT_SAMPLE_CAP),
      limitations: LOS_LIMITATIONS,
    },
  }
}

/** The control-point gate: a surface that fails its surveyed points is never analyzed. */
function controlPointRefusalOf(spec: TerrainSpec, surface: TerrainSurface): LosRefusal | undefined {
  const controlPoints = spec.controlPoints as NonNullable<TerrainSpec['controlPoints']>
  const check = checkControlPoints(surface, controlPoints)
  if (!check.ok) {
    return { status: 'refused', code: 'control-point-mismatch', message: check.issues[0]?.message ?? 'control points are uncheckable against this surface' }
  }
  if (!check.withinTolerance(spec.controlToleranceM as number)) {
    const worst = check.deltas.reduce((worstSoFar, delta) =>
      Math.abs(delta.deltaM) > Math.abs(worstSoFar.deltaM) ? delta : worstSoFar)
    return { status: 'refused', code: 'control-point-mismatch', message: `the surface fails its control points: ${worst.id} deviates by ${worst.deltaM.toFixed(3)} m against a ${spec.controlToleranceM} m tolerance` }
  }
  return undefined
}

/** The clearance uncertainty: endpoint sigmas in quadrature, surface sigma linear (conservative). */
function clearanceUncertaintyOf(spec: TerrainSpec): number {
  return Math.hypot(spec.accuracy.observerMeters, spec.accuracy.targetMeters) + spec.accuracy.surfaceMeters
}

/** The curvature record one run declares and applies. */
function curvatureRecordOf(spec: TerrainSpec): CurvatureRecord {
  if (spec.curvature.kind === 'none') return { kind: 'none', radiusM: EARTH_RADIUS_M, refractionK: 0 }
  return {
    kind: 'refraction-corrected',
    radiusM: EARTH_RADIUS_M,
    refractionK: spec.curvature.refractionK,
  }
}

/** Earth-curvature drop at one distance: (1−k)·d²/(2R) meters. */
function curvatureDrop(record: CurvatureRecord, distanceM: number): number {
  if (record.kind === 'none') return 0
  return (1 - record.refractionK) * distanceM * distanceM / (2 * record.radiusM)
}

/** Plane coordinates of one lon/lat in the anchored plane. */
function xyOf(plane: ReturnType<typeof planeAt>, lon: number, lat: number): { cx: number; cy: number } {
  const [cx, cy] = toPlane(plane, lon, lat)
  return { cx, cy }
}

/** Keep at most `cap` evenly spaced rows (always including both endpoints). */
function decimate(samples: readonly LosSample[], cap: number): readonly LosSample[] {
  if (samples.length <= cap) return samples
  const picked: LosSample[] = []
  const stride = (samples.length - 1) / (cap - 1)
  for (let at = 0; at < cap; at++) {
    const sample = samples[Math.round(at * stride)]
    if (sample !== undefined) picked.push(sample)
  }
  return picked
}
