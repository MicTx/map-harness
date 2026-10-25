/**
 * Shapefile ZIP import admission fixtures for `data_import` (P1-L3): bounded
 * container admission (entry budget, traversal, declared decompression
 * totals, lying local headers), component matching, .cpg/LDID encoding,
 * `.prj` CRS resolution with exactly-once reprojection, missing-CRS
 * confirmation, structure and budget refusals. All fixtures are synthetic,
 * built by the shared generator.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShapefileImport } from '../src/import-format/shapefile.ts'
import {
  CGCS2000_CM117_WKT,
  SHAPE_TYPES,
  WGS84_WKT,
  buildDbf,
  buildShp,
  buildShx,
  shapefileZip,
  zipOf,
} from './fixtures/shapefile-fixtures.mjs'

const POINT_FIELDS = [{ name: 'name', type: 'C', length: 10 }, { name: 'pop', type: 'N', length: 8 }]

test('a point shapefile with explicit WGS84 keeps coordinates identical', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9], [121.47, 31.23]],
    fields: POINT_FIELDS,
    rows: [['first', '1200'], ['second', '300']],
  })
  const outcome = parseShapefileImport({ bytes, crs: 'EPSG:4326' })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.format, 'shapefile')
  assert.equal(outcome.admission.encoding, 'utf-8')
  const [first, second] = outcome.geojson.features
  assert.equal(first.geometry.type, 'Point')
  assert.deepEqual(first.geometry.coordinates, [116.4, 39.9])
  assert.deepEqual(first.properties, { name: 'first', pop: 1200 })
  assert.deepEqual(second.properties, { name: 'second', pop: 300 })
  assert.equal(outcome.admission.warnings.length, 0)
})

test('single-part and multi-part polylines map to LineString and MultiLineString', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.polyline,
    geometries: [
      { parts: [[[116.4, 39.9], [117.0, 40.0]]] },
      { parts: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] },
    ],
    fields: [{ name: 'name', type: 'C', length: 6 }],
    rows: [['one'], ['two']],
  })
  const outcome = parseShapefileImport({ bytes, crs: 'EPSG:4326' })
  assert.equal(outcome.kind, 'ready')
  const [single, multi] = outcome.geojson.features
  assert.equal(single.geometry.type, 'LineString')
  assert.equal(multi.geometry.type, 'MultiLineString')
  assert.equal(multi.geometry.coordinates.length, 2)
})

test('polygon rings: two clockwise parts stay two polygons; a hole nests', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.polygon,
    geometries: [
      { parts: [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]] },
      { parts: [[[10, 10], [10, 12], [12, 12], [12, 10], [10, 10]]] },
    ],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['a'], ['b']],
  })
  const outcome = parseShapefileImport({ bytes, crs: 'EPSG:4326' })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.geojson.features[0].geometry.type, 'Polygon')
  assert.equal(outcome.geojson.features[1].geometry.type, 'Polygon')

  const holeBytes = shapefileZip({
    shapeType: SHAPE_TYPES.polygon,
    geometries: [{ parts: [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]], [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]]] }],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['holed']],
  })
  const holed = parseShapefileImport({ bytes: holeBytes, crs: 'EPSG:4326' })
  assert.equal(holed.kind, 'ready')
  const geometry = holed.geojson.features[0].geometry
  assert.ok(geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates[0]
  assert.equal(rings.length, 2, 'the counter-clockwise inner ring nests as a hole')
})

test('a projected .prj reprojects exactly once to known WGS84', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[500000, 4000000]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['cm117']],
    prj: CGCS2000_CM117_WKT,
  })
  const outcome = parseShapefileImport({ bytes })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.prjConclusion.proj4Constructible, true)
  assert.match(outcome.admission.prjConclusion.wktSummary, /117E/)
  const [lon, lat] = outcome.geojson.features[0].geometry.coordinates
  assert.ok(Math.abs(lon - 117) < 0.001, `lon ${lon} should sit on the central meridian`)
  assert.ok(Math.abs(lat - 36.13) < 0.05, `lat ${lat}`)
})

test('a geographic WGS84 .prj never double-projects: coordinates stay identical', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['wgs']],
    prj: WGS84_WKT,
  })
  const outcome = parseShapefileImport({ bytes })
  assert.equal(outcome.kind, 'ready')
  assert.deepEqual(outcome.geojson.features[0].geometry.coordinates, [116.4, 39.9])
})

test('a .cpg label decodes Chinese field names and values', () => {
  const encoder = new TextEncoder()
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: encoder.encode('名称'), type: 'C', length: 12 }],
    rows: [[encoder.encode('医院')]],
    cpg: 'UTF-8',
  })
  const outcome = parseShapefileImport({ bytes, crs: 'EPSG:4326' })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.encoding, 'utf-8')
  assert.deepEqual(outcome.geojson.features[0].properties, { 名称: '医院' })
})

test('an LDID header byte selects the DBF encoding without a .cpg', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'label', type: 'C', length: 8 }],
    rows: [[Buffer.from('café', 'latin1')]],
    ldid: 0x03,
  })
  const outcome = parseShapefileImport({ bytes, crs: 'EPSG:4326' })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.encoding, 'windows-1252')
  assert.deepEqual(outcome.geojson.features[0].properties, { label: 'café' })
})

test('missing .prj and no explicit crs stop at confirmation with geographic candidates', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['x']],
  })
  const outcome = parseShapefileImport({ bytes })
  assert.equal(outcome.kind, 'needs_confirmation')
  assert.equal(outcome.admission.nativeCrs, 'unconfirmed')
  assert.equal(outcome.admission.crsCandidates.length, 1)
  assert.deepEqual(outcome.admission.crsCandidates[0], { crs: 'EPSG:4326', reasons: ['assume-geographic-wgs84'] })
  assert.match(outcome.admission.candidatesFingerprint, /^[0-9a-f]{64}$/)
})

test('an unconstructible .prj stops at confirmation carrying its summary', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['x']],
    prj: 'NOT A VALID PROJECTION STRING',
  })
  const outcome = parseShapefileImport({ bytes })
  assert.equal(outcome.kind, 'needs_confirmation')
  assert.equal(outcome.admission.prjConclusion.proj4Constructible, false)
  assert.ok(outcome.admission.crsCandidates.some(candidate => candidate.reasons.includes('prj-present-but-unconstructible')))
  // An explicit crs decision resolves the same file.
  const resolved = parseShapefileImport({ bytes, crs: 'EPSG:4326' })
  assert.equal(resolved.kind, 'ready')
})

test('an explicit crs overrides a constructible .prj with an honest warning', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['x']],
    prj: CGCS2000_CM117_WKT,
  })
  const outcome = parseShapefileImport({ bytes, crs: 'EPSG:4326' })
  assert.equal(outcome.kind, 'ready')
  assert.ok(outcome.admission.warnings.includes('prj-overridden-by-explicit-crs'))
  assert.deepEqual(outcome.geojson.features[0].geometry.coordinates, [116.4, 39.9])
})

test('unknown extra ZIP entries are ignored and reported', () => {
  const base = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['x']],
  })
  const packed = zipOf([
    { name: 'layer.shp', data: extract(base, 'layer.shp') },
    { name: 'layer.shx', data: extract(base, 'layer.shx') },
    { name: 'layer.dbf', data: extract(base, 'layer.dbf') },
    { name: 'readme.txt', data: Buffer.from('note') },
  ])
  const outcome = parseShapefileImport({ bytes: packed, crs: 'EPSG:4326' })
  assert.equal(outcome.kind, 'ready')
  assert.deepEqual(outcome.admission.warnings, ['ignored-zip-entries:1'])
})

/** Extract one entry payload from a stored-method ZIP (test helper). */
function extract(zip, name) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let offset = 0
  while (view.getUint32(offset, true) === 0x04034b50) {
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const size = view.getUint32(offset + 18, true)
    const entryName = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    if (entryName === name) return zip.subarray(offset + 30 + nameLength + extraLength, offset + 30 + nameLength + extraLength + size)
    offset += 30 + nameLength + extraLength + size
  }
  throw new Error(`entry ${name} not found`)
}

