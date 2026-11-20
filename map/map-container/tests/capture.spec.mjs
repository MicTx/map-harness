/**
 * The public capture face: one PNG of the live view with its viewport fix, and
 * the three distinct refusals (no view, SDK hang, SDK throw) as plain objects.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { createMapObservationService } from '../src/observation.ts'
import { FIXED_BASEMAP_DESCRIPTOR, expectedObservationSources } from '../src/observation-protocol.ts'
import { createMapSourceCatalog } from '../src/sources.ts'
import {
  captured,
  resetCaptured,
  FakeMap,
  FakeTileLayer,
  FakeMapImageLayer,
  FakeArcgisTileLayer,
  FakeWmtsLayer,
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

class FakeDiv {
  appendChild() {}
}

/** Minimal canvas/Image seam for the composite stage in Node tests. */
class FakeCanvasContext {
  drawImage() {}
  fillRect() {}
  fillText() {}
  strokeText() {}
  measureText(text) { return { width: text.length * 6 } }
}
class FakeCanvas {
  constructor() {
    this.width = 0
    this.height = 0
    this.style = {}
  }
  setAttribute() {}
  getContext() { return new FakeCanvasContext() }
  toDataURL() { return 'data:image/png;base64,AAAA' }
}
class FakeElement {
  constructor() {
    this.style = {}
    this.textContent = null
  }
  setAttribute() {}
}
class FakeImage {
  constructor() {
    this.width = 800
    this.height = 600
  }
  set src(_value) { queueMicrotask(() => this.onload?.()) }
}
if (globalThis.HTMLDivElement === undefined) globalThis.HTMLDivElement = FakeDiv
if (globalThis.document === undefined) {
  globalThis.document = { createElement: tag => (tag === 'canvas' ? new FakeCanvas() : new FakeElement()) }
}
if (globalThis.Image === undefined) globalThis.Image = FakeImage

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
  '@arcgis/core/widgets/Sketch/SketchViewModel.js': 'FakeSketchViewModel',
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@arcgis/core/core/reactiveUtils.js'
      || specifier === '@arcgis/core/geometry/projectionUtils.js'
      || specifier === '@arcgis/core/config.js') return { url: doublesUrl, shortCircuit: true }
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
  return {
    mode: 'map',
    view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 },
    layers: new Map(),
    revision: 0,
    basemap: null,
    imageryDisplay: {
      labelsVisible: false,
      recentVisible: true,
      recentOpacity: 1,
      earlyVisible: false,
      earlySource: null,
    },
  }
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
  assert.deepEqual(view.screenshotCalls, [{ format: 'png', ignorePadding: true, width: 800, height: 600 }])
  assert.deepEqual(result.viewport, {
    center: [116.4, 39.9],
    zoom: 9,
    extent: [116, 39.5, 116.8, 40.3],
    wkid: 3857,
    mode: 'map',
    scale: 591657527.591555 / 2 ** 9,
  })
})

test('a view that cannot report its camera still yields the PNG, with no viewport', async t => {
  const { occurrence, view } = await mounted(t, { sessionId: 'capture-no-camera' })
  view.center = undefined
  const result = await occurrence.captureView()
  assert.equal(result.dataUrl, 'data:image/png;base64,AAAA')
  assert.equal(result.viewport, null)
})

test('an unready request survives passive initial camera and layout changes, then captures once', { timeout: 10_000 }, async () => {
  resetCaptured()
  captured.holdNextView = true
  const currentState = {
    ...stateOf(),
    observationRequest: {
      callId: 'obs-delayed-ready',
      requestSeq: 4,
      revision: 0,
      expiresAtMs: Date.now() + 8_000,
    },
  }
  let releaseClaim
  let releaseCapture
  const claimSeen = new Promise(resolve => { releaseClaim = resolve })
  const captureSeen = new Promise(resolve => { releaseCapture = resolve })
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push(body)
    if (body.action === 'claim') {
      releaseClaim()
      return { json: async () => ({ status: 'claimed', token: 'one-claim-token' }) }
    }
    if (body.kind === 'capture') releaseCapture(body)
    return { ok: true }
  }
  const occurrence = createMapOccurrence(() => currentState, 'capture-delayed-ready', 'view:map')
  occurrence.mount(new FakeDiv())
  try {
    const view = captured.mapViews[0]
    assert.ok(view)
    assert.ok(view.pendingWhens.length > 0, 'the initial render is held behind the barrier')
    await claimSeen

    // These initial SDK assignments are passive setup while no frozen capture
    // identity exists; they must not consume the pending observation.
    view.center = new FakePoint({ x: 116.45, y: 39.91 })
    view.padding = { top: 14, right: 22, bottom: 10, left: 18 }
    view.width = 720
    view.height = 520
    for (const entry of [...captured.watches]) entry.callback()
    assert.equal(requests.filter(item => item.action === 'claim').length, 1)
    assert.equal(requests.some(item => item.action === 'cancel'), false)

    view.releaseWhens()
    const submission = await captureSeen
    assert.equal(submission.kind, 'capture')
    assert.equal(submission.capture.renderedRevision, 0)
    assert.equal(submission.capture.cssViewSize.width, 720)
    assert.equal(submission.capture.cssViewSize.height, 520)
    assert.equal(view.screenshotCalls.length, 1, 'one owned attempt produces one screenshot')
    assert.equal(requests.filter(item => item.kind === 'capture').length, 1)
  } finally {
    occurrence.dispose()
    globalThis.fetch = previousFetch
  }
})

