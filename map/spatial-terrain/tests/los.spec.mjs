/**
 * Line-of-sight numeric fixtures: every verdict is checked against an
 * independently derived analytic answer (piecewise-linear ridge crossings,
 * the uniform-slope graze, the earth-curvature horizon, building and voxel
 * geometry) within pre-written tolerances, and the honesty rules — grazing
 * sightlines are indeterminate inside the declared error budget, out-of-hull
 * paths refuse, oversampling refuses — are negative-tested.
 *
 * Plane meters convert to degrees at the equator (cos φ0 = 1): one meter is
 * `180 / (R·π)` degrees on both axes, so fixture geometry is written in
 * meters and converted once.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_REFRACTION_K,
  EARTH_RADIUS_M,
  TERRAIN_METHOD_VERSION,
  terrainSpecDigestOf,
  validateTerrainSpec,
} from '../src/contract.ts'
import { buildTerrainObstacles, buildTerrainSurface } from '../src/surface.ts'
import { computeLineOfSight } from '../src/los.ts'

const M = 180 / (EARTH_RADIUS_M * Math.PI) // one meter in degrees at the equator

/** The flat-ground surface fixture: a 21×5 lattice, 100 m spacing, elevation `elevationOf`. */
function flatSurface(elevationOf = () => 0) {
  const features = []
  for (let lat = -2; lat <= 2; lat++) {
    for (let lon = 0; lon <= 20; lon++) {
      features.push(point(lon * 100, lat * 100, elevationOf(lon * 100)))
    }
  }
  return buildTerrainSurface(binding, features).surface
}

const binding = {
  ref: 'res-dem-fixture@v1',
  revision: 'fixture-digest-1',
  elevationField: 'elev',
  horizontalCrs: 'EPSG:4326',
  vertical: { datum: 'EGM96', units: 'm', epoch: 'none' },
}

/** The wide flat surface the curvature fixtures run over: 0..21000 m × ±200 m, 100 m lattice. */
function wideSurface() {
  const features = []
  for (let lat = -2; lat <= 2; lat++) {
    for (let lon = 0; lon <= 210; lon++) {
      features.push(point(lon * 100, lat * 100, 0))
    }
  }
  return buildTerrainSurface(binding, features).surface
}

/** The default zero-uncertainty spec (analytic fixtures), mutated per test. */
function spec(overrides = {}) {
  const resolved = {
    methodVersion: TERRAIN_METHOD_VERSION,
    surface: binding,
    curvature: { kind: 'none' },
    accuracy: { surfaceMeters: 0, observerMeters: 0, targetMeters: 0 },
    sampling: { intervalMeters: 50, maxSamples: 4096 },
    ...overrides,
  }
  const issues = validateTerrainSpec(resolved)
  assert.deepEqual(issues, [], 'fixture spec must be valid')
  return resolved
}

function observerAt(x, heightM, overrides = {}) {
  return { lon: x * M, lat: 0, heightM, ...overrides }
}

test('flat ground with endpoint heights is visible with exact distances', () => {
  const surface = flatSurface()
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  const run = computeLineOfSight(
    spec(),
    surface,
    obstacles,
    observerAt(0, 100),
    observerAt(800, 0),
  )
  assert.equal(run.status, 'computed')
  const result = run.result
  assert.equal(result.status, 'visible')
  assert.equal(result.firstObstruction, null)
  assert.ok(Math.abs(result.horizontalDistanceM - 800) < 1e-6)
  assert.ok(Math.abs(result.slantDistanceM - Math.hypot(800, -100)) < 1e-6)
  assert.equal(result.sampling.sampleCount, Math.ceil(800 / 50) + 1)
  assert.equal(result.curvature.kind, 'none')
  assert.equal(result.distanceDefinition, 'local-tangent-plane')
  assert.ok(Math.abs(result.observerElevationM - 100) < 1e-9)
  // The tightest interior clearance sits at the last sample before the
  // ground-level target: ray 6.25 m over terrain 0.
  assert.ok(Math.abs(result.minClearanceM - 6.25) < 1e-9)
  assert.ok(Math.abs(result.minClearanceDistanceM - 750) < 1e-9)
})

