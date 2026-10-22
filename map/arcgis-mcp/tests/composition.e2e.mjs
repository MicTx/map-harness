import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../../apps/web/node_modules/playwright/index.mjs'
import { deriveReplayScript, parseSessionLog, resolveScriptedEntry } from '../../../packages/test-support/llm-replay/lib/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const mapBin = join(root, 'map', 'bin', 'map-harness.mjs')
const pickerPatch = join(root, 'apps', 'web', 'tests', 'pin-browse-picker.overlay.yml')
const requiredMapTools = [
  'data_export',
  'data_import',
  'layer_set_state',
  'layer_set_style',
  'map_add_layer',
  'map_apply_patch',
  'map_draw',
  'map_fit_view',
  'map_get_state',
  'map_locate',
  'map_observe',
  'map_remove_layer',
  'map_set_mode',
  'map_set_view',
  'map_undo',
]
const requiredGeoTools = [
  'geo_area',
  'geo_buffer',
  'geo_contour',
  'geo_difference',
  'geo_distance',
  'geo_intersect',
  'geo_nearest',
  'geo_perimeter',
  'geo_point_line_distance',
  'geo_union',
]
const requiredDataChainTools = [
  'catalog_register',
  'catalog_resolve',
  'map_save',
  'decision_update',
]

const messageStart = {
  type: 'message_start',
  message: { id: 'msg-map-composition', model: 'map-composition', usage: { input_tokens: 12, output_tokens: 1 } },
}
const stop = reason => [
  { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
]
const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

function toolResponse(calls) {
  return sse([
    messageStart,
    ...calls.flatMap((call, index) => [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } },
      { type: 'content_block_stop', index },
    ]),
    ...stop('tool_use'),
  ])
}

function fromTranscriptOf(parsed, pattern) {
  const text = JSON.stringify(parsed.messages)
  const matches = [...text.matchAll(new RegExp(pattern, 'g'))].map(match => match[0])
  return matches.at(-1)
}

function textResponse(text) {
  return sse([
    messageStart,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    ...stop('end_turn'),
  ])
}

// Session binding and pointer delivery must not depend on public tile-server latency.
async function useFixtureBasemap(page) {
  const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
  await page.route('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/**', route =>
    route.fulfill({ contentType: 'image/png', body: tile }))
}

async function listen(server) {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('server has no TCP address')
  return address.port
}

async function freePort() {
  const server = createServer()
  const port = await listen(server)
  await new Promise(resolveClose => server.close(resolveClose))
  return port
}

async function stopProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error
    }
  }
  await new Promise((resolveExit) => {
    const timeout = setTimeout(resolveExit, 5_000)
    child.once('exit', () => {
      clearTimeout(timeout)
      resolveExit()
    })
  })
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error?.code !== 'ESRCH') throw error
      }
    }
  }
}

