import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadGeoJson, loadGeoJsonString, projDefinitionOf, setGeoSourceTestHook, toWgs84 } from '../src/geo-source.ts'
import { bboxOf } from '../src/output.ts'
import { geoBuffer, geoArea, geoIntersect, geoDistance } from '../src/geo-tools.ts'
import {
  GEO_META_KIND,
  GEO_META_SCHEMA_VERSION,
  MAX_ANALYSIS_META_BYTES,
  buildGeoAnalysisMeta,
  decodeGeoAnalysisMeta,
} from '../src/geo-meta.ts'
import { SpatialError } from '../src/spatial-errors.ts'
import { controlledFsExec, withExec } from './workspace-rig.mjs'
import proj4 from 'proj4'

const wgs84Square = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[116.0, 39.0], [116.01, 39.0], [116.01, 39.01], [116.0, 39.01], [116.0, 39.0]]] }, properties: {} }],
}

test('proj4 CGCS2000 zone convergence: round trip error under 1e-4 degrees', () => {
  const def = projDefinitionOf('EPSG:4547')
  const [e, n] = proj4('EPSG:4326', def, [117.0, 39.0])
  const [lon, lat] = proj4(def, 'EPSG:4326', [e, n])
  assert.ok(Math.abs(lon - 117.0) < 1e-4)
  assert.ok(Math.abs(lat - 39.0) < 1e-4)
  const geometry = toWgs84({ type: 'Point', coordinates: [e, n] }, def)
  assert.equal(geometry.type, 'Point')
  assert.ok(Math.abs(geometry.coordinates[0] - 117.0) < 1e-4)
})

test('bboxOf walks polygon rings', () => {
  const box = bboxOf(wgs84Square)
  assert.deepEqual(box, [116.0, 39.0, 116.01, 39.01])
})

test('loadGeoJson rejects invalid JSON and non-FeatureCollection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'))
  writeFileSync(join(dir, 'bad.json'), '{nope')
  await withExec(dir, exec => assert.rejects(loadGeoJson({ path: 'bad.json' }, exec), /not valid JSON/))
  writeFileSync(join(dir, 'arr.json'), '[]')
  await withExec(dir, exec => assert.rejects(loadGeoJson({ path: 'arr.json' }, exec), /FeatureCollection/))
})

test('geo_area execute remains asynchronous', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'))
  writeFileSync(join(dir, 'square.geojson'), JSON.stringify(wgs84Square))
  await withExec(dir, (exec) => {
    const result = geoArea.execute({ path: 'square.geojson' }, exec)
    assert.equal(result instanceof Promise, true)
  })
})

test('geo_area async returns area in range', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'))
  writeFileSync(join(dir, 'square.geojson'), JSON.stringify(wgs84Square))
  await withExec(dir, async (exec) => {
    const value = await geoArea.execute({ path: 'square.geojson' }, exec)
    assert.ok(value.area_m2 > 0.5e6 && value.area_m2 < 2.5e6, `area ${value.area_m2}`)
    assert.deepEqual(value.bbox, [116.0, 39.0, 116.01, 39.01])
  })
})

test('geo_buffer grows area monotonically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'))
  writeFileSync(join(dir, 'square.geojson'), JSON.stringify(wgs84Square))
  await withExec(dir, async (exec) => {
    const small = await geoBuffer.execute({ path: 'square.geojson', distance_m: 10 }, exec)
    const big = await geoBuffer.execute({ path: 'square.geojson', distance_m: 100 }, exec)
    assert.ok(small.area_m2 > 0)
    assert.ok(big.area_m2 > small.area_m2)
  })
})

test('geo_intersect disjoint polygons report no overlap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'))
  const a = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]] }, properties: {} }] }
  const b = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[20, 20], [21, 20], [21, 21], [20, 21], [20, 20]]] }, properties: {} }] }
  writeFileSync(join(dir, 'a.geojson'), JSON.stringify(a))
  writeFileSync(join(dir, 'b.geojson'), JSON.stringify(b))
  await withExec(dir, async (exec) => {
    const value = await geoIntersect.execute({ path_a: 'a.geojson', path_b: 'b.geojson' }, exec)
    assert.equal(value.intersects, false)
  })
})

