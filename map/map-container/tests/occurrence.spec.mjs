import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import {
  captured,
  resetCaptured,
  flushRenderWaits,
  fireViewEvent,
  fireWatch,
  FakeMap,
  FakeTileLayer,
  FakeMapImageLayer,
  FakeFeatureLayer,
  FakeGraphicsLayer,
  FakeMapView,
  FakeSceneView,
  FakePoint,
  FakeGraphic,
  FakePolyline,
  FakePolygon,
  FakeExtent,
  FakeSpatialReference,
  FakeSimpleMarkerSymbol,
  FakeSimpleLineSymbol,
  FakeSimpleFillSymbol,
  fireViewHover,
} from './arcgis-doubles.mjs'

class FakeDiv {}
if (globalThis.HTMLDivElement === undefined) globalThis.HTMLDivElement = FakeDiv

const doublesUrl = new URL('./arcgis-doubles.mjs', import.meta.url).href
const exportBySpecifier = {
  '@arcgis/core/Map.js': 'FakeMap',
  '@arcgis/core/views/MapView.js': 'FakeMapView',
  '@arcgis/core/views/SceneView.js': 'FakeSceneView',
  '@arcgis/core/layers/WebTileLayer.js': 'FakeTileLayer',
  '@arcgis/core/layers/MapImageLayer.js': 'FakeMapImageLayer',
  '@arcgis/core/layers/FeatureLayer.js': 'FakeFeatureLayer',
  '@arcgis/core/layers/GraphicsLayer.js': 'FakeGraphicsLayer',
  '@arcgis/core/Graphic.js': 'FakeGraphic',
  '@arcgis/core/geometry/Point.js': 'FakePoint',
  '@arcgis/core/geometry/Polyline.js': 'FakePolyline',
  '@arcgis/core/geometry/Polygon.js': 'FakePolygon',
  '@arcgis/core/geometry/Extent.js': 'FakeExtent',
  '@arcgis/core/geometry/SpatialReference.js': 'FakeSpatialReference',
  '@arcgis/core/symbols/SimpleMarkerSymbol.js': 'FakeSimpleMarkerSymbol',
  '@arcgis/core/symbols/SimpleLineSymbol.js': 'FakeSimpleLineSymbol',
  '@arcgis/core/symbols/SimpleFillSymbol.js': 'FakeSimpleFillSymbol',
  '@arcgis/core/symbols/TextSymbol.js': 'FakeTextSymbol',

}

const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@arcgis/core/core/reactiveUtils.js') return { url: doublesUrl, shortCircuit: true }
    if (specifier.startsWith('@arcgis/core/')) {
      const name = exportBySpecifier[specifier]
      if (name === undefined) throw new Error(`no ArcGIS double for ${specifier}`)
      const source = `export { ${name} as default } from ${JSON.stringify(doublesUrl)}`
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { createMapOccurrence } = await import('../src/client/occurrence.ts')
const { KEY_FREE_BASEMAP, WEB_MERCATOR_ZOOM0_SCALE } = await import('../src/client/view-policy.ts')

function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

function stateOf({ mode = 'map', wkid = 4326, center = [116.4, 39.9], zoom = 9, layers = [], revision = 0 } = {}) {
  return {
    mode,
    view: { center, zoom, wkid },
    layers: new Map(layers.map(layer => [layer.id, layer])),
    revision,
  }
}

function layer(id = 'binding-e2e', coordinates = [116.4, 39.9], properties = {}) {
  return {
    id,
    name: id,
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates }, properties }],
    },
  }
}

function holder() {
  return new FakeDiv()
}

test('a Session rejects a second occurrence and releases its identity on disposal', t => {
  const first = createMapOccurrence(() => stateOf(), 'exclusive-session', 'first-tab')
  t.after(() => first.dispose())
  assert.throws(() => createMapOccurrence(() => stateOf(), 'exclusive-session', 'second-tab'), /already bound/)
  first.dispose()
  const reopened = createMapOccurrence(() => stateOf(), 'exclusive-session', 'third-tab')
  t.after(() => reopened.dispose())
  first.dispose()
  assert.throws(() => createMapOccurrence(() => stateOf(), 'exclusive-session', 'fourth-tab'), /already bound/)
})

test('World Imagery TileLayer is used on a geographic 2D view without a token', async () => {
  resetCaptured()
  let current = stateOf()
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map')
  occurrence.mount(holder())
  await flush()
  assert.equal(captured.tileLayers.length, 1)
  assert.equal(captured.tileLayers[0].title, 'World Imagery')
  assert.equal(captured.tileLayers[0].urlTemplate, KEY_FREE_BASEMAP.urlTemplate)
  assert.equal(KEY_FREE_BASEMAP.urlTemplate.includes('token'), false)
  assert.equal(captured.maps[0].basemap, undefined)
  assert.equal(captured.mapViews[0].spatialReference.wkid, 3857)
  occurrence.dispose()
})

test('the diagnostic camera reads the SDK view rather than repeating the requested coordinates', async t => {
  resetCaptured()
  const occurrence = createMapOccurrence(() => stateOf(), 'camera-observation', 'map')
  t.after(() => occurrence.dispose())
  occurrence.mount(holder())
  const handle = globalThis.__mapHarness.get('camera-observation:map')
  assert.equal(handle.camera, null)
  await flush()
  assert.deepEqual(handle.camera, { center: [116.4, 39.9], zoom: 9, wkid: 3857 })
  const view = captured.mapViews[0]
  view.center = new FakePoint({ longitude: 87.6168, latitude: 43.8256 })
  view.zoom = 11
  assert.deepEqual(handle.center, [116.4, 39.9], 'the durable target is independent of the camera observation')
  assert.deepEqual(handle.camera, { center: [87.6168, 43.8256], zoom: 11, wkid: 3857 })
  view.zoom = -1
  view.scale = WEB_MERCATOR_ZOOM0_SCALE / 2 ** 8
  assert.equal(handle.camera.zoom, 8)
  view.center = new FakePoint({ longitude: NaN, latitude: 43.8256 })
  assert.equal(handle.camera, null)
  occurrence.dispose()
  assert.equal(handle.camera, null)
})

