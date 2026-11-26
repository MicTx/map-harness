/**
 * Stream tool integration fixtures over the REAL catalog service, projection,
 * and `spatial-realtime` package: register a scenario resource → `stream_open`
 * binds the exact version into a realtime workbench layer → `stream_advance`
 * replays the controlled source (duplicates drop, out-of-order lands by event
 * time, the watermark closes windows, the late arrival appends a revision,
 * the offline batch counts the disconnect) → `stream_pause`/`stream_resume`
 * gate it → `stream_materialize` publishes the fixed window set as an
 * immutable, digest-pinned artifact through the accepted-call pairing and
 * flips the layer to its final state. Cancellations and refusals never fold
 * and never publish.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import { buildMapChangeMeta } from '../../map-container/src/protocol.ts'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { buildMaterializedExport, decodeCheckpoint, resumeCheckpoint, encodeCheckpoint } from '../../spatial-realtime/src/index.ts'
import { catalogRegister } from '../src/catalog-tools.ts'
import { streamOpen, streamAdvance, streamPause, streamResume, streamMaterialize } from '../src/stream-tools.ts'

/** The canonical scenario as a wire resource: duplicates, out-of-order, late, offline. */
function scenarioCollection() {
  const rows = [
    { batch: 0, delivery: 1, event_id: 'evt-a-1', event_time_ms: 1_000, lon: 116.4, lat: 39.9, value: 3 },
    // The at-least-once re-delivery: same eventId (dedup applies), a distinct
    // wire record (the delivery marker keeps the features distinguishable).
    { batch: 0, delivery: 2, event_id: 'evt-a-1', event_time_ms: 1_000, lon: 116.4, lat: 39.9, value: 3 },
    { batch: 1, delivery: 1, event_id: 'evt-b-2', event_time_ms: 25_000, lon: 116.41, lat: 39.91, value: 4 },
    { batch: 1, delivery: 2, event_id: 'evt-b-1', event_time_ms: 11_000, lon: 116.4, lat: 39.9, value: 5 },
    { batch: 2, delivery: 1, event_id: 'evt-late-1', event_time_ms: 11_500, lon: 116.42, lat: 39.92, value: 7 },
    { batch: 3, delivery: 1, offline: true, event_id: 'offline-marker', event_time_ms: 0, lon: 116.4, lat: 39.9, value: 0 },
  ]
  return {
    type: 'FeatureCollection',
    features: rows.map(properties => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [properties.lon, properties.lat] },
      properties,
    })),
  }
}

/** A scenario whose batch indices skip 1: a source sequencing defect. */
function gappedScenarioCollection() {
  const rows = [
    { batch: 0, event_id: 'evt-x', event_time_ms: 1_000, lon: 116.4, lat: 39.9, value: 1 },
    { batch: 2, event_id: 'evt-y', event_time_ms: 2_000, lon: 116.4, lat: 39.9, value: 2 },
  ]
  return {
    type: 'FeatureCollection',
    features: rows.map(properties => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [properties.lon, properties.lat] },
      properties,
    })),
  }
}

