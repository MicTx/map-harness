import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../../apps/web/node_modules/playwright/index.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const mapBin = join(root, 'map', 'bin', 'map-harness.mjs')
const pickerPatch = join(root, 'apps', 'web', 'tests', 'pin-browse-picker.overlay.yml')
const requiredMapTools = [
  'map_add_layer',
  'map_apply_patch',
  'map_get_state',
  'map_remove_layer',
  'map_set_mode',
  'map_set_view',
  'map_undo',
]
const requiredGeoTools = [
  'geo_area',
  'geo_buffer',
  'geo_distance',
  'geo_intersect',
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
      assert.fail(`map band ${expected} check for rgb(${rgb.join(', ')}) failed after ${String(timeout)} ms: ${last.count}/${last.total} matching pixels`)
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}

/**
 * One occurrence's current render observation from the live test handle. The
 * map tab occurrence — not the conversation-view occurrence — is the measured
 * surface, so its receipt is the one a person's screen attests.
 * @param page - the driven page.
 * @returns the receipt, or null before the handle exists.
 */
async function readMapTabReceipt(page) {
  return await page.evaluate(() => {
    const harness = window.__mapHarness
    if (!(harness instanceof Map)) return null
    const entry = [...harness.entries()].find(([key]) => !key.endsWith(':view:map'))
    return entry === undefined ? null : entry[1]?.renderReceipt ?? null
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
    const entry = [...harness.entries()].find(([key]) => !key.endsWith(':view:map'))
    const receipt = entry?.[1]?.renderReceipt
    return receipt?.status === 'rendered' && receipt.failedLayers.length === 0
      && receipt.renderedRevision === receipt.revision && typeof receipt.viewId === 'string'
  }, undefined, { timeout: 30_000 })
  return await readMapTabReceipt(page)
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

test('built map profile composes MCP tools and rejects workspace escape', { timeout: 120_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-mcp-composition-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  const outside = join(temp, 'outside.geojson')
  const pointCollection = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'composition' } }],
  }
  writeFileSync(outside, JSON.stringify(pointCollection))
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'sample-points.geojson'), JSON.stringify(pointCollection))

  const providerRequests = []
  let mainRequests = 0
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      const titleRequest = parsed.max_tokens === 64
      providerRequests.push({ titleRequest, tools: parsed.tools ?? [], messages: parsed.messages ?? [] })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (titleRequest) {
        response.end(textResponse('map composition'))
        return
      }
      mainRequests += 1
      if (mainRequests === 1) {
        response.end(toolResponse([
          { id: 'composition-add', name: 'map_add_layer', input: { path: 'sample-points.geojson', layer_id: 'composition' } },
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
      } else {
        response.end(textResponse('workspace escape rejected'))
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

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    // Upstream 0.2 keeps the Sidebar chrome hidden for a blank conversation;
    // the first real message materializes the tab strip and map occurrence.
    await sendMessage(page, '请加载 sample-points.geojson 图层并把地图移动到北京。')

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
    // The ArcGIS view inside the freshly opened tab initializes asynchronously.
    // The right-Sidebar tab occurrence's key ends with the minted tab id, so
    // any handle other than the conversation view's `:view:map` is the panel.
    await page.waitForFunction(() => [...(window.__mapHarness ?? new Map()).keys()]
      .some(key => !key.endsWith(':view:map')), undefined, { timeout: 30_000 })

    await waitForCounter(() => mainRequests, 3)
    const toolCalls = page.getByRole('button', { name: /3 .*tool calls|3 次工具调用/ })
    if (await toolCalls.count() > 0) await toolCalls.click()
    // The restored Sidebar strip now exposes several tabs; the right-Sidebar
    // map tab is `地图 关闭` (a dockkit tab with a close affordance), which
    // the `exact: true` match must not confuse with the conversation view's
    // plain `地图` tab.
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
    assert.ok(handles.length >= 1)
    assert.ok(handles.every(value => value.layerCount === 1))

    const main = providerRequests.filter(request => !request.titleRequest)
    const toolNames = main[0].tools.map(tool => tool.name).filter(name => name.startsWith('map_') && name !== 'map_save').sort()
    assert.deepEqual(toolNames, requiredMapTools)
    assert.equal(new Set(toolNames).size, requiredMapTools.length)
    // Native-only presentation: the map profile pins the tools row to native,
    // so the PTC transport (`run_code`) must never reach the model tool list.
    const allNames = main[0].tools.map(tool => tool.name)
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
    assert.equal(consoleErrors.length, 0)

    const installedPreset = readFileSync(join(home, '.agent-presets', 'map-analyst', 'agent.cordis.yml'), 'utf8')
    assert.match(installedPreset, /@map-harness\/spatial-context\/agent/)
  } finally {
    if (browser) await browser.close()
    if (app) await stopProcessTree(app)
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

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
        if (parsed.max_tokens === 64) {
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
      if (parsed.max_tokens === 64) {
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
      if (parsed.max_tokens === 64) {
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
          { id: 'pixels-view', name: 'map_set_view', input: { center: [116.5, 39.9], zoom: 8, wkid: 4326 } },
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

test('gesture write channel: a user drag steers the running turn, an explicit submit queues, and programmatic writes stay silent', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-gesture-composition-'))
  const home = join(temp, 'home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# gesture composition\n')

  // Request 1 moves the view programmatically (map_set_view — must never form
  // a gesture). Request 2 holds the turn open so the user drag can steer it.
  // The steer lands as request 3 carrying the bounded observation text. The
  // explicit workbench submit lands as request 4 (idle, queue mode).
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
  const bodies = []
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', async () => {
      const parsed = JSON.parse(body)
      if (parsed.max_tokens === 64) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(textResponse('gesture lane'))
        return
      }
      mainRequests += 1
      bodies.push(JSON.stringify(parsed.messages))
      if (mainRequests === 2) await waitForGate('gesture')
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
    await sendMessage(page, '把地图移动到北京。')

    const mapBand = page.locator('[data-map-container]:not([data-map-view])')
    await mapBand.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map
        && [...harness.values()].some(value => value.center?.[0] === 116.4 && value.center?.[1] === 39.9)
    }, undefined, { timeout: 30_000 })
    // Request 2 holds the turn open: programmatic writes stay silent and the
    // occurrence is ready to attribute real user gestures.
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].every(value => (value.gesture?.draftsFormed ?? 0) === 0)
    }, undefined, { timeout: 10_000 })

    // A real user drag on the map band: pointer events attribute the camera
    // change; the settle window then forms one bounded stable observation.
    // The view-sync camera writes hold a programmatic mute pulse — let it
    // expire so the drag is attributed to the user.
    await new Promise(resolve => setTimeout(resolve, 1_800))
    const band = await mapBand.boundingBox()
    const dragX = band.x + band.width / 2
    const dragY = band.y + Math.min(band.height / 4, 120)
    await page.mouse.move(dragX, dragY)
    await page.mouse.down()
    await page.mouse.move(dragX + 80, dragY + 20, { steps: 10 })
    await page.mouse.up()

    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map
        && [...harness.values()].some(value => (value.gesture?.stableEmitted ?? 0) >= 1)
    }, undefined, { timeout: 15_000 })
    const metrics = await page.evaluate(() => {
      const harness = window.__mapHarness
      return [...harness.values()].map(value => value.gesture)
    })
    const stable = metrics.find(entry => (entry?.stableEmitted ?? 0) >= 1)
    assert.ok(stable.lastText.startsWith('[map-gesture v1]'), 'the steered observation carries the version marker')
    assert.equal(stable.draftsFormed, 1, 'exactly the user drag forms a draft')

    // The steer entered the running turn's inbox; ending the held round lets
    // the next request carry it as user input.
    openGate('gesture')
    for (let waited = 0; waited < 30_000 && !(bodies.length >= 3 && bodies[2].includes('[map-gesture v1]')); waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(bodies[2]?.includes('[map-gesture v1]'), 'the steered observation reaches the model conversation as user input')

    // Idle now: the explicit workbench submit queues a fresh observation.
    await page.locator('[data-gesture-submit-button]').click()
    await page.locator('[data-gesture-submit-status]').waitFor({ timeout: 10_000 })
    const statusText = await page.locator('[data-gesture-submit-status]').textContent()
    assert.equal(statusText, '已作为用户输入发送视图观察', 'the explicit submit reports its outcome inline')
    for (let waited = 0; waited < 30_000 && !(bodies.length >= 4 && bodies[3].includes('[map-gesture v1]') && bodies[3].includes('explicit')); waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(bodies[3]?.includes('[map-gesture v1]'), 'the explicit submit reaches the model conversation as user input')
    assert.ok(bodies[3]?.includes('explicit'), 'the explicit observation carries its kind')
  } finally {
    if (browser) await browser.close()
    if (app) await stopProcessTree(app)
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})
