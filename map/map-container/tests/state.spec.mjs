import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEGENERATE_BBOX_PAD_DEG, geoJsonBbox } from '../src/client/bbox.ts'
import { wireToState } from '../src/client/state.ts'
import { mapTabDefinition } from '../src/client/definition.ts'

test('the map is a retained single-content page rather than a second conversation canvas', () => {
  const definition = mapTabDefinition()
  assert.equal(definition.kind, 'map')
  assert.equal(definition.multiple, false)
  assert.equal(definition.keepMounted, true)
})

test('wireToState rebuilds occurrence state from the projection wire', () => {
  const state = wireToState({
    layers: [{
      id: 'sample-points',
      name: 'sample-points',
      sourceCrs: 'EPSG:4326',
      opacity: 1,
      visible: true,
      data: { type: 'FeatureCollection', features: [] },
    }],
    view: { center: [116.2, 39.2], zoom: 8, wkid: 4326 },
    mode: 'map',
    aoi: { name: 'study', ring: [[116, 39], [117, 39], [117, 40], [116, 39]] },
    revision: 7,
    operations: [{ index: 1, operationId: 'op-1', undoOf: null, writerId: 'w1', revision: 7, summary: 'add-layer sample-points (0 features)' }],
  })
  assert.equal(state.layers.get('sample-points').name, 'sample-points')
  assert.deepEqual(state.view.center, [116.2, 39.2])
  assert.equal(state.revision, 7)
  assert.deepEqual(state.aoi.ring, [[116, 39], [117, 39], [117, 40], [116, 39]])
  assert.deepEqual(state.operations[0].summary, 'add-layer sample-points (0 features)')
  const bare = wireToState({
    layers: [],
    view: { center: [0, 0], zoom: 0, wkid: 4326 },
    mode: 'map',
    aoi: null,
    revision: 0,
    operations: [],
  })
  assert.equal(bare.aoi, null)
  assert.deepEqual(bare.operations, [])
  assert.equal(wireToState(undefined), undefined)
})

test('polygon bbox is the coordinate envelope', () => {
  const bbox = geoJsonBbox({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[116, 39], [116.5, 39], [116.5, 39.5], [116, 39.5], [116, 39]]] },
      properties: {},
    }],
  })
  assert.deepEqual(bbox, { west: 116, south: 39, east: 116.5, north: 39.5 })
})

test('point bbox is padded on both axes', () => {
  const bbox = geoJsonBbox({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [116.4, 39.9] },
      properties: {},
    }],
  })
  assert.deepEqual(bbox, {
    west: 116.4 - DEGENERATE_BBOX_PAD_DEG,
    south: 39.9 - DEGENERATE_BBOX_PAD_DEG,
    east: 116.4 + DEGENERATE_BBOX_PAD_DEG,
    north: 39.9 + DEGENERATE_BBOX_PAD_DEG,
  })
})

test('empty or non-geojson data has no bbox', () => {
  assert.equal(geoJsonBbox({ type: 'FeatureCollection', features: [] }), null)
  assert.equal(geoJsonBbox(undefined), null)
})
