/**
 * Opt-in two-image visual-change qualification. Two fixed Wayback observations
 * and their real PNG attachments are seeded into one isolated Session; the
 * admitted live model calls `map_compare_views` and `map_mark_changes` through
 * the shipped host. No model image is sent until the spec authority decision,
 * explicit opt-in, model and budget all agree.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { spawn } from 'node:child_process'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '../../../packages/core/session/lib/index.js'
import * as JsonlSessionPersistence from '../../../packages/session/session-persistence-jsonl/lib/index.js'
import { createMessage } from '../../../packages/llm/llm/lib/index.js'
import { PUBLIC_BASE_URL, requestModelListing } from '../../../packages/llm/llm-deepseek/lib/index.js'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import { waybackDescriptor } from '../../map-container/src/wayback.ts'
import { parseBasemapSelection } from '../../layers/src/basemap.ts'
import { symbolVersionOf } from '../../layers/src/contract.ts'
import {
  buildMapChangeMeta,
  buildMapObservationMeta,
  expectedObservationSources,
  observationCompositionOf,
} from '../../map-container/src/index.ts'
import { trackedTmpDir, waitFor, withTrackedTmpDir } from '../../tests/support/reliability.mjs'
import { createMapUseRecordingRelay } from './map-use-live-fixture.mjs'
import { skippedVisualChangeLiveReport, visualChangeLiveAdmission } from './visual-change-live-policy.mjs'

const title = 'Dual-image visual change qualification'
const acquisitionTools = ['map_set_basemap', 'map_observe']
const comparisonTools = ['map_compare_views', 'map_mark_changes']
const visibleTools = [...acquisitionTools, ...comparisonTools]
const executableTools = new Set(comparisonTools)
const maximumModelRequests = 8
const acquisitionMode = 'seeded-observations'
const acquisitionLimitation = 'This lane proves current-model understanding of two persisted images; it exposes map_set_basemap/map_observe but denies their live execution and does not execute map_set_basemap(early/recent) -> map_observe x2 in the live run.'
const origin = new URL(PUBLIC_BASE_URL).origin
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const camera = {
  center: [104.9, 36.4], extent: [100, 32, 109.8, 40.8], wkid: 4326,
  scale: 50000, zoom: 6, rotation: 0, mode: 'map', padding: [0, 0, 0, 0],
}
const georeference = {
  kind: 'affine-2d', coefficients: [0.01, 0, 100, 0, -0.01, 40.8], wkid: 4326, maxResidualCssPx: 0,
}
const composition = observationCompositionOf([])
const sceneLayer = (() => {
  const draft = { methodVersion: 'map-layers@1', presentation: 'single', fill: { color: '#1769d2', opacity: 0.85, outlineColor: '#1769d2', outlineWidthPx: 1 } }
  return {
    id: 'visual-change-scene', name: 'Visual change scene', sourceCrs: 'EPSG:4326', visible: true, opacity: 1,
    symbol: { ...draft, symbolVersion: symbolVersionOf(draft) },
    data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'scene-reference', properties: { category: 'sample' }, geometry: { type: 'Polygon', coordinates: [[[104.8, 36.3], [105.0, 36.3], [105.0, 36.5], [104.8, 36.5], [104.8, 36.3]]] } }] },
  }
})()

/** The bounded admission contract shared by the runner and its inert tests. */
export function visualChangeLiveRunContract() {
  return {
    maximumModelRequests,
    acquisitionMode,
    acquisitionLimitation,
    relay: { ablate: false },
    visibleTools: [...visibleTools],
    executableTools: [...executableTools],
  }
}
const imageSize = { width: 800, height: 600 }
const goal = '会话已经保存了同一视角的两张固定 Wayback 影像观察，ID 分别是 obs-before 与 obs-after。请先调用一次 map_compare_views，按 before/after 顺序同时查看返回的两张原图；再用一次 map_mark_changes，针对两张图之间明显新增的红色建筑提出恰好一个 appeared 候选，使用扁平的 bbox 像素几何，category 写“新增红色建筑”，confidence 只能 uncertain 或 likely，不要给概率、面积、发生日期或检测精度。不要把发布日期当拍摄日期，不要调用其他工具。若两图不可比或看不出变化，返回空 items 并说明限制。最后独立一行写 VISUAL_CHANGE_ENDED。'

