import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { Resolver } from 'node:dns/promises'
import { connect as connectTcp, isIP } from 'node:net'
import sharp from 'sharp'
import { chromium } from '../../../apps/web/node_modules/playwright/index.mjs'
import { deriveReplayScript, parseSessionLog, resolveScriptedEntry } from '../../../packages/test-support/llm-replay/lib/index.js'
import { createZstdFrameDecoder, scanZstdFrames } from '../../../packages/session/session-persistence-jsonl/lib/types/zstd.js'
import { qualificationPlatform, windowsLauncherInvocation } from '../../bin/web-service-qualification-platform.mjs'
import { prepareMapInstance, resolveMapInstance } from '../../bin/instance-home.mjs'
import { OBSERVATION_ALLOW_PATCH, OBSERVATION_USER_REQUEST, createObservationModelFixture } from './observation-model-fixture.mjs'
import { MAP_MARKUP_ALLOW_PATCH, MAP_USE_ALLOW_PATCH, MAP_USE_USER_REQUEST, createMapUseModelFixture } from './map-use-model-fixture.mjs'
import { deriveMapUseReplay, resolveMapUseReplayEntry } from './map-use-replay.mjs'
import { imageGridCoverage, isolatedTemp, proxyEvidenceSecrets, redactEvidence, writeEvidence } from './wayback-evidence.mjs'
import { OBSERVATION_CONTROL_POINTS } from '../../map-container/tests/observation-control-cases.mjs'
import { PUBLIC_SOURCE_PRESETS } from '../../map-container/src/source-render-protocol.ts'
import { loadVerifiedWaybackRelease } from '../../map-container/src/wayback-catalog-store.ts'
import { WAYBACK_CONFIG_URL } from '../../map-container/src/wayback-catalog-codec.ts'
import { SPATIAL_MCP_TOOL_NAMES } from '../../tools/src/spatial-catalog.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const mapBin = join(root, 'map', 'bin', 'map-harness.mjs')
const applicationCommand = process.env.MAP_APPLICATION_BIN ? resolve(process.env.MAP_APPLICATION_BIN) : process.execPath
const applicationPrefix = process.env.MAP_APPLICATION_BIN ? [] : [mapBin]
const pickerPatch = join(root, 'apps', 'web', 'tests', 'pin-browse-picker.overlay.yml')
const requiredMapTools = [
  'data_export',
  'data_import',
  'layer_set_state',
  'layer_set_style',
  'map_add_layer',
  'map_apply_patch',
  'map_compare_views',
  'map_draw',
  'map_fit_view',
  'map_get_state',
  'map_list_basemaps',
  'map_locate',
  'map_mark_changes',
  'map_markup',
  'map_observe',
  'map_remove_layer',
  'map_set_basemap',
  'map_set_mode',
  'map_set_view',
  'map_undo',
  'map_use',
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

const fixtureImagery = new URL(PUBLIC_SOURCE_PRESETS['esri-world-imagery'].url)
const worldEdge = 20037508.342789244
const fixtureExtent = { xmin: -worldEdge, ymin: -worldEdge, xmax: worldEdge, ymax: worldEdge, spatialReference: { wkid: 3857 } }
const fixtureMapServer = {
  currentVersion: 11.5,
  capabilities: 'Map,Query',
  singleFusedMapCache: true,
  spatialReference: fixtureExtent.spatialReference,
  fullExtent: fixtureExtent,
  initialExtent: fixtureExtent,
  supportedImageFormatTypes: 'PNG32,PNG',
  tileInfo: {
    rows: 256, cols: 256, dpi: 96, format: 'PNG',
    origin: { x: -worldEdge, y: worldEdge }, spatialReference: fixtureExtent.spatialReference,
    lods: Array.from({ length: 20 }, (_value, level) => ({
      level, resolution: 2 * worldEdge / (256 * 2 ** level), scale: 591657527.591555 / 2 ** level,
    })),
  },
  layers: [],
}

/** Serve the default MapServer metadata and both visible raster sources without public traffic. */
async function useFixtureBasemap(page) {
  const tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#ffffff' } }).png().toBuffer()
  const labelTile = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#00000000' } }).png().toBuffer()
  await page.route(url => url.pathname === '/api/map/sources/resource'
    && url.searchParams.get('sourceId') === 'amap-imagery-labels'
    && url.searchParams.get('resource') === 'xyz-tile', route =>
    route.fulfill({ contentType: 'image/png', body: labelTile }))
  await page.route(url => url.origin === fixtureImagery.origin
    && (url.pathname === fixtureImagery.pathname || url.pathname.startsWith(`${fixtureImagery.pathname}/`)), route => {
    const url = new URL(route.request().url())
    const resource = url.pathname.slice(fixtureImagery.pathname.length)
    if (resource === '' || resource === '/') return route.fulfill({ json: fixtureMapServer })
    if (/^\/tile\/\d+\/\d+\/\d+$/u.test(resource)) return route.fulfill({ contentType: 'image/png', body: tile })
    if (resource === '/export' && url.searchParams.get('f') === 'image') return route.fulfill({ contentType: 'image/png', body: tile })
    return route.abort('blockedbyclient')
  })
}

async function useLiveImagery(page, network, source, responses) {
  const labelTile = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#00000000' } }).png().toBuffer()
  await page.route(url => url.pathname === '/api/map/sources/resource'
    && url.searchParams.get('sourceId') === 'amap-imagery-labels'
    && url.searchParams.get('resource') === 'xyz-tile', route =>
    route.fulfill({ contentType: 'image/png', body: labelTile }))
  await page.route(url => url.origin === fixtureImagery.origin
    && (url.pathname === fixtureImagery.pathname || url.pathname.startsWith(`${fixtureImagery.pathname}/`)), async route => {
    const url = new URL(route.request().url())
    const suffix = url.pathname.slice(fixtureImagery.pathname.length)
    const payload = suffix === '' || suffix === '/' || suffix.startsWith('/tilemap/') ? 'json' : 'image'
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await network.request({ source, url, payload })
        if (payload === 'image') {
          const metadata = await sharp(response.body).metadata()
          responses.push({ status: response.status, format: metadata.format })
        }
        await route.fulfill({ status: response.status, contentType: response.contentType ?? undefined, body: response.body })
        return
      } catch (error) {
        if (attempt < 2 && ['SOURCE_UNAVAILABLE', 'SOURCE_TIMEOUT'].includes(error.code)) continue
        responses.push({ status: 0, code: error.code ?? 'unexpected', path: url.pathname, query: [...url.searchParams.keys()] })
        await route.abort('failed')
        return
      }
    }
  })
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

/**
 * The launcher spawns the service detached (its own process group), so the launcher's group can be gone
 * while the service still holds the instance lock. Await the record the service publishes on teardown
 * (`state: 'stopped'`); a relaunch on the same Map home before that is MAP_INSTANCE_BUSY.
 */
async function waitForInstanceRecord(mapHome, timeoutMs = 15_000) {
  if (mapHome === undefined) return
  const record = join(mapHome, 'map-run', 'instance.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (JSON.parse(readFileSync(record, 'utf8')).state === 'stopped') return
    } catch {
      // absent or mid-write; keep waiting until the deadline
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}


/**
 * The launcher spawns the service detached, so killing the launcher's group leaves the service alive holding
 * the instance lock. SIGKILL it (a crash, never a graceful dispose: the interrupted turn must stay open so the
 * relaunched app's repair closers write its `turn/end`), then wait until the pid is gone; the kernel releases
 * the flock with the process, so the relaunch on the same Map home is admitted.
 */
async function killDetachedService(mapHome, timeoutMs = 15_000) {
  const record = join(mapHome, 'map-run', 'instance.json')
  const read = () => { try { return JSON.parse(readFileSync(record, 'utf8')) } catch { return undefined } }
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  const state = read()
  const pid = Number.isInteger(state?.pid) ? state.pid : undefined
  if (pid !== undefined && alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch { /* raced its exit */ } }
  const deadline = Date.now() + timeoutMs
  while (pid !== undefined && alive(pid) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (pid !== undefined && alive(pid)) throw new Error(`detached map service ${pid} did not exit after SIGKILL`)
}

async function stopProcessTree(child, mapHome) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await waitForInstanceRecord(mapHome)
    return
  }
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
    await new Promise((resolveExit, rejectExit) => {
      const onExit = () => { clearTimeout(timeout); resolveExit() }
      const timeout = setTimeout(() => {
        child.off('exit', onExit)
        rejectExit(new Error('child process did not exit after forced termination'))
      }, 5_000)
      child.once('exit', onExit)
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } else process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error?.code !== 'ESRCH') {
          clearTimeout(timeout)
          child.off('exit', onExit)
          rejectExit(error)
        }
      }
    })
  }
  // The launcher can exit before its web child finishes flushing storage; hold
  // teardown until the whole process group is gone so a following temp removal
  // never races a late write.
  if (process.platform !== 'win32') {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      try {
        process.kill(-child.pid, 0)
      } catch (error) {
        if (error?.code === 'ESRCH' || error?.code === 'EPERM') {
          await waitForInstanceRecord(mapHome)
          return
        }
        throw error
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
}

/** Install the scoped browser-storage key builder as a page global; the product injects the namespace per page load. */
async function installScopedStorageKey(context) {
  await context.addInitScript(() => {
    globalThis.scopedStorageKey = key => {
      const namespace = globalThis.__DSH_BROWSER_STORAGE_NAMESPACE__
      return typeof namespace === 'string' && namespace !== '' ? `dsh.scope:${namespace.length}:${namespace}:${key}` : key
    }
  })
}

async function waitForAppUrl(child, stdout, stderr) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const match = stdout.value.match(/map-harness web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
    if (match) return match[1]
    if (child.exitCode !== null) throw new Error(`map app exited ${String(child.exitCode)}: ${stderr.value}`)
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`map app URL timeout: ${stderr.value}`)
}

async function maybeContinueNotice(page) {
  const notice = page.getByRole('dialog', { name: /Preview notice|预览版说明/i })
  try {
    await notice.waitFor({ state: 'visible', timeout: 5_000 })
  } catch (_noticeAbsent) {
    return
  }
  const isAcknowledgement = operation => operation.op === 'set' && Array.isArray(operation.path)
    && operation.path.length === 1 && operation.path[0] === 'welcomeNoticeVersion'
  const [response] = await Promise.all([
    page.waitForResponse(response => {
      if (response.request().method() !== 'POST' || new URL(response.url()).pathname !== '/api/settings/mutate') return false
      const args = response.request().postDataJSON()?.payload?.args
      return args?.ns === 'ui-settings-general' && Array.isArray(args.ops) && args.ops.some(isAcknowledgement)
    }),
    notice.getByRole('button', { name: /^(Continue|继续)$/ }).click(),
  ])
  assert.equal(response.status(), 200)
  const reply = await response.json()
  const expected = response.request().postDataJSON().payload.args.ops.find(isAcknowledgement).value
  assert.equal(reply.result?.ok, true,
    `the welcome acknowledgement must persist: ${JSON.stringify({ expected, reply })}`)
  assert.equal(reply.result.value?.value?.welcomeNoticeVersion, expected,
    `welcome acknowledgement mismatch: ${JSON.stringify({ expected, reply })}`)
  await notice.waitFor({ state: 'hidden', timeout: 5_000 })
}

/** Adopt the exact fixture path and wait for its newly selected Session, not just its workspace row. */
async function connectWorkspace(page, workspace) {
  const workspaceName = workspace.split(/[\\/]/).filter(Boolean).at(-1)
  // Finish startup selection before the user-owned navigation begins.
  await page.locator('[data-conversation-session] [data-composer-input][contenteditable="true"]').waitFor()
  const closedDrawer = page.locator('[data-sidebar-drawer][data-sidebar-collapsed]')
  if (await closedDrawer.count() > 0) {
    await page.locator('[data-shell-leading]').getByRole('button', { name: /^(Open sidebar|打开侧边栏)$/ }).click()
    await closedDrawer.waitFor({ state: 'detached' })
  }
  await page.getByRole('button', { name: /^(Add workspace|添加工作区)$/ }).click()
  const dialog = page.getByRole('dialog', { name: /^(Select Workspace Directory|选择工作区目录)$/ })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: /^(Edit path|编辑路径)$/ }).click()
  const pathInput = dialog.getByRole('textbox', { name: /^(Edit path|编辑路径)$/ })
  await pathInput.fill(workspace)
  await pathInput.press('Enter')
  await pathInput.waitFor({ state: 'detached' })
  await dialog.getByRole('navigation').getByRole('button', { name: workspaceName, exact: true }).waitFor()
  const [workspaceResponse, sessionResponse] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/workspace/create'
      && response.request().postDataJSON()?.payload?.args?.request?.path === workspace),
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/create'
      && response.request().postDataJSON()?.payload?.args?.request?.workspaceId !== undefined),
    dialog.getByRole('button', { name: /^(Open|打开)$/ }).click(),
  ])
  const workspaceReply = await workspaceResponse.json()
  const sessionReply = await sessionResponse.json()
  assert.equal(workspaceReply.result?.ok, true, JSON.stringify(workspaceReply))
  assert.equal(sessionReply.result?.ok, true, JSON.stringify(sessionReply))
  const workspaceId = workspaceReply.result.value.workspace.workspaceId
  assert.equal(sessionResponse.request().postDataJSON().payload.args.request.workspaceId, workspaceId)
  const sessionId = sessionReply.result.value.sessionId
  await dialog.waitFor({ state: 'hidden' })
  const conversation = page.locator(`[data-conversation-session="${sessionId}"]:visible`)
  await conversation.locator('[data-composer-input][contenteditable="true"]').waitFor()
  await page.locator(`[data-row-key="session:${sessionId}"][aria-selected="true"]`).waitFor({ state: 'attached' })
  return sessionId
}

/** Select a preset only on a blank Session; existing conversations keep their recorded preset. */
async function chooseMapPreset(page) {
  const conversation = page.locator('[data-conversation-session]:visible').first()
  await conversation.waitFor()
  if (await conversation.getAttribute('data-content-phase') !== 'hero') return
  const current = conversation.locator('button[aria-haspopup="menu"]').filter({ hasText: /地图分析模式|Standard|标准模式/ }).first()
  await current.waitFor()
  if (!(await current.innerText()).includes('地图分析模式')) {
    await current.click()
    await page.getByRole('menuitem').filter({ hasText: '地图分析模式' }).click()
  }
  await conversation.locator('button[aria-haspopup="menu"]:enabled').filter({ hasText: '地图分析模式' }).waitFor()
}

/** Expand the resident card and select the requested tab. */
async function openUnifiedMapPanel(scope, section) {
  const panel = scope.locator('[data-map-panel][data-map-panel-surface="unified"]:visible').first()
  await panel.waitFor({ timeout: 30_000 })
  const chevron = panel.locator('[data-map-panel-collapse]')
  if (await chevron.getAttribute('aria-expanded') === 'false') await chevron.click()
  if (section !== undefined) {
    const tab = panel.locator(`[data-map-panel-tab="${section}"]`).locator('..')
    if (await tab.getAttribute('aria-selected') === 'false') await tab.click()
    await panel.locator(`[data-map-panel-tab-body="${section}"]`).waitFor()
  }
  return panel
}

/** Collapse the card to its header without unmounting it. */
async function closeUnifiedMapPanel(scope) {
  const panel = scope.locator('[data-map-panel][data-map-panel-surface="unified"]:visible').first()
  const chevron = panel.locator('[data-map-panel-collapse]')
  if (await chevron.getAttribute('aria-expanded') === 'true') await chevron.click()
  await panel.locator('[data-map-panel-body]').waitFor({ state: 'hidden' })
}

function imageryRow(panel, kind) {
  return panel.locator(`[data-map-imagery-row][data-imagery-kind="${kind}"]`)
}

async function openImageryDialog(page, kind) {
  const panel = await openUnifiedMapPanel(page, 'imagery')
  await imageryRow(panel, kind).getByRole('button').filter({ hasText: '⋯' }).click()
  const dialog = page.getByRole('dialog').filter({ has: page.locator('[data-map-imagery-dialog]') })
  await dialog.waitFor()
  return dialog
}

async function closeImageryDialog(page, dialog) {
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
}

/** Type through Lexical's input path and observe the accepted prompt on the selected Session. */
async function sendMessage(page, text) {
  const conversation = page.locator('[data-conversation-session]:visible').first()
  const sessionId = await conversation.getAttribute('data-conversation-session')
  assert.ok(sessionId, 'a selected Session owns the composer')
  const composer = conversation.locator('[data-composer-input][contenteditable="true"]')
  await composer.waitFor()
  // The composer element remounts when a turn settles, so read the live
  // surface by session id for every observation instead of holding a handle.
  const composerText = () => page.evaluate(id => {
    const conversation = [...document.querySelectorAll('[data-conversation-session]')]
      .find(node => node.getAttribute('data-conversation-session') === id && node.offsetParent !== null)
    const surface = conversation?.querySelector('[data-composer-input][contenteditable="true"]')
    return surface === null ? null : (surface.textContent ?? '')
  }, sessionId)
  // Lexical consumes per-character key events unreliably after a programmatic
  // focus (the first character of a fresh draft can vanish), so commit the
  // prompt like a CJK IME does: one insertText input, verified on the live
  // surface, retried when a settling turn remounted the editor mid-insert.
  let placed = false
  for (let attempt = 0; attempt < 3 && !placed; attempt += 1) {
    await composer.waitFor({ state: 'visible', timeout: 30_000 })
    await composer.click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.press('Backspace')
    for (let waited = 0; waited < 5_000; waited += 50) {
      if ((await composerText())?.trim() === '') break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    // The freshly mounted Lexical editor needs a DOM selection inside itself
    // (and one reconciled frame) before it accepts injected input; without it
    // the commit lands nowhere.
    await page.waitForFunction(id => {
      const conversation = [...document.querySelectorAll('[data-conversation-session]')]
        .find(node => node.getAttribute('data-conversation-session') === id && node.offsetParent !== null)
      const surface = conversation?.querySelector('[data-composer-input][contenteditable="true"]')
      const selection = document.getSelection()
      return surface !== null && selection !== null && selection.rangeCount > 0
        && surface.contains(selection.getRangeAt(0).startContainer)
    }, sessionId)
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    }))
    await page.keyboard.insertText(text)
    placed = (await composerText())?.includes(text) === true
  }
  assert.ok(placed, `the composer holds the prompt (saw ${JSON.stringify(await composerText())})`)
  const [submitted] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === '/api/session/prompt'
      && response.request().postDataJSON()?.payload?.args?.request?.sessionId === sessionId),
    conversation.getByRole('button', { name: /^(Send message|发送消息)$/ }).click(),
  ])
  assert.equal(submitted.status(), 200, 'prompt transport succeeds')
  const reply = await submitted.json()
  assert.equal(reply.result?.ok, true, JSON.stringify(reply))
}

