import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import React from 'react'
import { tsImport } from 'tsx/esm/api'
import { OLD_RELEASE, catalogBody, catalogHarness, catalogResponse } from './wayback-panel-fixture.mjs'

const { createElement, act } = React
globalThis.React = React
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const uiPrimitivesRequire = createRequire(new URL('../../../packages/client/ui-primitives/package.json', import.meta.url))
let createRootFn
const createRoot = (...args) => (createRootFn ??= uiPrimitivesRequire('react-dom/client').createRoot)(...args)
const importClient = specifier => tsImport(specifier, { parentURL: import.meta.url, tsconfig: new URL('../tsconfig.json', import.meta.url).pathname })
const { ImageryResourcePanel } = await importClient('../src/client/LayerPanel.tsx')
const { createMapSourceCatalog } = await importClient('../src/sources.ts')
const { waybackDescriptor } = await importClient('../src/wayback.ts')
const { en } = await importClient('../src/client/locales.ts')

const t = (key, params) => {
  const template = en[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/gu, (whole, name) => params[name] ?? '')
}

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLButtonElement',
  'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'Document', 'Event', 'MouseEvent', 'FocusEvent', 'InputEvent',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
]

function installDom(tContext) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const saved = new Map()
  const roots = []
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  for (const name of DOM_GLOBALS) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  }
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

const catalog = createMapSourceCatalog(undefined, 'allow', {})
const page = {
  schemaVersion: 1,
  catalogVersion: 'fixture',
  canChange: true,
  context: { provider: null, at: null, zoom: null },
  sources: catalog.list().sources,
  nextCursor: null,
}
const early = waybackDescriptor({
  releaseId: 10,
  itemId: '903f0abe9c3b452dafe1ca5b8dd858b9',
  title: 'World Imagery (Wayback 2014-02-20)',
  publishedAt: '2014-02-20',
  layerIdentifier: 'WB_2014_R01',
  acquiredAt: null,
})
const display = overrides => ({
  labelsVisible: true,
  recentVisible: true,
  recentOpacity: 1,
  earlyVisible: false,
  earlySource: null,
  ...overrides,
})

function wire() {
  return {
    layers: [],
    view: { center: [116.4, 39.9], zoom: 8, wkid: 4326 },
    interaction: { open: false, stopped: null, turnStartSeq: null, startedAt: 0, actions: 0, observations: 0, lastResult: null },
    mode: 'map',
    basemap: null,
    imageryDisplay: display(),
    aoi: null,
    revision: 0,
    operations: [],
    observationRequest: null,
  }
}

const propsOf = (submitted, extra = {}) => ({
  wire: wire(),
  sessionId: 'session-1',
  occurrenceKey: 'imagery',
  occurrence: () => null,
  t,
  useResource: () => ({ status: 'live', value: page, failure: undefined }),
  changeSubmit: async input => { submitted.push(input); return { ok: true, revision: input.revision + 1 } },
  panelSubmit: undefined,
  imageUrl: () => '',
  ...extra,
})

const click = element => act(() => { element.dispatchEvent(new globalThis.MouseEvent('click', { bubbles: true })) })
const flush = async () => { await act(async () => { for (let at = 0; at < 10; at += 1) await Promise.resolve() }) }
const rowOf = (root, kind) => root.querySelector(`[data-map-imagery-row][data-imagery-kind="${kind}"]`)
const openDialog = async (root, kind) => {
  await click(rowOf(root, kind).querySelector('[data-map-panel-actions] button[aria-haspopup="dialog"]'))
  await flush()
}
const closeDialog = async dom => {
  const close = dom.window.document.querySelector(`[role="dialog"] button[aria-label="${t('panel.dialogClose')}"]`)
  await click(close)
  await flush()
}
/** Wait in real time for an owner fetch or response body to settle inside the tree. */
const eventually = async (predicate, message) => {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  }
  assert.ok(predicate(), message)
}
const selectRelease = async (dom, value) => {
  const select = dom.window.document.querySelector('[data-map-wayback-release]')
  assert.ok(select)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set
    setter.call(select, value)
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  await flush()
}

test('imagery rows preserve default visibility and current source selections', async tContext => {
  const dom = installDom(tContext)
  const submitted = []
  const root = createRoot(dom.container)
  dom.roots.push(root)
  await act(async () => {
    root.render(createElement(ImageryResourcePanel, { ...propsOf(submitted), open: true }))
  })
  const eyes = [...dom.container.querySelectorAll('[data-map-imagery-row] [data-map-panel-eye]')]
  assert.deepEqual(eyes.map(eye => eye.getAttribute('aria-pressed')), ['true', 'true', 'false'])
  assert.deepEqual(eyes.map(eye => eye.disabled), [false, false, true], 'the early toggle waits for a chosen release')

  await openDialog(dom.container, 'labels')
  const labelSelect = dom.window.document.querySelector('[data-map-panel-source="labels"]')
  assert.equal(labelSelect.value, 'amap-imagery-labels')
  await closeDialog(dom)

  await openDialog(dom.container, 'recent')
  assert.equal(dom.window.document.querySelector('[data-map-imagery-opacity]').value, '1')
  await closeDialog(dom)

  await click(rowOf(dom.container, 'labels').querySelector('[data-map-panel-eye]'))
  await flush()
  assert.equal(submitted.at(-1).change.op, 'set-imagery-display')
  assert.equal(submitted.at(-1).change.display.labelsVisible, false)
})

