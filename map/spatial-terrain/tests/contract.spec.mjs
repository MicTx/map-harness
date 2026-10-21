/**
 * `spatial-terrain@1` contract fixtures: vertical metadata/CRS/revision
 * rejections list every reason, the revision binding compares exact refs and
 * digests, control points are checked against the built grid with the
 * surveyed tolerance, and the bounded display grid decimates without
 * inventing elevations.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_REFRACTION_K,
  MAX_PATH_DISTANCE_M,
  RESOURCE_REF_PATTERN,
  TERRAIN_METHOD_VERSION,
  revisionsMatch,
  validateTerrainSpec,
} from '../src/contract.ts'
import { buildTerrainSurface, checkControlPoints, elevationAt, surfaceDisplayPoints } from '../src/surface.ts'

/** A minimal valid surface binding to mutate per fixture. */
const validSurface = {
  ref: 'res-dem9@v1',
  revision: 'abc123',
  elevationField: 'elev',
  horizontalCrs: 'EPSG:4326',
  vertical: { datum: 'EGM96', units: 'm', epoch: 'none' },
}

/** A minimal valid spec built around `validSurface`. */
function validSpec(overrides = {}) {
  return {
    methodVersion: TERRAIN_METHOD_VERSION,
    surface: validSurface,
    curvature: { kind: 'refraction-corrected', refractionK: DEFAULT_REFRACTION_K },
    accuracy: { surfaceMeters: 0.5, observerMeters: 0.1, targetMeters: 0.1 },
    sampling: { intervalMeters: 25, maxSamples: 4096 },
    ...overrides,
  }
}

test('a spec missing vertical metadata, CRS, or version lists every refusal reason', () => {
  const issues = validateTerrainSpec({
    methodVersion: 'spatial-terrain@0',
    surface: {
      ref: 'dem-unversioned',
      elevationField: '',
      // vertical metadata entirely absent, no CRS, no revision
    },
    curvature: { kind: 'none' },
    accuracy: { surfaceMeters: -1, observerMeters: 0, targetMeters: Number.NaN },
    sampling: { intervalMeters: 0, maxSamples: 1 },
  })
  const codes = issues.map(issue => `${issue.field}:${issue.code}`)
  assert.ok(codes.includes('methodVersion:method-version'), codes.join())
  assert.ok(codes.includes('surface.ref:ref-unversioned'), codes.join())
  assert.ok(codes.includes('surface.revision:revision-required'), codes.join())
  assert.ok(codes.includes('surface.elevationField:field-required'), codes.join())
  assert.ok(codes.includes('surface.horizontalCrs:horizontal-crs-required'), codes.join())
  assert.ok(codes.includes('surface.vertical:vertical-datum-required'), codes.join())
  assert.ok(codes.includes('accuracy.surfaceMeters:accuracy-nonnegative'), codes.join())
  assert.ok(codes.includes('accuracy.targetMeters:accuracy-nonnegative'), codes.join())
  assert.ok(codes.includes('sampling.intervalMeters:interval-positive'), codes.join())
  assert.ok(codes.includes('sampling.maxSamples:max-samples-bound'), codes.join())
})

test('a spec with an unnamed datum, unsupported unit, or missing epoch refuses loudly', () => {
  for (const [vertical, code] of [
    [{ units: 'm', epoch: 'none' }, 'vertical-datum-required'],
    [{ datum: 'EGM96', units: 'ft', epoch: 'none' }, 'vertical-units-unsupported'],
    [{ datum: 'EGM96', units: 'm' }, 'epoch-required'],
  ]) {
    const issues = validateTerrainSpec(validSpec({ surface: { ...validSurface, vertical } }))
    assert.ok(issues.some(issue => issue.code === code), `${code} expected, got ${issues.map(issue => issue.code).join()}`)
  }
  assert.deepEqual(validateTerrainSpec(validSpec()), [], 'a complete spec validates clean')
})

