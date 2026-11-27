import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import sharp from 'sharp'
import { createMapSourceCatalog } from '../src/sources.ts'
import { createMapSourceService } from '../src/source-service.ts'
import { createMapSourceRoutes, registerMapSourceRoutes } from '../src/source-route.ts'
import { SourceCatalogError } from '../src/source-error.ts'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t, handler) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return server.address().port
}

async function png(width = 2, height = 2) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
  }).png().toBuffer()
}

function mapServerDocument() {
  return {
    currentVersion: 11.5,
    capabilities: 'Map,Query,Export',
    singleFusedMapCache: true,
    spatialReference: { wkid: 4547 },
    fullExtent: { xmin: 100, ymin: 100, xmax: 300, ymax: 300 },
    supportedImageFormatTypes: 'PNG32,PNG,JPG',
    maxImageWidth: 1024,
    maxImageHeight: 512,
    tileInfo: {
      rows: 2,
      cols: 2,
      dpi: 96,
      format: 'PNG32',
      origin: { x: 200, y: 200 },
      spatialReference: { wkid: 4547 },
      lods: [{ level: 10, resolution: 10, scale: 37795.2 }],
    },
    layers: [{ id: 9, defaultVisibility: true }],
  }
}

function state(selection) {
  return {
    basemap: selection,
    imageryDisplay: {
      labelsVisible: selection?.labels != null,
      recentVisible: true,
      recentOpacity: 1,
      earlyVisible: false,
      earlySource: null,
    },
    mode: 'map',
    view: { center: [120, 30], zoom: 10, wkid: selection === null ? 4326 : 4547 },
  }
}

function publicState(catalog, labels = false) {
  const selection = catalog.selection('esri-world-imagery', labels ? 'esri-world-boundaries-places' : null)
  assert.equal(selection.ok, true)
  return { ...state(selection.value), view: { center: [120, 30], zoom: 10, wkid: 4326 } }
}

function request(path, init = {}) {
  return new Request(`http://owner.test${path}`, init)
}

function errorBody(response) {
  return response.json()
}

async function refuse(route, path, code, status, init = {}) {
  const response = await route.fetch(request(path, init))
  assert.equal(response.status, status)
  assert.deepEqual(await errorBody(response), { ok: false, code })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  return response
}

