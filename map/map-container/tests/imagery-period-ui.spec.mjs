import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { JSDOM } from 'jsdom'
import React from 'react'
import { tsImport } from 'tsx/esm/api'

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
const release = {
  releaseId: 10,
  itemId: '903f0abe9c3b452dafe1ca5b8dd858b9',
  title: 'World Imagery (Wayback 2014-02-20)',
  publishedAt: '2014-02-20',
  layerIdentifier: 'WB_2014_R01',
  acquiredAt: null,
}

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

const propsOf = submitted => ({
  wire: wire(),
  sessionId: 'session-1',
  occurrenceKey: 'imagery',
  occurrence: () => null,
  t,
  useResource: () => ({ status: 'live', value: page, failure: undefined }),
  changeSubmit: async input => { submitted.push(input); return { ok: true, revision: input.revision + 1 } },
  panelSubmit: undefined,
  imageUrl: () => '',
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

test('the early dialog selects a fixed release from catalog without local discovery', async tContext => {
  const dom = installDom(tContext)
  const submitted = []
  const requests = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async input => {
    requests.push(String(input))
    return Response.json({
      schemaVersion: 1,
      releases: [{ ...release, descriptor: early }],
      nextCursor: null,
    })
  }
  tContext.after(() => { globalThis.fetch = previousFetch })
  const root = createRoot(dom.container)
  dom.roots.push(root)
  await act(async () => {
    root.render(createElement(ImageryResourcePanel, { ...propsOf(submitted), open: true }))
  })
  await openDialog(dom.container, 'early')
  await act(async () => { await new Promise(resolve => setImmediate(resolve)) })
  assert.ok(requests.every(url => url.includes('operation=catalog')), requests.join('\n'))
  assert.ok(requests.every(url => !url.includes('operation=local') && !url.includes('operation=coverage') && !url.includes('operation=metadata')))
  await selectRelease(dom, '10')
  assert.equal(submitted.at(-1).change.op, 'set-imagery-display')
  assert.equal(submitted.at(-1).change.display.earlyVisible, true)
  assert.equal(submitted.at(-1).change.display.earlySource.release.version, '10')
  assert.equal(submitted.at(-1).change.display.recentOpacity, 0.5)
})

test('early selection, reopening, and clearing preserve deliberate recent imagery choices', async tContext => {
  const dom = installDom(tContext)
  const submitted = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ schemaVersion: 1, releases: [{ ...release, descriptor: early }], nextCursor: null })
  tContext.after(() => { globalThis.fetch = previousFetch })
  const root = createRoot(dom.container)
  dom.roots.push(root)
  const render = async imageryDisplay => {
    const props = propsOf(submitted)
    await act(async () => root.render(createElement(ImageryResourcePanel, {
      ...props, open: true, wire: { ...props.wire, imageryDisplay },
    })))
    await flush()
  }

  await render(display({ recentOpacity: 0.3 }))
  await openDialog(dom.container, 'early')
  await selectRelease(dom, '10')
  assert.equal(submitted.at(-1).change.display.recentOpacity, 0.3)

  await render(display({ recentVisible: false }))
  await selectRelease(dom, '10')
  assert.equal(submitted.at(-1).change.display.recentVisible, false)
  assert.equal(submitted.at(-1).change.display.recentOpacity, 1)

  await render(display({ earlySource: early, earlyVisible: true, recentOpacity: 0.4 }))
  await selectRelease(dom, '')
  assert.deepEqual(submitted.at(-1).change.display, display({ recentOpacity: 0.4 }))
  await closeDialog(dom)

  for (const [recentVisible, recentOpacity, expectedOpacity] of [[true, 1, 0.5], [true, 0.25, 0.25], [false, 1, 1]]) {
    await render(display({ earlySource: early, recentVisible, recentOpacity }))
    await click(rowOf(dom.container, 'early').querySelector('[data-map-panel-eye]'))
    await flush()
    assert.deepEqual(submitted.at(-1).change.display, display({
      earlySource: early, earlyVisible: true, recentVisible, recentOpacity: expectedOpacity,
    }))
  }

  await render(display({ earlySource: early, earlyVisible: true, recentOpacity: 0.7 }))
  await click(rowOf(dom.container, 'early').querySelector('[data-map-panel-eye]'))
  await flush()
  assert.deepEqual(submitted.at(-1).change.display, display({ earlySource: early, recentOpacity: 0.7 }))
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
