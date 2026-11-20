/**
 * Mechanical execution of the lead-authored raw SDK calibration. This
 * collector writes observations, not a geometric accuracy verdict; the lead
 * checks the frozen JSON independently. All HTTP stays on the owned server.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import sharp from 'sharp'
import { chromium } from '../../../apps/web/node_modules/playwright/index.mjs'
import { OBSERVATION_CONTROL_CASES } from './observation-control-cases.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const assets = resolve(here, '../node_modules/@arcgis/core/assets')
const contentTypes = {
  '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
}

/** Collect three fixed cases using actual SDK camera and toScreen readings. */
export async function collectObservationControls(outputDir) {
  mkdirSync(outputDir, { recursive: true })
  const temp = mkdtempSync(join(tmpdir(), 'observation-controls-'))
  let server
  let browser
  try {
    const bundlePath = join(temp, 'controls.js')
    const built = spawnSync(join(root, 'node_modules/.bin/esbuild'), [
      join(here, 'observation-controls.browser.ts'),
      '--bundle', '--platform=browser', '--format=esm', '--target=es2024',
      '--define:process.env.NODE_ENV="production"', `--outfile=${bundlePath}`,
    ], { cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
    writeFileSync(join(outputDir, 'control-bundle.log'), `${built.stdout ?? ''}${built.stderr ?? ''}`)
    assert.equal(built.status, 0, `calibration bundle failed: ${built.stderr ?? built.error}`)
    const bundle = readFileSync(bundlePath)
    const tile = await sharp(Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">'
      + '<rect width="256" height="256" fill="white"/>'
      + '<path d="M0 0H256V256H0ZM128 0V256M0 128H256" fill="none" stroke="#dde5ea"/>'
      + '</svg>',
    )).png().toBuffer()
    const html = '<!doctype html><meta charset="utf-8">'
      + '<link rel="stylesheet" href="/assets/esri/themes/light/main.css">'
      + '<style>html,body{margin:0}#map{width:896px;height:560px}output{display:none}</style>'
      + '<div id="map" data-map-container></div><output></output>'
      + '<script type="module" src="/controls.js"></script>'
    server = createServer((request, response) => {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      if (path === '/') {
        response.writeHead(200, { 'content-type': 'text/html' }).end(html)
      } else if (path === '/controls.js') {
        response.writeHead(200, { 'content-type': 'application/javascript' }).end(bundle)
      } else if (path.startsWith('/tiles/')) {
        response.writeHead(200, { 'content-type': 'image/png' }).end(tile)
      } else if (path.startsWith('/assets/')) {
        const file = resolve(assets, decodeURIComponent(path.slice('/assets/'.length)))
        if (!file.startsWith(`${assets}${sep}`)) {
          response.writeHead(404).end()
          return
        }
        try {
          response.writeHead(200, { 'content-type': contentTypes[extname(file)] ?? 'application/octet-stream' })
            .end(readFileSync(file))
        } catch (error) {
          response.writeHead(404).end()
        }
      } else response.writeHead(404).end()
    })
    await new Promise((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    assert.equal(typeof address, 'object')
    const origin = `http://127.0.0.1:${address.port}`
    browser = await chromium.launch({ headless: true })
    const cases = []
    for (const spec of OBSERVATION_CONTROL_CASES) {
      const context = await browser.newContext({
        viewport: { width: 1100, height: 760 }, deviceScaleFactor: spec.deviceScaleFactor,
      })
      const page = await context.newPage()
      const diagnostics = []
      const blockedRequests = []
      page.on('pageerror', error => diagnostics.push({ type: 'pageerror', message: error.message }))
      page.on('console', message => {
        if (message.type() === 'error') diagnostics.push({ type: 'console', message: message.text() })
      })
      await page.route('**/*', route => {
        if (new URL(route.request().url()).origin === origin) return route.continue()
        blockedRequests.push(route.request().url())
        return route.abort('blockedbyclient')
      })
      try {
        await page.goto(`${origin}/?case=${encodeURIComponent(spec.name)}`, { timeout: 60_000 })
        await page.waitForFunction(() => (document.querySelector('output')?.textContent?.length ?? 0) > 0,
          undefined, { timeout: 60_000 })
        const raw = JSON.parse(await page.locator('output').textContent())
        writeFileSync(join(outputDir, `${spec.name}-diagnostics.json`), JSON.stringify({ diagnostics, blockedRequests }, null, 2))
        assert.equal(raw.ok, true, `SDK calibration failed: ${JSON.stringify(raw)}`)
        const { pngBase64, ...capture } = raw.capture
        const png = Buffer.from(pngBase64, 'base64')
        const pngPath = `${spec.name}.png`
        writeFileSync(join(outputDir, pngPath), png)
        cases.push({
          name: raw.name, requested: raw.requested, devicePixelRatio: raw.devicePixelRatio,
          capture, controlPoints: raw.controlPoints, sdkCamera: raw.sdkCamera,
          png: { path: pngPath, sha256: createHash('sha256').update(png).digest('hex') },
        })
      } catch (error) {
        writeFileSync(join(outputDir, `${spec.name}-diagnostics.json`), JSON.stringify({ diagnostics, blockedRequests }, null, 2))
        throw error
      } finally {
        await context.close()
      }
    }
    const sdkVersion = JSON.parse(readFileSync(resolve(assets, '../package.json'), 'utf8')).version
    const artifact = { schemaVersion: 1, sdkVersion, cases }
    writeFileSync(join(outputDir, 'sdk-controls.json'), JSON.stringify(artifact, null, 2))
    return { artifactPath: join(outputDir, 'sdk-controls.json'), cases: cases.map(value => value.name) }
  } finally {
    if (browser !== undefined) await browser.close()
    if (server !== undefined) {
      server.closeAllConnections()
      await new Promise(resolveClose => server.close(resolveClose))
    }
    rmSync(temp, { recursive: true, force: true })
  }
}