test('exact source routes admit only known paths, methods, sessions and catalog queries', async t => {
  const service = createMapSourceService(createMapSourceCatalog(undefined, 'allow', {}))
  const route = createMapSourceRoutes(service, async () => publicState(service.catalog))
  t.after(() => service.dispose())

  await refuse(route, '/api/map/sources/other', 'SOURCE_RESOURCE_DENIED', 404)
  const method = await route.fetch(request('/api/map/sources/catalog?session', { method: 'POST' }))
  assert.equal(method.status, 405)
  assert.equal(method.headers.get('allow'), 'GET')
  assert.deepEqual(await errorBody(method), { ok: false, code: 'SOURCE_RESOURCE_DENIED' })

  await refuse(route, '/api/map/sources/catalog', 'SOURCE_RESOURCE_DENIED', 403)
  await refuse(route, '/api/map/sources/catalog?sessionId=two&SESSIONID=two', 'SOURCE_RESOURCE_DENIED', 403)
  await refuse(route, '/api/map/sources/catalog?sessionId=known&lon=1', 'SOURCE_RESOURCE_DENIED', 403)
  await refuse(route, '/api/map/sources/catalog?sessionId=known&lon=NaN&lat=1&zoom=1', 'SOURCE_RESOURCE_DENIED', 403)
  await refuse(route, '/api/map/sources/catalog?sessionId=known&provider=wayback', 'SOURCE_RESOURCE_DENIED', 403)
  await refuse(route, '/api/map/sources/catalog?sessionId=known&pageSize=0', 'SOURCE_LIMIT_EXCEEDED', 413)
  await refuse(route, `/api/map/sources/catalog?sessionId=known&q=${'x'.repeat(9000)}`, 'SOURCE_LIMIT_EXCEEDED', 413)

  const response = await route.fetch(request('/api/map/sources/catalog?sessionId=known&provider=esri&lon=1.5&lat=2.25&zoom=3&pageSize=2'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const page = await response.json()
  assert.equal(page.schemaVersion, 1)
  assert.equal(page.sources.length, 2)
  assert.deepEqual(page.context, { provider: 'esri', at: { lon: 1.5, lat: 2.25 }, zoom: 3 })
  service.dispose()
})

test('render publishes key-free public recipes without DNS or controlled links', async t => {
  const service = createMapSourceService(createMapSourceCatalog(undefined, 'allow', {}))
  t.after(() => service.dispose())
  const route = createMapSourceRoutes(service, async sessionId => sessionId === 'public' ? publicState(service.catalog, true) : null)
  const response = await route.fetch(request('/api/map/sources/render?sessionId=public'))
  assert.equal(response.status, 200)
  const descriptor = await response.json()
  assert.equal(descriptor.schemaVersion, 1)
  assert.equal(descriptor.basemap.transport, 'public-preset')
  assert.equal(descriptor.basemap.layerKind, 'arcgis-tile')
  assert.equal(descriptor.labels.transport, 'public-preset')
  assert.equal('resourceHref' in descriptor.basemap, false)
  assert.equal(service.healthOf(descriptor.basemap.source.id).kind, 'unknown')
  await refuse(route, '/api/map/sources/render?sessionId=missing', 'SOURCE_NOT_FOUND', 404)
})

test('optional source fields omitted by legacy records retain their current defaults', async t => {
  const service = createMapSourceService(createMapSourceCatalog(undefined, 'allow', {}))
  t.after(() => service.dispose())
  const legacy = structuredClone(publicState(service.catalog, true))
  for (const source of [legacy.basemap.basemap, legacy.basemap.labels]) delete source.tileAdjustment
  const route = createMapSourceRoutes(service, async () => legacy)
  const response = await route.fetch(request('/api/map/sources/render?sessionId=legacy'))
  assert.equal(response.status, 200)
  const descriptor = await response.json()
  assert.equal(descriptor.basemap.source.tileAdjustment, null)
  assert.equal(descriptor.labels.source.tileAdjustment, null)
})

test('ordinary base source drift refuses render without replacing the record', async t => {
  const service = createMapSourceService(createMapSourceCatalog(undefined, 'allow', {}))
  t.after(() => service.dispose())
  const drift = structuredClone(publicState(service.catalog, true))
  drift.basemap.basemap = { ...drift.basemap.basemap, title: 'Forged imagery' }
  const route = createMapSourceRoutes(service, async () => drift)
  await refuse(route, '/api/map/sources/render?sessionId=drift', 'SOURCE_CHANGED', 409)
})

test('controlled MapServer resources are identity-bound, bounded and conditionally cacheable', async t => {
  const tile = await png()
  let metadataCalls = 0
  let tileCalls = 0
  const port = await fixture(t, (req, res) => {
    if (req.url?.includes('f=json')) {
      metadataCalls += 1
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    tileCalls += 1
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' }).end(tile)
  })
  const catalog = createMapSourceCatalog({
    proxy: { maxConcurrentRequests: 1, maxQueuedRequests: 0 },
    custom: [{
      id: 'controlled-map', title: 'Controlled map', attribution: 'Fixture credit', role: 'basemap',
      adapter: 'arcgis-mapserver', endpoint: `http://127.0.0.1:${port}/MapServer`, nativeWkid: 4547,
      supportsDynamicExport: true, supportedModes: ['map'], minZoom: 0, maxZoom: 20,
      compatibleBasemapIds: [], allowPrivateNetwork: true, allowHttp: true,
    }],
  }, 'allow', {})
  const service = createMapSourceService(catalog)
  t.after(() => service.dispose())
  const selection = catalog.selection('controlled-map')
  assert.equal(selection.ok, true)
  let current = state(selection.value)
  const route = createMapSourceRoutes(service, async () => current)

  const render = await route.fetch(request('/api/map/sources/render?sessionId=map'))
  assert.equal(render.status, 200)
  const descriptor = await render.json()
  assert.equal(descriptor.basemap.transport, 'controlled')
  assert.equal(descriptor.basemap.layerKind, 'arcgis-tile')
  assert.equal(descriptor.basemap.resourceHref.startsWith('/api/map/sources/resource?'), true)
  assert.equal(metadataCalls, 1)

  const metadataQuery = new URLSearchParams(descriptor.basemap.resourceHref.split('?')[1])
  metadataQuery.set('resource', 'arcgis-metadata')
  metadataQuery.set('f', 'json')
  const metadata = await route.fetch(request(`/api/map/sources/resource?${metadataQuery}`))
  assert.equal(metadata.status, 200)
  assert.equal(metadata.headers.get('content-type'), 'application/json;charset=utf-8')
  assert.equal(metadata.headers.get('x-content-type-options'), 'nosniff')
  const metadataBody = await metadata.json()
  assert.equal(metadataBody.currentVersion, 11.5)
  assert.equal(metadataCalls, 1)

  const tileQuery = new URLSearchParams(descriptor.basemap.resourceHref.split('?')[1])
  tileQuery.set('resource', 'arcgis-tile')
  tileQuery.set('level', '10')
  tileQuery.set('row', '0')
  tileQuery.set('col', '0')
  const tileHref = `/api/map/sources/resource?${tileQuery}`
  const image = await route.fetch(request(tileHref))
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(image.headers.get('content-length'), String(tile.byteLength))
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), tile)
  const etag = image.headers.get('etag')
  assert.equal(tileCalls, 1)

  for (const validator of [etag, `W/${etag}`, `${etag}, "other"`]) {
    const unchanged = await route.fetch(request(tileHref, { headers: { 'if-none-match': validator } }))
    assert.equal(unchanged.status, 304)
    assert.equal(unchanged.headers.get('etag'), etag)
    assert.equal(await unchanged.arrayBuffer().then(buffer => buffer.byteLength), 0)
  }
  const changed = await route.fetch(request(tileHref, { headers: { 'if-none-match': '"different"' } }))
  assert.equal(changed.status, 200)
  assert.equal(tileCalls, 1)

  current = { ...current, view: { center: [120, 30], zoom: 10, wkid: 4490 } }
  const dynamic = await route.fetch(request('/api/map/sources/render?sessionId=map'))
  assert.equal(dynamic.status, 200)
  const dynamicDescriptor = await dynamic.json()
  assert.equal(dynamicDescriptor.engineWkid, 4490)
  assert.equal(dynamicDescriptor.basemap.layerKind, 'arcgis-map-image')
  assert.equal(metadataCalls, 1)
  current = { ...current, view: { center: [120, 30], zoom: 10, wkid: 4547 } }

  const malformedQuery = new URLSearchParams(tileQuery)
  malformedQuery.set('hiddenLayers', '9')
  await refuse(route, `/api/map/sources/resource?${malformedQuery}`, 'SOURCE_RESOURCE_DENIED', 403)
  assert.equal(tileCalls, 1)

  const missingIdentity = new URLSearchParams(tileQuery)
  missingIdentity.delete('nativeEpoch')
  await refuse(route, `/api/map/sources/resource?${missingIdentity}`, 'SOURCE_RESOURCE_DENIED', 403)
  assert.equal(metadataCalls + tileCalls, 2)

  current = { ...current, mode: 'scene' }
  await refuse(route, tileHref, 'SOURCE_CHANGED', 409)
  assert.equal(metadataCalls + tileCalls, 2)
})

function wmtsCapabilities() {
  const matrix = (id, scale, size) => `<TileMatrix><ows:Identifier>${id}</ows:Identifier><ScaleDenominator>${scale}</ScaleDenominator><TopLeftCorner>-20037508.342789244 20037508.342789244</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>${size}</MatrixWidth><MatrixHeight>${size}</MatrixHeight></TileMatrix>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.0.0">
<ows:OperationsMetadata>${['GetCapabilities', 'GetTile'].map(operation => `<ows:Operation name="${operation}"><ows:DCP><ows:HTTP><ows:Get xlink:href="http://10.0.0.5/private?token=secret"><ows:Constraint name="GetEncoding"><ows:AllowedValues><ows:Value>KVP</ows:Value></ows:AllowedValues></ows:Constraint></ows:Get></ows:HTTP></ows:DCP></ows:Operation>`).join('')}</ows:OperationsMetadata>
<Contents><Layer><ows:Title>Private title</ows:Title><ows:Identifier>private-layer</ows:Identifier><Style isDefault="true"><ows:Identifier>private-style</ows:Identifier></Style><Format>image/png</Format><TileMatrixSetLink><TileMatrixSet>private-grid</TileMatrixSet></TileMatrixSetLink></Layer>
<TileMatrixSet><ows:Identifier>private-grid</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>${matrix('private-low', 559082264.0287178, 1)}${matrix('private-high', 279541132.0143589, 2)}</TileMatrixSet></Contents></Capabilities>`
}

test('controlled WMTS translates native identities through one same-origin endpoint', async t => {
  const tile = await png(256, 256)
  let capabilitiesCalls = 0
  let tileCalls = 0
  const port = await fixture(t, (req, res) => {
    const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
    if (query.get('REQUEST') === 'GetCapabilities') {
      capabilitiesCalls += 1
      res.writeHead(200, { 'content-type': 'application/xml' }).end(wmtsCapabilities())
      return
    }
    assert.equal(query.get('REQUEST'), 'GetTile')
    assert.equal(query.get('LAYER'), 'private-layer')
    assert.equal(query.get('STYLE'), 'private-style')
    assert.equal(query.get('TILEMATRIXSET'), 'private-grid')
    assert.equal(query.get('TILEMATRIX'), 'private-low')
    assert.equal(query.get('TILEROW'), '0')
    assert.equal(query.get('TILECOL'), '0')
    tileCalls += 1
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' }).end(tile)
  })
  const catalog = createMapSourceCatalog({
    credentials: { fixture: { type: 'query', parameter: 'token', env: 'FIXTURE_WMTS_TOKEN' } },
    custom: [{
      id: 'controlled-wmts', title: 'Public WMTS', attribution: 'Public credit', role: 'basemap',
      adapter: 'wmts', endpoint: `http://127.0.0.1:${port}/private`, credentialRef: 'fixture',
      wmts: { layer: 'private-layer', style: 'private-style', tileMatrixSet: 'private-grid', format: 'image/png' },
      nativeWkid: 3857, supportedModes: ['map'], minZoom: 0, maxZoom: 20, compatibleBasemapIds: [],
      allowPrivateNetwork: true, allowHttp: true,
    }],
  }, 'allow', { FIXTURE_WMTS_TOKEN: 'secret' })
  const service = createMapSourceService(catalog)
  t.after(() => service.dispose())
  const selection = catalog.selection('controlled-wmts')
  assert.equal(selection.ok, true)
  const current = { ...state(selection.value), view: { center: [120, 30], zoom: 10, wkid: 4326 } }
  const route = createMapSourceRoutes(service, async () => current)
  const render = await route.fetch(request('/api/map/sources/render?sessionId=wmts'))
  assert.equal(render.status, 200)
  const descriptor = await render.json()
  assert.equal(descriptor.basemap.layerKind, 'wmts')
  assert.equal(capabilitiesCalls, 1)

  const metadataQuery = new URLSearchParams(descriptor.basemap.resourceHref.split('?')[1])
  metadataQuery.set('service', 'WMTS')
  metadataQuery.set('version', '1.0.0')
  metadataQuery.set('request', 'GetCapabilities')
  const metadata = await route.fetch(request(`/api/map/sources/resource?${metadataQuery}`))
  assert.equal(metadata.status, 200)
  assert.equal(metadata.headers.get('content-type'), 'application/xml;charset=utf-8')
  const xml = await metadata.text()
  for (const secret of ['private-layer', 'private-style', 'private-grid', 'private-low', '10.0.0.5', 'token=secret', '127.0.0.1']) {
    assert.equal(xml.includes(secret), false, secret)
  }
  assert.equal(xml.includes('http://owner.test/api/map/sources/resource?'), true)
  const endpoint = /<ows:Get xlink:href="([^"]+)"/.exec(xml)?.[1]?.replaceAll('&amp;', '&')
  const endpointUrl = new URL(endpoint ?? '')
  assert.equal(endpointUrl.origin, 'http://owner.test')
  assert.equal(endpointUrl.pathname, '/api/map/sources/resource')
  for (const [key, value] of descriptor.basemap.resourceHref.split('?')[1].split('&').map(pair => pair.split('=').map(decodeURIComponent))) {
    assert.equal(endpointUrl.searchParams.get(key), value)
  }
  assert.equal(capabilitiesCalls, 1)

  const tileQuery = new URLSearchParams(descriptor.basemap.resourceHref.split('?')[1])
  tileQuery.set('service', 'WMTS')
  tileQuery.set('version', '1.0.0')
  tileQuery.set('request', 'GetTile')
  tileQuery.set('layer', 'source')
  tileQuery.set('style', 'default')
  tileQuery.set('format', 'image/png')
  tileQuery.set('tilematrixset', 'grid')
  tileQuery.set('tilematrix', '0')
  tileQuery.set('tilerow', '0')
  tileQuery.set('tilecol', '0')
  const image = await route.fetch(request(`/api/map/sources/resource?${tileQuery}`))
  assert.equal(image.status, 200)
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), tile)
  assert.equal(tileCalls, 1)
})

