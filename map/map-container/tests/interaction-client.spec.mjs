/**
 * Browser interaction half: the fence distinguishes user takeover (gesture
 * epoch) from programmatic/foreign camera movement (camera epoch/layout), and
 * the claim/result wire bodies stay bounded and token-authenticated.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cameraMatchesObservation,
  claimMapUse,
  declineMapUse,
  fenceRefusalOf,
  submitMapUse,
} from '../src/client/map-use-client.ts'

const camera = {
  center: [104.9, 36.4], extent: [100, 32, 109.8, 40.8], wkid: 4326,
  scale: 100000, zoom: 6, rotation: 0, mode: 'map', padding: [0, 0, 0, 0],
}

const observation = {
  observationId: 'obs-1', callId: 'c', requestSeq: 1, mapRevision: 4,
  viewId: 'view-1', generation: 2, cameraEpoch: 3, gestureEpoch: 1,
  attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1, width: 8, height: 6, sha256: '0'.repeat(64) },
  capturedAt: '2026-11-06T00:00:00.000Z',
  imageSize: { width: 8, height: 6 }, mapContentRect: { x: 0, y: 0, width: 8, height: 6 },
  cssViewSize: { width: 800, height: 600 }, camera,
  georeference: { kind: 'affine-2d', coefficients: [0.01, 0, 100, 0, -0.01, 40.8], wkid: 4326, maxResidualCssPx: 0 },
  sources: [{ id: 's', kind: 'basemap', version: null, attribution: null, policy: 'fixed' }],
  includedOverlays: [], limitations: [],
}

const live = {
  viewId: 'view-1', generation: 2, mapRevision: 4, cameraEpoch: 3, gestureEpoch: 1,
  mode: 'map', width: 800, height: 600, padding: [0, 0, 0, 0], camera,
}

test('a live view that still matches the observation has no refusal', () => {
  assert.equal(fenceRefusalOf(observation, live), null)
  assert.equal(cameraMatchesObservation(camera, camera), true)
})

test('user takeover and programmatic movement stay distinguishable', () => {
  assert.equal(fenceRefusalOf(observation, { ...live, gestureEpoch: 2 }), 'user-interrupted')
  assert.equal(fenceRefusalOf(observation, { ...live, cameraEpoch: 4 }), 'stale')
  assert.equal(fenceRefusalOf(observation, { ...live, mode: 'scene' }), 'unsupported')
  assert.equal(fenceRefusalOf(observation, { ...live, mapRevision: 5 }), 'stale')
  assert.equal(fenceRefusalOf(observation, { ...live, viewId: 'view-2' }), 'stale')
  assert.equal(fenceRefusalOf(observation, { ...live, generation: 3 }), 'stale')
  assert.equal(fenceRefusalOf(observation, { ...live, width: 801 }), 'stale')
  assert.equal(fenceRefusalOf(observation, { ...live, padding: [1, 0, 0, 0] }), 'stale')
  assert.equal(fenceRefusalOf(observation, { ...live, camera: { ...camera, center: [105, 36.4] } }), 'stale')
})

test('camera comparison tolerates only floating-point noise', () => {
  const noisy = { ...camera, center: [104.90000000001, 36.39999999999] }
  assert.equal(cameraMatchesObservation(noisy, camera), true)
  assert.equal(cameraMatchesObservation({ ...camera, zoom: 7 }, camera), false)
  assert.equal(cameraMatchesObservation(null, camera), false)
  assert.equal(cameraMatchesObservation(null, null), true)
})

test('claim, submit, and decline use the bounded interaction route', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    if (calls.length === 1) return Response.json({ status: 'claimed', token: 'tok' })
    return Response.json({ ok: true })
  }
  try {
    const identity = { sessionId: 's', callId: 'c', requestSeq: 1 }
    const claim = await claimMapUse({ ...identity, expiresAtMs: Date.now() + 5000 }, new AbortController().signal)
    assert.deepEqual(claim, { status: 'claimed', token: 'tok' })
    assert.equal(await submitMapUse({ ...identity, token: 'tok' }, { status: 'validated' }, new AbortController().signal), true)
    assert.equal(await declineMapUse(identity, 'tok', 'user-interrupted', Date.now() + 5000), true)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(calls[0].url, '/api/map/use')
  assert.deepEqual(calls[0].body, { action: 'claim', sessionId: 's', callId: 'c', requestSeq: 1, expiresAtMs: calls[0].body.expiresAtMs })
  assert.deepEqual(calls[1].body, {
    action: 'result', sessionId: 's', callId: 'c', requestSeq: 1, token: 'tok',
    outcome: { status: 'validated' },
  })
  assert.deepEqual(calls[2].body, {
    action: 'result', sessionId: 's', callId: 'c', requestSeq: 1, token: 'tok',
    outcome: { status: 'declined', code: 'user-interrupted' },
  })
})