test('geo_distance Beijing to Shanghai roughly 1068 km', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'))
  const bj = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: {} }] }
  const sh = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [121.47, 31.23] }, properties: {} }] }
  writeFileSync(join(dir, 'bj.geojson'), JSON.stringify(bj))
  writeFileSync(join(dir, 'sh.geojson'), JSON.stringify(sh))
  await withExec(dir, async (exec) => {
    const value = await geoDistance.execute({ path_a: 'bj.geojson', path_b: 'sh.geojson' }, exec)
    assert.ok(value.distance_km > 1000 && value.distance_km < 1150, `distance ${value.distance_km}`)
  })
})

test('geo_distance with projected CRS input converges through proj4', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-'))
  const def = projDefinitionOf('EPSG:4547')
  const [x1, y1] = proj4('EPSG:4326', def, [116.4, 39.9])
  const [x2, y2] = proj4('EPSG:4326', def, [121.47, 31.23])
  const a = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [x1, y1] }, properties: {} }] }
  const b = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [x2, y2] }, properties: {} }] }
  writeFileSync(join(dir, 'a.geojson'), JSON.stringify(a))
  writeFileSync(join(dir, 'b.geojson'), JSON.stringify(b))
  await withExec(dir, async (exec) => {
    const value = await geoDistance.execute({ path_a: 'a.geojson', path_b: 'b.geojson', crs_a: 'EPSG:4547', crs_b: 'EPSG:4547' }, exec)
    assert.ok(value.distance_km > 1000 && value.distance_km < 1150, `projected distance ${value.distance_km}`)
  })
})

test('loadGeoJson rejects absolute, parent, and symlink workspace escapes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'geo-root-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const outside = join(root, 'outside.geojson')
  writeFileSync(outside, JSON.stringify(wgs84Square))
  symlinkSync(outside, join(workspace, 'link.geojson'))
  await withExec(workspace, async (exec) => {
    await assert.rejects(loadGeoJson({ path: outside }, exec), /session workspace/)
    await assert.rejects(loadGeoJson({ path: '../outside.geojson' }, exec), /session workspace/)
    await assert.rejects(loadGeoJson({ path: 'link.geojson' }, exec), /symbolic link/)
  })
})

test('loadGeoJson rejects oversized and non-regular targets before readBytes', async () => {
  let reads = 0
  const base = {
    resolve: async path => ({ targetKey: path, displayPath: path }),
    contains: () => true,
    stat: async () => ({ type: 'file', size: 1, version: 'v1' }),
    readBytes: async () => { reads += 1; return Buffer.from(JSON.stringify(wgs84Square)) },
  }
  const oversized = {
    ...base,
    lstat: async () => ({ type: 'file', size: 32 * 1024 * 1024 + 1, version: 'v1' }),
  }
  await assert.rejects(
    loadGeoJson({ path: 'oversized.geojson' }, controlledFsExec('/workspace', oversized)),
    /byte limit/,
  )
  assert.equal(reads, 0)

  const special = {
    ...base,
    lstat: async () => ({ type: 'other', version: 'v1' }),
  }
  await assert.rejects(
    loadGeoJson({ path: 'pipe.geojson' }, controlledFsExec('/workspace', special)),
    /regular file/,
  )
  assert.equal(reads, 0)
})

test('loadGeoJson enforces feature and coordinate resource limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-limits-'))
  const features = Array.from({ length: 10_001 }, (_, index) => ({
    type: 'Feature', geometry: null, properties: { index },
  }))
  writeFileSync(join(dir, 'features.geojson'), JSON.stringify({ type: 'FeatureCollection', features }))
  const coordinates = Array.from({ length: 100_001 }, () => [116.4, 39.9])
  writeFileSync(join(dir, 'coordinates.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'MultiPoint', coordinates }, properties: {} }],
  }))
  await withExec(dir, async (exec) => {
    await assert.rejects(loadGeoJson({ path: 'features.geojson' }, exec), /feature limit/)
    await assert.rejects(loadGeoJson({ path: 'coordinates.geojson' }, exec), /coordinate limit/)
  })
})

