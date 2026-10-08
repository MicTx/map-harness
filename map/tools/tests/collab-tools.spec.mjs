/**
 * Collaboration tool fixtures over the REAL commit protocol: the rig mounts
 * the session store, projection registry, map-container plugin, and the
 * spatial-collab plugin, so every `map_apply_patch`/`map_undo` call runs the
 * product's serial commit path — handler-side engine checks, then the fold's
 * own CAS — against accepted `tool/call` + `tool/result` events.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '../../../packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../packages/session/session-projection/lib/index.js'
import { createToolResultMessage } from '../../../packages/llm/llm/lib/index.js'
import * as mapContainerPlugin from '../../map-container/src/plugin.ts'
import * as collabPlugin from '../../spatial-collab/src/plugin.ts'
import { MAP_META_SCHEMA_VERSION } from '../../map-container/src/protocol.ts'
import { layerPayload, pointCollection } from '../../map-container/tests/map-rig.mjs'
import { mapApplyPatch, mapUndo } from '../src/collab-tools.ts'
import { mapGetState, mapSetView } from '../src/map-tools.ts'

let rigCounter = 0

/** Boot one collab rig: session store + projections + container + writer lifecycle. */
async function collabRig() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(mapContainerPlugin)
  await ctx.plugin(collabPlugin)
  let turn = 0
  return {
    ctx,
    collab: ctx.get('spatialCollab'),
    session(id) {
      return ctx.sessions.create(SessionId(id ?? `collab-rig-${rigCounter += 1}`), {})
    },
    call(session, callId, name, args) {
      turn += 1
      return session.append('tool/call', { turn, step: 1, callId, name, arguments: JSON.stringify(args ?? {}) })
    },
    result(session, callEvent, { isError = false, meta, text = 'ok' } = {}) {
      return session.append('tool/result', {
        turn: callEvent.data.turn,
        step: callEvent.data.step,
        message: createToolResultMessage({
          callId: callEvent.data.callId,
          content: [{ type: 'text', text: isError ? `Error: ${text}` : text }],
          isError,
        }),
        ...meta === undefined ? {} : { meta },
      }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
    },
    state(session) {
      return ctx.sessionProjections.stateOf(session, 'mapContainer')
    },
    exec(session, { callId } = {}) {
      return {
        callId,
        rootCallId: callId,
        token: Symbol.for(`collab-rig-token-${callId ?? 'none'}`),
        name: 'collab_rig_dispatch',
        arguments: {},
        agent: { ctx, session },
        signal: new AbortController().signal,
      }
    },
    async dispose() {
      await ctx.fiber.dispose()
    },
  }
}

/** Run one map_apply_patch call through the rig: appends the call, executes, folds the meta. */
async function patchAndFold(rig, session, callId, args, { fold = true } = {}) {
  const call = rig.call(session, callId, 'map_apply_patch', args)
  const value = await mapApplyPatch.execute(args, rig.exec(session, { callId }))
  if (fold && value.meta !== null) rig.result(session, call, { meta: value.meta })
  return value
}

/** Execute one patch call WITHOUT folding its result (handler-stage assertions). */
async function patchWithoutFold(rig, session, callId, args) {
  rig.call(session, callId, 'map_apply_patch', args)
  return mapApplyPatch.execute(args, rig.exec(session, { callId }))
}

/** One minimal patch, encoded the way a model sends a `type:'json'` argument. */
function encodedSeedPatch() {
  return JSON.stringify([
    { kind: 'set-view', view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 } },
  ])
}

test('map_apply_patch accepts a string-encoded patch and refuses a malformed one by name', async () => {
  const rig = await collabRig()
  try {
    const session = rig.session()
    const encoded = encodedSeedPatch()
    assert.equal(typeof encoded, 'string')
    const proposed = await patchWithoutFold(rig, session, 'p-string', {
      patch: encoded,
      expected_revision: 0,
      operation_id: 'op-string-1',
    })
    assert.equal(proposed.status, 'proposed', 'a JSON string patch decodes into the existing commit path')
    assert.deepEqual(proposed.ops, ['set-view'])

    await assert.rejects(
      () => patchWithoutFold(rig, session, 'p-bad-json', { patch: '{not json', expected_revision: 0 }),
      (error) => error instanceof Error
        && error.message.startsWith('INVALID_ARGUMENT: patch is a string that is not valid JSON')
        && error.message.includes('{not json'),
    )

    await assert.rejects(
      () => patchWithoutFold(rig, session, 'p-shape', { patch: JSON.stringify({ kind: 'set-view' }), expected_revision: 0 }),
      (error) => error instanceof Error && error.message.startsWith('INVALID_ARGUMENT: patch rejected:'),
      'JSON that parses but is not a patch keeps the existing refusal',
    )
  } finally {
    await rig.dispose()
  }
})

