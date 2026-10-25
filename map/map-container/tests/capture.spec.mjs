/**
 * The public capture face: one PNG of the live view with its viewport fix, and
 * the three distinct refusals (no view, SDK hang, SDK throw) as plain objects.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import {
  captured,
  resetCaptured,
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

registerHooks({
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

const { createMapOccurrence, setCaptureTimeoutForTest } = await import('../src/client/occurrence.ts')

const flush = () => new Promise(resolve => setImmediate(resolve))

function stateOf() {
  return { mode: 'map', view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 }, layers: new Map(), revision: 0 }
}

/** A mounted occurrence whose live view reports a readable camera and the test's screenshot behavior. */
async function mounted(t, { sessionId, screenshot } = {}) {
  resetCaptured()
  const occurrence = createMapOccurrence(() => stateOf(), sessionId, 'view:map')
  t.after(() => occurrence.dispose())
  occurrence.mount(new FakeDiv())
  await flush()
  const view = captured.mapViews[0]
  assert.ok(view !== undefined, 'the occurrence mounted a 2D view')
  view.center = new FakePoint({ x: 116.4, y: 39.9 })
  view.extent = new FakeExtent({ xmin: 116, ymin: 39.5, xmax: 116.8, ymax: 40.3 })
  view.zoom = 9
  view.scale = 591657527.591555 / 2 ** 9
  if (screenshot !== undefined) view.screenshot = screenshot
  return { occurrence, view }
}

test('a live view captures its PNG together with the viewport fix', async t => {
  const { occurrence, view } = await mounted(t, { sessionId: 'capture-ok' })
  const result = await occurrence.captureView()
  assert.equal(result.dataUrl, 'data:image/png;base64,AAAA')
  assert.deepEqual(view.screenshotCalls, [{ format: 'png' }])
  assert.deepEqual(result.viewport, {
    center: [116.4, 39.9],
    zoom: 9,
    extent: [116, 39.5, 116.8, 40.3],
    wkid: 3857,
    mode: 'map',
  })
})

test('a view that cannot report its camera still yields the PNG, with no viewport', async t => {
  const { occurrence, view } = await mounted(t, { sessionId: 'capture-no-camera' })
  view.center = undefined
  const result = await occurrence.captureView()
  assert.equal(result.dataUrl, 'data:image/png;base64,AAAA')
  assert.equal(result.viewport, null)
})

test('an occurrence without a live view refuses with no-view', async () => {
  resetCaptured()
  const occurrence = createMapOccurrence(() => stateOf(), 'capture-no-view', 'view:map')
  await assert.rejects(occurrence.captureView(), error => error.code === 'no-view')
  occurrence.dispose()
})

test('a destroyed view refuses with no-view', async t => {
  const { occurrence, view } = await mounted(t, { sessionId: 'capture-destroyed' })
  view.destroyed = true
  await assert.rejects(occurrence.captureView(), error => error.code === 'no-view')
})

test('an SDK capture that never settles reports capture-timeout', async t => {
  const { occurrence } = await mounted(t, {
    sessionId: 'capture-hang',
    screenshot: () => new Promise(() => {}),
  })
  setCaptureTimeoutForTest(40)
  t.after(() => setCaptureTimeoutForTest(5_000))
  // The face's own deadline is the only thing that can end this promise.
  await assert.rejects(occurrence.captureView(), error => error.code === 'capture-timeout')
})

test('an SDK throw reports capture-failed with its detail', async t => {
  const { occurrence } = await mounted(t, {
    sessionId: 'capture-throw',
    screenshot: () => Promise.reject(new Error('canvas unavailable')),
  })
  await assert.rejects(occurrence.captureView(), error => error.code === 'capture-failed' && error.detail === 'canvas unavailable')
})