async function waitForAppUrl(child, stdout, stderr) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const match = stdout.value.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
    if (match) return match[1]
    if (child.exitCode !== null) throw new Error(`map app exited ${String(child.exitCode)}: ${stderr.value}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`map app URL timeout: ${stderr.value}`)
}

async function maybeContinueNotice(page) {
  const button = page.getByRole('button', { name: /Continue|继续/ })
  try {
    await button.first().waitFor({ state: 'visible', timeout: 5_000 })
  } catch (_noticeAbsent) {
    return
  }
  await button.first().click()
  await button.first().waitFor({ state: 'hidden', timeout: 5_000 })
}

async function connectWorkspace(page, workspace) {
  // Upstream 0.2 keeps the same label on the inert composer textbox and on
  // the real workspace chip. Target the button so the overlay opens reliably.
  const trigger = page.getByRole('button', { name: /Choose workspace|选择工作区/ })
  const dialog = page.getByRole('dialog', { name: /Select Workspace Directory|选择工作区目录/ })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await trigger.click()
    const addWorkspace = page.getByText(/Add workspace|添加工作区/).last()
    if (await addWorkspace.count() > 0) await addWorkspace.click()
    try {
      await dialog.waitFor({ timeout: 4_000 })
      break
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const currentDialog = page.getByRole('dialog').last()
      await currentDialog.getByRole('button', { name: /Edit path|编辑路径/ }).click()
      const pathInput = page.getByRole('dialog').last().getByRole('textbox', { name: /Edit path|编辑路径/ })
      await pathInput.waitFor({ timeout: 5_000 })
      await pathInput.fill(workspace)
      await pathInput.press('Enter')
      await page.getByRole('dialog').last().getByRole('button', { name: /Open|打开/, exact: true }).click()
      break
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
  // Opening the directory commits the workspace and attaches a blank Session
  // asynchronously. Wait for the selected chip to reflect the requested path
  // before any model turn, otherwise relative map paths use the old default
  // workspace.
  const workspaceName = workspace.split(/[\\/]/).filter(Boolean).at(-1)
  await page.waitForFunction(name => {
    const chipSelected = [...document.querySelectorAll('button[aria-label="选择工作区"], button[aria-label="Choose workspace"]')]
      .some(button => button.textContent?.trim() === name)
    const workspaceRow = [...document.querySelectorAll('[role="treeitem"]')]
      .some(row => row.textContent?.trim().startsWith(name))
    return chipSelected || workspaceRow
  }, workspaceName, { timeout: 30_000 })
}

/** Select the map analyst when the upstream preset chip is visible. */
async function chooseMapPreset(page) {
  const standard = page.getByRole('button', { name: /Standard|标准模式/ })
  if (await standard.count() > 0) await standard.click()
  const mapPreset = page.getByText('地图分析师', { exact: true }).last()
  if (await mapPreset.count() > 0) await mapPreset.click()
}

async function sendMessage(page, text) {
  const composer = page.locator('[data-composer-input][contenteditable="true"]')
  await composer.waitFor({ timeout: 15_000 })
  await composer.fill(text)
  await page.getByRole('button', { name: /Send message|发送消息/ }).click()
}

/** Wait for the deterministic local provider to finish a bounded turn. */
async function waitForCounter(read, target, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (read() < target && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(read() >= target, `provider did not reach request ${target}`)
}

/**
 * Count the pixels of one page region within tolerance of an rgb triple.
 * The screenshot is decoded by the browser itself (`createImageBitmap` over
 * the captured PNG), so the lane adds no image dependency and measures the
 * composited canvas, WebGL included.
 * @param page - the driven page.
 * @param selector - the element whose box the clip follows.
 * @param rgb - the target channel triple.
 * @param options - `topFraction` (band height) or `bottomEdge` (clip end), and `tolerance`.
 * @returns the match count, the sampled total, and the decoded size.
 */
async function countRegionColor(page, selector, rgb, options = {}) {
  const { topFraction = 1, bottomEdge = null, tolerance = 10 } = options
  const box = await page.locator(selector).first().boundingBox()
  if (box === null || box.width < 2 || box.height < 2) throw new Error(`no measurable region for ${selector}`)
  const bottom = bottomEdge === null ? box.y + box.height * topFraction : Math.min(bottomEdge, box.y + box.height)
  const height = Math.max(1, Math.floor(bottom - box.y))
  const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: Math.floor(box.width), height } })
  return await page.evaluate(async ({ dataUrl, target, slack }) => {
    const blob = await (await fetch(dataUrl)).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
    let count = 0
    for (let at = 0; at < data.length; at += 4) {
      if (Math.abs(data[at] - target[0]) <= slack
        && Math.abs(data[at + 1] - target[1]) <= slack
        && Math.abs(data[at + 2] - target[2]) <= slack) count += 1
    }
    return { count, total: Math.floor(data.length / 4), width: bitmap.width, height: bitmap.height }
  }, { dataUrl: `data:image/png;base64,${shot.toString('base64')}`, target: rgb, slack: tolerance })
}

/**
 * The map band above the workbench panel: the clip that never samples the
 * panel's own swatches. Falls back to the whole container when no panel shows.
 * @param page - the driven page.
 * @returns the container selector's box and the clip bottom edge (or null).
 */
async function mapBandOf(page) {
  const panel = page.locator('[data-map-workbench]')
  const panelBox = await panel.count() > 0 && await panel.first().isVisible()
    ? await panel.first().boundingBox()
    : null
  return panelBox === null ? null : panelBox.y - 4
}

/**
 * Poll the rendered map band until the expected presence of one color holds.
 * @param page - the driven page.
 * @param rgb - the target channel triple.
 * @param expected - `present` or `absent`.
 * @param options - timeout and the presence/absence pixel thresholds.
 * @returns the last measurement.
 */
async function waitForMapColor(page, rgb, expected, options = {}) {
  const { timeout = 30_000, present = 2_000, absent = 100, tolerance = 10 } = options
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    const bottomEdge = await mapBandOf(page)
    last = await countRegionColor(page, '[data-map-container]:not([data-map-view])', rgb, { bottomEdge, tolerance })
    const holds = expected === 'present' ? last.count >= present : last.count <= absent
    if (holds) return last
    if (Date.now() > deadline) {
      if (process.env.LW_DEBUG) {
        const box = await page.locator('[data-map-container]:not([data-map-view])').first().boundingBox()
        writeFileSync('/tmp/pixels-fail.png', await page.screenshot({ clip: box ?? undefined }))
      }
      assert.fail(`map band ${expected} check for rgb(${rgb.join(', ')}) failed after ${String(timeout)} ms: ${last.count}/${last.total} matching pixels`)
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}

/** Read the selected conversation's map receipt, excluding retained background Sessions. */
async function readMapTabReceipt(page) {
  return await page.evaluate(() => {
    const harness = window.__mapHarness
    if (!(harness instanceof Map)) return null
    const sessionId = document.querySelector('[data-map-session-action]')?.getAttribute('data-map-session-action')
    return [...harness.values()].find(value => value.renderReceipt.sessionId === sessionId)?.renderReceipt ?? null
  })
}

/**
 * Wait until the map tab occurrence's receipt attests a completed render of
 * its current revision on one concrete view.
 * @param page - the driven page.
 * @returns the observed receipt.
 */
async function waitForRenderedReceipt(page) {
  await page.waitForFunction(() => {
    const harness = window.__mapHarness
    if (!(harness instanceof Map)) return false
    const sessionId = document.querySelector('[data-map-session-action]')?.getAttribute('data-map-session-action')
    const receipt = [...harness.values()].find(value => value.renderReceipt.sessionId === sessionId)?.renderReceipt
    return receipt?.status === 'rendered' && receipt.failedLayers.length === 0
      && receipt.renderedRevision === receipt.revision && typeof receipt.viewId === 'string'
  }, undefined, { timeout: 30_000 })
  return await readMapTabReceipt(page)
}

/** Wait for the SDK camera itself, independently of the requested projection coordinates. */
async function waitForMapCamera(page, sessionId, center, zoom) {
  await page.waitForFunction(({ sessionId, center, zoom }) => {
    const camera = [...(window.__mapHarness ?? new Map()).values()]
      .find(value => value.renderReceipt.sessionId === sessionId)?.camera
    return camera != null && Math.abs(camera.center[0] - center[0]) < 0.00001
      && Math.abs(camera.center[1] - center[1]) < 0.00001 && Math.abs(camera.zoom - zoom) < 0.01
  }, { sessionId, center, zoom }, { timeout: 30_000 })
}

/**
 * The darkest swatch among the legend's class rows (the light-to-dark ramp's
 * top class); the class rows precede the underflow/overflow/missing specials.
 * @param page - the driven page.
 * @param classCount - the classification's class count.
 * @returns the rgb triple the map must paint that class with.
 */
async function darkestLegendColor(page, classCount) {
  const swatches = await page.locator('[data-workbench-legend] li span[role="img"]')
    .evaluateAll(spans => spans.map(span => getComputedStyle(span).backgroundColor))
  assert.ok(swatches.length >= classCount, `expected ${classCount} legend classes, saw ${swatches.length}`)
  let darkest = null
  for (const value of swatches.slice(0, classCount)) {
    const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(value)
    if (match === null) continue
    const rgb = [Number(match[1]), Number(match[2]), Number(match[3])]
    const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114
    if (darkest === null || luminance < darkest.luminance) darkest = { rgb, luminance }
  }
  assert.ok(darkest !== null, 'no parseable legend swatch color')
  return darkest.rgb
}

for (const [legacyPreset, offlineHint, onlineSource] of [[false, false, false], [true, false, false], [false, true, false], [false, false, true]]) test(onlineSource
  ? 'spatial workflow: online search registers and renders through the real map profile'
  : offlineHint
  ? 'offline hint does not block loopback map binding or consecutive moves'
  : legacyPreset
    ? 'legacy preset map binding follows committed tools without reloading'
    : 'built map profile composes MCP tools and rejects workspace escape', { timeout: 120_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-mcp-composition-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  const outside = join(temp, 'outside.geojson')
  if (legacyPreset) {
    const preset = join(home, '.agent-presets', 'map-analyst')
    cpSync(join(root, 'map', 'presets', 'map-analyst'), preset, { recursive: true })
    const composition = join(preset, 'agent.cordis.yml')
    const legacyComposition = readFileSync(composition, 'utf8').replace(/\n- id: spatial-context-agent\n[\s\S]*$/, '\n')
    assert.doesNotMatch(legacyComposition, /name: ['"]@map-harness\/spatial-context\/agent['"]/, 'the installed legacy preset really lacks spatial context')
    writeFileSync(composition, legacyComposition + '\n- id: legacy-map-tools\n  name: "@map-harness/map-tools/mcp"\n')
    const profile = join(home, 'profiles', 'map-web')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'map-binding-profile', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@map-harness/map-web'] } } }))
    cpSync(join(root, 'map', 'profiles', 'map-web', 'cordis.patch.yml'), join(profile, 'cordis.patch.yml'))
  }
  const pointCollection = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'composition' } }],
  }
  writeFileSync(outside, JSON.stringify(pointCollection))
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'sample-points.geojson'), JSON.stringify(pointCollection))

  const providerRequests = []
  let mainRequests = 0
  let onlineRegistered = false
  let onlineReads = 0
  let onlineRef
  const provider = createServer((request, response) => {
    if (request.url.startsWith('/v2/search?')) {
      onlineReads++
      const params = new URL(request.url, 'http://fixture').searchParams
      assert.equal(params.get('tk'), 'composition-search-key')
      assert.equal(params.get('type'), 'query')
      assert.equal(JSON.parse(params.get('postStr')).level, 12)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ count: 1, pois: [{ name: 'composition', lonlat: '116.4,39.9' }] }))
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      const titleRequest = isTitleRequest(parsed)
      const registeringOnline = onlineSource && !onlineRegistered && !titleRequest
      if (!registeringOnline) providerRequests.push({ titleRequest, tools: parsed.tools ?? [], messages: parsed.messages ?? [] })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (titleRequest) {
        response.end(textResponse('map composition'))
        return
      }
      if (registeringOnline) {
        onlineRegistered = true
        response.end(toolResponse([{ id: 'online-register', name: 'catalog_register', input: { name: 'composition', online: { kind: 'search', query: '医院', bbox: [116, 39, 117, 40] } } }]))
        return
      }
      mainRequests += 1
      if (mainRequests === 1) {
        if (onlineSource) onlineRef = fromTranscriptOf(parsed, 'res-[a-f0-9-]+@v[0-9]+')
        response.end(toolResponse([
          { id: 'composition-add', name: 'map_add_layer', input: onlineSource
            ? { ref: onlineRef, name: 'composition', layer_id: 'composition' }
            : { path: 'sample-points.geojson', layer_id: 'composition' } },
          { id: 'composition-view', name: 'map_set_view', input: { center: [116.4, 39.9], zoom: 9, wkid: 4326 } },
        ]))
      } else if (mainRequests === 2) {
        response.end(toolResponse([
          { id: 'composition-buffer', name: 'geo_buffer', input: { path: 'sample-points.geojson', distance_m: 500 } },
        ]))
      } else if (mainRequests === 3) {
        response.end(textResponse('composition success'))
      } else if (mainRequests === 4) {
        response.end(toolResponse([
          { id: 'composition-escape', name: 'map_add_layer', input: { path: '../outside.geojson', layer_id: 'escape' } },
        ]))
      } else if (mainRequests === 5) {
        response.end(textResponse('workspace escape rejected'))
      } else if (mainRequests === 6) {
        response.end(toolResponse([{ id: 'binding-followup', name: 'map_set_view', input: { center: [121.5, 31.2], zoom: 8 } }]))
      } else if (mainRequests === 8) {
        response.end(toolResponse([
          { id: 'binding-second-layer', name: 'map_add_layer', input: { path: 'sample-points.geojson', layer_id: 'session-b' } },
          { id: 'binding-second-view', name: 'map_set_view', input: { center: [2.35, 48.85], zoom: 6 } },
        ]))
      } else if (mainRequests === 10) {
        response.end(toolResponse([{ id: 'binding-state', name: 'map_get_state', input: {} }]))
      } else if (mainRequests === 12) {
        response.end(toolResponse([{ id: 'binding-reconnect', name: 'map_set_view', input: { center: [87.6168, 43.8256], zoom: 11 } }]))
      } else {
        response.end(textResponse('binding turn complete'))
      }
    })
  })

  let app
  let browser
  try {
    const providerPort = await listen(provider)
    const extraPatches = []
    if (onlineSource) {
      const searchPatch = join(temp, 'search.patch.yml')
      writeFileSync(searchPatch, `- id: spatial-connect\n  config:\n    tianditu:\n      apiKeyEnv: COMPOSITION_SEARCH_KEY\n      baseUrl: http://127.0.0.1:${providerPort}\n`)
      extraPatches.push('--patch', searchPatch)
    }
    let appPort = 0
    const stdout = { value: '' }
    const stderr = { value: '' }
    app = spawn(process.execPath, [
      mapBin,
      '--patch', pickerPatch,
      ...extraPatches,
      '--host', '127.0.0.1',
      '--port', String(appPort),
      '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        ...(onlineSource ? { COMPOSITION_SEARCH_KEY: 'composition-search-key' } : {}),
        DEEPSEEK_API_KEY: 'composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)
    appPort = Number(new URL(url).port)

    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({ locale: 'zh-CN' })
    if (offlineHint) await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false })
    })
    const page = await context.newPage()
    await useFixtureBasemap(page)
    const pageErrors = []
    const consoleErrors = []
    let restarting = false
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => {
      if (message.type() !== 'error') return
      const text = message.text()
      if (restarting && (/WebSocket connection .*failed:/.test(text) || /net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING)/.test(text))) return
      consoleErrors.push(text)
    })
    await page.goto(url)
    if (offlineHint) assert.equal(await page.evaluate(() => navigator.onLine), false)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    // Upstream 0.2 keeps the Sidebar chrome hidden for a blank conversation;
    // the first real message materializes the tab strip and map occurrence.
    await sendMessage(page, onlineSource ? '请检索北京范围内的医院，登记结果并显示在地图上。' : '请加载 sample-points.geojson 图层并把地图移动到北京。')

    // The map profile's right Sidebar keeps the map tab as its default-open
    // focus while still offering workspace files and document preview: the
    // strip stays visible for tab switching, and the preview tab types stay
    // registered while terminal and browser never register.
    await page.locator('[data-sidebar-right-panel]').waitFor({ state: 'attached', timeout: 15_000 })
    if (await page.locator('[data-sidebar-right-open]').count() === 0) {
      const expand = page.locator('[data-sidebar-right-expand]')
      if (await expand.count() > 0) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await page.locator('[data-sidebar-right-expand]').click({ force: true, timeout: 3_000 })
            break
          } catch (error) {
            if (attempt === 2) throw error
          }
        }
      }
    }
    await page.waitForFunction(() => document.querySelector('[data-sidebar-right-open]') !== null, undefined, { timeout: 15_000 })
    const rightbar = await page.waitForFunction(() => {
      const sidebar = document.querySelector('[data-sidebar-right-open]')
      if (sidebar === null) return null
      const strips = [...sidebar.querySelectorAll('[data-dockkit-strip]')]
      return {
        stripVisible: strips.length > 0 && strips.every(strip => strip.offsetParent !== null),
        stripCount: strips.length,
        styleInjected: document.querySelector('style[data-map-harness-sidebar]') !== null,
        mapHandles: [...(window.__mapHarness ?? new Map()).keys()].filter(key => key.includes('map-container')).length,
      }
    }, undefined, { timeout: 15_000 }).then(handle => handle.jsonValue())
    assert.equal(rightbar.stripCount > 0, true, `expected a tab strip in the expanded sidebar (count ${rightbar.stripCount})`)
    assert.equal(rightbar.stripVisible, true, 'the right Sidebar tab strip must stay visible with multiple tab types')
    assert.equal(rightbar.styleInjected, false, 'the map-only strip-hiding style must be gone')
    if (onlineSource) {
      await waitForCounter(() => mainRequests, 3)
      const receipt = JSON.stringify(providerRequests.filter(request => !request.titleRequest)[0]?.messages.at(-1))
      const failures = stderr.value.split('\n').filter(line => /Error|error|failed|warn/.test(line) && !/key|token|secret|password|authorization/i.test(line)).slice(-10)
      const visibleTools = providerRequests.find(request => !request.titleRequest)?.tools.map(tool => tool.name)
      assert.equal(onlineReads, 1, `online request was not dispatched: ${receipt}; tools=${JSON.stringify(visibleTools)}; loader=${JSON.stringify(failures)}`)
      assert.ok(onlineRef, `online registration did not publish a resource: ${receipt}`)
    }
    await page.waitForFunction(() => (window.__mapHarness?.size ?? 0) === 1, undefined, { timeout: 30_000 })

    await waitForCounter(() => mainRequests, 3)
    const toolCalls = page.getByRole('button', { name: /3 .*tool calls|3 次工具调用/ })
    if (await toolCalls.count() > 0) await toolCalls.click()
    // The dockkit tab's accessible name includes its close affordance.
    const mapTab = page.getByRole('tab', { name: '地图 关闭', exact: true })
    if (await mapTab.count() > 0) await mapTab.click()
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map
        && [...harness.values()].filter(value => value.layerCount === 1
          && value.center?.[0] === 116.4 && value.center?.[1] === 39.9
          && value.zoom === 9 && value.engine === 'arcgis-core').length >= 1
    }, undefined, { timeout: 60_000 })

    await sendMessage(page, '请加载工作区外的 ../outside.geojson。')
    await waitForCounter(() => mainRequests, 5)
    const chatTab = page.getByRole('tab', { name: /Chat|对话/, exact: true })
    if (await chatTab.count() > 0) await chatTab.click()
    const mapTabAfterEscape = page.getByRole('tab', { name: '地图 关闭', exact: true })
    if (await mapTabAfterEscape.count() > 0) await mapTabAfterEscape.click()
    await page.waitForFunction(() => window.__mapHarness instanceof Map && window.__mapHarness.size >= 1)
    const handles = await page.evaluate(() => [...window.__mapHarness.values()].map(value => ({
      layerCount: value.layerCount,
      center: value.center,
      zoom: value.zoom,
      engine: value.engine,
    })))
    assert.equal(handles.length, 1, 'one conversation has one map engine')
    assert.ok(handles.every(value => value.layerCount === 1))

    const firstReceipt = await waitForRenderedReceipt(page)
    const firstSession = firstReceipt.sessionId
    await waitForMapCamera(page, firstSession, [116.4, 39.9], 9)
    if (offlineHint) await page.evaluate(() => { window.dispatchEvent(new Event('offline')) })
    const openMap = page.getByRole('button', { name: '打开本会话地图', exact: true })
    assert.equal(await page.getByRole('tab', { name: '地图', exact: true }).count(), 0, 'conversation has no independent map view')
    await page.getByRole('button', { name: '收起右侧边栏', exact: true }).click()
    await page.locator('[data-map-container]:visible').waitFor({ state: 'hidden' })
    await openMap.click()
    await page.locator('[data-map-container]:visible').waitFor()
    await openMap.click()
    assert.equal((await readMapTabReceipt(page)).viewId, firstReceipt.viewId, 'collapse and repeated navigation retain the same engine')

    await sendMessage(page, '将本会话地图移到上海，保留已有图层。')
    await waitForCounter(() => mainRequests, 7)
    await page.waitForFunction(id => [...window.__mapHarness.values()].some(value =>
      value.renderReceipt.sessionId === id && value.center[0] === 121.5), firstSession)
    await waitForMapCamera(page, firstSession, [121.5, 31.2], 8)
    assert.equal((await readMapTabReceipt(page)).viewId, firstReceipt.viewId, 'follow-up tools update the existing engine')

    await page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'workspace' }).first().hover()
    await page.getByRole('button', { name: '在“workspace”中新建会话', exact: true }).click()
    await page.getByText('探索未至之境', { exact: true }).waitFor()
    await chooseMapPreset(page)
    await sendMessage(page, '加载 sample-points.geojson 到新会话并定位巴黎。')
    await waitForCounter(() => mainRequests, 9)
    await page.waitForFunction(first => [...window.__mapHarness.values()].some(value =>
      value.renderReceipt.sessionId !== first && value.center[0] === 2.35 && value.layerCount === 1), firstSession)
    const secondSession = await page.locator('[data-map-container]:visible').getAttribute('data-map-session')
    assert.notEqual(secondSession, firstSession)
    const twoMaps = await page.evaluate(() => [...window.__mapHarness.values()].map(value => ({
      sessionId: value.renderReceipt.sessionId, center: value.center, layerCount: value.layerCount, viewId: value.renderReceipt.viewId,
    })))
    assert.equal(twoMaps.length, 2, 'one retained map for each of the two sessions')
    assert.deepEqual(twoMaps.find(value => value.sessionId === firstSession).center, [121.5, 31.2])
    assert.deepEqual(twoMaps.find(value => value.sessionId === secondSession).center, [2.35, 48.85])

    await page.locator(`[data-row-key="session:${firstSession}"]`).click()
    await page.locator(`[data-map-container][data-map-session="${firstSession}"]:visible`).waitFor()
    assert.equal((await readMapTabReceipt(page)).viewId, firstReceipt.viewId, 'switching back preserves the original engine')
    await sendMessage(page, '读取本会话地图状态。')
    await waitForCounter(() => mainRequests, 11)
    const stateTranscript = JSON.stringify(providerRequests.filter(request => !request.titleRequest)[10].messages)
    assert.ok(stateTranscript.includes('composition'))
    assert.equal(stateTranscript.includes('session-b'), false, 'the first conversation cannot read the second map')

    // Exercise an old saved layout with multiple map records through real restore,
    // rather than deleting browser storage or manipulating the live renderer.
    await page.evaluate(id => {
      const key = `dsh.sidebar-right.v1.${id}`
      const saved = JSON.parse(localStorage.getItem(key))
      const surface = saved.bySession[id]
      const original = Object.values(surface.layout.tabs).find(tab => tab.kind === 'map')
      const duplicate = { ...original, id: 'duplicate-map' }
      surface.layout.tabs[duplicate.id] = duplicate
      const pane = Object.values(surface.layout.nodes).find(node => node.kind === 'pane' && node.tabs.includes(original.id))
      pane.tabs.push(duplicate.id)
      pane.activeTabId = duplicate.id
      localStorage.setItem(key, JSON.stringify(saved))
    }, firstSession)
    await page.reload()
    await page.locator(`[data-map-container][data-map-session="${firstSession}"]:visible`).waitFor({ timeout: 30_000 })
    await page.waitForFunction(id => {
      const maps = [...(window.__mapHarness ?? new Map()).values()]
      return maps.length === 1 && maps[0].renderReceipt.sessionId === id
        && maps[0].center[0] === 121.5 && maps[0].layerCount === 1
    }, firstSession)
    await page.waitForFunction(id => {
      const layout = JSON.parse(localStorage.getItem(`dsh.sidebar-right.v1.${id}`)).bySession[id].layout
      return Object.values(layout.tabs).filter(tab => tab.kind === 'map').length === 1
    }, firstSession)
    assert.equal(await page.locator('[data-map-container]').count(), 1)
    assert.notEqual((await waitForRenderedReceipt(page)).viewId, firstReceipt.viewId, 'refresh recreates only the selected session map from its log')

    if (legacyPreset || offlineHint) {
      restarting = true
      await stopProcessTree(app)
      stdout.value = ''; stderr.value = ''
      app = spawn(process.execPath, [mapBin, '--patch', pickerPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open'], {
        cwd: workspace,
        env: { ...process.env, MAPHARNESS_HOME: home, DSH_HOME: home, DEEPSEEK_API_KEY: 'composition-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`, DSH_TELEMETRY_MODE: 'DISABLED' },
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      })
      app.stdout.setEncoding('utf8'); app.stderr.setEncoding('utf8')
      app.stdout.on('data', chunk => { stdout.value += chunk })
      app.stderr.on('data', chunk => { stderr.value += chunk })
      await waitForAppUrl(app, stdout, stderr)
      await sendMessage(page, '重连后将本会话地图移动到乌鲁木齐。')
      await waitForCounter(() => mainRequests, 13)
      await page.waitForFunction(id => [...window.__mapHarness.values()].some(value => value.renderReceipt.sessionId === id
        && value.center[0] === 87.6168 && value.zoom === 11), firstSession)
      await waitForMapCamera(page, firstSession, [87.6168, 43.8256], 11)
      if (offlineHint) assert.equal(await page.evaluate(() => navigator.onLine), false)
      restarting = false
    }

    if (onlineSource) assert.equal(onlineReads, 1, 'online search must fetch once and later restore from the registered bytes')
    const main = providerRequests.filter(request => !request.titleRequest)
    const contextMessages = main[0].messages.filter(message => JSON.stringify(message.content).includes('spatial-context/snapshot v1 kind=baseline'))
    assert.equal(contextMessages.length, 1, 'new and legacy presets must each admit exactly one spatial baseline')
    assert.match(JSON.stringify(contextMessages[0]), /以本轮模型请求提供的工具 schema 为准/)
    if (legacyPreset) {
      const installed = readFileSync(join(home, '.agent-presets', 'map-analyst', 'agent.cordis.yml'), 'utf8')
      assert.doesNotMatch(installed, /name: ['"]@map-harness\/spatial-context\/agent['"]/, 'runtime fallback must not rewrite the user preset')
      assert.match(installed, /id: legacy-map-tools/, 'user-owned registrations remain intact')
    }
    const allNames = main[0].tools.map(tool => tool.name)
    const toolNames = allNames.filter(name => requiredMapTools.includes(name)).sort()
    assert.deepEqual(toolNames, requiredMapTools, 'the map, layer, and data tools the profile promises are all mounted')
    assert.equal(new Set(toolNames).size, requiredMapTools.length)
    // Native-only presentation: the map profile pins the tools row to native,
    // so the PTC transport (`run_code`) must never reach the model tool list.
    assert.equal(allNames.includes('run_code'), false, 'run_code must not appear in the native model toolset')
    for (const geo of requiredGeoTools) {
      assert.ok(allNames.includes(geo), `${geo} must stay in the model toolset`)
    }
    for (const chain of requiredDataChainTools) {
      assert.ok(allNames.includes(chain), `${chain} must stay in the model toolset`)
    }
    // The geo analysis call really dispatched through the internal MCP
    // provider: the next request's transcript carries its model content with
    // status and limitations, and no durable analysis meta leaks into it.
    const geoTranscript = JSON.stringify(main[2].messages)
    assert.ok(geoTranscript.includes('composition-buffer'), 'the geo_buffer call result must reach the model')
    assert.ok(geoTranscript.includes('succeeded'), 'geo metrics status must be model-visible')
    assert.ok(geoTranscript.includes('limitations'), 'geo key limitations must be model-visible')
    assert.equal(geoTranscript.includes('analysis-result'), false, 'durable geo meta must stay out of model content')
    assert.ok(main[4].messages.some(message => JSON.stringify(message).includes('session workspace')))
    assert.equal(pageErrors.length, 0)
    assert.deepEqual(consoleErrors, [])

    if (!legacyPreset) {
      const installedPreset = readFileSync(join(home, '.agent-presets', 'map-analyst', 'agent.cordis.yml'), 'utf8')
      assert.match(installedPreset, /@map-harness\/spatial-context\/agent/)
    }
  } finally {
    if (browser) await browser.close()
    if (app) await stopProcessTree(app)
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

/**
 * Whether one provider request is the session-title side request rather than
 * a model turn. Matches the title prompt text, so the routing holds whether
 * or not the title plugin sets a token cap.
 */
function isTitleRequest(parsed) {
  if (parsed.max_tokens === 64) return true
  const first = parsed.messages?.find(message => message.role === 'user')
  const text = typeof first?.content === 'string' ? first.content : (first?.content ?? []).map(part => part.text ?? '').join('')
  return text.startsWith('Generate the session title')
}

/** The deterministic logical resource id for one registered name (refs.ts rule). */
function resourceIdFor(name) {
  return `res-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`
}

test('P0b chain: register, resolve, buffer the second point, load the artifact, save; a restarted app reads the same resource', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-chain-composition-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const twoPoints = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 'alpha', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'first' } },
      { type: 'Feature', id: 'beta', geometry: { type: 'Point', coordinates: [10, 0] }, properties: { name: 'second' } },
    ],
  }
  writeFileSync(join(workspace, 'poi.geojson'), JSON.stringify(twoPoints))
  // Overwrite the SOURCE after registering: the versioned reads below must
  // keep returning the registered bytes.
  const sourceOverwriteAfterRegister = () => {
    writeFileSync(join(workspace, 'poi.geojson'), JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', id: 'alpha', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'moved' } }],
    }))
  }

  // The deterministic identity of the named resource: valid across restarts.
  const resourceRef = `${resourceIdFor('poi')}@v1`

  let mainRequests = 0
  /** Extract the newest match of one pattern from the request transcript. */
  const fromTranscript = (parsed, pattern) => {
    const text = JSON.stringify(parsed.messages)
    const matches = [...text.matchAll(new RegExp(pattern, 'g'))].map(match => match[0])
    return matches.at(-1)
  }

  /** Boot the app over `home` with a provider scripted by `respond(requestIndex, parsed, response)`. */
  async function bootChainApp(respond) {
    let requestIndex = 0
    const provider = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        const parsed = JSON.parse(body)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        if (isTitleRequest(parsed)) {
          response.end(textResponse('map chain'))
          return
        }
        respond(requestIndex, parsed, response)
        requestIndex += 1
      })
    })
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const stdout = { value: '' }
    const stderr = { value: '' }
    const child = spawn(process.execPath, [
      mapBin,
      '--patch', pickerPatch,
      '--host', '127.0.0.1',
      '--port', String(appPort),
      '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'chain-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout.value += chunk })
    child.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(child, stdout, stderr)
    return { provider, child, url, count: () => requestIndex }
  }

  let app
  let provider
  let browser
  let url
  try {
    // ── run 1: the deterministic chain ──────────────────────────────────
    ;({ provider, child: app, url } = await bootChainApp((index, parsed, response) => {
      mainRequests = index + 1
      if (index === 0) {
        response.end(toolResponse([
          { id: 'chain-register', name: 'catalog_register', input: { path: 'poi.geojson', name: 'poi' } },
        ]))
      } else if (index === 1) {
        const resolvedRef = fromTranscript(parsed, 'res-[a-f0-9]{24}@v1')
        assert.equal(resolvedRef, resourceRef, `catalog_register must publish the deterministic named identity: ${JSON.stringify(parsed.messages).slice(-4000)}`)
        response.end(toolResponse([
          { id: 'chain-resolve', name: 'catalog_resolve', input: { resource: resolvedRef } },
        ]))
      } else if (index === 2) {
        const refs = [...JSON.stringify(parsed.messages).matchAll(/f-[a-f0-9]{16}/g)].map(match => match[0])
        assert.ok(refs.length >= 2, `resolve must present both feature refs (saw ${refs})`)
        const betaRef = refs[1]
        response.end(toolResponse([
          { id: 'chain-buffer', name: 'geo_buffer', input: { ref: { resource: resourceRef, feature: betaRef }, distance_m: 1000 } },
        ]))
      } else if (index === 3) {
        const artifactRef = fromTranscript(parsed, 'art-[a-f0-9-]+@v1')
        assert.ok(artifactRef, 'the buffer result must publish an artifactRef into the transcript')
        response.end(toolResponse([
          { id: 'chain-add', name: 'map_add_layer', input: { ref: artifactRef, layer_id: 'poi-buffer' } },
          { id: 'chain-view', name: 'map_set_view', input: { center: [10, 0], zoom: 9, wkid: 4326 } },
        ]))
      } else if (index === 4) {
        response.end(toolResponse([
          { id: 'chain-save', name: 'map_save', input: {} },
        ]))
      } else {
        const transcript = JSON.stringify(parsed.messages)
        assert.ok(transcript.includes('\\"saved\\":true'), `the save receipt must reach the model (transcript: ${transcript.slice(-600)})`)
        assert.ok(transcript.includes('durable_through_seq'), 'the receipt must carry the fixed prefix seq')
        response.end(textResponse('chain saved'))
      }
    }))

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await sendMessage(page, '请登记 poi.geojson，对第二个点做 1km 缓冲并加载，然后保存。')
    await page.getByText('chain saved', { exact: true }).waitFor({ timeout: 45_000 })
    // The accepted add-layer folded: the map occurrence reports one layer.
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map
        && [...harness.values()].filter(value => value.layerCount === 1).length >= 1
    }, undefined, { timeout: 30_000 })
    // The source file changed after registration; close cleanly before restart.
    await browser.close()
    browser = undefined
    sourceOverwriteAfterRegister()
    await stopProcessTree(app)
    app = undefined
    await new Promise(resolveClose => provider.close(resolveClose))
    provider = undefined
    mainRequests = 0

    // ── run 2: the RESTARTED app reads the same persisted catalog ───────
    ;({ provider, child: app, url } = await bootChainApp((index, parsed, response) => {
      if (index === 0) {
        response.end(toolResponse([
          { id: 'restart-resolve', name: 'catalog_resolve', input: { resource: resourceRef } },
        ]))
      } else if (index === 1) {
        const refs = [...JSON.stringify(parsed.messages).matchAll(/f-[a-f0-9]{16}/g)].map(match => match[0])
        const betaRef = refs[1]
        response.end(toolResponse([
          { id: 'restart-area', name: 'geo_area', input: { ref: { resource: resourceRef, feature: betaRef } } },
        ]))
      } else {
        const transcript = JSON.stringify(parsed.messages)
        assert.ok(transcript.includes(resourceRef), 'the restarted app must resolve the registered resource')
        assert.ok(transcript.includes('area_m2'), `the versioned read must return the registered bytes: ${transcript.slice(-5000)}`)
        response.end(textResponse('restart read ok'))
      }
    }))
    browser = await chromium.launch({ headless: true })
    const context2 = await browser.newContext({ locale: 'zh-CN' })
    const page2 = await context2.newPage()
    await page2.goto(url)
    await maybeContinueNotice(page2)
    const catalogSessions = readdirSync(join(home, 'spatial-store', 'sessions'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    assert.equal(catalogSessions.length, 1, `expected one persisted catalog Session, got ${catalogSessions}`)
    const persistedSessionId = catalogSessions[0]
    const persistedRow = page2.locator('[role="treeitem"]').filter({ hasText: 'map chain' }).first()
    await persistedRow.waitFor({ timeout: 15_000 })
    await persistedRow.click()
    await page2.waitForFunction(id => {
      const current = JSON.parse(localStorage.getItem('dsh.sessions.current') ?? 'null')
      return current?.sessionId === id
    }, persistedSessionId, { timeout: 15_000 })
    // Selecting the persisted row restores the original Session and its
    // workspace binding; wait for that session's live composer before sending.
    await page2.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 15_000 })
    await chooseMapPreset(page2)
    await sendMessage(page2, '重启后请读取已登记的 poi 资源并测第二个点的面积。')
    await page2.getByText('restart read ok', { exact: true }).waitFor({ timeout: 45_000 })
    await browser.close()
    browser = undefined
  } finally {
    if (browser) await browser.close()
    if (app) await stopProcessTree(app)
    if (provider) await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

test('P3-visualization workbench: viz_classify styles the map and the Web panel passes ARIA checks', { timeout: 180_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-viz-composition-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const scored = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 's1', geometry: { type: 'Point', coordinates: [116.0, 39.9] }, properties: { score: 2, time: '2026-01-01T06:00:00Z' } },
      { type: 'Feature', id: 's2', geometry: { type: 'Point', coordinates: [116.01, 39.9] }, properties: { score: 8, time: '2026-01-02T06:00:00Z' } },
      { type: 'Feature', id: 's3', geometry: { type: 'Point', coordinates: [116.02, 39.9] }, properties: { score: 26, time: '2026-01-03T06:00:00Z' } },
    ],
  }
  writeFileSync(join(workspace, 'scored.geojson'), JSON.stringify(scored))

  let mainRequests = 0
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isTitleRequest(parsed)) {
        response.end(textResponse('map viz'))
        return
      }
      mainRequests += 1
      if (mainRequests === 1) {
        response.end(toolResponse([
          { id: 'viz-register', name: 'catalog_register', input: { path: 'scored.geojson', name: 'scored' } },
        ]))
      } else if (mainRequests === 2) {
        const resourceRef = fromTranscriptOf(parsed, 'res-[a-f0-9]{24}@v1')
        response.end(toolResponse([
          { id: 'viz-add', name: 'map_add_layer', input: { ref: resourceRef, layer_id: 'zones' } },
        ]))
      } else if (mainRequests === 3) {
        response.end(toolResponse([
          { id: 'viz-style', name: 'viz_classify', input: {
            layer_id: 'zones', field: 'score', unit: '分', classification: 'equal-interval', class_count: 3,
            time_field: 'time', timezone: 'UTC', granularity: 'day',
            time_from: '2026-01-01T00:00:00Z', time_to: '2026-01-04T00:00:00Z',
          } },
        ]))
      } else {
        response.end(textResponse('viz applied'))
      }
    })
  })

  let app
  let browser
  try {
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const stdout = { value: '' }
    const stderr = { value: '' }
    app = spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'viz-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await sendMessage(page, '请登记 scored.geojson，加载为 zones 图层并按 score 分三级，时间轴按天。')
    await page.getByText('viz applied', { exact: true }).waitFor({ timeout: 45_000 })

    // The classification folded end to end: the occurrence reports a styled layer.
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map
        && [...harness.values()].some(value => (value.styledLayers ?? []).length === 1 && value.styledLayers[0] === 'zones')
    }, undefined, { timeout: 30_000 })

    // ── the real Web workbench: legend, timeline, chart, table, export ──
    const workbench = page.locator('[data-map-workbench]')
    await workbench.waitFor({ timeout: 30_000 })

    // Legend: class rows with text ranges beside the color swatches.
    const legendRows = workbench.locator('[data-workbench-legend] li')
    assert.equal(await legendRows.count() >= 4, true, 'the legend lists every class plus the specials')
    const legendText = await legendRows.first().textContent()
    assert.match(legendText ?? '', /–|≥/, 'each class row carries its text range')

    // Timeline: real buttons with accessible names; stepping advances the pinned frame.
    const nextFrame = workbench.getByRole('button', { name: /下一帧|Next frame/ })
    await nextFrame.click()
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map
        && [...harness.values()].some(value => value.frameIndex === 1)
    }, undefined, { timeout: 15_000 })

    // Chart brush: clicking a class bar selects its range and the highlight
    // lands on the map. The first class holds the stepped frame's features.
    const chartBars = workbench.locator('[data-workbench-chart] button')
    assert.equal(await chartBars.count() >= 3, true)
    await chartBars.nth(0).click()
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map
        && [...harness.values()].some(value => value.highlightCount >= 1)
    }, undefined, { timeout: 15_000 })

    // Export: the fixed-revision manifest status renders into the live region.
    await workbench.getByRole('button', { name: /导出当前视图|Export current view/ }).click()
    await page.waitForFunction(() => {
      const region = document.querySelector('[data-map-workbench]')
      return region !== null && (region.querySelector('[data-workbench-export-status]')?.textContent ?? '').length > 0
    }, undefined, { timeout: 15_000 })

    // The pinned frame + selection survive on the handle for the smoke lane.
    const handle = await page.evaluate(() => {
      const harness = window.__mapHarness
      return [...(harness instanceof Map ? harness.values() : [])].at(-1)
    })
    assert.equal(handle.frameIndex, 1)
    assert.equal(handle.highlightCount >= 1, true)
    assert.deepEqual(handle.styledLayers, ['zones'])
  } finally {
    if (browser) await browser.close()
    if (app) await stopProcessTree(app)
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

test('rendered pixels: the classified polygons paint the map band, survive the 3D switch, and clear on removal', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-pixels-composition-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  // Two polygons a class apart at equal-interval breaks: the high-score square
  // wears the ramp's dark top class, the low-score square its light bottom one.
  const parcels = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'dark-parcel',
        geometry: { type: 'Polygon', coordinates: [[[115.6, 39.6], [116.4, 39.6], [116.4, 40.4], [115.6, 40.4], [115.6, 39.6]]] },
        properties: { score: 26 },
      },
      {
        type: 'Feature',
        id: 'light-parcel',
        geometry: { type: 'Polygon', coordinates: [[[116.6, 39.6], [117.4, 39.6], [117.4, 40.4], [116.6, 40.4], [116.6, 39.6]]] },
        properties: { score: 2 },
      },
    ],
  }
  writeFileSync(join(workspace, 'parcels.geojson'), JSON.stringify(parcels))

  // The stub provider answers the next round only after the assertion
  // section opens the matching gate: pixel observations need the map to hold
  // still between rounds, not race the loop to the end. A gate opened before
  // its waiter arrives stays open (sticky), so neither side can deadlock.
  const gates = new Map()
  const waitForGate = name => {
    const existing = gates.get(name)
    if (existing?.opened === true) return Promise.resolve()
    return new Promise(resolve => { gates.set(name, { opened: false, resolve }) })
  }
  const openGate = name => {
    const gate = gates.get(name)
    if (gate === undefined) {
      gates.set(name, { opened: true, resolve: undefined })
      return
    }
    gate.opened = true
    gate.resolve?.()
    gate.resolve = undefined
  }
  let mainRequests = 0
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isTitleRequest(parsed)) {
        response.end(textResponse('map pixels'))
        return
      }
      mainRequests += 1
      if (mainRequests === 2) await waitForGate('framed')
      if (mainRequests === 3) await waitForGate('loaded')
      if (mainRequests === 4) await waitForGate('styled')
      if (mainRequests === 5) await waitForGate('switched')
      if (mainRequests === 1) {
        // Register the data and frame both parcels before any layer exists.
        response.end(toolResponse([
          { id: 'pixels-register', name: 'catalog_register', input: { path: 'parcels.geojson', name: 'parcels' } },
          { id: 'pixels-view', name: 'map_set_view', input: { center: [116.5, 39.9], zoom: 9, wkid: 4326 } },
        ]))
      } else if (mainRequests === 2) {
        const resourceRef = fromTranscriptOf(parsed, 'res-[a-f0-9]{24}@v1')
        response.end(toolResponse([
          { id: 'pixels-add', name: 'map_add_layer', input: { ref: resourceRef, layer_id: 'parcels' } },
        ]))
      } else if (mainRequests === 3) {
        response.end(toolResponse([
          {
            id: 'pixels-classify',
            name: 'viz_classify',
            input: { layer_id: 'parcels', field: 'score', unit: '分', classification: 'equal-interval', class_count: 3 },
          },
        ]))
      } else if (mainRequests === 4) {
        response.end(toolResponse([
          { id: 'pixels-mode', name: 'map_set_mode', input: { mode: 'scene' } },
        ]))
      } else if (mainRequests === 5) {
        response.end(toolResponse([
          { id: 'pixels-remove', name: 'map_remove_layer', input: { layer_id: 'parcels' } },
        ]))
      } else {
        response.end(textResponse('pixels measured'))
      }
    })
  })

  let app
  let browser
  let page
  try {
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const stdout = { value: '' }
    const stderr = { value: '' }
    app = spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'pixels-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)

    // Headless Chromium ships no GPU, and the ArcGIS view requests its WebGL2
    // context with `failIfMajorPerformanceCaveat`; only the ANGLE/SwiftShader
    // pair satisfies that strict request, so the software renderer must be
    // selected explicitly or the view refuses to mount at all.
    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({ locale: 'zh-CN' })
    page = await context.newPage()
    await useFixtureBasemap(page)
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await sendMessage(page, '请登记 parcels.geojson，加载为 parcels 图层，按 score 等距分三级并移动到两个地块。')

    // The map tab occurrence is the one the workbench lives in; its band is
    // what a person sees. It must be visible for any pixel measurement.
    const mapBand = page.locator('[data-map-container]:not([data-map-view])')
    await mapBand.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map
        && [...harness.values()].some(value => value.center?.[0] === 116.5 && value.center?.[1] === 39.9)
    }, undefined, { timeout: 30_000 })
    // Round 1 folded the framed view; only now may the layer be added.
    openGate('framed')

    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.layerCount === 1)
    }, undefined, { timeout: 30_000 })
    openGate('loaded')

    // Round 3 folded the classification: the legend derives from the same
    // style version the map paints, so its darkest class color is the exact
    // color the canvas must show where the top-class polygon sits.
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map
        && [...harness.values()].some(value => (value.styledLayers ?? []).includes('parcels'))
    }, undefined, { timeout: 30_000 })
    await page.locator('[data-map-workbench]').waitFor({ timeout: 30_000 })
    await page.locator('[data-workbench-legend] li').first().waitFor({ timeout: 30_000 })
    const classColor = await darkestLegendColor(page, 3)
    // The 2D map paints the class color exactly; the 3D scene shades it a
    // little (lighting and color management differ), so the tolerance covers
    // both while staying far below the background's distance to it.
    const painted2d = await waitForMapColor(page, classColor, 'present', { tolerance: 30, present: 5_000 })
    assert.ok(painted2d.count >= 5_000, `the styled polygons must cover the map band (${painted2d.count} px)`)
    // The occurrence receipt attests the same fact the pixels do: revision N
    // rendered on one concrete view, with no failed layer.
    const receipt2d = await waitForRenderedReceipt(page)
    assert.equal(receipt2d.renderedRevision, receipt2d.revision)
    assert.equal(receipt2d.failedLayers.length, 0)
    // The 2D band is measured; only now may the mode switch.
    openGate('styled')

    // Round 4 switched to the 3D scene: the same layer must paint there too,
    // through the rebuilt SceneView and its restored camera.
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.mode === 'scene')
    }, undefined, { timeout: 90_000 })
    const painted3d = await waitForMapColor(page, classColor, 'present', { tolerance: 30, present: 5_000, timeout: 60_000 })
    assert.ok(painted3d.count >= 5_000, `the 3D scene must paint the styled polygons (${painted3d.count} px)`)
    // The rebuilt SceneView is a new view: the receipt must attest rendering
    // on that new view, never inherit the destroyed MapView's observation.
    const receipt3d = await waitForRenderedReceipt(page)
    assert.notEqual(receipt3d.viewId, receipt2d.viewId)
    assert.equal(receipt3d.renderedRevision, receipt3d.revision)
    // The 3D band is measured; only now may the layer be removed.
    openGate('switched')

    // Round 5 removed the layer: the paint leaves the canvas with it, which
    // proves the counted pixels were the layer, not the background.
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.layerCount === 0)
    }, undefined, { timeout: 30_000 })
    const cleared = await waitForMapColor(page, classColor, 'absent', { tolerance: 30, absent: 500 })
    assert.ok(cleared.count <= 500, `removal must clear the class color (${cleared.count} px left)`)
  } finally {
    if (browser) await browser.close()
    if (app) await stopProcessTree(app)
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

test('implicit viewport context: a user drag posts no chat message, and the next request reasons over the settled viewport', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-gesture-composition-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# gesture composition\n')

  // Request 1 moves the view programmatically (map_set_view); request 2 ends
  // the first turn. The user then drags the map: no chat message may form.
  // The user's next message (request 3) carries the settled viewport line.
  let mainRequests = 0
  const bodies = []
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      if (isTitleRequest(parsed)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(textResponse('gesture lane'))
        return
      }
      mainRequests += 1
      bodies.push(JSON.stringify(parsed.messages))
      if (mainRequests === 1) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(toolResponse([
          { id: 'g-view', name: 'map_set_view', input: { center: [116.4, 39.9], zoom: 10, wkid: 4326 } },
        ]))
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(textResponse(`round ${String(mainRequests)} done`))
      }
    })
  })

  let app
  let browser
  let page
  try {
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const stdout = { value: '' }
    const stderr = { value: '' }
    app = spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      // The temp workspace is the project layer: a repository-root cwd would
      // read the root .env and hit the bootstrap-only guard (DEEPSEEK_* are
      // launching-environment names), refusing the boot entirely.
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'gesture-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)
    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({ locale: 'zh-CN' })
    page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useFixtureBasemap(page)
    await sendMessage(page, '把地图移动到北京。')

    const mapBand = page.locator('[data-map-container]:not([data-map-view])')
    await mapBand.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map
        && [...harness.values()].some(value => value.center?.[0] === 116.4 && value.center?.[1] === 39.9)
    }, undefined, { timeout: 30_000 })
    for (let waited = 0; waited < 30_000 && bodies.length < 2; waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    await waitForRenderedReceipt(page)
    // A real user drag on the map band: pointer events attribute the camera
    // change; the settle window then forms one bounded stable observation.
    // The view-sync camera writes hold a programmatic mute pulse — let it
    // expire so the drag is attributed to the user.
    await new Promise(resolve => setTimeout(resolve, 1_800))
    const band = await mapBand.boundingBox()
    // The layer panel overlays the map's top-left at up to 60% height; drag
    // the band center below it so the pointer reaches the map surface.
    const dragX = band.x + band.width / 2
    const dragY = band.y + band.height * 0.75
    await page.mouse.move(dragX, dragY)
    await page.mouse.down()
    await page.mouse.move(dragX + 80, dragY + 20, { steps: 10 })
    await page.mouse.up()

    // The viewport report is implicit: wait past the settle window, then make
    // sure the drag produced no model request of its own.
    await new Promise(resolve => setTimeout(resolve, 2_500))
    assert.equal(bodies.length, 2, 'a user drag never starts a model request')
    await sendMessage(page, '这里有什么？')
    for (let waited = 0; waited < 30_000 && bodies.length < 3; waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(bodies[2]?.includes('用户视窗:'), 'the next request carries the user viewport as context')
    assert.ok(!bodies.some(body => body.includes('[map-gesture v1]')), 'no gesture text ever enters the conversation')
  } finally {
    if (browser) await browser.close()
    if (app) await stopProcessTree(app)
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

test('panel user writes: a panel click applies immediately, the model reads the notice without re-applying, and model changes never re-submit', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-panel-composition-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# panel composition\n')
  const sourceCollection = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 'p1', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'first' } },
      { type: 'Feature', id: 'p2', geometry: { type: 'Point', coordinates: [116.41, 39.9] }, properties: { name: 'second' } },
    ],
  }
  writeFileSync(join(workspace, 'panel-points.geojson'), JSON.stringify(sourceCollection))
  writeFileSync(join(workspace, 'panel-beta.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', id: 'b1', geometry: { type: 'Point', coordinates: [116.42, 39.9] }, properties: { name: 'beta' } }],
  }))
  // The named resource's deterministic identity: the ref-loaded layer and the
  // download route both address this exact version.
  const sourceRef = `${resourceIdFor('panel-map')}@v1`

  /** Model requests that carried a user change notice, with the tool calls answered. */
  const noticeTurns = []
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      if (isTitleRequest(parsed)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(textResponse('panel lane'))
        return
      }
      const messages = parsed.messages
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const textOf = message => (typeof message.content === 'string'
        ? message.content
        : (Array.isArray(message.content) ? message.content.map(part => part.text ?? '').join('\n') : ''))
      // Notices claimed with a prompt sit beside it, so routing reads every
      // user message after the newest assistant message.
      const lastAssistant = messages.map(message => message.role).lastIndexOf('assistant')
      const pendingText = messages.slice(lastAssistant + 1).filter(message => message.role === 'user').map(textOf).join('\n')
      if (pendingText.includes('面板里改了什么')) {
        const notices = messages.filter(message => message.role === 'user' && textOf(message).includes('[map-user-change v1]'))
        noticeTurns.push(notices.map(textOf))
        response.end(textResponse('已读到面板改动。'))
        return
      }
      if (pendingText.includes('把两个图层都显示出来')) {
        response.end(toolResponse([{ id: 'panel-show', name: 'layer_set_state', input: { states: [{ layer_id: 'alpha', visible: true }, { layer_id: 'beta', visible: true }] } }]))
        return
      }
      // Setup phases read the transcript itself (tool results arrive as user
      // `tool_result` parts, and issued call inputs stay in the transcript):
      // register the named resource, load both layers, group them, then end.
      const transcript = JSON.stringify(messages)
      if (!transcript.includes('panel-points.geojson')) {
        response.end(toolResponse([{ id: 'panel-register', name: 'catalog_register', input: { path: 'panel-points.geojson', name: 'panel-map' } }]))
        return
      }
      if (!transcript.includes('panel-beta.geojson')) {
        response.end(toolResponse([
          { id: 'panel-add-alpha', name: 'map_add_layer', input: { ref: sourceRef, name: 'Alpha', layer_id: 'alpha' } },
          { id: 'panel-add-beta', name: 'map_add_layer', input: { path: 'panel-beta.geojson', name: 'Beta', layer_id: 'beta' } },
        ]))
        return
      }
      if (!transcript.includes('基准')) {
        response.end(toolResponse([{ id: 'panel-group', name: 'layer_set_state', input: { states: [{ layer_id: 'alpha', group: '基准' }, { layer_id: 'beta', group: '基准' }] } }]))
        return
      }
      response.end(textResponse('panel round done'))
    })
  })

  let app
  let browser
  let page
  try {
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const stdout = { value: '' }
    const stderr = { value: '' }
    app = spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'panel-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)
    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({ locale: 'zh-CN' })
    page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useFixtureBasemap(page)
    // Round 1 registers the named resource; round 2 loads the ref layer plus
    // the display layer; round 3 groups both.
    await sendMessage(page, '准备图层数据。')
    const mapBand = page.locator('[data-map-container]:not([data-map-view])')
    await mapBand.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-map-panel-layer]')]
      return rows.length >= 2 && rows.every(row => row.querySelector('[data-map-panel-eye]') !== null)
    }, undefined, { timeout: 30_000 })
    await page.waitForFunction(() => {
      const groups = [...document.querySelectorAll('[data-map-panel-group]')]
      return groups.some(group => group.getAttribute('aria-label') === '基准' && (group.textContent ?? '').includes('2 层'))
    }, undefined, { timeout: 15_000 })
    await waitForRenderedReceipt(page)

    const alphaRow = page.locator('[data-map-panel-layer]', { hasText: 'Alpha' })
    const betaRow = page.locator('[data-map-panel-layer]', { hasText: 'Beta' })
    const eyeOf = row => row.locator('[data-map-panel-eye]')
    assert.equal(await eyeOf(alphaRow).getAttribute('aria-pressed'), 'true')
    assert.equal(await eyeOf(betaRow).getAttribute('aria-pressed'), 'true')
    const turnsBefore = await page.evaluate(() => document.querySelectorAll('[data-map-tool-card]').length)

    // (1) Group eye: one user write hides both members at once, with no model turn.
    await page.locator('[data-map-panel-group]', { hasText: '基准' }).getByRole('button', { name: '隐藏本组' }).click()
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-map-panel-layer]')]
      return rows.length >= 2 && rows.every(row => row.querySelector('[data-map-panel-eye]')?.getAttribute('aria-pressed') === 'false')
    }, undefined, { timeout: 10_000 })
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-map-tool-card]').length), turnsBefore, 'the user write runs no tool')

    // (2) A model-driven change updates the panel and writes nothing back.
    await sendMessage(page, '把两个图层都显示出来。')
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-map-panel-layer]')]
      return rows.length >= 2 && rows.every(row => row.querySelector('[data-map-panel-eye]')?.getAttribute('aria-pressed') === 'true')
    }, undefined, { timeout: 30_000 })

    // (3) One layer eye, then drag order: both apply immediately.
    await eyeOf(alphaRow).click()
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-map-panel-layer]')]
      const pressed = name => rows.find(row => (row.textContent ?? '').includes(name))?.querySelector('[data-map-panel-eye]')?.getAttribute('aria-pressed')
      return pressed('Alpha') === 'false' && pressed('Beta') === 'true'
    }, undefined, { timeout: 10_000 })
    const orderOf = () => page.evaluate(() => [...document.querySelectorAll('[data-map-panel-layer] [data-map-panel-name]')].map(node => node.textContent))
    const before = await orderOf()
    await page.locator('[data-map-panel-layer]', { hasText: before[1] }).locator('[data-map-panel-handle]')
      .dragTo(page.locator('[data-map-panel-layer]', { hasText: before[0] }).locator('[data-map-panel-name]'))
    await page.waitForFunction(first => document.querySelector('[data-map-panel-layer] [data-map-panel-name]')?.textContent !== first, before[0], { timeout: 10_000 })

    // (4) The next model turn reads every notice and repeats none of them.
    await sendMessage(page, '我在面板里改了什么？')
    await page.getByText('已读到面板改动。', { exact: true }).waitFor({ timeout: 30_000 })
    assert.equal(noticeTurns.length, 1)
    const notices = noticeTurns[0].join('\n')
    assert.match(notices, /隐藏了图层：(Alpha、Beta|Beta、Alpha)/)
    assert.match(notices, /隐藏了图层：Alpha/)
    assert.match(notices, /调整了图层叠放顺序/)
    assert.equal(await eyeOf(alphaRow).getAttribute('aria-pressed'), 'false', 'reading the notice changes nothing')

    // (5) The menu's download entry streams the exact registered bytes.
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await alphaRow.getByRole('button', { name: 'Alpha 的更多操作' }).click()
    await alphaRow.getByRole('menuitem', { name: `下载引用 ${sourceRef}` }).click()
    const download = await downloadPromise
    const downloaded = JSON.parse(readFileSync(await download.path(), 'utf8'))
    assert.equal(downloaded.features.length, sourceCollection.features.length, 'the downloaded bytes are the registered version')

    // (6) The route from the real page: authorized bytes plus fixed refusals.
    const sessionId = await page.evaluate(() => document.querySelector('[data-map-container]')?.getAttribute('data-map-session'))
    assert.ok(typeof sessionId === 'string' && sessionId.length > 0)
    const legs = await page.evaluate(async ({ session, ref }) => {
      const query = (targetSession, targetRef) => `/api/map/artifact?session=${encodeURIComponent(targetSession)}&ref=${encodeURIComponent(targetRef)}`
      const authorized = await fetch(query(session, ref))
      const bytes = new Uint8Array(await authorized.arrayBuffer())
      const refused = await fetch(query(session, 'art-missing@v1'))
      const noSession = await fetch(`/api/map/artifact?ref=${encodeURIComponent(ref)}`)
      return {
        authorized: {
          status: authorized.status,
          type: authorized.headers.get('content-type'),
          disposition: authorized.headers.get('content-disposition'),
          bytes: bytes.byteLength,
        },
        refused: { status: refused.status, body: await refused.json() },
        noSession: { status: noSession.status, body: await noSession.json() },
      }
    }, { session: sessionId, ref: sourceRef })
    assert.equal(legs.authorized.status, 200)
    assert.equal(legs.authorized.type, 'application/octet-stream')
    assert.ok(legs.authorized.disposition?.includes(sourceRef), 'the response names the exact version')
    assert.ok(legs.authorized.bytes > 0)
    assert.equal(legs.refused.status, 404)
    assert.deepEqual(legs.refused.body, { ok: false, code: 'unknown-ref' })
    assert.equal(legs.noSession.status, 400)
    assert.deepEqual(legs.noSession.body, { ok: false, code: 'unknown-session' })
  } finally {
    if (browser) await browser.close()
    if (app) await stopProcessTree(app)
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

// The default lane replays the live-recorded decisions, not canned tool results.
// MAP_FACILITY_LIVE=1 selects the deployment's real model for a separate demonstration.
test('layer workbench: dialogue imports with confirmation land as layers, and honest rejections leave no residue', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-lw-import-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const fixtureRoot = join(root, 'map', 'arcgis-mcp', 'tests', 'fixtures', 'layer-workbench')
  for (const name of ['hospitals.csv', 'roads.shp.zip', 'truncated.shp.zip']) {
    cpSync(join(fixtureRoot, name), join(workspace, name))
  }

  /** Every scripted round's transcript, for result-shape assertions. */
  const transcripts = []
  let mainRequests = 0
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isTitleRequest(parsed)) {
        response.end(textResponse('layer workbench import'))
        return
      }
      mainRequests += 1
      transcripts.push(JSON.stringify(parsed.messages ?? []).slice(-9000))
      if (mainRequests === 1) {
        response.end(toolResponse([
          { id: 'lw-import-gate', name: 'data_import', input: { path: 'hospitals.csv', name: 'hospitals' } },
        ]))
      } else if (mainRequests === 2) {
        // The gated result must be model-visible with candidates and a fingerprint.
        const gated = transcripts.at(-1)
        assert.match(gated, /needs_confirmation/, 'the needs_confirmation outcome reaches the model')
        assert.match(gated, /column_candidates/)
        assert.match(gated, /candidates_fingerprint\\?":\\?"[0-9a-f]{64}/)
        response.end(textResponse('坐标列有歧义：x/y 均为候选，请确认经度列用 x、纬度列用 y。'))
      } else if (mainRequests === 3) {
        // The user confirmed; resend with the decisions plus the fingerprint.
        const fingerprint = [...transcripts.at(-1).matchAll(/candidates_fingerprint\\?":\\?"([0-9a-f]{64})/g)].map(match => match[1]).at(-1)
        assert.ok(fingerprint, 'the confirmation fingerprint is in the transcript')
        response.end(toolResponse([
          { id: 'lw-import-confirm', name: 'data_import', input: { path: 'hospitals.csv', name: 'hospitals', lon_column: 'x', lat_column: 'y', confirm: { fingerprint } } },
          { id: 'lw-import-roads', name: 'data_import', input: { path: 'roads.shp.zip', name: 'roads' } },
        ]))
      } else if (mainRequests === 4) {
        const refs = [...new Set([...transcripts.at(-1).matchAll(/res-[a-f0-9]{24}@v1/g)].map(match => match[0]))]
        assert.equal(refs.length, 2, `both imports published resources (saw ${refs})`)
        response.end(toolResponse([
          { id: 'lw-add-hospitals', name: 'map_add_layer', input: { ref: refs[0], layer_id: 'hospitals', name: '医院' } },
          { id: 'lw-add-roads', name: 'map_add_layer', input: { ref: refs[1], layer_id: 'roads', name: '道路' } },
          { id: 'lw-view', name: 'map_set_view', input: { center: [116.4, 39.91], zoom: 11, wkid: 4326 } },
        ]))
      } else if (mainRequests === 5) {
        response.end(textResponse('导入完成：医院与道路两个图层已上图。'))
      } else if (mainRequests === 6) {
        response.end(toolResponse([
          { id: 'lw-import-broken', name: 'data_import', input: { path: 'truncated.shp.zip', name: 'broken' } },
        ]))
      } else if (mainRequests === 7) {
        // The refusal must be a visible, stable tool error in the transcript.
        assert.match(transcripts.at(-1), /record chain/, 'the truncated shapefile refuses with the stable error')
        response.end(toolResponse([
          { id: 'lw-resolve', name: 'catalog_resolve', input: { search: {} } },
        ]))
      } else {
        const listing = transcripts.at(-1)
        assert.equal([...listing.matchAll(/res-[a-f0-9]{24}@v1/g)].length >= 2, true, 'the resolve listing reaches the model')
        response.end(textResponse('链路完成'))
      }
    })
  })

  let app
  let browser
  let page
  try {
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const stdout = { value: '' }
    const stderr = { value: '' }
    app = spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'lw-import-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)

    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({ locale: 'zh-CN' })
    page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useFixtureBasemap(page)
    const mapBand = page.locator('[data-map-container]:not([data-map-view])')

    // Round 1 imports the ambiguous CSV; the gate itself must leave the map empty.
    await sendMessage(page, '请把 hospitals.csv 导入并放到地图上。')
    await mapBand.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.layerCount === 0)
    }, undefined, { timeout: 30_000 })
    await page.getByText('坐标列有歧义', { exact: false }).waitFor({ timeout: 45_000 })
    await page.waitForFunction(() => document.querySelectorAll('[data-map-panel-layer]').length === 0, undefined, { timeout: 10_000 })

    // The user confirms; one round trip completes the import, the shapefile,
    // and both layers.
    await sendMessage(page, '确认：经度列用 x，纬度列用 y。')
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-map-panel-layer]')]
      return rows.length === 2 && rows.every(row => row.querySelector('[data-map-panel-eye]')?.getAttribute('aria-pressed') === 'true')
    }, undefined, { timeout: 60_000 })
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.layerCount === 2)
    }, undefined, { timeout: 30_000 })
    const receipt = await waitForRenderedReceipt(page)
    assert.equal(receipt.failedLayers.length, 0)
    const panelText = await page.locator('[data-map-panel]').first().textContent()
    assert.match(panelText ?? '', /医院/)
    assert.match(panelText ?? '', /道路/)

    // The malformed file refuses honestly: same layers, no residue, no crash.
    await sendMessage(page, '再试试 truncated.shp.zip。')
    await page.getByText('链路完成', { exact: true }).waitFor({ timeout: 60_000 })
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.layerCount === 2)
    }, undefined, { timeout: 30_000 })
    assert.equal((await page.locator('[data-map-panel-layer]').count()), 2, 'the refused import adds no panel row')
    const failures = stderr.value.split('\n').filter(line => /Error|error|failed|warn/.test(line)
      && !/key|token|secret|password|authorization/i.test(line)
      && !/did not activate|trace-warnings/.test(line)).slice(-6)
    assert.deepEqual(failures, [])
    assert.equal(mainRequests >= 8, true, `the scripted chain ran to completion (${mainRequests} rounds)`)
  } finally {
    await new Promise(resolveClose => provider.close(resolveClose))
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined && app.pid !== undefined) {
      try { process.kill(-app.pid, 'SIGTERM') } catch { /* the app already exited */ }
    }
    rmSync(temp, { recursive: true, force: true })
  }
})

