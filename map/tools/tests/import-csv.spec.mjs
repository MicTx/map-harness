/**
 * CSV import admission fixtures for `data_import` (P1-L1): decode, RFC 4180
 * parsing, coordinate-column resolution (strong-alias auto-select, weak/range
 * candidates → needs_confirmation), property typing, CRS normalization through
 * the shared GeoJSON admission, budgets, and content-bound fingerprints. All
 * fixtures are synthetic; GBK bytes are pre-encoded literals verified against
 * Node's full-ICU TextDecoder.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsvImport } from '../src/import-format/csv.ts'

/** Encode text as UTF-8 bytes. @param {string} text @returns {Uint8Array} */
const utf8 = (text) => new TextEncoder().encode(text)

/** GBK-encoded `名称,经度,纬度` header + one data row `甲,116.4,39.9`. */
const GBK_CSV = Uint8Array.from([
  0xC3, 0xFB, 0xB3, 0xC6, 0x2C, 0xBE, 0xAD, 0xB6, 0xC8, 0x2C, 0xCE, 0xB3, 0xB6, 0xC8, 0x0A,
  0xBC, 0xD7, 0x2C, 0x31, 0x31, 0x36, 0x2E, 0x34, 0x2C, 0x33, 0x39, 0x2E, 0x39, 0x0A,
])

test('plain lon/lat headers parse to ready Point features with typed properties', () => {
  const outcome = parseCsvImport({ bytes: utf8('lon,lat,name,score\n116.4,39.9,first,1.5\n121.47,31.23,second,2\n') })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.format, 'csv')
  assert.equal(outcome.admission.encoding, 'utf-8')
  assert.equal(outcome.admission.nativeCrs, 'EPSG:4326')
  assert.equal(outcome.admission.columnMapping.lonColumn, 'lon')
  assert.equal(outcome.admission.columnMapping.latColumn, 'lat')
  assert.equal(outcome.geojson.features.length, 2)
  const first = outcome.geojson.features[0]
  assert.equal(first.geometry.type, 'Point')
  assert.deepEqual(first.geometry.coordinates, [116.4, 39.9])
  assert.deepEqual(first.properties, { name: 'first', score: 1.5 })
  assert.equal(outcome.geojson.features[1].properties.score, 2)
})

test('strong Chinese aliases 经度/纬度 auto-select; id column becomes feature.id', () => {
  const outcome = parseCsvImport({ bytes: utf8('编号,经度,纬度,备注\nA1,116.4,39.9,甲\nA2,121.47,31.23,乙\n') })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.columnMapping.lonColumn, '经度')
  assert.equal(outcome.admission.columnMapping.latColumn, '纬度')
  const [a, b] = outcome.geojson.features
  assert.equal(a.id, 'A1')
  assert.equal(b.id, 'A2')
  assert.deepEqual(a.properties, { 备注: '甲' })
})

test('UTF-8 BOM is sniffed and stripped without an explicit encoding', () => {
  const bytes = utf8('lon,lat\r\n116.4,39.9\r\n')
  const bombed = new Uint8Array([0xEF, 0xBB, 0xBF, ...bytes])
  const outcome = parseCsvImport({ bytes: bombed })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.encoding, 'utf-8')
  assert.deepEqual(outcome.geojson.features[0].geometry.coordinates, [116.4, 39.9])
})

test('explicit gbk encoding decodes Chinese headers and values', () => {
  const outcome = parseCsvImport({ bytes: GBK_CSV, encoding: 'gbk' })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.encoding, 'gbk')
  assert.equal(outcome.admission.columnMapping.lonColumn, '经度')
  const feature = outcome.geojson.features[0]
  assert.deepEqual(feature.geometry.coordinates, [116.4, 39.9])
  assert.deepEqual(feature.properties, { 名称: '甲' })
})

test('GBK bytes without an explicit encoding fail with a stable, path-free error', () => {
  assert.throws(
    () => parseCsvImport({ bytes: GBK_CSV }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^IMPORT_ENCODING_INVALID: CSV content cannot be decoded/)
      assert.equal(error.message.includes('/'), false)
      return true
    },
  )
})

test('RFC 4180 quoted fields: commas, escaped quotes, and embedded newlines survive', () => {
  const csv = 'lon,lat,label\n116.4,39.9,"has, comma"\n121.47,31.23,"line\nbreak and ""quoted"""\n'
  const outcome = parseCsvImport({ bytes: utf8(csv) })
  assert.equal(outcome.kind, 'ready')
  assert.deepEqual(outcome.geojson.features[0].properties, { label: 'has, comma' })
  assert.deepEqual(outcome.geojson.features[1].properties, { label: 'line\nbreak and "quoted"' })
})

test('weak x/y aliases alone do not auto-select; they surface as confirmation candidates', () => {
  const outcome = parseCsvImport({ bytes: utf8('x,y,v\n500000,4400000,1\n500100,4400100,2\n') })
  assert.equal(outcome.kind, 'needs_confirmation')
  const candidates = outcome.admission.columnCandidates
  assert.ok(candidates.lon.some(entry => entry.column === 'x'))
  assert.ok(candidates.lat.some(entry => entry.column === 'y'))
  assert.equal(outcome.admission.columnMapping, null)
  assert.match(outcome.admission.candidatesFingerprint, /^[0-9a-f]{64}$/)
})

test('two strong lon aliases are ambiguous: needs_confirmation lists both', () => {
  const outcome = parseCsvImport({ bytes: utf8('lon,longitude,lat\n116.4,116.4,39.9\n') })
  assert.equal(outcome.kind, 'needs_confirmation')
  const lonColumns = outcome.admission.columnCandidates.lon.map(entry => entry.column).sort()
  assert.deepEqual(lonColumns, ['lon', 'longitude'])
})

