/**
 * Visual-observation tool fixtures (V1 evidence path): `map_observe` pairs
 * its accepted native call with one claimed, revision-bound client capture —
 * with the authored refusals the contract names: pairing, expected revision,
 * source policy, vision, attachments, no-view, not-ready, stale, timeout,
 * cancellation, and invalid image. Pixel observation never impersonates
 * measurement.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { mapRig, pointCollection } from '../../map-container/tests/map-rig.mjs'
import { createMapObservationService } from '../../map-container/src/observation.ts'
import { expectedObservationSources, FIXED_BASEMAP_DESCRIPTOR } from '../../map-container/src/observation-protocol.ts'
import { createMapSourceRoutes } from '../../map-container/src/source-route.ts'
import { createMapSourceCatalog } from '../../map-container/src/sources.ts'
import { createMapSourceService } from '../../map-container/src/source-service.ts'
import { createWaybackService, WAYBACK_ENDPOINT } from '../../map-container/src/wayback.ts'
import { createBasemapSelection } from '../../layers/src/basemap.ts'
import { buildMapChangeMeta } from '../../map-container/src/protocol.ts'
import { mapObserve } from '../src/observation-tools.ts'
import { mapAddLayer } from '../src/map-tools.ts'
import { subagentModelSelectionProjectionDefinition } from '@deepseek-ai/dsh-tool-subagent/src/model-selection-state.ts'

/** A REAL PNG payload through sharp — signature-only fakes never reach pixels. */
async function realPng(width = 8, height = 4) {
  const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 5, g: 10, b: 20 } } }).png().toBuffer()
  return bytes.toString('base64')
}

/** One attested client capture receipt for revision `revision`. */
async function clientCapture(revision, { pngWidth = 8, pngHeight = 4, sources = [FIXED_BASEMAP_DESCRIPTOR] } = {}) {
  return {
    renderedRevision: revision, viewId: 'view-1', generation: 1, cameraEpoch: 0, gestureEpoch: 0,
    imageSize: { width: pngWidth, height: pngHeight },
    mapContentRect: { x: 0, y: 0, width: pngWidth, height: pngHeight },
    cssViewSize: { width: pngWidth, height: pngHeight },
    camera: null,
    georeference: { kind: 'none', reason: 'unreadable-camera' },
    sources,
    includedOverlays: ['attribution'],
    pngBase64: await realPng(pngWidth, pngHeight),
  }
}

/** A claimed submission for the live wait. */
const approvedObservation = {
  observation: { capturePolicy: 'allow' },
  sources: { presets: { 'amap-imagery-labels': { screenshot: 'allowed' } } },
}

function expectedSources(rig, session) {
  const state = rig.state(session)
  const labels = rig.ctx.get('mapSourceService').catalog.descriptorOf('amap-imagery-labels')
  return expectedObservationSources(state.layers, state.basemap, state.imageryDisplay, labels).sources
}

async function submitClaimed(service, { sessionId, callId, requestSeq, revision, pngWidth = 8, pngHeight = 4, sources }) {
  const claimed = await service.claim({ sessionId, callId, requestSeq, revision, expiresAtMs: Date.now() + 5_000, signal: new AbortController().signal })
  assert.equal(claimed.status, 'claimed')
  return service.submit({
    kind: 'capture', sessionId, callId, requestSeq, revision, token: claimed.token,
    capture: await clientCapture(revision, { pngWidth, pngHeight, ...(sources === undefined ? {} : { sources }) }),
  })
}

/** Supply the owner model API used by the vision gate without scanning Session logs. */
function execWithModel(rig, session, callId, model = 'vision-model', signal = new AbortController().signal) {
  const execution = rig.exec(session, { callId, signal })
  return {
    ...execution,
    agent: {
      ...execution.agent,
      model: { current: () => ({ provider: 'fixture-provider', model }) },
    },
  }
}

/** Admit one real tool/call and wait for the host service to issue its client claim. */
async function startObservation(rig, session, callId, { signal = new AbortController().signal, timeoutMs = 10_000, executionContext } = {}) {
  rig.call(session, callId, 'map_observe', { timeout_ms: timeoutMs, expected_revision: 0 })
  const request = rig.state(session).observationRequest
  const service = rig.ctx.get('mapObservation')
  const execution = mapObserve.execute({ timeout_ms: timeoutMs, expected_revision: 0 }, executionContext ?? execWithModel(rig, session, callId, 'vision-model', signal))
  const claim = await service.claim({
    sessionId: session.id,
    callId,
    requestSeq: request.requestSeq,
    revision: request.revision,
    expiresAtMs: request.expiresAtMs,
    signal: new AbortController().signal,
  })
  assert.equal(claim.status, 'claimed')
  return { execution, request, service, token: claim.token }
}

/** Resolve the actual browser render recipe before constructing a client capture. */
async function renderedSources(rig, session) {
  const routes = createMapSourceRoutes(rig.ctx.get('mapSourceService'), async () => rig.state(session))
  try {
    const response = await routes.fetch(new Request(`http://localhost/api/map/sources/render?sessionId=${session.id}`))
    assert.equal(response.status, 200)
    const descriptor = await response.json()
    const state = rig.state(session)
    return expectedObservationSources(state.layers, state.basemap, state.imageryDisplay, descriptor.labels?.source ?? null).sources
  } finally {
    routes.dispose()
  }
}

/** Submit a real PNG fixture with the rendered source identities. */
async function submitObservationCapture(rig, session, callId, { request, service, token }) {
  const sources = await renderedSources(rig, session)
  return service.submit({
    kind: 'capture',
    sessionId: session.id,
    callId,
    requestSeq: request.requestSeq,
    revision: request.revision,
    token,
    capture: await clientCapture(request.revision, { sources }),
  })
}

