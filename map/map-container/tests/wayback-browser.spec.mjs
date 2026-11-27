import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '../../../apps/web/node_modules/playwright/index.mjs'
import { freeHmrPort } from './free-hmr-port.mjs'

const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url))

test('imagery tabs and admitted Wayback selection remain reachable at 390px', { timeout: 120_000 }, async t => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'wayback-vite-'))
  const hmrPort = await freeHmrPort()
  let vite
  t.after(async () => {
    try { await vite?.close() } finally { await rm(cacheDir, { recursive: true, force: true }) }
  })
  vite = await webRequire('vite').createServer({
    cacheDir,
    configFile: false,
    root: new URL('../../..', import.meta.url).pathname,
    appType: 'custom',
    resolve: { alias: [
      // The real shell compiles primitive module CSS into the loader's deferred
      // stylesheets; a direct-import page needs the same styles from source.
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: new URL('../../../packages/client/ui-primitives/src/index.ts', import.meta.url).pathname },
      { find: 'react-dom/client', replacement: webRequire.resolve('react-dom/client') },
    ] },
    server: { middlewareMode: true, hmr: { port: hmrPort } },
  })
  const server = createHttpServer((request, response) => {
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/map/map-container/tests/wayback-panel-browser-entry.tsx"></script></body></html>')
      return
    }
    vite.middlewares(request, response)
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()))
  const { port } = server.address()
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
  t.after(() => context.close())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(`http://127.0.0.1:${port}/`)

  await page.locator('[data-map-panel-collapse]').click()
  await page.locator('[data-map-panel-tab="imagery"]').click()
  const rows = page.locator('[data-map-imagery-row]')
  await rows.nth(0).waitFor()
  assert.equal(await rows.count(), 3)
  const eyes = page.locator('[data-map-imagery-row] [data-map-panel-eye]')
  assert.deepEqual(await eyes.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-pressed'))), ['true', 'true', 'false'])

  // Hidden tab panels collapse their controls to 0x0; each tab's controls are
  // asserted right after that tab is activated, skipping controls inside [hidden].
  const assertVisibleControls = async () => {
    const geometry = await page.evaluate(() => {
      const selectors = ['[data-map-panel-eye]', '[data-map-panel-source]', '[data-map-imagery-opacity]', '[data-map-wayback-release]']
      const controls = selectors.flatMap(selector => [...document.querySelectorAll(selector)])
        .filter(element => element.closest('[hidden]') === null)
      return {
        viewport: [window.innerWidth, window.innerHeight],
        scrollWidth: document.documentElement.scrollWidth,
        controls: controls.map(element => {
          element.scrollIntoView({ block: 'center', inline: 'nearest' })
          const rect = element.getBoundingClientRect()
          return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
        }),
      }
    })
    assert.equal(geometry.scrollWidth <= geometry.viewport[0], true)
    for (const control of geometry.controls) {
      assert.ok(control.width > 0 && control.height > 0 && control.x >= 0 && control.right <= geometry.viewport[0]
        && control.y >= 0 && control.bottom <= geometry.viewport[1], JSON.stringify(control))
    }
  }
  await assertVisibleControls()

  const earlyRow = page.locator('[data-map-imagery-row][data-imagery-kind="early"]')
  await earlyRow.locator('button[aria-haspopup="dialog"]').click()
  const releaseSelect = page.locator('[data-map-wayback-release]')
  await page.waitForFunction(() => document.querySelectorAll('[data-map-wayback-release] option').length === 3)
  assert.deepEqual(await releaseSelect.evaluateAll(nodes => nodes.map(node => node.disabled)), [false])
  await releaseSelect.selectOption('10')
  await page.waitForFunction(() => window.waybackFixture.changes.some(change => change.op === 'set-imagery-display'))
  assert.deepEqual(await page.evaluate(() => window.waybackFixture.admits), [{
    method: 'POST', credentials: 'same-origin',
    body: { sessionId: 'fixture', release: { releaseId: 10, itemId: 'a'.repeat(32), publishedAt: '2014-02-20', layerIdentifier: 'WB_2014_R01' } },
  }])
  assert.deepEqual(await page.evaluate(() => window.waybackFixture.submitted), [{ revision: 0 }])
  assert.equal(await page.evaluate(() => window.waybackFixture.changes.at(-1).display.recentOpacity), 0.5)
  assert.equal(await releaseSelect.inputValue(), '10')
  await assertVisibleControls()
  // Only the admission route is read; the local catalog is never polled.
  assert.deepEqual(await page.evaluate(() => window.waybackFixture.requests), ['/api/map/wayback/admit'])

  // A refused admission is reported inside the dialog and keeps the selection.
  await page.evaluate(() => window.waybackFixture.setAdmissionFailure(true))
  await releaseSelect.selectOption('50')
  await page.locator('[data-map-wayback-failure]').waitFor()
  assert.equal(await page.evaluate(() => window.waybackFixture.submitted.length), 1)
  assert.equal(await releaseSelect.inputValue(), '10')
  await page.evaluate(() => window.waybackFixture.setAdmissionFailure(false))
  assert.equal(await earlyRow.locator('[data-map-panel-eye]').getAttribute('aria-pressed'), 'true')
  await page.evaluate(() => {
    const dialog = document.querySelector('[data-map-imagery-dialog]')?.closest('[role="dialog"]')
    const close = dialog?.querySelector('button[aria-label*="关闭"], button[aria-label*="Close"]')
    if (close instanceof HTMLElement) close.click()
  })

  await page.locator('[data-map-imagery-row][data-imagery-kind="recent"] button[aria-haspopup="dialog"]').click()
  const opacity = page.locator('[data-map-imagery-opacity]')
  assert.equal(await opacity.inputValue(), '0.5')
  await opacity.fill('0.45')
  await page.waitForFunction(() => window.waybackFixture.changes.some(change => change.op === 'set-imagery-display' && change.display.recentOpacity === 0.45))
  await assertVisibleControls()
  await page.evaluate(() => {
    const dialog = document.querySelector('[data-map-imagery-dialog]')?.closest('[role="dialog"]')
    const close = dialog?.querySelector('button[aria-label*="关闭"], button[aria-label*="Close"]')
    if (close instanceof HTMLElement) close.click()
  })

  // A failed refresh keeps the last verified list, the selection, and raises no error.
  await page.locator('[data-map-imagery-row][data-imagery-kind="early"] button[aria-haspopup="dialog"]').click()
  await page.locator('[data-map-wayback-release]').waitFor()
  await page.evaluate(() => window.waybackFixture.setCatalogFailure(true))
  await page.evaluate(() => window.waybackFixture.refresh())
  await page.waitForFunction(() => window.waybackFixture.snapshot().reason === 'http')
  assert.equal(await page.locator('[data-map-wayback-release]').inputValue(), '10')
  assert.equal(await page.locator('[data-map-wayback-release] option').count(), 3)
  assert.equal(await page.locator('[data-map-wayback] [role="alert"]').count(), 0)
  assert.deepEqual(errors, [])
})
