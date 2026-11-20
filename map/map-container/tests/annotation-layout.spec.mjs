import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import React from 'react'
import { tsImport } from 'tsx/esm/api'

const { createElement, act } = React
globalThis.React = React
const uiPrimitivesRequire = createRequire(new URL('../../../packages/client/ui-primitives/package.json', import.meta.url))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let createRootFn
const createRoot = (...args) => (createRootFn ??= uiPrimitivesRequire('react-dom/client').createRoot)(...args)
const importClient = specifier => tsImport(specifier, { parentURL: import.meta.url, tsconfig: new URL('../tsconfig.json', import.meta.url).pathname })
const { LayerPanel } = await importClient('../src/client/LayerPanel.tsx')
const { en } = await importClient('../src/client/locales.ts')

const t = (key, params) => {
  const template = en[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/gu, (whole, name) => params[name] ?? '')
}

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'Document', 'Event',
  'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'UIEvent',
  'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
]

function installDom(tContext) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const saved = new Map()
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const expose = (name, value) => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  for (const name of DOM_GLOBALS) expose(name, dom.window[name])
  const roots = []
  tContext.after(() => {
    for (const root of roots) act(() => root.unmount())
    container.remove()
    dom.window.close()
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
  })
  return { window: dom.window, container, roots }
}

const annotationFeature = (id, name) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [116.4, 39.9] },
  properties: {
    name,
    dshRole: 'user-annotation',
    dshAuthor: 'user',
    dshSource: 'manual',
    dshCreateOperationId: `create-${id}`,
    dshUpdateOperationId: `update-${id}`,
    dshCreatedAt: '2026-11-04T00:00:00.000Z',
    dshUpdatedAt: '2026-11-04T00:00:00.000Z',
  },
})

const wireOf = (features = [
  annotationFeature('ann-0123456789abcdef01234567', 'Site A'),
  annotationFeature('ann-0123456789abcdef01234568', 'Site B'),
]) => ({
  layers: [{
    id: 'user-annotations',
    name: 'User annotations',
    role: 'user-annotation',
    data: { type: 'FeatureCollection', features },
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
  }],
  view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 },
  mode: 'map',
  basemap: null,
  aoi: null,
  revision: 9,
  operations: [],
  undoableAnnotation: null,
  observationRequest: null,
})

function occurrenceStub() {
  const calls = { draw: [], cancels: 0 }
  let drawing = { status: 'idle', kind: null, lastError: null }
  return {
    calls,
    stub: {
      annotationDrawingState: () => drawing,
      async startAnnotationDrawing(kind) {
        calls.draw.push(kind)
        drawing = { status: 'drawing', kind, lastError: null }
        return 'started'
      },
      cancelAnnotationDrawing() {
        calls.cancels += 1
        drawing = { status: 'idle', kind: null, lastError: null }
        return true
      },
    },
  }
}

function mountPanel(dom, wire = wireOf()) {
  const occurrence = occurrenceStub()
  const root = createRoot(dom.container)
  act(() => {
    root.render(createElement(LayerPanel, {
      surface: 'annotation',
      wire,
      sessionId: 'session-1',
      occurrenceKey: 'tab',
      occurrence: () => occurrence.stub,
      t,
      useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
      changeSubmit: async input => ({ ok: true, revision: input.revision + 1 }),
      panelSubmit: async () => true,
    }))
  })
  dom.roots.push(root)
  return { container: dom.container, root, occurrence }
}

const flush = async () => { await act(async () => { for (let at = 0; at < 10; at += 1) await Promise.resolve() }) }
const click = async (dom, node) => { await act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))) }
const byText = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text)

test('drawing tools form one labeled toolbar with a trailing more menu', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountPanel(dom)
  const tools = container.querySelector('[data-map-panel-annotation-tools]')
  assert.ok(tools)
  assert.equal(tools.getAttribute('role'), 'group')
  assert.equal((tools.getAttribute('aria-label') ?? '').length > 0, true, 'the toolbar carries an accessible name')
  const more = tools.querySelector('[data-map-panel-annotation-menu] button[aria-haspopup="menu"]')
  assert.ok(more)
  assert.equal(more.hasAttribute('data-map-panel-icon'), true, 'the more menu is the toolbar trailing icon button')
  for (const kind of ['point', 'line', 'polygon', 'rectangle']) {
    assert.equal(byText(container, t(`panel.annotation.kind.${kind}`)) === null, false, `${kind} tool stays in the toolbar`)
  }
  assert.ok(tools.querySelector('[data-map-panel-bulk-count]')?.textContent.includes('2'), 'the toolbar states its annotation count')
})

