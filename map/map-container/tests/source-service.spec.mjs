import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import sharp from 'sharp'
import { BasemapSourceId } from '../../layers/src/index.ts'
import { createMapSourceService } from '../src/source-service.ts'
import { createMapSourceCatalog, SourceCatalogError } from '../src/sources.ts'

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
  return { port: server.address().port, server }
}

function catalog(config = {}, policy = 'allow', env = {}) {
  return createMapSourceCatalog(config, policy, env)
}

function imageSource(id, endpoint, overrides = {}) {
  return {
    id, title: id, role: 'basemap', adapter: 'arcgis-mapserver', endpoint,
    attribution: 'Fixture owner', nativeWkid: 4547, supportsDynamicExport: true,
    supportedModes: ['map', 'scene'], minZoom: 0, maxZoom: 23, compatibleBasemapIds: [],
    allowPrivateNetwork: true, allowHttp: true,
    ...overrides,
  }
}

function xyzSource(id, endpoint, overrides = {}) {
  return {
    id, title: id, role: 'basemap', adapter: 'xyz', endpoint,
    attribution: 'Fixture owner', nativeWkid: 3857, supportsDynamicExport: false,
    supportedModes: ['map'], minZoom: 0, maxZoom: 19, compatibleBasemapIds: [],
    allowPrivateNetwork: true, allowHttp: true,
    ...overrides,
  }
}

function mapServerDocument() {
  return {
    currentVersion: 11.5, capabilities: 'Map,Query', singleFusedMapCache: true,
    spatialReference: { wkid: 4547 },
    fullExtent: { xmin: 100, ymin: 100, xmax: 300, ymax: 300 },
    supportedImageFormatTypes: 'PNG32,PNG,JPG', maxImageWidth: 1024, maxImageHeight: 512,
    tileInfo: {
      rows: 2, cols: 2, dpi: 96, format: 'PNG32',
      origin: { x: 200, y: 200 }, spatialReference: { wkid: 4547 },
      lods: [{ level: 10, resolution: 10, scale: 37795.2 }],
    },
    layers: [{ id: 9, defaultVisibility: true }],
  }
}

async function png(width = 2, height = 2) {
  return sharp({
    create: { width, height, channels: 4, background: { r: 40, g: 80, b: 120, alpha: 1 } },
  }).png().toBuffer()
}

function service(t, sourceCatalog, dependencies) {
  const result = createMapSourceService(sourceCatalog, dependencies)
  t.after(() => result.dispose())
  return result
}

function sourceFrom(sourceCatalog, id) {
  return sourceCatalog.descriptorOf(BasemapSourceId(id))
}

function sourceError(code) {
  return error => error instanceof SourceCatalogError && error.code === code
}

function resolverProbe() {
  let calls = 0
  const noRecords = () => {
    calls += 1
    return Promise.reject(Object.assign(new Error('fixture DNS has no records'), { code: 'ENODATA' }))
  }
  return {
    count: () => calls,
    createResolver: () => ({ resolve4: noRecords, resolve6: noRecords, cancel() {} }),
  }
}

test('all key-free public presets prepare without DNS; forged grants refuse and credentialed Esri stays controlled', { timeout: 10_000 }, async t => {
  const probe = resolverProbe()
  const servicePublic = service(t, catalog(), probe)
  const publicIds = ['esri-world-imagery', 'esri-world-boundaries-places', 'osm-standard']
  const nativeEpochs = new Set()
  let runtimeEpoch
  for (const id of publicIds) {
    const source = sourceFrom(servicePublic.catalog, id)
    const binding = await servicePublic.prepare(source)
    assert.equal(binding.transport, 'public-preset')
    assert.equal(binding.presetId, id)
    assert.equal(Object.isFrozen(binding), true)
    assert.equal(Object.isFrozen(binding.source), true)
    assert.equal(binding.source.id, source.id)
    runtimeEpoch ??= binding.runtimeEpoch
    assert.equal(binding.runtimeEpoch, runtimeEpoch)
    assert.equal(nativeEpochs.has(binding.nativeEpoch), false)
    nativeEpochs.add(binding.nativeEpoch)
    assert.equal(servicePublic.healthOf(source.id).kind, 'unknown')
    await assert.rejects(servicePublic.resource(source, binding.nativeEpoch, { wkid: 3857 }, new URLSearchParams({
      resource: 'xyz-tile', z: '0', x: '0', y: '0',
    })), sourceError('SOURCE_RESOURCE_DENIED'))
  }
  const base = sourceFrom(servicePublic.catalog, 'esri-world-imagery')
  const forgedGrant = { ...base, automatedMapUse: 'allowed' }
  assert.throws(() => servicePublic.verifySource(forgedGrant), sourceError('SOURCE_CHANGED'))
  await assert.rejects(servicePublic.prepare(forgedGrant), sourceError('SOURCE_CHANGED'))
  assert.equal(probe.count(), 0)

  const credentials = { esri: { type: 'query', parameter: 'token', env: 'FIXTURE_ESRI_TOKEN' } }
  const privateCatalog = catalog({
    credentials,
    presets: { 'esri-world-imagery': { credentialRef: 'esri' } },
  }, 'allow', { FIXTURE_ESRI_TOKEN: 'synthetic-captured-token' })
  const credentialProbe = resolverProbe()
  const controlled = service(t, privateCatalog, credentialProbe)
  await assert.rejects(controlled.prepare(sourceFrom(privateCatalog, 'esri-world-imagery')), sourceError('SOURCE_UNAVAILABLE'))
  assert.ok(credentialProbe.count() > 0)
  assert.equal(controlled.healthOf(BasemapSourceId('esri-world-imagery')).kind, 'failed')
})

