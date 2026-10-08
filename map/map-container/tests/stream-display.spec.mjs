/**
 * Stream-workbench display identity: the fold accepts a stream layer only
 * inside the current meta schema version, only when its id is the stream id
 * and its resourceRef cites the bound scenario ref, and only when the
 * embedded checkpoint decodes — a fold that could not resume would strand
 * the workbench, so it refuses read-only instead. The occurrence keys the
 * rendered identity on the workbench revision and mode/pause token (a pause
 * or a new revision redraws even when the display copy is unchanged), and
 * drops graphics and the stream token on removal. ArcGIS constructors are
 * the shared doubles.
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
const {
  MAP_META_SCHEMA_VERSION,
  MAP_PROJECTION_STATE_VERSION,
  buildMapChangeMeta,
  decodeMapChangeMeta,
  initialMapProjectionState,
  settleMapResult,
} = await import('../src/protocol.ts')
const { REALTIME_METHOD_VERSION, StreamRuntime, encodeCheckpoint } = await import('../../spatial-realtime/src/index.ts')

function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

function holder() {
  return new (globalThis.HTMLDivElement)()
}

const SCENARIO_REF = 'res-stream-scenario@v1'
const SCENARIO_REVISION = 'digest-scenario-v1'

/** One live runtime over a small deterministic scenario. */
function liveRuntime() {
  const runtime = StreamRuntime.open({
    methodVersion: REALTIME_METHOD_VERSION,
    windowSizeMs: 10_000,
    allowedLatenessMs: 5_000,
    dedupCapacity: 64,
    bufferCapacity: 32,
    maxEventsPerAdvance: 16,
    maxOpenWindows: 8,
    maxRevisionsPerWindow: 4,
  }, {
    batches: [
      { events: [{ eventId: 'e1', eventTimeMs: 1_000, lon: 116.0, lat: 39.8, value: 3 }] },
      { events: [{ eventId: 'e2', eventTimeMs: 21_000, lon: 116.4, lat: 39.9, value: 4 }] },
    ],
  })
  runtime.advance(1_000)
  runtime.advance(2_000)
  return runtime
}

const windowDisplay = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [116.0, 39.8] }, properties: { window_start_ms: 0, status: 'closed', revision: 1, count: 1, mean: 3 } },
  ],
}

function streamLayer(overrides = {}) {
  const runtime = liveRuntime()
  const { stream: streamOverrides, ...layerOverrides } = overrides
  return {
    id: 'stream-city',
    name: 'stream city',
    data: { type: 'FeatureCollection', features: structuredClone(windowDisplay.features) },
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    sourceCallSeq: 1,
    displayDigest: 'digest-display',
    resourceRef: SCENARIO_REF,
    stream: {
      streamId: 'stream-city',
      scenarioRef: SCENARIO_REF,
      scenarioRevision: SCENARIO_REVISION,
      mode: 'realtime',
      methodVersion: REALTIME_METHOD_VERSION,
      windowSizeMs: 10_000,
      allowedLatenessMs: 5_000,
      watermarkMs: 16_000,
      lagMs: 14_000,
      paused: false,
      revision: 2,
      closedWindows: 1,
      gapWindows: 1,
      lateRevisions: 0,
      duplicatesDropped: 0,
      offlineBatches: 0,
      checkpoint: encodeCheckpoint(runtime),
      ...(streamOverrides ?? {}),
    },
    ...layerOverrides,
  }
}

function settleAdd(layer, schemaVersion = MAP_META_SCHEMA_VERSION) {
  const state = initialMapProjectionState()
  const meta = buildMapChangeMeta(1, 0, { op: 'add-layer', layer })
  const decoded = decodeMapChangeMeta({ ...JSON.parse(JSON.stringify(meta)), schemaVersion })
  return settleMapResult(state, {
    resultSeq: 1,
    pending: { callId: 'c1', callSeq: 1, name: 'map_add_layer' },
    isError: false,
    meta: decoded.status === 'ok' ? decoded.meta : { schemaVersion, kind: 'map-change', sourceCallSeq: 1, targetRevision: 0, change: { op: 'add-layer', layer } },
    citedCallSeq: 1,
  })
}

test('the fold accepts a stream layer at the current meta version and keeps the identity', () => {
  const layer = streamLayer()
  const settled = settleAdd(layer)
  assert.equal(settled.diagnostics.length, 0)
  assert.equal(settled.layers.length, 1)
  const folded = settled.layers[0]
  assert.equal(folded.stream.streamId, 'stream-city')
  assert.equal(folded.stream.mode, 'realtime')
  assert.equal(folded.stream.scenarioRef, SCENARIO_REF)
  assert.equal(folded.stream.watermarkMs, 16_000, 'the watermark stays visible in the folded record')
  assert.equal(folded.stream.gapWindows, 1, 'the data gap stays visible in the folded record')
  assert.equal(folded.resourceRef, SCENARIO_REF)
  assert.equal(settled.stateVersion, MAP_PROJECTION_STATE_VERSION)
})

