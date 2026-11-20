import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import arcgisConfig from './arcgis-doubles.mjs'
import {
  captured,
  resetCaptured,
  flushRenderWaits,
  fireViewEvent,
  fireWatch,
  FakeMap,
  FakeTileLayer,
  FakeMapImageLayer,
  FakeArcgisTileLayer,
  FakeWmtsLayer,
  FakeFeatureLayer,
  FakeGraphicsLayer,
  FakeSketchViewModel,
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
  '@arcgis/core/layers/BaseTileLayer.js': 'FakeTileLayer',
  '@arcgis/core/layers/MapImageLayer.js': 'FakeMapImageLayer',
  '@arcgis/core/layers/TileLayer.js': 'FakeArcgisTileLayer',
  '@arcgis/core/layers/WMTSLayer.js': 'FakeWmtsLayer',
  '@arcgis/core/config.js': 'default',
  '@arcgis/core/layers/FeatureLayer.js': 'FakeFeatureLayer',
  '@arcgis/core/layers/GraphicsLayer.js': 'FakeGraphicsLayer',
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

const hook = registerHooks({
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

const { createMapOccurrence } = await import('../src/client/occurrence.ts')
const { KEY_FREE_BASEMAP, WEB_MERCATOR_ZOOM0_SCALE } = await import('../src/client/view-policy.ts')
const { createMapSourceCatalog } = await import('../src/sources.ts')
const { PUBLIC_SOURCE_PRESETS } = await import('../src/source-render-protocol.ts')
const { waybackDescriptor } = await import('../src/wayback.ts')
const { initialMapInteractionState } = await import('../src/interaction-protocol.ts')
const { createRenderReceiptStore } = await import('../src/client/render-receipt.ts')

const sourceCatalog = createMapSourceCatalog(undefined, 'allow', {})

function sourceDescriptor(selectionId, labels = false) {
  const result = sourceCatalog.selection(selectionId, labels ? 'esri-world-boundaries-places' : null)
  if (!result.ok) throw new Error(result.code)
  const publicLayer = (source, nativeEpoch) => ({
    source,
    nativeEpoch,
    layerKind: source.adapter === 'xyz' ? 'web-tile' : 'arcgis-tile',
    transport: 'public-preset',
    presetId: source.id,
  })
  return {
    schemaVersion: 1,
    sessionId: 'source-session',
    runtimeEpoch: '66666666-5555-4444-8333-222222222222',
    mode: 'map',
    engineWkid: 3857,
    basemap: publicLayer(result.value.basemap, '77777777-6666-4555-8444-333333333333'),
    labels: result.value.labels === null
      ? null
      : publicLayer(result.value.labels, '88888888-7777-4666-8555-444444444444'),
    earlyImagery: null,
    display: {
      labelsVisible: result.value.labels !== null,
      recentVisible: true,
      recentOpacity: 1,
      earlyVisible: false,
    },
  }
}

function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

/** The virtual-source rewrite interceptor of the currently mounted occurrence. */
function rewriteInterceptor() {
  return arcgisConfig.request.interceptors.find(item => item.urls === 'https://map-harness.invalid/__map-source/')
}

function stateOf({
  mode = 'map',
  wkid = 4326,
  center = [116.4, 39.9],
  zoom = 9,
  layers = [],
  revision = 0,
  imageryDisplay = { labelsVisible: false, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null },
} = {}) {
  return {
    mode,
    view: { center, zoom, wkid },
    basemap: null,
    imageryDisplay,
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

test('the occurrence exposes the live drawing host and a temporary SDK layer', async () => {
  resetCaptured()
  const submitted = []
  const occurrence = createMapOccurrence(() => stateOf(), 'annotation-session', 'tab', {
    onAnnotationCreate: async geometry => {
      submitted.push(geometry)
    },
  })
  try {
    occurrence.mount(holder())
    await flush()
    await flush()
    const sketchModule = await import('@arcgis/core/widgets/Sketch/SketchViewModel.js')
    assert.equal(sketchModule.default, FakeSketchViewModel)
    const startResult = await occurrence.startAnnotationDrawing('point')
    assert.equal(startResult, 'started')
    assert.equal(captured.mapViews.length, 1)
    const model = captured.sketches[captured.sketches.length - 1]
    assert.ok(model instanceof FakeSketchViewModel)
    assert.deepEqual(model.createCalls, [{ tool: 'point', mode: 'click' }])
    assert.equal(captured.maps[0].layers.length, 2)
    model.emitCreate('complete', { geometry: { type: 'point', x: 116, y: 39 } })
    await flush()
    assert.deepEqual(submitted, [{ type: 'Point', coordinates: [116, 39] }])
    assert.equal(occurrence.annotationDrawingState().status, 'idle')

    assert.equal(await occurrence.startAnnotationDrawing('line'), 'started')
    const withDraft = captured.maps[0].layers.length
    assert.equal(occurrence.cancelAnnotationDrawing(), true)
    assert.equal(captured.sketches.at(-1).cancelCount, 1)
    assert.deepEqual(occurrence.annotationDrawingState(), { status: 'idle', kind: null, lastError: null })
    assert.equal(captured.maps[0].layers.length, withDraft - 1)
  } finally {
    occurrence.dispose()
  }
})

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
  assert.equal(captured.mapViews[0].options.spatialReference.wkid, 3857)
  occurrence.dispose()
})

test('descriptor-selected sources replace carriers without rebuilding the camera or business layers', async () => {
  resetCaptured()
  const osm = sourceCatalog.selection('osm-standard').value
  const imagery = sourceCatalog.selection('esri-world-imagery', 'esri-world-boundaries-places').value
  let current = { ...stateOf({ layers: [layer('business')], revision: 1 }), basemap: osm }
  let releaseDescriptor
  const firstDescriptor = new Promise(resolve => { releaseDescriptor = resolve })
  const loadRenderDescriptor = async () => {
    if (current.basemap === osm) {
      await firstDescriptor
      return sourceDescriptor('osm-standard')
    }
    return sourceDescriptor('esri-world-imagery', true)
  }
  const occurrence = createMapOccurrence(() => current, 'source-live', 'view:map', { loadRenderDescriptor })
  occurrence.mount(holder())
  await flush()
  const view = captured.mapViews[0]
  view.center = { longitude: 121.47, latitude: 31.23 }
  view.zoom = 12
  releaseDescriptor(sourceDescriptor('osm-standard'))
  await flush()
  await flush()
  assert.equal(captured.mapViews.length, 1)
  assert.equal(captured.tileLayers.at(-1).urlTemplate, PUBLIC_SOURCE_PRESETS['osm-standard'].url)
  assert.equal(captured.maps[0].layers[0].title, 'OpenStreetMap Standard')
  assert.equal(captured.maps[0].layers[1].title, 'business')
  assert.equal(view.center.longitude, 121.47)
  assert.equal(view.zoom, 12)
  assert.equal(occurrence.getRenderReceipt().status, 'rendered')

  current = {
    ...stateOf({
      layers: [layer('business')],
      revision: 2,
      imageryDisplay: { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null },
    }),
    basemap: imagery,
  }
  occurrence.refresh(current)
  await flush()
  await flush()
  assert.equal(captured.arcgisTileLayers.length, 2)
  assert.deepEqual(captured.maps[0].layers.slice(0, 3).map(item => item.title), [
    'Esri World Imagery',
    'Esri World Boundaries and Places',
    'business',
  ])
  assert.equal(view.center.longitude, 121.47)
  assert.equal(view.zoom, 12)
  occurrence.dispose()
})

test('Esri tiles stay on the preset host and tile failures surface and retry', async () => {
  resetCaptured()
  const imagery = sourceCatalog.selection('esri-world-imagery', 'esri-world-boundaries-places').value
  const imageryDisplay = { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null }
  let current = { ...stateOf({ layers: [layer('business')], imageryDisplay }), basemap: imagery }
  const occurrence = createMapOccurrence(() => current, 'esri-pin-session', 'view:map', {
    loadRenderDescriptor: async () => sourceDescriptor('esri-world-imagery', true),
  })
  occurrence.mount(holder())
  await flush()
  await flush()
  assert.equal(captured.arcgisTileLayers.length, 2)
  for (const carrier of captured.arcgisTileLayers) {
    assert.deepEqual(carrier.tileServers, [carrier.url], 'carriers pin the single preset host')
    assert.equal(new URL(carrier.url).host, 'server.arcgisonline.com')
    assert.equal(carrier.tileServers.some(server => server.includes('services.arcgisonline.com')), false)
  }
  const interceptor = arcgisConfig.request.interceptors.find(item => typeof item.error === 'function' && item.urls.includes(PUBLIC_SOURCE_PRESETS['esri-world-imagery'].url))
  assert.ok(interceptor, 'a tile failure interceptor watches the public Esri presets')
  assert.equal(occurrence.sourceFailure(), null)
  interceptor.error({ name: 'AbortError' })
  assert.equal(occurrence.sourceFailure(), null, 'an aborted superseded request never counts')
  interceptor.error({ name: 'request:server' })
  assert.equal(occurrence.sourceFailure(), 'error', 'a preset-host request failure raises the source failure bar')
  interceptor.after({ data: 'tile' })
  assert.equal(occurrence.sourceFailure(), null, 'a preset-host success clears the failure bar')
  interceptor.error({ name: 'request:server' })
  assert.equal(occurrence.sourceFailure(), 'error')
  occurrence.retrySource()
  assert.equal(occurrence.sourceFailure(), null, 'manual retry clears the tile failure bar')
  await flush()
  await flush()
  const rebuilt = captured.arcgisTileLayers.slice(2)
  assert.equal(rebuilt.length, 2, 'retry rebuilds the pinned carriers')
  for (const carrier of rebuilt) {
    assert.deepEqual(carrier.tileServers, [carrier.url])
  }
  occurrence.dispose()
  assert.equal(arcgisConfig.request.interceptors.includes(interceptor), false, 'disposal removes the tile interceptor')
})

test('fixed early imagery renders below recent imagery and labels above both', async () => {
  resetCaptured()
  const early = waybackDescriptor({
    releaseId: 10,
    itemId: '903f0abe9c3b452dafe1ca5b8dd858b9',
    title: 'World Imagery (Wayback 2014-02-20)',
    publishedAt: '2014-02-20',
    layerIdentifier: 'WB_2014_R01',
    acquiredAt: null,
  })
  const imageryDisplay = {
    labelsVisible: true,
    recentVisible: true,
    recentOpacity: 0.45,
    earlyVisible: true,
    earlySource: early,
  }
  const current = {
    ...stateOf({ layers: [layer('business')], revision: 3, imageryDisplay }),
    basemap: sourceCatalog.selection('esri-world-imagery', 'esri-world-boundaries-places').value,
  }
  const descriptor = {
    ...sourceDescriptor('esri-world-imagery', true),
    earlyImagery: {
      source: early,
      nativeEpoch: '55555555-4444-3333-2222-111111111111',
      layerKind: 'wmts',
      transport: 'controlled',
      resourceHref: '/api/map/sources/resource?role=imagery-overlay&resource=wmts',
    },
    display: {
      labelsVisible: true,
      recentVisible: true,
      recentOpacity: 0.45,
      earlyVisible: true,
    },
  }
  const occurrence = createMapOccurrence(() => current, 'overlay-order', 'view:map', {
    loadRenderDescriptor: async () => descriptor,
  })
  occurrence.mount(holder())
  await flush()
  await flush()
  assert.deepEqual(captured.maps[0].layers.slice(0, 4).map(item => item.title), [
    early.title,
    'Esri World Imagery',
    'Esri World Boundaries and Places',
    'business',
  ])
  assert.equal(captured.maps[0].layers[1].opacity, 0.45)
  assert.deepEqual(
    occurrence.getRenderReceipt().layerVersions.map(item => item.id),
    ['early-imagery', 'basemap', 'labels', 'business'],
  )
  occurrence.dispose()

})

test('an explicit source failure removes the old carrier and never falls back to World Imagery', async () => {
  resetCaptured()
  let current = stateOf({ layers: [layer('business')] })
  const osm = sourceCatalog.selection('osm-standard').value
  const occurrence = createMapOccurrence(() => current, 'source-failed', 'failed-source', {
    loadRenderDescriptor: async () => Promise.reject(new Error('render unavailable')),
  })
  occurrence.mount(holder())
  await flush()
  const view = captured.mapViews[0]
  assert.equal(captured.tileLayers.some(item => item.urlTemplate === KEY_FREE_BASEMAP.urlTemplate), true)
  view.center = { longitude: 121.47, latitude: 31.23 }
  view.zoom = 12
  current = { ...stateOf({ layers: [layer('business')], revision: 1 }), basemap: osm }
  occurrence.refresh(current)
  await flush()
  await flush()
  assert.equal(captured.maps[0].layers.some(item => item.urlTemplate === KEY_FREE_BASEMAP.urlTemplate), false)
  assert.deepEqual(captured.maps[0].layers.map(item => item.title), ['business'])
  assert.equal(occurrence.getRenderReceipt().status, 'failed')
  assert.deepEqual(occurrence.getRenderReceipt().failedLayers, [{ layerId: 'basemap', code: 'BASEMAP_FAILED' }])
  assert.equal(view.center.longitude, 121.47)
  assert.equal(view.zoom, 12)
  occurrence.dispose()
})

test('a failed descriptor read retries the same source without falling back', async () => {
  resetCaptured()
  const osm = sourceCatalog.selection('osm-standard').value
  const current = { ...stateOf({ layers: [layer('business')] }), basemap: osm }
  let failed = false
  const occurrence = createMapOccurrence(() => current, 'retry-session', 'retry-source', {
    loadRenderDescriptor: async () => {
      if (!failed) {
        failed = true
        throw new Error('transient render failure')
      }
      return sourceDescriptor('osm-standard')
    },
  })
  occurrence.mount(holder())
  await flush()
  assert.equal(occurrence.getRenderReceipt().status, 'failed')
  assert.equal(captured.tileLayers.length, 0)
  assert.equal(occurrence.sourceFailure(), 'error')
  await new Promise(resolve => setTimeout(resolve, 1_050))
  await flush()
  await flush()
  assert.equal(occurrence.getRenderReceipt().status, 'rendered')
  assert.equal(captured.tileLayers.at(-1).urlTemplate, PUBLIC_SOURCE_PRESETS['osm-standard'].url)
  assert.equal(captured.maps[0].layers.some(item => item.urlTemplate === KEY_FREE_BASEMAP.urlTemplate), false)
  assert.equal(occurrence.sourceFailure(), null)
  occurrence.dispose()
})

test('a repeated descriptor failure backs off, cancels on disposal, and manual retry resets the cycle', async () => {
  resetCaptured()
  const current = { ...stateOf(), basemap: sourceCatalog.selection('osm-standard').value }
  const scheduled = []
  const pending = []
  let attempts = 0
  const occurrence = createMapOccurrence(() => current, 'backoff-session', 'backoff-source', {
    loadRenderDescriptor: async () => { attempts += 1; throw new Error('offline') },
    sourceRetryScheduler: (callback, delayMs) => {
      const handle = setTimeout(callback, 60_000)
      const item = { handle, delayMs, callback }
      scheduled.push(item)
      pending.push(item)
      return handle
    },
  })
  occurrence.mount(holder())
  await flush()
  assert.equal(occurrence.sourceFailure(), 'error')
  assert.deepEqual(scheduled.map(item => item.delayMs), [1_000])
  pending.shift().callback()
  await flush()
  assert.deepEqual(scheduled.map(item => item.delayMs), [1_000, 2_000])
  occurrence.retrySource()
  await flush()
  assert.deepEqual(scheduled.map(item => item.delayMs), [1_000, 2_000, 1_000])
  assert.equal(attempts, 3)
  const timer = scheduled.at(-1).handle
  occurrence.dispose()
  assert.equal(timer._destroyed, true)
})

test('controlled MapServer SDK requests are rewritten to the exact resource identity', async () => {
  resetCaptured()
  const imagery = sourceCatalog.selection('esri-world-imagery').value
  const identityHref = `/api/map/sources/resource?${new URLSearchParams({
    sessionId: 'controlled-session',
    role: 'basemap',
    sourceId: imagery.basemap.id,
    configDigest: imagery.basemap.configDigest,
    runtimeEpoch: '66666666-5555-4444-8333-222222222222',
    nativeEpoch: '99999999-8888-4777-8666-555555555555',
    viewMode: 'map',
    viewWkid: '3857',
  }).toString()}`
  const current = { ...stateOf({ revision: 1 }), basemap: imagery }
  const occurrence = createMapOccurrence(() => current, 'controlled-session', 'controlled', {
    loadRenderDescriptor: async () => ({
      schemaVersion: 1,
      sessionId: 'controlled-session',
      runtimeEpoch: '66666666-5555-4444-8333-222222222222',
      mode: 'map',
      engineWkid: 3857,
      basemap: {
        source: imagery.basemap,
        nativeEpoch: '99999999-8888-4777-8666-555555555555',
        layerKind: 'arcgis-map-image',
        transport: 'controlled',
        resourceHref: identityHref,
      },
      labels: null,
    }),
  })
  occurrence.mount(holder())
  await flush()
  await flush()
  const carrier = captured.mapImageLayers.at(-1)
  assert.match(carrier.url, /^https:\/\/map-harness\.invalid\/__map-source\//u)
  const interceptor = rewriteInterceptor()
  assert.equal(interceptor.urls, 'https://map-harness.invalid/__map-source/')
  const params = { url: `${carrier.url}/tile/10/3/4`, requestOptions: { query: { f: 'json', token: 'client-secret' } } }
  interceptor.before(params)
  const rewritten = new URL(params.url, 'https://owner.test')
  assert.equal(rewritten.pathname, '/api/map/sources/resource')
  assert.equal(rewritten.searchParams.get('resource'), 'arcgis-tile')
  assert.equal(rewritten.searchParams.get('level'), '10')
  assert.equal(rewritten.searchParams.get('row'), '3')
  assert.equal(rewritten.searchParams.get('col'), '4')
  assert.equal(rewritten.searchParams.get('sourceId'), imagery.basemap.id)
  assert.equal(rewritten.searchParams.get('token'), null)
  occurrence.dispose()
})

test('controlled WMTS and dynamic-export queries preserve only their closed vocabulary', async t => {
  t.after(() => {
    while (arcgisConfig.request.interceptors.length > 0) {
      const interceptor = arcgisConfig.request.interceptors.at(-1)
      if (typeof interceptor.before === 'function') interceptor.before({ url: 'https://unrelated.test', requestOptions: {} })
      arcgisConfig.request.interceptors.pop()
    }
  })
  const imagery = sourceCatalog.selection('esri-world-imagery').value
  const descriptorOf = (layerKind, sessionId) => {
    const identityHref = `/api/map/sources/resource?${new URLSearchParams({
      sessionId,
      role: 'basemap',
      sourceId: imagery.basemap.id,
      configDigest: imagery.basemap.configDigest,
      runtimeEpoch: '66666666-5555-4444-8333-222222222222',
      nativeEpoch: '99999999-8888-4777-8666-555555555555',
      viewMode: 'map',
      viewWkid: '3857',
      ...(layerKind === 'wmts' ? { resource: 'wmts' } : {}),
    }).toString()}`
    return {
      schemaVersion: 1,
      sessionId,
      runtimeEpoch: '66666666-5555-4444-8333-222222222222',
      mode: 'map',
      engineWkid: 3857,
      basemap: {
        source: imagery.basemap,
        nativeEpoch: '99999999-8888-4777-8666-555555555555',
        layerKind,
        transport: 'controlled',
        resourceHref: identityHref,
      },
      labels: null,
    }
  }
  const mountControlled = (layerKind, sessionId) => {
    const current = { ...stateOf({ revision: 1 }), basemap: imagery }
    const occurrence = createMapOccurrence(() => current, sessionId, `${sessionId}-source`, {
      loadRenderDescriptor: async () => descriptorOf(layerKind, sessionId),
    })
    occurrence.mount(holder())
    return occurrence
  }

  resetCaptured()
  const wmts = mountControlled('wmts', 'wmts-session')
  await flush()
  await flush()
  const wmtsCarrier = captured.wmtsLayers.at(-1)
  const wmtsParams = { url: wmtsCarrier.url, requestOptions: { query: { SERVICE: 'WMTS', REQUEST: 'GetTile', TILEMATRIX: '0', TOKEN: 'client-secret' } } }
  rewriteInterceptor().before(wmtsParams)
  const rewrittenWmts = new URL(wmtsParams.url, 'https://owner.test')
  assert.deepEqual(rewrittenWmts.searchParams.getAll('resource'), ['wmts'])
  assert.equal(rewrittenWmts.searchParams.get('service'), 'WMTS')
  assert.equal(rewrittenWmts.searchParams.get('request'), 'GetTile')
  assert.equal(rewrittenWmts.searchParams.get('tilematrix'), '0')
  assert.equal(rewrittenWmts.searchParams.get('token'), null)
  wmts.dispose()

  resetCaptured()
  const dynamic = mountControlled('arcgis-map-image', 'export-session')
  await flush()
  await flush()
  const dynamicCarrier = captured.mapImageLayers.at(-1)
  const exportParams = {
    url: `${dynamicCarrier.url}/export?bbox=0,0,1,1&BBOXSR=3857&TOKEN=client-secret`,
    requestOptions: { query: { f: 'image' } },
  }
  rewriteInterceptor().before(exportParams)
  const rewrittenExport = new URL(exportParams.url, 'https://owner.test')
  assert.equal(rewrittenExport.searchParams.get('resource'), 'arcgis-export')
  assert.equal(rewrittenExport.searchParams.get('bbox'), '0,0,1,1')
  assert.equal(rewrittenExport.searchParams.get('bboxsr'), '3857')
  assert.equal(rewrittenExport.searchParams.get('f'), 'image')
  assert.equal(rewrittenExport.searchParams.get('token'), null)
  dynamic.dispose()
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
  assert.equal(view.scale, WEB_MERCATOR_ZOOM0_SCALE / 2 ** 9)
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

test('restoring a clicked feature settles the latest render receipt', async () => {
  resetCaptured()
  const current = {
    ...stateOf({ revision: 5, layers: [layer('coverage')] }),
    interaction: {
      ...initialMapInteractionState(),
      turn: 1,
      turnStartSeq: 1,
      stopped: 'user-interrupted',
      lastResult: {
        action: 'click', sourceCallSeq: 13, targetRevision: 5, view: null,
        hits: [{ layerId: 'coverage', layerName: 'coverage', featureId: 'f-1', title: 'coverage', fields: [], omitted: 0 }],
      },
    },
  }
  const inspected = []
  const occurrence = createMapOccurrence(() => current, 'restored-click', 'tab', { onInspect: value => inspected.push(value) })
  try {
    occurrence.mount(holder())
    await flush()
    const receipt = occurrence.getRenderReceipt()
    assert.equal(inspected.at(-1)?.featureId, 'f-1')
    assert.equal(receipt.status, 'rendered')
    assert.equal(receipt.renderedRevision, 5)
    assert.equal(receipt.failedLayers.length, 0)
  } finally {
    occurrence.dispose()
  }
})

test('an existing view reapplies the recorded camera after ArcGIS readiness', async () => {
  resetCaptured()
  const occurrence = createMapOccurrence(() => stateOf({ center: [116.4, 39.9], zoom: 10 }), 'initial-camera', 'initial-camera')
  captured.holdNextView = true
  occurrence.mount(holder())
  const view = captured.mapViews[0]
  assert.equal(view.pendingWhens.length > 0, true)
  view.releaseWhens()
  await flush()
  assert.equal(view.center.longitude, 116.4)
  assert.equal(view.center.latitude, 39.9)
  assert.equal(view.zoom, 10)
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
  const bare = graphicsCarrierOf(captured.maps[0]).graphics[0].symbol
  assert.equal(bare.color, '#4264fb', 'a bare layer wears the default blue, never ArcGIS black')
  assert.equal(bare.outline.color, '#ffffff')
  plain.dispose()

  // A layer without a symbol takes the semantic its name says: hospitals are red squares.
  resetCaptured()
  current = stateOf({ layers: [{ ...layer('h1'), name: '三甲医院' }] })
  const named = createMapOccurrence(() => current, 's3a', 'named')
  named.mount(holder())
  await flush()
  const facility = graphicsCarrierOf(captured.maps[0]).graphics[0].symbol
  assert.equal(facility.color, '#e55e5e')
  assert.equal(facility.style, 'square')
  named.dispose()

  // Bare lines and polygons wear the default blue too (a line casing sits beneath its stroke).
  resetCaptured()
  const geometries = [
    { type: 'LineString', coordinates: [[116.4, 39.9], [116.5, 40.0]] },
    { type: 'Polygon', coordinates: [[[116.4, 39.9], [116.5, 39.9], [116.5, 40.0], [116.4, 39.9]]] },
  ]
  current = stateOf({
    layers: geometries.map((geometry, at) => ({
      ...layer(`bare-${at}`),
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: {} }] },
    })),
  })
  const shapes = createMapOccurrence(() => current, 's3b', 'shapes')
  shapes.mount(holder())
  await flush()
  const [lineLayer, polygonLayer] = captured.maps[0].layers.filter(item => item.graphics !== undefined)
  const lineSymbols = lineLayer.graphics.map(graphic => graphic.symbol)
  assert.ok(lineSymbols.some(symbol => symbol.color === '#4264fb' && symbol.width === 2.5), 'a bare line strokes in the default blue')
  const fill = polygonLayer.graphics[0].symbol
  assert.equal(fill.color, 'rgba(66, 100, 251, 0.3)', 'a bare polygon fills translucent default blue')
  assert.notEqual(fill.outline.color, '#000000')
  shapes.dispose()
  plain.dispose()
})

test('renaming a classified polygon to an inferred AOI keeps its class fill opaque', async t => {
  resetCaptured()
  const original = shapeLayer('zones', 'Polygon', { style: scoreStyle() })
  original.data.features[0].properties.score = 26
  let current = stateOf({ layers: [original], revision: 4 })
  const occurrence = createMapOccurrence(() => current, 'rename', 'classified')
  t.after(() => occurrence.dispose())
  occurrence.mount(holder())
  await flush()
  const carrier = graphicsCarrierOf(captured.maps[0])
  const graphic = carrier.graphics[0]
  assert.equal(graphic.symbol.color, '#08306b')

  current = stateOf({ layers: [{ ...original, name: '研究区地块' }], revision: 5 })
  occurrence.refresh(current)
  await flush()
  occurrence.setHighlight('zones', new Set())
  assert.equal(carrier.graphics[0], graphic, 'a name change preserves the styled graphic')
  assert.equal(graphic.symbol.color, '#08306b', 'inferred AOI opacity must not dim the classified fill')
})

test('an explicitly declared fill opacity still applies to classification', async t => {
  resetCaptured()
  const declared = shapeLayer('zones', 'Polygon', {
    name: '研究区地块',
    style: scoreStyle(),
    symbol: singleSymbol({ fill: { color: '#ee4e8b', opacity: 0.4, outlineColor: '#ee4e8b', outlineWidthPx: 2 } }),
  })
  declared.data.features[0].properties.score = 26
  const occurrence = createMapOccurrence(() => stateOf({ layers: [declared] }), 'explicit', 'classified')
  t.after(() => occurrence.dispose())
  occurrence.mount(holder())
  await flush()
  assert.equal(graphicsCarrierOf(captured.maps[0]).graphics[0].symbol.color, 'rgba(8, 48, 107, 0.4)')
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

test('a heatmap presentation renders through a client-side FeatureLayer with its field and radius', async t => {
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
  t.after(() => occurrence.dispose())
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
  assert.deepEqual(carrier.renderer.colorStops[0], { ratio: 0, color: '#44015400' })
  assert.deepEqual(carrier.renderer.colorStops.at(-1), { ratio: 1, color: '#fde725' })

  for (const ramp of ['viridis', 'plasma', 'inferno', 'magma', 'blues', 'reds']) {
    current = {
      ...current,
      revision: current.revision + 1,
      layers: new Map([['hotspots', { ...current.layers.get('hotspots'), symbol: {
        ...heatmap, symbolVersion: `sym-${ramp}@v1`, heatmap: { ...heatmap.heatmap, ramp },
      } }]]),
    }
    occurrence.refresh(current)
    await flush()
    assert.match(carrier.renderer.colorStops[0].color, /^#[0-9a-f]{6}00$/, `${ramp}: zero density is transparent`)
    assert.ok(carrier.renderer.colorStops.slice(1).every(stop => /^#[0-9a-f]{6}$/.test(stop.color)), `${ramp}: positive density keeps its opaque colors`)
  }

  // A radius change re-renders through the same carrier.
  current = {
    ...current,
    revision: current.revision + 1,
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
    revision: current.revision + 1,
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
  assert.deepEqual(pts[0].symbol.outline, { color: '#ffffff', width: 2 }, 'markers wear a white halo')
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
  assert.equal(handle.labels[0].color, '#7e3434', 'labels wear a deep shade of the symbol color (here the inferred facility red)')
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
  assert.ok(Math.abs(inspections[0].anchor.left - 500) < 1e-6 && Math.abs(inspections[0].anchor.right - 500) < 1e-6
    && inspections[0].anchor.top === 300 && inspections[0].anchor.bottom === 300,
  'the card carries the feature geometry anchor')
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

test('a settled camera reanchors the open feature card and dismissal stays closed', async () => {
  resetCaptured()
  const named = (id, lon, name) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [lon, 39.9] }, properties: { name } })
  let current = stateOf({
    layers: [{
      id: 'sites', name: 'Sites', sourceCrs: 'EPSG:4326', opacity: 1, visible: true,
      legend: { title: 's', symbol: { color: '#2f6fb0', outline: '#ffffff' } },
      data: { type: 'FeatureCollection', features: [named('a', 116.4, 'Alpha')] },
    }],
  })
  const inspections = []
  const occurrence = createMapOccurrence(() => current, 'anchor', 'anchor:1', { onInspect: value => inspections.push(value) })
  occurrence.mount(holder())
  await flush()
  const carrier = captured.maps[0].layers.find(item => item.graphics !== undefined)
  const feature = carrier.graphics.find(graphic => graphic.attributes?.__fid === 'a')
  const view = captured.mapViews[0]
  view.hitResults = [{ type: 'graphic', graphic: feature }]
  await fireViewHover(view, { x: 500, y: 300 })
  assert.equal(inspections.length, 1)
  assert.ok(Math.abs(inspections[0].anchor.left - 400) < 1e-6 && Math.abs(inspections[0].anchor.right - 400) < 1e-6
    && inspections[0].anchor.top === 300 && inspections[0].anchor.bottom === 300)

  const savedToScreen = view.toScreen
  view.toScreen = () => ({ x: 520, y: 330 })
  const stationary = captured.watches.find(entry => entry.getter.toString().includes('stationary'))
  stationary.callback(true)
  assert.equal(inspections.length, 2, 'the settled camera reports a moved anchor without another hit test')
  assert.deepEqual(inspections[1].anchor, { left: 520, top: 330, right: 520, bottom: 330 })

  occurrence.dismissInspection()
  assert.equal(inspections.at(-1), null)
  stationary.callback(true)
  assert.equal(inspections.at(-1), null, 'a dismissed card stays closed across later camera settlements')

  view.toScreen = savedToScreen
  occurrence.dispose()
})

test('dense points cluster their unplaced labels; a badge click zooms into its bbox', async () => {
  resetCaptured()
  const named = (id, lon, lat) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name: `Site ${id}` } })
  const dense = []
  for (let at = 0; at < 91; at += 1) dense.push(named(`f${at}`, 116.39 + (at % 10) * 0.0001, 39.89 + Math.floor(at / 10) * 0.0001))
  let current = stateOf({
    layers: [{
      id: 'sites', name: 'Sites', sourceCrs: 'EPSG:4326', opacity: 1, visible: true,
      legend: { title: 's', symbol: { color: '#2f6fb0', outline: '#ffffff' } },
      data: { type: 'FeatureCollection', features: dense },
    }],
  })
  const clicks = []
  const domHolder = new FakeDiv()
  domHolder.ownerDocument = {
    createElement: () => ({
      style: {}, textContent: null, attributes: new Map(), children: [], onclick: null,
      setAttribute(name, value) { this.attributes.set(name, value) },
      replaceChildren(...children) { this.children = children },
      remove() {},
    }),
  }
  domHolder.appendChild = child => { (domHolder.children ??= []).push(child) }
  const occurrence = createMapOccurrence(() => current, 'lblc', 'lblc:1')
  occurrence.mount(domHolder)
  await flush()
  const handle = globalThis.__mapHarness.get('lblc:lblc:1')
  const placed = handle.labelCount
  assert.ok(placed > 0 && placed < 91, `dense points drop some labels (${placed}/91)`)
  const clusters = handle.labelClusters
  assert.ok(clusters.length > 0, 'unplaced names surface as cluster badges')
  assert.equal(placed + clusters.reduce((total, badge) => total + badge.count, 0), 91,
    'every named point is either placed or counted in a badge')
  // The overlay lives under the mount holder; the first render binds its click callback.
  const overlayRoot = domHolder.children?.[0]
  const badgeClick = { target: () => {} }
  if (overlayRoot !== undefined) {
    const pill = [...overlayRoot.children].find(child => child.attributes.get('data-map-label-cluster') === '')
    if (pill !== undefined) badgeClick.target = () => pill.onclick()
  }
  void clicks

  const view = captured.mapViews[0]
  const savedToScreen = view.toScreen
  view.toScreen = point => ({
    x: 40 + (point.longitude - 116.39) * 400_000,
    y: 40 + (point.latitude - 39.89) * 400_000,
  })
  void badgeClick
  const stationary = captured.watches.find(entry => entry.getter.toString().includes('stationary'))
  stationary.callback(true)
  const zoomedPlaced = handle.labelCount
  const zoomedClusters = handle.labelClusters
  assert.ok(zoomedPlaced > placed, 'zooming in places more names')
  assert.equal(zoomedPlaced + zoomedClusters.reduce((total, badge) => total + badge.count, 0), 91)
  assert.ok(zoomedClusters.reduce((total, badge) => total + badge.count, 0)
    < clusters.reduce((total, badge) => total + badge.count, 0), 'zooming in swallows fewer points into badges')
  view.toScreen = savedToScreen

  stationary.callback(false)
  stationary.callback(true)

  // A badge click zooms to its covering bbox with programmatic attribution.
  const wentTo = recordGoTo(view)
  const badge = zoomedClusters.reduce((largest, item) => item.count > largest.count ? item : largest, zoomedClusters[0])
  badgeClick.target()
  assert.equal(wentTo.length, 1, 'clicking a badge frames its cluster bbox')
  const extent = wentTo[0]
  assert.ok(extent.xmin <= badge.bbox.west + 1e-9 && extent.xmax >= badge.bbox.east - 1e-9)
  assert.ok(extent.ymin <= badge.bbox.south + 1e-9 && extent.ymax >= badge.bbox.north - 1e-9)
  occurrence.dispose()
})

test('a badge on a single-row cluster frames a tight box instead of the data bbox pad', async () => {
  resetCaptured()
  const row = [0, 1, 2, 3].map(at => ({
    type: 'Feature', id: `row-${at}`,
    geometry: { type: 'Point', coordinates: [116.39 + at * 0.0001, 39.89] },
    properties: { name: `Site ${at}` },
  }))
  const current = stateOf({
    layers: [{
      id: 'row', name: 'Row', sourceCrs: 'EPSG:4326', opacity: 1, visible: true,
      legend: { title: 'r', symbol: { color: '#2f6fb0', outline: '#ffffff' } },
      data: { type: 'FeatureCollection', features: row },
    }],
  })
  const domHolder = new FakeDiv()
  domHolder.ownerDocument = {
    createElement: () => ({
      style: {}, textContent: null, attributes: new Map(), children: [], onclick: null,
      setAttribute(name, value) { this.attributes.set(name, value) },
      replaceChildren(...children) { this.children = children },
      remove() {},
    }),
  }
  domHolder.appendChild = child => { (domHolder.children ??= []).push(child) }
  const occurrence = createMapOccurrence(() => current, 'rowc', 'rowc:1')
  occurrence.mount(domHolder)
  await flush()
  const view = captured.mapViews[0]
  view.toScreen = () => ({ x: 200, y: 100 })
  const stationary = captured.watches.find(entry => entry.getter.toString().includes('stationary'))
  stationary.callback(true)
  const clusters = globalThis.__mapHarness.get('rowc:rowc:1').labelClusters
  assert.equal(clusters.length, 1, 'the row collapses into one badge')
  assert.ok(clusters[0].count >= 2, `the row badge covers the dropped labels (${clusters[0].count})`)
  assert.equal(clusters[0].bbox.south, clusters[0].bbox.north, 'the cluster bbox is a zero-height row')
  const overlayRoot = domHolder.children?.[0]
  const pill = [...overlayRoot.children].find(child => child.attributes.get('data-map-label-cluster') === '')
  const wentTo = recordGoTo(view)
  pill.onclick()
  assert.equal(wentTo.length, 1, 'clicking the row badge frames its bbox')
  const extent = wentTo[0]
  assert.ok(extent.ymax - extent.ymin < 0.002, `a zero-height cluster frames under 0.002° tall (${extent.ymax - extent.ymin})`)
  assert.ok(extent.xmin <= clusters[0].bbox.west && extent.xmax >= clusters[0].bbox.east, 'the frame still covers the row')
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

test('selection and inspection highlights are independent sources over one outline set', async () => {
  resetCaptured()
  let current = stateOf({ layers: [styledLayer({ features: [point(5, undefined, 'a'), point(25, undefined, 'b')] })] })
  const occurrence = createMapOccurrence(() => current, 's1', 'hl:src')
  occurrence.mount(holder())
  await flush()
  const graphics = captured.maps.at(-1).layers.find(item => item.graphics !== undefined).graphics
  occurrence.setHighlight('zones', new Set(['a']))
  occurrence.setHighlight('zones', new Set(['b']), 'inspection')
  assert.equal(graphics[0].symbol.outline.color, '#00b8ff', 'selection id keeps the highlight')
  assert.equal(graphics[1].symbol.outline.color, '#00b8ff', 'inspection id joins the same outline set')
  occurrence.setHighlight('zones', new Set(), 'inspection')
  assert.equal(graphics[0].symbol.outline.color, '#00b8ff', 'clearing the inspection leaves the selection')
  assert.equal(graphics[1].symbol.outline.color, '#ffffff')
  occurrence.setHighlight('zones', new Set(), 'selection')
  occurrence.setHighlight('zones', new Set(['b']), 'inspection')
  assert.equal(graphics[0].symbol.outline.color, '#ffffff')
  assert.equal(graphics[1].symbol.outline.color, '#00b8ff', 'clearing the selection leaves the inspection')
  occurrence.dispose()
})

test('one id highlighted through both sources still counts once', async () => {
  resetCaptured()
  let current = stateOf({ layers: [styledLayer({ features: [point(5, undefined, 'a'), point(25, undefined, 'b')] })] })
  const occurrence = createMapOccurrence(() => current, 's1', 'hl:union')
  occurrence.mount(holder())
  await flush()
  const key = 's1:hl:union'
  occurrence.setHighlight('zones', new Set(['a']))
  occurrence.setHighlight('zones', new Set(['a']), 'inspection')
  assert.equal(globalThis.__mapHarness.get(key).highlightCount, 1, 'the union is counted, not the source sum')
  occurrence.refresh(current)
  await flush()
  assert.equal(globalThis.__mapHarness.get(key).highlightCount, 1, 'a refresh preserves the union')
  current = stateOf({ layers: [] })
  occurrence.refresh(current)
  await flush()
  assert.equal(globalThis.__mapHarness.get(key).highlightCount, 0, 'removing the layer clears both sources')
  occurrence.dispose()
})

test('a hover inspection closes the prior inspection without touching the selection', async () => {
  resetCaptured()
  const named = (id, name) => ({ type: 'Feature', id, geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name } })
  let current = stateOf({
    layers: [{
      id: 'hospitals', name: 'Hospitals', sourceCrs: 'EPSG:4326', opacity: 1, visible: true,
      legend: { title: 'h', symbol: { color: '#e55e5e', outline: '#000000' } },
      data: { type: 'FeatureCollection', features: [named('x', 'X'), named('y', 'Y')] },
    }],
  })
  const inspections = []
  let prior = null
  const occurrence = createMapOccurrence(() => current, 's1', 'hl:hover', {
    onInspect: next => {
      if (prior !== null && prior.layerId !== next?.layerId) occurrence.setHighlight(prior.layerId, new Set(), 'inspection')
      prior = next
      inspections.push(next)
    },
  })
  occurrence.mount(holder())
  await flush()
  const carrier = captured.maps[0].layers.find(item => item.graphics !== undefined)
  const view = captured.mapViews[0]
  occurrence.setHighlight('hospitals', new Set(['x']))
  view.hitResults = [{ type: 'graphic', graphic: carrier.graphics[1] }]
  await fireViewHover(view, { x: 500, y: 300 })
  assert.equal(carrier.graphics[0].symbol.outline.color, '#00b8ff', 'the selection highlight survives the inspection')
  assert.equal(carrier.graphics[1].symbol.outline.color, '#00b8ff', 'the inspected feature joins the outline set')
  view.hitResults = []
  await fireViewHover(view, { x: 10, y: 10 })
  assert.equal(carrier.graphics[0].symbol.outline.color, '#00b8ff')
  assert.equal(carrier.graphics[1].symbol.outline.color, '#ffffff', 'hovering off clears only the inspection')
  occurrence.dispose()
})

test('a drawing action preempts an unclaimed map-use request and preserves the user interruption reason', async () => {
  resetCaptured()
  const originalFetch = globalThis.fetch
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  const bodies = []
  const current = { ...stateOf(), interaction: { ...initialMapInteractionState(), turn: 1, turnStartSeq: 0, open: true, actions: 1 } }
  const occurrence = createMapOccurrence(() => current, 'draw-preempts', 'tab')
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    bodies.push(body)
    if (body.action === 'claim') { entered.resolve(); await release.promise; return Response.json({ status: 'claimed', token: 'claimed' }) }
    return Response.json({ ok: true })
  }
  try {
    occurrence.mount(holder())
    await flush()
    const request = { callId: 'click', requestSeq: 3, turn: 1, turnStartSeq: 0, controlEpoch: 0, observationId: 'obs', action: 'click', xPx: 1, yPx: 1, expiresAtMs: Date.now() + 5000, arguments: '{}' }
    const waiting = occurrence.runMapUse(request, null)
    await entered.promise
    assert.equal(await occurrence.startAnnotationDrawing('point'), 'started')
    fireWatch(captured.watches.at(-1))
    release.resolve()
    await waiting
    assert.ok(bodies.some(body => body.action === 'stop' && body.turnStartSeq === 0))
    assert.ok(bodies.some(body => body.outcome?.code === 'user-interrupted'))
    assert.equal(captured.mapViews[0].lastHitInclude, undefined)
  } finally { release.resolve(); occurrence.dispose(); globalThis.fetch = originalFetch }
})

test('a stopped occurrence never applies a camera callback that was already waiting for the view', async () => {
  resetCaptured()
  const originalFetch = globalThis.fetch
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const stored = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value) },
  } })
  globalThis.fetch = async () => Response.json({ ok: true })
  let current = { ...stateOf(), interaction: { ...initialMapInteractionState(), turn: 1, turnStartSeq: 0, open: true, actions: 1 } }
  const occurrence = createMapOccurrence(() => current, 'stop-camera', 'tab')
  try {
    occurrence.mount(holder())
    await flush()
    const view = captured.mapViews[0]
    const before = view.center
    view.holdWhen = true
    current = {
      ...current, revision: 1, view: { ...current.view, center: [117, 40], scale: 5000, rotation: 30 },
      interaction: { ...current.interaction, lastResult: { action: 'pan', targetRevision: 0, sourceCallSeq: 3, view: { center: [117, 40] } } },
    }
    occurrence.refresh(current)
    assert.ok(view.pendingWhens.length > 0)
    occurrence.stopMapUse(0)
    view.releaseWhens()
    await flush()
    assert.equal(view.center, before)
    assert.equal(occurrence.getRenderReceipt().renderedRevision, null)
    assert.deepEqual(occurrence.getRenderReceipt().failedLayers, [{ layerId: null, code: 'CAMERA_SUPERSEDED' }])
    const recoveredReceipt = createRenderReceiptStore('stop-camera', 'tab').get()
    assert.deepEqual(recoveredReceipt, occurrence.getRenderReceipt())
    occurrence.refresh(current)
    await flush()
    assert.equal(view.center, before)
  } finally {
    occurrence.dispose()
    globalThis.fetch = originalFetch
    if (storageDescriptor === undefined) delete globalThis.localStorage
    else Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
  }
})

