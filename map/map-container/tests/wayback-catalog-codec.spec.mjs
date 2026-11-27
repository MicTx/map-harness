import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WAYBACK_CONFIG_URL,
  WAYBACK_ENDPOINT,
  WaybackCatalogDecodeError,
  decodeWaybackCatalog,
  decodeWaybackCatalogItems,
  normalizeWaybackCatalogItem,
} from '../src/wayback-catalog-codec.ts'

const itemId = digit => digit.repeat(32).slice(-32)
const entry = (release, date, digit = 'a', meta = digit === 'a' ? 'b' : 'c') => ({
  itemTitle: `World Imagery (Wayback ${date})`,
  releaseDateLabel: date,
  itemID: itemId(digit),
  itemURL: `${WAYBACK_ENDPOINT}/tile/${release}/{level}/{row}/{col}`,
  metadataLayerUrl: `https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_${date.slice(0, 4)}_r01/MapServer`,
  metadataLayerItemID: itemId(meta), // distinct from itemID unless two releases share a digit
  layerIdentifier: `WB_${date.slice(0, 4)}_R01`,
})
const official = (...releases) => JSON.stringify(Object.fromEntries(releases.map(([id, date, ...rest]) => [String(id), entry(id, date, ...rest)])))

test('fixed public endpoints are the official config URL and WMTS endpoint', () => {
  assert.equal(WAYBACK_CONFIG_URL, 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json')
  assert.equal(WAYBACK_ENDPOINT, 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer')
})

test('decodes the official config into newest-first frozen releases with intact item fields', () => {
  const catalog = decodeWaybackCatalog(official([10, '2014-02-20', 'b'], [50, '2025-10-29', 'a']))
  assert.deepEqual(catalog.releases.map(release => release.releaseId), [50, 10])
  assert.deepEqual(catalog.releases[0], {
    releaseId: 50, itemId: itemId('a'), title: 'World Imagery (Wayback 2025-10-29)', publishedAt: '2025-10-29',
    layerIdentifier: 'WB_2025_R01', acquiredAt: null,
  })
  assert.deepEqual(Object.keys(catalog.items[0]), ['releaseNum', 'itemID', 'itemTitle', 'releaseDateLabel', 'layerIdentifier', 'itemURL', 'metadataLayerUrl', 'metadataLayerItemID'])
  assert.equal(catalog.items[0].itemURL, `${WAYBACK_ENDPOINT}/tile/50/{level}/{row}/{col}`)
  assert.ok(Object.isFrozen(catalog.releases) && Object.isFrozen(catalog.releases[0]) && Object.isFrozen(catalog.items[0]))
  assert.equal(catalog.digest, decodeWaybackCatalog(official([10, '2014-02-20', 'b'], [50, '2025-10-29', 'a'])).digest)
  assert.match(catalog.digest, /^[0-9a-f]{8}$/)
  assert.equal(catalog.digest, decodeWaybackCatalog(official([50, '2025-10-29', 'a'], [10, '2014-02-20', 'b'])).digest)
})

test('two releases sharing a date sort by ascending release id', () => {
  const catalog = decodeWaybackCatalog(official([20, '2020-01-01', 'd', 'e'], [10, '2020-01-01', 'a'], [30, '2019-01-01', 'f', '0']))
  assert.deepEqual(catalog.releases.map(release => release.releaseId), [10, 20, 30])
})

const damaged = [
  ['non-JSON body', '{', 'malformed'],
  ['non-object body', '[]', 'shape'],
  ['null body', 'null', 'shape'],
  ['empty catalog', '{}', 'count'],
  ['non-numeric keys only', JSON.stringify({ foo: entry(1, '2014-02-20'), bar: 2 }), 'count'],
  ['entry is an array', JSON.stringify({ 10: [] }), 'shape'],
  ['missing metadata item id', JSON.stringify({ 10: { ...entry(10, '2014-02-20'), metadataLayerItemID: undefined } }), 'shape'],
  ['non-string metadata layer url', JSON.stringify({ 10: { ...entry(10, '2014-02-20'), metadataLayerUrl: 5 } }), 'shape'],
  ['impossible release date', JSON.stringify({ 10: entry(10, '2019-02-30') }), 'date'],
  ['title without a date', JSON.stringify({ 10: { ...entry(10, '2014-02-20'), itemTitle: 'World Imagery' } }), 'shape'],
  ['control character in title', JSON.stringify({ 10: { ...entry(10, '2014-02-20'), itemTitle: 'World Imagery (Wayback 2014-02-20)\n' } }), 'shape'],
  ['oversized title', JSON.stringify({ 10: { ...entry(10, '2014-02-20'), itemTitle: `World Imagery (Wayback 2014-02-20)${'x'.repeat(300)}` } }), 'shape'],
]
for (const [name, body, reason] of damaged) {
  test(`rejects ${name} with reason ${reason}`, () => {
    assert.throws(() => decodeWaybackCatalog(body), error => error instanceof WaybackCatalogDecodeError && error.reason === reason)
  })
}

test('allows different imagery releases to share metadata', () => {
  const batch = decodeWaybackCatalog(official([10, '2014-02-20', 'b', 'c'], [11, '2015-02-20', 'd', 'c']))
  assert.equal(batch.releases.length, 2)
})

const listDamaged = [
  ['duplicate item ids', [[10, '2014-02-20', 'a'], [11, '2015-02-20', 'a']], 'duplicate'],
  ['zero release id', [[0, '2014-02-20', 'a']], 'shape'],
  ['fractional release id', [[1.5, '2014-02-20', 'a']], 'shape'],
]
for (const [name, releases, reason] of listDamaged) {
  test(`rejects ${name} with reason ${reason}`, () => {
    assert.throws(() => decodeWaybackCatalog(official(...releases)), error => error instanceof WaybackCatalogDecodeError && error.reason === reason)
  })
}

test('rejects a tile URL that leaves the fixed endpoint and a foreign metadata host', () => {
  const foreignTile = JSON.stringify({ 10: { ...entry(10, '2014-02-20'), itemURL: 'https://example.com/tile/10/{level}/{row}/{col}' } })
  assert.throws(() => decodeWaybackCatalog(foreignTile), error => error.reason === 'endpoint')
  const foreignMetadata = JSON.stringify({ 10: { ...entry(10, '2014-02-20'), metadataLayerUrl: 'https://metadata.example.com/arcgis/rest/services/World_Imagery_Metadata_2014_r01/MapServer' } })
  assert.throws(() => decodeWaybackCatalog(foreignMetadata), error => error.reason === 'endpoint')
  const searched = JSON.stringify({ 10: { ...entry(10, '2014-02-20'), itemURL: `${WAYBACK_ENDPOINT}/tile/10/{level}/{row}/{col}?x=1` } })
  assert.throws(() => decodeWaybackCatalog(searched), error => error.reason === 'endpoint')
})

test('requires an intact batch of 1..256 numeric entries', () => {
  const hex = index => index.toString(16).padStart(32, '0')
  const many = {}
  for (let index = 1; index <= 256; index += 1) {
    many[index] = { ...entry(index, '2014-02-20', 'a'), itemID: hex(index), metadataLayerItemID: hex(0x1000 + index) }
  }
  assert.equal(decodeWaybackCatalog(JSON.stringify(many)).releases.length, 256)
  const over = { ...many }
  over[257] = { ...entry(257, '2014-02-20', 'a'), itemID: hex(257), metadataLayerItemID: hex(0x1000 + 257) }
  assert.throws(() => decodeWaybackCatalog(JSON.stringify(over)), error => error.reason === 'count')
  assert.throws(() => decodeWaybackCatalog(official([10, '2014-02-20'], [11, '2015-02-20'], [12, 'x'])), error => error.reason === 'shape')
})

test('normalizeWaybackCatalogItem validates one entry and decodeWaybackCatalogItems validates a persisted list', () => {
  const normalized = normalizeWaybackCatalogItem({ releaseNum: '10', ...entry(10, '2014-02-20') })
  assert.equal(normalized.release.releaseId, 10)
  assert.equal(normalized.item.releaseNum, 10)
  assert.throws(() => normalizeWaybackCatalogItem({ releaseNum: '10.0', ...entry(10, '2014-02-20') }), error => error.reason === 'shape')
  assert.throws(() => normalizeWaybackCatalogItem(null), error => error.reason === 'shape')
  const items = decodeWaybackCatalogItems([{ releaseNum: 10, ...entry(10, '2014-02-20', 'a') }, { releaseNum: 50, ...entry(50, '2025-10-29', 'd') }]).items
  assert.deepEqual(decodeWaybackCatalogItems(items).releases.map(release => release.releaseId), [50, 10])
  assert.throws(() => decodeWaybackCatalogItems([]), error => error.reason === 'count')
  assert.throws(() => decodeWaybackCatalogItems([{ releaseNum: 10, ...entry(10, '2014-02-20', 'a') }, { releaseNum: 10, ...entry(10, '2015-02-20', 'b') }]), error => error.reason === 'duplicate')
  assert.throws(() => decodeWaybackCatalogItems({ 10: entry(10, '2014-02-20') }), error => error.reason === 'shape')
  assert.throws(() => decodeWaybackCatalogItems([{ ...items[0], extra: 1 }, items[1]]), error => error.reason === 'shape')
})
