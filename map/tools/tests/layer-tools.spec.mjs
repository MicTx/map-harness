/**
 * Layer presentation tool fixtures over the REAL session/projection chain:
 * `layer_set_state` batching as one revision with `map_get_state` group
 * visibility, `expected_revision` staleness, cancellation with zero residue,
 * the collab compatibility paths (update-layer and upsert-layer replacements
 * keep symbol/overrides/group), `layer_set_style` preset/auto expansion with
 * transparency tiers, override-id refusal, heatmap exclusivity on both
 * guards, and the `map_add_layer` tile branch (admission, credential
 * refusal, crs exclusivity, WebTile identity into the projection and wire).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import { mapDraw, mapAddLayer, mapGetState } from '../src/map-tools.ts'
import { layerSetState, layerSetStyle } from '../src/layer-tools.ts'
import { mapApplyPatch, mapUndo } from '../src/collab-tools.ts'
import { legendForLayer } from '../src/display.ts'
import { autoSymbolOf, resolveSymbolPreset, symbolVersionOf } from '../../layers/src/index.ts'
import { buildStyle } from '../../spatial-viz/src/index.ts'
import * as spatialCollabPlugin from '../../spatial-collab/src/plugin.ts'

/** Draw one point layer through the real call/result chain. */
async function drawPointLayer(rig, session, callId, { layerId = 'hospitals', coordinates = [[116.4, 39.9], [116.42, 39.92]] } = {}) {
  const args = { kind: 'point', coordinates: coordinates.slice(0, 1), layer_id: layerId, name: layerId }
  const call = rig.call(session, callId, 'map_draw', args)
  const value = await mapDraw.execute(args, rig.exec(session, { callId }))
  rig.result(session, call, { meta: value.meta })
  return call
}

/** Draw one line layer (heatmap's non-Point refusal fixture). */
async function drawLineLayer(rig, session, callId, layerId = 'roads') {
  const args = { kind: 'line', coordinates: [[116.4, 39.9], [116.5, 39.95]], layer_id: layerId, name: layerId }
  const call = rig.call(session, callId, 'map_draw', args)
  const value = await mapDraw.execute(args, rig.exec(session, { callId }))
  rig.result(session, call, { meta: value.meta })
  return call
}

/** Run one layer_set_state call through the rig and fold its meta. */
async function setState(rig, session, callId, states, extra = {}) {
  const args = { states, ...extra }
  const call = rig.call(session, callId, 'layer_set_state', args)
  const value = await layerSetState.execute(args, rig.exec(session, { callId }))
  rig.result(session, call, { meta: value.meta })
  return value
}

/** Run one layer_set_style call through the rig and fold its meta. */
async function setStyle(rig, session, callId, args) {
  const call = rig.call(session, callId, 'layer_set_style', args)
  const value = await layerSetStyle.execute(args, rig.exec(session, { callId }))
  rig.result(session, call, { meta: value.meta })
  return value
}

test('layer_set_state batches visibility, opacity, and group into one revision', async () => {
  const rig = await mapRig()
  try {
    await rig.ctx.plugin(spatialCollabPlugin)
    const session = rig.session('batch')
    await drawPointLayer(rig, session, 'c1', { layerId: 'hospitals' })
    await drawLineLayer(rig, session, 'c2', 'roads')
    assert.equal(rig.state(session).revision, 2)

    const value = await setState(rig, session, 'c3', [
      { layer_id: 'hospitals', visible: false, opacity: 0.4 },
      { layer_id: 'roads', group: '路网' },
    ])
    assert.deepEqual(value.updated, ['hospitals', 'roads'])
    assert.equal(rig.state(session).revision, 3, 'one call is one revision')
    const hospitals = rig.state(session).layers.find(layer => layer.id === 'hospitals')
    const roads = rig.state(session).layers.find(layer => layer.id === 'roads')
    assert.equal(hospitals.visible, false)
    assert.equal(hospitals.opacity, 0.4)
    assert.equal(roads.group, '路网')

    // map_get_state exposes the group so the model sees manual grouping.
    const stateValue = await mapGetState.execute({}, rig.exec(session, { callId: 'c4' }))
    assert.equal(stateValue.layers.find(layer => layer.id === 'roads').group, '路网')

    // Undo restores the prior presentation as a new revision.
    const undoArgs = { undo_of: rig.state(session).operations.at(-1).index }
    const undoCall = rig.call(session, 'c5', 'map_undo', undoArgs)
    const undoValue = await mapUndo.execute(undoArgs, rig.exec(session, { callId: 'c5' }))
    rig.result(session, undoCall, { meta: undoValue.meta })
    const restored = rig.state(session).layers.find(layer => layer.id === 'hospitals')
    assert.equal(restored.visible, true)
    assert.equal(restored.opacity, 1)
  } finally {
    await rig.dispose()
  }
})

