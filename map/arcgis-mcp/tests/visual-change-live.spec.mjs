/**
 * The dual-image live lane stays inert without both the explicit opt-in and
 * the spec's closed authority decision. These checks prove the admission gate
 * before any relay, browser or model image request can be made.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { LIVE_ENV, skippedVisualChangeLiveReport, visualChangeLiveAdmission } from './visual-change-live-policy.mjs'
import { visualChangeSpecPath } from './visual-change-live-paths.mjs'
import { createMapUseRecordingRelay } from './map-use-live-fixture.mjs'
import { visualChangeLiveRunContract } from './visual-change-live-fixture.mjs'
import { DeepSeekFileStore } from '../../../packages/llm/llm-deepseek/lib/index.js'

const closed = [
  '# spec',
  '- [ ] [decision] first draft without authority',
  '- [x] [decision] 授权双图 live | answer: approved | model: deepseek-flash | budget: one dual-image run | authority: user:2026-11-10-dual-image-live',
].join('\n')
const env = {
  MAP_VISUAL_CHANGE_MODEL: 'deepseek-flash',
  MAP_VISUAL_CHANGE_BUDGET: 'one dual-image run',
  MAP_VISUAL_CHANGE_AUTHORITY: '2026-11-10-dual-image-live',
}

test('the opt-in switch is the first gate and creates no side effects', () => {
  const admission = visualChangeLiveAdmission({}, closed)
  assert.equal(admission.ok, false)
  assert.match(admission.reason, new RegExp(LIVE_ENV))
  assert.deepEqual(skippedVisualChangeLiveReport(admission), {
    ok: false, skipped: true, reason: admission.reason, relayRequests: 0, browserLaunches: 0, sentImages: 0,
  })
})

test('the spec authority decision must be closed with an explicit user reference', () => {
  const fields = '| answer: approved | model: deepseek-flash | budget: one dual-image run | authority: user:2026-11-10-dual-image-live'
  const open = `- [ ] [decision] 授权双图 live ${fields}`
  for (const text of [open, `- [x] [decision] 授权双图 live | answer: approved | model: deepseek-flash | budget: one dual-image run`]) {
    const admission = visualChangeLiveAdmission({ [LIVE_ENV]: '1', ...env }, text)
    assert.equal(admission.ok, false)
    assert.match(admission.reason, /authority decision is not closed/u)
  }
})

test('the model, budget and authority reference must mirror the closed decision', () => {
  for (const omission of ['MAP_VISUAL_CHANGE_MODEL', 'MAP_VISUAL_CHANGE_BUDGET', 'MAP_VISUAL_CHANGE_AUTHORITY']) {
    const partial = { ...env }
    delete partial[omission]
    assert.equal(visualChangeLiveAdmission({ [LIVE_ENV]: '1', ...partial }, closed).ok, false)
  }
  assert.equal(visualChangeLiveAdmission({
    [LIVE_ENV]: '1', ...env, MAP_VISUAL_CHANGE_AUTHORITY: 'another-session',
  }, closed).ok, false)
  assert.equal(visualChangeLiveAdmission({
    [LIVE_ENV]: '1', ...env, MAP_VISUAL_CHANGE_MODEL: 'another-model',
  }, closed).ok, false)
  assert.equal(visualChangeLiveAdmission({
    [LIVE_ENV]: '1', ...env, MAP_VISUAL_CHANGE_BUDGET: 'unbounded',
  }, closed).ok, false)
  const admitted = visualChangeLiveAdmission({ [LIVE_ENV]: '1', ...env }, closed)
  assert.deepEqual(admitted, {
    enabled: true, ok: true, reason: undefined, authority: '2026-11-10-dual-image-live',
    answer: 'approved', model: 'deepseek-flash', budget: 'one dual-image run',
  })
})

test('the checked-in decision admits only its own closed model, budget and authority', () => {
  const current = readFileSync(visualChangeSpecPath(), 'utf8')
  const checkedIn = visualChangeLiveAdmission({ [LIVE_ENV]: '1', ...env }, current)
  const closedWithPlaceholder = closed.replace('answer: approved', 'answer: TODO')
  assert.equal(visualChangeLiveAdmission({ [LIVE_ENV]: '1', ...env }, closedWithPlaceholder).ok, false)
  assert.equal(checkedIn.ok, checkedIn.authority !== undefined
    && checkedIn.authority === env.MAP_VISUAL_CHANGE_AUTHORITY
    && checkedIn.model === env.MAP_VISUAL_CHANGE_MODEL
    && checkedIn.budget === env.MAP_VISUAL_CHANGE_BUDGET,
  'an open decision stays inert; a user-closed decision may admit its mirrored model and budget')
})

test('the live fixture stays inert until both admission gates pass', async () => {
  const { runVisualChangeLiveQualification, visualChangeLiveRunContract } = await import('./visual-change-live-fixture.mjs')
  const contract = visualChangeLiveRunContract()
  assert.equal(contract.relay.ablate, false, 'the live relay must forward both original images unchanged')
  assert.equal(contract.maximumModelRequests, 8)
  assert.match(contract.acquisitionLimitation, /does not execute map_set_basemap/u)
  assert.deepEqual(contract.visibleTools, [
    'map_set_basemap', 'map_observe', 'map_compare_views', 'map_mark_changes',
  ])
  assert.deepEqual(contract.executableTools, ['map_compare_views', 'map_mark_changes'])
  const previous = process.env[LIVE_ENV]
  delete process.env[LIVE_ENV]
  try {
    const report = await runVisualChangeLiveQualification({
      spawn: () => { throw new Error('no process may start while the lane is skipped') },
      chromium: { launch: () => { throw new Error('no browser may start while the lane is skipped') } },
      createRelay: () => { throw new Error('no relay may start while the lane is skipped') },
    })
    assert.equal(report.skipped, true)
    assert.equal(report.sentImages, 0)
    assert.equal(report.browserLaunches, 0)
    assert.equal(report.relayRequests, 0)
  } finally {
    if (previous === undefined) delete process.env[LIVE_ENV]
    else process.env[LIVE_ENV] = previous
  }
})

test('the recording relay preserves both dual-image uploads without a real model', async () => {
  const { DeepSeekAdapter } = await import('../../../packages/llm/llm-deepseek/lib/index.js')
  const { resolveAdapterOptions } = await import('../../../packages/llm/llm-deepseek/lib/index.js')
  const { createAssistantMessage, createToolResultMessage, ToolCallId } = await import('../../../packages/llm/llm/lib/index.js')
  const { mapCompareViews } = await import('../../tools/src/visual-change-tools.ts')
  const { Context } = await import('@deepseek-ai/cordis')
  const LocalAttachmentStore = (await import('../../../packages/attachment/attachment-local/lib/index.js')).default
  const temporary = mkdtempSync(join(tmpdir(), 'visual-change-relay-'))
  let relay
  const storeContext = new Context()
  try {
    const images = await Promise.all(['#2864aa', '#408c48'].map(background =>
      sharp({ create: { width: 800, height: 600, channels: 3, background } }).png().toBuffer(),
    ))
    const digests = images.map(bytes => createHash('sha256').update(bytes).digest('hex'))
    const refs = images.map((bytes, index) => ({
      attachmentId: `sha256:${digests[index]}`, width: 800, height: 600, mediaType: 'image/png', bytes: bytes.length,
    }))
    const rendered = mapCompareViews.output.render({}, {
      before_image: refs[0], after_image: refs[1], image_order: ['before', 'after'], meta: { kind: 'map-visual-comparison' },
    })
    const renderedRefs = rendered.filter(block => block.type === 'image').map(block => block.attachment)
    assert.deepEqual(renderedRefs, refs, 'the production renderer must keep the complete image attachment reference')
    const legacyRefs = refs.map(ref => ({ attachmentId: ref.attachmentId, mediaType: ref.mediaType }))
    let fileCount = 0
    const messageBodies = []
    const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
    const stop = [
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    const textResponse = sse([
      { type: 'message_start', message: { id: 'msg-dual-image', model: 'deepseek-flash', usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_stop', index: 0 },
      ...stop,
    ])
    const upstream = async (url, init) => {
      if (url.pathname.endsWith('/files')) {
        fileCount += 1
        const form = await new Request('http://relay/upload', { method: 'POST', headers: init.headers, body: init.body }).formData()
        const upload = form.get('file')
        assert.ok(upload instanceof Blob, 'the real Files client must submit one image blob')
        return Response.json({ id: `file-${fileCount}`, type: 'file', mime_type: 'image/webp',
          size_bytes: upload.size, filename: upload.name,
          created_at: '2026-11-10T00:00:00Z', expires_at: '2026-11-17T00:00:00Z' })
      }
      messageBodies.push(JSON.parse(init.body))
      return new Response(textResponse, { headers: { 'content-type': 'text/event-stream' } })
    }
    relay = createMapUseRecordingRelay({
      apiKey: 'relay-test', directory: realpathSync(temporary), ablate: visualChangeLiveRunContract().relay.ablate,
      beforeFirstImage: async () => {}, fetchUpstream: upstream,
    })
    await new Promise(resolveListen => relay.server.listen(0, '127.0.0.1', resolveListen))
    const port = relay.server.address().port
    const callId = ToolCallId('map_compare_views')
    const home = join(realpathSync(temporary), 'home')
    for (const [index, bytes] of images.entries()) {
      const directory = join(home, 'attachments', 'v1', 'objects', digests[index].slice(0, 2))
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, digests[index]), bytes)
    }
    const store = new LocalAttachmentStore(storeContext, { dshHome: home })
    const files = new DeepSeekFileStore()
    const adapter = new DeepSeekAdapter({
      options: () => resolveAdapterOptions({ baseURL: `http://127.0.0.1:${port}/anthropic`, models: [{
        id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', inputModalities: ['text', 'image'],
        systemPromptUpdate: 'in-history', toolUpdate: 'addition-only', imagePixelBudget: 'low', imageMaxBytes: 2 * 1024 * 1024,
      }] }),
      resolveAuth: async () => ({ headers: { 'x-api-key': 'relay-test' } }), resolveUserId: () => 'test-user',
      resolveAttachments: () => store, resolveImageAccess: () => ({ readonlyPath: '/workspace/image.png' }),
      resolveFiles: () => files, prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
    })
    const history = [
      createAssistantMessage({ source: { provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'tool-call', id: callId, name: 'map_compare_views', arguments: '{}' }] }),
      createToolResultMessage({ callId, isError: false, content: renderedRefs.map(attachment => ({ type: 'image', attachment })) }),
    ]
    const stream = adapter.stream({ provider: 'deepseek-official', model: 'deepseek-flash', messages: history })
    for await (const _chunk of stream) { /* drain the bounded response */ }
    const imageRequest = messageBodies.at(-1)
    assert.equal(messageBodies.length, 1)
    assert.equal(relay.requests.filter(entry => entry.path.endsWith('/messages')).length, 1)
    assert.equal(relay.requests.filter(entry => entry.path.endsWith('/files')).length, 2)
    const messageRequest = relay.requests.find(entry => entry.path.endsWith('/messages'))
    const fileImages = relay.requests.filter(entry => entry.path.endsWith('/files')).flatMap(entry => entry.images)
    assert.equal(fileImages.length, 2)
    assert.equal(new Set(fileImages.map(image => image.original)).size, 2)
    assert.deepEqual(messageRequest.images.map(image => image.original).sort(), fileImages.map(image => image.original).sort())
    assert.equal(imageRequest.messages.at(-1).content.find(part => part.type === 'tool_result').content.filter(part => part.type === 'image').length, 2)
    const legacyHistory = [
      createAssistantMessage({ source: { provider: 'deepseek-official', model: 'deepseek-flash' }, content: [{ type: 'tool-call', id: callId, name: 'map_compare_views', arguments: '{}' }] }),
      createToolResultMessage({ callId, isError: false, content: legacyRefs.map(attachment => ({ type: 'image', attachment })) }),
    ]
    await assert.rejects(async () => {
      for await (const _chunk of adapter.stream({ provider: 'deepseek-official', model: 'deepseek-flash', messages: legacyHistory })) { /* drain */ }
    }, error => error.code === 'TRANSPORT' && /metadata does not match its reference/u.test(String(error.cause?.message)),
    'the legacy truncated renderer shape must fail before the request leaves the adapter')
    assert.equal(relay.requests.filter(entry => entry.path.endsWith('/messages')).length, 1,
      'the legacy failure must not dispatch a second model request')
  } finally {
    relay?.abort()
    relay?.server.closeAllConnections()
    if (relay !== undefined) await new Promise(resolveClose => relay.server.close(resolveClose))
    await storeContext.fiber.dispose()
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('the isolated seed writes two real attachments and a readable production session', async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { SessionId } = await import('../../../packages/core/session/lib/index.js')
  const JsonlSessionPersistence = await import('../../../packages/session/session-persistence-jsonl/lib/index.js')
  const { mapRig } = await import('../../map-container/tests/map-rig.mjs')
  const { seedVisualChangePair } = await import('./visual-change-live-fixture.mjs')
  const temporary = mkdtempSync(join(tmpdir(), 'visual-change-seed-'))
  try {
    const home = join(realpathSync(temporary), 'home')
    const workspace = join(realpathSync(temporary), 'workspace')
    const seed = await seedVisualChangePair(home, workspace, 'visual-change-seed')
    assert.notEqual(seed.beforePng.toString('hex'), seed.afterPng.toString('hex'))
    for (const [index, bytes] of [seed.beforePng, seed.afterPng].entries()) {
      const digest = seed.records[index].attachment.sha256
      const path = join(home, 'attachments', 'v1', 'objects', digest.slice(0, 2), digest)
      assert.equal(existsSync(path), true)
      assert.equal(readFileSync(path).toString('hex'), bytes.toString('hex'))
    }
    const storage = new Context()
    try {
      await storage.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
      const reader = await storage.sessionPersistence.open(SessionId('visual-change-seed'), 'read')
      const events = (await reader.read()).events
      await reader.close()
      assert.equal(events.find(event => event.type === 'session/title').data.title, 'Dual-image visual change qualification')
      const observations = events.filter(event => event.type === 'tool/result' && event.data.meta?.kind === 'map-observation')
      assert.equal(observations.length, 2)
      assert.deepEqual(observations.map(event => event.data.meta.record.observationId), ['obs-before', 'obs-after'])
      assert.deepEqual(observations.map(event => event.data.meta.record.attachment.sha256), seed.records.map(record => record.attachment.sha256))
      assert.deepEqual(observations.map(event => event.data.meta.record.basemap.basemap.id), ['esri-wayback', 'esri-wayback'])
      assert.deepEqual(observations.map(event => event.data.meta.record.basemap.basemap.release.version), ['10', '32246'])
      const basemapChanges = events.filter(event => event.type === 'tool/result'
        && event.data.meta?.kind === 'map-change' && event.data.meta.change.op === 'set-basemap')
      assert.equal(basemapChanges.at(-1).data.meta.change.selection, null,
        'the restored browser basemap uses the fixture-backed legacy source')
      const sourceRig = await mapRig({ mapConfig: {
        observation: { capturePolicy: 'allow' },
        sources: { presets: { 'esri-wayback': { automatedMapUse: 'allowed', screenshot: 'allowed' } } },
      } })
      try {
        const catalog = sourceRig.ctx.get('mapSourceService').catalog
        for (const event of observations) {
          assert.doesNotThrow(() => catalog.verifyWaybackPolicy(event.data.meta.record.basemap.basemap),
            'each seeded Wayback source must satisfy the live catalog policy')
        }
      } finally { await sourceRig.dispose() }
    } finally {
      await storage.fiber.dispose()
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})

test('the live guard exposes acquisition tools but executes only comparison tools', async () => {
  const temporary = mkdtempSync(join(tmpdir(), 'visual-change-guard-'))
  try {
    const log = join(realpathSync(temporary), 'denied.jsonl')
    const listeners = []
    const restrictions = []
    const guards = []
    const ctx = {
      on: (_event, listener) => { listeners.push(listener) },
      tools: {
        guard: guard => { guards.push(guard) },
      },
    }
    const { apply } = await import('./visual-change-live-guard.mjs')
    apply(ctx, { log })
    assert.equal(listeners.length, 1)
    listeners[0]({ agent: { ctx: { tools: { restrict: filter => restrictions.push(filter) } } } })
    assert.deepEqual(restrictions, [{ allow: ['map_set_basemap', 'map_observe', 'map_compare_views', 'map_mark_changes'] }])
    assert.equal(guards.length, 1)
    for (const name of ['map_compare_views', 'map_mark_changes']) {
      assert.equal(guards[0]({ name, callId: name }), undefined)
    }
    for (const name of ['map_set_basemap', 'map_observe', 'map_use']) {
      assert.match(guards[0]({ name, callId: name }), /only map_compare_views and map_mark_changes/u)
    }
    assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line).name), [
      'map_set_basemap', 'map_observe', 'map_use',
    ])
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