test('a text-only Session receives bounded analysis from its authorized vision child', async t => {
  const route = { provider: 'fixture-provider', model: 'vision-model' }
  const rig = await mapRig({ mapConfig: { ...approvedObservation, observation: { ...approvedObservation.observation, vision: route } } })
  t.after(async () => rig.dispose())
  const session = rig.session('text-vision')
  const policy = await rig.ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
  t.after(() => policy.dispose())
  session.append('subagent/model-selection-policy', { allowedModels: [route] })
  const analysisCalls = []
  const childText = JSON.stringify({ summary: 'A visible roof.', observations: ['Roof outline is visible.'], limitations: ['No ground truth.'] })
  let savedInput
  let released = 0
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', {
    listModels: async () => [{ id: 'text-model', inputModalities: ['text'] }],
    resolveModelInfo: async (provider, model) => ({ provider, id: model, inputModalities: ['text', 'image'] }),
  }))
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      savedInput = inputs[0]
      return [{ attachmentId: 'opaque-vision', mediaType: 'image/png', bytes: savedInput.data.byteLength, width: 8, height: 4 }]
    },
    readImage: async ref => ({ ref, data: savedInput.data }),
  }))
  rig.ctx.effect(() => rig.ctx.reflect.provide('subagents', {
    getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true }, prepareContinuable: async () => ({}) }),
    startActivation: async request => {
      analysisCalls.push(request)
      return { childId: request.childId, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: childText }] }), dispose: async () => { released += 1 } }
    },
  }))
  rig.ctx.effect(() => rig.ctx.reflect.provide('sessionPersistence', {
    open: async () => ({
      read: async () => ({ events: [
        { type: 'user/message', data: { content: analysisCalls[0].request.prompt } },
        { type: 'assistant/message', data: { message: { source: { kind: 'model', ...route }, content: [{ type: 'text', text: childText }] } } },
      ] }),
      close: async () => {},
    }),
  }))
  const call = rig.call(session, 'obs-vision', 'map_observe', { focus: 'Describe the roof' })
  const request = rig.state(session).observationRequest
  const executing = mapObserve.execute({ focus: 'Describe the roof' }, execWithModel(rig, session, 'obs-vision', 'text-model'))
  const verdict = await submitClaimed(rig.ctx.get('mapObservation'), {
    sessionId: session.id, callId: 'obs-vision', requestSeq: request.requestSeq, revision: request.revision,
    sources: expectedSources(rig, session),
  })
  assert.equal(verdict.ok, true)
  const result = await executing
  assert.equal(analysisCalls.length, 1)
  assert.match(analysisCalls[0].request.prompt[0].text, /Describe the roof/)
  assert.match(analysisCalls[0].request.prompt[0].text, /Captured view:/)
  assert.equal(analysisCalls[0].request.prompt[1].attachment.attachmentId, result.image.attachmentId)
  assert.equal(result.analysis.text, childText)
  assert.equal(result.analysis.model, 'vision-model')
  assert.equal(result.meta.schemaVersion, 4)
  assert.deepEqual(result.meta.record.visualAnalysis, {
    provider: route.provider, model: route.model, childSessionId: result.analysis.child_session_id,
  })
  assert.equal(mapObserve.output.render({}, result).some(block => block.type === 'image'), false)
  assert.equal(released, 1)
  rig.result(session, call, { meta: result.meta })
  assert.equal(rig.state(session).latestObservation.observationId, result.observation_id)
})

test('invalid delegated analysis is rejected before an observation record is published', async t => {
  for (const text of ['not JSON', '{}', JSON.stringify({ summary: '', observations: [], limitations: [] }),
    JSON.stringify({ summary: 'x', observations: [], limitations: [], instructions: 'untrusted' }),
    JSON.stringify({ summary: 'x', observations: Array(33).fill('x'), limitations: [] })]) {
    const route = { provider: 'fixture-provider', model: 'vision-model' }
    const rig = await mapRig({ mapConfig: { ...approvedObservation, observation: { ...approvedObservation.observation, vision: route } } })
    t.after(async () => rig.dispose())
    const policy = await rig.ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    t.after(() => policy.dispose())
    const session = rig.session(`invalid-vision-${text.length}`)
    session.append('subagent/model-selection-policy', { allowedModels: [route] })
    let input
    rig.ctx.effect(() => rig.ctx.reflect.provide('llm', {
      listModels: async () => [{ id: 'text-model', inputModalities: ['text'] }],
      resolveModelInfo: async () => ({ inputModalities: ['image'] }),
    }))
    rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
      saveImages: async inputs => {
        input = inputs[0]
        return [{ attachmentId: 'invalid-vision', mediaType: 'image/png', bytes: input.data.byteLength, width: 8, height: 4 }]
      },
      readImage: async ref => ({ ref, data: input.data }),
    }))
    rig.ctx.effect(() => rig.ctx.reflect.provide('subagents', {
      getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true }, prepareContinuable: async () => ({}) }),
      startActivation: async request => ({ childId: request.childId, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }), dispose: async () => {} }),
    }))
    rig.ctx.effect(() => rig.ctx.reflect.provide('sessionPersistence', { open: async () => { throw new Error('invalid output must not be published') } }))
    rig.call(session, 'obs-invalid', 'map_observe', { focus: 'Describe the map' })
    const request = rig.state(session).observationRequest
    const execution = mapObserve.execute({ focus: 'Describe the map' }, execWithModel(rig, session, 'obs-invalid', 'text-model'))
    assert.equal((await submitClaimed(rig.ctx.get('mapObservation'), {
      sessionId: session.id, callId: 'obs-invalid', requestSeq: request.requestSeq, revision: request.revision,
      sources: expectedSources(rig, session),
    })).ok, true)
    await assert.rejects(execution, /VISION_UNAVAILABLE: The vision analysis returned invalid structured output/)
    assert.equal(rig.state(session).latestObservation, null)
  }
})

test('a text-only Session refuses an unapproved, unverified, or non-durable vision route before capture', async t => {
  for (const scenario of ['not-authorized', 'not-image-capable', 'not-durable']) {
    const route = { provider: 'fixture-provider', model: 'vision-model' }
    const rig = await mapRig({ mapConfig: { ...approvedObservation, observation: { ...approvedObservation.observation, vision: route } } })
    t.after(async () => rig.dispose())
    const policy = await rig.ctx.sessionProjections.register(subagentModelSelectionProjectionDefinition)
    t.after(() => policy.dispose())
    const session = rig.session(`vision-${scenario}`)
    if (scenario !== 'not-authorized') session.append('subagent/model-selection-policy', { allowedModels: [route] })
    let saves = 0
    rig.ctx.effect(() => rig.ctx.reflect.provide('llm', {
      listModels: async () => [{ id: 'text-model', inputModalities: ['text'] }],
      resolveModelInfo: async () => ({ inputModalities: scenario === 'not-image-capable' ? ['text'] : ['text', 'image'] }),
    }))
    rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', { saveImages: async () => { saves += 1; return [] } }))
    rig.ctx.effect(() => rig.ctx.reflect.provide('subagents', {
      getProvider: () => ({ inheritsParentContext: false, capabilities: { agentOptions: true }, prepareContinuable: async () => ({}) }),
    }))
    if (scenario !== 'not-durable') rig.ctx.effect(() => rig.ctx.reflect.provide('sessionPersistence', { open: async () => { throw new Error('not reached') } }))
    rig.call(session, 'obs-refused', 'map_observe', { focus: 'Describe the map' })
    await assert.rejects(mapObserve.execute({ focus: 'Describe the map' }, execWithModel(rig, session, 'obs-refused', 'text-model')), /VISION_UNAVAILABLE/)
    assert.equal(saves, 0)
    assert.equal(rig.ctx.get('mapObservation').pendingCount, 0)
  }
})