test('the live occurrence captures unverified displayed sources without a policy decline', { timeout: 5_000 }, async () => {
  resetCaptured()
  const catalog = createMapSourceCatalog(undefined, 'unverified', {})
  const selection = catalog.selection('esri-world-imagery', 'amap-imagery-labels').value
  const state = {
    ...stateOf(),
    basemap: selection,
    imageryDisplay: { ...stateOf().imageryDisplay, labelsVisible: true },
    observationRequest: { callId: 'obs-unverified', requestSeq: 4, revision: 0, expiresAtMs: Date.now() + 4_000 },
  }
  const descriptor = {
    schemaVersion: 1,
    sessionId: 'capture-unverified',
    runtimeEpoch: '66666666-5555-4444-8333-222222222222',
    mode: 'map',
    engineWkid: 3857,
    basemap: { source: selection.basemap, nativeEpoch: '77777777-6666-4555-8444-333333333333', layerKind: 'arcgis-tile', transport: 'public-preset', presetId: selection.basemap.id },
    labels: { source: selection.labels, nativeEpoch: '88888888-7777-4666-8555-444444444444', layerKind: 'web-tile', transport: 'controlled', resourceHref: '/api/map/sources/resource' },
    earlyImagery: null,
    display: state.imageryDisplay,
  }
  const previousFetch = globalThis.fetch
  const requests = []
  let complete
  const finished = new Promise(resolve => { complete = resolve })
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push(body)
    if (body.action === 'claim') return { json: async () => ({ status: 'claimed', token: 'capture-token' }) }
    if (body.kind === 'capture' || body.kind === 'decline') complete(body)
    return { ok: true }
  }
  const occurrence = createMapOccurrence(() => state, 'capture-unverified', 'view:map', {
    loadRenderDescriptor: async () => descriptor,
  })
  try {
    occurrence.mount(new FakeDiv())
    const result = await finished
    assert.equal(result.kind, 'capture')
    assert.deepEqual(result.capture.sources, expectedObservationSources([], selection, state.imageryDisplay).sources)
    assert.deepEqual(result.capture.sources.map(source => source.policy), ['unverified', 'unverified'])
    assert.equal(captured.mapViews[0].screenshotCalls.length, 1)
    assert.equal(requests.some(request => request.code === 'policy'), false)
  } finally {
    occurrence.dispose()
    globalThis.fetch = previousFetch
  }
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

test('a camera change after freeze settles the registry and bounds blocked cleanup without SDK submit', { timeout: 5_000 }, async () => {
  resetCaptured()
  const expiresAtMs = Date.now() + 1_200
  const request = { callId: 'obs-camera-move', requestSeq: 4, revision: 0, expiresAtMs }
  const state = { ...stateOf(), observationRequest: request }
  const controller = new AbortController()
  const service = createMapObservationService()
  const waiting = service.waitFor({
    sessionId: 'capture-camera-move',
    ...request,
    signal: controller.signal,
    readCurrent: () => ({
      request: { callId: request.callId, requestSeq: request.requestSeq, revision: request.revision },
      revision: 0,
      sources: [FIXED_BASEMAP_DESCRIPTOR],
      captureAllowed: true,
    }),
  })
  let releaseScreenshot
  let screenshotStarted
  let cleanupAborted
  const started = new Promise(resolve => { screenshotStarted = resolve })
  const cleanupAbortedPromise = new Promise(resolve => { cleanupAborted = resolve })
  const previousFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body)
    if (body.action === 'claim') {
      const claim = await service.claim({
        sessionId: body.sessionId,
        callId: body.callId,
        requestSeq: body.requestSeq,
        revision: body.revision,
        expiresAtMs: body.expiresAtMs,
        signal: options.signal,
      })
      return { json: async () => claim }
    }
    if (body.kind === 'decline') {
      await service.submit(body)
      return await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          cleanupAborted()
          reject(options.signal.reason)
        }, { once: true })
      })
    }
    if (body.action === 'cancel') {
      const result = service.cancelWire(body)
      return { ok: result.ok }
    }
    if (body.kind === 'capture') {
      return { ok: true }
    }
    return { ok: false }
  }
  const occurrence = createMapOccurrence(() => state, 'capture-camera-move', 'view:map')
  occurrence.mount(new FakeDiv())
  try {
    const view = captured.mapViews[0]
    assert.ok(view)
    view.screenshot = () => new Promise(resolve => {
      releaseScreenshot = resolve
      screenshotStarted()
    })
    await started
    assert.equal(view.screenshotCalls.length, 1)
    view.center = new FakePoint({ x: 116.5, y: 39.95 })
    for (const entry of [...captured.watches]) entry.callback()
    assert.equal((await waiting).status, 'declined')
    assert.equal(service.pendingCount, 0)
    assert.equal(service.earlyClaimCount, 0)
    await cleanupAbortedPromise
    assert.equal(calls.some(call => call.kind === 'capture'), false, 'no late SDK result is submitted')
    releaseScreenshot({ dataUrl: 'data:image/png;base64,AAAA', data: { width: 800, height: 600, data: new Uint8ClampedArray(800 * 600 * 4) } })
  } finally {
    occurrence.dispose()
    service.dispose()
    globalThis.fetch = previousFetch
  }
})