test('layer workbench: styles, legend chips and panel requests stay consistent through the model round', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-lw-styles-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const fixtureRoot = join(root, 'map', 'arcgis-mcp', 'tests', 'fixtures', 'layer-workbench')
  for (const name of ['hospitals.confirmed.csv', 'roads.shp.zip']) {
    cpSync(join(fixtureRoot, name), join(workspace, name))
  }
  const hospitalIds = ['示例第一医院', '示例第二医院', '示例第三医院']
  const imageryTemplate = 'https://tiles.layer-workbench.invalid/{z}/{y}/{x}.png'

  /** Every `[map-panel v1]` batch the model conversation received, in arrival order. */
  const panelBatches = []
  const seenPanelAt = new Set()
  /** Extract the newest parseable panel batch from real user messages (panel write channel helper). */
  function extractPanelBatch(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message.role !== 'user') continue
      const text = typeof message.content === 'string'
        ? message.content
        : (Array.isArray(message.content) ? message.content.map(part => part.text ?? '').join('\n') : '')
      let from = 0
      for (;;) {
        const markerAt = text.indexOf('[map-panel v1]\n', from)
        if (markerAt < 0) break
        from = markerAt + '[map-panel v1]\n'.length
        const after = text.slice(from)
        let depth = 0
        let stop = -1
        for (let at = 0; at < after.length; at += 1) {
          if (after[at] === '{') depth += 1
          else if (after[at] === '}') {
            depth -= 1
            if (depth === 0) { stop = at + 1; break }
          }
        }
        if (stop < 0) continue
        try {
          return JSON.parse(after.slice(0, stop))
        } catch {
          continue
        }
      }
    }
    return undefined
  }

  const transcripts = []
  let mainRequests = 0
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isTitleRequest(parsed)) {
        response.end(textResponse('layer workbench styles'))
        return
      }
      mainRequests += 1
      const transcript = JSON.stringify(parsed.messages ?? []).slice(-9000)
      transcripts.push(transcript)
      const fullTranscript = JSON.stringify(parsed.messages ?? [])
      const batch = extractPanelBatch(parsed.messages ?? [])
      if (batch !== undefined && !seenPanelAt.has(batch.at)) {
        seenPanelAt.add(batch.at)
        const entry = batch.r[0]
        panelBatches.push({ request: entry, revision: batch.rev })
        if (entry.op === 'set-state') {
          response.end(toolResponse([{
            id: `panel-state-${String(panelBatches.length)}`,
            name: 'layer_set_state',
            input: { states: entry.states.map(state => ({
              layer_id: state.id,
              ...(state.visible === undefined ? {} : { visible: state.visible }),
              ...(state.opacity === undefined ? {} : { opacity: state.opacity }),
              ...(state.group === undefined ? {} : { group: state.group }),
            })) },
          }]))
          forceEndNext = true
          return
        }
      }
      // A panel batch consumes its own round and ends its turn with prose,
      // so the assertions between user messages keep a stable boundary.
      if (forceEndNext) {
        forceEndNext = false
        response.end(textResponse('面板请求已生效。'))
        return
      }
      scriptStep += 1
      const step = scriptStep
      if (step === 1) {
        response.end(toolResponse([
          { id: 'lw2-import-hospitals', name: 'data_import', input: { path: 'hospitals.confirmed.csv', name: 'hospitals', lon_column: 'lon', lat_column: 'lat', id_column: '名称' } },
          { id: 'lw2-import-roads', name: 'data_import', input: { path: 'roads.shp.zip', name: 'roads' } },
        ]))
      } else if (step === 2) {
        const refs = [...new Set([...fullTranscript.matchAll(/res-[a-f0-9]{24}@v1/g)].map(match => match[0]))]
        assert.equal(refs.length, 2, `both imports published resources (saw ${refs})`)
        response.end(toolResponse([
          { id: 'lw2-add-hospitals', name: 'map_add_layer', input: { ref: refs[0], layer_id: 'hospitals', name: '医院' } },
          { id: 'lw2-add-roads', name: 'map_add_layer', input: { ref: refs[1], layer_id: 'roads', name: '道路' } },
          { id: 'lw2-view', name: 'map_set_view', input: { center: [116.397, 39.91], zoom: 13, wkid: 4326 } },
        ]))
      } else if (step === 3) {
        response.end(toolResponse([
          { id: 'lw2-preset', name: 'layer_set_style', input: { layer_id: 'hospitals', preset: 'marker-square-red-large' } },
          { id: 'lw2-group', name: 'layer_set_state', input: { states: [{ layer_id: 'hospitals', group: '基准' }, { layer_id: 'roads', group: '基准' }] } },
        ]))
      } else if (step === 4) {
        response.end(textResponse('已按红色方形预设显示并归组。'))
      } else if (step === 5) {
        response.end(toolResponse([
          { id: 'lw2-overrides', name: 'layer_set_style', input: { layer_id: 'hospitals', overrides: [{ featureIds: hospitalIds, patch: { color: '#0055ff', opacity: 1 } }] } },
        ]))
      } else if (step === 6) {
        response.end(textResponse('三个医院要素已改为蓝色。'))
      } else if (step === 7) {
        response.end(toolResponse([{ id: 'lw2-state-read', name: 'map_get_state', input: {} }]))
      } else if (step === 8) {
        // The stale-revision attempt: one visible refusal, then the retry.
        const revision = [...fullTranscript.matchAll(/\\?"revision\\?":(\d+)/g)].map(match => Number(match[1])).at(-1) ?? 0
        assert.ok(revision > 0, `the state read must expose the revision (saw ${transcript.slice(-500)})`)
        staleRevision = revision - 1
        response.end(toolResponse([
          { id: 'lw2-stale', name: 'layer_set_state', input: { states: [{ layer_id: 'hospitals', visible: true }], expected_revision: staleRevision } },
        ]))
      } else if (step === 9) {
        assert.match(fullTranscript, /stale/, 'the stale-revision refusal is model-visible')
        response.end(toolResponse([
          { id: 'lw2-retry', name: 'layer_set_state', input: { states: [{ layer_id: 'hospitals', visible: true }], expected_revision: staleRevision + 1 } },
        ]))
      } else if (step === 10) {
        response.end(textResponse('已重新显示医院层。'))
      } else if (step === 11) {
        response.end(toolResponse([
          { id: 'lw2-heatmap', name: 'layer_set_style', input: { layer_id: 'hospitals', preset: 'preset:heatmap-viridis', overrides: null } },
          { id: 'lw2-imagery', name: 'map_add_layer', input: { tile_url: imageryTemplate, tile_attribution: 'layer-workbench fixture tiles', layer_id: 'imagery-base', name: '底图影像' } },
        ]))
      } else {
        response.end(textResponse('样式与家族切换完成。'))
      }
    })
  })
  let staleRevision = 0
  /** Scripted phase counter; panel-batch rounds never advance it. */
  let scriptStep = 0
  /** Whether the next round must close the panel turn with prose. */
  let forceEndNext = false

  /**
   * The layer panel overlays the map's top-left corner, so its chip swatches
   * are inside any naive container clip. Sample the band right of the panel
   * instead: same canvas, no panel pixels.
   * @param page - the driven page.
   * @param rgb - the target channel triple.
   * @param expected - `present` or `absent`.
   * @returns the last measurement.
   */
  async function waitForMapColorBesidePanel(page, rgb, expected) {
    const deadline = Date.now() + 30_000
    let last
    for (;;) {
      // Hidden overlays report zero rects through getBoundingClientRect, so a
      // vanished workbench simply stops constraining the clip instead of
      // stalling an auto-waiting locator.
      const rects = await page.evaluate(() => {
        const rectOf = selector => {
          const element = document.querySelector(selector)
          if (element === null) return null
          const rect = element.getBoundingClientRect()
          return rect.width < 2 || rect.height < 2 ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        }
        return {
          container: rectOf('[data-map-container]:not([data-map-view])'),
          panel: rectOf('[data-map-panel]'),
          workbench: rectOf('[data-map-workbench]'),
        }
      })
      const box = rects.container
      if (box === null) throw new Error('no map container box')
      // The panel floats at the top right: sample the band to its left.
      const left = box.x + 4
      const right = rects.panel === null ? box.x + box.width : Math.min(box.x + box.width, rects.panel.x - 4)
      const bottom = rects.workbench === null ? box.y + box.height : Math.min(rects.workbench.y - 4, box.y + box.height)
      const clip = { x: Math.floor(left), y: Math.floor(box.y), width: Math.max(2, Math.floor(right - left)), height: Math.max(2, Math.floor(bottom - box.y)) }
      const shot = await page.screenshot({ clip })
      last = await page.evaluate(async ({ dataUrl, target, slack }) => {
        const blob = await (await fetch(dataUrl)).blob()
        const bitmap = await createImageBitmap(blob)
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d')
        context.drawImage(bitmap, 0, 0)
        const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height)
        let count = 0
        for (let at = 0; at < data.length; at += 4) {
          if (Math.abs(data[at] - target[0]) <= slack
            && Math.abs(data[at + 1] - target[1]) <= slack
            && Math.abs(data[at + 2] - target[2]) <= slack) count += 1
        }
        return { count, total: Math.floor(data.length / 4) }
      }, { dataUrl: `data:image/png;base64,${shot.toString('base64')}`, target: rgb, slack: 40 })
      const holds = expected === 'present' ? last.count >= 60 : last.count <= 8
      if (holds) return last
      if (Date.now() > deadline) {
        assert.fail(`beside-panel ${expected} check for rgb(${rgb.join(', ')}) failed after 30000 ms: ${last.count}/${last.total} matching pixels`)
      }
      await new Promise(resolve => setTimeout(resolve, 400))
    }
  }

  let app
  let browser
  let page
  try {
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const stdout = { value: '' }
    const stderr = { value: '' }
    app = spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'lw-styles-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)

    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({ locale: 'zh-CN' })
    page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useFixtureBasemap(page)
    // The imagery family layer never leaves the loopback: the fixture tile answers.
    const tile = readFileSync(join(fixtureRoot, 'tile.png'))
    await page.route('https://tiles.layer-workbench.invalid/**', route =>
      route.fulfill({ contentType: 'image/png', body: tile }))

    // M1: import both datasets, land both layers, apply the preset, group them.
    await sendMessage(page, '导入两份数据并成层：医院用红色方形预设，并与道路归入「基准」组。')
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-map-panel-layer]')]
      return rows.length === 2 && rows.every(row => row.querySelector('[data-map-panel-eye]')?.getAttribute('aria-pressed') === 'true')
    }, undefined, { timeout: 60_000 })
    await page.waitForFunction(() => {
      const groups = [...document.querySelectorAll('[data-map-panel-group]')]
      return groups.some(group => group.getAttribute('aria-label') === '基准' && (group.textContent ?? '').includes('2 层'))
    }, undefined, { timeout: 30_000 })
    await waitForRenderedReceipt(page)

    // The chip's point-symbol color is the pixel oracle for the preset.
    await page.locator('[data-map-panel-layer]', { hasText: '医院' }).locator('[data-map-panel-swatch] > span').first().waitFor({ timeout: 15_000 })
    const chipColor = await page.locator('[data-map-panel-layer]', { hasText: '医院' })
      .locator('[data-map-panel-swatch] > span').first()
      .evaluate(span => getComputedStyle(span).backgroundColor)
    const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(chipColor)
    assert.ok(match !== null, `the chip color parses (${chipColor})`)
    const presetRgb = [Number(match[1]), Number(match[2]), Number(match[3])]
    const painted = await waitForMapColorBesidePanel(page, presetRgb, 'present')
    assert.ok(painted.count >= 60, `the preset paints the map band with the chip color (${painted.count} px of rgb(${presetRgb.join(', ')}))`)

    // M2: per-feature overrides repaint all three markers blue; the chip keeps
    // the layer symbol but carries the overrides marker.
    await sendMessage(page, '把三个医院要素都改成蓝色。')
    await page.getByText('三个医院要素已改为蓝色。', { exact: true }).waitFor({ timeout: 60_000 })
    const repainted = await waitForMapColorBesidePanel(page, [0, 85, 255], 'present')
    assert.ok(repainted.count >= 60, `the overrides repaint the markers (${repainted.count} px)`)
    await waitForMapColorBesidePanel(page, presetRgb, 'absent')
    assert.equal(await page.locator('[data-map-panel-layer]', { hasText: '医院' }).getByText('含逐要素覆盖').count(), 1)

    // Panel user write: hiding the group applies at once, without a model turn.
    await page.locator('[data-map-panel-group]', { hasText: '基准' }).getByRole('button', { name: '隐藏本组' }).click()
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-map-panel-layer]')]
      return rows.length >= 2 && rows.every(row => row.querySelector('[data-map-panel-eye]')?.getAttribute('aria-pressed') === 'false')
    }, undefined, { timeout: 10_000 })
    assert.equal(panelBatches.length, 0, 'the user write queues no conversation request')
    await waitForMapColorBesidePanel(page, [0, 85, 255], 'absent')

    // M3: a stale revision is a visible refusal; the retry re-shows the layer
    // with zero new panel requests (model-driven changes never re-enter).
    await sendMessage(page, '把医院层重新显示出来。')
    await page.getByText('已重新显示医院层。', { exact: true }).waitFor({ timeout: 90_000 })
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-map-panel-layer]')]
      const hospitals = rows.find(row => (row.textContent ?? '').includes('医院'))
      const roads = rows.find(row => (row.textContent ?? '').includes('道路'))
      return hospitals?.querySelector('[data-map-panel-eye]')?.getAttribute('aria-pressed') === 'true'
        && roads?.querySelector('[data-map-panel-eye]')?.getAttribute('aria-pressed') === 'false'
    }, undefined, { timeout: 30_000 })
    const reshown = await waitForMapColorBesidePanel(page, [0, 85, 255], 'present')
    assert.ok(reshown.count >= 60, `the retry repaints the overridden markers (${reshown.count} px)`)
    assert.equal(panelBatches.length, 0, 'model-driven changes submit no panel requests')

    // M4: family coverage — the hospital layer becomes a heatmap (overrides
    // cleared in the same call) and a WebTile imagery layer joins the map.
    await sendMessage(page, '医院层改成热力图，并加一层影像底图。')
    await page.getByText('样式与家族切换完成。', { exact: true }).waitFor({ timeout: 90_000 })
    await page.waitForFunction(() => document.querySelectorAll('[data-map-panel-layer]').length === 3, undefined, { timeout: 30_000 })
    const badges = await page.evaluate(() => [...document.querySelectorAll('[data-map-panel-layer]')].map(row => ({
      text: row.textContent ?? '',
      badge: row.querySelector('[data-map-panel-swatch]')?.getAttribute('aria-label') ?? '',
    })))
    assert.ok(badges.some(row => row.text.includes('医院') && row.badge === '热力'), `the hospital layer carries the heatmap badge (${JSON.stringify(badges)})`)
    assert.ok(badges.some(row => row.text.includes('底图影像') && row.badge === '影像'), `the imagery layer carries the imagery badge (${JSON.stringify(badges)})`)
    await page.locator('[data-map-panel-layer]', { hasText: '医院' }).locator('[data-map-panel-ramp] > span').first().waitFor({ timeout: 15_000 })
    const heatmapStops = await page.locator('[data-map-panel-layer]', { hasText: '医院' })
      .locator('[data-map-panel-ramp] > span').count()
    assert.ok(heatmapStops >= 3, `the heatmap chip shows the ramp stops (${heatmapStops})`)
    const finalReceipt = await waitForRenderedReceipt(page)
    assert.equal(finalReceipt.failedLayers.length, 0, 'the heatmap and imagery layers render without failures')

    const failures = stderr.value.split('\n').filter(line => /Error|error|failed|warn/.test(line)
      && !/key|token|secret|password|authorization/i.test(line)
      && !/did not activate|trace-warnings/.test(line)).slice(-6)
    assert.deepEqual(failures, [])
  } finally {
    await new Promise(resolveClose => provider.close(resolveClose))
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined && app.pid !== undefined) {
      try { process.kill(-app.pid, 'SIGTERM') } catch { /* the app already exited */ }
    }
    rmSync(temp, { recursive: true, force: true })
  }
})