test('timeout and cancellation settle honestly; a closed client is a timeout', async () => {
  const service = createMapObservationService()
  const readCurrent = callId => () => ({
    request: { callId, requestSeq: 1, revision: 1 },
    revision: 1,
    sources: [FIXED_BASEMAP_DESCRIPTOR],
    captureAllowed: true,
  })
  const timedOut = await service.waitFor({ sessionId: 's', callId: 'c', requestSeq: 1, revision: 1, expiresAtMs: Date.now() + 40, signal: new AbortController().signal, readCurrent: readCurrent('c') })
  assert.equal(timedOut.status, 'timeout')

  const controller = new AbortController()
  const wait = service.waitFor({ sessionId: 's', callId: 'c2', requestSeq: 1, revision: 1, expiresAtMs: Date.now() + 60_000, signal: controller.signal, readCurrent: readCurrent('c2') })
  controller.abort()
  assert.equal((await wait).status, 'cancelled')

  const closed = await createMapObservationService().waitFor({ sessionId: 's', callId: 'c3', requestSeq: 1, revision: 1, expiresAtMs: Date.now() + 30, signal: new AbortController().signal, readCurrent: readCurrent('c3') })
  assert.equal(closed.status, 'timeout')
})

test('map_observe pins the authored model-facing description and parameter text', () => {
  assert.equal(
    mapObserve.description,
    "Observe this session's current map and return its image, observation id, sources, and positioning limits. Requires an open map and an image-capable current model. The image is evidence of the cited map revision, not a measurement; use geo_* or stats_* tools for numeric values.",
  )
  assert.equal(mapObserve.parameters.properties.timeout_ms.description, 'Capture window in milliseconds [1000, 60000]; default 20000.')
  assert.equal(mapObserve.parameters.properties.expected_revision.description, 'Optional: require this accepted map revision. Omit after map_use to observe the latest accepted state; never copy its source_revision.')
})

test('map_observe refuses without its accepted call and on a stale expected revision', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-observe-pair-'))
  writeFileSync(join(dir, 'points.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  t.after(async () => { await rig.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const session = rig.session('observe-pair')

  const addCall = rig.call(session, 'add-1', 'map_add_layer', { path: 'points.geojson', layer_id: 'pts' })
  const added = await mapAddLayer.execute({ path: 'points.geojson', layer_id: 'pts' }, rig.exec(session, { callId: 'add-1' }))
  rig.result(session, addCall, { meta: added.meta })

  // Executing without the accepted tool/call is a pairing refusal.
  await assert.rejects(
    mapObserve.execute({}, rig.exec(session, { callId: 'never-called' })),
    /INVALID_ARGUMENT: map_observe requires its accepted native tool call/,
  )

  // expected_revision that does not match the current revision is stale.
  const staleCall = rig.call(session, 'obs-stale', 'map_observe', { expected_revision: 99 })
  await assert.rejects(
    mapObserve.execute({ expected_revision: 99 }, rig.exec(session, { callId: 'obs-stale' })),
    /STALE_OBSERVATION: The map or capture identity changed; observe the current view again/u,
  )
  void staleCall
})

test('map_observe gates: attachments, vision, then no-client timeout — all before capture', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-observe-gates-'))
  writeFileSync(join(dir, 'points.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir, mapConfig: { observation: { capturePolicy: 'allow' } } })
  t.after(async () => { await rig.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const session = rig.session('observe-gates')
  session.append('request/header', { turn: 1, header: { config: { provider: 'p', model: 'vision-model' } } })

  const addCall = rig.call(session, 'add-1', 'map_add_layer', { path: 'points.geojson', layer_id: 'pts' })
  const added = await mapAddLayer.execute({ path: 'points.geojson', layer_id: 'pts' }, rig.exec(session, { callId: 'add-1' }))
  rig.result(session, addCall, { meta: added.meta })

  // Explicit allow reaches the attachment gate before requesting capture.
  rig.call(session, 'obs-att', 'map_observe', {})
  await assert.rejects(
    mapObserve.execute({}, execWithModel(rig, session, 'obs-att')),
    /SPATIAL_SERVICE_UNAVAILABLE: The attachment service is unavailable/,
  )
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', { saveImages: async () => [] }))

  // Fail-closed vision gate: no llm service mounted → named refusal.
  rig.call(session, 'obs-v', 'map_observe', {})
  await assert.rejects(
    mapObserve.execute({}, execWithModel(rig, session, 'obs-v')),
    /VISION_UNAVAILABLE: The current model cannot receive images and no authorized vision route is configured/,
  )
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: async () => [{ id: 'vision-model', inputModalities: ['text', 'image'] }] }))
  const noModelExec = rig.exec(session, { callId: 'obs-no-model' })
  rig.call(session, 'obs-no-model', 'map_observe', {})
  await assert.rejects(
    mapObserve.execute({}, {
      ...noModelExec,
      agent: { ...noModelExec.agent, model: { current: () => undefined } },
    }),
    /VISION_UNAVAILABLE: The current model cannot receive images and no authorized vision route is configured/,
  )

  // Text-only models never receive pixels.
  const rigText = await mapRig({ cwd: dir, mapConfig: { observation: { capturePolicy: 'allow' } } })
  t.after(async () => rigText.dispose())
  rigText.ctx.effect(() => rigText.ctx.reflect.provide('llm', { listModels: async () => [{ id: 'text-model', inputModalities: ['text'] }] }))
  rigText.ctx.effect(() => rigText.ctx.reflect.provide('attachments', { saveImages: async () => [] }))
  const textSession = rigText.session('observe-text')
  textSession.append('request/header', { turn: 1, header: { config: { provider: 'p', model: 'text-model' } } })
  const textAdd = rigText.call(textSession, 'add-t', 'map_add_layer', { path: 'points.geojson', layer_id: 'pts' })
  const textAdded = await mapAddLayer.execute({ path: 'points.geojson', layer_id: 'pts' }, rigText.exec(textSession, { callId: 'add-t' }))
  rigText.result(textSession, textAdd, { meta: textAdded.meta })
  rigText.call(textSession, 'obs-t', 'map_observe', {})
  await assert.rejects(
    mapObserve.execute({}, execWithModel(rigText, textSession, 'obs-t', 'text-model')),
    /VISION_UNAVAILABLE/,
  )

  // The tool has no viewport-presence oracle; an open request with no client times out honestly.
  rig.call(session, 'obs-view', 'map_observe', { timeout_ms: 1000 })
  await assert.rejects(
    mapObserve.execute({ timeout_ms: 1000 }, execWithModel(rig, session, 'obs-view')),
    /CAPTURE_TIMEOUT: No current map image arrived before the capture deadline/,
  )
})

test('a blocked model catalog is bounded by the request deadline and releases an early claim', async t => {
  const rig = await mapRig({ mapConfig: { observation: { capturePolicy: 'allow' } } })
  t.after(async () => rig.dispose())
  const session = rig.session('observe-catalog-timeout')
  session.append('request/header', { turn: 1, header: { config: { provider: 'p', model: 'vision-model' } } })
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', { saveImages: async () => [] }))
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: () => new Promise(() => {}) }))
  const call = rig.call(session, 'obs-catalog', 'map_observe', { timeout_ms: 1000 })
  const request = rig.state(session).observationRequest
  const observation = rig.ctx.get('mapObservation')
  const earlyClaim = observation.claim({
    sessionId: session.id,
    callId: 'obs-catalog',
    requestSeq: request.requestSeq,
    revision: request.revision,
    expiresAtMs: request.expiresAtMs,
    signal: new AbortController().signal,
  })
  await assert.rejects(
    mapObserve.execute({ timeout_ms: 1000 }, execWithModel(rig, session, 'obs-catalog')),
    /CAPTURE_TIMEOUT: No current map image arrived before the capture deadline/,
  )
  assert.ok(['cancelled', 'timeout'].includes((await earlyClaim).status))
  assert.equal(observation.pendingCount, 0)
  assert.equal(observation.earlyClaimCount, 0)
  void call
})