test('a highlight change during screenshot capture refuses the in-flight observation', { timeout: 5_000 }, async () => {
  resetCaptured()
  const request = { callId: 'obs-highlight-change', requestSeq: 4, revision: 0, expiresAtMs: Date.now() + 4_000 }
  const state = {
    ...stateOf(),
    layers: new Map([['coverage', {
      id: 'coverage', name: 'coverage', sourceCrs: 'EPSG:4326', opacity: 1, visible: true,
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'site',
        geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'site' } }] },
    }]]),
    observationRequest: request,
  }
  const service = createMapObservationService()
  const controller = new AbortController()
  const waiting = service.waitFor({
    sessionId: 'capture-highlight-change', ...request, signal: controller.signal,
    readCurrent: () => ({
      request: { callId: request.callId, requestSeq: request.requestSeq, revision: request.revision },
      revision: 0, sources: expectedObservationSources([...state.layers.values()], null, state.imageryDisplay).sources,
      captureAllowed: true,
    }),
  })
  const previousFetch = globalThis.fetch
  const calls = []
  let releaseScreenshot
  let markStarted
  const started = new Promise(resolve => { markStarted = resolve })
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body)
    if (body.action === 'claim') return { json: async () => service.claim({ ...body, signal: options.signal }) }
    if (body.kind === 'decline') return { ok: (await service.submit(body)).ok }
    if (body.action === 'cancel') return { ok: service.cancelWire(body).ok }
    return { ok: true }
  }
  const occurrence = createMapOccurrence(() => state, 'capture-highlight-change', 'view:map')
  try {
    occurrence.mount(new FakeDiv())
    captured.mapViews[0].screenshot = () => new Promise(resolve => { releaseScreenshot = resolve; markStarted() })
    await started
    occurrence.setHighlight('coverage', new Set(['site']))
    releaseScreenshot({ dataUrl: 'data:image/png;base64,AAAA', data: { width: 800, height: 600, data: new Uint8ClampedArray(800 * 600 * 4) } })
    const outcome = await waiting
    assert.deepEqual(outcome, { status: 'declined', code: 'stale' })
    assert.equal(calls.some(call => call.kind === 'capture'), false)
  } finally {
    releaseScreenshot?.({ dataUrl: 'data:image/png;base64,AAAA', data: { width: 800, height: 600, data: new Uint8ClampedArray(800 * 600 * 4) } })
    occurrence.dispose()
    service.dispose()
    globalThis.fetch = previousFetch
  }
})

