/**
 * Visual-observation fixtures (task-visual-observation): the pending-wait
 * registry pairs one `map_observe` execution with one client capture of an
 * exact revision — with the honest negatives the contract names: timeout,
 * cancellation, a closed (never-submitting) client, stale-revision captures,
 * cross-session/call mismatches, malformed payloads, and the fail-closed
 * vision gate. Pixel observation never impersonates measurement.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig, pointCollection } from '../../map-container/tests/map-rig.mjs'
import {
  MAX_OBSERVATION_BYTES,
  createMapObservationService,
} from '../../map-container/src/observation.ts'
import { mapObserve } from '../src/observation-tools.ts'
import { mapAddLayer } from '../src/map-tools.ts'

/** A minimal signature-valid PNG payload (header + filler). */
function fakePng(size = 64) {
  const bytes = new Uint8Array(size)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return Buffer.from(binary, 'binary').toString('base64')
}

test('the wait/submit pair binds session, call, and revision; refusals are named', async () => {
  const service = createMapObservationService(() => 0)
  const waiting = service.waitFor('session-a', 'call-1', 3, 5_000, new AbortController().signal)
  assert.equal(service.pendingCount, 1)

  // Cross-session submissions never reach the wait.
  assert.equal(service.submit({ sessionId: 'session-b', callId: 'call-1', requestSeq: 9, renderedRevision: 3, viewId: 'v', pngBase64: fakePng() }).ok, false)
  assert.equal(service.submit({ sessionId: 'session-b', callId: 'call-1', requestSeq: 9, renderedRevision: 3, viewId: 'v', pngBase64: fakePng() }).code, 'no-pending-request')
  // A capture of a different revision is stale, never accepted.
  assert.equal(service.submit({ sessionId: 'session-a', callId: 'call-1', requestSeq: 9, renderedRevision: 2, viewId: 'v', pngBase64: fakePng() }).code, 'stale-revision')
  // Malformed payload refuses loudly.
  assert.equal(service.submit({ sessionId: 'session-a', callId: 'call-1', requestSeq: 9, renderedRevision: 3, viewId: 'v', pngBase64: 'not base64!' }).code, 'malformed-png')
  assert.equal(service.submit({ sessionId: 'session-a', callId: 'call-1', requestSeq: 9, renderedRevision: 3, viewId: 'v', pngBase64: Buffer.from('no png signature here').toString('base64') }).code, 'malformed-png')
  assert.equal(service.submit({ sessionId: 'session-a', callId: 'call-1', requestSeq: 9, renderedRevision: 3, viewId: 'v', pngBase64: Buffer.from(new Uint8Array(MAX_OBSERVATION_BYTES + 1)).toString('base64') }).code, 'oversized')

  // The correctly paired submission resolves the wait with the bound revision.
  const verdict = service.submit({ sessionId: 'session-a', callId: 'call-1', requestSeq: 9, renderedRevision: 3, viewId: 'view-1', pngBase64: fakePng() })
  assert.equal(verdict.ok, true)
  const outcome = await waiting
  assert.equal(outcome.status, 'observed')
  if (outcome.status === 'observed') {
    assert.equal(outcome.revision, 3)
    assert.equal(outcome.renderedRevision, 3)
    assert.equal(outcome.viewId, 'view-1')
    assert.equal(outcome.png.length, 64)
  }
  assert.equal(service.pendingCount, 0, 'the wait cleared')
})

test('timeout and cancellation settle honestly; a closed client is a timeout', async () => {
  const service = createMapObservationService()
  const timedOut = await service.waitFor('s', 'c', 1, 40, new AbortController().signal)
  assert.equal(timedOut.status, 'timeout')

  const controller = new AbortController()
  const wait = service.waitFor('s', 'c2', 1, 60_000, controller.signal)
  controller.abort()
  assert.equal((await wait).status, 'cancelled')

  // No submission at all (the client occurrence is closed) → timeout.
  const closed = await createMapObservationService().waitFor('s', 'c3', 1, 30, new AbortController().signal)
  assert.equal(closed.status, 'timeout')
})

test('the projection folds map_observe calls into a bounded, call-paired observation request', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('observe-fold')
    const add = rig.call(session, 'add', 'map_add_layer', { path: 'points.geojson' })
    void add
    // (layer folding is covered elsewhere; here the request lifecycle matters)
    const before = rig.state(session)
    assert.equal(before.observationRequest, null)

    const observe = session.append('tool/call', { turn: 2, step: 1, callId: 'obs-1', name: 'map_observe', arguments: JSON.stringify({ timeout_ms: 5000 }) })
    const during = rig.state(session)
    assert.equal(during.observationRequest?.callId, 'obs-1')
    assert.equal(during.observationRequest?.requestSeq, observe.seq)
    assert.equal(during.observationRequest?.revision, before.revision)
    assert.ok(during.observationRequest.expiresAtMs > observe.time)

    // An unrelated result never clears the request.
    session.append('tool/result', {
      turn: 2, step: 1,
      message: { role: 'tool', content: [{ type: 'text', text: 'unrelated' }], isError: false },
    }, { surfaceOp: 'append' })
    assert.notEqual(rig.state(session).observationRequest, null)

    // Its own settling result — success or error — clears it.
    session.append('tool/result', {
      turn: 2, step: 1,
      message: { role: 'tool', toolCallId: 'obs-1', content: [{ type: 'text', text: 'done' }], isError: true },
    }, { surfaceOp: 'append', sourceEventSeqs: [observe.seq] })
    assert.equal(rig.state(session).observationRequest, null)
  } finally {
    await rig.dispose()
  }
})