test('a pre-aborted accepted call releases its parked claim before catalog or attachment work', async t => {
  const rig = await mapRig({ mapConfig: { observation: { capturePolicy: 'allow' } } })
  t.after(async () => rig.dispose())
  const session = rig.session('observe-pre-aborted')
  let catalogCalls = 0
  let saveCalls = 0
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', {
    listModels: async () => { catalogCalls += 1; return [{ id: 'vision-model', inputModalities: ['image'] }] },
  }))
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async () => { saveCalls += 1; return [] },
    readImage: async () => { throw new Error('readImage must not start') },
  }))
  const call = rig.call(session, 'obs-pre-aborted', 'map_observe', {})
  const request = rig.state(session).observationRequest
  const service = rig.ctx.get('mapObservation')
  const parked = service.claim({
    sessionId: session.id,
    callId: 'obs-pre-aborted',
    requestSeq: request.requestSeq,
    revision: request.revision,
    expiresAtMs: request.expiresAtMs,
    signal: new AbortController().signal,
  })
  const controller = new AbortController()
  controller.abort(new DOMException('caller cancelled before dispatch', 'AbortError'))
  await assert.rejects(
    mapObserve.execute({}, execWithModel(rig, session, 'obs-pre-aborted', 'vision-model', controller.signal)),
    /CANCELLED: The map observation was cancelled; no observation record was published/,
  )
  assert.equal((await parked).status, 'cancelled')
  assert.equal(catalogCalls, 0)
  assert.equal(saveCalls, 0)
  assert.equal(service.pendingCount, 0)
  assert.equal(service.earlyClaimCount, 0)
  void call
})

test('the turn deadline bounds an observation even when its own capture window is longer', { timeout: 10000 }, async t => {
  const rig = await mapRig({ mapConfig: { observation: { capturePolicy: 'allow' }, interaction: { maxElapsedMs: 1000 } } })
  t.after(async () => rig.dispose())
  const session = rig.session('observe-turn-deadline')
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', { saveImages: async () => [] }))
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: () => new Promise(() => {}) }))
  rig.call(session, 'observe-turn-deadline', 'map_observe', { timeout_ms: 60000 })
  const request = rig.state(session).observationRequest
  assert.equal(request.expiresAtMs - session.snapshotEvents().at(-1).time, 60000)
  await assert.rejects(mapObserve.execute({ timeout_ms: 60000 }, execWithModel(rig, session, request.callId)), /CAPTURE_TIMEOUT.*open the map and retry/u)
  assert.equal(rig.ctx.get('mapObservation').pendingCount, 0)
})

test('default source policies and the rendered AMap labels do not prevent a complete observation', async t => {
  const rig = await mapRig()
  t.after(async () => rig.dispose())
  const session = rig.session('observe-default-sources')
  const catalog = rig.ctx.get('mapSourceService').catalog
  const label = catalog.descriptorOf('amap-imagery-labels')
  assert.equal(label.screenshot, 'unverified')
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', {
    listModels: async () => [{ id: 'vision-model', inputModalities: ['image'] }],
  }))
  let image
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      image = inputs[0].data
      return [{ attachmentId: 'att-default', mediaType: 'image/png', bytes: image.length, width: 8, height: 4 }]
    },
    readImage: async ref => ({ ref, data: image }),
  }))
  const call = rig.call(session, 'obs-default-sources', 'map_observe', { timeout_ms: 1000 })
  const request = rig.state(session).observationRequest
  const controller = new AbortController()
  t.after(() => controller.abort())
  const executing = mapObserve.execute({ timeout_ms: 1000 }, execWithModel(rig, session, call.data.callId, 'vision-model', controller.signal))
  const resultPromise = executing.then(value => ({ value }), error => ({ error }))
  const observation = rig.ctx.get('mapObservation')
  const claim = await observation.claim({
    sessionId: session.id, callId: call.data.callId, requestSeq: request.requestSeq,
    revision: request.revision, expiresAtMs: request.expiresAtMs, signal: controller.signal,
  })
  if (claim.status !== 'claimed') {
    const failure = await resultPromise
    assert.fail(`capture was not claimed (${claim.status}): ${failure.error?.message ?? 'no tool failure'}`)
  }
  const sources = expectedObservationSources([], null, rig.state(session).imageryDisplay, label).sources
  assert.deepEqual(sources.map(source => source.id), ['esri-world-imagery', 'amap-imagery-labels'])
  assert.equal(sources[1].policy, 'unverified')
  const submission = await observation.submit({
    kind: 'capture', sessionId: session.id, callId: call.data.callId, requestSeq: request.requestSeq,
    revision: request.revision, token: claim.token, capture: await clientCapture(request.revision, { sources }),
  })
  assert.deepEqual(submission, { ok: true })
  const result = await resultPromise
  assert.equal(result.error, undefined)
  assert.deepEqual(result.value.sources, sources)
  assert.equal(result.value.image.attachmentId, 'att-default')
  rig.result(session, call, { meta: result.value.meta })
  assert.deepEqual(rig.state(session).latestObservation.sources, sources)
})