test('display projections do not pass as analysis CRS and unsupported curvature states refuse', () => {
  const displayOnly = validateTerrainSpec(validSpec({
    surface: { ...validSurface, horizontalCrs: '' },
  }))
  assert.ok(displayOnly.some(issue => issue.code === 'horizontal-crs-required'))

  const curvature = validateTerrainSpec(validSpec({ curvature: { kind: 'refraction-corrected', refractionK: 1.5 } }))
  assert.ok(curvature.some(issue => issue.field === 'curvature.refractionK'))
  const unstated = validateTerrainSpec(validSpec({ curvature: undefined }))
  assert.ok(unstated.some(issue => issue.field === 'curvature'), 'the curvature correction must be stated, never defaulted')
})

test('obstacle bindings conflict-check against the surface and each other', () => {
  const sameRef = validateTerrainSpec(validSpec({
    buildings: { ref: validSurface.ref, revision: 'x', heightField: 'h', base: 'terrain' },
  }))
  assert.ok(sameRef.some(issue => issue.field === 'buildings.ref' && issue.code === 'ref-conflict'), sameRef.map(issue => issue.code).join())

  const absoluteNeedsField = validateTerrainSpec(validSpec({
    buildings: { ref: 'res-bld@v1', revision: 'x', heightField: 'h', base: 'absolute' },
  }))
  assert.ok(absoluteNeedsField.some(issue => issue.code === 'base-field-required'))

  const terrainRejectsField = validateTerrainSpec(validSpec({
    buildings: { ref: 'res-bld@v1', revision: 'x', heightField: 'h', base: 'terrain', baseField: 'base' },
  }))
  assert.ok(terrainRejectsField.some(issue => issue.code === 'base-field-required'))

  const shared = validateTerrainSpec(validSpec({
    buildings: { ref: 'res-bld@v1', revision: 'x', heightField: 'h', base: 'terrain' },
    voxels: { ref: 'res-bld@v1', revision: 'y', zField: 'z', cellMeters: 0 },
  }))
  assert.ok(shared.some(issue => issue.field === 'voxels.ref' && issue.code === 'ref-conflict'))
  assert.ok(shared.some(issue => issue.field === 'voxels.cellMeters' && issue.code === 'voxel-cell-positive'))
})

test('control points require a positive tolerance and finite members', () => {
  const missingTolerance = validateTerrainSpec(validSpec({
    controlPoints: [{ id: 'cp1', lon: 0, lat: 0, elevationM: 1 }],
  }))
  assert.ok(missingTolerance.some(issue => issue.code === 'control-tolerance-positive'))
  const toleranceWithoutPoints = validateTerrainSpec(validSpec({ controlToleranceM: 1 }))
  assert.ok(toleranceWithoutPoints.some(issue => issue.code === 'control-points-required'))
  const badPoint = validateTerrainSpec(validSpec({
    controlPoints: [{ id: 'cp1', lon: 200, lat: 0, elevationM: 1 }],
    controlToleranceM: 1,
  }))
  assert.ok(badPoint.some(issue => issue.code === 'control-point-invalid'))
})

test('the revision binding compares exact ref plus digest, so another version is stale', () => {
  assert.ok(revisionsMatch({ ref: 'res-dem9@v1', revision: 'abc' }, { ref: 'res-dem9@v1', revision: 'abc' }))
  assert.ok(!revisionsMatch({ ref: 'res-dem9@v1', revision: 'abc' }, { ref: 'res-dem9@v2', revision: 'abc' }))
  assert.ok(!revisionsMatch({ ref: 'res-dem9@v1', revision: 'abc' }, { ref: 'res-dem9@v1', revision: 'def' }))
  assert.match(RESOURCE_REF_PATTERN.source, /res-/)
  assert.ok(RESOURCE_REF_PATTERN.test('res-dem-9@v12'))
  assert.ok(!RESOURCE_REF_PATTERN.test('res-dem-9'))
})

