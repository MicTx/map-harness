import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAP_PROJECTION_STATE_VERSION,
  USER_ANNOTATION_LAYER_ID,
  initialMapProjectionState,
  mapProjectionStateSchema,
  settleAgentAnnotation,
  validateAnnotationGeometry,
  validateMapChangeCandidate,
} from '../src/protocol.ts'
import { mapContainerProjectionDefinition, resolvePresetSymbol } from '../src/projection.ts'
import { mapRig } from './map-rig.mjs'
import { admitUserChange, parseUserChangeRecord, userChangeNoticeText, userChangeOfNoticeText } from '../src/user-change.ts'
import { serveChangeRequest } from '../src/change-route.ts'
import { SYMBOL_PRESETS } from '../../layers/src/index.ts'

const at = '2026-11-04T00:00:00.000Z'
const laterAt = '2026-11-04T00:01:00.000Z'
const featureId = 'ann-0123456789abcdef01234567'
const preset = SYMBOL_PRESETS[0]

function ordinaryLayer(id = 'business') {
  return {
    id,
    name: id,
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    sourceCallSeq: 1,
    data: {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', id: `${id}-1`, geometry: { type: 'Point', coordinates: [116, 39] }, properties: { name: id } }],
    },
  }
}

function baseState() {
  return { ...initialMapProjectionState(), layers: [ordinaryLayer()], revision: 2 }
}

const notice = (record, summary = '标注地图') => ({
  id: `m-${record.operationId}`,
  role: 'user',
  content: [{ type: 'text', text: userChangeNoticeText(summary, record) }],
  source: { kind: 'map-user-change', form: 'notice', summary },
})

const splice = (seq, message) => ({ type: 'agent/inbox/spliced', seq, time: 0, data: { target: 'next-step', start: 0, inserted: [message] } })
const apply = (state, record, seq = 10) => mapContainerProjectionDefinition.apply(state, splice(seq, notice(record)))

function createRecord(operationId = 'create-1', name = 'Site') {
  return {
    operationId,
    targetRevision: 2,
    sessionId: 'session-1',
    at,
    featureId,
    change: { op: 'annotation-create', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, name },
  }
}

function insertAnnotation(session, revision, overrides = {}) {
  const record = { ...createRecord(), targetRevision: revision, sessionId: session.id, ...overrides }
  return session.append('agent/inbox/spliced', {
    target: 'next-step',
    start: 0,
    inserted: [notice(record)],
  })
}

test('annotation state creates a protected layer with a stable host identity', () => {
  const state = apply(baseState(), createRecord())
  assert.equal(MAP_PROJECTION_STATE_VERSION, 21)
  assert.equal(state.revision, 3)
  assert.equal(state.layers.length, 2)
  assert.equal(state.layers[0].id, USER_ANNOTATION_LAYER_ID)
  assert.equal(state.layers[0].role, 'user-annotation')
  assert.equal(state.layers[0].data.features[0].id, featureId)
  assert.deepEqual(state.layers[0].data.features[0].properties, {
    name: 'Site',
    dshRole: 'user-annotation',
    dshAuthor: 'user',
    dshSource: 'manual',
    dshCreateOperationId: 'create-1',
    dshUpdateOperationId: 'create-1',
    dshCreatedAt: at,
    dshUpdatedAt: at,
  })
  const operation = state.operations.at(-1)
  assert.equal(operation.writerId, 'user')
  assert.equal(operation.annotationInverse.layer, null)
  assert.equal(operation.post.annotationDigest, operation.post.annotationDigest)
  assert.match(operation.post.requestDigest, /^[0-9a-f]{8}$/u)
  assert.equal(mapProjectionStateSchema.safeParse(state).success, true)
})