test('layer workbench: dialogue exports reach the browser and survive an app restart', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-lw-export-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const fixtureRoot = join(root, 'map', 'arcgis-mcp', 'tests', 'fixtures', 'layer-workbench')
  for (const name of ['hospitals.confirmed.csv', 'roads.shp.zip']) {
    cpSync(join(fixtureRoot, name), join(workspace, name))
  }

  /** Scripted phase counter over the provider rounds this test authored. */
  let scriptStep = 0
  const transcripts = []
  let mainRequests = 0
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isTitleRequest(parsed)) {
        response.end(textResponse('layer workbench export'))
        return
      }
      mainRequests += 1
      const fullTranscript = JSON.stringify(parsed.messages ?? [])
      transcripts.push(fullTranscript)
      scriptStep += 1
      const step = scriptStep
      if (step === 1) {
        response.end(toolResponse([
          { id: 'lw3-import-hospitals', name: 'data_import', input: { path: 'hospitals.confirmed.csv', name: 'hospitals', lon_column: 'lon', lat_column: 'lat', id_column: '名称' } },
          { id: 'lw3-import-roads', name: 'data_import', input: { path: 'roads.shp.zip', name: 'roads' } },
        ]))
      } else if (step === 2) {
        const refs = [...new Set([...fullTranscript.matchAll(/res-[a-f0-9]{24}@v1/g)].map(match => match[0]))]
        assert.equal(refs.length, 2, `both imports published resources (saw ${refs})`)
        response.end(toolResponse([
          { id: 'lw3-add-hospitals', name: 'map_add_layer', input: { ref: refs[0], layer_id: 'hospitals', name: '医院' } },
          { id: 'lw3-add-roads', name: 'map_add_layer', input: { ref: refs[1], layer_id: 'roads', name: '道路' } },
          { id: 'lw3-view', name: 'map_set_view', input: { center: [116.397, 39.91], zoom: 12, wkid: 4326 } },
          { id: 'lw3-group', name: 'layer_set_state', input: { states: [{ layer_id: 'hospitals', group: '基准' }, { layer_id: 'roads', group: '基准' }] } },
        ]))
      } else if (step === 3) {
        response.end(textResponse('两份地图数据已就绪。'))
      } else if (step === 4) {
        response.end(toolResponse([
          { id: 'lw3-export', name: 'data_export', input: { map: true, format: 'geojson' } },
        ]))
      } else if (step === 5) {
        const artifacts = [...fullTranscript.matchAll(/art-[a-f0-9-]+@v1/g)].map(match => match[0])
        assert.equal(new Set(artifacts).size, 2, `the whole-map export reports one artifact per layer (saw ${artifacts})`)
        const mapRevision = [...fullTranscript.matchAll(/map_revision\\?":(\d+)/g)].map(match => Number(match[1])).at(-1)
        assert.ok(mapRevision !== undefined && mapRevision > 0, 'the export result reports the map revision')
        response.end(toolResponse([
          { id: 'lw3-save', name: 'map_save', input: { map_revision: mapRevision } },
        ]))
      } else if (step === 6) {
        assert.match(fullTranscript, /\\?"saved\\?":true/, 'the save receipt reaches the model')
        response.end(textResponse('已导出并保存。'))
      } else if (step === 7) {
        response.end(toolResponse([{ id: 'lw3-state-after', name: 'map_get_state', input: {} }]))
      } else {
        response.end(textResponse('重启后状态一致。'))
      }
    })
  })

  /** Boot (or reboot) the app over the same home with the shared provider. */
  function bootApp(providerPort, appPort) {
    const stdout = { value: '' }
    const stderr = { value: '' }
    const child = spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'lw-export-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout.value += chunk })
    child.stderr.on('data', chunk => { stderr.value += chunk })
    return { child, stdout, stderr }
  }

  let app
  let browser
  let page
  try {
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const first = bootApp(providerPort, appPort)
    app = first.child
    const url = await waitForAppUrl(app, first.stdout, first.stderr)

    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({ locale: 'zh-CN' })
    page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useFixtureBasemap(page)

    // M1: import, land both layers in one group, verify the wire.
    await sendMessage(page, '导入两份数据成层并归入「基准」组。')
    await page.getByText('两份地图数据已就绪。', { exact: true }).waitFor({ timeout: 90_000 })
    await page.waitForFunction(() => document.querySelectorAll('[data-map-panel-layer]').length === 2, undefined, { timeout: 30_000 })
    const beforeReceipt = await waitForRenderedReceipt(page)
    const sessionId = beforeReceipt.sessionId
    const beforeRevision = beforeReceipt.revision
    const hospitalsRow = page.locator('[data-map-panel-layer]', { hasText: '医院' })
    await hospitalsRow.getByRole('button', { name: '医院 的更多操作' }).click()
    const resourceRef = await hospitalsRow.evaluate(row => row.querySelector('[role="menuitem"][aria-label^="下载引用"]')?.getAttribute('aria-label')?.match(/(res-[^ ]+@v\d+)/)?.[1] ?? null)
    await hospitalsRow.getByRole('button', { name: '医院 的更多操作' }).click()
    assert.ok(resourceRef !== null, 'the ref-loaded layer exposes its exact-version download')

    // M2: the whole-map export publishes one artifact per layer; the refs ride
    // the conversation into the browser.
    await sendMessage(page, '把当前地图全部导出并保存。')
    await page.getByText('已导出并保存。', { exact: true }).waitFor({ timeout: 90_000 })
    const exportTranscript = transcripts.at(-1)
    const artifactPairs = [...exportTranscript.matchAll(/(art-[a-f0-9-]+@v1)[^{}]{0,120}?content_digest\\?":\\?"([0-9a-f]{64})/g)].map(match => [match[1], match[2]])
    const artifactRefs = [...new Set(artifactPairs.map(pair => pair[0]))]
    assert.equal(artifactRefs.length, 2, `both per-layer artifacts are model-visible (saw ${artifactRefs})`)
    const digestOfRef = new Map(artifactPairs)
    assert.equal(digestOfRef.size, 2, `each artifact reports its digest (saw ${JSON.stringify(artifactPairs)})`)

    // One artifact ref from the conversation streams through the read-only
    // route from the real page: the bytes hash to the reported digest.
    const sessionForRefs = await page.evaluate(() => document.querySelector('[data-map-container]')?.getAttribute('data-map-session'))
    const pastedHex = await page.evaluate(async ({ session, ref }) => {
      const response = await fetch(`/api/map/artifact?session=${encodeURIComponent(session)}&ref=${encodeURIComponent(ref)}`)
      const digest = await crypto.subtle.digest('SHA-256', await response.arrayBuffer())
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
    }, { session: sessionForRefs, ref: artifactRefs[0] })
    assert.equal(pastedHex, digestOfRef.get(artifactRefs[0]), 'the artifact route streams the exact published artifact bytes')

    // The layer menu's download answers with the registered resource version.
    const layerDownload = page.waitForEvent('download', { timeout: 30_000 })
    await hospitalsRow.getByRole('button', { name: '医院 的更多操作' }).click()
    await hospitalsRow.getByRole('menuitem', { name: `下载引用 ${resourceRef}` }).click()
    const layered = readFileSync(await (await layerDownload).path())
    assert.equal(JSON.parse(layered.toString('utf8')).features.length, 3, 'the layer download carries the registered features')

    // M3: kill the app process tree, reboot over the same home, and reload.
    await stopProcessTree(app)
    app = undefined
    const second = bootApp(providerPort, appPort)
    app = second.child
    await waitForAppUrl(app, second.stdout, second.stderr)
    await page.reload()
    await maybeContinueNotice(page)
    const persistedRow = page.locator('[role="treeitem"]').filter({ hasText: 'layer workbench export' }).first()
    await persistedRow.waitFor({ timeout: 15_000 })
    await persistedRow.click()
    await page.waitForFunction(id => {
      const current = JSON.parse(localStorage.getItem('dsh.sessions.current') ?? 'null')
      return current?.sessionId === id
    }, sessionId, { timeout: 15_000 })
    await page.locator('[data-composer-input][contenteditable="true"]').waitFor({ timeout: 15_000 })
    await chooseMapPreset(page)

    // The restored map is identical: layers, group, panel, revision, receipt.
    await page.waitForFunction(() => document.querySelectorAll('[data-map-panel-layer]').length === 2, undefined, { timeout: 30_000 })
    const afterReceipt = await waitForRenderedReceipt(page)
    assert.equal(afterReceipt.revision, beforeRevision, 'the restarted projection replays to the same revision')
    const restoredPanel = await page.locator('[data-map-panel]').first().textContent()
    assert.match(restoredPanel ?? '', /医院/)
    assert.match(restoredPanel ?? '', /道路/)
    await page.waitForFunction(() => {
      const groups = [...document.querySelectorAll('[data-map-panel-group]')]
      return groups.some(group => group.getAttribute('aria-label') === '基准' && (group.textContent ?? '').includes('2 层'))
    }, undefined, { timeout: 15_000 })

    // The artifact route keeps serving the pre-restart publications.
    const routed = await page.evaluate(async ({ session, ref }) => {
      const answer = await fetch(`/api/map/artifact?session=${encodeURIComponent(session)}&ref=${encodeURIComponent(ref)}`)
      return { status: answer.status, bytes: new Uint8Array(await answer.arrayBuffer()).byteLength }
    }, { session: sessionId, ref: artifactRefs[0] })
    assert.equal(routed.status, 200)
    assert.ok(routed.bytes > 0, 'the artifact route serves after the restart')

    // One post-restart model round reads the state and confirms it.
    await sendMessage(page, '重启后确认地图状态一致。')
    await page.getByText('重启后状态一致。', { exact: true }).waitFor({ timeout: 90_000 })
    const stateTranscript = transcripts.at(-1)
    assert.match(stateTranscript, /hospitals/)
    assert.match(stateTranscript, /roads/)
    const flatState = stateTranscript.replaceAll('\\', '')
    assert.ok(flatState.includes(`"revision":${beforeRevision}`), 'the post-restart state names the same revision')

    const failures = second.stderr.value.split('\n').filter(line => /Error|error|failed|warn/.test(line)
      && !/key|token|secret|password|authorization/i.test(line)
      && !/did not activate|trace-warnings/.test(line)).slice(-6)
    assert.deepEqual(failures, [])
  } finally {
    await new Promise(resolveClose => provider.close(resolveClose))
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined && app.pid !== undefined) {
      try { process.kill(-app.pid, 'SIGTERM') } catch { /* the app already exited */ }
    }
    rmSync(temp, { recursive: true, force: true })
  }
})

