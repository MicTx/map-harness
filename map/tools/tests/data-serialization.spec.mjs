/**
 * Export-serialization round-trip fixtures for `data_export` (P1-L6):
 * every format's bytes re-enter through the import admission and come back
 * with equal coordinates and properties — geojson exact, shapefile exact
 * (float64 doubles, typed DBF fields), CSV through RFC 4180, KML per-part
 * with string-coerced ExtendedData. Mixed-geometry shapefile refusals list
 * per-type counts; over-wide DBF strings fail loudly naming the field.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serializeExport } from '../src/export-format/index.ts'
import { parseCsvImport } from '../src/import-format/csv.ts'
import { parseKmlImport } from '../src/import-format/kml.ts'
import { parseShapefileImport } from '../src/import-format/shapefile.ts'
import { loadGeoJsonString } from '../src/geo-source.ts'

const feature = (type, coordinates, properties) => ({ type: 'Feature', geometry: { type, coordinates }, properties })
const collectionOf = (features) => ({ type: 'FeatureCollection', features })

const POINTS = collectionOf([
  feature('Point', [116.4, 39.9], { name: '甲', code: '007001', score: 1.5, flag: true }),
  feature('Point', [121.47, 31.23], { name: 'second', code: '110101', score: 2, flag: false }),
])

test('geojson round-trips exactly, Multi parts and polygon holes included', () => {
  const mixed = collectionOf([
    feature('MultiPoint', [[116.4, 39.9], [121.47, 31.23]], { name: 'multi' }),
    feature('MultiLineString', [[[116.4, 39.9], [117.0, 40.0]], [[0, 0], [1, 1]]], { name: 'lines' }),
    feature('Polygon', [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]], [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]]], { name: 'holed' }),
    feature('MultiPolygon', [[[[10, 10], [10, 12], [12, 12], [12, 10], [10, 10]]], [[[20, 20], [20, 22], [22, 22], [22, 20], [20, 20]]]], { name: 'polys' }),
  ])
  const payload = serializeExport('geojson', mixed, { name: 'mixed' })
  assert.equal(payload.extension, 'geojson')
  const back = loadGeoJsonString(payload.bytes, 'EPSG:4326')
  assert.deepEqual(back, mixed)
})

test('csv round-trips points with RFC 4180 quoting and typed properties', () => {
  const tricky = collectionOf([
    feature('Point', [116.4, 39.9], { name: 'has, comma', note: 'line\nbreak and "quoted"', score: 1.5 }),
    feature('Point', [121.47, 31.23], { name: 'plain', note: 'x', score: 2 }),
  ])
  const payload = serializeExport('csv', tricky, { name: 'pts' })
  assert.equal(payload.bytes[0], 0xEF, 'UTF-8 BOM leads the CSV bytes')
  const outcome = parseCsvImport({ bytes: payload.bytes })
  assert.equal(outcome.kind, 'ready')
  assert.deepEqual(outcome.geojson.features[0].geometry.coordinates, [116.4, 39.9])
  assert.deepEqual(outcome.geojson.features[0].properties, { name: 'has, comma', note: 'line\nbreak and "quoted"', score: 1.5 })
  assert.deepEqual(outcome.geojson.features[1].properties, { name: 'plain', note: 'x', score: 2 })
})

test('csv export refuses line geometry instead of degrading it', () => {
  const lines = collectionOf([feature('LineString', [[0, 0], [1, 1]], { name: 'l' })])
  assert.throws(
    () => serializeExport('csv', lines, { name: 'l' }),
    /GEOMETRY_UNSUPPORTED: CSV export carries point data only/,
  )
})

test('kml per-part export round-trips Multi parts as separate features with equal coordinates', () => {
  const data = collectionOf([
    feature('MultiPoint', [[116.4, 39.9], [121.47, 31.23]], { name: 'two-dots', code: '007001' }),
    feature('Polygon', [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]], [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]]], { name: 'holed' }),
    feature('LineString', [[116.4, 39.9], [117.0, 40.0]], { name: 'line' }),
  ])
  const payload = serializeExport('kml', data, { name: 'k' })
  const outcome = parseKmlImport({ bytes: payload.bytes })
  assert.equal(outcome.kind, 'ready')
  const features = outcome.geojson.features
  // MultiPoint flattens to two Point placemarks; the polygon keeps its hole.
  assert.equal(features.length, 4)
  assert.deepEqual(features[0].geometry.coordinates, [116.4, 39.9])
  assert.deepEqual(features[1].geometry.coordinates, [121.47, 31.23])
  assert.equal(features[0].properties.name, 'two-dots')
  assert.equal(features[0].properties.code, '007001', 'ExtendedData keeps strings exact')
  const polygon = features[2].geometry
  assert.equal(polygon.type, 'Polygon')
  assert.equal(polygon.coordinates.length, 2, 'the hole survives as a second ring')
  assert.deepEqual(features[3].geometry.coordinates, [[116.4, 39.9], [117.0, 40.0]])
})

test('shapefile round-trips points exactly with typed properties', () => {
  const payload = serializeExport('shapefile', POINTS, { name: 'pts' })
  const outcome = parseShapefileImport({ bytes: payload.bytes })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.prjConclusion.proj4Constructible, true)
  assert.deepEqual(outcome.geojson.features[0].geometry.coordinates, [116.4, 39.9])
  assert.deepEqual(outcome.geojson.features[0].properties, { name: '甲', code: '007001', score: 1.5, flag: true })
  assert.deepEqual(outcome.geojson.features[1].properties, { name: 'second', code: '110101', score: 2, flag: false })
})

test('shapefile round-trips MultiPoint, MultiLineString parts, and polygon holes', () => {
  const data = collectionOf([
    feature('MultiPoint', [[116.4, 39.9], [121.47, 31.23]], { name: 'multi' }),
  ])
  const multiPoint = parseShapefileImport({ bytes: serializeExport('shapefile', data, { name: 'mp' }).bytes })
  assert.equal(multiPoint.kind, 'ready')
  assert.equal(multiPoint.geojson.features[0].geometry.type, 'MultiPoint')
  assert.deepEqual(multiPoint.geojson.features[0].geometry.coordinates, [[116.4, 39.9], [121.47, 31.23]])

  const lines = collectionOf([feature('MultiLineString', [[[116.4, 39.9], [117.0, 40.0]], [[0, 0], [1, 1]]], { name: 'lines' })])
  const multiLine = parseShapefileImport({ bytes: serializeExport('shapefile', lines, { name: 'ml' }).bytes })
  assert.equal(multiLine.kind, 'ready')
  assert.equal(multiLine.geojson.features[0].geometry.type, 'MultiLineString')
  assert.deepEqual(multiLine.geojson.features[0].geometry.coordinates, [[[116.4, 39.9], [117.0, 40.0]], [[0, 0], [1, 1]]])

  const holed = collectionOf([feature('Polygon', [[[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]], [[0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5], [0.5, 0.5]]], { name: 'holed' })])
  const polygon = parseShapefileImport({ bytes: serializeExport('shapefile', holed, { name: 'pg' }).bytes })
  assert.equal(polygon.kind, 'ready')
  const geometry = polygon.geojson.features[0].geometry
  assert.ok(geometry.type === 'Polygon' || geometry.type === 'MultiPolygon')
  const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates[0]
  assert.equal(rings.length, 2, 'the hole re-imports as a second ring')
  assert.deepEqual(rings[0].length, 5)

  const polys = collectionOf([feature('MultiPolygon', [[[[10, 10], [10, 12], [12, 12], [12, 10], [10, 10]]], [[[20, 20], [20, 22], [22, 22], [22, 20], [20, 20]]]], { name: 'two' })])
  const multiPolygon = parseShapefileImport({ bytes: serializeExport('shapefile', polys, { name: 'mpg' }).bytes })
  assert.equal(multiPolygon.kind, 'ready')
  assert.equal(multiPolygon.geojson.features[0].geometry.type, 'MultiPolygon')
  assert.equal(multiPolygon.geojson.features[0].geometry.coordinates.length, 2)
})

test('shapefile export refuses mixed geometry families with per-type counts', () => {
  const mixed = collectionOf([
    feature('Point', [116.4, 39.9], { name: 'p' }),
    feature('LineString', [[0, 0], [1, 1]], { name: 'l' }),
  ])
  assert.throws(
    () => serializeExport('shapefile', mixed, { name: 'mixed' }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /GEOMETRY_UNSUPPORTED: mixed geometry families cannot share one shapefile: Point:1, LineString:1/)
      return true
    },
  )
})

test('a DBF over-wide string fails loudly naming the field', () => {
  const wide = collectionOf([feature('Point', [116.4, 39.9], { name: 'x'.repeat(300) })])
  assert.throws(
    () => serializeExport('shapefile', wide, { name: 'w' }),
    /INVALID_ARGUMENT: property "name" needs 300 bytes, above the 254-byte dBASE field limit/,
  )
})

test('long property keys shorten to unique dBASE names and still round-trip values', () => {
  const data = collectionOf([feature('Point', [116.4, 39.9], {
    'very-long-property-key-number-one': 'first',
    'very-long-property-key-number-two': 'second',
    short: 3,
  })])
  const outcome = parseShapefileImport({ bytes: serializeExport('shapefile', data, { name: 'k' }).bytes })
  assert.equal(outcome.kind, 'ready')
  const properties = outcome.geojson.features[0].properties
  assert.equal(Object.keys(properties).length, 3)
  assert.ok(Object.values(properties).includes('first'))
  assert.ok(Object.values(properties).includes('second'))
  assert.ok(Object.values(properties).includes(3))
})
