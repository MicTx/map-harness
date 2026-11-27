import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseWaybackReleaseVerificationRequest, verifyWaybackRelease } from '../src/wayback-release-verification.ts'
import { SourceCatalogError } from '../src/source-error.ts'

/** Recorded official WMTS capabilities document. */
const official = readFileSync(new URL('./fixtures/wayback-capabilities.xml', import.meta.url))
const CAPABILITIES_URL = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetCapabilities'
const GENERIC_URL = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS'
const itemUrl = itemId => `https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`
const ITEM_URL = itemUrl('903f0abe9c3b452dafe1ca5b8dd858b9')
/** Official WMTS tile template, the item `data.templateUrl` form. */
const tileUrl = (release, protocol = 'https') =>
  `${protocol}://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/{TileMatrixSet}/MapServer/tile/${release}/{TileMatrix}/{TileRow}/{TileCol}`
/** Catalog form of the same fixed release, the older item `url` form. */
const catalogTileUrl = (release, protocol = 'https') =>
  `${protocol}://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${release}/{level}/{row}/{col}`
const titleOf = date => `World Imagery (Wayback ${date})`

/** Current official release in the recorded document. */
const request = { releaseId: 43291, itemId: '903f0abe9c3b452dafe1ca5b8dd858b9', layerIdentifier: 'WB_2026_R10', publishedAt: '2026-10-29' }

function item(overrides = {}, base = request) {
  return JSON.stringify({
    id: base.itemId, owner: 'esri_imagery', orgId: 'P3ePLMYs2RVChkJx', type: 'WMTS', access: 'public',
    title: titleOf(base.publishedAt), url: GENERIC_URL,
    // Observed on a current item: names another release and must never be consumed.
    data: { templateUrl: tileUrl(base.releaseId), wmtsInfo: { url: tileUrl(8249) } },
    ...overrides,
  })
}

function network(responses) {
  const calls = []
  return {
    calls,
    async request(input) {
      calls.push({ url: input.url.href, payload: input.payload, signal: input.signal })
      const body = responses[input.url.href]
      assert.notEqual(body, undefined, `unexpected request ${input.url.href}`)
      if (body instanceof Error) throw body
      return { status: 200, body: Buffer.from(body), contentType: input.payload === 'xml' ? 'text/xml' : 'application/json',
        cache: { etag: null, lastModified: null, cacheControl: null, date: null, age: null, expires: null, vary: null } }
    },
    dispose() {},
  }
}

const responses = (overrides, base = request, document = official) =>
  ({ [itemUrl(base.itemId)]: typeof overrides === 'string' ? overrides : item(overrides, base), [CAPABILITIES_URL]: document })
const ok = (overrides, base) => verifyWaybackRelease(base ?? request, network(responses(overrides, base)))

test('returns the canonical release with native WMTS metadata from two fixed https URLs', async () => {
  const payload = JSON.parse(item({ data: undefined }))
  const url = itemUrl(request.itemId)
  const dataUrl = url.replace('?f=json', '/data?f=json')
  const transport = network({ [url]: JSON.stringify(payload), [dataUrl]: JSON.stringify({ templateUrl: catalogTileUrl(43291), wmtsInfo: { url: tileUrl(8249) } }), [CAPABILITIES_URL]: official })
  const result = await verifyWaybackRelease(request, transport)
  assert.deepEqual(result.release, { ...request, title: titleOf(request.publishedAt), acquiredAt: null })
  assert.equal(result.wmts.nativeLayer, 'WB_2026_R10')
  assert.equal(result.wmts.matrices.length, 24)
  assert.equal(result.templateUrl, tileUrl(43291))
  assert.deepEqual(transport.calls.map(call => [call.url, call.payload]), [[ITEM_URL, 'json'], [dataUrl, 'json'], [CAPABILITIES_URL, 'xml']])
})

test('accepts an older item whose url is already the exact fixed tile URL, without fetching it', async () => {
  const older = { releaseId: 10, itemId: '0'.repeat(32), layerIdentifier: 'WB_2014_R01', publishedAt: '2014-02-20' }
  const transport = network(responses({ url: catalogTileUrl(10, 'http'), data: { templateUrl: tileUrl(10, 'http') } }, older))
  const result = await verifyWaybackRelease(older, transport)
  assert.deepEqual(result.release, { ...older, title: titleOf(older.publishedAt), acquiredAt: null })
  assert.equal(result.wmts.nativeLayer, 'WB_2014_R01')
  assert.equal(result.templateUrl, tileUrl(10))
  assert.deepEqual(transport.calls.map(call => call.url), [itemUrl(older.itemId), CAPABILITIES_URL])
})

test('accepts the documented release 15084 catalog and WMTS layer mismatch only', async () => {
  const special = { ...request, releaseId: 15084, layerIdentifier: 'WB_2015_R14', publishedAt: '2015-03-18' }
  const result = await verifyWaybackRelease(special, network(responses({}, special)))
  assert.equal(result.release.layerIdentifier, 'WB_2015_R14')
  assert.equal(result.wmts.nativeLayer, 'WB_2015_R04')
  // WB_2015_R14 is its own release with another date everywhere else.
  await assert.rejects(ok({}, { ...special, releaseId: 15083 }), { code: 'SOURCE_CHANGED' })
  await assert.rejects(ok({}, { ...request, releaseId: 15083, layerIdentifier: 'WB_2015_R04', publishedAt: '2015-03-18' }), { code: 'SOURCE_UNAVAILABLE' })
})