test('layer workbench: POI search becomes a layer and service failures report honestly', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-lw-poi-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# poi composition\n')

  const { startPoiFixtureServer } = await import('./fixtures/layer-workbench/poi-fixture-server.mjs')
  const fixture = await startPoiFixtureServer({ mode: 'page-1' })

  let scriptStep = 0
  const transcripts = []
  let mainRequests = 0
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isTitleRequest(parsed)) {
        response.end(textResponse('layer workbench poi'))
        return
      }
      mainRequests += 1
      const fullTranscript = JSON.stringify(parsed.messages ?? [])
      transcripts.push(fullTranscript)
      scriptStep += 1
      const step = scriptStep
      if (step === 1) {
        response.end(toolResponse([
          { id: 'lw4-register', name: 'catalog_register', input: { online: { kind: 'search', query: '医院', bbox: [116, 39, 117, 40], limit: 3, offset: 0 }, name: 'poi-医院' } },
        ]))
      } else if (step === 2) {
        const ref = [...fullTranscript.matchAll(/res-[a-f0-9]{24}@v1/g)].map(match => match[0]).at(-1)
        assert.ok(ref, 'the online registration published a resource')
        response.end(toolResponse([
          { id: 'lw4-add', name: 'map_add_layer', input: { ref, layer_id: 'poi', name: '医院点位' } },
          { id: 'lw4-view', name: 'map_set_view', input: { center: [116.4, 39.91], zoom: 12, wkid: 4326 } },
        ]))
      } else if (step === 3) {
        const ref = [...fullTranscript.matchAll(/res-[a-f0-9]{24}@v1/g)].map(match => match[0]).at(-1)
        response.end(toolResponse([
          { id: 'lw4-density', name: 'viz_aggregate', input: { resource_ref: ref, layer_id: 'poi-density', layer_name: '医院密度', cell_size: 0.01, unit: '家' } },
        ]))
      } else if (step === 4) {
        response.end(textResponse('检索成图完成。'))
      } else if (step === 5) {
        const nextOffset = [...fullTranscript.matchAll(/next_offset\\?":(\d+)/g)].map(match => Number(match[1])).at(-1) ?? 2
        response.end(toolResponse([
          { id: 'lw4-page2', name: 'catalog_register', input: { online: { kind: 'search', query: '医院', bbox: [116, 39, 117, 40], limit: 2, offset: nextOffset }, name: 'poi-医院' } },
        ]))
      } else if (step === 6) {
        const v2 = [...fullTranscript.matchAll(/res-[a-f0-9]{24}@v2/g)].map(match => match[0]).at(-1)
        assert.ok(v2, 'the second page publishes the next version of the same resource name')
        response.end(textResponse('第二页入库，同名资源版本递增。'))
      } else if (step === 7) {
        response.end(toolResponse([
          { id: 'lw4-denied', name: 'catalog_register', input: { online: { kind: 'search', query: '药店', bbox: [116, 39, 117, 40] }, name: 'poi-药店' } },
        ]))
      } else {
        assert.match(transcripts.at(-1), /SEARCH_RATE_LIMITED/, 'the rate-limited refusal is model-visible')
        response.end(textResponse('检索服务限流，本次失败，未生成图层。'))
      }
    })
  })

  let app
  let browser
  let page
  try {
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const searchPatch = join(temp, 'search.patch.yml')
    writeFileSync(searchPatch, `- id: spatial-connect\n  config:\n    tianditu:\n      apiKeyEnv: COMPOSITION_SEARCH_KEY\n      baseUrl: http://127.0.0.1:${fixture.port}\n`)
    const stdout = { value: '' }
    const stderr = { value: '' }
    app = spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--patch', searchPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        COMPOSITION_SEARCH_KEY: 'layer-workbench-fixture-key',
        DEEPSEEK_API_KEY: 'lw-poi-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)

    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({ locale: 'zh-CN' })
    page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useFixtureBasemap(page)

    // M1: the fixture-backed search registers, loads, and aggregates.
    await sendMessage(page, '检索北京范围内的医院，登记并显示在地图上，再做网格密度。')
    await page.getByText('检索成图完成。', { exact: true }).waitFor({ timeout: 90_000 })
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-map-panel-layer]')]
      return rows.length === 2 && rows.some(row => (row.textContent ?? '').includes('医院点位'))
        && rows.some(row => (row.textContent ?? '').includes('医院密度'))
    }, undefined, { timeout: 30_000 })
    const receipt = await waitForRenderedReceipt(page)
    assert.equal(receipt.failedLayers.length, 0)
    assert.ok(fixture.requests.length >= 1, 'the fixture search service actually received the query')
    assert.ok(fixture.requests.every(request => request.url.includes('tk=')), 'the fixture sees the configured key')

    // M2: the next page publishes the next version of the same name.
    fixture.setMode('page-2')
    await sendMessage(page, '继续拉取第二页。')
    await page.getByText('第二页入库，同名资源版本递增。', { exact: true }).waitFor({ timeout: 90_000 })
    const pageTranscript = transcripts.at(-1)
    assert.match(pageTranscript, /res-[a-f0-9]{24}@v2/, 'the versioned second page is model-visible')
    assert.equal(fixture.requests.length >= 2, true)

    // M3: the rate-limited service refuses honestly — no silent empty layer.
    fixture.setMode('rate-limited')
    await sendMessage(page, '再检索药店。')
    await page.getByText('检索服务限流，本次失败，未生成图层。', { exact: true }).waitFor({ timeout: 90_000 })
    const deniedTranscript = transcripts.at(-1)
    assert.match(deniedTranscript, /SEARCH_RATE_LIMITED/, 'the refusal carries the stable search error code')
    assert.equal((await page.locator('[data-map-panel-layer]').count()), 2, 'the refused search adds no layer')

    const failures = stderr.value.split('\n').filter(line => /Error|error|failed|warn/.test(line)
      && !/key|token|secret|password|authorization/i.test(line)
      && !/did not activate|trace-warnings/.test(line)).slice(-6)
    assert.deepEqual(failures, [])
  } finally {
    await new Promise(resolveClose => provider.close(resolveClose))
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined && app.pid !== undefined) {
      try { process.kill(-app.pid, 'SIGTERM') } catch { /* the app already exited */ }
    }
    fixture.server.closeAllConnections()
    await new Promise(resolveClose => fixture.server.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

test('spatial workflow: facility coverage comparison reaches the map, linked table and export', { timeout: 240_000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'map-facility-web-'))
  const workspace = join(temp, 'workspace')
  const home = join(temp, 'home')
  const scenario = join(root, 'snapshots/session/map-facility-decision')
  // The replay must consume the whole recorded conversation, so its floor
  // comes from the fixture itself instead of a hardcoded round count.
  const recordedRounds = new Set(readFileSync(join(scenario, 'session.v4.jsonl'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line))
    .filter(record => record.type === 'assistant/message')
    .map(record => `${record.data.turn}:${record.data.step}`))
  let app
  let browser
  let provider
  t.after(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        if (app) {
          await stopProcessTree(app)
          if (app.exitCode === null && app.signalCode === null) {
            await new Promise((resolveExit, reject) => {
              const timer = setTimeout(() => reject(new Error('facility app did not exit after kill')), 5_000)
              app.once('exit', () => { clearTimeout(timer); resolveExit() })
            })
          }
        }
      } finally {
        if (provider?.listening) await new Promise(resolveClose => provider.close(resolveClose))
        rmSync(temp, { recursive: true, force: true })
      }
    }
  })
  cpSync(join(scenario, 'workspace'), workspace, { recursive: true })
  const fixture = readFileSync(join(scenario, 'session.v4.jsonl'), 'utf8')
  const rows = fixture.trim().split('\n').map(JSON.parse)
  const task = rows.find(row => row.type === 'user/message' && row.data.source.kind === 'user').data.content[0].text
  const live = process.env.MAP_FACILITY_LIVE === '1'
  const env = { ...process.env, MAPHARNESS_HOME: home, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED' }
  let providerFailure
  let requests = 0
  if (!live) {
    const script = deriveReplayScript(parseSessionLog(fixture))
    const overrides = JSON.parse(readFileSync(join(scenario, 'replay.override.json'), 'utf8'))
    for (const patch of overrides.patches) script[patch.at] = patch.entry
    provider = createServer((request, response) => {
      let body = ''
      request.setEncoding('utf8')
      request.on('error', error => { providerFailure = error; response.destroy() })
      request.on('data', chunk => {
        body += chunk
        if (body.length > 4 * 1024 * 1024) request.destroy(new Error('facility request exceeds fixture limit'))
      })
      request.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          if (isTitleRequest(parsed)) { response.end(textResponse('Facility decision')); return }
          const source = script[requests++]
          if (source === undefined) throw new Error('unexpected request after facility script ended')
          const entry = resolveScriptedEntry(source, parsed.messages)
          assert.equal(entry.kind, 'chunks')
          const blocks = entry.chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
          const calls = blocks.filter(block => block.type === 'tool-call')
          if (calls.length > 0) {
            response.end(toolResponse(calls.map(call => ({ id: call.id, name: call.name, input: JSON.parse(call.arguments) }))))
          } else {
            response.end(textResponse('FACILITY_DECISION_COMPLETE\n\n' + blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')))
          }
        } catch (error) {
          providerFailure = error
          response.destroy(error)
        }
      })
    })
    env.DEEPSEEK_API_KEY = 'facility-replay-fixture'
    env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${await listen(provider)}`
  }
  const overlay = join(temp, 'facility.overlay.yml')
  writeFileSync(overlay, [
    '- id: spatial-accessibility', '  config:', `    root: ${JSON.stringify(join(home, 'accessibility-store'))}`, '    provider: controlled-lattice',
    '- id: session-title-llm', '  disabled: true',
    '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-flash',
    '- id: llm-deepseek', "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'", '  config:', '    maxTokens: 8192', '    reasoningEffort: off', '',
  ].join('\n'))
  const stdout = { value: '' }
  const stderr = { value: '' }
  app = spawn(process.execPath, [mapBin, '--patch', pickerPatch, '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  })
  app.stdout.setEncoding('utf8')
  app.stderr.setEncoding('utf8')
  app.stdout.on('data', chunk => { stdout.value += chunk })
  app.stderr.on('data', chunk => { stderr.value += chunk })
  const url = await waitForAppUrl(app, stdout, stderr)
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  if (!live) await useFixtureBasemap(page)
  await page.goto(url)
  await maybeContinueNotice(page)
  await connectWorkspace(page, workspace)
  await chooseMapPreset(page)
  await sendMessage(page, task + '\nEnd the final report with a separate paragraph containing only FACILITY_DECISION_COMPLETE.')
  await page.getByText('FACILITY_DECISION_COMPLETE', { exact: true }).last().waitFor({ timeout: 120_000 })
  if (providerFailure) throw providerFailure
  const report = await page.locator('body').textContent()
  assert.match(report, /150\s*\/\s*350/)
  assert.match(report, /200\s*\/\s*350/)
  await page.waitForFunction(() => {
    const handles = window.__mapHarness
    return handles instanceof Map && [...handles.values()].some(handle => handle.styledLayers?.includes('population'))
  }, undefined, { timeout: 30_000 })
  const workbench = page.locator('[data-map-workbench]').first()
  await workbench.waitFor({ timeout: 30_000 })
  assert.match(await workbench.textContent(), /people/)
  const table = workbench.locator('[data-workbench-table]')
  assert.match(await table.textContent(), /100/)
  assert.match(await table.textContent(), /200/)
  const bars = workbench.locator('[data-workbench-chart] button')
  assert.ok(await bars.count() >= 3)
  await bars.first().click()
  await page.waitForFunction(() => [...window.__mapHarness.values()].some(handle => handle.highlightCount === 1), undefined, { timeout: 15_000 })
  await workbench.getByRole('button', { name: /导出当前视图|Export current view/ }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('[data-workbench-export-status]')].some(node => node.textContent?.trim()), undefined, { timeout: 15_000 })
  await page.reload()
  await page.waitForFunction(() => {
    const handles = window.__mapHarness
    return handles instanceof Map && [...handles.values()].some(handle => handle.styledLayers?.includes('population'))
  }, undefined, { timeout: 30_000 })
  const receipt = await waitForRenderedReceipt(page)
  assert.equal(receipt.renderedRevision, receipt.revision)
  await page.waitForFunction(() => [...window.__mapHarness.values()].some(handle => handle.center?.[0] === 116.01 && handle.center?.[1] === 39.5), undefined, { timeout: 15_000 })
  const mapUi = await page.evaluate(() => {
    const action = document.querySelector('[data-map-session-action]')
    const maps = [...document.querySelectorAll('[data-map-container]')]
    const handles = [...window.__mapHarness.values()]
    const tabs = [...document.querySelectorAll('[role="tab"]')]
    return {
      conversationViews: tabs.filter(tab => !tab.closest('[data-sidebar-right-panel]')).map(tab => tab.textContent.trim()),
      mapAction: action?.getAttribute('aria-label'),
      mapTabs: tabs.filter(tab => tab.closest('[data-sidebar-right-panel]') && tab.textContent.includes('地图')).length,
      mapCanvases: maps.length,
      mapEngines: handles.length,
      boundToConversation: maps.every(map => map.getAttribute('data-map-session') === action?.getAttribute('data-map-session-action'))
        && handles.every(handle => handle.renderReceipt.sessionId === action?.getAttribute('data-map-session-action')),
    }
  })
  assert.deepEqual(mapUi, JSON.parse(readFileSync(new URL('./expected/session-map.json', import.meta.url), 'utf8')))
  if (process.env.MAP_FACILITY_ARTIFACTS) {
    mkdirSync(process.env.MAP_FACILITY_ARTIFACTS, { recursive: true })
    await page.screenshot({ path: join(process.env.MAP_FACILITY_ARTIFACTS, live ? 'facility-live.png' : 'facility-replay.png'), fullPage: true })
  }
  assert.equal(providerFailure, undefined)
  if (!live) assert.ok(requests >= recordedRounds.size, `the replay consumed every recorded round (${requests} < ${recordedRounds.size})`)
  t.diagnostic(`facility GUI ${live ? 'live provider' : 'recorded model replay'}: linked population, selection, export and reload passed`)
})

/** A coarse downsampled RGB grid of the map band: comparable across rounds. */
async function mapBandSignature(page) {
  const bottomEdge = await mapBandOf(page)
  return await countRegionColorGrid(page, '[data-map-container]:not([data-map-view])', { bottomEdge })
}

/**
 * Sample the band as a coarse grid instead of one color count, so two rounds
 * can be compared for "the pixels changed / returned".
 */
async function countRegionColorGrid(page, selector, options = {}) {
  const box = await page.locator(selector).first().boundingBox()
  if (box === null || box.width < 2 || box.height < 2) throw new Error(`no measurable region for ${selector}`)
  const bottom = options.bottomEdge === null ? box.y + box.height : Math.min(options.bottomEdge, box.y + box.height)
  const height = Math.max(1, Math.floor(bottom - box.y))
  const shot = await page.screenshot({ clip: { x: box.x, y: box.y, width: Math.floor(box.width), height } })
  return await page.evaluate(async dataUrl => {
    const blob = await (await fetch(dataUrl)).blob()
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const context = canvas.getContext('2d')
    context.drawImage(bitmap, 0, 0)
    const columns = 48
    const rows = 32
    const cell = context.getImageData(0, 0, bitmap.width, bitmap.height)
    const grid = []
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x = Math.floor(((column + 0.5) / columns) * bitmap.width)
        const y = Math.floor(((row + 0.5) / rows) * bitmap.height)
        const at = (y * bitmap.width + x) * 4
        grid.push([cell.data[at], cell.data[at + 1], cell.data[at + 2]])
      }
    }
    return grid
  }, `data:image/png;base64,${shot.toString('base64')}`)
}

/** The fraction of grid cells whose color moved beyond one channel slack. */
function gridDifference(left, right, slack = 8) {
  if (left.length !== right.length) throw new Error('grid size mismatch')
  let moved = 0
  for (let at = 0; at < left.length; at += 1) {
    if (Math.abs(left[at][0] - right[at][0]) > slack
      || Math.abs(left[at][1] - right[at][1]) > slack
      || Math.abs(left[at][2] - right[at][2]) > slack) moved += 1
  }
  return moved / left.length
}

/** Poll a local condition with a deadline, failing loud with the reason. */
async function waitForValue(read, timeout, reason) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (read() === true) return true
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert.fail(reason)
}

/** Wait until the map tab's receipt attests one exact rendered revision. */
/** Catch-up variant: the fast undo tail may skip intermediate rendered revisions. */
async function waitReceiptRevisionAtLeast(page, revision) {
  await page.waitForFunction(rev => {
    const harness = window.__mapHarness
    if (!(harness instanceof Map)) return false
    const sessionId = document.querySelector('[data-map-session-action]')?.getAttribute('data-map-session-action')
    const receipt = [...harness.values()].find(value => value.renderReceipt.sessionId === sessionId)?.renderReceipt
    return receipt?.status === 'rendered' && receipt.failedLayers.length === 0
      && receipt.revision >= rev && receipt.renderedRevision === receipt.revision && typeof receipt.viewId === 'string'
  }, revision, { timeout: 30_000 })
  return await readMapTabReceipt(page)
}

async function waitReceiptRevision(page, revision) {
  await page.waitForFunction(rev => {
    const harness = window.__mapHarness
    if (!(harness instanceof Map)) return false
    const sessionId = document.querySelector('[data-map-session-action]')?.getAttribute('data-map-session-action')
    const receipt = [...harness.values()].find(value => value.renderReceipt.sessionId === sessionId)?.renderReceipt
    return receipt?.status === 'rendered' && receipt.failedLayers.length === 0
      && receipt.revision === rev && receipt.renderedRevision === rev && typeof receipt.viewId === 'string'
  }, revision, { timeout: 30_000 })
  return await readMapTabReceipt(page)
}

test('spatial workflow: locate, draw, fit and the study AOI travel the real map profile with honest receipts', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-actions-composition-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })

  const gates = new Map()
  const waitForGate = name => {
    const existing = gates.get(name)
    if (existing?.opened === true) return Promise.resolve()
    return new Promise(resolve => { gates.set(name, { opened: false, resolve }) })
  }
  const openGate = name => {
    const gate = gates.get(name)
    if (gate === undefined) {
      gates.set(name, { opened: true, resolve: undefined })
      return
    }
    gate.opened = true
    gate.resolve?.()
    gate.resolve = undefined
  }
  let mainRequests = 0
  let sawConflict = null
  const stdout = { value: '' }
  const stderr = { value: '' }
  const provider = createServer((request, response) => {
    if (request.url.startsWith('/geocoder?')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: '0', location: { lon: 116.397455, lat: 39.908722 } }))
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isTitleRequest(parsed)) {
        response.end(textResponse('map actions'))
        return
      }
      mainRequests += 1
      if (mainRequests === 2) await waitForGate('framed')
      if (mainRequests === 3) await waitForGate('drawn')
      if (mainRequests === 5) await waitForGate('aoi')
      if (mainRequests === 1) {
        // Resolve the place by provider, then frame the study extent before
        // any layer exists: the framed basemap is the pixel baseline.
        response.end(toolResponse([
          { id: 'actions-locate', name: 'map_locate', input: { query: '北京市天安门' } },
          { id: 'actions-fit', name: 'map_fit_view', input: { bbox: [116.1, 39.8, 116.4, 40.0] } },
        ]))
      } else if (mainRequests === 2) {
        response.end(toolResponse([
          { id: 'actions-draw', name: 'map_draw', input: { kind: 'polygon', coordinates: [[116.1, 39.8], [116.4, 39.8], [116.4, 40.0], [116.1, 40.0]], layer_id: 'study-site', name: '研究区' } },
        ]))
      } else if (mainRequests === 3) {
        // A stale expected_revision must conflict with the current revision
        // and fold nothing — the honest refusal, not a silent overwrite.
        response.end(toolResponse([
          { id: 'actions-stale', name: 'map_apply_patch', input: { patch: [{ kind: 'set-aoi', aoi: { ring: [[116.3, 39.85], [116.5, 39.85], [116.5, 39.95], [116.3, 39.95]] } }], expected_revision: 0 } },
        ]))
      } else if (mainRequests === 4) {
        sawConflict = JSON.stringify(parsed.messages).includes('"status":"conflict"') || JSON.stringify(parsed.messages).includes('status\\":\\"conflict')
        response.end(toolResponse([
          { id: 'actions-aoi', name: 'map_apply_patch', input: { patch: [{ kind: 'set-aoi', aoi: { name: '核心区', ring: [[116.3, 39.85], [116.5, 39.85], [116.5, 39.95], [116.3, 39.95]] } }], expected_revision: 2, operation_id: 'workflow-aoi' } },
        ]))
      } else if (mainRequests === 5) {
        response.end(toolResponse([
          { id: 'actions-remove', name: 'map_remove_layer', input: { layer_id: 'study-site' } },
        ]))
      } else {
        response.end(textResponse('map actions complete'))
      }
    })
  })

  let app
  let browser
  let page
  try {
    const providerPort = await listen(provider)
    const searchPatch = join(temp, 'search.patch.yml')
    writeFileSync(searchPatch, `- id: spatial-connect\n  config:\n    tianditu:\n      apiKeyEnv: COMPOSITION_SEARCH_KEY\n      baseUrl: http://127.0.0.1:${String(providerPort)}\n`)
    const appPort = await freePort()
    app = spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--patch', searchPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        COMPOSITION_SEARCH_KEY: 'composition-search-key',
        DEEPSEEK_API_KEY: 'map-actions-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)

    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({ locale: 'zh-CN' })
    page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)

    // Negative (no client): before the first message materializes a map
    // occurrence, no handle exists at all — nothing publishes a receipt for a
    // session whose map nobody renders.
    const noClient = await page.evaluate(() => (globalThis).__mapHarness === undefined)
    assert.equal(noClient, true, 'a session without a mounted map occurrence must not publish any render receipt')

    await sendMessage(page, '请定位天安门，把地图适配到研究范围，再绘制研究区多边形并标记核心区。')

    const mapBand = page.locator('[data-map-container]:not([data-map-view])')
    await mapBand.waitFor({ state: 'visible', timeout: 30_000 })
    // Round 1 folded the fitted view: the camera itself must sit on the
    // documented derivation (center at the bbox midpoint, integer zoom 11).
    const fitted = await waitReceiptRevision(page, 1)
    await waitForMapCamera(page, fitted.sessionId, [116.25, 39.9], 11)
    const baseline = await mapBandSignature(page)
    openGate('framed')

    // Round 2 folded the drawn polygon: the receipt must attest the render,
    // and the band's pixels must move — the default polygon symbol paints the
    // fitted extent, covering most of the viewport.
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.layerCount === 1)
    }, undefined, { timeout: 30_000 })
    const drawn = await waitReceiptRevision(page, 2)
    const painted = await mapBandSignature(page)
    const covered = gridDifference(baseline, painted)
    assert.ok(covered >= 0.25, `the drawn polygon must repaint the fitted band (changed ${Math.round(covered * 100)}%)`)
    openGate('drawn')

    // Round 3 conflicted on the stale revision: the machine-readable refusal
    // reaches the next turn's transcript — the fold-free behavior is owned by
    // the unit workflow suite; here the refusal itself must be observable.
    assert.equal(await waitForValue(() => sawConflict === true, 30_000, 'the stale patch never reached the next turn'), true)

    // Round 4 folded the valid AOI patch: the SAME concrete view attests the
    // new revision — the stale r2 receipt is replaced, never extended.
    const withAoi = await waitReceiptRevision(page, 3)
    assert.equal(withAoi.viewId, drawn.viewId, 'the same view attests the new revision; the old receipt is replaced')
    assert.equal(sawConflict, true, 'the stale patch returned a machine-readable conflict to the model')
    openGate('aoi')

    // Round 5 removed the layer: the paint leaves with it, which proves the
    // counted pixels were the drawn polygon, not the background.
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.layerCount === 0)
    }, undefined, { timeout: 30_000 })
    const cleared = await waitReceiptRevision(page, 4)
    assert.equal(cleared.viewId, drawn.viewId)
    const reverted = await mapBandSignature(page)
    const returned = gridDifference(baseline, reverted)
    assert.ok(returned <= 0.05, `removing the layer must return the band to the basemap (residual ${Math.round(returned * 100)}%)`)

    // The profile's spatial-accessibility entry refuses to activate without
    // its credential (loud-refusal by design); that one pre-existing warning
    // line is tolerated — anything new about THIS workflow's tools is not.
    const failures = stderr.value.split('\n').filter(line => /Error|error|failed|warn/.test(line)
      && !/key|token|secret|password|authorization/i.test(line)
      && !/did not activate|trace-warnings/.test(line)).slice(-6)
    assert.deepEqual(failures, [])
    assert.equal(sawConflict, true)
  } finally {
    // A failed assertion must not strand the provider's gated handlers: open
    // every gate so pending responses settle and the server can close.
    for (const name of [...gates.keys()]) openGate(name)
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined) await stopProcessTree(app)
    provider.closeAllConnections()
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

