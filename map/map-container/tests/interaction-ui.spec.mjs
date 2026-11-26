/**
 * Continuous map-use status strip: counts and current action are visible, the
 * stop control is a native button with its own handler, and the strip stays
 * absent before the first action.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import React from 'react'
import { tsImport } from 'tsx/esm/api'

const { createElement, act } = React
const uiPrimitivesRequire = createRequire(new URL('../../../packages/client/ui-primitives/package.json', import.meta.url))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const importClient = specifier => tsImport(specifier, { parentURL: import.meta.url, tsconfig: new URL('../tsconfig.json', import.meta.url).pathname })
const { MapUseStatus } = await importClient('../src/client/MapUseStatus.tsx')
const { en } = await importClient('../src/client/locales.ts')

const t = (key, params) => {
  const template = en[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/gu, (whole, name) => params[name] ?? '')
}

const DOM_GLOBALS = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'Event', 'MouseEvent']

function installDom(tContext) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true })
  const saved = new Map()
  for (const name of DOM_GLOBALS) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  }
  tContext.after(() => {
    dom.window.close()
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
  })
  return dom
}

test('status shows counts, current action, and a working stop button', async tContext => {
  const dom = installDom(tContext)
  const { createRoot } = uiPrimitivesRequire('react-dom/client')
  const container = dom.window.document.getElementById('root')
  const root = createRoot(container)
  let stops = 0
  const interaction = {
    stateVersion: 1, turn: 3, open: true, startedAt: 0, actions: 4, observations: 2,
    request: { callId: 'call', requestSeq: 9, turn: 3, observationId: 'obs', action: 'click', xPx: 10, yPx: 20, expiresAtMs: 1000 },
  }
  act(() => root.render(createElement(MapUseStatus, { interaction, onStop: () => { stops += 1 }, t })))
  const status = container.querySelector('[data-map-use-status]')
  assert.ok(status)
  assert.match(status.textContent, /4 actions \/ 2 observations/u)
  assert.match(status.textContent, /Current: inspect/u)
  const button = status.querySelector('button')
  assert.equal(button.textContent, 'Stop map use')
  act(() => button.click())
  assert.equal(stops, 1)
  act(() => root.unmount())
})

test('status is absent before the first action and after the turn closes', async tContext => {
  const dom = installDom(tContext)
  const { createRoot } = uiPrimitivesRequire('react-dom/client')
  const container = dom.window.document.getElementById('root')
  const root = createRoot(container)
  act(() => root.render(createElement(MapUseStatus, {
    interaction: { stateVersion: 1, turn: 1, open: true, startedAt: 0, actions: 0, observations: 0, request: null },
    onStop: () => {},
    t,
  })))
  assert.equal(container.querySelector('[data-map-use-status]'), null)
  act(() => root.render(createElement(MapUseStatus, {
    interaction: { stateVersion: 1, turn: 1, open: false, startedAt: 0, actions: 3, observations: 1, request: null },
    onStop: () => {},
    t,
  })))
  assert.equal(container.querySelector('[data-map-use-status]'), null)
  act(() => root.unmount())
})
