/**
 * V7 two-image candidate review fixtures: stable selection, sibling actions,
 * both persisted source images, atomic user decision, CAS, and replay.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import React from 'react'
import { JSDOM } from 'jsdom'
import { tsImport } from 'tsx/esm/api'
import {
  initialMapProjectionState,
  mapProjectionStateSchema,
  settleUserChange,
} from '../src/protocol.ts'
import { mapContainerProjectionDefinition } from '../src/projection.ts'
import { panelChangesOf } from '../src/client/panel-view.ts'
import { userChangeNoticeText, userChangeOfNoticeText } from '../src/user-change.ts'
import { mapRig } from './map-rig.mjs'

const { createElement, act } = React
globalThis.React = React
const uiPrimitivesRequire = createRequire(new URL('../../../packages/client/ui-primitives/package.json', import.meta.url))
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const createRoot = (...args) => uiPrimitivesRequire('react-dom/client').createRoot(...args)
const importClient = specifier => tsImport(specifier, { parentURL: import.meta.url, tsconfig: new URL('../tsconfig.json', import.meta.url).pathname })
const { LayerPanel } = await importClient('../src/client/LayerPanel.tsx')
const { en } = await importClient('../src/client/locales.ts')

const at = '2026-11-10T00:00:00.000Z'
const reviewedAt = '2026-11-10T00:01:00.000Z'
const changeId = 'vchange-0123456789abcdef01234567'
const otherChangeId = 'vchange-0123456789abcdef01234568'
const acceptedFeatureId = 'ann-0123456789abcdef01234567'
const beforeId = 'att-before'
const afterId = 'att-after'

const attachment = (id, sha) => ({
  attachmentId: id, mediaType: 'image/png', bytes: 10, width: 800, height: 600, name: `${id}.png`, sha256: sha,
})

const change = (status = 'proposed', overrides = {}) => ({
  changeId,
  comparisonId: 'vcompare-0123456789abcdef01234567',
  beforeObservationId: 'obs-before',
  afterObservationId: 'obs-after',
  beforeAttachmentSha256: 'a'.repeat(64),
  afterAttachmentSha256: 'b'.repeat(64),
  observationAttachment: attachment(afterId, 'b'.repeat(64)),
  sourceCallId: 'changes-1',
  sourceCallSeq: 9,
  mapRevision: 1,
  modelProvider: 'fixture',
  modelName: 'vision-model',
  kind: 'appeared',
  category: 'building',
  note: 'new roof',
  confidence: 'likely',
  pixelGeometry: { type: 'point', point: [200, 100] },
  geometry: { type: 'Point', coordinates: [102, 39.8] },
  status,
  createdAt: at,
  reviewedAt: status === 'proposed' ? null : reviewedAt,
  humanEdited: false,
  acceptedFeatureId: status === 'accepted' ? acceptedFeatureId : null,
  ...overrides,
})

const observation = (id, callId, requestSeq, attachmentRef) => ({
  observationId: id, callId, requestSeq, mapRevision: 1,
  viewId: 'view-1', generation: 1, cameraEpoch: 0, gestureEpoch: 0,
  attachment: attachmentRef,
  capturedAt: at,
  imageSize: { width: 800, height: 600 },
  mapContentRect: { x: 0, y: 0, width: 800, height: 600 },
  cssViewSize: { width: 800, height: 600 },
  camera: { center: [102, 39.8], extent: [100, 38, 104, 41], wkid: 4326, scale: 50000, zoom: 8, rotation: 0, mode: 'map', padding: [0, 0, 0, 0] },
  georeference: { kind: 'affine-2d', coefficients: [0.01, 0, 100, 0, -0.01, 41], wkid: 4326, maxResidualCssPx: 0 },
  sources: [{ id: 'esri-wayback', kind: 'basemap', version: '10', attribution: 'Esri', policy: 'approved' }],
  basemap: null,
  includedOverlays: ['attribution'], limitations: [],
})

const wire = (changes = [change()], extra = {}) => ({
  layers: [],
  view: { center: [102, 39.8], zoom: 8, wkid: 4326 },
  interaction: initialMapProjectionState().interaction,
  mode: 'map',
  basemap: null,
  aoi: null,
  revision: 1,
  operations: [],
  undoableAnnotation: null,
  observationRequest: null,
  latestObservation: null,
  observationHistory: [
    observation('obs-before', 'obs-before', 3, attachment(beforeId, 'a'.repeat(64))),
    observation('obs-after', 'obs-after', 7, attachment(afterId, 'b'.repeat(64))),
  ],
  comparisons: [],
  visualProposals: [],
  visualChanges: changes,
  ...extra,
})

function baseState(changes = [change()]) {
  return { ...initialMapProjectionState(), revision: 1, visualChanges: changes }
}

function acceptChange(overrides = {}) {
  return { op: 'visual-change-accept', changeId, expectedRevision: 1, ...overrides }
}

function applyRecord(state, record, seq = 30) {
  const text = userChangeNoticeText('review visual change', record)
  assert.ok(text)
  return mapContainerProjectionDefinition.apply(state, {
    type: 'agent/inbox/spliced', seq, time: 0,
    data: { target: 'next-step', start: 0, inserted: [{
      id: `notice-${seq}`, role: 'user', source: { kind: 'map-user-change', form: 'notice', summary: 'review visual change' },
      content: [{ type: 'text', text }],
    }] },
  })
}

test('change rows bind both persisted images and reviewed evidence', () => {
  const rows = panelChangesOf(wire([change(), change('rejected', { changeId: otherChangeId })]))
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, changeId)
  assert.equal(rows[0].comparisonId, 'vcompare-0123456789abcdef01234567')
  assert.equal(rows[0].beforeAttachment?.attachmentId, beforeId)
  assert.equal(rows[0].afterAttachment?.attachmentId, afterId)
  assert.equal(rows[1].status, 'rejected')
  assert.equal(panelChangesOf(wire([change('accepted')]))[0].humanEdited, false)
})

test('accept atomically writes one annotation and a reject keeps evidence', () => {
  const state = baseState()
  const record = {
    operationId: 'accept-change', targetRevision: 1, sessionId: 'session-1', at: reviewedAt, featureId: acceptedFeatureId,
    change: acceptChange({ name: 'Verified building', description: 'human edited' }),
  }
  const accepted = applyRecord(state, record)
  assert.equal(accepted.revision, 2)
  assert.equal(accepted.visualChanges[0].status, 'accepted')
  assert.equal(accepted.visualChanges[0].humanEdited, true)
  assert.equal(accepted.visualChanges[0].acceptedFeatureId, acceptedFeatureId)
  assert.equal(accepted.layers.filter(layer => layer.role === 'visual-change').length, 0)
  const annotation = accepted.layers.find(layer => layer.role === 'user-annotation')
  assert.equal(annotation.data.features[0].id, acceptedFeatureId)
  assert.equal(annotation.data.features[0].properties.name, 'Verified building')
  assert.equal(annotation.data.features[0].properties.description, 'human edited')
  assert.equal(mapProjectionStateSchema.safeParse(accepted).success, true)
  assert.equal(applyRecord(accepted, record, 31).revision, 2, 'a retry does not create a second annotation')

  const rejected = applyRecord(state, {
    operationId: 'reject-change', targetRevision: 1, sessionId: 'session-1', at: reviewedAt,
    change: { op: 'visual-change-reject', changeId, expectedRevision: 1 },
  })
  assert.equal(rejected.visualChanges[0].status, 'rejected')
  assert.equal(rejected.layers.filter(layer => layer.role === 'user-annotation').length, 0)
  assert.equal(userChangeOfNoticeText(userChangeNoticeText('reject', {
    operationId: 'reject-retry', targetRevision: 1,
    change: { op: 'visual-change-reject', changeId, expectedRevision: 1 },
  }))?.change.op, 'visual-change-reject')
  assert.deepEqual(rejected.observationHistory, state.observationHistory, 'review does not replace either source image')
})

test('stale CAS, unknown change and concurrent writes cannot write an official marker', () => {
  const state = baseState()
  const stale = settleUserChange(state, {
    seq: 31, operationId: 'stale-accept', targetRevision: 0,
    change: acceptChange(), sessionId: 'session-1', at: reviewedAt, featureId: acceptedFeatureId,
  })
  assert.equal(stale.revision, 1)
  assert.equal(stale.diagnostics.at(-1).code, 'stale-revision')
  const existing = settleUserChange(state, {
    seq: 31, operationId: 'user-create', targetRevision: 1,
    change: { op: 'annotation-create', geometry: { type: 'Point', coordinates: [100, 40] }, name: 'User' },
    sessionId: 'session-1', at, featureId: acceptedFeatureId,
  })
  const after = settleUserChange(existing, {
    seq: 32, operationId: 'late-accept', targetRevision: 1,
    change: acceptChange({ expectedRevision: 2 }),
    sessionId: 'session-1', at: reviewedAt, featureId: 'ann-0123456789abcdef01234568',
  })
  assert.equal(after.revision, 2)
  assert.equal(after.visualChanges[0].status, 'proposed')
  assert.equal(after.diagnostics.at(-1).code, 'stale-revision')
  assert.equal(after.layers[0].data.features[0].properties.name, 'User')
  const unknown = settleUserChange(state, {
    seq: 32, operationId: 'unknown-accept', targetRevision: 1,
    change: acceptChange({ changeId: otherChangeId }), sessionId: 'session-1', at: reviewedAt, featureId: acceptedFeatureId,
  })
  assert.equal(unknown.revision, 1)
  assert.equal(unknown.diagnostics.at(-1).code, 'comparison-unknown')
})

test('checkpoint replay restores a visual-change decision without external work', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('visual-change-replay')
    const state = rig.state(session)
    const withChange = {
      ...state, revision: 1,
      visualChanges: [change()],
      observationHistory: wire().observationHistory,
    }
    assert.equal(mapProjectionStateSchema.safeParse(withChange).success, true)
    const accepted = settleUserChange(withChange, {
      seq: 30, operationId: 'accept-replay', targetRevision: 1,
      change: acceptChange(), sessionId: 'session-1', at: reviewedAt, featureId: acceptedFeatureId,
    })
    assert.equal(accepted.visualChanges[0].status, 'accepted')
    assert.equal(accepted.layers[0].role, 'user-annotation')
    assert.equal(accepted.observationRequest, null, 'recovery never requests a screenshot')
    assert.equal(accepted.observationHistory.length, 2, 'recovery keeps both persisted image records')
    assert.equal(accepted.latestObservation, null, 'recovery never requests a new observation')
  } finally { await rig.dispose() }
})

test('change panel keeps identity after other-group work and exposes sibling actions', async tContext => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
  const saved = new Map()
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'Document', 'Event', 'CustomEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'UIEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: dom.window[name] })
  }
  tContext.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[name]
      else Object.defineProperty(globalThis, name, descriptor)
    }
    dom.window.close()
  })
  const container = dom.window.document.createElement('div')
  dom.window.document.body.append(container)
  const submitted = []
  const t = (key, params) => {
    const template = en[key] ?? key
    return params === undefined ? template : template.replace(/\{(\w+)\}/gu, (_whole, name) => params[name] ?? '')
  }
  const root = createRoot(container)
  const render = view => act(() => root.render(createElement(LayerPanel, {
    wire: view,
    sessionId: 'session-1',
    occurrenceKey: 'occ-1',
    occurrence: () => null,
    t,
    useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
    panelSubmit: undefined,
    imageUrl: async (_sessionId, ref) => `blob:${ref.attachmentId}`,
    changeSubmit: async input => { submitted.push(input); return { ok: true, revision: input.revision + 1 } },
  })))
  const click = async node => { await act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) }) }
  const twoChanges = [change(), change('rejected', { changeId: otherChangeId })]
  await render(wire(twoChanges))
  const firstRow = container.querySelector(`[data-change-id="${changeId}"]`)
  const select = firstRow.querySelector('[data-map-panel-change-select]')
  await click(select)
  assert.equal(select.getAttribute('aria-haspopup'), 'dialog')
  assert.equal(dom.window.document.querySelector('[role="dialog"][aria-modal="true"]') !== null, true)
  assert.equal(dom.window.document.querySelector('[data-map-panel-change-editor]') !== null, true)
  assert.equal(firstRow.querySelector('[data-map-panel-change-accept]'), null, 'review actions stay in the dialog')
  assert.equal(firstRow.querySelector('[data-map-panel-change-select] button'), null, 'no nested interactive button')
  const sources = [...dom.window.document.querySelectorAll('[data-map-panel-change-source]')]
  assert.equal(sources.length, 2)
  await click(sources[0])
  await click(sources[1])
  await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() })
  assert.deepEqual([...dom.window.document.querySelectorAll('[data-map-panel-change-preview] img')].map(img => img.getAttribute('src')),
    [`blob:${beforeId}`, `blob:${afterId}`])

  await render(wire(twoChanges, { revision: 2, layers: [{ id: 'other', name: 'Other', data: { type: 'FeatureCollection', features: [] }, sourceCrs: 'EPSG:4326', opacity: 1, visible: true }] }))
  const kept = container.querySelector(`[data-change-id="${changeId}"] [data-map-panel-change-select]`)
  assert.equal(dom.window.document.querySelector('[role="dialog"][aria-modal="true"]') !== null, true, 'a different layer keeps the dialog identity')
  assert.equal(container.querySelector(`[data-change-id="${otherChangeId}"]`).getAttribute('data-status'), 'rejected')
  const name = dom.window.document.querySelector('[data-map-panel-change-name]')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(name, 'Checked building')
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  const accept = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === t('panel.proposal.accept'))
  assert.equal(accept.disabled, false)
  accept.focus()
  await act(async () => { accept.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await click(accept)
  await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() })
  assert.equal(submitted.length, 1, 'Enter/Space on the sibling action does not trigger the parent selection')
  assert.deepEqual(submitted[0].change, {
    op: 'visual-change-accept', changeId, expectedRevision: 2, name: 'Checked building',
  })
  assert.equal(dom.window.document.querySelector('[role="dialog"][aria-modal="true"]'), null)
  await click(kept)
  const reject = [...dom.window.document.querySelectorAll('button')].find(button => button.textContent === t('panel.proposal.reject'))
  await click(reject)
  await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() })
  assert.equal(submitted.at(-1).change.op, 'visual-change-reject')
  act(() => root.unmount())
})
