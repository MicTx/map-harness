/**
 * Layer-state fold fixtures: the three presentation changes
 * (`set-layer-state`, `set-symbol-style`, `set-feature-overrides`) through
 * decode → validate → settle, the v5 version gate (v4 records naming the new
 * words or fields refuse read-only), undo round-trips restoring prior
 * visibility/symbol/overrides, patch composition, operation-id idempotency,
 * the `feature-unknown` refusal with zero residue, imagery layer
 * add/remove/replay through the same fold, and the v8 cache-row discard.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAP_META_SCHEMA_VERSION,
  MAP_MUTATION_TOOL_NAMES,
  MAP_PROJECTION_STATE_VERSION,
  MAX_LAYER_STATE_ENTRIES,
  buildMapChangeMeta,
  decodeMapChangeMeta,
  initialMapProjectionState,
  layerDigestOf,
  mapChangeAllowedForTool,
  mapProjectionStateSchema,
  settleMapResult,
  validateMapChangeCandidate,
} from '../src/protocol.ts'
import { LAYERS_METHOD_VERSION, overridesVersionOf, symbolVersionOf } from '../../layers/src/index.ts'

/** A settled call fixture against one base state. */
function settleChange(state, pendingName, change, { callSeq = 1, resultSeq = 2, operationId, undoOf } = {}) {
  const meta = buildMapChangeMeta(callSeq, state.revision, change, {
    ...(operationId === undefined ? {} : { operationId }),
    ...(undoOf === undefined ? {} : { undoOf }),
  })
  return settleMapResult(state, {
    resultSeq,
    pending: { callId: `c${callSeq}`, callSeq, name: pendingName },
    isError: false,
    meta,
    citedCallSeq: callSeq,
  })
}

/** One data layer carrying a stable feature id set (GeoJSON `id` member = `featureIdOf` key). */
function dataLayer(id = 'hospitals', featureIds = ['h1', 'h2']) {
  return {
    id,
    name: id,
    data: {
      type: 'FeatureCollection',
      features: featureIds.map((featureId, at) => ({
        type: 'Feature',
        id: featureId,
        geometry: { type: 'Point', coordinates: [116.4 + at * 0.01, 39.9] },
        properties: { featureId },
      })),
    },
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    sourceCallSeq: 1,
  }
}

/** One line layer (non-Point) for the heatmap refusals. */
function lineLayer(id = 'roads') {
  return {
    id,
    name: id,
    data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[116.4, 39.9], [116.5, 39.95]] }, properties: {} }],
    },
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    sourceCallSeq: 1,
  }
}

/** One validated single symbol over the map-layers vocabulary. */
function redSquareSymbol() {
  const draft = {
    methodVersion: LAYERS_METHOD_VERSION,
    presentation: 'single',
    point: { shape: 'square', color: '#e53935', sizePx: 12, opacity: 0.8 },
  }
  return { ...draft, symbolVersion: symbolVersionOf(draft) }
}

/** One validated heatmap symbol. */
function heatmapSymbol() {
  const draft = {
    methodVersion: LAYERS_METHOD_VERSION,
    presentation: 'heatmap',
    heatmap: { radiusPx: 24, ramp: 'viridis' },
  }
  return { ...draft, symbolVersion: symbolVersionOf(draft) }
}

/** One bare override entry list. */
function overrideEntries() {
  return [{ featureIds: ['h1'], patch: { color: '#1e88e5' } }]
}

/** The state after adding one layer through the ordinary fold. */
function stateWithLayer(layer) {
  return settleChange(initialMapProjectionState(), 'map_add_layer', { op: 'add-layer', layer })
}

test('set-layer-state folds one batch as one revision and exposes groups on the wire', () => {
  const base = settleChange(
    settleChange(initialMapProjectionState(), 'map_add_layer', { op: 'add-layer', layer: dataLayer('a') }),
    'map_add_layer',
    { op: 'add-layer', layer: dataLayer('b', ['b1']) },
  )
  assert.equal(base.revision, 2)
  const settled = settleChange(base, 'layer_set_state', {
    op: 'set-layer-state',
    states: [
      { layerId: 'a', visible: false, opacity: 0.5, group: '路网' },
      { layerId: 'b', group: null },
    ],
  })
  assert.equal(settled.revision, 3)
  assert.equal(settled.diagnostics.length, 0)
  const a = settled.layers.find(layer => layer.id === 'a')
  const b = settled.layers.find(layer => layer.id === 'b')
  assert.equal(a.visible, false)
  assert.equal(a.opacity, 0.5)
  assert.equal(a.group, '路网')
  assert.equal(b.group, undefined)
  assert.equal(settled.operations.at(-1).summary, 'set-layer-state a, b')
  assert.deepEqual(settled.operations.at(-1).post.layerStates, [
    { layerId: 'a', visible: false, opacity: 0.5, group: '路网' },
    { layerId: 'b', visible: true, opacity: 1, group: null },
  ])
})

