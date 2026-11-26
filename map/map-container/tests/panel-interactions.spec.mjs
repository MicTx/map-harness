import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
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

// React reads `document` once at import time to choose its input-event strategy. react-dom is
// loaded through the imports below, before installDom creates any per-test document; without a
// document present it freezes the IE9 propertychange polyfill and every later focusin on a text
// input calls the missing attachEvent. A baseline document keeps the normal input-event path.
const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLAnchorElement',
  'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'Document', 'Range', 'Selection',
  'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'UIEvent',
  'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
]
const baselineDom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: false })
for (const name of DOM_GLOBALS) {
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: name === 'window' ? baselineDom.window : baselineDom.window[name] })
}
const { LayerPanel } = await importClient('../src/client/LayerPanel.tsx')
const { SYMBOL_PRESETS, symbolVersionOf } = await importClient('../../layers/src/index.ts')
const { createMapSourceCatalog } = await importClient('../src/sources.ts')
const { Workbench } = await importClient('../src/client/Workbench.tsx')
const { FeatureCard } = await importClient('../src/client/FeatureCard.tsx')
const { en } = await importClient('../src/client/locales.ts')

// The MapTabBody spec mounts the real component; its lazy occurrence import
// resolves the ArcGIS SDK through the same constructor doubles occurrence.spec uses.
const doublesUrl = new URL('./arcgis-doubles.mjs', import.meta.url).href
const arcgisDoubleExports = {
  '@arcgis/core/Map.js': 'FakeMap',
  '@arcgis/core/views/MapView.js': 'FakeMapView',
  '@arcgis/core/views/SceneView.js': 'FakeSceneView',
  '@arcgis/core/layers/WebTileLayer.js': 'FakeTileLayer',
  '@arcgis/core/layers/BaseTileLayer.js': 'FakeTileLayer',
  '@arcgis/core/layers/MapImageLayer.js': 'FakeMapImageLayer',
  '@arcgis/core/layers/TileLayer.js': 'FakeArcgisTileLayer',
  '@arcgis/core/layers/WMTSLayer.js': 'FakeWmtsLayer',
  '@arcgis/core/config.js': 'default',
  '@arcgis/core/layers/FeatureLayer.js': 'FakeFeatureLayer',
  '@arcgis/core/layers/GraphicsLayer.js': 'FakeGraphicsLayer',
  '@arcgis/core/widgets/Sketch/SketchViewModel.js': 'FakeSketchViewModel',
  '@arcgis/core/Graphic.js': 'FakeGraphic',
  '@arcgis/core/geometry/Point.js': 'FakePoint',
  '@arcgis/core/geometry/Polyline.js': 'FakePolyline',
  '@arcgis/core/geometry/Polygon.js': 'FakePolygon',
  '@arcgis/core/geometry/Extent.js': 'FakeExtent',
  '@arcgis/core/geometry/SpatialReference.js': 'FakeSpatialReference',
  '@arcgis/core/symbols/SimpleMarkerSymbol.js': 'FakeSimpleMarkerSymbol',
  '@arcgis/core/symbols/SimpleLineSymbol.js': 'FakeSimpleLineSymbol',
  '@arcgis/core/symbols/SimpleFillSymbol.js': 'FakeSimpleFillSymbol',
  '@arcgis/core/symbols/TextSymbol.js': 'FakeTextSymbol',
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@arcgis/core/core/reactiveUtils.js') return { url: doublesUrl, shortCircuit: true }
    if (specifier === '@arcgis/core/geometry/projectionUtils.js') return { url: doublesUrl, shortCircuit: true }
    if (specifier.startsWith('@arcgis/core/')) {
      const name = arcgisDoubleExports[specifier]
      if (name === undefined) throw new Error(`no ArcGIS double for ${specifier}`)
      const source = `export { ${name} as default } from ${JSON.stringify(doublesUrl)}`
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
const { MapTabBody } = await importClient('../src/client/MapTabBody.tsx')

const t = (key, params) => {
  const template = en[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/gu, (whole, name) => params[name] ?? '')
}

function installDom(tContext) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const saved = new Map()
  const roots = []
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const expose = (name, value) => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  }
  for (const name of DOM_GLOBALS) expose(name, dom.window[name])
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

const setInputValue = async (input, value) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(input.ownerDocument.defaultView.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new input.ownerDocument.defaultView.Event('input', { bubbles: true }))
  })
}

const pointFeature = (id, properties = {}) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [116.4, 39.9] },
  properties,
})

const layerOf = (id, overrides = {}) => ({
  id,
  name: `Layer ${id}`,
  data: { type: 'FeatureCollection', features: [pointFeature(`${id}-feature`)] },
  sourceCrs: 'EPSG:4326',
  opacity: 1,
  visible: true,
  ...overrides,
})

const wireOf = (layers, revision = 7) => ({
  layers,
  view: { center: [116.4, 39.9], zoom: 8, wkid: 4326 },
  mode: 'map',
  aoi: null,
  imageryDisplay: { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null },
  revision,
  operations: [],
  observationRequest: null,
})

const panelProps = (wire, extras = {}) => ({
  wire,
  sessionId: 'session-1',
  occurrenceKey: 'occ-1',
  occurrence: () => null,
  t,
  useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
  changeSubmit: undefined,
  panelSubmit: undefined,
  ...extras,
})

function mountPanel(dom, props, component = LayerPanel) {
  const root = createRoot(dom.container)
  act(() => { root.render(createElement(component, props)) })
  dom.roots.push(root)
  return { container: dom.container, root }
}

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

const flush = async () => { await act(async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }) }
const click = async node => { await act(async () => { node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true })) }) }
const keyDown = async (node, init, props = {}) => {
  await act(async () => {
    const event = new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    for (const [name, value] of Object.entries(props)) Object.defineProperty(event, name, { value })
    node.dispatchEvent(event)
  })
}
const setSelectValue = async (select, value) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(select.constructor.prototype, 'value').set
    setter.call(select, value)
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
}
const byText = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text)
const statusOf = dom => dom.window.document.querySelector('[role="alert"]')?.textContent ?? null
const confirmClear = async container => {
  await click(container.querySelector('[data-map-panel-bulk-menu] button[aria-haspopup="menu"]'))
  const item = [...container.ownerDocument.querySelectorAll('[role="menuitem"]')]
    .find(node => node.textContent?.startsWith(t('panel.clearAll.withCount', { count: '' }).replace('（）', '').replace('()', '')) || node.textContent?.includes('Clear layers'))
  assert.ok(item, 'the clear action lives in the bulk menu')
  await click(item)
  await click(byText(container, t('panel.clearAll.confirm.button')))
}

