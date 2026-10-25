/**
 * P0a projection and protocol fixtures: the `mapContainer` fold's commit
 * rules (decode/validate/settle), the plain-JSON persisted state, the
 * projection-cache ladder (including corrupted rows), legacy log decoding,
 * and the refusal paths — failed results, unpaired/duplicate
 * (surface-replaced) results, unknown versions, stale revisions, capacity,
 * and pending overflow.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { snapshotJsonValue } from '../../../packages/util/values/lib/index.js'
import {
  MAX_CHANGE_META_BYTES,
  MAX_MAP_LAYERS,
  MAX_MAP_OPERATION_RECORDS,
  MAX_PROJECTION_STATE_BYTES,
  MAX_PENDING_MAP_CALLS,
  MAP_PROJECTION_STATE_VERSION,
  buildMapChangeMeta,
  decodeMapChangeMeta,
  initialMapProjectionState,
  settleMapResult,
  validateMapChangeCandidate,
} from '../src/protocol.ts'
import { mapContainerProjectionDefinition } from '../src/projection.ts'
import { buildStyle, styleVersionOf } from '../../spatial-viz/src/index.ts'
import { layerPayload, mapRig, pointCollection } from './map-rig.mjs'

const state0 = mapContainerProjectionDefinition.init({}, 0)

const callEvent = (seq, callId, name, args = {}) => ({ type: 'tool/call', seq, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } })
const resultEvent = (seq, callId, { isError = false, meta, citedSeq } = {}) => ({
  type: 'tool/result',
  seq,
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: isError ? 'Error' : 'ok' }], ...(isError ? { isError: true } : {}) }],
      source: { kind: 'tool', callId },
    },
    ...(meta === undefined ? {} : { meta }),
  },
  ...(citedSeq === undefined ? {} : { sourceEventSeqs: [citedSeq] }),
})

/** A well-formed durable meta for one add-layer candidate against `state`. */
function addLayerMeta(callSeq, targetRevision, id = 'a') {
  const change = { op: 'add-layer', layer: layerPayload(id, pointCollection(), callSeq) }
  return buildMapChangeMeta(callSeq, targetRevision, change)
}

test('decode: valid meta decodes; missing fields, unknown kind/version, and oversized payloads refuse', () => {
  const ok = decodeMapChangeMeta(addLayerMeta(3, 0))
  assert.equal(ok.status, 'ok')

  assert.equal(decodeMapChangeMeta({ kind: 'map-change', sourceCallSeq: 1, targetRevision: 0, change: { op: 'set-mode', mode: 'scene' } }).status, 'refused')
  const missingSourceCallSeq = decodeMapChangeMeta({ schemaVersion: 1, kind: 'map-change', targetRevision: 0, change: { op: 'set-mode', mode: 'scene' } })
  assert.equal(missingSourceCallSeq.status, 'refused')
  assert.equal(missingSourceCallSeq.code, 'invalid-meta')
  const unknownKind = decodeMapChangeMeta({ schemaVersion: 1, kind: 'analysis-result', sourceCallSeq: 1, targetRevision: 0, change: { op: 'set-mode', mode: 'scene' } })
  assert.equal(unknownKind.status, 'refused')
  assert.equal(unknownKind.code, 'unknown-kind')
  const unknownVersion = decodeMapChangeMeta({ schemaVersion: 99, kind: 'map-change', sourceCallSeq: 1, targetRevision: 0, change: { op: 'set-mode', mode: 'scene' } })
  assert.equal(unknownVersion.status, 'refused')
  assert.equal(unknownVersion.code, 'unknown-schema-version')
  // v1 (pre-P0b) records decode beside v2 records.
  const v1 = decodeMapChangeMeta({ schemaVersion: 1, kind: 'map-change', sourceCallSeq: 1, targetRevision: 0, change: { op: 'set-mode', mode: 'scene' } })
  assert.equal(v1.status, 'ok')
  // A catalog-identified layer without its display digest is invalid.
  const unidentified = decodeMapChangeMeta({
    schemaVersion: 2,
    kind: 'map-change',
    sourceCallSeq: 1,
    targetRevision: 0,
    change: {
      op: 'add-layer',
      layer: {
        id: 'ref-layer',
        name: 'ref-layer',
        data: pointCollection(),
        sourceCrs: 'EPSG:4326',
        opacity: 1,
        visible: true,
        sourceCallSeq: 1,
        resourceRef: 'res-abc@v1',
      },
    },
  })
  assert.equal(unidentified.status, 'refused')
  assert.equal(unidentified.code, 'invalid-meta')
  assert.equal(decodeMapChangeMeta('not-an-object').status, 'refused')

  const bulky = addLayerMeta(1, 0, 'bulky')
  bulky.change.layer.data.features[0].properties = { filler: 'x'.repeat(MAX_CHANGE_META_BYTES) }
  const oversized = decodeMapChangeMeta(bulky)
  assert.equal(oversized.status, 'refused')
  assert.equal(oversized.code, 'oversized-meta')
  assert.throws(() => validateMapChangeCandidate(initialMapProjectionState(), bulky.change), /byte limit/)
})