test('set-layer-state undo restores the prior visibility, opacity, and group', () => {
  const base = settleChange(stateWithLayer(dataLayer()), 'layer_set_state', {
    op: 'set-layer-state',
    states: [{ layerId: 'hospitals', visible: false, opacity: 0.25, group: 'health' }],
  })
  const record = base.operations.at(-1)
  const undone = settleChange(base, 'map_undo', record.inverse, { callSeq: 3, undoOf: record.index })
  const layer = undone.layers.find(candidate => candidate.id === 'hospitals')
  assert.equal(layer.visible, true)
  assert.equal(layer.opacity, 1)
  assert.equal(layer.group, undefined)
  assert.equal(undone.operations.at(-1).undoOf, record.index)
})

test('set-layer-state refusals: unknown layer, duplicate entries, empty entries, v4 records', () => {
  const base = stateWithLayer(dataLayer())
  const unknown = settleChange(base, 'layer_set_state', { op: 'set-layer-state', states: [{ layerId: 'nope', visible: false }] })
  assert.equal(unknown.revision, 1)
  assert.deepEqual(unknown.layers, base.layers)
  assert.equal(unknown.diagnostics.at(-1).code, 'layer-unknown')

  const duplicate = decodeMapChangeMeta({
    ...JSON.parse(JSON.stringify(buildMapChangeMeta(1, 1, { op: 'set-layer-state', states: [{ layerId: 'a', visible: true }, { layerId: 'a', visible: false }] }))),
  })
  assert.equal(duplicate.status, 'refused')

  const empty = decodeMapChangeMeta(buildMapChangeMeta(1, 1, { op: 'set-layer-state', states: [{ layerId: 'a' }] }))
  assert.equal(empty.status, 'refused')

  const v4 = JSON.parse(JSON.stringify(buildMapChangeMeta(1, 1, { op: 'set-layer-state', states: [{ layerId: 'hospitals', visible: false }] })))
  v4.schemaVersion = 4
  const decoded = decodeMapChangeMeta(v4)
  assert.equal(decoded.status, 'refused')
  assert.equal(decoded.code, 'invalid-meta')

  const tooMany = { op: 'set-layer-state', states: Array.from({ length: MAX_LAYER_STATE_ENTRIES + 1 }, (_, at) => ({ layerId: `l${at}`, visible: false })) }
  assert.equal(decodeMapChangeMeta(buildMapChangeMeta(1, 1, tooMany)).status, 'refused')
})

test('set-symbol-style folds, versions, clears, and undoes through the prior symbol', () => {
  const base = stateWithLayer(dataLayer())
  const styled = settleChange(base, 'layer_set_style', { op: 'set-symbol-style', entries: [{ layerId: 'hospitals', symbol: redSquareSymbol() }] })
  const styledLayer = styled.layers.find(layer => layer.id === 'hospitals')
  assert.equal(styledLayer.symbol.symbolVersion, redSquareSymbol().symbolVersion)
  assert.deepEqual(styled.operations.at(-1).post.symbolVersions, [{ layerId: 'hospitals', symbolVersion: styledLayer.symbol.symbolVersion }])

  const record = styled.operations.at(-1)
  const undone = settleChange(styled, 'map_undo', record.inverse, { callSeq: 3, undoOf: record.index })
  assert.equal(undone.layers.find(layer => layer.id === 'hospitals').symbol, undefined)

  const recolored = settleChange(styled, 'layer_set_style', {
    op: 'set-symbol-style',
    entries: [{ layerId: 'hospitals', symbol: { ...redSquareSymbol(), symbolVersion: 'sym-tampered@v1' } }],
  })
  assert.equal(recolored.revision, styled.revision)
  assert.equal(recolored.diagnostics.at(-1).code, 'invalid-meta')

  const cleared = settleChange(styled, 'layer_set_style', { op: 'set-symbol-style', entries: [{ layerId: 'hospitals', symbol: null }] })
  assert.equal(cleared.layers.find(layer => layer.id === 'hospitals').symbol, undefined)
})