test('map_observe gates on vision support, waits for the client, and returns a bound image', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-observe-'))
  writeFileSync(join(dir, 'points.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  t.after(async () => { await rig.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const session = rig.session('observe-tool')

  const addCall = rig.call(session, 'add-1', 'map_add_layer', { path: 'points.geojson', layer_id: 'pts' })
  const added = await mapAddLayer.execute({ path: 'points.geojson', layer_id: 'pts' }, rig.exec(session, { callId: 'add-1' }))
  rig.result(session, addCall, { meta: added.meta })

  // Fail-closed gate: no llm service mounted → no capture, named refusal.
  const observeCall = rig.call(session, 'obs-gate', 'map_observe', {})
  await assert.rejects(
    mapObserve.execute({}, rig.exec(session, { callId: 'obs-gate' })),
    /vision-capable model/,
    'a host without a verified image-capable model never submits a capture',
  )

  // No layers: nothing to observe — even with the gate open.
  const llm = {
    listModels: async provider => (provider === 'p' ? [{ id: 'vision-model', inputModalities: ['text', 'image'] }] : []),
  }
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', llm))
  const emptySession = rig.session('observe-empty')
  await assert.rejects(
    mapObserve.execute({}, rig.exec(emptySession, { callId: 'obs-empty' })),
    /no layers/,
  )

  // Vision gate refuses text-only models before any capture.
  const textOnly = { listModels: async () => [{ id: 'text-model', inputModalities: ['text'] }] }
  const rigText = await mapRig({ cwd: dir })
  t.after(async () => rigText.dispose())
  rigText.ctx.effect(() => rigText.ctx.reflect.provide('llm', textOnly))
  const textSession = rigText.session('observe-text')
  const textAdd = rigText.call(textSession, 'add-t', 'map_add_layer', { path: 'points.geojson', layer_id: 'pts' })
  const textAdded = await mapAddLayer.execute({ path: 'points.geojson', layer_id: 'pts' }, rigText.exec(textSession, { callId: 'add-t' }))
  rigText.result(textSession, textAdd, { meta: textAdded.meta })
  rigText.call(textSession, 'obs-t', 'map_observe', {})
  await assert.rejects(
    mapObserve.execute({}, rigText.exec(textSession, { callId: 'obs-t' })),
    /vision-capable/,
    'a text-only model never receives pixels',
  )
  void session
})

test('the full loop: a vision host with a submitting client returns the bound image block', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-observe-full-'))
  writeFileSync(join(dir, 'points.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  t.after(async () => { await rig.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const session = rig.session('observe-full')

  const addCall = rig.call(session, 'add-1', 'map_add_layer', { path: 'points.geojson', layer_id: 'pts' })
  const added = await mapAddLayer.execute({ path: 'points.geojson', layer_id: 'pts' }, rig.exec(session, { callId: 'add-1' }))
  rig.result(session, addCall, { meta: added.meta })
  const revision = rig.state(session).revision

  // The plugin already provides the observation service; reuse it.
  const observation = rig.ctx.get('mapObservation')
  const savedImages = []
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: async () => [{ id: 'vision-model', inputModalities: ['text', 'image'] }] }))
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      savedImages.push(inputs[0])
      return [{ attachmentId: `att-${savedImages.length}`, mediaType: 'image/png', bytes: inputs[0].data.length, width: 800, height: 600, name: 'map.png' }]
    },
  }))

  // The session's surface needs a request/header for the gate's model read.
  session.append('request/header', { header: { config: { provider: 'p', model: 'vision-model' } } })

  // The "client": submit while the tool waits.
  const callId = 'obs-full'
  rig.call(session, callId, 'map_observe', {})
  const pending = mapObserve.execute({}, rig.exec(session, { callId }))
  await new Promise(resolve => setTimeout(resolve, 20))
  const verdict = observation.submit({ sessionId: session.id, callId, requestSeq: 0, renderedRevision: revision, viewId: 'view-1', pngBase64: fakePng(128) })
  assert.equal(verdict.ok, true, `the client submission lands: ${JSON.stringify(verdict)}`)
  const result = await pending
  assert.equal(result.revision, revision)
  assert.equal(result.view_id, 'view-1')
  assert.equal(result.image.attachmentId, 'att-1')
  assert.ok(Array.isArray(savedImages) && savedImages.length === 1)
  // The render contract: the model-facing content carries the image block.
  const content = mapObserve.output.render({}, result)
  assert.ok(content.some(block => block.type === 'image'), 'the image reaches the model content')
  assert.ok(content.some(block => block.type === 'text'), 'the summary text travels beside it')
})