test('controlled base and labels prepare sequentially under concurrency one', async t => {
  let metadataCalls = 0
  const port = await fixture(t, (_req, res) => {
    metadataCalls += 1
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
  })
  const endpoint = `http://127.0.0.1:${port}/MapServer`
  const source = overrides => ({
    title: 'Fixture source', attribution: 'Fixture credit', adapter: 'arcgis-mapserver',
    endpoint, nativeWkid: 4547, supportsDynamicExport: true, supportedModes: ['map'],
    minZoom: 0, maxZoom: 20, allowPrivateNetwork: true, allowHttp: true, ...overrides,
  })
  const catalog = createMapSourceCatalog({
    proxy: { maxConcurrentRequests: 1, maxQueuedRequests: 0 },
    custom: [
      source({ id: 'pair-base', role: 'basemap', compatibleBasemapIds: [] }),
      source({ id: 'pair-labels', role: 'labels', compatibleBasemapIds: ['pair-base'] }),
    ],
  }, 'allow', {})
  const service = createMapSourceService(catalog)
  t.after(() => service.dispose())
  const selection = catalog.selection('pair-base', 'pair-labels')
  assert.equal(selection.ok, true)
  const route = createMapSourceRoutes(service, async () => state(selection.value))
  const response = await route.fetch(request('/api/map/sources/render?sessionId=pair'))
  assert.equal(response.status, 200)
  const descriptor = await response.json()
  assert.equal(descriptor.basemap.source.id, 'pair-base')
  assert.equal(descriptor.labels.source.id, 'pair-labels')
  assert.equal(metadataCalls, 2)
  assert.notEqual(descriptor.basemap.resourceHref, descriptor.labels.resourceHref)
})

