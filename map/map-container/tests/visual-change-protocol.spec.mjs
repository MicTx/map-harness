/**
 * V7 comparison-protocol fixtures: versioned history and comparison facts,
 * two-image evidence equality, and refusal paths that never infer missing
 * composition, fixed releases, or local acquisition dates.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { waybackDescriptor } from '../src/wayback.ts'
import { parseBasemapSelection } from '../../layers/src/basemap.ts'
import {
  MAX_MAP_OBSERVATION_HISTORY,
  MAP_PROJECTION_STATE_VERSION,
  initialMapProjectionState,
  mapProjectionStateSchema,
  observationCandidateOf,
} from '../src/protocol.ts'
import {
  buildMapObservationMeta,
  decodeMapObservationMeta,
  mapObservationRecordSchema,
  observationCompositionOf,
} from '../src/observation-protocol.ts'
import {
  buildVisualChangeMeta,
  buildVisualComparisonMeta,
  compareObservationEvidence,
  decodeVisualChangeMeta,
  decodeVisualComparisonMeta,
  parseVisualChangeItems,
  visualChangePairingCode,
  VISUAL_CHANGE_SCHEMA_VERSION,
  VISUAL_COMPARISON_META_KIND,
} from '../src/comparison-protocol.ts'
import { mapContainerProjectionDefinition } from '../src/projection.ts'

const sha = value => createHash('sha256').update(value).digest('hex')
const attachment = (value, overrides = {}) => ({
  attachmentId: `att-${value}`, mediaType: 'image/png', bytes: 100,
  width: 800, height: 600, sha256: sha(value), ...overrides,
})
const camera = {
  center: [116.4, 39.9], extent: [116.3, 39.8, 116.5, 40.0], wkid: 4326,
  scale: 50000, zoom: 12, rotation: 0, mode: 'map', padding: [0, 0, 0, 0],
}
const georeference = {
  kind: 'affine-2d', coefficients: [0.0001, 0, 116.3, 0, -0.0001, 40.0],
  wkid: 4326, maxResidualCssPx: 0,
}
const composition = observationCompositionOf([
  { id: 'pts', role: 'overlay', visible: true, opacity: 1, data: { type: 'FeatureCollection', features: [] } },
])
const release = (releaseId, publishedAt) => {
  const descriptor = waybackDescriptor({
    releaseId, itemId: `${releaseId}`.padEnd(32, '0'),
    title: `World Imagery (Wayback ${publishedAt.slice(0, 10)})`,
    publishedAt, layerIdentifier: `WB_${releaseId}_R01`, acquiredAt: null,
  })
  const parsed = parseBasemapSelection({ schemaVersion: 1, basemap: descriptor, labels: null })
  assert.equal(parsed.ok, true)
  return parsed.value
}
const source = (selection, index) => ({
  id: selection.basemap.id, kind: 'basemap', version: selection.basemap.release.version,
  attribution: selection.basemap.attribution, policy: 'approved',
})
const observation = (id, callId, requestSeq, basemap, overrides = {}) => ({
  observationId: id, callId, requestSeq, mapRevision: 1,
  viewId: 'view-1', generation: 1, cameraEpoch: 0, gestureEpoch: 0,
  attachment: attachment(id),
  capturedAt: '2026-11-10T00:00:00.000Z',
  imageSize: { width: 800, height: 600 },
  mapContentRect: { x: 0, y: 0, width: 800, height: 600 },
  cssViewSize: { width: 800, height: 600 },
  camera, georeference,
  sources: [source(basemap)],
  basemap,
  includedOverlays: ['attribution'], limitations: [],
  composition,
  ...overrides,
})

const beforeSelection = release('10', '2014-02-20T00:00:00.000Z')
const afterSelection = release('32246', '2026-01-26T00:00:00.000Z')
const before = observation('obs-before', 'obs-1', 3, beforeSelection)
const after = observation('obs-after', 'obs-2', 5, afterSelection)
const candidate = { before, after, beforeCallId: 'obs-1', afterCallId: 'obs-2' }

test('current projection generation carries bounded history and refuses stale rows', () => {
  assert.equal(MAP_PROJECTION_STATE_VERSION, 21)
  const state = initialMapProjectionState()
  assert.equal(state.observationHistory.length, 0)
  assert.equal(state.comparisons.length, 0)
  assert.equal(state.visualChanges.length, 0)
  assert.equal(mapProjectionStateSchema.safeParse({ ...state, stateVersion: 16 }).success, false)
  assert.equal(mapProjectionStateSchema.safeParse({ ...state, observationHistory: Array.from({ length: MAX_MAP_OBSERVATION_HISTORY + 1 }, () => before) }).success, false)
})

test('observation records persist exact composition only at version 3', () => {
  const meta = buildMapObservationMeta(before)
  assert.equal(meta.schemaVersion, 3)
  assert.deepEqual(decodeMapObservationMeta(meta), { status: 'ok', record: before })
  assert.equal(decodeMapObservationMeta({ ...meta, schemaVersion: 2 }).code, 'invalid-meta')
  assert.equal(decodeMapObservationMeta({ ...meta, record: { ...before, composition: undefined } }).code, 'invalid-meta')
  assert.equal(mapObservationRecordSchema.safeParse(before).success, true)
})

test('an accepted observation enters bounded history and replay re-folds it', () => {
  const init = mapContainerProjectionDefinition.init()
  const state = {
    ...init,
    revision: 1,
    basemap: beforeSelection,
    observationRequest: { callId: 'obs-1', requestSeq: 3, revision: 1, expiresAtMs: 1 },
  }
  const candidate = observationCandidateOf(state, before)
  assert.equal(candidate.ok, true)
  assert.equal(candidate.state.observationRequest, null)
  assert.equal(candidate.state.latestObservation.observationId, before.observationId)
  assert.equal(candidate.state.observationHistory.length, 1)
  assert.deepEqual(candidate.state.observationHistory[0], before)
  const replayed = observationCandidateOf(state, before)
  assert.equal(replayed.ok, true)
  assert.deepEqual(replayed.state.observationHistory, candidate.state.observationHistory)
})

test('old v1 and v2 observations remain readable as historical records', () => {
  const legacy = { ...before, basemap: undefined, composition: undefined }
  const meta = buildMapObservationMeta(legacy)
  assert.equal(meta.schemaVersion, 1)
  assert.equal(decodeMapObservationMeta(meta).status, 'ok')
  const v2 = { ...before, composition: undefined }
  const v2Meta = buildMapObservationMeta(v2)
  assert.equal(v2Meta.schemaVersion, 2)
  assert.equal(decodeMapObservationMeta(v2Meta).status, 'ok')
  assert.equal(compareObservationEvidence({ ...candidate, before: v2 }).code, 'missing-composition')
})

test('two fixed releases with one composition and image plane admit only limited comparisons', () => {
  const verdict = compareObservationEvidence(candidate)
  assert.equal(verdict.status, 'ok')
  assert.equal(verdict.comparability, 'limited')
  assert.ok(verdict.limitations.some(line => line.includes('acquisition dates are unknown')))
})

test('comparison refuses changed composition, view, affine, dates, release, and sources', () => {
  const refusal = (overrides, code) => assert.equal(compareObservationEvidence({ ...candidate, ...overrides }).code, code)
  refusal({ before: { ...before, composition: observationCompositionOf([]) } }, 'composition-changed')
  refusal({ before: { ...before, camera: { ...camera, center: [116.5, 39.9] } } }, 'view-changed')
  refusal({ before: { ...before, georeference: { ...georeference, coefficients: [0.0002, 0, 116.3, 0, -0.0002, 40.0] } } }, 'georeference-changed')
  refusal({ before: { ...before, georeference: { kind: 'none', reason: 'unreadable-camera' }, camera },
    after: { ...after, georeference: { kind: 'none', reason: 'unreadable-camera' }, camera } }, 'unsupported-georeference')
  refusal({ before: { ...before, basemap: release('32246', '2026-01-26T00:00:00.000Z') } }, 'same-image')
  refusal({ before: { ...before, sources: [{ ...source(beforeSelection), policy: 'unverified' }] } }, 'view-changed')
  const unverified = compareObservationEvidence({ ...candidate,
    before: { ...before, sources: [{ ...source(beforeSelection), policy: 'unverified' }] },
    after: { ...after, sources: [{ ...source(afterSelection), policy: 'unverified' }] },
  })
  assert.equal(unverified.status, 'ok')
  refusal({ before: { ...before, basemap: null } }, 'missing-fixed-release')
  refusal({ after: { ...after, basemap: release('7', '2011-02-01T00:00:00.000Z') } }, 'reverse-dates')
})

test('comparison meta round trips and refuses unknown or malformed versions', () => {
  const verdict = compareObservationEvidence(candidate)
  assert.equal(verdict.status, 'ok')
  const record = {
    comparisonId: 'vcompare-0123456789abcdef01234567',
    callId: 'compare-1', callSeq: 3,
    beforeObservationId: before.observationId,
    afterObservationId: after.observationId,
    beforeAttachmentSha256: before.attachment.sha256,
    afterAttachmentSha256: after.attachment.sha256,
    beforeRelease: {
      role: 'before', sourceId: 'esri-wayback', releaseId: '10',
      publishedAt: '2014-02-20T00:00:00.000Z', acquiredAt: null,
      acquisitionScope: 'unknown', overlayCount: 1, overlayVisible: true,
    },
    afterRelease: {
      role: 'after', sourceId: 'esri-wayback', releaseId: '32246',
      publishedAt: '2026-01-26T00:00:00.000Z', acquiredAt: null,
      acquisitionScope: 'unknown', overlayCount: 1, overlayVisible: true,
    },
    comparability: verdict.comparability,
    limitations: verdict.limitations,
    sourceKind: 'map-observation', sourceVersion: 3,
    composition, focus: null, createdAt: '2026-11-10T00:00:00.000Z',
  }
  const meta = buildVisualComparisonMeta(record)
  assert.equal(meta.kind, VISUAL_COMPARISON_META_KIND)
  assert.equal(meta.schemaVersion, VISUAL_CHANGE_SCHEMA_VERSION)
  assert.deepEqual(decodeVisualComparisonMeta(meta), record)
  assert.equal(decodeVisualComparisonMeta({ ...meta, schemaVersion: 1 }), null)
  assert.equal(decodeVisualComparisonMeta({ ...meta, record: { ...record, comparisonId: 'other' } }), null)
})

test('change items reject probabilities and malformed geometry; durable meta refuses inferred fields', () => {
  const item = {
    kind: 'appeared', category: 'building', note: 'new roof',
    confidence: 'likely', pixelGeometry: { type: 'point', point: [10, 20] },
  }
  assert.equal(parseVisualChangeItems([])?.length, 0)
  assert.equal(parseVisualChangeItems([item])?.length, 1)
  assert.equal(parseVisualChangeItems([{ ...item, confidence: 0.95 }]), undefined)
  assert.equal(parseVisualChangeItems([{ ...item, pixelGeometry: { type: 'point', point: [Number.NaN, 2] } }]), undefined)
  const change = {
    changeId: 'vchange-0123456789abcdef01234567',
    comparisonId: 'vcompare-0123456789abcdef01234567',
    beforeObservationId: before.observationId, afterObservationId: after.observationId,
    beforeAttachmentSha256: before.attachment.sha256, afterAttachmentSha256: after.attachment.sha256,
    observationAttachment: after.attachment,
    sourceCallId: 'change-1', sourceCallSeq: 7, mapRevision: 1,
    modelProvider: 'fixture', modelName: 'vision-model',
    kind: 'appeared', category: 'building', note: 'new roof', confidence: 'likely',
    pixelGeometry: item.pixelGeometry, geometry: { type: 'Point', coordinates: [116.4, 39.9] },
    status: 'proposed', createdAt: '2026-11-10T00:00:00.000Z',
    reviewedAt: null, humanEdited: false, acceptedFeatureId: null,
  }
  const meta = buildVisualChangeMeta({
    comparisonId: change.comparisonId, callId: change.sourceCallId,
    sourceCallSeq: change.sourceCallSeq, targetRevision: 1,
    modelProvider: 'fixture', modelName: 'vision-model',
    changes: [change], limitations: [],
  })
  assert.equal(decodeVisualChangeMeta(meta).status, 'ok')
  assert.equal(decodeVisualChangeMeta({ ...meta, schemaVersion: 1 }).code, 'unknown-schema-version')
  assert.equal(decodeVisualChangeMeta({ ...meta, kind: 'other' }).code, 'unknown-kind')
  assert.equal(decodeVisualChangeMeta({ ...meta, record: { ...meta.record, changes: [{ ...change, kind: 'scientific-fact' }] } }).code, 'invalid-meta')
  const comparison = {
    comparisonId: change.comparisonId, beforeObservationId: before.observationId,
    afterObservationId: after.observationId,
    beforeAttachmentSha256: before.attachment.sha256, afterAttachmentSha256: after.attachment.sha256,
    comparability: 'limited',
  }
  assert.equal(visualChangePairingCode({ revision: 1, comparisons: [comparison] }, meta, 'change-1', 7, []), null)
  assert.equal(visualChangePairingCode({ revision: 1, comparisons: [comparison] }, meta, 'foreign', 7, []), 'comparison-pairing')
})