test('layer_set_state refuses stale expected revisions and unknown layers with zero residue', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('refusals')
    await drawPointLayer(rig, session, 'c1', { layerId: 'hospitals' })
    const before = rig.state(session)
    await assert.rejects(
      setState(rig, session, 'c2', [{ layer_id: 'hospitals', visible: false }], { expected_revision: 0 }),
      /expected_revision 0 is stale/,
    )
    await assert.rejects(
      setState(rig, session, 'c3', [{ layer_id: 'nope', visible: false }]),
      /unknown layer_id "nope"/,
    )
    assert.equal(rig.state(session).revision, before.revision)
    assert.equal(rig.state(session).diagnostics.some(diagnostic => diagnostic.code !== 'duplicate-op'), false)
  } finally {
    await rig.dispose()
  }
})

test('cancellation before the fold leaves zero changes', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('cancel')
    await drawPointLayer(rig, session, 'c1', { layerId: 'hospitals' })
    const revisionBefore = rig.state(session).revision
    const call = rig.call(session, 'c2', 'layer_set_state', { states: [{ layer_id: 'hospitals', visible: false }] })
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      layerSetState.execute({ states: [{ layer_id: 'hospitals', visible: false }] }, { ...rig.exec(session, { callId: 'c2' }), signal: controller.signal }),
    )
    assert.equal(rig.state(session).revision, revisionBefore)
    assert.equal(rig.state(session).layers.find(layer => layer.id === 'hospitals').visible, true)
    void call
  } finally {
    await rig.dispose()
  }
})

test('layer_set_style expands presets and auto, keeping transparency tiers', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('styles')
    await drawPointLayer(rig, session, 'c1', { layerId: 'hospitals' })
    const preset = resolveSymbolPreset('marker-square-red-large')
    const presetValue = await setStyle(rig, session, 'c2', { layer_id: 'hospitals', preset: 'marker-square-red-large' })
    assert.equal(presetValue.symbol_version, preset.symbol.symbolVersion)
    const styled = rig.state(session).layers.find(layer => layer.id === 'hospitals')
    assert.equal(styled.symbol.point.opacity, 0.8, 'the transparency tier survives expansion')
    assert.equal(styled.symbol.point.shape, 'square')

    const autoValue = await setStyle(rig, session, 'c3', { layer_id: 'hospitals', auto: true })
    assert.equal(autoValue.symbol_version, autoSymbolOf('hospitals').symbolVersion)
    assert.equal(rig.state(session).layers.find(layer => layer.id === 'hospitals').symbol.symbolVersion, autoSymbolOf('hospitals').symbolVersion)

    const cleared = await setStyle(rig, session, 'c4', { layer_id: 'hospitals', symbol: null })
    assert.equal(cleared.symbol_version, autoSymbolOf('hospitals').symbolVersion)
    assert.equal(rig.state(session).layers.find(layer => layer.id === 'hospitals').symbol, undefined)

    await assert.rejects(
      setStyle(rig, session, 'c5', { layer_id: 'hospitals', symbol: preset.symbol, preset: 'marker-circle-blue' }),
      /mutually exclusive/,
    )
    await assert.rejects(
      setStyle(rig, session, 'c6', { layer_id: 'hospitals', preset: 'no-such-preset' }),
      /unknown preset/,
    )
  } finally {
    await rig.dispose()
  }
})