/** Wait for the deterministic local provider to finish a bounded turn. */
async function waitForCounter(read, target, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (read() < target && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert.ok(read() >= target, `provider did not reach request ${target} (saw ${read()})`)
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

/**
 * Capture the live ArcGIS canvas and report whether it paints varied imagery.
 * Screenshotting the map canvas (not the surrounding panel) keeps UI text from
 * standing in for real rendered tiles.
 * @param page - the driven page.
 * @returns the PNG, decoded pixels, and the sampled distinct-color count.
 */
async function mapFrameStats(page) {
  const canvas = page.locator('[data-map-container] canvas').first()
  await canvas.waitFor({ state: 'visible', timeout: 30_000 })
  const png = await canvas.screenshot()
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const colors = new Set()
  let nonBlank = 0
  for (let at = 0; at < data.length; at += 4) {
    const red = data[at]; const green = data[at + 1]; const blue = data[at + 2]
    colors.add((red << 16) | (green << 8) | blue)
    if (red < 235 || green < 235 || blue < 235) nonBlank += 1
  }
  const gridCoverage = imageGridCoverage(data, info.width, info.height)
  return { png, data, width: info.width, height: info.height, distinctColors: colors.size, nonBlank, total: data.length / 4, gridCoverage }
}

/** Wait until the map canvas paints varied imagery rather than a blank surface. */
async function waitForMapFrame(page, { timeout = 90_000, previous = null, minimumChange = 0.01 } = {}) {
  const deadline = Date.now() + timeout
  let last
  for (;;) {
    last = await mapFrameStats(page)
    const changed = previous === null || changedPixelShare(previous, last) >= minimumChange
    if (last.distinctColors >= 24 && last.gridCoverage.every(value => value >= 0.75) && changed) return last
    if (Date.now() >= deadline) {
      assert.fail(`the map canvas did not paint all regions: ${last.distinctColors} colors, grid=${JSON.stringify(last.gridCoverage)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}

async function waitForImageryFrame(page, previous = null) {
  const deadline = Date.now() + 90_000
  for (;;) {
    const frame = await mapFrameStats(page)
    const changed = previous === null || changedPixelShare(previous, frame) >= 0.01
    if (frame.distinctColors >= 24 && frame.gridCoverage.every(value => value >= 0.6) && changed) return frame
    if (Date.now() >= deadline) assert.fail(`the map canvas did not paint imagery: colors=${frame.distinctColors}, grid=${JSON.stringify(frame.gridCoverage)}`)
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}

/** Share of sampled pixels whose RGB differs between two same-size map captures. */
function changedPixelShare(before, after) {
  assert.equal(before.data.length, after.data.length, 'map captures must keep one size')
  let changed = 0
  for (let at = 0; at < before.data.length; at += 4) {
    if (Math.abs(before.data[at] - after.data[at]) > 8
      || Math.abs(before.data[at + 1] - after.data[at + 1]) > 8
      || Math.abs(before.data[at + 2] - after.data[at + 2]) > 8) changed += 1
  }
  return changed / (before.data.length / 4)
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
async function waitForRenderedReceipt(page, timeout = 30_000) {
  try {
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      if (!(harness instanceof Map)) return false
      const sessionId = document.querySelector('[data-map-session-action]')?.getAttribute('data-map-session-action')
      const receipt = [...harness.values()].find(value => value.renderReceipt.sessionId === sessionId)?.renderReceipt
      return receipt?.status === 'rendered' && receipt.failedLayers.length === 0
        && receipt.renderedRevision === receipt.revision && typeof receipt.viewId === 'string'
    }, undefined, { timeout })
  } catch (error) {
    const receipts = await page.evaluate(() => [...(window.__mapHarness?.values() ?? [])].map(value => ({
      sessionId: value.renderReceipt.sessionId,
      mode: value.mode,
      layerCount: value.layerCount,
      receipt: value.renderReceipt,
    })))
    throw new Error(`${error instanceof Error ? error.name : 'Error'}; receipts=${JSON.stringify(receipts)}`)
  }
  return await readMapTabReceipt(page)
}

async function waitForImageryReceipt(page, sessionId, digest, minimumRevision = 0) {
  await page.waitForFunction(({ sessionId, digest, minimumRevision }) => {
    const occurrenceKey = document.querySelector(`[data-map-container][data-map-session="${sessionId}"]`)?.getAttribute('data-map-tab')
    return [...(window.__mapHarness?.values() ?? [])].some(handle => {
      const receipt = handle.renderReceipt
      return receipt.sessionId === sessionId && receipt.occurrenceKey === occurrenceKey
        && receipt.status === 'rendered' && receipt.failedLayers.length === 0
        && receipt.revision >= minimumRevision && receipt.revision === receipt.renderedRevision
        && receipt.layerVersions.some(layer => layer.id === 'early-imagery' && layer.token === digest)
        && receipt.layerVersions.some(layer => layer.id === 'basemap')
    })
  }, { sessionId, digest, minimumRevision }, { timeout: 90_000 })
  return page.evaluate(({ sessionId, digest }) => {
    const occurrenceKey = document.querySelector(`[data-map-container][data-map-session="${sessionId}"]`)?.getAttribute('data-map-tab')
    return [...window.__mapHarness.values()].find(handle => {
      const receipt = handle.renderReceipt
      return receipt.sessionId === sessionId && receipt.occurrenceKey === occurrenceKey
        && receipt.status === 'rendered' && receipt.layerVersions.some(layer => layer.id === 'early-imagery' && layer.token === digest)
    }).renderReceipt
  }, { sessionId, digest })
}

/** Wait for the SDK camera itself, independently of the requested projection coordinates. */
async function waitForMapCamera(page, sessionId, center, zoom) {
  try {
    await page.waitForFunction(({ sessionId, center, zoom }) => {
      const camera = [...(window.__mapHarness ?? new Map()).values()]
        .find(value => value.renderReceipt.sessionId === sessionId)?.camera
      return camera != null && Math.abs(camera.center[0] - center[0]) < 0.00001
        && Math.abs(camera.center[1] - center[1]) < 0.00001 && Math.abs(camera.zoom - zoom) < 0.01
    }, { sessionId, center, zoom }, { timeout: 60_000 })
  } catch (error) {
    throw new Error(`${String(error)}\nReceipt state: ${JSON.stringify(await receiptDiagnostics(page))}`)
  }
}

/** Wait for a settled live camera while allowing raster LOD zoom rounding. */
async function waitForMapCameraLoose(page, sessionId, center, zoom) {
  await page.waitForFunction(({ sessionId, center, zoom }) => {
    const camera = [...(window.__mapHarness ?? new Map()).values()]
      .find(value => value.renderReceipt.sessionId === sessionId)?.camera
    return camera != null && Math.abs(camera.center[0] - center[0]) < 0.001
      && Math.abs(camera.center[1] - center[1]) < 0.001
      && Math.abs(camera.zoom - zoom) < 0.25
  }, { sessionId, center, zoom }, { timeout: 30_000 })
}

/**
 * The darkest class swatch among a layer row's chip legend (the light-to-dark
 * ramp's top class); the unified panel's replacement for the removed workbench
 * legend.
 * @param row - the layer row locator carrying the class chip.
 * @param classCount - the classification's class count.
 * @returns the rgb triple the map must paint that class with.
 */
async function darkestRowChipColor(row, classCount) {
  const swatches = await row.locator('[data-map-panel-chip] span[role="img"]')
    .evaluateAll(spans => spans.map(span => getComputedStyle(span).backgroundColor))
  assert.ok(swatches.length >= classCount, `expected ${classCount} class swatches, saw ${swatches.length}`)
  let darkest = null
  for (const value of swatches.slice(0, classCount)) {
    const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(value)
    if (match === null) continue
    const rgb = [Number(match[1]), Number(match[2]), Number(match[3])]
    const luminance = rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114
    if (darkest === null || luminance < darkest.luminance) darkest = { rgb, luminance }
  }
  assert.ok(darkest !== null, 'no parseable class swatch color')
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
  const mapHome = join(temp, 'map-home')
  const workspace = join(temp, 'workspace')
  const outside = join(temp, 'outside.geojson')
  if (legacyPreset) {
    // A non-empty unmarked Map home is refused (MAP_HOME_UNCLAIMED); claim it the way an install does,
    // resolving against the same DSH_HOME the launch will inherit so admission sees identical roots.
    prepareMapInstance(resolveMapInstance({ mode: 'source', checkoutRoot: root, installRoots: [root], env: { ...process.env, DSH_HOME: home, MAPHARNESS_HOME: mapHome }, cwd: workspace }))
    // The product installs and reads the preset under the Map home; a legacy install lives there too.
    const preset = join(mapHome, '.agent-presets', 'map-analyst')
    cpSync(join(root, 'map', 'presets', 'map-analyst'), preset, { recursive: true })
    const composition = join(preset, 'agent.cordis.yml')
    const legacyComposition = readFileSync(composition, 'utf8').replace(/\n- id: spatial-context-agent\n[\s\S]*$/, '\n')
    assert.doesNotMatch(legacyComposition, /name: ['"]@map-harness\/spatial-context\/agent['"]/, 'the installed legacy preset really lacks spatial context')
    writeFileSync(composition, legacyComposition + '\n- id: legacy-map-tools\n  name: "@map-harness/map-tools/mcp"\n')
    const profile = join(mapHome, 'profiles', 'map-web')
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
        response.end(toolResponse([{ id: 'binding-reconnect', name: 'map_set_view', input: { center: [12.3456, 45.6789], zoom: 11 } }]))
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
        MAPHARNESS_HOME: mapHome,
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
    await installScopedStorageKey(context)
    if (offlineHint) await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false })
    })
    const page = await context.newPage()
    await useFixtureBasemap(page)
    const pageErrors = []
    const consoleErrors = []
    let restarting = false
    let reloading = false
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => {
      if (message.type() !== 'error') return
      const text = message.text()
      if ((restarting || reloading) && (/WebSocket connection .*failed:/.test(text)
        || /net::ERR_(CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE|INCOMPLETE_CHUNKED_ENCODING)/.test(text)
        || /sessionStatus\/mark failed: Failed to fetch/.test(text))) return
      // A retained engine keeps its pre-restart source identity, and the host
      // refuses its labels tiles with an honest 409 SOURCE_CHANGED until the
      // user refreshes; the refusal is product behavior, not a page defect.
      if (/Failed to load resource: the server responded with a status of 409 \(Conflict\)/.test(text)
        && message.location()?.url.includes('/api/map/sources/resource?')) return
      if (/\[@arcgis\/core\/(?:layers\/TileLayer|views\/support\/LayerViewManager)\].*(?:Failed to load layer|Failed to create layerview).*'Esri World Imagery'/.test(text)) return
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
    if (onlineSource) {
      // The ref layer lands in the same projection pass as the requested view,
      // so the settled camera is either the requested zoom 9 or the layer's
      // own auto-frame; both center on the registered point.
      await page.waitForFunction(sessionId => {
        const camera = [...(window.__mapHarness?.values() ?? [])]
          .find(value => value.renderReceipt.sessionId === sessionId)?.camera
        return camera != null && Math.abs(camera.center[0] - 116.4) < 0.01
          && Math.abs(camera.center[1] - 39.9) < 0.01
      }, firstSession, { timeout: 60_000 })
    } else {
      // The ref add and requested view fold in one pass; an auto-frame may win
      // the initial camera, while the bound center still proves the session map.
      await page.waitForFunction(sessionId => {
        const camera = [...(window.__mapHarness?.values() ?? [])]
          .find(value => value.renderReceipt.sessionId === sessionId)?.camera
        return camera != null && Math.abs(camera.center[0] - 116.4) < 0.01
          && Math.abs(camera.center[1] - 39.9) < 0.01
      }, firstSession, { timeout: 60_000 })
    }
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
    const [createdSessionResponse] = await Promise.all([
      page.waitForResponse('**/api/session/create'),
      page.getByRole('button', { name: '在“workspace”中新建会话', exact: true }).click(),
    ])
    const createdSession = await createdSessionResponse.json()
    assert.equal(createdSession.result?.ok, true, JSON.stringify(createdSession))
    await page.locator(`[data-conversation-session="${createdSession.result.value.sessionId}"]:visible [data-composer-input][contenteditable="true"]`).waitFor()
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
      const key = globalThis.scopedStorageKey(`dsh.sidebar-right.v1.${id}`)
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
    reloading = true
    await page.reload()
    await page.locator(`[data-map-container][data-map-session="${firstSession}"]:visible`).waitFor({ timeout: 30_000 })
    await page.waitForFunction(id => {
      const maps = [...(window.__mapHarness ?? new Map()).values()]
      return maps.length === 1 && maps[0].renderReceipt.sessionId === id
        && maps[0].center[0] === 121.5 && maps[0].layerCount === 1
    }, firstSession)
    await page.waitForFunction(id => {
      const layout = JSON.parse(localStorage.getItem(globalThis.scopedStorageKey(`dsh.sidebar-right.v1.${id}`))).bySession[id].layout
      return Object.values(layout.tabs).filter(tab => tab.kind === 'map').length === 1
    }, firstSession)
    reloading = false
    assert.equal(await page.locator('[data-map-container]').count(), 1)
    assert.notEqual((await waitForRenderedReceipt(page)).viewId, firstReceipt.viewId, 'refresh recreates only the selected session map from its log')

    if (legacyPreset || offlineHint) {
      restarting = true
      await stopProcessTree(app, mapHome)
      stdout.value = ''; stderr.value = ''
      app = spawn(process.execPath, [mapBin, '--patch', pickerPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open'], {
        cwd: workspace,
        env: { ...process.env, MAPHARNESS_HOME: mapHome, DSH_HOME: home, DEEPSEEK_API_KEY: 'composition-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`, DSH_TELEMETRY_MODE: 'DISABLED' },
        stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      })
      app.stdout.setEncoding('utf8'); app.stderr.setEncoding('utf8')
      app.stdout.on('data', chunk => { stdout.value += chunk })
      app.stderr.on('data', chunk => { stderr.value += chunk })
      await waitForAppUrl(app, stdout, stderr)
      await sendMessage(page, 'Reconnect and move this session map to synthetic point (12.3456, 45.6789).')
      await waitForCounter(() => mainRequests, 13)
      await page.waitForFunction(id => [...window.__mapHarness.values()].some(value => value.renderReceipt.sessionId === id
        && value.center[0] === 12.3456 && value.zoom === 11), firstSession)
      await waitForMapCamera(page, firstSession, [12.3456, 45.6789], 11)
      if (offlineHint) assert.equal(await page.evaluate(() => navigator.onLine), false)
      restarting = false
      // The retained engine still carries the pre-restart runtime epoch; a
      // real user refreshes after the backend restart, rebuilding the source
      // carriers against the new epoch instead of 409ing on every tile.
      reloading = true
      await page.reload()
      await page.locator(`[data-map-container][data-map-session="${firstSession}"]:visible`).waitFor({ timeout: 30_000 })
      reloading = false
    }

    if (onlineSource) assert.equal(onlineReads, 1, 'online search must fetch once and later restore from the registered bytes')
    const main = providerRequests.filter(request => !request.titleRequest)
    const contextMessages = main[0].messages.filter(message => JSON.stringify(message.content).includes('spatial-context/snapshot v1 kind=baseline'))
    assert.equal(contextMessages.length, 1, 'new and legacy presets must each admit exactly one spatial baseline')
    assert.match(JSON.stringify(contextMessages[0]), /以本轮模型请求提供的工具 schema 为准/)
    if (legacyPreset) {
      const installed = readFileSync(join(mapHome, '.agent-presets', 'map-analyst', 'agent.cordis.yml'), 'utf8')
      assert.doesNotMatch(installed, /name: ['"]@map-harness\/spatial-context\/agent['"]/, 'runtime fallback must not rewrite the user preset')
      assert.match(installed, /id: legacy-map-tools/, 'user-owned registrations remain intact')
    }
    const allNames = main[0].tools.map(tool => tool.name)
    const toolNames = allNames.filter(name => requiredMapTools.includes(name)).sort()
    assert.deepEqual(toolNames, requiredMapTools, 'the map, layer, and data tools the profile promises are all mounted')
    assert.equal(new Set(toolNames).size, requiredMapTools.length)
    const compareTool = main[0].tools.find(tool => tool.name === 'map_compare_views')
    const changeTool = main[0].tools.find(tool => tool.name === 'map_mark_changes')
    assert.ok(compareTool, 'map_compare_views must be in the native model toolset')
    assert.ok(changeTool, 'map_mark_changes must be in the native model toolset')
    assert.match(JSON.stringify(compareTool.input_schema ?? compareTool.inputSchema ?? {}), /comparison_id|before_observation_id|after_observation_id/u)
    assert.match(JSON.stringify(changeTool.input_schema ?? changeTool.inputSchema ?? {}), /comparison_id/u)
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
      const installedPreset = readFileSync(join(mapHome, '.agent-presets', 'map-analyst', 'agent.cordis.yml'), 'utf8')
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
  const mapHome = join(temp, 'map-home')
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
        MAPHARNESS_HOME: mapHome,
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
    await installScopedStorageKey(context)
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
    await installScopedStorageKey(context2)
    const page2 = await context2.newPage()
    await page2.goto(url)
    await maybeContinueNotice(page2)
    const catalogSessions = readdirSync(join(mapHome, 'spatial-store', 'sessions'), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    assert.equal(catalogSessions.length, 1, `expected one persisted catalog Session, got ${catalogSessions}`)
    const persistedSessionId = catalogSessions[0]
    const persistedRow = page2.locator('[role="treeitem"]').filter({ hasText: 'map chain' }).first()
    await persistedRow.waitFor({ timeout: 15_000 })
    await persistedRow.click()
    await page2.waitForFunction(id => {
      const current = JSON.parse(localStorage.getItem(globalThis.scopedStorageKey('dsh.sessions.current')) ?? 'null')
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

test('P3-visualization: viz_classify styles the map and the unified layer row carries the class ramp', { timeout: 180_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-web-qualification-'))
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
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
  let titleRequests = 0
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (isTitleRequest(parsed)) {
        titleRequests += 1
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
  let page
  let handedOff = false
  const stdout = { value: '' }
  const stderr = { value: '' }
  const pageErrors = []
  try {
    const providerPort = await listen(provider)
    const env = {
      ...process.env,
      MAPHARNESS_HOME: mapHome,
      DSH_HOME: home,
      DEEPSEEK_API_KEY: 'viz-composition-test',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
      DSH_TELEMETRY_MODE: 'DISABLED',
    }
    if (env.MAP_APPLICATION_MINIMAL_PATH === '1') env.PATH = qualificationPlatform(process.platform, env).path
    const serviceLauncher = env.MAP_APPLICATION_LAUNCHER
    const serviceArgs = ['--patch', pickerPatch, '--host', '127.0.0.1', '--port', '0', '--no-open']
    const windowsLauncher = serviceLauncher !== undefined && process.platform === 'win32'
      ? windowsLauncherInvocation(serviceLauncher, serviceArgs, env) : undefined
    app = spawn(serviceLauncher === undefined ? process.execPath : windowsLauncher?.command ?? serviceLauncher,
      serviceLauncher === undefined ? [mapBin, ...serviceArgs] : windowsLauncher ? [windowsLauncher.commandLine] : serviceArgs, {
      cwd: serviceLauncher === undefined ? workspace : env.MAP_APPLICATION_CWD ?? workspace,
      env: windowsLauncher?.env ?? env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: windowsLauncher !== undefined,
    })
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 720 }, hasTouch: true })
    page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(String(error)))
    await useFixtureBasemap(page)
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

    // ── the unified panel row carries the same style version the map paints ──
    await openUnifiedMapPanel(page, 'ai')
    const zonesRows = page.locator('[data-map-panel-layer]')
    await zonesRows.first().waitFor({ timeout: 15_000 })
    assert.equal(await zonesRows.count(), 1, 'the classified map holds one layer row')
    const zonesRow = zonesRows.first()
    const classSwatches = zonesRow.locator('[data-map-panel-chip] span[role="img"]')
    await classSwatches.first().waitFor({ timeout: 15_000 })
    assert.equal(await classSwatches.count() >= 3, true, 'the classified row lists every class swatch')
    assert.match(await classSwatches.first().getAttribute('aria-label') ?? '', /\d/, 'each class swatch names its class')

    // The receipt attests the classified style rendered on one concrete view.
    const receipt = await waitForRenderedReceipt(page)
    assert.equal(receipt.failedLayers.length, 0)
    assert.equal(receipt.renderedRevision, receipt.revision)
    const evidenceDir = env.MAP_FACILITY_ARTIFACTS
    const assertTabColors = async () => {
      const colors = await page.locator('[data-map-panel-tabs] [role="tab"]').evaluateAll(tabs => tabs.map(tab => {
        const component = getComputedStyle(tab)
        const body = getComputedStyle(document.body)
        const normalize = value => {
          const probe = document.createElement('span')
          probe.style.color = value
          document.body.append(probe)
          const resolved = getComputedStyle(probe).color
          probe.remove()
          return resolved
        }
        return { selected: tab.getAttribute('aria-selected'), color: component.color, primary: normalize(body.getPropertyValue('--dsw-alias-label-primary')), secondary: normalize(body.getPropertyValue('--dsw-alias-label-secondary')) }
      }))
      for (const color of colors) assert.equal(color.color, color.selected === 'true' ? color.primary : color.secondary, JSON.stringify(color))
    }
    await assertTabColors()
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true })
      await page.screenshot({ path: join(evidenceDir, 'ui-desktop-light.png'), fullPage: true })
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'))
      await page.waitForFunction(() => {
        const tab = document.querySelector('[data-map-panel-tabs] [role="tab"][aria-selected="true"]')
        const probe = document.createElement('span')
        probe.style.color = 'var(--dsw-alias-label-primary)'
        document.body.append(probe)
        const matches = tab !== null && getComputedStyle(tab).color === getComputedStyle(probe).color
        probe.remove()
        return matches
      })
      await assertTabColors()
      await page.screenshot({ path: join(evidenceDir, 'ui-desktop-dark.png'), fullPage: true })
      await page.emulateMedia({ colorScheme: 'light' })
    }
    const touchContext = await browser.newContext({
      locale: 'zh-CN', viewport: { width: 390, height: 844 }, hasTouch: true,
      storageState: await context.storageState(),
    })
    try {
      const touchPage = await touchContext.newPage()
      await useFixtureBasemap(touchPage)
      await touchPage.goto(url)
      const touchMap = touchPage.locator('[data-map-container]:visible')
      await touchMap.waitFor({ timeout: 30_000 })
      await waitForRenderedReceipt(touchPage)
      const touchCard = touchMap.locator('[data-map-panel][data-map-panel-surface="unified"]')
      const touchChevron = touchCard.locator('[data-map-panel-collapse]')
      const navigation = touchMap.locator('[data-mapbox-ctrl-top-right]')
      const footer = touchMap.locator('.esri-view-attribution')
      await footer.waitFor({ state: 'visible' })
      const footerBox = await footer.boundingBox()
      assert.ok(footerBox !== null && footerBox.height > 22, 'the narrow SDK attribution wraps')
      for (const selector of ['[data-mapbox-ctrl-scale]', '[data-mapbox-ctrl-attrib-button]']) {
        const control = await touchMap.locator(selector).boundingBox()
        assert.ok(control !== null && control.y + control.height <= footerBox.y,
          `${selector} overlaps the SDK attribution: ${JSON.stringify({ control, footerBox })}`)
      }
      const attribution = touchMap.locator('[data-mapbox-ctrl-attrib-button]')
      await attribution.tap()
      assert.equal(await attribution.getAttribute('aria-expanded'), 'true')
      assert.match(await touchMap.locator('[data-mapbox-ctrl-attrib-inner]').innerText(), /Esri/)
      await attribution.tap()
      const checkClearance = async () => {
        const panelBox = await touchCard.boundingBox()
        const navBox = await navigation.boundingBox()
        assert.ok(panelBox !== null && navBox !== null && panelBox.x + panelBox.width <= navBox.x,
          `touch panel overlaps navigation: ${JSON.stringify({ panelBox, navBox })}`)
      }
      assert.equal(await touchChevron.getAttribute('aria-expanded'), 'false')
      await checkClearance()
      if (evidenceDir) await touchPage.screenshot({ path: join(evidenceDir, 'ui-touch-390.png'), fullPage: true })
      await touchChevron.tap()
      for (const section of ['annotation', 'ai', 'imagery']) {
        const tab = touchCard.locator(`[data-map-panel-tab="${section}"]`)
        await tab.tap()
        await touchCard.locator(`[data-map-panel-tab-body="${section}"]`).waitFor({ state: 'visible' })
        assert.equal(await tab.locator('..').getAttribute('aria-selected'), 'true')
        await touchPage.waitForFunction(section => {
          const button = document.querySelector(`[data-map-panel-tab="${section}"]`)?.closest('[role="tab"]')
          if (button === null || button === undefined) return false
          const selected = getComputedStyle(button).color
          const other = button.parentElement.querySelector('[role="tab"][aria-selected="false"]')
          return other !== null && selected !== getComputedStyle(other).color
        }, section)
        await checkClearance()
        if (evidenceDir) await touchPage.screenshot({ path: join(evidenceDir, `ui-touch-${section}.png`), fullPage: true })
      }
      const zoom = await touchPage.evaluate(() => [...(window.__mapHarness?.values() ?? [])].at(-1)?.camera?.zoom)
      assert.ok(Number.isFinite(zoom), 'the touch view has a readable camera')
      await navigation.locator('[data-mapbox-ctrl-zoom-in]').tap()
      await touchPage.waitForFunction(before => [...(window.__mapHarness?.values() ?? [])].at(-1)?.camera?.zoom > before, zoom)
    } finally {
      await touchContext.close()
    }
    await closeUnifiedMapPanel(page)

    await page.reload()
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.styledLayers?.includes('zones'))
    }, undefined, { timeout: 30_000 })
    if (env.MAP_FACILITY_ARTIFACTS) {
      mkdirSync(env.MAP_FACILITY_ARTIFACTS, { recursive: true })
      await page.screenshot({ path: join(env.MAP_FACILITY_ARTIFACTS, 'qualification-workbench.png'), fullPage: true })
    }
    if (env.MAP_APPLICATION_RUNTIME_REPORT) {
      writeFileSync(env.MAP_APPLICATION_RUNTIME_REPORT, JSON.stringify({
        format: 'map-application-runtime-report-1', temp, home, workspace, provider: 'synthetic',
      }, null, 2) + '\n')
      handedOff = true
    }
  } catch (error) {
    let pageText = ''
    if (page) {
      try {
        pageText = (await page.locator('body').innerText({ timeout: 2_000 })).slice(-6_000)
      } catch (readError) {
        pageText = `Unable to read page: ${String(readError)}`
      }
      if (process.env.MAP_FACILITY_ARTIFACTS) {
        try {
          mkdirSync(process.env.MAP_FACILITY_ARTIFACTS, { recursive: true })
          await page.screenshot({ path: join(process.env.MAP_FACILITY_ARTIFACTS, 'qualification-failure.png'), fullPage: true })
        } catch (screenshotError) {
          pageErrors.push(`Unable to capture page: ${String(screenshotError)}`)
        }
      }
    }
    const diagnostics = { mainRequests, titleRequests, pageErrors, pageText,
      exitCode: app?.exitCode, stderr: stderr.value.slice(-6_000).replace(/([?&]token=)[^\s&]+/gu, '$1[redacted]') }
      throw new Error(`Web qualification scenario failed: ${JSON.stringify(diagnostics)}`)
  } finally {
    let cleaned = false
    try {
      try {
        if (browser) await browser.close()
      } finally {
        try {
          if (app) {
            await stopProcessTree(app)
            if (app.exitCode === null && app.signalCode === null) {
              await new Promise((resolveExit, reject) => {
                const timer = setTimeout(() => reject(new Error('qualification app did not exit after kill')), 5_000)
                app.once('exit', () => { clearTimeout(timer); resolveExit() })
              })
            }
          }
        } finally {
          provider.closeAllConnections()
          await new Promise(resolveClose => provider.close(resolveClose))
        }
      }
      cleaned = true
    } finally {
      if (cleaned && !handedOff) rmSync(temp, { recursive: true, force: true })
    }
  }
})

test('rendered pixels: the classified polygons paint the map band, survive the 3D switch, and clear on removal', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-pixels-composition-'))
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
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
        MAPHARNESS_HOME: mapHome,
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
    await installScopedStorageKey(context)
    page = await context.newPage()
    await useFixtureBasemap(page)
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await sendMessage(page, '请登记 parcels.geojson，加载为 parcels 图层，按 score 等距分三级并移动到两个地块。')

    // The map tab occurrence is the band a person sees; it must be visible for
    // any pixel measurement.
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

    // Round 3 folded the classification: the panel chip derives from the same
    // style version the map paints, so its darkest class color is the exact
    // color the canvas must show where the top-class polygon sits.
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map
        && [...harness.values()].some(value => (value.styledLayers ?? []).includes('parcels'))
    }, undefined, { timeout: 30_000 })
    await openUnifiedMapPanel(page, 'ai')
    const parcelsRows = page.locator('[data-map-panel-layer]')
    await parcelsRows.first().waitFor({ timeout: 30_000 })
    assert.equal(await parcelsRows.count(), 1, 'the map holds the single parcels layer')
    const parcelsRow = parcelsRows.first()
    const classColor = await darkestRowChipColor(parcelsRow, 3)
    // Close the card so the pixel band holds only the map canvas.
    await closeUnifiedMapPanel(page)
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
    // The default AMap reference labels are a 2D-only source: a real user turns
    // them off before the 3D switch so the scene descriptor resolves the World
    // Imagery basemap instead of reporting an honest source failure.
    const imageryPanel = await openUnifiedMapPanel(page, 'imagery')
    const labelsToggle = imageryRow(imageryPanel, 'labels').locator('[data-map-panel-eye]')
    await labelsToggle.click()
    await imageryRow(imageryPanel, 'labels').locator('[data-map-panel-eye][aria-pressed="false"]').waitFor()
    await closeUnifiedMapPanel(page)
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
  const mapHome = join(temp, 'map-home')
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
          // An off-center L-shaped reference: the paired before/after
          // screenshots must show it translate and grow, never a blank canvas.
          { id: 'g-draw', name: 'map_draw', input: { kind: 'polygon', coordinates: [[116.28, 39.82], [116.5, 39.82], [116.5, 39.9], [116.38, 39.9], [116.38, 39.98], [116.28, 39.98]], layer_id: 'gesture-ref', name: '参照区域' } },
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
        MAPHARNESS_HOME: mapHome,
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
    await installScopedStorageKey(context)
    page = await context.newPage()
    // Every implicit viewport report the page posts, in arrival order.
    const viewportPosts = []
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/map/viewport')) {
        viewportPosts.push(JSON.parse(request.postData() ?? '{}'))
      }
    })
    const evidenceDir = join(root, '.spec', 'specs', '2026-11-13_fix-map-canvas-gestures', 'evidence')
    mkdirSync(evidenceDir, { recursive: true })
    /** The live SDK camera of the session's one map occurrence. */
    const cameraOf = () => page.evaluate(() => [...(window.__mapHarness?.values() ?? [])][0]?.camera ?? null)
    /** The elementFromPoint hit chain at one screen point, with its view-surface verdict. */
    const hitProbeAt = (x, y) => page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y)
      const path = []
      let node = target
      while (node !== null && path.length < 6) {
        const cls = typeof node.className === 'string' ? node.className.split(/\s+/).slice(0, 3).join('.') : ''
        path.push(`${node.tagName}.${cls}`)
        node = node.parentElement
      }
      return { path, onViewSurface: target !== null && target.closest('.esri-view-surface') !== null }
    }, { x, y })
    const dragFrom = async (x, y) => {
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 80, y + 20, { steps: 10 })
      await page.mouse.up()
    }
    const settle = ms => new Promise(resolve => setTimeout(resolve, ms))
    const round4 = value => Math.round(value * 10_000) / 10_000
    /** The viewport report carries the view SR (3857 meters); the diagnostic camera carries WGS84 degrees. */
    const mercatorOf = ([lon, lat]) => [
      lon * 20_037_508.34 / 180,
      6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)),
    ]
    const nearMercator = (projected, posted) => Math.abs(projected[0] - posted[0]) < 100
      && Math.abs(projected[1] - posted[1]) < 100
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useFixtureBasemap(page)
    // The default AMap labels carrier also loads real street tiles; pin it to
    // the same white fixture so captured evidence stays byte-stable.
    const whiteTile = Buffer.from(await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 256
      const context = canvas.getContext('2d')
      if (context === null) throw new Error('gesture lane needs a 2D canvas')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, 256, 256)
      return canvas.toDataURL('image/png').split(',')[1]
    }), 'base64')
    await page.route('https://wprd01.is.autonavi.com/**', route =>
      route.fulfill({ contentType: 'image/png', body: whiteTile }))
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
    // The view-sync camera writes (map_set_view plus the new layer's framing)
    // hold a programmatic mute pulse — let it expire so the drag is
    // attributed to the user.
    await settle(1_800)

    // ── compact layout: a real drag, then a real wheel ────────────────────
    const band = await mapBand.boundingBox()
    assert.ok(band.width < 590, `the default right panel hosts the compact map form (band ${band.width}px)`)
    const dragX = band.x + band.width * 0.15
    const dragY = band.y + band.height * 0.75
    const compactHit = await hitProbeAt(dragX, dragY)
    assert.equal(compactHit.onViewSurface, true,
      `the compact drag origin must reach the ArcGIS view surface, hit ${JSON.stringify(compactHit.path)}`)
    const cameraBefore = await cameraOf()
    assert.notEqual(cameraBefore, null, 'the live camera is readable before the drag')
    const postBeforeDrag = viewportPosts.at(-1)?.viewport
    assert.ok(postBeforeDrag !== undefined, 'the initial settle posts a viewport report')
    await mapBand.screenshot({ path: join(evidenceDir, '01-compact-before.png') })
    await dragFrom(dragX, dragY)
    await settle(2_500)
    const cameraAfterDrag = await cameraOf()
    assert.ok(cameraAfterDrag !== null && cameraBefore !== null
      && (Math.abs(cameraAfterDrag.center[0] - cameraBefore.center[0]) > 0.005
        || Math.abs(cameraAfterDrag.center[1] - cameraBefore.center[1]) > 0.005),
      `a real drag must move the live camera: ${JSON.stringify({ cameraBefore, cameraAfterDrag })}`)
    await mapBand.screenshot({ path: join(evidenceDir, '02-compact-drag-after.png') })
    const postDrag = viewportPosts.at(-1)?.viewport
    assert.ok(postDrag !== undefined && postDrag !== postBeforeDrag, 'the settled camera posts a viewport report')
    assert.ok(cameraAfterDrag !== null && nearMercator(mercatorOf(cameraAfterDrag.center), postDrag.center),
      `the newest viewport report carries the dragged camera: ${JSON.stringify({ projected: mercatorOf(cameraAfterDrag.center), postDrag })}`)
    assert.equal(bodies.length, 2, 'a user drag never starts a model request')

    await page.keyboard.press('Escape')
    const wheelHit = await hitProbeAt(dragX, dragY)
    assert.equal(wheelHit.onViewSurface, true, 'the wheel origin stays on the view surface')
    const zoomBeforeWheel = (await cameraOf())?.zoom
    await page.mouse.move(dragX, dragY)
    await page.mouse.wheel(0, -240)
    await settle(2_500)
    const cameraAfterWheel = await cameraOf()
    assert.ok(cameraAfterWheel !== null && zoomBeforeWheel !== undefined
      && Math.abs(cameraAfterWheel.zoom - zoomBeforeWheel) > 0.01,
      `a real wheel must change the live zoom: ${JSON.stringify({ zoomBeforeWheel, cameraAfterWheel })}`)
    await mapBand.screenshot({ path: join(evidenceDir, '03-compact-wheel-after.png') })
    const postWheel = viewportPosts.at(-1)?.viewport
    assert.ok(postWheel !== undefined && cameraAfterWheel !== null
      && Math.abs(postWheel.zoom - cameraAfterWheel.zoom) < 1e-3
      && nearMercator(mercatorOf(cameraAfterWheel.center), postWheel.center),
      `the newest viewport report carries the zoomed camera: ${JSON.stringify({ postWheel, cameraAfterWheel })}`)
    assert.equal(bodies.length, 2, 'a wheel gesture never starts a model request')

    await sendMessage(page, '这里有什么？')
    for (let waited = 0; waited < 30_000 && bodies.length < 3; waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    assert.ok(bodies[2]?.includes('用户视窗:'), 'the next request carries the user viewport as context')
    const viewportLine = bodies[2]?.match(/用户视窗:[^"\\]*/u)?.[0] ?? ''
    const lineMatch = viewportLine.match(/center=\[(-?[\d.]+), (-?[\d.]+)\] zoom=(-?[\d.]+)/u)
    assert.ok(lineMatch !== null, `the viewport line renders the camera: ${viewportLine.slice(0, 80)}`)
    assert.ok(postWheel !== undefined
      && Math.abs(Number(lineMatch[1]) - round4(postWheel.center[0])) < 1e-4
      && Math.abs(Number(lineMatch[2]) - round4(postWheel.center[1])) < 1e-4
      && Math.abs(Number(lineMatch[3]) - round4(postWheel.zoom)) < 1e-4,
      `the model reasons over the post-gesture camera, not the initial one: ${viewportLine.slice(0, 80)}`)
    assert.ok(!bodies.some(body => body.includes('[map-gesture v1]')), 'no gesture text ever enters the conversation')
    await settle(1_000)

    // Collapse the resident card before measuring bare-canvas gestures.
    await page.setViewportSize({ width: 700, height: 800 })
    await page.waitForFunction(() => document.querySelector('[data-map-overlay-content]')?.getAttribute('data-map-rail') === 'wide',
      undefined, { timeout: 15_000 })
    const wideBand = await mapBand.boundingBox()
    assert.ok(wideBand.width > 590, `the fullscreen panel hosts the wide rail (band ${wideBand.width}px)`)
    const wideRail = mapBand.locator('[data-map-overlay-content][data-map-rail="wide"]')
    await closeUnifiedMapPanel(wideRail)
    assert.equal(await wideRail.locator('[data-map-panel][data-map-panel-collapsed]').count(), 1,
      'the wide rail keeps one collapsed resident card')
    const wideDragX = wideBand.x + wideBand.width * 0.65
    const wideDragY = wideBand.y + wideBand.height * 0.45
    await page.keyboard.press('Escape')
    const wideHit = await hitProbeAt(wideDragX, wideDragY)
    assert.equal(wideHit.onViewSurface, true,
      `the wide-rail drag origin must reach the view surface, hit ${JSON.stringify(wideHit.path)}`)
    const wideBefore = await cameraOf()
    await mapBand.screenshot({ path: join(evidenceDir, '04-wide-before.png') })
    await dragFrom(wideDragX, wideDragY)
    await settle(2_500)
    const wideAfter = await cameraOf()
    assert.ok(wideAfter !== null && wideBefore !== null
      && (Math.abs(wideAfter.center[0] - wideBefore.center[0]) > 0.005
        || Math.abs(wideAfter.center[1] - wideBefore.center[1]) > 0.005),
      `a wide-rail drag must move the live camera: ${JSON.stringify({ wideBefore, wideAfter })}`)
    assert.equal(bodies.length, 3, 'a wide-rail gesture never starts a model request')

    const widePanel = await openUnifiedMapPanel(wideRail, 'ai')
    assert.deepEqual(
      await widePanel.locator('[data-map-panel-tab]').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('data-map-panel-tab'))),
      ['imagery', 'ai', 'annotation'],
      'the expanded card hosts its three tabs')
    const openDragX = wideBand.x + wideBand.width * 0.78
    await page.keyboard.press('Escape')
    const openHit = await hitProbeAt(openDragX, wideDragY)
    assert.equal(openHit.onViewSurface, true,
      `the drag origin beside an open rail card must reach the view surface, hit ${JSON.stringify(openHit.path)}`)
    const openBefore = await cameraOf()
    await dragFrom(openDragX, wideDragY)
    await settle(2_500)
    const openAfter = await cameraOf()
    assert.ok(openAfter !== null && openBefore !== null
      && (Math.abs(openAfter.center[0] - openBefore.center[0]) > 0.005
        || Math.abs(openAfter.center[1] - openBefore.center[1]) > 0.005),
      `a drag beside the open rail card must move the live camera: ${JSON.stringify({ openBefore, openAfter })}`)
    await mapBand.screenshot({ path: join(evidenceDir, '05-wide-after.png') })
    assert.equal(bodies.length, 3, 'gestures around the open panel never start a model request')
    const postWide = viewportPosts.at(-1)?.viewport
    assert.ok(postWide !== undefined && openAfter !== null
      && nearMercator(mercatorOf(openAfter.center), postWide.center),
      'the newest viewport report carries the wide-layout camera')

    writeFileSync(join(evidenceDir, 'gesture-camera.json'), JSON.stringify({
      compact: { cameraBefore, cameraAfterDrag, cameraAfterWheel },
      wide: { wideBefore, wideAfter, openBefore, openAfter },
      modelRequests: bodies.length,
    }, null, 2))
    writeFileSync(join(evidenceDir, 'gesture-hit-targets.json'), JSON.stringify({
      compactDrag: compactHit, compactWheel: wheelHit, wideCollapsed: wideHit, wideOpenPanel: openHit,
    }, null, 2))
    writeFileSync(join(evidenceDir, 'viewport-requests.json'), JSON.stringify({ posts: viewportPosts }, null, 2))
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
  const mapHome = join(temp, 'map-home')
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
        const notices = messages.filter(message => message.role === 'user' && /\[map-user-change v\d/u.test(textOf(message)))
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
        MAPHARNESS_HOME: mapHome,
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
    await installScopedStorageKey(context)
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
    await openUnifiedMapPanel(page, 'ai')
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-map-panel-layer]')]
      return rows.length >= 2 && rows.every(row => row.querySelector('[data-map-panel-eye]') !== null)
    }, undefined, { timeout: 30_000 })
    assert.equal(await page.locator('[data-map-panel-group]').count(), 0, 'ordinary layers render as one flat list')
    await waitForRenderedReceipt(page)

    const alphaRow = page.locator('[data-map-panel-layer]', { hasText: 'Alpha' })
    const betaRow = page.locator('[data-map-panel-layer]', { hasText: 'Beta' })
    const eyeOf = row => row.locator('[data-map-panel-eye]')
    assert.equal(await eyeOf(alphaRow).getAttribute('aria-pressed'), 'true')
    assert.equal(await eyeOf(betaRow).getAttribute('aria-pressed'), 'true')
    const turnsBefore = await page.evaluate(() => document.querySelectorAll('[data-map-tool-card]').length)

    // (1) Flat rows have no group eye; two individual eyes hide both members
    // with no model turn.
    await eyeOf(alphaRow).click()
    await eyeOf(betaRow).click()
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
    assert.match(notices, /隐藏了图层：Alpha/)
    assert.match(notices, /隐藏了图层：Beta/)
    assert.match(notices, /调整了图层叠放顺序/)
    assert.equal(await eyeOf(alphaRow).getAttribute('aria-pressed'), 'false', 'reading the notice changes nothing')

    // (5) The menu's download entry streams the exact registered bytes.
    const downloadPromise = page.waitForEvent('download', { timeout: 30_000 })
    await alphaRow.getByRole('button', { name: 'Alpha 的更多操作' }).click()
    const operationDialog = page.getByRole('dialog')
    await operationDialog.getByRole('button', { name: `下载引用 ${sourceRef}` }).click()
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
test('layer workbench: autonomous import decisions land as layers, and honest rejections leave no residue', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-lw-import-'))
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
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
        // Select the fixture's known coordinate columns without another user turn.
        const fingerprint = [...transcripts.at(-1).matchAll(/candidates_fingerprint\\?":\\?"([0-9a-f]{64})/g)].map(match => match[1]).at(-1)
        assert.ok(fingerprint, 'the confirmation fingerprint is in the transcript')
        response.end(toolResponse([
          { id: 'lw-import-confirm', name: 'data_import', input: { path: 'hospitals.csv', name: 'hospitals', lon_column: 'x', lat_column: 'y', confirm: { fingerprint } } },
          { id: 'lw-import-roads', name: 'data_import', input: { path: 'roads.shp.zip', name: 'roads' } },
        ]))
      } else if (mainRequests === 3) {
        const refs = [...new Set([...transcripts.at(-1).matchAll(/res-[a-f0-9]{24}@v1/g)].map(match => match[0]))]
        assert.equal(refs.length, 2, `both imports published resources (saw ${refs})`)
        response.end(toolResponse([
          { id: 'lw-add-hospitals', name: 'map_add_layer', input: { ref: refs[0], layer_id: 'hospitals', name: '医院' } },
          { id: 'lw-add-roads', name: 'map_add_layer', input: { ref: refs[1], layer_id: 'roads', name: '道路' } },
          { id: 'lw-view', name: 'map_set_view', input: { center: [116.4, 39.91], zoom: 11, wkid: 4326 } },
        ]))
      } else if (mainRequests === 4) {
        response.end(textResponse('导入完成：医院与道路两个图层已上图。'))
      } else if (mainRequests === 5) {
        response.end(toolResponse([
          { id: 'lw-import-broken', name: 'data_import', input: { path: 'truncated.shp.zip', name: 'broken' } },
        ]))
      } else if (mainRequests === 6) {
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
        MAPHARNESS_HOME: mapHome,
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
    await installScopedStorageKey(context)
    page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useFixtureBasemap(page)
    const mapBand = page.locator('[data-map-container]:not([data-map-view])')

    // One request covers the candidate decision, fingerprint retry and both layers.
    await sendMessage(page, '请把 hospitals.csv 导入并放到地图上。')
    await mapBand.waitFor({ state: 'visible', timeout: 30_000 })
    await openUnifiedMapPanel(page, 'ai')
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
    assert.ok(transcripts.some(text => text.includes('choose the supported candidates')))
    const screenshotDir = process.env.MAP_UI_REVIEW_EVIDENCE
    if (screenshotDir !== undefined) {
      mkdirSync(screenshotDir, { recursive: true })
      await page.screenshot({ path: join(screenshotDir, 'autonomous-import.png'), fullPage: true })
    }

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
    assert.equal(mainRequests >= 7, true, `the scripted chain ran to completion (${mainRequests} rounds)`)
  } catch (error) {
    const dom = await page?.locator('body').innerText({ timeout: 2000 }).catch(() => 'DOM unavailable')
    console.error('autonomous import failed:', error, '\nDOM:', dom, '\nrequests:', mainRequests)
    throw error
  } finally {
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined) await stopProcessTree(app)
    provider.closeAllConnections()
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

