/**
 * Independent control-point checks for visual proposal pixel geometry. The
 * affine coefficients are chosen so WGS84 output equals a simple pixel
 * transform; none of the expected coordinates come from the implementation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { visualProposalGeometryOf } from '../src/visual-proposal-math.ts'
import { scaleFromZoom } from '../src/view-policy.ts'

const observation = (overrides = {}) => ({
  observationId: 'obs-1',
  callId: 'obs-call',
  requestSeq: 1,
  mapRevision: 0,
  viewId: 'view-1',
  generation: 1,
  cameraEpoch: 0,
  gestureEpoch: 0,
  attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 800, height: 600, sha256: '0'.repeat(64) },
  capturedAt: '2026-11-09T00:00:00.000Z',
  imageSize: { width: 800, height: 600 },
  mapContentRect: { x: 100, y: 50, width: 600, height: 400 },
  cssViewSize: { width: 600, height: 400 },
  camera: {
    center: [110, 38], extent: [100, 30, 120, 46], wkid: 4326,
    scale: scaleFromZoom(6), zoom: 6, rotation: 0, mode: 'map', padding: [0, 0, 0, 0],
  },
  georeference: { kind: 'affine-2d', coefficients: [0.01, 0, 100, 0, -0.01, 40.8], wkid: 4326, maxResidualCssPx: 0 },
  sources: [{ id: 'esri-world-imagery', kind: 'basemap', version: null, attribution: 'Source: Esri', policy: 'fixed' }],
  includedOverlays: ['attribution'],
  limitations: [],
  ...overrides,
})

const map = point => [100 + point[0] * 0.01, 40.8 - point[1] * 0.01]

test('point, polyline, polygon and all four bbox corners use the frozen affine', () => {
  const point = [200, 100]
  assert.deepEqual(visualProposalGeometryOf(observation(), { type: 'point', point }), { type: 'Point', coordinates: map(point) })
  const line = [[200, 100], [300, 200]]
  assert.deepEqual(visualProposalGeometryOf(observation(), { type: 'polyline', points: line }), {
    type: 'LineString', coordinates: line.map(map),
  })
  const ring = [[200, 100], [300, 100], [300, 200], [200, 100]]
  assert.deepEqual(visualProposalGeometryOf(observation(), { type: 'polygon', points: ring }), {
    type: 'Polygon', coordinates: [ring.map(map)],
  })
  const corners = [[200, 100], [300, 100], [300, 200], [200, 200]]
  assert.deepEqual(visualProposalGeometryOf(observation(), { type: 'bbox', corners }), {
    type: 'Polygon', coordinates: [[...corners.map(map), map(corners[0])]],
  })
})

test('signature area, non-finite points, duplicate vertices and self-intersection refuse', () => {
  const current = observation()
  for (const pixel of [[0, 100], [99, 100], [700, 100], [200, 49], [200, 450]]) {
    assert.equal(visualProposalGeometryOf(current, { type: 'point', point: pixel }), 'outside-map')
  }
  assert.equal(visualProposalGeometryOf(current, { type: 'point', point: [Number.POSITIVE_INFINITY, 100] }), 'invalid-argument')
  assert.equal(visualProposalGeometryOf(current, { type: 'polyline', points: [[200, 100], [200, 100]] }), 'geometry-invalid')
  assert.equal(visualProposalGeometryOf(current, {
    type: 'polygon', points: [[200, 100], [300, 200], [300, 100], [200, 200], [200, 100]],
  }), 'geometry-invalid')
  assert.equal(visualProposalGeometryOf(current, {
    type: 'bbox', corners: [[200, 100], [300, 100], [200, 200], [300, 200]],
  }), 'geometry-invalid')
})

test('3D, scene, mismatched WKID, world wrap and non-affine evidence never approximate', () => {
  const scene = observation({ camera: { ...observation().camera, mode: 'scene' } })
  assert.equal(visualProposalGeometryOf(scene, { type: 'point', point: [200, 100] }), 'unsupported-georeference')
  assert.equal(visualProposalGeometryOf(observation({ camera: null, georeference: { kind: 'none', reason: 'unreadable-camera' } }), { type: 'point', point: [200, 100] }), 'unsupported-georeference')
  assert.equal(visualProposalGeometryOf(observation({ georeference: { kind: 'none', reason: 'not-2d' } }), { type: 'point', point: [200, 100] }), 'unsupported-georeference')
  const mismatched = observation({ georeference: { kind: 'affine-2d', coefficients: [0.01, 0, 100, 0, -0.01, 40.8], wkid: 3857, maxResidualCssPx: 0 } })
  assert.equal(visualProposalGeometryOf(mismatched, { type: 'point', point: [200, 100] }), 'unsupported-georeference')
  const wrapped = observation({ georeference: { kind: 'affine-2d', coefficients: [1, 0, 0, 0, -1, 0], wkid: 4326, maxResidualCssPx: 0 } })
  assert.equal(visualProposalGeometryOf(wrapped, { type: 'point', point: [200, 100] }), 'world-wrap')
})