test('same-value refresh keeps a user-moved camera', async () => {
  resetCaptured()
  let current = stateOf({ zoom: 9 })
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map')
  occurrence.mount(holder())
  await flush()
  const view = captured.mapViews[0]
  view.center = { longitude: 121.47, latitude: 31.23 }
  view.zoom = 12
  occurrence.refresh(current)
  await flush()
  assert.equal(view.center.longitude, 121.47)
  assert.equal(view.zoom, 12)
  assert.equal(captured.mapViews.length, 1)
  occurrence.dispose()
})

test('receipt moves from applied to rendered and exposes revision and view identity', async () => {
  resetCaptured()
  let current = stateOf({ revision: 7, layers: [layer()] })
  const occurrence = createMapOccurrence(() => current, 'receipt-session', 'view:map')
  occurrence.mount(holder())
  assert.equal(occurrence.getRenderReceipt().status, 'applied')
  await flush()
  assert.equal(occurrence.getRenderReceipt().status, 'rendered')
  assert.equal(occurrence.getRenderReceipt().renderedRevision, 7)
  assert.equal(occurrence.getRenderReceipt().occurrenceKey, 'view:map')
  assert.equal(typeof occurrence.getRenderReceipt().viewId, 'string')
  occurrence.dispose()
})

test('a superseded view cannot publish a late rendered receipt', async () => {
  resetCaptured()
  let current = stateOf({ revision: 1, layers: [layer()] })
  const occurrence = createMapOccurrence(() => current, 'receipt-session', 'late-view')
  occurrence.mount(holder())
  const first = captured.mapViews[0]
  const firstReceipt = occurrence.getRenderReceipt()
  first.holdWhen = true
  current = stateOf({ mode: 'scene', revision: 2, layers: [layer('binding-e2e', [117, 40])] })
  occurrence.refresh(current)
  await flush()
  assert.equal(occurrence.getRenderReceipt().revision, 2)
  assert.equal(occurrence.getRenderReceipt().status, 'rendered')
  assert.notEqual(occurrence.getRenderReceipt().renderedRevision, 1)
  // The rebuilt engine is a new generation: receipts never carry across views.
  assert.ok(occurrence.getRenderReceipt().generation > firstReceipt.generation)
  assert.notEqual(occurrence.getRenderReceipt().viewId, firstReceipt.viewId)
  first.releaseWhens()
  await flush()
  assert.notEqual(occurrence.getRenderReceipt().renderedRevision, 1)
  occurrence.dispose()
})

test('a layer whose layer view fails reports its layer id in a failed receipt', async () => {
  resetCaptured()
  const occurrence = createMapOccurrence(() => stateOf({ revision: 4, layers: [layer()] }), 'receipt-session', 'failed-layer')
  occurrence.mount(holder())
  const view = captured.mapViews[0]
  // The next attempt on this view cannot create the layer view; the receipt
  // must name the layer with a fixed code, never the raw SDK exception.
  view.layerError = 'binding-e2e'
  occurrence.refresh(stateOf({ revision: 5, layers: [layer()] }))
  await flush()
  const receipt = occurrence.getRenderReceipt()
  assert.equal(receipt.status, 'failed')
  assert.equal(receipt.revision, 5)
  assert.equal(receipt.renderedRevision, null)
  assert.deepEqual(receipt.failedLayers, [{ layerId: 'binding-e2e', code: 'LAYER_FAILED' }])
  occurrence.dispose()
})

test('the persisted receipt accessor keeps serving the last observation when storage is unusable', async () => {
  resetCaptured()
  const occurrence = createMapOccurrence(() => stateOf({ revision: 5, layers: [layer()] }), 'receipt-session', 'storage-less')
  occurrence.mount(holder())
  await flush()
  assert.equal(occurrence.getRenderReceipt().status, 'rendered')
  assert.equal(occurrence.getPersistedRenderReceipt()?.renderedRevision, 5)
  assert.equal(occurrence.getPersistedRenderReceipt()?.occurrenceKey, 'storage-less')
  occurrence.dispose()
})

test('4326 to 4547 to 4326 rebuilds the engine and restores World Imagery', async () => {
  resetCaptured()
  let current = stateOf({ wkid: 4326, layers: [layer()] })
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map')
  occurrence.mount(holder())
  await flush()
  const first = captured.mapViews[0]
  assert.equal(captured.tileLayers.length, 1)

  current = stateOf({ wkid: 4547, layers: [layer()] })
  occurrence.refresh(current)
  await flush()
  assert.equal(first.destroyed, true)
  const projected = captured.mapViews.at(-1)
  assert.notEqual(projected, first)
  assert.equal(projected.spatialReference.wkid, 4547)
  // Projected views reproject the imagery service server-side through the
  // dynamic export endpoint instead of cached Web-Mercator tiles.
  assert.equal(projected.map.layers.some(item => item.urlTemplate === KEY_FREE_BASEMAP.urlTemplate), false)
  assert.match(String(projected.map.layers[0].url), /World_Imagery\/MapServer$/u)
  assert.equal(captured.mapImageLayers.length, 1)
  assert.equal(captured.destroyedMaps.includes(first.map), true)
  await flush()
  // No raster LODs on projected views: the camera zoom goes through scale.
  assert.equal(projected.zoom, 0)
  assert.ok(Math.abs(projected.scale - WEB_MERCATOR_ZOOM0_SCALE / 2 ** 9) < 1e-6)

  current = stateOf({ wkid: 4326, layers: [layer()] })
  occurrence.refresh(current)
  await flush()
  assert.equal(projected.destroyed, true)
  const restored = captured.mapViews.at(-1)
  assert.equal(restored.map.layers.filter(item => item.urlTemplate === KEY_FREE_BASEMAP.urlTemplate).length, 1)
  await flush()
  assert.equal(restored.zoom, 9)
  occurrence.dispose()
})