test('loadGeoJson rejects non-finite, out-of-range, and over-deep coordinates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-coordinates-'))
  writeFileSync(join(dir, 'nonfinite.geojson'), '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[1e999,0]},"properties":{}}]}')
  writeFileSync(join(dir, 'range.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [181, 0] }, properties: {} }],
  }))
  let deep = [116.4, 39.9]
  for (let index = 0; index < 17; index += 1) deep = [deep]
  writeFileSync(join(dir, 'deep.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: deep }, properties: {} }],
  }))
  await withExec(dir, async (exec) => {
    await assert.rejects(loadGeoJson({ path: 'nonfinite.geojson' }, exec), /finite/)
    await assert.rejects(loadGeoJson({ path: 'range.geojson' }, exec), /WGS84 range/)
    await assert.rejects(loadGeoJson({ path: 'deep.geojson' }, exec), /geometry depth/)
  })
})

test('loadGeoJson and loadGeoJsonString reject geometry-specific coordinate nesting', async () => {
  const malformed = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [0, 0] }, properties: {} }],
  }
  const bytes = Buffer.from(JSON.stringify(malformed))
  assert.throws(() => loadGeoJsonString(bytes, 'EPSG:4326'), /INVALID_GEOJSON:.*Polygon rings/)

  const dir = mkdtempSync(join(tmpdir(), 'geo-shape-'))
  writeFileSync(join(dir, 'malformed.geojson'), bytes)
  await withExec(dir, async (exec) => {
    await assert.rejects(loadGeoJson({ path: 'malformed.geojson' }, exec), /INVALID_GEOJSON:.*Polygon rings/)
  })
})

test('loadGeoJson rejects a symlink replacement after path admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'geo-race-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const inside = join(workspace, 'safe.geojson')
  const outside = join(root, 'outside.geojson')
  const outsideCollection = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [121.47, 31.23] }, properties: {} }],
  }
  writeFileSync(inside, JSON.stringify(wgs84Square))
  writeFileSync(outside, JSON.stringify(outsideCollection))
  setGeoSourceTestHook(async () => {
    unlinkSync(inside)
    symlinkSync(outside, inside)
  })
  try {
    await withExec(workspace, async (exec) => {
      await assert.rejects(loadGeoJson({ path: 'safe.geojson' }, exec), /symbolic link/)
    })
  } finally {
    setGeoSourceTestHook(undefined)
  }
})

test('loadGeoJson redacts host paths from filesystem errors', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-redact-'))
  const missing = join(dir, 'host-secret-name.geojson')
  await withExec(dir, async (exec) => {
    await assert.rejects(
      loadGeoJson({ path: missing }, exec),
      error => error instanceof Error
        && /could not be read/.test(error.message)
        && !error.message.includes(missing),
    )
  })
})

test('geo results project content, presentationMeta, and durable meta from one canonical value', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-meta-'))
  writeFileSync(join(dir, 'square.geojson'), JSON.stringify(wgs84Square))
  await withExec(dir, async (exec) => {
    const value = await geoArea.execute({ path: 'square.geojson' }, exec)
    assert.equal(value.status, 'succeeded')
    assert.ok(Array.isArray(value.limitations) && value.limitations.length > 0)

    const meta = geoArea.output.presentationMeta({}, value)
    assert.equal(meta.schemaVersion, GEO_META_SCHEMA_VERSION)
    assert.equal(meta.kind, 'analysis-result')
    assert.equal(meta.tool, 'geo_area')
    assert.equal(meta.status, 'succeeded')
    assert.deepEqual(meta.inputs, [{ path: 'square.geojson', crs: 'EPSG:4326', featureIndex: 0 }])
    assert.equal(meta.method.algorithm, 'turf-area')
    assert.deepEqual(meta.metrics, [{ name: 'area', value: value.area_m2, unit: 'm^2' }])
    assert.deepEqual(meta.limitations, value.limitations)

    const rendered = geoArea.output.render({}, value)
    assert.equal(rendered.length, 1)
    const text = rendered[0].text
    assert.ok(text.includes('"area_m2"'), 'metrics stay model-visible')
    assert.ok(text.includes('"status":"succeeded"'), 'status stays model-visible')
    assert.ok(text.includes('limitations'), 'key limitations stay model-visible')
    assert.equal(text.includes('analysis-result'), false, 'durable meta stays out of model content')

    const decoded = decodeGeoAnalysisMeta(meta)
    assert.equal(decoded.status, 'ok')
    assert.deepEqual(decoded.meta.inputs, meta.inputs)
  })
})