test('candidate validation rejects the 33rd layer but allows id replacement and returns the current revision', () => {
  const layers = Array.from({ length: MAX_MAP_LAYERS }, (_, at) => layerPayload(`l${at}`))
  const full = { ...initialMapProjectionState(), layers }
  const adding = validateMapChangeCandidate(initialMapProjectionState(), { op: 'add-layer', layer: layerPayload('a') })
  assert.equal(adding, 0)
  assert.throws(
    () => validateMapChangeCandidate(full, { op: 'add-layer', layer: layerPayload('one-too-many') }),
    /at most 32 layers/,
  )
  const replaced = validateMapChangeCandidate(full, { op: 'add-layer', layer: layerPayload('l0') })
  assert.equal(replaced, 0)
  const advanced = { ...full, revision: 7 }
  assert.equal(validateMapChangeCandidate(advanced, { op: 'set-mode', mode: 'scene' }), 7)
})

test('admission counts UTF-8 bytes and rejects unsupported WKID or display geometry', () => {
  const multibyte = addLayerMeta(0, 0, 'utf8')
  multibyte.change.layer.data.features[0].properties = { filler: '汉'.repeat(Math.ceil(MAX_CHANGE_META_BYTES / 3)) }
  assert.equal(decodeMapChangeMeta(multibyte).code, 'oversized-meta')
  assert.equal(decodeMapChangeMeta({
    schemaVersion: 4,
    kind: 'map-change',
    sourceCallSeq: 0,
    targetRevision: 0,
    change: { op: 'set-view', view: { center: [0, 0], zoom: 0, wkid: 999999 } },
  }).code, 'invalid-meta')
  assert.equal(decodeMapChangeMeta({
    schemaVersion: 4,
    kind: 'map-change',
    sourceCallSeq: 0,
    targetRevision: 0,
    change: { op: 'add-layer', layer: {
      ...layerPayload('multi'),
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[0, 0]] }, properties: {} }] },
    } },
  }).code, 'invalid-meta')
})

test('map meta budget includes the durable envelope around a near-limit change', () => {
  const template = { op: 'add-layer', layer: {
    ...layerPayload('near-limit'),
    data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { filler: '' } }] },
  } }
  const templateBytes = Buffer.byteLength(JSON.stringify(template), 'utf8')
  const candidate = { ...template }
  candidate.layer = {
    ...template.layer,
    data: { ...template.layer.data, features: [{ ...template.layer.data.features[0], properties: { filler: 'x'.repeat(MAX_CHANGE_META_BYTES - templateBytes - 1) } }] },
  }
  const envelope = { schemaVersion: 4, kind: 'map-change', sourceCallSeq: 0, targetRevision: 0, change: candidate }
  assert.ok(Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= MAX_CHANGE_META_BYTES)
  assert.ok(Buffer.byteLength(JSON.stringify(envelope), 'utf8') > MAX_CHANGE_META_BYTES)
  assert.throws(() => buildMapChangeMeta(0, 0, candidate), /byte limit/)
})

test('fold admission enforces tool ownership, nested call identity, and exact source citations', () => {
  const forged = buildMapChangeMeta(0, 0, { op: 'set-mode', mode: 'scene' })
  const wrongTool = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(0, 'wrong-tool', 'map_set_view')),
    resultEvent(1, 'wrong-tool', { meta: forged, citedSeq: 0 }),
  )
  assert.deepEqual(wrongTool.diagnostics, [{ seq: 1, code: 'call-pairing' }])

  const nested = buildMapChangeMeta(0, 0, { op: 'add-layer', layer: layerPayload('nested', pointCollection(), 42) })
  const wrongNested = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(0, 'nested', 'map_add_layer')),
    resultEvent(1, 'nested', { meta: nested, citedSeq: 0 }),
  )
  assert.deepEqual(wrongNested.diagnostics, [{ seq: 1, code: 'call-pairing' }])

  const extraCitation = settleMapResult(state0, {
    resultSeq: 1,
    pending: { callId: 'citation', callSeq: 0, name: 'map_set_mode' },
    isError: false,
    meta: forged,
    citedCallSeq: 0,
    citedCallSeqs: [0, 99],
  })
  assert.deepEqual(extraCitation.diagnostics, [{ seq: 1, code: 'call-pairing' }])
})