test('a settled camera different from the accepted view submits one final view record', async () => {
  resetCaptured()
  let current = stateOf({ center: [116.4, 39.9], zoom: 9 })
  const submitted = []
  const occurrence = createMapOccurrence(() => current, 'camera-persist', 'tab', {
    onUserCamera: view => { submitted.push(view) },
  })
  try {
    occurrence.mount(holder())
    await flush()
    const view = captured.mapViews[0]
    view.center = new FakePoint({ x: 121.47, y: 31.23, longitude: 121.47, latitude: 31.23 })
    view.extent = new FakeExtent({ xmin: 121, ymin: 31, xmax: 122, ymax: 32 })
    view.zoom = 12
    view.scale = 30_000
    view.rotation = 33
    fireViewEvent(view, 'pointer-down', {})
    const stationary = captured.watches.find(entry => entry.getter.toString().includes('stationary'))
    stationary.callback(true)
    await flush()
    await flush()
    assert.equal(submitted.length, 1)
    assert.deepEqual(submitted[0], { center: [121.47, 31.23], zoom: 12, wkid: 4326, scale: 30_000, rotation: 33 })

    current = {
      ...stateOf({ center: [121.47, 31.23], zoom: 12 }),
    }
    current.view.scale = 30_000
    current.view.rotation = 33
    stationary.callback(true)
    await flush()
    await flush()
    assert.equal(submitted.length, 1, 'the same settled camera is written once')
  } finally {
    occurrence.dispose()
  }
})

