/**
 * Visual-proposal review fixtures: candidate UI derived from the wire,
 * atomic accept/reject/edit fold, CAS refusal, retry identity, and replay.
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
import { panelProposalsOf } from '../src/client/panel-view.ts'
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

const at = '2026-11-09T00:00:00.000Z'
const reviewedAt = '2026-11-09T00:01:00.000Z'
const proposalId = 'vprop-0123456789abcdef01234567'
const acceptedFeatureId = 'ann-0123456789abcdef01234567'

const sourceAttachment = {
  attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 10, width: 800, height: 600,
  name: 'map.png', sha256: 'a'.repeat(64),
}

const proposal = (status = 'proposed', overrides = {}) => ({
  proposalId,
  observationId: 'obs-1',
  observationAttachmentSha256: 'a'.repeat(64),
  observationAttachment: sourceAttachment,
  sourceCallId: 'markup-1',
  sourceCallSeq: 2,
  mapRevision: 1,
  modelProvider: 'fixture',
  modelName: 'vision-model',
  purpose: 'target',
  category: 'building',
  note: 'visible roof',
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

const wire = (proposals = [proposal()]) => ({
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
  latestObservation: {
    observationId: 'obs-1',
    attachment: {
      attachmentId: 'sha256:' + 'a'.repeat(64), bytes: 10, width: 800, height: 600, name: 'map.png',
    },
  },
  visualProposals: proposals,
})

function baseState(proposals = [proposal()]) {
  return {
    ...initialMapProjectionState(),
    visualProposals: proposals,
    revision: 1,
  }
}

function acceptChange(overrides = {}) {
  return {
    op: 'visual-proposal-accept', proposalId, expectedRevision: 1,
    ...overrides,
  }
}

function applyRecord(state, record, seq = 10) {
  const text = userChangeNoticeText('review proposal', record)
  assert.ok(text)
  return mapContainerProjectionDefinition.apply(state, {
    type: 'agent/inbox/spliced', seq, time: 0,
    data: { target: 'next-step', start: 0, inserted: [{
      id: 'notice', role: 'user', source: { kind: 'map-user-change', form: 'notice', summary: 'review proposal' },
      content: [{ type: 'text', text }],
    }] },
  })
}

test('candidate rows derive from projection records and review evidence persists', () => {
  const faces = panelProposalsOf(wire([proposal(), proposal('rejected', { proposalId: 'vprop-0123456789abcdef01234568' })]))
  assert.equal(faces.length, 2)
  assert.equal(faces[0].status, 'proposed')
  assert.equal(faces[0].sourceAttachment?.attachmentId, 'sha256:' + 'a'.repeat(64))
  assert.equal(faces[0].sourceAttachment?.mediaType, 'image/png')
  assert.equal(panelProposalsOf({ ...wire(), latestObservation: null })[0].sourceAttachment?.attachmentId,
    'sha256:' + 'a'.repeat(64), 'the candidate keeps its own persisted source image reference')
  assert.equal(faces[1].status, 'rejected')
  assert.equal(panelProposalsOf(wire([proposal('accepted')]))[0].humanEdited, false)
})

test('accept atomically creates one annotation and records human edits', () => {
  const state = baseState()
  const record = {
    operationId: 'accept-1', targetRevision: 1, sessionId: 'session-1', at: reviewedAt, featureId: acceptedFeatureId,
    change: acceptChange({ name: 'Verified building', description: 'human edited' }),
  }
  const next = applyRecord(state, record)
  assert.equal(next.revision, 2)
  assert.equal(next.visualProposals[0].status, 'accepted')
  assert.equal(next.visualProposals[0].humanEdited, true)
  assert.equal(next.visualProposals[0].acceptedFeatureId, acceptedFeatureId)
  assert.equal(next.layers.filter(layer => layer.role === 'visual-proposal').length, 0)
  const annotation = next.layers.find(layer => layer.role === 'user-annotation')
  assert.equal(annotation.data.features[0].id, acceptedFeatureId)
  assert.equal(annotation.data.features[0].properties.name, 'Verified building')
  assert.equal(annotation.data.features[0].properties.description, 'human edited')
  assert.equal(mapProjectionStateSchema.safeParse(next).success, true)
  assert.equal(applyRecord(next, record, 11).revision, 2, 'a retry does not create a second annotation')
})

test('reject keeps evidence, stale CAS refuses, and concurrent writes do not overwrite annotations', () => {
  const state = baseState()
  const rejected = applyRecord(state, {
    operationId: 'reject-1', targetRevision: 1, sessionId: 'session-1', at: reviewedAt,
    change: { op: 'visual-proposal-reject', proposalId, expectedRevision: 1 },
  })
  assert.equal(rejected.visualProposals[0].status, 'rejected')
  assert.equal(rejected.layers.filter(layer => layer.role === 'user-annotation').length, 0)
  assert.deepEqual(userChangeOfNoticeText(userChangeNoticeText('reject', {
    operationId: 'reject-2', targetRevision: 1, change: { op: 'visual-proposal-reject', proposalId, expectedRevision: 1 },
  }))?.change.op, 'visual-proposal-reject')
  const stale = settleUserChange(state, {
    seq: 11, operationId: 'stale-1', targetRevision: 0,
    change: acceptChange(), sessionId: 'session-1', at: reviewedAt, featureId: acceptedFeatureId,
  })
  assert.equal(stale.revision, 1)
  assert.equal(stale.diagnostics.at(-1).code, 'stale-revision')
  const existing = settleUserChange(state, {
    seq: 12, operationId: 'user-create', targetRevision: 1,
    change: { op: 'annotation-create', geometry: { type: 'Point', coordinates: [100, 40] }, name: 'User' },
    sessionId: 'session-1', at, featureId: acceptedFeatureId,
  })
  const after = settleUserChange(existing, {
    seq: 13, operationId: 'stale-accept', targetRevision: 1,
    change: acceptChange({ expectedRevision: 2 }),
    sessionId: 'session-1', at: reviewedAt, featureId: 'ann-0123456789abcdef01234568',
  })
  assert.equal(after.revision, 2)
  assert.equal(after.visualProposals[0].status, 'proposed')
  assert.equal(after.diagnostics.at(-1).code, 'stale-revision')
  assert.equal(after.layers[0].data.features[0].properties.name, 'User')
})

test('checkpoint replay restores candidate review and never re-runs model inference', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('proposal-replay')
    const state = rig.state(session)
    const withProposal = { ...state, revision: 1, visualProposals: [proposal()] }
    assert.equal(mapProjectionStateSchema.safeParse(withProposal).success, true)
    const accepted = settleUserChange(withProposal, {
      seq: 10, operationId: 'accept-1', targetRevision: 1,
      change: acceptChange(), sessionId: 'session-1', at: reviewedAt, featureId: acceptedFeatureId,
    })
    assert.equal(accepted.visualProposals[0].status, 'accepted')
    assert.equal(accepted.layers[0].role, 'user-annotation')
    assert.equal(accepted.latestObservation, null, 'recovery never requests a new observation')
    assert.equal(accepted.observationRequest, null, 'recovery never requests a screenshot')
  } finally { await rig.dispose() }
})

test('candidate panel exposes source, status, edit, accept, reject and keyboard', async tContext => {
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
  act(() => root.render(createElement(LayerPanel, {
    wire: wire(),
    sessionId: 'session-1',
    occurrenceKey: 'occ-1',
    occurrence: () => null,
    t,
    useResource: () => ({ status: 'loading', value: undefined, failure: undefined }),
    panelSubmit: undefined,
    imageUrl: async (sessionId, attachment) => {
      assert.equal(sessionId, 'session-1')
      assert.equal(attachment.attachmentId, 'sha256:' + 'a'.repeat(64))
      return 'blob:source-preview'
    },
    changeSubmit: async input => { submitted.push(input); return { ok: true, revision: input.revision + 1 } },
  })))
  const byText = text => [...dom.window.document.querySelectorAll('button')].find(node => node.textContent === text)
  const click = async node => { await act(async () => { node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })) }) }
  assert.equal(container.querySelector('[data-map-panel-proposal]').getAttribute('data-status'), 'proposed')
  assert.match(container.querySelector('[data-map-panel-pending-main] [data-tone="warning"]').textContent, /Pending review/)
  await click(container.querySelector('[data-map-panel-proposal-select]'))
  assert.equal(dom.window.document.querySelector('[role="dialog"][aria-modal="true"]')?.getAttribute('aria-label'), 'building')
  assert.equal(dom.window.document.querySelector('[data-map-panel-proposal-source]').tagName, 'BUTTON')
  await click(dom.window.document.querySelector('[data-map-panel-proposal-source]'))
  assert.equal(dom.window.document.querySelector('[data-map-panel-proposal-preview] img')?.getAttribute('src'), 'blob:source-preview')
  assert.match(dom.window.document.querySelector('[data-map-panel-proposal-preview] img')?.getAttribute('alt'), /building/u)
  await click(dom.window.document.querySelector('[data-map-panel-proposal-source]'))
  assert.equal(dom.window.document.querySelector('[data-map-panel-proposal-preview]'), null)
  const name = dom.window.document.querySelector('[data-map-panel-proposal-name]')
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(name, 'Checked building')
    name.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  await click(byText(t('panel.proposal.accept')))
  await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() })
  assert.equal(submitted.length, 1)
  assert.deepEqual(submitted[0].change, {
    op: 'visual-proposal-accept', proposalId, expectedRevision: 1, name: 'Checked building',
  })
  assert.equal(dom.window.document.querySelector('[role="dialog"][aria-modal="true"]'), null, 'successful review closes the dialog')
  await click(container.querySelector('[data-map-panel-proposal-select]'))
  await click(byText(t('panel.proposal.reject')))
  await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve() })
  assert.equal(submitted.at(-1).change.op, 'visual-proposal-reject')
  assert.equal(dom.window.document.querySelector('[role="dialog"][aria-modal="true"]'), null, 'successful rejection closes the dialog')
  await click(container.querySelector('[data-map-panel-proposal-select]'))
  const dialog = dom.window.document.querySelector('[role="dialog"][aria-modal="true"]')
  await act(async () => { dialog.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  assert.equal(dom.window.document.querySelector('[role="dialog"][aria-modal="true"]'), null, 'Escape closes the dialog')
  assert.ok(container.querySelector('[data-map-panel-proposal]'))
  act(() => root.unmount())
})