const background = (red, green, blue) => Buffer.from(
  `<svg width="${imageSize.width}" height="${imageSize.height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="rgb(${red},${green},${blue})"/></svg>`,
)
const realPng = async (red, green, blue, withBuilding) => await sharp(background(red, green, blue))
  .composite(withBuilding ? [{
    input: Buffer.from('<svg width="160" height="110" xmlns="http://www.w3.org/2000/svg"><rect x="8" y="8" width="144" height="94" rx="6" fill="#d33636" stroke="#7d1818" stroke-width="6"/><path d="M36 102V48h28v54M96 102V48h28v54" fill="#ffd0c0"/></svg>'),
    left: 320, top: 245,
  }] : [])
  .png().toBuffer()

const release = (releaseId, publishedAt) => {
  const descriptor = waybackDescriptor({
    releaseId, itemId: `${releaseId}`.padEnd(32, '0'),
    title: `World Imagery (Wayback ${publishedAt})`,
    publishedAt, layerIdentifier: `WB_${releaseId}_R01`, acquiredAt: null,
  })
  const parsed = parseBasemapSelection({ schemaVersion: 1, basemap: descriptor, labels: null })
  assert.equal(parsed.ok, true)
  return parsed.value
}

const observation = (id, selection, bytes) => ({
  observationId: id, callId: id, requestSeq: 0, mapRevision: 0,
  viewId: 'view-1', generation: 1, cameraEpoch: 0, gestureEpoch: 0,
  attachment: {
    attachmentId: `sha256:${hash(bytes)}`, mediaType: 'image/png', bytes: bytes.length,
    width: imageSize.width, height: imageSize.height, sha256: hash(bytes),
  },
  capturedAt: '2026-11-10T00:00:00.000Z',
  imageSize,
  mapContentRect: { x: 0, y: 0, width: imageSize.width, height: imageSize.height },
  cssViewSize: imageSize,
  camera, georeference,
  sources: expectedObservationSources([], selection).sources,
  basemap: selection,
  includedOverlays: ['attribution'], limitations: [],
  composition,
})

/**
 * Seed two accepted observations, their real attachments, and a prior setup
 * turn into one isolated Session. The projection consumes the same persisted
 * `tool/call` + `tool/result.meta` events as the shipped Web host.
 */
