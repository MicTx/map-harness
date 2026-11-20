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
const { SYMBOL_PRESETS } = await importClient('../../layers/src/index.ts')

const t = (key, params) => {
  const template = en[key] ?? key
  return params === undefined ? template : template.replace(/\{(\w+)\}/gu, (whole, name) => params[name] ?? '')
}

const DOM_GLOBALS = [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLAnchorElement',
  'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'Document', 'Range', 'Selection', 'Event',
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

const annotationFeature = (id, name, geometry = { type: 'Point', coordinates: [116.4, 39.9] }) => ({
  type: 'Feature',
  id,
  geometry,
  properties: {
    name,
    dshRole: 'user-annotation',
    dshAuthor: 'user',
    dshSource: 'manual',
    dshCreateOperationId: `create-${id}`,
    dshUpdateOperationId: `update-${id}`,
    dshCreatedAt: '2026-11-04T00:00:00.000Z',
    dshUpdatedAt: '2026-11-04T00:00:00.000Z',
  },
})

const annotationLayer = {
  id: 'user-annotations',
  name: 'User annotations',
  role: 'user-annotation',
  data: {
    type: 'FeatureCollection',
    features: [
      annotationFeature('ann-0123456789abcdef01234567', 'Site A'),
      annotationFeature('ann-0123456789abcdef01234568', 'Site B', { type: 'LineString', coordinates: [[116, 39], [117, 40]] }),
    ],
  },
  sourceCrs: 'EPSG:4326',
  opacity: 1,
  visible: true,
}

const ordinaryLayer = (id = 'business') => ({
  id,
  name: id === 'business' ? 'Business' : id,
  data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: 'business-1', geometry: { type: 'Point', coordinates: [116, 39] }, properties: {} }] },
  sourceCrs: 'EPSG:4326',
  opacity: 1,
  visible: true,
})

const wireOf = (layers = [annotationLayer, ordinaryLayer()]) => ({
  layers,
  view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 },
  mode: 'map',
  basemap: null,
  aoi: null,
  revision: 9,
  operations: [{
    index: 1,
    operationId: 'annotation-create-1',
    undoOf: null,
    writerId: 'user',
    revision: 9,
    summary: 'annotation-create Site A',
  }],
  undoableAnnotation: {
    index: 1,
    operationId: 'annotation-create-1',
    undoOf: null,
    writerId: 'user',
    revision: 9,
    summary: 'annotation-create Site A',
  },
  observationRequest: null,
})

function occurrenceStub() {
  const calls = { draw: [], edit: [], cancels: 0 }
  let drawing = { status: 'idle', kind: null, lastError: null }
  return {
    fail(code) {
      drawing = { ...drawing, status: 'idle', lastError: code }
    },
    calls,
    stub: {
      annotationDrawingState: () => drawing,
      async startAnnotationDrawing(kind) {
        calls.draw.push(kind)
        drawing = { status: 'drawing', kind, lastError: null }
        return 'started'
      },
      async startAnnotationEditing(featureId, geometry, expectedUpdatedAt) {
        calls.edit.push({ featureId, geometry, expectedUpdatedAt })
        drawing = { status: 'editing', kind: null, lastError: null }
        return 'started'
      },
      cancelAnnotationDrawing() {
        calls.cancels += 1
        drawing = { status: 'idle', kind: null, lastError: null }
        return true
      },
    },
  }
}

function mount(dom, extras = {}, wire = wireOf()) {
  const occurrence = occurrenceStub()
  const submitted = []
  const panelRequests = []
  const root = createRoot(dom.container)
  act(() => {
    root.render(createElement(LayerPanel, {
      wire,
      sessionId: 'session-1',
      occurrenceKey: 'tab',
      occurrence: () => occurrence.stub,
      t,
      useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
      changeSubmit: async input => {
        submitted.push(input)
        return { ok: true, revision: input.revision + 1 }
      },
      panelSubmit: async (_sessionId, text) => {
        panelRequests.push(text)
        return true
      },
      ...extras,
    }))
  })
  dom.roots.push(root)
  return { occurrence, submitted, panelRequests, container: dom.container, root }
}

const flush = async () => { await act(async () => { for (let at = 0; at < 10; at += 1) await Promise.resolve() }) }
const click = async (dom, node) => { await act(async () => node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))) }
const byText = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text)
const openAnnotationMenu = async (dom, container) => {
  const trigger = container.querySelector('[data-map-panel-annotation-menu] button[aria-haspopup="menu"]')
  await click(dom, trigger)
}
const setInputValue = async (dom, input, value) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(input, value)
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
}
const setSelectValue = async (dom, select, value) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(select.constructor.prototype, 'value').set
    setter.call(select, value)
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  })
}

test('annotations render as a separate stable-id group from business layers', async tContext => {
  const dom = installDom(tContext)
  const { container } = mount(dom)
  const rows = [...container.querySelectorAll('[data-map-annotation-row]')]
  assert.equal(rows.length, 2)
  assert.equal(container.querySelectorAll('[data-map-panel-layer]').length, 1)
  assert.equal(container.querySelector('[data-map-panel-layer] [data-map-panel-name]').textContent, 'Business')
  assert.equal(rows[0].querySelector('[data-map-panel-name]').textContent, 'Site A')
  assert.equal(rows[1].querySelector('[data-map-panel-name]').textContent, 'Site B')
  assert.equal(rows[0].querySelector('[data-map-panel-actions] button').closest('[data-map-panel-name]'), null,
    'row actions are siblings, not nested inside the name button')
})