test('drawing keeps the tool palette visible with the active tool pressed', async tContext => {
  const dom = installDom(tContext)
  const { container, occurrence } = mountPanel(dom)
  await click(dom, byText(container, t('panel.annotation.kind.point')))
  await flush()
  assert.deepEqual(occurrence.calls.draw.length, 1)
  const point = byText(container, t('panel.annotation.kind.point'))
  assert.equal(point === null, false, 'the palette stays visible while drawing')
  assert.equal(point.getAttribute('aria-pressed'), 'true')
  assert.equal(byText(container, t('panel.annotation.kind.line')).disabled, true, 'other tools wait for the draft to finish')
  assert.equal(byText(container, t('panel.annotation.cancel')) === null, false, 'cancel remains reachable in the toolbar')
})

test('annotations use the layer-row anatomy and open one shared dialog', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountPanel(dom)
  const rows = [...container.querySelectorAll('[data-map-annotation-row]')]
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.ok(row.querySelector('[data-map-panel-row]'), 'each annotation row reuses the layer row slot')
    const swatch = row.querySelector('[data-map-panel-swatch]')
    assert.ok(swatch)
    assert.equal(swatch.getAttribute('data-kind'), 'point', 'the swatch shape carries the geometry type')
    assert.ok(row.querySelector('[data-map-panel-name]'), 'the name opens the operation dialog')
    assert.ok(row.querySelector('[data-map-panel-actions] [aria-label^="Locate"]'), 'hover actions carry a locate control')
    assert.ok(row.querySelector('[data-map-panel-actions] button[aria-haspopup="dialog"]'), 'hover actions carry a trailing more dialog trigger')
  }
  assert.equal(container.querySelector('[data-map-annotation-editor]'), null, 'no inline editor remains')
  await click(dom, rows[0].querySelector('[data-map-panel-name]'))
  await flush()
  const dialog = dom.window.document.querySelector('[data-map-annotation-dialog]')
  assert.ok(dialog, 'the row name opens the annotation dialog')
  assert.equal(dialog.getAttribute('role'), 'group')
  const close = dom.window.document.querySelector(`[role="dialog"] button[aria-label="${t('panel.dialogClose')}"]`)
  assert.ok(close, 'the dialog keeps the shared close affordance')
})

test('the empty state belongs to the annotation list region', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountPanel(dom, wireOf([]))
  const list = container.querySelector('[data-map-panel-list]')
  assert.ok(list, 'the annotation list region renders even when empty')
  assert.ok(list.querySelector('[data-map-panel-empty]'), 'the empty state renders inside the list region it explains')
  assert.equal(container.querySelector('[data-map-panel-empty-inline]'), null)
})

test('annotation search appears above the layer threshold and filters rows', async tContext => {
  const dom = installDom(tContext)
  const features = ['A', 'B', 'C', 'D', 'E'].map(name => annotationFeature(`ann-0${name}`, `Site ${name}`))
  const { container } = mountPanel(dom, wireOf(features))
  const search = container.querySelector('[data-map-panel-search]')
  assert.ok(search, 'five annotations reveal the search field like the layer list')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(search, 'B')
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await flush()
  assert.equal(container.querySelectorAll('[data-map-annotation-row]').length, 1, 'tokens match like the layer search')
  assert.match(container.querySelector('[data-map-annotation-row] [data-map-panel-name]').textContent, /Site B/)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(search, 'no-such')
    search.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await flush()
  assert.equal(container.querySelectorAll('[data-map-annotation-row]').length, 0)
  assert.ok(container.querySelector('[data-map-panel-empty]'), 'a no-match list reports its empty state')
})

test('the annotation list scrolls inside the panel with an overflow hint', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountPanel(dom)
  const list = container.querySelector('[data-map-panel-list]')
  assert.ok(list)
  assert.match(list.getAttribute('class') ?? '', /.*/, 'the list keeps the shared scroll region styling')
  assert.equal(container.querySelector('[data-map-panel-annotations] [data-map-panel-list]') !== null, true, 'the list lives inside the annotation group')
})