test('route cancellation, saturation and disposal retain work without owning the service', async t => {
  const service = createMapSourceService(createMapSourceCatalog({
    proxy: { maxConcurrentRequests: 1, maxQueuedRequests: 0 },
  }, 'allow', {}))
  t.after(() => service.dispose())
  const gate = deferred()
  let releaseReader = deferred()
  let currentGate = gate
  const route = createMapSourceRoutes(service, async () => {
    await currentGate.promise
    return publicState(service.catalog)
  })
  const caller = new AbortController()
  const blocked = route.fetch(request('/api/map/sources/render?sessionId=blocked', { signal: caller.signal }))
  await Promise.resolve()
  caller.abort()
  await refuse(route, '/api/map/sources/render?sessionId=saturated', 'SOURCE_LIMIT_EXCEEDED', 413)
  gate.resolve()
  const cancelled = await blocked
  assert.equal(cancelled.status, 499)
  await new Promise(resolve => setImmediate(resolve))

  releaseReader = deferred()
  currentGate = releaseReader
  const draining = route.fetch(request('/api/map/sources/render?sessionId=dispose'))
  await Promise.resolve()
  route.dispose()
  route.dispose()
  const disposed = await draining
  assert.equal(disposed.status, 499)
  releaseReader.resolve()
  await new Promise(resolve => setImmediate(resolve))
  const binding = await service.prepare(service.catalog.descriptorOf('esri-world-imagery'))
  assert.equal(binding.transport, 'public-preset')
  await refuse(route, '/api/map/sources/catalog?sessionId=after', 'SOURCE_CANCELLED', 499)
})

