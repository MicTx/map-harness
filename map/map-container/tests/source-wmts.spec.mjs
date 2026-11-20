import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWmtsMetadata, createSdkWmtsMetadata } from '../src/source-wmts.ts'
import { createMapSourceCatalog, SourceCatalogError } from '../src/sources.ts'

function escape(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
}

function capabilities({ layer = 'private-layer', style = 'private-style', set = 'private-grid', format = 'image/png' } = {}) {
  const matrix = (id, scale, size) => `<TileMatrix><ows:Identifier>${id}</ows:Identifier><ScaleDenominator>${scale}</ScaleDenominator><TopLeftCorner>-20037508.342789244 20037508.342789244</TopLeftCorner><TileWidth>256</TileWidth><TileHeight>256</TileHeight><MatrixWidth>${size}</MatrixWidth><MatrixHeight>${size}</MatrixHeight></TileMatrix>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.0.0">
<ows:ServiceProvider><ows:ProviderName>private-token</ows:ProviderName></ows:ServiceProvider>
<ows:OperationsMetadata>
${['GetCapabilities', 'GetTile'].map(operation => `<ows:Operation name="${operation}"><ows:DCP><ows:HTTP><ows:Get xlink:href="http://10.0.0.5/wmts?token=private-token"><ows:Constraint name="GetEncoding"><ows:AllowedValues><ows:Value>KVP</ows:Value></ows:AllowedValues></ows:Constraint></ows:Get></ows:HTTP></ows:DCP></ows:Operation>`).join('')}
</ows:OperationsMetadata>
<Contents><Layer><ows:Title>Private layer title</ows:Title><ows:Identifier>${escape(layer)}</ows:Identifier>
<Style isDefault="true"><ows:Identifier>${escape(style)}</ows:Identifier></Style>
<Format>${format}</Format><ResourceURL resourceType="tile" format="image/png" template="http://10.0.0.5/private-token/{TileMatrix}"/>
<TileMatrixSetLink><TileMatrixSet>${escape(set)}</TileMatrixSet></TileMatrixSetLink></Layer>
<TileMatrixSet><ows:Identifier>${escape(set)}</ows:Identifier><ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
${matrix('private-low', 559082264.0287178, 1)}${matrix('private-high', 279541132.0143589, 2)}
</TileMatrixSet></Contents></Capabilities>`
}

function fixture(wmts = {}, wkid = 3857) {
  const config = { layer: 'private-layer', tileMatrixSet: 'private-grid', ...wmts }
  const catalog = createMapSourceCatalog({ custom: [{
    id: 'wmts-fixture', title: 'Public fixture', attribution: 'Public credit', role: 'basemap',
    adapter: 'wmts', endpoint: 'https://source.example.test/wmts', wmts: config,
    nativeWkid: wkid, supportedModes: ['map'], minZoom: 0, maxZoom: 20, compatibleBasemapIds: [],
  }] }, 'allow', {})
  return { source: catalog.list({ provider: 'custom' }).sources[0], config }
}

function parse(xml, input = fixture()) {
  return parseWmtsMetadata(input.source, input.config, Buffer.from(xml))
}

function code(expected) {
  return error => error instanceof SourceCatalogError && error.code === expected
}

test('WMTS admits the configured KVP layer and exact native geometry without following document URLs', () => {
  const result = parse(capabilities())
  assert.equal(result.nativeWkid, 3857)
  assert.equal(result.nativeLayer, 'private-layer')
  assert.equal(result.nativeStyle, 'private-style')
  assert.equal(result.nativeMatrixSet, 'private-grid')
  assert.equal(result.publicFormat, 'image/png')
  assert.deepEqual(result.matrices.map(matrix => [matrix.nativeId, matrix.publicId, matrix.matrixWidth]), [
    ['private-low', '0', 1], ['private-high', '1', 2],
  ])
  assert.deepEqual(result.matrices[0].topLeftCorner, [-20037508.342789244, 20037508.342789244])
  assert.equal(Math.abs(result.matrices[0].viewScale - 591658710.9091312) < 1e-6, true)
  assert.equal(result.matrices[1].maxTileCol, 1)
})

test('native WMTS reconstruction uses public identifiers, geometry and one controlled KVP endpoint only', () => {
  const input = fixture()
  const metadata = parse(capabilities(), input)
  const href = '/api/map/sources/resource?source=custom%3Afixture&epoch=fake-epoch'
  const xml = createSdkWmtsMetadata(input.source, metadata, href)
  for (const needle of ['private-layer', 'private-style', 'private-grid', 'private-low', 'private-high', 'private-token', '10.0.0.5', 'ResourceURL', 'ServiceProvider']) {
    assert.equal(xml.includes(needle), false)
  }
  assert.equal(xml.includes('Public fixture'), true)
  assert.equal(xml.includes('epoch=fake-epoch'), true)
  const decoded = parse(xml, { source: input.source, config: { layer: 'source', style: 'default', tileMatrixSet: 'grid', format: 'image/png' } })
  assert.deepEqual(decoded.matrices.map(matrix => [matrix.nativeId, matrix.scaleDenominator, matrix.topLeftCorner]), [
    ['0', 559082264.0287178, [-20037508.342789244, 20037508.342789244]],
    ['1', 279541132.0143589, [-20037508.342789244, 20037508.342789244]],
  ])
})