test('annotation update changes one feature and preserves other state', () => {
  let state = apply(baseState(), createRecord())
  state = apply(state, {
    operationId: 'update-1',
    targetRevision: 3,
    sessionId: 'session-1',
    at,
    featureId,
    change: {
      op: 'annotation-update',
      featureId,
      expectedUpdatedAt: at,
      geometry: { type: 'Point', coordinates: [116.41, 39.91] },
      name: 'Moved site',
      description: '',
      symbol: preset.symbol,
    },
  }, 11)
  const layer = state.layers[0]
  assert.equal(layer.data.features.length, 1)
  assert.deepEqual(layer.data.features[0].geometry.coordinates, [116.41, 39.91])
  assert.equal(layer.data.features[0].properties.name, 'Moved site')
  assert.equal(layer.data.features[0].properties.description, '')
  assert.deepEqual(layer.overrides.entries[0].featureIds, [featureId])
  assert.equal(layer.overrides.entries[0].patch.color, preset.symbol.point.color)
  assert.equal(state.layers[1].id, 'business')
  assert.equal(state.layers[1].data.features[0].id, 'business-1')
  assert.equal(state.basemap, null)
})

test('creating another annotation retains existing layer and feature presentation', () => {
  let state = apply(baseState(), createRecord())
  state = apply(state, {
    operationId: 'style-first-feature', targetRevision: 3, sessionId: 'session-1', at: laterAt, featureId,
    change: { op: 'annotation-update', featureId, expectedUpdatedAt: at, symbol: preset.symbol },
  }, 11)
  state = settleAgentAnnotation(state, {
    kind: 'map-agent-annotation', schemaVersion: 1, sourceCallSeq: 12, targetRevision: 4,
    operationId: 'style-annotation-layer', sessionId: 'session-1', at: laterAt,
    change: { op: 'annotation-layer-style', symbol: preset.symbol },
  }, 'style-call', 13)
  assert.equal(state.revision, 5)
  const oldLayer = state.layers.find(layer => layer.id === USER_ANNOTATION_LAYER_ID)
  assert.ok(oldLayer.symbol)
  assert.equal(oldLayer.overrides.entries.length, 1)
  const newFeatureId = 'ann-0123456789abcdef01234568'
  state = apply(state, {
    operationId: 'create-2', targetRevision: 5, sessionId: 'session-1', at: laterAt, featureId: newFeatureId,
    change: { op: 'annotation-create', geometry: { type: 'Point', coordinates: [117, 40] }, name: 'Second site' },
  }, 14)
  assert.equal(state.revision, 6)
  const newLayer = state.layers.find(layer => layer.id === USER_ANNOTATION_LAYER_ID)
  assert.deepEqual(newLayer.symbol, oldLayer.symbol)
  assert.deepEqual(newLayer.overrides, oldLayer.overrides)
  assert.deepEqual(newLayer.data.features.map(feature => feature.id), [featureId, newFeatureId])
  const thirdFeatureId = 'ann-0123456789abcdef01234569'
  state = apply(state, {
    operationId: 'create-3', targetRevision: 6, sessionId: 'session-1', at: laterAt, featureId: thirdFeatureId,
    change: { op: 'annotation-create', geometry: { type: 'Point', coordinates: [118, 41] }, name: 'Third site', symbol: preset.symbol },
  }, 15)
  assert.equal(state.revision, 7)
  const styledLayer = state.layers.find(layer => layer.id === USER_ANNOTATION_LAYER_ID)
  assert.deepEqual(styledLayer.symbol, oldLayer.symbol)
  assert.deepEqual(styledLayer.overrides.entries.map(entry => entry.featureIds), [[featureId], [thirdFeatureId]])
})

test('a stale feature update refuses instead of overwriting a newer writer', () => {
  let state = apply(baseState(), createRecord())
  state = apply(state, {
    operationId: 'update-writer-1',
    targetRevision: 3,
    sessionId: 'session-1',
    at: laterAt,
    featureId,
    change: {
      op: 'annotation-update',
      featureId,
      expectedUpdatedAt: at,
      name: 'Newer writer',
    },
  }, 11)
  const stale = apply(state, {
    operationId: 'update-writer-2',
    targetRevision: 4,
    sessionId: 'session-1',
    at: laterAt,
    featureId,
    change: {
      op: 'annotation-update',
      featureId,
      expectedUpdatedAt: at,
      name: 'Stale writer',
    },
  }, 12)
  assert.equal(stale.revision, 4)
  assert.equal(stale.diagnostics.at(-1).code, 'stale-revision')
  assert.equal(stale.layers[0].data.features[0].properties.name, 'Newer writer')
})

