/**
 * Visual-proposal protocol fixtures: bounded model input, versioned meta
 * refusal, and the invariant that no missing field becomes inferred evidence.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_VISUAL_PROPOSAL_ITEMS,
  VISUAL_PROPOSAL_META_KIND,
  VISUAL_PROPOSAL_SCHEMA_VERSION,
  buildVisualProposalMeta,
  decodeVisualProposalMeta,
  parseVisualProposalItems,
} from '../src/visual-proposal-protocol.ts'

const item = (overrides = {}) => ({
  kind: 'target',
  category: 'building',
  note: 'visible roof',
  confidence: 'likely',
  pixelGeometry: { type: 'point', point: [10, 20] },
  ...overrides,
})

const attachment = {
  attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 800, height: 600, sha256: 'a'.repeat(64),
}

const proposal = {
  proposalId: 'vprop-0123456789abcdef01234567',
  observationId: 'obs-1',
  observationAttachmentSha256: 'a'.repeat(64),
  observationAttachment: attachment,
  sourceCallId: 'call-1',
  sourceCallSeq: 4,
  mapRevision: 0,
  modelProvider: 'fixture',
  modelName: 'vision-model',
  purpose: 'target',
  category: 'building',
  note: 'visible roof',
  confidence: 'likely',
  pixelGeometry: { type: 'point', point: [10, 20] },
  geometry: { type: 'Point', coordinates: [100.1, 40.6] },
  status: 'proposed',
  createdAt: '2026-11-09T00:00:00.000Z',
  reviewedAt: null,
  humanEdited: false,
  acceptedFeatureId: null,
}

const meta = buildVisualProposalMeta({
  observationId: 'obs-1',
  callId: 'call-1',
  sourceCallSeq: 4,
  targetRevision: 0,
  purpose: 'target',
  modelProvider: 'fixture',
  modelName: 'vision-model',
  proposals: [proposal],
})

test('parseVisualProposalItems admits an empty honest result and each bounded geometry, and rejects hostile fields', () => {
  assert.deepEqual(parseVisualProposalItems([]), [])

  const admitted = parseVisualProposalItems([
    item(),
    item({ kind: 'sketch', confidence: 'uncertain', pixelGeometry: { type: 'polyline', points: [[1, 2], [3, 4]] } }),
    item({ pixelGeometry: { type: 'polygon', points: [[1, 2], [3, 2], [3, 4], [1, 2]] } }),
    item({ pixelGeometry: { type: 'bbox', corners: [[1, 2], [3, 2], [3, 4], [1, 4]] } }),
  ])
  assert.equal(admitted?.length, 4)
  for (const forbidden of [
    new Array(MAX_VISUAL_PROPOSAL_ITEMS + 1).fill(item()),
    [item({ confidence: 0.95 })],
    [item({ category: 'x'.repeat(513) })],
    [item({ note: '猫'.repeat(200) })],
    [item({ pixelGeometry: { type: 'point', point: [Number.NaN, 2] } })],
    [item({ pixelGeometry: { type: 'polyline', points: [[1, 2]] } })],
    [item({ pixelGeometry: { type: 'polygon', points: [[1, 2], [3, 2], [3, 4]] } })],
    [item({ pixelGeometry: { type: 'bbox', corners: [[1, 2], [3, 2], [3, 4]] } })],
    [item({ modelProvider: 'spoofed', accepted: true })],
    [item({ pixelGeometry: { type: 'point', point: [10, 20], url: 'https://example.invalid' } })],
  ]) assert.equal(parseVisualProposalItems(forbidden), undefined)
})

test('meta round trips with evidence limits and refuses unknown versions without defaults', () => {
  assert.equal(meta.kind, VISUAL_PROPOSAL_META_KIND)
  assert.equal(meta.schemaVersion, VISUAL_PROPOSAL_SCHEMA_VERSION)
  assert.equal(meta.record.observationKind, 'map-observation')
  assert.equal(meta.record.limitations.length, 3)
  assert.deepEqual(decodeVisualProposalMeta(meta), { status: 'ok', meta })
  assert.deepEqual(decodeVisualProposalMeta({ ...meta, schemaVersion: 2 }), { status: 'refused', code: 'unknown-schema-version' })
  assert.deepEqual(decodeVisualProposalMeta({ ...meta, kind: 'other' }), { status: 'refused', code: 'unknown-kind' })
  assert.deepEqual(decodeVisualProposalMeta({ ...meta, record: { ...meta.record, proposals: [{ ...proposal, acceptedFeatureId: 'ann-0123456789abcdef01234567' }] } }), { status: 'refused', code: 'invalid-meta' })
  assert.deepEqual(decodeVisualProposalMeta({ proposalId: proposal.proposalId }), { status: 'refused', code: 'unknown-kind' })
})

test('model self-assessment never becomes a probability and text bytes are bounded', () => {
  const parsed = parseVisualProposalItems([item({ confidence: 'likely' })])
  assert.equal(parsed?.[0]?.confidence, 'likely')
  assert.equal(Object.hasOwn(parsed?.[0] ?? {}, 'probability'), false)
  assert.equal(parseVisualProposalItems([item({ category: 'é'.repeat(257) })]), undefined)
})