test('layer_set_style folds a semantic symbol with a label and refuses an invalid label', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('semantic')
    await drawPointLayer(rig, session, 'c1', { layerId: 'stops' })
    const draft = { methodVersion: 'map-layers@1', presentation: 'single', semantic: 'transit', label: { field: 'name', minZoom: 12 } }
    const value = await setStyle(rig, session, 'c2', { layer_id: 'stops', symbol: { ...draft, symbolVersion: symbolVersionOf(draft) } })
    const layer = rig.state(session).layers.find(candidate => candidate.id === 'stops')
    assert.equal(layer.symbol.semantic, 'transit')
    assert.deepEqual(layer.symbol.label, { field: 'name', minZoom: 12 })
    assert.equal(value.symbol_version, layer.symbol.symbolVersion)
    const revision = rig.state(session).revision
    const bad = { ...draft, label: { field: 'name', minZoom: 40 } }
    await assert.rejects(
      setStyle(rig, session, 'c3', { layer_id: 'stops', symbol: { ...bad, symbolVersion: symbolVersionOf(bad) } }),
      /label\.minZoom \(out-of-range\)/,
    )
    assert.equal(rig.state(session).revision, revision, 'a refused label leaves zero residue')
  } finally {
    await rig.dispose()
  }
})

test('layer_set_style applies overrides to known feature ids and refuses unknown ones', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('overrides')
    await drawPointLayer(rig, session, 'c1', { layerId: 'clinics' })
    const value = await setStyle(rig, session, 'c2', {
      layer_id: 'clinics',
      overrides: [{ featureIds: ['f-1'], patch: { color: '#1e88e5', opacity: 0.5 } }],
    })
    assert.ok(value.overrides_version?.startsWith('ovr-'))
    const layer = rig.state(session).layers.find(candidate => candidate.id === 'clinics')
    assert.equal(layer.overrides.overridesVersion, value.overrides_version)
    const revision = rig.state(session).revision
    await assert.rejects(
      setStyle(rig, session, 'c3', { layer_id: 'clinics', overrides: [{ featureIds: ['missing'], patch: { color: '#1e88e5' } }] }),
      /unknown feature id "missing"/,
    )
    assert.equal(rig.state(session).revision, revision)
  } finally {
    await rig.dispose()
  }
})

test('heatmap presentation refuses non-point layers and classified layers at the tool guard', async () => {
  const rig = await mapRig()
  try {
    await rig.ctx.plugin(spatialCollabPlugin)
    const session = rig.session('heatmap')
    await drawLineLayer(rig, session, 'c1', 'roads')
    const heatmap = resolveSymbolPreset('heatmap-viridis').symbol
    await assert.rejects(
      setStyle(rig, session, 'c2', { layer_id: 'roads', symbol: heatmap }),
      /GEOMETRY_UNSUPPORTED.*not all-Point/,
    )

    await drawPointLayer(rig, session, 'c3', { layerId: 'hospitals' })
    const built = buildStyle({
      field: 'score',
      unit: '人',
      measure: 'total',
      encoding: 'fill',
      classification: 'equal-interval',
      breaks: [10],
      domain: { min: 0, max: 20 },
    })
    const patchArgs = JSON.parse(JSON.stringify({
      patch: [{ kind: 'set-style', entries: [{ layerId: 'hospitals', style: built }] }],
      expected_revision: rig.state(session).revision,
    }))
    const patchCall = rig.call(session, 'c4', 'map_apply_patch', patchArgs)
    const patchValue = await mapApplyPatch.execute(patchArgs, rig.exec(session, { callId: 'c4' }))
    rig.result(session, patchCall, { meta: patchValue.meta })
    assert.equal(rig.state(session).layers.find(layer => layer.id === 'hospitals').style.styleVersion, built.styleVersion)

    await assert.rejects(
      setStyle(rig, session, 'c5', { layer_id: 'hospitals', symbol: heatmap }),
      /classification style.*exclusive/,
    )
  } finally {
    await rig.dispose()
  }
})

