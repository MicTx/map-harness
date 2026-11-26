/** Real built-profile and Chromium persistence isolation; all user data belongs to a temporary HOME. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { readMapInstance, resolveMapInstance } from '../bin/instance-home.mjs'
import { probeInstanceLock } from '../bin/instance-lock.mjs'

const repo = realpathSync(resolve(import.meta.dirname, '../..'))
const requireBrowser = createRequire(join(repo, 'map/spatial-accessibility/package.json'))
const { chromium } = requireBrowser('playwright')
const SESSION = 'browser-isolation-shared-session'
const VIEW_KEY = 'dsh.workspace.view.v5'
const SHORTCUT_KEY = 'dsh.keybindings.v1'
const fixtureResponse = 'The isolation fixture is ready.'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const redact = text => text.replace(/([?&]token=)[^\s"&]+/gu, '$1<redacted>')

/** Include directory entries and symlink destinations without following projected package links. */
/** The active spec package directory under `.spec/specs/`, from the bound `spec/<slug>` branch or the sole active package. */
function packageDir(root) {
  const specs = join(root, '.spec', 'specs')
  const branch = spawnSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  const fromBranch = branch.startsWith('spec/') ? branch.slice('spec/'.length) : ''
  if (fromBranch !== '' && existsSync(join(specs, fromBranch))) return join(specs, fromBranch)
  const active = readdirSync(specs, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== 'archive')
  if (active.length !== 1) throw new Error(`the isolation e2e needs exactly one active spec package under ${specs}; found ${active.length}`)
  return join(specs, active[0].name)
}

function fingerprint(directory) {
  if (!existsSync(directory)) return []
  function visit(at, prefix) {
    return readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
      const path = join(at, entry.name), name = prefix + entry.name
      if (entry.isSymbolicLink()) return [[name, 'link', readlinkSync(path)]]
      if (entry.isDirectory()) return [[name + '/', 'directory'], ...visit(path, name + '/')]
      assert.equal(entry.isFile(), true, `unexpected fixture file kind: ${name}`)
      return [[name, 'file', hash(readFileSync(path))]]
    })
  }
  return visit(directory, '')
}

function environment(home, modelUrl, overrides = {}) {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'LANG', 'LC_ALL'].flatMap(key =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]]))
  return {
    ...env, HOME: home, USERPROFILE: home, TMPDIR: join(home, 'tmp'), TEMP: join(home, 'tmp'), TMP: join(home, 'tmp'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
    DSH_HOME: join(home, '.dsh'), DSH_AGENTS_HOME: join(home, '.agents'),
    DSH_RESOURCE_CACHE: join(home, '.cache/deepseek-harness'),
    NODE_OPTIONS: '', DSH_TELEMETRY_MODE: 'DISABLED', DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'local-isolation-fixture', DEEPSEEK_BASE_URL: modelUrl, NO_PROXY: '127.0.0.1,localhost',
    ...overrides,
  }
}