test('malformed identities stay refusals and reader failures preserve error ownership', async t => {
  const service = createMapSourceService(createMapSourceCatalog(undefined, 'allow', {}))
  t.after(() => service.dispose())
  const publicRoutes = createMapSourceRoutes(service, async sessionId => sessionId === 'public' ? publicState(service.catalog) : null)
  const render = await publicRoutes.fetch(request('/api/map/sources/render?sessionId=public'))
  const descriptor = await render.json()
  const query = new URLSearchParams()
  query.set('sessionId', 'public')
  query.set('role', 'basemap')
  query.set('sourceId', '../arbitrary')
  query.set('configDigest', descriptor.basemap.source.configDigest)
  query.set('runtimeEpoch', descriptor.runtimeEpoch)
  query.set('nativeEpoch', descriptor.basemap.nativeEpoch)
  query.set('viewMode', 'map')
  query.set('viewWkid', '3857')
  query.set('resource', 'arcgis-metadata')
  query.set('f', 'json')
  await refuse(publicRoutes, `/api/map/sources/resource?${query}`, 'SOURCE_RESOURCE_DENIED', 403)

  const badEpoch = new URLSearchParams(query)
  badEpoch.set('sourceId', descriptor.basemap.source.id)
  badEpoch.set('runtimeEpoch', '00000000-0000-0000-0000-000000000000')
  await refuse(publicRoutes, `/api/map/sources/resource?${badEpoch}`, 'SOURCE_RESOURCE_DENIED', 403)

  const expected = createMapSourceRoutes(service, () => Promise.reject(new SourceCatalogError('SOURCE_UNAVAILABLE')))
  await refuse(expected, '/api/map/sources/render?sessionId=reader', 'SOURCE_UNAVAILABLE', 502)
  const unexpected = createMapSourceRoutes(service, () => Promise.reject(new Error('reader ownership failure')))
  await assert.rejects(unexpected.fetch(request('/api/map/sources/render?sessionId=reader')), /reader ownership failure/)
})