test('explicit denial and visible imagery retain their source facts without blocking capture', async t => {
  const rig = await mapRig({ mapConfig: { observation: { capturePolicy: 'deny' } } })
  t.after(async () => rig.dispose())
  const session = rig.session('observe-policy')
  const imageryArgs = {
    tile_url: 'https://tiles.example.org/{z}/{y}/{x}.png',
    tile_attribution: 'Fixture imagery',
    layer_id: 'imagery',
    name: 'Fixture imagery',
  }
  const imageryCall = rig.call(session, 'imagery-1', 'map_add_layer', imageryArgs)
  const imagery = await mapAddLayer.execute(imageryArgs, rig.exec(session, { callId: 'imagery-1' }))
  rig.result(session, imageryCall, { meta: imagery.meta })
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', {
    listModels: async () => [{ id: 'vision-model', inputModalities: ['image'] }],
  }))
  let image
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      image = inputs[0].data
      return [{ attachmentId: 'att-denied', mediaType: 'image/png', bytes: image.length, width: 8, height: 4 }]
    },
    readImage: async ref => ({ ref, data: image }),
  }))
  const call = rig.call(session, 'obs-imagery', 'map_observe', { timeout_ms: 1000 })
  const request = rig.state(session).observationRequest
  const sources = await renderedSources(rig, session)
  assert.deepEqual(sources.map(source => source.id), ['esri-world-imagery', 'amap-imagery-labels', 'imagery'])
  assert.equal(sources[1].policy, 'unverified')
  assert.equal(sources[2].policy, 'unverified')
  const executing = mapObserve.execute({ timeout_ms: 1000 }, execWithModel(rig, session, call.data.callId))
  const verdict = await submitClaimed(rig.ctx.get('mapObservation'), {
    sessionId: session.id, callId: call.data.callId, requestSeq: request.requestSeq, revision: request.revision, sources,
  })
  assert.deepEqual(verdict, { ok: true })
  const result = await executing
  assert.deepEqual(result.sources, sources)
  assert.equal(result.image.attachmentId, 'att-denied')
  rig.result(session, call, { meta: result.meta })
  assert.deepEqual(rig.state(session).latestObservation.sources, sources)
})

test('Esri, OSM and AMap sources remain observable without grants', async t => {
  const rig = await mapRig({ mapConfig: { observation: { capturePolicy: 'deny' } } })
  t.after(async () => rig.dispose())
  const sourceService = rig.ctx.get('mapSourceService')
  const catalog = sourceService.catalog
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', {
    listModels: async () => [{ id: 'vision-model', inputModalities: ['image'] }],
  }))
  let image
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      image = inputs[0].data
      return [{ attachmentId: 'att-source-matrix', mediaType: 'image/png', bytes: image.length, width: 8, height: 4 }]
    },
    readImage: async ref => ({ ref, data: image }),
  }))
  const selectedSources = [
    ['esri-world-imagery', null],
    ['osm-standard', null],
    ['esri-world-imagery', 'amap-imagery-labels'],
  ]
  for (const [id, label] of selectedSources) {
    const selection = catalog.selection(id, label)
    assert.equal(selection.ok, true)
    const sessionId = `${id}-${label ?? 'none'}`
    const target = rig.session(sessionId)
    const { buildMapChangeMeta } = await import('../../map-container/src/protocol.ts')
    const select = rig.call(target, `select-${sessionId}`, 'map_set_basemap', {})
    rig.result(target, select, { meta: buildMapChangeMeta(select.seq, 0, { op: 'set-basemap', selection: selection.value }) })
    const state = rig.state(target)
    assert.equal(state.basemap.basemap.id, id)
    const call = rig.call(target, `observe-${sessionId}`, 'map_observe', { timeout_ms: 1000 })
    const request = rig.state(target).observationRequest
    const sources = expectedObservationSources(state.layers, state.basemap, state.imageryDisplay, selection.value.labels).sources
    const executing = mapObserve.execute({ timeout_ms: 1000 }, execWithModel(rig, target, call.data.callId))
    const verdict = await submitClaimed(rig.ctx.get('mapObservation'), {
      sessionId: target.id, callId: call.data.callId, requestSeq: request.requestSeq, revision: request.revision, sources,
    })
    assert.deepEqual(verdict, { ok: true })
    const result = await executing
    assert.deepEqual(result.sources, sources)
    assert.equal(result.sources[0].policy, 'unverified')
    rig.result(target, call, { meta: result.meta })
    assert.deepEqual(rig.state(target).latestObservation.sources, sources)
  }

  const missing = catalog.descriptorOf('tianditu-img-w')
  assert.equal(missing.availability.reason, 'missing-credential')
  assert.throws(() => sourceService.verifySource(missing), { code: 'SOURCE_NOT_CONFIGURED' })
})

test('configured Tianditu, custom, and fixed Wayback sources capture without policy grants', async t => {
  const release = {
    releaseNum: 10, itemID: '10'.padStart(32, '0'), itemTitle: 'World Imagery (Wayback 2014-02-20)',
    itemURL: `${WAYBACK_ENDPOINT}/tile/10/{level}/{row}/{col}`,
    metadataLayerUrl: 'https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2014_r01/MapServer',
    metadataLayerItemID: '10'.padStart(32, 'f'), layerIdentifier: 'WB_2014_R01', releaseDateLabel: '2014-02-20',
  }
  let catalogReads = 0
  const history = createWaybackService({ core: {
    async getWaybackItems() { catalogReads += 1; return [release] },
    async getWaybackItemsWithLocalChanges() { throw new Error('local query is not part of capture') },
    async getMetadata() { throw new Error('metadata is not part of capture') },
  } })
  const config = {
    credentials: { tianditu: { type: 'query', parameter: 'tk', env: 'DSH_TEST_SOURCE_VALUE' } },
    custom: [{
      id: 'fixture-tiles', title: 'Fixture tiles', role: 'basemap', adapter: 'xyz',
      endpoint: 'https://tiles.example.test/{z}/{x}/{y}.png', attribution: 'Fixture attribution', nativeWkid: 3857,
      supportedModes: ['map'], minZoom: 0, maxZoom: 20, compatibleBasemapIds: [],
      screenshot: 'denied', automatedMapUse: 'denied',
    }],
  }
  const catalog = createMapSourceCatalog(config, 'deny', { DSH_TEST_SOURCE_VALUE: 'fixture-value' }, history)
  const sourceService = createMapSourceService(catalog, {}, history)
  t.after(async () => sourceService.dispose())
  t.after(async () => history.dispose())
  await history.refreshCatalog()
  const rig = await mapRig()
  t.after(async () => rig.dispose())
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', {
    listModels: async () => [{ id: 'vision-model', inputModalities: ['image'] }],
  }))
  let image
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      image = inputs[0].data
      return [{ attachmentId: 'att-source-matrix', mediaType: 'image/png', bytes: image.length, width: 8, height: 4 }]
    },
    readImage: async ref => ({ ref, data: image }),
  }))
  const wayback = await catalog.waybackDescriptor(10)
  assert.equal(catalogReads, 1)
  const historicalSelection = createBasemapSelection(wayback, null)
  assert.equal(historicalSelection.ok, true)
  const selections = [catalog.selection('tianditu-img-w', 'tianditu-cia-w'), catalog.selection('fixture-tiles'), historicalSelection]
  const controller = new AbortController()
  t.after(() => controller.abort())
  for (const [index, selection] of selections.entries()) {
    assert.equal(selection.ok, true)
    const session = rig.session(`extended-source-${index}`)
    const select = rig.call(session, `select-extended-${index}`, 'map_set_basemap', {})
    rig.result(session, select, { meta: buildMapChangeMeta(select.seq, 0, { op: 'set-basemap', selection: selection.value }) })
    const call = rig.call(session, `observe-extended-${index}`, 'map_observe', { timeout_ms: 1000 })
    const request = rig.state(session).observationRequest
    const state = rig.state(session)
    const sources = expectedObservationSources(state.layers, state.basemap, state.imageryDisplay, null).sources
    const execution = execWithModel(rig, session, call.data.callId, 'vision-model', controller.signal)
    execution.agent.ctx = { get: name => name === 'mapSourceService' ? sourceService : rig.ctx.get(name) }
    const pending = mapObserve.execute({ timeout_ms: 1000 }, execution)
    const verdict = await submitClaimed(rig.ctx.get('mapObservation'), {
      sessionId: session.id, callId: call.data.callId, requestSeq: request.requestSeq, revision: request.revision, sources,
    })
    assert.deepEqual(verdict, { ok: true })
    const result = await pending
    assert.deepEqual(result.sources, sources)
    assert.equal(result.sources[0].policy, 'unverified')
    assert.equal(result.sources[0].id, selection.value.basemap.id)
    assert.equal(result.sources[0].attribution, selection.value.basemap.attribution)
    assert.equal(result.meta.record.attachment.sha256, createHash('sha256').update(image).digest('hex'))
    assert.equal(mapObserve.output.render({}, result).some(block => block.type === 'image'), true)
    rig.result(session, call, { meta: result.meta })
    assert.deepEqual(rig.state(session).latestObservation.sources, sources)
  }
  assert.equal(catalogReads, 1, 'capture uses the verified cached release without another external request')
  const recoveredCatalog = createMapSourceCatalog(config, 'deny', { DSH_TEST_SOURCE_VALUE: 'fixture-value' }, {
    cachedRelease: () => undefined,
  })
  assert.throws(() => recoveredCatalog.verifyCachedWaybackSource(wayback), { code: 'SOURCE_UNAVAILABLE' })
})