test('map to scene with the same camera still initializes a new SceneView', async () => {
  resetCaptured()
  let current = stateOf({ mode: 'map' })
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map')
  occurrence.mount(holder())
  await flush()
  const mapView = captured.mapViews[0]
  current = stateOf({ mode: 'scene' })
  occurrence.refresh(current)
  await flush()
  assert.equal(mapView.destroyed, true)
  assert.equal(captured.sceneViews.length, 1)
  const scene = captured.sceneViews[0]
  await flush()
  assert.equal(scene.center.longitude, 116.4)
  assert.equal(scene.center.latitude, 39.9)
  assert.equal(scene.zoom, 9)
  occurrence.dispose()
})

test('destroyed view does not receive a late when() camera write', async () => {
  resetCaptured()
  let current = stateOf()
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map')
  occurrence.mount(holder())
  await flush()
  const view = captured.mapViews[0]
  view.holdWhen = true
  current = stateOf({ center: [121.47, 31.23], zoom: 12 })
  occurrence.refresh(current)
  occurrence.dispose()
  view.flushWhen()
  assert.equal(view.destroyed, true)
  assert.equal(view.center.longitude, 116.4)
  assert.equal(view.center.latitude, 39.9)
  assert.equal(view.zoom, 9)
  hook.deregister?.()
})

test('a same-id layer with moved coordinates or changed attributes redraws its graphics', async () => {
  resetCaptured()
  let current = stateOf({ layers: [layer('a')] })
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map')
  occurrence.mount(holder())
  await flush()
  const graphics = captured.maps[0].layers.find(item => item.graphics !== undefined)
  assert.equal(graphics.graphics.length, 1)
  const first = graphics.graphics[0]
  const coordinatesOf = graphic => [graphic.geometry.longitude, graphic.geometry.latitude]

  // Same id, same feature count, moved point: identity must change and redraw.
  current = stateOf({ layers: [layer('a', [121.47, 31.23])] })
  occurrence.refresh(current)
  await flush()
  assert.equal(graphics.graphics.length, 1)
  assert.notEqual(graphics.graphics[0], first)
  assert.deepEqual(coordinatesOf(graphics.graphics[0]), [121.47, 31.23])

  // Same id, same coordinates, changed properties: redraw again.
  current = stateOf({ layers: [layer('a', [121.47, 31.23], { name: 'renamed' })] })
  occurrence.refresh(current)
  await flush()
  assert.equal(graphics.graphics.length, 1)
  // Attributes carry the stable feature id the shared selection addresses.
  assert.deepEqual(graphics.graphics[0].attributes, { name: 'renamed', __fid: 'f-1' })
  occurrence.dispose()
})

test('graphic attributes keep scalar user fields and reject nested or reserved keys', async () => {
  resetCaptured()
  const properties = JSON.parse('{"name":"safe","count":2,"enabled":true,"empty":null,"nested":{"secret":"drop"},"list":[1],"__proto__":{"polluted":true},"constructor":"drop","prototype":"drop","hasOwnProperty":"drop","toString":"drop"}')
  let current = stateOf({ layers: [layer('safe-attrs', [116.4, 39.9], properties)] })
  const occurrence = createMapOccurrence(() => current, 's1', 'attrs:1')
  occurrence.mount(holder())
  await flush()
  const graphics = captured.maps[0].layers.find(item => item.graphics !== undefined)
  assert.deepEqual(graphics.graphics[0].attributes, {
    name: 'safe', count: 2, enabled: true, empty: null, __fid: 'f-1',
  })
  assert.equal(Object.prototype.polluted, undefined)
  assert.equal(Object.hasOwn(graphics.graphics[0].attributes, '__proto__'), false)
  occurrence.dispose()
})

test('removing a layer drops its rendered identity; re-adding rebuilds, and sessions stay independent', async () => {
  resetCaptured()
  let current = stateOf({ layers: [layer('a')] })
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map')
  occurrence.mount(holder())
  await flush()
  const graphics = captured.maps[0].layers.find(item => item.graphics !== undefined)
  assert.equal(graphics.graphics.length, 1)

  // Remove, then re-add the SAME id with different data: the stale token must
  // not suppress the redraw, and the rebuilt layer starts empty.
  current = stateOf({ layers: [] })
  occurrence.refresh(current)
  await flush()
  assert.equal(captured.maps[0].layers.includes(graphics), false, 'the removed layer leaves the map')
  current = stateOf({ layers: [layer('a', [10, 0])] })
  occurrence.refresh(current)
  await flush()
  const rebuilt = captured.maps[0].layers.find(item => item.graphics !== undefined)
  assert.notEqual(rebuilt, graphics, 're-adding the same id builds a fresh layer, never the removed one')
  assert.equal(rebuilt.graphics.length, 1)
  assert.deepEqual([rebuilt.graphics[0].geometry.longitude, rebuilt.graphics[0].geometry.latitude], [10, 0])

  // A different Session owns separate layer caches even with the same layer id.
  const other = createMapOccurrence(() => stateOf({ layers: [layer('a')] }), 's2', 'panel:map')
  other.mount(holder())
  await flush()
  assert.equal(captured.maps.length, 2)
  const otherGraphics = captured.maps[1].layers.find(item => item.graphics !== undefined)
  assert.equal(otherGraphics.graphics.length, 1)
  other.dispose()
  occurrence.dispose()
})

test('data carriers follow the state layer order without moving other map layers', async () => {
  resetCaptured()
  let current = stateOf({ layers: [layer('a'), layer('b'), layer('c')] })
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map')
  occurrence.mount(holder())
  await flush()
  const map = captured.maps[0]
  const titles = () => map.layers.filter(item => item.graphics !== undefined && item.title !== 'labels').map(item => item.title)
  const others = () => map.layers.filter(item => item.graphics === undefined)
  const before = others()
  assert.deepEqual(titles(), ['a', 'b', 'c'])
  current = stateOf({ layers: [layer('c'), layer('a'), layer('b')] })
  occurrence.refresh(current)
  await flush()
  assert.deepEqual(titles(), ['c', 'a', 'b'], 'carriers permute to the new order')
  assert.deepEqual(others(), before, 'non-data layers keep their positions')
  occurrence.dispose()
})

