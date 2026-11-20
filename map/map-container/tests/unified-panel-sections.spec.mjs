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

const layerOf = (id, name) => ({
  id, name, visible: true, opacity: 1, sourceCrs: 'EPSG:4326',
  data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: `${id}-f`, geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: {} }] },
})
const annotationOf = (id, name) => ({
  type: 'Feature', id,
  geometry: { type: 'Point', coordinates: [116.4, 39.9] },
  properties: { name, dshRole: 'user-annotation', dshAuthor: 'user', dshSource: 'manual', dshCreatedAt: '2026-11-13T00:00:00.000Z', dshUpdatedAt: '2026-11-13T00:00:00.000Z' },
})
const wireOf = () => ({
  layers: [
    layerOf('alpha', 'Alpha'),
    { id: 'user-annotations', name: 'User annotations', role: 'user-annotation', visible: true, opacity: 1, sourceCrs: 'EPSG:4326', data: { type: 'FeatureCollection', features: [annotationOf('ann-1', 'Site A')] } },
  ],
  view: { center: [116.4, 39.9], zoom: 8, wkid: 4326 },
  mode: 'map', basemap: null,
  imageryDisplay: { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null },
  aoi: null, revision: 7, operations: [], observationRequest: null,
  visualProposals: [], visualChanges: [], undoableAnnotation: null,
})

function mount(dom) {
  const root = createRoot(dom.container)
  act(() => {
    root.render(createElement(LayerPanel, {
      surface: 'unified', wire: wireOf(), sessionId: 'session-1', occurrenceKey: 'tab',
      occurrence: () => null, t,
      useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
      changeSubmit: async input => ({ ok: true, revision: input.revision + 1 }),
      panelSubmit: undefined,
    }))
  })
  dom.roots.push(root)
  return { container: dom.container, root }
}

const click = async (dom, node) => { await act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) }) }
const sectionsOf = container => [...container.querySelectorAll('[data-map-panel] [data-map-panel-section]')]
const sectionBodiesOf = container => [...container.querySelectorAll('[data-map-panel] [data-map-panel-section-body]')]

test('one resident card hosts three collapsible sections and no tablist or launcher', async tContext => {
  const dom = installDom(tContext)
  const { container } = mount(dom)
  assert.equal(container.querySelectorAll('[data-map-panel]').length, 1)
  const card = container.querySelector('[data-map-panel]')
  assert.equal(card.getAttribute('data-map-panel-surface'), 'unified')
  assert.equal(card.hasAttribute('data-map-panel-collapsed'), false)
  assert.equal(container.querySelector('[data-map-panel-tabs]'), null, 'the tabbed switcher is gone')
  assert.equal(container.querySelectorAll('[role="tablist"]').length, 0, 'no nested tablist remains in any section')
  assert.equal(container.querySelector('[data-map-panel-toggle]'), null, 'no launcher button remains')
  const sections = sectionsOf(container)
  assert.deepEqual(sections.map(section => section.getAttribute('data-map-panel-section')), ['annotation', 'ai', 'imagery'])
  assert.deepEqual(
    sections.map(section => section.querySelector('[data-map-panel-section-title]')?.textContent),
    [t('panel.tab.annotation'), t('panel.tab.layers'), t('panel.tab.imagery')],
  )
  const bodies = sectionBodiesOf(container)
  assert.equal(bodies.length, 3, 'every section body stays mounted')
  assert.deepEqual(bodies.map(body => body.hidden), [true, false, true], 'layers is the only section expanded by default')
  assert.ok(bodies[1].querySelector('[data-map-panel-list]'), 'the layers section hosts the list')
  for (const section of sections) {
    const caret = section.querySelector('[data-map-panel-section-caret]')
    assert.ok(caret, `section ${String(section.getAttribute('data-map-panel-section'))} carries a caret`)
    const body = dom.window.document.getElementById(caret.getAttribute('aria-controls') ?? '')
    assert.ok(body, 'the caret controls an existing section body')
  }
})

test('section carets toggle one section and keep the other bodies mounted', async tContext => {
  const dom = installDom(tContext)
  const { container } = mount(dom)
  const caretOf = value => container.querySelector(`[data-map-panel-section="${String(value)}"] [data-map-panel-section-caret]`)
  const annotationCaret = caretOf('annotation')
  assert.equal(annotationCaret.getAttribute('aria-expanded'), 'false')
  assert.equal(annotationCaret.getAttribute('aria-label'), t('panel.section.expand', { title: t('panel.tab.annotation') }))
  await click(dom, annotationCaret)
  assert.deepEqual(sectionBodiesOf(container).map(body => body.hidden), [false, false, true], 'annotation opens without disturbing the others')
  assert.equal(caretOf('annotation').getAttribute('aria-expanded'), 'true')
  assert.equal(caretOf('annotation').getAttribute('aria-label'), t('panel.section.collapse', { title: t('panel.tab.annotation') }))
  assert.ok(container.querySelector('[data-map-panel-section="annotation"] [data-map-panel-annotation-tools]'), 'annotation tools are reachable in the opened section')
  await click(dom, caretOf('imagery'))
  assert.deepEqual(sectionBodiesOf(container).map(body => body.hidden), [false, false, false], 'imagery opens alongside both others')
  assert.ok(container.querySelector('[data-map-panel-section="imagery"] [data-map-imagery-row]'), 'the flat imagery rows stay inside their section')
  await click(dom, caretOf('ai'))
  assert.deepEqual(sectionBodiesOf(container).map(body => body.hidden), [false, true, false], 'the layers section collapses alone')
  assert.ok(sectionBodiesOf(container)[1].querySelector('[data-map-panel-layer]'), 'the collapsed section body keeps its rows mounted')
})

test('collapsing the card keeps a resident bar and expanding restores section states', async tContext => {
  const dom = installDom(tContext)
  const { container } = mount(dom)
  await click(dom, container.querySelector('[data-map-panel-section="annotation"] [data-map-panel-section-caret]'))
  const collapse = container.querySelector('[data-map-panel-collapse]')
  assert.equal(collapse.getAttribute('aria-expanded'), 'true')
  assert.equal(collapse.getAttribute('aria-label'), t('panel.collapse'))
  await click(dom, collapse)
  const card = container.querySelector('[data-map-panel]')
  assert.ok(card, 'the card stays mounted as a resident bar')
  assert.equal(card.hasAttribute('data-map-panel-collapsed'), true)
  assert.ok(card.querySelector('[data-map-panel-header]'), 'the collapsed bar keeps its header')
  assert.equal(card.querySelector('[data-map-panel-body]'), null, 'the collapsed card shows no body')
  assert.equal(card.querySelectorAll('[data-map-panel-section]').length, 0, 'the collapsed card shows no sections')
  assert.equal(container.querySelector('[data-map-panel-toggle]'), null, 'collapsing never produces a launcher button')
  assert.ok(card.querySelector('h2'), 'the bar keeps its title')
  const expand = card.querySelector('[data-map-panel-collapse]')
  assert.equal(expand.getAttribute('aria-expanded'), 'false')
  assert.equal(expand.getAttribute('aria-label'), t('panel.expand'))
  await click(dom, expand)
  assert.deepEqual(sectionBodiesOf(container).map(body => body.hidden), [false, false, true], 'expanding restores the section states chosen before collapsing')
  assert.equal(container.querySelector('[data-map-panel-section="annotation"] [data-map-panel-section-caret]')?.getAttribute('aria-expanded'), 'true')
})
