/**
 * `map_markup` fixtures: the model-direct tool pairs an accepted call with
 * the current session's observation, reads the exact persisted PNG, projects
 * bounded image pixels, and returns a versioned meta record that folds only
 * once. Error, stale, cross-session, non-affine and duplicate paths leave no
 * candidate residue.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import { buildMapObservationMeta } from '../../map-container/src/observation-protocol.ts'
import { scaleFromZoom } from '../../map-container/src/view-policy.ts'
import { mapMarkup, MARKUP_DESCRIPTION } from '../src/markup-tools.ts'
import { mapEditAnnotation } from '../src/annotation-tools.ts'
import { SYMBOL_PRESETS } from '../../layers/src/index.ts'
import { MAP_USER_CHANGE_SOURCE, userChangeNoticeText } from '../../map-container/src/user-change.ts'
import { mapContainerProjectionDefinition } from '../../map-container/src/projection.ts'

const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex')
const pngSha256 = createHash('sha256').update(png).digest('hex')
const fixedSource = { id: 'esri-world-imagery', kind: 'basemap', version: null, attribution: 'Source: Esri', policy: 'fixed' }
const item = (overrides = {}) => ({
  kind: 'target', category: 'building', note: 'visible roof', confidence: 'likely',
  pixelGeometry: { type: 'point', point: [200, 100] }, ...overrides,
})

function observationRecord(callId, requestSeq, overrides = {}) {
  return {
    observationId: 'obs-1', callId, requestSeq, mapRevision: 0,
    viewId: 'view-1', generation: 1, cameraEpoch: 0, gestureEpoch: 0,
    attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: png.length, width: 800, height: 600, sha256: pngSha256 },
    capturedAt: '2026-11-09T00:00:00.000Z',
    imageSize: { width: 800, height: 600 },
    mapContentRect: { x: 0, y: 0, width: 800, height: 600 },
    cssViewSize: { width: 800, height: 600 },
    camera: {
      center: [104.9, 36.4], extent: [100, 32, 109.8, 40.8], wkid: 4326,
      scale: scaleFromZoom(6), zoom: 6, rotation: 0, mode: 'map', padding: [0, 0, 0, 0],
    },
    georeference: { kind: 'affine-2d', coefficients: [0.01, 0, 100, 0, -0.01, 40.8], wkid: 4326, maxResidualCssPx: 0 },
    sources: [fixedSource], basemap: null, includedOverlays: ['attribution'], limitations: [],
    ...overrides,
  }
}

async function rigWithObservation(overrides = {}) {
  const rig = await mapRig({ mapConfig: {
    observation: { capturePolicy: 'allow' },
    sources: { presets: { 'esri-world-imagery': { automatedMapUse: 'allowed' } } },
  } })
  const session = rig.session('markup-session')
  session.append('turn/start', { turn: 1 })
  const call = session.append('tool/call', { turn: 1, step: 1, callId: 'obs-call', name: 'map_observe', arguments: '{}' })
  const request = rig.state(session).observationRequest
  const record = observationRecord('obs-call', request.requestSeq, overrides)
  rig.result(session, call, { meta: buildMapObservationMeta(record) })
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    async readImage(ref) { return { ref, data: new Uint8Array(png) } },
  }))
  return { rig, session }
}

function execWithModel(rig, session, callId, signal = new AbortController().signal) {
  const execution = rig.exec(session, { callId, signal })
  return { ...execution, agent: { ...execution.agent, model: { current: () => ({ provider: 'fixture-provider', model: 'vision-model' }) } } }
}

const args = (overrides = {}) => ({
  observation_id: 'obs-1', purpose: 'target', items: [item()], ...overrides,
})

test('map_markup pins authored model-facing text and refuses unpaired or forged inputs', async t => {
  assert.equal(mapMarkup.description, MARKUP_DESCRIPTION)
  const { rig, session } = await rigWithObservation()
  t.after(async () => { await rig.dispose() })
  await assert.rejects(mapMarkup.execute(args(), execWithModel(rig, session, 'unpaired')), /INVALID_ARGUMENT/)
  const call = rig.call(session, 'markup-call', 'map_markup', args())
  const execution = execWithModel(rig, session, 'markup-call')
  await assert.rejects(mapMarkup.execute(args({ items: [item({ kind: 'sketch' })] }), execution), /INVALID_PROPOSAL/)
  await assert.rejects(mapMarkup.execute(args({ purpose: 'detection', items: [item({ kind: 'detection' })] }), execution), /INVALID_PROPOSAL/)
  await assert.rejects(mapMarkup.execute(args({ items: [item({ pixelGeometry: { type: 'point', point: [-1, 100] } })] }), execution), /INVALID_PROPOSAL|outside/)
  assert.deepEqual(rig.state(session).visualProposals, [])
  assert.deepEqual(rig.state(session).pendingCalls.map(entry => entry.callId), ['markup-call'])
  void call
})

test('accepted candidates fold once with durable image evidence and independent WGS84 geometry', async t => {
  const { rig, session } = await rigWithObservation()
  t.after(async () => { await rig.dispose() })
  const call = rig.call(session, 'markup-call', 'map_markup', args())
  const value = await mapMarkup.execute(args(), execWithModel(rig, session, 'markup-call'))
  assert.equal(value.candidates, 1)
  assert.equal(value.status, 'proposed')
  assert.equal(value.must_confirm, false)
  assert.deepEqual(value.proposals[0].geometry, { type: 'Point', coordinates: [102, 39.8] })
  assert.equal(value.meta.kind, 'map-visual-proposal')
  assert.equal(value.meta.schemaVersion, 1)
  assert.equal(value.meta.record.proposals[0].modelProvider, 'fixture-provider')
  assert.equal(value.meta.record.proposals[0].observationAttachmentSha256, pngSha256)
  assert.deepEqual(value.meta.record.proposals[0].geometry, { type: 'Point', coordinates: [102, 39.8] })
  assert.equal(rig.state(session).revision, 0, 'the tool result is not a map change until it is accepted')
  rig.result(session, call, { meta: value.meta })
  const state = rig.state(session)
  assert.equal(state.revision, 1)
  assert.equal(state.visualProposals.length, 1)
  assert.equal(state.visualProposals[0].status, 'proposed')
  assert.equal(state.layers[0].id, 'visual-proposals')
  assert.equal(state.layers[0].data.features[0].geometry.coordinates[0], 102)
  const wire = mapContainerProjectionDefinition.wire.view(state)
  assert.equal(wire.visualProposals.length, 1)
  const repeat = rig.result(session, call, { meta: value.meta })
  void repeat
  const replayed = rig.state(session)
  assert.equal(replayed.revision, state.revision)
  assert.deepEqual(replayed.visualProposals, state.visualProposals)
  assert.deepEqual(replayed.layers, state.layers)
  assert.deepEqual(replayed.diagnostics, state.diagnostics, 'an unpaired duplicate result writes nothing')
})

test('an agent applies and rejects visual candidates without recording user confirmation', async t => {
  const { rig, session } = await rigWithObservation()
  t.after(async () => rig.dispose())
  const markupArgs = args({ items: [item(), item({ category: 'shed', pixelGeometry: { type: 'point', point: [250, 100] } })] })
  const markupCall = rig.call(session, 'two-candidates', 'map_markup', markupArgs)
  const markup = await mapMarkup.execute(markupArgs, execWithModel(rig, session, markupCall.data.callId))
  rig.result(session, markupCall, { meta: markup.meta })
  const userFeatureId = 'ann-0123456789abcdef01234567'
  const firstAt = '2026-11-14T00:00:00.000Z'
  const userChange = (operationId, change, at = firstAt) => {
    const record = { operationId, targetRevision: rig.state(session).revision, sessionId: session.id, at, featureId: userFeatureId, change }
    session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{
      id: `${operationId}-message`, role: 'user', source: { kind: MAP_USER_CHANGE_SOURCE, form: 'notice', summary: 'annotation' },
      content: [{ type: 'text', text: userChangeNoticeText('annotation', record) }],
    }] })
  }
  userChange('user-create-before-agent', { op: 'annotation-create', geometry: { type: 'Point', coordinates: [116, 39] }, name: 'User site' })
  userChange('user-style-before-agent', { op: 'annotation-update', featureId: userFeatureId, expectedUpdatedAt: firstAt, symbol: SYMBOL_PRESETS[0].symbol }, '2026-11-14T00:01:00.000Z')
  const commit = async (callId, change) => {
    const input = { expected_revision: rig.state(session).revision, change }
    const call = rig.call(session, callId, 'map_edit_annotation', input)
    const result = await mapEditAnnotation.execute(input, rig.exec(session, { callId }))
    rig.result(session, call, { meta: result.meta })
    return result
  }
  await commit('agent-style-layer', { op: 'annotation-layer-style', symbol: SYMBOL_PRESETS[0].symbol })
  const previousLayer = rig.state(session).layers.find(layer => layer.id === 'user-annotations')
  const applied = await commit('agent-apply-proposal', { op: 'visual-proposal-apply', proposalId: markup.candidate_ids[0] })
  let state = rig.state(session)
  const annotationLayer = state.layers.find(layer => layer.id === 'user-annotations')
  assert.deepEqual(annotationLayer.symbol, previousLayer.symbol)
  assert.deepEqual(annotationLayer.overrides, previousLayer.overrides)
  assert.equal(state.visualProposals[0].status, 'agent-applied')
  assert.equal(state.visualProposals[0].acceptedFeatureId, applied.feature_id)
  assert.equal(state.visualProposals[0].humanEdited, false)
  assert.equal(state.visualProposals[0].reviewedBy, 'agent')
  const feature = annotationLayer.data.features.find(entry => entry.id === applied.feature_id)
  assert.equal(annotationLayer.data.features.find(entry => entry.id === userFeatureId).properties.dshAuthor, 'user')
  assert.equal(feature.properties.dshAuthor, 'agent')
  assert.equal(feature.properties.dshSource, 'visual-proposal')
  assert.equal(state.operations.at(-1).writerId, 'agent')
  const rejected = await commit('agent-reject-proposal', { op: 'visual-proposal-dismiss', proposalId: markup.candidate_ids[1] })
  state = rig.state(session)
  assert.equal(state.visualProposals[1].status, 'agent-dismissed')
  assert.equal(state.visualProposals[1].reviewedBy, 'agent')
  const unpaired = { expected_revision: state.revision, change: { op: 'visual-proposal-dismiss', proposalId: markup.candidate_ids[0] } }
  await assert.rejects(mapEditAnnotation.execute(unpaired, rig.exec(session, { callId: 'unpaired-agent-decision' })), /accepted tool call/)
  const stale = { expected_revision: state.revision - 1, change: { op: 'visual-proposal-dismiss', proposalId: markup.candidate_ids[0] } }
  rig.call(session, 'stale-agent-decision', 'map_edit_annotation', stale)
  await assert.rejects(mapEditAnnotation.execute(stale, rig.exec(session, { callId: 'stale-agent-decision' })), /STALE_OBSERVATION/)
  const wrongCandidate = { expected_revision: state.revision, change: { op: 'visual-proposal-dismiss', proposalId: 'vprop-' + 'f'.repeat(24) } }
  rig.call(session, 'unknown-agent-decision', 'map_edit_annotation', wrongCandidate)
  await assert.rejects(mapEditAnnotation.execute(wrongCandidate, rig.exec(session, { callId: 'unknown-agent-decision' })), /visual-proposal-unknown/)
  await commit('agent-undo-dismissal', { op: 'annotation-undo', operationId: rejected.operation_id })
  assert.equal(rig.state(session).visualProposals[1].status, 'proposed')
  await commit('agent-undo-application', { op: 'annotation-undo', operationId: applied.operation_id })
  state = rig.state(session)
  assert.equal(state.visualProposals[0].status, 'proposed')
  assert.deepEqual(state.layers.find(layer => layer.id === 'user-annotations'), previousLayer)
  const restored = rig.ctx.sessionProjections.restore({}, session.snapshotEvents(), 0, session.header, session.inheritedEventCount)
  assert.deepEqual(restored.checkpoint.mapContainer.val, rig.state(session))
})

test('unknown, cross-session, stale and non-affine observations refuse before any write', async t => {
  const { rig, session } = await rigWithObservation()
  t.after(async () => { await rig.dispose() })
  const foreign = rig.session('other-session')
  const foreignCall = rig.call(foreign, 'foreign-markup', 'map_markup', args())
  await assert.rejects(mapMarkup.execute(args(), execWithModel(rig, foreign, 'foreign-markup')), /UNKNOWN_OBSERVATION/)
  assert.deepEqual(rig.state(foreign).visualProposals, [])
  void foreignCall

  const stale = rig.call(session, 'stale-markup', 'map_markup', args({ observation_id: 'obs-other' }))
  await assert.rejects(mapMarkup.execute(args({ observation_id: 'obs-other' }), execWithModel(rig, session, 'stale-markup')), /UNKNOWN_OBSERVATION/)
  void stale

  const nonAffine = await rigWithObservation({ georeference: { kind: 'none', reason: 'not-2d' } })
  t.after(async () => { await nonAffine.rig.dispose() })
  const nonAffineCall = nonAffine.rig.call(nonAffine.session, 'non-affine', 'map_markup', args())
  await assert.rejects(mapMarkup.execute(args(), execWithModel(nonAffine.rig, nonAffine.session, 'non-affine')), /STALE_OBSERVATION/)
  void nonAffineCall

  const call = rig.call(session, 'bad-image', 'map_markup', args())
  const badImageExecution = execWithModel(rig, session, 'bad-image')
  badImageExecution.agent.ctx = { get: name => name === 'attachments'
    ? { async readImage(ref) { return { ref, data: new Uint8Array([1, 2, 3]) } } }
    : rig.ctx.get(name) }
  await assert.rejects(mapMarkup.execute(args(), badImageExecution), /UNKNOWN_OBSERVATION/)
  assert.deepEqual(rig.state(session).visualProposals, [])
  void call
})

test('3D, outside-map, self-intersecting and oversized candidates leave no residue', async t => {
  const { rig, session } = await rigWithObservation()
  t.after(async () => { await rig.dispose() })
  const cases = [
    args({ items: [item({ pixelGeometry: { type: 'point', point: [900, 100] } })] }),
    args({ items: [item({ pixelGeometry: { type: 'polygon', points: [[200, 100], [300, 200], [300, 100], [200, 200], [200, 100]] } })] }),
    args({ items: new Array(101).fill(item()) }),
    args({ items: [item({ category: 'x'.repeat(513) })] }),
  ]
  for (const [index, candidate] of cases.entries()) {
    const callId = `invalid-${index}`
    rig.call(session, callId, 'map_markup', candidate)
    await assert.rejects(mapMarkup.execute(candidate, execWithModel(rig, session, callId)), /INVALID_PROPOSAL|PROPOSAL_LIMIT/)
  }
  assert.deepEqual(rig.state(session).visualProposals, [])
  assert.deepEqual(rig.state(session).layers.filter(layer => layer.role === 'visual-proposal'), [])
})

test('unknown proposal meta versions stay read-only and old state versions refuse checkpoints', async t => {
  const { rig, session } = await rigWithObservation()
  t.after(async () => { await rig.dispose() })
  const call = rig.call(session, 'unknown-version', 'map_markup', args())
  const value = await mapMarkup.execute(args(), execWithModel(rig, session, 'unknown-version'))
  const before = rig.state(session)
  for (const meta of [
    { ...value.meta, schemaVersion: 2 },
    { ...value.meta, kind: 'map-change' },
    { ...value.meta, record: { ...value.meta.record, proposals: [] } },
  ]) rig.result(session, call, { meta })
  const after = rig.state(session)
  assert.equal(after.revision, before.revision)
  assert.deepEqual(after.visualProposals, [])
  assert.equal(after.diagnostics.at(-1).code, 'unknown-schema-version')
  const registry = rig.ctx.sessionProjections
  const row = registry.checkpoint(session).mapContainer
  assert.deepEqual(registry.viewCheckpoint({ mapContainer: { ver: 14, seq: row.seq, val: row.val } }), {})
})
