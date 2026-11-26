/**
 * Browser-free DOM and behavior contract for the Mapbox-compatible controls:
 * official structure, icon slots, camera wiring, scale text, and the compact
 * attribution toggle.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import React from 'react'
import { tsImport } from 'tsx/esm/api'

const { createElement, act } = React
globalThis.React = React
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const uiPrimitivesRequire = createRequire(new URL('../../../packages/client/ui-primitives/package.json', import.meta.url))
const createRoot = (...args) => uiPrimitivesRequire('react-dom/client').createRoot(...args)
const importClient = specifier => tsImport(specifier, {
  parentURL: import.meta.url,
  tsconfig: new URL('../tsconfig.json', import.meta.url).pathname,
})
const { MapboxControls } = await importClient('../src/client/mapbox-controls.tsx')
const { en } = await importClient('../src/client/locales.ts')

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLDivElement', 'HTMLButtonElement',
  'HTMLInputElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'Document',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent',
  'InputEvent', 'UIEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame',
]

const t = (key) => en[key] ?? key

function fixture(tContext) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const saved = new Map()
  const expose = (name, value) => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  for (const name of DOM_GLOBALS) expose(name, dom.window[name])
  const doc = dom.window.document
  const map = doc.createElement('section')
  map.setAttribute('data-map-container', '')
  const canvas = doc.createElement('div')
  canvas.setAttribute('data-map-canvas', '')
  const attribution = doc.createElement('div')
  attribution.className = 'esri-view-attribution'
  attribution.textContent = 'Esri, HERE'
  canvas.append(attribution)
  const overlay = doc.createElement('div')
  overlay.setAttribute('data-map-overlay-content', '')
  const mount = doc.createElement('div')
  overlay.append(mount)
  map.append(canvas, overlay)
  doc.body.append(map)

  const calls = []
  let controlState = { rotation: 30, scaleLabel: '5 km', zoom: 9 }
  const occurrence = {
    mapControlState: () => controlState,
    zoomBy: delta => { calls.push(['zoom', delta]); controlState = { ...controlState, zoom: controlState.zoom + delta }; return 'applied' },
    resetBearing: () => { calls.push(['bearing']); controlState = { ...controlState, rotation: 0 }; return 'applied' },
  }
  const fullscreenCalls = []
  map.requestFullscreen = () => { fullscreenCalls.push('enter'); return Promise.resolve() }
  const root = createRoot(mount)
  tContext.after(() => {
    act(() => root.unmount())
    map.remove()
    dom.window.close()
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
  })
  act(() => root.render(createElement(MapboxControls, { occurrence: () => occurrence, t })))
  return { doc, map, calls, fullscreenCalls, getState: () => controlState }
}

function click(doc, selector) {
  const button = doc.querySelector(selector)
  assert.ok(button, `${selector} must render`)
  act(() => button.dispatchEvent(new doc.defaultView.MouseEvent('click', { bubbles: true })))
}

test('the four official control groups render with icon slots', t => {
  const { doc } = fixture(t)
  assert.equal(doc.querySelectorAll('[data-mapbox-controls]').length, 1)
  assert.equal(doc.querySelectorAll('[data-mapbox-ctrl-group]').length, 2)
  assert.equal(doc.querySelectorAll('[data-mapbox-ctrl-top-right]').length, 1)
  assert.equal(doc.querySelectorAll('[data-mapbox-ctrl-bottom-left]').length, 1)
  assert.equal(doc.querySelectorAll('[data-mapbox-ctrl-bottom-right]').length, 1)
  for (const name of ['zoom-in', 'zoom-out', 'compass', 'fullscreen']) {
    const button = doc.querySelector(`[data-mapbox-ctrl-${name}]`)
    assert.ok(button, name)
    assert.ok(button.querySelector('[data-mapbox-ctrl-icon]'), `${name} icon`)
    assert.ok(button.getAttribute('aria-label'), `${name} label`)
  }
  assert.match(doc.querySelector('[data-mapbox-ctrl-scale]').textContent, /5 km/)
  assert.equal(doc.querySelector('[data-mapbox-ctrl-attrib-inner]').textContent, 'Esri, HERE')
  assert.ok(doc.querySelector('[data-mapbox-ctrl-attrib-button]'))
})

test('zoom, compass, and fullscreen write through the occurrence', t => {
  const { doc, calls, fullscreenCalls } = fixture(t)
  click(doc, '[data-mapbox-ctrl-zoom-in]')
  click(doc, '[data-mapbox-ctrl-zoom-out]')
  click(doc, '[data-mapbox-ctrl-compass]')
  click(doc, '[data-mapbox-ctrl-fullscreen]')
  assert.deepEqual(calls, [['zoom', 1], ['zoom', -1], ['bearing']])
  assert.deepEqual(fullscreenCalls, ['enter'])
})

test('the compass icon rotates with the live bearing', t => {
  const { doc } = fixture(t)
  const icon = doc.querySelector('[data-mapbox-ctrl-compass] > [data-mapbox-ctrl-icon]')
  assert.equal(icon.style.getPropertyValue('--mapbox-compass-rotation'), '-30deg')
  click(doc, '[data-mapbox-ctrl-compass]')
  assert.equal(icon.style.getPropertyValue('--mapbox-compass-rotation'), '0deg')
})

test('the compact attribution expands on a real click', t => {
  const { doc } = fixture(t)
  const attrib = doc.querySelector('[data-mapbox-ctrl-attrib]')
  assert.equal(attrib.hasAttribute('data-mapbox-compact-show'), false)
  assert.equal(doc.querySelector('[data-mapbox-ctrl-attrib-button]').getAttribute('aria-expanded'), 'false')
  click(doc, '[data-mapbox-ctrl-attrib-button]')
  assert.equal(attrib.hasAttribute('data-mapbox-compact-show'), true)
  assert.equal(doc.querySelector('[data-mapbox-ctrl-attrib-button]').getAttribute('aria-expanded'), 'true')
})