test('layer workbench: styles, legend chips and panel requests stay consistent through the model round', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-lw-styles-'))
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
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
   * Temporarily conceal the panel while sampling map pixels so markers behind
   * the floating card remain measurable without counting the card's swatches.
   * @param page - the driven page.
   * @param rgb - the target channel triple.
   * @param expected - `present` or `absent`.
   * @returns the last measurement.
   */
  async function waitForMapColorBesidePanel(page, rgb, expected) {
    const deadline = Date.now() + 30_000
    let last
    const panel = page.locator('[data-map-panel]').first()
    const originalVisibility = await panel.evaluate(element => element.style.visibility)
    await panel.evaluate(element => { element.style.visibility = 'hidden' })
    try { for (;;) {
      const box = await page.locator('[data-map-container]:not([data-map-view])').boundingBox()
      if (box === null) throw new Error('no map container box')
      const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.max(2, Math.floor(box.width)), height: Math.max(2, Math.floor(box.height)) }
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
      const absentLimit = Math.max(8, Math.floor(last.total / 2_000))
      const holds = expected === 'present' ? last.count >= 60 : last.count <= absentLimit
      if (holds) return { ...last, screenshot: shot.toString('base64') }
      if (Date.now() > deadline) {
        if (process.env.MAP_UI_REVIEW_EVIDENCE) {
          mkdirSync(process.env.MAP_UI_REVIEW_EVIDENCE, { recursive: true })
          await page.screenshot({ path: join(process.env.MAP_UI_REVIEW_EVIDENCE, 'layer-color-failure.png') })
        }
        assert.fail(`beside-panel ${expected} check for rgb(${rgb.join(', ')}) failed after 30000 ms: ${last.count}/${last.total} matching pixels`)
      }
      await new Promise(resolve => setTimeout(resolve, 400))
    } } finally { await panel.evaluate((element, value) => { element.style.visibility = value }, originalVisibility) }
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
        MAPHARNESS_HOME: mapHome,
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
    await installScopedStorageKey(context)
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
    // The unified card is closed on the compact band; open its layer tab through
    // the real launcher before reading or expecting panel rows.
    await openUnifiedMapPanel(page, 'ai')
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-map-panel-layer]')]
      return rows.length === 2 && rows.every(row => row.querySelector('[data-map-panel-eye]')?.getAttribute('aria-pressed') === 'true')
    }, undefined, { timeout: 60_000 })
    await waitForRenderedReceipt(page)

    // The chip's point-symbol color is the pixel oracle for the preset.
    const hospitalSwatch = page.locator('[data-map-panel-layer]', { hasText: '医院' })
      .locator('[data-map-panel-swatch] [data-map-panel-badge] > span').first()
    await hospitalSwatch.waitFor({ state: 'attached', timeout: 15_000 })
    const chipColor = await hospitalSwatch.evaluate(span => getComputedStyle(span).backgroundColor)
    const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/u.exec(chipColor)
    assert.ok(match !== null, `the chip color parses (${chipColor})`)
    const presetRgb = [Number(match[1]), Number(match[2]), Number(match[3])]
    const painted = await waitForMapColorBesidePanel(page, presetRgb, 'present')
    assert.ok(painted.count >= 60, `the preset paints the map band with the chip color (${painted.count} px of rgb(${presetRgb.join(', ')}))`)

    // M2: per-feature overrides repaint all three markers and the swatch blue.
    await sendMessage(page, '把三个医院要素都改成蓝色。')
    await page.getByText('三个医院要素已改为蓝色。', { exact: true }).waitFor({ timeout: 60_000 })
    const repainted = await waitForMapColorBesidePanel(page, [0, 85, 255], 'present')
    assert.ok(repainted.count >= 60, `the overrides repaint the markers (${repainted.count} px)`)
    await waitForMapColorBesidePanel(page, presetRgb, 'absent')
    const overrideSwatches = await page.locator('[data-map-panel-layer]', { hasText: '医院' }).locator('[data-map-panel-badge] > span').evaluateAll(spans => spans.map(span => getComputedStyle(span).backgroundColor))
    assert.deepEqual(overrideSwatches, ['rgb(0, 85, 255)'])

    // Panel user write: hiding both layers applies at once, without a model
    // turn. The flat row list exposes one eye per layer.
    await page.locator('[data-map-panel-layer]', { hasText: '医院' }).locator('[data-map-panel-eye]').click()
    await page.locator('[data-map-panel-layer]', { hasText: '道路' }).locator('[data-map-panel-eye]').click()
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
      badge: row.querySelector('[data-map-panel-swatch]')?.getAttribute('data-kind') ?? '',
    })))
    assert.ok(badges.some(row => row.text.includes('医院') && row.badge === 'heatmap'), `the hospital layer carries the heatmap badge (${JSON.stringify(badges)})`)
    assert.ok(badges.some(row => row.text.includes('底图影像') && row.badge === 'imagery'), `the imagery layer carries the imagery badge (${JSON.stringify(badges)})`)
    await page.locator('[data-map-panel-layer]', { hasText: '医院' }).locator('[data-map-panel-ramp] > span').first().waitFor({ timeout: 15_000 })
    const heatmapStops = await page.locator('[data-map-panel-layer]', { hasText: '医院' })
      .locator('[data-map-panel-ramp] > span').count()
    assert.ok(heatmapStops >= 3, `the heatmap chip shows the ramp stops (${heatmapStops})`)
    const finalReceipt = await waitForRenderedReceipt(page)
    assert.equal(finalReceipt.failedLayers.length, 0, 'the heatmap and imagery layers render without failures')

    // Hide the opaque imagery fixture so the white basemap detects a heatmap
    // that paints zero-density pixels; positive density must still be visible.
    const imageryRow = page.locator('[data-map-panel-layer]', { hasText: '底图影像' })
    await imageryRow.locator('[data-map-panel-eye]').click()
    await page.waitForFunction(() => [...document.querySelectorAll('[data-map-panel-layer]')]
      .find(row => row.textContent?.includes('底图影像'))?.querySelector('[data-map-panel-eye]')?.getAttribute('aria-pressed') === 'false')
    await waitForRenderedReceipt(page)
    const background = await waitForMapColorBesidePanel(page, [255, 255, 255], 'present')
    assert.ok(background.count > background.total / 2, 'zero-density heatmap pixels preserve the white basemap')
    await page.locator('[data-map-panel-layer]', { hasText: '医院' }).locator('[data-map-panel-eye]').click()
    await page.waitForFunction(() => [...document.querySelectorAll('[data-map-panel-layer]')]
      .find(row => row.textContent?.includes('医院'))?.querySelector('[data-map-panel-eye]')?.getAttribute('aria-pressed') === 'false')
    await waitForRenderedReceipt(page)
    const hidden = await waitForMapColorBesidePanel(page, [255, 255, 255], 'present')
    const changed = await page.evaluate(async ({ shown, hidden }) => {
      async function pixels(encoded) {
        const blob = await (await fetch(`data:image/png;base64,${encoded}`)).blob()
        const bitmap = await createImageBitmap(blob)
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext('2d')
        context.drawImage(bitmap, 0, 0)
        return context.getImageData(0, 0, bitmap.width, bitmap.height).data
      }
      const before = await pixels(shown)
      const after = await pixels(hidden)
      if (before.length !== after.length) throw new Error('heatmap visibility changed the sampled map band dimensions')
      let count = 0
      for (let at = 0; at < before.length; at += 4) {
        if ([0, 1, 2].some(channel => Math.abs(before[at + channel] - after[at + channel]) > 4)) count += 1
      }
      return count
    }, { shown: background.screenshot, hidden: hidden.screenshot })
    assert.ok(changed >= 60 && changed < background.total / 2, `heatmap visibility changes only the point-density pixels (${changed}/${background.total})`)

    const failures = stderr.value.split('\n').filter(line => /Error|error|failed|warn/.test(line)
      && !/key|token|secret|password|authorization/i.test(line)
      && !/did not activate|trace-warnings/.test(line)).slice(-6)
    assert.deepEqual(failures, [])
  } finally {
    await new Promise(resolveClose => provider.close(resolveClose))
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined) await stopProcessTree(app)
    rmSync(temp, { recursive: true, force: true })
  }
})

test('map basemap: controlled source pairs render, panel labels toggle, and a second Loader replays', { timeout: 300_000 }, async () => {
  // Adjacent regression evidence is temporary: never recreate a retired
  // task directory or write a raw Session into the repository.
  const temp = isolatedTemp(root, 'map-basemap-composition-')
  const evidenceDir = join(temp, 'evidence')
  const evidenceSecrets = proxyEvidenceSecrets(process.env.DSH_WAYBACK_PROXY_URL ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null)
  mkdirSync(evidenceDir, { recursive: true })
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const pointCollection = {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', id: 'source-point', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'source-point' } }],
  }
  writeFileSync(join(workspace, 'source-points.geojson'), JSON.stringify(pointCollection))
  writeFileSync(join(workspace, 'README.md'), '# basemap composition\n')

  let mainRequests = 0
  const providerRequests = []
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      if (isTitleRequest(parsed)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(textResponse('basemap lane'))
        return
      }
      mainRequests += 1
      providerRequests.push(parsed)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const transcript = JSON.stringify(parsed.messages)
      const lastMessage = parsed.messages.at(-1)
      const lastContent = lastMessage?.content
      const lastToolResult = Array.isArray(lastContent)
        ? lastContent.find(part => part?.type === 'tool_result')
        : undefined
      const currentText = typeof lastContent === 'string' ? lastContent
        : Array.isArray(lastContent) && lastContent[0]?.type === 'text' ? lastContent[0].text
        : ''
      if (lastToolResult?.tool_use_id === 'source-add') {
        response.end(textResponse('数据已准备。'))
      } else if (lastToolResult?.tool_use_id === 'source-view') {
        response.end(textResponse('地图已移动。'))
      } else if (lastToolResult?.tool_use_id === 'source-select') {
        response.end(textResponse('来源已切换。'))
      } else if (lastToolResult?.tool_use_id === 'source-state') {
        response.end(textResponse('状态已读取。'))
      } else if (currentText.includes('切换受控底图和注记。')) {
        response.end(toolResponse([{
            id: 'source-select',
            name: 'map_set_basemap',
            input: { source_id: 'fixture-basemap', label_source_id: 'fixture-labels' },
        }]))
      } else if (currentText.includes('读取地图状态。')) {
        response.end(toolResponse([{ id: 'source-state', name: 'map_get_state', input: {} }]))
      } else if (currentText.includes('移动地图。')) {
        response.end(toolResponse([{ id: 'source-view', name: 'map_set_view', input: { center: [116.4, 39.9], zoom: 9, wkid: 4326 } }]))
      } else if (currentText.includes('准备地图数据。')) {
        response.end(toolResponse([{ id: 'source-add', name: 'map_add_layer', input: { path: 'source-points.geojson', name: 'business', layer_id: 'business' } }]))
      } else if (currentText.includes('确认状态。')) {
        response.end(textResponse('basemap state confirmed'))
      } else {
        response.end(textResponse('context updated'))
      }
    })
  })

  const metadataCalls = []
  const tileCalls = []
  const tile = await sharp({
    create: { width: 256, height: 256, channels: 4, background: { r: 63, g: 248, b: 207, alpha: 1 } },
  }).png().toBuffer()
  const lods = Array.from({ length: 20 }, (_value, level) => ({
    level,
    resolution: 156543.03392800014 / 2 ** level,
    scale: 591657527.591555 / 2 ** level,
  }))
  const sourceServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.searchParams.get('f') === 'json') {
      metadataCalls.push(url.pathname)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        currentVersion: 11.5,
        capabilities: 'Map,Query',
        singleFusedMapCache: true,
        spatialReference: { wkid: 3857 },
        fullExtent: { xmin: -20037508.342789244, ymin: -20037508.342789244, xmax: 20037508.342789244, ymax: 20037508.342789244 },
        supportedImageFormatTypes: 'PNG32,PNG',
        tileInfo: {
          rows: 256,
          cols: 256,
          dpi: 96,
          format: 'PNG',
          origin: { x: -20037508.342789244, y: 20037508.342789244 },
          spatialReference: { wkid: 3857 },
          lods,
        },
        layers: [],
      }))
      return
    }
    tileCalls.push(url.pathname)
    response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    response.end(tile)
  })

  let app
  let browser
  let page
  const stdout = { value: '' }
  const stderr = { value: '' }
  const pageErrors = []
  const consoleErrors = []
  const controlledRouteRequests = []
  const networkFailures = []
  try {
    const providerPort = await listen(provider)
    await new Promise((resolve, reject) => sourceServer.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(undefined)))
    const sourcePort = sourceServer.address().port
    const appPort = await freePort()
    const sourcePatch = join(temp, 'basemap.patch.yml')
    writeFileSync(sourcePatch, `- id: map-container
  config:
    sources:
      custom:
        - id: fixture-basemap
          title: Fixture Basemap
          role: basemap
          adapter: arcgis-mapserver
          endpoint: http://127.0.0.1:${sourcePort}/MapServer
          nativeWkid: 3857
          supportedModes: [map, scene]
          minZoom: 0
          maxZoom: 19
          compatibleBasemapIds: []
          attribution: Fixture Base
          allowPrivateNetwork: true
          allowHttp: true
          automatedMapUse: allowed
          screenshot: allowed
        - id: fixture-labels
          title: Fixture Labels
          role: labels
          adapter: arcgis-mapserver
          endpoint: http://127.0.0.1:${sourcePort}/MapServer
          nativeWkid: 3857
          supportedModes: [map, scene]
          minZoom: 0
          maxZoom: 19
          compatibleBasemapIds: [fixture-basemap]
          attribution: Fixture Labels
          allowPrivateNetwork: true
          allowHttp: true
          automatedMapUse: allowed
          screenshot: allowed
`)
    const boot = () => spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--patch', sourcePatch,
      '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: mapHome,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'basemap-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerPort}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app = boot()
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)

    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1024, height: 768 },
      hasTouch: true,
    })
    page = await context.newPage()
    await useFixtureBasemap(page)
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('request', request => {
      if (request.url().includes('/api/map/sources/resource')) controlledRouteRequests.push(request.url())
    })
    page.on('response', response => {
      if (response.status() >= 400) {
        networkFailures.push({ url: response.url(), status: response.status() })
      }
    })
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)

    await sendMessage(page, '准备地图数据。')
    await page.locator('[data-map-container]:visible').waitFor({ timeout: 30_000 })
    await waitForCounter(() => mainRequests, 1)
    await waitForRenderedReceipt(page)
    const sessionId = await page.locator('[data-map-container]:visible').getAttribute('data-map-session')
    assert.ok(sessionId)

    await sendMessage(page, '移动地图。')
    await waitForCounter(() => mainRequests, 4)
    await page.waitForFunction(id => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.sessionId === id)
      return handle?.center[0] === 116.4 && handle?.center[1] === 39.9 && handle?.zoom === 9
    }, sessionId, { timeout: 30_000 })
    const cameraBeforeSwitch = await page.evaluate(id => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.sessionId === id)
      return handle?.camera
    }, sessionId)
    await sendMessage(page, '切换受控底图和注记。')
    await waitForCounter(() => mainRequests, 5)
    const green = await waitForMapColor(page, [63, 248, 207], 'present', { timeout: 45_000, present: 10_000 })
    assert.ok(green.count > 0)
    assert.equal(metadataCalls.length, 2, 'base and labels each verify native metadata once')
    assert.ok(tileCalls.length > 0, 'controlled tiles reach the local fixture')
    assert.ok(controlledRouteRequests.length > 0)
    assert.equal(controlledRouteRequests.some(request => request.includes(String(sourcePort))), false)
    assert.equal(controlledRouteRequests.some(request => request.includes('token=')), false)
    const sourceReceipt = await waitForRenderedReceipt(page)
    assert.deepEqual(sourceReceipt.layerVersions.map(entry => entry.id), ['basemap', 'labels', 'business'])
    const labelsDialog = await openImageryDialog(page, 'labels')
    const labelSelect = labelsDialog.locator('[data-map-panel-source="labels"]')
    assert.deepEqual(await labelSelect.locator('option').allTextContents(), ['关闭', 'Fixture Labels'])
    assert.equal(await labelSelect.inputValue(), 'fixture-labels')
    await closeImageryDialog(page, labelsDialog)
    const baseDialog = await openImageryDialog(page, 'recent')
    const baseSelect = baseDialog.locator('[data-map-panel-source="base"]')
    assert.deepEqual(await baseSelect.locator('option').allTextContents(), [
      'Esri World Imagery', 'OpenStreetMap Standard', 'Tianditu Imagery · 不可用', 'Tianditu Vector · 不可用', 'Fixture Basemap',
    ])
    assert.equal(await baseSelect.inputValue(), 'fixture-basemap')
    await closeImageryDialog(page, baseDialog)

    await sendMessage(page, '读取地图状态。')
    await waitForCounter(() => providerRequests
      .filter(request => JSON.stringify(request.messages).includes('"id":"source-state"')).length, 1)
    await waitForCounter(() => providerRequests
      .filter(request => JSON.stringify(request.messages).includes('"tool_use_id":"source-state"')).length, 1)
    const confirmationsBefore = await page.getByText('basemap state confirmed', { exact: true }).count()
    const requestsBeforeConfirmation = mainRequests
    await sendMessage(page, '确认状态。')
    await waitForCounter(() => mainRequests, requestsBeforeConfirmation + 1)
    await page.waitForFunction(expected => document.body.innerText
      .split('basemap state confirmed').length - 1 > expected, confirmationsBefore, { timeout: 30_000 })
    const stateRequest = providerRequests
      .filter(request => JSON.stringify(request.messages).includes('"tool_use_id":"source-state"'))
      .at(-1)
    assert.ok(stateRequest, 'the map state tool result reached the model')
    const stateTranscript = JSON.stringify(stateRequest.messages)
    const stateResultText = stateRequest.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(part => part?.type === 'tool_result' && part.tool_use_id === 'source-state')
      .flatMap(part => Array.isArray(part.content) ? part.content : [])
      .map(part => typeof part === 'object' && part !== null && 'text' in part ? part.text : '')
      .join('\n')
    assert.match(stateResultText, /Fixture Basemap/)
    assert.match(stateResultText, /Fixture Labels/)
    assert.match(stateResultText, /"basemap_explicit":true/)
    assert.equal(stateTranscript.includes(`127.0.0.1:${String(sourcePort)}`), false)

    await page.setViewportSize({ width: 390, height: 768 })
    const narrowImagery = await openUnifiedMapPanel(page, 'imagery')
    for (const colorScheme of ['dark', 'light']) {
      await page.emulateMedia({ colorScheme })
      await page.waitForFunction(expected => document.body.hasAttribute('data-ds-dark-theme') === expected,
        colorScheme === 'dark', { timeout: 10_000 })
      const geometry = await page.evaluate(() => {
        const sourcePanel = document.querySelector('[data-map-panel-sources]')
        if (sourcePanel === null) return null
        const box = sourcePanel.getBoundingClientRect()
        const panel = document.querySelector('[data-map-panel]')?.getBoundingClientRect()
        const container = document.querySelector('[data-map-container]')?.getBoundingClientRect()
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          panel: panel === undefined ? null : { x: panel.x, y: panel.y, width: panel.width, height: panel.height },
          container: container === undefined ? null : { x: container.x, y: container.y, width: container.width, height: container.height },
        }
      })
      assert.ok(geometry)
      writeFileSync(join(evidenceDir, `controlled-basemap-${colorScheme}-geometry.json`), JSON.stringify(geometry, null, 2))
      assert.equal(geometry.documentWidth <= geometry.viewportWidth, true)
      assert.equal(geometry.x >= 0 && geometry.y >= 0
        && geometry.x + geometry.width <= geometry.viewportWidth
        && geometry.y + geometry.height <= geometry.viewportHeight, true)
      writeFileSync(join(evidenceDir, `controlled-basemap-${colorScheme}-390.png`), await page.screenshot({ fullPage: true }))
    }
    const narrowLabelsDialog = await openImageryDialog(page, 'labels')
    await narrowLabelsDialog.locator('[data-map-panel-source="labels"]').tap()
    await page.keyboard.press('Escape')
    if (await narrowLabelsDialog.isVisible()) await closeImageryDialog(page, narrowLabelsDialog)
    const labelsRow = imageryRow(narrowImagery, 'labels')
    const labelsToggle = labelsRow.locator('[data-map-panel-eye]')
    await labelsToggle.focus()
    await page.keyboard.press('Tab')
    assert.equal(await labelsRow.getByRole('button').filter({ hasText: '⋯' }).evaluate(button => document.activeElement === button), true)
    await labelsToggle.click()
    await labelsRow.locator('[data-map-panel-eye][aria-pressed="false"]').waitFor()
    await page.waitForFunction(() => {
      const receipt = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.status === 'rendered')
      return receipt?.renderReceipt.layerVersions.some(entry => entry.id === 'labels') === false
    }, undefined, { timeout: 30_000 })
    await labelsToggle.click()
    await labelsRow.locator('[data-map-panel-eye][aria-pressed="true"]').waitFor()
    await page.waitForFunction(() => {
      const receipt = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.status === 'rendered')
      return receipt?.renderReceipt.layerVersions.some(entry => entry.id === 'labels') === true
    }, undefined, { timeout: 30_000 })
    await page.setViewportSize({ width: 1024, height: 768 })
    const cameraAfterSwitch = await page.evaluate(id => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.sessionId === id)
      return handle?.camera
    }, sessionId)
    assert.deepEqual(cameraAfterSwitch, cameraBeforeSwitch)
    const beforeRestart = await page.evaluate(() => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.status === 'rendered')
      return { revision: handle.renderReceipt.revision, layerCount: handle.layerCount, viewId: handle.renderReceipt.viewId }
    })
    assert.equal(beforeRestart.layerCount, 1)
    writeFileSync(join(evidenceDir, 'controlled-basemap.png'), await page.screenshot({ fullPage: true }))

    const sessionLogPaths = observationSessionLogs(home, mapHome, workspace)
    const matchingLogs = sessionLogPaths.map(path => ({ path, text: readObservationSessionLog(path) }))
      .filter(entry => entry.text.includes('source-select'))
    assert.ok(matchingLogs.length > 0, 'the accepted basemap change is durable')
    const sessionLog = matchingLogs[0].text
    assert.equal(sessionLog.includes(`127.0.0.1:${String(sourcePort)}`), false)
    assert.match(sessionLog, /\[map-user-change v\d+\]/)
    // Keep the Session in the isolated test home; the repository evidence only
    // needs its integrity digest and the assertions above.
    writeEvidence(evidenceDir, 'basemap-session-digest.json', JSON.stringify({
      bytes: Buffer.byteLength(sessionLog), sha256: createHash('sha256').update(sessionLog).digest('hex'),
    }), evidenceSecrets)
    writeFileSync(join(evidenceDir, 'provider-requests.json'), JSON.stringify(providerRequests, null, 2))

    await stopProcessTree(app)
    app = undefined
    app = boot()
    const secondStdout = { value: '' }
    const secondStderr = { value: '' }
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { secondStdout.value += chunk })
    app.stderr.on('data', chunk => { secondStderr.value += chunk })
    await waitForAppUrl(app, secondStdout, secondStderr)
    await page.close()
    pageErrors.length = 0
    consoleErrors.length = 0
    networkFailures.length = 0
    page = await context.newPage()
    await useFixtureBasemap(page)
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('request', request => {
      if (request.url().includes('/api/map/sources/resource')) controlledRouteRequests.push(request.url())
    })
    page.on('response', response => {
      if (response.status() >= 400) {
        networkFailures.push({ url: response.url(), status: response.status() })
      }
    })
    await page.goto(url)
    await page.locator(`[data-map-container][data-map-session="${sessionId}"]:visible`).waitFor({ timeout: 30_000 })
    await waitForMapColor(page, [63, 248, 207], 'present', { timeout: 45_000, present: 10_000 })
    const replayReceipt = await waitForRenderedReceipt(page)
    assert.equal(replayReceipt.revision, beforeRestart.revision)
    assert.notEqual(replayReceipt.viewId, beforeRestart.viewId)
    await page.waitForFunction(id => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.sessionId === id)
      return handle?.center[0] === 116.4 && handle?.center[1] === 39.9 && handle?.zoom === 9
    }, sessionId, { timeout: 30_000 })
    const replayHandle = await page.evaluate(() => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.status === 'rendered')
      return { layerCount: handle.layerCount, labels: handle.renderReceipt.layerVersions.some(entry => entry.id === 'labels') }
    })
    assert.deepEqual(replayHandle, { layerCount: 1, labels: true })
    assert.equal(metadataCalls.length, 4, 'the second Loader re-verifies both controlled sources')
    writeFileSync(join(evidenceDir, 'controlled-basemap-replay.png'), await page.screenshot({ fullPage: true }))
    writeEvidence(evidenceDir, 'app-stdout.log', stdout.value + secondStdout.value, evidenceSecrets)
    writeEvidence(evidenceDir, 'app-stderr.log', stderr.value + secondStderr.value, evidenceSecrets)

    const failures = `${stderr.value}\n${secondStderr.value}`.split('\n')
      .filter(line => /Error|error|failed|warn/.test(line)
        && !/key|token|secret|password|authorization/i.test(line)
        && !/did not activate|trace-warnings/.test(line))
      .slice(-10)
    assert.deepEqual(failures.map(line => redactEvidence(line, evidenceSecrets)), [])
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(consoleErrors, [])
  } catch (error) {
    let dom = ''
    try {
      dom = await page?.locator('body').innerText({ timeout: 2_000 }) ?? ''
      if (page !== undefined) writeFileSync(join(evidenceDir, 'failure.png'), await page.screenshot({ fullPage: true }))
    } catch (domError) {
      dom = `DOM unavailable: ${String(domError)}`
    }
    writeEvidence(evidenceDir, 'failure.json', JSON.stringify({
      error: redactEvidence(String(error), evidenceSecrets),
      url: page?.url(),
      dom: redactEvidence(dom, evidenceSecrets),
      pageErrors,
      consoleErrors,
      networkFailures,
      stdout: stdout.value,
      stderr: stderr.value,
      metadataCalls,
      tileCalls,
      controlledRouteRequests,
      providerRequests,
      handles: await page?.evaluate(() => [...(window.__mapHarness?.entries() ?? [])].map(([key, value]) => ({
        key,
        camera: value.camera,
        center: value.center,
        zoom: value.zoom,
        receipt: value.renderReceipt,
      }))),
    }, null, 2))
    if (process.env.MAP_COMPOSITION_DEBUG === '1') {
      console.error('[map basemap diagnostics]', JSON.stringify({
        error: String(error),
        mainRequests,
        providerRequests: providerRequests.map(request => {
          const last = request.messages?.at(-1)
          return { role: last?.role, content: typeof last?.content === 'string' ? last.content.slice(0, 160) : last?.content }
        }),
        dom: redactEvidence(dom, evidenceSecrets).slice(0, 2_000),
      }, null, 2))
    }
    throw error
  } finally {
    await new Promise(resolveClose => provider.close(resolveClose))
    await new Promise(resolveClose => sourceServer.close(resolveClose))
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close()
    if (app !== undefined) await stopProcessTree(app)
    rmSync(temp, { recursive: true, force: true })
  }
})

