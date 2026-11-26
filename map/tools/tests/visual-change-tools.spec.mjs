/**
 * V7 dual-image fixtures: every comparison comes from two accepted
 * observation records in one session, two saved PNG attachments, and two
 * independently verified fixed releases. The candidate batch reads the same
 * pair, folds once, and remains unconfirmed until a user change settles it.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import { waybackDescriptor } from '../../map-container/src/wayback.ts'
import { parseBasemapSelection } from '../../layers/src/basemap.ts'
import { buildMapChangeMeta, buildMapObservationMeta, expectedObservationSources, observationCompositionOf } from '../../map-container/src/index.ts'
import { visualChangePairingCode } from '../../map-container/src/comparison-protocol.ts'
import { mapCompareViews, mapMarkChanges, COMPARE_DESCRIPTION, MARK_CHANGES_DESCRIPTION } from '../src/visual-change-tools.ts'
import { mapEditAnnotation } from '../src/annotation-tools.ts'

const sha = value => createHash('sha256').update(value).digest('hex')
const realPng = async (red, green, blue) => (await sharp({
  create: { width: 8, height: 4, channels: 3, background: { r: red, g: green, b: blue } },
}).png().toBuffer()).toString('base64')
const camera = {
  center: [104.9, 36.4], extent: [100, 32, 109.8, 40.8], wkid: 4326,
  scale: 50000, zoom: 6, rotation: 0, mode: 'map', padding: [0, 0, 0, 0],
}
const georeference = {
  kind: 'affine-2d', coefficients: [0.01, 0, 100, 0, -0.01, 40.8], wkid: 4326, maxResidualCssPx: 0,
}
const composition = observationCompositionOf([])

const release = (releaseId, publishedAt) => {
  const descriptor = waybackDescriptor({
    releaseId, itemId: `${releaseId}`.padEnd(32, '0'),
    title: `World Imagery (Wayback ${publishedAt.slice(0, 10)})`,
    publishedAt, layerIdentifier: `WB_${releaseId}_R01`, acquiredAt: null,
  })
  const parsed = parseBasemapSelection({ schemaVersion: 1, basemap: descriptor, labels: null })
  assert.equal(parsed.ok, true)
  return parsed.value
}

const beforeSelection = release(10, '2014-02-20T00:00:00.000Z')
const afterSelection = release(32246, '2026-01-26T00:00:00.000Z')
const attachment = (id, bytes) => ({
  attachmentId: id, mediaType: 'image/png', bytes: bytes.length,
  width: 800, height: 600, sha256: sha(bytes),
})

function observation(id, callId, requestSeq, selection, bytes, overrides = {}) {
  return {
    observationId: id, callId, requestSeq, mapRevision: 0,
    viewId: 'view-1', generation: 1, cameraEpoch: 0, gestureEpoch: 0,
    attachment: attachment(`att-${id}`, bytes),
    capturedAt: '2026-11-10T00:00:00.000Z',
    imageSize: { width: 800, height: 600 },
    mapContentRect: { x: 0, y: 0, width: 800, height: 600 },
    cssViewSize: { width: 800, height: 600 },
    camera, georeference,
    sources: expectedObservationSources([], selection).sources,
    basemap: selection,
    includedOverlays: ['attribution'], limitations: [],
    composition,
    ...overrides,
  }
}

let beforePng
let afterPng
let before
let after

async function prepareImages() {
  if (beforePng !== undefined) return
  beforePng = Buffer.from(await realPng(15, 20, 25), 'base64')
  afterPng = Buffer.from(await realPng(80, 30, 20), 'base64')
  before = observation('obs-before', 'obs-before', 3, beforeSelection, beforePng)
  after = observation('obs-after', 'obs-after', 5, afterSelection, afterPng)
}

async function rigWithPair(t, { mutate = () => {}, withSources = true, observationOverrides = {}, unverified = false } = {}) {
  await prepareImages()
  const rig = await mapRig({ mapConfig: {
    observation: { capturePolicy: 'allow' },
    sources: { presets: { 'esri-world-imagery': { automatedMapUse: 'allowed' }, 'esri-wayback': { automatedMapUse: 'allowed' } } },
  } })
  t.after(async () => rig.dispose())
  const session = rig.session('visual-change-pair')
  const acquisitionCalls = []
  for (const [callId, record, selection] of [['obs-before', before, beforeSelection], ['obs-after', after, afterSelection]]) {
    const releaseId = Number(selection.basemap.release.version)
    const basemapCall = rig.call(session, `basemap-${callId}`, 'map_set_basemap', { source_id: 'esri-wayback', release_id: releaseId })
    acquisitionCalls.push({ name: basemapCall.data.name, args: basemapCall.data.arguments, selection })
    rig.result(session, basemapCall, { meta: buildMapChangeMeta(basemapCall.seq, rig.state(session).revision, { op: 'set-basemap', selection }) })
    const call = rig.call(session, callId, 'map_observe', {})
    acquisitionCalls.push({ name: call.data.name, args: call.data.arguments })
    const request = rig.state(session).observationRequest
    const overrides = callId === 'obs-after' ? observationOverrides : {}
    const policySources = unverified ? record.sources.map(source => ({ ...source, policy: 'unverified' })) : record.sources
    rig.result(session, call, { meta: buildMapObservationMeta({ ...record, sources: policySources, ...overrides, requestSeq: request.requestSeq, mapRevision: request.revision }) })
  }
  assert.deepEqual(acquisitionCalls.map(call => call.name), [
    'map_set_basemap', 'map_observe', 'map_set_basemap', 'map_observe',
  ])
  assert.deepEqual(acquisitionCalls.filter(call => call.name === 'map_set_basemap').map(call => call.selection), [
    beforeSelection, afterSelection,
  ])
  assert.deepEqual(acquisitionCalls.filter(call => call.name === 'map_set_basemap').map(call => JSON.parse(call.args).release_id), [
    10, 32246,
  ])
  const stored = new Map([
    [before.attachment.attachmentId, beforePng],
    [after.attachment.attachmentId, afterPng],
  ])
  const sourceService = rig.ctx.get('mapSourceService')
  const sourceFace = withSources ? {
    ...sourceService,
    verifySource() {},
    catalog: {
      ...sourceService.catalog,
      verifySource(source) {
        if (withSources) assert.ok([beforeSelection.basemap, afterSelection.basemap].some(entry => JSON.stringify(entry) === JSON.stringify(source)))
      },
      verifyWaybackPolicy(source) {
        if (withSources) assert.ok([beforeSelection.basemap, afterSelection.basemap].some(entry => JSON.stringify(entry) === JSON.stringify(source)))
      },
      verifyCachedWaybackSource(source) {
        if (withSources) assert.ok([beforeSelection.basemap, afterSelection.basemap].some(entry => JSON.stringify(entry) === JSON.stringify(source)))
      },
    },
  } : undefined
  const baseCtx = rig.ctx
  const faceCtx = { get: name => name === 'mapSourceService'
    ? sourceFace ?? { ...sourceService, verifySource() {}, catalog: sourceService.catalog }
    : baseCtx.get(name) }
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    async readImage(ref, signal) {
      signal?.throwIfAborted()
      const data = stored.get(ref.attachmentId)
      if (data === undefined) throw new Error('missing attachment')
      return { ref, data: new Uint8Array(data) }
    },
  }))
  mutate({ rig, session, stored })
  return { rig, session, stored, faceCtx }
}

function execOf({ rig, session, faceCtx }, callId, options = {}) {
  const execution = rig.exec(session, { callId, ...(options.signal === undefined ? {} : { signal: options.signal }) })
  return {
    ...execution,
    agent: {
      ...execution.agent,
      ctx: faceCtx,
      model: { current: () => ({ provider: 'fixture-provider', model: 'vision-model' }) },
    },
  }
}

function compareArgs(overrides = {}) {
  return { before_observation_id: before.observationId, after_observation_id: after.observationId, ...overrides }
}

const item = (overrides = {}) => ({
  kind: 'appeared', category: 'building', note: 'new roof', confidence: 'likely',
  pixelGeometry: { type: 'point', point: [200, 100] }, ...overrides,
})

test('the two tools pin their authored model-facing descriptions', () => {
  assert.match(mapCompareViews.description, /Compare two saved map_observe images/)
  assert.match(mapMarkChanges.description, /Apply or dismiss a candidate with map_edit_annotation/)
  assert.equal(COMPARE_DESCRIPTION, mapCompareViews.description)
  assert.equal(MARK_CHANGES_DESCRIPTION, mapMarkChanges.description)
})

test('candidate ceiling has one source across native, MCP, and durable validation', async () => {
  const { MAX_VISUAL_CHANGE_CANDIDATES } = await import('../../map-container/src/comparison-limits.ts')
  const { mapMarkChangesInput } = await import('../../arcgis-mcp/src/visual-change-input.ts')
  assert.equal(MAX_VISUAL_CHANGE_CANDIDATES, 100)
  assert.match(mapMarkChanges.description, new RegExp(`up to ${MAX_VISUAL_CHANGE_CANDIDATES}`))
  assert.match(mapMarkChanges.parameters.properties.items.description, new RegExp(`0\\.\\.${MAX_VISUAL_CHANGE_CANDIDATES}`))
  assert.equal(mapMarkChangesInput.shape.items.safeParse(Array.from({ length: MAX_VISUAL_CHANGE_CANDIDATES }, () => ({}))).success, true)
  assert.equal(mapMarkChangesInput.shape.items.safeParse(Array.from({ length: MAX_VISUAL_CHANGE_CANDIDATES + 1 }, () => ({}))).success, false)
})

test('map_compare_views refuses without an accepted call and without two versioned observations', async t => {
  await prepareImages()
  const pair = await rigWithPair(t)
  await assert.rejects(
    mapCompareViews.execute(compareArgs(), execOf(pair, 'unpaired')),
    /INVALID_ARGUMENT: map_compare_views requires its accepted tool\/call/,
  )
  const call = pair.rig.call(pair.session, 'compare-1', 'map_compare_views', compareArgs())
  await assert.rejects(
    mapCompareViews.execute(compareArgs({ after_observation_id: 'unknown' }), execOf(pair, 'compare-1')),
    /UNKNOWN_OBSERVATION/,
  )
  assert.deepEqual(pair.rig.state(pair.session).comparisons, [])
  void call
})

test('a verified pair renders two image blocks and folds a read-only comparison record', async t => {
  await prepareImages()
  const pair = await rigWithPair(t)
  const call = pair.rig.call(pair.session, 'compare-1', 'map_compare_views', compareArgs())
  const result = await mapCompareViews.execute(compareArgs({ focus: 'roof' }), execOf(pair, 'compare-1'))
  assert.equal(result.meta.kind, 'map-visual-comparison')
  assert.equal(result.meta.schemaVersion, 2)
  assert.equal(result.meta.record.callId, 'compare-1')
  assert.equal(result.meta.record.callSeq, call.seq)
  assert.equal(result.meta.record.focus, 'roof')
  assert.equal(result.meta.record.beforeAttachmentSha256, sha(beforePng))
  assert.equal(result.meta.record.afterAttachmentSha256, sha(afterPng))
  assert.equal(result.meta.record.beforeRelease.releaseId, '10')
  assert.equal(result.meta.record.afterRelease.releaseId, '32246')
  assert.equal(result.meta.record.comparability, 'limited')
  assert.equal(result.meta.record.sourceVersion, 3)
  const rendered = mapCompareViews.output.render(compareArgs(), result)
  const images = rendered.filter(block => block.type === 'image')
  assert.deepEqual(images.map(block => block.attachment.attachmentId),
    [before.attachment.attachmentId, after.attachment.attachmentId])
  assert.deepEqual(images.map(block => ({
    bytes: block.attachment.bytes, width: block.attachment.width, height: block.attachment.height,
  })), [before.attachment, after.attachment].map(attachment => ({
    bytes: attachment.bytes, width: attachment.width, height: attachment.height,
  })))
  const text = rendered.find(block => block.type === 'text').text
  assert.equal(text.includes('"meta"'), false)
  assert.equal(text.includes('"before_image"'), false)
  assert.equal(text.includes('"after_image"'), false)
  assert.equal(JSON.parse(text).image_order.length, 2)
  const revision = pair.rig.state(pair.session).revision
  pair.rig.result(pair.session, call, { meta: result.meta })
  const state = pair.rig.state(pair.session)
  assert.equal(state.revision, revision, 'comparison never writes a map revision')
  assert.equal(state.comparisons.length, 1)
  assert.deepEqual(state.comparisons[0], result.meta.record)
  assert.equal(mapCompareViews.output.presentationMeta(compareArgs(), result).kind, 'map-visual-comparison')
})

test('unverified source policies do not prevent a fixed-release comparison from folding', async t => {
  await prepareImages()
  const pair = await rigWithPair(t, { unverified: true })
  const call = pair.rig.call(pair.session, 'compare-unverified', 'map_compare_views', compareArgs())
  const result = await mapCompareViews.execute(compareArgs(), execOf(pair, call.data.callId))
  pair.rig.result(pair.session, call, { meta: result.meta })
  assert.equal(pair.rig.state(pair.session).comparisons.length, 1)
  assert.equal(pair.rig.state(pair.session).observationHistory.every(record => record.sources[0].policy === 'unverified'), true)
})

test('comparison refuses stale bytes, same-image releases, reverse dates, and source drift', async t => {
  await prepareImages()
  for (const scenario of ['stored-byte', 'same-image', 'reverse', 'source']) {
    let mutate = () => {}
    let overrides = {}
    let observationOverrides = {}
    if (scenario === 'stored-byte') mutate = ({ stored }) => stored.set(after.attachment.attachmentId, beforePng)
    if (scenario === 'same-image') overrides = { after_observation_id: before.observationId }
    if (scenario === 'reverse') overrides = { before_observation_id: after.observationId, after_observation_id: before.observationId }
    if (scenario === 'source') observationOverrides = { sources: after.sources.map((source, index) => index === 0 ? { ...source, version: '9' } : source) }
    const pair = await rigWithPair(t, { mutate, observationOverrides })
    const call = pair.rig.call(pair.session, `compare-${scenario}`, 'map_compare_views', compareArgs(overrides))
    await assert.rejects(
      mapCompareViews.execute(compareArgs(overrides), execOf(pair, `compare-${scenario}`)),
      /UNKNOWN_OBSERVATION|COMPARISON_REFUSED|SOURCE_CHANGED/,
    )
    assert.deepEqual(pair.rig.state(pair.session).comparisons, [])
    void call
  }
})

test('an agent applies and undoes a visual-change candidate with truthful attribution', async t => {
  const pair = await rigWithPair(t, { unverified: true })
  const compareCall = pair.rig.call(pair.session, 'agent-compare', 'map_compare_views', compareArgs())
  const compared = await mapCompareViews.execute(compareArgs(), execOf(pair, compareCall.data.callId))
  pair.rig.result(pair.session, compareCall, { meta: compared.meta })
  const markArgs = { comparison_id: compared.comparison_id, items: [item()] }
  const markCall = pair.rig.call(pair.session, 'agent-change', 'map_mark_changes', markArgs)
  const marked = await mapMarkChanges.execute(markArgs, execOf(pair, markCall.data.callId))
  pair.rig.result(pair.session, markCall, { meta: marked.meta })
  const commit = async (callId, change) => {
    const input = { expected_revision: pair.rig.state(pair.session).revision, change }
    const call = pair.rig.call(pair.session, callId, 'map_edit_annotation', input)
    const result = await mapEditAnnotation.execute(input, pair.rig.exec(pair.session, { callId }))
    pair.rig.result(pair.session, call, { meta: result.meta })
    return result
  }
  const applied = await commit('apply-change', { op: 'visual-change-apply', changeId: marked.candidate_ids[0] })
  let state = pair.rig.state(pair.session)
  assert.equal(state.visualChanges[0].status, 'agent-applied')
  assert.equal(state.visualChanges[0].reviewedBy, 'agent')
  const feature = state.layers.find(layer => layer.id === 'user-annotations').data.features[0]
  assert.equal(feature.properties.dshAuthor, 'agent')
  assert.equal(feature.properties.dshSource, 'visual-change')
  await commit('undo-change', { op: 'annotation-undo', operationId: applied.operation_id })
  state = pair.rig.state(pair.session)
  assert.equal(state.visualChanges[0].status, 'proposed')
  assert.equal(state.layers.some(layer => layer.id === 'user-annotations'), false)
  const restored = pair.rig.ctx.sessionProjections.restore({}, pair.session.snapshotEvents(), 0,
    pair.session.header, pair.session.inheritedEventCount)
  assert.deepEqual(restored.checkpoint.mapContainer.val, state)
})

test('a comparison seen by another call cannot be replayed through a forged pending identity', async t => {
  await prepareImages()
  const pair = await rigWithPair(t)
  const first = pair.rig.call(pair.session, 'compare-legit', 'map_compare_views', compareArgs())
  const result = await mapCompareViews.execute(compareArgs(), execOf(pair, 'compare-legit'))
  pair.rig.result(pair.session, first, { meta: result.meta })
  const second = pair.rig.call(pair.session, 'compare-replay', 'map_compare_views', compareArgs())
  pair.rig.result(pair.session, second, { meta: result.meta })
  assert.equal(pair.rig.state(pair.session).comparisons.length, 1)
  assert.match(pair.rig.state(pair.session).diagnostics.map(entry => entry.code).join(','), /comparison-pairing/)
})

test('known-change, no-change and not-comparable flows settle only their declared evidence', async t => {
  await prepareImages()
  const known = await rigWithPair(t)
  const knownCompareCall = known.rig.call(known.session, 'known-compare', 'map_compare_views', compareArgs())
  const knownComparison = await mapCompareViews.execute(compareArgs(), execOf(known, 'known-compare'))
  known.rig.result(known.session, knownCompareCall, { meta: knownComparison.meta })
  const knownCall = known.rig.call(known.session, 'known-changes', 'map_mark_changes', { comparison_id: knownComparison.comparison_id, items: [item()] })
  const knownResult = await mapMarkChanges.execute({ comparison_id: knownComparison.comparison_id, items: [item()] }, execOf(known, 'known-changes'))
  known.rig.result(known.session, knownCall, { meta: knownResult.meta })
  assert.equal(knownResult.candidates, 1)
  assert.equal(known.rig.state(known.session).visualChanges.length, 1)

  const empty = await rigWithPair(t)
  const emptyCompareCall = empty.rig.call(empty.session, 'empty-compare', 'map_compare_views', compareArgs())
  const emptyComparison = await mapCompareViews.execute(compareArgs(), execOf(empty, 'empty-compare'))
  empty.rig.result(empty.session, emptyCompareCall, { meta: emptyComparison.meta })
  const emptyCall = empty.rig.call(empty.session, 'empty-changes', 'map_mark_changes', {
    comparison_id: emptyComparison.comparison_id, items: [], limitations: 'No visible change is supported by these two images.',
  })
  const emptyArgs = { comparison_id: emptyComparison.comparison_id, items: [], limitations: 'No visible change is supported by these two images.' }
  const emptyResult = await mapMarkChanges.execute(emptyArgs, execOf(empty, 'empty-changes'))
  empty.rig.result(empty.session, emptyCall, { meta: emptyResult.meta })
  assert.equal(emptyResult.candidates, 0)
  assert.equal(emptyResult.must_confirm, false)
  assert.deepEqual(emptyResult.proposals, [])
  assert.equal(empty.rig.state(empty.session).visualChanges.length, 0)
  assert.match(emptyResult.meta.record.limitations.join('\n'), /No visible change/)

  const drifted = await rigWithPair(t, { observationOverrides: { camera: { ...camera, center: [105, 36.4] } } })
  const driftedCall = drifted.rig.call(drifted.session, 'drifted-compare', 'map_compare_views', compareArgs())
  await assert.rejects(
    mapCompareViews.execute(compareArgs(), execOf(drifted, 'drifted-compare')),
    /COMPARISON_REFUSED/,
  )
  assert.deepEqual(drifted.rig.state(drifted.session).comparisons, [])
  assert.deepEqual(drifted.rig.state(drifted.session).visualChanges, [])
  void driftedCall
})

test('map_mark_changes folds one bounded batch and refuses an unknown comparison or an unpaired result', async t => {
  await prepareImages()
  const pair = await rigWithPair(t)
  const compareCall = pair.rig.call(pair.session, 'compare-1', 'map_compare_views', compareArgs())
  const comparison = await mapCompareViews.execute(compareArgs(), execOf(pair, 'compare-1'))
  pair.rig.result(pair.session, compareCall, { meta: comparison.meta })
  const args = { comparison_id: comparison.comparison_id, items: [item()] }

  await assert.rejects(
    mapMarkChanges.execute(args, execOf(pair, 'unpaired')),
    /INVALID_ARGUMENT: map_mark_changes requires its accepted tool\/call/,
  )
  const unknown = pair.rig.call(pair.session, 'unknown-comparison', 'map_mark_changes', args)
  await assert.rejects(
    mapMarkChanges.execute({ ...args, comparison_id: 'vcompare-000000000000000000000000' }, execOf(pair, 'unknown-comparison')),
    /UNKNOWN_COMPARISON/,
  )
  assert.equal(pair.rig.state(pair.session).visualChanges.length, 0)
  void unknown

  const call = pair.rig.call(pair.session, 'changes-1', 'map_mark_changes', args)
  const result = await mapMarkChanges.execute(args, execOf(pair, 'changes-1'))
  assert.equal(result.candidates, 1)
  assert.equal(result.must_confirm, false)
  assert.deepEqual(result.proposals[0].geometry, result.meta.record.changes[0].geometry)
  assert.equal(result.meta.kind, 'map-visual-change')
  assert.equal(result.meta.schemaVersion, 2)
  assert.equal(result.meta.record.changes[0].kind, 'appeared')
  assert.equal(result.meta.record.changes[0].comparisonId, comparison.comparison_id)
  assert.equal(result.meta.record.changes[0].beforeAttachmentSha256, sha(beforePng))
  assert.equal(result.meta.record.changes[0].afterAttachmentSha256, sha(afterPng))
  assert.equal(result.meta.record.changes[0].beforeObservationId, before.observationId)
  assert.equal(result.meta.record.changes[0].afterObservationId, after.observationId)
  assert.deepEqual(result.meta.record.changes[0].geometry, { type: 'Point', coordinates: [102, 39.8] })
  assert.equal(result.meta.record.changes[0].status, 'proposed')
  assert.equal(visualChangePairingCode(pair.rig.state(pair.session), result.meta, 'changes-1', call.seq, []), null)
  const beforeChanges = pair.rig.state(pair.session).revision
  pair.rig.result(pair.session, call, { meta: result.meta })
  const state = pair.rig.state(pair.session)
  assert.equal(state.revision, beforeChanges + 1)
  assert.equal(state.visualChanges.length, 1)
  assert.equal(state.layers[0].role, 'visual-change')
  const rendered = mapMarkChanges.output.render(args, result).find(block => block.type === 'text').text
  assert.equal(rendered.includes('"meta"'), false)
  assert.equal(mapMarkChanges.output.presentationMeta(args, result).kind, 'map-visual-change')
})

test('cancellation, forged bytes, uncomparable pairs and duplicate batches write no candidates', async t => {
  await prepareImages()
  const pair = await rigWithPair(t)
  const compareCall = pair.rig.call(pair.session, 'compare-1', 'map_compare_views', compareArgs())
  const comparison = await mapCompareViews.execute(compareArgs(), execOf(pair, 'compare-1'))
  pair.rig.result(pair.session, compareCall, { meta: comparison.meta })
  const args = { comparison_id: comparison.comparison_id, items: [item()] }
  const controller = new AbortController()
  controller.abort(new DOMException('cancelled', 'AbortError'))
  const cancelled = pair.rig.call(pair.session, 'changes-cancel', 'map_mark_changes', args)
  await assert.rejects(
    mapMarkChanges.execute(args, execOf(pair, 'changes-cancel', { signal: controller.signal })),
    /CANCELLED/,
  )
  void cancelled
  pair.stored.set(after.attachment.attachmentId, beforePng)
  const forged = pair.rig.call(pair.session, 'changes-forged', 'map_mark_changes', args)
  await assert.rejects(
    mapMarkChanges.execute(args, execOf(pair, 'changes-forged')),
    /UNKNOWN_OBSERVATION/,
  )
  void forged
  pair.stored.set(after.attachment.attachmentId, afterPng)
  const badItem = pair.rig.call(pair.session, 'changes-bad-item', 'map_mark_changes', args)
  await assert.rejects(
    mapMarkChanges.execute({ ...args, items: [item({ confidence: 0.9 })] }, execOf(pair, 'changes-bad-item')),
    /INVALID_PROPOSAL/,
  )
  void badItem
  const final = pair.rig.state(pair.session)
  assert.deepEqual(final.visualChanges, [])
  assert.equal(final.revision, 2)
})