test('standalone surfaces collapse to a resident title bar and expand again', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountPanel(dom, panelProps(wireOf([layerOf('one')]), { surface: 'annotation' }))
  const card = () => container.querySelector('[data-map-panel][aria-labelledby$=":annotation:panel:title"]')
  assert.equal(card() !== null, true)
  await click(container.querySelector('[data-map-panel-collapse]'))
  assert.equal(card() !== null, true, 'the card stays resident after collapsing')
  assert.equal(card().hasAttribute('data-map-panel-collapsed'), true)
  assert.equal(card().querySelector('h2').textContent, 'User annotations')
  assert.equal(container.querySelector('[data-map-panel-toggle]'), null, 'no launcher button appears')
  await click(container.querySelector('[data-map-panel-collapse]'))
  assert.equal(card().hasAttribute('data-map-panel-collapsed'), false)
})

test('the layer-management surface is expanded by default', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountPanel(dom, panelProps(wireOf([layerOf('one')]), { surface: 'ai' }))
  assert.equal(container.querySelector('[data-map-panel][aria-labelledby$=":ai:panel:title"]') !== null, true)
})

test('wide first paint opens one unified card instead of three toggles', async tContext => {
  const dom = installDom(tContext)
  // jsdom has no layout observer: pin the container to a wide 1200px box.
  const savedResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback }
    observe() { this.callback([{ contentRect: { width: 1200, height: 800 } }], this) }
    disconnect() {}
  }
  globalThis.HTMLDivElement = dom.window.HTMLDivElement
  tContext.after(() => {
    if (savedResizeObserver === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = savedResizeObserver
  })
  const props = {
    sessionId: 'map-tab-wide',
    useTabInfo: () => ({ tab: { id: 'tab-wide' } }),
    useProjection: () => wireOf([layerOf('one')]),
    useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
    t,
  }
  const root = createRoot(dom.container)
  act(() => { root.render(createElement(MapTabBody, props)) })
  dom.roots.push(root)
  await flush()
  const toggles = () => [...dom.container.querySelectorAll('[data-map-panel-toggle]')]
  const panels = () => [...dom.container.querySelectorAll('[data-map-panel]')]
  assert.equal(toggles().length, 0, 'wide first paint has no per-surface toggle')
  assert.equal(panels().length, 1, 'wide first paint shows the single unified card')
  assert.equal(panels()[0].getAttribute('data-map-panel-surface'), 'unified')
  assert.ok(dom.container.querySelector('[data-map-panel-tabs]'))
  assert.deepEqual(
    [...dom.container.querySelectorAll('[data-map-panel-tab]')].map(tab => tab.getAttribute('data-map-panel-tab')),
    ['imagery', 'ai', 'annotation'],
  )
  assert.equal(dom.container.querySelector('[data-map-rail-panels]'), null, 'no rail wrapper remains')
  await click(panels()[0].querySelector('[data-map-panel-collapse]'))
  assert.equal(panels().length, 1, 'collapsing keeps the resident card mounted')
  assert.equal(panels()[0].hasAttribute('data-map-panel-collapsed'), true)
  assert.equal(panels()[0].querySelector('h2').textContent, t('panel.all.title'))
  assert.equal(toggles().length, 0)
  await click(panels()[0].querySelector('[data-map-panel-collapse]'))
  assert.equal(panels().length, 1)
  assert.equal(panels()[0].hasAttribute('data-map-panel-collapsed'), false)
  assert.equal(panels()[0].getAttribute('data-map-panel-surface'), 'unified')
})

test('narrow first paint keeps one launcher and opens the same unified card', async tContext => {
  const dom = installDom(tContext)
  const savedResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback }
    observe() { this.callback([{ contentRect: { width: 390, height: 800 } }], this) }
    disconnect() {}
  }
  globalThis.HTMLDivElement = dom.window.HTMLDivElement
  tContext.after(() => {
    if (savedResizeObserver === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = savedResizeObserver
  })
  const props = {
    sessionId: 'map-tab-narrow',
    useTabInfo: () => ({ tab: { id: 'tab-narrow' } }),
    useProjection: () => wireOf([layerOf('one')]),
    useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
    t,
  }
  const root = createRoot(dom.container)
  act(() => { root.render(createElement(MapTabBody, props)) })
  dom.roots.push(root)
  await flush()
  const toggles = () => [...dom.container.querySelectorAll('[data-map-panel-toggle]')]
  const panels = () => [...dom.container.querySelectorAll('[data-map-panel]')]
  assert.equal(panels().length, 1, 'narrow first paint keeps the resident card mounted')
  assert.equal(panels()[0].hasAttribute('data-map-panel-collapsed'), true, 'narrow first paint collapses to the title bar')
  assert.equal(toggles().length, 0, 'no launcher button exists')
  await click(panels()[0].querySelector('[data-map-panel-collapse]'))
  assert.equal(panels().length, 1)
  assert.equal(panels()[0].hasAttribute('data-map-panel-collapsed'), false)
  assert.equal(panels()[0].getAttribute('data-map-panel-surface'), 'unified')
  assert.ok(dom.container.querySelector('[data-map-panel-tabs]'))
})