/** Open the early dialog and let the warmed catalog reach the selector. */
const openEarly = async container => {
  await openDialog(container, 'early')
  await flush()
  await new Promise(resolve => setImmediate(resolve))
  await flush()
  await flush()
}

/** Admit through the same-origin route; any other same-origin request fails the test. */
function admitRoute(tContext, ...replies) {
  const previousFetch = globalThis.fetch
  const requests = []
  const queue = [...replies]
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://owner.test')
    requests.push({ url, init })

    if (url.pathname !== '/api/map/wayback/admit') throw new Error(`unexpected same-origin request ${url.pathname}`)
    const reply = queue.shift()
    return typeof reply === 'function' ? reply(init) : Response.json(reply ?? early)
  }
  tContext.after(() => { globalThis.fetch = previousFetch })
  return requests
}

test('the early dialog lists the warmed owner catalog and commits the admitted release without local discovery', async tContext => {
  const dom = installDom(tContext)
  const submitted = []
  const requests = admitRoute(tContext)
  const harness = catalogHarness(catalogResponse(catalogBody([10, '2014-02-20', 'a'])))
  tContext.after(() => harness.owner.dispose())
  const root = createRoot(dom.container)
  dom.roots.push(root)
  await act(async () => {
    root.render(createElement(ImageryResourcePanel, { ...propsOf(submitted, { waybackCatalog: harness.owner }), open: true }))
  })
  await openEarly(dom.container)
  await new Promise(resolve => setImmediate(resolve))
  await flush()
  assert.equal(harness.calls.length, 1, 'the catalog is warmed once the panel mounts')
  assert.equal(requests.length, 0, 'opening the dialog admits nothing')
  const select = dom.window.document.querySelector('[data-map-wayback-release]')
  assert.deepEqual([...select.options].map(option => option.value), ['', '10'])
  await selectRelease(dom, '10')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    sessionId: 'session-1',
    release: { releaseId: 10, itemId: OLD_RELEASE.itemId, publishedAt: '2014-02-20', layerIdentifier: 'WB_2014_R01' },
  })
  assert.equal(submitted.at(-1).change.op, 'set-imagery-display')
  assert.equal(submitted.at(-1).change.display.earlyVisible, true)
  assert.deepEqual(submitted.at(-1).change.display.earlySource, early)
  assert.equal(submitted.at(-1).change.display.recentOpacity, 0.5)
})

test('selection stays pending and disabled during verification, then commits with the click-time revision and display', async tContext => {
  const dom = installDom(tContext)
  const submitted = []
  let finishAdmission
  admitRoute(tContext, () => new Promise(resolve => { finishAdmission = resolve }))
  const harness = catalogHarness(catalogResponse(catalogBody([10, '2014-02-20', 'a'], [50, '2025-10-29', 'd'])))
  tContext.after(() => harness.owner.dispose())
  const root = createRoot(dom.container)
  dom.roots.push(root)
  const props = propsOf(submitted, { waybackCatalog: harness.owner })
  await act(async () => { root.render(createElement(ImageryResourcePanel, { ...props, open: true })) })
  await openEarly(dom.container)
  const document = dom.window.document
  const select = document.querySelector('[data-map-wayback-release]')
  await eventually(() => !select.disabled, 'the warmed catalog enables the selector')
  await selectRelease(dom, '10')
  assert.equal(submitted.length, 0, 'nothing is committed before admission')
  assert.equal(select.disabled, true)
  assert.equal(select.value, '10')
  assert.equal(document.querySelector('[data-map-imagery-row][data-imagery-kind="early"] [data-map-panel-eye]').disabled, true)
  // Another actor advances the Session while the verification is pending.
  await act(async () => { root.render(createElement(ImageryResourcePanel, { ...props, open: true, wire: { ...props.wire, revision: 7 } })) })
  await act(async () => { finishAdmission(Response.json(early)) })
  await flush()
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].revision, 0, 'the commit targets the revision read at click time')
  // One atomic blend: the admitted release and the reduced recent opacity travel in one change.
  assert.deepEqual(submitted[0].change.display, display({ earlySource: early, earlyVisible: true, recentOpacity: 0.5 }))
  assert.equal(select.disabled, false)
  assert.equal(document.querySelector('[data-map-wayback-failure]'), null)
})

