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
  const mapContainer = dom.window.document.createElement('div')
  mapContainer.setAttribute('data-map-container', '')
  const container = dom.window.document.createElement('div')
  mapContainer.append(container)
  dom.window.document.body.append(mapContainer)
  const expose = (name, value) => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  for (const name of DOM_GLOBALS) expose(name, dom.window[name])
  const roots = []
  tContext.after(() => {
    for (const root of roots) act(() => root.unmount())
    mapContainer.remove()
    dom.window.close()
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
  })
  return { window: dom.window, mapContainer, container, roots }
}

const wireOf = () => ({
  layers: [
    { id: 'alpha', name: 'Alpha', visible: true, opacity: 1, sourceCrs: 'EPSG:4326',
      data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'alpha-f', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: {} }] } },
  ],
  view: { center: [116.4, 39.9], zoom: 8, wkid: 4326 },
  mode: 'map', basemap: null,
  imageryDisplay: { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null },
  aoi: null, revision: 7, operations: [], observationRequest: null,
  visualProposals: [], visualChanges: [], undoableAnnotation: null,
})

const rectOf = (left, top, width, height) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
  toJSON: () => ({}),
})

function mount(dom, { width = 1000, height = 800, panelHeight = 300 } = {}) {
  dom.mapContainer.getBoundingClientRect = () => rectOf(0, 0, width, height)
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
  const card = dom.container.querySelector('[data-map-panel]')
  card.getBoundingClientRect = () => rectOf(
    Number.parseFloat(card.style.left) || 10,
    Number.parseFloat(card.style.top) || 10,
    Number.parseFloat(card.style.width) || 280,
    Number.parseFloat(card.style.height) || panelHeight,
  )
  return { container: dom.container, card, root }
}

const pointer = async (dom, target, type, init) => {
  await act(async () => {
    target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }))
  })
}
const down = (dom, node, x, y) => pointer(dom, node, 'pointerdown', { clientX: x, clientY: y })
const move = (dom, x, y) => pointer(dom, dom.window, 'pointermove', { clientX: x, clientY: y })
const up = (dom, x, y) => pointer(dom, dom.window, 'pointerup', { clientX: x, clientY: y })
const click = async (dom, node) => { await act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) }) }

test('header pointer drag moves the card by the pointer delta', async tContext => {
  const dom = installDom(tContext)
  const { card } = mount(dom)
  const header = card.querySelector('[data-map-panel-header]')
  await down(dom, header, 100, 20)
  await move(dom, 150, 60)
  await up(dom, 150, 60)
  assert.equal(card.style.position, 'absolute')
  assert.equal(card.style.left, '60px', 'origin x 10 + dx 50')
  assert.equal(card.style.top, '50px', 'origin y 10 + dy 40')
})

test('movement below the 4px threshold never starts a drag', async tContext => {
  const dom = installDom(tContext)
  const { card } = mount(dom)
  const header = card.querySelector('[data-map-panel-header]')
  await down(dom, header, 100, 20)
  await move(dom, 102, 22)
  await up(dom, 102, 22)
  assert.equal(card.style.left, '', 'no custom position was applied')
  assert.equal(card.style.top, '')
})

test('the drag clamps the card inside the map container', async tContext => {
  const dom = installDom(tContext)
  const { card } = mount(dom)
  const header = card.querySelector('[data-map-panel-header]')
  await down(dom, header, 100, 20)
  await move(dom, 5000, 5000)
  await up(dom, 5000, 5000)
  assert.equal(card.style.left, '720px', 'container width 1000 - card width 280')
  assert.equal(card.style.top, '500px', 'container height 800 - card height 300')
  await down(dom, header, 100, 20)
  await move(dom, -5000, -5000)
  await up(dom, -5000, -5000)
  assert.equal(card.style.left, '0px')
  assert.equal(card.style.top, '0px')
})

test('header buttons never start a drag and still toggle collapse', async tContext => {
  const dom = installDom(tContext)
  const { card } = mount(dom)
  const collapse = card.querySelector('[data-map-panel-collapse]')
  await down(dom, collapse, 100, 20)
  await move(dom, 400, 400)
  await up(dom, 400, 400)
  assert.equal(card.style.left, '', 'the collapse button suppressed the drag')
  await click(dom, collapse)
  assert.equal(card.hasAttribute('data-map-panel-collapsed'), true)
})

test('the collapsed title bar stays draggable', async tContext => {
  const dom = installDom(tContext)
  const { card } = mount(dom)
  await click(dom, card.querySelector('[data-map-panel-collapse]'))
  assert.equal(card.hasAttribute('data-map-panel-collapsed'), true)
  card.getBoundingClientRect = () => rectOf(10, 10, 280, 32)
  const header = card.querySelector('[data-map-panel-header]')
  await down(dom, header, 100, 20)
  await move(dom, 130, 90)
  await up(dom, 130, 90)
  assert.equal(card.style.left, '40px')
  assert.equal(card.style.top, '80px')
})