test('wide resize keeps the open panel open across any width', async tContext => {
  const dom = installDom(tContext)
  let resizeCallback
  const savedResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback) { resizeCallback = callback }
    observe() { resizeCallback([{ contentRect: { width: 1200, height: 800 } }], this) }
    disconnect() {}
  }
  globalThis.HTMLDivElement = dom.window.HTMLDivElement
  tContext.after(() => {
    if (savedResizeObserver === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = savedResizeObserver
  })
  const props = {
    sessionId: 'map-tab-resize',
    useTabInfo: () => ({ tab: { id: 'tab-resize' } }),
    useProjection: () => wireOf([layerOf('one')]),
    useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
    t,
  }
  const root = createRoot(dom.container)
  act(() => { root.render(createElement(MapTabBody, props)) })
  dom.roots.push(root)
  await flush()
  const panels = () => [...dom.container.querySelectorAll('[data-map-panel]')]
  assert.equal(panels().length, 1, 'the wide card starts open')
  assert.equal(panels()[0].getAttribute('data-map-panel-surface'), 'unified')
  // Collapsing and expanding marks the choice as user-owned before resizing.
  await click(panels()[0].querySelector('[data-map-panel-collapse]'))
  assert.equal(panels()[0].hasAttribute('data-map-panel-collapsed'), true)
  await click(panels()[0].querySelector('[data-map-panel-collapse]'))
  assert.equal(panels().length, 1)
  await act(async () => { resizeCallback([{ contentRect: { width: 1200, height: 800 } }]) })
  assert.equal(panels().length, 1, 'a wide→wide resize keeps the open panel')
  assert.equal(panels()[0].getAttribute('data-map-panel-surface'), 'unified')
  await act(async () => { resizeCallback([{ contentRect: { width: 390, height: 800 } }]) })
  assert.equal(panels().length, 1, 'a wide→narrow resize keeps the user-opened panel')
  assert.equal(panels()[0].getAttribute('data-map-panel-surface'), 'unified')
  await act(async () => { resizeCallback([{ contentRect: { width: 1200, height: 800 } }]) })
  assert.equal(panels().length, 1, 'a narrow→wide resize keeps the open panel')
  assert.equal(panels()[0].getAttribute('data-map-panel-surface'), 'unified')
})

test('the imagery rows submit basemap and display changes without local Wayback discovery', async tContext => {
  const dom = installDom(tContext)
  const catalog = createMapSourceCatalog(undefined, 'allow', {})
  const imagery = catalog.selection('esri-world-imagery', 'amap-imagery-labels').value
  const noLabels = catalog.selection('esri-world-imagery').value
  const submitted = []
  const wire = {
    ...wireOf([]),
    basemap: imagery,
    imageryDisplay: { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null },
  }
  const page = {
    schemaVersion: 1,
    catalogVersion: 'fixture',
    canChange: true,
    context: { provider: null, at: null, zoom: null },
    sources: [...catalog.list().sources],
    nextCursor: null,
  }
  const { container } = mountPanel(dom, panelProps(wire, {
    changeSubmit: async input => {
      submitted.push(input)
      return { ok: true, revision: input.revision + 1 }
    },
    useResource: address => {
      assert.equal(address, 'dsh-resource://map-source/session-1')
      return { status: 'live', value: page, failure: undefined }
    },
  }))
  const labelsRow = container.querySelector('[data-map-imagery-row][data-imagery-kind="labels"]')
  await click(labelsRow.querySelector('button[aria-haspopup="dialog"]'))
  await flush()
  const labelsSelect = dom.window.document.querySelector('select[data-map-panel-source="labels"]')
  assert.equal(labelsSelect.value, 'amap-imagery-labels')

  await setSelectValue(labelsSelect, '')
  await flush()
  assert.deepEqual(submitted.at(-1).change, { op: 'set-basemap', selection: noLabels })
  assert.equal(submitted.at(-1).summary, 'The user changed the basemap to "Esri World Imagery" in the layer panel')

  await click(dom.window.document.querySelector(`[role="dialog"] button[aria-label="${t('panel.dialogClose')}"]`))
  await flush()
  const recentRow = container.querySelector('[data-map-imagery-row][data-imagery-kind="recent"]')
  await click(recentRow.querySelector('button[aria-haspopup="dialog"]'))
  await flush()
  const baseSelect = dom.window.document.querySelector('select[data-map-panel-source="base"]')
  assert.equal(baseSelect.value, 'esri-world-imagery')
  assert.equal([...baseSelect.options].some(option => option.value === 'esri-wayback'), false)
  await setInputValue(dom.window.document.querySelector('[data-map-imagery-opacity]'), '0.4')
  await flush()
  assert.equal(submitted.at(-1).change.op, 'set-imagery-display')
  assert.equal(submitted.at(-1).change.display.recentOpacity, 0.4)
})

test('a controlled panel follows its open prop as a resident collapsible card', async tContext => {
  const dom = installDom(tContext)
  let open = false
  const onOpenChange = value => { open = value }
  const props = () => panelProps(wireOf([]), { open, onOpenChange })
  const { container, root } = mountPanel(dom, props())
  const card = () => container.querySelector('[data-map-panel]')
  assert.ok(card(), 'the controlled card is always resident')
  assert.equal(card().hasAttribute('data-map-panel-collapsed'), true)
  assert.equal(card().querySelector('h2').textContent, t('panel.title'))
  assert.equal(container.querySelector('[data-map-panel-toggle]'), null)
  await click(card().querySelector('[data-map-panel-collapse]'))
  act(() => { root.render(createElement(LayerPanel, props())) })
  assert.equal(open, true)
  assert.equal(card().hasAttribute('data-map-panel-collapsed'), false)
  await click(card().querySelector('[data-map-panel-collapse]'))
  act(() => { root.render(createElement(LayerPanel, props())) })
  assert.equal(open, false)
  assert.equal(card().hasAttribute('data-map-panel-collapsed'), true)
})

test('the clear sweep submits each removal against the acknowledged revision', async tContext => {
  const dom = installDom(tContext)
  const calls = []
  const first = deferred()
  const changeSubmit = input => {
    calls.push(input)
    return calls.length === 1 ? first.promise : Promise.resolve({ ok: true, revision: 7 + calls.length })
  }
  const props = panelProps(wireOf([layerOf('a'), layerOf('b'), layerOf('c')], 7), { changeSubmit })
  const { container } = mountPanel(dom, props)
  await confirmClear(container)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].revision, 7)
  assert.equal(byText(container, t('panel.showAll')).disabled, true, 'pending locks other mutations')
  first.resolve({ ok: true, revision: 8 })
  await flush()
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map(call => call.revision), [7, 8, 9])
  assert.equal(statusOf(dom), t('panel.summary.clearAll', { count: '3' }))
})

