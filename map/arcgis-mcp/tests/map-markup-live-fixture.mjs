/**
 * Opt-in real visual markup qualification: an isolated synthetic scene, the
 * project's configured DeepSeek vision model through a recording-only relay,
 * and host-derived geometry oracles. It proves that the real model sees the
 * image and proposes traceable candidates, never detection accuracy.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { spawn } from 'node:child_process'
import SessionStore, { SessionId } from '../../../packages/core/session/lib/index.js'
import * as JsonlSessionPersistence from '../../../packages/session/session-persistence-jsonl/lib/index.js'
import { createMessage, createToolResultMessage } from '../../../packages/llm/llm/lib/index.js'
import { PUBLIC_BASE_URL, requestModelListing } from '../../../packages/llm/llm-deepseek/lib/index.js'
import { buildMapChangeMeta } from '../../map-container/src/protocol.ts'
import { symbolVersionOf } from '../../layers/src/contract.ts'
import { trackedTmpDir, waitFor, withTrackedTmpDir } from '../../tests/support/reliability.mjs'
import { createMapUseRecordingRelay } from './map-use-live-fixture.mjs'

const modelId = 'deepseek-flash'
const allowedTools = new Set(['map_observe', 'map_markup'])
const origin = new URL(PUBLIC_BASE_URL).origin
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const blue = '#1769d2'
const targetCenter = [116.4, 39.9]
const targetRing = [[-0.12, 0.16], [0.14, -0.1], [-0.14, -0.12], [-0.12, 0.16]]
const goal = '请只根据 map_observe 返回的地图截图，用 map_markup 提出恰好一个 target 候选框住蓝色三角形。先 map_observe，再调用一次 map_markup（purpose=target，items 数组恰好一项，pixelGeometry 必须是一个扁平对象 {type:"bbox",corners:[[x,y]×4]}，单位是截图输出图像像素，不要嵌套在其它键下；confidence 只能 uncertain 或 likely，不要编概率）。候选类别写“蓝色三角形”，note 简短说明视觉依据。不要读文件、查询几何、猜图层 ID 或使用其他工具；本场景只允许 map_observe/map_markup。若看不到目标，返回空 items 并说明限制。最后独立一行写 VISUAL_MARKUP_ENDED。'

function layersOf() {
  const layers = [
    { ring: targetRing.map(([longitude, latitude]) => [longitude + targetCenter[0], latitude + targetCenter[1]]), color: blue, name: 'Target triangle' },
    { ring: [[0.3, 0.35], [0.55, 0.2], [0.3, 0.12], [0.3, 0.35]], color: '#2a9d55', name: 'Reference square' },
    { ring: [[-0.5, -0.45], [-0.28, -0.35], [-0.5, -0.25], [-0.5, -0.45]], color: '#d33636', name: 'Reference triangle' },
  ]
  return layers.map((item, index) => {
    const draft = { methodVersion: 'map-layers@1', presentation: 'single', fill: { color: item.color, opacity: 0.9, outlineColor: item.color, outlineWidthPx: 2 } }
    return {
      id: `markup-layer-${index + 1}`, name: item.name, sourceCrs: 'EPSG:4326', visible: true, opacity: 1,
      symbol: { ...draft, symbolVersion: symbolVersionOf(draft) },
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: `markup-feature-${index + 1}`, properties: { category: 'sample' }, geometry: { type: 'Polygon', coordinates: [item.ring] } }] },
    }
  })
}

async function seedScene(home, workspace) {
  const sessionId = SessionId('visual-markup')
  const ctx = new (await import('@deepseek-ai/cordis')).Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
    const session = ctx.sessions.create(sessionId, { meta: { cwd: workspace, agentPreset: 'map-analyst' } })
    session.append('session/title', { title: 'Visual markup qualification', messageSeqs: [], source: { kind: 'user' } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { id: 'setup', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'An isolated synthetic visual markup scene is ready.' }] }, { surfaceOp: 'append' })
    const layers = layersOf()
    const content = layers.map(layer => ({ type: 'tool-call', id: `seed-${layer.id}`, name: 'map_add_layer', arguments: JSON.stringify({ path: 'prepared-scene' }) }))
    const time = Date.now()
    const stream = content.flatMap((block, index) => [
      { type: 'chunk', time, chunk: { type: 'block-start', index, blockType: 'tool-call' } },
      { type: 'tool-call-chunks', time0: time, index, dt: [], id: block.id, name: block.name, args: [block.arguments] },
      { type: 'chunk', time, chunk: { type: 'block-end', index, block } },
    ])
    stream.push({ type: 'chunk', time, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } })
    session.append('assistant/message', { turn: 1, step: 1, message: createMessage({ role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content }), stream }, { surfaceOp: 'append' })
    let revision = 0
    for (const layer of layers) {
      const callId = `seed-${layer.id}`
      const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'map_add_layer', arguments: JSON.stringify({ path: 'prepared-scene' }) })
      session.append('tool/result', {
        turn: 1, step: 1, message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'Synthetic layer prepared.' }], isError: false }),
        meta: buildMapChangeMeta(call.seq, revision++, { op: 'add-layer', layer: { ...layer, sourceCallSeq: call.seq } }),
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'done' } })
    const handle = await ctx.sessionPersistence.create(session.header)
    await handle.append(session.snapshotEvents())
    await handle.close()
    const reader = await ctx.sessionPersistence.open(session.id, 'read')
    try { await reader.read() } finally { await reader.close() }
    return { sessionId: session.id, target: { vertices: layers[0].data.features[0].geometry.coordinates[0].slice(0, 3) } }
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Polygon containment for one point against the independent projected triangle. */
function insideProjectedPolygon(point, vertices) {
  let crossings = 0
  for (let index = 0; index < vertices.length; index += 1) {
    const a = vertices[index]
    const b = vertices[(index + 1) % vertices.length]
    if ((a.y > point.y) !== (b.y > point.y)) {
      const x = a.x + (point.y - a.y) * (b.x - a.x) / (b.y - a.y)
      if (x > point.x) crossings += 1
    }
  }
  return crossings % 2 === 1
}