test('user annotations: draw, edit, undo, export, and recover in a second Loader', { timeout: 300_000 }, async () => {
  const temp = isolatedTemp(root, 'map-annotation-composition-')
  const evidenceDir = join(temp, 'evidence')
  const workspace = join(temp, 'workspace')
  mkdirSync(evidenceDir, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'source-points.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', id: 'business-point', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'business-point' } }],
  }))

  let mainRequests = 0
  const providerRequests = []
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      if (isTitleRequest(parsed)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(textResponse('annotation lane'))
        return
      }
      mainRequests += 1
      providerRequests.push(parsed)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const transcript = JSON.stringify(parsed.messages)
      const lastMessage = parsed.messages.at(-1)
      const lastContent = lastMessage?.content
      const lastToolResult = Array.isArray(lastContent)
        ? lastContent.find(part => part?.type === 'tool_result')
        : undefined
      const businessResult = lastToolResult?.tool_use_id === 'annotation-business-add'
      const currentText = typeof lastContent === 'string' ? lastContent
        : Array.isArray(lastContent) && lastContent[0]?.type === 'text' ? lastContent[0].text
        : ''
      if (currentText.includes('准备地图数据。') || businessResult) {
        response.end(transcript.includes('"id":"annotation-business-add"')
          ? textResponse('数据已准备。')
          : toolResponse([{ id: 'annotation-business-add', name: 'map_add_layer', input: { path: 'source-points.geojson', layer_id: 'business' } }]))
      } else if (transcript.includes('annotation-export') && lastToolResult === undefined) {
        response.end(toolResponse([{ id: 'annotation-export', name: 'data_export', input: { layer_id: 'user-annotations', format: 'geojson' } }]))
      } else if (lastToolResult !== undefined) {
        response.end(textResponse('annotation export complete'))
      } else {
        response.end(textResponse('annotation turn complete'))
      }
    })
  })

  let app
  let browser
  let page
  const stdout = { value: '' }
  const stderr = { value: '' }
  const pageErrors = []
  const consoleErrors = []
  const networkFailures = []
  try {
    const providerPort = await listen(provider)
    const appPort = await freePort()
    const boot = () => spawn(process.execPath, [
      mapBin, '--patch', pickerPatch,
      '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: join(temp, 'map-home'),
        DSH_HOME: join(temp, 'home'),
        DEEPSEEK_API_KEY: 'annotation-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerPort}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app = boot()
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)

    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({
      locale: 'zh-CN',
      viewport: { width: 1024, height: 768 },
      hasTouch: true,
    })
    page = await context.newPage()
    await useFixtureBasemap(page)
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('response', response => {
      if (response.status() >= 400) networkFailures.push({ url: response.url(), status: response.status() })
    })
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)

    await sendMessage(page, '准备地图数据。')
    await waitForCounter(() => mainRequests, 2)
    await page.locator('[data-map-container]:visible').waitFor({ timeout: 30_000 })
    await waitForRenderedReceipt(page)
    const sessionId = await page.locator('[data-map-container]:visible').getAttribute('data-map-session')
    assert.ok(sessionId)

    const lightTheme = await page.evaluate(() => getComputedStyle(document.querySelector('[data-map-container]')).getPropertyValue('--map-bg').trim())
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'))
    const darkTheme = await page.evaluate(() => getComputedStyle(document.querySelector('[data-map-container]')).getPropertyValue('--map-bg').trim())
    assert.notEqual(darkTheme, lightTheme)
    const narrowCanvasBox = await page.locator('[data-map-container]:not([data-map-view])').boundingBox()
    assert.ok(narrowCanvasBox)
    await openUnifiedMapPanel(page, 'annotation')
    const annotationGroup = page.locator('[data-map-panel-annotations]')
    await annotationGroup.getByRole('button', { name: /绘制点标记/ }).tap()
    await closeUnifiedMapPanel(page)
    await page.touchscreen.tap(narrowCanvasBox.x + narrowCanvasBox.width * 0.3, narrowCanvasBox.y + narrowCanvasBox.height * 0.72)
    await openUnifiedMapPanel(page, 'annotation')
    await page.getByRole('button', { name: /未命名标记/ }).first().waitFor({ timeout: 30_000 })
    const narrowPanel = await annotationGroup.evaluate(element => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }))
    assert.ok(narrowPanel.scrollWidth <= narrowPanel.clientWidth + 1)
    for (const button of await annotationGroup.getByRole('button').all()) {
      const box = await button.boundingBox()
      assert.ok(box)
      assert.ok(box.x >= 0)
      assert.ok(box.x + box.width <= 390)
    }
    writeFileSync(join(evidenceDir, 'annotations-narrow-dark.png'), await page.screenshot({ fullPage: true }))
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'))
    await page.setViewportSize({ width: 1024, height: 768 })

    const visibleMap = page.locator('[data-map-container]:visible')
    await closeUnifiedMapPanel(visibleMap)
    await openUnifiedMapPanel(visibleMap, 'annotation')
    await visibleMap.getByRole('button', { name: /未命名标记/ }).first().waitFor({ timeout: 30_000 })
    await visibleMap.getByRole('button', { name: /未命名标记/ }).first().click()
    const editor = page.locator('[data-map-annotation-dialog]')
    await editor.locator('input').first().fill('Protected site')
    await editor.getByRole('button', { name: '保存标记' }).click()
    const renamed = visibleMap.getByRole('button', { name: 'Protected site', exact: true })
    await renamed.waitFor({ timeout: 30_000 })
    if (!await editor.isVisible()) await renamed.click()
    await waitForRenderedReceipt(page)
    const beforeStyle = await page.evaluate(() => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.status === 'rendered')
      return handle.renderReceipt.revision
    })
    await editor.locator('select').selectOption({ index: 1 })
    await page.waitForFunction(expected => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.status === 'rendered')
      return handle?.renderReceipt.revision === expected
    }, beforeStyle + 1, { timeout: 30_000 })

    const beforeUndo = await page.evaluate(id => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.sessionId === id)
      return { revision: handle.renderReceipt.revision, camera: handle.camera }
    }, sessionId)
    assert.ok(beforeUndo.camera !== null, 'the camera is readable before annotation deletion')
    await editor.getByRole('button', { name: /删除标记 Protected site/ }).click()
    await editor.getByRole('button', { name: '确认删除' }).click()
    await page.waitForFunction(expected => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.status === 'rendered')
      return handle?.renderReceipt.revision === expected
    }, beforeUndo.revision + 1, { timeout: 30_000 })
    await visibleMap.getByRole('button', { name: '标记操作' }).click()
    await page.getByRole('menuitem', { name: '撤销标记' }).click()
    await page.waitForFunction(expected => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.status === 'rendered')
      return handle?.renderReceipt.revision === expected
    }, beforeUndo.revision + 2, { timeout: 30_000 })
    await renamed.waitFor({ timeout: 30_000 })
    writeFileSync(join(evidenceDir, 'annotations-edited.png'), await page.screenshot({ fullPage: true }))

    await visibleMap.getByRole('button', { name: '标记操作' }).click()
    await page.getByRole('menuitem', { name: '导出标记' }).click()
    await page.getByText('annotation export complete', { exact: true }).waitFor({ timeout: 90_000 })
    const exportRequestText = JSON.stringify(providerRequests.at(-1)?.messages ?? [])
    assert.match(exportRequestText, /user-annotations/)
    assert.match(exportRequestText, /geojson/)
    const exportTranscript = exportRequestText
    assert.match(exportTranscript, /art-[a-f0-9-]+@v1/)
    assert.equal(exportTranscript.includes('geometry-invalid'), false)

    const cameraAfter = await page.evaluate(id => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.sessionId === id)
      return handle == null ? null : {
        camera: handle.camera,
        feature: handle.annotationSnapshot?.data?.features?.[0]?.geometry?.coordinates ?? null,
      }
    }, sessionId)
    assert.deepEqual(cameraAfter?.camera, beforeUndo.camera, 'deletion, undo, and export preserve the live camera')
    const [longitude, latitude] = cameraAfter?.feature ?? []
    assert.ok(Number.isFinite(longitude) && Number.isFinite(latitude), 'undo restores the annotation coordinates')
    await visibleMap.getByRole('button', { name: '定位到标记 Protected site', exact: true }).click()
    await page.waitForFunction(({ id, longitude, latitude }) => {
      const camera = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.sessionId === id)?.camera
      return camera != null && Math.abs(camera.center[0] - longitude) < 0.05
        && Math.abs(camera.center[1] - latitude) < 0.05
    }, { id: sessionId, longitude, latitude }, { timeout: 30_000 })
    writeFileSync(join(evidenceDir, 'provider-requests.json'), JSON.stringify(providerRequests, null, 2))

    const sessionLogPaths = observationSessionLogs(join(temp, 'home'), join(temp, 'map-home'), workspace)
    const matchingLogs = sessionLogPaths.map(path => ({ path, text: readObservationSessionLog(path) }))
      .filter(entry => entry.text.includes('annotation-create') || entry.text.includes('annotation-update') || entry.text.includes('annotation-delete'))
    assert.ok(matchingLogs.length > 0, 'accepted annotations are durable')
    writeFileSync(join(evidenceDir, 'annotation-session.jsonl'), matchingLogs[0].text)
    const acceptedAnnotation = await page.evaluate(id => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.sessionId === id)
      return { revision: handle.renderReceipt.revision, layer: handle.annotationSnapshot }
    }, sessionId)

    await stopProcessTree(app)
    app = undefined
    app = boot()
    const secondStdout = { value: '' }
    const secondStderr = { value: '' }
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { secondStdout.value += chunk })
    app.stderr.on('data', chunk => { secondStderr.value += chunk })
    await waitForAppUrl(app, secondStdout, secondStderr)
    await page.close()
    pageErrors.length = 0
    consoleErrors.length = 0
    networkFailures.length = 0
    page = await context.newPage()
    await useFixtureBasemap(page)
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('response', response => {
      if (response.status() >= 400) networkFailures.push({ url: response.url(), status: response.status() })
    })
    await page.goto(url)
    const replayMap = page.locator(`[data-map-container][data-map-session="${sessionId}"]:visible`)
    await replayMap.waitFor({ timeout: 30_000 })
    await openUnifiedMapPanel(replayMap, 'annotation')
    await replayMap.getByRole('button', { name: 'Protected site', exact: true }).waitFor({ timeout: 30_000 })
    await waitForRenderedReceipt(page)
    const replay = await page.evaluate(() => {
      const handle = [...(window.__mapHarness?.values() ?? [])].find(value => value.renderReceipt.status === 'rendered')
      return {
        revision: handle.renderReceipt.revision,
        layers: handle.renderReceipt.layerVersions.map(entry => entry.id),
        layer: handle.annotationSnapshot,
      }
    })
    assert.equal(replay.layers.includes('basemap'), true)
    assert.equal(replay.layers.includes('user-annotations'), true)
    assert.equal(replay.layers.includes('business'), true)
    assert.deepEqual(replay.layer, acceptedAnnotation.layer)
    assert.equal(replay.revision, acceptedAnnotation.revision)
    assert.equal(replay.layer.data.features[0].id, acceptedAnnotation.layer.data.features[0].id)
    assert.equal(replay.layer.data.features[0].properties.dshSource, 'manual')
    writeFileSync(join(evidenceDir, 'annotations-replayed.png'), await page.screenshot({ fullPage: true }))
    writeFileSync(join(evidenceDir, 'app-stdout.log'), stdout.value + secondStdout.value)
    writeFileSync(join(evidenceDir, 'app-stderr.log'), stderr.value + secondStderr.value)
    assert.deepEqual(networkFailures, [])
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(consoleErrors, [])
  } catch (error) {
    let dom = ''
    try {
      dom = await page?.locator('body').innerText({ timeout: 2_000 }) ?? ''
      if (page !== undefined) writeFileSync(join(evidenceDir, 'failure.png'), await page.screenshot({ fullPage: true }))
    } catch (domError) {
      dom = `DOM unavailable: ${String(domError)}`
    }
    writeFileSync(join(evidenceDir, 'failure.json'), JSON.stringify({
      error: String(error),
      url: page?.url(),
      dom,
      stdout: stdout.value,
      stderr: stderr.value,
      providerSummaries: providerRequests.slice(-5).map(request => ({
        lastRole: request.messages.at(-1)?.role,
        assistantTools: request.messages.filter(message => message.role === 'assistant')
          .flatMap(message => Array.isArray(message.content) ? message.content : [])
          .filter(part => part?.type === 'tool_use')
          .map(part => part.name),
      })),
      handles: await page?.evaluate(() => [...(window.__mapHarness?.entries() ?? [])].map(([key, value]) => ({
        key,
        camera: value.camera,
        receipt: value.renderReceipt,
      }))),
    }, null, 2))
    throw error
  } finally {
    await new Promise(resolveClose => provider.close(resolveClose))
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close()
    if (app !== undefined) await stopProcessTree(app)
    rmSync(temp, { recursive: true, force: true })
  }
})

test('layer workbench: dialogue exports reach the browser and survive an app restart', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-lw-export-'))
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
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
        MAPHARNESS_HOME: mapHome,
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
    await installScopedStorageKey(context)
    page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useFixtureBasemap(page)

    // M1: import, land both layers in one group, verify the wire.
    await sendMessage(page, '导入两份数据成层并归入「基准」组。')
    await page.getByText('两份地图数据已就绪。', { exact: true }).waitFor({ timeout: 90_000 })
    await openUnifiedMapPanel(page, 'ai')
    await page.waitForFunction(() => document.querySelectorAll('[data-map-panel-layer]').length === 2, undefined, { timeout: 30_000 })
    const beforeReceipt = await waitForRenderedReceipt(page)
    const sessionId = beforeReceipt.sessionId
    const beforeRevision = beforeReceipt.revision
    const hospitalsRow = page.locator('[data-map-panel-layer]', { hasText: '医院' })
    await hospitalsRow.getByRole('button', { name: '医院 的更多操作' }).click()
    const layerDialog = page.getByRole('dialog').last()
    const downloadButton = layerDialog.getByRole('button', { name: /^(下载引用|Download ref) / }).first()
    const resourceRef = (await downloadButton.getAttribute('aria-label'))?.match(/(res-[^ ]+@v\d+)/)?.[1] ?? null
    await layerDialog.getByRole('button', { name: /^(关闭图层面板|Close layer panel)$/ }).click()
    await layerDialog.waitFor({ state: 'detached', timeout: 10_000 })
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
    const downloadDialog = page.getByRole('dialog').last()
    await downloadDialog.getByRole('button', { name: `下载引用 ${resourceRef}` }).click()
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
      const current = JSON.parse(localStorage.getItem(globalThis.scopedStorageKey('dsh.sessions.current')) ?? 'null')
      return current?.sessionId === id
    }, sessionId, { timeout: 15_000 })
    await page.locator(`[data-conversation-session="${sessionId}"]:visible [data-composer-input][contenteditable="true"]`).waitFor({ timeout: 30_000 })
    await chooseMapPreset(page)

    // The restored map is identical: layers, panel, revision, receipt.
    await openUnifiedMapPanel(page, 'ai')
    await page.waitForFunction(() => document.querySelectorAll('[data-map-panel-layer]').length === 2, undefined, { timeout: 30_000 })
    const afterReceipt = await waitForRenderedReceipt(page)
    assert.equal(afterReceipt.revision, beforeRevision, 'the restarted projection replays to the same revision')
    const restoredPanel = await page.locator('[data-map-panel]').first().textContent()
    assert.match(restoredPanel ?? '', /医院/)
    assert.match(restoredPanel ?? '', /道路/)

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
    if (app !== undefined) await stopProcessTree(app)
    rmSync(temp, { recursive: true, force: true })
  }
})

