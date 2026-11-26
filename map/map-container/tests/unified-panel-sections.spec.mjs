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

const layerOf = (id, name) => ({
  id, name, visible: true, opacity: 1, sourceCrs: 'EPSG:4326',
  data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: `${id}-f`, geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: {} }] },
})
const annotationOf = (id, name) => ({
  type: 'Feature', id,
  geometry: { type: 'Point', coordinates: [116.4, 39.9] },
  properties: { name, dshRole: 'user-annotation', dshAuthor: 'user', dshSource: 'manual', dshCreatedAt: '2026-11-13T00:00:00.000Z', dshUpdatedAt: '2026-11-13T00:00:00.000Z' },
})
const wireOf = () => ({
  layers: [
    layerOf('alpha', 'Alpha'),
    { id: 'user-annotations', name: 'User annotations', role: 'user-annotation', visible: true, opacity: 1, sourceCrs: 'EPSG:4326', data: { type: 'FeatureCollection', features: [annotationOf('ann-1', 'Site A')] } },
  ],
  view: { center: [116.4, 39.9], zoom: 8, wkid: 4326 },
  mode: 'map', basemap: null,
  imageryDisplay: { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null },
  aoi: null, revision: 7, operations: [], observationRequest: null,
  visualProposals: [], visualChanges: [], undoableAnnotation: null,
})

function mount(dom) {
  const root = createRoot(dom.container)
  act(() => {
    root.render(createElement(LayerPanel, {
      surface: 'unified', wire: wireOf(), sessionId: 'session-1', occurrenceKey: 'tab',
      occurrence: () => null, t,
      useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
      changeSubmit: async input => ({ ok: true, revision: input.revision + 1 }),
      panelSubmit: undefined,
    }))
  })
  dom.roots.push(root)
  return { container: dom.container, root }
}

const click = async (dom, node) => { await act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) }) }
const tabsOf = container => [...container.querySelectorAll('[role="tab"]')]
const bodiesOf = container => [...container.querySelectorAll('[role="tabpanel"]')]

test('one resident card presents three tables with layers selected', async tContext => {
  const dom = installDom(tContext)
  const { container } = mount(dom)
  const card = container.querySelector('[data-map-panel]')
  assert.equal(card.getAttribute('data-map-panel-surface'), 'unified')
  assert.equal(card.hasAttribute('data-map-panel-collapsed'), false)
  const tabs = tabsOf(container)
  assert.deepEqual(tabs.map(tab => tab.textContent), [t('panel.tab.imagery'), t('panel.tab.layers'), t('panel.tab.annotation')])
  assert.deepEqual(tabs.map(tab => tab.getAttribute('aria-selected')), ['false', 'true', 'false'])
  assert.deepEqual(bodiesOf(container).map(body => body.hidden), [true, false, true])
  for (const tab of tabs) {
    const body = dom.window.document.getElementById(tab.getAttribute('aria-controls'))
    assert.equal(body.getAttribute('aria-labelledby'), tab.id)
    assert.ok(body.querySelector('[role="table"]'))
  }
})

test('tabs support keyboard navigation and preserve their mounted content and scroll', async tContext => {
  const dom = installDom(tContext)
  const { container } = mount(dom)
  const layers = bodiesOf(container)[1]
  layers.scrollTop = 75
  tabsOf(container)[1].focus()
  await act(async () => tabsOf(container)[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
  assert.equal(dom.window.document.activeElement, tabsOf(container)[2])
  assert.deepEqual(bodiesOf(container).map(body => body.hidden), [true, true, false])
  await click(dom, tabsOf(container)[0])
  assert.deepEqual(bodiesOf(container).map(body => body.hidden), [false, true, true])
  await click(dom, tabsOf(container)[1])
  assert.equal(bodiesOf(container)[1], layers)
  assert.equal(layers.scrollTop, 75)
})

test('collapse keeps the chosen tab and its content mounted', async tContext => {
  const dom = installDom(tContext)
  const { container } = mount(dom)
  await click(dom, tabsOf(container)[2])
  const body = bodiesOf(container)[2]
  const collapse = container.querySelector('[data-map-panel-collapse]')
  await click(dom, collapse)
  const card = container.querySelector('[data-map-panel]')
  assert.equal(card.hasAttribute('data-map-panel-collapsed'), true)
  assert.equal(card.querySelector('[data-map-panel-body]').hidden, true)
  await click(dom, collapse)
  assert.equal(bodiesOf(container)[2], body)
  assert.equal(body.hidden, false)
  assert.equal(tabsOf(container)[2].getAttribute('aria-selected'), 'true')
})

test('portalled bulk menu remains usable, closes on Escape and restores focus', async tContext => {
  const dom = installDom(tContext)
  const { container } = mount(dom)
  const trigger = container.querySelector('[data-map-panel-bulk-menu] button')
  trigger.focus()
  await click(dom, trigger)
  const item = dom.window.document.querySelector('[role="menuitem"]')
  assert.ok(item)
  assert.equal(container.contains(item), false)
  item.focus()
  await act(async () => item.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  assert.equal(dom.window.document.querySelector('[role="menuitem"]'), null)
  assert.equal(dom.window.document.activeElement, trigger)
})
