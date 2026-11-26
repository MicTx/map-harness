import test from 'node:test'
import assert from 'node:assert/strict'
import { compileSourceResource, metadataRequest } from '../src/source-resource.ts'
import { parseMapServerMetadata } from '../src/source-mapserver.ts'
import { parseWmtsMetadata } from '../src/source-wmts.ts'
import { createMapSourceCatalog, SourceCatalogError } from '../src/sources.ts'

function configured(adapter, overrides = {}) {
  const catalog = createMapSourceCatalog({ custom: [{
    id: 'resource-fixture', title: 'Resource fixture', attribution: 'Public credit', role: 'basemap',
    adapter, endpoint: adapter === 'xyz' ? 'https://tiles.example.test/{z}/{x}/{y}.png?tenant=fixture' : 'https://geo.example.test/tenant/MapServer/?tenant=fixture',
    nativeWkid: adapter === 'xyz' ? 3857 : 4547, supportsDynamicExport: adapter === 'arcgis-mapserver',
    supportedModes: ['map', 'scene'], minZoom: 0, maxZoom: 30, compatibleBasemapIds: [],
    ...(adapter === 'wmts' ? { endpoint: 'https://geo.example.test/wmts/?tenant=fixture', wmts: { layer: 'private-layer', style: 'private-style', tileMatrixSet: 'private-grid' }, nativeWkid: 3857 } : {}),
    ...overrides,
  }] }, 'allow', {})
  const descriptor = catalog.list({ provider: 'custom' }).sources[0]
  return catalog.resolvedSource(descriptor.id, descriptor.configDigest)
}

function mapserverDocument() {
  return {
    currentVersion: 11.5, capabilities: 'Map,Query', singleFusedMapCache: true,
    spatialReference: { wkid: 4547 },
    fullExtent: { xmin: 100, ymin: 100, xmax: 300, ymax: 300 },
    supportedImageFormatTypes: 'PNG32,PNG,JPG',
    maxImageWidth: 1024, maxImageHeight: 512,
    tileInfo: {
      rows: 2, cols: 2, dpi: 96, format: 'PNG32', origin: { x: 200, y: 200 }, spatialReference: { wkid: 4547 },
      lods: [{ level: 10, resolution: 10, scale: 37795.2 }, { level: 11, resolution: 5, scale: 18897.6 }],
    },
    layers: [
      { id: 5, defaultVisibility: true, subLayerIds: [6, 7] },
      { id: 6, defaultVisibility: true, parentLayerId: 5 },
      { id: 7, defaultVisibility: false, parentLayerId: 5 },
      { id: 9, defaultVisibility: true },
      { id: 10, defaultVisibility: false, subLayerIds: [11] },
      { id: 11, defaultVisibility: true, parentLayerId: 10 },
    ],
  }
}

function arcgis(overrides = {}, document = mapserverDocument()) {
  const resolved = configured('arcgis-mapserver', overrides)
  return { adapter: 'arcgis-mapserver', resolved, metadata: parseMapServerMetadata(resolved.source, Buffer.from(JSON.stringify(document))) }
}

function query(values) {
  return new URLSearchParams(values)
}

function compile(source, values, wkid = 4547) {
  return compileSourceResource(source, { wkid }, values instanceof URLSearchParams ? values : query(values))
}

function refuses(source, values, expected = 'SOURCE_RESOURCE_DENIED') {
  assert.throws(() => compile(source, values), error => {
    assert.ok(error instanceof SourceCatalogError)
    assert.equal(error.code, expected)
    assert.equal(error.message.includes('geo.example.test'), false)
    assert.equal(error.message.includes('private-layer'), false)
    return true
  })
}

function exportQuery(overrides = {}) {
  return {
    resource: 'arcgis-export', bbox: '100,100,300,300', bboxSR: '4547', imageSR: '4547',
    size: '800,400', dpi: '192', format: 'png32', transparent: 'true', f: 'image',
    ...overrides,
  }
}

test('configured metadata GET compilation preserves the exact root and static query without credentials', () => {
  const resolved = configured('arcgis-mapserver')
  const request = metadataRequest(resolved)
  assert.equal(request.url.pathname, '/tenant/MapServer/')
  assert.equal(request.url.searchParams.get('tenant'), 'fixture')
  assert.equal(request.url.searchParams.get('f'), 'json')
  assert.equal(request.payload, 'json')
  const source = arcgis()
  assert.deepEqual(compile(source, { resource: 'arcgis-metadata', f: 'json' }), { kind: 'metadata', payload: 'json' })
  refuses(source, { resource: 'arcgis-metadata', f: 'pjson' })
  refuses(source, { resource: 'arcgis-metadata', f: 'json', url: 'https://arbitrary.example.test' })
})