test('layer workbench: POI search becomes a layer and service failures report honestly', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-lw-poi-'))
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
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
    app = spawn(applicationCommand, [
      ...applicationPrefix, '--patch', pickerPatch, '--patch', searchPatch, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: mapHome,
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
    await installScopedStorageKey(context)
    page = await context.newPage()
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useFixtureBasemap(page)

    // M1: the fixture-backed search registers, loads, and aggregates.
    await sendMessage(page, '检索北京范围内的医院，登记并显示在地图上，再做网格密度。')
    await page.getByText('检索成图完成。', { exact: true }).waitFor({ timeout: 90_000 })
    await openUnifiedMapPanel(page, 'ai')
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
    if (app !== undefined) await stopProcessTree(app)
    fixture.server.closeAllConnections()
    await new Promise(resolveClose => fixture.server.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

test('spatial workflow: facility coverage comparison reaches the map, linked table and export', { timeout: 240_000 }, async t => {
  const temp = mkdtempSync(join(tmpdir(), 'map-facility-web-'))
  const workspace = join(temp, 'workspace')
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
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
        if (process.env.MAP_APPLICATION_RUNTIME_REPORT === undefined) rmSync(temp, { recursive: true, force: true })
      }
    }
  })
  cpSync(join(scenario, 'workspace'), workspace, { recursive: true })
  const fixture = readFileSync(join(scenario, 'session.v4.jsonl'), 'utf8')
  const rows = fixture.trim().split('\n').map(JSON.parse)
  const task = rows.find(row => row.type === 'user/message' && row.data.source.kind === 'user').data.content[0].text
  const live = process.env.MAP_FACILITY_LIVE === '1'
  const env = { ...process.env, MAPHARNESS_HOME: mapHome, DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED' }
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
    // The profile keeps the row off without a Tianditu key; the keyless lattice provider turns it back on.
    '- id: spatial-accessibility', '  disabled: false', '  config:', `    root: ${JSON.stringify(join(mapHome, 'accessibility-store'))}`, '    provider: controlled-lattice',
    '- id: session-title-llm', '  disabled: true',
    '- id: agent-default-model', '  config:', '    provider: deepseek-official', '    model: deepseek-flash',
    '- id: llm-deepseek', "  name: '@deepseek-ai/dsh-llm-deepseek-api-key'", '  config:', '    maxTokens: 8192', '    reasoningEffort: off', '',
  ].join('\n'))
  const stdout = { value: '' }
  const stderr = { value: '' }
  if (env.MAP_APPLICATION_MINIMAL_PATH === '1') env.PATH = qualificationPlatform(process.platform, env).path
  const serviceLauncher = env.MAP_APPLICATION_LAUNCHER
  const serviceArgs = ['--patch', pickerPatch, '--patch', overlay, '--host', '127.0.0.1', '--port', '0', '--no-open']
  const windowsLauncher = serviceLauncher !== undefined && process.platform === 'win32'
    ? windowsLauncherInvocation(serviceLauncher, serviceArgs, env) : undefined
  app = serviceLauncher === undefined
    ? spawn(process.execPath, [mapBin, ...serviceArgs], {
      cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
    : spawn(windowsLauncher?.command ?? serviceLauncher, windowsLauncher ? [windowsLauncher.commandLine] : serviceArgs, {
      cwd: env.MAP_APPLICATION_CWD ?? workspace, env: windowsLauncher?.env ?? env, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32', windowsVerbatimArguments: windowsLauncher !== undefined,
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
  // The unified panel row carries the classified population legend the map
  // paints; the removed workbench table, chart brush and manifest export had
  // no unified-card successor, so the lane asserts the legend + receipt.
  await openUnifiedMapPanel(page, 'ai')
  const populationRow = page.locator('[data-map-panel-layer]', { hasText: 'population' })
  await populationRow.waitFor({ timeout: 30_000 })
  const populationSwatches = populationRow.locator('[data-map-panel-chip] span[role="img"]')
  await populationSwatches.first().waitFor({ timeout: 30_000 })
  assert.equal(await populationSwatches.count() >= 3, true,
    `the population legend lists its three classes (${await populationSwatches.count()})`)
  await page.waitForFunction(() => [...window.__mapHarness.values()].some(handle => handle.renderReceipt?.status === 'rendered'), undefined, { timeout: 30_000 })
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
  if (process.env.MAP_APPLICATION_RUNTIME_REPORT) {
    writeFileSync(process.env.MAP_APPLICATION_RUNTIME_REPORT, JSON.stringify({
      format: 'map-application-runtime-report-1', temp, home, workspace, provider: live ? 'live' : 'recorded',
    }, null, 2) + '\n')
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

async function receiptDiagnostics(page) {
  return await page.evaluate(() => {
    const harness = window.__mapHarness
    const sessionId = document.querySelector('[data-map-session-action]')?.getAttribute('data-map-session-action')
    return {
      sessionId,
      harnessType: harness?.constructor?.name,
      values: harness instanceof Map
        ? [...harness.entries()].map(([key, value]) => ({
          key,
          layerCount: value.layerCount,
          revision: value.revision,
          camera: value.camera,
          receipt: value.renderReceipt,
        }))
        : [],
    }
  })
}

/** Wait until the map tab's receipt attests one exact rendered revision. */
/** Catch-up variant: the fast undo tail may skip intermediate rendered revisions. */
async function waitReceiptRevisionAtLeast(page, revision) {
  try {
    await page.waitForFunction(rev => {
      const harness = window.__mapHarness
      if (!(harness instanceof Map)) return false
      const sessionId = document.querySelector('[data-map-session-action]')?.getAttribute('data-map-session-action')
      const receipt = [...harness.values()].find(value => value.renderReceipt.sessionId === sessionId)?.renderReceipt
      return receipt?.status === 'rendered' && receipt.failedLayers.length === 0
        && receipt.revision >= rev && receipt.renderedRevision === receipt.revision && typeof receipt.viewId === 'string'
    }, revision, { timeout: 60_000 })
  } catch (error) {
    throw new Error(`${String(error)}\nReceipt state: ${JSON.stringify(await receiptDiagnostics(page))}`)
  }
  return await readMapTabReceipt(page)
}

async function waitReceiptRevision(page, revision) {
  try {
    await page.waitForFunction(rev => {
      const harness = window.__mapHarness
      if (!(harness instanceof Map)) return false
      const sessionId = document.querySelector('[data-map-session-action]')?.getAttribute('data-map-session-action')
      const receipt = [...harness.values()].find(value => value.renderReceipt.sessionId === sessionId)?.renderReceipt
      return receipt?.status === 'rendered' && receipt.failedLayers.length === 0
        && receipt.revision === rev && receipt.renderedRevision === rev && typeof receipt.viewId === 'string'
    }, revision, { timeout: 60_000 })
  } catch (error) {
    throw new Error(`${String(error)}\nReceipt state: ${JSON.stringify(await receiptDiagnostics(page))}`)
  }
  return await readMapTabReceipt(page)
}

test('spatial workflow: locate, draw, fit and the study AOI travel the real map profile with honest receipts', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-actions-composition-'))
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
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
    app = spawn(applicationCommand, [
      ...applicationPrefix, '--host', '127.0.0.1', '--port', String(appPort), '--no-open', '--patch', pickerPatch, '--patch', searchPatch,
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: mapHome,
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
    await installScopedStorageKey(context)
    page = await context.newPage()
    await page.goto(url)
    try {
      await maybeContinueNotice(page)
      await connectWorkspace(page, workspace)
    } catch (error) {
      throw new Error(`${String(error)}\nPage: ${(await page.locator('body').innerText()).slice(0, 3000)}\nHost: ${stderr.value.slice(-6000)}`)
    }
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

    // Any error or warning line in the host log fails the workflow.
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
  const mapHome = join(temp, 'map-home')
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
        MAPHARNESS_HOME: mapHome,
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
    await installScopedStorageKey(context)
    page = await context.newPage()
    await useFixtureBasemap(page)
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
    // The unified panel row carries the same style version the map paints; the
    // removed workbench table and manifest export had no unified-card successor.
    await openUnifiedMapPanel(page, 'ai')
    const zoneRows = page.locator('[data-map-panel-layer]').filter({ hasNotText: '核心区' })
    await zoneRows.first().waitFor({ timeout: 30_000 })
    const classColor = await darkestRowChipColor(zoneRows.first(), 3)
    // Close the card so the pixel band holds only the map canvas.
    await closeUnifiedMapPanel(page)
    const painted = await waitForMapColor(page, classColor, 'present', { tolerance: 30, present: 5_000 })
    assert.ok(painted.count >= 5_000, `the styled parcels must paint the map band (${painted.count} px)`)
    const receiptStyled = await waitReceiptRevision(page, 4)
    assert.equal(receiptStyled.renderedRevision, receiptStyled.revision)
    const firstSession = receiptStyled.sessionId
    await waitForRenderedReceipt(page)
    openGate('styled')

    // Round 4 folded the atomic management patch (rename + reorder); round 5
    // folded the set-layer-state hide: the renamed layer keeps its id and
    // paint through both.
    await waitReceiptRevisionAtLeast(page, 5)
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => (value.styledLayers ?? []).includes('zones'))
    }, undefined, { timeout: 30_000 })
    const paintedAfter = await waitForMapColor(page, classColor, 'present', { tolerance: 30, present: 5_000 })
    assert.ok(paintedAfter.count >= 5_000, 'a rename keeps the classified paint')
    openGate('saved')
    await waitReceiptRevisionAtLeast(page, 6)

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
    const [createdSessionResponse] = await Promise.all([
      page.waitForResponse('**/api/session/create'),
      page.getByRole('button', { name: '在“workspace”中新建会话', exact: true }).click(),
    ])
    const createdSession = await createdSessionResponse.json()
    assert.equal(createdSession.result?.ok, true, JSON.stringify(createdSession))
    await page.locator(`[data-conversation-session="${createdSession.result.value.sessionId}"]:visible [data-composer-input][contenteditable="true"]`).waitFor()
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
  const temp = isolatedTemp(root, 'map-symbology-')
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
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
        ...process.env, MAPHARNESS_HOME: mapHome, DSH_HOME: home,
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
      throw new Error(`labels never placed: ${JSON.stringify(seen)} requests=${String(mainRequests)} stderr=${stderr.value.slice(-800)}`)
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
    const specDir = join(temp, 'spec-evidence')
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
    assert.equal(labelStyle.color, 'rgb(126, 52, 52)', 'labels wear the facility hue with RGB channels scaled to 55%')
    assert.equal(labelStyle.pointer, 'none', 'the overlay never intercepts hover')

    // Hover the isolated North Clinic marker: the attribute card lists its
    // fields. The projection must be finite on every attempt: a settling view
    // can report NaN screen coordinates that elementFromPoint rejects.
    const card = page.locator('[data-map-feature-card]')
    let cardText = null
    for (let attempt = 0; attempt < 10 && cardText === null; attempt += 1) {
      const point = await page.evaluate(() => {
        const container = [...document.querySelectorAll('[data-map-container]')]
          .find(element => element.getBoundingClientRect().width > 0)
        if (container === undefined) return null
        const rect = container.getBoundingClientRect()
        for (const value of window.__mapHarness?.values() ?? []) {
          const projected = value.labelCount > 0 ? value.screenOf(116.44, 39.94) : null
          if (projected !== null && Number.isFinite(projected.x) && Number.isFinite(projected.y)) {
            return { x: rect.x + projected.x, y: rect.y + projected.y, width: window.innerWidth, height: window.innerHeight }
          }
        }
        return null
      })
      if (point === null || point.x < 0 || point.y < 0 || point.x >= point.width || point.y >= point.height) {
        await new Promise(resolveWait => setTimeout(resolveWait, 250))
        continue
      }
      await page.mouse.move(Math.min(point.x, point.width - 1), Math.min(point.y, point.height - 1))
      try {
        await card.waitFor({ state: 'visible', timeout: 5_000 })
        cardText = await card.innerText()
      } catch (_hoverMissed) {
        if (process.env.MAP_COMPOSITION_DEBUG === '1') {
          console.error('[hover debug]', JSON.stringify({ point, cardCount: await card.count() }))
        }
      }
    }
    assert.ok(cardText !== null, 'the hovered feature opens the attribute card')
    const cardBox = await card.boundingBox()
    const viewport = page.viewportSize()
    assert.ok(cardBox !== null && cardBox.y >= 0 && cardBox.y + cardBox.height <= viewport.height
      && cardBox.x >= box.x && cardBox.x + cardBox.width <= box.x + box.width, `the card sits inside the visible map (${JSON.stringify(cardBox)})`)
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

/** One raw-session-log finder scoped to the fixture-owned DSH_HOME. */
function observationSessionLogs(...roots) {
  const matches = []
  const visit = directory => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()
        && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zstd'))) matches.push(path)
    }
  }
  for (const rootPath of roots) visit(rootPath)
  return matches
}

/** Read one raw JSONL Session log, including the deployed concatenated-Zstandard form. */
function readObservationSessionLog(path) {
  const bytes = readFileSync(path)
  if (!path.endsWith('.jsonl.zstd')) return bytes.toString('utf8')
  const scanned = scanZstdFrames(bytes)
  const decoder = createZstdFrameDecoder()
  try {
    return Buffer.concat(Array.from(
      decoder.decode(bytes, scanned.frames),
      chunk => Buffer.from(chunk),
    )).toString('utf8')
  } finally {
    decoder.close()
  }
}

/** Decode the named Session's complete durable events without reading a partial final row. */
function readDurableSessionEvents(roots, sessionId) {
  for (const path of observationSessionLogs(...roots)) {
    const raw = readObservationSessionLog(path)
    const headerEnd = raw.indexOf('\n')
    if (headerEnd < 0 || JSON.parse(raw.slice(0, headerEnd)).id !== sessionId) continue
    return parseSessionLog(raw.slice(0, raw.lastIndexOf('\n') + 1))
  }
  return []
}

/**
 * Collect the literal strings one raw JSONL Session log carries. A notice's
 * record text lives inside a JSON string, so raw-log matches see escaped
 * quotes; walking decoded values restores the text the host committed.
 */
function sessionLogStrings(raw) {
  const texts = []
  const walk = value => {
    if (typeof value === 'string') texts.push(value)
    else if (Array.isArray(value)) for (const entry of value) walk(entry)
    else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) walk(entry)
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      walk(JSON.parse(line))
    } catch {
      // A torn final line carries no complete event.
    }
  }
  return texts
}

/**
 * Poll the fixture-owned Session logs for notice texts matching `predicate`.
 * Persistence buffers appends asynchronously, so an accepted change can be
 * durable moments after its response.
 */
async function waitForSessionNoticeTexts(roots, predicate, timeout) {
  const deadline = Date.now() + timeout
  for (;;) {
    const matched = observationSessionLogs(...roots)
      .map(path => readObservationSessionLog(path))
      .flatMap(raw => sessionLogStrings(raw))
      .filter(predicate)
    if (matched.length > 0 || Date.now() >= deadline) return matched
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

/** Wait for a 200 user-change response after `start` whose posted record carries `op`. */
async function waitForAcceptedChange(responses, start, op, timeout) {
  const deadline = Date.now() + timeout
  const matches = () => responses.slice(start)
    .filter(entry => entry.status === 200 && entry.postData.includes(`"op":"${op}"`))
  while (matches().length === 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const [match] = matches()
  assert.ok(match !== undefined, `the host did not accept the ${op} change`)
  return JSON.parse(match.postData)
}

test('map observation log reader preserves successive decoder-owned frames', () => {
  const directory = mkdtempSync(join(tmpdir(), 'observation-log-reader-'))
  const chunks = ['first-frame: obs-base\n', 'second-frame: obs-labelled\n', 'third-frame: final result\n']
  try {
    const compressed = join(directory, 'session.jsonl.zstd')
    writeFileSync(compressed, Buffer.concat(chunks.map(chunk => zstdCompressSync(Buffer.from(chunk)))))
    assert.equal(readObservationSessionLog(compressed), chunks.join(''))
    const plaintext = join(directory, 'session.jsonl')
    writeFileSync(plaintext, chunks.join(''))
    assert.equal(readObservationSessionLog(plaintext), chunks.join(''))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('map compare: the native Web profile mounts both visual-change tools', () => {
  const names = SPATIAL_MCP_TOOL_NAMES
  for (const name of ['map_compare_views', 'map_mark_changes']) {
    assert.ok(names.includes(name), `${name} must be in the unified native tool catalog`)
  }
})

/** Require one native tool_result to carry a canonical inline image. */
function inlineObservationImage(messages, toolUseId) {
  const result = messages.flatMap(message => message.content ?? [])
    .find(block => block.type === 'tool_result' && block.tool_use_id === toolUseId)
  assert.ok(result, `missing native tool_result for ${toolUseId}`)
  const image = result.content?.find(block => block.type === 'image')
  assert.ok(image, `${toolUseId} result must include model image input`)
  assert.equal(image.source?.type, 'base64')
  assert.equal(image.source?.media_type, 'image/png')
  assert.equal(typeof image.source?.data, 'string')
  assert.ok(image.source.data.length > 0)
  const canonical = Buffer.from(image.source.data, 'base64').toString('base64')
  assert.equal(canonical === image.source.data, true, 'inline image base64 is canonical')
  return image.source
}

const observationDeclineCodes = new Set(['no-view', 'not-ready', 'stale', 'policy', 'capture-failed', 'oversized', 'invalid-image'])
const observationRouteRefusals = new Set(['no-pending-request', 'malformed', 'wrong-token', 'stale-revision', 'oversized', 'busy'])
const observationClaimRefusals = new Set(['timeout', 'cancelled', 'conflict', 'full'])

/** Read only the action and authored decline code from a test request. */
function observationRouteRequest(request) {
  try {
    const body = request.postDataJSON()
    const action = body?.action ?? body?.kind
    if (action === 'decline') return { action, declineCode: observationDeclineCodes.has(body.code) ? body.code : null }
    if (action === 'claim' || action === 'capture' || action === 'cancel') return { action }
  } catch (_nonJsonRequest) {
    return { action: 'unknown' }
  }
  return { action: 'unknown' }
}

/** Read only the host's closed refusal codes. */
function observationRouteErrorCode(body, action) {
  if (observationRouteRefusals.has(body?.code)) return body.code
  if (action === 'claim' && observationClaimRefusals.has(body?.status)) return body.status
  return null
}

/** Record only bounded route outcomes; successful response bodies can contain claim tokens. */
function observeMapObservationRoutes(page) {
  const entries = []
  const requests = new WeakMap()
  const pending = new Set()
  const onRequest = request => {
    if (entries.length === 32 || new URL(request.url()).pathname !== '/api/map/observation') return
    const entry = { ...observationRouteRequest(request), status: null, errorCode: null }
    requests.set(request, entry)
    entries.push(entry)
  }
  const onResponse = response => {
    const entry = requests.get(response.request())
    if (entry === undefined) return
    entry.status = response.status()
    if (entry.status < 400) return
    const read = response.json().then(body => { entry.errorCode = observationRouteErrorCode(body, entry.action) }, () => {})
    pending.add(read)
    void read.then(() => { pending.delete(read) })
  }
  const onFailure = request => {
    const entry = requests.get(request)
    if (entry !== undefined) entry.status = 'network-error'
  }
  page.on('request', onRequest)
  page.on('response', onResponse)
  page.on('requestfailed', onFailure)
  return {
    async read() {
      let timer
      try {
        await Promise.race([Promise.all(pending), new Promise(resolve => { timer = setTimeout(resolve, 1_000) })])
        return entries.map(entry => ({ ...entry }))
      } finally { clearTimeout(timer) }
    },
    dispose() {
      page.off('request', onRequest)
      page.off('response', onResponse)
      page.off('requestfailed', onFailure)
    },
  }
}

/** Sample observation identities without copying source URLs, coordinates or image receipts. */
async function observationDiagnostics(page, routes) {
  const routeTrace = await routes?.read() ?? []
  const views = await page?.evaluate(() => [...(window.__mapHarness?.values() ?? [])].slice(0, 4).map(handle => ({
    layerCount: handle.layerCount,
    observationRevision: handle.latestObservation?.mapRevision ?? null,
    observations: handle.interaction.observations,
    active: handle.interaction.open,
    capture: handle.observationCapture,
  }))).catch(() => []) ?? []
  return { routeTrace, views }
}

/**
 * map observation: capture revision-zero basemap evidence, then labelled
 * revision-two evidence through the supported Loader/app and real ArcGIS SDK.
 * The lead-owned provider script supplies current model capabilities and
 * exact tool calls; generated tiles are the only tile response source.
 */
async function runObservationComposition(evidenceDir, replayScript) {
  mkdirSync(evidenceDir, { recursive: true })
  const screenshotDir = replayScript === undefined ? process.env.MAP_UI_REVIEW_EVIDENCE : undefined
  if (screenshotDir !== undefined) mkdirSync(screenshotDir, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'observe-home-'))
  const mapHome = mkdtempSync(join(tmpdir(), 'map-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'observe-workspace-'))
  const overlay = join(home, 'map-observation-test.overlay.yml')
  writeFileSync(overlay, `${readFileSync(pickerPatch, 'utf8').trimEnd()}${OBSERVATION_ALLOW_PATCH}`)
  writeFileSync(join(workspace, 'points.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'alpha' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [116.5, 39.95] }, properties: { name: 'beta' } },
    ],
  }))

  const fixture = createObservationModelFixture({ isTitleRequest, textResponse, toolResponse, resolveScriptedEntry, replayScript })
  const stdout = { value: '' }
  const stderr = { value: '' }
  let observationRoutes
  let app
  let provider
  let browser
  let page
  try {
    provider = createServer(fixture.handler)
    const providerPort = await listen(provider)
    const appPort = await freePort()
    app = spawn(process.execPath, [
      mapBin, '--patch', overlay, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: mapHome,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'observe-composition-test',
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
    await installScopedStorageKey(context)
    page = await context.newPage()
    await useFixtureBasemap(page)
    observationRoutes = observeMapObservationRoutes(page)
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    if (screenshotDir !== undefined) await page.screenshot({ path: join(screenshotDir, 'observe-start.png'), fullPage: true })
    await sendMessage(page, OBSERVATION_USER_REQUEST)
    await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])]
      .some(value => value.latestObservation?.callId === 'obs-base'), undefined, { timeout: 45_000 })
    const base = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()].find(value => value.latestObservation?.callId === 'obs-base')
      return { record: handle.latestObservation, layerCount: handle.layerCount }
    })
    assert.equal(base.record.mapRevision, 0)
    assert.equal(base.layerCount, 0, 'the first capture is the untouched basemap')
    if (screenshotDir !== undefined) await page.screenshot({ path: join(screenshotDir, 'observe-base.png'), fullPage: true })
    fixture.releaseBase()

    await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])]
      .some(value => value.latestObservation?.callId === 'obs-labelled' && value.latestObservation.mapRevision === 2),
    undefined, { timeout: 60_000 })
    const labelled = await page.evaluate(positions => {
      const handle = [...window.__mapHarness.values()].find(value => value.latestObservation?.callId === 'obs-labelled')
      return {
        record: handle.latestObservation,
        layerCount: handle.layerCount,
        renderReceipt: handle.renderReceipt,
        controlPoints: positions.map(wgs84 => ({ wgs84, screen: handle.screenOf(...wgs84) })),
      }
    }, OBSERVATION_CONTROL_POINTS.map(point => point.wgs84))
    assert.equal(labelled.record.mapRevision, 2)
    assert.equal(labelled.layerCount, 1)
    assert.equal(labelled.record.georeference.kind, 'affine-2d')
    assert.equal(labelled.renderReceipt.status, 'rendered')
    assert.equal(labelled.renderReceipt.viewId, labelled.record.viewId)
    assert.equal(labelled.renderReceipt.generation, labelled.record.generation)
    assert.equal(labelled.renderReceipt.renderedRevision, labelled.record.mapRevision)
    assert.ok(labelled.controlPoints.every(point => point.screen !== null))
    if (screenshotDir !== undefined) await page.screenshot({ path: join(screenshotDir, 'observe-finished.png'), fullPage: true })
    for (const [label, evidence] of [['base', base], ['labelled', labelled]]) {
      const { record } = evidence
      assert.equal(record.attachment.mediaType, 'image/png')
      assert.equal(record.attachment.sha256.length, 64)
      assert.equal(record.attachment.width, record.imageSize.width)
      assert.equal(record.attachment.height, record.imageSize.height)
      assert.equal(record.sources[0].id, 'esri-world-imagery')
      assert.equal(record.sources[0].attribution.includes('Esri'), true)
      const attachmentId = /^sha256:([0-9a-f]{64})$/u.exec(record.attachment.attachmentId)?.[1]
      assert.equal(attachmentId, record.attachment.sha256)
      assert.ok(attachmentId)
      const attachmentPath = join(mapHome, 'attachments', 'v1', 'objects', attachmentId.slice(0, 2), attachmentId)
      const png = readFileSync(attachmentPath)
      assert.equal(createHash('sha256').update(png).digest('hex'), record.attachment.sha256, `${label} resolves to its saved observation`)
    }

    const finalController = new AbortController()
    const finalTimeout = setTimeout(() => finalController.abort(
      new Error('The model did not receive both observation results before the deadline.'),
    ), 30_000)
    let finalRequest
    try {
      finalRequest = await fixture.waitForFinalRequest(finalController.signal)
    } finally {
      clearTimeout(finalTimeout)
    }
    for (const [callId, evidence] of [['obs-base', base], ['obs-labelled', labelled]]) {
      const source = inlineObservationImage(finalRequest.messages, callId)
      assert.equal(createHash('sha256').update(Buffer.from(source.data, 'base64')).digest('hex'),
        evidence.record.attachment.sha256, `${callId} delivers the saved observation PNG`)
    }
    await page.getByText('observation noted', { exact: true }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
    const sessionLogs = observationSessionLogs(home, mapHome, workspace)
      .map(path => readObservationSessionLog(path))
      .filter(text => text.includes('obs-base'))
    assert.ok(sessionLogs.length > 0, 'the Loader run must persist a raw Session log with the accepted observation results')
    const replay = deriveReplayScript(parseSessionLog(sessionLogs[0]))
    assert.equal(replay.length, 5, 'the durable log includes all four tool responses and the final model response')
    writeFileSync(join(evidenceDir, 'observation-diagnostics.json'), JSON.stringify(await observationDiagnostics(page, observationRoutes), null, 2))
    return replay
  } catch (error) {
    const diagnostics = await observationDiagnostics(page, observationRoutes)
    throw new Error(`${error instanceof Error ? error.name : 'Error'}; observation diagnostics: ${JSON.stringify(diagnostics)}`)
  } finally {
    fixture.releaseBase()
    observationRoutes?.dispose()
    try {
      if (browser !== undefined) await browser.close()
    } finally {
      try {
        if (app !== undefined) await stopProcessTree(app, mapHome)
      } finally {
        try {
          if (provider !== undefined) { provider.closeAllConnections(); await new Promise(resolveClose => provider.close(resolveClose)) }
        } finally {
          rmSync(home, { recursive: true, force: true })
          rmSync(mapHome, { recursive: true, force: true })
          rmSync(workspace, { recursive: true, force: true })
        }
      }
    }
  }
}