test('descriptor drift and unavailable sources refuse before queueing or transport', async t => {
  const calls = []
  const target = await fixture(t, (_req, res) => {
    calls.push(1)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
  })
  const sourceCatalog = catalog({ custom: [imageSource('drift-source', `http://127.0.0.1:${target.port}/MapServer`)] })
  const descriptor = sourceFrom(sourceCatalog, 'drift-source')
  const owner = service(t, sourceCatalog)
  for (const changed of [
    { screenshot: 'denied' }, { title: 'Changed' }, { release: { version: 'v2', publishedAt: null, acquiredAt: null } },
    { attribution: 'Changed attribution' },
  ]) {
    assert.throws(() => owner.verifySource({ ...descriptor, ...changed }), sourceError('SOURCE_CHANGED'))
    await assert.rejects(owner.prepare({ ...descriptor, ...changed }), sourceError('SOURCE_CHANGED'))
  }
  assert.equal(calls.length, 0)
  await assert.rejects(owner.prepare({
    ...descriptor, id: BasemapSourceId('missing-source'),
  }), sourceError('SOURCE_NOT_FOUND'))
  assert.equal(owner.healthOf(BasemapSourceId('missing-source')).kind, 'unknown')

  const unavailable = catalog({
    credentials: { missing: { type: 'bearer', env: 'FIXTURE_MISSING_TOKEN' } },
    custom: [imageSource('disabled-source', `http://127.0.0.1:${target.port}/MapServer`, {
      credentialRef: 'missing',
    })],
  })
  const disabledDescriptor = sourceFrom(unavailable, 'disabled-source')
  const disabledOwner = service(t, unavailable)
  await assert.rejects(disabledOwner.prepare(disabledDescriptor), sourceError('SOURCE_NOT_CONFIGURED'))
  const disabledCatalog = catalog({ presets: { 'esri-world-boundaries-places': { enabled: false } } })
  const disabledSource = sourceFrom(disabledCatalog, 'esri-world-boundaries-places')
  assert.equal(disabledSource.availability.reason, 'disabled')
  await assert.rejects(service(t, disabledCatalog).prepare(disabledSource), sourceError('SOURCE_UNAVAILABLE'))
  const enabledCatalog = catalog({ presets: { 'esri-world-boundaries-places': { enabled: true } } })
  assert.equal(sourceFrom(enabledCatalog, 'esri-world-boundaries-places').availability.kind, 'configured')
  assert.equal(calls.length, 0)
})

test('MapServer prepare admits one frozen native definition and resources return exact validated PNG bytes', async t => {
  const tile = await png()
  const requests = []
  let changedProviderMetadata = false
  const target = await fixture(t, (req, res) => {
    requests.push(req.url)
    if (req.url?.includes('f=json')) {
      const metadata = mapServerDocument()
      if (changedProviderMetadata) {
        metadata.tileInfo.rows = 4
        metadata.tileInfo.cols = 4
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(metadata))
    } else if (req.url?.includes('/tile/10/1/0')) {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('private provider error')
    } else {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60', etag: '"private-provider-tag"' })
        .end(tile)
    }
  })
  const sourceCatalog = catalog({ custom: [imageSource('fixture-map', `http://127.0.0.1:${target.port}/MapServer`)] })
  const source = sourceFrom(sourceCatalog, 'fixture-map')
  const owner = service(t, sourceCatalog)
  const binding = await owner.prepare(source)
  assert.equal(binding.transport, 'controlled')
  assert.equal(Object.isFrozen(binding.native), true)
  assert.equal(owner.healthOf(source.id).kind, 'reachable')
  const repeated = await owner.prepare(source)
  assert.equal(repeated.nativeEpoch, binding.nativeEpoch)
  assert.equal(requests.length, 1)
  changedProviderMetadata = true
  const nativeMetadata = await owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, new URLSearchParams({
    resource: 'arcgis-metadata', f: 'json',
  }))
  assert.equal(nativeMetadata.kind, 'arcgis-metadata')
  assert.deepEqual(nativeMetadata.metadata, binding.native.metadata.service)
  assert.equal(nativeMetadata.metadata.tileInfo.rows, 2)
  assert.equal(binding.nativeEpoch, repeated.nativeEpoch)
  assert.equal(JSON.stringify(nativeMetadata).includes('127.0.0.1'), false)
  assert.equal(requests.length, 1, 'semantic metadata reads do not fetch the changed provider grid')
  const result = await owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, new URLSearchParams({
    resource: 'arcgis-tile', level: '10', row: '0', col: '0',
  }))
  assert.equal(result.kind, 'image')
  assert.deepEqual(result.body, tile)
  assert.equal(result.contentType, 'image/png')
  assert.notEqual(result.etag, '"private-provider-tag"')
  assert.equal(requests.length, 2)
  assert.equal(owner.healthOf(source.id).kind, 'reachable')
  await assert.rejects(owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, new URLSearchParams({
    resource: 'arcgis-tile', level: '10', row: '1', col: '0',
  })), sourceError('SOURCE_UNAVAILABLE'))
  assert.equal(owner.healthOf(source.id).kind, 'failed')
  const failedHealth = owner.healthOf(source.id)
  assert.deepEqual((await owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, new URLSearchParams({
    resource: 'arcgis-metadata', f: 'json',
  }))).metadata, binding.native.metadata.service)
  assert.strictEqual(owner.healthOf(source.id), failedHealth)
  assert.deepEqual((await owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, new URLSearchParams({
    resource: 'arcgis-tile', level: '10', row: '0', col: '0',
  }))).body, tile)
  assert.strictEqual(owner.healthOf(source.id), failedHealth, 'cached definition/image reads do not clear transport failure')
  assert.equal(requests.length, 3)
  assert.equal(JSON.stringify(result).includes('127.0.0.1'), false)
  await assert.rejects(owner.resource(source, randomUUID(), { wkid: 4547 },
    new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })), sourceError('SOURCE_CHANGED'))
  assert.equal(requests.length, 3)
})

