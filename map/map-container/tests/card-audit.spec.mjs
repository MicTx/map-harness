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
    resolve: { alias: [
      // The real shell compiles primitive module CSS into the loader's deferred
      // stylesheets; a direct-import page needs the same styles from source.
      { find: /^@deepseek-ai\/dsh-client-ui-primitives$/, replacement: new URL('../../../packages/client/ui-primitives/src/index.ts', import.meta.url).pathname },
      { find: 'react-dom/client', replacement: webRequire.resolve('react-dom/client') },
    ] },
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

async function applyScheme(page, scheme) {
  if (scheme === 'dark') await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
  else await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
}

async function collapseFeaturePanel(page) {
  const close = page.locator('[data-audit-cell="feature-card"] [data-map-panel-header] [data-map-panel-icon]').first()
  if (await close.count()) await close.click()
  await page.waitForTimeout(100)
}

function intersects(left, right) {
  return left.left < right.right && right.left < left.right && left.top < right.bottom && right.top < left.bottom
}

/** Assert one feature card stays around its anchor, inside the map, and clear of visible floating DOM. */
async function assertFeatureCardGeometry(page, auditId, anchor) {
  const cardLocator = page.locator(`[data-audit-cell="${auditId}"] [data-map-feature-card]`)
  await cardLocator.waitFor({ state: 'visible', timeout: 15_000 })
  try {
    await page.waitForFunction((auditId) => {
      const cell = document.querySelector(`[data-audit-cell="${auditId}"]`)
      const map = cell?.querySelector('[data-map-container]')?.getBoundingClientRect()
      const element = cell?.querySelector('[data-map-feature-card]')
      const card = element?.getBoundingClientRect()
      return map !== undefined && card !== undefined && element?.dataset.mapFeatureOverlap === '0'
        && card.left >= map.left - 1 && card.top >= map.top - 1 && card.right <= map.right + 1 && card.bottom <= map.bottom + 1
    }, auditId, { timeout: 10_000 })
  } catch (error) {
    const state = await page.evaluate((auditId) => {
      const cell = document.querySelector(`[data-audit-cell="${auditId}"]`)
      const mapElement = cell?.querySelector('[data-map-container]')
      const overlayElement = cell?.querySelector('[data-map-overlay-content]')
      const cardElement = cell?.querySelector('[data-map-feature-card]')
      const rect = element => element?.getBoundingClientRect()
      return {
        map: rect(mapElement),
        overlay: rect(overlayElement),
        card: rect(cardElement),
        style: cardElement?.getAttribute('style'),
        dataset: cardElement === null ? null : { ...cardElement.dataset },
      }
    }, auditId)
    throw new Error(`feature-card placement did not settle: ${JSON.stringify(state)}\n${String(error)}`)
  }
  const metrics = await page.evaluate(({ auditId, anchor }) => {
    const cell = document.querySelector(`[data-audit-cell="${auditId}"]`)
    const map = cell?.querySelector('[data-map-container]')?.getBoundingClientRect()
    const cardElement = cell?.querySelector('[data-map-feature-card]')
    const card = cardElement?.getBoundingClientRect()
    const obstacles = [...(cell?.querySelectorAll('[data-map-panel], [data-map-panel-toggle], [data-map-workbench], [data-map-use-status], [data-map-state], [data-map-source-error], .esri-view-attribution, .esri-ui .esri-component') ?? [])]
      .filter(element => element !== cardElement && !cardElement?.contains(element))
      .map(element => ({ element, rect: element.getBoundingClientRect(), style: getComputedStyle(element) }))
      .filter(item => item.rect.width > 0 && item.rect.height > 0 && item.style.display !== 'none' && item.style.visibility !== 'hidden')
      .map(item => ({ left: item.rect.left, top: item.rect.top, right: item.rect.right, bottom: item.rect.bottom }))
    return {
      map: map === undefined ? null : { left: map.left, top: map.top, right: map.right, bottom: map.bottom },
      card: card === undefined || cardElement === null ? null : {
        left: card.left, top: card.top, right: card.right, bottom: card.bottom,
        side: cardElement.dataset.mapFeatureSide ?? null,
        constrained: cardElement.dataset.mapFeatureConstrained ?? null,
        overlap: cardElement.dataset.mapFeatureOverlap ?? null,
      },
      anchor: map === undefined ? null : {
        left: map.left + anchor.left, top: map.top + anchor.top,
        right: map.left + anchor.right, bottom: map.top + anchor.bottom,
      },
      obstacles,
    }
  }, { auditId, anchor })
  assert.ok(metrics.map !== null && metrics.card !== null && metrics.anchor !== null, `missing feature-card geometry: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.card.left >= metrics.map.left - 1 && metrics.card.top >= metrics.map.top - 1
    && metrics.card.right <= metrics.map.right + 1 && metrics.card.bottom <= metrics.map.bottom + 1,
  `feature card leaves the map: ${JSON.stringify(metrics)}`)
  assert.equal(intersects(metrics.card, metrics.anchor), false, `feature card covers its feature anchor: ${JSON.stringify(metrics)}`)
  for (const obstacle of metrics.obstacles) {
    assert.equal(intersects(metrics.card, obstacle), false, `feature card overlaps floating DOM: ${JSON.stringify({ obstacle, ...metrics })}`)
  }
  assert.equal(metrics.card.overlap, '0', `feature card reports fallback overlap: ${JSON.stringify(metrics)}`)
}

async function assertDesktopBase(page) {
  const imageryRow = page.locator('[data-audit-cell="imagery"] [data-map-imagery-row][data-imagery-kind="recent"]')
  await imageryRow.locator('[data-map-panel-eye]').click()
  await imageryRow.locator('button[aria-haspopup="dialog"]').click()
  await page.waitForTimeout(100)
  const metrics = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-map-tool-card]')]
    const running = document.querySelector('[data-map-tool-card][data-state="running"]')
    const runningRow = running?.querySelector('[data-map-tool-card-row]')
    const caret = runningRow === null || runningRow === undefined ? null : getComputedStyle(runningRow, '::after')
    const header = document.querySelector('[data-map-panel-header]')
    const featureCell = document.querySelector('[data-audit-cell="feature-card"]')
    const card = featureCell?.querySelector('[data-map-feature-card]')
    const collapsedBar = featureCell?.querySelector('[data-map-panel-collapsed] [data-map-panel-header]')
    const sessionAction = document.querySelector('[data-audit-cell="session-action"] [data-map-session-action]')
    const sessionStyle = sessionAction === null ? null : getComputedStyle(sessionAction)
    const stop = document.querySelector('[data-map-use-status] > button')
    const imageryCell = document.querySelector('[data-audit-cell="imagery"]')
    const imageryPanel = imageryCell?.querySelector('[data-map-panel]')
    const imageryPanelRect = imageryPanel?.getBoundingClientRect()
    const imageryContainer = imageryCell?.querySelector('[data-map-container]')?.getBoundingClientRect()
    const imagerySelects = [...(document.querySelectorAll('[data-map-imagery-dialog] select') ?? [])]
      .filter(select => select.getBoundingClientRect().width > 0).map(select => {
      const rect = select.getBoundingClientRect()
      return { value: select.value, left: rect.left, right: rect.right, width: rect.width }
    })
    const railCell = document.querySelector('[data-audit-cell="rail"]')
    const railContainerEl = railCell?.querySelector('[data-map-container]')
    railContainerEl?.scrollIntoView({ block: 'center', behavior: 'instant' })
    const railContainer = railContainerEl?.getBoundingClientRect()
    const railPanelEl = railCell?.querySelector('[data-map-panel]')
    const railPanelRect = railPanelEl?.getBoundingClientRect()
    const railPanelStyle = railPanelEl === null || railPanelEl === undefined ? null : getComputedStyle(railPanelEl)
    const railSections = [...(railPanelEl?.querySelectorAll('[data-map-panel-tab]') ?? [])].map(tab => {
      const rect = tab.getBoundingClientRect()
      return {
        name: tab.getAttribute('data-map-panel-tab'),
        expanded: tab.closest('[role="tab"]')?.getAttribute('aria-selected') === 'true',
        headLeft: rect?.left, headRight: rect?.right, headTop: rect?.top, headBottom: rect?.bottom,
      }
    })
    const railBody = railPanelEl?.querySelector('[data-map-panel-body]') === null ? null : (() => {
      const body = railPanelEl.querySelector('[data-map-panel-body]')
      const rect = body.getBoundingClientRect()
      return { top: rect.top, scrollHeight: body.scrollHeight, clientHeight: body.clientHeight }
    })()
    const railPanelCount = railCell?.querySelectorAll('[data-map-panel]').length ?? null
    const railLauncherCount = railCell?.querySelectorAll('[data-map-panel-toggle]').length ?? 0
    const railTablistCount = railCell?.querySelectorAll('[data-map-panel-tabs]').length ?? 0
    const railOverlay = railCell?.querySelector('[data-map-overlay-content]')
    let railGapProbeHitsCard = null
    if (railContainer !== null && railContainer !== undefined && railOverlay !== null && railOverlay !== undefined) {
      const probe = document.elementFromPoint(railContainer.right - 24, railContainer.top + 200)
      railGapProbeHitsCard = probe !== null && probe.closest('[data-map-panel]') !== null
    }
    const railOpenCell = document.querySelector('[data-audit-cell="rail-open"]')
    const railOpenContainerEl = railOpenCell?.querySelector('[data-map-container]')
    railOpenContainerEl?.scrollIntoView({ block: 'center', behavior: 'instant' })
    const railOpenContainer = railOpenContainerEl?.getBoundingClientRect()
    const railOpenCardEl = railOpenCell?.querySelector('[data-map-panel]')
    const railOpenBarEl = railOpenCardEl?.querySelector('[data-map-panel-header]')
    const railOpenBar = railOpenBarEl?.getBoundingClientRect()
    const railOpenStyle = railOpenCardEl === null || railOpenCardEl === undefined ? null : getComputedStyle(railOpenCardEl)
    const compactCell = document.querySelector('[data-audit-cell="compact-band"]')
    const compactOverlay = compactCell?.querySelector('[data-map-overlay-content]')?.getBoundingClientRect()
    const compactBarEl = compactCell?.querySelector('[data-map-panel-collapsed] [data-map-panel-header]')
    const compactBar = compactBarEl?.getBoundingClientRect()
    const compactLauncherCount = compactCell?.querySelectorAll('[data-map-panel-toggle]').length ?? 0
    const compactOpenCell = document.querySelector('[data-audit-cell="compact-open"]')
    const compactOpenOverlay = compactOpenCell?.querySelector('[data-map-overlay-content]')?.getBoundingClientRect()
    const compactOpenPanelEl = compactOpenCell?.querySelector('[data-map-panel]')
    const compactOpenPanelRect = compactOpenPanelEl?.getBoundingClientRect()
    const compactOpenPanel = compactOpenPanelRect === undefined ? null : { left: compactOpenPanelRect.left, right: compactOpenPanelRect.right, top: compactOpenPanelRect.top, bottom: compactOpenPanelRect.bottom }
    const compactOpenLauncherCount = compactOpenCell?.querySelectorAll('[data-map-panel-toggle]').length ?? 0
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    return {
      viewport,
      states: cards.map(card => card.getAttribute('data-state')),
      icon: runningRow?.querySelector('[data-map-tool-card-icon]')?.textContent ?? '',
      caretWidth: caret?.borderTopWidth ?? '',
      headerPosition: header === null ? null : getComputedStyle(header).position,
      cardTop: card?.getBoundingClientRect().top ?? null,
      collapsedBarBottom: collapsedBar?.getBoundingClientRect().bottom ?? null,
      sessionMinHeight: sessionStyle?.minHeight ?? null,
      sessionBorder: sessionStyle?.borderTopWidth ?? null,
      stopHeight: stop?.getBoundingClientRect().height ?? null,
      imageryPanelLeft: imageryPanelRect?.left ?? null,
      imageryPanelRight: imageryPanelRect?.right ?? null,
      imageryPanelBottom: imageryPanelRect?.bottom ?? null,
      imageryContainerBottom: imageryContainer?.bottom ?? null,
      imagerySelects,
      railContainer: railContainer === undefined ? null : { left: railContainer.left, right: railContainer.right, top: railContainer.top, bottom: railContainer.bottom },
      railPanelCount,
      railLauncherCount,
      railTablistCount,
      railPanel: railPanelRect === undefined || railPanelEl === null || railPanelEl === undefined ? null : {
        left: railPanelRect.left, right: railPanelRect.right, top: railPanelRect.top, bottom: railPanelRect.bottom,
        position: railPanelStyle?.position ?? null, pointerEvents: railPanelStyle?.pointerEvents ?? null,
      },
      railSections,
      railBody,
      railGapProbeHitsCard,
      railOpenContainer: railOpenContainer === undefined ? null : { left: railOpenContainer.left, right: railOpenContainer.right, top: railOpenContainer.top, bottom: railOpenContainer.bottom },
      railOpenCardCollapsed: railOpenCardEl?.hasAttribute('data-map-panel-collapsed') ?? null,
      railOpenBar: railOpenBar === undefined ? null : { left: railOpenBar.left, right: railOpenBar.right, top: railOpenBar.top, bottom: railOpenBar.bottom },
      railOpenPointerEvents: railOpenStyle?.pointerEvents ?? null,
      compactOverlay: compactOverlay === undefined ? null : { left: compactOverlay.left, right: compactOverlay.right, top: compactOverlay.top, bottom: compactOverlay.bottom },
      compactBar: compactBar === undefined ? null : { left: compactBar.left, right: compactBar.right, top: compactBar.top, bottom: compactBar.bottom },
      compactLauncherCount,
      compactOpenOverlay: compactOpenOverlay === undefined ? null : { left: compactOpenOverlay.left, right: compactOpenOverlay.right, top: compactOpenOverlay.top, bottom: compactOpenOverlay.bottom },
      compactOpenPanel,
      compactOpenLauncherCount,
    }
  })
  for (const state of ['preparing', 'running', 'ok', 'error', 'stopped']) {
    assert.ok(metrics.states.includes(state), `missing ${state} tool card: ${JSON.stringify(metrics.states)}`)
  }
  assert.notEqual(metrics.icon, '▾')
  assert.notEqual(metrics.icon, '')
  assert.notEqual(metrics.caretWidth, '0px')
  assert.equal(metrics.headerPosition, 'sticky')
  assert.ok(metrics.cardTop !== null && metrics.collapsedBarBottom !== null, 'the feature card and collapsed annotation bar are measurable')
  assert.equal(metrics.sessionMinHeight, '28px')
  assert.equal(metrics.sessionBorder, '0px')
  assert.ok(metrics.stopHeight !== null && metrics.stopHeight <= 30, `stop button is too tall: ${String(metrics.stopHeight)}`)
  assert.equal(metrics.imagerySelects.length, 1, `one imagery dialog select is open: ${JSON.stringify(metrics.imagerySelects)}`)
  assert.ok(metrics.imageryPanelBottom !== null && metrics.imageryContainerBottom !== null
    && metrics.imageryPanelBottom <= metrics.imageryContainerBottom - 22,
  `imagery panel does not reserve its attribution band: ${JSON.stringify(metrics)}`)
  for (const select of metrics.imagerySelects) {
    assert.ok(select.width > 100, `imagery source select is too narrow: ${JSON.stringify(select)}`)
    assert.ok(select.left >= 0 && select.right <= (metrics.viewport?.width ?? 0), `imagery source select leaves the viewport: ${JSON.stringify(select)}`)
  }
  assert.ok(metrics.railContainer !== null, 'the resident expanded-card fixture is missing')
  assert.equal(metrics.railPanelCount, 1, `the fixture hosts one resident card: ${String(metrics.railPanelCount)}`)
  assert.equal(metrics.railLauncherCount, 0, 'no launcher button exists next to the resident card')
  assert.equal(metrics.railTablistCount, 1, 'the card has one tablist')
  assert.ok(metrics.railPanel !== null, 'the resident card is missing')
  assert.equal(metrics.railPanel.position, 'absolute', `the resident card is positioned against the map container: ${JSON.stringify(metrics.railPanel)}`)
  assert.equal(metrics.railPanel.pointerEvents, 'auto')
  assert.ok(metrics.railPanel.left >= metrics.railContainer.left - 1 && metrics.railPanel.right <= metrics.railContainer.right + 1
    && metrics.railPanel.top >= metrics.railContainer.top - 1 && metrics.railPanel.bottom <= metrics.railContainer.bottom + 1,
  `the resident card leaves its map container: ${JSON.stringify({ panel: metrics.railPanel, container: metrics.railContainer })}`)
  assert.ok(metrics.railPanel.bottom <= metrics.railContainer.bottom - 22,
    `the resident card covers the attribution band: ${JSON.stringify({ panel: metrics.railPanel, container: metrics.railContainer })}`)
  assert.equal(metrics.railSections.length, 3, `the resident card shows three sections: ${JSON.stringify(metrics.railSections)}`)
  assert.deepEqual(metrics.railSections.map(section => section.name), ['imagery', 'ai', 'annotation'])
  assert.deepEqual(metrics.railSections.map(section => section.expanded), [false, true, false], 'layers is selected by default')
  // Taller content belongs to the single scrolling body: every section head
  // must sit inside the card width and the full scrollable content height.
  assert.ok(metrics.railBody !== null, 'the resident card keeps one scrolling body')
  assert.ok(metrics.railBody.scrollHeight >= metrics.railBody.clientHeight)
  const contentBottom = metrics.railBody.top + metrics.railBody.scrollHeight
  for (const section of metrics.railSections) {
    assert.ok(section.headLeft >= metrics.railPanel.left - 1 && section.headRight <= metrics.railPanel.right + 1
      && section.headTop >= metrics.railPanel.top - 1 && section.headBottom <= metrics.railBody.top + 1,
    `section head leaves the card: ${JSON.stringify({ section, panel: metrics.railPanel, body: metrics.railBody, contentBottom })}`)
  }
  assert.equal(metrics.railGapProbeHitsCard, false, 'a map gesture starting beside the resident card never hits the card')
  assert.ok(metrics.railOpenContainer !== null, 'the collapsed-card fixture is missing')
  assert.equal(metrics.railOpenCardCollapsed, true, 'the collapsed fixture shows the resident title bar')
  assert.ok(metrics.railOpenBar !== null, 'the collapsed title bar is missing')
  assert.equal(metrics.railOpenPointerEvents, 'auto', 'the collapsed bar receives pointer events')
  assert.ok(metrics.railOpenBar.left >= metrics.railOpenContainer.left - 1 && metrics.railOpenBar.right <= metrics.railOpenContainer.right + 1
    && metrics.railOpenBar.top >= metrics.railOpenContainer.top - 1 && metrics.railOpenBar.bottom <= metrics.railOpenContainer.bottom + 1,
  `the collapsed bar leaves its container: ${JSON.stringify({ bar: metrics.railOpenBar, container: metrics.railOpenContainer })}`)
  assert.equal(metrics.compactLauncherCount, 0, 'the compact fixture keeps the resident collapsed bar, not a launcher')
  assert.ok(metrics.compactOverlay !== null)
  assert.ok(metrics.compactBar !== null, 'the compact collapsed bar is missing')
  assert.ok(metrics.compactBar.left >= metrics.compactOverlay.left && metrics.compactBar.right <= metrics.compactOverlay.right + 1
    && metrics.compactBar.top >= metrics.compactOverlay.top && metrics.compactBar.bottom <= metrics.compactOverlay.bottom,
  `the compact bar leaves the overlay: ${JSON.stringify({ bar: metrics.compactBar, overlay: metrics.compactOverlay })}`)
  assert.equal(metrics.compactOpenLauncherCount, 0, 'the expanded compact card leaves no launcher')
  assert.ok(metrics.compactOpenPanel !== null, 'the compact expanded fixture must show the resident card')
  assert.ok(metrics.compactOpenOverlay !== null)
  assert.ok(metrics.compactOpenPanel.left >= metrics.compactOpenOverlay.left - 1 && metrics.compactOpenPanel.right <= metrics.compactOpenOverlay.right + 1
    && metrics.compactOpenPanel.top >= metrics.compactOpenOverlay.top - 1 && metrics.compactOpenPanel.bottom <= metrics.compactOpenOverlay.bottom + 1,
  `the compact card leaves the overlay: ${JSON.stringify({ panel: metrics.compactOpenPanel, overlay: metrics.compactOpenOverlay })}`)

}

/** Drag one card by its title bar and return the card rect before and after. */
async function dragCard(page, selector, dx, dy) {
  const card = page.locator(selector)
  await card.scrollIntoViewIfNeeded()
  const before = await card.boundingBox()
  assert.ok(before !== null, `drag target is missing: ${selector}`)
  const grip = await card.locator('[data-map-panel-grip]').boundingBox()
  const startX = grip === null ? before.x + 20 : grip.x + grip.width / 2
  const startY = grip === null ? before.y + 12 : grip.y + grip.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(120)
  const after = await card.boundingBox()
  return { before, after }
}

async function assertCardDraggable(page) {
  // A short drag follows the pointer without clamping.
  const delta = { dx: 60, dy: -5 }
  const short = await dragCard(page, '[data-audit-cell="unified"] [data-map-panel]', delta.dx, delta.dy)
  assert.ok(short.after !== null && short.before !== null)
  assert.ok(Math.abs(short.after.x - (short.before.x + delta.dx)) <= 2 && Math.abs(short.after.y - (short.before.y + delta.dy)) <= 2,
    `the card follows the pointer delta: ${JSON.stringify({ before: short.before, after: short.after })}`)
  // A long drag clamps the card inside its map container instead of escaping.
  const far = await dragCard(page, '[data-audit-cell="unified"] [data-map-panel]', 4000, 4000)
  const container = await page.locator('[data-audit-cell="unified"] [data-map-container]').boundingBox()
  assert.ok(container !== null)
  // The clamp floors its maximum, so one pixel covers float comparison noise.
  const farRight = far.after.x + far.after.width
  const farBottom = far.after.y + far.after.height
  assert.ok(far.after !== null && farRight <= container.x + container.width + 1
    && farBottom <= container.y + container.height + 1
    && far.after.x >= container.x - 1 && far.after.y >= container.y - 1,
  `the card clamps into its container: ${JSON.stringify({ after: far.after, container })}`)
  // The collapsed title bar drags too.
  const collapsed = await dragCard(page, '[data-audit-cell="rail-open"] [data-map-panel]', 40, 20)
  assert.ok(collapsed.after !== null && collapsed.before !== null)
  assert.ok(Math.abs(collapsed.after.x - (collapsed.before.x + 40)) <= 2 && Math.abs(collapsed.after.y - (collapsed.before.y + 20)) <= 2,
    `the collapsed bar follows the pointer delta: ${JSON.stringify({ before: collapsed.before, after: collapsed.after })}`)
}

async function assertAttributionResize(page) {
  const result = await page.evaluate(async () => {
    const cell = document.querySelector('[data-audit-cell="mapbox-controls"]')
    const attribution = cell?.querySelector('.esri-view-attribution')
    const overlay = cell?.querySelector('[data-map-overlay-content]')
    if (!(attribution instanceof HTMLElement) || !(overlay instanceof HTMLElement)) throw new Error('missing attribution fixture')
    attribution.style.height = '52px'
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { measured: attribution.getBoundingClientRect().height, reserved: overlay.style.getPropertyValue('--map-attribution-height') }
  })
  assert.equal(result.reserved, `${Math.ceil(result.measured)}px`, 'the panel lane follows the measured attribution height')
}

/** Close the foreground candidate/layer dialog so panel geometry is measurable again. */
async function closeForegroundDialog(page) {
  const close = page.locator('[role="dialog"][aria-modal="true"] button[aria-label*="关闭"]').first()
  if (await close.count()) await close.click()
  await page.waitForTimeout(100)
}

async function assertDesktopInteractive(page) {
  const metrics = await page.evaluate(() => {
    const running = document.querySelector('[data-map-tool-card][data-state="running"]')
    const row = running?.querySelector('[data-map-tool-card-row]')
    const editor = document.querySelector('[data-map-panel-change-editor] label')
    const label = editor?.querySelector('span')
    const input = editor?.querySelector('input')
    const editorRect = editor?.getBoundingClientRect()
    const inputRect = input?.getBoundingClientRect()
    return {
      expanded: row?.getAttribute('aria-expanded'),
      body: running !== null && running !== undefined && running.querySelector('[data-map-tool-card-body]') !== null,
      editorDisplay: editor === null || editor === undefined ? null : getComputedStyle(editor).display,
      editorDirection: editor === null || editor === undefined ? null : getComputedStyle(editor).flexDirection,
      editorWidth: editorRect?.width ?? 0,
      inputWidth: inputRect?.width ?? 0,
      labelWidth: label?.getBoundingClientRect().width ?? 0,
    }
  })
  assert.equal(metrics.expanded, 'true')
  assert.equal(metrics.body, true)
  assert.equal(metrics.editorDisplay, 'flex')
  assert.equal(metrics.editorDirection, 'column')
  assert.ok(metrics.inputWidth > metrics.editorWidth * 0.9, `editor input does not fill its row: ${JSON.stringify(metrics)}`)
}

async function assertMobileStack(page) {
  const metrics = await page.evaluate(() => {
    const overlay = document.querySelector('[data-map-overlay-content]')
    const overlayRect = overlay?.getBoundingClientRect()
    const containerRect = document.querySelector('[data-map-container]')?.getBoundingClientRect()
    const panels = [...document.querySelectorAll('[data-map-panel]')]
      .map(panel => {
        const rect = panel.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
      })
      .sort((left, right) => left.top - right.top)
    const sourceSelect = [...document.querySelectorAll('[data-map-panel-sources] select[data-map-panel-source="base"]')]
      .map(select => select.getBoundingClientRect()).find(rect => rect.width > 0)
    const launchers = [...document.querySelectorAll('[data-map-panel-toggle]')].length
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      overlay: overlayRect === undefined ? null : { top: overlayRect.top, bottom: overlayRect.bottom, left: overlayRect.left, right: overlayRect.right },
      container: containerRect === undefined ? null : { top: containerRect.top, bottom: containerRect.bottom },
      panels,
      sourceSelect: sourceSelect === undefined ? null : { left: sourceSelect.left, right: sourceSelect.right, width: sourceSelect.width },
      launchers,
    }
  })
  assert.equal(metrics.panels.length, 1)
  assert.ok(metrics.overlay !== null)
  assert.ok(metrics.container !== null && metrics.overlay.bottom <= metrics.container.bottom + 1,
    `overlay sinks below the container: ${JSON.stringify(metrics)}`)
  assert.ok(metrics.scrollWidth <= metrics.innerWidth, `horizontal overflow: ${JSON.stringify(metrics)}`)
  for (const [index, panel] of metrics.panels.entries()) {
    assert.ok(panel.width > 0 && panel.height > 0, `empty mobile panel: ${JSON.stringify(panel)}`)
    assert.ok(panel.left >= 0 && panel.right <= metrics.innerWidth, `mobile panel leaves the viewport: ${JSON.stringify(panel)}`)
    assert.ok(panel.top >= metrics.overlay.top && panel.bottom <= metrics.overlay.bottom, `mobile panel leaves its overlay: ${JSON.stringify(panel)}`)
  }
  assert.equal(metrics.launchers, 0, `the expanded mobile card leaves no launcher: ${JSON.stringify(metrics)}`)
  if (metrics.sourceSelect !== null) {
    assert.ok(metrics.sourceSelect.width > 100
      && metrics.sourceSelect.left >= 0
      && metrics.sourceSelect.right <= metrics.innerWidth,
    `mobile source select leaves the viewport: ${JSON.stringify(metrics)}`)
  }
}

test('map card audit captures every card across themes and widths', { timeout: 180_000 }, async t => {
  const out = process.env.MAP_CARD_EVIDENCE_DIR ?? await mkdtemp(join(tmpdir(), 'map-card-audit-'))
  await mkdir(out, { recursive: true })
  console.log(`map card audit screenshots: ${out}`)
  const port = await serve(t)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())

  const shots = []
  for (const scheme of ['light', 'dark']) {
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: scheme })
    const page = await desktop.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    await page.goto(`http://127.0.0.1:${port}/`)
    await applyScheme(page, scheme)
    try {
      await page.locator('[data-map-tool-card]').first().waitFor({ timeout: 15_000 })
    } catch (error) {
      const text = await page.locator('body').innerText()
      throw new Error(`map card audit failed to render in ${scheme} 1280px: ${JSON.stringify({ errors, text: text.slice(0, 2000) })}\n${String(error)}`)
    }
    await collapseFeaturePanel(page)
    await page.waitForTimeout(300)
    assert.deepEqual(errors, [], `browser errors in ${scheme} 1280px`)
    await assertDesktopBase(page)
    await assertAttributionResize(page)
    await assertFeatureCardGeometry(page, 'feature-card', { left: 360, top: 120, right: 380, bottom: 150 })
    await assertFeatureCardGeometry(page, 'feature-collision', { left: 320, top: 180, right: 340, bottom: 210 })
    for (const auditId of ['feature-card', 'feature-collision']) {
      const featureName = `${scheme}-1280-${auditId}.png`
      await page.locator(`[data-audit-cell="${auditId}"]`).screenshot({ path: join(out, featureName) })
      shots.push(featureName)
    }
    const name = `${scheme}-1280.png`
    await page.screenshot({ path: join(out, name), fullPage: true })
    shots.push(name)

    await closeForegroundDialog(page)
    await assertCardDraggable(page)
    const dragged = `${scheme}-1280-dragged.png`
    await page.screenshot({ path: join(out, dragged), fullPage: true })
    shots.push(dragged)

    await closeForegroundDialog(page)

    const firstToolRow = page.locator('[data-map-tool-card-row][role="button"]').first()
    if (await firstToolRow.count()) await firstToolRow.click()
    const moreBtn = page.locator('[data-map-panel-more]').first()
    if (await moreBtn.count()) await moreBtn.click()
    // Flat rows open candidate review as one shared dialog; only one dialog
    // may sit in the foreground, so close it before opening the next row.
    const propSel = page.locator('[data-map-panel-proposal-select]').first()
    if (await propSel.count()) {
      await propSel.click()
      await page.locator('[role="dialog"][aria-modal="true"] button[aria-label*="关闭"]').first().click()
    }
    const changeSel = page.locator('[data-map-panel-change-select]').first()
    if (await changeSel.count()) await changeSel.click()
    const changeEditor = page.locator('[role="dialog"] [data-map-panel-change-editor]').first()
    if (await changeEditor.count()) await changeEditor.scrollIntoViewIfNeeded()
    await page.waitForTimeout(200)
    await assertDesktopInteractive(page)
    const interactive = `${scheme}-1280-interactive.png`
    await page.screenshot({ path: join(out, interactive), fullPage: true })
    shots.push(interactive)
    await closeForegroundDialog(page)
    await assertResidentCardGeometry(page)
    await desktop.close()

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme, hasTouch: true })
    const mobilePage = await mobile.newPage()
    const mobileErrors = []
    mobilePage.on('pageerror', error => mobileErrors.push(String(error)))
    mobilePage.on('console', message => { if (message.type() === 'error') mobileErrors.push(message.text()) })
    await mobilePage.goto(`http://127.0.0.1:${port}/`)
    await applyScheme(mobilePage, scheme)
    const collapsedShot = `${scheme}-390-collapsed.png`
    await mobilePage.screenshot({ path: join(out, collapsedShot), fullPage: true })
    shots.push(collapsedShot)
    await mobilePage.locator('[data-map-panel-collapse]').first().click()
    await mobilePage.locator('[data-map-panel] [data-map-panel-body]').first().waitFor({ timeout: 15_000 })
    await mobilePage.waitForTimeout(300)
    assert.deepEqual(mobileErrors, [], `browser errors in ${scheme} 390px`)
    const mobileName = `${scheme}-390.png`
    await mobilePage.screenshot({ path: join(out, mobileName), fullPage: true })
    shots.push(mobileName)

    await mobilePage.locator('[data-map-panel-tab="imagery"]').click()
    await mobilePage.locator('[data-map-panel-tab-body="imagery"] [data-map-imagery-row][data-imagery-kind="recent"] button[aria-haspopup="dialog"]').click()
    await mobilePage.waitForTimeout(200)
    await assertMobileStack(mobilePage)
    await mobilePage.evaluate(() => {
      const dialog = document.querySelector('[data-map-imagery-dialog]')?.closest('[role="dialog"]')
      const close = dialog?.querySelector('button[aria-label*="关闭"]')
      if (close instanceof HTMLElement) close.click()
    })
    await mobilePage.waitForTimeout(100)
    await mobilePage.locator('[data-map-panel-tab="ai"]').click()
    await mobilePage.locator('[data-map-panel-proposal-select]').first().click()
    await mobilePage.locator('[role="dialog"][aria-modal="true"] button[aria-label*="关闭"]').first().click()
    await mobilePage.locator('[data-map-panel-change-select]').first().click()
    await mobilePage.locator('[role="dialog"] [data-map-panel-change-editor]').first().scrollIntoViewIfNeeded()
    await mobilePage.waitForTimeout(200)
    const mobileInteractive = `${scheme}-390-interactive.png`
    await mobilePage.screenshot({ path: join(out, mobileInteractive), fullPage: true })
    shots.push(mobileInteractive)
    await closeForegroundDialog(mobilePage)
    await assertResidentCardGeometry(mobilePage, { touch: true })
    await mobile.close()
  }
  assert.equal(shots.length, 16)
})


