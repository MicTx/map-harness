import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import React from 'react'
import { tsImport } from 'tsx/esm/api'
import {
  OLD_RELEASE, NEW_RELEASE, admittedSource, catalogBody, catalogHarness, catalogRelease, catalogResponse,
} from './wayback-panel-fixture.mjs'

globalThis.React = React
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const importClient = specifier => tsImport(specifier, { parentURL: import.meta.url, tsconfig: new URL('../tsconfig.json', import.meta.url).pathname })
const { WaybackPanel } = await importClient('../src/client/wayback-panel.tsx')
const { admitWaybackRelease, MAP_WAYBACK_ADMIT_ROUTE } = await importClient('../src/client/wayback-client.ts')
const { en } = await importClient('../src/client/locales.ts')
const primitives = createRequire(new URL('../../../packages/client/ui-primitives/package.json', import.meta.url))
const { createRoot } = primitives('react-dom/client')
const { createElement, act } = React

const translate = (key, params = {}) => (en[key] ?? key).replace(/\{(\w+)\}/g, (_match, name) => params[name] ?? '')

function installDom(t) {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  const globals = ['window', 'document', 'navigator', 'HTMLElement', 'HTMLSelectElement', 'HTMLButtonElement', 'Element', 'Node', 'Event', 'MouseEvent']
  const saved = new Map(globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  for (const name of globals) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  }
  const root = createRoot(dom.window.document.getElementById('root'))
  t.after(() => {
    act(() => root.unmount())
    dom.window.close()
    for (const [name, property] of saved) {
      if (property === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, property)
    }
  })
  return { document: dom.window.document, root, window: dom.window }
}

const flush = async () => { await act(async () => { await new Promise(resolve => setImmediate(resolve)) }) }
const NO_REFRESH = () => {}
/** Panel props with a catalog view; `catalog` overrides the view, `releases` the list, `rest` the other props. */
const panelProps = (selected, { catalog: view = {}, releases, ...rest } = {}) => ({
  t: translate, current: null, busy: false, pendingReleaseId: null, failure: null,
  onSelect: release => selected.push(release), onClear: () => selected.push(null), onRefresh: NO_REFRESH,
  catalog: { state: 'ready', refreshing: false, refresh: NO_REFRESH, ...(releases === undefined ? {} : { releases }), ...view },
  ...rest,
})
const change = async (window, select, value) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(select, value)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}

test('admission posts the release identity with session credentials and returns the canonical source', async t => {
  const previous = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ input, init })
    return Response.json(admittedSource(OLD_RELEASE))
  }
  t.after(() => { globalThis.fetch = previous })
  const result = await admitWaybackRelease('session-1', OLD_RELEASE, new AbortController().signal)
  assert.deepEqual(calls.map(call => call.input), [MAP_WAYBACK_ADMIT_ROUTE])
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sessionId: 'session-1',
    release: { releaseId: 10, itemId: OLD_RELEASE.itemId, publishedAt: '2014-02-20', layerIdentifier: 'WB_2014_R01' },
  })
  assert.equal(result.ok, true)
  assert.equal(result.source.release.version, '10')
})

test('admission reports typed failures and never throws', async t => {
  const previous = globalThis.fetch
  t.after(() => { globalThis.fetch = previous })
  const cases = [
    [() => Response.json({ ok: false, code: 'SOURCE_READ_ONLY' }, { status: 403 }), 'denied'],
    [() => Response.json({ ok: false, code: 'SOURCE_CHANGED' }, { status: 409 }), 'changed'],
    [() => Response.json({ ok: false, code: 'SOURCE_UNAVAILABLE' }, { status: 503 }), 'unavailable'],
    [() => Response.json({ ok: false, code: 'SOURCE_TIMEOUT' }, { status: 504 }), 'unavailable'],
    [() => new Response('gateway', { status: 502 }), 'unavailable'],
    [() => { throw new TypeError('offline') }, 'network'],
    [() => Response.json({ ...admittedSource(OLD_RELEASE), release: { version: '50', publishedAt: '2014-02-20', acquiredAt: null } }), 'invalid'],
    [() => Response.json({ id: 'esri-world-imagery' }), 'invalid'],
  ]
  for (const [reply, reason] of cases) {
    globalThis.fetch = async () => reply()
    assert.deepEqual(await admitWaybackRelease('session-1', OLD_RELEASE, new AbortController().signal), { ok: false, reason }, reason)
  }
  const controller = new AbortController()
  controller.abort()
  globalThis.fetch = async () => { throw new DOMException('aborted', 'AbortError') }
  assert.deepEqual(await admitWaybackRelease('session-1', OLD_RELEASE, controller.signal), { ok: false, reason: 'cancelled' })
})