test('WMTS and XYZ materialize only their native geometry; Tianditu refuses before network', async t => {
  const tile = await png()
  const wmtsXml = `<Capabilities version="1.0.0" xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink"><ows:OperationsMetadata><ows:Operation name="GetCapabilities"><ows:DCP><ows:HTTP><ows:Get xlink:href="http://10.0.0.5/private"/></ows:HTTP></ows:DCP></ows:Operation><ows:Operation name="GetTile"><ows:DCP><ows:HTTP><ows:Get xlink:href="http://10.0.0.5/private"/></ows:HTTP></ows:DCP></ows:Operation></ows:OperationsMetadata><Contents><Layer><ows:Identifier>private-layer</ows:Identifier><Style isDefault="true"><ows:Identifier>private-style</ows:Identifier></Style><Format>tiles</Format><TileMatrixSetLink><TileMatrixSet>private-grid</TileMatrixSet></TileMatrixSetLink></Layer><TileMatrixSet><ows:Identifier>private-grid</ows:Identifier><ows:SupportedCRS>EPSG:3857</ows:SupportedCRS><TileMatrix><ows:Identifier>low</ows:Identifier><ScaleDenominator>139770566.00717945</ScaleDenominator><TopLeftCorner>-20037508.342789244 20037508.342789244</TopLeftCorner><TileWidth>2</TileWidth><TileHeight>2</TileHeight><MatrixWidth>4</MatrixWidth><MatrixHeight>4</MatrixHeight></TileMatrix></TileMatrixSet></Contents></Capabilities>`
  const requests = []
  let currentWmtsXml = wmtsXml
  const target = await fixture(t, (req, res) => {
    requests.push(req.url)
    if (req.url?.includes('GetCapabilities')) {
      res.writeHead(200, { 'content-type': 'application/xml' }).end(currentWmtsXml)
    } else {
      res.writeHead(200, { 'content-type': 'image/png' }).end(tile)
    }
  })
  const sourceCatalog = catalog({ custom: [imageSource('fixture-wmts', `http://127.0.0.1:${target.port}/wmts`, {
    adapter: 'wmts', nativeWkid: 3857, supportedModes: ['map'], supportsDynamicExport: false,
    wmts: { layer: 'private-layer', style: 'private-style', tileMatrixSet: 'private-grid', format: 'tiles' },
  })] })
  const owner = service(t, sourceCatalog)
  const source = sourceFrom(sourceCatalog, 'fixture-wmts')
  const binding = await owner.prepare(source)
  assert.equal(binding.transport, 'controlled')
  currentWmtsXml = wmtsXml.replace('<TileWidth>2</TileWidth>', '<TileWidth>4</TileWidth>')
  const healthBeforeMetadata = owner.healthOf(source.id)
  const metadata = await owner.resource(source, binding.nativeEpoch, { wkid: 3857 },
    new URLSearchParams({ resource: 'wmts', SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetCapabilities' }))
  assert.equal(metadata.kind, 'wmts-metadata')
  assert.deepEqual(metadata.metadata, binding.native.metadata)
  assert.strictEqual(owner.healthOf(source.id), healthBeforeMetadata)
  assert.equal(requests.length, 1, 'metadata reads reuse the admitted WMTS geometry')
  const image = await owner.resource(source, binding.nativeEpoch, { wkid: 3857 }, new URLSearchParams({
    resource: 'wmts', SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetTile', LAYER: 'source',
    STYLE: 'default', TILEMATRIXSET: 'grid', FORMAT: 'image/png', TILEMATRIX: '0', TILEROW: '0', TILECOL: '0',
  }))
  assert.equal(image.kind, 'image')
  assert.deepEqual(image.body, tile)
  assert.equal(JSON.stringify(metadata).includes('10.0.0.5'), false)
  assert.equal(requests.length, 2)

  const xyzTile = await png(256, 256)
  let xyzMetadataCalls = 0
  let xyzTileCalls = 0
  const xyzServer = await fixture(t, (req, res) => {
    if (req.url?.includes('/f=')) xyzMetadataCalls += 1
    else xyzTileCalls += 1
    res.writeHead(200, { 'content-type': 'image/png' }).end(xyzTile)
  })
  const xyzCatalog = catalog({ custom: [xyzSource('fixture-xyz', `http://127.0.0.1:${xyzServer.port}/{z}/{x}/{y}.png`)] })
  const xyzOwner = service(t, xyzCatalog)
  const xyz = sourceFrom(xyzCatalog, 'fixture-xyz')
  const xyzBinding = await xyzOwner.prepare(xyz)
  const xyzImage = await xyzOwner.resource(xyz, xyzBinding.nativeEpoch, { wkid: 3857 },
    new URLSearchParams({ resource: 'xyz-tile', z: '0', x: '0', y: '0' }))
  assert.equal(xyzBinding.transport, 'controlled')
  assert.equal(xyzImage.kind, 'image')
  assert.deepEqual(xyzImage.body, xyzTile)
  assert.equal(xyzMetadataCalls, 0)
  assert.equal(xyzTileCalls, 1)

  const probe = resolverProbe()
  const tiandituCatalog = catalog({
    credentials: { td: { type: 'query', parameter: 'tk', env: 'TD_TOKEN' } },
    presets: { 'tianditu-img-w': { credentialRef: 'td' } },
  }, 'allow', { TD_TOKEN: 'synthetic-token' })
  const tiandituOwner = service(t, tiandituCatalog, probe)
  await assert.rejects(tiandituOwner.prepare(sourceFrom(tiandituCatalog, 'tianditu-img-w')), sourceError('SOURCE_UNAVAILABLE'))
  assert.equal(probe.count(), 0)
})

test('fresh image cache returns copies and isolates credential/source activation scopes', async t => {
  const tile = await png()
  const tileRequests = []
  const target = await fixture(t, (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    tileRequests.push({
      authorization: req.headers.authorization,
      ifNoneMatch: req.headers['if-none-match'],
    })
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60', etag: '"upstream-private"' }).end(tile)
  })
  const endpoint = `http://127.0.0.1:${target.port}/MapServer`
  const credentials = {
    first: { type: 'bearer', env: 'FIRST_TOKEN' },
    second: { type: 'bearer', env: 'SECOND_TOKEN' },
  }
  const sources = [
    imageSource('cache-first', endpoint, { credentialRef: 'first' }),
    imageSource('cache-second', endpoint, { credentialRef: 'second' }),
  ]
  const config = { credentials, custom: sources }
  const sourceCatalog = catalog(config, 'allow', { FIRST_TOKEN: 'secret-one', SECOND_TOKEN: 'secret-two' })
  const owner = service(t, sourceCatalog)
  const first = sourceFrom(sourceCatalog, 'cache-first')
  const second = sourceFrom(sourceCatalog, 'cache-second')
  const firstBinding = await owner.prepare(first)
  const secondBinding = await owner.prepare(second)
  const query = new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })
  const one = await owner.resource(first, firstBinding.nativeEpoch, { wkid: 4547 }, query)
  one.body.fill(0)
  const oneAgain = await owner.resource(first, firstBinding.nativeEpoch, { wkid: 4547 }, query)
  assert.deepEqual(oneAgain.body, tile)
  assert.notEqual(oneAgain.etag, '"upstream-private"')
  const other = await owner.resource(second, secondBinding.nativeEpoch, { wkid: 4547 }, query)
  assert.deepEqual(other.body, tile)
  assert.equal(tileRequests.length, 2, 'each source scope reads once; same-source repeats hit cache')
  assert.deepEqual(tileRequests, [
    { authorization: 'Bearer secret-one', ifNoneMatch: undefined },
    { authorization: 'Bearer secret-two', ifNoneMatch: undefined },
  ])

  const secretChangedCatalog = catalog(config, 'allow', { FIRST_TOKEN: 'different-secret', SECOND_TOKEN: 'secret-two' })
  const secondOwner = service(t, secretChangedCatalog)
  const firstChanged = sourceFrom(secretChangedCatalog, 'cache-first')
  const changedBinding = await secondOwner.prepare(firstChanged)
  const changedImage = await secondOwner.resource(firstChanged, changedBinding.nativeEpoch, { wkid: 4547 }, query)
  assert.equal(firstChanged.configDigest, first.configDigest)
  assert.notEqual(secondOwner.runtimeEpoch, owner.runtimeEpoch)
  assert.notEqual(changedBinding.nativeEpoch, firstBinding.nativeEpoch)
  assert.notEqual(changedImage.etag, oneAgain.etag)
})

test('disabled and no-store caches reread; a valid 304 keeps admitted bytes and browser-safe policy', async t => {
  const tile = await png()
  let hits = 0
  const target = await fixture(t, (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    hits += 1
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(tile)
  })
  const sourceCatalog = catalog({
    proxy: { cacheMaxBytes: 0, cacheMaxEntries: 0 },
    custom: [imageSource('cache-off', `http://127.0.0.1:${target.port}/MapServer`)],
  })
  const owner = service(t, sourceCatalog)
  const source = sourceFrom(sourceCatalog, 'cache-off')
  const binding = await owner.prepare(source)
  const query = new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })
  await owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query)
  await owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query)
  assert.equal(hits, 2)

  let conditionalHits = 0
  const conditionalTarget = await fixture(t, (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    conditionalHits += 1
    if (conditionalHits === 1) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache', etag: '"private-one"' }).end(tile)
      return
    }
    assert.equal(req.headers['if-none-match'], '"private-one"')
    res.writeHead(304, { etag: '"private-one"', 'cache-control': 'max-age=60' }).end()
  })
  const conditionalCatalog = catalog({ custom: [imageSource('conditional', `http://127.0.0.1:${conditionalTarget.port}/MapServer`)] })
  const conditionalOwner = service(t, conditionalCatalog)
  const conditionalSource = sourceFrom(conditionalCatalog, 'conditional')
  const conditionalBinding = await conditionalOwner.prepare(conditionalSource)
  const first = await conditionalOwner.resource(conditionalSource, conditionalBinding.nativeEpoch, { wkid: 4547 }, query)
  const revalidated = await conditionalOwner.resource(conditionalSource, conditionalBinding.nativeEpoch, { wkid: 4547 }, query)
  assert.equal(conditionalHits, 2)
  assert.deepEqual(revalidated.body, first.body)
  assert.equal(revalidated.etag, first.etag)
  assert.notEqual(revalidated.etag, '"private-one"')
  assert.match(revalidated.cacheControl, /^private, max-age=/)
})