test('map_apply_patch refuses a caller-supplied display digest that does not match the layer data', async () => {
  const rig = await collabRig()
  try {
    const session = rig.session()
    await assert.rejects(
      () => patchWithoutFold(rig, session, 'p-stale-digest', {
        patch: [{ kind: 'upsert-layer', layer: {
          id: 'point', name: 'point', sourceCrs: 'EPSG:4326', opacity: 1, visible: true,
          data: pointCollection([1, 1]), digest: 'stale-display-digest',
        } }],
        expected_revision: 0,
      }),
      (error) => error instanceof Error && error.message.startsWith('INVALID_ARGUMENT: layer "point" digest does not match'),
    )
    assert.equal(rig.state(session).layers.length, 0)
  } finally {
    await rig.dispose()
  }
})

test('map_apply_patch admits GeoJSON before returning a foldable meta', async () => {
  const rig = await collabRig()
  try {
    const session = rig.session()
    await assert.rejects(
      () => patchWithoutFold(rig, session, 'p-invalid-geojson', {
        patch: [{ kind: 'upsert-layer', layer: {
          id: 'bad', name: 'bad', sourceCrs: 'EPSG:4326', opacity: 1, visible: true,
          data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: ['bad', 0] }, properties: {} }] },
        } }],
        expected_revision: 0,
      }),
      error => error instanceof Error && error.message.startsWith('INVALID_GEOJSON:'),
    )
    await assert.rejects(
      () => patchWithoutFold(rig, session, 'p-oversized-geojson', {
        patch: [{ kind: 'upsert-layer', layer: {
          id: 'large', name: 'large', sourceCrs: 'EPSG:4326', opacity: 1, visible: true,
          data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { filler: 'x'.repeat(32 * 1024 * 1024) } }] },
        } }],
        expected_revision: 0,
      }),
      error => error instanceof Error && error.message.startsWith('INVALID_GEOJSON:'),
    )
    assert.equal(rig.state(session).revision, 0)
    assert.equal(rig.state(session).layers.length, 0)
  } finally {
    await rig.dispose()
  }
})

/** Fold the last appended-but-unsettled call's meta (the loop step the agent loop does on acceptance). */
function foldLastCall(rig, session, callEvent, meta) {
  rig.result(session, callEvent, { meta })
}

/** Run one map_undo call through the rig. */
async function undoAndFold(rig, session, callId, args = {}) {
  const call = rig.call(session, callId, 'map_undo', args)
  const value = await mapUndo.execute(args, rig.exec(session, { callId }))
  if (value.meta !== null) rig.result(session, call, { meta: value.meta })
  return value
}

test('map_apply_patch proposes one atomic patch that folds once, with the operation ledgered for undo', async () => {
  const rig = await collabRig()
  try {
    const session = rig.session()
    const call = rig.call(session, 'p1', 'map_apply_patch', {
      patch: [
        { kind: 'upsert-layer', layer: { id: 'point', name: 'point', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection() } },
        { kind: 'set-view', view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 } },
        { kind: 'set-aoi', aoi: { name: 'study', ring: [[115, 39], [118, 39], [118, 41], [115, 39]] } },
      ],
      expected_revision: 0,
      operation_id: 'op-seed-1',
    })
    const value = await mapApplyPatch.execute(call.data.arguments === undefined ? {} : JSON.parse(call.data.arguments), rig.exec(session, { callId: 'p1' }))
    assert.equal(value.status, 'proposed')
    assert.equal(value.target_revision, 0)
    assert.equal(value.meta.schemaVersion, MAP_META_SCHEMA_VERSION)
    assert.equal(value.meta.operationId, 'op-seed-1')
    assert.equal(value.meta.change.op, 'patch')
    assert.equal(value.meta.writerId, `session:${session.id}`)
    assert.equal(rig.state(session).revision, 0, 'the handler itself must not mutate the map')
    assert.equal(rig.state(session).layers.length, 0)

    foldLastCall(rig, session, call, value.meta)
    const state = rig.state(session)
    assert.equal(state.revision, 1, 'the whole patch is one serial commit')
    assert.deepEqual(state.layers.map(layer => layer.id), ['point'])
    assert.equal(state.aoi.name, 'study')
    assert.equal(state.operations.length, 1)
    const record = state.operations[0]
    assert.equal(record.operationId, 'op-seed-1')
    assert.equal(record.index, 1)
    assert.equal(record.writerId, `session:${session.id}`)
    assert.equal(record.inverse.op, 'patch', 'the three-op patch compensates as one patch')

    // Handler-stage idempotent replay: the same operation id replays the recorded outcome.
    const replay = await patchAndFold(rig, session, 'p2', {
      patch: [{ kind: 'set-mode', mode: 'scene' }],
      expected_revision: 1,
      operation_id: 'op-seed-1',
    })
    assert.equal(replay.status, 'duplicate')
    assert.equal(replay.recorded_revision, 1)
    assert.equal(replay.meta, null)
    assert.equal(rig.state(session).revision, 1)

    // Fold-side guard: a RE-PROPOSED meta with an already-ledgered operation id
    // (correct pairing and target revision) settles as duplicate-op, never a second apply.
    const replayCall = rig.call(session, 'p3', 'map_apply_patch', { patch: [], expected_revision: 1, operation_id: 'op-seed-1' })
    const reproposed = { ...value.meta, sourceCallSeq: replayCall.seq, targetRevision: 1 }
    rig.result(session, replayCall, { meta: reproposed })
    assert.equal(rig.state(session).revision, 1, 'the re-proposed operation id applied nothing')
    assert.deepEqual(rig.state(session).layers.map(layer => layer.id), ['point'])
    assert.equal(rig.state(session).diagnostics.some(d => d.code === 'duplicate-op'), true, 'the fold records the idempotent replay')
  } finally {
    await rig.dispose()
  }
})