test('a header with no coordinate columns at all enters confirmation with empty candidates', () => {
  const outcome = parseCsvImport({ bytes: utf8('name,value\n甲,1\n乙,2\n') })
  assert.equal(outcome.kind, 'needs_confirmation')
  assert.deepEqual(outcome.admission.columnCandidates.lon, [])
  assert.deepEqual(outcome.admission.columnCandidates.lat, [])
})

test('explicit columns bypass confirmation; a missing explicit column refuses loudly', () => {
  const ready = parseCsvImport({ bytes: utf8('x,y,name\n116.4,39.9,甲\n'), lonColumn: 'x', latColumn: 'y' })
  assert.equal(ready.kind, 'ready')
  assert.deepEqual(ready.admission.columnMapping.reasons, ['explicit'])

  assert.throws(
    () => parseCsvImport({ bytes: utf8('a,b\n1,2\n'), lonColumn: 'missing', latColumn: 'b' }),
    /INVALID_ARGUMENT: lon column "missing" is not in the CSV header/,
  )
  assert.throws(
    () => parseCsvImport({ bytes: utf8('a,b\n1,2\n'), lonColumn: 'a' }),
    /INVALID_ARGUMENT: lon_column and lat_column are required together/,
  )
})

test('non-numeric coordinate cells refuse with the row and column named', () => {
  assert.throws(
    () => parseCsvImport({ bytes: utf8('lon,lat\n116.4,39.9\nnot-a-number,40\n') }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^IMPORT_FORMAT_INVALID: CSV row 2 column "lon"/)
      assert.equal(error.message.includes(process.cwd()), false)
      return true
    },
  )
})

test('rows with empty coordinate cells are dropped and counted, never silently kept', () => {
  const outcome = parseCsvImport({ bytes: utf8('lon,lat,name\n116.4,39.9,keep\n,39.9,drops\n121.47,,drops too\n') })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.geojson.features.length, 1)
  assert.deepEqual(outcome.admission.warnings, ['dropped-rows:2'])
})

test('WGS84 out-of-range coordinates refuse through the shared GeoJSON admission', () => {
  assert.throws(
    () => parseCsvImport({ bytes: utf8('lon,lat\n200,39.9\n') }),
    /INVALID_GEOJSON: GeoJSON coordinate is outside the WGS84 range/,
  )
})

test('declared projected CRS reprojects through proj4 to valid WGS84', () => {
  const outcome = parseCsvImport({
    bytes: utf8('x,y,name\n500000,4400000,gauss point\n'),
    crs: 'EPSG:4547',
    lonColumn: 'x',
    latColumn: 'y',
  })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.nativeCrs, 'EPSG:4547')
  const [lon, lat] = outcome.geojson.features[0].geometry.coordinates
  assert.ok(lon > 112 && lon < 116, `reprojected lon ${lon}`)
  assert.ok(lat > 38 && lat < 42, `reprojected lat ${lat}`)
})

test('an unknown declared CRS refuses with the stable CRS code', () => {
  assert.throws(
    () => parseCsvImport({ bytes: utf8('x,y\n1,2\n'), crs: 'EPSG:99999', lonColumn: 'x', latColumn: 'y' }),
    /CRS_UNKNOWN/,
  )
})

test('feature budget refuses beyond 10000 data rows', () => {
  const rows = ['lon,lat']
  for (let index = 0; index < 10_001; index += 1) rows.push(`116.${index % 10},39.9`)
  assert.throws(
    () => parseCsvImport({ bytes: utf8(`${rows.join('\n')}\n`) }),
    /RESOURCE_TOO_LARGE: CSV exceeds the 10000 feature limit/,
  )
})

test('the fingerprint binds candidates to the exact file content', () => {
  const first = parseCsvImport({ bytes: utf8('lon,longitude,lat\n116.4,116.4,39.9\n') })
  const second = parseCsvImport({ bytes: utf8('lon,longitude,lat\n116.4,116.4,39.9\n') })
  const changed = parseCsvImport({ bytes: utf8('lon,longitude,lat\n121.47,121.47,31.23\n') })
  assert.ok(first.kind === 'needs_confirmation' && second.kind === 'needs_confirmation' && changed.kind === 'needs_confirmation')
  assert.equal(second.admission.candidatesFingerprint, first.admission.candidatesFingerprint)
  assert.notEqual(changed.admission.candidatesFingerprint, first.admission.candidatesFingerprint)
})

test('a header-only CSV is ready with zero features; an empty file refuses', () => {
  const outcome = parseCsvImport({ bytes: utf8('lon,lat\n') })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.geojson.features.length, 0)
  assert.throws(
    () => parseCsvImport({ bytes: utf8('') }),
    /INVALID_ARGUMENT: CSV requires a header row/,
  )
})

test('ragged rows refuse as malformed CSV structure', () => {
  assert.throws(
    () => parseCsvImport({ bytes: utf8('lon,lat,name\n116.4,39.9\n') }),
    /IMPORT_FORMAT_INVALID: CSV structure is malformed/,
  )
})

test('leading-zero strings stay strings so administrative codes never corrupt', () => {
  const outcome = parseCsvImport({ bytes: utf8('lon,lat,code,flag,on\n116.4,39.9,007001,yes,true\n') })
  assert.equal(outcome.kind, 'ready')
  assert.deepEqual(outcome.geojson.features[0].properties, { code: '007001', flag: 'yes', on: true })
})