test('a source change while capture is in flight cannot publish an attachment', async t => {
  const rig = await mapRig()
  t.after(async () => rig.dispose())
  const session = rig.session('observe-source-drift')
  const source = rig.ctx.get('mapSourceService')
  let replaced = false
  let writes = 0
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', {
    listModels: async () => [{ id: 'vision-model', inputModalities: ['image'] }],
  }))
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async () => { writes += 1; return [] },
  }))
  const call = rig.call(session, 'observe-source-drift', 'map_observe', { timeout_ms: 1000 })
  const request = rig.state(session).observationRequest
  const execution = execWithModel(rig, session, call.data.callId)
  execution.agent.ctx = { get: name => name === 'mapSourceService' ? {
    ...source,
    verifySource(candidate) {
      if (replaced) throw new Error('source replaced during capture')
      source.verifySource(candidate)
    },
  } : rig.ctx.get(name) }
  const pending = mapObserve.execute({ timeout_ms: 1000 }, execution)
  const observation = rig.ctx.get('mapObservation')
  const claim = await observation.claim({
    sessionId: session.id, callId: call.data.callId, requestSeq: request.requestSeq,
    revision: request.revision, expiresAtMs: request.expiresAtMs, signal: new AbortController().signal,
  })
  assert.equal(claim.status, 'claimed')
  const sources = expectedObservationSources([], null, rig.state(session).imageryDisplay, source.catalog.descriptorOf('amap-imagery-labels')).sources
  replaced = true
  await observation.submit({
    kind: 'capture', sessionId: session.id, callId: call.data.callId, requestSeq: request.requestSeq,
    revision: request.revision, token: claim.token, capture: await clientCapture(request.revision, { sources }),
  })
  await assert.rejects(pending, /STALE_OBSERVATION/)
  assert.equal(writes, 0)
  assert.equal(rig.state(session).latestObservation, null)
})

test('replacing the default source service during attachment save prevents publication', async t => {
  const rig = await mapRig()
  t.after(() => rig.dispose())
  const session = rig.session('observe-default-config-drift')
  const replacement = createMapSourceService(createMapSourceCatalog({ presets: {
    'amap-imagery-labels': { automatedMapUse: 'allowed' },
  } }, 'unverified', {}))
  t.after(() => replacement.dispose())
  let currentSource = rig.ctx.get('mapSourceService')
  let reads = 0
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: async () => [{ id: 'vision-model', inputModalities: ['image'] }] }))
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      currentSource = replacement
      return [{ attachmentId: 'drifted', mediaType: 'image/png', bytes: inputs[0].data.byteLength, width: 8, height: 4 }]
    },
    readImage: async () => { reads += 1; throw new Error('source drift must stop readback') },
  }))
  const callId = 'observe-config-drift'
  const executionContext = execWithModel(rig, session, callId)
  executionContext.agent.ctx = { get: name => name === 'mapSourceService' ? currentSource : rig.ctx.get(name) }
  const pending = await startObservation(rig, session, callId, { executionContext })
  const rejected = assert.rejects(pending.execution, { code: 'SOURCE_CHANGED' })
  assert.deepEqual(await submitObservationCapture(rig, session, callId, pending), { ok: true })
  await rejected
  assert.equal(reads, 0)
  assert.equal(rig.state(session).latestObservation, null)
  assert.equal(pending.service.pendingCount, 0)
})

test('caller cancellation during a blocked attachment save prevents read and record publication', async t => {
  const rig = await mapRig({ mapConfig: { observation: { capturePolicy: 'allow' } } })
  t.after(async () => rig.dispose())
  const session = rig.session('observe-save-abort')
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: async () => [{ id: 'vision-model', inputModalities: ['image'] }] }))
  let resolveSave
  let savedInput
  let readCount = 0
  let announceSave
  const saveStarted = new Promise(resolve => { announceSave = resolve })
  const saveGate = new Promise(resolve => { resolveSave = resolve })
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      savedInput = inputs[0]
      announceSave()
      return saveGate
    },
    readImage: async () => { readCount += 1; throw new Error('read must not start') },
  }))
  const controller = new AbortController()
  const pending = await startObservation(rig, session, 'obs-save-abort', { signal: controller.signal })
  assert.equal((await submitObservationCapture(rig, session, 'obs-save-abort', pending)).ok, true)
  await saveStarted
  controller.abort(new DOMException('caller cancelled', 'AbortError'))
  await assert.rejects(pending.execution, /CANCELLED: The map observation was cancelled/)
  resolveSave([{
    attachmentId: 'opaque-late-save',
    mediaType: 'image/png',
    bytes: savedInput.data.byteLength,
    width: 8,
    height: 4,
  }])
  await saveGate
  assert.equal(readCount, 0)
  assert.equal(rig.state(session).latestObservation, null)
})