test('WMTS escaped identifiers decode safely and tiles retains its upstream format privately', () => {
  const escaped = parse(capabilities({ layer: 'private&layer' }), fixture({ layer: 'private&layer' }))
  assert.equal(escaped.nativeLayer, 'private&layer')
  const tiled = parse(capabilities({ format: 'tiles' }), fixture({ format: 'tiles' }))
  assert.equal(tiled.nativeFormat, 'tiles')
  assert.equal(tiled.publicFormat, 'image/png')
})

test('WMTS matrix limits select only declared matrices and retain precise row/column bounds', () => {
  const limits = `<TileMatrixSetLimits><TileMatrixLimits><TileMatrix>private-high</TileMatrix><MinTileRow>1</MinTileRow><MaxTileRow>1</MaxTileRow><MinTileCol>0</MinTileCol><MaxTileCol>1</MaxTileCol></TileMatrixLimits></TileMatrixSetLimits>`
  const xml = capabilities().replace('</TileMatrixSetLink>', `${limits}</TileMatrixSetLink>`)
  const matrix = parse(xml).matrices[0]
  assert.equal(matrix.nativeId, 'private-high')
  assert.equal(matrix.publicId, '0')
  assert.equal(matrix.minTileRow, 1)
  assert.equal(parse(xml).matrices.length, 1)
  assert.throws(() => parse(xml.replace('<MinTileRow>1</MinTileRow>', '<MinTileRow>2</MinTileRow>')), code('SOURCE_UNAVAILABLE'))
  assert.throws(() => parse(xml.replace('<TileMatrix>private-high</TileMatrix>', '<TileMatrix>missing</TileMatrix>')), code('SOURCE_UNAVAILABLE'))
})

test('WMTS metadata rejects ambiguous style, wrong link/CRS, unsupported operations and invalid matrices', () => {
  const original = capabilities()
  const cases = [
    xml => xml.replace('version="1.0.0"', 'version="2.0.0"'),
    xml => xml.replace('<TileMatrixSet>private-grid</TileMatrixSet>', '<TileMatrixSet>missing</TileMatrixSet>'),
    xml => xml.replace('EPSG::3857', 'EPSG::4326'),
    xml => xml.replaceAll('<ows:Value>KVP</ows:Value>', '<ows:Value>REST</ows:Value>'),
    xml => xml.replaceAll('<TileWidth>256</TileWidth>', '<TileWidth>0</TileWidth>'),
    xml => xml.replace('<MatrixWidth>2</MatrixWidth>', '<MatrixWidth>4294967297</MatrixWidth>'),
    xml => xml.replace('<TopLeftCorner>-20037508.342789244 20037508.342789244</TopLeftCorner>', '<TopLeftCorner>NaN 0</TopLeftCorner>'),
    xml => xml.replace('279541132.0143589', '-1'),
    xml => xml.replace('279541132.0143589', '559082264.0287178'),
    xml => xml.replace('private-high', 'private-low'),
    xml => xml.replace('<Format>image/png</Format>', '<Format>image/svg+xml</Format>'),
    xml => xml.replace('</Layer>', '<Dimension><ows:Identifier>Time</ows:Identifier><Default>2024</Default></Dimension></Layer>'),
    xml => xml.replace('<Style isDefault="true">', '<Style isDefault="false">').replace('</Style>', '</Style><Style isDefault="false"><ows:Identifier>other</ows:Identifier></Style>'),
  ]
  for (const mutate of cases) {
    const changed = mutate(original)
    assert.notEqual(changed, original)
    assert.throws(() => parse(changed), code('SOURCE_UNAVAILABLE'))
  }
  assert.throws(() => parse(original, fixture({ layer: 'missing' })), code('SOURCE_UNAVAILABLE'))
  assert.throws(() => parse(original, fixture({ style: 'missing' })), code('SOURCE_UNAVAILABLE'))
})

test('WMTS parsing bounds malformed, deep, node-heavy and declaration-bearing input without raw errors', () => {
  for (const xml of [
    '<Capabilities>',
    '<!DOCTYPE Capabilities [<!ENTITY private "private-token">]>' + capabilities(),
    capabilities().replace('<Contents>', '<Contents><!ENTITY private "private-token">'),
  ]) {
    let failure
    try { parse(xml) } catch (error) { failure = error }
    assert.equal(failure.code, 'SOURCE_UNAVAILABLE')
    assert.equal(failure.message.includes('private-token'), false)
    assert.equal(Object.hasOwn(failure, 'cause'), false)
  }
  const deep = capabilities().replace('<Contents>', `<Contents>${'<x>'.repeat(33)}${'</x>'.repeat(33)}`)
  assert.throws(() => parse(deep), code('SOURCE_LIMIT_EXCEEDED'))
  const wide = capabilities().replace('<Contents>', `<Contents>${'<x>1</x>'.repeat(17000)}`)
  assert.throws(() => parse(wide), code('SOURCE_LIMIT_EXCEEDED'))
})