test('fold rejects forged map_undo targets and inverse changes', () => {
  let state = mapContainerProjectionDefinition.apply(state0, callEvent(0, 'add', 'map_add_layer'))
  state = mapContainerProjectionDefinition.apply(state, resultEvent(1, 'add', { meta: addLayerMeta(0, 0, 'undo-target') }))
  assert.equal(state.operations[0].index, 1)

  // The target's inverse is remove-layer. A forged mode change must not be
  // accepted merely because it names an existing operation index.
  state = mapContainerProjectionDefinition.apply(state, callEvent(2, 'forged-inverse', 'map_undo'))
  const forgedInverse = buildMapChangeMeta(2, 1, { op: 'set-mode', mode: 'scene' }, { undoOf: 1 })
  const rejectedInverse = mapContainerProjectionDefinition.apply(
    state,
    resultEvent(3, 'forged-inverse', { meta: forgedInverse, citedSeq: 2 }),
  )
  assert.equal(rejectedInverse.revision, 1)
  assert.equal(rejectedInverse.layers.length, 1)
  assert.equal(rejectedInverse.mode, 'map')
  assert.deepEqual(rejectedInverse.diagnostics, [{ seq: 3, code: 'call-pairing' }])

  // A valid inverse paired with a missing target is rejected as well.
  const missingTargetState = mapContainerProjectionDefinition.apply(rejectedInverse, callEvent(4, 'forged-target', 'map_undo'))
  const forgedTarget = buildMapChangeMeta(4, 1, { op: 'remove-layer', layerId: 'undo-target' }, { undoOf: 999 })
  const rejectedTarget = mapContainerProjectionDefinition.apply(
    missingTargetState,
    resultEvent(5, 'forged-target', { meta: forgedTarget, citedSeq: 4 }),
  )
  assert.equal(rejectedTarget.revision, 1)
  assert.deepEqual(rejectedTarget.diagnostics, [
    { seq: 3, code: 'call-pairing' },
    { seq: 5, code: 'call-pairing' },
  ])

  // A compensating layer must be rebound to the undo call. Reusing the
  // target's inverse with an unrelated source call is not a valid proposal.
  let removed = mapContainerProjectionDefinition.apply(rejectedTarget, callEvent(6, 'remove', 'map_remove_layer'))
  removed = mapContainerProjectionDefinition.apply(
    removed,
    resultEvent(7, 'remove', { meta: buildMapChangeMeta(6, 1, { op: 'remove-layer', layerId: 'undo-target' }), citedSeq: 6 }),
  )
  assert.equal(removed.revision, 2)
  const wrongSource = { ...state.layers[0], sourceCallSeq: 999 }
  const sourceMismatchState = mapContainerProjectionDefinition.apply(removed, callEvent(8, 'forged-source', 'map_undo'))
  const forgedSource = buildMapChangeMeta(8, 2, { op: 'add-layer', layer: wrongSource }, { undoOf: 2 })
  const rejectedSource = mapContainerProjectionDefinition.apply(
    sourceMismatchState,
    resultEvent(9, 'forged-source', { meta: forgedSource, citedSeq: 8 }),
  )
  assert.equal(rejectedSource.revision, 2)
  assert.equal(rejectedSource.layers.length, 0)
  assert.deepEqual(rejectedSource.diagnostics.at(-1), { seq: 9, code: 'call-pairing' })
})

test('absent removal refuses without a revision and the operation ledger stays bounded', () => {
  assert.throws(
    () => validateMapChangeCandidate(state0, { op: 'remove-layer', layerId: 'missing' }),
    (error) => error.code === 'layer-unknown',
  )
  let state = state0
  for (let seq = 0; seq < MAX_MAP_OPERATION_RECORDS + 8; seq += 1) {
    const callSeq = seq * 2
    state = settleMapResult(state, {
      resultSeq: callSeq + 1,
      pending: { callId: `mode-${seq}`, callSeq, name: 'map_set_mode' },
      isError: false,
      meta: buildMapChangeMeta(callSeq, state.revision, { op: 'set-mode', mode: seq % 2 === 0 ? 'scene' : 'map' }),
      citedCallSeq: callSeq,
      citedCallSeqs: [callSeq],
    })
  }
  assert.equal(state.revision, MAX_MAP_OPERATION_RECORDS + 8)
  assert.equal(state.operations.length, MAX_MAP_OPERATION_RECORDS)
})