test('the collab compatibility paths keep symbol, overrides, and group on same-id replacement', async () => {
  const rig = await mapRig()
  try {
    await rig.ctx.plugin(spatialCollabPlugin)
    const session = rig.session('collab-compat')
    await drawPointLayer(rig, session, 'c1', { layerId: 'hospitals' })
    await setStyle(rig, session, 'c2', {
      layer_id: 'hospitals',
      preset: 'marker-square-red-large',
      overrides: [{ featureIds: ['f-1'], patch: { color: '#43a047' } }],
    })
    await setState(rig, session, 'c3', [{ layer_id: 'hospitals', group: 'clinics', opacity: 0.7 }])
    const styled = rig.state(session).layers.find(layer => layer.id === 'hospitals')
    const symbolVersion = styled.symbol.symbolVersion
    const overridesVersion = styled.overrides.overridesVersion

    const updateArgs = {
      patch: [{ kind: 'update-layer', layerId: 'hospitals', visible: false }],
      expected_revision: rig.state(session).revision,
    }
    const updateCall = rig.call(session, 'c4', 'map_apply_patch', updateArgs)
    const updateValue = await mapApplyPatch.execute(updateArgs, rig.exec(session, { callId: 'c4' }))
    rig.result(session, updateCall, { meta: updateValue.meta })
    const updated = rig.state(session).layers.find(layer => layer.id === 'hospitals')
    assert.equal(updated.visible, false)
    assert.equal(updated.symbol.symbolVersion, symbolVersion, 'update-layer keeps the presentation fields')
    assert.equal(updated.overrides.overridesVersion, overridesVersion)
    assert.equal(updated.group, 'clinics')

    const layerData = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'hospitals' } }] }
    const upsertArgs = {
      patch: [{ kind: 'upsert-layer', layer: { id: 'hospitals', name: 'hospitals renamed', data: layerData, sourceCrs: 'EPSG:4326', opacity: 0.7, visible: false } }],
      expected_revision: rig.state(session).revision,
    }
    const upsertCall = rig.call(session, 'c5', 'map_apply_patch', upsertArgs)
    const upsertValue = await mapApplyPatch.execute(upsertArgs, rig.exec(session, { callId: 'c5' }))
    rig.result(session, upsertCall, { meta: upsertValue.meta })
    const upserted = rig.state(session).layers.find(layer => layer.id === 'hospitals')
    assert.equal(upserted.name, 'hospitals renamed')
    assert.equal(upserted.symbol.symbolVersion, symbolVersion, 'upsert-layer keeps the presentation fields')
    assert.equal(upserted.overrides.overridesVersion, overridesVersion)
    assert.equal(upserted.group, 'clinics')
  } finally {
    await rig.dispose()
  }
})

test('map_add_layer tile branch admits key-free templates and renders imagery into the wire', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('tiles')
    const args = { tile_url: 'https://tiles.example.org/planet/{z}/{y}/{x}.png', tile_attribution: 'Example', name: 'Example tiles' }
    const call = rig.call(session, 'c1', 'map_add_layer', args)
    const value = await mapAddLayer.execute(args, rig.exec(session, { callId: 'c1' }))
    rig.result(session, call, { meta: value.meta })
    const layer = rig.state(session).layers.find(candidate => candidate.id === value.layer.id)
    assert.equal(layer.imagery.urlTemplate, 'https://tiles.example.org/planet/{level}/{row}/{col}.png')
    assert.equal(layer.data, undefined, 'an imagery layer carries no feature data')
    assert.equal(value.layer.featureCount, 0)
    assert.deepEqual(value.bbox, null)

    const wire = rig.view(session)
    const wireLayer = wire.layers.find(candidate => candidate.id === layer.id)
    assert.equal(wireLayer.imagery.urlTemplate, layer.imagery.urlTemplate)
    assert.equal(wireLayer.featureCount, 0)

    rig.call(session, 'c2', 'map_add_layer', {})
    await assert.rejects(
      mapAddLayer.execute({ tile_url: 'https://tiles.example.org/{z}/{y}/{x}.png?token=secret' }, rig.exec(session, { callId: 'c2' })),
      /imagery template rejected.*query-present/,
    )
    rig.call(session, 'c3', 'map_add_layer', {})
    await assert.rejects(
      mapAddLayer.execute({ tile_url: 'https://tiles.example.org/{z}/{y}/{x}.png', crs: 'EPSG:4547' }, rig.exec(session, { callId: 'c3' })),
      /crs applies to path inputs only/,
    )
    rig.call(session, 'c4', 'map_add_layer', {})
    await assert.rejects(
      mapAddLayer.execute({ tile_url: 'https://user:pass@tiles.example.org/{z}/{y}/{x}.png' }, rig.exec(session, { callId: 'c4' })),
      /imagery template rejected.*userinfo-present/,
    )
  } finally {
    await rig.dispose()
  }
})

test('the versioned-layer legend wiring derives deterministically from the layer id', () => {
  const first = legendForLayer('hospitals', 'Hospitals')
  const second = legendForLayer('hospitals', 'Hospitals')
  assert.deepEqual(first, second)
  assert.deepEqual(first, legendForLayer('hospitals', 'Hospitals'))
  assert.equal(first.title, 'Hospitals')
  assert.notDeepEqual(first.symbol, legendForLayer('clinics', 'Clinics').symbol)
})