test('a mismatched 304 gets one unconditional 200; an unsolicited 304 never succeeds empty', async t => {
  const tile = await png()
  let hits = 0
  const target = await fixture(t, (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    hits += 1
    if (hits === 1) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache', etag: '"first"' }).end(tile)
    } else if (hits === 2) {
      res.writeHead(304, { etag: '"changed"', 'cache-control': 'max-age=60' }).end()
    } else {
      assert.equal(req.headers['if-none-match'], undefined)
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(tile)
    }
  })
  const sourceCatalog = catalog({ custom: [imageSource('mismatch-304', `http://127.0.0.1:${target.port}/MapServer`)] })
  const owner = service(t, sourceCatalog)
  const source = sourceFrom(sourceCatalog, 'mismatch-304')
  const binding = await owner.prepare(source)
  const query = new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })
  await owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query)
  assert.deepEqual((await owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query)).body, tile)
  assert.equal(hits, 3)

  const unexpected = await fixture(t, (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    res.writeHead(304).end()
  })
  const noCacheCatalog = catalog({ proxy: { cacheMaxBytes: 0, cacheMaxEntries: 0 }, custom: [
    imageSource('unsolicited-304', `http://127.0.0.1:${unexpected.port}/MapServer`),
  ] })
  const noCacheOwner = service(t, noCacheCatalog)
  const noCacheSource = sourceFrom(noCacheCatalog, 'unsolicited-304')
  const noCacheBinding = await noCacheOwner.prepare(noCacheSource)
  await assert.rejects(noCacheOwner.resource(noCacheSource, noCacheBinding.nativeEpoch, { wkid: 4547 }, query), sourceError('SOURCE_UNAVAILABLE'))
})