test('a layer with a displayDigest keys its rendered identity on the digest', async () => {
  resetCaptured()
  const base = { ...layer('v'), displayDigest: 'digest-1' }
  let current = stateOf({ layers: [base] })
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map')
  occurrence.mount(holder())
  await flush()
  const graphics = captured.maps[0].layers.find(item => item.graphics !== undefined)
  assert.equal(graphics.graphics.length, 1)

  // A digest bump alone (same feature count) forces the redraw.
  current = stateOf({ layers: [{ ...base, data: { ...base.data, features: [{ ...base.data.features[0], properties: { changed: true } }] }, displayDigest: 'digest-2' }] })
  occurrence.refresh(current)
  await flush()
  assert.equal(graphics.graphics.length, 1)
  assert.deepEqual(graphics.graphics[0].attributes, { changed: true, __fid: 'f-1' })
  occurrence.dispose()
})

/** A three-class style over score 0..30 for the classification fixtures. */
function scoreStyle() {
  return {
    methodVersion: 'spatial-viz@1',
    field: 'score', unit: '分', measure: 'total', encoding: 'fill',
    classification: 'equal-interval', breaks: [10, 20], domain: { min: 0, max: 30 },
    palette: ['#f7fbff', '#6baed6', '#08306b'],
    missingColor: '#bdbdbd', overflowColor: '#616161', missingLabel: 'no data',
    timeBinding: {
      timeField: 'at', timezone: 'UTC', granularity: 'day',
      window: { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' },
    },
  }
}

function styledLayer({ features, id = 'zones', style = scoreStyle() } = {}) {
  return {
    id, name: id, sourceCrs: 'EPSG:4326', opacity: 1, visible: true, style,
    data: { type: 'FeatureCollection', features },
  }
}

function point(value, at, id) {
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: value === undefined ? { at } : { score: value, at } }
  if (id !== undefined) feature.id = id
  return feature
}

function graphicsFor(current) {
  return [...current.__mapHarnessValues ?? []]
}

test('a styled layer renders per-class symbols: class color, missing as an x marker', async () => {
  resetCaptured()
  let current = stateOf({ layers: [styledLayer({ features: [point(5, undefined, 'low'), point(15, undefined, 'mid'), point(25, undefined, 'high'), point(undefined, undefined, 'nolist')] })] })
  const occurrence = createMapOccurrence(() => current, 's1', 'style:1')
  occurrence.mount(holder())
  await flush()
  const graphics = captured.maps.at(-1).layers.find(item => item.graphics !== undefined)
  assert.equal(graphics.graphics.length, 4)
  const symbols = graphics.graphics.map(g => g.symbol)
  assert.deepEqual(
    symbols.map(symbol => symbol.color),
    ['#f7fbff', '#6baed6', '#08306b', '#bdbdbd'],
    'each class wears its palette color; missing wears the missing color',
  )
  assert.equal(symbols[3].style, 'x', 'missing values carry the non-color x shape')
  assert.equal(symbols[0].style, 'circle')
  occurrence.dispose()
})

test('size-encoded point totals graduate by class; fill-encoded points keep one size', async () => {
  resetCaptured()
  const sizeStyle = { ...scoreStyle(), encoding: 'size' }
  let current = stateOf({ layers: [styledLayer({ features: [point(5), point(25)], style: sizeStyle })] })
  const occurrence = createMapOccurrence(() => current, 's1', 'style:2')
  occurrence.mount(holder())
  await flush()
  const [low, high] = captured.maps.at(-1).layers.find(item => item.graphics !== undefined).graphics.map(g => g.symbol)
  assert.ok(high.size > low.size, `the top class renders larger (${low.size} → ${high.size})`)
  occurrence.dispose()

  resetCaptured()
  current = stateOf({ layers: [styledLayer({ features: [point(5), point(25)] })] })
  const fillOccurrence = createMapOccurrence(() => current, 's2', 'style:3')
  fillOccurrence.mount(holder())
  await flush()
  const [fillLow, fillHigh] = captured.maps.at(-1).layers.find(item => item.graphics !== undefined).graphics.map(g => g.symbol)
  assert.equal(fillLow.size, fillHigh.size)
  fillOccurrence.dispose()
})

test('a pinned time frame hides out-of-frame and missing-time features; unpinning restores them', async () => {
  resetCaptured()
  const features = [point(5, '2026-01-01T06:00:00Z', 'a'), point(15, '2026-01-02T06:00:00Z', 'b'), point(25, undefined, 'noTime')]
  let current = stateOf({ layers: [styledLayer({ features })] })
  const occurrence = createMapOccurrence(() => current, 's1', 'frame:1')
  occurrence.mount(holder())
  await flush()
  assert.equal(captured.maps.at(-1).layers.find(item => item.graphics !== undefined).graphics.length, 3)
  occurrence.setTimeFrame({ index: 0, startMs: Date.parse('2026-01-01T00:00:00Z'), endMs: Date.parse('2026-01-02T00:00:00Z') })
  await flush()
  assert.equal(captured.maps.at(-1).layers.find(item => item.graphics !== undefined).graphics.length, 1, 'only the in-frame feature shows')
  occurrence.setTimeFrame(null)
  await flush()
  assert.equal(captured.maps.at(-1).layers.find(item => item.graphics !== undefined).graphics.length, 3, 'unpinning restores the full set')
  occurrence.dispose()
})

test('setHighlight re-symbols the selected features with the highlight outline', async () => {
  resetCaptured()
  let current = stateOf({ layers: [styledLayer({ features: [point(5, undefined, 'a'), point(25, undefined, 'b')] })] })
  const occurrence = createMapOccurrence(() => current, 's1', 'hl:1')
  occurrence.mount(holder())
  await flush()
  const graphics = captured.maps.at(-1).layers.find(item => item.graphics !== undefined).graphics
  assert.equal(graphics[0].symbol.outline.color, '#ffffff')
  occurrence.setHighlight('zones', new Set(['a']))
  assert.equal(graphics[0].symbol.outline.color, '#00b8ff', 'the selected feature wears the highlight outline')
  assert.equal(graphics[1].symbol.outline.color, '#ffffff')
  occurrence.setHighlight('zones', new Set())
  assert.equal(graphics[0].symbol.outline.color, '#ffffff', 'clearing restores the base outline')
  occurrence.dispose()
})