/** Each child owns its process group; shutdown awaits pipe closure after termination. */
function launch(args, env, cwd) {
  const child = spawn(process.execPath, args, { env, cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', startupError
  const listeners = new Set()
  const consume = chunk => {
    output = (output + chunk.toString()).slice(-4 * 1024 * 1024)
    for (const listener of listeners) listener()
  }
  child.stdout.on('data', consume)
  child.stderr.on('data', consume)
  child.on('error', error => { startupError = error; for (const listener of listeners) listener() })
  let exit
  const closed = new Promise(resolveClosed => child.once('close', (code, signal) => {
    exit = { code, signal }
    for (const listener of listeners) listener()
    resolveClosed(exit)
  }))
  const kill = signal => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      if (process.platform === 'win32') child.kill(signal)
      else process.kill(-child.pid, signal)
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  let stopping
  return {
    child, closed, logs: () => redact(output), exit: () => exit,
    async ready() {
      return new Promise((resolveReady, rejectReady) => {
        const finish = (error, value) => {
          clearTimeout(timer); listeners.delete(check)
          if (error !== undefined) rejectReady(error)
          else resolveReady(value)
        }
        const check = () => {
          if (startupError !== undefined) return finish(startupError)
          if (child.exitCode !== null || child.signalCode !== null) return finish(new Error(`service exited before readiness\n${redact(output)}`))
          const url = /(?:dsh|map-harness) web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
          if (url !== undefined) finish(undefined, url)
        }
        const timer = setTimeout(() => finish(new Error(`service readiness deadline\n${redact(output)}`)), 60000)
        listeners.add(check)
        check()
      })
    },
    stop() {
      return stopping ??= (async () => {
        let forced = false
        const timer = setTimeout(() => { forced = true; kill('SIGKILL') }, 15000)
        try {
          kill('SIGTERM')
          const result = await closed
          assert.equal(forced, false, `service exceeded shutdown deadline\n${redact(output)}`)
          return result
        } finally { clearTimeout(timer) }
      })()
    },
  }
}

async function boundedExit(service, milliseconds = 30000) {
  let timer
  try {
    return await Promise.race([service.closed, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`child exit deadline\n${service.logs()}`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

async function exchange(url) {
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  await response.arrayBuffer()
  assert.equal(response.status, 303, 'real launch-token exchange must redirect')
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie, 'real Host did not set a browser Cookie')
  return cookie
}

async function rpc(url, cookie, method, args) {
  const rpcId = randomUUID()
  const response = await fetch(new URL('/api/' + method, url), {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }), signal: AbortSignal.timeout(30000),
  })
  assert.equal(response.status, 200, `${method} HTTP ${response.status}: ${await response.clone().text()}`)
  const envelope = await response.json()
  assert.equal(envelope.rpcId, rpcId)
  assert.equal(envelope.result.ok, true, `${method}: ${JSON.stringify(envelope.result.error)}`)
  return envelope.result.value
}

async function storageBytes(page) {
  return page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort().map(key => [key, localStorage.getItem(key)])))
}

function prefix(namespace) { return namespace === '' ? '' : `dsh.scope:${namespace.length}:${namespace}:` }
function ownBytes(bytes, namespace) {
  const pre = prefix(namespace)
  return Object.fromEntries(Object.entries(bytes).filter(([key]) => pre === '' ? !key.startsWith('dsh.scope:') : key.startsWith(pre)))
}
function assertRetained(bytes, prior, namespace = '') {
  assert.deepEqual(ownBytes(bytes, namespace), prior, `foreign scope bytes or key inventory changed: ${namespace || 'stock'}`)
}

/** One Session occurrence's receipt records an asynchronous browser observation, not user state. */
const RECEIPT_PREFIX = 'map-render-receipt:'
function persistentBytes(bytes, namespace) {
  const pre = prefix(namespace)
  return Object.fromEntries(Object.entries(bytes).filter(([key]) => {
    if (pre === '' ? key.startsWith('dsh.scope:') : !key.startsWith(pre)) return false
    return !key.slice(pre.length).startsWith(RECEIPT_PREFIX)
  }))
}
function assertPersistentRetained(bytes, prior, namespace) {
  assert.deepEqual(persistentBytes(bytes, namespace), persistentBytes(prior, namespace),
    `foreign scope user state or key inventory changed: ${namespace || 'stock'}`)
}
function receiptKeys(bytes, namespace) {
  const pre = prefix(namespace)
  return Object.keys(bytes).filter(key => key.startsWith(pre + RECEIPT_PREFIX))
}
function assertScopeReceipts(bytes, namespace, sessionOccurrence) {
  const keys = receiptKeys(bytes, namespace)
  assert.deepEqual(keys, [prefix(namespace) + RECEIPT_PREFIX + JSON.stringify(sessionOccurrence)],
    `scope must own exactly its one render receipt: ${namespace}`)
  assert.equal(receiptKeys(bytes, '').length, 0, 'stock namespace must never receive a Map render receipt')
}

function shortcutBinding(bytes, namespace) {
  const document = JSON.parse(bytes[prefix(namespace) + SHORTCUT_KEY])
  const profile = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'
  return document.profiles[`web:${profile}`]['sidebar.left.toggle']
}

async function waitStorage(page, namespace, key, predicate) {
  const physical = prefix(namespace) + key
  await page.waitForFunction(({ key, predicate }) => {
    const raw = localStorage.getItem(key)
    return raw !== null && raw.includes(predicate)
  }, { key: physical, predicate }, { timeout: 15000 })
}

async function editDraft(page, text) {
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await input.waitFor({ timeout: 30000 })
  await input.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.type(text)
  assert.equal(await input.innerText(), text)
  return input
}

async function chooseView(page, choice) {
  await page.getByRole('button', { name: 'View options', exact: true }).click()
  await page.getByRole('menuitem', { name: choice, exact: true }).click()
}

async function shortcuts(page) {
  await page.getByRole('button', { name: 'Account menu', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Edit shortcuts', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts', exact: true })
  await dialog.waitFor()
  return dialog
}

async function closeShortcuts(page) {
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await page.getByRole('dialog', { name: 'Settings', exact: true }).waitFor({ state: 'hidden' })
}

async function setShortcut(page, binding) {
  const dialog = await shortcuts(page)
  const edit = dialog.getByRole('button', { name: 'Edit shortcut for Toggle left sidebar', exact: true })
  await edit.click()
  const group = dialog.getByRole('group', { name: 'Toggle left sidebar', exact: true })
  if (binding === null) await group.getByRole('button', { name: 'Remove', exact: true }).click()
  else await page.keyboard.press(binding)
  await group.waitFor({ state: 'hidden' })
  return dialog
}

async function setSidebar(page, collapsed) {
  const expand = page.locator('[data-sidebar-right-expand]')
  const toggle = page.locator('[data-sidebar-right-toggle]:visible').first()
  const open = page.locator('[data-sidebar-right-open]')
  if (collapsed) {
    // Exercise the actual collapse write even when a fresh Session begins closed.
    if (await expand.isVisible()) await expand.click()
    await toggle.click()
    await expand.waitFor({ state: 'visible' })
    await open.waitFor({ state: 'hidden' })
  } else {
    if (await expand.isVisible()) await expand.click()
    await open.waitFor({ state: 'visible' })
    await toggle.waitFor({ state: 'visible' })
  }
}

/** Own a deterministic provider instead of contacting a real model while creating a nonblank Session. */
async function modelFixture(t) {
  const calls = []
  const server = createServer((request, response) => {
    request.resume()
    request.once('end', () => {
      calls.push({ method: request.method, url: request.url })
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-flash', object: 'model' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = [
        { type: 'message_start', message: { id: 'isolation-fixture', model: 'deepseek-v4-flash', usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: fixtureResponse } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
      response.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''))
    })
  })
  t.after(() => new Promise((resolveClosed, rejectClosed) => {
    server.close(error => error ? rejectClosed(error) : resolveClosed())
    server.closeAllConnections()
  }))
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return { url: `http://127.0.0.1:${address.port}`, calls }
}