test('no-store revalidation drops retention and upstream failure never serves prior bytes', async t => {
  const tile = await png()
  let noStoreHits = 0
  const noStoreServer = await fixture(t, (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    noStoreHits += 1
    if (noStoreHits === 1) res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache', etag: '"ns"' }).end(tile)
    else if (noStoreHits === 2) res.writeHead(304, { etag: '"ns"', 'cache-control': 'no-store' }).end()
    else {
      assert.equal(req.headers['if-none-match'], undefined)
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }).end(tile)
    }
  })
  const noStoreCatalog = catalog({ custom: [imageSource('no-store-304', `http://127.0.0.1:${noStoreServer.port}/MapServer`)] })
  const noStoreOwner = service(t, noStoreCatalog)
  const noStoreSource = sourceFrom(noStoreCatalog, 'no-store-304')
  const noStoreBinding = await noStoreOwner.prepare(noStoreSource)
  const query = new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })
  const original = await noStoreOwner.resource(noStoreSource, noStoreBinding.nativeEpoch, { wkid: 4547 }, query)
  const once = await noStoreOwner.resource(noStoreSource, noStoreBinding.nativeEpoch, { wkid: 4547 }, query)
  const fresh = await noStoreOwner.resource(noStoreSource, noStoreBinding.nativeEpoch, { wkid: 4547 }, query)
  assert.deepEqual(once.body, original.body)
  assert.deepEqual(fresh.body, tile)
  assert.equal(noStoreHits, 3)

  let failureHits = 0
  const failureServer = await fixture(t, (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    failureHits += 1
    if (failureHits === 1) res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache', etag: '"old"' }).end(tile)
    else res.writeHead(503).end('private provider body')
  })
  const failureCatalog = catalog({ custom: [imageSource('stale-failure', `http://127.0.0.1:${failureServer.port}/MapServer`)] })
  const failureOwner = service(t, failureCatalog)
  const failureSource = sourceFrom(failureCatalog, 'stale-failure')
  const failureBinding = await failureOwner.prepare(failureSource)
  await failureOwner.resource(failureSource, failureBinding.nativeEpoch, { wkid: 4547 }, query)
  await assert.rejects(failureOwner.resource(failureSource, failureBinding.nativeEpoch, { wkid: 4547 }, query), sourceError('SOURCE_UNAVAILABLE'))
  assert.equal(failureHits, 2)
})

