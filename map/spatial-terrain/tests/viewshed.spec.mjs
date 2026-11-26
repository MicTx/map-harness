/** Area viewshed: lattice determinism, honest tallies, and the refusal family over analytic terrain. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EARTH_RADIUS_M, TERRAIN_METHOD_VERSION, validateTerrainSpec } from '../src/contract.ts'
import { buildTerrainObstacles, buildTerrainSurface } from '../src/surface.ts'
import { computeViewshed, MAX_VIEWSHED_RADIUS_M, MAX_VIEWSHED_TARGETS } from '../src/viewshed.ts'

const M = 180 / (EARTH_RADIUS_M * Math.PI) // one meter in degrees at the equator

function point(lonM, latM, elevation) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lonM * M, latM * M] },
    properties: { elev: elevation },
  }
}

const binding = {
  ref: 'res-dem-fixture@v1',
  revision: 'fixture-digest-1',
  elevationField: 'elev',
  horizontalCrs: 'EPSG:4326',
  vertical: { datum: 'EGM96', units: 'm', epoch: 'none' },
}

/**
 * A surface with a 50 m wall across x ∈ (600, 900): an observer at the origin
 * sees everything before the wall and nothing on the far side of it.
 */
function walledSurface() {
  const features = []
  for (let lat = -2; lat <= 2; lat++) {
    for (let lon = 0; lon <= 20; lon++) {
      const x = lon * 100
      features.push(point(x, lat * 100, x > 600 && x < 900 ? 50 : 0))
    }
  }
  return buildTerrainSurface(binding, features).surface
}

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

test('the wall shades the far side: tallies match the hand-computed geometry', () => {
  const surface = walledSurface()
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  const observer = { lon: 0, lat: 0, heightM: 2 }
  const run = computeViewshed(spec(), surface, obstacles, observer, 1500, 512)
  assert.equal(run.status, 'computed')
  const result = run.result
  assert.equal(result.methodVersion, TERRAIN_METHOD_VERSION)
  assert.equal(result.curvature.kind, 'none')
  // The lattice covers ±1500 m: west of the observer and beyond the surface's
  // ±200 m band refuse per target as `outside` — honestly counted, not dropped.
  assert.ok(result.tallies.outside > 0, 'off-surface lattice points tally as outside')
  assert.ok(result.tallies.visible > 0, 'the near side is visible')
  assert.ok(result.tallies.blocked > 0, 'the far side of the wall is blocked')
  assert.equal(result.tallies.visible + result.tallies.blocked + result.tallies.indeterminate + result.tallies.outside + result.tallies.refused, result.targets.length)
  // Per-target verdicts follow the wall: targets on the near slope are
  // visible (they stand on it), everything past the plateau's front edge
  // (x ≈ 700, the 50 m nodes) is shaded, and off-surface lattice points
  // tally as `outside` instead of disappearing.
  const blockedXs = result.targets.filter(target => target.status === 'blocked').map(target => target.lon / M)
  assert.ok(blockedXs.length > 0, 'the plateau shades targets behind its front edge')
  for (const x of blockedXs) {
    assert.ok(x > 650, `a blocked target must sit past the wall's near slope (got x=${String(x)})`)
  }
  for (const target of result.targets) {
    if (target.status === 'visible') {
      const x = target.lon / M
      assert.ok(x < 750, `a visible target must sit on the near side or the slope itself (got x=${String(x)})`)
    }
  }
})

test('the lattice is deterministic: identical inputs produce identical targets in order', () => {
  const surface = walledSurface()
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  const observer = { lon: 0, lat: 0, heightM: 2 }
  const first = computeViewshed(spec(), surface, obstacles, observer, 1000, 128)
  const second = computeViewshed(spec(), surface, obstacles, observer, 1000, 128)
  assert.equal(first.status, 'computed')
  assert.equal(second.status, 'computed')
  assert.deepEqual(first.status === 'computed' && first.result.targets, second.status === 'computed' && second.result.targets)
  assert.deepEqual(first.status === 'computed' && first.result.tallies, second.status === 'computed' && second.result.tallies)
  // Row-major order: distance is not monotonic across rows, but equal rows repeat.
  const distances = (first.status === 'computed' ? first.result.targets : []).map(target => target.distanceM)
  assert.ok(distances.length >= 1)
})

test('radius and target-count bounds refuse with named codes', () => {
  const surface = walledSurface()
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  const observer = { lon: 0, lat: 0, heightM: 2 }
  assert.equal(computeViewshed(spec(), surface, obstacles, observer, MAX_VIEWSHED_RADIUS_M + 1, 512).code, 'radius-too-large')
  assert.equal(computeViewshed(spec(), surface, obstacles, observer, 1500, MAX_VIEWSHED_TARGETS + 1).code, 'invalid-radius')
  assert.equal(computeViewshed(spec(), surface, obstacles, observer, -5, 512).code, 'invalid-radius')
})

test('an observer off the registered surface refuses instead of answering empty', () => {
  const surface = walledSurface()
  const obstacles = buildTerrainObstacles(undefined, undefined, undefined, undefined, surface).obstacles
  // The surface spans x 0..2000 m: an observer far west sees every lattice
  // target refuse, and the run reports the condition instead of tallies.
  const run = computeViewshed(spec(), surface, obstacles, { lon: -5000 * M, lat: 0, heightM: 2 }, 800, 128)
  assert.equal(run.status, 'refused')
  assert.equal(run.status === 'refused' ? run.code : '', 'observer-outside-surface')
})