test('the cumulative projection budget rejects the add that would exceed it and keeps the old state', () => {
  // Each layer is far under the per-change cap, but together they pass the
  // cumulative budget: the LAST add must refuse even though every add before
  // it was legal on its own.
  const filler = 'x'.repeat(60 * 1024)
  const features = Array.from({ length: 70 }, (_, at) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { id: at, filler },
  }))
  const bigLayer = at => ({
    ...layerPayload(`big-${at}`),
    data: {
      type: 'FeatureCollection',
      features,
    },
  })
  // Twenty legal adds, each far under the per-feature cap, together exceed the
  // 64 MiB cumulative budget while staying under the layer-count cap.
  const state = { ...initialMapProjectionState(), layers: Array.from({ length: 20 }, (_, at) => bigLayer(at)) }
  assert.throws(
    () => validateMapChangeCandidate(state, { op: 'add-layer', layer: bigLayer(20) }),
    /projection would exceed/,
  )
  // A legal small state stays well under the budget.
  assert.equal(validateMapChangeCandidate(initialMapProjectionState(), { op: 'add-layer', layer: layerPayload('a') }), 0)
})

test('the final projection budget reserves the operation ledger and refuses without applying', () => {
  const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
  const existingFiller = 'x'.repeat(60 * 1024)
  const existingFeatures = Array.from({ length: 500 }, (_, at) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [1, 1] },
    properties: { id: at, filler: existingFiller },
  }))
  const existingLayers = ['large-a', 'large-b'].map((id, at) => layerPayload(
    id,
    { type: 'FeatureCollection', features: existingFeatures },
    at,
  ))
  const state = { ...initialMapProjectionState(), layers: existingLayers }
  const template = layerPayload('ledger-reserve', { type: 'FeatureCollection', features: [] }, 0)
  const templateProjected = { ...state, layers: [...state.layers, template] }
  const feature = at => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [2, 2] },
    properties: { id: at, filler: existingFiller },
  })
  const maxFeatureFillerBytes = 60 * 1024
  const oneFeatureProjected = {
    ...state,
    layers: [...state.layers, { ...template, data: { type: 'FeatureCollection', features: [feature(0)] } }],
  }
  const perFeatureBytes = bytes(oneFeatureProjected) - bytes(templateProjected)
  let prefixCount = Math.max(0, Math.floor((MAX_PROJECTION_STATE_BYTES - 16 - bytes(templateProjected)) / perFeatureBytes))
  let prefixFeatures = Array.from({ length: prefixCount }, (_, at) => feature(at))
  const emptyTail = at => ({
    ...feature(at),
    properties: { id: at, filler: '' },
  })
  const projectedWith = features => ({
    ...state,
    layers: [...state.layers, { ...template, data: { type: 'FeatureCollection', features } }],
  })
  let baseline = projectedWith([...prefixFeatures, emptyTail(prefixCount)])
  while (bytes(baseline) > MAX_PROJECTION_STATE_BYTES - 16) {
    prefixFeatures = prefixFeatures.slice(0, -1)
    baseline = projectedWith([...prefixFeatures, emptyTail(prefixFeatures.length)])
  }
  let tailFillerBytes = MAX_PROJECTION_STATE_BYTES - 16 - bytes(baseline)
  while (tailFillerBytes > maxFeatureFillerBytes) {
    prefixFeatures = [...prefixFeatures, feature(prefixFeatures.length)]
    baseline = projectedWith([...prefixFeatures, emptyTail(prefixFeatures.length)])
    tailFillerBytes = MAX_PROJECTION_STATE_BYTES - 16 - bytes(baseline)
  }
  assert.ok(tailFillerBytes >= 0)
  const tail = {
    ...emptyTail(prefixFeatures.length),
    properties: { id: prefixFeatures.length, filler: 'x'.repeat(tailFillerBytes) },
  }
  const candidateFeatures = [...prefixFeatures, tail]
  const candidate = {
    ...template,
    data: { type: 'FeatureCollection', features: candidateFeatures },
  }
  const projected = projectedWith(candidateFeatures)
  assert.ok(bytes(projected) <= MAX_PROJECTION_STATE_BYTES)
  assert.ok(bytes(projected) > MAX_PROJECTION_STATE_BYTES - 128)

  const settled = settleMapResult(state, {
    resultSeq: 1,
    pending: { callId: 'ledger-reserve', callSeq: 0, name: 'map_add_layer' },
    isError: false,
    meta: buildMapChangeMeta(0, 0, { op: 'add-layer', layer: candidate }),
    citedCallSeq: 0,
    citedCallSeqs: [0],
  })
  assert.equal(settled.revision, 0)
  assert.deepEqual(settled.layers, state.layers)
  assert.deepEqual(settled.operations, [])
  assert.deepEqual(settled.diagnostics, [{ seq: 1, code: 'oversized-meta' }])
})

