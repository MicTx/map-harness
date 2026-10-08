import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import {
  captured,
  resetCaptured,
  flushRenderWaits,
  FakeMap,
  FakeTileLayer,
  FakeMapImageLayer,
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

test('removing a layer drops its rendered identity; re-adding rebuilds, and occurrences stay independent', async () => {
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

  // A second occurrence of the same session renders from its own cache: its
  // earlier state is untouched by the first occurrence's later refresh.
  const other = createMapOccurrence(() => stateOf({ layers: [layer('a')] }), 's1', 'panel:map')
  other.mount(holder())
  await flush()
  assert.equal(captured.maps.length, 2)
  const otherGraphics = captured.maps[1].layers.find(item => item.graphics !== undefined)
  assert.equal(otherGraphics.graphics.length, 1)
  other.dispose()
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
  assert.equal(graphics[0].symbol.outline.color, '#ffdf00', 'the selected feature wears the highlight outline')
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