test('route deadline covers a reader that ignores cancellation', async t => {
  const service = createMapSourceService(createMapSourceCatalog({
    proxy: { requestTimeoutMs: 5 },
  }, 'allow', {}))
  t.after(() => service.dispose())
  const release = deferred()
  t.after(() => release.resolve())
  const route = createMapSourceRoutes(service, async () => {
    await release.promise
    return publicState(service.catalog)
  })
  const deadline = await route.fetch(request('/api/map/sources/render?sessionId=slow'))
  assert.equal(deadline.status, 504)
  assert.deepEqual(await deadline.json(), { ok: false, code: 'SOURCE_TIMEOUT' })
  release.resolve()
  await new Promise(resolve => setImmediate(resolve))
  await route.fetch(request('/api/map/sources/render?sessionId=ready'))
})

test('production registration removes every route before disposal settles', async t => {
  const service = createMapSourceService(createMapSourceCatalog(undefined, 'allow', {}))
  t.after(() => service.dispose())
  const registered = new Map()
  const pending = []
  const connection = {
    fetch: {
      register(route) {
        assert.equal(registered.has(route.path), false, `route ${route.path} is already registered`)
        registered.set(route.path, route)
        return () => {
          registered.delete(route.path)
          const completion = deferred()
          pending.push(completion)
          return completion.promise
        }
      },
    },
  }
  const ctx = { get: name => name === 'connection' ? connection : name === 'sessionController' ? {} : undefined }
  const dispose = registerMapSourceRoutes(ctx, service)
  assert.equal(registered.size, 5)
  const firstDisposal = dispose()
  assert.equal(registered.size, 0)
  assert.equal(pending.length, 5)

  const disposeAgain = registerMapSourceRoutes(ctx, service)
  assert.equal(registered.size, 5)
  for (const completion of pending.splice(0)) completion.resolve()
  await firstDisposal
  assert.equal(registered.size, 5)
  const secondDisposal = disposeAgain()
  assert.equal(registered.size, 0)
  assert.equal(pending.length, 5)
  for (const completion of pending.splice(0)) completion.resolve()
  await secondDisposal
})

