/**
 * User map change fixtures: record parsing and bounds, admission against the
 * accepted state, the notice text round-trip, the fold applying a notice at
 * its inbox insertion exactly once per operation id, and the host route's
 * refusals and inbox delivery.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialMapProjectionState } from '../src/protocol.ts'
import { mapContainerProjectionDefinition, resolvePresetSymbol } from '../src/projection.ts'
import {
  MAP_USER_CHANGE_SOURCE,
  admitUserChange,
  parseUserChangeRecord,
  userChangeNoticeText,
  userChangeOfNoticeText,
} from '../src/user-change.ts'
import { serveChangeRequest } from '../src/change-route.ts'
import { SYMBOL_PRESETS } from '../../layers/src/index.ts'

const collection = id => ({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', id: `${id}-1`, geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: {} }],
})

/** A state holding layers `a` and `b` at revision 2. */
function baseState() {
  const layer = id => ({ id, name: id.toUpperCase(), data: collection(id), sourceCrs: 'EPSG:4326', opacity: 1, visible: true, sourceCallSeq: 1 })
  return { ...initialMapProjectionState(), layers: [layer('a'), layer('b')], revision: 2 }
}

const notice = (record, summary = '隐藏图层 A') => ({
  id: `m-${record.operationId}`,
  role: 'user',
  content: [{ type: 'text', text: userChangeNoticeText(summary, record) }],
  source: { kind: MAP_USER_CHANGE_SOURCE, form: 'notice', summary },
})

const splice = (seq, message) => ({ type: 'agent/inbox/spliced', seq, time: 0, data: { target: 'next-step', start: 0, inserted: [message] } })

test('records parse only the panel vocabulary within bounds', () => {
  assert.ok(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'remove-layer', layerId: 'a' } }))
  assert.equal(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'add-layer', layer: {} } }), undefined)
  assert.equal(parseUserChangeRecord({ operationId: 'bad id!', targetRevision: 0, change: { op: 'remove-layer', layerId: 'a' } }), undefined)
  assert.equal(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'set-layer-state', states: [{ layerId: 'a', opacity: 2 }] } }), undefined)
  assert.equal(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'remove-layer', layerId: 'a' }, extra: 1 }), undefined)
})

test('admission refuses stale revisions, unknown layers, unknown presets, and partial reorders', () => {
  const state = baseState()
  const record = change => ({ operationId: 'u1', targetRevision: 2, change })
  assert.deepEqual(admitUserChange(state, { ...record({ op: 'remove-layer', layerId: 'a' }), targetRevision: 1 }, resolvePresetSymbol), { ok: false, code: 'stale-revision' })
  assert.deepEqual(admitUserChange(state, record({ op: 'remove-layer', layerId: 'zz' }), resolvePresetSymbol), { ok: false, code: 'layer-unknown' })
  assert.deepEqual(admitUserChange(state, record({ op: 'set-symbol-preset', layerId: 'a', preset: 'nope' }), resolvePresetSymbol), { ok: false, code: 'preset-unknown' })
  assert.deepEqual(admitUserChange(state, record({ op: 'reorder-layers', layerIds: ['a'] }), resolvePresetSymbol), { ok: false, code: 'layer-unknown' })
  assert.equal(admitUserChange(state, record({ op: 'reorder-layers', layerIds: ['b', 'a'] }), resolvePresetSymbol).ok, true)
})

test('the notice text round-trips its record and stays model-readable', () => {
  const record = { operationId: 'u7', targetRevision: 3, change: { op: 'set-layer-state', states: [{ layerId: 'a', visible: false }] } }
  const text = userChangeNoticeText('隐藏图层 A', record)
  assert.ok(text.startsWith('隐藏图层 A\n'))
  assert.deepEqual(userChangeOfNoticeText(text), record)
  assert.equal(userChangeOfNoticeText('plain prose'), undefined)
})

test('the fold applies a notice at inbox insertion and ignores its later claim', () => {
  const def = mapContainerProjectionDefinition
  const record = { operationId: 'u1', targetRevision: 2, change: { op: 'set-layer-state', states: [{ layerId: 'a', visible: false, opacity: 0.4 }] } }
  const message = notice(record)
  const inserted = def.apply(baseState(), splice(10, message))
  assert.equal(inserted.revision, 3)
  assert.equal(inserted.layers.find(layer => layer.id === 'a').visible, false)
  assert.equal(inserted.layers.find(layer => layer.id === 'a').opacity, 0.4)
  const op = inserted.operations.at(-1)
  assert.equal(op.writerId, 'user')
  assert.ok(op.inverse, 'a user change keeps its undo inverse')
  const claimed = def.apply(inserted, { type: 'user/message', seq: 14, time: 0, data: message })
  assert.equal(claimed, inserted, 'the claimed message replays as the same operation')
})

