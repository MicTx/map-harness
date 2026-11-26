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
const { createMapSourceCatalog } = await importClient('../src/sources.ts')
const { en } = await importClient('../src/client/locales.ts')

const t = (key, params) => {
  const template = en[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/gu, (whole, name) => params[name] ?? '')
}

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement',
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

function mountImagery(dom, { canChange = true } = {}) {
  const catalog = createMapSourceCatalog(undefined, 'allow', {})
  const submitted = []
  const wire = {
    layers: [],
    view: { center: [116.4, 39.9], zoom: 8, wkid: 4326 },
    mode: 'map',
    basemap: catalog.selection('esri-world-imagery', 'amap-imagery-labels').value,
    aoi: null,
    revision: 7,
    operations: [],
    observationRequest: null,
    visualProposals: [],
    visualChanges: [],
  }
  const page = {
    schemaVersion: 1,
    catalogVersion: 'fixture',
    canChange,
    context: { provider: null, at: null, zoom: null },
    sources: [...catalog.list().sources],
    nextCursor: null,
  }
  const root = createRoot(dom.container)
  act(() => {
    root.render(createElement(LayerPanel, {
      surface: 'imagery',
      wire,
      sessionId: 'session-1',
      occurrenceKey: 'tab',
      occurrence: () => null,
      t,
      useResource: () => ({ status: 'live', value: page, failure: undefined }),
      changeSubmit: async input => {
        submitted.push(input)
        return { ok: true, revision: input.revision + 1 }
      },
    }))
  })
  dom.roots.push(root)
  return { container: dom.container, root, submitted }
}

const click = async (dom, node) => { await act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))) }
const rowsOf = container => [...container.querySelectorAll('[data-map-imagery-row]')]
const rowOf = (container, kind) => container.querySelector(`[data-map-imagery-row][data-imagery-kind="${kind}"]`)

test('imagery resources form one flat row list in the shared row anatomy', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountImagery(dom)
  const sources = container.querySelector('[data-map-panel-sources]')
  assert.ok(sources)
  assert.equal(container.querySelector('[data-map-imagery-tabs]'), null, 'no nested tablist remains')
  assert.deepEqual(rowsOf(container).map(row => row.getAttribute('data-imagery-kind')), ['labels', 'recent', 'early'])
  for (const row of rowsOf(container)) {
    const inner = row.querySelector('[data-map-panel-row]')
    assert.ok(inner, 'each imagery row reuses the layer row slot')
    assert.ok(row.querySelector('[data-map-panel-swatch], [data-map-panel-type]'), 'each row identifies its type')
    assert.ok(row.querySelector('[data-map-panel-name]'), 'each row names its period')
    assert.ok(row.querySelector('[data-map-panel-state]'), 'each row reports its display state')
    assert.ok(row.querySelector('[data-map-panel-eye]'), 'each row carries the shared eye toggle')
    assert.ok(row.querySelector('[data-map-panel-actions] button[aria-haspopup="dialog"]'), 'each row opens its source dialog from the trailing more button')
  }
})

test('eye toggles submit set-imagery-display', async tContext => {
  const dom = installDom(tContext)
  const { container, submitted } = mountImagery(dom)
  const labelsEye = rowOf(container, 'labels').querySelector('[data-map-panel-eye]')
  assert.equal(labelsEye.getAttribute('aria-pressed'), 'true')
  await click(dom, labelsEye)
  await act(async () => { for (let at = 0; at < 10; at += 1) await Promise.resolve() })
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].change.op, 'set-imagery-display')
  assert.equal(submitted[0].change.display.labelsVisible, false)
})

test('a read-only catalog locks every toggle', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountImagery(dom, { canChange: false })
  for (const row of rowsOf(container)) {
    assert.equal(row.querySelector('[data-map-panel-eye]').disabled, true, 'a read-only catalog locks every toggle')
  }
})

test('each row opens its own source dialog', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountImagery(dom)
  await click(dom, rowOf(container, 'labels').querySelector('[data-map-panel-actions] button[aria-haspopup="dialog"]'))
  await act(async () => { for (let at = 0; at < 10; at += 1) await Promise.resolve() })
  const labelsDialog = dom.window.document.querySelector('[data-map-imagery-dialog]')
  assert.ok(labelsDialog, 'the labels row opens its dialog')
  assert.ok(labelsDialog.querySelector('select[data-map-panel-source="labels"]'), 'the labels dialog owns the labels select')
  await click(dom, dom.window.document.querySelector(`[role="dialog"] button[aria-label="${t('panel.dialogClose')}"]`))

  await click(dom, rowOf(container, 'recent').querySelector('[data-map-panel-actions] button[aria-haspopup="dialog"]'))
  await act(async () => { for (let at = 0; at < 10; at += 1) await Promise.resolve() })
  const recentDialog = dom.window.document.querySelector('[data-map-imagery-dialog]')
  assert.ok(recentDialog.querySelector('select[data-map-panel-source="base"]'), 'the recent dialog owns the basemap select')
  assert.ok(recentDialog.querySelector('[data-map-imagery-opacity]'), 'the recent dialog owns the opacity slider')
})
