/**
 * User map change fixtures: record parsing and bounds, admission against the
 * accepted state, the notice text round-trip, the fold applying a notice at
 * its inbox insertion exactly once per operation id, and the host route's
 * refusals and inbox delivery.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildMapChangeMeta, initialMapProjectionState } from '../src/protocol.ts'
import { mapContainerProjectionDefinition, resolvePresetSymbol } from '../src/projection.ts'
import {
  MAP_USER_CHANGE_MARKER_V8,
  MAP_USER_CHANGE_SOURCE,
  admitUserChange,
  parseUserChangeRecord,
  userChangeNoticeText,
  userChangeOfNoticeText,
} from '../src/user-change.ts'
import { serveChangeRequest } from '../src/change-route.ts'
import { SYMBOL_PRESETS } from '../../layers/src/index.ts'
import { symbolVersionOf } from '../../layers/src/contract.ts'
import { createMapSourceCatalog } from '../src/sources.ts'
import { waybackDescriptor } from '../src/wayback.ts'

const selectedBasemap = createMapSourceCatalog(undefined, 'allow', {})
  .selection('esri-world-imagery', 'esri-world-boundaries-places').value

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
  const symbol = { ...SYMBOL_PRESETS[0].symbol, point: { ...SYMBOL_PRESETS[0].symbol.point, color: '#123abc' } }
  const styled = { ...symbol, symbolVersion: symbolVersionOf(symbol) }
  assert.ok(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'set-symbol-style', layerId: 'a', symbol: styled } }))
  assert.equal(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'set-symbol-style', layerId: 'a', symbol: { ...styled, point: { ...styled.point, color: 'red' } } } }), undefined)
  assert.equal(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'set-symbol-style', layerId: 'a', symbol: { ...styled, symbolVersion: 'stale' } } }), undefined)
  assert.ok(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'remove-layer', layerId: 'a' } }))
  assert.equal(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'add-layer', layer: {} } }), undefined)
  assert.equal(parseUserChangeRecord({ operationId: 'bad id!', targetRevision: 0, change: { op: 'remove-layer', layerId: 'a' } }), undefined)
  assert.equal(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'set-layer-state', states: [{ layerId: 'a', opacity: 2 }] } }), undefined)
  assert.equal(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'remove-layer', layerId: 'a' }, extra: 1 }), undefined)
  assert.ok(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'set-basemap', selection: selectedBasemap } }))
  assert.equal(parseUserChangeRecord({ operationId: 'u1', targetRevision: 0, change: { op: 'set-basemap', selection: null } }), undefined)
  assert.ok(parseUserChangeRecord({
    operationId: 'a1', targetRevision: 0, sessionId: 's1', at: '2026-11-04T00:00:00Z', featureId: 'ann-0123456789abcdef01234567',
    change: { op: 'annotation-create', geometry: { type: 'Point', coordinates: [1, 2] }, name: 'Site' },
  }))
  assert.equal(parseUserChangeRecord({
    operationId: 'a1', targetRevision: 0,
    change: { op: 'annotation-create', geometry: { type: 'Point', coordinates: [181, 2] }, name: 'Site' },
  }), undefined)
})

test('a complete single-symbol color write lowers without replacing its sibling fields', () => {
  const original = SYMBOL_PRESETS[0].symbol
  const draft = { ...original, point: { ...original.point, color: '#123abc' } }
  const symbol = { ...draft, symbolVersion: symbolVersionOf(draft) }
  const result = admitUserChange(baseState(), { operationId: 'color', targetRevision: 2, change: { op: 'set-symbol-style', layerId: 'a', symbol } }, resolvePresetSymbol)
  assert.deepEqual(result, { ok: true, change: { op: 'set-symbol-style', entries: [{ layerId: 'a', symbol }] } })
  assert.equal(result.ok && result.change.op === 'set-symbol-style' ? result.change.entries[0].symbol.point.sizePx : 0, original.point.sizePx)
  assert.equal(result.ok && result.change.op === 'set-symbol-style' ? result.change.entries[0].symbol.point.outlineColor : '', original.point.outlineColor)
  assert.deepEqual(admitUserChange(baseState(), { operationId: 'color', targetRevision: 1, change: { op: 'set-symbol-style', layerId: 'a', symbol } }, resolvePresetSymbol), { ok: false, code: 'stale-revision' })
})

test('admission refuses stale revisions, unknown layers, unknown presets, and partial reorders', () => {
  const state = baseState()
  const record = change => ({ operationId: 'u1', targetRevision: 2, change })
  assert.deepEqual(admitUserChange(state, { ...record({ op: 'remove-layer', layerId: 'a' }), targetRevision: 1 }, resolvePresetSymbol), { ok: false, code: 'stale-revision' })
  assert.deepEqual(admitUserChange(state, record({ op: 'remove-layer', layerId: 'zz' }), resolvePresetSymbol), { ok: false, code: 'layer-unknown' })
  assert.deepEqual(admitUserChange(state, record({ op: 'set-symbol-preset', layerId: 'a', preset: 'nope' }), resolvePresetSymbol), { ok: false, code: 'preset-unknown' })
  assert.deepEqual(admitUserChange(state, record({ op: 'reorder-layers', layerIds: ['a'] }), resolvePresetSymbol), { ok: false, code: 'layer-unknown' })
  assert.equal(admitUserChange(state, record({ op: 'reorder-layers', layerIds: ['b', 'a'] }), resolvePresetSymbol).ok, true)
  assert.equal(admitUserChange(state, record({ op: 'set-basemap', selection: selectedBasemap }), resolvePresetSymbol).ok, true)
  assert.deepEqual(
    admitUserChange(state, record({ op: 'set-view', view: { center: [116.4, 39.9], zoom: 10, wkid: 4326 } }), resolvePresetSymbol),
    { ok: true, change: { op: 'set-view', view: { center: [116.4, 39.9], zoom: 10, wkid: 4326 } } },
  )
  assert.equal(admitUserChange(state, record({ op: 'set-view', view: { center: [200, 39.9], zoom: 10, wkid: 4326 } }), resolvePresetSymbol).ok, false)
})

test('the notice text round-trips its record and stays model-readable', () => {
  const record = { operationId: 'u7', targetRevision: 3, change: { op: 'set-layer-state', states: [{ layerId: 'a', visible: false }] } }
  const text = userChangeNoticeText('隐藏图层 A', record)
  assert.ok(text.startsWith('隐藏图层 A\n'))
  assert.deepEqual(userChangeOfNoticeText(text), record)
  assert.equal(userChangeOfNoticeText('plain prose'), undefined)
})

test('a settled camera view record round-trips through the v8 view marker', () => {
  const record = {
    operationId: 'view-1',
    targetRevision: 2,
    change: { op: 'set-view', view: { center: [116.4, 39.9], zoom: 11.5, wkid: 4326, rotation: 15 } },
  }
  assert.ok(parseUserChangeRecord(record))
  const text = userChangeNoticeText('用户调整了地图视图', record)
  assert.ok(text.includes(`\n${MAP_USER_CHANGE_MARKER_V8}\n`))
  assert.deepEqual(userChangeOfNoticeText(text), record)
  assert.equal(parseUserChangeRecord({ ...record, change: { op: 'set-view', view: { ...record.change.view, center: ['116.4', 39.9] } } }), undefined)
})

test('a set-view user change folds the final camera once and ignores its later claim', () => {
  const def = mapContainerProjectionDefinition
  const record = {
    operationId: 'view-2',
    targetRevision: 2,
    change: { op: 'set-view', view: { center: [116.4, 39.9], zoom: 12, wkid: 4326, scale: 30_000, rotation: 0 } },
  }
  const message = notice(record)
  const inserted = def.apply(baseState(), splice(10, message))
  assert.equal(inserted.revision, 3)
  assert.deepEqual(inserted.view, record.change.view)
  const claimed = def.apply(inserted, { type: 'user/message', seq: 14, time: 0, data: message })
  assert.equal(claimed, inserted, 'the claimed message replays as the same operation')
})

test('a stale set-view user change records a diagnostic and keeps the view', () => {
  const def = mapContainerProjectionDefinition
  const base = baseState()
  const stale = def.apply(base, splice(10, notice({
    operationId: 'view-3',
    targetRevision: 1,
    change: { op: 'set-view', view: { center: [121.5, 31.2], zoom: 9, wkid: 4326 } },
  })))
  assert.deepEqual(stale.view, base.view)
  assert.equal(stale.diagnostics.at(-1).code, 'stale-revision')
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

test('a public-selection user notice carries and folds the full public selection', () => {
  const def = mapContainerProjectionDefinition
  const record = { operationId: 'b1', targetRevision: 2, change: { op: 'set-basemap', selection: selectedBasemap } }
  const text = userChangeNoticeText('切换底图', record)
  assert.match(text, /\[map-user-change v2\]/)
  assert.deepEqual(userChangeOfNoticeText(text), record)
  const state = def.apply(baseState(), splice(20, notice(record, '切换底图')))
  assert.equal(state.revision, 3)
  assert.deepEqual(state.basemap, selectedBasemap)
  assert.equal(state.operations.at(-1).post.basemapDigest, JSON.stringify(selectedBasemap))

  const v1 = { operationId: 'old', targetRevision: 2, change: { op: 'remove-layer', layerId: 'a' } }
  const v1Text = `old\n[map-user-change v1]\n${JSON.stringify(v1)}`
  assert.deepEqual(userChangeOfNoticeText(v1Text), v1)
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
    host: {
      agentOf: async id => (id === 's1' ? agent : undefined),
      stateOf: () => state,
      admitBasemap: undefined,
    },
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

test('the route verifies a basemap write through the host source owner before injecting', async () => {
  const rig = routeHost(baseState())
  const calls = []
  rig.host.admitBasemap = async (state, selection) => {
    calls.push({ revision: state.revision, selection })
    return JSON.stringify(selection) === JSON.stringify(selectedBasemap) ? undefined : 'SOURCE_CHANGED'
  }
  const body = {
    sessionId: 's1',
    summary: '切换底图',
    record: { operationId: 'b1', targetRevision: 2, change: { op: 'set-basemap', selection: selectedBasemap } },
  }
  const accepted = await serveChangeRequest(post(body), rig.host)
  assert.equal(accepted.status, 200)
  assert.deepEqual(calls, [{ revision: 2, selection: selectedBasemap }])
  assert.deepEqual(rig.state().basemap, selectedBasemap)

  const drifted = { ...selectedBasemap, basemap: { ...selectedBasemap.basemap, title: 'forged' } }
  const refused = await serveChangeRequest(post({ ...body, record: { ...body.record, operationId: 'b2', change: { op: 'set-basemap', selection: drifted } } }), rig.host)
  assert.equal(refused.status, 409)
  assert.deepEqual(await refused.json(), { ok: false, code: 'SOURCE_CHANGED' })
  assert.equal(rig.injected.length, 1)
})

test('a user imagery blend is admitted, logged, and undone as one complete display state', async () => {
  const initial = initialMapProjectionState()
  const rig = routeHost(initial)
  const source = waybackDescriptor({
    releaseId: 10, itemId: '903f0abe9c3b452dafe1ca5b8dd858b9', title: 'World Imagery (Wayback 2014-02-20)',
    publishedAt: '2014-02-20', layerIdentifier: 'WB_2014_R01', acquiredAt: null,
  })
  rig.host.admitEarlyImagery = async (_state, candidate) => {
    assert.deepEqual(candidate, source)
    return undefined
  }
  const display = { ...initial.imageryDisplay, earlySource: source, earlyVisible: true, recentOpacity: 0.5 }
  const record = { operationId: 'imagery-1', targetRevision: 0, change: { op: 'set-imagery-display', display } }
  const response = await serveChangeRequest(post({ sessionId: 's1', summary: 'Show early imagery', record }), rig.host)
  assert.equal(response.status, 200)
  assert.deepEqual(userChangeOfNoticeText(rig.injected[0].content[0].text), record)
  assert.deepEqual(rig.state().imageryDisplay, display)
  const inverse = rig.state().operations.at(-1).inverse
  assert.deepEqual(inverse, { op: 'set-imagery-display', display: initial.imageryDisplay })
  const call = { type: 'tool/call', seq: 100, data: { turn: 1, step: 1, callId: 'undo', name: 'map_undo', arguments: '{}' } }
  const withCall = mapContainerProjectionDefinition.apply(rig.state(), call)
  const undone = mapContainerProjectionDefinition.apply(withCall, {
    type: 'tool/result', seq: 101,
    data: { turn: 1, step: 1, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'undo', content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: 'undo' } }, meta: buildMapChangeMeta(100, 1, inverse, { undoOf: 1 }) },
    sourceEventSeqs: [100],
  })
  assert.deepEqual(undone.imageryDisplay, initial.imageryDisplay)
  assert.equal(undone.revision, 2)
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