test('MapServer cache bounds come from native geometry, not global XYZ zoom or a forced positive origin', () => {
  const source = arcgis()
  assert.deepEqual(source.metadata.tileBounds, [
    { level: 10, minCol: -5, maxCol: 4, minRow: -5, maxRow: 4 },
    { level: 11, minCol: -10, maxCol: 9, minRow: -10, maxRow: 9 },
  ])
  const input = query({ resource: 'arcgis-tile', level: '10', row: '-5', col: '4', blankTile: 'false' })
  const before = input.toString()
  const endpoint = source.resolved.endpoint
  const plan = compile(source, input)
  assert.equal(plan.kind, 'image')
  assert.equal(plan.url.pathname, '/tenant/MapServer/tile/10/-5/4')
  assert.equal(plan.url.searchParams.get('blankTile'), 'false')
  assert.equal(plan.url.searchParams.get('tenant'), 'fixture')
  assert.deepEqual([plan.width, plan.height], [2, 2])
  assert.equal(input.toString(), before)
  assert.equal(source.resolved.endpoint, endpoint)
  assert.equal(plan.cacheKey, plan.url.href)
  for (const patch of [{ level: '2' }, { row: '-6' }, { row: '5' }, { col: '5' }, { col: '4.5' }, { row: '01' }, { blankTile: 'true' }, { f: 'json' }]) {
    refuses(source, { resource: 'arcgis-tile', level: '10', row: '0', col: '0', ...patch })
  }
})

test('MapServer export forwards only supported image fields and default-visible leaf ids', () => {
  const source = arcgis()
  const plan = compile(source, exportQuery({ rotation: '-37', layers: 'show:9,6' }))
  assert.equal(plan.url.pathname, '/tenant/MapServer/export')
  assert.equal(plan.url.searchParams.get('bbox'), '100,100,300,300')
  assert.equal(plan.url.searchParams.get('size'), '800,400')
  assert.equal(plan.url.searchParams.get('rotation'), '-37')
  assert.equal(plan.url.searchParams.get('layers'), 'show:6,9')
  assert.equal(plan.url.searchParams.get('format'), 'png32')
  assert.equal(plan.url.searchParams.get('f'), 'image')
  assert.equal(plan.url.searchParams.get('transparent'), 'true')
  assert.deepEqual([plan.width, plan.height], [800, 400])
  assert.equal(compile(source, exportQuery({ layers: 'show:-1' })).url.searchParams.get('layers'), 'show:-1')
  assert.equal(compile(source, exportQuery({ bboxSR: '3857', imageSR: '102100' }), 3857).kind, 'image')
})

test('MapServer export refuses hidden/group layers, arbitrary operations and invalid SR/geometry/media', () => {
  const source = arcgis()
  for (const patch of [
    { layers: 'show:7' }, { layers: 'show:11' }, { layers: 'show:5' }, { layers: 'show:6,6' }, { layers: 'hide:9' },
    { bboxSR: '4326' }, { imageSR: '3857' }, { bboxSR: '{"wkid":4547}' },
    { bbox: '300,100,100,300' }, { bbox: '100,100,100,300' }, { bbox: '0,0,1' },
    { bbox: '-1e308,0,1e308,1' }, { bbox: 'NaN,0,1,1' }, { format: 'svg' }, { f: 'json' },
    { transparent: 'false' }, { rotation: '361' }, { rotation: 'NaN' }, { dpi: '0' },
    { size: '800.5,400' }, { size: '0,400' }, { dynamicLayers: '[]' }, { layerDefs: '{}' },
    { gdbVersion: 'private' }, { time: '2020' }, { callback: 'execute' }, { token: 'private-token' },
  ]) refuses(source, exportQuery(patch))
  for (const patch of [{ size: '1025,400' }, { size: '800,513' }, { dpi: '1201' }]) {
    refuses(source, exportQuery(patch), 'SOURCE_LIMIT_EXCEEDED')
  }
  refuses(arcgis({ supportsDynamicExport: false }), exportQuery())
  const noExport = mapserverDocument()
  noExport.capabilities = 'Query'
  refuses(arcgis({}, noExport), exportQuery())
})

test('XYZ compilation uses the explicit global 256px profile with exact integer matrix bounds', () => {
  const source = { adapter: 'xyz', resolved: configured('xyz') }
  assert.equal(metadataRequest(source.resolved), null)
  const plan = compile(source, { resource: 'xyz-tile', z: '2', x: '3', y: '1' })
  assert.equal(plan.url.href, 'https://tiles.example.test/2/3/1.png?tenant=fixture')
  assert.deepEqual([plan.width, plan.height], [256, 256])
  assert.equal(compile(source, { resource: 'xyz-tile', z: '0', x: '0', y: '0' }).kind, 'image')
  assert.equal(compile(source, { resource: 'xyz-tile', z: '30', x: '1073741823', y: '1073741823' }).kind, 'image')
  for (const patch of [{ z: '31' }, { x: '4' }, { y: '-1' }, { z: '1.5' }, { x: '3e0' }, { x: '03' }, { url: 'https://elsewhere.example.test' }, { token: 'private' }]) {
    refuses(source, { resource: 'xyz-tile', z: '2', x: '3', y: '1', ...patch })
  }
  refuses(source, { resource: 'arcgis-metadata', f: 'json' })
})