/** Run one isolated real-model markup qualification. */
export async function runMapMarkupLiveQualification(options) {
  return withTrackedTmpDir('map-markup-live-evidence', ({ path }) => runMapMarkupLiveQualificationIn(path, options))
}

async function runMapMarkupLiveQualificationIn(evidenceRoot, options) {
  const { root, mapBin, pickerPatch, chromium, listen, stopProcessTree, waitForAppUrl, maybeContinueNotice, connectWorkspace, sendMessage, waitForRenderedReceipt, useFixtureBasemap, observationSessionLogs, readObservationSessionLog } = options
  const project = process.env.MAP_MARKUP_LIVE_KEY_SOURCE === 'project-env' ? parseEnv(readFileSync(join(root, '.env'), 'utf8')) : process.env
  const apiKey = project.DEEPSEEK_API_KEY
  assert.ok(apiKey, 'A real project credential is required; there is no mock fallback')
  const listing = await requestModelListing(new URL('/models', origin).href, { 'x-api-key': apiKey }, AbortSignal.timeout(30000))
  const currentModel = listing.entries.find(entry => entry.id === modelId)
  assert.ok(currentModel?.capabilities.usable && currentModel.capabilities.facts.inputModalities.includes('image'))
  const runId = new Date().toISOString().replace(/[:.]/gu, '-')
  const evidence = join(evidenceRoot, 'evidence')
  mkdirSync(evidence, { recursive: true })
  const temporaryRoot = trackedTmpDir('map-markup-live')
  const temporary = realpathSync(temporaryRoot.path)
  const home = join(temporary, 'home')
  const workspace = join(temporary, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  const report = { runId, model: currentModel, transport: { kind: 'transparent-recording-relay', upstreamOrigin: origin, responseFallback: false }, criteria: { requiredCandidates: 1, bboxOverlapsTarget: true, bboxCornerErrorPx: 40, noForbiddenTools: true, noProbabilityClaims: true }, ok: false }
  writeFileSync(join(evidence, 'registered-plan.json'), JSON.stringify({ goal, criteria: report.criteria }, null, 2))
  let app
  let browser
  let relay
  let page
  const pageErrors = []
  const stdout = { value: '' }
  const stderr = { value: '' }
  const captures = []
  const deniedLog = join(temporary, 'denied.jsonl')
  try {
    const scene = await seedScene(home, workspace)
    report.target = scene.target
    relay = createMapUseRecordingRelay({ apiKey, directory: evidence, beforeFirstImage: async () => {} })
    const port = await listen(relay.server)
    const overlay = join(temporary, 'visual.overlay.yml')
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
- id: llm-deepseek
  config:
    models:
      - id: ${modelId}
        name: DeepSeek-V4.1-Flash
        inputModalities: [text, image]
        contextWindow: 1048576
        maxTokens: 8192
        systemPromptUpdate: in-history
        toolUpdate: addition-only
- insert:
    - id: map-markup-live-guard
      name: ${JSON.stringify(fileURLToPath(new URL('./map-markup-live-guard.mjs', import.meta.url)))}
      config:
        log: ${JSON.stringify(deniedLog)}
`)
    report.configurationSha256 = hash(readFileSync(overlay, 'utf8'))
    app = spawn(process.execPath, [mapBin, '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
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
    browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 820 } })
    page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(String(error)))
    await useFixtureBasemap(page)
    await page.route(/\/api\/map\/observation$/u, async route => {
      const request = route.request()
      const body = request.postDataJSON()
      if (body?.kind === 'capture') {
        const bytes = Buffer.from(body.capture.pngBase64, 'base64')
        writeFileSync(join(evidence, `observe-${captures.length + 1}.png`), bytes)
        const { pngBase64, ...capture } = body.capture
        const control = await page.evaluate(target => {
          const handle = [...window.__mapHarness.values()][0]
          return { vertices: target.vertices.map(vertex => handle.screenOf(...vertex)), center: handle.screenOf(116.4, 39.9), receipt: handle.renderReceipt }
        }, scene.target)
        captures.push({ callId: body.callId, revision: body.revision, sha256: hash(bytes), ...capture, control })
      }
      await route.continue()
    })
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    const group = page.getByRole('treeitem', { name: /Ungrouped|未分组/u })
    if (await group.count() > 0 && await group.first().getAttribute('aria-expanded') === 'false') await group.first().click()
    await page.locator('[role="treeitem"]').filter({ hasText: /Visual markup qualification|未命名|Untitled/u }).last().click()
    await waitForRenderedReceipt(page)
    await page.waitForFunction(() => [...window.__mapHarness.values()].some(handle => handle.layerCount === 3))
    await page.screenshot({ path: join(evidence, 'before.png') })
    await sendMessage(page, goal)
    await page.getByText('VISUAL_MARKUP_ENDED', { exact: true }).last().waitFor({ timeout: 240000 })
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30000 })
    await waitFor(() => relay.requests.every(entry => entry.completed), { timeoutMs: 5000, label: 'upstream protocol requests reach quiescence' })
    await page.screenshot({ path: join(evidence, 'after.png') })
    const state = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()][0]
      return { proposals: handle.visualProposals, receipt: handle.renderReceipt, observation: handle.latestObservation }
    })
    const raw = observationSessionLogs(home).map(path => readObservationSessionLog(path)).find(text => text.includes(scene.sessionId))
    assert.ok(raw, 'the qualification must persist its session log')
    const events = raw.trim().split('\n').map(line => JSON.parse(line))
    const calls = events.filter(event => event.type === 'tool/call' && event.data.turn > 1).map(event => ({ seq: event.seq, ...event.data, args: JSON.parse(event.data.arguments) }))
    const results = events.filter(event => event.type === 'tool/result' && event.data.turn > 1)
    const modelRequests = relay.requests.filter(entry => entry.path.endsWith('/messages'))
    const sentImages = modelRequests.flatMap(entry => entry.images)
    const captureHashes = new Set(captures.map(capture => capture.sha256))
    const denied = existsSync(deniedLog) ? readFileSync(deniedLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
    const markupCalls = calls.filter(call => call.name === 'map_markup')
    const markupResults = results.filter(event => event.data.meta?.kind === 'map-visual-proposal')
    const finalText = events.filter(event => event.type === 'assistant/message' && event.data.turn > 1).map(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')).at(-1) ?? ''
    report.state = state
    report.calls = calls
    report.denied = denied
    report.captures = captures
    report.upstream = modelRequests.map(({ request, ...entry }) => entry)
    report.imageMatches = sentImages.map(image => ({ ...image, fromCapture: captureHashes.has(image.original) }))
    report.pageErrors = pageErrors
    writeFileSync(join(evidence, 'events.json'), JSON.stringify(events.filter(event => ['tool/call', 'tool/result', 'turn/start', 'turn/end'].includes(event.type)), null, 2))
    assert.equal(relay.failure, undefined)
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(denied, [])
    assert.ok(calls.every(call => allowedTools.has(call.name)))
    assert.ok(modelRequests.length > 1 && modelRequests.every(entry => entry.status === 200 && entry.model === modelId && entry.messageId !== null))
    assert.ok(modelRequests.every(entry => entry.protocolComplete && entry.stopReason !== null && typeof entry.usage.output_tokens === 'number'))
    for (const entry of modelRequests) assert.deepEqual(entry.request.tools.map(tool => tool.name).sort(), [...allowedTools].sort())
    assert.ok(sentImages.length > 0 && sentImages.every(image => captureHashes.has(image.original)))
    assert.ok(captures.every(capture => sentImages.some(image => image.original === capture.sha256)))
    assert.ok(captures.length > 0)
    assert.ok(captures.every(capture => capture.control.receipt.status === 'rendered' && capture.control.receipt.renderedRevision === capture.revision))
    assert.equal(markupCalls.length, 1, 'the model must submit exactly one map_markup call')
    assert.equal(markupResults.length, 1, 'the markup result must fold exactly once')
    assert.equal(calls[0].name, 'map_observe', 'the model must observe before proposing')
    assert.equal(state.proposals.length, report.criteria.requiredCandidates)
    const proposal = state.proposals[0]
    assert.equal(proposal.status, 'proposed')
    assert.equal(proposal.observationId, state.observation.observationId)
    assert.equal(proposal.observationAttachmentSha256, state.observation.attachment.sha256)
    assert.equal(proposal.modelName, modelId)
    assert.equal(proposal.purpose, 'target')
    assert.equal(['uncertain', 'likely'].includes(proposal.confidence), true)
    assert.match(proposal.category, /三角|triangle/iu)
    const result = markupResults[0].data.meta.record
    assert.equal(result.proposals.length, 1)
    assert.equal(result.proposals[0].proposalId, proposal.proposalId)
    const markupCall = markupCalls[0]
    const item = markupCall.args.items[0]
    assert.equal(item.confidence, proposal.confidence)
    assert.equal(item.pixelGeometry.type, 'bbox')
    assert.equal(item.pixelGeometry.corners.length, 4)
    const capture = captures.find(entry => entry.callId === result.proposals[0].sourceCallId - 1 >= 0 ? entry.revision === result.proposals[0].mapRevision : false) ?? captures.at(-1)
    const projected = result.proposals[0].pixelGeometry.type === 'bbox' ? result.proposals[0].pixelGeometry.corners : []
    const projectedPolygon = projected.map(point => ({ x: point[0], y: point[1] }))
    const centroid = projectedPolygon.length === 4
      ? { x: projectedPolygon.reduce((total, point) => total + point.x, 0) / 4, y: projectedPolygon.reduce((total, point) => total + point.y, 0) / 4 }
      : undefined
    const targetCentroid = {
      x: capture.control.vertices.reduce((total, point) => total + point.x, 0) / capture.control.vertices.length,
      y: capture.control.vertices.reduce((total, point) => total + point.y, 0) / capture.control.vertices.length,
    }
    const overlaps = projectedPolygon.length === 4 && projectedPolygon.some(point => insideProjectedPolygon(point, capture.control.vertices))
      || capture.control.vertices.some(vertex => insideProjectedPolygon(vertex, projectedPolygon))
    report.geometryOracle = { projectedPolygon, centroid, targetCentroid, overlaps }
    assert.equal(report.geometryOracle.overlaps, true, 'the bbox must overlap the independent projected target')
    report.cornerErrorPx = Math.max(...projectedPolygon.map(point => Math.hypot(point.x - targetCentroid.x, point.y - targetCentroid.y)))
    assert.ok(report.cornerErrorPx <= report.criteria.bboxCornerErrorPx, `bbox corners drift ${report.cornerErrorPx}px from the target centroid`)
    assert.doesNotMatch(finalText, /\b\d{1,3}(\.\d+)?%\b/u)
    assert.doesNotMatch(JSON.stringify(result), /accuracy|precision|recall|置信度\s*[:=]?\s*\d/iu)
    assert.equal(state.receipt.revision > capture.revision, true, 'the accepted candidate must advance the map revision')
    report.ok = true
  } catch (error) {
    report.error = String(error)
    if (page !== undefined && !page.isClosed()) {
      report.page = (await page.locator('body').innerText().catch(inner => `page unavailable: ${String(inner)}`)).slice(-8000)
      await page.screenshot({ path: join(evidence, 'failure.png') }).catch(inner => { report.screenshotError = String(inner) })
    }
    report.hostLog = stderr.value.slice(-6000).replaceAll(apiKey, '[redacted]')
    throw error
  } finally {
    await browser?.close()
    if (app !== undefined) await stopProcessTree(app)
    relay?.abort()
    if (relay !== undefined) { relay.server.closeAllConnections(); await new Promise(resolveClose => relay.server.close(resolveClose)) }
    writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
    await temporaryRoot.dispose()
  }
  return report
}