test('spatial workflow: layer management threads rename, hide, reorder, restyle, save and undo through the real profile', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-layerviz-composition-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  // Two polygons a class apart plus a drawn core mark: the classified band is
  // the pixel oracle; the drawn mark exercises presentational updates.
  const parcels = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 'dark-parcel',
        geometry: { type: 'Polygon', coordinates: [[[115.6, 39.6], [116.4, 39.6], [116.4, 40.4], [115.6, 40.4], [115.6, 39.6]]] },
        properties: { score: 26 },
      },
      {
        type: 'Feature',
        id: 'light-parcel',
        geometry: { type: 'Polygon', coordinates: [[[116.6, 39.6], [117.4, 39.6], [117.4, 40.4], [116.6, 40.4], [116.6, 39.6]]] },
        properties: { score: 2 },
      },
    ],
  }
  writeFileSync(join(workspace, 'parcels.geojson'), JSON.stringify(parcels))

  const gates = new Map()
  const waitForGate = name => {
    const existing = gates.get(name)
    if (existing?.opened === true) return Promise.resolve()
    return new Promise(resolve => { gates.set(name, { opened: false, resolve }) })
  }
  const openGate = name => {
    const gate = gates.get(name)
    if (gate === undefined) {
      gates.set(name, { opened: true, resolve: undefined })
      return
    }
    gate.opened = true
    gate.resolve?.()
    gate.resolve = undefined
  }
  let mainRequests = 0
  const transcript = []
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isTitleRequest(parsed)) {
        response.end(textResponse('map layer management'))
        return
      }
      mainRequests += 1
      transcript.push(JSON.stringify(parsed.messages ?? []).slice(-6000))
      if (mainRequests === 3) await waitForGate('seeded')
      if (mainRequests === 4) await waitForGate('styled')
      if (mainRequests === 5) await waitForGate('saved')
      if (mainRequests === 1) {
        response.end(toolResponse([
          { id: 'lv-register', name: 'catalog_register', input: { path: 'parcels.geojson', name: 'parcels' } },
        ]))
      } else if (mainRequests === 2) {
        const resourceRef = fromTranscriptOf(parsed, 'res-[a-f0-9]{24}@v1')
        response.end(toolResponse([
          { id: 'lv-add', name: 'map_add_layer', input: { ref: resourceRef, layer_id: 'zones' } },
          { id: 'lv-draw', name: 'map_draw', input: { kind: 'polygon', coordinates: [[116.45, 39.7], [116.55, 39.7], [116.55, 40.3], [116.45, 40.3]], layer_id: 'core', name: '核心区' } },
        ]))
      } else if (mainRequests === 3) {
        response.end(toolResponse([
          { id: 'lv-fit', name: 'map_fit_view', input: { layer_id: 'zones' } },
          { id: 'lv-classify', name: 'viz_classify', input: { layer_id: 'zones', field: 'score', unit: '分', classification: 'equal-interval', class_count: 3 } },
        ]))
      } else if (mainRequests === 4) {
        // The rename and reorder stay one atomic patch (two deltas, one
        // revision); visibility is the fine-grained channel's own operation.
        response.end(toolResponse([
          { id: 'lv-patch', name: 'map_apply_patch', input: {
            patch: [
              { kind: 'update-layer', layerId: 'zones', name: '研究区地块' },
              { kind: 'reorder-layers', layerIds: ['core', 'zones'] },
            ],
            expected_revision: 4,
            operation_id: 'lv-manage',
          } },
        ]))
      } else if (mainRequests === 5) {
        // The hide rides the set-layer-state channel: its own revision,
        // independently undoable.
        response.end(toolResponse([
          { id: 'lv-hide', name: 'layer_set_state', input: { states: [{ layer_id: 'core', visible: false }] } },
        ]))
      } else if (mainRequests === 6) {
        response.end(toolResponse([
          { id: 'lv-save', name: 'map_save', input: { map_revision: 6 } },
          { id: 'lv-state', name: 'map_get_state', input: {} },
        ]))
      } else if (mainRequests === 7) {
        response.end(toolResponse([
          { id: 'lv-undo', name: 'map_undo', input: {} },
        ]))
      } else if (mainRequests === 8) {
        response.end(toolResponse([
          { id: 'lv-state2', name: 'map_get_state', input: {} },
        ]))
      } else {
        response.end(textResponse('layer management complete'))
      }
    })
  })

  let app
  let browser
  let page
  try {
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const stdout = { value: '' }
    const stderr = { value: '' }
    app = spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: home,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'map-layerviz-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)

    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({ locale: 'zh-CN' })
    page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await sendMessage(page, '请登记 parcels.geojson 加载为 zones 图层，绘制核心区，按 score 分级，然后重命名、隐藏核心区并保存导出。')

    const mapBand = page.locator('[data-map-container]:not([data-map-view])')
    await mapBand.waitFor({ state: 'visible', timeout: 30_000 })
    // Rounds 1–2 folded: both layers landed.
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.layerCount === 2)
    }, undefined, { timeout: 30_000 })
    openGate('seeded')

    // Round 3 folded the fit + classification: legend, pixels, and the same
    // style version across layer, legend, and workbench.
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => (value.styledLayers ?? []).includes('zones'))
    }, undefined, { timeout: 30_000 })
    const workbench = page.locator('[data-map-workbench]').first()
    await workbench.waitFor({ timeout: 30_000 })
    await page.locator('[data-workbench-legend] li').first().waitFor({ timeout: 30_000 })
    const classColor = await darkestLegendColor(page, 3)
    const painted = await waitForMapColor(page, classColor, 'present', { tolerance: 30, present: 5_000 })
    assert.ok(painted.count >= 5_000, `the styled parcels must paint the map band (${painted.count} px)`)
    const receiptStyled = await waitReceiptRevision(page, 4)
    assert.equal(receiptStyled.renderedRevision, receiptStyled.revision)
    const firstSession = receiptStyled.sessionId
    // The workbench export pins the same style version the map painted.
    const table = workbench.locator('[data-workbench-table]')
    assert.match(await table.textContent(), /26|2/)
    await workbench.getByRole('button', { name: /导出当前视图|Export current view/ }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('[data-workbench-export-status]')].some(node => (node.textContent ?? '').trim().length > 0), undefined, { timeout: 15_000 })
    openGate('styled')

    // Round 4 folded the atomic management patch (rename + reorder); round 5
    // folded the set-layer-state hide: the renamed layer keeps its id and
    // paint through both.
    await waitReceiptRevisionAtLeast(page, 4)
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => (value.styledLayers ?? []).includes('zones'))
    }, undefined, { timeout: 30_000 })
    const paintedAfter = await waitForMapColor(page, classColor, 'present', { tolerance: 30, present: 5_000 })
    assert.ok(paintedAfter.count >= 5_000, 'a rename keeps the classified paint')
    openGate('saved')
    await waitReceiptRevisionAtLeast(page, 5)

    // Round 6 returned the pinned save + state; round 7 undid the hide —
    // one operation per undo, so the rename (an earlier patch) persists.
    await waitForValue(() => transcript.length >= 7, 30_000, 'the save round never ran')
    assert.match(transcript[6], /研究区地块/, 'the state round sees the renamed layer')
    assert.match(transcript[6], /\\?"visible\\?":false/, 'the state round sees the hidden core')
    assert.match(transcript[6], /\\?"revision\\?":6/, 'the saved state pinned revision 6')
    await waitReceiptRevisionAtLeast(page, 6)

    // The undo compensated the set-layer-state hide; the final state round
    // attests the restored visibility and the surviving rename, with the
    // ledger naming the compensated operation.
    await waitForValue(() => transcript.length >= 9, 30_000, 'the final state round never ran')
    const state2At = transcript[8].lastIndexOf('lv-state2')
    const finalState = transcript[8].slice(state2At)
    assert.ok(state2At >= 0, 'the final state result is present')
    assert.match(finalState, /研究区地块/, 'the rename persists: its patch is an earlier operation this undo does not touch')
    assert.doesNotMatch(finalState, /\\?"visible\\?":false/, 'undo restored the core layer visibility')
    assert.match(finalState, /undo_of/, 'the ledger names the compensated operation')

    // Session isolation: a second conversation owns an empty map while the
    // first keeps its layers.
    await page.locator('[data-row-key^="workspace:"]').filter({ hasText: 'workspace' }).first().hover()
    await page.getByRole('button', { name: '在“workspace”中新建会话', exact: true }).click()
    await page.getByText('探索未至之境', { exact: true }).waitFor()
    await chooseMapPreset(page)
    await sendMessage(page, '只看地图，不加载数据。')
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      if (!(harness instanceof Map)) return false
      const values = [...harness.values()]
      return values.length === 2 && values.some(value => value.layerCount === 0) && values.some(value => value.layerCount === 2)
    }, undefined, { timeout: 60_000 })

    // Reconnect: reload the app and the first session's final state returns.
    await page.locator(`[data-row-key="session:${firstSession}"]`).click()
    await page.reload()
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.layerCount === 2 && (value.styledLayers ?? []).includes('zones'))
    }, undefined, { timeout: 60_000 })
    const finalReceipt = await waitForRenderedReceipt(page)
    assert.equal(finalReceipt.renderedRevision, finalReceipt.revision)

    const failures = stderr.value.split('\n').filter(line => /Error|error|failed|warn/.test(line)
      && !/key|token|secret|password|authorization/i.test(line)
      && !/did not activate|trace-warnings/.test(line)).slice(-6)
    assert.deepEqual(failures, [])
  } finally {
    for (const name of [...gates.keys()]) openGate(name)
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined) await stopProcessTree(app)
    provider.closeAllConnections()
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