test('a missing .shx refuses as an incomplete component set', () => {
  const base = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['x']],
  })
  const packed = zipOf([
    { name: 'layer.shp', data: extract(base, 'layer.shp') },
    { name: 'layer.dbf', data: extract(base, 'layer.dbf') },
  ])
  assert.throws(
    () => parseShapefileImport({ bytes: packed, crs: 'EPSG:4326' }),
    /IMPORT_FORMAT_INVALID: shapefile ZIP must carry exactly one matching \.shp\/\.shx\/\.dbf set/,
  )
})

test('a truncated .shp refuses loudly instead of parsing shorter', () => {
  const shp = buildShp(SHAPE_TYPES.point, [[116.4, 39.9], [121.47, 31.23]])
  const truncated = shp.bytes.subarray(0, shp.bytes.length - 12)
  const packed = zipOf([
    { name: 'layer.shp', data: truncated },
    { name: 'layer.shx', data: buildShx(shp.recordOffsets) },
    { name: 'layer.dbf', data: buildDbf({ fields: [{ name: 'name', type: 'C', length: 4 }], rows: [['a'], ['b']] }) },
  ])
  assert.throws(
    () => parseShapefileImport({ bytes: packed, crs: 'EPSG:4326' }),
    /IMPORT_FORMAT_INVALID: shapefile ZIP is malformed \(\.shp record chain\)/,
  )
})

