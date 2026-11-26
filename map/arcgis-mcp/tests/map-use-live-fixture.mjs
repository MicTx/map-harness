/** Opt-in real-model qualification with isolated scenes and a recording-only upstream relay. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { spawn } from 'node:child_process'
import sharp from 'sharp'
import SessionStore, { SessionId } from '../../../packages/core/session/lib/index.js'
import * as JsonlSessionPersistence from '../../../packages/session/session-persistence-jsonl/lib/index.js'
import { createMessage, createToolResultMessage } from '../../../packages/llm/llm/lib/index.js'
import { PUBLIC_BASE_URL, requestModelListing } from '../../../packages/llm/llm-deepseek/lib/index.js'
import { buildMapChangeMeta } from '../../map-container/src/protocol.ts'
import { symbolVersionOf } from '../../layers/src/contract.ts'
import { trackedTmpDir, waitFor, withTrackedTmpDir } from '../../tests/support/reliability.mjs'

const modelId = 'deepseek-flash'
const title = 'Visual map qualification'
const allowedTools = new Set(['map_observe', 'map_use'])
const origin = new URL(PUBLIC_BASE_URL).origin
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const layouts = [
  { seed: 101, centers: [[116.1, 40.8], [95.2, 42.1], [103.3, 29.7]], order: [1, 0, 2] },
  { seed: 211, centers: [[94.1, 31.8], [114.3, 41.9], [104.8, 44.1]], order: [2, 1, 0] },
  { seed: 307, centers: [[107.7, 45.2], [94.6, 33.2], [114.2, 30.5]], order: [0, 2, 1] },
  { seed: 401, centers: [[114.6, 29.3], [96.7, 40.6], [110.2, 44.1]], order: [1, 2, 0] },
  { seed: 503, centers: [[93.8, 42.4], [111.4, 42.6], [103.6, 29.4]], order: [2, 0, 1] },
]
const goal = '请只根据 map_observe 返回的地图截图，找到蓝色三角形。先简短描述你看到的图形组合，然后用 map_use 平移把蓝色三角形移到画面中心附近（约20像素内），重新观察，再围绕它放大约一级，再观察并点击蓝色三角形确认命中，最后 finish 并简短说明结果。每次只调用一个工具，每次动作使用最新 observation_id，动作后重新观察。不要读文件、查询几何、使用地理定位工具或猜图层ID；本场景只允许 map_observe/map_use。若截图看不到目标，不要猜坐标，应说明无法完成；遇到用户接管或预算不足，立即说明并结束，不要重试。最后独立一行写 VISUAL_QUALIFICATION_ENDED（这只是流程结束标记，不代表任务成功）。'

function layersOf(layout) {
  const rings = [
    [[0, 1], [1.1, -0.8], [-1.1, -0.8], [0, 1]],
    [[-1, -0.8], [1, -0.8], [1, 0.8], [-1, 0.8], [-1, -0.8]],
    [[0, 1], [1, 0], [0, -1], [-1, 0], [0, 1]],
  ]
  const colors = ['#1769d2', '#d33636', '#2a9d55']
  return layout.order.map((shape, index) => {
    const center = layout.centers[shape]
    const draft = { methodVersion: 'map-layers@1', presentation: 'single', fill: { color: colors[shape], opacity: 0.85, outlineColor: colors[shape], outlineWidthPx: 1 } }
    return {
      id: `layer-${layout.seed}-${index + 1}`, name: `Layer ${index + 1}`, sourceCrs: 'EPSG:4326', visible: true, opacity: 1,
      symbol: { ...draft, symbolVersion: symbolVersionOf(draft) },
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: `item-${index + 1}`, properties: { category: 'sample' }, geometry: { type: 'Polygon', coordinates: [rings[shape].map(([longitude, latitude]) => [longitude + center[0], latitude + center[1]])] } }] },
    }
  })
}

async function seedScene(home, workspace, layout) {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
    const session = ctx.sessions.create(SessionId(`visual-${layout.seed}`), { meta: { cwd: workspace, agentPreset: 'map-analyst' } })
    session.append('session/title', { title, messageSeqs: [], source: { kind: 'user' } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', { id: `setup-${layout.seed}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'An isolated synthetic scene is ready for visual inspection.' }] }, { surfaceOp: 'append' })
    const layers = layersOf(layout)
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
    const targetIndex = layout.order.indexOf(0)
    return { sessionId: session.id, target: { layerId: layers[targetIndex].id, featureId: `item-${targetIndex + 1}`, center: layout.centers[0], vertices: layers[targetIndex].data.features[0].geometry.coordinates[0].slice(0, 3) } }
  } finally { await ctx.fiber.dispose() }
}

function cleanRequest(value) {
  if (Array.isArray(value)) return value.map(cleanRequest)
  if (value === null || typeof value !== 'object') return value
  if (value.type === 'base64' && typeof value.data === 'string') return { ...value, data: `[sha256:${hash(Buffer.from(value.data, 'base64'))}]` }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cleanRequest(entry)]))
}

async function blankPng(bytes) {
  const { width, height } = await sharp(bytes).metadata()
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).png().toBuffer()
}

/**
 * Test a click against fixture vertices independently projected by the SDK.
 * @param point - clicked CSS-pixel position.
 * @param vertices - three projected triangle vertices in winding order.
 * @returns whether the click is inside the triangle or its one-pixel boundary.
 */