test('drawing tools drive the occurrence host and stop is reachable', async tContext => {
  const dom = installDom(tContext)
  const { container, occurrence } = mount(dom)
  await click(dom, byText(container, t('panel.annotation.kind.point')))
  await flush()
  assert.deepEqual(occurrence.calls.draw, ['point'])
  assert.equal(container.querySelector('[data-map-panel-annotations] [role="status"]').textContent,
    t('panel.annotation.status.drawing'))
  await click(dom, byText(container, t('panel.annotation.cancel')))
  assert.equal(occurrence.calls.cancels, 1)
})

test('a dialog-edited annotation saves text, style, geometry, delete, undo, and export through stable paths', async tContext => {
  const dom = installDom(tContext)
  const { container, occurrence, submitted, panelRequests } = mount(dom)
  await click(dom, container.querySelectorAll('[data-map-annotation-row] [data-map-panel-name]')[0])
  await flush()
  const dialog = dom.window.document.querySelector('[data-map-annotation-dialog]')
  assert.ok(dialog, 'the annotation editor lives in the shared dialog')

  const inputs = [...dialog.querySelectorAll('input')]
  await setInputValue(dom, inputs[0], 'Renamed site')
  await setInputValue(dom, inputs[1], 'Confirmed area')
  await click(dom, byText(dom.window.document, t('panel.annotation.save')))
  await flush()
  assert.deepEqual(submitted.at(-1).change, {
    op: 'annotation-update',
    featureId: 'ann-0123456789abcdef01234567',
    expectedUpdatedAt: '2026-11-04T00:00:00.000Z',
    name: 'Renamed site',
    description: 'Confirmed area',
  })

  await setSelectValue(dom, dom.window.document.querySelector('[data-map-annotation-style]'), SYMBOL_PRESETS[0].id)
  await flush()
  assert.equal(submitted.at(-1).change.symbol.symbolVersion, SYMBOL_PRESETS[0].symbol.symbolVersion)

  await click(dom, dom.window.document.querySelector('[aria-label^="Edit geometry of Site A"]'))
  await flush()
  assert.deepEqual(occurrence.calls.edit, [{
    featureId: 'ann-0123456789abcdef01234567',
    geometry: annotationLayer.data.features[0].geometry,
    expectedUpdatedAt: '2026-11-04T00:00:00.000Z',
  }])
  await click(dom, byText(container, t('panel.annotation.cancel')))

  await click(dom, dom.window.document.querySelector('[aria-label^="Delete annotation Site A"]'))
  await click(dom, byText(dom.window.document, t('panel.annotation.deleteConfirm.button')))
  await flush()
  assert.deepEqual(submitted.at(-1).change, {
    op: 'annotation-delete',
    featureIds: ['ann-0123456789abcdef01234567'],
  })

  await openAnnotationMenu(dom, container)
  await click(dom, byText(dom.window.document, t('panel.annotation.undo')))
  await flush()
  assert.deepEqual(submitted.at(-1).change, { op: 'annotation-undo', operationId: 'annotation-create-1' })

  await openAnnotationMenu(dom, container)
  await click(dom, byText(dom.window.document, t('panel.annotation.export')))
  await flush()
  assert.equal(panelRequests.length, 1)
  assert.ok(panelRequests[0].includes('"layer":"user-annotations"') && panelRequests[0].includes('"format":"geojson"'))
})

test('annotation controls fail closed without the user write seam', async tContext => {
  const dom = installDom(tContext)
  const { container, occurrence, submitted } = mount(dom, { changeSubmit: undefined })
  assert.equal(byText(container, t('panel.annotation.kind.point')).disabled, true)
  await openAnnotationMenu(dom, container)
  assert.equal(byText(container, t('panel.annotation.undo')).disabled, true)
  assert.deepEqual(occurrence.calls.draw, [])
  assert.deepEqual(submitted, [])
})

test('drawing failures render an alert and do not look successful', async tContext => {
  const dom = installDom(tContext)
  const { container, occurrence } = mount(dom, {
    changeSubmit: async () => ({ ok: false, code: 'stale-revision' }),
  })
  await click(dom, byText(container, t('panel.annotation.kind.point')))
  await flush()
  occurrence.fail('submit-failed')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)) })
  await flush()
  const alert = container.querySelector('[data-map-panel-annotations] [role="alert"]')
  assert.equal(alert.textContent, t('panel.annotation.error.submit-failed'))
  assert.equal(container.querySelector('[data-map-panel-annotations] [role="status"]'), null)
})

test('ordinary layer moves omit the protected annotation layer', async tContext => {
  const dom = installDom(tContext)
  const { container, submitted } = mount(dom, {}, wireOf([
    annotationLayer,
    ordinaryLayer('a'),
    ordinaryLayer('b'),
  ]))
  const moreButtons = [...container.querySelectorAll('[data-map-panel-layer] [aria-label^="More actions for"]')]
  await click(dom, moreButtons.at(-1))
  // The operation dialog portals to document.body, so its buttons live outside the panel container.
  const dialog = dom.window.document.querySelector('[role="dialog"][aria-modal="true"]')
  assert.ok(dialog, 'More opens the portaled operation dialog')
  await click(dom, dialog.querySelector('[data-map-panel-menu-items] button'))
  await flush()
  assert.equal(submitted.length, 1)
  assert.deepEqual(submitted[0].change.layerIds, ['b', 'a'])
  assert.equal(submitted[0].change.layerIds.includes('user-annotations'), false)
})
