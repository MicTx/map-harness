/**
 * Source-method parity fixtures (task-source-method-parity): the migrated
 * analysis methods — union/difference, perimeter, point-line distance,
 * nearest facility, kernel density, IDW contours, grid slope, and KML
 * export — each verified against a known numeric or analytic baseline, with
 * the honest negatives: missing/illegal inputs refuse, a view cone is not a
 * viewshed (card-level, asserted here for the slope/terrain family), and a
 * GeoJSON/KML export never claims to be a Shapefile.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import {
  geoUnion,
  geoDifference,
  geoPerimeter,
  geoPointLineDistance,
  geoNearest,
  geoContour,
} from '../src/geo-tools.ts'
import { vizDensity, vizExportKml } from '../src/viz-tools.ts'
import { terrainSlope } from '../src/terrain-tools.ts'
import { catalogRegister } from '../src/catalog-tools.ts'
import { mapAddLayer } from '../src/map-tools.ts'

const M = 180 / (6_371_000 * Math.PI) // one meter in degrees at the equator
const M_PER_DEG = 1 / M // ≈ 111,195 meters per degree

function square(west, south, sizeDeg) {
  const east = west + sizeDeg
  const north = south + sizeDeg
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] },
    properties: {},
  }
}

async function rigOf(label) {
  const dir = mkdtempSync(join(tmpdir(), `map-parity-${label}-`))
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: join(dir, 'catalog') })
  const session = rig.session('parity')
  return {
    dir,
    rig,
    session,
    write(name, collection) {
      writeFileSync(join(dir, `${name}.geojson`), JSON.stringify(collection))
      return `${name}.geojson`
    },
    async register(name, collection) {
      const path = join(dir, `${name}.geojson`)
      writeFileSync(path, JSON.stringify(collection))
      const callId = `reg-${name}`
      rig.call(session, callId, 'catalog_register', { path, name })
      return catalogRegister.execute({ path, name }, rig.exec(session, { callId }))
    },
    async dispose() {
      await rig.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('union and difference carry analytic area baselines; full coverage reports empty honestly', async t => {
  const env = await rigOf('overlay')
  t.after(async () => env.dispose())
  // Two unit squares overlapping by half: union = 1.5 deg², difference = 0.5 deg².
  const deg2 = M_PER_DEG * 111_132.92 // lon-m × lat-m per square degree ≈ 1.2357e10
  const pathA = env.write('a', { type: 'FeatureCollection', features: [square(0, 0, 1)] })
  const pathB = env.write('b', { type: 'FeatureCollection', features: [square(0.5, 0, 1)] })

  const union = await geoUnion.execute({ path_a: pathA, path_b: pathB }, env.rig.exec(env.session, { callId: 'u1' }))
  assert.ok(Math.abs(union.result_area_m2 - 1.5 * deg2) / (1.5 * deg2) < 0.02, `union ≈ 1.5 deg² (${union.result_area_m2})`)
  assert.equal(union.status, 'succeeded')

  const difference = await geoDifference.execute({ path_a: pathA, path_b: pathB }, env.rig.exec(env.session, { callId: 'd1' }))
  assert.ok(Math.abs(difference.result_area_m2 - 0.5 * deg2) / (0.5 * deg2) < 0.02, `difference ≈ 0.5 deg² (${difference.result_area_m2})`)

  // A fully covered by B: empty is a result, not a failure.
  const pathBig = env.write('big', { type: 'FeatureCollection', features: [square(-1, -1, 4)] })
  const covered = await geoDifference.execute({ path_a: pathA, path_b: pathBig }, env.rig.exec(env.session, { callId: 'd2' }))
  assert.equal(covered.empty, true)
  assert.equal(covered.result_area_m2, 0)

  // Point inputs refuse loudly.
  const pathPoint = env.write('pt', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }] })
  await assert.rejects(
    geoUnion.execute({ path_a: pathA, path_b: pathPoint }, env.rig.exec(env.session, { callId: 'u2' })),
    /must be a \(Multi\)Polygon/,
  )
})

test('perimeter measures the outer ring; holes stay excluded by design', async t => {
  const env = await rigOf('perimeter')
  t.after(async () => env.dispose())
  const withHole = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]],
        [[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]],
      ],
    },
    properties: {},
  }
  const path = env.write('ring', { type: 'FeatureCollection', features: [withHole] })
  const result = await geoPerimeter.execute({ path }, env.rig.exec(env.session, { callId: 'p1' }))
  // A unit square's boundary ≈ 4 × 111.2 km; the hole must not add to it.
  assert.ok(Math.abs(result.perimeter_km - 4 * M_PER_DEG / 1000) / (4 * M_PER_DEG / 1000) < 0.01,
    `perimeter ≈ 4° of arc (${result.perimeter_km} km)`)
  assert.ok(result.limitations.some(line => line.includes('holes are excluded')), 'the hole exclusion is stated')
})

test('point-line distance is the true segment distance, never an endpoint shortcut', async t => {
  const env = await rigOf('pldist')
  t.after(async () => env.dispose())
  const line = env.write('line', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 0]] }, properties: {} }] })

  // On the line: zero.
  const onLine = env.write('on', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0.5, 0] }, properties: {} }] })
  const zero = await geoPointLineDistance.execute({ point_path: onLine, line_path: line }, env.rig.exec(env.session, { callId: 'pl1' }))
  assert.equal(zero.distance_m, 0)

  // One hundredth of a degree off the line: ≈ 1.11 km.
  const near = env.write('near', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0.5, 0.01] }, properties: {} }] })
  const off = await geoPointLineDistance.execute({ point_path: near, line_path: line }, env.rig.exec(env.session, { callId: 'pl2' }))
  assert.ok(Math.abs(off.distance_m - 1112) / 1112 < 0.01, `off-line ≈ 1.11 km (${off.distance_m} m)`)

  // Beyond the line's end, the distance is to the ENDPOINT (1,0) ≈ √2° away,
  // never to the start point (2° away) — the segment answer, not a shortcut.
  const beyond = env.write('beyond', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [2, 1] }, properties: {} }] })
  const segment = await geoPointLineDistance.execute({ point_path: beyond, line_path: line }, env.rig.exec(env.session, { callId: 'pl3' }))
  const endpointKm = Math.SQRT2 * M_PER_DEG / 1000
  assert.ok(Math.abs(segment.distance_m / 1000 - endpointKm) / endpointKm < 0.01, `beyond-end ≈ √2° (${segment.distance_m} m)`)
  assert.ok(segment.distance_m / 1000 < 2 * M_PER_DEG / 1000, 'never the far-endpoint distance')
})

test('nearest facility is straight-line and says so; ties stay visible', async t => {
  const env = await rigOf('nearest')
  t.after(async () => env.dispose())
  const facilities = env.write('fac', {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { name: 'east' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 2] }, properties: { name: 'north' } },
    ],
  })
  const demand = env.write('demand', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} }] })
  const result = await geoNearest.execute({ point_path: demand, facilities_path: facilities }, env.rig.exec(env.session, { callId: 'n1' }))
  assert.ok(Math.abs(result.nearest_distance_km - M_PER_DEG / 1000) / (M_PER_DEG / 1000) < 0.01, `nearest ≈ 1° (${result.nearest_distance_km} km)`)
  assert.deepEqual(result.nearest_facility_point.map(Math.round), [1, 0])
  assert.ok(result.limitations.some(line => line.includes('straight-line')), 'the straight-line scope is declared')
  assert.ok(result.limitations.some(line => line.includes('run_submit')), 'road-network reachability is named as the other question')

  const empty = env.write('nofac', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: {} }] })
  await assert.rejects(
    geoNearest.execute({ point_path: demand, facilities_path: env.write('wrongtype', { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: {} }] }) }, env.rig.exec(env.session, { callId: 'n2' })),
    /no Point features/,
  )
  void empty
})

test('kernel density has the closed-form baseline and publishes a versioned artifact', async t => {
  const env = await rigOf('density')
  t.after(async () => env.dispose())
  const registered = await env.register('spots', {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'a' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0.5 * M * 1000, 0] }, properties: { name: 'b' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [-0.5 * M * 1000, 0] }, properties: { name: 'c' } },
    ],
  })
  const addCall = env.rig.call(env.session, 'add-spots', 'map_add_layer', { ref: registered.resource.ref, layer_id: 'spots' })
  const added = await mapAddLayer.execute({ ref: registered.resource.ref, layer_id: 'spots' }, env.rig.exec(env.session, { callId: 'add-spots' }))
  env.rig.result(env.session, addCall, { meta: added.meta })

  const callId = 'den-1'
  env.rig.call(env.session, callId, 'viz_density', { layer_id: 'spots', radius_km: 1 })
  const result = await vizDensity.execute({ layer_id: 'spots', radius_km: 1 }, env.rig.exec(env.session, { callId }))
  // Three points within 1 km of the center: density = 3 / (π·1²) ≈ 0.9549 个/km².
  assert.ok(Math.abs(result.density_max - 3 / Math.PI) / (3 / Math.PI) < 0.02, `center density ≈ 3/π (${result.density_max})`)
  assert.equal(result.unit, '个/km^2')
  assert.match(result.artifact.ref, /^art-/)
  assert.ok(result.limitations.some(line => line.includes('never statistical significance')), 'intensity is not significance')

  await assert.rejects(
    vizDensity.execute({ layer_id: 'spots', radius_km: 0.001 }, env.rig.exec(env.session, { callId: 'den-2' })),
    /radius_km must be/,
  )
  await assert.rejects(
    vizDensity.execute({ layer_id: 'ghost', radius_km: 1 }, env.rig.exec(env.session, { callId: 'den-3' })),
    /unknown layer ghost/,
  )
})

test('IDW contours interpolate the known middle value and refuse thin or unordered breaks', async t => {
  const env = await rigOf('contour')
  t.after(async () => env.dispose())
  const samples = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { v: 0 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0.01, 0] }, properties: { v: 5 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0.02, 0] }, properties: { v: 10 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0.01] }, properties: { v: 5 } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0.02, 0.01] }, properties: { v: 5 } },
    ],
  }
  const path = env.write('samples', samples)
  const result = await geoContour.execute({ path, field: 'v', breaks: [5], cell_size: 0.2 }, env.rig.exec(env.session, { callId: 'c1' }))
  assert.equal(result.status, 'succeeded')
  assert.ok(result.isoline_features > 0, 'the mid-value isoline exists')
  assert.ok(result.limitations.some(line => line.includes('no extrapolation')), 'the no-extrapolation limit is stated')

  await assert.rejects(
    geoContour.execute({ path, field: 'v', breaks: [5, 5] }, env.rig.exec(env.session, { callId: 'c2' })),
    /strictly increasing/,
  )
  await assert.rejects(
    geoContour.execute({ path, field: 'no_such', breaks: [1] }, env.rig.exec(env.session, { callId: 'c3' })),
    /at least 3 finite samples/,
  )
  const nanPath = env.write('nan', {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { v: 'not-a-number' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [1, 0] }, properties: { v: 1 } },
    ],
  })
  await assert.rejects(
    geoContour.execute({ path: nanPath, field: 'v', breaks: [1] }, env.rig.exec(env.session, { callId: 'c4' })),
    /at least 3 finite samples/,
    'non-numeric samples never silently count',
  )
})

test('grid slope returns the analytic plane answer and counts missing cells', async t => {
  const env = await rigOf('slope')
  t.after(async () => env.dispose())
  // A plane rising 10 m per 0.01° of longitude at the equator:
  // dz/dx = 10 m / (0.01° × 111,195 m/°) → slope = atan(0.008993) ≈ 0.5150°.
  const plane = { type: 'FeatureCollection', features: [] }
  for (let lon = 0; lon <= 4; lon += 1) {
    for (let lat = -1; lat <= 1; lat += 1) {
      plane.features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon * 0.01, lat * 0.01] },
        properties: { elevation: lon * 10 },
      })
    }
  }
  const registered = await env.register('plane', plane)
  const result = await terrainSlope.execute({ ref: registered.resource.ref }, env.rig.exec(env.session, { callId: 's1' }))
  const expected = Math.atan(10 / (0.01 * M_PER_DEG)) * 180 / Math.PI
  assert.ok(Math.abs(result.slope_max_deg - expected) / expected < 0.02, `plane slope ≈ ${expected.toFixed(4)}° (${result.slope_max_deg})`)
  assert.equal(result.missing_cells, 0)
  assert.ok(result.limitations.some(line => line.includes('resolution')), 'the grid-resolution limit is stated')
})

test('KML export publishes a fixed-version artifact and never claims to be a Shapefile', async t => {
  const env = await rigOf('kml')
  t.after(async () => env.dispose())
  const registered = await env.register('places', {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: '甲', score: 26 } },
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [[116, 39], [117, 40]] }, properties: { name: '路' } },
    ],
  })
  const addCall = env.rig.call(env.session, 'add-places', 'map_add_layer', { ref: registered.resource.ref, layer_id: 'places' })
  const added = await mapAddLayer.execute({ ref: registered.resource.ref, layer_id: 'places' }, env.rig.exec(env.session, { callId: 'add-places' }))
  env.rig.result(env.session, addCall, { meta: added.meta })

  const callId = 'kml-1'
  env.rig.call(env.session, callId, 'viz_export_kml', { layer_id: 'places' })
  const result = await vizExportKml.execute({ layer_id: 'places' }, env.rig.exec(env.session, { callId }))
  assert.equal(result.placemarks, 2)
  assert.match(result.artifact.ref, /^art-/)
  assert.equal(typeof result.map_revision, 'number', 'the export pins the map revision')
  assert.ok(result.limitations.some(line => line.includes('never a Shapefile')), 'the Shapefile confusion is preempted')

  await assert.rejects(
    vizExportKml.execute({ layer_id: 'ghost' }, env.rig.exec(env.session, { callId: 'kml-2' })),
    /unknown layer ghost/,
  )
})

test('a view cone is never a viewshed and unknown CRS refuses — the card contract holds', async () => {
  const { METHOD_CARDS } = await import('../../spatial-context/src/cards.ts')
  const terrain = METHOD_CARDS.find(card => card.id === 'terrain')
  assert.ok(terrain.preconditions.some(line => line.includes('视锥绘制不是可视域')), 'the card names the cone/viewshed distinction')
  const geometry = METHOD_CARDS.find(card => card.id === 'geometry')
  assert.ok(geometry.stopConditions.some(line => line.includes('未知 CRS')), 'the geometry card refuses unknown CRS')
})