test('actual view, layout, projection, request, and generation changes settle frozen occurrence captures', { timeout: 30_000 }, async t => {
  const cases = [
    ['camera center', ({ view }) => { view.center = new FakePoint({ x: 116.5, y: 40 }) }, true],
    ['camera extent', ({ view }) => { view.extent = new FakeExtent({ xmin: 115, ymin: 38, xmax: 118, ymax: 41 }) }, true],
    ['camera scale', ({ view }) => { view.scale += 100 }, true],
    ['camera zoom', ({ view }) => { view.zoom += 1 }, true],
    ['camera rotation', ({ view }) => { view.rotation = 23 }, true],
    ['camera WKID', ({ view }) => { view.spatialReference = FakeSpatialReference.fromJSON({ wkid: 4326 }) }, true],
    ['CSS resize', ({ view }) => { view.width = 720; view.height = 520 }, true],
    ['padding', ({ view }) => { view.padding = { top: 15, right: 20, bottom: 10, left: 25 } }, true],
    ['map revision', ({ state }) => { state.revision += 1 }, false],
    ['source set', ({ state }) => {
      state.layers.set('points', { id: 'points', visible: true, opacity: 1, displayDigest: 'source-v2' })
    }, false],
    ['request replacement', ({ state }) => {
      state.observationRequest = { ...state.observationRequest, callId: 'obs-replacement', requestSeq: 5 }
    }, false],
    ['view generation replacement', ({ occurrence, state }) => {
      state.mode = 'scene'
      state.observationRequest = null
      occurrence.refresh(state)
    }, false],
    ['dispose while SDK screenshot is blocked', ({ occurrence }) => occurrence.dispose(), false],
    ['move away then back', ({ view }) => {
      const center = view.center
      view.center = new FakePoint({ x: 116.6, y: 40.1 })
      for (const entry of [...captured.watches]) entry.callback()
      view.center = center
      for (const entry of [...captured.watches]) entry.callback()
    }, true],
  ]
  for (const [name, mutate, fireWatchers] of cases) {
    await t.test(name, { timeout: 5_000 }, async () => {
      resetCaptured()
      const sessionId = `capture-integrated-${name.replaceAll(' ', '-')}`
      const request = { callId: `obs-${name.replaceAll(' ', '-')}`, requestSeq: 4, revision: 0, expiresAtMs: Date.now() + 8_000 }
      const state = { ...stateOf(), observationRequest: request }
      const controller = new AbortController()
      const service = createMapObservationService()
      const waiting = service.waitFor({
        sessionId,
        ...request,
        signal: controller.signal,
        readCurrent: () => ({
          request: state.observationRequest === null ? null : {
            callId: state.observationRequest.callId,
            requestSeq: state.observationRequest.requestSeq,
            revision: state.observationRequest.revision,
          },
          revision: state.revision,
          sources: [FIXED_BASEMAP_DESCRIPTOR],
          captureAllowed: true,
        }),
      })
      const previousFetch = globalThis.fetch
      const calls = []
      let releaseScreenshot
      let markScreenshotStarted
      const screenshotStarted = new Promise(resolve => { markScreenshotStarted = resolve })
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body)
        calls.push(body)
        if (body.action === 'claim') {
          const claim = await service.claim({ ...body, signal: options.signal })
          return { json: async () => claim }
        }
        if (body.kind === 'decline') return { ok: (await service.submit(body)).ok }
        if (body.action === 'cancel') return { ok: service.cancelWire(body).ok }
        if (body.kind === 'capture') return { ok: true }
        return { ok: false }
      }
      const occurrence = createMapOccurrence(() => state, sessionId, 'view:map')
      occurrence.mount(new FakeDiv())
      const view = captured.mapViews[0]
      assert.ok(view)
      view.screenshot = () => new Promise(resolve => {
        releaseScreenshot = resolve
        markScreenshotStarted()
      })
      try {
        await screenshotStarted
        mutate({ view, state, occurrence })
        if (fireWatchers) for (const entry of [...captured.watches]) entry.callback()
        releaseScreenshot({ dataUrl: 'data:image/png;base64,AAAA', data: { width: 800, height: 600, data: new Uint8ClampedArray(800 * 600 * 4) } })
        const outcome = await waiting
        assert.ok(['declined', 'cancelled'].includes(outcome.status), `${name} registry settled: ${outcome.status}`)
        assert.equal(service.pendingCount, 0)
        assert.equal(service.earlyClaimCount, 0)
        assert.equal(calls.some(call => call.kind === 'capture'), false, 'no late SDK result is submitted')
        releaseScreenshot({ dataUrl: 'data:image/png;base64,AAAA', data: { width: 800, height: 600, data: new Uint8ClampedArray(800 * 600 * 4) } })
        await flush()
        assert.equal(calls.some(call => call.kind === 'capture'), false)
      } finally {
        occurrence.dispose()
        releaseScreenshot?.({ dataUrl: 'data:image/png;base64,AAAA', data: { width: 800, height: 600, data: new Uint8ClampedArray(800 * 600 * 4) } })
        service.dispose()
        globalThis.fetch = previousFetch
      }
      assert.equal(captured.watches.length, 0, 'dispose removes owned property watchers')
    })
  }
})