test('symbology: semantic symbols render with collision-free layer-colored labels and a feature hover opens the attribute card', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-symbology-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  // Eight named points: three crowd one spot (only some labels may fit), the
  // rest spread out so their labels must all place.
  const points = [
    ['示例第一医院', 116.39, 39.90], ['示例第二医院', 116.3905, 39.9003], ['示例第三医院', 116.391, 39.8998],
    ['Central Library', 116.42, 39.92], ['东城体育馆', 116.36, 39.93], ['West Station', 116.35, 39.89],
    ['南苑公园', 116.41, 39.88], ['North Clinic', 116.44, 39.94],
  ]
  const pois = {
    type: 'FeatureCollection',
    features: points.map(([name, lon, lat], at) => ({
      type: 'Feature', id: `poi-${String(at)}`, geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { name, beds: 100 + at, grade: at % 2 === 0 ? '三甲' : '二甲' },
    })),
  }
  writeFileSync(join(workspace, 'pois.geojson'), JSON.stringify(pois))
  const { symbolVersionOf } = await import('../../layers/src/index.ts')
  const facilitySymbol = { methodVersion: 'map-layers@1', presentation: 'single', semantic: 'facility', label: { field: 'name' } }

  let mainRequests = 0
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isTitleRequest(parsed)) {
        response.end(textResponse('symbology'))
        return
      }
      mainRequests += 1
      if (mainRequests === 1) {
        response.end(toolResponse([
          { id: 'sym-register', name: 'catalog_register', input: { path: 'pois.geojson', name: 'pois' } },
          { id: 'sym-view', name: 'map_set_view', input: { center: [116.4, 39.91], zoom: 12, wkid: 4326 } },
        ]))
      } else if (mainRequests === 2) {
        const resourceRef = fromTranscriptOf(parsed, 'res-[a-f0-9]{24}@v1')
        response.end(toolResponse([{ id: 'sym-add', name: 'map_add_layer', input: { ref: resourceRef, layer_id: 'pois', name: '设施' } }]))
      } else if (mainRequests === 3) {
        response.end(toolResponse([{
          id: 'sym-style', name: 'layer_set_style',
          input: { layer_id: 'pois', symbol: { ...facilitySymbol, symbolVersion: symbolVersionOf(facilitySymbol) } },
        }]))
      } else {
        response.end(textResponse('符号已设置。'))
      }
    })
  })

  let app
  let browser
  try {
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const stdout = { value: '' }
    const stderr = { value: '' }
    app = spawn(process.execPath, [mapBin, '--patch', pickerPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open'], {
      cwd: workspace,
      env: {
        ...process.env, MAPHARNESS_HOME: home, DSH_HOME: home,
        DEEPSEEK_API_KEY: 'symbology-composition-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)
    browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
    const page = await (await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 960 } })).newPage()
    await useFixtureBasemap(page)
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await sendMessage(page, '登记 pois.geojson，加载为设施图层，用设施语义符号并按名称标注。')

    try {
      await page.waitForFunction(() => [...(window.__mapHarness ?? new Map()).values()]
        .some(value => value.layerCount === 1 && value.renderReceipt.status === 'rendered' && value.labelCount > 0), undefined, { timeout: 60_000 })
    } catch (error) {
      const seen = await page.evaluate(() => [...(window.__mapHarness ?? new Map()).entries()].map(([key, value]) => ({
        key, layers: value.layerCount, status: value.renderReceipt.status, labels: value.labelCount, failed: value.renderReceipt.failedLayers,
      })))
      throw new Error(`labels never placed: ${JSON.stringify(seen)} requests=${String(mainRequests)} stderr=${stderr.value.slice(-800)}`, { cause: error })
    }
    // Wait for the styled revision (semantic symbol folded) to render.
    await page.waitForFunction(() => [...(window.__mapHarness ?? new Map()).values()]
      .some(value => value.renderReceipt.status === 'rendered'
        && value.renderReceipt.layerVersions.some(layer => layer.id === 'pois' && /\|sym-[^|]+\|/.test(layer.token) && value.labelCount > 0)), undefined, { timeout: 60_000 })
    const labelCount = await page.evaluate(() => Math.max(...[...window.__mapHarness.values()].map(value => value.labelCount)))
    assert.ok(labelCount >= 6 && labelCount <= points.length, `spread labels place, the crowded trio may drop some (${labelCount})`)

    // The facility semantic paints its hue (#e55e5e) on the canvas.
    const painted = await waitForMapColor(page, [0xe5, 0x5e, 0x5e], 'present', { tolerance: 24, present: 20 })
    assert.ok(painted.count >= 20, `facility markers paint their semantic hue (${painted.count} px)`)

    const band = page.locator('[data-map-container]:not([data-map-view])')
    const box = await band.boundingBox()
    const specDir = join(root, '.spec', 'specs', '2026-10-21_add-map-result-linkage')
    mkdirSync(specDir, { recursive: true })
    writeFileSync(join(specDir, 'evidence-labels.png'), await page.screenshot({ clip: box }))
    const labelStyle = await page.evaluate(() => {
      const item = document.querySelector('[data-map-labels] > div')
      if (item === null) return null
      const style = getComputedStyle(item)
      return { font: style.fontFamily, size: style.fontSize, color: style.color, pointer: getComputedStyle(item.parentElement).pointerEvents }
    })
    assert.ok(labelStyle !== null, 'labels draw as HTML text over the map')
    assert.match(labelStyle.font, /Microsoft YaHei/)
    assert.equal(labelStyle.size, '10.5px')
    assert.equal(labelStyle.color, 'rgb(183, 75, 75)', 'labels wear the facility hue darkened 20%')
    assert.equal(labelStyle.pointer, 'none', 'the overlay never intercepts hover')

    // Hover the isolated North Clinic marker: the attribute card lists its fields.
    const target = await page.evaluate(([lon, lat]) => {
      const container = document.querySelector('[data-map-container]:not([data-map-view])')
      const rect = container.getBoundingClientRect()
      return { rect: { x: rect.x, y: rect.y }, lon, lat }
    }, [116.44, 39.94])
    const screen = await page.evaluate(({ lon, lat }) => {
      for (const value of window.__mapHarness.values()) {
        const projected = value.labelCount > 0 ? value.screenOf(lon, lat) : null
        if (projected !== null) return projected
      }
      return null
    }, target)
    assert.ok(screen !== null, 'the diagnostic view handle projects the target')
    await page.mouse.move(target.rect.x + screen.x, target.rect.y + screen.y)
    const card = page.locator('[data-map-feature-card]')
    await card.waitFor({ state: 'visible', timeout: 30_000 })
    const cardBox = await card.boundingBox()
    const viewport = page.viewportSize()
    assert.ok(cardBox !== null && cardBox.y >= 0 && cardBox.y + cardBox.height <= viewport.height
      && cardBox.x >= box.x && cardBox.x + cardBox.width <= box.x + box.width, `the card sits inside the visible map (${JSON.stringify(cardBox)})`)
    const cardText = await card.innerText()
    assert.match(cardText, /North Clinic/)
    assert.match(cardText, /beds/)
    assert.match(cardText, /107/)
    assert.match(cardText, /grade/)
    assert.doesNotMatch(cardText, /__fid/, 'the internal feature id stays hidden')
    writeFileSync(join(specDir, 'evidence-popup.png'), await page.screenshot({ fullPage: true }))
  } finally {
    if (browser) await browser.close()
    if (app) await stopProcessTree(app)
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})