test('an attachment save blocked past the original request deadline cannot publish a late record', async t => {
  const rig = await mapRig({ mapConfig: { observation: { capturePolicy: 'allow' } } })
  t.after(async () => rig.dispose())
  const session = rig.session('observe-save-deadline')
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: async () => [{ id: 'vision-model', inputModalities: ['image'] }] }))
  let resolveSave
  let savedInput
  let readCount = 0
  let announceSave
  const saveStarted = new Promise(resolve => { announceSave = resolve })
  const saveGate = new Promise(resolve => { resolveSave = resolve })
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      savedInput = inputs[0]
      announceSave()
      return saveGate
    },
    readImage: async () => { readCount += 1; throw new Error('read must not start') },
  }))
  const originalNow = Date.now()
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: originalNow })
  try {
    const pending = await startObservation(rig, session, 'obs-save-deadline', { timeoutMs: 1000 })
    assert.equal((await submitObservationCapture(rig, session, 'obs-save-deadline', pending)).ok, true)
    await saveStarted
    t.mock.timers.tick(Math.max(1, pending.request.expiresAtMs - Date.now() + 1))
    await assert.rejects(pending.execution, /CAPTURE_TIMEOUT: No current map image arrived before the capture deadline/)
    resolveSave([{
      attachmentId: 'opaque-late-save',
      mediaType: 'image/png',
      bytes: savedInput.data.byteLength,
      width: 8,
      height: 4,
    }])
    await saveGate
    assert.equal(readCount, 0)
    assert.equal(rig.state(session).latestObservation, null)
  } finally {
    t.mock.timers.reset()
  }
})

test('caller cancellation during a blocked attachment read prevents late metadata publication', async t => {
  const rig = await mapRig({ mapConfig: { observation: { capturePolicy: 'allow' } } })
  t.after(async () => rig.dispose())
  const session = rig.session('observe-read-abort')
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: async () => [{ id: 'vision-model', inputModalities: ['image'] }] }))
  let savedInput
  let savedRef
  let resolveRead
  let seenReadSignal
  let announceRead
  const readStarted = new Promise(resolve => { announceRead = resolve })
  const readGate = new Promise(resolve => { resolveRead = resolve })
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      savedInput = inputs[0]
      savedRef = {
        attachmentId: 'opaque-saved-ref',
        mediaType: 'image/png',
        bytes: inputs[0].data.byteLength,
        width: 8,
        height: 4,
      }
      return [savedRef]
    },
    readImage: async (_ref, signal) => {
      seenReadSignal = signal
      announceRead()
      return readGate
    },
  }))
  const controller = new AbortController()
  const pending = await startObservation(rig, session, 'obs-read-abort', { signal: controller.signal })
  assert.equal((await submitObservationCapture(rig, session, 'obs-read-abort', pending)).ok, true)
  await readStarted
  controller.abort(new DOMException('caller cancelled', 'AbortError'))
  await assert.rejects(pending.execution, /CANCELLED: The map observation was cancelled/)
  assert.equal(seenReadSignal.aborted, true)
  resolveRead({ ref: savedRef, data: savedInput.data })
  await readGate
  assert.equal(rig.state(session).latestObservation, null)
})

test('an attachment read blocked past the original request deadline aborts and ignores late bytes', async t => {
  const rig = await mapRig({ mapConfig: { observation: { capturePolicy: 'allow' } } })
  t.after(async () => rig.dispose())
  const session = rig.session('observe-read-deadline')
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: async () => [{ id: 'vision-model', inputModalities: ['image'] }] }))
  let savedInput
  let savedRef
  let resolveRead
  let readSignal
  let announceRead
  const readStarted = new Promise(resolve => { announceRead = resolve })
  const readGate = new Promise(resolve => { resolveRead = resolve })
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      savedInput = inputs[0]
      savedRef = {
        attachmentId: 'opaque-read-deadline',
        mediaType: 'image/png',
        bytes: inputs[0].data.byteLength,
        width: 8,
        height: 4,
      }
      return [savedRef]
    },
    readImage: async (_ref, signal) => {
      readSignal = signal
      announceRead()
      return readGate
    },
  }))
  const originalNow = Date.now()
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: originalNow })
  try {
    const pending = await startObservation(rig, session, 'obs-read-deadline', { timeoutMs: 1000 })
    assert.equal((await submitObservationCapture(rig, session, 'obs-read-deadline', pending)).ok, true)
    await readStarted
    t.mock.timers.tick(Math.max(1, pending.request.expiresAtMs - Date.now() + 1))
    await assert.rejects(pending.execution, /CAPTURE_TIMEOUT: No current map image arrived before the capture deadline/)
    assert.equal(readSignal.aborted, true)
    resolveRead({ ref: savedRef, data: savedInput.data })
    await readGate
    assert.equal(rig.state(session).latestObservation, null)
  } finally {
    t.mock.timers.reset()
  }
})

test('attachment readback refuses same-size mutations, media conversion, and ref dimension or length drift', async t => {
  for (const mismatch of ['bytes', 'mediaType', 'dimensions', 'length', 'readLength']) {
    const rig = await mapRig({ mapConfig: { observation: { capturePolicy: 'allow' } } })
    t.after(async () => rig.dispose())
    const session = rig.session(`observe-storage-${mismatch}`)
    rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: async () => [{ id: 'vision-model', inputModalities: ['image'] }] }))
    let savedInput
    rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
      saveImages: async inputs => {
        savedInput = inputs[0]
        return [{
          attachmentId: 'opaque-storage-id',
          mediaType: 'image/png',
          bytes: inputs[0].data.byteLength,
          width: 8,
          height: 4,
        }]
      },
      readImage: async ref => {
        let data = savedInput.data
        let actualRef = ref
        if (mismatch === 'bytes') {
          data = Uint8Array.from(data)
          data[0] ^= 1
        } else if (mismatch === 'readLength') {
          data = data.slice(1)
        } else if (mismatch === 'mediaType') {
          actualRef = { ...ref, mediaType: 'image/webp' }
        } else if (mismatch === 'dimensions') {
          actualRef = { ...ref, width: 7 }
        } else {
          actualRef = { ...ref, bytes: ref.bytes - 1 }
        }
        return { ref: actualRef, data }
      },
    }))
    const pending = await startObservation(rig, session, `obs-storage-${mismatch}`)
    assert.equal((await submitObservationCapture(rig, session, `obs-storage-${mismatch}`, pending)).ok, true)
    await assert.rejects(
      pending.execution,
      /SPATIAL_SERVICE_UNAVAILABLE: The map image could not be stored; no observation record was published/,
      mismatch,
    )
    assert.equal(rig.state(session).latestObservation, null)
    assert.equal(rig.ctx.get('mapObservation').pendingCount, 0)
  }
})

