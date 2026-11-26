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
const { LayerPanel } = await importClient('../src/client/LayerPanel.tsx')
const { en } = await importClient('../src/client/locales.ts')
const { MAP_THEME_CSS, MAPBOX_CTRL_CSS } = await importClient('../src/client/map-theme.ts')

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

const sourceAttachment = {
  attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 10, width: 800, height: 600,
  name: 'map.png', sha256: 'a'.repeat(64),
}

const proposalOf = () => ({
  proposalId: 'vprop-0123456789abcdef01234567',
  observationId: 'obs-1',
  observationAttachmentSha256: 'a'.repeat(64),
  observationAttachment: sourceAttachment,
  sourceCallId: 'markup-1',
  sourceCallSeq: 2,
  mapRevision: 7,
  modelProvider: 'fixture',
  modelName: 'vision-model',
  purpose: 'target',
  category: 'Sketch proposal',
  note: 'visible roof',
  confidence: 'likely',
  pixelGeometry: { type: 'point', point: [200, 100] },
  geometry: { type: 'Point', coordinates: [116.4, 39.9] },
  status: 'proposed',
  createdAt: '2026-11-13T00:00:00.000Z',
  reviewedAt: null,
  humanEdited: false,
  acceptedFeatureId: null,
})

const changeOf = () => ({
  changeId: 'vchg-0123456789abcdef01234567',
  comparisonId: 'cmp-1',
  beforeObservationId: 'obs-1',
  afterObservationId: 'obs-2',
  category: 'New building',
  note: 'appeared between captures',
  kind: 'appeared',
  confidence: 'likely',
  status: 'proposed',
  humanEdited: false,
  createdAt: '2026-11-13T00:00:00.000Z',
  reviewedAt: null,
})

const layerOf = (id, name = `Layer ${id}`) => ({
  id,
  name,
  data: { type: 'FeatureCollection', features: [{ type: 'Feature', id: `${id}-feature`, geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: {} }] },
  sourceCrs: 'EPSG:4326',
  opacity: 1,
  visible: true,
})

const wireOf = (layers = []) => ({
  layers,
  view: { center: [116.4, 39.9], zoom: 8, wkid: 4326 },
  mode: 'map',
  aoi: null,
  revision: 7,
  operations: [],
  observationRequest: null,
  visualProposals: [],
  visualChanges: [],
  observationHistory: [],
})

function mountPanel(dom, props) {
  const root = createRoot(dom.container)
  act(() => {
    root.render(createElement(LayerPanel, {
      sessionId: 'session-1',
      occurrenceKey: 'tab',
      occurrence: () => null,
      t,
      useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
      changeSubmit: async input => ({ ok: true, revision: input.revision + 1 }),
      ...props,
    }))
  })
  dom.roots.push(root)
  return { container: dom.container, root }
}

const click = async node => { await act(async () => { node.dispatchEvent(new node.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true })) }) }

test('the empty state belongs to the layer list region', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountPanel(dom, { surface: 'ai', wire: wireOf([]) })
  const list = container.querySelector('[data-map-panel-list]')
  assert.ok(list, 'the layer list region renders even when empty')
  assert.ok(list.querySelector('[data-map-panel-empty]'), 'the empty state renders inside the list region it explains')
  assert.equal(container.querySelector('[data-map-panel-pending]'), null, 'no pending section exists without candidate records')
})

test('candidate review lives in the pending section and one dialog', async tContext => {
  const dom = installDom(tContext)
  const wire = wireOf([layerOf('a'), layerOf('b')])
  wire.visualProposals = [proposalOf()]
  wire.visualChanges = [changeOf()]
  const { container } = mountPanel(dom, { surface: 'ai', wire })
  const list = container.querySelector('[data-map-panel-list]')
  const pending = container.querySelector('[data-map-panel-pending]')
  assert.ok(list)
  assert.ok(pending)
  assert.ok(pending.querySelector('[data-map-panel-proposal]'), 'model candidates live in the pending section')
  assert.ok(pending.querySelector('[data-map-panel-change]'), 'visual change candidates live in the pending section')
  assert.ok(list.contains(pending), 'the pending section lives in the scrollable layer region')
  assert.equal(container.querySelector('[data-map-panel-review]'), null, 'the review region is gone')
  assert.equal(container.querySelector('[data-map-panel-section]'), null, 'no collapsible section headings remain')
  const trigger = pending.querySelector('[data-map-panel-proposal-select]')
  assert.ok(trigger, 'the candidate row itself opens review; the dialog is covered by visual-proposal-ui')
  assert.match(MAP_THEME_CSS, /\[data-map-panel-list\] \{[^}]*flex: 1 1 auto;[^}]*min-height: 0;[^}]*overflow-y: auto/)
  assert.doesNotMatch(MAP_THEME_CSS, /\[data-map-panel-review\]/)
})