async function streamRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `map-stream-${label}-`))
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: join(dir, 'catalog') })
  let callCounter = 0
  const sessions = new Map()
  function sessionOf_(id) {
    if (!sessions.has(id)) sessions.set(id, rig.session(id))
    return sessions.get(id)
  }
  return {
    dir,
    rig,
    sessionOf: sessionOf_,
    async register(name, collection) {
      const path = join(dir, `${name}.geojson`)
      writeFileSync(path, JSON.stringify(collection))
      const session = sessionOf_('workbench')
      const callId = `reg-${name}-${callCounter += 1}`
      rig.call(session, callId, 'catalog_register', { path, name })
      const { resource } = await catalogRegister.execute({ path, name }, rig.exec(session, { callId }))
      return resource
    },
    /** Prepare an accepted tool/call and run one stream tool against it; folds the returned meta like the loop does. */
    async run(session, tool, args, { fold = true, callId = `t-${callCounter += 1}`, signal } = {}) {
      const call = rig.call(session, callId, tool.name, args)
      const result = await tool.execute(args, rig.exec(session, { callId, signal }))
      if (fold && result.meta !== undefined) rig.result(session, call, { meta: result.meta })
      return { result, seq: call.seq }
    },
    streamLayer(session, streamId = 'city-stream') {
      return rig.state(session).layers.find(entry => entry.id === streamId)
    },
    async dispose() {
      await rig.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const OPEN_ARGS = {
  scenario_ref: 'res-stream-demo@v1',
  stream_id: 'city-stream',
  window_ms: 10_000,
  lateness_ms: 5_000,
}

test('stream_open binds the exact scenario version and folds the realtime workbench layer', async () => {
  const env = await streamRig('open')
  try {
    const resource = await env.register('stream-demo', scenarioCollection())
    const session = env.sessionOf('workbench')
    const { result } = await env.run(session, streamOpen, { ...OPEN_ARGS, scenario_ref: resource.ref })
    assert.equal(result.stream_id, 'city-stream')
    assert.equal(result.mode, 'realtime')
    assert.deepEqual(result.scenario, { ref: resource.ref, revision: resource.contentDigest, batches: 4 })
    assert.equal(result.status.watermark_ms, null, 'no watermark before the first admitted event')
    assert.ok(result.limitations.some(text => text.includes('pull-based')))

    const layer = env.streamLayer(session)
    assert.ok(layer, 'the workbench folded as a layer')
    assert.equal(layer.stream.mode, 'realtime')
    assert.equal(layer.stream.scenarioRef, resource.ref)
    assert.equal(layer.stream.scenarioRevision, resource.contentDigest)
    assert.equal(layer.resourceRef, resource.ref, 'the layer cites the bound scenario version')
    assert.equal(layer.stream.revision, 0)
  } finally {
    await env.dispose()
  }
})

test('stream_open refuses a scenario resource with broken batch sequencing before any fold', async () => {
  const env = await streamRig('badscenario')
  try {
    const resource = await env.register('stream-bad', gappedScenarioCollection())
    const session = env.sessionOf('workbench')
    await assert.rejects(
      env.run(session, streamOpen, { ...OPEN_ARGS, scenario_ref: resource.ref }),
      /scenario resource rejected.*contiguous/,
    )
    assert.equal(env.rig.state(session).layers.length, 0)
  } finally {
    await env.dispose()
  }
})

test('stream_advance replays duplicates, out-of-order, closure, late revision, and disconnect into one folded summary', async () => {
  const env = await streamRig('advance')
  try {
    const resource = await env.register('stream-demo', scenarioCollection())
    const session = env.sessionOf('workbench')
    await env.run(session, streamOpen, { ...OPEN_ARGS, scenario_ref: resource.ref })
    const { result } = await env.run(session, streamAdvance, { stream_id: 'city-stream', steps: 3 })
    assert.equal(result.steps_run, 3)
    assert.equal(result.totals.admitted, 4, 'one wire event of the duplicate batch plus batch 1 and 2')
    assert.equal(result.totals.duplicates_dropped, 1, 'the re-delivered evt-a-1 dropped')
    assert.equal(result.totals.windows_closed, 1, 'the 0..10s window closed behind the watermark')
    assert.equal(result.totals.windows_revised, 1, 'the late arrival revised the closed 10..20s window')
    assert.equal(result.revision, 2)
    assert.equal(result.status.watermark_ms, 20_000)

    const layer = env.streamLayer(session)
    assert.equal(layer.stream.watermarkMs, 20_000, 'the watermark stays visible in the record')
    assert.equal(layer.stream.lateRevisions, 1, 'the late revision stays visible in the record')
    assert.equal(layer.stream.duplicatesDropped, 1)
    assert.equal(layer.stream.revision, 2)
    // The late-revised window renders with its revision-2 aggregate.
    const revised = layer.data.features.find(feature => feature.properties.window_start_ms === 10_000)
    assert.equal(revised.properties.revision, 2)
    assert.equal(revised.properties.count, 2)
    assert.equal(revised.properties.status, 'revised')

    // The fourth batch is the offline disconnect: counted, nothing moves.
    const offline = await env.run(session, streamAdvance, { stream_id: 'city-stream', steps: 1 })
    assert.equal(offline.result.totals.offline_batches, 1)
    assert.equal(env.streamLayer(session).stream.offlineBatches, 1)
  } finally {
    await env.dispose()
  }
})

test('pause gates advance with a named conflict and resume releases the frozen cursor', async () => {
  const env = await streamRig('pause')
  try {
    const resource = await env.register('stream-demo', scenarioCollection())
    const session = env.sessionOf('workbench')
    await env.run(session, streamOpen, { ...OPEN_ARGS, scenario_ref: resource.ref })
    await env.run(session, streamPause, { stream_id: 'city-stream' })
    assert.equal(env.streamLayer(session).stream.paused, true)
    const before = env.streamLayer(session).stream.checkpoint.cursor
    await assert.rejects(
      env.run(session, streamAdvance, { stream_id: 'city-stream', steps: 1 }),
      error => error.code === 'STREAM_STATE_CONFLICT' && /paused/.test(error.message),
    )
    assert.deepEqual(env.streamLayer(session).stream.checkpoint.cursor, before, 'the refused advance never moved the cursor')
    await env.run(session, streamResume, { stream_id: 'city-stream' })
    assert.equal(env.streamLayer(session).stream.paused, false)
    const resumed = await env.run(session, streamAdvance, { stream_id: 'city-stream', steps: 1 })
    assert.equal(resumed.result.totals.admitted, 1, 'the source continued at the frozen cursor')
  } finally {
    await env.dispose()
  }
})

test('advancing past the exhausted source refuses instead of folding an empty change', async () => {
  const env = await streamRig('exhausted')
  try {
    const resource = await env.register('stream-demo', scenarioCollection())
    const session = env.sessionOf('workbench')
    await env.run(session, streamOpen, { ...OPEN_ARGS, scenario_ref: resource.ref })
    await env.run(session, streamAdvance, { stream_id: 'city-stream', steps: 9 })
    assert.equal(env.streamLayer(session).stream.checkpoint.cursor.batchIndex, 4, 'all four batches consumed')
    const revisionBefore = env.rig.state(session).revision
    await assert.rejects(
      env.run(session, streamAdvance, { stream_id: 'city-stream', steps: 1 }),
      error => error.code === 'STREAM_STATE_CONFLICT' && /exhausted/.test(error.message),
    )
    assert.equal(env.rig.state(session).revision, revisionBefore, 'the refused advance never folded')
  } finally {
    await env.dispose()
  }
})

test('stream_materialize publishes the digest-pinned artifact through the pairing and fixes the layer', async () => {
  const env = await streamRig('materialize')
  try {
    const resource = await env.register('stream-demo', scenarioCollection())
    const session = env.sessionOf('workbench')
    await env.run(session, streamOpen, { ...OPEN_ARGS, scenario_ref: resource.ref })
    await env.run(session, streamAdvance, { stream_id: 'city-stream', steps: 4 })
    const layer = env.streamLayer(session)
    assert.ok(layer.stream.closedWindows >= 2, 'the watermark settled at least two windows')
    const { result, seq } = await env.run(session, streamMaterialize, { stream_id: 'city-stream' })
    assert.equal(result.already_materialized, false)
    assert.equal(result.scenario.ref, resource.ref, 'the artifact cites the scenario version it was computed from')
    const publication = await env.rig.ctx.get('spatialCatalog').forSession(session.id).lookupPublication('artifact', seq)
    assert.ok(publication, 'the publication is durably recorded')
    assert.equal(publication.resultRef, result.artifact_ref)
    assert.ok(result.windows >= 2)

    const fixed = env.streamLayer(session)
    assert.equal(fixed.stream.mode, 'materialized', 'the layer carries the final state, distinct from the realtime projection')
    assert.deepEqual(fixed.stream.materialized, [{ exportDigest: result.export_digest, artifactRef: result.artifact_ref }])
    await assert.rejects(
      env.run(session, streamAdvance, { stream_id: 'city-stream', steps: 1 }),
      error => error.code === 'STREAM_STATE_CONFLICT' && /materialized/.test(error.message),
      'a materialized workbench is closed',
    )
    await assert.rejects(
      env.run(session, streamMaterialize, { stream_id: 'city-stream' }),
      error => error.code === 'STREAM_STATE_CONFLICT' && /already materialized/.test(error.message),
    )
  } finally {
    await env.dispose()
  }
})

test('a workbench whose checkpoint already records the publication returns the existing ref and never re-publishes', async () => {
  const env = await streamRig('idempotent')
  try {
    const resource = await env.register('stream-demo', scenarioCollection())
    const session = env.sessionOf('workbench')
    await env.run(session, streamOpen, { ...OPEN_ARGS, scenario_ref: resource.ref })
    await env.run(session, streamAdvance, { stream_id: 'city-stream', steps: 4 })
    // Crash recovery: the checkpoint recorded the publication but the fold
    // never flipped the mode. Re-materializing must return the recorded ref.
    const layer = env.streamLayer(session)
    const runtime = resumeCheckpoint(decodeCheckpoint(layer.stream.checkpoint).checkpoint)
    const processMs = layer.stream.checkpoint.lastProcessTimeMs ?? 0
    const planned = buildMaterializedExport(runtime, processMs)
    runtime.recordMaterialization({ exportDigest: planned.export.exportDigest, artifactRef: 'art-crash-1@v1', processMs })
    const recovered = structuredClone(layer)
    recovered.stream = { ...layer.stream, checkpoint: encodeCheckpoint(runtime) }
    const revisionBeforeFold = env.rig.state(session).revision
    rig_fold(env, session, recovered, revisionBeforeFold)
    assert.equal(env.streamLayer(session).stream.mode, 'realtime', 'the crash left the mode realtime')
    const revisionAfterFold = env.rig.state(session).revision
    assert.equal(revisionAfterFold, revisionBeforeFold + 1)

    const { result, seq } = await env.run(session, streamMaterialize, { stream_id: 'city-stream' })
    assert.equal(result.already_materialized, true)
    assert.equal(result.artifact_ref, 'art-crash-1@v1', 'the recorded ref is returned, never a second publication')
    const publication = await env.rig.ctx.get('spatialCatalog').forSession(session.id).lookupPublication('artifact', seq)
    assert.equal(publication, undefined, 'nothing was published for this call')
    assert.equal(env.rig.state(session).revision, revisionAfterFold, 'the idempotent return never folded')
  } finally {
    await env.dispose()
  }
})

test('a cancelled, unknown, or nested stream call never folds and never publishes', async () => {
  const env = await streamRig('cancel')
  try {
    const resource = await env.register('stream-demo', scenarioCollection())
    const session = env.sessionOf('workbench')
    await env.run(session, streamOpen, { ...OPEN_ARGS, scenario_ref: resource.ref })
    await env.run(session, streamAdvance, { stream_id: 'city-stream', steps: 4 })
    const revision = env.rig.state(session).revision

    // A cancelled call: the signal aborts before any work, nothing folds,
    // nothing publishes — the workbench checkpoint is untouched.
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      env.run(session, streamMaterialize, { stream_id: 'city-stream' }, { signal: controller.signal }),
    )
    assert.equal(env.rig.state(session).revision, revision, 'the cancelled call never folded')
    // An advance naming an unknown stream refuses without folding.
    await assert.rejects(
      env.run(session, streamAdvance, { stream_id: 'no-such-stream', steps: 1 }),
      error => error.code === 'INVALID_ARGUMENT' && /unknown stream/.test(error.message),
    )
    // Nested dispatch (PTC) of a stream mutation refuses loudly.
    const callId = 'nested-stream-1'
    env.rig.call(session, callId, 'stream_advance', { stream_id: 'city-stream' })
    await assert.rejects(
      streamAdvance.execute({ stream_id: 'city-stream' }, { ...env.rig.exec(session, { callId }), parent: {} }),
      /native model-direct calls only/,
    )
    assert.equal(env.rig.state(session).revision, revision, 'the nested call never folded')
  } finally {
    await env.dispose()
  }
})

/** Fold one crafted layer through the real commit protocol; returns the call event. */
function rig_fold(env, session, layer, targetRevision) {
  const callId = `recover-${Math.random().toString(36).slice(2)}`
  const call = env.rig.call(session, callId, 'stream_open', { stream_id: layer.id })
  // The recovery call owns the re-emitted layer record. Keep the nested
  // identity aligned with its outer source citation, as the production fold
  // requires for every add-layer candidate.
  const recoveredLayer = { ...layer, sourceCallSeq: call.seq }
  const meta = buildMapChangeMeta(call.seq, targetRevision, { op: 'add-layer', layer: recoveredLayer })
  env.rig.result(session, call, { meta })
  return call
}