export async function seedVisualChangePair(home, workspace, sessionId) {
  const beforePng = await realPng(15, 20, 25, false)
  const afterPng = await realPng(15, 20, 25, true)
  const selections = [
    release(10, '2014-02-20T00:00:00.000Z'),
    release(32246, '2026-01-26T00:00:00.000Z'),
  ]
  const records = [
    observation('obs-before', selections[0], beforePng),
    observation('obs-after', selections[1], afterPng),
  ]
  const storage = new Context()
  await storage.plugin(SessionStore)
  await storage.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
  const rig = await mapRig({ mapConfig: {
    observation: { capturePolicy: 'allow' },
    sources: { presets: { 'esri-world-imagery': { automatedMapUse: 'allowed' }, 'esri-wayback': { automatedMapUse: 'allowed', screenshot: 'allowed' } } },
  } })
  try {
    const session = rig.session(sessionId)
    session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { id: 'setup', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Two isolated synthetic fixed-release observations are ready.' }] }, { surfaceOp: 'append' })
    const content = records.flatMap(record => [
      { type: 'tool-call', id: `basemap-${record.callId}`, name: 'map_set_basemap', arguments: JSON.stringify({ source_id: 'esri-wayback' }) },
      { type: 'tool-call', id: record.callId, name: 'map_observe', arguments: '{}' },
    ])
    content.unshift({ type: 'tool-call', id: 'seed-scene', name: 'map_add_layer', arguments: JSON.stringify({ path: 'prepared-scene' }) })
    content.push({ type: 'tool-call', id: 'restore-default-basemap', name: 'map_set_basemap', arguments: JSON.stringify({ source_id: null }) })
    const time = Date.now()
    const stream = content.flatMap((block, index) => [
      { type: 'chunk', time, chunk: { type: 'block-start', index, blockType: 'tool-call' } },
      { type: 'tool-call-chunks', time0: time, index, dt: [], id: block.id, name: block.name, args: [block.arguments] },
      { type: 'chunk', time, chunk: { type: 'block-end', index, block } },
    ])
    stream.push({ type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } })
    session.append('assistant/message', { turn: 1, step: 1, message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content }), stream }, { surfaceOp: 'append' })
    const sceneCall = rig.call(session, 'seed-scene', 'map_add_layer', { path: 'prepared-scene' })
    rig.result(session, sceneCall, { meta: buildMapChangeMeta(sceneCall.seq, rig.state(session).revision, { op: 'add-layer', layer: { ...sceneLayer, sourceCallSeq: sceneCall.seq } }) })
    for (const [index, record] of records.entries()) {
      const selection = selections[index]
      const basemapCall = rig.call(session, `basemap-${record.callId}`, 'map_set_basemap', { source_id: 'esri-wayback' })
      rig.result(session, basemapCall, { meta: buildMapChangeMeta(basemapCall.seq, rig.state(session).revision, { op: 'set-basemap', selection }) })
      const call = rig.call(session, record.callId, 'map_observe', {})
      const request = rig.state(session).observationRequest
      rig.result(session, call, { meta: buildMapObservationMeta({ ...record, requestSeq: request.requestSeq, mapRevision: request.revision }) })
    }
    const restoreCall = rig.call(session, 'restore-default-basemap', 'map_set_basemap', { source_id: null })
    rig.result(session, restoreCall, { meta: buildMapChangeMeta(restoreCall.seq, rig.state(session).revision, { op: 'set-basemap', selection: null }) })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'done' } })
    const state = rig.state(session)
    assert.equal(state.observationHistory.length, 2, 'both fixed-release observations must fold from the seeded log')
    assert.equal(state.observationHistory[0].attachment.sha256, hash(beforePng))
    assert.equal(state.observationHistory[1].attachment.sha256, hash(afterPng))
    for (const bytes of [beforePng, afterPng]) {
      const digest = hash(bytes)
      const directory = join(home, 'attachments', 'v1', 'objects', digest.slice(0, 2))
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, digest), bytes)
    }
    const events = session.snapshotEvents()
    const persisted = storage.sessions.create(SessionId(sessionId), { meta: { cwd: workspace, agentPreset: 'map-analyst' } })
    const handle = await storage.sessionPersistence.create(persisted.header)
    await handle.append(events)
    await handle.close()
    const reader = await storage.sessionPersistence.open(persisted.id, 'read')
    try { await reader.read() } finally { await reader.close() }
    return { beforePng, afterPng, records, events }
  } finally {
    await rig.dispose()
    await storage.fiber.dispose()
  }
}

/**
 * Run one admitted qualification, or return without starting any external
 * process, browser, relay, credential read, or image upload.
 * @param options - owning composition helpers and optional injection seams.
 * @returns the evidence report.
 */
export async function runVisualChangeLiveQualification(options = {}) {
  const admission = visualChangeLiveAdmission()
  if (!admission.ok) return skippedVisualChangeLiveReport(admission)
  return withTrackedTmpDir('visual-change-live-evidence', ({ path }) => runVisualChangeLiveQualificationIn(admission, path, options))
}

