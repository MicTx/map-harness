import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import React from 'react'
import { createRequire } from 'node:module'
import { tsImport } from 'tsx/esm/api'

const { createElement, act } = React
globalThis.React = React
const uiPrimitivesRequire = createRequire(new URL('../../../packages/client/ui-primitives/package.json', import.meta.url))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let createRootFn
const createRoot = (...args) => (createRootFn ??= uiPrimitivesRequire('react-dom/client').createRoot)(...args)
const importClient = specifier => tsImport(specifier, { parentURL: import.meta.url, tsconfig: new URL('../tsconfig.json', import.meta.url).pathname })
const { FeatureCard } = await importClient('../src/client/FeatureCard.tsx')
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
  const rects = new Map()
  const rectOf = (element) => {
    if (element.hasAttribute('data-map-container')) return { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 }
    if (element.hasAttribute('data-map-overlay-content')) return { left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400 }
    if (element.hasAttribute('data-map-feature-card')) return { left: 0, top: 0, right: 300, bottom: 160, width: 300, height: 160 }
    if (element.hasAttribute('data-map-panel')) return { left: 450, top: 0, right: 590, bottom: 200, width: 140, height: 200 }
    return rects.get(element) ?? { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  }
  dom.window.Element.prototype.getBoundingClientRect = function () { return rectOf(this) }
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
  return { window: dom.window, container, roots, rects }
}

function mount(dom, inspection) {
  const root = createRoot(dom.container)
  dom.roots.push(root)
  act(() => {
    root.render(createElement('div', { 'data-map-container': '' },
      createElement('div', { 'data-map-overlay-content': '' },
        createElement('div', { 'data-map-panel': '' }),
        createElement(FeatureCard, { inspection, onClose: () => {}, t }),
      ),
    ))
  })
  return dom.container.querySelector('[data-map-feature-card]')
}

test('the card follows its feature anchor and flips away from a visible floating panel', async tContext => {
  const dom = installDom(tContext)
  const card = mount(dom, {
    layerId: 'points',
    layerName: 'Points',
    featureId: 'f1',
    title: 'Station',
    fields: [{ name: 'name', value: 'Station' }],
    omitted: 0,
    anchor: { left: 200, top: 180, right: 220, bottom: 220 },
  })
  assert.equal(card.dataset.mapFeatureSide, 'bottom')
  assert.equal(card.dataset.mapFeatureConstrained, 'false')
  assert.equal(card.style.left, '60px')
  assert.equal(card.style.top, '228px')
  assert.equal(card.style.visibility, 'visible')
})

test('a new anchor repositions the same card without losing its content', async tContext => {
  const dom = installDom(tContext)
  const root = createRoot(dom.container)
  dom.roots.push(root)
  const inspection = {
    layerId: 'points', layerName: 'Points', featureId: 'f1', title: 'Station',
    fields: [{ name: 'name', value: 'Station' }], omitted: 0,
    anchor: { left: 200, top: 180, right: 220, bottom: 220 },
  }
  const render = value => act(() => {
    root.render(createElement('div', { 'data-map-container': '' },
      createElement('div', { 'data-map-overlay-content': '' }, createElement(FeatureCard, { inspection: value, onClose: () => {}, t })),
    ))
  })
  render(inspection)
  const card = dom.container.querySelector('[data-map-feature-card]')
  assert.equal(card.dataset.mapFeatureSide, 'right')
  render({ ...inspection, anchor: { left: 80, top: 80, right: 100, bottom: 120 } })
  assert.equal(card.dataset.mapFeatureSide, 'right')
  assert.equal(card.style.left, '108px')
  assert.equal(card.querySelector('dd').textContent, 'Station')
})

test('the integration source observes card, overlay and floating surfaces together', () => {
  const source = readFileSync(new URL('../src/client/FeatureCard.tsx', import.meta.url), 'utf8')
  assert.match(source, /new globalThis\.ResizeObserver/)
  assert.match(source, /new globalThis\.MutationObserver/)
  assert.match(source, /data-map-canvas.*esri-view-attribution/s)
})