test('an analytic ridge blocks the sightline at the exact piecewise-linear crossing', () => {
  // Ridge crest 20 m across x ∈ [400, 600] with single-cell 100 m ramps;
  // observer eye 10 m at x=0, ground-level target at x=1000.
  // Ray(d) = 10·(1 − d/1000); terrain ramp 0.2·(d−300) → crossing at d = 1000/3.
  const surface = flatSurface(d => {
    if (d >= 400 && d <= 600) return 20
    if (d > 300 && d < 400) return 0.2 * (d - 300)
    if (d > 600 && d < 700) return 0.2 * (700 - d)
    return 0
  })
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  const run = computeLineOfSight(spec(), surface, obstacles, observerAt(0, 10), observerAt(1000, 0))
  assert.equal(run.status, 'computed')
  const result = run.result
  assert.equal(result.status, 'blocked')
  // First sample past the analytic crossing 333.3 m at 50 m spacing is 350 m.
  assert.equal(result.firstObstruction.distanceM, 350)
  assert.ok(Math.abs(result.firstObstruction.rayElevationM - 6.5) < 1e-9)
  assert.ok(Math.abs(result.firstObstruction.obstacleElevationM - 10) < 1e-9)
  assert.equal(result.firstObstruction.source, 'terrain')
  assert.ok(result.minClearanceM < 0)
  assert.equal(result.profile.length, 21)
})

test('the same ridge 3 m high clears with the crest clearance exactly ray-minus-crest', () => {
  const surface = flatSurface(d => {
    if (d >= 400 && d <= 600) return 3
    if (d > 300 && d < 400) return 0.03 * (d - 300)
    if (d > 600 && d < 700) return 0.03 * (700 - d)
    return 0
  })
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  const run = computeLineOfSight(spec(), surface, obstacles, observerAt(0, 10), observerAt(1000, 0))
  const result = run.result
  assert.equal(result.status, 'visible')
  assert.equal(result.firstObstruction, null)
  // Ray at the 500 m crest (sample 10): 10·0.5 = 5, terrain 3 → clearance 2 m.
  const crest = result.profile.find(sample => Math.abs(sample.distanceM - 500) < 1e-6)
  assert.ok(crest !== undefined)
  assert.ok(Math.abs(crest.clearanceM - 2) < 1e-9)
  // The path minimum sits at the last interior sample (d = 950 m), where the
  // descending ray is 0.5 m above the flat ground short of the target.
  assert.ok(Math.abs(result.minClearanceM - 0.5) < 1e-9)
  assert.ok(Math.abs(result.minClearanceDistanceM - 950) < 1e-6)
})

test('a grazing slope is indeterminate inside the error budget and visible or blocked once heights separate', () => {
  // Uniform 5% slope through both endpoints: the sightline parallels the ground.
  const surface = flatSurface(d => 0.05 * d)
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  const grazing = computeLineOfSight(
    spec({ accuracy: { surfaceMeters: 0.001, observerMeters: 0.001, targetMeters: 0.001 } }),
    surface,
    obstacles,
    observerAt(0, 0),
    observerAt(600, 0),
  )
  assert.equal(grazing.result.status, 'indeterminate', 'a zero-clearance line within its declared error is indeterminate')
  assert.equal(grazing.result.firstObstruction, null)

  const lifted = computeLineOfSight(
    spec({ accuracy: { surfaceMeters: 0.001, observerMeters: 0.001, targetMeters: 0.001 } }),
    surface,
    obstacles,
    observerAt(0, 5),
    observerAt(600, 0),
  )
  assert.equal(lifted.result.status, 'visible')
  // The ray starts 5 m above the slope and ends on it: the tightest interior
  // clearance is 5·(1/(n−1)) at the last interior sample.
  assert.ok(Math.abs(lifted.result.minClearanceM - 5 / 12) < 1e-9)

  const lowered = computeLineOfSight(spec(), surface, obstacles, observerAt(0, 0), observerAt(600, 0, { elevationM: 0.05 * 600 - 10 }))
  assert.equal(lowered.result.status, 'blocked', 'an absolute target 10 m under the slope-parallel line is blocked')
})

test('the declared error budget turns a marginal clear answer honestly indeterminate', () => {
  const surface = flatSurface(d => {
    if (d >= 400 && d <= 600) return 3
    if (d > 300 && d < 400) return 0.03 * (d - 300)
    if (d > 600 && d < 700) return 0.03 * (700 - d)
    return 0
  })
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  // minClearance 2 m: within a 3 m surface sigma it is not an answer.
  const budgeted = computeLineOfSight(
    spec({ accuracy: { surfaceMeters: 3, observerMeters: 0.2, targetMeters: 0.2 } }),
    surface,
    obstacles,
    observerAt(0, 10),
    observerAt(1000, 0),
  )
  assert.equal(budgeted.result.status, 'indeterminate')
  assert.ok(Math.abs(budgeted.result.clearanceUncertaintyM - (Math.hypot(0.2, 0.2) + 3)) < 1e-9)
})