test('real Chromium keeps DSH → Map A → Map B → A isolated on one origin and preserves stock home', { timeout: 300000 }, async t => {
  for (const file of ['apps/cli/lib/bin.js', 'apps/web/dist/index.html', 'map/map-container/lib/client.js']) {
    assert.ok(existsSync(join(repo, file)), `built artifact is required: ${file}`)
  }
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map-browser-isolation-')))
  const userHome = join(root, 'synthetic user 中文')
  mkdirSync(join(userHome, 'tmp'), { recursive: true })
  const work = join(root, 'workspace')
  mkdirSync(work)
  const evidence = join(packageDir(repo), 'evidence', `browser-${Date.now()}-${process.pid}`)
  mkdirSync(evidence, { recursive: true })
  const report = { runner: 'built-cli-with-source-map-prelude', browser: 'Chromium', platform: process.platform,
    outcome: 'running', flows: [], screenshots: [], pageErrors: [], limitations: [
      'Runs the built CLI/Web artifacts through the source Map preload wrapper; it is not a native SEA or Windows qualification.',
      'State recovery is session-cookie-independent browser local storage on one loopback origin; the separate Cookie check covers server audiences.',
    ] }
  const services = []
  let browser, context, page
  const shutdown = async () => {
    const failures = []
    try { await context?.close() } catch (error) { failures.push(error) }
    try { await browser?.close() } catch (error) { failures.push(error) }
    for (const service of services.toReversed()) {
      try { await service.stop() } catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'browser isolation cleanup failed')
  }
  t.after(async () => { try { await shutdown() } finally { rmSync(root, { recursive: true, force: true }) } })
  const provider = await modelFixture(t)
  const env = environment(userHome, provider.url)
  const picker = join(repo, 'apps/web/tests/pin-browse-picker.overlay.yml')
  const cli = join(repo, 'apps/cli/lib/bin.js')
  const map = join(repo, 'map/bin/map-harness.mjs')
  const stockArgs = port => [cli, '--profile', 'web', '--patch', picker, '--no-open', '--port', String(port)]
  const mapArgs = port => [map, '--patch', picker, '--no-open', '--port', String(port)]
  const screenshot = async (id, description) => {
    const path = join(evidence, id + '.png')
    await page.screenshot({ path, fullPage: true })
    report.screenshots.push({ path: relative(dirname(evidence), path).replaceAll('\\', '/'), sha256: hash(readFileSync(path)), description, step: id, format: 'png' })
  }
  const start = async (label, port, overrides = {}) => {
    const service = launch(label === 'stock' ? stockArgs(port) : mapArgs(port), { ...env, ...overrides }, work)
    services.push(service)
    const url = await service.ready()
    if (port !== 0) assert.equal(Number(new URL(url).port), port, 'instance switch must retain the same origin')
    const cookie = await exchange(url)
    report.flows.push({ id: label + '-start', observed: { origin: new URL(url).origin, pid: service.child.pid } })
    return { ...service, url, cookie }
  }
  const seed = async server => {
    const created = await rpc(server.url, server.cookie, 'workspace/create', { request: { path: work } })
    const result = await rpc(server.url, server.cookie, 'session/create', { request: {
      workspaceId: created.workspace.workspaceId, sessionId: SESSION,
    } })
    assert.equal(result.sessionId, SESSION)
  }
  const visit = async (server, expectedNamespace, first) => {
    await page.goto(server.url, { waitUntil: 'load' })
    await page.locator('[data-slot="root"]').waitFor({ state: 'attached', timeout: 30000 })
    if (first) {
      const notice = page.getByRole('button', { name: 'Continue', exact: true })
      await notice.click({ timeout: 30000 })
      await notice.waitFor({ state: 'hidden' })
    }
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ timeout: 30000 })
    assert.equal(await page.evaluate(() => window.__DSH_BROWSER_STORAGE_NAMESPACE__), expectedNamespace)
    await waitStorage(page, expectedNamespace, 'dsh.sessions.current', SESSION)
    if (first) {
      assert.equal(await page.locator('[data-composer-input][contenteditable="true"]').first().innerText(), '', 'fresh instance imported another scope draft')
      const input = await editDraft(page, 'Initialize the isolated browser fixture')
      await input.press('Enter')
      await page.getByText(fixtureResponse, { exact: true }).first().waitFor({ timeout: 30000 })
    }
  }
  try {
    browser = await chromium.launch({ headless: true })
    context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1000 }, colorScheme: 'light' })
    page = await context.newPage()
    page.on('pageerror', error => { report.pageErrors.push(String(error)) })
    page.setDefaultTimeout(20000)
    const stock = await start('stock', 0)
    const port = Number(new URL(stock.url).port)
    await seed(stock)
    await visit(stock, '', true)
    await editDraft(page, 'Stock DSH draft')
    await chooseView(page, 'Manual')
    await setSidebar(page, false)
    await setShortcut(page, 'ControlOrMeta+Shift+Period')
    await screenshot('stock-shortcuts', 'Stock DSH shortcut selection before switching instances')
    await closeShortcuts(page)
    await waitStorage(page, '', `dsh.conversation.${SESSION}`, 'Stock DSH draft')
    await screenshot('stock-state', 'Stock DSH draft, workspace preference and right sidebar')
    const stockBytes = await storageBytes(page)
    assert.equal(shortcutBinding(stockBytes, '').code, 'Period')
    assert.equal(JSON.parse(stockBytes[VIEW_KEY]).orderBy, 'manual')
    assert.equal(JSON.parse(stockBytes[`dsh.sidebar-right.v1.${SESSION}`]).bySession[SESSION].layout.expanded, true)
    await page.goto('about:blank')
    await stock.stop()

    for (const [path, text] of [['.dsh/isolation.sentinel', 'stock DSH bytes\n'], ['.agents/isolation.sentinel', 'stock agents bytes\n'],
      ['.cache/deepseek-harness/isolation.sentinel', 'stock runtime bytes\n']]) {
      mkdirSync(dirname(join(userHome, path)), { recursive: true })
      writeFileSync(join(userHome, path), text)
    }
    const stockTrees = ['.dsh', '.agents', '.cache/deepseek-harness'].map(path => [path, fingerprint(join(userHome, path))])
    const checkStock = () => { for (const [path, before] of stockTrees) assert.deepEqual(fingerprint(join(userHome, path)), before, `${path} changed`) }
    const aSpec = resolveMapInstance({ mode: 'source', checkoutRoot: repo, installRoots: [repo], env, cwd: work, homedir: userHome })
    const a = await start('map-a', port)
    const aInstance = readMapInstance(aSpec)
    assert.ok(aInstance)
    assert.equal(aSpec.overridden, false)
    assert.equal(aInstance.home, join(userHome, '.map-harness-dev', aSpec.checkoutKey))
    assert.ok(existsSync(join(aInstance.home, 'profiles/map-web/package.json')))
    assert.ok(existsSync(join(aInstance.home, 'map-run/instance.lock')))
    assert.equal(await probeInstanceLock(aInstance), 'locked')
    report.defaultMapHome = { relativePath: relative(userHome, aInstance.home), marker: 'map-instance.json',
      profile: 'profiles/map-web/package.json', lock: 'map-run/instance.lock', initialKernelState: 'locked' }
    const namespaceA = `map-harness:${aInstance.instanceId}`
    await seed(a)
    await visit(a, namespaceA, true)
    assertRetained(await storageBytes(page), stockBytes)
    await editDraft(page, 'Map A draft')
    await chooseView(page, 'In one list')
    await setSidebar(page, true)
    const aDialog = await setShortcut(page, null)
    await aDialog.getByRole('listitem').filter({ has: page.getByText('Toggle left sidebar', { exact: true }) })
      .getByText('No shortcut', { exact: true }).waitFor()
    await screenshot('map-a-shortcuts', 'Map A remembers an unbound left-sidebar shortcut independently of stock DSH')
    await closeShortcuts(page)
    await waitStorage(page, namespaceA, `dsh.conversation.${SESSION}`, 'Map A draft')
    await waitStorage(page, namespaceA, VIEW_KEY, 'flat')
    await screenshot('map-a-state', 'Map A draft and flattened workspace list with the right sidebar collapsed')
    const aSlice = await storageBytes(page)
    const aBytes = ownBytes(aSlice, namespaceA)
    assert.equal(shortcutBinding(aBytes, namespaceA), null)
    assert.equal(JSON.parse(aBytes[prefix(namespaceA) + `dsh.sidebar-right.v1.${SESSION}`]).bySession[SESSION].layout.expanded, false)
    assertScopeReceipts(aSlice, namespaceA, [SESSION, 'tab2'])
    assertRetained(aSlice, stockBytes)
    checkStock()

    const profileBefore = fingerprint(join(aInstance.home, 'profiles'))
    const busy = launch(mapArgs(0), env, work)
    services.push(busy)
    const busyExit = await boundedExit(busy)
    assert.equal(busyExit.signal, null)
    assert.notEqual(busyExit.code, 0)
    assert.match(busy.logs(), /MAP_INSTANCE_BUSY/u)
    assert.deepEqual(fingerprint(join(aInstance.home, 'profiles')), profileBefore)
    assert.equal(await probeInstanceLock(aInstance), 'locked')
    report.flows.push({ id: 'busy', criteria: ['C3', 'C11'], result: 'pass', observed: 'Second real Map launch reports MAP_INSTANCE_BUSY before profile writes; original kernel lease remains held.' })
    await page.goto('about:blank')
    await a.stop()
    assert.equal(await probeInstanceLock(aInstance), 'stopped')

    const bHome = join(userHome, 'map-b')
    const b = await start('map-b', port, { MAPHARNESS_HOME: bHome })
    const bSpec = resolveMapInstance({ mode: 'source', checkoutRoot: repo, installRoots: [repo], env: { ...env, MAPHARNESS_HOME: bHome }, cwd: work, homedir: userHome })
    const bInstance = readMapInstance(bSpec)
    assert.ok(bInstance)
    assert.notEqual(bInstance.instanceId, aInstance.instanceId)
    const namespaceB = `map-harness:${bInstance.instanceId}`
    await seed(b)
    await visit(b, namespaceB, true)
    const bArrival = await storageBytes(page)
    assertRetained(bArrival, stockBytes)
    assertPersistentRetained(bArrival, aBytes, namespaceA)
    assertScopeReceipts(bArrival, namespaceA, [SESSION, 'tab2'])
    await editDraft(page, 'Map B draft')
    await chooseView(page, 'Manual')
    await setSidebar(page, false)
    await setShortcut(page, 'ControlOrMeta+Shift+Comma')
    await screenshot('map-b-shortcuts', 'Map B shortcut differs from Map A and stock DSH')
    await closeShortcuts(page)
    await waitStorage(page, namespaceB, `dsh.conversation.${SESSION}`, 'Map B draft')
    await screenshot('map-b-state', 'Map B owns its draft and expanded right sidebar on the same browser origin')
    const bSlice = await storageBytes(page)
    const bBytes = ownBytes(bSlice, namespaceB)
    assert.equal(shortcutBinding(bBytes, namespaceB).code, 'Comma')
    assert.equal(JSON.parse(bBytes[prefix(namespaceB) + VIEW_KEY]).orderBy, 'manual')
    assert.equal(JSON.parse(bBytes[prefix(namespaceB) + `dsh.sidebar-right.v1.${SESSION}`]).bySession[SESSION].layout.expanded, true)
    assertScopeReceipts(bSlice, namespaceB, [SESSION, 'tab2'])
    assertRetained(bSlice, stockBytes)
    assertPersistentRetained(bSlice, aBytes, namespaceA)
    assertScopeReceipts(bSlice, namespaceA, [SESSION, 'tab2'])
    checkStock()
    await page.goto('about:blank')
    await b.stop()
    assert.equal(await probeInstanceLock(bInstance), 'stopped')

    const reopened = await start('map-a-reopened', port)
    await visit(reopened, namespaceA, false)
    assert.equal(await page.locator('[data-composer-input][contenteditable="true"]').first().innerText(), 'Map A draft')
    await page.locator('[data-sidebar-right-expand]').waitFor({ state: 'visible' })
    assert.equal(JSON.parse((await storageBytes(page))[prefix(namespaceA) + VIEW_KEY]).groupBy, 'flat')
    const aReopened = await storageBytes(page)
    assertRetained(aReopened, stockBytes)
    assertPersistentRetained(aReopened, bBytes, namespaceB)
    assertScopeReceipts(aReopened, namespaceB, [SESSION, 'tab2'])
    await screenshot('map-a-restored', 'Map A restores its own draft, flat workspace view and collapsed right sidebar after Map B')
    const restoredDialog = await shortcuts(page)
    await restoredDialog.getByRole('listitem').filter({ has: page.getByText('Toggle left sidebar', { exact: true }) })
      .getByText('No shortcut', { exact: true }).waitFor()
    await screenshot('map-a-shortcuts-restored', 'Map A restores its unbound shortcut after Map B used a different binding')
    await closeShortcuts(page)
    const ownSessions = await rpc(reopened.url, reopened.cookie, 'session/list', { _request: {} })
    assert.equal(ownSessions.items.some(item => item.sessionId === SESSION), true, 'same-scope Cookie must authenticate')
    const cookies = await context.cookies(reopened.url)
    const cookieNames = [stock.cookie, a.cookie, b.cookie].map(cookie => cookie.split('=', 1)[0])
    assert.equal(new Set(cookieNames).size, 3)
    assert.equal(reopened.cookie.split('=', 1)[0], cookieNames[1])
    for (const name of cookieNames) assert.ok(cookies.some(cookie => cookie.name === name), 'same browser context retains all three Cookie names')
    report.cookieNames = cookieNames
    for (const foreign of [stock.cookie, b.cookie]) {
      for (const cookie of [foreign, reopened.cookie.split('=', 1)[0] + foreign.slice(foreign.indexOf('='))]) {
        const response = await fetch(new URL('/api', reopened.url), { headers: { cookie }, signal: AbortSignal.timeout(15000) })
        await response.arrayBuffer()
        assert.equal(response.status, 401, 'foreign or renamed Cookie authenticated in Map A')
      }
    }
    const finalBytes = await storageBytes(page)
    assertRetained(finalBytes, stockBytes)
    assertPersistentRetained(finalBytes, bBytes, namespaceB)
    assertScopeReceipts(finalBytes, namespaceA, [SESSION, 'tab2'])
    assertScopeReceipts(finalBytes, namespaceB, [SESSION, 'tab2'])
    assert.equal(finalBytes[prefix(namespaceA) + SHORTCUT_KEY], aBytes[prefix(namespaceA) + SHORTCUT_KEY])
    report.storage = [
      { namespace: '', bytes: stockBytes }, { namespace: namespaceA, bytes: aBytes }, { namespace: namespaceB, bytes: bBytes },
    ].map(({ namespace, bytes }) => ({ namespace,
      keys: Object.entries(bytes).map(([key, value]) => ({ key, sha256: hash(value), byteLength: Buffer.byteLength(value) })),
    }))
    await page.goto('about:blank')
    await reopened.stop()
    assert.equal(await probeInstanceLock(aInstance), 'stopped')
    report.defaultMapHome.finalKernelState = 'stopped'
    checkStock()
    assert.equal(readMapInstance(aSpec).instanceId, aInstance.instanceId)
    assert.deepEqual(report.pageErrors, [])
    report.outcome = 'passed'
    report.origin = new URL(stock.url).origin
    report.namespaces = ['', namespaceA, namespaceB]
    report.stockDirectoryHashes = stockTrees.map(([path, value]) => ({ path, sha256: hash(JSON.stringify(value)) }))
    report.flows.push({ id: 'same-origin-state', criteria: ['C4', 'C11'], result: 'pass',
      observed: 'One Chromium context used DSH → Map A → Map B → Map A; keyboard and pointer edits persisted independently; foreign key bytes and stock-home fingerprints remained unchanged.' })
    report.flows.push({ id: 'cookies', criteria: ['C4'], result: 'pass', observed: 'Real HTTP rejects stock/B Cookies and renamed values with 401 in Map A.' })
    report.providerCalls = provider.calls
  } catch (error) {
    report.outcome = 'failed'
    report.error = redact(String(error.stack ?? error))
    if (page !== undefined && !page.isClosed()) {
      try { await screenshot('failure', 'Browser state at the failing assertion') } catch (captureError) { report.captureError = String(captureError) }
      try { report.dom = await page.locator('body').innerText() } catch (captureError) { report.domError = String(captureError) }
    }
    throw error
  } finally {
    report.services = services.map(service => ({ pid: service.child.pid, logs: service.logs() }))
    writeFileSync(join(evidence, 'flow.json'), JSON.stringify(report, null, 2) + '\n')
    console.log(`browser isolation evidence: ${relative(repo, evidence)}`)
    await shutdown()
  }
})