test('the test handle reports styled layers, visible features, frame, and highlight', async () => {
  resetCaptured()
  const features = [point(5, '2026-01-01T06:00:00Z', 'a'), point(15, undefined, 'b')]
  let current = stateOf({ layers: [styledLayer({ features })] })
  const occurrence = createMapOccurrence(() => current, 's1', 'handle:1')
  occurrence.mount(holder())
  await flush()
  const handles = globalThis.__mapHarness
  const key = 's1:handle:1'
  const handle = handles.get(key)
  assert.deepEqual(handle.styledLayers, ['zones'])
  assert.equal(handle.visibleFeatureCount, 2)
  assert.equal(handle.frameIndex, null)
  assert.equal(handle.highlightCount, 0)
  occurrence.setTimeFrame({ index: 0, startMs: Date.parse('2026-01-01T00:00:00Z'), endMs: Date.parse('2026-01-02T00:00:00Z') })
  await flush()
  const pinned = handles.get(key)
  assert.equal(pinned.frameIndex, 0)
  assert.equal(pinned.visibleFeatureCount, 1, 'the missing-time feature leaves the pinned view')
  occurrence.setHighlight('zones', new Set(['a']))
  const highlighted = handles.get(key)
  assert.equal(highlighted.highlightCount, 1)
  occurrence.dispose()
  assert.equal(handles.has(key), false, 'disposing an occurrence removes its global smoke handle')
  occurrence.dispose()
})

/** One symbol style over the map-layers vocabulary. */
function singleSymbol(overrides = {}) {
  return {
    methodVersion: 'map-layers@1',
    presentation: 'single',
    symbolVersion: 'sym-test@v1',
    point: { shape: 'square', color: '#e53935', sizePx: 12, opacity: 0.8, outlineColor: '#7f1d1d', outlineWidthPx: 1.5 },
    ...overrides,
  }
}

function graphicsCarrierOf(map) {
  return map.layers.find(item => item instanceof FakeGraphicsLayer)
}

test('the R4 resolution order runs override > classification > symbol > default', async () => {
  const { buildStyle } = await import('../../spatial-viz/src/index.ts')
  const style = buildStyle({
    field: 'score',
    unit: '人',
    measure: 'total',
    encoding: 'fill',
    classification: 'equal-interval',
    breaks: [10],
    domain: { min: 0, max: 20 },
  })
  resetCaptured()
  let current = stateOf({
    layers: [{
      ...layer('resolved', [116.4, 39.9], { score: 15 }),
      style,
      symbol: singleSymbol(),
      legend: { title: 'resolved', symbol: { color: '#111111', outline: '#000000' } },
      overrides: { overridesVersion: 'ovr-test@v1', entries: [{ featureIds: ['f-1'], patch: { color: '#1e88e5', opacity: 0.5, shape: 'diamond' } }] },
    }],
  })
  const occurrence = createMapOccurrence(() => current, 's1', 'resolution')
  occurrence.mount(holder())
  await flush()
  const graphics = graphicsCarrierOf(captured.maps[0])
  const symbol = graphics.graphics[0].symbol
  assert.equal(symbol.color, 'rgba(30, 136, 229, 0.5)', 'the override color and opacity win and fold into rgba')
  assert.equal(symbol.style, 'diamond', 'the override shape wins over the symbol block')
  assert.equal(symbol.size, 12, 'the symbol block size baseline applies where the override does not speak')
  occurrence.dispose()

  // Classification without an override: the class color wins, the symbol
  // block keeps the shape and the block opacity folds into the class color.
  resetCaptured()
  current = stateOf({ layers: [{ ...layer('classed', [116.4, 39.9], { score: 15 }), style, symbol: singleSymbol() }] })
  const classified = createMapOccurrence(() => current, 's2', 'classified')
  classified.mount(holder())
  await flush()
  const classSymbol = graphicsCarrierOf(captured.maps[0]).graphics[0].symbol
  assert.equal(classSymbol.color, `rgba(${Number.parseInt(style.palette[1].slice(1, 3), 16)}, ${Number.parseInt(style.palette[1].slice(3, 5), 16)}, ${Number.parseInt(style.palette[1].slice(5, 7), 16)}, 0.8)`)
  assert.equal(classSymbol.style, 'square')
  classified.dispose()

  // No style, no symbol, no override, no legend: ArcGIS's default symbol.
  resetCaptured()
  current = stateOf({ layers: [layer('plain')] })
  const plain = createMapOccurrence(() => current, 's3', 'plain')
  plain.mount(holder())
  await flush()
  assert.equal(graphicsCarrierOf(captured.maps[0]).graphics[0].symbol, undefined, 'nothing styles a bare layer')
  plain.dispose()
})

test('a symbol token change redraws and an unchanged state rebuilds nothing', async () => {
  resetCaptured()
  let current = stateOf({ layers: [{ ...layer('steady'), symbol: singleSymbol() }] })
  const occurrence = createMapOccurrence(() => current, 's1', 'token')
  occurrence.mount(holder())
  await flush()
  const graphics = graphicsCarrierOf(captured.maps[0])
  const first = graphics.graphics[0]
  occurrence.refresh(current)
  await flush()
  assert.equal(graphics.graphics[0], first, 'an identical token never rebuilds the graphic')
  current = {
    ...current,
    revision: 2,
    layers: new Map([['steady', { ...current.layers.get('steady'), symbol: { ...singleSymbol(), symbolVersion: 'sym-next@v1' } }]]),
  }
  occurrence.refresh(current)
  await flush()
  assert.notEqual(graphics.graphics[0], first, 'a symbol version change redraws the layer')
  occurrence.dispose()
})