test('pending rows preview, confirm, and cancel through the user change route', async tContext => {
  const dom = installDom(tContext)
  const wire = wireOf([layerOf('a')])
  wire.visualProposals = [proposalOf()]
  const focused = []
  const submitted = []
  const { container } = mountPanel(dom, {
    surface: 'ai',
    wire,
    occurrence: () => ({ focusFeature: (layerId, featureId) => focused.push([layerId, featureId]), annotationDrawingState: () => ({ status: 'idle', kind: null, lastError: null }) }),
    changeSubmit: async input => { submitted.push(input); return { ok: true, revision: input.revision + 1 } },
  })
  const row = container.querySelector('[data-map-panel-pending-row]')
  const buttons = [...row.querySelectorAll('button')]
  await click(buttons.find(button => button.textContent === t('panel.pending.preview')))
  assert.deepEqual(focused, [['visual-proposals', 'vprop-0123456789abcdef01234567']])
  await click(buttons.find(button => button.textContent === t('panel.pending.confirm')))
  await act(async () => { for (let at = 0; at < 10; at += 1) await Promise.resolve() })
  assert.equal(submitted[0].change.op, 'visual-proposal-accept')
  assert.equal(submitted[0].change.proposalId, 'vprop-0123456789abcdef01234567')
  await click(buttons.find(button => button.textContent === t('panel.pending.cancel')))
  await act(async () => { for (let at = 0; at < 10; at += 1) await Promise.resolve() })
  assert.equal(submitted[1].change.op, 'visual-proposal-reject')
  assert.equal(submitted[1].change.proposalId, 'vprop-0123456789abcdef01234567')
})

test('the bulk toolbar carries named actions and a scoped clear menu', async tContext => {
  const dom = installDom(tContext)
  const { container } = mountPanel(dom, { surface: 'ai', wire: wireOf([layerOf('a')]) })
  const bulk = container.querySelector('[data-map-panel-bulk]')
  assert.ok(bulk)
  const actions = [...bulk.querySelectorAll(':scope > button')]
  assert.deepEqual(actions.map(button => button.textContent), [t('panel.showAll'), t('panel.hideAll')])
  assert.ok(bulk.textContent.includes(t('panel.bulkScope', { count: '1' })), 'the toolbar states its scope')
  assert.equal(bulk.textContent.includes(t('panel.clearAll.withCount', { count: '1' })), false, 'clear stays in the menu')
  await click(bulk.querySelector('[data-map-panel-bulk-menu] button[aria-haspopup="menu"]'))
  assert.ok([...dom.window.document.querySelectorAll('[role="menuitem"]')].some(item => item.textContent?.includes('Clear layers (1)')))
})

test('panel rows do not override shared control appearance with the map navigation skin', () => {
  const source = readFileSync(new URL('../src/client/LayerPanel.tsx', import.meta.url), 'utf8')
  const rows = [...source.matchAll(/data-mapbox-panel-row=""/g)]
  assert.equal(rows.length, 6, 'every layer, annotation, imagery, and candidate row shares the skin')
  assert.doesNotMatch(MAPBOX_CTRL_CSS, /data-mapbox-panel-row|data-map-panel-icon/)
  assert.match(MAP_THEME_CSS, /\[data-map-panel-name\] \{[^}]*text-overflow: ellipsis; white-space: nowrap/)
})

test('panel controls pair with shared primitives', () => {
  const source = readFileSync(new URL('../src/client/LayerPanel.tsx', import.meta.url), 'utf8')
  const rawButtons = [...source.matchAll(/<button\b[^>]*>/g)]
    .map(match => match[0])
    .filter(tag => !tag.includes('data-map-panel-toggle') && !tag.includes('role="tab"'))
  assert.deepEqual(rawButtons, [], 'panel action controls use Button; only the collapsed launcher and the tablist stay native')
  const rawInputs = [...source.matchAll(/<input\b[^>]*>/g)]
    .map(match => match[0])
    .filter(tag => !tag.includes('type="range"') && !tag.includes('type="checkbox"') && !tag.includes('type="color"'))
  assert.deepEqual(rawInputs, [], 'text and search fields use Input; only the range slider, checkbox toggles, and the native color picker stay native')
})