test('a pending mutation locks repeated clear and visibility actions; a refusal stops the sweep', async tContext => {
  const dom = installDom(tContext)
  const calls = []
  const gate = deferred()
  const changeSubmit = input => {
    calls.push(input)
    return calls.length === 1 ? gate.promise : Promise.resolve({ ok: false, code: 'stale-revision' })
  }
  const { container } = mountPanel(dom, panelProps(wireOf([layerOf('a'), layerOf('b'), layerOf('c')], 7), { changeSubmit }))
  await confirmClear(container)
  assert.equal(calls.length, 1)
  await click(container.querySelector('[data-map-panel-eye]'))
  await click(container.querySelector('[data-map-panel-bulk-menu] button[aria-haspopup="menu"]'))
  const clearItem = [...dom.window.document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.includes('Clear layers'))
  assert.ok(clearItem)
  assert.equal(clearItem.disabled, true, 'the clear action is locked while a mutation is in flight')
  assert.equal(calls.length, 1, 'a second mutation never starts while one is in flight')
  gate.resolve({ ok: true, revision: 8 })
  await flush()
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.revision), [7, 8])
  assert.equal(statusOf(dom), t('panel.clearAll.partial', { count: '1', reason: t('panel.change.stale') }))
})

test('a rejected change reports failure and releases the pending lock', async tContext => {
  const dom = installDom(tContext)
  const calls = []
  const changeSubmit = input => { calls.push(input); return Promise.reject(new Error('offline')) }
  const { container } = mountPanel(dom, panelProps(wireOf([layerOf('a')], 7), { changeSubmit }))
  await confirmClear(container)
  await flush()
  assert.equal(statusOf(dom), t('panel.clearAll.partial', { count: '0', reason: t('panel.change.network') }))
  assert.equal(byText(container, t('panel.hideAll')).disabled, false, 'busy releases after rejection')
  await click(byText(container, t('panel.hideAll')))
  await flush()
  assert.equal(calls.length, 2, 'a later action submits again once the lock releases')
})

test('an export request stays pending until the queue acknowledges it', async tContext => {
  const dom = installDom(tContext)
  const submissions = []
  const gate = deferred()
  const secondRef = { promise: null }
  const panelSubmit = (sessionId, text, mode) => { submissions.push({ sessionId, text, mode }); return submissions.length === 1 ? gate.promise : secondRef.promise }
  const { container } = mountPanel(dom, panelProps(wireOf([layerOf('a')], 7), { changeSubmit: undefined, panelSubmit }))
  const more = container.querySelector(`[aria-label="${t('panel.more', { name: 'Layer a' })}"]`)
  await click(more)
  await click(byText(dom.window.document, 'GeoJSON'))
  await flush()
  assert.equal(submissions.length, 1)
  assert.equal(statusOf(dom), null, 'no success notice before the queue answers')
  assert.equal(byText(dom.window.document, 'GeoJSON').disabled, true, 'export buttons stay disabled while pending')
  await click(byText(dom.window.document, 'GeoJSON'))
  assert.equal(submissions.length, 1, 'a duplicate export never submits while pending')
  gate.resolve(true)
  await flush()
  assert.equal(statusOf(dom), t('panel.request.exported'))
  const second = deferred()
  secondRef.promise = second.promise
  await click(byText(dom.window.document, 'GeoJSON'))
  assert.equal(statusOf(dom), null, 'a new pending export clears the earlier success notice')
  assert.equal(container.querySelector('[data-map-panel]').getAttribute('aria-busy'), 'true')
  second.resolve(true)
  await flush()
  assert.equal(statusOf(dom), t('panel.request.exported'))
  assert.equal(container.querySelector('[data-map-panel]').getAttribute('aria-busy'), 'false')
})

test('a refused or rejected export reports failure, never success', async tContext => {
  const dom = installDom(tContext)
  const submissions = []
  const panelSubmit = (sessionId, text, mode) => {
    submissions.push(text)
    return submissions.length === 1 ? Promise.resolve(false) : Promise.reject(new Error('offline'))
  }
  const { container } = mountPanel(dom, panelProps(wireOf([layerOf('a')], 7), { panelSubmit }))
  const moreLabel = t('panel.more', { name: 'Layer a' })
  await click(container.querySelector(`[aria-label="${moreLabel}"]`))
  await click(byText(dom.window.document, 'CSV'))
  await flush()
  assert.equal(statusOf(dom), t('panel.request.failed'))
  await click(byText(dom.window.document, 'CSV'))
  await flush()
  assert.equal(submissions.length, 2)
  assert.equal(statusOf(dom), t('panel.request.failed'))
})

test('a nonempty search survives the layer count shrinking below the threshold', async tContext => {
  const dom = installDom(tContext)
  const five = ['a', 'b', 'c', 'd', 'e'].map(id => layerOf(id))
  const { container, root } = mountPanel(dom, panelProps(wireOf(five, 7)))
  const search = container.querySelector('[data-map-panel-search]')
  assert.ok(search)
  await setInputValue(search, 'no-such-layer')
  assert.equal(container.querySelectorAll('[data-map-panel-layer]').length, 0)
  const four = ['a', 'b', 'c', 'd'].map(id => layerOf(id))
  act(() => { root.render(createElement(LayerPanel, panelProps(wireOf(four, 8)))) })
  assert.ok(container.querySelector('[data-map-panel-search]'), 'the open search stays mounted')
  await setInputValue(container.querySelector('[data-map-panel-search]'), '')
  assert.equal(container.querySelectorAll('[data-map-panel-layer]').length, 4)
})

test('the swatch opens a color editor that submits a complete validated symbol', async tContext => {
  const dom = installDom(tContext)
  const calls = []
  const changeSubmit = input => {
    calls.push(input)
    return Promise.resolve({ ok: true, revision: 8 })
  }
  const { container } = mountPanel(dom, panelProps(wireOf([layerOf('a', { symbol: SYMBOL_PRESETS[0].symbol })], 7), { changeSubmit }))
  await click(container.querySelector('[data-map-panel-swatch]'))
  const hex = dom.window.document.querySelector(`input[aria-label="${t('panel.colorHex', { name: 'Layer a' })}"]`)
  assert.ok(hex, dom.window.document.body.innerHTML)
  await setInputValue(hex, '#123abc')
  await click(byText(dom.window.document, t('panel.colorApply')))
  await flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].change.op, 'set-symbol-style')
  assert.equal(calls[0].change.symbol.point.color, '#123abc')
  assert.match(calls[0].change.symbol.symbolVersion, /^sym-/u)
})