test('image header mismatches fail safely and a later valid response recovers', async t => {
  const wrong = await png(1, 1)
  const good = await png()
  let imageRequest = 0
  const target = await fixture(t, (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    imageRequest += 1
    res.writeHead(200, {
      'content-type': imageRequest === 2 ? 'image/jpeg' : 'image/png',
    }).end(imageRequest === 1 ? wrong : good)
  })
  const sourceCatalog = catalog({ custom: [imageSource('image-mismatch', `http://127.0.0.1:${target.port}/MapServer`)] })
  const owner = service(t, sourceCatalog)
  const source = sourceFrom(sourceCatalog, 'image-mismatch')
  const binding = await owner.prepare(source)
  const query = new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })
  await assert.rejects(owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query), sourceError('SOURCE_UNAVAILABLE'))
  assert.equal(owner.healthOf(source.id).kind, 'failed')
  await assert.rejects(owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query), sourceError('SOURCE_UNAVAILABLE'))
  assert.equal(owner.healthOf(source.id).kind, 'failed')
  assert.deepEqual((await owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query)).body, good)
  assert.equal(owner.healthOf(source.id).kind, 'reachable')
  assert.equal(imageRequest, 3)
})

test('conditional cache eviction during a pending 304 triggers exactly one unconditional image read', { timeout: 10_000 }, async t => {
  const imageA = await png()
  const imageB = await png(2, 2)
  const startedA304 = deferred()
  const releaseA304 = deferred()
  t.after(() => releaseA304.resolve())
  let aTiles = 0
  let bTiles = 0
  const target = await fixture(t, async (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    if (req.url?.includes('tenant=a')) {
      aTiles += 1
      if (aTiles === 1) res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache', etag: '"a-v1"' }).end(imageA)
      else if (aTiles === 2) {
        startedA304.resolve()
        await releaseA304.promise
        res.writeHead(304, { etag: '"a-v1"', 'cache-control': 'max-age=60' }).end()
      } else res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' }).end(imageA)
      return
    }
    bTiles += 1
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' }).end(imageB)
  })
  const sourceCatalog = catalog({
    proxy: { cacheMaxEntries: 1 },
    custom: [
      imageSource('evict-a', `http://127.0.0.1:${target.port}/MapServer?tenant=a`),
      imageSource('evict-b', `http://127.0.0.1:${target.port}/MapServer?tenant=b`),
    ],
  })
  const owner = service(t, sourceCatalog)
  const sourceA = sourceFrom(sourceCatalog, 'evict-a')
  const sourceB = sourceFrom(sourceCatalog, 'evict-b')
  const bindingA = await owner.prepare(sourceA)
  const bindingB = await owner.prepare(sourceB)
  const query = new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })
  await owner.resource(sourceA, bindingA.nativeEpoch, { wkid: 4547 }, query)
  const revalidatingA = owner.resource(sourceA, bindingA.nativeEpoch, { wkid: 4547 }, query)
  await startedA304.promise
  await owner.resource(sourceB, bindingB.nativeEpoch, { wkid: 4547 }, query)
  releaseA304.resolve()
  assert.deepEqual((await revalidatingA).body, imageA)
  assert.equal(aTiles, 3)
  assert.equal(bTiles, 1)
})

test('a 304 cannot clear a later provider failure when another fresh same-scope image replaced its prior', { timeout: 10_000 }, async t => {
  const oldImage = await png()
  const freshImage = await png(2, 2)
  const conditionalStarted = deferred()
  const releaseConditional = deferred()
  let imageRequests = 0
  const target = await fixture(t, async (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    imageRequests += 1
    const path = new URL(req.url, 'http://127.0.0.1').pathname
    if (path.endsWith('/tile/10/1/0')) {
      res.writeHead(503).end('private provider failure')
    } else if (imageRequests === 1) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-cache', etag: '"old"' }).end(oldImage)
    } else if (imageRequests === 2) {
      conditionalStarted.resolve()
      await releaseConditional.promise
      res.writeHead(304, { etag: '"mismatched"', 'cache-control': 'no-store' }).end()
    } else {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60', etag: '"new"' }).end(freshImage)
    }
  })
  const sourceCatalog = catalog({ custom: [imageSource('same-scope-replacement', `http://127.0.0.1:${target.port}/MapServer`)] })
  const owner = service(t, sourceCatalog)
  const source = sourceFrom(sourceCatalog, 'same-scope-replacement')
  const binding = await owner.prepare(source)
  const rowZero = new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })
  await owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, rowZero)
  const pending304 = owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, rowZero)
  await conditionalStarted.promise
  assert.deepEqual((await owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, rowZero)).body, freshImage)
  await assert.rejects(owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, new URLSearchParams({
    resource: 'arcgis-tile', level: '10', row: '1', col: '0',
  })), sourceError('SOURCE_UNAVAILABLE'))
  const failedHealth = owner.healthOf(source.id)
  assert.equal(failedHealth.kind, 'failed')
  releaseConditional.resolve()
  assert.deepEqual((await pending304).body, freshImage)
  assert.strictEqual(owner.healthOf(source.id), failedHealth)
  assert.equal(imageRequests, 4)
})