test('a stale expected_revision conflicts with the current face and never folds', async () => {
  const rig = await collabRig()
  try {
    const session = rig.session()
    await patchAndFold(rig, session, 'p1', {
      patch: [{ kind: 'upsert-layer', layer: { id: 'a', name: 'a', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection([1, 1]) } }],
      expected_revision: 0,
    })
    const stale = await patchAndFold(rig, session, 'p2', {
      patch: [{ kind: 'set-mode', mode: 'scene' }],
      expected_revision: 0,
    })
    assert.equal(stale.status, 'conflict')
    assert.equal(stale.code, 'stale_revision')
    assert.equal(stale.current_revision, 1)
    assert.match(stale.detail, /stale base/)
    assert.equal(stale.meta, null)
    assert.equal(rig.state(session).revision, 1, 'a conflicted patch changes nothing')
    assert.equal(rig.state(session).mode, 'map')
  } finally {
    await rig.dispose()
  }
})

test('a delete against an already-deleted layer conflicts; the old patch is never auto-replayed', async () => {
  const rig = await collabRig()
  try {
    const session = rig.session()
    await patchAndFold(rig, session, 'p1', {
      patch: [
        { kind: 'upsert-layer', layer: { id: 'roads', name: 'roads', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection([2, 2]) } },
        { kind: 'remove-layer', layerId: 'roads' },
      ],
      expected_revision: 0,
    })
    const state = rig.state(session)
    assert.deepEqual(state.layers.map(layer => layer.id), [], 'the patch applied atomically')
    assert.equal(state.operations[0].post.absentIds.includes('roads'), true)

    // Another writer submits the same delete later (e.g. a queued client retry):
    // the conditional read refuses instead of replaying the delete.
    const replayed = await patchAndFold(rig, session, 'p2', {
      patch: [{ kind: 'remove-layer', layerId: 'roads' }],
      expected_revision: 1,
    })
    assert.equal(replayed.status, 'conflict')
    assert.equal(replayed.code, 'layer_missing')
    assert.match(replayed.diff.entries[0].detail, /already gone; the delete is not replayed/)
  } finally {
    await rig.dispose()
  }
})

test('a same-layer update with a stale digest expectation conflicts after another writer touched the layer', async () => {
  const rig = await collabRig()
  try {
    const session = rig.session()
    await patchAndFold(rig, session, 'p1', {
      patch: [{ kind: 'upsert-layer', layer: { id: 'point', name: 'point', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection([3, 3]) } }],
      expected_revision: 0,
    })
    const read = await mapGetState.execute({}, rig.exec(session))
    const digestV1 = read.layers[0].digest

    // Writer B rewrites the layer (different coordinates → different digest).
    await patchAndFold(rig, session, 'p2', {
      patch: [{ kind: 'upsert-layer', layer: { id: 'point', name: 'point', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection([4, 4]) }, expect: { digest: digestV1 } }],
      expected_revision: 1,
    })
    // Writer A's queued patch still cites the v1 digest: refused with the named conflict.
    const stale = await patchAndFold(rig, session, 'p3', {
      patch: [{ kind: 'upsert-layer', layer: { id: 'point', name: 'point-v9', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection([9, 9]) }, expect: { digest: digestV1 } }],
      expected_revision: 2,
    })
    assert.equal(stale.status, 'conflict')
    assert.equal(stale.code, 'layer_digest_conflict')
    assert.match(stale.diff.entries[0].detail, /content changed/)
  } finally {
    await rig.dispose()
  }
})