test('a traversal entry name refuses before any extraction', () => {
  const base = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['x']],
  })
  const packed = zipOf([
    { name: '../evil.shp', data: extract(base, 'layer.shp') },
    { name: 'layer.shx', data: extract(base, 'layer.shx') },
    { name: 'layer.dbf', data: extract(base, 'layer.dbf') },
  ])
  assert.throws(
    () => parseShapefileImport({ bytes: packed, crs: 'EPSG:4326' }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /IMPORT_FORMAT_INVALID.*traverses outside the archive/)
      assert.equal(error.message.includes(process.cwd()), false)
      return true
    },
  )
})

test('entry count beyond 16 refuses with the budget named', () => {
  const entries = []
  for (let index = 0; index < 17; index += 1) entries.push({ name: `f${index}.txt`, data: Buffer.from('x') })
  assert.throws(
    () => parseShapefileImport({ bytes: zipOf(entries), crs: 'EPSG:4326' }),
    /RESOURCE_TOO_LARGE: shapefile ZIP exceeds the 16 entry limit/,
  )
})

test('declared decompressed totals beyond 32 MiB refuse before extraction', () => {
  const base = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['x']],
  })
  const packed = zipOf([
    { name: 'layer.shp', data: extract(base, 'layer.shp'), declaredSize: 33 * 1024 * 1024 },
  ])
  assert.throws(
    () => parseShapefileImport({ bytes: packed, crs: 'EPSG:4326' }),
    /RESOURCE_TOO_LARGE: shapefile ZIP declares \d+ decompressed bytes/,
  )
})

test('a stored entry lying about its size refuses as malformed', () => {
  const base = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['x']],
  })
  const packed = zipOf([
    { name: 'layer.shp', data: extract(base, 'layer.shp'), declaredSize: 4 },
    { name: 'layer.shx', data: extract(base, 'layer.shx') },
    { name: 'layer.dbf', data: extract(base, 'layer.dbf') },
  ])
  assert.throws(
    () => parseShapefileImport({ bytes: packed, crs: 'EPSG:4326' }),
    /IMPORT_FORMAT_INVALID: shapefile ZIP is malformed \(declared size of "layer\.shp"\)/,
  )
})