test('a refused admission reports inline, keeps the selection, and releases the panel', async tContext => {
  const dom = installDom(tContext)
  const submitted = []
  const requests = admitRoute(tContext, () => Response.json({ ok: false, code: 'SOURCE_CHANGED' }, { status: 409 }))
  const harness = catalogHarness(catalogResponse(catalogBody([10, '2014-02-20', 'a'])))
  tContext.after(() => harness.owner.dispose())
  const root = createRoot(dom.container)
  dom.roots.push(root)
  await act(async () => {
    root.render(createElement(ImageryResourcePanel, { ...propsOf(submitted, { waybackCatalog: harness.owner }), open: true }))
  })
  await openEarly(dom.container)
  await eventually(() => !dom.window.document.querySelector('[data-map-wayback-release]')?.disabled, 'the warmed catalog enables the selector')
  await selectRelease(dom, '10')
  await eventually(() => dom.window.document.querySelector('[data-map-wayback-failure]') !== null, 'the refusal is reported inline')
  assert.equal(requests.length, 1)
  assert.equal(submitted.length, 0)
  const failure = dom.window.document.querySelector('[data-map-wayback-failure]')
  assert.ok(failure)
  assert.match(failure.textContent, /changed/)
  assert.equal(dom.window.document.querySelector('[data-map-wayback-release]').value, '')
  // The panel is writable again: hiding labels submits normally.
  await click(rowOf(dom.container, 'labels').querySelector('[data-map-panel-eye]'))
  await flush()
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0].change.display.labelsVisible, false)
})

test('closing the early dialog during verification never submits the late result', async tContext => {
  const dom = installDom(tContext)
  const submitted = []
  let finishAdmission
  admitRoute(tContext, () => new Promise(resolve => { finishAdmission = resolve }))
  const harness = catalogHarness(catalogResponse(catalogBody([10, '2014-02-20', 'a'])))
  tContext.after(() => harness.owner.dispose())
  const root = createRoot(dom.container)
  dom.roots.push(root)
  await act(async () => {
    root.render(createElement(ImageryResourcePanel, { ...propsOf(submitted, { waybackCatalog: harness.owner }), open: true }))
  })
  await openEarly(dom.container)
  await eventually(() => !dom.window.document.querySelector('[data-map-wayback-release]')?.disabled, 'the warmed catalog enables the selector')
  await selectRelease(dom, '10')
  await eventually(() => typeof finishAdmission === 'function', 'the choice reaches the admission route')
  await closeDialog(dom)
  await act(async () => { finishAdmission(Response.json(early)) })
  await flush()
  // The early eye still waits for a release; another row proves the panel is writable again.
  await eventually(() => dom.window.document.querySelector('[data-map-imagery-row][data-imagery-kind="labels"] [data-map-panel-eye]').disabled === false, 'closing releases the panel')
  assert.equal(submitted.length, 0)
  assert.equal(dom.window.document.querySelector('[data-map-wayback-release]'), null, 'the dialog stays closed')
})

test('the early selector stays disabled when the deployment policy withholds Wayback', async tContext => {
  const dom = installDom(tContext)
  const submitted = []
  const requests = admitRoute(tContext)
  const harness = catalogHarness(catalogResponse(catalogBody([10, '2014-02-20', 'a'])))
  tContext.after(() => harness.owner.dispose())
  const root = createRoot(dom.container)
  dom.roots.push(root)
  const sources = page.sources.map(source => source.id === 'esri-wayback'
    ? { ...source, availability: { kind: 'unavailable', reason: 'disabled' } }
    : source)
  await act(async () => {
    root.render(createElement(ImageryResourcePanel, {
      ...propsOf(submitted, { waybackCatalog: harness.owner, useResource: () => ({ status: 'live', value: { ...page, sources }, failure: undefined }) }),
      open: true,
    }))
  })
  await openEarly(dom.container)
  assert.equal(dom.window.document.querySelector('[data-map-wayback-release]')?.disabled, true)
  assert.equal(harness.calls.length, 0, 'a withheld policy never warms the catalog')
  await selectRelease(dom, '10')
  assert.equal(requests.length, 0)
})

test('the recent dialog controls opacity while the eye controls visibility', async tContext => {
  const dom = installDom(tContext)
  const submitted = []
  const root = createRoot(dom.container)
  dom.roots.push(root)
  await act(async () => root.render(createElement(ImageryResourcePanel, { ...propsOf(submitted), open: true })))
  await openDialog(dom.container, 'recent')
  const opacity = dom.window.document.querySelector('[data-map-imagery-opacity]')
  assert.equal(opacity.disabled, false)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(opacity, '0.45')
    opacity.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    opacity.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
  assert.equal(submitted.length, 1, `opacity=${opacity.outerHTML}`)
  assert.equal(submitted.at(-1).change.display.recentOpacity, 0.45)
  await closeDialog(dom)
  await click(rowOf(dom.container, 'recent').querySelector('[data-map-panel-eye]'))
  await flush()
  assert.equal(submitted.at(-1).change.display.recentVisible, false)
})