test('a container resize re-clamps the dragged card back into view', async tContext => {
  const dom = installDom(tContext)
  const observers = []
  const savedResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback }
    observe() { observers.push(this) }
    disconnect() {}
  }
  tContext.after(() => {
    if (savedResizeObserver === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = savedResizeObserver
  })
  const { card } = mount(dom)
  const header = card.querySelector('[data-map-panel-header]')
  await down(dom, header, 100, 20)
  await move(dom, 700, 480)
  await up(dom, 700, 480)
  assert.equal(card.style.left, '610px')
  assert.equal(card.style.top, '470px')
  dom.mapContainer.getBoundingClientRect = () => rectOf(0, 0, 400, 700)
  await act(async () => { for (const observer of observers) observer.callback([], observer) })
  assert.equal(card.style.left, '120px', 're-clamped to container width 400 - card width 280')
  assert.equal(card.style.top, '400px', 're-clamped to container height 700 - card height 300')
})

test('all eight resize handles move their edges and preserve the opposite edges', async tContext => {
  const expected = {
    n: [10, 30, 280, 280], ne: [10, 30, 310, 280], e: [10, 10, 310, 300],
    se: [10, 10, 310, 320], s: [10, 10, 280, 320], sw: [40, 10, 250, 320],
    w: [40, 10, 250, 300], nw: [40, 30, 250, 280],
  }
  for (const [direction, result] of Object.entries(expected)) {
    await tContext.test(direction, async child => {
      const dom = installDom(child)
      const { card } = mount(dom)
      await down(dom, card.querySelector(`[data-map-panel-resize="${direction}"]`), 100, 100)
      await move(dom, 130, 120)
      await up(dom, 130, 120)
      assert.deepEqual(['left', 'top', 'width', 'height'].map(key => Number.parseFloat(card.style[key])), result)
    })
  }
})

test('resize bounds, collapse and expansion retain the chosen size', async tContext => {
  const dom = installDom(tContext)
  const { card } = mount(dom)
  await down(dom, card.querySelector('[data-map-panel-resize="se"]'), 100, 100)
  await move(dom, 5000, 5000)
  await up(dom, 5000, 5000)
  assert.equal(card.style.width, '990px')
  assert.equal(card.style.height, '790px')
  await click(dom, card.querySelector('[data-map-panel-collapse]'))
  assert.equal(card.style.height, '790px')
  await click(dom, card.querySelector('[data-map-panel-collapse]'))
  assert.equal(card.style.height, '790px')
  await down(dom, card.querySelector('[data-map-panel-resize="nw"]'), 100, 100)
  await move(dom, 5000, 5000)
  await up(dom, 5000, 5000)
  assert.equal(card.style.width, '240px')
  assert.equal(card.style.height, '180px')
})

test('shrinking the available area constrains size and position even while collapsed', async tContext => {
  const dom = installDom(tContext)
  const observers = []
  const savedResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback }
    observe(target) { this.target = target; observers.push(this) }
    disconnect() {}
  }
  tContext.after(() => {
    if (savedResizeObserver === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = savedResizeObserver
  })
  const { card } = mount(dom)
  await down(dom, card.querySelector('[data-map-panel-resize="se"]'), 100, 100)
  await move(dom, 700, 600)
  await up(dom, 700, 600)
  await click(dom, card.querySelector('[data-map-panel-collapse]'))
  dom.mapContainer.getBoundingClientRect = () => rectOf(0, 0, 350, 250)
  await act(async () => { for (const observer of observers.filter(item => item.target === dom.mapContainer)) observer.callback([], observer) })
  await click(dom, card.querySelector('[data-map-panel-collapse]'))
  assert.equal(card.style.width, '350px')
  assert.equal(card.style.height, '250px')
  assert.equal(card.style.left, '0px')
  assert.equal(card.style.top, '0px')
})

test('pointer cancellation and unmount release active gesture listeners', async tContext => {
  const dom = installDom(tContext)
  const { card, root } = mount(dom)
  const header = card.querySelector('[data-map-panel-header]')
  await down(dom, header, 100, 100)
  await move(dom, 130, 140)
  assert.equal(card.style.left, '40px')
  await pointer(dom, dom.window, 'pointercancel', {})
  await move(dom, 300, 300)
  assert.equal(card.style.left, '')
  await down(dom, header, 100, 100)
  act(() => root.unmount())
  dom.roots.splice(dom.roots.indexOf(root), 1)
  await move(dom, 300, 300)
  assert.equal(card.style.left, '')
})

test('closing the map discards its panel geometry', async tContext => {
  const dom = installDom(tContext)
  const first = mount(dom)
  await down(dom, first.card.querySelector('[data-map-panel-resize="se"]'), 100, 100)
  await move(dom, 200, 200)
  await up(dom, 200, 200)
  assert.equal(first.card.style.width, '380px')
  act(() => first.root.unmount())
  dom.roots.splice(dom.roots.indexOf(first.root), 1)
  const second = mount(dom)
  assert.equal(second.card.style.width, '')
  assert.equal(second.card.style.height, '')
})
