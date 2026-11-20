import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { chromium } from '../../../apps/web/node_modules/playwright/index.mjs'
import { freeHmrPort } from './free-hmr-port.mjs'

const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url))

test('imagery tabs and direct Wayback selection remain reachable at 390px', { timeout: 120_000 }, async t => {
  const hmrPort = await freeHmrPort()
  const vite = await webRequire('vite').createServer({
    configFile: false,
    root: new URL('../../..', import.meta.url).pathname,
    appType: 'custom',
    resolve: { alias: { 'react-dom/client': webRequire.resolve('react-dom/client') } },
    server: { middlewareMode: true, hmr: { port: hmrPort } },
  })
  t.after(() => vite.close())
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
  await page.locator('[data-map-panel-section="imagery"] [data-map-panel-section-caret]').click()
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
  await releaseSelect.waitFor()
  await releaseSelect.selectOption('10')
  await page.waitForFunction(() => window.waybackFixture.changes.some(change => change.op === 'set-imagery-display'))
  await assertVisibleControls()
  const requests = await page.evaluate(() => window.waybackFixture.requests)
  assert.ok(requests.length > 0)
  assert.ok(requests.every(operation => operation === 'catalog'), requests.join(','))
  assert.equal(await earlyRow.locator('[data-map-panel-eye]').getAttribute('aria-pressed'), 'true')
  await page.evaluate(() => {
    const dialog = document.querySelector('[data-map-imagery-dialog]')?.closest('[role="dialog"]')
    const close = dialog?.querySelector('button[aria-label*="关闭"], button[aria-label*="Close"]')
    if (close instanceof HTMLElement) close.click()
  })

  await page.locator('[data-map-imagery-row][data-imagery-kind="recent"] button[aria-haspopup="dialog"]').click()
  const opacity = page.locator('[data-map-imagery-opacity]')
  await opacity.fill('0.45')
  await page.waitForFunction(() => window.waybackFixture.changes.some(change => change.op === 'set-imagery-display' && change.display.recentOpacity === 0.45))
  await assertVisibleControls()
  await page.evaluate(() => {
    const dialog = document.querySelector('[data-map-imagery-dialog]')?.closest('[role="dialog"]')
    const close = dialog?.querySelector('button[aria-label*="关闭"], button[aria-label*="Close"]')
    if (close instanceof HTMLElement) close.click()
  })

  await page.evaluate(() => window.waybackFixture.setCatalogFailure(true))
  await page.locator('[data-map-imagery-row][data-imagery-kind="early"] button[aria-haspopup="dialog"]').click()
  await page.getByRole('alert').waitFor()
  await page.evaluate(() => window.waybackFixture.setCatalogFailure(false))
  await page.getByRole('button', { name: 'Retry' }).click()
  await page.getByRole('alert').waitFor({ state: 'hidden' })
  assert.equal(await page.locator('[data-map-wayback-release]').inputValue(), '10')
  assert.deepEqual(errors, [])
})
