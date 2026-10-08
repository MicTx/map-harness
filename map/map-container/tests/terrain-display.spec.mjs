/**
 * Terrain-preview display identity: the fold accepts a terrain layer only
 * inside the current meta schema version and only when it cites its bound
 * surface ref; the occurrence keys the rendered identity on the terrain
 * revision (a same-id, same-digest re-add at a new version redraws with the
 * new elevations), puts the elevation on the Point z, renders the same
 * record in 2D and 3D, and drops both graphics and the revision token on
 * removal. ArcGIS constructors are the shared doubles.
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

function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

function holder() {
  return new (globalThis.HTMLDivElement)()
}

const displayPoints = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [116.0, 39.8] }, properties: { elev: 40 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { elev: 55 } },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [116.8, 40.0] }, properties: { elev: 47 } },
  ],
}

const terrainIdentity = {
  surfaceRef: 'res-dem-city@v1',
  revision: 'digest-city-v1',
  verticalDatum: 'EGM96',
  verticalUnits: 'm',
  epoch: 'none',
  elevationField: 'elev',
  gridColumns: 21,
  gridRows: 5,
  sourcePointCount: 105,
}

function terrainLayer(id = 'terrain-preview', revision = terrainIdentity.revision, features = displayPoints.features) {
  return {
    id,
    name: 'terrain preview',
    data: { type: 'FeatureCollection', features },
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    sourceCallSeq: 1,
    displayDigest: 'digest-display',
    resourceRef: terrainIdentity.surfaceRef,
    terrain: { ...terrainIdentity, revision },
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

test('the fold accepts a terrain layer at the current meta version and keeps the revision', () => {
  const settled = settleAdd(terrainLayer())
  assert.equal(settled.diagnostics.length, 0)
  assert.equal(settled.layers.length, 1)
  const layer = settled.layers[0]
  assert.equal(layer.terrain.revision, 'digest-city-v1')
  assert.equal(layer.terrain.verticalDatum, 'EGM96')
  assert.equal(layer.terrain.surfaceRef, 'res-dem-city@v1')
  assert.equal(layer.resourceRef, 'res-dem-city@v1')
})

test('a terrain layer must cite its bound surface ref as the layer resourceRef', () => {
  const mismatched = terrainLayer()
  mismatched.resourceRef = 'res-other@v1'
  const settled = settleAdd(mismatched)
  assert.equal(settled.layers.length, 0, 'the mismatching layer never folds')
  assert.equal(settled.diagnostics[0]?.code, 'invalid-meta')
})

test('an older meta version carrying a terrain identity refuses read-only', () => {
  const settled = settleAdd(terrainLayer(), MAP_META_SCHEMA_VERSION - 1)
  assert.equal(settled.layers.length, 0)
  assert.equal(settled.diagnostics[0]?.code, 'invalid-meta')
})

test('the persisted state generation carries terrain layers', () => {
  // Generation 7 carried terrain identity; 8 adds the stream workbench
  // identity block (checkpoint plus status) — both are serialized layer
  // fields, so each bump discards cache rows that cannot fold them.
  assert.equal(MAP_PROJECTION_STATE_VERSION, 8, 'serialized layer identity fields keep the cache generation current')
  const settled = settleAdd(terrainLayer())
  assert.equal(settled.stateVersion, MAP_PROJECTION_STATE_VERSION)
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

function graphicsLayerOf(view) {
  return view.map.layers.find(candidate => candidate instanceof FakeGraphicsLayer)
}

function handleOf(key = 's1:view:map') {
  return globalThis.__mapHarness.get(key)
}

test('terrain preview points render at their elevation z in 2D and 3D', async () => {
  for (const mode of ['map', 'scene']) {
    const mounted = await mountedOccurrence(mode, terrainLayer())
    const graphics = graphicsLayerOf(mounted.view)
    assert.equal(graphics.graphics.length, 3, `${mode}: every preview point renders`)
    const zValues = graphics.graphics.map(graphic => graphic.geometry.z)
    assert.deepEqual(zValues, [40, 55, 47], `${mode}: elevations ride the Point z`)
    assert.ok(handleOf().terrainRevisions.includes('terrain-preview@digest-city-v1'), `${mode}: the handle cites the terrain revision`)
    mounted.occurrence.dispose()
  }
})

test('re-adding the same layer id at a new terrain version redraws the new elevations', async () => {
  const mounted = await mountedOccurrence('map', terrainLayer())
  const graphics = graphicsLayerOf(mounted.view)
  assert.equal(graphics.graphics.length, 3)
  const nextFeatures = displayPoints.features.map(feature => ({ ...feature, properties: { elev: feature.properties.elev + 10 } }))
  // Same display digest on purpose: only the revision differs.
  const v2 = terrainLayer('terrain-preview', 'digest-city-v2', nextFeatures)
  mounted.set(occurrenceState('map', v2))
  mounted.occurrence.refresh(occurrenceState('map', v2))
  await flush()
  const zValues = graphics.graphics.map(graphic => graphic.geometry.z)
  assert.deepEqual(zValues, [50, 65, 57], 'the new version redraws with its own elevations')
  assert.ok(handleOf().terrainRevisions.includes('terrain-preview@digest-city-v2'))
  assert.ok(!handleOf().terrainRevisions.includes('terrain-preview@digest-city-v1'))
  mounted.occurrence.dispose()
})

test('an unchanged terrain layer does not rebuild graphics', async () => {
  const mounted = await mountedOccurrence('map', terrainLayer())
  const graphics = graphicsLayerOf(mounted.view)
  const firstGraphic = graphics.graphics[0]
  mounted.occurrence.refresh(occurrenceState('map', terrainLayer()))
  await flush()
  assert.equal(graphics.graphics[0], firstGraphic, 'the cached render identity survives the refresh')
  mounted.occurrence.dispose()
})

test('removing the terrain layer clears its graphics and revision token', async () => {
  const mounted = await mountedOccurrence('map', terrainLayer())
  assert.equal(graphicsLayerOf(mounted.view).graphics.length, 3)
  mounted.set(occurrenceState('map', undefined))
  mounted.occurrence.refresh(occurrenceState('map', undefined))
  await flush()
  assert.equal(graphicsLayerOf(mounted.view), undefined, 'unload drops the graphics layer from the map')
  assert.deepEqual(handleOf().terrainRevisions, [], 'unload drops the revision token')
  mounted.occurrence.dispose()
})

test('a mode switch re-renders the same terrain revision on the other engine', async () => {
  resetCaptured()
  const layer = terrainLayer()
  let current = occurrenceState('map', layer)
  const mapSide = createMapOccurrence(() => current, 's1', 'view:map')
  mapSide.mount(holder())
  await flush()
  current = occurrenceState('scene', layer)
  const sceneSide = createMapOccurrence(() => current, 's1', 'view:scene')
  sceneSide.mount(holder())
  await flush()
  assert.equal(captured.mapViews.length, 1)
  assert.equal(captured.sceneViews.length, 1)
  assert.deepEqual(graphicsLayerOf(captured.sceneViews[0]).graphics.map(graphic => graphic.geometry.z), [40, 55, 47])
  assert.ok(handleOf('s1:view:scene').terrainRevisions.includes('terrain-preview@digest-city-v1'), 'the 3D occurrence cites the same terrain revision')
  mapSide.dispose()
  sceneSide.dispose()
})