test('an incomplete or duplicate grid refuses instead of interpolating over holes', () => {
  const grid = gridOf([
    [0, 0, 0], [100, 0, 0], [200, 0, 0],
    [0, 50, 0], [100, 50, 0], [200, 50, 0],
    [0, 100, 0], [200, 100, 0],
  ])
  const missingCorner = buildTerrainSurface(validSurface, grid.features)
  assert.ok(!missingCorner.surface)
  assert.equal(missingCorner.issues[0].code, 'incomplete-grid')

  const duplicated = gridOf([
    [0, 0, 0], [0, 0, 5], [100, 0, 0],
    [0, 50, 0], [100, 50, 0],
    [0, 100, 0], [100, 100, 0],
  ])
  const duplicate = buildTerrainSurface(validSurface, duplicated.features)
  assert.ok(!duplicate.surface)
  assert.equal(duplicate.issues[0].code, 'duplicate-grid-point')

  const nonNumeric = buildTerrainSurface(validSurface, gridOf([
    [0, 0, 'x'], [100, 0, 0],
    [0, 50, 0], [100, 50, 0],
  ]).features)
  assert.equal(nonNumeric.issues[0].code, 'grid-point-invalid')

  const tooSmall = buildTerrainSurface(validSurface, gridOf([
    [0, 0, 0], [100, 0, 0],
  ]).features)
  assert.equal(tooSmall.issues[0].code, 'incomplete-grid')
})

test('bilinear interpolation answers inside the hull and refuses outside it', () => {
  const built = buildTerrainSurface(validSurface, gridOf([
    [0, 0, 10], [100, 0, 20],
    [0, 100, 30], [100, 100, 60],
  ]).features)
  assert.ok(built.surface)
  const surface = built.surface
  assert.equal(elevationAt(surface, 0, 0), 10)
  assert.equal(elevationAt(surface, 50, 50), 30, 'cell center is the four-corner mean')
  assert.equal(elevationAt(surface, 25, 0), 12.5)
  assert.equal(elevationAt(surface, 150, 50), undefined, 'outside the hull never extrapolates')
})

test('surveyed control points certify the surface within the declared tolerance', () => {
  const built = buildTerrainSurface(validSurface, gridOf([
    [0, 0, 10], [100, 0, 10],
    [0, 100, 10], [100, 100, 10],
  ]).features)
  const surface = built.surface
  const within = checkControlPoints(surface, [{ id: 'cp-a', lon: 50, lat: 50, elevationM: 10.4 }])
  assert.ok(within.ok)
  assert.ok(within.withinTolerance(0.5))
  assert.ok(!within.withinTolerance(0.1))
  const outside = checkControlPoints(surface, [{ id: 'cp-b', lon: 500, lat: 0, elevationM: 10 }])
  assert.ok(!outside.ok)
  assert.equal(outside.issues[0].code, 'control-point-outside-surface')
})

test('the display grid decimates deterministically and never invents elevations', () => {
  const lons = [0, 100, 200, 300]
  const lats = [0, 50, 100, 150]
  const features = []
  for (const lat of lats) {
    for (const lon of lons) features.push(point(lon, lat, lon + lat))
  }
  const built = buildTerrainSurface(validSurface, features)
  const full = surfaceDisplayPoints(built.surface, 'elev', 16)
  assert.equal(full.features.length, 16)
  assert.deepEqual(full.totalPointCount, 16)
  const decimated = surfaceDisplayPoints(built.surface, 'elev', 6)
  assert.ok(decimated.features.length <= 6, `decimated count ${decimated.features.length} exceeds cap`)
  assert.equal(decimated.totalPointCount, 16)
  for (const feature of decimated.features) {
    const [lon, lat] = feature.geometry.coordinates
    assert.equal(feature.properties.elev, lon + lat, 'display elevations come from the grid, unchanged')
  }
  // Both endpoints of the grid survive decimation.
  const coords = decimated.features.map(feature => feature.geometry.coordinates.join())
  assert.ok(coords.includes('0,0'))
  assert.ok(coords.includes('300,150'))
  assert.equal(MAX_PATH_DISTANCE_M, 100_000)
})

/** Build a FeatureCollection of Point features from [lon, lat, elevation] rows. */
function gridOf(rows) {
  return { features: rows.map(([lon, lat, elevation]) => point(lon, lat, elevation)) }
}

function point(lon, lat, elevation, field = 'elev') {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { [field]: elevation },
  }
}