test('color editing starts from the rendered geometry and preserves symbol details', async tContext => {
  const dom = installDom(tContext)
  const calls = []
  const draft = {
    methodVersion: 'map-layers@1',
    presentation: 'single',
    semantic: 'route',
    point: { shape: 'diamond', color: '#aa0000', sizePx: 11, opacity: 0.6, outlineColor: '#111111', outlineWidthPx: 2 },
    line: { color: '#00aa00', widthPx: 4, pattern: 'dash' },
    fill: { color: '#0000aa', opacity: 0.4, outlineColor: '#aa00aa', outlineWidthPx: 3 },
  }
  const symbol = { ...draft, symbolVersion: symbolVersionOf(draft) }
  const line = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'route-1', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: {} }] }
  const { container } = mountPanel(dom, panelProps(wireOf([layerOf('route', { data: line, symbol })]), {
    changeSubmit: input => { calls.push(input); return Promise.resolve({ ok: true, revision: 8 }) },
  }))
  await click(container.querySelector('[data-map-panel-swatch]'))
  const hex = dom.window.document.querySelector(`input[aria-label="${t('panel.colorHex', { name: 'Layer route' })}"]`)
  assert.equal(hex.value, '#00aa00', 'line layers initialize from the rendered line block, not the point block')
  await setInputValue(hex, '#123abc')
  await click(byText(dom.window.document, t('panel.colorApply')))
  await flush()
  const applied = calls[0].change.symbol
  assert.equal(applied.line.color, '#123abc')
  assert.equal(applied.point.color, '#123abc')
  assert.equal(applied.fill.color, '#123abc')
  assert.deepEqual(applied.point, { ...draft.point, color: '#123abc' })
  assert.deepEqual(applied.line, { ...draft.line, color: '#123abc' })
  assert.deepEqual(applied.fill, { ...draft.fill, color: '#123abc' })
})

test('polygon color editing starts from the rendered fill and preserves fill details', async tContext => {
  const dom = installDom(tContext)
  const calls = []
  const draft = {
    methodVersion: 'map-layers@1',
    presentation: 'single',
    semantic: 'aoi',
    point: { shape: 'diamond', color: '#aa0000', sizePx: 11, opacity: 0.6, outlineColor: '#111111', outlineWidthPx: 2 },
    line: { color: '#00aa00', widthPx: 4, pattern: 'dash' },
    fill: { color: '#0000aa', opacity: 0.4, outlineColor: '#aa00aa', outlineWidthPx: 3 },
  }
  const symbol = { ...draft, symbolVersion: symbolVersionOf(draft) }
  const polygon = { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'area-1', geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, properties: {} }] }
  const { container } = mountPanel(dom, panelProps(wireOf([layerOf('area', { data: polygon, symbol })]), {
    changeSubmit: input => { calls.push(input); return Promise.resolve({ ok: true, revision: 8 }) },
  }))
  await click(container.querySelector('[data-map-panel-swatch]'))
  const hex = dom.window.document.querySelector(`input[aria-label="${t('panel.colorHex', { name: 'Layer area' })}"]`)
  assert.equal(hex.value, '#0000aa', 'polygon layers initialize from the rendered fill block')
  await setInputValue(hex, '#123abc')
  await click(byText(dom.window.document, t('panel.colorApply')))
  await flush()
  const applied = calls[0].change.symbol
  assert.equal(applied.fill.color, '#123abc')
  assert.deepEqual(applied.point, { ...draft.point, color: '#123abc' })
  assert.deepEqual(applied.line, { ...draft.line, color: '#123abc' })
  assert.deepEqual(applied.fill, { ...draft.fill, color: '#123abc' })
})

test('the full legend includes every class and effective feature override in the operation dialog', async tContext => {
  const dom = installDom(tContext)
  const layer = layerOf('a', {
    style: scoreStyle(), opacity: 0.5,
    symbol: { methodVersion: 'map-layers@1', presentation: 'single', symbolVersion: 's', point: { shape: 'circle', color: '#ff0000', sizePx: 8, opacity: 0.8 } },
    overrides: { overridesVersion: 'v1', entries: [{ featureIds: ['f-1'], patch: { color: '#00ff00', opacity: 0.25 } }] },
    data: { type: 'FeatureCollection', features: [pointFeature('f-1', { score: 15 }), pointFeature('f-2', { score: 5 })] },
  })
  const { container } = mountPanel(dom, panelProps(wireOf([layer], 7)))
  const swatch = container.querySelector('[data-map-panel-swatch] [data-map-panel-badge]')
  assert.ok(swatch.children.length > 1, 'mixed effective colors remain visible as segments')
  await click(container.querySelector(`[aria-label="${t('panel.more', { name: 'Layer a' })}"]`))
  const legend = dom.window.document.querySelector('[data-map-panel-legend]')
  assert.ok(legend.textContent.includes(t('workbench.legend.missing')))
  assert.ok(legend.textContent.includes(t('panel.legend.underflow')))
  assert.ok(legend.textContent.includes(t('panel.legend.overflow')))
  assert.ok(legend.textContent.includes('f-1'))
  assert.ok(legend.textContent.includes('rgba(0, 255, 0, 0.125)'))
})

test('imagery layers expose their type in the operation trigger', tContext => {
  const dom = installDom(tContext)
  const imagery = layerOf('imagery', { data: undefined, imagery: { methodVersion: 'map-layers@1', urlTemplate: 'https://example.invalid/{level}/{row}/{col}' } })
  const { container } = mountPanel(dom, panelProps(wireOf([imagery])))
  const type = container.querySelector('[data-map-panel-swatch] [data-map-panel-type]')
  assert.equal(type.textContent, t('panel.badge.imagery'))
  assert.equal(type.hasAttribute('aria-hidden'), false)
})

test('More opens one accessible operation dialog and Escape restores its trigger', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountPanel(dom, panelProps(wireOf([layerOf('a')], 7), { changeSubmit: () => Promise.resolve({ ok: true, revision: 8 }) }))
  const moreLabel = t('panel.more', { name: 'Layer a' })
  const more = container.querySelector(`[aria-label="${moreLabel}"]`)
  await click(more)
  const disclosure = dom.window.document.querySelector('[data-map-panel-menu]')
  const dialog = dom.window.document.querySelector('[role="dialog"][aria-modal="true"]')
  assert.ok(disclosure)
  assert.ok(dialog)
  assert.equal(disclosure.getAttribute('role'), 'group')
  assert.equal(disclosure.querySelectorAll('[role="menuitem"]').length, 0)
  assert.equal(more.getAttribute('aria-expanded'), 'true')
  const range = disclosure.querySelector('input[type="range"]')
  assert.equal(range.tabIndex, 0, 'the opacity input is tab-reachable')
  range.focus()
  await keyDown(range, { key: 'Escape', isComposing: true })
  assert.notEqual(dom.window.document.querySelector('[data-map-panel-menu]'), null, 'an IME-composition Escape does not close the dialog')
  await keyDown(range, { key: 'Escape' }, { keyCode: 229 })
  assert.notEqual(dom.window.document.querySelector('[data-map-panel-menu]'), null, 'keyCode 229 does not close the dialog')
  await keyDown(range, { key: 'Escape' })
  assert.equal(dom.window.document.querySelector('[data-map-panel-menu]'), null, 'Escape closes the dialog')
  assert.equal(dom.window.document.activeElement, more, 'focus returns to the More button')
})