test('a stream layer must carry its streamId as the layer id and the scenario ref as resourceRef', () => {
  for (const mutate of [
    layer => ({ ...layer, id: 'other-id' }),
    layer => ({ ...layer, resourceRef: 'res-other@v1' }),
  ]) {
    const settled = settleAdd(mutate(streamLayer()))
    assert.equal(settled.layers.length, 0, 'the mismatching layer never folds')
    assert.equal(settled.diagnostics[0]?.code, 'invalid-meta')
  }
})

test('a stream layer whose checkpoint cannot decode refuses read-only', () => {
  const layer = streamLayer({ stream: { checkpoint: { schemaVersion: 99 } } })
  const settled = settleAdd(layer)
  assert.equal(settled.layers.length, 0, 'a stranded workbench never folds')
  assert.equal(settled.diagnostics[0]?.code, 'invalid-meta')
})

test('a materialized stream layer must cite at least one pin; a realtime layer must not carry pins', () => {
  const bareMaterialized = streamLayer({ stream: { mode: 'materialized', materialized: [] } })
  const settled = settleAdd(bareMaterialized)
  assert.equal(settled.layers.length, 0)
  assert.equal(settled.diagnostics[0]?.code, 'invalid-meta')
  const pinned = streamLayer({
    stream: {
      mode: 'materialized',
      materialized: [{ exportDigest: 'd'.repeat(64), artifactRef: 'art-demo-1@v1' }],
    },
  })
  const ok = settleAdd(pinned)
  assert.equal(ok.layers.length, 1)
  assert.equal(ok.layers[0].stream.materialized[0].artifactRef, 'art-demo-1@v1')
})

test('an older meta version carrying a stream identity refuses read-only', () => {
  const settled = settleAdd(streamLayer(), MAP_META_SCHEMA_VERSION - 1)
  assert.equal(settled.layers.length, 0)
  assert.equal(settled.diagnostics[0]?.code, 'invalid-meta')
})

function occurrenceState(mode, layer) {
  return {
    mode,
    view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 },
    layers: new Map(layer === undefined ? [] : [[layer.id, layer]]),
    revision: 1,
  }
}

async function mountedOccurrence(mode, layer) {
  resetCaptured()
  let current = occurrenceState(mode, layer)
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map')
  occurrence.mount(holder())
  await flush()
  return { occurrence, view: mode === 'scene' ? captured.sceneViews[0] : captured.mapViews[0], currentRef: () => current, set: next => { current = next } }
}

async function handleOf(occurrence) {
  await flush()
  return globalThis.__mapHarness.get('s1:view:map')
}

async function graphicsLayerOf(view) {
  await flush()
  return view.map.layers.find(candidate => candidate instanceof FakeGraphicsLayer)
}

test('the occurrence redraws a stream layer when its workbench revision or pause flips, and exposes the stream states', async () => {
  const first = streamLayer()
  const env = await mountedOccurrence('map', first)
  let graphics = await graphicsLayerOf(env.view)
  assert.equal(graphics.graphics.length, 1)
  let handle = await handleOf(env.occurrence)
  assert.deepEqual(handle.streamStates, [{
    id: 'stream-city',
    mode: 'realtime',
    revision: 2,
    paused: false,
    watermarkMs: 16_000,
    lagMs: 14_000,
    gapWindows: 1,
    lateRevisions: 0,
  }])

  // Same display data and digest, new workbench revision: the identity token
  // changes, so the projection redraws for the new conclusions.
  const advanced = streamLayer()
  advanced.stream = { ...advanced.stream, revision: 3, watermarkMs: 26_000 }
  env.occurrence.refresh(occurrenceState('map', advanced))
  graphics = await graphicsLayerOf(env.view)
  assert.equal(graphics.graphics.length, 1)
  handle = await handleOf(env.occurrence)
  assert.equal(handle.streamStates[0].revision, 3)

  // A pause flips the identity without touching data: redraw + face flag.
  const paused = streamLayer()
  paused.stream = { ...paused.stream, paused: true }
  env.occurrence.refresh(occurrenceState('map', paused))
  handle = await handleOf(env.occurrence)
  assert.equal(handle.streamStates[0].paused, true)

  // Removal drops the graphics layer from the map; the stream face empties.
  env.occurrence.refresh(occurrenceState('map', undefined))
  await flush()
  assert.equal(await graphicsLayerOf(env.view), undefined, 'unload drops the stream layer graphics')
  handle = await handleOf(env.occurrence)
  assert.deepEqual(handle.streamStates, [])
})

test('the materialized mode renders the same layer with its final identity', async () => {
  const fixed = streamLayer({
    stream: {
      mode: 'materialized',
      materialized: [{ exportDigest: 'd'.repeat(64), artifactRef: 'art-demo-1@v1' }],
    },
  })
  const env = await mountedOccurrence('map', fixed)
  const graphics = await graphicsLayerOf(env.view)
  assert.equal(graphics.graphics.length, 1)
  const handle = await handleOf(env.occurrence)
  assert.equal(handle.streamStates[0].mode, 'materialized', 'the realtime/final distinction is visible on the display face')
})