test('delete removes an empty annotation layer and user undo restores its snapshot', () => {
  let state = apply(baseState(), createRecord())
  state = apply(state, {
    operationId: 'delete-1',
    targetRevision: 3,
    sessionId: 'session-1',
    at,
    featureId,
    change: { op: 'annotation-delete', featureIds: [featureId] },
  }, 11)
  assert.deepEqual(state.layers.map(layer => layer.id), ['business'])
  assert.equal(state.revision, 4)

  state = apply(state, {
    operationId: 'undo-delete-1',
    targetRevision: 4,
    sessionId: 'session-1',
    at,
    featureId,
    change: { op: 'annotation-undo', operationId: 'delete-1' },
  }, 12)
  assert.equal(state.layers[0].id, USER_ANNOTATION_LAYER_ID)
  assert.equal(state.layers[0].data.features[0].id, featureId)
  assert.equal(state.operations.at(-1).undoOf, 2)
  assert.equal(state.revision, 5)
})

test('operation ids replay idempotently while stale revisions refuse', () => {
  const created = apply(baseState(), createRecord())
  assert.equal(apply(created, createRecord()), created)
  const stale = apply(baseState(), { ...createRecord(), targetRevision: 1 })
  assert.equal(stale.revision, 2)
  assert.equal(stale.diagnostics.at(-1).code, 'stale-revision')
})