export function insideProjectedTriangle(point, vertices) {
  const distances = vertices.map((vertex, index) => {
    const next = vertices[(index + 1) % vertices.length]
    return ((next.x - vertex.x) * (point.y - vertex.y) - (next.y - vertex.y) * (point.x - vertex.x)) / Math.hypot(next.x - vertex.x, next.y - vertex.y)
  })
  return distances.every(distance => distance >= -1) || distances.every(distance => distance <= 1)
}

/**
 * Relay provider bytes while recording image identity and terminal protocol evidence.
 * @param options - isolated storage, authentication and optional test transport.
 * @returns the server and its bounded request observations.
 */
export function createMapUseRecordingRelay({ apiKey, directory, ablate, beforeFirstImage, fetchUpstream = fetch }) {
  const requests = []
  const uploads = new Map()
  const controllers = new Set()
  let notified = false
  let failure
  async function handle(request, response) {
    const controller = new AbortController()
    controllers.add(controller)
    response.on('close', () => { if (!response.writableEnded) controller.abort() })
    const timer = setTimeout(() => controller.abort(), 90000)
    let entry
    try {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 64 * 1024 * 1024) throw new Error('Qualification relay request exceeded 64 MiB')
        chunks.push(chunk)
      }
      let body = Buffer.concat(chunks)
      const upstreamUrl = new URL(request.url, origin)
      assert.equal(upstreamUrl.origin, origin, 'the relay credential is restricted to the configured upstream')
      const path = upstreamUrl.pathname
      assert.ok(path === '/models' || /^\/anthropic\/v1\/(messages|files)(?:\/|$)/u.test(path))
      const headers = new Headers({ 'x-api-key': apiKey })
      for (const key of ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'user-agent']) if (typeof request.headers[key] === 'string') headers.set(key, request.headers[key])
      entry = { index: requests.length, method: request.method, path, images: [], status: null, requestId: null, messageId: null, usage: {}, stopReason: null, protocolComplete: false, completed: false }
      requests.push(entry)
      if (path.endsWith('/files') && request.method === 'POST') {
        const form = await new Request('http://relay/upload', { method: 'POST', headers, body }).formData()
        for (const [key, value] of form.entries()) {
          if (typeof value === 'string') continue
          const original = Buffer.from(await value.arrayBuffer())
          const forwarded = ablate ? await blankPng(original) : original
          entry.images.push({ original: hash(original), forwarded: hash(forwarded) })
          if (ablate) form.set(key, new Blob([forwarded], { type: value.type }), value.name)
        }
        if (ablate) { body = form; headers.delete('content-type') }
      }
      if (path.endsWith('/messages') && body.length > 0) {
        const parsed = JSON.parse(body.toString('utf8'))
        entry.model = parsed.model
        async function visit(value) {
          if (Array.isArray(value)) { for (const item of value) await visit(item); return }
          if (value === null || typeof value !== 'object') return
          if (value.type === 'image' && value.source?.type === 'base64') {
            const original = Buffer.from(value.source.data, 'base64')
            const forwarded = ablate ? await blankPng(original) : original
            entry.images.push({ original: hash(original), forwarded: hash(forwarded) })
            if (ablate) value.source.data = forwarded.toString('base64')
          } else if (value.type === 'image' && value.source?.type === 'file') {
            const uploaded = uploads.get(value.source.file_id)
            assert.ok(uploaded, 'every file-referenced image must have a recorded upload')
            entry.images.push(uploaded)
          }
          for (const item of Object.values(value)) await visit(item)
        }
        await visit(parsed.messages)
        entry.request = cleanRequest(parsed)
        if (entry.images.length > 0 && !notified) { notified = true; await beforeFirstImage() }
        body = Buffer.from(JSON.stringify(parsed))
      }
      const upstream = await fetchUpstream(upstreamUrl, { method: request.method, headers, ...(request.method === 'GET' || request.method === 'DELETE' ? {} : { body }), redirect: 'error', signal: controller.signal })
      entry.status = upstream.status
      entry.requestId = upstream.headers.get('x-request-id') ?? upstream.headers.get('request-id') ?? upstream.headers.get('x-ds-request-id') ?? upstream.headers.get('x-ds-trace-id')
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      if (path.endsWith('/files') && request.method === 'POST') {
        const bytes = Buffer.from(await upstream.arrayBuffer())
        if (upstream.ok) {
          const uploaded = JSON.parse(bytes.toString('utf8'))
          assert.equal(entry.images.length, 1)
          uploads.set(uploaded.id, entry.images[0])
        }
        response.end(bytes)
        return
      }
      let buffered = ''
      for await (const chunk of upstream.body) {
        response.write(chunk)
        if (!path.endsWith('/messages')) continue
        buffered += Buffer.from(chunk).toString('utf8')
        const lines = buffered.split('\n')
        buffered = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ') || line.slice(6).trim() === '[DONE]') continue
          const event = JSON.parse(line.slice(6))
          if (event.type === 'message_start') { entry.messageId = event.message.id; entry.responseModel = event.message.model; Object.assign(entry.usage, event.message.usage) }
          if (event.type === 'message_stop') entry.protocolComplete = true
          if (event.type === 'message_delta' && event.delta?.stop_reason != null) entry.stopReason = event.delta.stop_reason
          if (event.usage) Object.assign(entry.usage, event.usage)
        }
      }
      response.end()
    } catch (error) {
      if (error?.name === 'AbortError' && entry?.protocolComplete && controller.signal.aborted) entry.closedAfterMessageStop = true
      else failure ??= String(error)
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' }).end('{"error":{"type":"relay_error","message":"The qualification relay failed."}}')
      else response.destroy()
    } finally {
      clearTimeout(timer)
      controllers.delete(controller)
      if (entry !== undefined) entry.completed = true
      writeFileSync(join(directory, 'upstream.json'), JSON.stringify(requests, null, 2))
    }
  }
  const server = createServer((request, response) => { void handle(request, response) })
  return { server, requests, get failure() { return failure }, abort() { for (const controller of controllers) controller.abort() } }
}