test('geo meta decode refuses unknown versions and kinds read-only', () => {
  const refused = decodeGeoAnalysisMeta({ schemaVersion: 99, kind: 'analysis-result' })
  assert.deepEqual(refused, { status: 'refused', code: 'unknown-schema-version' })
  const wrongKind = decodeGeoAnalysisMeta({ schemaVersion: 1, kind: 'decision-change' })
  assert.deepEqual(wrongKind, { status: 'refused', code: 'unknown-kind' })
  assert.equal(decodeGeoAnalysisMeta('nope').status, 'refused')
  assert.equal(decodeGeoAnalysisMeta({ schemaVersion: 1, kind: 'analysis-result' }).status, 'refused')
})

test('geo meta builder enforces its serialized size bound', () => {
  const longPath = 'p'.repeat(MAX_ANALYSIS_META_BYTES)
  assert.throws(
    () => buildGeoAnalysisMeta({
      schemaVersion: GEO_META_SCHEMA_VERSION,
      kind: GEO_META_KIND,
      tool: 'geo_area',
      status: 'succeeded',
      inputs: [{ path: longPath, crs: 'EPSG:4326', featureIndex: 0 }],
      method: { algorithm: 'turf-area', units: 'm^2', parameters: {} },
      metrics: [{ name: 'area', value: 1, unit: 'm^2' }],
      limitations: [],
    }),
    /RESOURCE_TOO_LARGE/,
  )
})

test('geo failures carry stable error codes and never a presentation meta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-codes-'))
  writeFileSync(join(dir, 'square.geojson'), JSON.stringify(wgs84Square))
  await withExec(dir, async (exec) => {
    await assert.rejects(
      geoArea.execute({ path: 'square.geojson', crs: 'EPSG:9999' }, exec),
      error => error instanceof SpatialError && error.code === 'CRS_UNKNOWN' && /unsupported CRS/.test(error.message),
    )
    await assert.rejects(
      geoBuffer.execute({ path: 'square.geojson', distance_m: 2e7 }, exec),
      error => error instanceof SpatialError && error.code === 'INVALID_ARGUMENT',
    )
    await assert.rejects(
      geoArea.execute({ path: '../outside.geojson' }, exec),
      error => error instanceof SpatialError && error.code === 'WORKSPACE_ESCAPE',
    )
  }
  )
})

test('first-feature tools surface the consumed feature index and record both selections', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'geo-selector-'))
  const twoFeatures = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: null, properties: { name: 'attribute-only' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: {} },
    ],
  }
  writeFileSync(join(dir, 'points.geojson'), JSON.stringify(twoFeatures))
  writeFileSync(join(dir, 'other.geojson'), JSON.stringify(twoFeatures))
  await withExec(dir, async (exec) => {
    const buffered = await geoBuffer.execute({ path: 'points.geojson', distance_m: 100 }, exec)
    assert.equal(buffered.feature_index, 1, 'the first geometry-bearing feature is index 1')
    assert.equal(buffered.meta.inputs[0].featureIndex, 1)

    const secondArea = await geoArea.execute({ path: 'points.geojson', feature_index: 1 }, exec)
    assert.equal(secondArea.feature_index, 1)
    assert.equal(secondArea.meta.inputs[0].featureIndex, 1)

    const distant = await geoDistance.execute({ path_a: 'points.geojson', path_b: 'other.geojson' }, exec)
    assert.equal(distant.feature_index_a, 1)
    assert.equal(distant.feature_index_b, 1)
    assert.deepEqual(
      distant.meta.inputs.map(input => input.path),
      ['points.geojson', 'other.geojson'],
    )
  })
})