test('legacy v1 and v2 notices never carry annotation operations', () => {
  const legacyRecord = createRecord()
  for (const marker of ['[map-user-change v1]', '[map-user-change v2]']) {
    const text = `legacy annotation\n${marker}\n${JSON.stringify(legacyRecord)}`
    assert.equal(userChangeOfNoticeText(text), undefined)
    const message = {
      id: `legacy-${marker}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'map-user-change', form: 'notice', summary: 'legacy annotation' },
    }
    assert.equal(mapContainerProjectionDefinition.apply(baseState(), splice(11, message)).revision, 2)
  }
})

test('the wire keeps an annotation undo candidate beyond its twelve-summary history window', () => {
  let state = apply(baseState(), createRecord())
  for (let index = 0; index < 13; index += 1) {
    state = apply(state, {
      operationId: `ordinary-${index}`,
      targetRevision: state.revision,
      change: { op: 'set-layer-state', states: [{ layerId: 'business', visible: index % 2 === 0 }] },
    }, 20 + index)
  }
  const wire = mapContainerProjectionDefinition.wire.view(state)
  assert.equal(wire.operations.length, 12)
  assert.equal(wire.operations.some(op => op.operationId === 'create-1'), false)
  assert.equal(wire.undoableAnnotation.operationId, 'create-1')
})

test('checkpoint tail replay and full replay restore the same accepted annotation', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('annotation-recovery')
    insertAnnotation(session, 0)
    const registry = rig.ctx.sessionProjections
    const checkpoint = registry.checkpoint(session)
    const floor = registry.restoreFloor(checkpoint)
    const suffix = insertAnnotation(session, 1, {
      operationId: 'annotation-after-checkpoint',
      targetRevision: 1,
      sessionId: session.id,
      at: laterAt,
      featureId: 'ann-0123456789abcdef01234599',
      change: { op: 'annotation-create', geometry: { type: 'Point', coordinates: [117, 40] }, name: 'Tail site' },
    })
    const events = session.snapshotEvents()
    const tail = registry.restore(checkpoint, events.filter(event => event.seq >= floor), floor, session.header, session.inheritedEventCount)
    const full = registry.restore({}, events, 0, session.header, session.inheritedEventCount)
    assert.equal(tail.checkpoint.mapContainer.seq, suffix.seq)
    assert.deepEqual(tail.snapshot.values.mapContainer, full.snapshot.values.mapContainer)
    assert.deepEqual(full.snapshot.values.mapContainer.layers[0].data.features.map(feature => feature.id), [
      featureId,
      'ann-0123456789abcdef01234599',
    ])
  } finally {
    await rig.dispose()
  }
})

test('model and generic panel paths cannot edit the protected annotation layer', () => {
  const state = apply(baseState(), createRecord())
  const cases = [
    { op: 'remove-layer', layerId: USER_ANNOTATION_LAYER_ID },
    { op: 'add-layer', layer: { ...state.layers[0], data: state.layers[0].data, sourceCallSeq: 1 } },
    { op: 'set-layer-state', states: [{ layerId: USER_ANNOTATION_LAYER_ID, visible: false }] },
    { op: 'set-symbol-style', entries: [{ layerId: USER_ANNOTATION_LAYER_ID, symbol: null }] },
    { op: 'reorder-layers', layerIds: [USER_ANNOTATION_LAYER_ID, 'business'] },
  ]
  for (const change of cases) {
    let failure
    try {
      validateMapChangeCandidate(state, change)
    } catch (error) {
      failure = error
    }
    assert.equal(failure?.code, 'annotation-protected')
  }
  const admission = admitUserChange(state, {
    operationId: 'panel-delete',
    targetRevision: 3,
    change: { op: 'remove-layer', layerId: USER_ANNOTATION_LAYER_ID },
  }, resolvePresetSymbol)
  assert.deepEqual(admission, { ok: false, code: 'annotation-protected' })
})

test('ordinary reorders keep the annotation layer first', () => {
  const annotation = apply(baseState(), createRecord()).layers[0]
  const withTwo = { ...baseState(), revision: 3, layers: [annotation, ordinaryLayer('a'), ordinaryLayer('b')] }
  const change = { op: 'reorder-layers', layerIds: ['b', 'a'] }
  assert.equal(validateMapChangeCandidate(withTwo, change), withTwo.revision)
  const reordered = apply(withTwo, { operationId: 'reorder-ordinary', targetRevision: 3, change }, 20)
  assert.deepEqual(reordered.layers.map(layer => layer.id), [USER_ANNOTATION_LAYER_ID, 'b', 'a'])
})

test('annotation geometry rejects range, topology, and malformed shapes', () => {
  assert.equal(validateAnnotationGeometry({ type: 'Point', coordinates: [180, 0] }), 1)
  for (const geometry of [
    { type: 'Point', coordinates: [Number.NaN, 0] },
    { type: 'LineString', coordinates: [[0, 0], [0, 0]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [2, 0], [0, 1], [2, 1], [0, 0]]] },
  ]) {
    assert.throws(() => validateAnnotationGeometry(geometry), /annotation/)
  }
})

test('the host route derives annotation identity and answers retries idempotently', async () => {
  let state = initialMapProjectionState()
  let seq = 10
  const injected = []
  const agent = {
    session: {},
    inject(message) {
      injected.push(message)
      state = mapContainerProjectionDefinition.apply(state, splice(seq++, message))
    },
  }
  const host = { agentOf: async id => (id === 's1' ? agent : undefined), stateOf: () => state }
  const body = {
    sessionId: 's1',
    summary: '创建标记',
    record: { operationId: 'route-create', targetRevision: 0, change: { op: 'annotation-create', geometry: { type: 'Point', coordinates: [1, 2] }, name: 'Route' } },
  }
  const request = value => new Request('http://host/api/map/change', { method: 'POST', body: JSON.stringify(value) })
  const accepted = await serveChangeRequest(request(body), host)
  assert.equal(accepted.status, 200)
  assert.deepEqual(await accepted.json(), { ok: true, revision: 1 })
  assert.equal(injected.length, 1)
  const persisted = parseUserChangeRecord(JSON.parse(injected[0].content[0].text.split('\n').at(-1)))
  assert.equal(persisted.sessionId, 's1')
  assert.match(persisted.featureId, /^ann-[0-9a-f]{24}$/u)

  const retry = await serveChangeRequest(request(body), host)
  assert.equal(retry.status, 200)
  assert.deepEqual(await retry.json(), { ok: true, revision: 1, duplicate: true })
  assert.equal(injected.length, 1)

  const changed = await serveChangeRequest(request({ ...body, record: { ...body.record, change: { ...body.record.change, name: 'Different' } } }), host)
  assert.equal(changed.status, 400)
  assert.deepEqual(await changed.json(), { ok: false, code: 'invalid-change' })
  assert.equal(injected.length, 1)
})
