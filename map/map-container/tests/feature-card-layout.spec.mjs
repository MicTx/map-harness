import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
const { FeatureCard } = await importClient('../src/client/FeatureCard.tsx')
const { en } = await importClient('../src/client/locales.ts')
const { MAP_THEME_CSS } = await importClient('../src/client/map-theme.ts')

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

const inspection = {
  layerId: 'points',
  layerName: '重点点位',
  featureId: 'f1',
  title: '北京站',
  fields: [{ name: 'name', value: '北京站' }, { name: 'level', value: 'S1' }],
  omitted: 2,
  anchor: { left: 100, top: 100, right: 120, bottom: 120 },
}

function mountCard(dom, value = inspection) {
  const root = createRoot(dom.container)
  act(() => {
    root.render(createElement(FeatureCard, { inspection: value, onClose: () => {}, t }))
  })
  dom.roots.push(root)
  return { container: dom.container, root }
}

test('the feature card head shares the panel header skeleton', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountCard(dom)
  const head = container.querySelector('[data-map-feature-card-head]')
  assert.ok(head)
  assert.equal(head.querySelector('h3') === null, false, 'the head keeps its feature title as a heading')
  assert.equal(head.querySelector('[data-map-panel-icon]') === null, false, 'the head close uses the shared icon control')
  assert.match(MAP_THEME_CSS, /\[data-map-feature-card-head\], \[data-map-panel-header\] \{[^}]*position: sticky/)
})

test('field rows use the shared divider treatment and definition semantics', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountCard(dom)
  const rows = [...container.querySelectorAll('[data-map-feature-card] dl > div')]
  assert.equal(rows.length, 2)
  for (const row of rows) {
    assert.equal(row.querySelector('dt') === null || row.querySelector('dd') === null, false, 'each row keeps its label/value definition pair')
  }
  assert.match(MAP_THEME_CSS, /\[data-map-feature-card\] dl > div \{[^}]*border-bottom: 1px solid var\(--map-border\)/)
})

test('the feature card pairs its control with shared primitives', () => {
  const source = readFileSync(new URL('../src/client/FeatureCard.tsx', import.meta.url), 'utf8')
  const rawButtons = [...source.matchAll(/<button\b[^>]*>/g)].map(match => match[0])
  assert.deepEqual(rawButtons, [], 'the card close control uses Button')
})
