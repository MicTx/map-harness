import test from 'node:test'
import assert from 'node:assert/strict'
import { parseMapServerMetadata } from '../src/source-mapserver.ts'
import { createMapSourceCatalog, SourceCatalogError } from '../src/sources.ts'

function source(nativeWkid = 3857) {
  return createMapSourceCatalog({ custom: [{
    id: 'mapserver-fixture', title: 'Fixture source', role: 'basemap', adapter: 'arcgis-mapserver',
    endpoint: 'https://source.example.test/MapServer', attribution: 'Configured public credit',
    nativeWkid, supportedModes: ['map', 'scene'], minZoom: 0, maxZoom: 23, compatibleBasemapIds: [],
  }] }, 'allow', {}).list({ provider: 'custom' }).sources[0]
}

function document() {
  return {
    currentVersion: 11.5,
    capabilities: 'Map,Query,Data',
    singleFusedMapCache: true,
    spatialReference: { wkid: 102100, latestWkid: 3857 },
    fullExtent: { xmin: -20037508, ymin: -20037508, xmax: 20037508, ymax: 20037508 },
    initialExtent: { xmin: -100000, ymin: -100000, xmax: 100000, ymax: 100000, spatialReference: { wkid: 3857 } },
    supportedImageFormatTypes: 'PNG32,PNG24,PNG,JPG,SVG,PDF',
    supportsDynamicLayers: true,
    maxImageWidth: 8192,
    maxImageHeight: 4096,
    tileInfo: {
      rows: 256, cols: 256, dpi: 96, format: 'MIXED',
      origin: { x: -20037508.342787, y: 20037508.342787 },
      spatialReference: { wkid: 102100, latestWkid: 3857 },
      lods: [
        { level: 0, resolution: 156543.033928, scale: 591657527.591555 },
        { level: 1, resolution: 78271.516964, scale: 295828763.795777 },
      ],
    },
    layers: [{ id: 0, name: 'Sensitive layer name', parentLayerId: -1, subLayerIds: null, defaultVisibility: true }],
    serviceDescription: 'private-token http://10.0.0.5/private',
    copyrightText: '<img src="http://10.0.0.5/private-token">',
    documentInfo: { Title: 'Sensitive title', Keywords: 'private-token' },
    tileServers: ['http://10.0.0.5/private-token'],
    serviceItemId: 'private-token',
  }
}

function parse(value, descriptor = source()) {
  return parseMapServerMetadata(descriptor, Buffer.from(JSON.stringify(value)))
}

function code(expected) {
  return error => error instanceof SourceCatalogError && error.code === expected
}

test('MapServer reconstructs only minimal native SDK metadata with public configured attribution', () => {
  const descriptor = source()
  const result = parse(document(), descriptor)
  assert.equal(result.nativeWkid, 3857)
  assert.equal(result.supportsExport, true)
  assert.equal(descriptor.supportsDynamicExport, false)
  assert.equal(result.service.copyrightText, 'Configured public credit')
  assert.equal(result.service.capabilities, 'Map')
  assert.equal(result.service.supportsDynamicLayers, false)
  assert.equal(result.service.supportedImageFormatTypes, 'PNG32,PNG24,PNG,JPG')
  assert.equal(result.service.maxImageWidth, 4096)
  assert.equal(result.service.layers[0].name, '0')
  assert.deepEqual(result.service.tileInfo.lods, document().tileInfo.lods)
  assert.deepEqual(result.service.fullExtent.spatialReference, document().spatialReference)
  assert.deepEqual(Object.keys(result.service).sort(), [
    'capabilities', 'copyrightText', 'currentVersion', 'fullExtent', 'initialExtent', 'layers',
    'maxImageHeight', 'maxImageWidth', 'singleFusedMapCache', 'spatialReference',
    'supportedImageFormatTypes', 'supportsDynamicLayers', 'tileInfo',
  ].sort())
  const output = JSON.stringify(result)
  for (const needle of ['private-token', '10.0.0.5', 'Sensitive', 'tileServers', 'serviceItemId', 'documentInfo']) {
    assert.equal(output.includes(needle), false)
  }
})

test('MapServer dynamic export is an actual capability, not a configured permission', () => {
  const raw = document()
  raw.singleFusedMapCache = false
  delete raw.tileInfo
  delete raw.initialExtent
  delete raw.layers
  const result = parse(raw)
  assert.equal(result.supportsExport, true)
  assert.equal(Object.hasOwn(result.service, 'tileInfo'), false)
  assert.deepEqual(result.service.initialExtent, result.service.fullExtent)
  assert.deepEqual(result.service.layers, [])
  raw.capabilities = 'Query,Data'
  assert.throws(() => parse(raw), code('SOURCE_UNAVAILABLE'))
  raw.singleFusedMapCache = true
  raw.tileInfo = document().tileInfo
  assert.equal(parse(raw).supportsExport, false)
})