test('a heatmap presentation renders through a client-side FeatureLayer with its field and radius', async () => {
  resetCaptured()
  const heatmap = {
    methodVersion: 'map-layers@1',
    presentation: 'heatmap',
    symbolVersion: 'sym-heat@v1',
    heatmap: { field: 'weight', radiusPx: 24, ramp: 'viridis' },
  }
  let current = stateOf({
    layers: [{
      ...layer('hotspots'),
      data: {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { weight: 5 } }],
      },
      symbol: heatmap,
    }],
  })
  const occurrence = createMapOccurrence(() => current, 's1', 'heatmap')
  occurrence.mount(holder())
  await flush()
  const carrier = captured.maps[0].layers.find(item => item instanceof FakeFeatureLayer)
  assert.ok(carrier !== undefined, 'the heatmap layer swaps the graphics carrier for a FeatureLayer')
  assert.equal(carrier.objectIdField, '__fid')
  assert.deepEqual(carrier.fields.map(field => field.name), ['__fid', 'weight'])
  assert.equal(carrier.source.length, 1)
  assert.equal(carrier.source[0].attributes.weight, 5)
  assert.equal(carrier.renderer.radius, 24)
  assert.equal(carrier.renderer.field, 'weight')
  assert.equal(carrier.renderer.colorStops.length, 5)

  // A radius change re-renders through the same carrier.
  current = {
    ...current,
    revision: 2,
    layers: new Map([['hotspots', { ...current.layers.get('hotspots'), symbol: { ...heatmap, symbolVersion: 'sym-heat2@v1', heatmap: { ...heatmap.heatmap, radiusPx: 40 } } }]]),
  }
  occurrence.refresh(current)
  await flush()
  const sameCarrier = captured.maps[0].layers.find(item => item instanceof FakeFeatureLayer)
  assert.equal(sameCarrier, carrier, 'the carrier identity is stable across presentation edits')
  assert.equal(carrier.renderer.radius, 40)

  // Switching back to a single symbol swaps the carrier back to graphics.
  current = {
    ...current,
    revision: 3,
    layers: new Map([['hotspots', { ...current.layers.get('hotspots'), symbol: singleSymbol() }]]),
  }
  occurrence.refresh(current)
  await flush()
  assert.equal(captured.maps[0].layers.some(item => item instanceof FakeFeatureLayer), false, 'the heatmap carrier leaves the map')
  assert.ok(graphicsCarrierOf(captured.maps[0]) !== undefined, 'the graphics carrier returns')
  occurrence.dispose()
})

test('an imagery layer renders through a WebTileLayer with visible and opacity mapped', async () => {
  resetCaptured()
  const imagery = { methodVersion: 'map-layers@1', urlTemplate: 'https://tiles.example.org/base/{level}/{row}/{col}.png', attribution: 'Example' }
  let current = stateOf({
    layers: [{
      id: 'overlay',
      name: 'Example tiles',
      sourceCrs: 'EPSG:4326',
      opacity: 0.6,
      visible: true,
      imagery,
    }],
  })
  const occurrence = createMapOccurrence(() => current, 's1', 'imagery')
  occurrence.mount(holder())
  await flush()
  const tile = captured.tileLayers.find(item => item.urlTemplate === imagery.urlTemplate)
  assert.ok(tile !== undefined, 'the imagery layer mounts as a WebTileLayer')
  assert.equal(tile.copyright, 'Example')
  assert.equal(tile.opacity, 0.6)
  assert.equal(captured.maps[0].layers.some(item => item instanceof FakeGraphicsLayer), false, 'no graphics carrier for an imagery layer')

  current = { ...current, revision: 2, layers: new Map([['overlay', { ...current.layers.get('overlay'), visible: false, opacity: 0.2 }]]) }
  occurrence.refresh(current)
  await flush()
  assert.equal(tile.visible, false)
  assert.equal(tile.opacity, 0.2)
  occurrence.dispose()
})

// ── focus faces: view-local camera framing, never a visibility or projection change ──

function recordGoTo(view) {
  const wentTo = []
  view.goTo = target => { wentTo.push(target); return Promise.resolve() }
  return wentTo
}

function assertBbox(extent, west, south, east, north) {
  assert.ok(Math.abs(extent.xmin - west) < 1e-9, `xmin ${extent.xmin} ~= ${west}`)
  assert.ok(Math.abs(extent.ymin - south) < 1e-9, `ymin ${extent.ymin} ~= ${south}`)
  assert.ok(Math.abs(extent.xmax - east) < 1e-9, `xmax ${extent.xmax} ~= ${east}`)
  assert.ok(Math.abs(extent.ymax - north) < 1e-9, `ymax ${extent.ymax} ~= ${north}`)
}

test('focusLayer frames a hidden layer without showing it; unknown ids are no-ops', async t => {
  resetCaptured()
  const hidden = { ...layer('focus-hidden', [116.4, 39.9]), visible: false }
  let current = stateOf({ layers: [hidden] })
  const occurrence = createMapOccurrence(() => current, 'focus-layer', 'map')
  t.after(() => occurrence.dispose())
  occurrence.mount(holder())
  await flush()
  const view = captured.mapViews[0]
  const wentTo = recordGoTo(view)
  const carrier = captured.maps[0].layers.find(item => item instanceof FakeGraphicsLayer)
  assert.equal(carrier.visible, false, 'the carrier starts hidden from the projection')

  occurrence.focusLayer('focus-hidden')
  assert.equal(carrier.visible, false, 'framing a hidden layer never forces it visible')
  assert.equal(wentTo.length, 1)
  assertBbox(wentTo[0], 116.39, 39.89, 116.41, 39.91)

  occurrence.focusLayer('missing-layer')
  assert.equal(wentTo.length, 1, 'an unknown layer is a no-op')
  occurrence.dispose()
})

test('focusFeature frames one feature bbox; unknown layers, features, and null geometry are no-ops', async t => {
  resetCaptured()
  const featured = layer('focus-features', [116.4, 39.9])
  featured.data.features.push(
    { type: 'Feature', id: 'f2', geometry: { type: 'Point', coordinates: [121.47, 31.23] }, properties: {} },
    { type: 'Feature', id: 'f3', geometry: null, properties: {} },
  )
  let current = stateOf({ layers: [featured] })
  const occurrence = createMapOccurrence(() => current, 'focus-feature', 'map')
  t.after(() => occurrence.dispose())
  occurrence.mount(holder())
  await flush()
  const view = captured.mapViews[0]
  const wentTo = recordGoTo(view)

  occurrence.focusFeature('focus-features', 'f2')
  assert.equal(wentTo.length, 1)
  assertBbox(wentTo[0], 121.46, 31.22, 121.48, 31.24)

  occurrence.focusFeature('focus-features', 'f3')
  occurrence.focusFeature('focus-features', 'missing-feature')
  occurrence.focusFeature('missing-layer', 'f2')
  assert.equal(wentTo.length, 1, 'unknown ids and null geometry never move the camera')
  occurrence.dispose()
})