async function runVisualChangeLiveQualificationIn(admission, evidenceRoot, options) {
  const {
    root, mapBin, pickerPatch, chromium, listen, stopProcessTree, waitForAppUrl,
    maybeContinueNotice, connectWorkspace, sendMessage, waitForRenderedReceipt,
    useFixtureBasemap, observationSessionLogs, readObservationSessionLog,
  } = options
  for (const [name, value] of Object.entries({
    root, mapBin, pickerPatch, chromium, listen, stopProcessTree, waitForAppUrl,
    maybeContinueNotice, connectWorkspace, sendMessage, waitForRenderedReceipt,
    useFixtureBasemap, observationSessionLogs, readObservationSessionLog,
  })) assert.ok(value, `${name} is required by the admitted composition lane`)
  const inject = {
    spawn,
    chromium,
    createRelay: createMapUseRecordingRelay,
  }
  const project = process.env.MAP_VISUAL_CHANGE_LIVE_KEY_SOURCE === 'project-env'
    ? parseEnv(readFileSync(join(root, '.env'), 'utf8'))
    : process.env
  const apiKey = project.DEEPSEEK_API_KEY
  assert.ok(apiKey, 'A real project credential is required; there is no mock fallback')
  const listing = await requestModelListing(new URL('/models', origin).href, { 'x-api-key': apiKey }, AbortSignal.timeout(30000))
  const currentModel = listing.entries.find(entry => entry.id === admission.model)
  assert.ok(currentModel?.capabilities.usable && currentModel.capabilities.facts.inputModalities.includes('image'))
  const runId = new Date().toISOString().replace(/[:.]/gu, '-')
  const evidence = join(evidenceRoot, 'evidence')
  mkdirSync(evidence, { recursive: true })
  const temporaryRoot = trackedTmpDir('visual-change-live')
  const temporary = realpathSync(temporaryRoot.path)
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  const sessionId = 'visual-change-live-' + runId
  const report = {
    runId, model: currentModel, authority: admission.authority, budget: admission.budget,
    transport: { kind: 'transparent-recording-relay', upstreamOrigin: origin, responseFallback: false },
    acquisitionMode,
    acquisitionLimitation,
    criteria: { twoDistinctImages: true, visibleTools: [...visibleTools], executableTools: [...executableTools], comparisonIdBound: true, noForbiddenTools: true, maximumModelRequests, acquisitionMode, acquisitionLimitation },
    ok: false,
  }
  writeFileSync(join(evidence, 'registered-plan.json'), JSON.stringify({ goal, criteria: report.criteria }, null, 2))
  let app
  let browser
  let relay
  let page
  const pageErrors = []
  const stdout = { value: '' }
  const stderr = { value: '' }
  const deniedLog = join(temporary, 'denied.jsonl')
  try {
    const seed = await seedVisualChangePair(home, workspace, sessionId)
    report.seed = { sessionId, records: seed.records.map(record => ({
      observationId: record.observationId,
      attachment: record.attachment,
      release: record.basemap.basemap.release,
    })) }
    for (const [index, bytes] of [seed.beforePng, seed.afterPng].entries()) {
      writeFileSync(join(evidence, `observation-${index + 1}.png`), bytes)
    }
    relay = inject.createRelay({ apiKey, directory: evidence, ablate: visualChangeLiveRunContract().relay.ablate, beforeFirstImage: async () => {} })
    const port = await listen(relay.server)
    const overlay = join(temporary, 'visual-change.overlay.yml')
    writeFileSync(overlay, `${readFileSync(pickerPatch, 'utf8').trimEnd()}
- id: session-title-llm
  disabled: true
- id: map-container
  config:
    observation:
      capturePolicy: allow
    sources:
      presets:
        esri-world-imagery:
          automatedMapUse: allowed
        esri-wayback:
          screenshot: allowed
          automatedMapUse: allowed
- id: llm-deepseek
  config:
    models:
      - id: ${admission.model}
        name: DeepSeek-V4.1-Flash
        inputModalities: [text, image]
        contextWindow: 1048576
        maxTokens: 8192
        systemPromptUpdate: in-history
        toolUpdate: addition-only
- insert:
    - id: visual-change-live-guard
      name: ${JSON.stringify(fileURLToPath(new URL('./visual-change-live-guard.mjs', import.meta.url)))}
      config:
        log: ${JSON.stringify(deniedLog)}
`)
    report.configurationSha256 = hash(readFileSync(overlay, 'utf8'))
    app = inject.spawn(process.execPath, [mapBin, '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd: workspace,
      env: { ...process.env, MAPHARNESS_HOME: home, DSH_HOME: home, DEEPSEEK_API_KEY: apiKey, DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`, DSH_TELEMETRY_MODE: 'DISABLED', DSH_CLIENT_MAP_ORG_NAME: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)
    browser = await inject.chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 820 } })
    page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(String(error)))
    await useFixtureBasemap(page)
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    const group = page.getByRole('treeitem', { name: /Ungrouped|未分组/u })
    if (await group.count() > 0 && await group.first().getAttribute('aria-expanded') === 'false') await group.first().click()
    await page.locator('[role="treeitem"]').filter({ hasText: new RegExp(`${title}|未命名|Untitled`, 'u') }).last().click()
    await waitForRenderedReceipt(page)
    await page.waitForFunction(count => [...window.__mapHarness.values()].some(handle => handle.observationHistory?.length === count), 2)
    await page.screenshot({ path: join(evidence, 'before.png') })
    await sendMessage(page, goal)
    const completion = page.getByText('VISUAL_CHANGE_ENDED', { exact: true }).last()
      .waitFor({ timeout: 300000 }).then(() => 'ended')
    const terminalFailure = (async () => {
      await page.getByText('处理失败', { exact: true }).last().waitFor({ timeout: 300000 })
      await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30000 })
      return 'failed'
    })()
    await Promise.race([
      completion,
      terminalFailure.then(() => { throw new Error('the live model request failed before the qualification ended') }),
    ])
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30000 })
    await waitFor(() => relay.requests.every(entry => entry.completed), { timeoutMs: 30000, label: 'upstream protocol requests reach quiescence' })
    await page.screenshot({ path: join(evidence, 'after.png') })
    const state = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()][0]
      return { comparisons: handle.comparisons, visualChanges: handle.visualChanges, observationHistory: handle.observationHistory }
    })
    const raw = observationSessionLogs(home).map(path => readObservationSessionLog(path)).find(text => text.includes(sessionId))
    assert.ok(raw, 'the qualification must persist its session log')
    const events = raw.trim().split('\n').map(line => JSON.parse(line))
    const calls = events.filter(event => event.type === 'tool/call' && event.data.turn > 1).map(event => ({ seq: event.seq, ...event.data, args: JSON.parse(event.data.arguments) }))
    const results = events.filter(event => event.type === 'tool/result' && event.data.turn > 1 && ['map-visual-comparison', 'map-visual-change'].includes(event.data.meta?.kind))
    const assistantMessages = events.filter(event => event.type === 'assistant/message' && event.data.turn > 1)
    const modelRequests = relay.requests.filter(entry => entry.path.endsWith('/messages'))
    const sentImages = modelRequests.flatMap(entry => entry.images)
    const expectedHashes = new Set(seed.records.map(record => record.attachment.sha256))
    const denied = existsSync(deniedLog) ? readFileSync(deniedLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    const compareCalls = calls.filter(call => call.name === 'map_compare_views')
    const markCalls = calls.filter(call => call.name === 'map_mark_changes')
    const finalText = assistantMessages.map(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).at(-1) ?? ''
    report.state = state
    report.calls = calls
    report.results = results.map(result => ({ seq: result.seq, metaKind: result.data.meta.kind, callId: result.data.callId }))
    report.assistantMessageSeqs = assistantMessages.map(event => event.seq)
    report.denied = denied
    report.upstream = modelRequests.map(({ request, ...entry }) => entry)
    report.imageMatches = sentImages.map(image => ({ ...image, fromSeed: expectedHashes.has(image.original) }))
    report.pageErrors = pageErrors
    writeFileSync(join(evidence, 'events.json'), JSON.stringify(events.filter(event => ['tool/call', 'tool/result', 'turn/start', 'turn/end'].includes(event.type)), null, 2))
    assert.equal(relay.failure, undefined)
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(denied, [])
    assert.ok(calls.every(call => executableTools.has(call.name)), 'the live run may execute only the two comparison tools')
    for (const entry of modelRequests) assert.deepEqual(entry.request.tools.map(tool => tool.name).sort(), [...visibleTools].sort())
    assert.ok(modelRequests.every(entry => entry.status === 200 && entry.model === admission.model && entry.messageId !== null))
    assert.ok(modelRequests.every(entry => entry.protocolComplete && entry.stopReason !== null && typeof entry.usage.output_tokens === 'number'))
    assert.ok(modelRequests.length > 0 && modelRequests.length <= maximumModelRequests,
      'the authorized live run must stay inside its declared model-request budget')
    assert.deepEqual([...new Set(sentImages.map(image => image.original))].sort(), [...expectedHashes].sort(), 'the model must receive both distinct seed images')
    const imageRequestIndex = modelRequests.findIndex(entry => entry.images.length >= 2)
    assert.ok(imageRequestIndex >= 0, 'both images must be present in one model request')
    assert.deepEqual(compareCalls.map(call => call.name), ['map_compare_views'], 'the model must compare the seeded pair')
    assert.equal(markCalls.length, 1, 'the model must submit exactly one bounded change batch')
    const compareResult = results.find(result => result.data.meta.kind === 'map-visual-comparison')
    assert.ok(compareResult, 'the comparison result must be persisted before the change proposal')
    const afterCompareAssistant = assistantMessages.filter(event => event.seq > compareResult.seq)
    assert.ok(afterCompareAssistant.some(event => event.data.message.content.some(block => block.type === 'tool-call' && block.id === markCalls[0].callId)),
      'the model must produce map_mark_changes after both images and the comparison result are in its history')
    assert.deepEqual(calls.map(call => call.name), [...comparisonTools])
    assert.equal(results.filter(result => result.data.meta.kind === 'map-visual-comparison').length, 1)
    assert.equal(results.filter(result => result.data.meta.kind === 'map-visual-change').length, 1)
    assert.equal(state.comparisons.length, 1)
    assert.equal(state.visualChanges.length, 1)
    assert.equal(state.comparisons[0].beforeAttachmentSha256, seed.records[0].attachment.sha256)
    assert.equal(state.comparisons[0].afterAttachmentSha256, seed.records[1].attachment.sha256)
    assert.equal(state.visualChanges[0].comparisonId, state.comparisons[0].comparisonId)
    assert.equal(state.visualChanges[0].kind, 'appeared')
    assert.equal(state.visualChanges[0].pixelGeometry.type, 'bbox')
    const corners = state.visualChanges[0].pixelGeometry.corners
    const center = {
      x: corners.reduce((total, corner) => total + corner[0], 0) / corners.length,
      y: corners.reduce((total, corner) => total + corner[1], 0) / corners.length,
    }
    report.geometryOracle = { corners, center, expected: { left: 320, top: 245, right: 480, bottom: 355 } }
    assert.ok(center.x >= 320 && center.x <= 480 && center.y >= 245 && center.y <= 355,
      'the candidate must locate the red building that exists only in the after image')
    assert.doesNotMatch(finalText, /\b\d{1,3}(\.\d+)?%\b/u)
    assert.doesNotMatch(JSON.stringify(results), /accuracy|precision|recall|置信度\s*[:=]?\s*\d/iu)
    report.ok = true
  } catch (error) {
    report.error = String(error)
    report.relay = relay === undefined ? null : {
      failure: relay.failure,
      requests: relay.requests.map(({ request, ...entry }) => entry),
    }
    report.pageErrors = pageErrors
    report.denied = existsSync(deniedLog)
      ? readFileSync(deniedLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      : []
    try {
      const raw = observationSessionLogs(home).map(path => readObservationSessionLog(path)).find(text => text.includes(sessionId))
      report.events = raw === undefined ? null : raw.trim().split('\n').map(line => JSON.parse(line))
    } catch (inner) {
      report.eventsError = String(inner)
    }
    if (page !== undefined && !page.isClosed()) {
      report.page = (await page.locator('body').innerText().catch(inner => `page unavailable: ${String(inner)}`)).slice(-8000)
      report.mapDiagnostics = await page.evaluate(() => ({
        selectedSessionId: document.querySelector('[data-map-session-action]')?.getAttribute('data-map-session-action') ?? null,
        receiptKeys: [...(window.__mapHarness?.keys?.() ?? [])],
        receipts: [...(window.__mapHarness?.values?.() ?? [])].map(handle => ({
          status: handle.renderReceipt?.status ?? null,
          sessionId: handle.renderReceipt?.sessionId ?? null,
          occurrenceKey: handle.renderReceipt?.occurrenceKey ?? null,
          revision: handle.renderReceipt?.revision ?? null,
          renderedRevision: handle.renderReceipt?.renderedRevision ?? null,
          viewId: handle.renderReceipt?.viewId ?? null,
          failedLayers: handle.renderReceipt?.failedLayers ?? [],
          reason: handle.renderReceipt?.reason ?? null,
          layerCount: handle.layerCount ?? null,
          observationHistory: handle.observationHistory?.length ?? null,
        })),
      })).catch(inner => ({ unavailable: String(inner) }))
      await page.screenshot({ path: join(evidence, 'failure.png') }).catch(inner => { report.screenshotError = String(inner) })
    }
    report.hostLog = stderr.value.slice(-6000).replaceAll(apiKey, '[redacted]')
    report.hostStdout = stdout.value.slice(-6000).replaceAll(apiKey, '[redacted]')
    throw error
  } finally {
    await browser?.close().catch(inner => { report.browserCloseError = String(inner) })
    if (app !== undefined) await Promise.resolve(stopProcessTree(app)).catch(inner => { report.processStopError = String(inner) })
    try {
      relay?.abort()
      if (relay !== undefined) {
        relay.server.closeAllConnections()
        await new Promise((resolveClose, rejectClose) => relay.server.close(error => error === undefined ? resolveClose() : rejectClose(error)))
      }
    } catch (inner) {
      report.relayCloseError = String(inner)
    }
    await Promise.resolve(temporaryRoot.dispose()).catch(inner => { report.temporaryCleanupError = String(inner) })
    writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
  }
  return report
}