test('heatmap presentations refuse non-point layers and coexisting classification styles at both boundaries', () => {
  const pointBase = stateWithLayer(dataLayer())
  const heated = settleChange(pointBase, 'layer_set_style', { op: 'set-symbol-style', entries: [{ layerId: 'hospitals', symbol: heatmapSymbol() }] })
  assert.equal(heated.revision, 2)
  assert.equal(heated.layers.find(layer => layer.id === 'hospitals').symbol.presentation, 'heatmap')

  const lineBase = stateWithLayer(lineLayer())
  const refused = settleChange(lineBase, 'layer_set_style', { op: 'set-symbol-style', entries: [{ layerId: 'roads', symbol: heatmapSymbol() }] })
  assert.equal(refused.revision, 1)
  assert.equal(refused.diagnostics.at(-1).code, 'invalid-meta')
  assert.throws(() => validateMapChangeCandidate(lineBase, { op: 'set-symbol-style', entries: [{ layerId: 'roads', symbol: heatmapSymbol() }] }), /all-Point/)

  const mixed = { ...pointBase, layers: pointBase.layers.map(layer => ({ ...layer, style: { styleVersion: 'sty-x@v1' } })) }
  const conflicted = settleChange(mixed, 'layer_set_style', { op: 'set-symbol-style', entries: [{ layerId: 'hospitals', symbol: heatmapSymbol() }] })
  assert.equal(conflicted.revision, mixed.revision)
  assert.equal(conflicted.diagnostics.at(-1).code, 'invalid-meta')

  const unknown = settleChange(pointBase, 'layer_set_style', { op: 'set-symbol-style', entries: [{ layerId: 'nope', symbol: redSquareSymbol() }] })
  assert.equal(unknown.diagnostics.at(-1).code, 'layer-unknown')
})

test('set-feature-overrides folds with a derived version and refuses unknown feature ids with zero residue', () => {
  const base = stateWithLayer(dataLayer())
  const entries = overrideEntries()
  const settled = settleChange(base, 'layer_set_style', { op: 'set-feature-overrides', entries: [{ layerId: 'hospitals', overrides: entries }] })
  const layer = settled.layers.find(candidate => candidate.id === 'hospitals')
  assert.equal(layer.overrides.overridesVersion, overridesVersionOf(entries))
  assert.deepEqual(settled.operations.at(-1).post.overridesVersions, [{ layerId: 'hospitals', overridesVersion: layer.overrides.overridesVersion }])

  const refused = settleChange(base, 'layer_set_style', { op: 'set-feature-overrides', entries: [{ layerId: 'hospitals', overrides: [{ featureIds: ['missing'], patch: { color: '#1e88e5' } }] }] })
  assert.equal(refused.revision, 1)
  assert.deepEqual(refused.operations, base.operations)
  assert.equal(refused.diagnostics.at(-1).code, 'feature-unknown')

  const second = [{ featureIds: ['h2'], patch: { color: '#43a047' } }]
  const resettled = settleChange(settled, 'layer_set_style', { op: 'set-feature-overrides', entries: [{ layerId: 'hospitals', overrides: second }] }, { callSeq: 3 })
  assert.equal(resettled.layers.find(layer => layer.id === 'hospitals').overrides.overridesVersion, overridesVersionOf(second))

  const record = resettled.operations.at(-1)
  const undone = settleChange(resettled, 'map_undo', record.inverse, { callSeq: 4, undoOf: record.index })
  const undoneLayer = undone.layers.find(layer => layer.id === 'hospitals')
  assert.equal(undoneLayer.overrides.overridesVersion, overridesVersionOf(entries))

  const cleared = settleChange(settled, 'layer_set_style', { op: 'set-feature-overrides', entries: [{ layerId: 'hospitals', overrides: null }] }, { callSeq: 5 })
  assert.equal(cleared.layers.find(layer => layer.id === 'hospitals').overrides, undefined)
})

test('a v4 record naming the new presentation fields refuses read-only', () => {
  const layer = { ...dataLayer(), symbol: redSquareSymbol() }
  const v4 = JSON.parse(JSON.stringify(buildMapChangeMeta(1, 0, { op: 'add-layer', layer })))
  v4.schemaVersion = 4
  const decoded = decodeMapChangeMeta(v4)
  assert.equal(decoded.status, 'refused')
  assert.equal(decoded.code, 'invalid-meta')
})