test('FIFO service slots enforce queue capacity, cancellation, and entry-time query snapshots', { timeout: 10_000 }, async t => {
  const tile = await png()
  const firstEntered = deferred()
  const releaseFirst = deferred()
  t.after(() => releaseFirst.resolve())
  const rows = []
  let imageCount = 0
  const target = await fixture(t, async (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    imageCount += 1
    rows.push(new URL(req.url, 'http://127.0.0.1').pathname)
    if (imageCount === 1) {
      firstEntered.resolve()
      await releaseFirst.promise
    }
    res.writeHead(200, { 'content-type': 'image/png' }).end(tile)
  })
  const sourceCatalog = catalog({
    proxy: { maxConcurrentRequests: 1, maxQueuedRequests: 1 },
    custom: [imageSource('fifo-source', `http://127.0.0.1:${target.port}/MapServer`)],
  })
  const owner = service(t, sourceCatalog)
  const source = sourceFrom(sourceCatalog, 'fifo-source')
  const binding = await owner.prepare(source)
  const query = () => new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })
  const first = owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query())
  await firstEntered.promise
  const cancel = new AbortController()
  const canceledQuery = query()
  const canceled = owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, canceledQuery, cancel.signal)
  canceledQuery.set('row', '-5')
  const full = owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query())
  await assert.rejects(full, sourceError('SOURCE_LIMIT_EXCEEDED'))
  cancel.abort(new Error('caller reason stays private'))
  await assert.rejects(canceled, sourceError('SOURCE_CANCELLED'))

  const queuedQuery = query()
  const next = owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, queuedQuery)
  queuedQuery.set('row', '-9')
  releaseFirst.resolve()
  await first
  await next
  assert.deepEqual(rows, ['/MapServer/tile/10/0/0', '/MapServer/tile/10/0/0'])
  assert.equal(imageCount, 2)
})

test('queue deadline includes blocked header work and refuses queued admission', { timeout: 10_000 }, async t => {
  const tile = await png()
  let imageCalls = 0
  const target = await fixture(t, async (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    imageCalls += 1
    res.writeHead(200, { 'content-type': 'image/png' }).end(tile)
  })
  const sourceCatalog = catalog({
    proxy: { requestTimeoutMs: 100, maxConcurrentRequests: 1, maxQueuedRequests: 1 },
    custom: [imageSource('deadline-source', `http://127.0.0.1:${target.port}/MapServer`)],
  })
  const owner = service(t, sourceCatalog)
  const source = sourceFrom(sourceCatalog, 'deadline-source')
  const binding = await owner.prepare(source)
  const query = new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })
  const originalMetadata = sharp.prototype.metadata
  const headerStarted = deferred()
  const releaseHeader = deferred()
  t.after(() => releaseHeader.resolve())
  sharp.prototype.metadata = function (...args) {
    return originalMetadata.apply(this, args).then(async value => {
      headerStarted.resolve()
      await releaseHeader.promise
      return value
    })
  }
  const originalNow = Date.now()
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: originalNow })
  try {
    const first = owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query)
    await headerStarted.promise
    const queued = owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query)
    t.mock.timers.tick(101)
    await assert.rejects(queued, sourceError('SOURCE_TIMEOUT'))
    await assert.rejects(first, sourceError('SOURCE_TIMEOUT'))
    assert.equal(imageCalls, 1, 'the expired queued operation never reaches transport')
    assert.equal(owner.healthOf(source.id).kind, 'reachable', 'deadline after headers cannot publish late health')
    releaseHeader.resolve()
  } finally {
    releaseHeader.resolve()
    sharp.prototype.metadata = originalMetadata
    t.mock.timers.reset()
  }
})

test('disposing the service cancels active and queued work and prevents revival', { timeout: 10_000 }, async t => {
  const tile = await png()
  const entered = deferred()
  const release = deferred()
  t.after(() => release.resolve())
  let imageCalls = 0
  const target = await fixture(t, async (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    imageCalls += 1
    entered.resolve()
    await release.promise
    res.writeHead(200, { 'content-type': 'image/png' }).end(tile)
  })
  const sourceCatalog = catalog({
    proxy: { maxConcurrentRequests: 1, maxQueuedRequests: 1 },
    custom: [imageSource('dispose-source', `http://127.0.0.1:${target.port}/MapServer`)],
  })
  const owner = service(t, sourceCatalog)
  const source = sourceFrom(sourceCatalog, 'dispose-source')
  const binding = await owner.prepare(source)
  const query = new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })
  const active = owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query)
  await entered.promise
  const waiting = owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query)
  owner.dispose()
  await assert.rejects(active, sourceError('SOURCE_CANCELLED'))
  await assert.rejects(waiting, sourceError('SOURCE_CANCELLED'))
  assert.equal(owner.healthOf(source.id).kind, 'unknown')
  release.resolve()
  owner.dispose()
  assert.equal(imageCalls, 1)
  await assert.rejects(owner.prepare(source), sourceError('SOURCE_CANCELLED'))
})

test('blocked sharp header inspection retains the running slot after prompt cancellation', { timeout: 10_000 }, async t => {
  const tile = await png()
  let imageCalls = 0
  const target = await fixture(t, (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    imageCalls += 1
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' }).end(tile)
  })
  const sourceCatalog = catalog({
    proxy: { maxConcurrentRequests: 1, maxQueuedRequests: 1 },
    custom: [imageSource('header-block', `http://127.0.0.1:${target.port}/MapServer`)],
  })
  const owner = service(t, sourceCatalog)
  const source = sourceFrom(sourceCatalog, 'header-block')
  const binding = await owner.prepare(source)
  const originalMetadata = sharp.prototype.metadata
  const headerStarted = deferred()
  const releaseHeader = deferred()
  t.after(() => releaseHeader.resolve())
  let calls = 0
  sharp.prototype.metadata = function (...args) {
    const actual = originalMetadata.apply(this, args)
    calls += 1
    if (calls === 1) return actual.then(async value => {
      headerStarted.resolve()
      await releaseHeader.promise
      return value
    })
    return actual
  }
  const query = new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })
  const controller = new AbortController()
  const first = owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query, controller.signal)
  try {
    await headerStarted.promise
    controller.abort()
    await assert.rejects(first, sourceError('SOURCE_CANCELLED'))
    const second = owner.resource(source, binding.nativeEpoch, { wkid: 4547 }, query)
    assert.equal(imageCalls, 1)
    releaseHeader.resolve()
    assert.equal((await second).kind, 'image')
    assert.equal(imageCalls, 2)
    assert.equal(owner.healthOf(source.id).kind, 'reachable')
  } finally {
    releaseHeader.resolve()
    sharp.prototype.metadata = originalMetadata
  }
})