test('stored layer groups do not render grouping labels or controls', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountPanel(dom, panelProps(wireOf([layerOf('a', { group: '基准' }), layerOf('b', { group: '基准' })], 7)))
  assert.equal(container.querySelectorAll('[data-map-panel-layer]').length, 2)
  assert.equal(container.querySelector('[data-map-panel-group]'), null)
  assert.equal(container.textContent.includes('基准'), false)
  await click(container.querySelector(`[aria-label="${t('panel.more', { name: 'Layer a' })}"]`))
  assert.equal(dom.window.document.querySelector('[data-map-panel-menu]').textContent.includes(t('panel.group')), false)
})

test('the attribute table clamps its page when the feature set shrinks', async tContext => {
  const dom = installDom(tContext)
  const twenty = Array.from({ length: 20 }, (_, index) => pointFeature(`f${index}`, { name: `row-${index}` }))
  const wire = wireOf([layerOf('a', { data: { type: 'FeatureCollection', features: twenty } })], 7)
  const { container, root } = mountPanel(dom, panelProps(wire))
  await click(container.querySelector(`[aria-label="${t('panel.more', { name: 'Layer a' })}"]`))
  await click(byText(dom.window.document, t('panel.attributes')))
  assert.ok(container.querySelector('[data-map-panel-attributes]'))
  const next = () => container.querySelector(`[aria-label="${t('panel.attributeNextPage')}"]`)
  const prev = () => container.querySelector(`[aria-label="${t('panel.attributePrevPage')}"]`)
  const pager = () => container.querySelector('[data-map-panel-pager]')?.textContent ?? ''
  assert.ok(pager().includes(t('panel.attributePage', { page: '1', pages: '3' })))
  await click(next())
  await click(next())
  assert.ok(pager().includes(t('panel.attributePage', { page: '3', pages: '3' })))
  const shrunk = wireOf([layerOf('a', { data: { type: 'FeatureCollection', features: [pointFeature('solo', { name: 'only' })] } })], 8)
  act(() => { root.render(createElement(LayerPanel, panelProps(shrunk))) })
  assert.ok(pager().includes(t('panel.attributePage', { page: '1', pages: '1' })), 'the page clamps to the data')
  assert.ok(container.querySelector('[data-map-panel-table]').textContent.includes('solo'), 'the replacement feature renders')
  assert.equal(prev().disabled, true)
  assert.equal(next().disabled, true)
})

test('the feature card ignores an Escape another consumer already handled', async tContext => {
  const dom = installDom(tContext)
  let closes = 0
  const inspection = { layerId: 'a', layerName: 'Layer a', featureId: 'f1', title: null, fields: [{ name: 'kind', value: 'x' }], omitted: 0, anchor: { left: 100, top: 100, right: 120, bottom: 120 } }
  const root = createRoot(dom.container)
  dom.roots.push(root)
  act(() => { root.render(createElement(FeatureCard, { inspection, onClose: () => { closes += 1 }, t })) })
  act(() => { dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })) })
  assert.equal(closes, 1)
  const handled = new dom.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  handled.preventDefault()
  act(() => { dom.window.dispatchEvent(handled) })
  assert.equal(closes, 1, 'a consumed Escape does not close the card')
})

const scoreStyle = (overrides = {}) => ({
  methodVersion: 'spatial-viz@1', field: 'score', unit: '分', measure: 'total', encoding: 'fill',
  classification: 'equal-interval', breaks: [10, 20], domain: { min: 0, max: 30 },
  palette: ['#f7fbff', '#6baed6', '#08306b'], missingColor: '#bdbdbd', overflowColor: '#616161', missingLabel: 'no data',
  styleVersion: 'style-a',
  ...overrides,
})

const wbFeature = (score, at, id) => {
  const feature = { type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { score, ...(at === undefined ? {} : { at }) } }
  if (id !== undefined) feature.id = id
  return feature
}

const wbLayer = (id, features, style = scoreStyle(), extras = {}) => ({
  id, name: `Layer ${id}`, data: { type: 'FeatureCollection', features }, sourceCrs: 'EPSG:4326',
  opacity: 1, visible: true, style, resourceRef: `ref-${id}`, ...extras,
})

const wbProps = (wire, occurrence = () => null) => ({ wire, occurrence, t })

const wbStatus = container => container.querySelector('[data-map-workbench] p[role="status"]:not([data-workbench-export-status])')?.textContent ?? null
const wbRows = container => [...container.querySelectorAll('[data-workbench-table] tbody tr')]
const wbOccurrence = (receipt = null) => {
  const calls = { highlight: [], timeFrame: [] }
  return {
    calls,
    stub: {
      setHighlight: (layerId, ids) => { calls.highlight.push([layerId, ids]) },
      setTimeFrame: frame => { calls.timeFrame.push(frame) },
      getRenderReceipt: () => receipt,
    },
  }
}
const renderedReceipt = revision => ({ status: 'rendered', revision, renderedRevision: revision, viewId: 'v1', failedLayers: [], at: '', generation: 1, attempt: 1, layerVersions: [], reason: null })

