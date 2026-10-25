/**
 * KML import admission fixtures for `data_import` (P1-L2): fixed-WGS84 KML
 * 2.2 parsing through `@xmldom/xmldom` + `@tmcw/togeojson`, ExtendedData and
 * CDATA properties, same-type MultiGeometry normalization to Multi*,
 * declaration/BOM encoding decode, external-reference non-execution with
 * honest warnings, and the shared GeoJSON admission for ranges and budgets.
 * All fixtures are synthetic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseKmlImport } from '../src/import-format/kml.ts'

/** Encode text as UTF-8 bytes. @param {string} text @returns {Uint8Array} */
const utf8 = (text) => new TextEncoder().encode(text)

/** Wrap one KML Document body in the KML 2.2 namespace envelope. */
const kmlOf = (body, declaration = '<?xml version="1.0" encoding="UTF-8"?>') =>
  `${declaration}<kml xmlns="http://www.opengis.net/kml/2.2"><Document>${body}</Document></kml>`

const PLACEMARK = '<Placemark><name>A</name><Point><coordinates>116.4,39.9</coordinates></Point></Placemark>'

/** GBK-encoded KML: `<?xml … encoding="GBK"?>` + placemark whose name is 甲. */
const GBK_KML = Uint8Array.from([
  ...utf8('<?xml version="1.0" encoding="GBK"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>'),
  0xBC, 0xD7,
  ...utf8('</name><Point><coordinates>116.4,39.9</coordinates></Point></Placemark></Document></kml>'),
])

test('a basic placemark parses to a ready Point feature with name properties', () => {
  const outcome = parseKmlImport({ bytes: utf8(kmlOf(PLACEMARK)) })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.format, 'kml')
  assert.equal(outcome.admission.encoding, 'utf-8')
  assert.equal(outcome.admission.nativeCrs, 'EPSG:4326')
  const feature = outcome.geojson.features[0]
  assert.equal(feature.geometry.type, 'Point')
  assert.deepEqual(feature.geometry.coordinates, [116.4, 39.9])
  assert.equal(feature.properties.name, 'A')
})

test('ExtendedData Data/SimpleData land in properties; CDATA unwraps; codes stay strings', () => {
  const body = '<Placemark><name>A</name>'
    + '<ExtendedData><Data name="pop"><value><![CDATA[1200 & rising]]></value></Data>'
    + '<SimpleData name="code">007001</SimpleData></ExtendedData>'
    + '<Point><coordinates>116.4,39.9</coordinates></Point></Placemark>'
  const outcome = parseKmlImport({ bytes: utf8(kmlOf(body)) })
  assert.equal(outcome.kind, 'ready')
  assert.deepEqual(outcome.geojson.features[0].properties, { name: 'A', pop: '1200 & rising', code: '007001' })
})

test('a same-type MultiGeometry normalizes to Multi* instead of GeometryCollection', () => {
  const body = '<Placemark><name>multi</name><MultiGeometry>'
    + '<Point><coordinates>116.4,39.9</coordinates></Point>'
    + '<Point><coordinates>121.47,31.23</coordinates></Point>'
    + '</MultiGeometry></Placemark>'
  const outcome = parseKmlImport({ bytes: utf8(kmlOf(body)) })
  assert.equal(outcome.kind, 'ready')
  const geometry = outcome.geojson.features[0].geometry
  assert.equal(geometry.type, 'MultiPoint')
  assert.deepEqual(geometry.coordinates, [[116.4, 39.9], [121.47, 31.23]])
})

test('LineString and Polygon placemarks survive with their types', () => {
  const body = '<Placemark><name>line</name><LineString><coordinates>116.4,39.9 117.0,40.0</coordinates></LineString></Placemark>'
    + '<Placemark><name>poly</name><Polygon><outerBoundaryIs><LinearRing><coordinates>116.4,39.9 116.5,39.9 116.5,40.0 116.4,39.9</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>'
  const outcome = parseKmlImport({ bytes: utf8(kmlOf(body)) })
  assert.equal(outcome.kind, 'ready')
  const [line, poly] = outcome.geojson.features
  assert.equal(line.geometry.type, 'LineString')
  assert.deepEqual(line.geometry.coordinates, [[116.4, 39.9], [117.0, 40.0]])
  assert.equal(poly.geometry.type, 'Polygon')
  assert.equal(poly.geometry.coordinates[0].length, 4)
})

test('a mixed-type MultiGeometry is left for the shared admission to refuse', () => {
  const body = '<Placemark><name>mixed</name><MultiGeometry>'
    + '<Point><coordinates>116.4,39.9</coordinates></Point>'
    + '<LineString><coordinates>116.4,39.9 117.0,40.0</coordinates></LineString>'
    + '</MultiGeometry></Placemark>'
  assert.throws(
    () => parseKmlImport({ bytes: utf8(kmlOf(body)) }),
    /GEOMETRY_UNSUPPORTED/,
  )
})

test('altitude triples are preserved as three-element positions', () => {
  const outcome = parseKmlImport({ bytes: utf8(kmlOf('<Placemark><name>alt</name><Point><coordinates>116.4,39.9,100</coordinates></Point></Placemark>')) })
  assert.equal(outcome.kind, 'ready')
  assert.deepEqual(outcome.geojson.features[0].geometry.coordinates, [116.4, 39.9, 100])
})