test('the panel lists the owner snapshot without any same-origin catalog request and selects nothing on refresh', async t => {
  const { document, root, window } = installDom(t)
  const harness = catalogHarness(catalogResponse(catalogBody([10, '2014-02-20', 'a'])), new Error('offline'))
  t.after(() => harness.owner.dispose())
  await harness.owner.ensureFresh()
  const selected = []
  const render = (overrides = {}) => act(async () => {
    root.render(createElement(WaybackPanel, panelProps(selected, {
      releases: harness.owner.getSnapshot().releases, ...overrides,
    })))
  })
  await render()
  const select = document.querySelector('[data-map-wayback-release]')
  assert.equal(select.disabled, false)
  assert.deepEqual([...select.options].map(option => [option.value, option.textContent]), [
    ['', 'Choose an ArcGIS Wayback release'], ['10', 'World Imagery (Wayback 2014-02-20)'],
  ])
  assert.equal(document.querySelector('[role="status"]'), null)

  // A failed refresh keeps the last verified list and the current value.
  await act(async () => { await harness.owner.refresh() })
  assert.equal(harness.owner.getSnapshot().reason, 'network')
  await render()
  assert.equal(select.options.length, 2)
  assert.equal(select.value, '')
  assert.equal(selected.length, 0)
  assert.equal(harness.calls.length, 2)

  await change(window, select, '10')
  assert.deepEqual(selected.map(release => release.releaseId), [10])
  await change(window, select, '')
  assert.deepEqual(selected.at(-1), null)
})

test('the panel is disabled for policy, while busy, and while empty or failed', async t => {
  const { document, root } = installDom(t)
  const harness = catalogHarness(catalogResponse(catalogBody([10, '2014-02-20', 'a'], [50, '2025-10-29', 'd'])))
  t.after(() => harness.owner.dispose())
  await harness.owner.ensureFresh()
  const releases = harness.owner.getSnapshot().releases
  const render = overrides => act(async () => {
    root.render(createElement(WaybackPanel, panelProps([], { releases, ...overrides })))
  })
  await render({ catalog: { state: 'off' } })
  const select = document.querySelector('[data-map-wayback-release]')
  assert.ok(select)
  assert.equal(select.disabled, true)
  assert.match(document.body.textContent, /unavailable in this deployment/)
  assert.equal(document.querySelector('[role="alert"]'), null)
  await render({ busy: true })
  assert.equal(select.disabled, true)
  await render({ catalog: { state: 'loading' }, releases: [] })
  assert.equal(select.disabled, true)
  assert.match(document.querySelector('[role="status"]').textContent, /Reading the ArcGIS Wayback release catalog/)
  await render({ catalog: { state: 'error' }, releases: [] })
  assert.equal(select.disabled, true)
  assert.match(document.querySelector('[role="alert"]').textContent, /temporarily unavailable/)
  await render({ pendingReleaseId: 50, busy: true })
  assert.equal(select.disabled, true)
  assert.equal(select.value, '50')
  assert.match(document.querySelector('[role="status"]').textContent, /Verifying/)
  await render({ failure: 'changed' })
  assert.equal(select.disabled, false)
  assert.match(document.querySelector('[data-map-wayback-failure]').textContent, /changed/)
})
