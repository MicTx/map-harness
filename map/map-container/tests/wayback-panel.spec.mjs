import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import React from 'react'
import { JSDOM } from 'jsdom'
import { tsImport } from 'tsx/esm/api'
import { waybackDescriptor } from '../src/wayback.ts'

globalThis.React = React

const importClient = specifier => tsImport(specifier, { parentURL: import.meta.url, tsconfig: new URL('../tsconfig.json', import.meta.url).pathname })
const { WaybackPanel } = await importClient('../src/client/wayback-panel.tsx')
const { readWaybackReleases } = await importClient('../src/client/wayback-client.ts')
const { en } = await importClient('../src/client/locales.ts')
const require = createRequire(new URL('../../../packages/client/ui-primitives/package.json', import.meta.url))
const { createRoot } = require('react-dom/client')
const { createElement, act } = React

const older = {
  releaseId: 10,
  itemId: '903f0abe9c3b452dafe1ca5b8dd858b9',
  title: 'World Imagery (Wayback 2014-02-20)',
  publishedAt: '2014-02-20',
  layerIdentifier: 'WB_2014_R01',
  acquiredAt: null,
}
const newer = {
  releaseId: 50,
  itemId: 'a'.repeat(32),
  title: 'World Imagery (Wayback 2025-10-29)',
  publishedAt: '2025-10-29',
  layerIdentifier: 'WB_2025_R01',
  acquiredAt: null,
}
const descriptor = item => waybackDescriptor(item)
const translate = (key, params = {}) => (en[key] ?? key).replace(/\{(\w+)\}/g, (_match, name) => params[name] ?? '')
const response = value => ({ ok: true, json: async () => value })

test('catalog pagination reaches older releases and rejects malformed descriptors', async t => {
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous })
  const requests = []
  globalThis.fetch = async url => {
    requests.push(String(url))
    const cursor = new URL(String(url), 'http://owner.test').searchParams.get('cursor')
    return response(cursor === null
      ? { schemaVersion: 1, releases: [{ ...newer, descriptor: descriptor(newer) }], nextCursor: 'next' }
      : { schemaVersion: 1, releases: [{ ...older, descriptor: descriptor(older) }], nextCursor: null })
  }
  const result = await readWaybackReleases('session-1', new AbortController().signal)
  assert.deepEqual(result.map(item => item.release.releaseId), [50, 10])
  assert.equal(requests.length, 2)
  globalThis.fetch = async () => response({ schemaVersion: 1, releases: [{ ...older, descriptor: { id: 'attacker' } }], nextCursor: null })
  await assert.rejects(readWaybackReleases('session-1', new AbortController().signal), /invalid Wayback source/)
})

test('the panel directly selects a fixed release from the catalog', async tContext => {
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async input => {
    requests.push(String(input))
    return response({ schemaVersion: 1, releases: [{ ...older, descriptor: descriptor(older) }], nextCursor: null })
  }
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLSelectElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
  const saved = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const name of globals.filter(name => name !== 'IS_REACT_ACT_ENVIRONMENT')) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(dom.window.document.getElementById('root'))
  tContext.after(() => {
    act(() => root.unmount())
    dom.window.close()
    globalThis.fetch = previousFetch
    for (const [name, property] of saved) {
      if (property === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, property)
    }
  })
  const selected = []
  await act(async () => {
    root.render(createElement(WaybackPanel, {
      sessionId: 'session-1',
      canWrite: true,
      current: null,
      t: translate,
      onSelect: source => selected.push(source),
    }))
    await new Promise(resolve => setImmediate(resolve))
  })
  const select = dom.window.document.querySelector('[data-map-wayback-release]')
  assert.ok(select)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
    setter.call(select, '10')
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  assert.equal(selected.length, 1)
  assert.equal(selected[0].release.version, '10')
  await act(async () => {
    root.render(createElement(WaybackPanel, {
      sessionId: 'session-1',
      canWrite: true,
      current: selected[0],
      t: translate,
      onSelect: source => selected.push(source),
    }))
  })
  assert.ok(requests.every(url => url.includes('operation=catalog')))
  assert.ok(requests.every(url => !url.includes('operation=local') && !url.includes('operation=coverage') && !url.includes('operation=metadata')))
  assert.match(dom.window.document.body.textContent, /Published: 2014-02-20/)
})

test('the selector waits for a cold catalog, disables new selection on failure, and retries only the local catalog', async tContext => {
  tContext.mock.timers.enable({ apis: ['setTimeout'] })
  const previousFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async input => {
    requests.push(String(input))
    if (requests.length === 1) return new Response(null, { status: 503, headers: { 'retry-after': '1' } })
    if (requests.length === 2) return new Response(null, { status: 502 })
    return response({ schemaVersion: 1, releases: [{ ...newer, descriptor: descriptor(newer) }], nextCursor: null })
  }
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLSelectElement', 'HTMLButtonElement', 'Node', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
  const saved = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const name of globals.filter(name => name !== 'IS_REACT_ACT_ENVIRONMENT')) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const root = createRoot(dom.window.document.getElementById('root'))
  tContext.after(() => {
    act(() => root.unmount())
    dom.window.close()
    globalThis.fetch = previousFetch
    for (const [name, property] of saved) {
      if (property === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, property)
    }
  })
  await act(async () => {
    root.render(createElement(WaybackPanel, {
      sessionId: 'session-1',
      canWrite: true,
      current: null,
      t: translate,
      onSelect: () => {},
    }))
    await new Promise(resolve => setImmediate(resolve))
  })
  const document = dom.window.document
  const select = document.querySelector('[data-map-wayback-release]')
  assert.equal(select.disabled, true)
  assert.equal(document.querySelector('[role="alert"]'), null)
  assert.match(document.querySelector('[role="status"]').textContent, /Preparing the early imagery catalog/)
  await act(async () => tContext.mock.timers.tick(1000))
  assert.equal(select.disabled, true)
  assert.match(document.querySelector('[role="alert"]').textContent, /temporarily unavailable/)
  const retry = document.querySelector('[role="alert"] button')
  assert.ok(retry)
  await act(async () => retry.click())
  assert.equal(requests.length, 3)
  assert.ok(requests.every(url => new URL(url, 'http://owner.test').searchParams.get('operation') === 'catalog'))
  assert.equal(select.disabled, false)
  assert.equal(select.options[1].value, String(newer.releaseId))
})