test('production registration reads exact session projections through Connection routes', async t => {
  const service = createMapSourceService(createMapSourceCatalog(undefined, 'allow', {}))
  t.after(() => service.dispose())
  const selection = service.catalog.selection('esri-world-imagery', 'esri-world-boundaries-places')
  assert.equal(selection.ok, true)
  const projection = {
    kind: 'sequenced',
    asOfSeq: 4,
    values: {
      mapContainer: {
        basemap: selection.value,
        mode: 'map',
        view: { center: [120, 30], zoom: 10, wkid: 4326 },
      },
    },
  }
  const registered = new Map()
  const connection = {
    fetch: {
      register(route) {
        registered.set(route.path, route)
        return async () => { registered.delete(route.path) }
      },
    },
  }
  const controller = {
    projections: async (request, signal) => {
      signal.throwIfAborted()
      return request.sessionId === 'live' ? projection : request.sessionId === 'migration'
        ? { kind: 'migration-required', values: {} }
        : null
    },
  }
  const ctx = { get: name => name === 'connection' ? connection : name === 'sessionController' ? controller : undefined }
  const dispose = registerMapSourceRoutes(ctx, service)
  assert.deepEqual([...registered.keys()], [
    '/api/map/sources/catalog',
    '/api/map/sources/render',
    '/api/map/sources/resource',
    '/api/map/wayback',
    '/api/map/wayback/admit',
  ])
  assert.deepEqual(registered.get('/api/map/wayback/admit').methods, ['POST'])
  assert.equal(registered.get('/api/map/wayback/admit').requestBody, 'streaming')

  const catalog = await registered.get('/api/map/sources/catalog').fetch(request('/api/map/sources/catalog?sessionId=live&provider=esri&pageSize=1'))
  assert.equal(catalog.status, 200)
  assert.equal((await catalog.json()).sources.length, 1)
  const render = await registered.get('/api/map/sources/render').fetch(request('/api/map/sources/render?sessionId=live'))
  assert.equal(render.status, 200)
  assert.equal((await render.json()).basemap.source.id, 'esri-world-imagery')
  const missing = await registered.get('/api/map/sources/catalog').fetch(request('/api/map/sources/catalog?sessionId=migration'))
  assert.equal(missing.status, 404)

  const liveRender = await service.prepare(selection.value.basemap)
  assert.equal(liveRender.transport, 'public-preset')
  await dispose()
  assert.deepEqual([...registered.keys()], [])
  assert.equal((await service.prepare(selection.value.basemap)).transport, 'public-preset')
})