test('the fold reorders, restyles by preset, and removes', () => {
  const def = mapContainerProjectionDefinition
  const preset = SYMBOL_PRESETS[0].id
  let state = def.apply(baseState(), splice(10, notice({ operationId: 'r1', targetRevision: 2, change: { op: 'reorder-layers', layerIds: ['b', 'a'] } })))
  assert.deepEqual(state.layers.map(layer => layer.id), ['b', 'a'])
  state = def.apply(state, splice(11, notice({ operationId: 's1', targetRevision: 3, change: { op: 'set-symbol-preset', layerId: 'a', preset } })))
  assert.equal(state.layers.find(layer => layer.id === 'a').symbol.symbolVersion, resolvePresetSymbol(preset).symbolVersion)
  state = def.apply(state, splice(12, notice({ operationId: 'd1', targetRevision: 4, change: { op: 'remove-layer', layerId: 'b' } })))
  assert.deepEqual(state.layers.map(layer => layer.id), ['a'])
})

test('a stale notice records a diagnostic and leaves the map unchanged', () => {
  const def = mapContainerProjectionDefinition
  const base = baseState()
  const stale = def.apply(base, splice(10, notice({ operationId: 'u9', targetRevision: 1, change: { op: 'remove-layer', layerId: 'a' } })))
  assert.deepEqual(stale.layers, base.layers)
  assert.equal(stale.diagnostics.at(-1).code, 'stale-revision')
})

test('notices from other sources and plain inbox messages never fold', () => {
  const def = mapContainerProjectionDefinition
  const base = baseState()
  const record = { operationId: 'u1', targetRevision: 2, change: { op: 'remove-layer', layerId: 'a' } }
  const forged = { ...notice(record), source: { kind: 'user' } }
  assert.equal(def.apply(base, splice(10, forged)), base, 'a user-typed copy of the marker is not a user change')
})

/** A route host over one in-memory state whose inject folds like the real inbox. */
function routeHost(initial) {
  let state = initial
  let seq = 20
  const injected = []
  const agent = {
    session: {},
    inject(message) {
      injected.push(message)
      state = mapContainerProjectionDefinition.apply(state, splice(seq++, message))
    },
  }
  return {
    injected,
    state: () => state,
    host: { agentOf: async id => (id === 's1' ? agent : undefined), stateOf: () => state },
  }
}

const post = body => new Request('http://host/api/map/change', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })

test('the route applies one admitted change before it responds', async () => {
  const rig = routeHost(baseState())
  const response = await serveChangeRequest(post({ sessionId: 's1', summary: '隐藏图层 A', record: { operationId: 'u1', targetRevision: 2, change: { op: 'set-layer-state', states: [{ layerId: 'a', visible: false }] } } }), rig.host)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, revision: 3 })
  assert.equal(rig.injected.length, 1)
  assert.equal(rig.injected[0].source.kind, MAP_USER_CHANGE_SOURCE)
  assert.ok(rig.injected[0].content[0].text.startsWith('隐藏图层 A\n'))
  assert.equal(rig.state().layers[0].visible, false)
})

test('the route refuses malformed, unknown-session, stale, and multi-line summary requests without injecting', async () => {
  const rig = routeHost(baseState())
  const record = { operationId: 'u1', targetRevision: 2, change: { op: 'remove-layer', layerId: 'a' } }
  const cases = [
    [post('not json'), 400, 'invalid-change'],
    [post({ sessionId: 'nope', summary: 'x', record }), 404, 'unknown-session'],
    [post({ sessionId: 'bad id', summary: 'x', record }), 404, 'unknown-session'],
    [post({ sessionId: 's1', summary: 'x', record: { ...record, targetRevision: 0 } }), 409, 'stale-revision'],
    [post({ sessionId: 's1', summary: 'a\nb', record }), 400, 'invalid-change'],
    [post({ sessionId: 's1', summary: 'x', record: { ...record, change: { op: 'set-view' } } }), 400, 'invalid-change'],
    [post({ sessionId: 's1', summary: 'x', record: { ...record, change: { op: 'remove-layer', layerId: 'zz' } } }), 400, 'layer-unknown'],
  ]
  for (const [request, status, code] of cases) {
    const response = await serveChangeRequest(request, rig.host)
    assert.equal(response.status, status, code)
    assert.deepEqual(await response.json(), { ok: false, code })
  }
  assert.equal(rig.injected.length, 0)
})