test('fold pairs call→result and applies one accepted change with revision and call identity', () => {
  const afterCall = mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c1', 'map_add_layer', { path: 'a.geojson' }))
  assert.deepEqual(afterCall.pendingCalls, [{ callId: 'c1', callSeq: 0, name: 'map_add_layer' }])
  assert.equal(afterCall.revision, 0)
  const afterResult = mapContainerProjectionDefinition.apply(afterCall, resultEvent(1, 'c1', { meta: addLayerMeta(0, 0) }))
  assert.equal(afterResult.layers.length, 1)
  assert.equal(afterResult.layers[0].id, 'a')
  assert.equal(afterResult.layers[0].sourceCallSeq, 0)
  assert.equal(afterResult.revision, 1)
  assert.equal(afterResult.lastCallId, 'c1')
  assert.deepEqual(afterResult.pendingCalls, [])
  const wire = mapContainerProjectionDefinition.wire.view(afterResult)
  assert.equal(wire.layers[0].featureCount, 1)
  assert.equal(wire.mode, 'map')
})

test('fold set_view and set_mode from versioned meta', () => {
  const viewMeta = buildMapChangeMeta(0, 0, { op: 'set-view', view: { center: [117, 39], zoom: 10, wkid: 4547 } })
  const afterCallV = mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c2', 'map_set_view'))
  const v = mapContainerProjectionDefinition.apply(afterCallV, resultEvent(1, 'c2', { meta: viewMeta }))
  assert.deepEqual(v.view, { center: [117, 39], zoom: 10, wkid: 4547 })
  assert.equal(v.revision, 1)
  const modeMeta = buildMapChangeMeta(2, 1, { op: 'set-mode', mode: 'scene' })
  const afterCallM = mapContainerProjectionDefinition.apply(v, callEvent(2, 'c3', 'map_set_mode'))
  const m = mapContainerProjectionDefinition.apply(afterCallM, resultEvent(3, 'c3', { meta: modeMeta }))
  assert.equal(m.mode, 'scene')
  assert.equal(m.revision, 2)
})

test('the persisted state is plain JSON: cache snapshot round-trip passes and a Map fixture fails', () => {
  const afterCall = mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c1', 'map_add_layer'))
  const applied = mapContainerProjectionDefinition.apply(afterCall, resultEvent(1, 'c1', { meta: addLayerMeta(0, 0) }))
  const detached = snapshotJsonValue(applied)
  assert.notEqual(detached, undefined, 'the P0a state must satisfy the projection-cache JSON gate')
  assert.deepEqual(JSON.parse(JSON.stringify(applied)), applied)
  assert.equal(applied.stateVersion, MAP_PROJECTION_STATE_VERSION)

  // The pre-P0a shape (Map-keyed layers) is exactly what the cache gate refuses.
  const mapBased = { ...applied, layers: new Map([['a', applied.layers[0]]]) }
  assert.equal(snapshotJsonValue(mapBased), undefined)
})

test('failure admission: an error result carrying a change meta never mutates the map', () => {
  const afterCall = mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c-fail', 'map_set_mode', { mode: 'scene' }))
  const settled = mapContainerProjectionDefinition.apply(afterCall, resultEvent(1, 'c-fail', { isError: true, meta: buildMapChangeMeta(0, 0, { op: 'set-mode', mode: 'scene' }) }))
  assert.equal(settled.mode, 'map')
  assert.equal(settled.revision, 0)
  assert.equal(settled.lastCallId, null)
  assert.deepEqual(settled.pendingCalls, [])
  assert.deepEqual(settled.diagnostics, [{ seq: 1, code: 'failed-result' }])
  const plainFailure = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(2, 'c-plain', 'map_set_mode')),
    resultEvent(3, 'c-plain', { isError: true }),
  )
  assert.deepEqual(plainFailure.diagnostics, [])
})

test('unpaired results and surface-replaced duplicates settle nothing (apply-once)', () => {
  const withPending = mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c9', 'map_add_layer'))
  const stranger = mapContainerProjectionDefinition.apply(withPending, resultEvent(1, 'c8', { meta: addLayerMeta(99, 0) }))
  assert.equal(stranger.layers.length, 0)
  assert.equal(stranger.pendingCalls.length, 1)

  const applied = mapContainerProjectionDefinition.apply(withPending, resultEvent(1, 'c9', { meta: addLayerMeta(0, 0), citedSeq: 0 }))
  assert.equal(applied.layers.length, 1)
  // A surface replacement re-appends the same toolCallId/meta at a new seq:
  // the pending entry is consumed, so the change applies exactly once.
  const replacement = mapContainerProjectionDefinition.apply(applied, {
    ...resultEvent(2, 'c9', { meta: addLayerMeta(0, 0) }),
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
    sourceEventSeqs: [1],
  })
  assert.equal(replacement.layers.length, 1)
  assert.equal(replacement.revision, 1)
})