test('earth curvature blocks a descending sightline at the analytic crossing and refraction flips it clear', () => {
  const surface = wideSurface()
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  const curvature = { kind: 'refraction-corrected', refractionK: 0 }
  // Pure curvature (k = 0): drop(d) = d²/(2R). A 30 m eye looking at a
  // ground target 21000 m away first dips under the bulged terrain where
  // 30·(1−f) − drop(21000)·f + drop(21000·f) = 0 → f ≈ 0.8665 (≈ 18196 m).
  const beyond = computeLineOfSight(spec({ curvature }), surface, obstacles, observerAt(0, 30), observerAt(21000, 0))
  assert.equal(beyond.result.status, 'blocked')
  const crossingM = 0.8665 * 21000
  assert.ok(Math.abs(beyond.result.firstObstruction.distanceM - crossingM) <= 60,
    `first obstruction ${beyond.result.firstObstruction.distanceM} vs analytic ${crossingM}`)
  assert.equal(beyond.result.firstObstruction.source, 'terrain')

  const inside = computeLineOfSight(spec({ curvature }), surface, obstacles, observerAt(0, 30), observerAt(18000, 0))
  assert.equal(inside.result.status, 'visible', '18000 m stays clear under pure curvature')

  // k = 0.13 shrinks the drop to 0.87·d²/(2R) (refraction extends the ray):
  // the 20500 m sightline is blocked under k = 0 and clears under k = 0.13.
  const geometric = computeLineOfSight(spec({ curvature }), surface, obstacles, observerAt(0, 30), observerAt(20500, 0))
  assert.equal(geometric.result.status, 'blocked')
  assert.deepEqual(geometric.result.curvature, { kind: 'refraction-corrected', radiusM: EARTH_RADIUS_M, refractionK: 0 })
  const refracted = computeLineOfSight(
    spec({ curvature: { kind: 'refraction-corrected', refractionK: DEFAULT_REFRACTION_K } }),
    surface,
    obstacles,
    observerAt(0, 30),
    observerAt(20500, 0),
  )
  assert.equal(refracted.result.status, 'visible')
  assert.deepEqual(refracted.result.curvature, { kind: 'refraction-corrected', radiusM: EARTH_RADIUS_M, refractionK: DEFAULT_REFRACTION_K })
})

test('building footprints block only when the sightline passes below their roofline', () => {
  const surface = flatSurface()
  const buildingsBinding = { ref: 'res-bld@v1', revision: 'bld-1', heightField: 'height', base: 'terrain' }
  const features = [{
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[200 * M, -30 * M], [300 * M, -30 * M], [300 * M, 30 * M], [200 * M, 30 * M]]] },
    properties: { height: 20 },
  }]
  const built = buildTerrainObstacles(buildingsBinding, features, undefined, undefined, surface)
  assert.deepEqual(built.issues, [])
  assert.equal(built.obstacles.buildings[0].baseM, 0, 'terrain base samples the surface under the footprint')

  const tall = computeLineOfSight(spec({ buildings: buildingsBinding }), surface, built.obstacles, observerAt(0, 2), observerAt(500, 2))
  assert.equal(tall.result.status, 'blocked')
  assert.equal(tall.result.firstObstruction.source, 'building')
  assert.ok(Math.abs(tall.result.firstObstruction.distanceM - 200) < 1e-6)
  assert.ok(Math.abs(tall.result.firstObstruction.obstacleElevationM - 20) < 1e-9)

  const low = buildTerrainObstacles(
    buildingsBinding,
    [{ ...features[0], properties: { height: 1 } }],
    undefined,
    undefined,
    surface,
  ).obstacles
  const cleared = computeLineOfSight(spec({ buildings: buildingsBinding }), surface, low, observerAt(0, 2), observerAt(500, 2))
  assert.equal(cleared.result.status, 'visible', 'a 1 m building clears a 2 m sightline')

  const offPath = buildTerrainObstacles(
    buildingsBinding,
    [{
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[200 * M, 120 * M], [300 * M, 120 * M], [300 * M, 180 * M], [200 * M, 180 * M]]] },
      properties: { height: 50 },
    }],
    undefined,
    undefined,
    surface,
  ).obstacles
  const beside = computeLineOfSight(spec({ buildings: buildingsBinding }), surface, offPath, observerAt(0, 2), observerAt(500, 2))
  assert.equal(beside.result.status, 'visible')
})

