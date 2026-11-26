/** Building-footprint retrieval: bounded Overpass query, strict decode, bounded retry, honest empty pages. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createSpatialFootprints, overpassQuery, decodeFootprint, decodeFootprints } from '../src/footprints.ts'
import { FootprintError, resolveFootprintRequest, resolveFootprintsConfig, SPATIAL_FOOTPRINTS_SERVICE } from '../src/footprints-contract.ts'
import { resolveSearchRequest } from '../src/search-contract.ts'

const BBOX = [87.51386, 43.83936, 87.51558, 43.84073]

function closedWay(id, name, building = 'retail', first = [87.514, 43.84]) {
  const [lon, lat] = first
  return {
    type: 'way', id, tags: { name, building, 'building:levels': '4' },
    geometry: [
      { lon, lat }, { lon: lon + 0.0004, lat }, { lon: lon + 0.0004, lat: lat + 0.0003 }, { lon, lat: lat + 0.0003 }, { lon, lat },
    ],
  }
}

async function fixture(t, handler) {
  const hits = []
  const http = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      hits.push({ method: request.method, data: new URLSearchParams(body).get('data') })
      handler(hits.length, response, hits.at(-1).data)
    })
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)) })
  return { baseUrl: `http://127.0.0.1:${http.address().port}`, hits }
}

function json(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

test('the request contract bounds the refinement window and names the footprints kind', () => {
  assert.equal(resolveSearchRequest({ kind: 'footprints', bbox: BBOX }).kind, 'footprints')
  assert.deepEqual(resolveFootprintRequest({ kind: 'footprints', bbox: BBOX }), { kind: 'footprints', bbox: BBOX, limit: 200 })
  assert.equal(resolveFootprintRequest({ kind: 'footprints', bbox: BBOX, building: 'retail', limit: 5 }).limit, 5)
  assert.throws(() => resolveFootprintRequest({ kind: 'footprints', bbox: [87, 43, 88, 44] }), error => error instanceof FootprintError && error.code === 'FOOTPRINTS_INVALID_INPUT')
  assert.throws(() => resolveFootprintRequest({ kind: 'footprints', bbox: [87.52, 43.85, 87.51, 43.84] }), /must not wrap/)
  assert.throws(() => resolveFootprintRequest({ kind: 'footprints', bbox: BBOX, endpoint: 'https://evil' }), /Unrecognized/) // model JSON never names endpoints
})

test('the Overpass query is bounded, filtered and carries the server-side deadline', () => {
  const request = resolveFootprintRequest({ kind: 'footprints', bbox: BBOX, building: 'retail' })
  const query = overpassQuery(request, 45)
  assert.match(query, /^\[out:json\]\[timeout:45\];way\["building"="retail"\]\(43\.83936,87\.51386,43\.84073,87\.51558\);out geom 200;$/u)
  assert.match(overpassQuery(resolveFootprintRequest({ kind: 'footprints', bbox: BBOX }), 500), /\[timeout:60\]/u, 'the server deadline is capped at 60s')
  assert.match(overpassQuery(resolveFootprintRequest({ kind: 'footprints', bbox: BBOX, building: 're"t\\ail' })), /"building"="retail"/u, 'quotes and backslashes cannot escape the filter')
})

test('decode keeps closed ways, skips relations and unclosed rings, and reports what it skipped', () => {
  const good = decodeFootprint(closedWay(1, '万达广场'))
  assert.equal(good.geometry.type, 'Polygon')
  assert.equal(good.properties.id, 'osm/way/1')
  assert.equal(good.properties.levels, 4)
  assert.equal(good.geometry.coordinates[0].length, 5, 'the closing point is retained')
  assert.equal(decodeFootprint({ type: 'relation', id: 2, tags: { building: 'yes' } }), undefined, 'multipolygon relations are not rebuilt')
  const unclosed = closedWay(3, 'x'); unclosed.geometry.pop()
  assert.equal(decodeFootprint(unclosed), undefined, 'an open way is not a footprint')
  const outOfBounds = closedWay(4, 'y', 'yes', [999, 43])
  assert.equal(decodeFootprint(outOfBounds), undefined)
  const spec = resolveFootprintsConfig({})
  const page = decodeFootprints({ elements: [closedWay(1, 'a'), closedWay(3, 'b'), { type: 'relation', id: 9 }] }, resolveFootprintRequest({ kind: 'footprints', bbox: BBOX }), spec)
  assert.equal(page.total, 2)
  assert.equal(page.provider, 'osm-overpass')
  assert.equal(page.licence, 'ODbL 1.0 (OpenStreetMap contributors)')
  assert.ok(page.limitations.some(line => /1 element\(s\) had no closed way geometry/.test(line)))
  assert.throws(() => decodeFootprints({ remark: 'runtime error: query timed out' }, resolveFootprintRequest({ kind: 'footprints', bbox: BBOX }), spec), error => error.code === 'FOOTPRINTS_RESPONSE_INVALID')
})

test('config: public default, deployment override, loopback-only HTTP, no credentials in the URL', () => {
  assert.equal(resolveFootprintsConfig(undefined).baseUrl, 'https://overpass-api.de/api/interpreter')
  assert.equal(resolveFootprintsConfig(undefined).declared, false)
  const custom = resolveFootprintsConfig({ baseUrl: 'https://overpass.internal.example/api/interpreter', licence: 'proprietary', attribution: 'Internal GIS' })
  assert.equal(custom.declared, true)
  assert.equal(custom.licence, 'proprietary')
  assert.equal(resolveFootprintsConfig({ baseUrl: 'http://127.0.0.1:1234/api/interpreter' }).baseUrl, 'http://127.0.0.1:1234/api/interpreter')
  assert.throws(() => resolveFootprintsConfig({ baseUrl: 'http://overpass.example/api' }), /HTTPS/)
  assert.throws(() => resolveFootprintsConfig({ baseUrl: 'https://user:pw@overpass.example/api' }), /credentials/)
  assert.throws(() => resolveFootprintsConfig({ maxRetries: 5 }), /configuration/)
})

test('a closed way reaches the page through a real request; the body is the Overpass form', async t => {
  const { baseUrl, hits } = await fixture(t, (_n, response) => json(response, 200, { elements: [closedWay(1, '万达广场购物中心主体')] }))
  const service = createSpatialFootprints(resolveFootprintsConfig({ baseUrl }))
  t.after(() => service.close())
  const page = await service.footprints({ kind: 'footprints', bbox: BBOX })
  assert.equal(page.total, 1)
  assert.equal(page.data.features[0].properties.name, '万达广场购物中心主体')
  assert.equal(page.request.kind, 'footprints')
  assert.equal(hits[0].method, 'POST')
  assert.match(hits[0].data, /^\[out:json\]\[timeout:/u, 'the form decodes to the Overpass QL statement')
})

test('an empty Overpass answer is a valid page, not an error and not a fallback', async t => {
  const { baseUrl } = await fixture(t, (_n, response) => json(response, 200, { elements: [] }))
  const service = createSpatialFootprints(resolveFootprintsConfig({ baseUrl }))
  t.after(() => service.close())
  const page = await service.footprints({ kind: 'footprints', bbox: BBOX })
  assert.equal(page.total, 0)
  assert.deepEqual(page.data.features, [])
  assert.equal(page.truncated, false)
})

test('a 503 is retried once; a 403 is not retried and surfaces as UNAVAILABLE', async t => {
  const { baseUrl, hits } = await fixture(t, (n, response) => n === 1 ? json(response, 503, {}) : json(response, 200, { elements: [closedWay(7, 'after retry')] }))
  const service = createSpatialFootprints(resolveFootprintsConfig({ baseUrl, maxRetries: 1 }))
  t.after(() => service.close())
  const page = await service.footprints({ kind: 'footprints', bbox: BBOX })
  assert.equal(page.total, 1)
  assert.equal(hits.length, 2, 'exactly one retry')
  await service.close()

  const denied = await fixture(t, (_n, response) => json(response, 403, {}))
  const strict = createSpatialFootprints(resolveFootprintsConfig({ baseUrl: denied.baseUrl, maxRetries: 2 }))
  t.after(() => strict.close())
  await assert.rejects(strict.footprints({ kind: 'footprints', bbox: BBOX }), error => error instanceof FootprintError && error.code === 'FOOTPRINTS_SOURCE_INVALID')
  assert.equal(denied.hits.length, 1, '4xx is never retried')
})

test('a 503 that persists past the retry budget surfaces as UNAVAILABLE with no fabricated result', async t => {
  const { baseUrl } = await fixture(t, (_n, response) => json(response, 503, {}))
  const service = createSpatialFootprints(resolveFootprintsConfig({ baseUrl, maxRetries: 1 }))
  t.after(() => service.close())
  await assert.rejects(service.footprints({ kind: 'footprints', bbox: BBOX }), error => error.code === 'FOOTPRINTS_UNAVAILABLE')
})

test('an oversized body is refused before it is parsed', async t => {
  const { baseUrl } = await fixture(t, (_n, response) => { response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(64 * 1024) }); response.end(JSON.stringify({ elements: [], pad: 'x'.repeat(64 * 1024) })) })
  const service = createSpatialFootprints(resolveFootprintsConfig({ baseUrl, maxResponseBytes: 1024 }))
  t.after(() => service.close())
  await assert.rejects(service.footprints({ kind: 'footprints', bbox: BBOX }), error => error.code === 'FOOTPRINTS_TOO_LARGE')
})

test('unconfigured and disposed services refuse explicitly; the service name is stable', async t => {
  assert.equal(SPATIAL_FOOTPRINTS_SERVICE, 'spatialFootprints')
  const off = createSpatialFootprints(undefined)
  await assert.rejects(off.footprints({ kind: 'footprints', bbox: BBOX }), error => error.code === 'FOOTPRINTS_NOT_CONFIGURED')
  const { baseUrl } = await fixture(t, (_n, response) => json(response, 200, { elements: [] }))
  const service = createSpatialFootprints(resolveFootprintsConfig({ baseUrl }))
  await service.close()
  await assert.rejects(service.footprints({ kind: 'footprints', bbox: BBOX }), error => error.code === 'FOOTPRINTS_DISPOSED')
})