test('pairing and revision admission refuse mismatched records with bounded diagnostics', () => {
  const wrongSeq = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c1', 'map_add_layer')),
    resultEvent(1, 'c1', { meta: addLayerMeta(5, 0) }),
  )
  assert.equal(wrongSeq.layers.length, 0)
  assert.deepEqual(wrongSeq.diagnostics, [{ seq: 1, code: 'call-pairing' }])

  const wrongCitation = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c1', 'map_add_layer')),
    resultEvent(1, 'c1', { meta: addLayerMeta(0, 0), citedSeq: 42 }),
  )
  assert.deepEqual(wrongCitation.diagnostics, [{ seq: 1, code: 'call-pairing' }])

  const stale = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c1', 'map_add_layer')),
    resultEvent(1, 'c1', { meta: addLayerMeta(0, 9) }),
  )
  assert.deepEqual(stale.diagnostics, [{ seq: 1, code: 'stale-revision' }])
})

test('unknown meta versions stay read-only: refused with a diagnostic, never defaulted', () => {
  const future = { schemaVersion: 99, kind: 'map-change', sourceCallSeq: 0, targetRevision: 0, change: { op: 'set-mode', mode: 'scene' } }
  const settled = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c1', 'map_set_mode')),
    resultEvent(1, 'c1', { meta: future }),
  )
  assert.equal(settled.mode, 'map')
  assert.deepEqual(settled.diagnostics, [{ seq: 1, code: 'unknown-schema-version' }])
})

test('fold-side capacity refuses the 33rd layer from a replayed record', () => {
  let state = state0
  for (let at = 0; at < MAX_MAP_LAYERS; at++) {
    state = mapContainerProjectionDefinition.apply(state, callEvent(at * 2, `c${at}`, 'map_add_layer'))
    state = mapContainerProjectionDefinition.apply(state, resultEvent(at * 2 + 1, `c${at}`, { meta: addLayerMeta(at * 2, at, `l${at}`) }))
  }
  assert.equal(state.layers.length, MAX_MAP_LAYERS)
  assert.equal(state.revision, MAX_MAP_LAYERS)
  state = mapContainerProjectionDefinition.apply(state, callEvent(64, 'c32', 'map_add_layer'))
  state = mapContainerProjectionDefinition.apply(state, resultEvent(65, 'c32', { meta: addLayerMeta(64, 32) }))
  assert.equal(state.layers.length, MAX_MAP_LAYERS)
  assert.deepEqual(state.diagnostics, [{ seq: 65, code: 'capacity' }])
})

test('pending overflow evicts the oldest call into a bounded diagnostic', () => {
  let state = state0
  for (let at = 0; at <= MAX_PENDING_MAP_CALLS; at++) {
    state = mapContainerProjectionDefinition.apply(state, callEvent(at, `c${at}`, 'map_add_layer'))
  }
  assert.equal(state.pendingCalls.length, MAX_PENDING_MAP_CALLS)
  assert.deepEqual(state.diagnostics, [{ seq: 0, code: 'pending-overflow' }])
  assert.equal(state.pendingCalls[0].callSeq, 1)
})

test('legacy pre-P0a flat metas fold through the dedicated old-log path', () => {
  const legacyLayer = { id: 'legacy', name: 'Legacy', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: pointCollection() }
  const added = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(0, 'cl', 'map_add_layer')),
    resultEvent(1, 'cl', { meta: { layer: legacyLayer } }),
  )
  assert.equal(added.layers.length, 1)
  assert.equal(added.layers[0].sourceCallSeq, 0)
  assert.equal(added.revision, 1)

  const viewed = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(added, callEvent(2, 'cv', 'map_set_view')),
    resultEvent(3, 'cv', { meta: { view: { center: [120, 30], zoom: 7 } } }),
  )
  assert.deepEqual(viewed.view, { center: [120, 30], zoom: 7, wkid: 4326 })

  const moded = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(viewed, callEvent(4, 'cm', 'map_set_mode')),
    resultEvent(5, 'cm', { meta: { mode: 'scene' } }),
  )
  assert.equal(moded.mode, 'scene')

  const removed = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(moded, callEvent(6, 'cr', 'map_remove_layer')),
    resultEvent(7, 'cr', { meta: { layer_id: 'legacy' } }),
  )
  assert.equal(removed.layers.length, 0)
  assert.equal(removed.revision, 4)
})