test('occupied voxels block when the sightline crosses the cell', () => {
  const surface = flatSurface()
  const voxelsBinding = { ref: 'res-vox@v1', revision: 'vox-1', zField: 'z', cellMeters: 20 }
  const features = [{ type: 'Feature', geometry: { type: 'Point', coordinates: [200 * M, 0] }, properties: { z: 5 } }]
  const built = buildTerrainObstacles(undefined, undefined, voxelsBinding, features, surface)
  assert.deepEqual(built.issues, [])
  const blocked = computeLineOfSight(spec({ voxels: voxelsBinding }), surface, built.obstacles, observerAt(0, 5), observerAt(400, 5))
  assert.equal(blocked.result.status, 'blocked')
  assert.equal(blocked.result.firstObstruction.source, 'voxel')
  assert.equal(blocked.result.firstObstruction.distanceM, 200)

  const offPath = buildTerrainObstacles(
    undefined,
    undefined,
    voxelsBinding,
    [{ type: 'Feature', geometry: { type: 'Point', coordinates: [200 * M, 100 * M] }, properties: { z: 5 } }],
    surface,
  ).obstacles
  const beside = computeLineOfSight(spec({ voxels: voxelsBinding }), surface, offPath, observerAt(0, 5), observerAt(400, 5))
  assert.equal(beside.result.status, 'visible')

  const above = buildTerrainObstacles(
    undefined,
    undefined,
    voxelsBinding,
    [{ type: 'Feature', geometry: { type: 'Point', coordinates: [200 * M, 0] }, properties: { z: 500 } }],
    surface,
  ).obstacles
  const overhead = computeLineOfSight(spec({ voxels: voxelsBinding }), surface, above, observerAt(0, 5), observerAt(400, 5))
  assert.equal(overhead.result.status, 'visible', 'a voxel 500 m up does not block a 5 m sightline')
})

test('paths that leave the grid hull, oversample, or collapse refuse with named codes', () => {
  const surface = flatSurface()
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  const outside = computeLineOfSight(spec(), surface, obstacles, observerAt(0, 5), observerAt(2500, 0))
  assert.equal(outside.status, 'refused')
  assert.equal(outside.code, 'endpoint-outside-surface')

  const oversampled = computeLineOfSight(
    spec({ sampling: { intervalMeters: 0.1, maxSamples: 4096 } }),
    surface,
    obstacles,
    observerAt(0, 5),
    observerAt(1000, 0),
  )
  assert.equal(oversampled.status, 'refused')
  assert.equal(oversampled.code, 'beyond-sample-bound')
  assert.match(oversampled.message, /10001 samples/)

  const degenerate = computeLineOfSight(spec(), surface, obstacles, observerAt(500, 5), observerAt(500, 5))
  assert.equal(degenerate.code, 'degenerate-path')

  const tooLong = computeLineOfSight(spec(), surface, obstacles, observerAt(0, 5), { lon: 0, lat: 100_100 * M, heightM: 5 })
  assert.equal(tooLong.code, 'path-too-long')
})

test('a surface that fails its control points is never analyzed', () => {
  const surface = flatSurface(() => 10)
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  const failing = computeLineOfSight(
    spec({
      controlPoints: [{ id: 'cp-1', lon: 500 * M, lat: 0, elevationM: 15 }],
      controlToleranceM: 1,
    }),
    surface,
    obstacles,
    observerAt(0, 2),
    observerAt(500, 0),
  )
  assert.equal(failing.status, 'refused')
  assert.equal(failing.code, 'control-point-mismatch')
  assert.match(failing.message, /cp-1/)

  const passing = computeLineOfSight(
    spec({
      controlPoints: [{ id: 'cp-1', lon: 500 * M, lat: 0, elevationM: 10.5 }],
      controlToleranceM: 1,
    }),
    surface,
    obstacles,
    observerAt(0, 2),
    observerAt(500, 0),
  )
  assert.equal(passing.status, 'computed')
  assert.equal(passing.result.status, 'visible')
})

test('the result binds the resolved spec digest and method version', () => {
  const surface = flatSurface()
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  const resolvedSpec = spec()
  const run = computeLineOfSight(resolvedSpec, surface, obstacles, observerAt(0, 3), observerAt(300, 1))
  assert.equal(run.result.methodVersion, TERRAIN_METHOD_VERSION)
  assert.equal(run.result.specDigest, terrainSpecDigestOf(resolvedSpec))
  assert.ok(run.result.specDigest.length === 64)
})

function point(lonM, latM, elevation) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lonM * M, latM * M] },
    properties: { elev: elevation },
  }
}
