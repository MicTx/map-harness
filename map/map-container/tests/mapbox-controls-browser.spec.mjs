/**
 * Real-browser contract for the Mapbox-compatible controls: the audit page
 * mounts the four vendor control groups, Playwright clicks zoom/compass/
 * attribution, and vendor geometry is read from the live computed styles.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '../../../apps/web/node_modules/playwright/index.mjs'
import { freeHmrPort } from './free-hmr-port.mjs'

const webRequire = createRequire(new URL('../../../apps/web/package.json', import.meta.url))

async function serve(t) {
  const vite = await webRequire('vite').createServer({
    configFile: false,
    root: new URL('../../..', import.meta.url).pathname,
    appType: 'custom',
    resolve: { alias: { 'react-dom/client': webRequire.resolve('react-dom/client') } },
    server: { middlewareMode: true, hmr: { port: await freeHmrPort() }, watch: { ignored: ['**/.spec/**', '**/website/.dist/**'] } },
  })
  t.after(() => vite.close())
  const server = createHttpServer((request, response) => {
    if (new URL(request.url, 'http://127.0.0.1').pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/map/map-container/tests/card-audit-entry.tsx"></script></body></html>')
      return
    }
    vite.middlewares(request, response)
  })
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolve()))
  const { port } = server.address()
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  return port
}

test('the Mapbox control groups render and click through real browser interactions', { timeout: 120_000 }, async t => {
  const out = process.env.MAP_CONTROL_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'mapbox-controls-'))
  await mkdir(out, { recursive: true })
  console.log(`mapbox control audit screenshots: ${out}`)
  const port = await serve(t)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error)))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto(`http://127.0.0.1:${port}/`)
  const cell = page.locator('[data-audit-cell="mapbox-controls"]')
  await cell.locator('[data-mapbox-ctrl-group]').first().waitFor({ timeout: 15_000 })
  assert.deepEqual(errors, [], 'the audit page renders without browser errors')

  // Vendor geometry read from the live document, not from source constants.
  const geometry = await cell.evaluate(root => {
    const group = root.querySelector('[data-mapbox-ctrl-group]')
    const navigation = root.querySelector('[data-mapbox-ctrl-navigation]')
    const zoomIn = root.querySelector('[data-mapbox-ctrl-zoom-in]')
    const zoomOut = root.querySelector('[data-mapbox-ctrl-zoom-out]')
    const scale = root.querySelector('[data-mapbox-ctrl-scale]')
    const groupStyle = getComputedStyle(group)
    const zoomStyle = getComputedStyle(zoomIn)
    const secondButton = navigation === null ? undefined : navigation.querySelectorAll('button')[1]
    return {
      buttonWidth: zoomStyle.width,
      buttonHeight: zoomStyle.height,
      radius: groupStyle.borderRadius,
      background: groupStyle.backgroundColor,
      shadow: groupStyle.boxShadow,
      separator: secondButton === undefined ? '' : (() => { const s = getComputedStyle(secondButton); return s.borderTopWidth + ' ' + s.borderTopStyle + ' ' + s.borderTopColor })(),
      scaleText: scale.textContent,
      scaleWidth: getComputedStyle(scale).width,
      iconImage: getComputedStyle(zoomIn.querySelector('[data-mapbox-ctrl-icon]')).backgroundImage.slice(0, 60),
    }
  })
  assert.equal(geometry.buttonWidth, '32px')
  assert.equal(geometry.buttonHeight, '32px')
  assert.equal(geometry.radius, '4px')
  assert.equal(geometry.background, 'rgb(255, 255, 255)')
  assert.ok(geometry.shadow.includes('rgba(0, 0, 0, 0.1)'), geometry.shadow)
  assert.equal(geometry.separator, '1px solid rgb(221, 221, 221)', 'the vendor #ddd separator survives the host button reset')
  assert.match(geometry.scaleText ?? '', /5 km/)
  assert.ok(geometry.iconImage.includes('data:image/svg+xml'), 'the zoom-in icon is the vendor SVG')

  // Real clicks drive the occurrence readout.
  const readout = cell.locator('[data-mapbox-control-calls]')
  await cell.locator('[data-mapbox-ctrl-zoom-in]').click()
  await cell.locator('[data-mapbox-ctrl-zoom-out]').click()
  await cell.locator('[data-mapbox-ctrl-compass]').click()
  assert.equal((await readout.textContent()) ?? '', 'zoom:1,zoom:-1,bearing')

  // The compact attribution opens on a real click.
  const attrib = cell.locator('[data-mapbox-ctrl-attrib]')
  assert.equal(await attrib.getAttribute('data-mapbox-compact-show'), null)
  await cell.locator('[data-mapbox-ctrl-attrib-button]').click()
  assert.equal(await attrib.getAttribute('data-mapbox-compact-show'), '')
  assert.match((await cell.locator('[data-mapbox-ctrl-attrib-inner]').textContent()) ?? '', /Esri/)

  await cell.screenshot({ path: join(out, 'mapbox-controls-1280.png') })

  // The 390px touch context keeps the vendor control visible and clickable.
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true })
  const mobilePage = await mobile.newPage()
  const mobileErrors = []
  mobilePage.on('pageerror', error => mobileErrors.push(String(error)))
  mobilePage.on('console', message => { if (message.type() === 'error') mobileErrors.push(message.text()) })
  await mobilePage.goto(`http://127.0.0.1:${port}/?mapbox-controls`)
  const mobileCell = mobilePage.locator('[data-audit-cell="mapbox-controls"]')
  await mobileCell.locator('[data-mapbox-ctrl-zoom-in]').waitFor({ timeout: 15_000 })
  await assert.deepEqual(mobileErrors, [])
  const box = await mobileCell.locator('[data-mapbox-ctrl-group]').first().boundingBox()
  assert.ok(box !== null && box.x >= 0 && box.y >= 0, 'the control group stays inside the 390px viewport')
  await mobileCell.locator('[data-mapbox-ctrl-zoom-in]').tap()
  await mobileCell.locator('[data-mapbox-ctrl-attrib-button]').tap()
  await assert.match((await mobileCell.locator('[data-mapbox-ctrl-attrib-inner]').textContent()) ?? '', /Esri/)
  await mobileCell.screenshot({ path: join(out, 'mapbox-controls-390.png') })
  await context.close()
  await mobile.close()
})