test('writer lifecycle: explicit writers, permission revoke, disconnect, and reconnect gate every commit', async () => {
  const rig = await collabRig()
  try {
    const session = rig.session()
    rig.collab.join(session, { id: 'client-a', label: 'rightbar' })

    const args = {
      patch: [{ kind: 'set-mode', mode: 'scene' }],
      expected_revision: 0,
      writer_id: 'client-a',
    }
    const ok = await patchAndFold(rig, session, 'p1', args)
    assert.equal(ok.status, 'proposed')
    assert.equal(ok.meta.writerId, 'client-a')

    // Unknown writer refuses loud.
    await assert.rejects(
      () => patchAndFold(rig, session, 'p2', { ...args, writer_id: 'ghost', expected_revision: 1 }),
      error => error.code === 'WRITER_UNKNOWN',
    )

    // Revoked permission refuses while the writer stays joined.
    rig.collab.setPermission(session, 'client-a', false)
    await assert.rejects(
      () => patchAndFold(rig, session, 'p3', { ...args, expected_revision: 1 }),
      error => error.code === 'WRITE_PERMISSION_DENIED',
    )
    rig.collab.setPermission(session, 'client-a', true)

    // Disconnect (transport close) refuses new writes; reconnect restores them.
    rig.collab.disconnect(session, 'client-a')
    await assert.rejects(
      () => patchAndFold(rig, session, 'p4', { ...args, expected_revision: 1 }),
      error => error.code === 'WRITER_OFFLINE',
    )
    rig.collab.reconnect(session, 'client-a')
    const resumed = await patchAndFold(rig, session, 'p5', { ...args, expected_revision: 1 })
    assert.equal(resumed.status, 'proposed')
  } finally {
    await rig.dispose()
  }
})

test('map_undo walks back multi-step history, each undo a NEW revision with the original log preserved', async () => {
  const rig = await collabRig()
  try {
    const session = rig.session()
    // rev0 → rev1: add layer.
    await patchAndFold(rig, session, 'u-add', {
      patch: [{ kind: 'upsert-layer', layer: { id: 'point', name: 'point', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection([7, 7]) } }],
      expected_revision: 0,
    })
    // rev1 → rev2: set view V1 (operation index 2).
    const view1Call = rig.call(session, 'u-view1', 'map_set_view', { center: [1, 1], zoom: 1 })
    const view1Meta = await mapSetView.execute({ center: [1, 1], zoom: 1 }, rig.exec(session, { callId: 'u-view1' }))
    rig.result(session, view1Call, { meta: view1Meta.meta })
    // rev2 → rev3: set view V2 (operation index 3).
    const view2Call = rig.call(session, 'u-view2', 'map_set_view', { center: [2, 2], zoom: 2 })
    const view2Meta = await mapSetView.execute({ center: [2, 2], zoom: 2 }, rig.exec(session, { callId: 'u-view2' }))
    rig.result(session, view2Call, { meta: view2Meta.meta })
    const eventsAfter = session.snapshotEvents().length

    // Undo #1: compensates the newest op (view V2) — back to V1 at a NEW revision.
    const undo1 = await undoAndFold(rig, session, 'u-1')
    assert.equal(undo1.status, 'proposed')
    assert.equal(undo1.undoing, 'set-view [2, 2] z2')
    assert.equal(undo1.meta.undoOf, 3)
    assert.equal(undo1.meta.change.op, 'set-view')
    assert.deepEqual(undo1.meta.change.view.center, [1, 1])
    assert.equal(rig.state(session).revision, 4)
    assert.match(undo1.external_note, /not rolled back/, 'undo never claims to roll back external resources')

    // Undo #2: walks past the undo record to the first view change.
    const undo2 = await undoAndFold(rig, session, 'u-2')
    assert.equal(undo2.status, 'proposed')
    assert.equal(undo2.undoing, 'set-view [1, 1] z1')
    assert.deepEqual(undo2.meta.change.view.center, [0, 0])
    assert.equal(rig.state(session).revision, 5)

    // Undo #3: removes the added layer — re-adding the removal compensation.
    const undo3 = await undoAndFold(rig, session, 'u-3')
    assert.equal(undo3.status, 'proposed')
    assert.equal(undo3.undoing.startsWith('add-layer point'), true)
    assert.equal(rig.state(session).revision, 6)
    assert.deepEqual(rig.state(session).layers.map(layer => layer.id), [])

    // Original history stays in the log: the event count only ever grows.
    assert.equal(session.snapshotEvents().length >= eventsAfter, true)
    // The audit records the undo chain.
    const undos = rig.state(session).operations.filter(op => op.undoOf !== null)
    assert.deepEqual(undos.map(op => op.undoOf), [3, 2, 1])
  } finally {
    await rig.dispose()
  }
})