test('the projection-cache ladder: checkpoint seeds restore, and version mismatches discard rows', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('cache-ladder')
    const call = rig.call(session, 'c1', 'map_add_layer', { path: 'a.geojson' })
    rig.result(session, call, { meta: addLayerMeta(call.seq, 0) })
    const viewCall = rig.call(session, 'c2', 'map_set_view', { center: [117, 39] })
    rig.result(session, viewCall, { meta: buildMapChangeMeta(viewCall.seq, 1, { op: 'set-view', view: { center: [117, 39], zoom: 3, wkid: 4326 } }) })
    const live = rig.state(session)
    assert.equal(live.revision, 2)

    const registry = rig.ctx.sessionProjections
    const checkpoint = registry.checkpoint(session)
    const row = checkpoint.mapContainer
    assert.ok(row)
    assert.equal(row.ver, MAP_PROJECTION_STATE_VERSION)
    assert.notEqual(snapshotJsonValue(row.val), undefined)

    // A stale ver-2 row (the pre-P0a Map-based generation) must not serve views.
    assert.deepEqual(registry.viewCheckpoint({ mapContainer: { ver: 2, seq: row.seq, val: row.val } }), {})
    assert.deepEqual(registry.viewCheckpoint({ mapContainer: row }).mapContainer.layers.length, 1)
    // restoreFloor pulls a mismatched row's key down to a full replay.
    assert.equal(registry.restoreFloor({ mapContainer: { ver: 2, seq: row.seq, val: row.val } }), 0)

    // Full replay without any row equals the live fold.
    const events = session.snapshotEvents()
    const cold = registry.restore({}, events, 0, session.header, session.inheritedEventCount)
    assert.deepEqual(cold.checkpoint.mapContainer.val, live)

    // Tail replay seeded from the checkpoint row continues across new events.
    const tailCall = rig.call(session, 'c3', 'map_set_mode', { mode: 'scene' })
    const tailResult = rig.result(session, tailCall, { meta: buildMapChangeMeta(tailCall.seq, 2, { op: 'set-mode', mode: 'scene' }) })
    const allEvents = session.snapshotEvents()
    const floor = registry.restoreFloor(checkpoint)
    const continued = registry.restore(
      checkpoint,
      allEvents.filter(event => event.seq >= floor),
      floor,
      session.header,
      session.inheritedEventCount,
    )
    assert.equal(continued.snapshot.values.mapContainer.mode, 'scene')
    assert.equal(continued.checkpoint.mapContainer.seq, tailResult.seq)
  } finally {
    await rig.dispose()
  }
})

test('a fresh process recovers identical state from the stored log, and forks stay isolated', async () => {
  const first = await mapRig()
  let stored
  let sessionId
  try {
    const session = first.session('recovery-source')
    sessionId = session.id
    const call = first.call(session, 'c1', 'map_add_layer', { path: 'a.geojson' })
    first.result(session, call, { meta: addLayerMeta(call.seq, 0) })
    stored = session.snapshotEvents()
    assert.equal(first.state(session).layers.length, 1)
  } finally {
    await first.dispose()
  }

  const second = await mapRig()
  try {
    const restored = second.ctx.sessions.create(sessionId, { seed: stored.map(event => JSON.parse(JSON.stringify(event))) })
    assert.equal(second.state(restored).layers.length, 1, 'a fresh projection rebuilds from the raw log with no cache')
    assert.deepEqual(second.view(restored).layers.map(layer => layer.id), ['a'])

    const fork = second.ctx.sessions.fork(restored)
    const forkCall = second.call(fork, 'f1', 'map_set_mode', { mode: 'scene' })
    second.result(fork, forkCall, { meta: buildMapChangeMeta(forkCall.seq, second.state(fork).revision, { op: 'set-mode', mode: 'scene' }) })
    assert.equal(second.state(fork).mode, 'scene')
    assert.equal(second.state(restored).mode, 'map', 'the parent keeps its own accepted state')
    assert.equal(second.state(restored).layers.length, 1)
  } finally {
    await second.dispose()
  }
})

test('a corrupted cache row at the current version drops its cached read and recovers by full replay', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('cache-corrupt')
    const call = rig.call(session, 'c1', 'map_add_layer', { path: 'a.geojson' })
    rig.result(session, call, { meta: addLayerMeta(call.seq, 0) })
    const live = rig.state(session)
    const registry = rig.ctx.sessionProjections
    const row = registry.checkpoint(session).mapContainer
    // Same ver as the live unit, but the stored val is garbage: the damage
    // case a version bump cannot cover.
    const corrupted = { ver: MAP_PROJECTION_STATE_VERSION, seq: row.seq, val: { broken: true, layers: 'not-an-array' } }

    // The zero-I/O rung refuses to serve the malformed row: no partial defaults.
    assert.deepEqual(registry.viewCheckpoint({ mapContainer: corrupted }), {})

    // A tail restore seeded from the corrupted row fails loud — a matching
    // ver alone never makes the val trustworthy.
    const floor = registry.restoreFloor({ mapContainer: corrupted })
    const events = session.snapshotEvents()
    const tail = events.filter(event => event.seq >= floor)
    assert.throws(() => registry.restore({ mapContainer: corrupted }, tail, floor, session.header, session.inheritedEventCount))

    // Recovery: the cache row is dropped and the raw log refolds whole. The
    // recovered view equals the live fold, and the refreshed row serves
    // reads again — the log stayed the sole authority throughout.
    const cold = registry.restore({}, events, 0, session.header, session.inheritedEventCount)
    assert.deepEqual(cold.snapshot.values.mapContainer.layers.map(layer => layer.id), rig.view(session).layers.map(layer => layer.id))
    assert.deepEqual(cold.snapshot.values.mapContainer, registry.viewCheckpoint(cold.checkpoint).mapContainer)
    assert.deepEqual(cold.checkpoint.mapContainer.val, live)
    assert.equal(registry.restoreFloor(cold.checkpoint), row.seq, 'the refreshed row carries the refolded watermark')
  } finally {
    await rig.dispose()
  }
})