test('both focus faces mute gesture attribution: camera lands inside the programmatic pulse with zero drafts', async t => {
  resetCaptured()
  const featured = layer('focus-mute', [116.4, 39.9])
  featured.data.features.push({ type: 'Feature', id: 'f2', geometry: { type: 'Point', coordinates: [121.47, 31.23] }, properties: {} })
  let current = stateOf({ layers: [featured] })
  // Manual clock: the mount-time camera sync opens a programmatic pulse, and
  // the test must step past it before the control can form a draft.
  let nowMs = 0
  const clock = { now: () => nowMs, setTimeout: () => 0, clearTimeout: () => {} }
  const occurrence = createMapOccurrence(() => current, 'focus-mute', 'map', { gestureClock: clock })
  t.after(() => occurrence.dispose())
  occurrence.mount(holder())
  await flush()
  const view = captured.mapViews[0]
  const cameraWatch = captured.watches[captured.watches.length - 1]
  // The fake view carries no extent and its center has no x/y until a test
  // sets them; the snapshot reader needs both.
  view.center = { x: 116.4, y: 39.9 }
  view.extent = { xmin: 116.3, ymin: 39.8, xmax: 116.5, ymax: 40 }

  // Control: past the mount pulse, an interaction window plus a camera change forms a draft.
  nowMs = 2_000
  fireViewEvent(view, 'pointer-drag')
  fireWatch(cameraWatch)
  assert.equal(occurrence.getGestureMetrics().draftsFormed, 1, 'the control path must be able to form a draft')

  // The camera landing inside goTo (fired synchronously like the SDK would)
  // stays unattributed: the programmatic pulse precedes every goTo.
  view.goTo = () => { fireWatch(cameraWatch); return Promise.resolve() }
  fireViewEvent(view, 'pointer-drag')
  occurrence.focusLayer('focus-mute')
  occurrence.focusFeature('focus-mute', 'f2')
  assert.equal(occurrence.getGestureMetrics().draftsFormed, 1, 'focus-driven camera writes never become gesture drafts')
  occurrence.dispose()
})

/** One layer carrying a single LineString or Polygon feature. */
function shapeLayer(id, type, extra = {}) {
  const coordinates = type === 'LineString' ? [[116.3, 39.8], [116.5, 40.0]] : [[[116.3, 39.8], [116.5, 39.8], [116.5, 40.0], [116.3, 39.8]]]
  return {
    id, name: id, sourceCrs: 'EPSG:4326', opacity: 1, visible: true,
    data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'f', geometry: { type, coordinates }, properties: { name: id } }] },
    ...extra,
  }
}

test('the Mapbox-style defaults: haloed markers, cased round lines, translucent outlined fills', async () => {
  resetCaptured()
  const legend = color => ({ title: 'l', symbol: { color, outline: '#000000' } })
  const current = stateOf({
    layers: [
      { ...layer('pts'), legend: legend('#4264fb') },
      shapeLayer('roads', 'LineString', { legend: legend('#f2a93b') }),
      shapeLayer('parcels', 'Polygon', { legend: legend('#3ba55c') }),
    ],
  })
  const occurrence = createMapOccurrence(() => current, 'look', 'look:1')
  occurrence.mount(holder())
  await flush()
  const carriers = captured.maps[0].layers.filter(item => item instanceof FakeGraphicsLayer)
  const [pts, roads, parcels] = carriers.map(carrier => carrier.graphics)
  assert.deepEqual(pts[0].symbol.outline, { color: '#ffffff', width: 1.5 }, 'markers wear a white halo')
  assert.equal(roads.length, 2, 'one casing plus one stroke')
  assert.equal(roads[0].symbol.color, 'rgba(255, 255, 255, 0.85)', 'the casing draws first')
  assert.equal(roads[0].symbol.width, roads[1].symbol.width + 2)
  assert.equal(roads[1].symbol.cap, 'round')
  assert.equal(parcels[0].symbol.color, 'rgba(59, 165, 92, 0.3)', 'legend-only fills are translucent')
  assert.notEqual(parcels[0].symbol.outline.color, '#ffffff', 'the outline is a darker shade of the fill')
  occurrence.dispose()
})

test('a semantic symbol resolves below explicit blocks and highlights per geometry', async () => {
  resetCaptured()
  const semantic = { methodVersion: 'map-layers@1', presentation: 'single', symbolVersion: 'sym-sem@v1', semantic: 'route' }
  const current = stateOf({ layers: [shapeLayer('trip', 'LineString', { symbol: semantic })] })
  const occurrence = createMapOccurrence(() => current, 'sem', 'sem:1')
  occurrence.mount(holder())
  await flush()
  const graphics = captured.maps[0].layers.find(item => item instanceof FakeGraphicsLayer).graphics
  const stroke = graphics[1].symbol
  assert.equal(stroke.color, '#1f6feb', 'the route semantic hue')
  assert.equal(stroke.width, 4.5)
  occurrence.setHighlight('trip', new Set(['f']))
  assert.equal(graphics[1].symbol.color, '#00b8ff', 'a selected line takes the highlight stroke, not a fill symbol')
  assert.ok(graphics[1].symbol.width > 4.5)
  occurrence.dispose()
})