test('map observation: revision-zero and labelled captures reach the model as inline images', { timeout: 300_000 }, async () => {
  const temp = isolatedTemp(root, 'map-observation-composition-')
  const evidenceDir = join(temp, 'evidence')
  try {
    const script = await runObservationComposition(evidenceDir)
    await runObservationComposition(join(evidenceDir, 'replay'), script)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})


test('map markup: candidates review, recover, and replay through the real Web client', { timeout: 420_000 }, async t => {
  const temp = isolatedTemp(root, 'map-markup-composition-')
  const evidenceDir = join(temp, 'evidence')
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
  const workspace = join(temp, 'workspace')
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  mkdirSync(evidenceDir, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  const overlay = join(home, 'map-markup-test.overlay.yml')
  writeFileSync(overlay, `${readFileSync(pickerPatch, 'utf8').trimEnd()}${MAP_MARKUP_ALLOW_PATCH}`)
  writeFileSync(join(workspace, 'points.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'alpha' } }],
  }))

  const models = {
    data: [{
      id: 'deepseek-flash',
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      api_capabilities: { anthropic_messages: { system_prompt_update: 'in-history', tool_update: 'addition-only' } },
    }],
  }
  const steps = [
    () => [{ id: 'markup-add', name: 'map_add_layer', input: { path: 'points.geojson', layer_id: 'points' } }],
    () => [{ id: 'markup-observe', name: 'map_observe', input: { timeout_ms: 30_000, expected_revision: 1 } }],
    messages => {
      const observation = [...JSON.stringify(messages).matchAll(/observation_id\\?":\\?"(obs-[0-9a-f-]{36})\\?"/gu)].at(-1)?.[1]
      if (observation === undefined) throw new Error('map markup fixture found no observation id')
      return [{ id: 'markup-submit', name: 'map_markup', input: {
        observation_id: observation,
        purpose: 'target',
        items: [{ kind: 'target', category: 'alpha point', note: 'marked point near the layer feature', confidence: 'likely', pixelGeometry: { type: 'bbox', corners: [[180, 80], [260, 80], [260, 140], [180, 140]] } }],
      } }]
    },
    messages => {
      const result = messages.flatMap(message => message.content ?? [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === 'markup-submit')
      const text = result?.content?.find(block => block.type === 'text')?.text
      if (typeof text !== 'string') throw new Error('map markup fixture found no projected geometry')
      const markup = JSON.parse(text)
      const proposal = markup.proposals[0]
      if (proposal?.geometry?.type !== 'Polygon') throw new Error('map markup fixture requires polygon geometry')
      return [{ id: 'markup-apply', name: 'map_edit_annotation', input: {
        expected_revision: markup.source_revision + 1,
        change: { op: 'visual-proposal-apply', proposalId: proposal.id },
      } }]
    },
    () => [{ text: 'map markup noted' }],
  ]
  let mainStep = 0
  const mainRequests = []
  const layerRendered = Promise.withResolvers()
  const provider = createServer((request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'GET' && path.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(models))
      return
    }
    if (request.method === 'GET' || !path.endsWith('/messages')) {
      request.resume()
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"type":"not_found"}}')
      return
    }
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      if (isTitleRequest(parsed)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(textResponse('map markup'))
        return
      }
      mainRequests.push(parsed)
      const index = mainStep++
      void (async () => {
        if (index === 1) await layerRendered.promise
        const step = steps[index]
        if (step === undefined) throw new Error(`map markup fixture received extra request ${index}`)
        const entries = step(parsed.messages)
        const calls = entries.filter(entry => entry.name !== undefined)
        const texts = entries.filter(entry => entry.text !== undefined)
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(calls.length > 0 ? toolResponse(calls) : textResponse(texts[0].text))
      })().catch(error => {
        if (response.headersSent) response.destroy(error)
        else response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
      })
    })
  })

  const pageErrors = []
  const consoleErrors = []
  const networkFailures = []
  const changeResponses = []
  let app
  let browser
  let page
  try {
    const providerPort = await listen(provider)
    let appPort = 0
    const stdout = { value: '' }
    const stderr = { value: '' }
    const boot = () => spawn(process.execPath, [
      mapBin, '--patch', overlay, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: mapHome,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'map-markup-composition-test',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app = boot()
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)
    appPort = Number(new URL(url).port)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1024, height: 768 }, hasTouch: true })
    page = await context.newPage()
    await useFixtureBasemap(page)
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('response', response => {
      if (response.url().endsWith('/api/map/change')) changeResponses.push({ status: response.status(), postData: response.request().postData() ?? '' })
      if (response.status() >= 400) networkFailures.push({ url: response.url(), status: response.status() })
    })
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await sendMessage(page, 'Observe the session map and mark the visible point as one target candidate.')
    await page.locator('[data-map-container]:visible').waitFor({ timeout: 30_000 })
    await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])].some(value =>
      value.renderReceipt?.status === 'rendered' && value.renderReceipt.revision === 1
        && value.renderReceipt.renderedRevision === 1 && value.renderReceipt.failedLayers.length === 0),
    undefined, { timeout: 30_000 })
    layerRendered.resolve()

    await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])]
      .some(value => value.latestObservation?.callId === 'markup-observe'), undefined, { timeout: 60_000 })
    const observation = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()].find(value => value.latestObservation?.callId === 'markup-observe')
      return handle.latestObservation
    })
    assert.equal(observation.mapRevision, 1)
    assert.equal(observation.georeference.kind, 'affine-2d')

    await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])]
      .some(value => (value.visualProposals ?? []).some(proposal => proposal.status === 'agent-applied')), undefined, { timeout: 60_000 })
    const beforeReview = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()].find(value => (value.visualProposals ?? []).length > 0)
      return { proposals: handle.visualProposals, receipt: handle.renderReceipt }
    })
    assert.equal(beforeReview.proposals.length, 1)
    const proposal = beforeReview.proposals[0]
    const markupRequest = mainRequests.find(request => request.messages.some(message =>
      (message.content ?? []).some(block => block.type === 'tool_result' && block.tool_use_id === 'markup-submit')))
    const markupResult = markupRequest?.messages.flatMap(message => message.content ?? [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'markup-submit')
    const markupText = markupResult?.content?.find(block => block.type === 'text')?.text
    assert.ok(markupText)
    const projected = JSON.parse(markupText)
    assert.equal(projected.must_confirm, false)
    assert.deepEqual(projected.proposals[0].geometry, proposal.geometry)
    assert.equal(proposal.observationId, observation.observationId)
    assert.equal(proposal.observationAttachmentSha256, observation.attachment.sha256)
    assert.equal(proposal.modelName, 'deepseek-flash')
    assert.equal(proposal.purpose, 'target')
    assert.equal(proposal.geometry.type, 'Polygon')
    assert.equal(proposal.status, 'agent-applied')
    assert.equal(proposal.reviewedBy, 'agent')
    await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])]
      .some(value => value.renderReceipt?.layerVersions?.some(layer => layer.id === 'user-annotations')), undefined, { timeout: 30_000 })
    const applied = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()].find(value => (value.visualProposals ?? []).length > 0)
      return { proposals: handle.visualProposals, annotations: handle.annotationSnapshot }
    })
    assert.equal(applied.proposals[0].acceptedFeatureId, applied.annotations.data.features[0].id)
    assert.equal(applied.annotations.data.features[0].properties.dshAuthor, 'agent')
    assert.equal(applied.annotations.data.features[0].properties.dshSource, 'visual-proposal')

    await openUnifiedMapPanel(page, 'ai')
    const proposalRow = page.locator('[data-map-panel-proposal][data-status="agent-applied"]').first()
    await proposalRow.waitFor({ timeout: 30_000 })
    await proposalRow.locator('[data-map-panel-proposal-select]').click()
    const proposalGroup = page.locator('[role="dialog"]').filter({ has: page.locator('[data-map-panel-proposal]') })
    await proposalGroup.waitFor({ timeout: 30_000 })
    assert.match(await proposalGroup.innerText(), /Agent 已应用/u)
    assert.equal(await proposalGroup.getByRole('button', { name: /确认候选/ }).count(), 0)
    const screenshotDir = process.env.MAP_UI_REVIEW_EVIDENCE
    if (screenshotDir !== undefined) {
      mkdirSync(screenshotDir, { recursive: true })
      await page.screenshot({ path: join(screenshotDir, 'agent-candidate-applied.png'), fullPage: true })
    }
    const sourceLink = proposalGroup.locator('[data-map-panel-proposal-source]')
    await sourceLink.waitFor({ timeout: 30_000 })
    await sourceLink.click()
    const sourcePreview = proposalGroup.locator('[data-map-panel-proposal-preview] img')
    await sourcePreview.waitFor({ timeout: 30_000 })
    assert.match(await sourcePreview.getAttribute('src'), /^(blob:|data:image\/png;base64,)/u)
    assert.equal(await sourcePreview.evaluate((image, width) => image.complete && image.naturalWidth === width, observation.imageSize.width), true)
    await page.setViewportSize({ width: 390, height: 844 })
    for (const button of await proposalGroup.getByRole('button').filter({ visible: true }).all()) {
      const box = await button.boundingBox()
      assert.ok(box)
      assert.ok(box.x >= 0 && box.x + box.width <= 390, 'proposal controls stay inside a 390px viewport')
    }
    await page.setViewportSize({ width: 1024, height: 768 })
    await page.keyboard.press('Escape')
    await proposalGroup.waitFor({ state: 'hidden', timeout: 10_000 })
    assert.equal(changeResponses.length, 0, 'no user change was needed to apply the candidate')
    await page.getByText('map markup noted', { exact: true }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })

    const modelRequestsBeforeRestart = mainRequests.length
    await stopProcessTree(app)
    app = boot()
    const secondStdout = { value: '' }
    const secondStderr = { value: '' }
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { secondStdout.value += chunk })
    app.stderr.on('data', chunk => { secondStderr.value += chunk })
    const restartedUrl = await waitForAppUrl(app, secondStdout, secondStderr)
    await page.close()
    pageErrors.length = 0
    consoleErrors.length = 0
    networkFailures.length = 0
    page = await context.newPage()
    await useFixtureBasemap(page)
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('response', response => {
      if (response.status() >= 400) networkFailures.push({ url: response.url(), status: response.status() })
    })
    await page.goto(restartedUrl)
    await page.locator(`[data-map-container][data-map-session="${beforeReview.receipt.sessionId}"]:visible`).waitFor({ timeout: 30_000 })
    await waitForRenderedReceipt(page)
    const replayed = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()].find(value => (value.visualProposals ?? []).length > 0)
      return { proposals: handle.visualProposals, annotations: handle.annotationSnapshot }
    })
    assert.deepEqual(replayed.proposals, applied.proposals)
    assert.deepEqual(replayed.annotations, applied.annotations)
    assert.equal(mainRequests.length, modelRequestsBeforeRestart, 'recovery issues no new model request')
    writeFileSync(join(evidenceDir, 'markup-session.json'), JSON.stringify({ observation, beforeReview, applied, replayed }, null, 2))
    writeFileSync(join(evidenceDir, 'markup-panel.png'), await page.screenshot({ fullPage: true }))
    writeFileSync(join(evidenceDir, 'app-stdout.log'), stdout.value + secondStdout.value)
    writeFileSync(join(evidenceDir, 'app-stderr.log'), stderr.value + secondStderr.value)
    assert.deepEqual(networkFailures, [])
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(consoleErrors, [])
  } catch (error) {
    let dom = ''
    try { dom = await page?.locator('body').innerText({ timeout: 2_000 }) ?? '' } catch { dom = 'DOM unavailable' }
    writeFileSync(join(evidenceDir, 'markup-composition-failure.json'), JSON.stringify({
      error: String(error), dom, pageErrors, consoleErrors, networkFailures, mainRequests,
    }, null, 2))
    if (page !== undefined) writeFileSync(join(evidenceDir, 'markup-failure.png'), await page.screenshot({ fullPage: true }))
    throw error
  } finally {
    layerRendered.resolve()
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close()
    if (app !== undefined) await stopProcessTree(app)
    provider.closeAllConnections()
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

/**
 * Continuous map use through the real Web Loader/ArcGIS SDK: observe, pan,
 * observe, zoom, observe, click a real feature, then let a real user drag
 * interrupt the next action and use the stop control before finishing.
 */
async function runMapUseComposition(evidenceDir, takeover = 'wheel', replayOptions) {
  mkdirSync(evidenceDir, { recursive: true })
  const screenshotDir = takeover === 'stop' && replayOptions === undefined ? process.env.MAP_UI_REVIEW_EVIDENCE : undefined
  if (screenshotDir !== undefined) mkdirSync(screenshotDir, { recursive: true })
  const home = mkdtempSync(join(tmpdir(), 'map-use-home-'))
  const mapHome = mkdtempSync(join(tmpdir(), 'map-home-'))
  const workspace = mkdtempSync(join(tmpdir(), 'map-use-workspace-'))
  const overlay = join(home, 'map-use-test.overlay.yml')
  const budgetCase = {
    'budget-actions': { key: 'maxActions', limit: 1, stopAfter: 5, actions: 2, observations: 2, revision: 2 },
    'budget-observations': { key: 'maxObservations', limit: 1, stopAfter: 4, actions: 1, observations: 2, revision: 2 },
    'budget-elapsed': { key: 'maxElapsedMs', limit: 1000, stopAfter: 2, actions: 0, observations: 1, revision: 1 },
  }[takeover]
  const patch = budgetCase === undefined ? MAP_USE_ALLOW_PATCH
    : `\n- id: map-container\n  config:\n    interaction:\n      ${budgetCase.key}: ${budgetCase.limit}\n`
  writeFileSync(overlay, `${readFileSync(pickerPatch, 'utf8').trimEnd()}${patch}`)
  const coverage = {
      type: 'Feature',
      geometry: takeover === 'empty-hit' ? { type: 'Point', coordinates: [104.9, 36.4] } : {
        type: 'Polygon',
        coordinates: [[[70, 5], [140, 5], [140, 60], [70, 60], [70, 5]]],
      },
      properties: { name: 'Coverage' },
  }
  writeFileSync(join(workspace, 'coverage.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: takeover === 'overlap'
      ? [{ ...coverage, id: 'coverage-bottom' }, { ...coverage, id: 'coverage-top', properties: { name: 'Top coverage' } }]
      : [coverage],
  }))

  const rotateBeforeTurn = takeover === 'rotated'
  const fixture = createMapUseModelFixture({
    isTitleRequest, textResponse, toolResponse, stopAfter: budgetCase?.stopAfter, emptyHit: takeover === 'empty-hit',
    unpinnedObservations: takeover === 'render-wait' || rotateBeforeTurn, replayScript: replayOptions?.script,
    resolveReplayEntry: resolveMapUseReplayEntry, prepareRotation: rotateBeforeTurn,
    replayScenario: replayOptions !== undefined,
  })
  const stdout = { value: '' }
  const stderr = { value: '' }
  let app
  let provider
  let browser
  let page
  let observationRoutes
  try {
    provider = createServer(fixture.handler)
    const providerPort = await listen(provider)
    let appPort = 0
    const boot = () => spawn(process.execPath, [
      mapBin, '--patch', overlay, '--host', '127.0.0.1', '--port', String(appPort), '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env,
        MAPHARNESS_HOME: mapHome,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: '{{SECRET_7ww3l5kz}}',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPort)}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app = boot()
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)
    appPort = Number(new URL(url).port)

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 }, hasTouch: takeover.startsWith('touch'), deviceScaleFactor: takeover === 'rotated' ? 2 : 1 })
    page = await context.newPage()
    await useFixtureBasemap(page)
    observationRoutes = observeMapObservationRoutes(page)
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await sendMessage(page, rotateBeforeTurn ? 'Load the coverage layer for a rotated map.' : MAP_USE_USER_REQUEST)
    await waitForRenderedReceipt(page)
    if (rotateBeforeTurn) {
      await page.getByText('map ready for rotation', { exact: true }).waitFor({ timeout: 30_000 })
      await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })
      const [rotationReport] = await Promise.all([
        page.waitForResponse(response => response.url().endsWith('/api/map/change')
          && response.request().postDataJSON()?.record?.change?.op === 'set-view', { timeout: 30_000 }),
        (async () => {
          const rectangle = await page.locator('[data-map-container]:visible').boundingBox()
          assert.ok(rectangle)
          await page.mouse.move(rectangle.x + rectangle.width * 0.2, rectangle.y + rectangle.height * 0.8)
          await page.mouse.down({ button: 'right' })
          await page.mouse.move(rectangle.x + rectangle.width * 0.35, rectangle.y + rectangle.height * 0.7, { steps: 10 })
          await page.mouse.up({ button: 'right' })
        })(),
      ])
      assert.equal(rotationReport.status(), 200)
      await sendMessage(page, MAP_USE_USER_REQUEST)
    }
    if (budgetCase !== undefined) {
      if (takeover === 'budget-elapsed') await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])]
        .some(handle => Date.now() - handle.interaction.startedAt >= 1000))
      fixture.releaseAll()
      const refusal = await fixture.waitForRefusal()
      const failures = refusal.messages.flatMap(message => message.content ?? [])
        .filter(block => block.type === 'tool_result' && block.is_error)
      assert.equal(failures.length, 1)
      assert.match(JSON.stringify(failures), /MAP_BUDGET_EXCEEDED/u)
      await fixture.waitForFinalRequest()
      await page.getByText('map use budget noted', { exact: true }).waitFor({ timeout: 30000 })
      const state = await page.evaluate(() => {
        const handle = [...window.__mapHarness.values()][0]
        return { interaction: handle.interaction, revision: handle.renderReceipt.revision }
      })
      assert.equal(state.interaction.actions, budgetCase.actions)
      assert.equal(state.interaction.observations, budgetCase.observations)
      assert.equal(state.interaction.stopped, 'finished')
      assert.equal(state.interaction.lastResult.action, 'finish')
      assert.equal(state.revision, budgetCase.revision)
      writeFileSync(join(evidenceDir, 'budget.json'), JSON.stringify({ budgetCase, state }, null, 2))
      return
    }
    const restartHost = async (pendingCall, expectedEnd = 'interrupted') => {
      const sessionId = await page.locator('[data-map-container]:visible').getAttribute('data-map-session')
      assert.ok(sessionId, 'the restart test owns a rendered Session')
      const roots = [home, mapHome, workspace]
      let eventsBefore
      let lastCall
      await waitForValue(() => {
        const events = readDurableSessionEvents(roots, sessionId)
        const call = events.findLast(event => event.type === 'tool/call'
          && (event.data.name === 'map_use' || event.data.name === 'map_observe'))
        if (call === undefined) return false
        const reachedCheckpoint = pendingCall !== undefined ? call.data.callId === pendingCall
          : expectedEnd === 'completed' ? events.some(event => event.type === 'turn/end'
            && event.data.turn === call.data.turn && event.data.reason.kind === 'completed')
            : call.data.callId === 'use-takeover' && events.some(event => event.type === 'tool/result'
              && event.data.message.toolCallId === call.data.callId && event.data.message.isError)
        if (!reachedCheckpoint) return false
        eventsBefore = events
        lastCall = call
        return true
      }, 10_000, 'the exact map-use checkpoint did not reach the durable Session')
      await page.waitForFunction(({ id, seq, open }) => [...(window.__mapHarness?.values() ?? [])].some(handle =>
        handle.renderReceipt.sessionId === id && handle.interaction.lastCallSeq === seq && handle.interaction.open === open),
      { id: sessionId, seq: lastCall.seq, open: expectedEnd !== 'completed' }, { timeout: 10_000 })
      const readCheckpoint = id => {
        const handle = [...window.__mapHarness.values()].find(value => value.renderReceipt.sessionId === id)
        return { interaction: handle.interaction, revision: handle.renderReceipt.revision, center: handle.center, sessionId: handle.renderReceipt.sessionId }
      }
      const before = await page.evaluate(readCheckpoint, sessionId)
      const callsBefore = eventsBefore.filter(event => event.type === 'tool/call').map(event => event.data.callId)
      const modelRequestsBefore = fixture.mainRequests.length
      if (process.platform !== 'win32') {
        const exited = new Promise(resolveExit => app.once('exit', resolveExit))
        process.kill(-app.pid, 'SIGKILL')
        await exited
      } else await stopProcessTree(app, mapHome)
      // Killing the launcher's group leaves the detached service alive with the instance lock; the
      // relaunch on the same Map home is refused (MAP_INSTANCE_BUSY) until the service is gone.
      await killDetachedService(mapHome)
      const secondStdout = { value: '' }
      const secondStderr = { value: '' }
      app = boot()
      app.stdout.setEncoding('utf8')
      app.stderr.setEncoding('utf8')
      app.stdout.on('data', chunk => { secondStdout.value += chunk })
      app.stderr.on('data', chunk => { secondStderr.value += chunk })
      const secondUrl = await waitForAppUrl(app, secondStdout, secondStderr)
      await page.close()
      page = await context.newPage()
      await useFixtureBasemap(page)
      const replayCalls = []
      page.on('request', request => { if (request.url().endsWith('/api/map/use')) replayCalls.push(request.postDataJSON()?.action) })
      await page.goto(secondUrl)
      await maybeContinueNotice(page)
      await page.locator('[role="treeitem"]').filter({ hasText: 'continuous map use' }).first().click()
      await page.waitForFunction(id => [...(window.__mapHarness?.values() ?? [])].some(handle =>
        handle.renderReceipt.sessionId === id && handle.renderReceipt.status === 'rendered'), sessionId, { timeout: 30_000 })
      const after = await page.evaluate(readCheckpoint, sessionId)
      for (const key of ['actions', 'observations', 'turnStartSeq', 'lastCallSeq', 'lastResult']) {
        assert.deepEqual(after.interaction[key], before.interaction[key], key)
      }
      assert.equal(after.interaction.stopped, pendingCall === undefined ? before.interaction.stopped : null)
      assert.equal(after.interaction.controlEpoch, before.interaction.controlEpoch)
      assert.equal(after.interaction.request, null)
      assert.equal(after.interaction.open, false)
      assert.equal(after.revision, before.revision)
      assert.deepEqual(after.center, before.center)
      assert.equal(after.sessionId, before.sessionId)
      assert.deepEqual(replayCalls, [])
      assert.equal(fixture.mainRequests.length, modelRequestsBefore)
      let recovered
      await waitForValue(() => {
        recovered = readDurableSessionEvents(roots, sessionId)
        return recovered.some(event => event.type === 'turn/end'
          && event.data.turn === lastCall.data.turn && event.data.reason.kind === expectedEnd)
      }, 10_000, 'the recovered turn ending did not reach the durable Session')
      assert.deepEqual(recovered.filter(event => event.type === 'tool/call').map(event => event.data.callId), callsBefore)
      const recoveryEvents = recovered.filter(event => event.type === 'turn/end')
        .map(event => ({ type: event.type, turn: event.data.turn, reason: event.data.reason }))
      writeFileSync(join(evidenceDir, 'restart.json'), JSON.stringify({ before, after, replayCalls, recoveryEvents }, null, 2))
    }
    fixture.releaseStep(1)

    await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])]
      .some(value => value.latestObservation?.callId === 'use-obs-1'), undefined, { timeout: 60_000 })
    const first = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()].find(value => value.latestObservation?.callId === 'use-obs-1')
      return {
        record: handle.latestObservation,
        layerCount: handle.layerCount,
        receipt: handle.renderReceipt,
        observationCapture: handle.observationCapture,
        control: handle.screenOf(104.9, 36.4),
      }
    })
    const captureSamples = [first.observationCapture]
    const baseRevision = rotateBeforeTurn || replayOptions !== undefined ? 2 : 1
    assert.equal(first.record.mapRevision, baseRevision)
    assert.ok(first.layerCount >= 1)
    assert.equal(first.record.georeference.kind, 'affine-2d')
    assert.equal(first.receipt.status, 'rendered')
    assert.equal(first.receipt.renderedRevision, baseRevision)
    if (screenshotDir !== undefined) await page.screenshot({ path: join(screenshotDir, 'map-before-pan.png'), fullPage: true })
    if (takeover === 'rotated') assert.ok(Math.abs(first.record.camera.rotation) > 1, 'the SDK must actually rotate for this matrix row')
    fixture.releaseStep(2)

    await page.waitForFunction(expected => [...(window.__mapHarness?.values() ?? [])]
      .some(value => value.latestObservation?.callId === 'use-obs-2' && value.latestObservation.mapRevision === expected),
    baseRevision + 1, { timeout: 60_000 })
    const second = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()].find(value => value.latestObservation?.callId === 'use-obs-2')
      return { record: handle.latestObservation, receipt: handle.renderReceipt, observationCapture: handle.observationCapture, control: handle.screenOf(104.9, 36.4) }
    })
    captureSamples.push(second.observationCapture)
    assert.equal(second.receipt.renderedRevision, baseRevision + 1)
    if (screenshotDir !== undefined) await page.screenshot({ path: join(screenshotDir, 'map-after-pan.png'), fullPage: true })
    writeFileSync(join(evidenceDir, 'map-use-controls-partial.json'), JSON.stringify({ first, second }, null, 2))
    assert.ok(Math.abs(second.control.x - first.control.x - 120) <= 0.5,
      `pan displacement ${second.control.x - first.control.x} must equal 120px`)
    assert.ok(Math.abs(second.control.y - first.control.y) <= 0.5)
    assert.ok(Math.abs(second.record.camera.scale / first.record.camera.scale - 1) <= 1e-9)
    assert.equal(second.record.camera.rotation, first.record.camera.rotation)
    fixture.setAnchor(second.control)
    if (takeover === 'pending-restart') {
      const claimEntered = Promise.withResolvers()
      await page.route('**/api/map/use', async route => {
        const body = route.request().postDataJSON()
        if (body.action === 'claim' && body.callId === 'use-zoom') {
          claimEntered.resolve()
          return
        }
        await route.continue()
      })
      fixture.releaseStep(4)
      await claimEntered.promise
      await page.waitForFunction(() => [...window.__mapHarness.values()].some(handle => handle.interaction.request?.callId === 'use-zoom'))
      await restartHost('use-zoom')
      return
    }
    if (takeover === 'render-wait') {
      const releaseTiles = Promise.withResolvers()
      const tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#ffffff' } }).png().toBuffer()
      let pendingTiles = 0
      let observationClaimed = false
      let capturesBeforeRender = 0
      await page.route('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/**', async route => {
        pendingTiles += 1
        await releaseTiles.promise
        await route.fulfill({ contentType: 'image/png', body: tile })
      })
      page.on('request', request => {
        if (!request.url().endsWith('/api/map/observation')) return
        const body = request.postDataJSON()
        if (body.callId !== 'use-obs-3') return
        if (body.action === 'claim') observationClaimed = true
        if (body.kind === 'capture') capturesBeforeRender += 1
      })
      try {
        fixture.releaseStep(4)
        await waitForCounter(() => pendingTiles > 0 && observationClaimed ? 1 : 0, 1, 15000)
        const blocked = await page.evaluate(() => {
          const handle = [...window.__mapHarness.values()][0]
          return { receipt: handle.renderReceipt, request: handle.interaction.request, observation: handle.latestObservation }
        })
        assert.equal(blocked.receipt.revision, 3)
        assert.notEqual(blocked.receipt.status, 'rendered')
        assert.equal(blocked.observation.mapRevision, 2)
        assert.equal(capturesBeforeRender, 0)
        writeFileSync(join(evidenceDir, 'render-barrier.json'), JSON.stringify({ pendingTiles, observationClaimed, capturesBeforeRender, blocked }, null, 2))
      } finally { releaseTiles.resolve() }
    } else fixture.releaseStep(4)

    await page.waitForFunction(expected => [...(window.__mapHarness?.values() ?? [])]
      .some(value => value.latestObservation?.callId === 'use-obs-3' && value.latestObservation.mapRevision === expected),
    baseRevision + 2, { timeout: 60_000 })
    const third = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()].find(value => value.latestObservation?.callId === 'use-obs-3')
      return {
        record: handle.latestObservation,
        receipt: handle.renderReceipt,
        observationCapture: handle.observationCapture,
        control: handle.screenOf(104.9, 36.4),
        center: [handle.camera.center[0], handle.camera.center[1]],
      }
    })
    captureSamples.push(third.observationCapture)
    assert.equal(third.receipt.renderedRevision, baseRevision + 2)
    if (screenshotDir !== undefined) await page.screenshot({ path: join(screenshotDir, 'map-after-zoom.png'), fullPage: true })
    assert.ok(Math.abs(third.record.camera.scale / second.record.camera.scale - 0.5) <= 1e-9)
    const anchorError = Math.hypot(third.control.x - second.control.x, third.control.y - second.control.y)
    assert.ok(anchorError <= 3, `the zoom anchor drift is ${anchorError}px`)
    fixture.releaseStep(6)
    await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])].some(value => value.latestObservation?.callId === 'use-obs-4'), undefined, { timeout: 30000 })
    const fourth = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()][0]
      return { record: handle.latestObservation, observationCapture: handle.observationCapture, control: handle.screenOf(104.9, 36.4) }
    })
    captureSamples.push(fourth.observationCapture)
    assert.ok(Math.abs(fourth.control.x - third.control.x + 60) <= 0.5)
    assert.ok(Math.abs(fourth.control.y - third.control.y - 30) <= 0.5)
    fixture.releaseStep(8)
    await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])].some(value => value.latestObservation?.callId === 'use-obs-5'), undefined, { timeout: 30000 })
    const fifth = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()][0]
      return { record: handle.latestObservation, observationCapture: handle.observationCapture }
    })
    captureSamples.push(fifth.observationCapture)
    assert.ok(Math.abs(fifth.record.camera.scale / fourth.record.camera.scale - Math.SQRT2) <= 1e-9)
    fixture.releaseStep(10)

    await fixture.waitForTakeover()
    const clickRequest = fixture.mainRequests.at(-1)
    const clickTranscript = JSON.stringify(clickRequest.messages)
    const clickResult = clickRequest.messages.flatMap(message => message.content ?? [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'use-click')
    const clickFacts = JSON.parse(clickResult.content.find(block => block.type === 'text').text)
    let observations
    if (replayOptions !== undefined) {
      observations = [first.record, second.record, third.record, fourth.record, fifth.record]
      for (const record of observations) {
        const source = inlineObservationImage(clickRequest.messages, record.callId)
        const result = clickRequest.messages.flatMap(message => message.content ?? [])
          .find(block => block.type === 'tool_result' && block.tool_use_id === record.callId)
        const identity = JSON.parse(result.content.find(block => block.type === 'text' && block.text.startsWith('{')).text)
        assert.equal(identity.observation_id, record.observationId)
        assert.equal(identity.revision, record.mapRevision)
        assert.equal(identity.view_id, record.viewId)
        const attachmentId = /^sha256:([0-9a-f]{64})$/u.exec(record.attachment.attachmentId)?.[1]
        assert.equal(attachmentId, record.attachment.sha256)
        const attachment = readFileSync(join(mapHome, 'attachments', 'v1', 'objects', attachmentId.slice(0, 2), attachmentId))
        assert.equal(createHash('sha256').update(attachment).digest('hex'), record.attachment.sha256)
        assert.equal(createHash('sha256').update(Buffer.from(source.data, 'base64')).digest('hex'), record.attachment.sha256)
      }
      assert.equal(new Set(observations.map(record => record.observationId)).size, 5)
      assert.deepEqual(observations.map(record => record.mapRevision), [2, 3, 4, 5, 6])
    }
    if (takeover === 'empty-hit') {
      assert.equal(clickFacts.hit, false)
      assert.deepEqual(clickFacts.hits, [])
      assert.equal(clickFacts.world.length, 2)
    } else {
      assert.match(clickTranscript, /\\"hit\\":true/u, 'the click returns a real SDK hit to the model')
      assert.match(clickTranscript, /\\"layer_id\\":\\"coverage\\"/u, 'the hit carries the stable layer id')
      assert.match(clickTranscript, /\\"feature_id\\"/u, 'the hit carries a stable feature id')
      if (takeover === 'overlap') assert.deepEqual(clickFacts.hits.map(hit => hit.feature_id), ['coverage-top', 'coverage-bottom'])
    }
    writeFileSync(join(evidenceDir, 'click.json'), JSON.stringify(clickFacts, null, 2))

    const status = page.locator('[data-map-use-status]')
    await status.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await status.innerText(), /5 个动作 \/ 5 次观察/u)
    await page.setViewportSize({ width: 390, height: 844 })
    const narrowButton = await status.getByRole('button', { name: '停止地图操作' }).boundingBox()
    assert.ok(narrowButton !== null)
    assert.ok(narrowButton.x >= 0 && narrowButton.y >= 0
      && narrowButton.x + narrowButton.width <= 390 && narrowButton.y + narrowButton.height <= 844,
    'the stop control stays inside a 390px viewport')
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme })
      await page.screenshot({ path: join(evidenceDir, `map-use-390-${colorScheme}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 800 })

    const mapBand = page.locator('[data-map-container]:not([data-map-view])')
    const band = await mapBand.boundingBox()
    assert.ok(band !== null)
    const beforeTakeover = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()][0]
      return { camera: handle.camera }
    })
    if (takeover === 'draw') await openUnifiedMapPanel(page, 'annotation')
    const [takeoverResponse] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/map/use')
        && response.request().postDataJSON()?.action === 'stop', { timeout: 10000 }),
      (async () => {
        if (takeover === 'stop' || takeover === 'restart') {
          await page.getByRole('button', { name: '停止地图操作', exact: true }).press('Enter')
        } else if (takeover === 'touch-stop') {
          await page.getByRole('button', { name: '停止地图操作', exact: true }).tap()
        } else if (takeover === 'draw') {
          // An earlier map-use click can leave the feature card open over the
          // card launcher; close it through its own control first. The
          // annotation tools live in the unified card's annotation tab, so
          // opening the card is part of the real draw takeover.
          const featureCard = page.locator('[data-map-feature-card]')
          if (await featureCard.count() > 0) {
            await featureCard.getByRole('button', { name: /^(关闭属性|Close attributes)$/ }).click()
            await featureCard.waitFor({ state: 'detached', timeout: 10_000 })
          }
          await openUnifiedMapPanel(page, 'annotation')
          await page.getByRole('button', { name: '绘制点标记', exact: true }).click()
                } else {
          const position = { x: band.x + band.width * 0.2, y: band.y + band.height * 0.85 }
          if (takeover === 'touch') {
            await page.touchscreen.tap(position.x, position.y)
          } else if (takeover === 'drag') {
            await page.mouse.move(position.x, position.y)
            await page.mouse.down()
            await page.mouse.move(position.x + 80, position.y + 20, { steps: 10 })
            await page.mouse.up()
          } else {
            await page.mouse.move(position.x, position.y)
            await page.mouse.wheel(0, -240)
          }
        }
      })(),
    ])
    assert.equal(takeoverResponse.status(), 200)
    await page.waitForFunction(() => [...window.__mapHarness.values()].some(handle => handle.interaction.stopped === 'user-interrupted'))
    if (screenshotDir !== undefined) await page.screenshot({ path: join(screenshotDir, 'user-stop.png'), fullPage: true })
    const afterTakeover = await page.evaluate(() => {
      const handle = [...window.__mapHarness.values()][0]
      return { camera: handle.camera }
    })
    writeFileSync(join(evidenceDir, 'map-use-takeover.json'), JSON.stringify({ band, beforeTakeover, afterTakeover }, null, 2))
    fixture.releaseTakeover()

    await fixture.waitForFinish()
    assert.match(JSON.stringify(fixture.mainRequests.at(-1).messages), /USER_INTERRUPTED/u,
      'the model sees the user takeover refusal, not a silent stale success')
    if (takeover === 'restart') {
      await restartHost()
      return
    }
    await page.reload()
    await page.waitForFunction(() => [...(window.__mapHarness?.values() ?? [])].some(handle => handle.interaction.stopped === 'user-interrupted'), undefined, { timeout: 30000 })
    assert.equal(await page.getByRole('button', { name: '停止地图操作' }).isDisabled(), true)
    fixture.releaseFinish()
    const finalRequest = await fixture.waitForFinalRequest()
    assert.match(JSON.stringify(finalRequest.messages), /\\"finished\\":true/u, 'finish remains callable after the stop control')
    const stoppedObservation = finalRequest.messages.flatMap(message => message.content ?? [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'use-observe-stopped')
    assert.equal(stoppedObservation.is_error, true)
    assert.match(stoppedObservation.content[0].text, /USER_INTERRUPTED/u)
    await page.getByText('map use noted', { exact: true }).waitFor({ timeout: 30_000 })
    await page.getByRole('button', { name: '停止生成', exact: true }).waitFor({ state: 'hidden', timeout: 30_000 })

    const diagnostics = await observationDiagnostics(page, observationRoutes)
    writeFileSync(join(evidenceDir, 'map-use-session-controls.json'), JSON.stringify({ ...diagnostics, captureSamples, anchorError, takeover }, null, 2))
    if (replayOptions !== undefined) {
      fixture.assertReplayConsumed()
      let sessionLog
      await waitForValue(() => {
        const matches = observationSessionLogs(home, mapHome, workspace)
          .map(path => readObservationSessionLog(path))
          .filter(text => text.includes('use-obs-1') && text.includes('"type":"turn/end"'))
        if (matches.length === 0) return false
        assert.equal(matches.length, 1, 'exactly one Session owns the map-use turn')
        sessionLog = matches[0]
        return true
      }, 30_000, 'the completed map-use turn must reach its durable Session')
      const script = deriveMapUseReplay(parseSessionLog(sessionLog))
      assert.equal(script.length, fixture.mainRequests.length)
      await restartHost(undefined, 'completed')
      return { script, observations, clickFacts, controls: [first.control, second.control, third.control, fourth.control] }
    }
  } catch (error) {
    const diagnostics = await observationDiagnostics(page, observationRoutes)
    throw new Error(`${error instanceof Error ? error.name : 'Error'}; map-use diagnostics: ${JSON.stringify(diagnostics)}`)
  } finally {
    fixture.releaseAll()
    observationRoutes?.dispose()
    try {
      if (browser !== undefined) await browser.close()
    } finally {
      try {
        if (app !== undefined) await stopProcessTree(app, mapHome)
      } finally {
        try {
          if (provider !== undefined) { provider.closeAllConnections(); await new Promise(resolveClose => provider.close(resolveClose)) }
        } finally {
          rmSync(home, { recursive: true, force: true })
          rmSync(mapHome, { recursive: true, force: true })
          rmSync(workspace, { recursive: true, force: true })
        }
      }
    }
  }
}

for (const takeover of ['wheel', 'drag', 'draw', 'stop', 'touch', 'touch-stop', 'rotated', 'restart', 'pending-restart', 'budget-actions', 'budget-observations', 'budget-elapsed', 'empty-hit', 'overlap', 'render-wait']) test(`map use: ${takeover} camera, control and recovery`, { timeout: 180_000 }, async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'map-use-evidence-'))
  try { await runMapUseComposition(evidenceDir, takeover) } finally { rmSync(evidenceDir, { recursive: true, force: true }) }
})

test('map use replay: a complete isolated Session drives a second real client', { timeout: 600_000 }, async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'map-use-replay-'))
  try {
    const recorded = await runMapUseComposition(join(evidenceDir, 'recorded'), 'stop', {})
    const replayed = await runMapUseComposition(join(evidenceDir, 'replayed'), 'stop', { script: recorded.script })
    assert.deepEqual(replayed.observations.map(record => record.mapRevision), recorded.observations.map(record => record.mapRevision))
    for (const [index, record] of recorded.observations.entries()) {
      assert.notEqual(replayed.observations[index].observationId, record.observationId)
      assert.deepEqual(replayed.observations[index].camera, record.camera,
        `observation ${String(index)} camera differs: recorded=${JSON.stringify(record.camera)} replayed=${JSON.stringify(replayed.observations[index].camera)}`)
    }
    for (const [index, point] of recorded.controls.entries()) {
      const replayedPoint = replayed.controls[index]
      const error = Math.hypot(replayedPoint.x - point.x, replayedPoint.y - point.y)
      assert.ok(error <= 0.5, `control ${String(index)} differs by ${String(error)}px: recorded=${JSON.stringify({ point, observation: recorded.observations[index] })} replayed=${JSON.stringify({ point: replayedPoint, observation: replayed.observations[index] })}`)
    }
    assert.deepEqual(replayed.clickFacts.hits, recorded.clickFacts.hits)
    assert.deepEqual(replayed.clickFacts.world, recorded.clickFacts.world)
  } finally { rmSync(evidenceDir, { recursive: true, force: true }) }
})

test('map use live: current vision model observes and acts without scripted decisions', { skip: process.env.MAP_USE_LIVE !== '1', timeout: 1500000 }, async () => {
  const { runMapUseLiveQualification } = await import('./map-use-live-fixture.mjs')
  await runMapUseLiveQualification({ root, mapBin, pickerPatch, chromium, listen, stopProcessTree, waitForAppUrl, maybeContinueNotice, connectWorkspace, sendMessage, waitForRenderedReceipt, useFixtureBasemap, observationSessionLogs, readObservationSessionLog })
})

test('map markup live: current vision model proposes a reviewable target candidate', { skip: process.env.MAP_MARKUP_LIVE !== '1', timeout: 900000 }, async () => {
  const { runMapMarkupLiveQualification } = await import('./map-markup-live-fixture.mjs')
  await runMapMarkupLiveQualification({ root, mapBin, pickerPatch, chromium, listen, stopProcessTree, waitForAppUrl, maybeContinueNotice, connectWorkspace, sendMessage, waitForRenderedReceipt, useFixtureBasemap, observationSessionLogs, readObservationSessionLog })
})

test('visual change live: current vision model compares two images and proposes one candidate', { skip: process.env.MAP_VISUAL_CHANGE_LIVE !== '1', timeout: 900000 }, async () => {
  const { runVisualChangeLiveQualification } = await import('./visual-change-live-fixture.mjs')
  const report = await runVisualChangeLiveQualification({ root, mapBin, pickerPatch, chromium, listen, stopProcessTree, waitForAppUrl, maybeContinueNotice, connectWorkspace, sendMessage, waitForRenderedReceipt, useFixtureBasemap, observationSessionLogs, readObservationSessionLog })
  assert.equal(report.skipped, undefined, 'the opt-in test must not accept a skipped authority gate')
  assert.equal(report.ok, true, 'the admitted live qualification must pass its declared criteria')
})

test('wayback: the browser owns the official catalog, the host admits the first release click, and both survive a reboot offline', { timeout: 300_000 }, async () => {
  const temp = isolatedTemp(root, 'map-wayback-browser-catalog-')
  const evidenceDir = process.env.MAP_WAYBACK_UI_EVIDENCE_DIR
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
  const workspace = join(temp, 'workspace')
  const profile = join(temp, 'profile')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# Wayback browser catalog\n')
  const catalogPath = join(mapHome, 'cache', 'map', 'wayback-catalog.sqlite')
  const certificate = join(temp, 'fixture.pem')
  const key = join(temp, 'fixture-key.pem')
  const tlsConfig = join(temp, 'tls.cnf')
  const fixtureOverlay = join(temp, 'wayback.overlay.yml')
  writeFileSync(fixtureOverlay, JSON.stringify([{ id: 'map-container', config: {
    wayback: { requestTimeoutMs: 120_000 },
    sources: { proxy: { requestTimeoutMs: 120_000, outboundProxy: { urlEnv: 'DSH_WAYBACK_PROXY_URL', targetResolution: 'proxy' } } },
  } }]))
  writeFileSync(tlsConfig, `[req]
distinguished_name=dn
prompt=no
x509_extensions=extensions
[dn]
CN=Map Harness Wayback loopback fixture
[extensions]
basicConstraints=critical,CA:TRUE
subjectAltName=DNS:www.arcgis.com,DNS:s3-us-west-2.amazonaws.com,DNS:wayback.maptiles.arcgis.com
`)
  // Release 10 of the official catalog; the same item the portal fixture publishes.
  const catalogItem = {
    itemID: '903f0abe9c3b452dafe1ca5b8dd858b9',
    itemTitle: 'World Imagery (Wayback 2014-02-20)',
    itemURL: 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/10/{level}/{row}/{col}',
    metadataLayerUrl: 'https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2014_r01/MapServer',
    metadataLayerItemID: '78e801fab4d24ab9a6053c7a461479be',
    layerIdentifier: 'WB_2014_R01',
  }
  const releaseTitle = catalogItem.itemTitle
  const catalogBody = JSON.stringify({ 10: catalogItem })
  const portalItem = {
    id: catalogItem.itemID, owner: 'esri_imagery', orgId: 'P3ePLMYs2RVChkJx', type: 'WMTS', access: 'public',
    title: releaseTitle,
    url: catalogItem.itemURL,
  }
  const heldCatalog = Promise.withResolvers()
  const renderGate = Promise.withResolvers()
  const upstream = {
    hostCatalogDenied: 0, portalReads: 0, capabilityReads: 0, nativeRequests: [], unexpectedAuthorities: [],
  }
  const sockets = new Set()
  const track = socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }

  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      if (isTitleRequest(parsed)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(textResponse('Wayback browser catalog'))
        return
      }
      const transcript = JSON.stringify(parsed.messages)
      const lastMessage = parsed.messages.at(-1)
      const lastToolResult = Array.isArray(lastMessage?.content)
        ? lastMessage.content.find(part => part?.type === 'tool_result')
        : undefined
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (lastToolResult?.tool_use_id === 'wayback-browser-undo') {
        response.end(textResponse('已撤销早期影像。'))
      } else if (lastToolResult?.tool_use_id === 'wayback-browser-view') {
        response.end(textResponse('北京已定位。'))
      } else if (transcript.includes('撤销早期影像')) {
        response.end(toolResponse([{ id: 'wayback-browser-undo', name: 'map_undo', input: {} }]))
      } else if (transcript.includes('移动到北京')) {
        response.end(toolResponse([{ id: 'wayback-browser-view', name: 'map_set_view', input: { center: [116.4, 39.9], zoom: 15, wkid: 4326 } }]))
      } else {
        response.end(textResponse('Wayback browser catalog acknowledged'))
      }
    })
  })

  let app
  let origin
  let proxy
  let browser
  const stdout = { value: '' }
  const stderr = { value: '' }
  const pageErrors = []
  const consoleErrors = []
  const boot = async (providerPort, proxyPort, webPort = '0') => {
    stdout.value = ''
    stderr.value = ''
    app = spawn(process.execPath, [
      mapBin, '--patch', pickerPatch, '--patch', fixtureOverlay,
      '--host', '127.0.0.1', '--port', webPort, '--no-open',
    ], {
      cwd: workspace,
      env: {
        ...process.env, MAPHARNESS_HOME: mapHome, DSH_HOME: home,
        NODE_EXTRA_CA_CERTS: certificate, DSH_WAYBACK_PROXY_URL: `http://127.0.0.1:${proxyPort}`,
        DEEPSEEK_API_KEY: 'wayback-fixture', DEEPSEEK_BASE_URL: `http://127.0.0.1:${providerPort}`,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    })
    app.stdout.setEncoding('utf8').on('data', chunk => { stdout.value += chunk })
    app.stderr.setEncoding('utf8').on('data', chunk => { stderr.value += chunk })
    return waitForAppUrl(app, stdout, stderr)
  }
  const stopApp = async () => {
    if (app === undefined) return
    await stopProcessTree(app, mapHome)
    app = undefined
  }
  // The host proxy denies the S3 catalog; only the official tile host and the portal item tunnel to the fixture.
  const browserCatalog = { requests: 0, headers: [], violations: [] }
  const openMap = async (url, context, restoredSessionId) => {
    const page = await context.newPage()
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    const browserRequests = { admit: 0, admitBodies: [] }
    await useFixtureBasemap(page)
    await page.goto(url)
    await maybeContinueNotice(page)
    if (restoredSessionId === undefined) {
      await connectWorkspace(page, workspace)
      await chooseMapPreset(page)
      await page.keyboard.press('Escape')
      await sendMessage(page, '移动到北京。')
    }
    const sessionId = restoredSessionId ?? await page.locator('[data-conversation-session]:visible').first().getAttribute('data-conversation-session')
    assert.ok(sessionId)
    await page.locator(`[data-map-container][data-map-session="${sessionId}"]:visible`).waitFor({ timeout: 30_000 })
    await waitForRenderedReceipt(page, 90_000)
    page.on('request', request => {
      const target = new URL(request.url())
      if (target.pathname === '/api/map/wayback') hostWaybackReads.push(target.search)
      if (target.pathname === '/api/map/wayback/admit' && request.method() === 'POST') {
        browserRequests.admit += 1
        browserRequests.admitBodies.push(request.postDataJSON())
      }
    })
    return { page, sessionId, browserRequests }
  }
  const capture = async (dialog, name) => {
    if (evidenceDir === undefined) return
    mkdirSync(evidenceDir, { recursive: true })
    await dialog.screenshot({ path: join(evidenceDir, `wayback-${name}.png`), animations: 'disabled' })
  }
  // Every same-origin Wayback read the browser issues; `operation=catalog` must never appear.
  const hostWaybackReads = []
  try {
    const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-config', tlsConfig, '-out', certificate, '-keyout', key], { encoding: 'utf8' })
    assert.equal(generated.status, 0, generated.error?.message ?? generated.stderr)
    const tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#c04020' } }).jpeg().toBuffer()
    const capabilities = readFileSync(join(root, 'map/map-container/tests/fixtures/wayback-capabilities.xml'))
    origin = createHttpsServer({ cert: readFileSync(certificate), key: readFileSync(key) }, async (request, response) => {
      const url = new URL(request.url, `https://${request.headers.host}`)
      if (url.hostname === 'www.arcgis.com') {
        upstream.portalReads += 1
        assert.equal(url.pathname, `/sharing/rest/content/items/${catalogItem.itemID}`)
        assert.equal(url.searchParams.get('f'), 'json')
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(portalItem))
        return
      }
      upstream.nativeRequests.push(`${url.pathname}${url.search}`)
      if (url.searchParams.get('REQUEST') === 'GetCapabilities') {
        upstream.capabilityReads += 1
        response.writeHead(200, { 'content-type': 'application/xml' }).end(capabilities)
      } else if (/\/tile\/10\/\d+\/\d+\/\d+$/u.test(url.pathname)) {
        response.writeHead(200, { 'content-type': 'image/jpeg' }).end(tile)
      } else response.writeHead(404).end()
    })
    origin.on('connection', track)
    const originPort = await listen(origin)
    proxy = createServer()
    proxy.on('connection', track)
    proxy.on('connect', (request, socket, head) => {
      socket.on('error', () => socket.destroy())
      if (request.url === 's3-us-west-2.amazonaws.com:443') {
        // The host never downloads the catalog; count the denial so a regression to host polling is visible.
        upstream.hostCatalogDenied += 1
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
        return
      }
      if (!['wayback.maptiles.arcgis.com:443', 'www.arcgis.com:443'].includes(request.url)) {
        upstream.unexpectedAuthorities.push(request.url)
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
        return
      }
      const tunnel = connectTcp(originPort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) tunnel.write(head)
        socket.pipe(tunnel).pipe(socket)
      })
      track(tunnel)
      socket.once('close', () => tunnel.destroy())
      tunnel.on('error', () => socket.destroy())
    })
    const proxyPort = await listen(proxy)
    const providerPort = await listen(provider)
    // One persistent profile so BrowserStorage survives the reboot with the same map home.
    const context = await chromium.launchPersistentContext(profile, {
      headless: true, locale: 'zh-CN', viewport: { width: 390, height: 844 }, hasTouch: true, colorScheme: 'dark',
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    browser = context
    // The browser context intercepts the exact official S3 URL; it is held until the map is ready, then
    // fulfilled as a public CORS read. No credential header may ever ride on it.
    await context.route(url2 => url2.href === WAYBACK_CONFIG_URL, async route => {
      browserCatalog.requests += 1
      const request = route.request()
      const headers = await request.allHeaders()
      browserCatalog.headers.push(headers)
      for (const name of ['cookie', 'authorization', 'proxy-authorization', 'referer']) {
        if (headers[name] !== undefined) browserCatalog.violations.push(`${name} on the catalog request`)
      }
      assert.notEqual(new URL(request.url()).origin, new URL(request.frame().url()).origin)
      await heldCatalog.promise
      await route.fulfill({
        status: 200, contentType: 'application/json', body: catalogBody,
        headers: { 'access-control-allow-origin': '*' },
      })
      const responseHeaders = await (await request.response())?.allHeaders()
      if (responseHeaders?.['access-control-allow-credentials'] !== undefined) browserCatalog.violations.push('credentialed CORS on the catalog response')
    })
    const coldUrl = await boot(providerPort, proxyPort)
    const cold = await openMap(coldUrl, context)
    // The catalog is still held: the selector must be visible but empty, with no host catalog read and no admission.
    const coldDialog = await openImageryDialog(cold.page, 'early')
    const coldPanel = cold.page.locator('[data-map-wayback]')
    await coldPanel.getByRole('status').filter({ hasText: /正在读取|Reading/ }).waitFor({ timeout: 10_000 })
    assert.equal(browserCatalog.requests, 1, 'the browser must request the official catalog exactly once')
    assert.equal(cold.browserRequests.admit, 0)
    assert.deepEqual(hostWaybackReads, [], 'the browser must not read operation=catalog from the host')
    await capture(coldDialog, 'browser-hold-dark')
    heldCatalog.resolve()
    await coldPanel.locator('[data-map-wayback-release] option[value="10"]').waitFor({ state: 'attached', timeout: 30_000 })
    assert.equal(await coldPanel.getByRole('combobox').isEnabled(), true)
    assert.deepEqual(browserCatalog.violations, [], 'the catalog request must carry no credentials')
    assert.deepEqual(cold.browserRequests.admitBodies, [])
    assert.equal(existsSync(catalogPath), false, 'the host must not write a catalog before any release is admitted')
    assert.equal(upstream.portalReads, 0)
    await capture(coldDialog, 'browser-catalog-dark')
    // Selecting release 10 is the first click: exactly one admission against the official portal item.
    const select = coldDialog.locator('[data-map-wayback-release]')
    await cold.page.route(url => url.pathname === '/api/map/sources/render', async route => {
      await renderGate.promise
      await route.continue()
    })
    const changeApplied = cold.page.waitForResponse(response => new URL(response.url()).pathname === '/api/map/change'
      && response.request().postDataJSON()?.record?.change?.op === 'set-imagery-display').catch(error => error)
    const [admitted] = await Promise.all([
      cold.page.waitForResponse(response => new URL(response.url()).pathname === '/api/map/wayback/admit' && response.request().method() === 'POST'),
      select.selectOption('10'),
    ])
    assert.equal(admitted.status(), 200, JSON.stringify({ result: await admitted.json(), upstream, stderr: stderr.value.slice(-800) }))
    const applied = await changeApplied
    if (applied instanceof Error) throw applied
    assert.equal(admitted.request().postDataJSON().release.releaseId, 10)
    assert.deepEqual(cold.browserRequests.admitBodies.map(body => body.release), [{
      releaseId: 10, itemId: catalogItem.itemID, layerIdentifier: 'WB_2014_R01', publishedAt: '2014-02-20',
    }])
    assert.equal(cold.browserRequests.admit, 1, 'admission happens on the first release click only')
    assert.equal(upstream.portalReads, 1, 'the portal item is read exactly once')
    assert.equal(browserCatalog.requests, 1)
    assert.equal(applied.status(), 200)
    const display = applied.request().postDataJSON().record.change.display
    assert.equal(display.earlySource.release.version, '10')
    assert.equal(display.recentOpacity, 0.5)
    renderGate.resolve()
    await waitForValue(() => upstream.nativeRequests.some(path => /\/tile\/10\//u.test(path)), 25_000, 'Viewport never requested the selected release tiles')
    assert.ok(upstream.nativeRequests.every(path => path.includes('GetCapabilities') || /\/tile\/10\//u.test(path)))
    await coldDialog.getByText(releaseTitle, { exact: true }).last().waitFor()
    await capture(coldDialog, 'browser-selected-dark')
    await closeImageryDialog(cold.page, coldDialog)
    const panel = await openUnifiedMapPanel(cold.page, 'imagery')
    await imageryRow(panel, 'early').getByText(releaseTitle, { exact: true }).waitFor()
    await imageryRow(panel, 'recent').getByText(/50%/u).waitFor()
    assert.equal(existsSync(catalogPath), true, 'the first admission creates the verified-release store')
    const verifiedBefore = loadVerifiedWaybackRelease(catalogPath, 10, display.earlySource.configDigest)
    assert.ok(verifiedBefore, 'the admitted release is persisted under its config digest')
    const hostCatalogDeniedBeforeReboot = upstream.hostCatalogDenied
    // Undo must not admit again: the admitted release stays remembered while the display is restored.
    await cold.page.setViewportSize({ width: 1280, height: 900 })
    await cold.page.locator('[data-sidebar-right-panel="push"][data-sidebar-right-open]').waitFor()
    await sendMessage(cold.page, '撤销早期影像。')
    await waitForValue(() => readDurableSessionEvents([mapHome], cold.sessionId)
      .some(event => event.type === 'tool/result' && event.data.meta?.change?.display?.earlySource === null
        && event.data.meta?.change?.display?.recentOpacity === 1), 15_000, 'Undo must persist the restored display state')
    await imageryRow(panel, 'recent').getByText(/100%/u).waitFor()
    assert.equal(await imageryRow(panel, 'early').locator('[data-map-panel-eye]').isDisabled(), true)
    assert.equal(cold.browserRequests.admit, 1, 'undo must not admit')
    assert.equal(browserCatalog.requests, 1)
    assert.equal(upstream.portalReads, 1)
    await capture(panel, 'browser-undo-dark')
    // Re-selecting the already admitted release reuses the remembered verification: no second admission.
    await cold.page.setViewportSize({ width: 390, height: 844 })
    const reselectDialog = await openImageryDialog(cold.page, 'early')
    const reselection = cold.page.waitForResponse(response => new URL(response.url()).pathname === '/api/map/change'
      && response.request().postDataJSON()?.record?.change?.op === 'set-imagery-display')
    await reselectDialog.locator('[data-map-wayback-release]').selectOption('10')
    assert.equal((await reselection).status(), 200)
    await closeImageryDialog(cold.page, reselectDialog)
    assert.equal(cold.browserRequests.admit, 2, 'each explicit choice is checked by the host')
    assert.equal(upstream.portalReads, 1, 'reselection uses the persisted proof')
    assert.deepEqual(hostWaybackReads, [], 'selection and undo never read operation=catalog')
    for (const page of context.pages()) await page.close()

    // Reboot with the same map home and the same browser profile: the cached catalog serves without S3 and without admission.
    heldCatalog.resolve()
    await stopApp()
    const warmUrl = await boot(providerPort, proxyPort, new URL(coldUrl).port)
    const warm = await openMap(warmUrl, context, cold.sessionId)
    assert.equal(browserCatalog.requests, 1, 'the browser must reuse its cached catalog after reboot')
    const warmDialog = await openImageryDialog(warm.page, 'early')
    const warmSelect = warmDialog.locator('[data-map-wayback-release]')
    await warmSelect.locator('option[value="10"]').waitFor({ state: 'attached', timeout: 15_000 })
    assert.equal(await warmSelect.inputValue(), '10', 'the persisted fixed selection is restored')
    await capture(warmDialog, 'browser-restored-dark')
    assert.equal(warm.browserRequests.admit, 0)
    assert.equal(browserCatalog.requests, 1)
    assert.equal(upstream.portalReads, 1)
    assert.ok(upstream.hostCatalogDenied >= hostCatalogDeniedBeforeReboot, 'background host sync does not supply the browser catalog')
    assert.equal(existsSync(catalogPath), true)
    assert.equal(loadVerifiedWaybackRelease(catalogPath, 7, '0'.repeat(64)), undefined)
    assert.deepEqual(loadVerifiedWaybackRelease(catalogPath, 10, display.earlySource.configDigest), { ...verifiedBefore })
    await closeImageryDialog(warm.page, warmDialog)
    assert.deepEqual(upstream.unexpectedAuthorities, [])
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(consoleErrors.filter(text => !/Failed to load resource/.test(text)), consoleErrors)
  } finally {
    heldCatalog.resolve()
    renderGate.resolve()
    try {
      await browser?.close()
    } finally {
      try {
        await stopApp()
      } finally {
        for (const socket of sockets) socket.destroy()
        await Promise.all([proxy, origin, provider].filter(server => server?.listening).map(server => new Promise(resolveClose => {
          server.close(resolveClose)
          server.closeAllConnections()
        })))
        rmSync(temp, { recursive: true, force: true })
      }
    }
  }
})

test('wayback: official catalog and fixed early imagery survive a cold restart', { timeout: 600_000 }, async t => {
  const strictLive = process.env.DSH_WAYBACK_LIVE === '1'
  if (!strictLive) {
    t.skip('official Wayback live lane requires DSH_WAYBACK_LIVE=1')
    return
  }
  const proxyUrl = process.env.DSH_WAYBACK_PROXY_URL ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? null
  const evidenceSecrets = proxyEvidenceSecrets(proxyUrl)
  const safeEvidence = (directory, name, content) => writeEvidence(directory, name, content, evidenceSecrets)
  const proxyOverlay = proxyUrl === null ? null : join(root, 'map', 'arcgis-mcp', 'tests', 'wayback-proxy.overlay.yml')
  const proxyEnv = proxyUrl === null ? {} : { DSH_WAYBACK_PROXY_URL: proxyUrl }
  const evidenceTemp = isolatedTemp(root, 'map-wayback-evidence-')
  const evidenceDir = join(evidenceTemp, 'evidence')
  t.after(() => rmSync(evidenceTemp, { recursive: true, force: true }))
  mkdirSync(evidenceDir, { recursive: true })
  const outbound = proxyUrl === null
    ? {}
    : { outboundProxy: { urlEnv: 'DSH_WAYBACK_PROXY_URL', targetResolution: 'proxy' } }
  const unavailable = (reason) => {
    const safeReason = redactEvidence(String(reason), evidenceSecrets)
    safeEvidence(evidenceDir, 'host-unavailable.json', JSON.stringify({ reason: safeReason }, null, 2))
    if (strictLive) throw new Error(`official Wayback unavailable: ${safeReason}`)
    t.skip(`official Wayback unavailable in this sandbox: ${safeReason}`)
  }
  // DNS resolves literal addresses on this host; the blocked hop is the direct
  // TCP connection. The product never uses ambient proxy variables: the lane
  // supplies an explicit proxy through deployment config, or stays direct.
  const dns = new Resolver({ timeout: 5_000, tries: 1 })
  const hostEvidence = { hostnames: ['s3-us-west-2.amazonaws.com', 'wayback.maptiles.arcgis.com', 'metadata.maptiles.arcgis.com'], resolved: {}, probe: null, proxy: proxyUrl === null ? 'direct' : 'explicit' }
  let skipped = false
  try {
    for (const hostname of hostEvidence.hostnames) {
      let resolved = []
      for (let attempt = 0; attempt < 3 && resolved.length === 0; attempt += 1) {
        if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 250))
        resolved = await dns.resolve4(hostname).catch(() => [])
      }
      hostEvidence.resolved[hostname] = resolved
      if (resolved.length === 0) {
        hostEvidence.reason = `no IPv4 addresses for ${hostname}`
        safeEvidence(evidenceDir, 'host-unavailable.json', JSON.stringify(hostEvidence, null, 2))
        unavailable(hostEvidence.reason)
        skipped = true
        return
      }
    }
    const { createSourceNetwork } = await import('../../map-container/src/source-network.ts')
    const { resolveSourceNetworkConfig } = await import('../../map-container/src/source-network-config.ts')
    const { waybackDescriptor } = await import('../../map-container/src/wayback.ts')
    const probe = createSourceNetwork(resolveSourceNetworkConfig({ requestTimeoutMs: 15_000, ...outbound }, { ...process.env, ...proxyEnv }))
    const source = { source: waybackDescriptor({
      releaseId: 1, itemId: '0'.repeat(32), title: 'World Imagery (Wayback 2014-02-20)',
      publishedAt: '2014-02-20', layerIdentifier: 'WB_2014_R01', acquiredAt: null,
    }), endpoint: 'https://wayback.maptiles.arcgis.com', allowPrivateNetwork: false, allowHttp: false }
    try {
      const response = await probe.request({
        source,
        url: new URL('https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/43291/0/0/0'),
        payload: 'json',
      })
      hostEvidence.probe = { status: response.status }
      if (response.status !== 200) {
        hostEvidence.reason = `tilemap probe returned HTTP ${String(response.status)}`
        safeEvidence(evidenceDir, 'host-unavailable.json', JSON.stringify(hostEvidence, null, 2))
        unavailable(hostEvidence.reason)
        skipped = true
        return
      }
    } finally {
      probe.dispose()
    }
  } catch (error) {
    const safeError = redactEvidence(String(error), evidenceSecrets)
    if (strictLive) throw new Error(safeError)
    hostEvidence.reason = safeError
    safeEvidence(evidenceDir, 'host-unavailable.json', JSON.stringify(hostEvidence, null, 2))
    t.skip(`official Wayback unavailable in this sandbox: ${safeError}`)
    return
  }
  assert.equal(skipped, false)
  safeEvidence(evidenceDir, 'host-preflight.json', JSON.stringify(hostEvidence, null, 2))
  const temp = isolatedTemp(root, 'map-wayback-composition-')
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# wayback composition\n')

  let mainRequests = 0
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      if (isTitleRequest(parsed)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(textResponse('wayback lane'))
        return
      }
      mainRequests += 1
      const transcript = JSON.stringify(parsed.messages)
      const lastMessage = parsed.messages.at(-1)
      const lastToolResult = Array.isArray(lastMessage?.content)
        ? lastMessage.content.find(part => part?.type === 'tool_result')
        : undefined
      // History keeps earlier instructions, so choose by the newest user text
      // rather than by anything anywhere in the transcript.
      const lastUserText = Array.isArray(lastMessage?.content)
        ? lastMessage.content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n')
        : typeof lastMessage?.content === 'string' ? lastMessage.content : ''
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (lastToolResult?.tool_use_id === 'wayback-view-beijing') {
        response.end(textResponse('北京已定位。'))
      } else if (lastToolResult?.tool_use_id === 'wayback-view-ocean') {
        response.end(textResponse('海洋已定位。'))
      } else if (lastUserText.includes('移动到北京')) {
        response.end(toolResponse([{ id: 'wayback-view-beijing', name: 'map_set_view', input: { center: [116.4, 39.9], zoom: 15, wkid: 4326 } }]))
      } else if (lastUserText.includes('移动到海洋')) {
        response.end(toolResponse([{ id: 'wayback-view-ocean', name: 'map_set_view', input: { center: [160, -30], zoom: 15, wkid: 4326 } }]))
      } else {
        response.end(textResponse('wayback acknowledged'))
      }
    })
  })

  let app
  let browser
  let page
  let liveNetwork
  const stdout = { value: '' }
  const stderr = { value: '' }
  const pageErrors = []
  const consoleErrors = []
  const networkFailures = []
  const waybackRequests = []
  const waybackTileRequests = []
  const waybackTileResponses = []
  const recentTileResponses = []
  const sourceRenderResponses = []
  const changeRequests = []
  const changeResponses = []
  const viewportRequests = []
  const viewportResponses = []
  const observe = (targetPage) => {
    targetPage.on('request', request => {
      const target = request.url()
      if (target.includes('/api/map/wayback')) waybackRequests.push(target)
      if (target.includes('/api/map/sources/resource')) waybackTileRequests.push(target)
      if (target.endsWith('/api/map/change')) changeRequests.push(target)
      if (target.endsWith('/api/map/viewport')) viewportRequests.push({ url: target, postData: request.postData() ?? '' })
    })
    targetPage.on('response', response => {
      if (response.url().includes('/api/map/sources/render')) {
        const entry = { status: response.status(), body: null }
        sourceRenderResponses.push(entry)
        void response.json().then(body => { entry.body = body }, () => {})
      }
      if (response.url().includes('/api/map/sources/resource')) {
        const entry = { url: response.url(), status: response.status(), contentType: response.headers()['content-type'] ?? null, magic: null }
        waybackTileResponses.push(entry)
        // Response headers alone do not prove imagery; keep the leading bytes
        // so the test can require a real JPEG/PNG signature.
        if (entry.status === 200) {
          void response.body().then(async body => {
            entry.magic = body.subarray(0, 4).toString('hex')
            try {
              await sharp(body).raw().toBuffer()
              entry.decoded = true
            } catch {
              entry.decoded = false
            }
          }, () => { entry.decoded = false })
        }
      }
      if (response.url().endsWith('/api/map/change')) {
        changeResponses.push({ status: response.status(), postData: response.request().postData() ?? '' })
      }
      if (response.url().endsWith('/api/map/viewport')) {
        viewportResponses.push({ status: response.status() })
      }
      if (response.status() >= 400 && !response.url().includes('favicon')) {
        networkFailures.push({ url: response.url(), status: response.status() })
      }
    })
  }
  // A tile only counts when its request identifies the accepted fixed-release
  // source: the digest embeds release id, title, and published date.
  const fixedReleaseTiles = digest => waybackTileRequests.filter(url2 => {
    const identity = new URL(url2).searchParams
    return identity.get('sourceId') === 'esri-wayback' && identity.get('configDigest') === digest
      && identity.get('request')?.toLowerCase() === 'gettile'
  })
  const decodedFixedReleaseTiles = digest => waybackTileResponses.filter(response => {
    const query = new URL(response.url).searchParams
    return response.status === 200 && response.decoded === true
      && query.get('sourceId') === 'esri-wayback' && query.get('request')?.toLowerCase() === 'gettile'
      && query.get('configDigest') === digest && /^image\//u.test(response.contentType ?? '')
      // JPEG is a 3-byte signature inside the captured four bytes, PNG is exactly four.
      && (response.magic?.startsWith('ffd8ff') === true || response.magic === '89504e47')
  })
  const boot = () => spawn(process.execPath, [
    mapBin, '--patch', pickerPatch,
    ...(proxyOverlay === null ? [] : ['--patch', proxyOverlay]),
    '--host', '127.0.0.1', '--port', String(appPortFor), '--no-open',
  ], {
    cwd: workspace,
    env: {
      ...process.env,
      ...proxyEnv,
      MAPHARNESS_HOME: mapHome,
      DSH_HOME: home,
      DEEPSEEK_API_KEY: 'gesture-composition-test',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(providerPortFor)}`,
      DSH_TELEMETRY_MODE: 'DISABLED',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  let appPortFor = 0
  let providerPortFor = 0
  try {
    providerPortFor = await listen(provider)
    appPortFor = await freePort()
    app = boot()
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { stdout.value += chunk })
    app.stderr.on('data', chunk => { stderr.value += chunk })
    const url = await waitForAppUrl(app, stdout, stderr)
    browser = await chromium.launch({
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1024, height: 768 } })
    await installScopedStorageKey(context)
    const { createSourceNetwork } = await import('../../map-container/src/source-network.ts')
    const { resolveSourceNetworkConfig } = await import('../../map-container/src/source-network-config.ts')
    const { waybackDescriptor } = await import('../../map-container/src/wayback.ts')
    liveNetwork = createSourceNetwork(resolveSourceNetworkConfig({ requestTimeoutMs: 30_000, ...outbound }, { ...process.env, ...proxyEnv }))
    const liveSource = { source: waybackDescriptor({
      releaseId: 1, itemId: '0'.repeat(32), title: 'World Imagery (Wayback 2014-02-20)',
      publishedAt: '2014-02-20', layerIdentifier: 'WB_2014_R01', acquiredAt: null,
    }), endpoint: fixtureImagery.origin, allowPrivateNetwork: false, allowHttp: false }
    page = await context.newPage()
    observe(page)
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    const openWaybackBranch = async () => {
      await openImageryDialog(page, 'early')
      const branch = page.locator('[data-map-wayback]')
      await branch.waitFor({ state: 'visible', timeout: 15_000 })
      return branch
    }
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useLiveImagery(page, liveNetwork, liveSource, recentTileResponses)
    // The first message materializes the tab strip and map occurrence.
    await sendMessage(page, '移动到北京。')
    await page.locator('[data-map-container]:visible').waitFor({ timeout: 30_000 })
    await waitForRenderedReceipt(page)
    const sessionId = await page.locator('[data-map-container]:visible').getAttribute('data-map-session')
    assert.ok(sessionId)

    await waitForCounter(() => mainRequests, 2)
    await waitForMapCamera(page, sessionId, [116.4, 39.9], 15)
    await waitForCounter(() => recentTileResponses.filter(response => response.status === 200 && response.format === 'jpeg').length, 1, 90_000)
    await closeUnifiedMapPanel(page)
    const recentFrame = await waitForImageryFrame(page)
    const waybackPanel = await openWaybackBranch()
    const releaseSelect = waybackPanel.locator('[data-map-wayback-release]')
    await page.waitForFunction(() => document.querySelector('[data-map-wayback-release]')?.options.length > 40,
      undefined, { timeout: 120_000 })
    const options = await releaseSelect.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, title: node.textContent })))
    const selectedReleaseId = options.filter(option => /^\d+$/u.test(option.value)).at(-1)?.value
    assert.ok(selectedReleaseId, 'the official catalog offers a fixed early release')
    assert.ok(options.length > 40)
    const changeResponseBaseline = changeResponses.length
    await releaseSelect.selectOption(selectedReleaseId)
    const acceptedEarly = await waitForAcceptedChange(changeResponses, changeResponseBaseline, 'set-imagery-display', 120_000)
    const display = acceptedEarly.record.change.display
    const earlySelection = display.earlySource
    assert.equal(earlySelection.id, 'esri-wayback')
    assert.equal(earlySelection.release.version, selectedReleaseId)
    assert.equal(earlySelection.release.acquiredAt, null)
    assert.ok(earlySelection.release.publishedAt)
    assert.deepEqual([display.earlyVisible, display.recentVisible, display.recentOpacity], [true, true, 0.5])
    await page.waitForFunction(expected => document.querySelector('[data-map-wayback-release]')?.value === expected,
      selectedReleaseId, { timeout: 60_000 })
    await waitForCounter(() => decodedFixedReleaseTiles(earlySelection.configDigest).length, 1, 90_000)
    await waitForCounter(() => sourceRenderResponses.filter(entry => entry.status === 200
      && entry.body?.earlyImagery?.source?.configDigest === earlySelection.configDigest).length, 1, 90_000)
    const earlyLogTexts = await waitForSessionNoticeTexts([home, mapHome, workspace],
      text => text.includes('[map-user-change v7 imagery]') && text.includes(`"operationId":"${acceptedEarly.record.operationId}"`)
        && text.includes(`"version":"${selectedReleaseId}"`), 15_000)
    assert.ok(earlyLogTexts.length > 0, 'the exact fixed release is persisted in the Session')
    const beforeRestartReceipt = await waitForImageryReceipt(page, sessionId, earlySelection.configDigest)
    await page.screenshot({ path: join(evidenceDir, 'wayback-blend-panel.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => document.body.hasAttribute('data-ds-dark-theme'))
    assert.match(await imageryRow(page, 'recent').innerText(), /50%/u)
    assert.match(await imageryRow(page, 'early').innerText(), /2014|Wayback/u)
    await page.screenshot({ path: join(evidenceDir, 'wayback-blend-panel-dark.png'), fullPage: true })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(() => !document.body.hasAttribute('data-ds-dark-theme'))
    const waybackDialog = page.getByRole('dialog').filter({ has: page.locator('[data-map-wayback]') })
    await closeImageryDialog(page, waybackDialog)
    await closeUnifiedMapPanel(page)
    const blendedFrame = await waitForImageryFrame(page, recentFrame)
    writeFileSync(join(evidenceDir, 'wayback-blended-map.png'), blendedFrame.png)
    safeEvidence(evidenceDir, 'wayback-beijing-fixed.json', JSON.stringify({
      optionCount: options.length, selectedReleaseId, publishedAt: earlySelection.release.publishedAt,
      acquiredAt: earlySelection.release.acquiredAt, display,
      recentTiles: recentTileResponses.length, fixedTiles: decodedFixedReleaseTiles(earlySelection.configDigest).length,
      changedPixelShare: changedPixelShare(recentFrame, blendedFrame), receipt: beforeRestartReceipt,
    }, null, 2))

    // Console noise is exempt only after this shutdown began: the page outlives
    // the spawned app, so teardown races are expected from here on. Anything
    // logged while the first app was live stays a product assertion.
    const consoleTeardownStart = consoleErrors.length
    await stopProcessTree(app)
    app = undefined
    app = boot()
    const secondStdout = { value: '' }
    const secondStderr = { value: '' }
    app.stdout.setEncoding('utf8')
    app.stderr.setEncoding('utf8')
    app.stdout.on('data', chunk => { secondStdout.value += chunk })
    app.stderr.on('data', chunk => { secondStderr.value += chunk })
    await waitForAppUrl(app, secondStdout, secondStderr)
    await page.close()
    // Old-page console events stop at close; the restarted page must be clean.
    const consoleTeardownEnd = consoleErrors.length
    page = await context.newPage()
    observe(page)
    page.on('pageerror', error => pageErrors.push(String(error)))
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await useLiveImagery(page, liveNetwork, liveSource, recentTileResponses)
    // Baselines are read after the old page is gone so its in-flight events
    // cannot satisfy the post-restart counters.
    const tilesBeforeReplay = fixedReleaseTiles(earlySelection.configDigest).length
    const tileImagesBeforeReplay = decodedFixedReleaseTiles(earlySelection.configDigest).length
    const rendersBeforeReplay = sourceRenderResponses.length
    const catalogBeforeReplay = waybackRequests.filter(request => request.includes('operation=catalog')).length
    await page.goto(url)
    await page.locator(`[data-map-container][data-map-session="${sessionId}"]:visible`).waitFor({ timeout: 30_000 })
    await waitForCounter(() => sourceRenderResponses.slice(rendersBeforeReplay).filter(entry => entry.status === 200
      && entry.body?.earlyImagery?.source?.configDigest === earlySelection.configDigest).length, 1, 90_000)
    const restoredRender = sourceRenderResponses.slice(rendersBeforeReplay).find(entry => entry.status === 200
      && entry.body?.earlyImagery?.source?.configDigest === earlySelection.configDigest).body
    assert.deepEqual(restoredRender.earlyImagery.source, earlySelection)
    assert.deepEqual(restoredRender.display, { labelsVisible: display.labelsVisible, recentVisible: true, recentOpacity: 0.5, earlyVisible: true })
    assert.equal(waybackRequests.filter(request => request.includes('operation=catalog')).length, catalogBeforeReplay,
      'the source restores before opening the Wayback catalog')
    await waitForCounter(() => fixedReleaseTiles(earlySelection.configDigest).length, tilesBeforeReplay + 1, 90_000).catch(() => {
      throw new Error('no wayback tile request after restart restored the fixed release')
    })
    await waitForCounter(() => decodedFixedReleaseTiles(earlySelection.configDigest).length, tileImagesBeforeReplay + 1, 90_000).catch(() => {
      throw new Error('no decodable wayback tile after restart restored the fixed release')
    })
    const restoredReceipt = await waitForImageryReceipt(page, sessionId, earlySelection.configDigest, beforeRestartReceipt.revision)
    assert.notEqual(restoredReceipt.viewId, beforeRestartReceipt.viewId, 'restart must render on a new live view')
    await closeUnifiedMapPanel(page)
    const restoredFrame = await waitForImageryFrame(page)
    await waitForMapCamera(page, sessionId, [116.4, 39.9], 15)
    writeFileSync(join(evidenceDir, 'wayback-restored-map.png'), restoredFrame.png)
    assert.ok(changedPixelShare(blendedFrame, restoredFrame) < changedPixelShare(recentFrame, restoredFrame),
      'the restored canvas must resemble the blend more than the recent-only map')
    safeEvidence(evidenceDir, 'wayback-restored-render.json', JSON.stringify({
      receipt: restoredReceipt, gridCoverage: restoredFrame.gridCoverage,
      differenceFromBlend: changedPixelShare(blendedFrame, restoredFrame),
      differenceFromRecent: changedPixelShare(recentFrame, restoredFrame),
    }, null, 2))
    const restoredWaybackPanel = await openWaybackBranch()
    assert.equal(await restoredWaybackPanel.locator('[data-map-wayback-release]').inputValue(), selectedReleaseId)

    const failures = `${stderr.value}\n${secondStderr.value}`.split('\n')
      .filter(line => /Error|error|failed|warn/.test(line)
        && !/key|token|secret|password|authorization/i.test(line)
        && !/did not activate|trace-warnings/.test(line))
      .slice(-10)
    safeEvidence(evidenceDir, 'wayback-tile-requests.json', JSON.stringify(waybackTileRequests, null, 2))
    safeEvidence(evidenceDir, 'app-stdout.log', stdout.value + secondStdout.value)
    safeEvidence(evidenceDir, 'app-stderr.log', stderr.value + secondStderr.value)
    assert.deepEqual(failures.map(line => redactEvidence(line, evidenceSecrets)), [])
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(networkFailures, [])
    // The page outlives each spawned app: closing and reopening it across the
    // restart races with teardown and handshake, so console noise recorded
    // between the shutdown and the old page's close on
    // ERR_INCOMPLETE_CHUNKED_ENCODING / remote.mux / ERR_CONNECTION_REFUSED is
    // transport churn. Errors while an app was live, and the restarted page's
    // own console, stay a product assertion.
    const teardownNoise = /ERR_INCOMPLETE_CHUNKED_ENCODING|remote\.mux|ERR_CONNECTION_REFUSED/u
    const productConsoleErrors = [
      ...consoleErrors.slice(0, consoleTeardownStart),
      ...consoleErrors.slice(consoleTeardownStart, consoleTeardownEnd).filter(text => !teardownNoise.test(text)),
      ...consoleErrors.slice(consoleTeardownEnd),
    ]
    assert.deepEqual(productConsoleErrors, [])
  } catch (error) {
    let dom = ''
    try {
      dom = await page?.locator('body').innerText({ timeout: 2_000 }) ?? ''
      if (page !== undefined) writeFileSync(join(evidenceDir, 'failure.png'), await page.screenshot({ fullPage: true }))
    } catch (domError) {
      dom = `DOM unavailable: ${String(domError)}`
    }
    safeEvidence(evidenceDir, 'failure.json', JSON.stringify({
      error: String(error),
      url: page?.url(),
      dom,
      pageErrors,
      consoleErrors,
      networkFailures,
      waybackRequests,
      waybackTileRequests,
      viewportRequests,
      viewportResponses,
      stdout: stdout.value,
      stderr: stderr.value,
      handles: await page?.evaluate(() => [...(window.__mapHarness?.entries() ?? [])].map(([key, value]) => ({
        key, camera: value.camera, center: value.center, zoom: value.zoom, receipt: value.renderReceipt,
      }))),
    }, null, 2))
    throw new Error(redactEvidence(`${String(error)}; recent=${JSON.stringify(recentTileResponses.slice(-8))}; network=${JSON.stringify(networkFailures.slice(-8))}; console=${JSON.stringify(consoleErrors.slice(-8))}`, evidenceSecrets))
  } finally {
    // Stop the app before closing the provider: a live app keeps provider
    // connections open and makes close() hang without a keepalive fix.
    if (app !== undefined) {
      await stopProcessTree(app).catch(() => {})
      app = undefined
    }
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    liveNetwork?.dispose()
    provider.closeAllConnections?.()
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})

test('final map state: the settled camera and hidden layer survive a page reload without another model request', { timeout: 240_000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'map-final-state-composition-'))
  const home = join(temp, 'home')
  const mapHome = join(temp, 'map-home')
  const workspace = join(temp, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), '# final map state\n')
  writeFileSync(join(workspace, 'final-points.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', id: 'f1', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { name: 'first' } },
      { type: 'Feature', id: 'f2', geometry: { type: 'Point', coordinates: [116.41, 39.9] }, properties: { name: 'second' } },
    ],
  }))

  let mainRequests = 0
  const bodies = []
  const changeRequests = []
  const provider = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      if (isTitleRequest(parsed)) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(textResponse('final state lane'))
        return
      }
      mainRequests += 1
      bodies.push(JSON.stringify(parsed.messages))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (mainRequests === 1) {
        response.end(toolResponse([
          { id: 'final-add', name: 'map_add_layer', input: { path: 'final-points.geojson', layer_id: 'final-layer', name: 'Final points' } },
          { id: 'final-view', name: 'map_set_view', input: { center: [116.4, 39.9], zoom: 9, wkid: 4326 } },
        ]))
      } else if (mainRequests === 2) {
        response.end(toolResponse([
          { id: 'final-hide', name: 'layer_set_state', input: { states: [{ layer_id: 'final-layer', visible: false }] } },
        ]))
      } else {
        response.end(textResponse('final setup done'))
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
        MAPHARNESS_HOME: mapHome,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'final-state-composition-test',
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
    await installScopedStorageKey(context)
    page = await context.newPage()
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/api/map/change')) {
        changeRequests.push(JSON.parse(request.postData() ?? '{}'))
      }
    })
    await page.goto(url)
    await maybeContinueNotice(page)
    await connectWorkspace(page, workspace)
    await chooseMapPreset(page)
    await useFixtureBasemap(page)
    await sendMessage(page, '准备最终状态地图。')
    await waitForCounter(() => mainRequests, 3)
    const mapBand = page.locator('[data-map-container]:not([data-map-view])')
    await mapBand.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForFunction(() => {
      const harness = window.__mapHarness
      return harness instanceof Map && [...harness.values()].some(value => value.layerCount === 1
        && value.center?.[0] === 116.4 && value.center?.[1] === 39.9 && value.zoom === 9)
    }, undefined, { timeout: 30_000 })
    const sessionId = await mapBand.getAttribute('data-map-session')
    assert.ok(typeof sessionId === 'string' && sessionId.length > 0)
    try {
      await waitForRenderedReceipt(page)
    } catch (error) {
      throw new Error(`${String(error)}\nReceipt state: ${JSON.stringify(await receiptDiagnostics(page))}`)
    }
    await openUnifiedMapPanel(page, 'ai')
    const hiddenEye = page.locator('[data-map-panel-layer]', { hasText: 'Final points' }).locator('[data-map-panel-eye]').first()
    await hiddenEye.waitFor({ timeout: 10_000 })
    assert.equal(await hiddenEye.getAttribute('aria-pressed'), 'false', 'the model layer write is the final hidden state')
    const evidenceDir = process.env.MAP_UI_REVIEW_EVIDENCE
    if (evidenceDir) {
      mkdirSync(evidenceDir, { recursive: true })
      await mapBand.screenshot({ path: join(evidenceDir, 'final-map-state-before.png') })
    }

    await closeUnifiedMapPanel(page)
    const cameraOf = () => page.evaluate(() => [...(window.__mapHarness?.values() ?? [])][0]?.camera ?? null)
    const cameraBefore = await cameraOf()
    const box = await mapBand.boundingBox()
    assert.ok(box !== null, 'the map band has geometry')
    const dragX = box.x + box.width * 0.25
    const dragY = box.y + box.height * 0.7
    await page.mouse.move(dragX, dragY)
    await page.mouse.down()
    await page.mouse.move(dragX + 140, dragY + 24, { steps: 12 })
    await page.mouse.up()
    await page.waitForTimeout(2_500)
    const cameraAfterDrag = await cameraOf()
    assert.ok(cameraBefore !== null && cameraAfterDrag !== null
      && (Math.abs(cameraAfterDrag.center[0] - cameraBefore.center[0]) > 0.005
        || Math.abs(cameraAfterDrag.center[1] - cameraBefore.center[1]) > 0.005),
      `the drag must move the live camera: ${JSON.stringify({ cameraBefore, cameraAfterDrag })}`)
    assert.ok(changeRequests.some(entry => entry.record?.change?.op === 'set-view'),
      'the settled camera is persisted through the user change route')
    assert.equal(mainRequests, 3, 'camera gestures never start another model request')
    assert.equal(bodies.some(body => body.includes('[map-gesture v1]')), false, 'gesture text never enters the conversation')
    if (evidenceDir) await mapBand.screenshot({ path: join(evidenceDir, 'final-map-state-after.png') })

    await page.reload()
    await page.locator(`[data-map-container][data-map-session="${sessionId}"]:visible`).waitFor({ timeout: 30_000 })
    await waitForMapCameraLoose(page, sessionId, cameraAfterDrag.center, cameraAfterDrag.zoom)
    await openUnifiedMapPanel(page, 'ai')
    const restoredEye = page.locator('[data-map-panel-layer]', { hasText: 'Final points' }).locator('[data-map-panel-eye]').first()
    await restoredEye.waitFor({ timeout: 10_000 })
    assert.equal(await restoredEye.getAttribute('aria-pressed'), 'false', 'the final layer state is restored')
    if (evidenceDir) {
      await mapBand.screenshot({ path: join(evidenceDir, 'final-map-state-restored.png') })
      writeEvidence(evidenceDir, 'final-map-state.json', {
        sessionId, cameraBefore, cameraAfterDrag, mainRequests,
        changeOps: changeRequests.map(entry => entry.record?.change?.op),
      })
    }
  } finally {
    if (page !== undefined) await page.close().catch(() => {})
    if (browser !== undefined) await browser.close().catch(() => {})
    if (app !== undefined) await stopProcessTree(app)
    provider.closeAllConnections()
    await new Promise(resolveClose => provider.close(resolveClose))
    rmSync(temp, { recursive: true, force: true })
  }
})