test('the full loop: claim + submit + attachment + meta fold into latestObservation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-observe-full-'))
  writeFileSync(join(dir, 'points.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir, mapConfig: { observation: { capturePolicy: 'allow' } } })
  t.after(async () => { await rig.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const session = rig.session('observe-full')
  session.append('request/header', { turn: 1, header: { config: { provider: 'p', model: 'vision-model' } } })

  const addCall = rig.call(session, 'add-1', 'map_add_layer', { path: 'points.geojson', layer_id: 'pts' })
  const added = await mapAddLayer.execute({ path: 'points.geojson', layer_id: 'pts' }, rig.exec(session, { callId: 'add-1' }))
  rig.result(session, addCall, { meta: added.meta })
  const revision = rig.state(session).revision

  const observation = rig.ctx.get('mapObservation')
  const savedImages = []
  let imageReads = 0
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: async () => [{ id: 'vision-model', inputModalities: ['text', 'image'] }] }))
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    saveImages: async inputs => {
      const saved = {
        attachmentId: 'opaque-observation-image-id',
        mediaType: 'image/png',
        bytes: inputs[0].data.length,
        width: 8,
        height: 4,
        name: inputs[0].name,
      }
      savedImages.push({ input: inputs[0], reference: saved })
      return [saved]
    },
    readImage: async ref => {
      imageReads += 1
      return { ref, data: savedImages[0].input.data }
    },
  }))
  const call = rig.call(session, 'obs-1', 'map_observe', { timeout_ms: 10_000 })
  const request = rig.state(session).observationRequest
  assert.equal(request.callId, 'obs-1')
  assert.equal(request.revision, revision)
  const sources = await renderedSources(rig, session)

  const executing = mapObserve.execute({ timeout_ms: 10_000 }, execWithModel(rig, session, 'obs-1'))
  // Claim resolves only when the tool has admitted the wait.
  const verdict = await submitClaimed(observation, { sessionId: session.id, callId: 'obs-1', requestSeq: request.requestSeq, revision, sources })
  assert.equal(verdict.ok, true)

  const result = await executing
  assert.equal(result.operable, false, 'a capture without affine positioning stays read-only')
  assert.equal(result.positioning, 'none')
  assert.equal(result.revision, revision)
  assert.equal(result.view_id, 'view-1')
  assert.equal(result.image.attachmentId, 'opaque-observation-image-id')
  assert.equal(result.observation_id.startsWith('obs-'), true)
  assert.equal(result.meta.kind, 'map-observation')
  assert.equal(result.meta.schemaVersion, 3)
  assert.equal(result.meta.record.basemap, null)
  assert.equal(result.meta.record.mapRevision, revision)
  assert.equal(result.meta.record.attachment.sha256, createHash('sha256').update(savedImages[0].input.data).digest('hex'))
  assert.ok(Array.isArray(result.sources))
  assert.ok(result.limitations.includes('Pixel reading is observation, not measurement.'))
  assert.equal(savedImages.length, 1)
  assert.equal(imageReads, 1)

  // The durable meta folds the observation into the projection.
  rig.result(session, call, { meta: result.meta })
  const after = rig.state(session)
  assert.equal(after.observationRequest, null)
  assert.equal(after.latestObservation.observationId, result.observation_id)
  assert.equal(after.latestObservation.mapRevision, revision)
})

test('a declined or timed-out client maps to the authored refusal codes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'map-observe-neg-'))
  writeFileSync(join(dir, 'points.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir, mapConfig: { observation: { capturePolicy: 'allow' } } })
  t.after(async () => { await rig.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const session = rig.session('observe-neg')
  session.append('request/header', { turn: 1, header: { config: { provider: 'p', model: 'vision-model' } } })

  const addCall = rig.call(session, 'add-1', 'map_add_layer', { path: 'points.geojson', layer_id: 'pts' })
  const added = await mapAddLayer.execute({ path: 'points.geojson', layer_id: 'pts' }, rig.exec(session, { callId: 'add-1' }))
  rig.result(session, addCall, { meta: added.meta })
  const revision = rig.state(session).revision
  const observation = rig.ctx.get('mapObservation')
  rig.ctx.effect(() => rig.ctx.reflect.provide('llm', { listModels: async () => [{ id: 'vision-model', inputModalities: ['text', 'image'] }] }))
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', { saveImages: async () => [] }))
  // A not-ready decline → NOT_READY.
  const callA = rig.call(session, 'obs-nr', 'map_observe', {})
  const reqA = rig.state(session).observationRequest
  const execA = mapObserve.execute({}, execWithModel(rig, session, 'obs-nr'))
  const claimA = await observation.claim({
    sessionId: session.id, callId: 'obs-nr', requestSeq: reqA.requestSeq, revision,
    expiresAtMs: Date.now() + 5_000, signal: new AbortController().signal,
  })
  assert.equal(claimA.status, 'claimed')
  await observation.submit({ kind: 'decline', sessionId: session.id, callId: 'obs-nr', requestSeq: reqA.requestSeq, token: claimA.token, code: 'not-ready' })
  await assert.rejects(execA, /NOT_READY: The requested map is not fully rendered/)
  void callA

  // No submission inside the window → CAPTURE_TIMEOUT.
  rig.call(session, 'obs-to', 'map_observe', { timeout_ms: 60 })
  await assert.rejects(
    mapObserve.execute({ timeout_ms: 60 }, execWithModel(rig, session, 'obs-to')),
    /CAPTURE_TIMEOUT: No current map image arrived before the capture deadline/,
  )

  // A wrong-token submission is refused and does not consume the wait.
  const callB = rig.call(session, 'obs-wt', 'map_observe', { timeout_ms: 200 })
  const reqB = rig.state(session).observationRequest
  const execB = mapObserve.execute({ timeout_ms: 200 }, execWithModel(rig, session, 'obs-wt'))
  const claimedB = await observation.claim({
    sessionId: session.id, callId: 'obs-wt', requestSeq: reqB.requestSeq, revision,
    expiresAtMs: Date.now() + 5_000, signal: new AbortController().signal,
  })
  assert.equal(claimedB.status, 'claimed')
  const wrong = await observation.submit({
    kind: 'capture', sessionId: session.id, callId: 'obs-wt', requestSeq: reqB.requestSeq,
    revision, token: 'not-the-claim-token', capture: await clientCapture(revision),
  })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.code, 'wrong-token')
  assert.equal(observation.pendingCount, 1)
  await assert.rejects(execB, /CAPTURE_TIMEOUT/)
  void callB
})