/** A valid computed style for the numeric fixtures below. */
function validStyleFixture() {
  return buildStyle({
    field: 'score', unit: '分', measure: 'total', encoding: 'fill',
    classification: 'equal-interval', breaks: [10, 20], domain: { min: 0, max: 30 },
  })
}

/** A well-formed durable meta for one set-style candidate. */
function setStyleMeta(callSeq, targetRevision, layerId, style = validStyleFixture()) {
  const change = { op: 'set-style', styles: [{ layerId, style }] }
  return buildMapChangeMeta(callSeq, targetRevision, change)
}

test('set-style folds onto the styled layer with revision and call identity', () => {
  const withLayer = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c0', 'map_add_layer')),
    resultEvent(1, 'c0', { meta: addLayerMeta(0, 0, 'zones') }),
  )
  const settled = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(withLayer, callEvent(2, 'c1', 'viz_classify')),
    resultEvent(3, 'c1', { meta: setStyleMeta(2, 1, 'zones') }),
  )
  assert.equal(settled.revision, 2)
  const styled = settled.layers.find(layer => layer.id === 'zones')
  assert.equal(styled.style.styleVersion, validStyleFixture().styleVersion)
  assert.equal(styled.style.breaks.length, 2)
})

test('set-style onto an unknown layer refuses read-only with its own diagnostic', () => {
  const withLayer = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c0', 'map_add_layer')),
    resultEvent(1, 'c0', { meta: addLayerMeta(0, 0, 'zones') }),
  )
  const settled = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(withLayer, callEvent(2, 'c1', 'viz_classify')),
    resultEvent(3, 'c1', { meta: setStyleMeta(2, 1, 'ghost') }),
  )
  assert.equal(settled.revision, 1)
  assert.deepEqual(settled.diagnostics, [{ seq: 3, code: 'style-layer-unknown' }])
  assert.equal(settled.layers.find(layer => layer.id === 'zones').style, undefined)
})

test('a style payload whose styleVersion does not re-derive refuses read-only', () => {
  const withLayer = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c0', 'map_add_layer')),
    resultEvent(1, 'c0', { meta: addLayerMeta(0, 0, 'zones') }),
  )
  const tampered = { ...validStyleFixture(), breaks: [5, 25], styleVersion: validStyleFixture().styleVersion }
  const settled = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(withLayer, callEvent(2, 'c1', 'viz_classify')),
    resultEvent(3, 'c1', { meta: setStyleMeta(2, 1, 'zones', tampered) }),
  )
  assert.equal(settled.revision, 1)
  assert.deepEqual(settled.diagnostics, [{ seq: 3, code: 'invalid-meta' }])
})

test('a v2 record cannot carry a set-style change: pre-style versions refuse read-only', () => {
  const withLayer = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(state0, callEvent(0, 'c0', 'map_add_layer')),
    resultEvent(1, 'c0', { meta: addLayerMeta(0, 0, 'zones') }),
  )
  const v2SetStyle = { ...setStyleMeta(2, 1, 'zones'), schemaVersion: 2 }
  const settled = mapContainerProjectionDefinition.apply(
    mapContainerProjectionDefinition.apply(withLayer, callEvent(2, 'c1', 'viz_classify')),
    resultEvent(3, 'c1', { meta: v2SetStyle }),
  )
  assert.equal(settled.revision, 1)
  assert.deepEqual(settled.diagnostics, [{ seq: 3, code: 'invalid-meta' }])
})

test('candidate validation refuses set-style naming a missing layer before any meta exists', () => {
  const style = validStyleFixture()
  assert.throws(
    () => validateMapChangeCandidate(state0, { op: 'set-style', styles: [{ layerId: 'ghost', style }] }),
    (error) => {
      assert.equal(error.code, 'style-layer-unknown')
      return true
    },
  )
  // The persisted state schema accepts a style-bearing layer (plain JSON for the cache).
  const parsed = JSON.parse(JSON.stringify({ style: style.styleVersion, version: styleVersionOf(style) }))
  assert.equal(parsed.style, style.styleVersion)
})
