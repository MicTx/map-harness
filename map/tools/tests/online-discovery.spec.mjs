/** Loopback wire and accepted-call registration tests for online spatial data. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import * as connectPlugin from '../../spatial-connect/src/plugin.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpatialSearch, resolveSearchConfig } from '../../spatial-connect/src/search.ts'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as catalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { catalogRegister, catalogResolve } from '../src/catalog-tools.ts'
import { mapAddLayer } from '../src/map-tools.ts'
import { dataExport } from '../src/data-tools.ts'
import { decodeDataExportMeta } from '../src/data-meta.ts'

async function fixture(t, handler, overrides = {}) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const service = createSpatialSearch(resolveSearchConfig({ apiKeyEnv: 'FIXTURE_SEARCH_KEY', baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 2000, ...overrides }, { FIXTURE_SEARCH_KEY: 'test-only-search-key' }))
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return service
}

function json(response, value, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(value))
}

const POIS = [{ name: '医院甲', lonlat: '116.4,39.9', address: '样例路1号' }, { name: '医院乙', lonlat: '116.41,39.91' }]

test('Tianditu search sends bounded native-CRS queries and returns deduplicated candidates with pagination', async t => {
  let requestCount = 0
  const service = await fixture(t, (request, response) => {
    const url = new URL(request.url, 'http://fixture')
    assert.equal(url.pathname, '/v2/search')
    assert.equal(url.searchParams.get('type'), 'query')
    assert.equal(url.searchParams.get('tk'), 'test-only-search-key')
    const args = JSON.parse(url.searchParams.get('postStr'))
    assert.equal(args.queryType, 2)
    assert.equal(args.mapBound, '116,39,117,40')
    assert.equal(args.start, 4)
    assert.equal(args.count, 3)
    assert.equal(args.level, 12)
    requestCount++
    json(response, { status: { infocode: 1000 }, count: '8', pois: [...POIS, POIS[0]] })
  })
  const result = await service.search({ kind: 'search', query: '医院', bbox: [116, 39, 117, 40], limit: 3, offset: 4 })
  assert.equal(result.nativeCrs, 'EPSG:4490')
  assert.equal(result.data.features.length, 2)
  assert.equal(result.hasMore, true)
  assert.equal(result.nextOffset, 7, 'pagination counts vendor rows, not deduplicated rows')
  assert.equal(result.total, 8)
  assert.equal(requestCount, 1)
  assert.ok(!JSON.stringify(result).includes('test-only-search-key'))
})

test('geocode, reverse and district boundaries retain their actual geometry semantics', async t => {
  const service = await fixture(t, (request, response) => {
    const url = new URL(request.url, 'http://fixture')
    if (url.pathname === '/administrative') {
      return json(response, { returncode: '100', data: [{ name: '样例区', cityCode: '156110108', lonlat: '116.4,39.9', points: '116,39;117,39;117,40;116,40;116,39' }] })
    }
    if (url.searchParams.has('ds')) {
      assert.equal(url.searchParams.get('type'), null)
      assert.equal(JSON.parse(url.searchParams.get('ds')).keyWord, '样例地址')
      return json(response, { status: '0', location: { lon: 116.4, lat: 39.9 } })
    }
    assert.equal(url.searchParams.get('type'), 'geocode')
    assert.equal(JSON.parse(url.searchParams.get('postStr')).lon, 116.4)
    json(response, { status: '0', result: { formatted_address: '样例地址' } })
  })
  const point = await service.search({ kind: 'geocode', query: '样例地址' })
  assert.deepEqual(point.data.features[0].geometry.coordinates, [116.4, 39.9])
  assert.ok(point.limitations.some(value => value.includes('unique')))
  const reverse = await service.search({ kind: 'reverse', point: [116.4, 39.9] })
  assert.equal(reverse.data.features[0].properties.name, '样例地址')
  const district = await service.search({ kind: 'district', query: '样例区', boundary: true })
  assert.equal(district.data.features[0].geometry.type, 'Polygon')
  assert.equal(district.data.features[0].properties.geometry_role, 'administrative-boundary')
})

test('invalid geometry, vendor refusal, oversized replies and redirects never become successful data', async t => {
  let responseBody = { count: 1, pois: [{ name: 'bad', lonlat: '190,95' }] }
  let status = 200
  const service = await fixture(t, (_request, response) => json(response, responseBody, status), { maxResponseBytes: 1024 })
  const input = { kind: 'search', query: '医院', region: '156110000' }
  await assert.rejects(service.search(input), /SEARCH_RESPONSE_INVALID/)
  responseBody = { status: { infocode: 403 }, msg: 'test-only-search-key' }
  await assert.rejects(service.search(input), error => /SEARCH_AUTH_DENIED/.test(error.message) && !error.message.includes('test-only-search-key'))
  status = 429
  await assert.rejects(service.search(input), /SEARCH_RATE_LIMITED/)
  status = 200
  responseBody = { data: 'x'.repeat(2048) }
  await assert.rejects(service.search(input), /SEARCH_TOO_LARGE/)
  const redirects = await fixture(t, (_request, response) => { response.writeHead(302, { Location: 'https://example.invalid/leak' }); response.end() })
  await assert.rejects(redirects.search(input), /SEARCH_UNAVAILABLE/)
})

test('request validation rejects missing area, ambiguous area, invalid limits and arbitrary endpoint injection', async t => {
  let requests = 0
  const service = await fixture(t, (_request, response) => { requests++; json(response, { count: '0', pois: [] }) })
  for (const input of [null, {}, { kind: 'search', query: 'a' }, { kind: 'search', query: 'a', region: '156110000', bbox: [0, 0, 1, 1] }, { kind: 'search', query: 'a', region: '156110000', limit: 21 }, { kind: 'reverse', point: [200, 0] }, { kind: 'geocode', query: 'a', url: 'http://localhost' }]) {
    await assert.rejects(service.search(input), /SEARCH_INVALID_INPUT/)
  }
  assert.equal(requests, 0)
  assert.throws(() => resolveSearchConfig({ apiKeyEnv: 'MISSING' }, {}), /SEARCH_NOT_CONFIGURED/)
  assert.throws(() => resolveSearchConfig({ baseUrl: 'http://example.com', apiKeyEnv: 'K' }, { K: 'fixture' }), /SEARCH_INVALID_INPUT/)
  assert.throws(() => resolveSearchConfig({ baseUrl: 'https://user:secret@example.com', apiKeyEnv: 'K' }, { K: 'fixture' }), /SEARCH_INVALID_INPUT/)
})

test('deadlines, cancellation, disposal and concurrency settle owned requests without fabricated results', { timeout: 10000 }, async t => {
  let started
  const arrived = new Promise(resolve => { started = resolve })
  const service = await fixture(t, () => { started() }, { timeoutMs: 1000, maxConcurrent: 1 })
  const controller = new AbortController()
  const pending = service.search({ kind: 'geocode', query: 'a' }, controller.signal)
  const rejected = assert.rejects(pending, /SEARCH_CANCELLED/)
  await arrived
  await assert.rejects(service.search({ kind: 'geocode', query: 'b' }), /SEARCH_RATE_LIMITED/)
  controller.abort()
  await rejected
  await assert.rejects(service.search({ kind: 'geocode', query: 'c' }), /SEARCH_TIMEOUT/)
  const parked = service.search({ kind: 'geocode', query: 'd' })
  const disposed = assert.rejects(parked, /SEARCH_CANCELLED/)
  await service.close()
  await disposed
  await assert.rejects(service.search({ kind: 'geocode', query: 'e' }), /SEARCH_DISPOSED/)
})

test('an unconfigured host reports missing search explicitly and disposal removes the service', async t => {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(connectPlugin, {})
  const service = ctx.get('spatialSearch')
  assert.ok(service)
  await assert.rejects(service.search({ kind: 'geocode', query: 'a' }), /SEARCH_NOT_CONFIGURED/)
  await ctx.fiber.dispose()
  assert.equal(ctx.get('spatialSearch'), undefined)
})

test('coordinate bounds apply across district features and to the closing ring vertex', async t => {
  let rows = [{ name: 'a', points: '0,0;1,0;1,1;0,0' }, { name: 'b', points: '2,2;3,2;3,3;2,2' }]
  const service = await fixture(t, (_request, response) => json(response, { returncode: '100', data: rows }), { maxCoordinates: 4 })
  await assert.rejects(service.search({ kind: 'district', query: 'x', boundary: true }), /SEARCH_TOO_LARGE/)
  rows = [{ name: 'a', points: '0,0;1,0;1,1;0,1' }]
  await assert.rejects(service.search({ kind: 'district', query: 'x', boundary: true }), /SEARCH_TOO_LARGE/)
})

test('online query registers an immutable catalog resource, loads it and retries without another network read', async t => {
  let requests = 0
  const service = await fixture(t, (_request, response) => { requests++; json(response, { count: 2, pois: POIS }) }, { timeoutMs: 1000 })
  const root = mkdtempSync(join(tmpdir(), 'map-online-register-'))
  const rig = await mapRig({ cwd: root })
  t.after(async () => { await rig.dispose(); rmSync(root, { recursive: true, force: true }) })
  await rig.ctx.plugin(catalogPlugin, { root: join(root, 'catalog') })
  rig.ctx.effect(() => rig.ctx.reflect.provide('spatialSearch', service))
  const session = rig.session('online')
  const online = { kind: 'search', query: '医院', region: '156110000' }
  const call = rig.call(session, 'register', 'catalog_register', { online, name: '医院' })
  const result = await catalogRegister.execute({ online, name: '医院' }, rig.exec(session, { callId: 'register' }))
  rig.result(session, call, { meta: result.meta })
  assert.equal(result.resource.featureCount, 2)
  assert.equal(result.resource.nativeCrs, 'EPSG:4490')
  assert.equal(result.source.provider, 'tianditu')
  assert.equal(result.preview.length, 2)
  const load = rig.call(session, 'load', 'map_add_layer', { ref: result.resource.ref })
  const loaded = await mapAddLayer.execute({ ref: result.resource.ref }, rig.exec(session, { callId: 'load' }))
  rig.result(session, load, { meta: loaded.meta })
  assert.equal(rig.state(session).layers[0].data.features.length, 2)
  rig.call(session, 'retry', 'catalog_register', { online, retry_of: call.seq })
  const retried = await catalogRegister.execute({ online, retry_of: call.seq }, rig.exec(session, { callId: 'retry' }))
  assert.equal(retried.resource.ref, result.resource.ref)
  assert.equal(requests, 1)
  const found = await catalogResolve.execute({ search: { name: '医院' } }, rig.exec(session))
  assert.equal(found.resources[0].ref, result.resource.ref)
  await assert.rejects(catalogRegister.execute({ online, path: 'file.geojson' }, rig.exec(session)), /exactly one/)
})

test('the POI chain runs end to end: search → register → resolve → layer → data_export', async t => {
  const service = await fixture(t, (_request, response) => { json(response, { count: 2, pois: POIS }) }, { timeoutMs: 1000 })
  const root = mkdtempSync(join(tmpdir(), 'map-online-export-'))
  const rig = await mapRig({ cwd: root })
  t.after(async () => { await rig.dispose(); rmSync(root, { recursive: true, force: true }) })
  await rig.ctx.plugin(catalogPlugin, { root: join(root, 'catalog') })
  rig.ctx.effect(() => rig.ctx.reflect.provide('spatialSearch', service))
  const session = rig.session('online-export')
  const online = { kind: 'search', query: '医院', bbox: [116, 39, 117, 40] }
  const register = rig.call(session, 'reg', 'catalog_register', { online, name: 'poi-链' })
  const registered = await catalogRegister.execute({ online, name: 'poi-链' }, rig.exec(session, { callId: 'reg' }))
  rig.result(session, register, { meta: registered.meta })
  const resolved = await catalogResolve.execute({ resource: registered.resource.ref }, rig.exec(session, { callId: 'resolve' }))
  assert.equal(resolved.bundle.resourceRef, registered.resource.ref)
  const load = rig.call(session, 'load', 'map_add_layer', { ref: registered.resource.ref, layer_id: 'poi' })
  const loaded = await mapAddLayer.execute({ ref: registered.resource.ref, layer_id: 'poi' }, rig.exec(session, { callId: 'load' }))
  rig.result(session, load, { meta: loaded.meta })
  const exportCall = rig.call(session, 'export', 'data_export', { layer_id: 'poi', format: 'geojson' })
  const exported = await dataExport.execute({ layer_id: 'poi', format: 'geojson' }, rig.exec(session, { callId: 'export' }))
  rig.result(session, exportCall, { meta: exported.meta })
  assert.equal(exported.status, 'succeeded')
  assert.equal(exported.artifact.feature_count, 2)
  const meta = decodeDataExportMeta(dataExport.output.presentationMeta({}, exported))
  assert.equal(meta.meta.artifacts[0].sourceRef, registered.resource.ref)
})

test('pagination continues under one name: the next page publishes the next version', async t => {
  let page = 0
  const service = await fixture(t, (_request, response) => {
    page += 1
    if (page === 1) return json(response, { count: 4, pois: POIS })
    json(response, { count: 4, pois: [{ name: '医院丙', lonlat: '116.42,39.92', address: '样例路3号' }] })
  }, { timeoutMs: 1000 })
  const root = mkdtempSync(join(tmpdir(), 'map-online-page-'))
  const rig = await mapRig({ cwd: root })
  t.after(async () => { await rig.dispose(); rmSync(root, { recursive: true, force: true }) })
  await rig.ctx.plugin(catalogPlugin, { root: join(root, 'catalog') })
  rig.ctx.effect(() => rig.ctx.reflect.provide('spatialSearch', service))
  const session = rig.session('online-page')
  const firstCall = rig.call(session, 'p1', 'catalog_register', { online: { kind: 'search', query: '医院', bbox: [116, 39, 117, 40], limit: 2, offset: 0 }, name: '医院页' })
  const first = await catalogRegister.execute({ online: { kind: 'search', query: '医院', bbox: [116, 39, 117, 40], limit: 2, offset: 0 }, name: '医院页' }, rig.exec(session, { callId: 'p1' }))
  rig.result(session, firstCall, { meta: first.meta })
  assert.equal(first.source.has_more, true)
  assert.equal(first.source.next_offset, 2)
  const secondCall = rig.call(session, 'p2', 'catalog_register', { online: { kind: 'search', query: '医院', bbox: [116, 39, 117, 40], limit: 2, offset: first.source.next_offset }, name: '医院页' })
  const second = await catalogRegister.execute({ online: { kind: 'search', query: '医院', bbox: [116, 39, 117, 40], limit: 2, offset: first.source.next_offset }, name: '医院页' }, rig.exec(session, { callId: 'p2' }))
  rig.result(session, secondCall, { meta: second.meta })
  assert.match(second.resource.ref, /@v2$/, 'the next page is the next version of the same resource name')
  assert.equal(second.resource.ref.replace(/@v2$/, ''), first.resource.ref.replace(/@v1$/, ''))
  assert.equal(second.resource.featureCount, 1)
  const both = await catalogResolve.execute({ search: { name: '医院页', include_versions: true } }, rig.exec(session, { callId: 'p3' }))
  assert.equal(both.resources.length >= 2, true)
  assert.equal(page, 2)
})