/**
 * Exercise genuine vision decisions and retain every result, including failed trials.
 * @param options - owning composition helpers; no model response fixture is supplied.
 * @returns the complete qualification report, or rejects after writing all trials.
 */
export async function runMapUseLiveQualification(options) {
  return withTrackedTmpDir('map-use-live-evidence', ({ path }) => runMapUseLiveQualificationIn(path, options))
}

async function runMapUseLiveQualificationIn(evidenceRoot, options) {
  const { root, mapBin, pickerPatch, chromium, listen, stopProcessTree, waitForAppUrl, maybeContinueNotice, connectWorkspace, sendMessage, waitForRenderedReceipt, useFixtureBasemap, observationSessionLogs, readObservationSessionLog } = options
  const project = process.env.MAP_USE_LIVE_KEY_SOURCE === 'project-env' ? parseEnv(readFileSync(join(root, '.env'), 'utf8')) : process.env
  const apiKey = project.DEEPSEEK_API_KEY
  assert.ok(apiKey, 'A real project credential is required; there is no mock fallback')
  const listing = await requestModelListing(new URL('/models', origin).href, { 'x-api-key': apiKey }, AbortSignal.timeout(30000))
  const currentModel = listing.entries.find(entry => entry.id === modelId)
  assert.ok(currentModel?.capabilities.usable && currentModel.capabilities.facts.inputModalities.includes('image'))
  const runId = new Date().toISOString().replace(/[:.]/gu, '-')
  const evidence = join(evidenceRoot, 'evidence')
  mkdirSync(evidence, { recursive: true })
  const scenarios = [...layouts.map((layout, index) => ({ mode: 'goal', layout, theme: index % 2 === 0 ? 'light' : 'dark' })), ...['ablation', 'takeover', 'budget'].map(mode => ({ mode, layout: layouts[0], theme: 'light' }))]
  const selected = process.env.MAP_USE_LIVE_CASES?.split(',')
  const report = { runId, model: currentModel, transport: { kind: 'transparent-recording-relay', upstreamOrigin: origin, responseFallback: false }, criteria: { firstClick: 'target only, inside independent projected triangle', boundaryTolerancePx: 1, centerTolerancePx: 32, minimumScaleRatio: 0.6, noForbiddenTools: true }, trials: [] }
  writeFileSync(join(evidence, 'registered-plan.json'), JSON.stringify({ scenarios, goal, criteria: report.criteria }, null, 2))
  for (const [index, scenario] of scenarios.entries()) {
    if (selected !== undefined && !selected.includes(String(index + 1))) continue
    const directory = join(evidence, `${index + 1}-${scenario.mode}`)
    mkdirSync(directory)
    const temporaryRoot = trackedTmpDir('map-use-live')
    const temporary = realpathSync(temporaryRoot.path)
    const home = join(temporary, 'home')
    const mapHome = join(temporary, 'map-home')
    const workspace = join(temporary, 'workspace')
    mkdirSync(workspace)
    mkdirSync(home)
    let app
    let browser
    let relay
    let page
    const trial = { index: index + 1, mode: scenario.mode, seed: scenario.layout.seed, theme: scenario.theme, ok: false, error: null }
    report.trials.push(trial)
    const captures = []
    const controls = []
    const pageErrors = []
    const stdout = { value: '' }
    const stderr = { value: '' }
    try {
      const scene = await seedScene(home, workspace, scenario.layout)
      trial.target = scene.target
      const denyLog = join(temporary, 'denied.jsonl')
      relay = createMapUseRecordingRelay({ apiKey, directory, ablate: scenario.mode === 'ablation', beforeFirstImage: async () => {
        if (scenario.mode !== 'takeover') return
        await page.getByRole('button', { name: '停止地图操作', exact: true }).click()
        await page.waitForFunction(() => [...window.__mapHarness.values()].some(handle => handle.interaction.stopped === 'user-interrupted'))
      } })
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
          screenshot: allowed
        amap-imagery-labels:
          screenshot: allowed
        tianditu-cia-w:
          screenshot: allowed
    interaction:
      maxActions: ${scenario.mode === 'budget' ? 1 : 20}
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
    - id: map-use-live-guard
      name: ${JSON.stringify(fileURLToPath(new URL('./map-use-live-guard.mjs', import.meta.url)))}
      config:
        log: ${JSON.stringify(denyLog)}
`)
      trial.configurationSha256 = hash(Buffer.from(readFileSync(overlay, 'utf8')))
      app = spawn(process.execPath, [mapBin, '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
        cwd: workspace, env: { ...process.env, MAPHARNESS_HOME: mapHome, DSH_HOME: home, DEEPSEEK_API_KEY: apiKey, DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/anthropic`, DSH_TELEMETRY_MODE: 'DISABLED', DSH_CLIENT_MAP_ORG_NAME: '' },
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      })
      app.stdout.setEncoding('utf8'); app.stderr.setEncoding('utf8')
      app.stdout.on('data', chunk => { stdout.value += chunk })
      app.stderr.on('data', chunk => { stderr.value += chunk })
      const url = await waitForAppUrl(app, stdout, stderr)
      browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
      const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 900 }, colorScheme: scenario.theme, deviceScaleFactor: scenario.layout.seed === 307 ? 2 : 1 })
      page = await context.newPage()
      trial.dpr = await page.evaluate(() => window.devicePixelRatio)
      assert.equal(trial.dpr, scenario.layout.seed === 307 ? 2 : 1)
      page.on('pageerror', error => pageErrors.push(String(error)))
      await useFixtureBasemap(page)
      await page.route(/\/api\/map\/(?:observation|use)$/u, async route => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        const body = request.postDataJSON()
        if (body?.kind === 'capture') {
          const bytes = Buffer.from(body.capture.pngBase64, 'base64')
          const digest = hash(bytes)
          writeFileSync(join(directory, `observe-${captures.length + 1}.png`), bytes)
          const { pngBase64, ...capture } = body.capture
          const control = await page.evaluate(target => {
            const handle = [...window.__mapHarness.values()][0]
            return { targetScreen: handle.screenOf(...target.center), targetVertices: target.vertices.map(vertex => handle.screenOf(...vertex)), receipt: handle.renderReceipt }
          }, scene.target)
          captures.push({ callId: body.callId, revision: body.revision, sha256: digest, ...capture, control })
        }
        if (path === '/api/map/use' && body?.action === 'result') controls.push(await page.evaluate(target => {
          const handle = [...window.__mapHarness.values()][0]
          return { request: handle.interaction.request, observation: handle.latestObservation, targetScreen: handle.screenOf(...target.center), targetVertices: target.vertices.map(vertex => handle.screenOf(...vertex)), camera: handle.camera, receipt: handle.renderReceipt }
        }, scene.target))
        await route.continue()
      })
      await page.goto(url)
      await maybeContinueNotice(page)
      await connectWorkspace(page, workspace)
      const group = page.getByRole('treeitem', { name: /Ungrouped|未分组/u })
      if (await group.count() > 0 && await group.first().getAttribute('aria-expanded') === 'false') await group.first().click()
      await page.locator('[role="treeitem"]').filter({ hasText: new RegExp(`${title}|未命名|Untitled`, 'u') }).last().click()
      await waitForRenderedReceipt(page)
      await page.waitForFunction(() => [...window.__mapHarness.values()].some(handle => handle.layerCount === 3))
      assert.equal(await page.locator('[data-map-container]').first().getAttribute('data-map-session'), scene.sessionId)
      await page.screenshot({ path: join(directory, 'before.png') })
      await sendMessage(page, goal)
      await page.getByText('VISUAL_QUALIFICATION_ENDED', { exact: true }).last().waitFor({ timeout: 180000 })
      await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30000 })
      await waitFor(() => relay.requests.every(entry => entry.completed), { timeoutMs: 5000, label: 'upstream protocol requests reach quiescence' })
      await page.screenshot({ path: join(directory, 'after.png') })
      const state = await page.evaluate(target => {
        const handle = [...window.__mapHarness.values()][0]
        return { interaction: handle.interaction, receipt: handle.renderReceipt, camera: handle.camera, observation: handle.latestObservation, targetScreen: handle.screenOf(...target) }
      }, scene.target.center)
      const raw = observationSessionLogs(home).map(path => readObservationSessionLog(path)).find(text => text.includes(scene.sessionId))
      assert.ok(raw)
      const events = raw.trim().split('\n').map(line => JSON.parse(line))
      const calls = events.filter(event => event.type === 'tool/call' && event.data.turn > 1).map(event => ({ seq: event.seq, time: event.time, ...event.data, args: JSON.parse(event.data.arguments) }))
      const results = events.filter(event => event.type === 'tool/result' && event.data.turn > 1)
      const denied = existsSync(denyLog) ? readFileSync(denyLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
      const pixels = calls.filter(call => call.name === 'map_use' && call.args.action !== 'finish')
      const clicked = pixels.filter(call => call.args.action === 'click')
      const modelRequests = relay.requests.filter(entry => entry.path.endsWith('/messages'))
      const sentImages = modelRequests.flatMap(entry => entry.images)
      const captureHashes = new Set(captures.map(capture => capture.sha256))
      const successfulClicks = results.filter(event => event.data.meta?.kind === 'map-use' && event.data.meta.record.action === 'click')
      const assistant = events.filter(event => event.type === 'assistant/message' && event.data.turn > 1).map(event => ({ seq: event.seq, text: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }))
      const earlyRequests = modelRequests.slice(0, modelRequests.findIndex(entry => entry.images.length > 0) + 1)
      const earlyText = JSON.stringify(earlyRequests.map(entry => entry.request.messages))
      const answerLeaks = [JSON.stringify(scene.target.center), JSON.stringify(scene.target.vertices), '#1769d2', '#d33636', '#2a9d55', scene.target.featureId].filter(token => earlyText.includes(token))
      const refusalCodes = results.filter(event => event.data.message.isError).map(event => ({ seq: event.seq, callId: event.data.message.toolCallId, text: event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') }))
      Object.assign(trial, { state, calls, denied, captures, controls, assistant, refusalCodes, textLeakAudit: { checked: 'host input before and including the first image request', answerLeaks }, imageMatches: sentImages.map(image => ({ ...image, fromCapture: captureHashes.has(image.original) })), upstream: modelRequests.map(({ request, ...entry }) => entry), pageErrors })
      writeFileSync(join(directory, 'events.json'), JSON.stringify(events.filter(event => ['tool/call', 'tool/result', 'turn/start', 'turn/end', 'agent/inbox/spliced'].includes(event.type)), null, 2))
      assert.equal(relay.failure, undefined)
      assert.deepEqual(pageErrors, [])
      assert.deepEqual(denied, [])
      assert.deepEqual(answerLeaks, [])
      assert.ok(calls.every(call => allowedTools.has(call.name)))
      assert.ok(modelRequests.length > 1 && modelRequests.every(entry => entry.status === 200 && entry.model === modelId && entry.messageId !== null && typeof entry.usage.input_tokens === 'number'))
      assert.ok(modelRequests.every(entry => entry.protocolComplete && entry.stopReason !== null && typeof entry.usage.output_tokens === 'number'))
      for (const entry of modelRequests) assert.deepEqual(entry.request.tools.map(tool => tool.name).sort(), [...allowedTools].sort())
      assert.ok(sentImages.length > 0 && sentImages.every(image => captureHashes.has(image.original)))
      assert.ok(captures.every(capture => sentImages.some(image => image.original === capture.sha256)))
      assert.ok(captures.length > 0)
      assert.ok(captures.every(capture => capture.control.receipt.status === 'rendered' && capture.control.receipt.renderedRevision === capture.revision))
      if (scenario.mode === 'ablation') {
        assert.ok(sentImages.every(image => image.original !== image.forwarded))
        assert.equal(successfulClicks.some(event => event.data.meta.record.hits.some(hit => hit.layerId === scene.target.layerId)), false)
        assert.equal(clicked.length, 0, 'blank pixels must not produce guessed clicks')
      } else if (scenario.mode === 'takeover') {
        assert.equal(state.interaction.stopped, 'user-interrupted')
        const refusal = results.find(event => JSON.stringify(event.data.message).includes('USER_INTERRUPTED'))
        assert.ok(refusal, 'a live model action must encounter the user takeover')
        assert.equal(calls.some(call => call.seq > refusal.seq && !(call.name === 'map_use' && call.args.action === 'finish')), false)
        assert.equal(state.receipt.revision, captures[0].revision)
        assert.deepEqual(state.targetScreen, captures[0].control.targetScreen)
      } else if (scenario.mode === 'budget') {
        assert.ok(state.interaction.actions <= 2)
        assert.ok(pixels.length >= 1)
        assert.equal(results.filter(event => event.data.meta?.kind === 'map-use' && event.data.meta.record.action !== 'finish').length, 1, 'one valid action must reach the configured budget')
        const errors = results.filter(event => event.data.message.isError)
        assert.ok(errors.length <= 1)
        assert.equal(state.receipt.revision, captures[0].revision + 1)
        assert.equal(state.receipt.status, 'rendered')
        assert.notDeepEqual(state.targetScreen, captures[0].control.targetScreen)
        assert.equal(controls.filter(control => control.request?.action !== 'finish').length, 1, 'refused attempts must not reach a second client fence')
        assert.equal(state.interaction.actions, errors.length === 1 ? 2 : 1, 'attempts include a refused budget call')
        if (errors.length === 1) {
          assert.match(JSON.stringify(errors[0].data.message), /MAP_BUDGET_EXCEEDED/u)
          assert.equal(calls.some(call => call.seq > errors[0].seq && !(call.name === 'map_use' && call.args.action === 'finish')), false)
        } else assert.equal(state.interaction.lastResult.action, 'finish')
        assert.match(assistant.at(-1).text, /预算|budget|限额|上限|额度|remaining/iu)
        const requestsBeforeReload = relay.requests.filter(entry => entry.path.endsWith('/messages')).length
        await page.reload()
        await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])].some(handle => handle.renderReceipt.status === 'rendered'))
        const restored = await page.evaluate(() => [...window.__mapHarness.values()][0].interaction)
        for (const key of ['actions', 'observations', 'stopped', 'open', 'controlEpoch', 'turnStartSeq']) assert.equal(restored[key], state.interaction[key])
        assert.equal(relay.requests.filter(entry => entry.path.endsWith('/messages')).length, requestsBeforeReload)
        trial.restoredBudget = restored
      } else {
        assert.ok(sentImages.every(image => image.original === image.forwarded))
        assert.equal(clicked.length, 1, 'the first and only click must be the target')
        assert.ok(pixels.some(call => call.args.action === 'pan'))
        assert.ok(pixels.some(call => call.args.action === 'zoom'))
        assert.equal(successfulClicks[0]?.data.meta.record.hits[0]?.layerId, scene.target.layerId)
        assert.equal(successfulClicks[0]?.data.meta.record.hits[0]?.featureId, scene.target.featureId)
        const clickControl = controls.find(control => control.request?.callId === clicked[0].callId)
        assert.ok(clickControl)
        const observed = clickControl.observation
        assert.equal(clickControl.receipt.status, 'rendered')
        assert.equal(clickControl.receipt.renderedRevision, observed.mapRevision)
        const point = { x: (clicked[0].args.x_px - observed.mapContentRect.x) * observed.cssViewSize.width / observed.mapContentRect.width, y: (clicked[0].args.y_px - observed.mapContentRect.y) * observed.cssViewSize.height / observed.mapContentRect.height }
        trial.clickErrorPx = Math.hypot(point.x - clickControl.targetScreen.x, point.y - clickControl.targetScreen.y)
        trial.centerErrorPx = Math.hypot(clickControl.targetScreen.x - observed.cssViewSize.width / 2, clickControl.targetScreen.y - observed.cssViewSize.height / 2)
        trial.scaleRatio = observed.camera.scale / captures[0].camera.scale
        trial.insideProjectedTriangle = insideProjectedTriangle(point, clickControl.targetVertices)
        assert.equal(trial.insideProjectedTriangle, true)
        assert.ok(trial.centerErrorPx <= report.criteria.centerTolerancePx, `target center error ${trial.centerErrorPx}px`)
        assert.ok(trial.scaleRatio <= report.criteria.minimumScaleRatio)
        assert.equal(state.interaction.lastResult.action, 'finish')
        trial.motion = []
        for (const call of pixels.filter(call => call.args.action === 'pan' || call.args.action === 'zoom')) {
          const beforeRecord = results.find(event => event.data.meta?.record?.observationId === call.args.observation_id)?.data.meta.record
          const before = captures.find(capture => capture.callId === beforeRecord?.callId)
          const nextCall = calls.find(candidate => candidate.seq > call.seq && candidate.name === 'map_observe')
          const after = captures.find(capture => capture.callId === nextCall?.callId)
          assert.ok(before && after)
          if (call.args.action === 'pan') {
            const offset = { x: before.cssViewSize.width / 2 - before.control.targetScreen.x, y: before.cssViewSize.height / 2 - before.control.targetScreen.y }
            const distanceBefore = Math.hypot(offset.x, offset.y)
            const distanceAfter = Math.hypot(after.cssViewSize.width / 2 - after.control.targetScreen.x, after.cssViewSize.height / 2 - after.control.targetScreen.y)
            const cosine = (call.args.dx_px * offset.x + call.args.dy_px * offset.y) / (Math.hypot(call.args.dx_px, call.args.dy_px) * distanceBefore)
            assert.ok(cosine > 0.8 && distanceAfter < distanceBefore)
            trial.motion.push({ action: 'pan', cosine, distanceBefore, distanceAfter })
          } else {
            const anchor = { x: ((call.args.anchor_x_px ?? before.mapContentRect.width / 2) - before.mapContentRect.x) * before.cssViewSize.width / before.mapContentRect.width, y: ((call.args.anchor_y_px ?? before.mapContentRect.height / 2) - before.mapContentRect.y) * before.cssViewSize.height / before.mapContentRect.height }
            const factor = before.camera.scale / after.camera.scale
            const expected = { x: anchor.x + (before.control.targetScreen.x - anchor.x) * factor, y: anchor.y + (before.control.targetScreen.y - anchor.y) * factor }
            const drift = Math.hypot(after.control.targetScreen.x - expected.x, after.control.targetScreen.y - expected.y)
            assert.ok(drift <= 0.5)
            assert.ok(after.control.targetScreen.x >= 0 && after.control.targetScreen.x <= after.cssViewSize.width && after.control.targetScreen.y >= 0 && after.control.targetScreen.y <= after.cssViewSize.height)
            trial.motion.push({ action: 'zoom', factor, drift })
          }
        }
      }
      trial.ok = true
    } catch (error) {
      trial.error = String(error)
      if (page !== undefined && !page.isClosed()) {
        trial.page = (await page.locator('body').innerText().catch(error => `page unavailable: ${String(error)}`)).slice(-8000)
        await page.screenshot({ path: join(directory, 'failure.png') }).catch(error => { trial.screenshotError = String(error) })
      }
      trial.hostLog = stderr.value.slice(-6000).replaceAll(apiKey, '[redacted]')
    } finally {
      await browser?.close()
      if (app !== undefined) await stopProcessTree(app)
      relay?.abort()
      if (relay !== undefined) { relay.server.closeAllConnections(); await new Promise(resolveClose => relay.server.close(resolveClose)) }
      writeFileSync(join(directory, 'result.json'), JSON.stringify(trial, null, 2))
      writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2))
      await temporaryRoot.dispose()
      console.log(`real vision ${trial.index} ${trial.mode}: ${trial.ok ? 'PASS' : trial.error}`)
    }
    if (relay?.requests.some(entry => entry.status === 401 || entry.status === 403 || entry.status === 429)) break
  }
  assert.ok(report.trials.length > 0 && report.trials.every(trial => trial.ok), 'Every selected real-model trial must pass; see the complete report')
  return report
}