test('MapServer spatial references are checked, including known Web Mercator aliases', () => {
  const raw = document()
  raw.spatialReference = { wkid: 900913 }
  assert.deepEqual(parse(raw).service.spatialReference, { wkid: 3857 })
  raw.spatialReference = { wkid: 4547 }
  raw.tileInfo.spatialReference = { wkid: 4547 }
  raw.initialExtent.spatialReference = { wkid: 4547 }
  assert.equal(parse(raw, source(4547)).nativeWkid, 4547)
  assert.throws(() => parse(raw), code('SOURCE_UNAVAILABLE'))
  raw.spatialReference = { wkid: 3857, latestWkid: 4326 }
  assert.throws(() => parse(raw), code('SOURCE_UNAVAILABLE'))
})

test('MapServer invalid extent, cache, format, LOD and unsupported documents refuse without invention', () => {
  const cases = [
    raw => { raw.error = { code: 401, message: 'private-token http://10.0.0.5/private' } },
    raw => { delete raw.currentVersion },
    raw => { raw.singleFusedMapCache = 'true' },
    raw => { delete raw.tileInfo },
    raw => { raw.fullExtent.xmin = raw.fullExtent.xmax },
    raw => { raw.fullExtent.xmin = -1e308; raw.fullExtent.xmax = 1e308 },
    raw => { raw.fullExtent.spatialReference = { wkid: 4326 } },
    raw => { raw.tileInfo.rows = 0 },
    raw => { raw.tileInfo.cols = 4097 },
    raw => { raw.tileInfo.dpi = 0 },
    raw => { raw.tileInfo.format = 'SVG' },
    raw => { raw.tileInfo.origin.x = NaN },
    raw => { raw.tileInfo.lods = [] },
    raw => { raw.tileInfo.lods[1].level = 0 },
    raw => { raw.tileInfo.lods[1].level = 1.5 },
    raw => { raw.tileInfo.lods[1].resolution = raw.tileInfo.lods[0].resolution },
    raw => { raw.tileInfo.lods[1].scale = -1 },
    raw => { raw.tileInfo.lods = Array.from({ length: 65 }, (_, level) => ({ level, resolution: 2 ** -level, scale: 2 ** -level })) },
    raw => { raw.supportedImageFormatTypes = 42 },
  ]
  for (const mutate of cases) {
    const raw = document()
    mutate(raw)
    assert.throws(() => parse(raw), code('SOURCE_UNAVAILABLE'))
  }
})

test('MapServer sublayer hierarchy retains ids and visibility but rejects broken references or cycles', () => {
  const raw = document()
  raw.layers = [
    { id: 0, name: 'Sensitive group', subLayerIds: [1, 2], defaultVisibility: true },
    { id: 1, name: 'Sensitive one', parentLayerId: 0, defaultVisibility: true, minScale: 10000, maxScale: 100 },
    { id: 2, name: 'Sensitive two', parentLayerId: 0, defaultVisibility: false },
  ]
  const layers = parse(raw).service.layers
  assert.deepEqual(layers.map(layer => [layer.id, layer.name, layer.parentLayerId, layer.defaultVisibility]), [
    [0, '0', -1, true], [1, '1', 0, true], [2, '2', 0, false],
  ])
  const cases = [
    layers => { layers.push({ ...layers[1] }) },
    layers => { layers[0].subLayerIds.push(999) },
    layers => { layers[1].parentLayerId = -1 },
    layers => { layers[0].subLayerIds.push(1) },
    layers => { layers[1].minScale = 10; layers[1].maxScale = 100 },
    layers => { layers[1].defaultVisibility = 'false' },
    layers => { layers[0].parentLayerId = 1; layers[1].subLayerIds = [0] },
  ]
  for (const mutate of cases) {
    const changed = structuredClone(raw)
    mutate(changed.layers)
    assert.throws(() => parse(changed), code('SOURCE_UNAVAILABLE'))
  }
})

test('MapServer parser bounds unknown deep and node-heavy metadata before retaining a result', () => {
  const deep = document()
  let nested = {}
  for (let depth = 0; depth < 33; depth += 1) nested = { child: nested }
  deep.unused = nested
  assert.throws(() => parse(deep), code('SOURCE_LIMIT_EXCEEDED'))
  const wide = document()
  wide.unused = Array(16385).fill(1)
  assert.throws(() => parse(wide), code('SOURCE_LIMIT_EXCEEDED'))
})

test('MapServer malformed bytes and upstream error text never become a public error cause', () => {
  for (const bytes of [Uint8Array.of(0xff), Buffer.from('{"private-token":'), Buffer.from('null')]) {
    let failure
    try { parseMapServerMetadata(source(), bytes) } catch (error) { failure = error }
    assert.equal(failure.code, 'SOURCE_UNAVAILABLE')
    assert.equal(Object.hasOwn(failure, 'cause'), false)
    assert.equal(failure.message.includes('private-token'), false)
  }
})
