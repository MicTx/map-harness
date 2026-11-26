/**
 * Contract test for the Mapbox-style control camera API on a real
 * createMapOccurrence instance backed by the ArcGIS doubles.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { captured, resetCaptured } from './arcgis-doubles.mjs'

const doublesUrl = new URL('./arcgis-doubles.mjs', import.meta.url).href
const exportBySpecifier = {
  '@arcgis/core/Map.js': 'FakeMap',
  '@arcgis/core/views/MapView.js': 'FakeMapView',
  '@arcgis/core/views/SceneView.js': 'FakeSceneView',
  '@arcgis/core/layers/WebTileLayer.js': 'FakeTileLayer',
  '@arcgis/core/layers/BaseTileLayer.js': 'FakeTileLayer',
  '@arcgis/core/layers/MapImageLayer.js': 'FakeMapImageLayer',
  '@arcgis/core/layers/TileLayer.js': 'FakeArcgisTileLayer',
  '@arcgis/core/layers/WMTSLayer.js': 'FakeWmtsLayer',
  '@arcgis/core/layers/FeatureLayer.js': 'FakeFeatureLayer',
  '@arcgis/core/layers/GraphicsLayer.js': 'FakeGraphicsLayer',
  '@arcgis/core/config.js': 'default',
  '@arcgis/core/widgets/Sketch/SketchViewModel.js': 'FakeSketchViewModel',
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

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@arcgis/core/core/reactiveUtils.js') return { url: doublesUrl, shortCircuit: true }
    if (specifier === '@arcgis/core/geometry/projectionUtils.js') return { url: doublesUrl, shortCircuit: true }
    if (specifier.startsWith('@arcgis/core/')) {
      const name = exportBySpecifier[specifier]
      if (name === undefined) throw new Error(`no ArcGIS double for ${specifier}`)
      const source = `export { ${name} as default } from ${JSON.stringify(doublesUrl)}`
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

class FakeDiv {}
if (globalThis.HTMLDivElement === undefined) globalThis.HTMLDivElement = FakeDiv

const { createMapOccurrence } = await import('../src/client/occurrence.ts')
const { scaleFromZoom } = await import('../src/client/view-policy.ts')

const flush = () => new Promise(resolve => setImmediate(resolve))

function stateOf() {
  return {
    mode: 'map',
    view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 },
    basemap: null,
    imageryDisplay: { labelsVisible: false, recentVisible: true, recentOpacity: 1, earlyVisible: false },
    layers: new Map(),
    revision: 0,
  }
}

function mounted(t, sessionId = 'control-api-session') {
  resetCaptured()
  const occurrence = createMapOccurrence(() => stateOf(), sessionId, `${sessionId}-tab`)
  t.after(() => occurrence.dispose())
  occurrence.mount(new FakeDiv())
  return occurrence
}

test('no-view control calls fail closed without writing camera state', t => {
  resetCaptured()
  const occurrence = createMapOccurrence(() => stateOf(), 'unmounted-controls', 'unmounted-tab')
  t.after(() => occurrence.dispose())
  assert.equal(occurrence.mapControlState(), null)
  assert.equal(occurrence.zoomBy(1), 'no-view')
  assert.equal(occurrence.resetBearing(), 'no-view')
  assert.equal(captured.mapViews.length, 0)
})

test('zoomBy clamps the step and resumes from scale when zoom is unreadable', async t => {
  const occurrence = mounted(t, 'zoom-controls')
  await flush()
  const view = captured.mapViews[0]
  assert.ok(view !== undefined)
  view.zoom = 9
  view.scale = scaleFromZoom(9)
  assert.equal(occurrence.zoomBy(1), 'applied')
  assert.equal(view.zoom, 10)
  assert.equal(view.scale, scaleFromZoom(10))
  assert.equal(occurrence.zoomBy(99), 'applied')
  assert.equal(view.zoom, 14)
  view.zoom = -1
  assert.equal(occurrence.zoomBy(-1), 'applied')
  assert.ok(view.zoom > 0)
})

test('resetBearing clears rotation and mapControlState reports it with a scale label', async t => {
  const occurrence = mounted(t, 'compass-controls')
  await flush()
  const view = captured.mapViews[0]
  assert.ok(view !== undefined)
  view.rotation = 32
  view.scale = 500_000
  const before = occurrence.mapControlState()
  assert.ok(before !== null)
  assert.equal(before.rotation, 32)
  assert.match(before.scaleLabel ?? '', /^\d+(\.\d+)? (m|km)$/)
  assert.equal(occurrence.resetBearing(), 'applied')
  assert.equal(view.rotation, 0)
  assert.equal(occurrence.mapControlState()?.rotation, 0)
  view.scale = 0
  assert.equal(occurrence.mapControlState()?.scaleLabel, null)
})
