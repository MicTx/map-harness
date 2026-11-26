import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAP_META_SCHEMA_VERSION,
  MAP_PROJECTION_STATE_VERSION,
  buildMapChangeMeta,
  decodeMapChangeMeta,
  initialMapProjectionState,
  mapProjectionStateSchema,
  validateMapChangeCandidate,
} from '../src/protocol.ts'
import { mapContainerProjectionDefinition } from '../src/projection.ts'
import { createMapSourceCatalog } from '../src/sources.ts'

const catalog = createMapSourceCatalog(undefined, 'allow', {})
const imagery = catalog.selection('esri-world-imagery').value
const labelsResult = catalog.selection('esri-world-imagery', 'esri-world-boundaries-places')
assert.equal(labelsResult.ok, true)
const imageryWithLabels = labelsResult.value

const callEvent = (seq, callId, name) => ({
  type: 'tool/call',
  seq,
  data: { turn: 1, step: 1, callId, name, arguments: '{}' },
})

const resultEvent = (seq, callId, meta, citedSeq = seq - 1) => ({
  type: 'tool/result',
  seq,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] }],
      source: { kind: 'tool', callId },
    },
    meta,
  },
  sourceEventSeqs: [citedSeq],
})

function settle(state, callSeq, callId, change, identity = {}, targetRevision = state.revision) {
  const name = identity.undoOf === undefined && change.op === 'set-basemap' ? 'map_set_basemap' : 'map_undo'
  const withCall = mapContainerProjectionDefinition.apply(state, callEvent(callSeq, callId, name))
  return mapContainerProjectionDefinition.apply(withCall, resultEvent(callSeq + 1, callId,
    buildMapChangeMeta(callSeq, targetRevision, change, identity), callSeq))
}

test('state v14 keeps legacy null explicit and rejects old cache rows', () => {
  const state = initialMapProjectionState()
  assert.equal(MAP_PROJECTION_STATE_VERSION, 21)
  assert.equal(MAP_META_SCHEMA_VERSION, 8)
  assert.equal(state.basemap, null)
  assert.equal(mapProjectionStateSchema.safeParse(state).success, true)
  assert.equal(mapProjectionStateSchema.safeParse({ ...state, stateVersion: 10 }).success, false)
})

test('set-basemap folds one CAS revision, preserves the document, and exposes wire state', () => {
  const initial = initialMapProjectionState()
  assert.equal(validateMapChangeCandidate(initial, { op: 'set-basemap', selection: imageryWithLabels }), 0)
  const applied = settle(initial, 0, 'set-1', { op: 'set-basemap', selection: imageryWithLabels })
  assert.deepEqual(applied.basemap, imageryWithLabels)
  assert.deepEqual(applied.view, initial.view)
  assert.deepEqual(applied.layers, [])
  assert.equal(applied.revision, 1)
  assert.equal(applied.operations.length, 1)
  assert.equal(applied.operations[0].post.basemapDigest, JSON.stringify(imageryWithLabels))
  assert.deepEqual(applied.operations[0].inverse, { op: 'set-basemap', selection: null })
  const wire = mapContainerProjectionDefinition.wire.view(applied)
  assert.deepEqual(wire.basemap, imageryWithLabels)
})

test('set-basemap meta v6 is paired while v1-v5 records stay readable and refuse the new word', () => {
  const meta = buildMapChangeMeta(0, 0, { op: 'set-basemap', selection: imagery })
  assert.equal(meta.schemaVersion, 8)
  assert.equal(decodeMapChangeMeta({ ...meta, schemaVersion: 6 }).status, 'ok')
  assert.equal(decodeMapChangeMeta(meta).status, 'ok')
  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    assert.equal(decodeMapChangeMeta({ ...meta, schemaVersion }).status, 'refused')
  }
  assert.equal(decodeMapChangeMeta({
    schemaVersion: 5,
    kind: 'map-change',
    sourceCallSeq: 0,
    targetRevision: 0,
    change: { op: 'set-mode', mode: 'scene' },
  }).status, 'ok')
  const withCall = mapContainerProjectionDefinition.apply(
    initialMapProjectionState(),
    callEvent(0, 'wrong-tool', 'map_set_mode'),
  )
  const mismatched = mapContainerProjectionDefinition.apply(withCall, resultEvent(1, 'wrong-tool', meta))
  assert.equal(mismatched.revision, 0)
  assert.deepEqual(mismatched.diagnostics, [{ seq: 1, code: 'call-pairing' }])
})

test('stale CAS and incompatible selections leave both sources unchanged', () => {
  const stale = { ...initialMapProjectionState(), revision: 7 }
  const applied = settle(stale, 0, 'stale', { op: 'set-basemap', selection: imageryWithLabels }, {}, 6)
  assert.equal(applied.revision, 7)
  assert.equal(applied.basemap, null)
  assert.deepEqual(applied.diagnostics, [{ seq: 1, code: 'stale-revision' }])

  const wrongRole = { ...imageryWithLabels, basemap: imageryWithLabels.labels }
  assert.equal(mapProjectionStateSchema.safeParse({ ...initialMapProjectionState(), basemap: wrongRole }).success, false)
})

test('undo restores the prior selection and concurrent source writes block the old target', () => {
  const initial = initialMapProjectionState()
  const first = settle(initial, 0, 'set-1', { op: 'set-basemap', selection: imagery })
  const undone = settle(first, 2, 'undo-1', first.operations[0].inverse, { undoOf: 1 })
  assert.equal(undone.basemap, null)
  assert.equal(undone.revision, 2)
  assert.equal(undone.operations[1].undoOf, 1)

  const concurrent = settle(first, 2, 'set-2', { op: 'set-basemap', selection: imageryWithLabels })
  assert.equal(concurrent.basemap.basemap.id, 'esri-world-imagery')
  assert.deepEqual(concurrent.basemap.labels, imageryWithLabels.labels)
  const blocked = settle(concurrent, 4, 'undo-1', first.operations[0].inverse, { undoOf: 1 })
  assert.equal(blocked.revision, 2)
  assert.deepEqual(blocked.basemap, imageryWithLabels)
  assert.deepEqual(blocked.diagnostics, [{ seq: 5, code: 'call-pairing' }])
})