test('map_undo rebinds a removed layer inverse to the new undo call', async () => {
  const rig = await collabRig()
  try {
    const session = rig.session()
    await patchAndFold(rig, session, 'r-add', {
      patch: [{ kind: 'upsert-layer', layer: { id: 'point', name: 'point', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection([8, 8]) } }],
      expected_revision: 0,
    })
    await patchAndFold(rig, session, 'r-remove', {
      patch: [{ kind: 'remove-layer', layerId: 'point' }],
      expected_revision: 1,
    })
    const undo = await undoAndFold(rig, session, 'r-undo', { undo_of: 2, expected_revision: 2 })
    assert.equal(undo.status, 'proposed')
    assert.equal(undo.meta.change.op, 'add-layer')
    assert.equal(undo.meta.change.layer.sourceCallSeq, 4)
    assert.deepEqual(rig.state(session).layers.map(layer => layer.id), ['point'])
  } finally {
    await rig.dispose()
  }
})

test('map_undo conflicts instead of overwriting when the affected slice moved on', async () => {
  const rig = await collabRig()
  try {
    const session = rig.session()
    // op1: add point at [3,3] (rev0 → 1).
    await patchAndFold(rig, session, 'c1', {
      patch: [{ kind: 'upsert-layer', layer: { id: 'point', name: 'point', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection([3, 3]) } }],
      expected_revision: 0,
      operation_id: 'op-add-point',
    })
    // op2: another writer replaces point with different content (rev1 → 2).
    await patchAndFold(rig, session, 'c2', {
      patch: [{ kind: 'upsert-layer', layer: { id: 'point', name: 'point', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection([8, 8]) } }],
      expected_revision: 1,
    })
    // Undoing op1 now would drop the OTHER writer's layer: refused with detail.
    const conflicted = await undoAndFold(rig, session, 'c3', { undo_of: 1 })
    assert.equal(conflicted.status, 'conflict')
    assert.equal(conflicted.code, 'undo_conflict')
    assert.match(conflicted.detail, /changed after the operation/)
    assert.equal(conflicted.meta, null)
    assert.equal(rig.state(session).revision, 2, 'a conflicted undo changes nothing')
  } finally {
    await rig.dispose()
  }
})

test('undo history survives recovery: a fresh process refolds the same audit and undo targets', async () => {
  const rig = await collabRig()
  let stored
  let sessionId
  let liveOperations
  try {
    const session = rig.session('collab-recover')
    await patchAndFold(rig, session, 'r1', {
      patch: [{ kind: 'upsert-layer', layer: { id: 'point', name: 'point', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection([5, 5]) } }],
      expected_revision: 0,
      operation_id: 'op-recover',
    })
    await patchAndFold(rig, session, 'r2', {
      patch: [{ kind: 'set-view', view: { center: [6, 6], zoom: 6, wkid: 4326 } }],
      expected_revision: 1,
    })
    stored = session.snapshotEvents().map(event => JSON.parse(JSON.stringify(event)))
    sessionId = session.id
    liveOperations = rig.state(session).operations.map(op => ({ ...op }))
  } finally {
    await rig.dispose()
  }

  const recovered = await collabRig()
  try {
    const session = recovered.ctx.sessions.create(sessionId, { seed: stored })
    const state = rig2State(recovered, session)
    assert.deepEqual(state.operations.map(op => ({ ...op })), liveOperations, 'the audit ledger refolds identically')
    // Undo still targets the recorded operations after recovery.
    const undo = await undoAndFold(recovered, session, 'r3')
    assert.equal(undo.status, 'proposed')
    assert.equal(undo.undoing, 'set-view [6, 6] z6')
  } finally {
    await recovered.dispose()
  }
})

/** Read the projection state from a recovered rig. */
function rig2State(rig, session) {
  return rig.ctx.sessionProjections.stateOf(session, 'mapContainer')
}