test('refuses a wrong portal item identity', async () => {
  for (const patch of [{ id: '0'.repeat(32) }, { owner: 'other_owner' }, { orgId: 'otherOrg' }, { type: 'Map Service' },
    { access: 'private' }, { access: 'org' }, { title: titleOf('2026-10-30') }, { title: 'World Imagery' },
    { url: tileUrl(8249) }, { url: catalogTileUrl(8249) }, { url: `${GENERIC_URL}/1.0.0` }, { url: 'https://example.com/World_Imagery/WMTS' }]) {
    await assert.rejects(ok(patch), { code: 'SOURCE_CHANGED' }, JSON.stringify(patch))
  }
})

test('refuses a published date that disagrees with the WMTS layer title', async () => {
  await assert.rejects(ok({}, { ...request, publishedAt: '2026-10-30' }), { code: 'SOURCE_CHANGED' })
})

test('refuses a newer or older release presented in the item template, ignoring wmtsInfo', async () => {
  for (const templateUrl of [tileUrl(8249), tileUrl(43300), `${tileUrl(43291)}/extra`, tileUrl(43291).replace('{TileMatrixSet}', 'other'),
    tileUrl(43291).replace('wayback.maptiles.arcgis.com', 'example.com'), `${tileUrl(43291)}?x=1`, `${tileUrl(43291)}#f`,
    `https://user:pw@wayback.maptiles.arcgis.com${new URL(tileUrl(43291)).pathname.replace(/%7B/g, '{').replace(/%7D/g, '}')}`,
    tileUrl(43291).replace('https:', 'ftp:')]) {
    await assert.rejects(ok({ data: { templateUrl } }), { code: 'SOURCE_CHANGED' }, templateUrl)
  }
})

test('refuses structurally unknown item data', async () => {
  const base = JSON.parse(item())
  const cases = ['null', '5', 'not json', '{}', JSON.stringify({ ...base, owner: 1 }), JSON.stringify({ ...base, title: undefined }),
    JSON.stringify({ ...base, access: undefined }), JSON.stringify({ ...base, url: 3692 }), JSON.stringify({ ...base, data: null }),
    JSON.stringify({ ...base, data: 'x' }), JSON.stringify({ ...base, data: {} }), JSON.stringify({ ...base, data: { templateUrl: 43291 } })]
  for (const body of cases) {
    await assert.rejects(verifyWaybackRelease(request, network(responses(body))), { code: 'SOURCE_UNAVAILABLE' }, body)
  }
})

test('refuses a capabilities document that does not carry this release and layer', async () => {
  const altered = [
    official.toString('utf8').replaceAll('tile/43291/', 'tile/8249/'),
    official.toString('utf8').replaceAll('<ows:Identifier>WB_2026_R10</ows:Identifier>', '<ows:Identifier>WB_1999_R99</ows:Identifier>'),
  ]
  for (const document of altered) {
    await assert.rejects(verifyWaybackRelease(request, network(responses({}, request, document))), { code: 'SOURCE_UNAVAILABLE' })
  }
  await assert.rejects(ok({}, { ...request, releaseId: 43290 }), { code: 'SOURCE_UNAVAILABLE' })
})

test('passes cancellation through and never contacts the tile or catalog hosts', async () => {
  const controller = new AbortController()
  const transport = network(responses())
  const pending = verifyWaybackRelease(request, transport, controller.signal)
  controller.abort()
  await assert.rejects(pending, { code: 'SOURCE_CANCELLED' })
  await assert.rejects(verifyWaybackRelease(request, transport, controller.signal), { code: 'SOURCE_CANCELLED' })
  assert.deepEqual(transport.calls.map(call => call.url), [ITEM_URL])
  assert.equal(transport.calls[0].signal, controller.signal)
  assert.equal(transport.calls.some(call => call.url.includes('amazonaws') || call.url.includes('/tile/')), false)
})

test('cancels while the item request is in flight without reading the capabilities document', async () => {
  const controller = new AbortController()
  const calls = []
  const hanging = {
    request(input) {
      calls.push([input.url.href, input.signal])
      return new Promise((resolve, reject) => {
        input.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    },
  }
  const pending = verifyWaybackRelease(request, hanging, controller.signal)
  controller.abort()
  await assert.rejects(pending, { code: 'SOURCE_CANCELLED' })
  assert.deepEqual(calls, [[ITEM_URL, controller.signal]])
})

test('propagates source failure without a second attempt', async () => {
  const failures = [[new Error('socket hang up'), 'SOURCE_UNAVAILABLE'], [new SourceCatalogError('SOURCE_TIMEOUT'), 'SOURCE_TIMEOUT']]
  for (const [error, code] of failures) {
    const transport = network({ [ITEM_URL]: error })
    await assert.rejects(verifyWaybackRelease(request, transport), { code })
    assert.deepEqual(transport.calls.map(call => call.url), [ITEM_URL])
  }
})

test('parses only a complete structural request', () => {
  assert.deepEqual(parseWaybackReleaseVerificationRequest({ ...request }), request)
  const bad = [null, 'x', 5, [], {}, { ...request, releaseId: '43291' }, { ...request, releaseId: 0 }, { ...request, releaseId: 1.5 },
    { ...request, itemId: '903F0ABE9C3B452DAFE1CA5B8DD858B9' }, { ...request, itemId: '../admin' }, { ...request, layerIdentifier: 'WB_2026_R1' },
    { ...request, layerIdentifier: 'WB_2026_R10x' }, { ...request, publishedAt: '2026-02-30' }, { ...request, publishedAt: '2026-1-09' },
    { ...request, publishedAt: 20261029 }, { ...request, extra: 1 }, { ...request, acquiredAt: '2026-01-01' }]
  for (const value of bad) {
    assert.throws(() => parseWaybackReleaseVerificationRequest(value), { code: 'SOURCE_CONFIG_INVALID' }, JSON.stringify(value))
  }
})
