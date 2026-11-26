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
import { waybackDescriptor } from '../src/wayback.ts'

const earlySource = waybackDescriptor({
  releaseId: 10,
  itemId: '903f0abe9c3b452dafe1ca5b8dd858b9',
  title: 'World Imagery (Wayback 2014-02-20)',
  publishedAt: '2014-02-20',
  layerIdentifier: 'WB_2014_R01',
  acquiredAt: null,
})

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
  const name = identity.undoOf === undefined && change.op === 'set-imagery-display' ? 'map_set_imagery' : 'map_undo'
  const withCall = mapContainerProjectionDefinition.apply(state, callEvent(callSeq, callId, name))
  return mapContainerProjectionDefinition.apply(
    withCall,
    resultEvent(callSeq + 1, callId, buildMapChangeMeta(callSeq, targetRevision, change, identity), callSeq),
  )
}

const display = overrides => ({
  labelsVisible: true,
  recentVisible: true,
  recentOpacity: 1,
  earlyVisible: false,
  earlySource: null,
  ...overrides,
})

test('fresh map state defaults to labels and recent imagery with early imagery hidden', () => {
  const state = initialMapProjectionState()
  assert.equal(MAP_PROJECTION_STATE_VERSION, 21)
  assert.equal(MAP_META_SCHEMA_VERSION, 8)
  assert.deepEqual(state.imageryDisplay, display())
  assert.equal(mapProjectionStateSchema.safeParse(state).success, true)
})

test('set-imagery-display is CAS-bound, reversible, and exposed on the wire', () => {
  const initial = initialMapProjectionState()
  const next = display({
    labelsVisible: false,
    recentOpacity: 0.35,
    earlyVisible: true,
    earlySource,
  })
  assert.equal(validateMapChangeCandidate(initial, { op: 'set-imagery-display', display: next }), 0)
  const applied = settle(initial, 0, 'imagery-1', { op: 'set-imagery-display', display: next })
  assert.deepEqual(applied.imageryDisplay, next)
  assert.equal(applied.revision, 1)
  assert.deepEqual(applied.operations[0].inverse, {
    op: 'set-imagery-display',
    display: display(),
  })
  assert.deepEqual(mapContainerProjectionDefinition.wire.view(applied).imageryDisplay, next)

  const undone = settle(applied, 2, 'undo-1', applied.operations[0].inverse, { undoOf: 1 })
  assert.deepEqual(undone.imageryDisplay, display())
  assert.equal(undone.revision, 2)
})

test('imagery display rejects invalid opacity and visible early imagery without a fixed release', () => {
  const initial = initialMapProjectionState()
  assert.throws(
    () => validateMapChangeCandidate(initial, { op: 'set-imagery-display', display: display({ recentOpacity: 1.1 }) }),
    /recent imagery opacity/,
  )
  assert.throws(
    () => validateMapChangeCandidate(initial, { op: 'set-imagery-display', display: display({ earlyVisible: true }) }),
    /visible early imagery/,
  )
})

test('meta v8 owns set-imagery-display while v7 and older records remain decodable', () => {
  const current = buildMapChangeMeta(0, 0, { op: 'set-imagery-display', display: display() })
  assert.equal(current.schemaVersion, 8)
  assert.equal(decodeMapChangeMeta(current).status, 'ok')
  assert.equal(decodeMapChangeMeta({ ...current, schemaVersion: 7 }).status, 'refused')

  const old = buildMapChangeMeta(0, 0, { op: 'set-mode', mode: 'scene' })
  for (const schemaVersion of [1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(decodeMapChangeMeta({ ...old, schemaVersion }).status, 'ok')
  }
})

test('a stale imagery display write leaves the accepted state unchanged', () => {
  const stale = { ...initialMapProjectionState(), revision: 7 }
  const applied = settle(
    stale,
    0,
    'stale-imagery',
    { op: 'set-imagery-display', display: display({ recentOpacity: 0.5 }) },
    {},
    6,
  )
  assert.equal(applied.revision, 7)
  assert.deepEqual(applied.imageryDisplay, display())
  assert.deepEqual(applied.diagnostics, [{ seq: 1, code: 'stale-revision' }])
})