test('UTF-8 BOM is sniffed without a declaration', () => {
  const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...utf8(kmlOf(PLACEMARK, ''))])
  const outcome = parseKmlImport({ bytes })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.encoding, 'utf-8')
  assert.equal(outcome.geojson.features.length, 1)
})

test('a declared GBK encoding decodes Chinese content', () => {
  const outcome = parseKmlImport({ bytes: GBK_KML })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.admission.encoding, 'gbk')
  assert.equal(outcome.geojson.features[0].properties.name, '甲')
})

test('NetworkLink and external icon hrefs are never followed and are reported as warnings', () => {
  const body = PLACEMARK
    + '<NetworkLink><name>remote</name><Link><href>http://example.invalid/other.kml</href></Link></NetworkLink>'
    + '<Style><IconStyle><Icon><href>http://example.invalid/icon.png</href></Icon></IconStyle></Style>'
  const outcome = parseKmlImport({ bytes: utf8(kmlOf(body)) })
  assert.equal(outcome.kind, 'ready')
  assert.ok(outcome.admission.warnings.some(warning => warning.startsWith('ignored-external-refs:')))
  assert.equal(outcome.admission.warnings.includes('ignored-external-refs:2'), true)
  // The NetworkLink itself stays as an honest null-geometry feature; only its
  // href is never dereferenced.
  assert.equal(outcome.geojson.features.length, 2)
  assert.equal(outcome.geojson.features[0].geometry.type, 'Point')
  assert.equal(outcome.geojson.features[1].geometry, null)
  assert.equal(outcome.geojson.features[1].properties.name, 'remote')
})

test('a document without placemarks is ready with zero features', () => {
  const outcome = parseKmlImport({ bytes: utf8(kmlOf('<name>empty</name>')) })
  assert.equal(outcome.kind, 'ready')
  assert.equal(outcome.geojson.features.length, 0)
})

test('truncated XML refuses as malformed', () => {
  const truncated = utf8(kmlOf(PLACEMARK)).slice(0, 60)
  assert.throws(
    () => parseKmlImport({ bytes: truncated }),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /^IMPORT_FORMAT_INVALID: KML is not well-formed/)
      assert.equal(error.message.includes(process.cwd()), false)
      return true
    },
  )
})

test('undefined entity references refuse as malformed XML', () => {
  assert.throws(
    () => parseKmlImport({ bytes: utf8(kmlOf('<Placemark><name>&bogus;</name><Point><coordinates>116.4,39.9</coordinates></Point></Placemark>')) }),
    /IMPORT_FORMAT_INVALID: KML is not well-formed/,
  )
})

test('a DOCTYPE declaration is rejected before parsing', () => {
  const doctype = '<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
    + '<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark><name>&xxe;</name>'
    + '<Point><coordinates>116.4,39.9</coordinates></Point></Placemark></Document></kml>'
  assert.throws(
    () => parseKmlImport({ bytes: utf8(doctype) }),
    /IMPORT_FORMAT_INVALID: KML must not carry a DTD/,
  )
})

test('an explicit crs parameter refuses: KML is fixed to WGS84', () => {
  assert.throws(
    () => parseKmlImport({ bytes: utf8(kmlOf(PLACEMARK)), crs: 'EPSG:4326' }),
    /INVALID_ARGUMENT: KML is fixed to WGS84/,
  )
})

test('out-of-range coordinates refuse through the shared admission', () => {
  assert.throws(
    () => parseKmlImport({ bytes: utf8(kmlOf('<Placemark><name>x</name><Point><coordinates>200,39.9</coordinates></Point></Placemark>')) }),
    /INVALID_GEOJSON: GeoJSON coordinate is outside the WGS84 range/,
  )
})

test('an unknown declared encoding label refuses with the label named', () => {
  assert.throws(
    () => parseKmlImport({ bytes: utf8(kmlOf(PLACEMARK, '<?xml version="1.0" encoding="not-a-codec"?>')) }),
    /IMPORT_ENCODING_INVALID: KML declares unsupported encoding "not-a-codec"/,
  )
})

test('the placemark budget refuses beyond 10000 placemarks', () => {
  const placemarks = []
  for (let index = 0; index < 10_001; index += 1) {
    placemarks.push(`<Placemark><name>p${index}</name><Point><coordinates>116.4,39.9</coordinates></Point></Placemark>`)
  }
  assert.throws(
    () => parseKmlImport({ bytes: utf8(kmlOf(placemarks.join(''))) }),
    /RESOURCE_TOO_LARGE: KML exceeds the 10000 placemark limit/,
  )
})

test('the fingerprint is stable for identical bytes and bound to content', () => {
  const bytes = utf8(kmlOf(PLACEMARK))
  const first = parseKmlImport({ bytes })
  const second = parseKmlImport({ bytes })
  const changed = parseKmlImport({ bytes: utf8(kmlOf(PLACEMARK.replace('116.4', '121.47'))) })
  assert.ok(first.kind === 'ready' && second.kind === 'ready' && changed.kind === 'ready')
  assert.equal(second.admission.candidatesFingerprint, first.admission.candidatesFingerprint)
  assert.notEqual(changed.admission.candidatesFingerprint, first.admission.candidatesFingerprint)
})
