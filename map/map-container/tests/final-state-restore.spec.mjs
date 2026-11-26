import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mapRig, layerPayload, pointCollection } from './map-rig.mjs'
import { buildMapChangeMeta } from '../src/protocol.ts'
import { MAP_USER_CHANGE_SOURCE, userChangeNoticeText } from '../src/user-change.ts'

function appendUserChange(session, operationId, summary, record) {
  const text = userChangeNoticeText(summary, record)
  assert.ok(text)
  session.append('agent/inbox/spliced', {
    target: 'next-step',
    start: 0,
    inserted: [{
      id: `m-${operationId}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: MAP_USER_CHANGE_SOURCE, form: 'notice', summary },
    }],
  })
}

function addLayerMeta(callSeq, targetRevision, id = 'alpha') {
  return buildMapChangeMeta(callSeq, targetRevision, {
    op: 'add-layer',
    layer: layerPayload(id, pointCollection([116.4, 39.9], { name: 'sample' }), callSeq),
  })
}

test('the final camera and final layer state survive full replay and a fresh session load', async () => {
  const first = await mapRig()
  let stored
  let sessionId
  try {
    const session = first.session('final-state')
    sessionId = session.id
    const addCall = first.call(session, 'c1', 'map_add_layer', {})
    first.result(session, addCall, { meta: addLayerMeta(addCall.seq, 0) })
    appendUserChange(session, 'camera-1', '用户调整了地图视图', {
      operationId: 'camera-1',
      targetRevision: 1,
      change: { op: 'set-view', view: { center: [121.47, 31.23], zoom: 12, wkid: 4326, scale: 30_000, rotation: 33 } },
    })
    appendUserChange(session, 'layer-1', '用户在图层面板隐藏了图层：alpha', {
      operationId: 'layer-1',
      targetRevision: 2,
      change: { op: 'set-layer-state', states: [{ layerId: 'alpha', visible: false, opacity: 0.4 }] },
    })

    const live = first.state(session)
    assert.deepEqual(live.view, { center: [121.47, 31.23], zoom: 12, wkid: 4326, scale: 30_000, rotation: 33 })
    assert.equal(live.layers.find(layer => layer.id === 'alpha').visible, false)
    assert.equal(live.layers.find(layer => layer.id === 'alpha').opacity, 0.4)
    assert.equal(live.revision, 3)

    const registry = first.ctx.sessionProjections
    const restored = registry.restore({}, session.snapshotEvents(), 0, session.header, session.inheritedEventCount)
    assert.deepEqual(restored.snapshot.values.mapContainer.view, live.view)
    assert.equal(restored.snapshot.values.mapContainer.layers.find(layer => layer.id === 'alpha').visible, false)

    stored = session.snapshotEvents()
  } finally {
    await first.dispose()
  }

  const second = await mapRig()
  try {
    const restored = second.ctx.sessions.create(sessionId, {
      seed: stored.map(event => JSON.parse(JSON.stringify(event))),
    })
    const state = second.state(restored)
    assert.deepEqual(state.view, { center: [121.47, 31.23], zoom: 12, wkid: 4326, scale: 30_000, rotation: 33 })
    assert.equal(state.layers.find(layer => layer.id === 'alpha').visible, false)
    assert.equal(state.layers.find(layer => layer.id === 'alpha').opacity, 0.4)
  } finally {
    await second.dispose()
  }
})

test('a later model set-view overrides the persisted user camera and stays final after replay', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('final-state-model-overrides')
    const addCall = rig.call(session, 'c1', 'map_add_layer', {})
    rig.result(session, addCall, { meta: addLayerMeta(addCall.seq, 0) })
    appendUserChange(session, 'camera-2', '用户调整了地图视图', {
      operationId: 'camera-2',
      targetRevision: 1,
      change: { op: 'set-view', view: { center: [121.47, 31.23], zoom: 12, wkid: 4326 } },
    })
    const modelView = { center: [117, 40], zoom: 10, wkid: 4326 }
    const viewCall = rig.call(session, 'c2', 'map_set_view', {})
    rig.result(session, viewCall, {
      meta: buildMapChangeMeta(viewCall.seq, rig.state(session).revision, { op: 'set-view', view: modelView }),
    })

    const live = rig.state(session)
    assert.deepEqual(live.view, modelView)
    const restored = rig.ctx.sessionProjections.restore({}, session.snapshotEvents(), 0, session.header, session.inheritedEventCount)
    assert.deepEqual(restored.snapshot.values.mapContainer.view, modelView)
  } finally {
    await rig.dispose()
  }
})