test('passive SDK camera settlement without a user gesture does not write a user change', async () => {
  resetCaptured()
  const current = stateOf({ center: [116.4, 39.9], zoom: 9 })
  const submitted = []
  const occurrence = createMapOccurrence(() => current, 'camera-passive', 'tab', {
    onUserCamera: view => { submitted.push(view) },
  })
  try {
    occurrence.mount(holder())
    await flush()
    const view = captured.mapViews[0]
    view.center = new FakePoint({ x: 116.45, y: 39.95, longitude: 116.45, latitude: 39.95 })
    view.extent = new FakeExtent({ xmin: 116, ymin: 39, xmax: 117, ymax: 40 })
    view.zoom = 9
    view.scale = 30_000
    const stationary = captured.watches.find(entry => entry.getter.toString().includes('stationary'))
    stationary.callback(true)
    await flush()
    await flush()
    assert.deepEqual(submitted, [])
  } finally {
    occurrence.dispose()
  }
})

test('programmatic camera sync does not create a final user camera write', async () => {
  resetCaptured()
  let current = stateOf({ center: [116.4, 39.9], zoom: 9 })
  const submitted = []
  const occurrence = createMapOccurrence(() => current, 'camera-programmatic', 'tab', {
    onUserCamera: view => { submitted.push(view) },
  })
  try {
    occurrence.mount(holder())
    await flush()
    current = stateOf({ center: [117, 40], zoom: 10 })
    occurrence.refresh(current)
    await flush()
    const stationary = captured.watches.find(entry => entry.getter.toString().includes('stationary'))
    stationary.callback(true)
    await flush()
    await flush()
    assert.equal(submitted.length, 0, 'the model-authored camera is already the accepted view')
  } finally {
    occurrence.dispose()
  }
})