async function assertResidentCardGeometry(page, { touch = false } = {}) {
  const panel = page.locator('[data-map-panel][data-map-panel-surface="unified"]').first()
  const tabs = panel.locator('[data-map-panel-tab]')
  assert.equal(await tabs.count(), 3, 'the resident card exposes three tabs')
  await panel.locator('[data-map-panel-tab="ai"]').click()

  // The layers section expands by default and hosts the pending candidates.
  const layers = await page.evaluate(() => {
    const panel = document.querySelector('[data-map-panel][data-map-panel-surface="unified"]')
    const list = panel?.querySelector('[data-map-panel-tab-body="ai"] [data-map-panel-list]')
    const pending = panel?.querySelector('[data-map-panel-pending]')
    return {
      flatCandidateRows: list !== null && list !== undefined && pending !== null && pending !== undefined
        && panel.querySelector('[data-map-panel-review]') === null
        && pending.querySelector('[data-map-panel-proposal]') !== null
        && pending.querySelector('[data-map-panel-change]') !== null,
      reviewGone: panel?.querySelector('[data-map-panel-review]') === null,
    }
  })
  assert.equal(layers.flatCandidateRows && layers.reviewGone, true,
    `candidates stay in the pending section with no duplicate review region: ${JSON.stringify(layers)}`)
  const longName = panel.locator('[data-map-panel-name]', { hasText: '重点点位重点点位重点点位' }).first()
  await longName.scrollIntoViewIfNeeded()
  const nameGeometry = await longName.evaluate(element => ({
    scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
  }))
  assert.ok(nameGeometry.scrollHeight <= nameGeometry.clientHeight && nameGeometry.scrollWidth > nameGeometry.clientWidth,
    `long layer names stay on one truncated line: ${JSON.stringify(nameGeometry)}`)
  const originalName = await longName.textContent()
  await longName.locator('xpath=ancestor::*[@data-map-panel-row]').locator('[aria-haspopup="dialog"]').last().click()
  assert.equal(await page.locator('[role="dialog"][aria-modal="true"]').getAttribute('aria-label'), originalName)
  assert.ok(await page.locator('[data-map-panel-legend] li').count() > 0, 'the operation dialog exposes the legend')
  await closeForegroundDialog(page)
  const scroller = panel.locator('[data-map-panel-tab-body="ai"]')
  await scroller.evaluate(element => { element.scrollTop = 80 })
  const scrollBefore = await scroller.evaluate(element => element.scrollTop)
  assert.ok(scrollBefore > 0, 'the active tab scrolls inside the card')
  await panel.locator('[data-map-panel-tab="imagery"]').click()
  await panel.locator('[data-map-panel-tab="ai"]').click()
  assert.equal(await scroller.evaluate(element => element.scrollTop), scrollBefore, 'tab switching preserves scroll')

  // Imagery expands its own section and keeps three flat rows with source dialogs.
  await panel.locator('[data-map-panel-tab="imagery"]').click()
  const imagery = await page.evaluate(() => {
    const panel = document.querySelector('[data-map-panel][data-map-panel-surface="unified"]')
    const section = panel?.querySelector('[data-map-panel-tab-body="imagery"]')
    const rows = [...(section?.querySelectorAll('[data-map-imagery-row]') ?? [])]
    const eyes = rows.map(row => row.querySelector('[data-map-panel-eye]') !== null)
    const moreButtons = rows.map(row => row.querySelector('[data-map-panel-actions] button[aria-haspopup="dialog"]') !== null)
    return { count: rows.length, eyes, moreButtons }
  })
  assert.equal(imagery.count === 3 && imagery.eyes.every(Boolean) && imagery.moreButtons.every(Boolean), true,
    `imagery keeps three flat rows with eye toggles and source dialogs: ${JSON.stringify(imagery)}`)
  await panel.locator('[data-map-panel-tab-body="imagery"] [data-map-imagery-row][data-imagery-kind="recent"] button[aria-haspopup="dialog"]').click()
  const recentDialog = page.locator('[data-map-imagery-dialog]')
  assert.equal(await recentDialog.count(), 1, 'the recent imagery row opens its source dialog')
  assert.equal(await recentDialog.locator('[data-map-panel-source-title]').textContent(), 'World Imagery with a very long source name that must remain visible in its dialog')
  await page.evaluate(() => {
    const dialog = document.querySelector('[data-map-imagery-dialog]')?.closest('[role="dialog"]')
    const close = dialog?.querySelector('button[aria-label*="关闭"]')
    if (close instanceof HTMLElement) close.click()
  })
  await page.waitForTimeout(100)

  // The annotation section expands in place; its row opens the shared dialog.
  await panel.locator('[data-map-panel-tab="annotation"]').click()
  const annotationName = panel.locator('[data-map-panel-tab-body="annotation"] [data-map-annotation-row] [data-map-panel-name]').first()
  if (touch) assert.equal(await panel.locator('[data-map-panel-tab-body="annotation"] [data-map-panel-search]').evaluate(input => getComputedStyle(input).fontSize), '16px')
  if (await annotationName.count()) await annotationName.click()
  await page.waitForTimeout(100)
  const annotation = await page.evaluate(() => {
    const panel = document.querySelector('[data-map-panel][data-map-panel-surface="unified"]')
    const section = panel?.querySelector('[data-map-panel-tab-body="annotation"]')
    const rows = [...(section?.querySelectorAll('[data-map-annotation-row]') ?? [])]
    const dialog = document.querySelector('[data-map-annotation-dialog]')
    return { rows: rows.length, dialogOpen: dialog !== null }
  })
  assert.equal(annotation.rows > 0 && annotation.dialogOpen, true,
    `the annotation row opens the shared operation dialog: ${JSON.stringify(annotation)}`)
  assert.equal(await page.locator('[data-map-annotation-dialog] input').first().inputValue(), '待核查点位名称很长需要在操作对话框中完整显示')
  await page.evaluate(() => {
    const dialog = document.querySelector('[data-map-annotation-dialog]')?.closest('[role="dialog"]')
    const close = dialog?.querySelector('button[aria-label*="关闭"]')
    if (close instanceof HTMLElement) close.click()
  })
  await page.waitForTimeout(100)

  const metrics = await page.evaluate(() => {
    const panel = document.querySelector('[data-map-panel][data-map-panel-surface="unified"]')
    return {
      coarsePointer: window.matchMedia('(pointer: coarse)').matches,
      smallestPanelButton: Math.min(...[...(panel?.querySelectorAll('[data-map-panel-tab-body]:not([hidden]) button') ?? [])]
        .map(button => Math.min(button.getBoundingClientRect().height, button.getBoundingClientRect().width))),
    }
  })
  if (touch) {
    assert.equal(metrics.coarsePointer, true, `the touch context advertises a coarse primary pointer: ${JSON.stringify(metrics)}`)
    assert.ok(metrics.smallestPanelButton >= 44,
      `panel controls keep 44px touch targets: ${JSON.stringify(metrics)}`)
  }

  const compact = touch ? panel : page.locator('[data-audit-cell="compact-open"] [data-map-panel]')
  await compact.evaluate(element => { element.style.width = '240px' })
  await compact.locator('[data-map-panel-tab="ai"]').click()
  const english = compact.locator('[data-map-panel-pending-name]').first()
  await english.evaluate(element => { element.textContent = 'A very long English candidate name that must remain accessible in its operation dialog' })
  const englishGeometry = await english.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, whiteSpace: getComputedStyle(element).whiteSpace }))
  assert.ok(englishGeometry.scroll > englishGeometry.width && englishGeometry.whiteSpace === 'nowrap', `English names truncate in the narrow panel: ${JSON.stringify(englishGeometry)}`)
  const compactRows = await compact.locator('[data-map-panel-row]:visible, [data-map-panel-pending-row]:visible').evaluateAll(rows => rows.map(row => ({ width: row.clientWidth, scroll: row.scrollWidth })))
  assert.ok(compactRows.every(row => row.scroll <= row.width + 1), `narrow rows retain their actions: ${JSON.stringify(compactRows)}`)
}