test('an unknown LDID byte refuses naming the byte, asking for a .cpg', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['x']],
    ldid: 0x77,
  })
  assert.throws(
    () => parseShapefileImport({ bytes, crs: 'EPSG:4326' }),
    /IMPORT_ENCODING_INVALID: DBF language driver id 0x77 has no known encoding; supply a \.cpg/,
  )
})

test('undecodable DBF bytes under the fallback UTF-8 attempt refuse', () => {
  const dbf = buildDbf({ fields: [{ name: 'name', type: 'C', length: 4 }], rows: [[Uint8Array.from([0xBC, 0xD7])]] })
  const shp = buildShp(SHAPE_TYPES.point, [[116.4, 39.9]])
  const packed = zipOf([
    { name: 'layer.shp', data: shp.bytes },
    { name: 'layer.shx', data: buildShx(shp.recordOffsets) },
    { name: 'layer.dbf', data: dbf },
  ])
  assert.throws(
    () => parseShapefileImport({ bytes: packed, crs: 'EPSG:4326' }),
    /IMPORT_ENCODING_INVALID: DBF content cannot be decoded as utf-8; supply a \.cpg/,
  )
})

test('a bogus .cpg label refuses naming the label', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['x']],
    cpg: 'not-a-codec',
  })
  assert.throws(
    () => parseShapefileImport({ bytes, crs: 'EPSG:4326' }),
    /IMPORT_ENCODING_INVALID: shapefile \.cpg declares unsupported encoding "not-a-codec"/,
  )
})

test('memo fields refuse with a stable message', () => {
  const shp = buildShp(SHAPE_TYPES.point, [[116.4, 39.9]])
  const dbf = buildDbf({ fields: [{ name: 'note', type: 'M', length: 10 }], rows: [['memo-ish']] })
  const packed = zipOf([
    { name: 'layer.shp', data: shp.bytes },
    { name: 'layer.shx', data: buildShx(shp.recordOffsets) },
    { name: 'layer.dbf', data: dbf },
  ])
  assert.throws(
    () => parseShapefileImport({ bytes: packed, crs: 'EPSG:4326' }),
    /IMPORT_FORMAT_INVALID: DBF memo fields are not supported/,
  )
})

test('the feature budget refuses beyond 10000 records', () => {
  const geometries = []
  for (let index = 0; index < 10_001; index += 1) geometries.push([(index % 180) - 90, (index % 90) - 45])
  const shp = buildShp(SHAPE_TYPES.point, geometries)
  const dbf = buildDbf({ fields: [{ name: 'name', type: 'C', length: 4 }], rows: geometries.map(() => ['x']) })
  const packed = zipOf([
    { name: 'layer.shp', data: shp.bytes },
    { name: 'layer.shx', data: buildShx(shp.recordOffsets) },
    { name: 'layer.dbf', data: dbf },
  ])
  assert.throws(
    () => parseShapefileImport({ bytes: packed, crs: 'EPSG:4326' }),
    /RESOURCE_TOO_LARGE: shapefile exceeds the 10000 feature limit/,
  )
})

test('the fingerprint binds the CRS decision inputs to the exact content', () => {
  const bytes = shapefileZip({
    shapeType: SHAPE_TYPES.point,
    geometries: [[116.4, 39.9]],
    fields: [{ name: 'name', type: 'C', length: 4 }],
    rows: [['x']],
  })
  const first = parseShapefileImport({ bytes })
  const second = parseShapefileImport({ bytes })
  const changed = parseShapefileImport({
    bytes: shapefileZip({
      shapeType: SHAPE_TYPES.point,
      geometries: [[121.47, 31.23]],
      fields: [{ name: 'name', type: 'C', length: 4 }],
      rows: [['x']],
    }),
  })
  assert.ok(first.kind === 'needs_confirmation' && second.kind === 'needs_confirmation' && changed.kind === 'needs_confirmation')
  assert.equal(second.admission.candidatesFingerprint, first.admission.candidatesFingerprint)
  assert.notEqual(changed.admission.candidatesFingerprint, first.admission.candidatesFingerprint)
})