test('the three new words compose inside one patch and replay idempotently by operation id', () => {
  const base = stateWithLayer(dataLayer())
  const change = {
    op: 'patch',
    changes: [
      { op: 'set-layer-state', states: [{ layerId: 'hospitals', group: 'clinics' }] },
      { op: 'set-symbol-style', entries: [{ layerId: 'hospitals', symbol: redSquareSymbol() }] },
    ],
  }
  const meta = buildMapChangeMeta(1, base.revision, change, { operationId: 'op-patch-1' })
  const settled = settleMapResult(base, {
    resultSeq: 2,
    pending: { callId: 'c1', callSeq: 1, name: 'map_apply_patch' },
    isError: false,
    meta,
    citedCallSeq: 1,
  })
  assert.equal(settled.revision, 2)
  const layer = settled.layers.find(candidate => candidate.id === 'hospitals')
  assert.equal(layer.group, 'clinics')
  assert.equal(layer.symbol.symbolVersion, redSquareSymbol().symbolVersion)

  const replay = settleMapResult(settled, {
    resultSeq: 3,
    pending: { callId: 'c1', callSeq: 1, name: 'map_apply_patch' },
    isError: false,
    meta,
    citedCallSeq: 1,
  })
  assert.equal(replay.revision, 2)
  assert.equal(replay.diagnostics.at(-1).code, 'duplicate-op')
})

test('imagery layers add, remove, and replay through the same fold', () => {
  const imagery = {
    methodVersion: LAYERS_METHOD_VERSION,
    urlTemplate: 'https://tiles.example.org/base/{level}/{row}/{col}.png',
    attribution: 'Example tiles',
  }
  const layer = {
    id: 'osm-overlay',
    name: 'Example tiles',
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    sourceCallSeq: 1,
    imagery,
  }
  const settled = settleChange(initialMapProjectionState(), 'map_add_layer', { op: 'add-layer', layer })
  assert.equal(settled.layers.length, 1)
  assert.equal(settled.layers[0].imagery.urlTemplate, imagery.urlTemplate)
  assert.equal(settled.layers[0].data, undefined)
  assert.equal(layerDigestOf(settled.layers[0]), layerDigestOf(layer))

  const both = decodeMapChangeMeta(buildMapChangeMeta(1, 0, { op: 'add-layer', layer: { ...layer, data: dataLayer().data } }))
  assert.equal(both.status, 'refused')

  const removed = settleChange(settled, 'map_remove_layer', { op: 'remove-layer', layerId: 'osm-overlay' }, { callSeq: 2 })
  assert.equal(removed.layers.length, 0)
  const readded = settleChange(removed, 'map_add_layer', { op: 'add-layer', layer: { ...layer, sourceCallSeq: 3 } }, { callSeq: 3 })
  assert.equal(readded.layers.length, 1)
  assert.equal(readded.operations.at(-1).summary, 'add-layer osm-overlay (0 features)')

  const stateChange = settleChange(readded, 'layer_set_state', { op: 'set-layer-state', states: [{ layerId: 'osm-overlay', opacity: 0.6, group: 'basemaps' }] }, { callSeq: 4 })
  assert.equal(stateChange.layers[0].opacity, 0.6)
})

test('v8 cache rows refuse the persisted-state schema and refold from the raw log', () => {
  const v8Row = { ...initialMapProjectionState(), stateVersion: 8 }
  assert.equal(mapProjectionStateSchema.safeParse(v8Row).success, false)
  assert.equal(mapProjectionStateSchema.safeParse(initialMapProjectionState()).success, true)
  assert.equal(MAP_PROJECTION_STATE_VERSION, 9)
})

test('the mutation tool surface owns exactly the new words for the new changes', () => {
  assert.ok(MAP_MUTATION_TOOL_NAMES.includes('layer_set_state'))
  assert.ok(MAP_MUTATION_TOOL_NAMES.includes('layer_set_style'))
  assert.equal(mapChangeAllowedForTool('layer_set_state', { op: 'set-layer-state', states: [{ layerId: 'a', visible: true }] }), true)
  assert.equal(mapChangeAllowedForTool('layer_set_style', { op: 'set-symbol-style', entries: [{ layerId: 'a', symbol: null }] }), true)
  assert.equal(mapChangeAllowedForTool('layer_set_style', { op: 'set-feature-overrides', entries: [{ layerId: 'a', overrides: null }] }), true)
  assert.equal(mapChangeAllowedForTool('layer_set_state', { op: 'set-symbol-style', entries: [{ layerId: 'a', symbol: null }] }), false)
  assert.equal(mapChangeAllowedForTool('map_set_view', { op: 'set-layer-state', states: [{ layerId: 'a', visible: true }] }), false)
  assert.equal(mapChangeAllowedForTool('map_undo', { op: 'set-layer-state', states: [{ layerId: 'a', visible: true }] }), true)
  assert.equal(MAP_META_SCHEMA_VERSION, 5)
})