test('named features get collision-free layer-colored labels on top, and a hover inspects the topmost feature', async () => {
  resetCaptured()
  const named = (id, lon, name) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [lon, 39.9] }, properties: { name, beds: 10, note: 'x'.repeat(400) } })
  const current = stateOf({
    layers: [{
      id: 'hospitals', name: 'Hospitals', sourceCrs: 'EPSG:4326', opacity: 1, visible: true,
      legend: { title: 'h', symbol: { color: '#e55e5e', outline: '#000000' } },
      // Two features 1px apart: the second label must take another anchor or drop.
      data: { type: 'FeatureCollection', features: [named('a', 116.4, 'Alpha'), named('b', 116.401, 'Beta'), named('c', 116.5, 'Gamma')] },
    }],
  })
  const inspections = []
  const occurrence = createMapOccurrence(() => current, 'lbl', 'lbl:1', { onInspect: value => inspections.push(value) })
  occurrence.mount(holder())
  await flush()
  const map = captured.maps[0]
  const handle = globalThis.__mapHarness.get('lbl:lbl:1')
  assert.equal(map.layers.some(item => item.title === 'labels'), false, 'labels never become a map layer')
  assert.deepEqual(handle.labels.map(label => label.text).sort(), ['Alpha', 'Beta', 'Gamma'])
  assert.equal(handle.labels[0].color, '#b74b4b', 'labels wear the layer color, darkened for legibility')
  assert.equal(globalThis.__mapHarness.get('lbl:lbl:1').labelCount, 3)
  const carrier = map.layers.find(item => item.title === 'Hospitals')
  const feature = carrier.graphics[2]
  assert.equal([...feature.attributes.note].length, 256, 'long attribute strings are truncated before reaching a graphic')
  const view = captured.mapViews[0]
  view.hitResults = [{ type: 'graphic', graphic: feature }]
  await fireViewHover(view, { x: 500, y: 300 })
  await fireViewHover(view, { x: 501, y: 300 })
  assert.equal(inspections.length, 1, 'moving within one feature reports it once')
  assert.equal(inspections[0].featureId, 'c', 'the data feature answers')
  assert.equal(inspections[0].title, 'Gamma')
  assert.deepEqual(inspections[0].fields.map(field => field.name), ['name', 'beds', 'note'])
  assert.equal(feature.symbol.outline.color, '#00b8ff', 'the inspected feature takes the highlight')
  assert.deepEqual(view.lastHitInclude, [carrier], 'hit tests only include visible data carriers')
  view.hitResults = []
  await fireViewHover(view, { x: 10, y: 10 })
  assert.equal(inspections.at(-1), null, 'hovering off every feature closes the card')
  view.hitResults = [{ type: 'graphic', graphic: feature }]
  await fireViewHover(view, { x: 500, y: 300 })
  await fireViewHover(view, null)
  assert.equal(inspections.at(-1), null, 'leaving the view closes the card')
  occurrence.dispose()
})

test('a label zoom range outside the view zoom hides the layer labels', async () => {
  resetCaptured()
  const symbol = { methodVersion: 'map-layers@1', presentation: 'single', symbolVersion: 'sym-z@v1', semantic: 'poi', label: { field: 'name', minZoom: 15 } }
  const current = stateOf({ zoom: 9, layers: [{ ...layer('poi', [116.4, 39.9], { name: 'Zoomed' }), symbol }] })
  const occurrence = createMapOccurrence(() => current, 'lblz', 'lblz:1')
  occurrence.mount(holder())
  await flush()
  captured.mapViews[0].zoom = 9
  const map = captured.maps[0]
  assert.equal(globalThis.__mapHarness.get('lblz:lblz:1').labelCount, 0)
  captured.mapViews[0].zoom = 16
  const stationary = captured.watches.find(entry => entry.getter.toString().includes('stationary'))
  stationary.callback(true)
  assert.equal(globalThis.__mapHarness.get('lblz:lblz:1').labels[0].text, 'Zoomed', 'settling inside the range places the label')
  occurrence.dispose()
})

test('a layer added after mount frames into view; mount, replay, in-view layers, and camera moves do not', async () => {
  resetCaptured()
  let current = stateOf({ layers: [layer('first', [116.4, 39.9])] })
  const occurrence = createMapOccurrence(() => current, 'frame', 'frame:1')
  occurrence.mount(holder())
  await flush()
  const view = captured.mapViews[0]
  const wentTo = []
  view.goTo = target => { wentTo.push(target); return Promise.resolve() }
  occurrence.refresh(current)
  assert.equal(wentTo.length, 0, 'the mounted layers never auto-frame')

  current = stateOf({ revision: 1, layers: [layer('first', [116.4, 39.9]), layer('second', [121.47, 31.23])] })
  occurrence.refresh(current)
  await flush()
  assert.equal(wentTo.length, 1, 'the newly produced layer frames')
  assert.ok(wentTo[0].xmin < 121.47 && wentTo[0].xmax > 121.47, 'the frame contains the new layer')

  current = stateOf({ revision: 2, layers: [...current.layers.values(), layer('near', [116.41, 39.9])] })
  occurrence.refresh(current)
  await flush()
  assert.equal(wentTo.length, 1, 'a new layer already in view keeps the camera')

  current = stateOf({ revision: 3, center: [100, 30], layers: [...current.layers.values(), layer('third', [113.26, 23.13])] })
  occurrence.refresh(current)
  await flush()
  assert.equal(wentTo.length, 1, 'a revision that also sets the view keeps that view')
  occurrence.dispose()
})

test('every settled 2D camera reports the viewport as implicit context', async () => {
  resetCaptured()
  const current = stateOf({ layers: [layer('v', [116.4, 39.9])] })
  const reports = []
  const occurrence = createMapOccurrence(() => current, 'vp', 'vp:1', { onViewport: snapshot => reports.push(snapshot) })
  occurrence.mount(holder())
  await flush()
  const view = captured.mapViews[0]
  view.center = { x: 116.4, y: 39.9 }
  view.extent = { xmin: 116.3, ymin: 39.8, xmax: 116.5, ymax: 40 }
  view.spatialReference = { wkid: 4326 }
  view.zoom = 11
  const stationary = captured.watches.find(entry => entry.getter.toString().includes('stationary'))
  stationary.callback(false)
  assert.equal(reports.length, 0, 'a moving camera reports nothing')
  stationary.callback(true)
  assert.equal(reports.length, 1)
  assert.deepEqual(reports[0].extent, [116.3, 39.8, 116.5, 40])
  assert.equal(reports[0].mode, 'map')
  occurrence.dispose()
})