function wmtsDocument() {
  const operations = ['GetCapabilities', 'GetTile'].map(name => `<ows:Operation name="${name}"><ows:DCP><ows:HTTP><ows:Get xlink:href="http://10.0.0.5/private-token"/></ows:HTTP></ows:DCP></ows:Operation>`).join('')
  return `<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.0.0">
<ows:OperationsMetadata>${operations}</ows:OperationsMetadata>
<Contents><Layer><ows:Identifier>private-layer</ows:Identifier><Style isDefault="true"><ows:Identifier>private-style</ows:Identifier></Style><Format>tiles</Format>
<TileMatrixSetLink><TileMatrixSet>private-grid</TileMatrixSet><TileMatrixSetLimits><TileMatrixLimits><TileMatrix>private/matrix:low</TileMatrix><MinTileRow>1</MinTileRow><MaxTileRow>2</MaxTileRow><MinTileCol>0</MinTileCol><MaxTileCol>3</MaxTileCol></TileMatrixLimits></TileMatrixSetLimits></TileMatrixSetLink></Layer>
<TileMatrixSet><ows:Identifier>private-grid</ows:Identifier><ows:SupportedCRS>EPSG:3857</ows:SupportedCRS><TileMatrix><ows:Identifier>private/matrix:low</ows:Identifier><ScaleDenominator>139770566.00717945</ScaleDenominator><TopLeftCorner>-20037508.342789244 20037508.342789244</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>4</MatrixWidth><MatrixHeight>4</MatrixHeight></TileMatrix></TileMatrixSet>
</Contents></Capabilities>`
}

function wmtsSource() {
  const resolved = configured('wmts')
  return { adapter: 'wmts', resolved, metadata: parseWmtsMetadata(resolved.source, resolved.wmts, Buffer.from(wmtsDocument())) }
}

function wmtsQuery(overrides = {}) {
  return {
    resource: 'wmts', SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0',
    LAYER: 'source', STYLE: 'default', TILEMATRIXSET: 'grid', FORMAT: 'image/png',
    TILEMATRIX: '0', TILEROW: '2', TILECOL: '3',
    ...overrides,
  }
}

test('WMTS operation plans translate only neutral SDK ids into the configured native KVP selection', () => {
  const source = wmtsSource()
  const metadata = metadataRequest(source.resolved)
  assert.equal(metadata.payload, 'xml')
  assert.equal(metadata.url.pathname, '/wmts/')
  assert.equal(metadata.url.searchParams.get('REQUEST'), 'GetCapabilities')
  assert.equal(metadata.url.searchParams.get('tenant'), 'fixture')
  assert.deepEqual(compile(source, { resource: 'wmts', SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetCapabilities' }), { kind: 'metadata', payload: 'xml' })
  const plan = compile(source, wmtsQuery())
  assert.equal(plan.url.hostname, 'geo.example.test')
  assert.equal(plan.url.pathname, '/wmts/')
  assert.equal(plan.url.searchParams.get('LAYER'), 'private-layer')
  assert.equal(plan.url.searchParams.get('STYLE'), 'private-style')
  assert.equal(plan.url.searchParams.get('TILEMATRIXSET'), 'private-grid')
  assert.equal(plan.url.searchParams.get('TILEMATRIX'), 'private/matrix:low')
  assert.equal(plan.url.searchParams.get('FORMAT'), 'tiles')
  assert.equal(plan.url.searchParams.get('TILEROW'), '2')
  assert.equal(plan.url.searchParams.get('TILECOL'), '3')
  assert.equal(plan.url.searchParams.has('token'), false)
  assert.deepEqual([plan.width, plan.height], [256, 256])
})

test('WMTS native identifiers, undeclared matrices, matrix-limit escapes and arbitrary operations refuse', () => {
  const source = wmtsSource()
  for (const patch of [
    { LAYER: 'private-layer' }, { STYLE: 'private-style' }, { TILEMATRIXSET: 'private-grid' },
    { TILEMATRIX: 'private/matrix:low' }, { TILEMATRIX: '1' }, { TILEROW: '0' }, { TILEROW: '3' },
    { TILECOL: '4' }, { FORMAT: 'tiles' }, { REQUEST: 'GetFeatureInfo' }, { VERSION: '1.1.0' },
    { SERVICE: 'WMS' }, { CQL_FILTER: '1=1' }, { tk: 'private-token' },
  ]) refuses(source, wmtsQuery(patch))
  refuses(source, { resource: 'wmts', SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetCapabilities', LAYER: 'source' })
})

test('closed resource admission rejects duplicate/case aliases, unknown paths and unbounded parameter sets', () => {
  const source = arcgis()
  const duplicate = query({ resource: 'arcgis-metadata', f: 'json' })
  duplicate.append('F', 'json')
  refuses(source, duplicate)
  const excessive = query({ resource: 'arcgis-metadata', f: 'json' })
  for (let index = 0; index < 20; index += 1) excessive.append(`unused${index}`, '1')
  refuses(source, excessive)
  for (const resource of ['find', 'query', 'identify', 'legend', 'layers', 'admin', '../MapServer/tile/0/0/0']) {
    refuses(source, { resource, f: 'json' })
  }
})