test('workbench row selection drives the map highlight and survives a same-dataset revision', async tContext => {
  const dom = installDom(tContext)
  const occ = wbOccurrence()
  const layer = wbLayer('zones', [wbFeature(5, undefined, 'low'), wbFeature(15, undefined, 'mid'), wbFeature(25, undefined, 'high')])
  const { container, root } = mountPanel(dom, wbProps(wireOf([layer], 7), () => occ.stub), Workbench)
  const rowButton = wbRows(container)[0].querySelector('button')
  await click(rowButton)
  assert.deepEqual([...occ.calls.highlight.at(-1)[1]], ['low'], 'the clicked row id reaches the map')
  assert.ok(wbStatus(container).includes('1'))
  act(() => { root.render(createElement(Workbench, wbProps(wireOf([{ ...layer, opacity: 0.9 }], 8), () => occ.stub))) })
  assert.deepEqual([...occ.calls.highlight.at(-1)[1]], ['low'], 'an ordinary revision keeps the explicit selection')
  await click(wbRows(container)[0].querySelector('button'))
  await flush()
  assert.equal(occ.calls.highlight.at(-1)[1].size, 0, 'toggling off clears the highlight without a constraint')
})

test('workbench brush and pinned frame filter the shared selection and the table', async tContext => {
  const dom = installDom(tContext)
  const occ = wbOccurrence()
  const style = scoreStyle({ timeBinding: { timeField: 'at', timezone: 'UTC', granularity: 'day', window: { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' } } })
  const features = [wbFeature(5, '2026-01-01T06:00:00Z', 'in-a'), wbFeature(15, '2026-01-02T06:00:00Z'), wbFeature(25, '2026-01-02T12:00:00Z', 'in-c')]
  const { container } = mountPanel(dom, wbProps(wireOf([wbLayer('zones', features, style)], 7), () => occ.stub), Workbench)
  await flush()
  assert.equal(wbRows(container).length, 3)
  await click(container.querySelector('[data-workbench-chart] button'))
  await flush()
  assert.equal(wbRows(container).length, 1, 'the brush leaves only the first class row')
  assert.ok(wbRows(container)[0].textContent.includes('in-a'))
  await click(container.querySelector(`[aria-label="${t('workbench.chart.clear')}"]`))
  await flush()
  assert.equal(wbRows(container).length, 3, 'clearing the brush restores every row')
  await click(container.querySelector(`[aria-label="${t('workbench.timeline.next')}"]`))
  await flush()
  const ids = wbRows(container).map(row => row.textContent)
  assert.ok(ids.some(text => text.includes('in-c')) && !ids.some(text => text.includes('in-a')), 'the pinned frame keeps only its rows')
  const anonymous = wbRows(container).map(row => row.querySelector('button')?.getAttribute('aria-label') ?? '')
  assert.ok(anonymous.some(label => label.includes('f-2')), 'the anonymous feature keeps its positional identity')
})

test('a symbol-only map renders no workbench region or legend copy', async tContext => {
  const dom = installDom(tContext)
  // A wire with only unclassified layers: styledLayersOf finds no classified
  // face, so the workbench must not mount at all.
  const wire = wireOf([layerOf('symbols-only')])
  const { container } = mountPanel(dom, wbProps(wire, () => null), Workbench)
  assert.equal(container.querySelector('[data-map-workbench]'), null)
  assert.equal(container.querySelector('[data-workbench-legend]'), null)
  assert.equal(container.textContent.includes('Legend'), false,
    'no workbench legend copy may render for a symbol-only map')
})

test('the workbench table clamps its page on filter shrink and resets on a new dataset', async tContext => {
  const dom = installDom(tContext)
  const occ = wbOccurrence()
  const many = Array.from({ length: 19 }, (_, index) => wbFeature(index, undefined, `w${index}`))
  many.push(wbFeature(25, undefined, 'top'))
  const { container, root } = mountPanel(dom, wbProps(wireOf([wbLayer('zones', many)], 7), () => occ.stub), Workbench)
  const next = () => container.querySelector(`[aria-label="${t('workbench.table.nextPage')}"]`)
  const prev = () => container.querySelector(`[aria-label="${t('workbench.table.prevPage')}"]`)
  await click(next()); await click(next())
  assert.ok(container.querySelector('[data-workbench-table]').textContent.includes(t('workbench.table.page', { page: '3', pages: '3' })))
  await click([...container.querySelectorAll('[data-workbench-chart] button')].find(bar => (bar.getAttribute('aria-label') ?? '') === t('workbench.chart.bar', { n: '3', count: '1', from: '20', to: '30' })))
  await flush()
  assert.ok(container.querySelector('[data-workbench-table]').textContent.includes(t('workbench.table.page', { page: '1', pages: '1' })), 'the page clamps onto the filtered set')
  assert.equal(wbRows(container).length, 1)
  assert.equal(prev().disabled, true)
  assert.equal(next().disabled, true)
  await click(wbRows(container)[0].querySelector('button'))
  await flush()
  const beforeSwitch = occ.calls.highlight.length
  const other = wbLayer('zones-b', [wbFeature(1, undefined, 'fresh')], scoreStyle({ field: 'score', domain: { min: 0, max: 5 }, breaks: [2, 4] }))
  act(() => { root.render(createElement(Workbench, wbProps(wireOf([other], 8), () => occ.stub))) })
  assert.ok(occ.calls.highlight.slice(beforeSwitch).some(([id, ids]) => id === 'zones' && ids.size === 0), 'teardown clears the previous layer highlight')
  assert.ok(wbRows(container).some(row => row.textContent.includes('fresh')), 'B renders its own row')
  assert.equal(container.querySelector(`[aria-label="${t('workbench.chart.clear')}"]`), null, 'no stale brush control survives')
  assert.equal(occ.calls.timeFrame.at(-1), null)
  assert.ok(container.querySelector('[data-workbench-table]').textContent.includes(t('workbench.table.page', { page: '1', pages: '1' })))
  assert.equal(wbRows(container).filter(row => row.querySelector('button')?.getAttribute('aria-pressed') === 'true').length, 0, 'no stale checked rows survive the identity switch')
})

test('the workbench export waits for a live rendered receipt and reports failures', async tContext => {
  const dom = installDom(tContext)
  const created = []
  const order = []
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  const originalClick = dom.window.HTMLAnchorElement.prototype.click
  URL.createObjectURL = blob => { order.push('create'); const url = `blob:fake-${created.length}`; created.push(url); return url }
  URL.revokeObjectURL = url => { order.push('revoke') }
  dom.window.HTMLAnchorElement.prototype.click = function () { order.push('click') }
  tContext.after(() => {
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
    dom.window.HTMLAnchorElement.prototype.click = originalClick
  })
  const layer = wbLayer('zones', [wbFeature(5, undefined, 'low')])
  const wire = wireOf([layer], 7)
  const exportButton = () => container.querySelector('[data-workbench-export-button]')
  const statusText = () => container.querySelector('[data-workbench-export-status]')?.textContent ?? null

  const blocked = wbOccurrence({ status: 'applied', revision: 7, renderedRevision: null })
  const { container, root } = mountPanel(dom, wbProps(wire, () => blocked.stub), Workbench)
  await click(exportButton())
  assert.equal(created.length, 0, 'a non-rendered receipt downloads nothing')
  assert.equal(container.querySelector('[data-workbench-export-status]').hasAttribute('data-ok'), false)
  assert.equal(statusText(), t('workbench.export.renderBlocked'))

  const staleReceipt = wbOccurrence(renderedReceipt(6))
  act(() => { root.render(createElement(Workbench, wbProps(wire, () => staleReceipt.stub))) })
  await click(exportButton())
  assert.equal(created.length, 0, 'a receipt rendered at another revision downloads nothing')
  for (const status of ['failed', 'unavailable']) {
    const receipt = { status, revision: status === 'failed' ? 7 : null, renderedRevision: null, viewId: status === 'failed' ? 'v1' : null, failedLayers: status === 'failed' ? [{ layerId: null, code: 'VIEW_FAILED' }] : [], at: '', generation: 1, attempt: 1, layerVersions: [], reason: null }
    act(() => { root.render(createElement(Workbench, wbProps(wire, () => wbOccurrence(receipt).stub))) })
    await click(exportButton())
    assert.equal(created.length, 0, `a ${status} receipt downloads nothing`)
    assert.equal(container.querySelector('[data-workbench-export-status]').hasAttribute('data-ok'), false)
  }
  act(() => { root.render(createElement(Workbench, wbProps(wire, () => null))) })
  await click(exportButton())
  assert.equal(created.length, 0, 'no live occurrence downloads nothing')
  assert.equal(container.querySelector('[data-workbench-export-status]').hasAttribute('data-ok'), false)

  const live = wbOccurrence(renderedReceipt(7))
  act(() => { root.render(createElement(Workbench, wbProps(wire, () => live.stub))) })
  URL.createObjectURL = () => { order.push('create'); throw new Error('no blobs') }
  await click(exportButton())
  assert.equal(statusText(), t('workbench.export.failed', { revision: '7' }))
  URL.createObjectURL = blob => { order.push('create'); const url = `blob:fake-${created.length}`; created.push(url); return url }
  await click(exportButton())
  assert.deepEqual(order.slice(-3), ['create', 'click', 'revoke'], 'the blob is created, clicked, then revoked')
  assert.ok(statusText().includes('7') && statusText() !== t('workbench.export.failed', { revision: '7' }) && statusText() !== t('workbench.export.renderBlocked'), 'success is reported only after the download fires')

  const failureBefore = statusText()
  dom.window.HTMLAnchorElement.prototype.click = () => { order.push('click'); throw new Error('click refused') }
  const revokesBefore = order.filter(step => step === 'revoke').length
  await click(exportButton())
  assert.equal(order.filter(step => step === 'revoke').length, revokesBefore + 1, 'a thrown click still releases the URL')
  assert.equal(statusText(), t('workbench.export.failed', { revision: '7' }))
})

test('a changed dataset identity resets workbench state for the same layer id', async tContext => {
  const dom = installDom(tContext)
  const occ = wbOccurrence()
  const features = [wbFeature(5, undefined, 'a'), wbFeature(25, undefined, 'b')]
  const { container, root } = mountPanel(dom, wbProps(wireOf([wbLayer('zones', features, scoreStyle(), { resourceRef: 'ref-zones-v1' })], 7), () => occ.stub), Workbench)
  await click(container.querySelector('[data-workbench-chart] button'))
  await flush()
  assert.equal(wbRows(container).length, 1)
  const v2 = wbLayer('zones', features, scoreStyle(), { resourceRef: 'ref-zones-v2' })
  act(() => { root.render(createElement(Workbench, wbProps(wireOf([v2], 8), () => occ.stub))) })
  assert.equal(wbRows(container).length, 2, 'the new dataset shows its own unfiltered rows')
  assert.equal(container.querySelector(`[aria-label="${t('workbench.chart.clear')}"]`), null, 'no brush survives the identity change')
  assert.equal(wbRows(container).filter(row => row.querySelector('button')?.getAttribute('aria-pressed') === 'true').length, 0)
  assert.ok(container.querySelector('[data-workbench-table]').textContent.includes(t('workbench.table.page', { page: '1', pages: '1' })))
  await click(container.querySelector('[data-workbench-chart] button'))
  await flush()
  assert.equal(wbRows(container).length, 1, 'a fresh brush works on the new dataset')
  const v3 = wbLayer('zones', features, scoreStyle({ styleVersion: 'style-b' }), { resourceRef: 'ref-zones-v2' })
  act(() => { root.render(createElement(Workbench, wbProps(wireOf([v3], 9), () => occ.stub))) })
  assert.equal(wbRows(container).length, 2, 'a classifier version change also resets the constraint')
  assert.equal(container.querySelector(`[aria-label="${t('workbench.chart.clear')}"]`), null)
})

test('unmounting the workbench releases the pinned frame and the selection on the map', async tContext => {
  const dom = installDom(tContext)
  const occ = wbOccurrence()
  const style = scoreStyle({ timeBinding: { timeField: 'at', timezone: 'UTC', granularity: 'day', window: { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' } } })
  const layer = wbLayer('zones', [wbFeature(5, '2026-01-01T06:00:00Z', 'in-a'), wbFeature(15, '2026-01-02T06:00:00Z', 'in-b')], style)
  const { container, root } = mountPanel(dom, wbProps(wireOf([layer], 7), () => occ.stub), Workbench)
  await flush()
  await click(container.querySelector(`[aria-label="${t('workbench.timeline.next')}"]`))
  await flush()
  assert.notEqual(occ.calls.timeFrame.at(-1), null)
  await click(wbRows(container)[0].querySelector('button'))
  await flush()
  const beforeUnmount = occ.calls.highlight.length
  dom.roots.splice(dom.roots.indexOf(root), 1)
  act(() => root.unmount())
  assert.equal(occ.calls.timeFrame.at(-1), null, 'unmount releases the pinned frame')
  assert.ok(occ.calls.highlight.slice(beforeUnmount).some(([id, ids]) => id === 'zones' && ids.size === 0), 'unmount clears the map selection')
})
