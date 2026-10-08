/**
 * P0a map-tool commit fixtures: mutation handlers propose pure candidates
 * against the accepted projection (never writing state), the returned
 * versioned meta folds only through the agent loop's accepted successful
 * `tool/result`, and the refusal paths — missing pairing, wrong pairing,
 * nested dispatch, capacity, cancellation — fail loud without map changes.
 * `map_get_state` reads the authoritative projection, so a recovered session
 * (fresh process, no cache) reports the same state.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_MAP_LAYERS } from '../../map-container/src/protocol.ts'
import { layerPayload, mapRig, pointCollection } from '../../map-container/tests/map-rig.mjs'
import {
  mapAddLayer,
  mapGetState,
  mapRemoveLayer,
  mapSetMode,
  mapSetView,
} from '../src/map-tools.ts'
import { displayDigestOf } from '../src/display.ts'

function renderedValue(tool, args, value) {
  const content = tool.output.render(args, value)
  assert.equal(content.length, 1)
  assert.equal(content[0].type, 'text')
  return JSON.parse(content[0].text)
}

test('mutation tools propose foldable candidates and only accepted results change the map', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'map-tools-'))
  writeFileSync(join(dir, 'point.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  try {
    const session = rig.session('session-a')

    // map_add_layer: candidate meta cites the accepted call and the current revision.
    const addCall = rig.call(session, 'call-add', 'map_add_layer', { path: 'point.geojson', layer_id: 'point' })
    const added = await mapAddLayer.execute({ path: 'point.geojson', layer_id: 'point' }, rig.exec(session, { callId: 'call-add' }))
    assert.equal(added.layer.id, 'point')
    assert.equal(added.total_layers, 1)
    assert.deepEqual(added.meta, {
      schemaVersion: 4,
      kind: 'map-change',
      sourceCallSeq: addCall.seq,
      targetRevision: 0,
      change: { op: 'add-layer', layer: { ...layerPayload('point', pointCollection(), addCall.seq), name: 'point.geojson', displayDigest: displayDigestOf(pointCollection()) } },
    })
    assert.equal(rig.state(session).layers.length, 0, 'the handler itself must not mutate the authoritative map')
    rig.result(session, addCall, { meta: added.meta })
    assert.equal(rig.state(session).layers.length, 1)
    assert.equal(rig.state(session).revision, 1)

    const viewCall = rig.call(session, 'call-view', 'map_set_view', { center: [116.4, 39.9], zoom: 9 })
    const viewed = await mapSetView.execute({ center: [116.4, 39.9], zoom: 9 }, rig.exec(session, { callId: 'call-view' }))
    assert.equal(viewed.meta.targetRevision, 1)
    assert.equal(viewed.meta.sourceCallSeq, viewCall.seq)
    rig.result(session, viewCall, { meta: viewed.meta })

    const modeCall = rig.call(session, 'call-mode', 'map_set_mode', { mode: 'scene' })
    const moded = await mapSetMode.execute({ mode: 'scene' }, rig.exec(session, { callId: 'call-mode' }))
    rig.result(session, modeCall, { meta: moded.meta })

    const state = await mapGetState.execute({}, rig.exec(session))
    assert.deepEqual(state.layers.map(layer => layer.id), ['point'])
    assert.deepEqual(state.view.center, [116.4, 39.9])
    assert.equal(state.view.zoom, 9)
    assert.equal(state.mode, 'scene')

    const removeCall = rig.call(session, 'call-remove', 'map_remove_layer', { layer_id: 'point' })
    const removed = await mapRemoveLayer.execute({ layer_id: 'point' }, rig.exec(session, { callId: 'call-remove' }))
    assert.equal(removed.removed, true)
    assert.equal(removed.total_layers, 0)
    rig.result(session, removeCall, { meta: removed.meta })
    assert.equal(rig.state(session).layers.length, 0)
    assert.equal(rig.state(session).revision, 4)
  } finally {
    await rig.dispose()
  }
})

test('mutation tools keep projection meta durable but out of model-visible JSON', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'map-meta-'))
  writeFileSync(join(dir, 'point.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  try {
    const session = rig.session('session-meta')
    const addCall = rig.call(session, 'm-add', 'map_add_layer', { path: 'point.geojson', layer_id: 'point' })
    const added = await mapAddLayer.execute({ path: 'point.geojson', layer_id: 'point' }, rig.exec(session, { callId: 'm-add' }))
    rig.result(session, addCall, { meta: added.meta })
    const viewCall = rig.call(session, 'm-view', 'map_set_view', { center: [116.4, 39.9], zoom: 8, wkid: 4326 })
    const viewed = await mapSetView.execute({ center: [116.4, 39.9], zoom: 8, wkid: 4326 }, rig.exec(session, { callId: 'm-view' }))
    rig.result(session, viewCall, { meta: viewed.meta })
    const modeCall = rig.call(session, 'm-mode', 'map_set_mode', { mode: 'map' })
    const moded = await mapSetMode.execute({ mode: 'map' }, rig.exec(session, { callId: 'm-mode' }))
    rig.result(session, modeCall, { meta: moded.meta })
    const removeCall = rig.call(session, 'm-remove', 'map_remove_layer', { layer_id: 'point' })
    const removed = await mapRemoveLayer.execute({ layer_id: 'point' }, rig.exec(session, { callId: 'm-remove' }))
    rig.result(session, removeCall, { meta: removed.meta })

    const cases = [
      [mapAddLayer, { path: 'point.geojson', layer_id: 'point' }, added],
      [mapSetView, { center: [116.4, 39.9], zoom: 8, wkid: 4326 }, viewed],
      [mapSetMode, { mode: 'map' }, moded],
      [mapRemoveLayer, { layer_id: 'point' }, removed],
    ]
    for (const [tool, args, value] of cases) {
      assert.deepEqual(tool.output.presentationMeta(args, value), value.meta)
      assert.equal(Object.hasOwn(renderedValue(tool, args, value), 'meta'), false)
      assert.equal(value.meta.kind, 'map-change')
      assert.equal(value.meta.schemaVersion, 4)
    }
  } finally {
    await rig.dispose()
  }
})

test('mutation handlers refuse unpaired, mispaired, nested, and aborted executions without map changes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'map-refusals-'))
  const rig = await mapRig({ cwd: dir })
  try {
    const session = rig.session('session-refuse')
    await assert.rejects(
      mapSetView.execute({ center: [1, 2] }, rig.exec(session, { callId: 'never-appended' })),
      /accepted tool\/call/,
    )
    const misCall = rig.call(session, 'mis-pair', 'map_set_mode', { mode: 'scene' })
    await assert.rejects(
      mapSetView.execute({ center: [1, 2] }, rig.exec(session, { callId: 'mis-pair' })),
      /paired with tool map_set_mode/,
    )
    const nestedCall = rig.call(session, 'nested', 'map_set_view', { center: [1, 2] })
    const nestedExec = { ...rig.exec(session, { callId: 'nested' }), parent: Symbol('ptc-token') }
    await assert.rejects(
      mapSetView.execute({ center: [1, 2] }, nestedExec),
      /nested dispatch/,
    )
    const abortedCall = rig.call(session, 'aborted', 'map_set_view', { center: [1, 2] })
    const controller = new AbortController()
    controller.abort(new DOMException('canceled', 'AbortError'))
    await assert.rejects(
      mapSetView.execute({ center: [1, 2] }, rig.exec(session, { callId: 'aborted', signal: controller.signal })),
      /AbortError|abort/i,
    )
    assert.equal(rig.state(session).layers.length, 0)
    assert.equal(rig.state(session).revision, 0)
    assert.equal(rig.state(session).view.center[0], 0)
    assert.equal(misCall.seq >= 0, true)
    assert.equal(nestedCall.seq >= 0, true)
    assert.equal(abortedCall.seq >= 0, true)
  } finally {
    await rig.dispose()
  }
})

test('pre-commit capacity refuses the 33rd layer while the map keeps its 32', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'map-capacity-'))
  writeFileSync(join(dir, 'point.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  try {
    const session = rig.session('session-capacity')
    for (let at = 0; at < MAX_MAP_LAYERS; at++) {
      const call = rig.call(session, `cap-${at}`, 'map_add_layer', { path: 'point.geojson', layer_id: `l${at}` })
      const value = await mapAddLayer.execute({ path: 'point.geojson', layer_id: `l${at}` }, rig.exec(session, { callId: `cap-${at}` }))
      rig.result(session, call, { meta: value.meta })
    }
    assert.equal(rig.state(session).layers.length, MAX_MAP_LAYERS)
    const oneTooMany = rig.call(session, 'cap-overflow', 'map_add_layer', { path: 'point.geojson', layer_id: 'overflow' })
    await assert.rejects(
      mapAddLayer.execute({ path: 'point.geojson', layer_id: 'overflow' }, rig.exec(session, { callId: 'cap-overflow' })),
      /at most 32 layers/,
    )
    rig.result(session, oneTooMany, { isError: true, text: 'Error: map container accepts at most 32 layers' })
    assert.equal(rig.state(session).layers.length, MAX_MAP_LAYERS)
    assert.equal(rig.state(session).revision, MAX_MAP_LAYERS)
    // The tool threw before returning, so the failed result carries no meta:
    // the pending entry settles silently and the map keeps its 32 layers.
    assert.deepEqual(rig.state(session).diagnostics, [])
  } finally {
    await rig.dispose()
  }
})

test('map_get_state reads the authoritative projection and survives a fresh process without cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'map-recovery-'))
  writeFileSync(join(dir, 'point.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  let stored
  let sessionId
  try {
    const session = rig.session('session-recover')
    sessionId = session.id
    const call = rig.call(session, 'rec-add', 'map_add_layer', { path: 'point.geojson', layer_id: 'point' })
    const added = await mapAddLayer.execute({ path: 'point.geojson', layer_id: 'point' }, rig.exec(session, { callId: 'rec-add' }))
    rig.result(session, call, { meta: added.meta })
    const viewCall = rig.call(session, 'rec-view', 'map_set_view', { center: [116.4, 39.9], zoom: 5 })
    const viewed = await mapSetView.execute({ center: [116.4, 39.9], zoom: 5 }, rig.exec(session, { callId: 'rec-view' }))
    rig.result(session, viewCall, { meta: viewed.meta })
    stored = session.snapshotEvents().map(event => JSON.parse(JSON.stringify(event)))
    const before = await mapGetState.execute({}, rig.exec(session))
    assert.equal(before.layers.length, 1)
  } finally {
    await rig.dispose()
  }

  const recovered = await mapRig({ cwd: dir })
  try {
    const session = recovered.ctx.sessions.create(sessionId, { seed: stored, meta: { cwd: dir } })
    const state = await mapGetState.execute({}, recovered.exec(session))
    assert.deepEqual(state.layers.map(layer => layer.id), ['point'])
    assert.deepEqual(state.view.center, [116.4, 39.9])
    assert.equal(state.view.zoom, 5)
  } finally {
    await recovered.dispose()
  }
})

test('sessions stay isolated and tools reject missing callers or services', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'map-errors-'))
  const rig = await mapRig({ cwd: dir })
  try {
    const a = rig.session('iso-a')
    const b = rig.session('iso-b')
    const callA = rig.call(a, 'iso-add', 'map_add_layer', { path: 'x', layer_id: 'only-a' })
    await assert.rejects(
      mapAddLayer.execute({ path: 'x', layer_id: 'only-a' }, rig.exec(a, { callId: 'iso-add' })),
      /could not be read|GeoJSON/i,
    )
    void callA
    assert.equal(rig.state(a).layers.length, 0)
    assert.equal(rig.state(b).layers.length, 0)
    await assert.rejects(
      mapGetState.execute({}, { signal: new AbortController().signal }),
      /agent session caller/,
    )
    const serviceless = await mapRig({ cwd: dir })
    try {
      const session = serviceless.session('no-map-service')
      const bare = { signal: new AbortController().signal, agent: { ctx: { get: () => undefined }, session } }
      await assert.rejects(mapGetState.execute({}, bare), /map container service unavailable/)
    } finally {
      await serviceless.dispose()
    }
  } finally {
    await rig.dispose()
  }
})