test('disposal during blocked header inspection prevents late health or image retention', { timeout: 10_000 }, async t => {
  const tile = await png()
  const target = await fixture(t, (req, res) => {
    if (req.url?.includes('f=json')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
      return
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'max-age=60' }).end(tile)
  })
  const sourceCatalog = catalog({ custom: [imageSource('dispose-header', `http://127.0.0.1:${target.port}/MapServer`)] })
  const owner = service(t, sourceCatalog)
  const source = sourceFrom(sourceCatalog, 'dispose-header')
  const binding = await owner.prepare(source)
  const originalMetadata = sharp.prototype.metadata
  const headerStarted = deferred()
  const releaseHeader = deferred()
  t.after(() => releaseHeader.resolve())
  sharp.prototype.metadata = function (...args) {
    return originalMetadata.apply(this, args).then(async value => {
      headerStarted.resolve()
      await releaseHeader.promise
      return value
    })
  }
  const operation = owner.resource(source, binding.nativeEpoch, { wkid: 4547 },
    new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' }))
  try {
    await headerStarted.promise
    owner.dispose()
    await assert.rejects(operation, sourceError('SOURCE_CANCELLED'))
    releaseHeader.resolve()
    // The non-cancellable header decoder has no public drain API; assert only the service's post-dispose contract.
    await assert.rejects(owner.prepare(source), sourceError('SOURCE_CANCELLED'))
    await assert.rejects(owner.resource(source, binding.nativeEpoch, { wkid: 4547 },
      new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })), sourceError('SOURCE_CANCELLED'))
    assert.equal(owner.healthOf(source.id).kind, 'unknown')
  } finally {
    releaseHeader.resolve()
    sharp.prototype.metadata = originalMetadata
  }
})

test('concurrent first native loads reuse equal semantics and replace changed semantics by epoch', { timeout: 10_000 }, async t => {
  for (const changed of [false, true]) {
    const entered = deferred()
    const releaseOne = deferred()
    const releaseTwo = deferred()
    t.after(() => { releaseOne.resolve(); releaseTwo.resolve() })
    let metadataCalls = 0
    const target = await fixture(t, async (req, res) => {
      metadataCalls += 1
      const number = metadataCalls
      if (number === 2) entered.resolve()
      await (number === 1 ? releaseOne.promise : releaseTwo.promise)
      const metadata = mapServerDocument()
      if (changed && number === 2) metadata.fullExtent.xmax = 400
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(metadata))
    })
    const sourceCatalog = catalog({ proxy: { maxConcurrentRequests: 2 }, custom: [
      imageSource(`concurrent-${changed}`, `http://127.0.0.1:${target.port}/MapServer`),
    ] })
    const owner = service(t, sourceCatalog)
    const source = sourceFrom(sourceCatalog, `concurrent-${changed}`)
    const first = owner.prepare(source)
    const second = owner.prepare(source)
    await entered.promise
    releaseOne.resolve()
    const firstBinding = await first
    releaseTwo.resolve()
    const secondBinding = await second
    assert.equal(metadataCalls, 2)
    assert.equal(firstBinding.transport, 'controlled')
    assert.equal(secondBinding.transport, 'controlled')
    if (changed) {
      assert.notEqual(firstBinding.nativeEpoch, secondBinding.nativeEpoch)
      const before = metadataCalls
      await assert.rejects(owner.resource(source, firstBinding.nativeEpoch, { wkid: 4547 },
        new URLSearchParams({ resource: 'arcgis-tile', level: '10', row: '0', col: '0' })), sourceError('SOURCE_CHANGED'))
      assert.equal(metadataCalls, before)
    } else assert.equal(firstBinding.nativeEpoch, secondBinding.nativeEpoch)
  }
})

test('semantic metadata byte bounds reject oversized attributed records before binding', async t => {
  let metadataCalls = 0
  const target = await fixture(t, (_req, res) => {
    metadataCalls += 1
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(mapServerDocument()))
  })
  const sourceCatalog = catalog({
    proxy: { maxMetadataBytes: 1_024 },
    custom: [imageSource('wide-attribution', `http://127.0.0.1:${target.port}/MapServer`, {
      attribution: '界'.repeat(400),
    })],
  })
  const owner = service(t, sourceCatalog)
  const source = sourceFrom(sourceCatalog, 'wide-attribution')
  await assert.rejects(owner.prepare(source), sourceError('SOURCE_LIMIT_EXCEEDED'))
  await assert.rejects(owner.prepare(source), sourceError('SOURCE_LIMIT_EXCEEDED'))
  assert.equal(metadataCalls, 2)
})