test('disposing during blocked image decode cancels the registry and removes decode/watch listeners', { timeout: 5_000 }, async () => {
  resetCaptured()
  const sessionId = 'capture-dispose-decode'
  const request = { callId: 'obs-dispose-decode', requestSeq: 4, revision: 0, expiresAtMs: Date.now() + 4_000 }
  const state = { ...stateOf(), observationRequest: request }
  const controller = new AbortController()
  const service = createMapObservationService()
  const waiting = service.waitFor({
    sessionId,
    ...request,
    signal: controller.signal,
    readCurrent: () => ({
      request: state.observationRequest,
      revision: state.revision,
      sources: [FIXED_BASEMAP_DESCRIPTOR],
      captureAllowed: true,
    }),
  })
  const previousFetch = globalThis.fetch
  const previousImage = globalThis.Image
  let capturePosts = 0
  let image
  let announceDecode
  const decodeStarted = new Promise(resolve => { announceDecode = resolve })
  globalThis.Image = class {
    width = 800
    height = 600
    onload = null
    onerror = null
    set src(value) {
      if (value !== '') {
        image = this
        announceDecode()
      }
    }
  }
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    if (body.action === 'claim') {
      const claim = await service.claim({ ...body, signal: options.signal })
      return { json: async () => claim }
    }
    if (body.action === 'cancel') return { ok: service.cancelWire(body).ok }
    if (body.kind === 'decline') return { ok: (await service.submit(body)).ok }
    if (body.kind === 'capture') {
      capturePosts += 1
      return { ok: true }
    }
    return { ok: false }
  }
  const occurrence = createMapOccurrence(() => state, sessionId, 'view:map')
  try {
    occurrence.mount(new FakeDiv())
    await decodeStarted
    occurrence.dispose()
    assert.ok(['declined', 'cancelled'].includes((await waiting).status))
    assert.equal(service.pendingCount, 0)
    assert.equal(capturePosts, 0)
    assert.equal(image.onload, null)
    assert.equal(image.onerror, null)
    assert.equal(captured.watches.length, 0)
  } finally {
    occurrence.dispose()
    service.dispose()
    globalThis.fetch = previousFetch
    globalThis.Image = previousImage
  }
})

test('a failed fixed basemap makes the receipt unhealthy and declines before SDK screenshot', { timeout: 5_000 }, async () => {
  resetCaptured()
  const state = {
    ...stateOf(),
    observationRequest: {
      callId: 'obs-basemap-failure',
      requestSeq: 5,
      revision: 0,
      expiresAtMs: Date.now() + 4_000,
    },
  }
  const previousFetch = globalThis.fetch
  const requests = []
  let declineSeen
  const declined = new Promise(resolve => { declineSeen = resolve })
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push(body)
    if (body.action === 'claim') return { json: async () => ({ status: 'claimed', token: 'basemap-token' }) }
    if (body.kind === 'decline') {
      declineSeen(body)
      return { ok: true }
    }
    return { ok: true }
  }
  const occurrence = createMapOccurrence(() => state, 'capture-basemap-failure', 'view:map')
  try {
    occurrence.mount(new FakeDiv())
    const view = captured.mapViews[0]
    assert.ok(view)
    view.layerError = 'World Imagery'
    await declined
    await flush()
    assert.equal(occurrence.getRenderReceipt().status, 'failed')
    assert.deepEqual(occurrence.getRenderReceipt().failedLayers, [{ layerId: 'basemap', code: 'BASEMAP_FAILED' }])
    assert.equal(requests.find(request => request.kind === 'decline').code, 'not-ready')
    assert.equal(requests.some(request => request.kind === 'capture'), false)
    assert.equal(view.screenshotCalls?.length ?? 0, 0)
  } finally {
    occurrence.dispose()
    globalThis.fetch = previousFetch
  }
})
