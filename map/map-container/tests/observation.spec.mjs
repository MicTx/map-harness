/**
 * Host observation registry: exact session/call/seq/revision pairing, the
 * opaque claim token, bounded pending waits and early claims, timeout,
 * cancellation, decline outcomes, dispose, and strict PNG admission through
 * the workspace sharp decoder. A wrong token or seq never consumes the wait.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { createMapObservationService, DEFAULT_OBSERVATION_LIMITS, serveObservationRequest } from '../src/observation.ts'
import { admitObservationPng } from '../src/observation-png.ts'
import { Config, resolveObservationConfig } from '../src/plugin.ts'
import {
  FIXED_BASEMAP_DESCRIPTOR,
  expectedObservationSources,
  decodeMapObservationMeta,
  buildMapObservationMeta,
  mapObservationCaptureSchema,
} from '../src/observation-protocol.ts'
import { initialMapProjectionState, observationCandidateOf } from '../src/protocol.ts'
import { createMapSourceCatalog } from '../src/sources.ts'

const selectedBasemap = createMapSourceCatalog(undefined, 'allow', {})
  .selection('esri-world-imagery', 'esri-world-boundaries-places').value

/** One real PNG (8x4) encoded through sharp — never a signature-only fake. */
async function realPngBase64(width = 8, height = 4) {
  const bytes = await sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer()
  return { base64: bytes.toString('base64'), bytes: Uint8Array.from(bytes), width, height }
}

/** Corrupt the compressed IDAT stream while preserving the PNG chunk structure. */
async function corruptIdatPngBase64() {
  const { bytes } = await realPngBase64()
  const png = Buffer.from(bytes)
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset)
    const kind = png.toString('ascii', offset + 4, offset + 8)
    if (kind === 'IDAT' && length > 0) {
      png[offset + 8 + Math.floor(length / 2)] ^= 0xff
      break
    }
    offset += length + 12
  }
  return png
}

/** Create one fresh host operation identity, deadline, signal, and trusted-current reader. */
function makeWait(overrides = {}) {
  const base = {
    sessionId: 's1',
    callId: 'call-1',
    requestSeq: 7,
    revision: 3,
    expiresAtMs: Date.now() + 5_000,
    ...overrides,
  }
  return {
    ...base,
    signal: overrides.signal ?? new AbortController().signal,
    readCurrent: Object.hasOwn(overrides, 'readCurrent') ? overrides.readCurrent : () => ({
      request: { callId: base.callId, requestSeq: base.requestSeq, revision: base.revision },
      revision: base.revision,
      sources: [FIXED_BASEMAP_DESCRIPTOR],
      captureAllowed: true,
    }),
  }
}

const capture = async () => {
  const { base64 } = await realPngBase64()
  return {
    renderedRevision: 3, viewId: 'view-1', generation: 1, cameraEpoch: 2, gestureEpoch: 0,
    imageSize: { width: 8, height: 4 }, mapContentRect: { x: 0, y: 0, width: 8, height: 4 },
    cssViewSize: { width: 8, height: 4 },
    camera: null, georeference: { kind: 'none', reason: 'unreadable-camera' },
    sources: [FIXED_BASEMAP_DESCRIPTOR],
    includedOverlays: ['attribution'], pngBase64: base64,
  }
}

test('claim issues the token; the token is required for submission', async () => {
  const service = createMapObservationService()
  const operation = makeWait()
  const waiting = service.waitFor(operation)
  const claimed = await service.claim(operation)
  assert.equal(claimed.status, 'claimed')
  const wrong = await service.submit({ kind: 'capture', sessionId: 's1', callId: 'call-1', requestSeq: 7, revision: 3, token: 'bogus', capture: await capture() })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.code, 'wrong-token')
  assert.equal(service.pendingCount, 1)
  const ok = await service.submit({ kind: 'capture', sessionId: 's1', callId: 'call-1', requestSeq: 7, revision: 3, token: claimed.token, capture: await capture() })
  assert.equal(ok.ok, true)
  const outcome = await waiting
  assert.equal(outcome.status, 'observed')
  assert.equal(outcome.png.length > 0, true)
  assert.equal(outcome.revision, 3)
})

test('an early claim parks until waitFor admits it', async () => {
  const service = createMapObservationService()
  const operation = makeWait()
  const claiming = service.claim(operation)
  assert.equal(service.earlyClaimCount, 1)
  const waiting = service.waitFor(operation)
  const claimed = await claiming
  assert.equal(claimed.status, 'claimed')
  assert.equal(service.earlyClaimCount, 0)
  await service.submit({ kind: 'capture', sessionId: 's1', callId: 'call-1', requestSeq: 7, revision: 3, token: claimed.token, capture: await capture() })
  const outcome = await waiting
  assert.equal(outcome.status, 'observed')
})

test('identity mismatches refuse without consuming the wait', async () => {
  const service = createMapObservationService()
  const operation = makeWait()
  const waiting = service.waitFor(operation)
  const { token } = await service.claim(operation)
  const other = await service.submit({ kind: 'capture', sessionId: 's2', callId: 'call-1', requestSeq: 7, revision: 3, token, capture: await capture() })
  assert.equal(other.ok, false)
  assert.equal(other.code, 'no-pending-request')
  const wrongSeq = await service.submit({ kind: 'capture', sessionId: 's1', callId: 'call-1', requestSeq: 8, revision: 3, token, capture: await capture() })
  assert.equal(wrongSeq.code, 'no-pending-request')
  const wrongCall = await service.submit({ kind: 'capture', sessionId: 's1', callId: 'call-other', requestSeq: 7, revision: 3, token, capture: await capture() })
  assert.equal(wrongCall.code, 'no-pending-request')
  const stale = await service.submit({ kind: 'capture', sessionId: 's1', callId: 'call-1', requestSeq: 7, revision: 4, token, capture: { ...(await capture()), renderedRevision: 4 } })
  assert.equal(stale.code, 'stale-revision')
  assert.equal(service.pendingCount, 1)
  const ok = await service.submit({ kind: 'capture', sessionId: 's1', callId: 'call-1', requestSeq: 7, revision: 3, token, capture: await capture() })
  assert.equal(ok.ok, true)
  const outcome = await waiting
  assert.equal(outcome.status, 'observed')
})

test('false client source descriptors are malformed without consuming the valid wait', async () => {
  const service = createMapObservationService()
  const operation = makeWait()
  const waiting = service.waitFor(operation)
  const claimed = await service.claim(operation)
  const invalid = await service.submit({
    kind: 'capture',
    sessionId: operation.sessionId,
    callId: operation.callId,
    requestSeq: operation.requestSeq,
    revision: operation.revision,
    token: claimed.token,
    capture: {
      ...(await capture()),
      pngBase64: 'not canonical base64',
      sources: [{ ...FIXED_BASEMAP_DESCRIPTOR, id: 'client-invented-source' }],
    },
  })
  assert.equal(invalid.code, 'malformed')
  assert.equal(invalid.detail, 'the capture sources do not match the trusted map')
  assert.equal(service.pendingCount, 1)
  const valid = await service.submit({
    kind: 'capture',
    sessionId: operation.sessionId,
    callId: operation.callId,
    requestSeq: operation.requestSeq,
    revision: operation.revision,
    token: claimed.token,
    capture: await capture(),
  })
  assert.equal(valid.ok, true)
  assert.equal((await waiting).status, 'observed')
})

test('decline and cancel require the claim token; wrong tokens preserve the wait', async () => {
  const service = createMapObservationService()
  const operation = makeWait()
  const waiting = service.waitFor(operation)
  const claimed = await service.claim(operation)
  assert.equal(claimed.status, 'claimed')
  const wrongDecline = await service.submit({
    kind: 'decline', sessionId: 's1', callId: 'call-1', requestSeq: 7, token: 'wrong', code: 'not-ready',
  })
  assert.equal(wrongDecline.code, 'wrong-token')
  const wrongCancel = service.cancelWire({ sessionId: 's1', callId: 'call-1', requestSeq: 7, token: 'wrong' })
  assert.equal(wrongCancel.code, 'wrong-token')
  assert.equal(service.pendingCount, 1)
  assert.deepEqual(service.cancelWire({ sessionId: 's1', callId: 'call-1', requestSeq: 7, token: claimed.token }), { ok: true })
  assert.equal((await waiting).status, 'cancelled')
})

test('canonical base64 and full PNG decode reject bad padding, trailing bits, and corrupt bytes without settling', async () => {
  const service = createMapObservationService()
  const operation = makeWait()
  const waiting = service.waitFor(operation)
  const claimed = await service.claim(operation)
  const good = await capture()
  for (const pngBase64 of ['AQ=', 'AR==']) {
    const refusal = await service.submit({
      kind: 'capture', sessionId: 's1', callId: 'call-1', requestSeq: 7, revision: 3,
      token: claimed.token, capture: { ...good, pngBase64 },
    })
    assert.equal(refusal.code, 'malformed')
    assert.equal(service.pendingCount, 1)
  }
  const corruptBytes = await corruptIdatPngBase64()
  const corruptMetadata = await sharp(corruptBytes).metadata()
  assert.equal(corruptMetadata.format, 'png', 'the PNG header remains readable')
  const corrupt = await service.submit({
    kind: 'capture', sessionId: 's1', callId: 'call-1', requestSeq: 7, revision: 3,
    token: claimed.token, capture: { ...good, pngBase64: corruptBytes.toString('base64') },
  })
  assert.equal(corrupt.code, 'malformed')
  assert.match(corrupt.detail, /decode-failed/)
  assert.equal(service.pendingCount, 1)
  const accepted = await service.submit({
    kind: 'capture', sessionId: 's1', callId: 'call-1', requestSeq: 7, revision: 3,
    token: claimed.token, capture: good,
  })
  assert.equal(accepted.ok, true)
  assert.equal((await waiting).status, 'observed')
})

test('encoded, decoded-pixel, and dimension limits refuse before accepting the wait', async () => {
  const { base64, bytes } = await realPngBase64(16, 12)
  for (const limits of [
    { ...DEFAULT_OBSERVATION_LIMITS, maxBytes: 8 },
    { ...DEFAULT_OBSERVATION_LIMITS, maxPixels: 16 },
    { ...DEFAULT_OBSERVATION_LIMITS, maxDimension: 8 },
  ]) {
    const service = createMapObservationService(limits)
    const operation = makeWait()
    const waiting = service.waitFor(operation)
    const claimed = await service.claim(operation)
    const refusal = await service.submit({
      kind: 'capture', sessionId: 's1', callId: 'call-1', requestSeq: 7, revision: 3,
      token: claimed.token,
      capture: {
        ...(await capture()),
        imageSize: { width: 16, height: 12 },
        mapContentRect: { x: 0, y: 0, width: 16, height: 12 },
        cssViewSize: { width: 16, height: 12 },
        pngBase64: base64,
      },
    })
    assert.equal(refusal.code, 'oversized', `${JSON.stringify(limits)}: ${JSON.stringify(refusal)}`)
    assert.equal(service.pendingCount, 1)
    service.cancel({ sessionId: 's1', callId: 'call-1', requestSeq: 7 })
    assert.equal((await waiting).status, 'cancelled')
  }
  assert.ok(bytes.length > 8)
})

test('submit revalidates live state after decode and abort cannot publish a late capture', async () => {
  const service = createMapObservationService()
  let revision = 3
  const liveWait = makeWait({
    signal: new AbortController().signal,
    readCurrent: () => ({
      request: revision === 3 ? { callId: 'call-1', requestSeq: 7, revision: 3 } : null,
      revision,
      sources: [FIXED_BASEMAP_DESCRIPTOR],
      captureAllowed: true,
    }),
  })
  const waiting = service.waitFor(liveWait)
  const claimed = await service.claim(liveWait)
  const pendingSubmit = service.submit({
    kind: 'capture',
    sessionId: 's1', callId: 'call-1', requestSeq: 7, revision: 3,
    token: claimed.token, capture: await capture(),
  })
  revision = 4
  const refusal = await pendingSubmit
  assert.equal(refusal.ok, true, 'a changed trusted map resolves the wait as stale rather than accepting evidence')
  assert.equal((await waiting).status, 'stale')
  assert.equal(service.pendingCount, 0)

  const cancelService = createMapObservationService()
  const controller = new AbortController()
  const cancelWait = makeWait({ signal: controller.signal })
  const canceledOutcome = cancelService.waitFor(cancelWait)
  const cancelClaim = await cancelService.claim(cancelWait)
  const late = cancelService.submit({
    kind: 'capture', sessionId: 's1', callId: 'call-1', requestSeq: 7, revision: 3,
    token: cancelClaim.token, capture: await capture(),
  })
  controller.abort()
  assert.equal((await canceledOutcome).status, 'cancelled')
  assert.equal((await late).ok, false)
  assert.equal(cancelService.pendingCount, 0)
})

test('live source, permission, selection, and request replacement during decode settle stale independently', async () => {
  for (const change of ['sources', 'policy', 'basemap', 'request']) {
    const service = createMapObservationService()
    const current = {
      request: { callId: 'call-1', requestSeq: 7, revision: 3 },
      revision: 3,
      sources: [FIXED_BASEMAP_DESCRIPTOR],
      basemap: null,
      captureAllowed: true,
    }
    const operation = makeWait({ readCurrent: () => current })
    const waiting = service.waitFor(operation)
    const claim = await service.claim(operation)
    const pendingSubmit = service.submit({
      kind: 'capture',
      sessionId: operation.sessionId,
      callId: operation.callId,
      requestSeq: operation.requestSeq,
      revision: operation.revision,
      token: claim.token,
      capture: await capture(),
    })
    if (change === 'sources') current.sources = [{ ...FIXED_BASEMAP_DESCRIPTOR, version: 'replacement' }]
    if (change === 'policy') current.captureAllowed = false
    if (change === 'basemap') current.basemap = selectedBasemap
    if (change === 'request') current.request = { callId: 'replacement-call', requestSeq: 8, revision: 3 }
    assert.equal((await pendingSubmit).ok, true)
    assert.equal((await waiting).status, 'stale', change)
    assert.equal(service.pendingCount, 0)
  }
})

test('readCurrent is mandatory and throwing current reads fail closed without evidence', async () => {
  const service = createMapObservationService()
  assert.equal((await service.waitFor(makeWait({ readCurrent: undefined }))).status, 'stale')
  const throwingWait = makeWait({
    callId: 'call-throws-current',
    requestSeq: 12,
    readCurrent: () => { throw new Error('current state unavailable') },
  })
  const waiting = service.waitFor(throwingWait)
  const claim = await service.claim(throwingWait)
  assert.equal(claim.status, 'claimed')
  const result = await service.submit({
    kind: 'capture',
    sessionId: 's1',
    callId: throwingWait.callId,
    requestSeq: throwingWait.requestSeq,
    revision: 3,
    token: claim.token,
    capture: await capture(),
  })
  assert.equal(result.ok, true)
  assert.equal((await waiting).status, 'stale')
  assert.equal(service.pendingCount, 0)
})

test('a duplicate submit cannot race the one in-flight decoder', async () => {
  const service = createMapObservationService()
  const operation = makeWait()
  const waiting = service.waitFor(operation)
  const claimed = await service.claim(operation)
  const submission = {
    kind: 'capture',
    sessionId: 's1',
    callId: 'call-1',
    requestSeq: 7,
    revision: 3,
    token: claimed.token,
    capture: await capture(),
  }
  const first = service.submit(submission)
  const duplicate = await service.submit(submission)
  assert.equal(duplicate.code, 'busy')
  assert.equal((await first).ok, true)
  assert.equal((await waiting).status, 'observed')
})

test('decline resolves the wait with its honest code', async () => {
  const service = createMapObservationService()
  const operation = makeWait()
  const waiting = service.waitFor(operation)
  const claimed = await service.claim(operation)
  assert.equal(claimed.status, 'claimed')
  const verdict = await service.submit({ kind: 'decline', sessionId: 's1', callId: 'call-1', requestSeq: 7, token: claimed.token, code: 'not-ready' })
  assert.equal(verdict.ok, true)
  const outcome = await waiting
  assert.equal(outcome.status, 'declined')
  assert.equal(outcome.code, 'not-ready')
})

test('timeout, cancellation, and dispose all release the wait', async () => {
  const service = createMapObservationService()
  const expired = service.waitFor(makeWait({ expiresAtMs: Date.now() - 1 }))
  assert.equal((await expired).status, 'timeout')
  const controller = new AbortController()
  const cancelled = service.waitFor(makeWait({ signal: controller.signal }))
  controller.abort()
  assert.equal((await cancelled).status, 'cancelled')
  const hanging = service.waitFor(makeWait())
  service.dispose()
  assert.equal((await hanging).status, 'cancelled')
  assert.equal(service.pendingCount, 0)
})

test('bounds refuse additional pending waits and early claims', async () => {
  const service = createMapObservationService({ ...DEFAULT_OBSERVATION_LIMITS, maxPending: 1, maxEarlyClaims: 1 })
  void service.waitFor(makeWait())
  const second = await service.waitFor(makeWait({ requestSeq: 8 }))
  assert.equal(second.status, 'full')
  void service.claim(makeWait({ requestSeq: 9 }))
  const overflowing = await service.claim(makeWait({ requestSeq: 10 }))
  assert.equal(overflowing.status, 'full')
  service.dispose()
})

test('expired early claims do not block the matching live revision', async () => {
  let clock = 100
  const service = createMapObservationService(DEFAULT_OBSERVATION_LIMITS, () => clock)
  const early = service.claim(makeWait({ expiresAtMs: 110 }))
  const readCurrent = () => ({
    request: { callId: 'call-1', requestSeq: 7, revision: 3 },
    revision: 3,
    sources: [FIXED_BASEMAP_DESCRIPTOR],
    captureAllowed: true,
  })
  clock = 120
  const waitingOperation = makeWait({ expiresAtMs: 1_000, readCurrent })
  const waiting = service.waitFor(waitingOperation)
  assert.equal((await early).status, 'timeout')
  const nextClaim = await service.claim(waitingOperation)
  assert.equal(nextClaim.status, 'claimed')
  service.cancel({ sessionId: 's1', callId: 'call-1', requestSeq: 7 })
  assert.equal((await waiting).status, 'cancelled')
})

test('plugin observation config resolves defaults and refuses nonsense', () => {
  const resolved = resolveObservationConfig(undefined)
  assert.equal(resolved.capturePolicy, 'unverified')
  assert.equal(resolved.maxBytes, 8_388_608)
  assert.equal(resolved.maxPending, 64)
  assert.equal(Config.parse({ observation: { maxBytes: 1024 } }).observation.maxBytes, 1024)
  assert.throws(() => resolveObservationConfig({ observation: { maxBytes: 0 } }))
  assert.throws(() => resolveObservationConfig({ observation: { maxPending: 1025 } }))
  assert.throws(() => resolveObservationConfig({ observation: { capturePolicy: 'sometimes' } }))
})

test('admitObservationPng decodes real PNGs and refuses fakes and mismatches', async () => {
  const { bytes } = await realPngBase64(16, 12)
  const verdict = await admitObservationPng(bytes, DEFAULT_OBSERVATION_LIMITS, { width: 16, height: 12 })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.width, 16)
  assert.equal(verdict.sha256.length, 64)
  const mismatch = await admitObservationPng(bytes, DEFAULT_OBSERVATION_LIMITS, { width: 9, height: 9 })
  assert.equal(mismatch.code, 'dimension-mismatch')
  const signatureOnly = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
  const fake = await admitObservationPng(signatureOnly, DEFAULT_OBSERVATION_LIMITS)
  assert.equal(fake.ok, false)
  const oversized = await admitObservationPng(new Uint8Array(10), { maxBytes: 5, maxPixels: 16, maxDimension: 8 })
  assert.equal(oversized.code, 'oversized')
})

test('the single POST route accepts a fully paired untouched revision-zero capture', async () => {
  const service = createMapObservationService()
  const identity = { sessionId: 's0', callId: 'observe-zero', requestSeq: 0 }
  const request = {
    callId: identity.callId,
    requestSeq: identity.requestSeq,
    revision: 0,
  }
  const waiting = service.waitFor({
    ...identity,
    revision: 0,
    expiresAtMs: Date.now() + 5_000,
    signal: new AbortController().signal,
    readCurrent: () => ({ request, revision: 0, sources: [FIXED_BASEMAP_DESCRIPTOR], captureAllowed: true }),
  })
  const claimResponse = await serveObservationRequest(new Request('http://local/api/map/observation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'claim', ...identity, revision: 0, expiresAtMs: Date.now() + 5_000 }),
  }), service)
  const claim = await claimResponse.json()
  assert.equal(claim.status, 'claimed')
  const malformedResponse = await serveObservationRequest(new Request('http://local/api/map/observation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'capture', ...identity, revision: 0, token: claim.token, capture: null }),
  }), service)
  assert.equal(malformedResponse.status, 400)
  assert.equal(service.pendingCount, 1, 'malformed JSON cannot consume the matching wait')
  const image = await realPngBase64()
  const submitResponse = await serveObservationRequest(new Request('http://local/api/map/observation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'capture',
      ...identity,
      revision: 0,
      token: claim.token,
      capture: {
        renderedRevision: 0,
        viewId: 'view-zero',
        generation: 1,
        cameraEpoch: 0,
        gestureEpoch: 0,
        imageSize: { width: 8, height: 4 },
        mapContentRect: { x: 0, y: 0, width: 8, height: 4 },
        cssViewSize: { width: 8, height: 4 },
        camera: null,
        georeference: { kind: 'none', reason: 'unreadable-camera' },
        sources: [FIXED_BASEMAP_DESCRIPTOR],
        includedOverlays: ['attribution'],
        pngBase64: image.base64,
      },
    }),
  }), service)
  assert.equal((await submitResponse.json()).ok, true)
  const outcome = await waiting
  assert.equal(outcome.status, 'observed')
  assert.equal(outcome.revision, 0)
  assert.equal(outcome.capture.renderedRevision, 0)
})

test('the single POST route rejects unknown fields per action and keeps a valid wait', async () => {
  const service = createMapObservationService()
  const operation = makeWait()
  const waiting = service.waitFor(operation)
  const endpoint = async body => serveObservationRequest(new Request('http://local/api/map/observation', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), service)
  const identity = {
    sessionId: operation.sessionId,
    callId: operation.callId,
    requestSeq: operation.requestSeq,
    revision: operation.revision,
  }
  const claimDeadline = Date.now() + 5_000
  const badClaim = await endpoint({ action: 'claim', ...identity, expiresAtMs: claimDeadline, extra: true })
  assert.equal(badClaim.status, 400)
  const goodClaim = await endpoint({ action: 'claim', ...identity, expiresAtMs: claimDeadline })
  const claim = await goodClaim.json()
  assert.equal(claim.status, 'claimed')

  const goodCapture = await capture()
  for (const body of [
    { kind: 'capture', ...identity, token: claim.token, capture: goodCapture, extra: true },
    { kind: 'decline', sessionId: identity.sessionId, callId: identity.callId, requestSeq: identity.requestSeq, token: claim.token, code: 'not-ready', extra: true },
    { action: 'cancel', sessionId: identity.sessionId, callId: identity.callId, requestSeq: identity.requestSeq, token: claim.token, extra: true },
  ]) {
    assert.equal((await endpoint(body)).status, 400)
    assert.equal(service.pendingCount, 1)
  }
  const accepted = await endpoint({ kind: 'capture', ...identity, token: claim.token, capture: goodCapture })
  assert.equal((await accepted.json()).ok, true)
  assert.equal((await waiting).status, 'observed')
})

test('meta decode: kind gating, version refusal, and round-trip', () => {
  const record = {
    observationId: 'obs-x', callId: 'call-1', requestSeq: 7, mapRevision: 3,
    viewId: 'v', generation: 1, cameraEpoch: 0, gestureEpoch: 0,
    attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 8, height: 4, sha256: 'a'.repeat(64) },
    capturedAt: new Date().toISOString(),
    imageSize: { width: 8, height: 4 }, mapContentRect: { x: 0, y: 0, width: 8, height: 4 },
    cssViewSize: { width: 8, height: 4 }, camera: null,
    georeference: { kind: 'none', reason: 'unreadable-camera' },
    sources: [{ id: 'esri-world-imagery', kind: 'basemap', version: null, attribution: 'Source: Esri', policy: 'fixed' }],
    basemap: selectedBasemap,
    includedOverlays: ['attribution'], limitations: ['l1'],
  }
  const meta = buildMapObservationMeta(record)
  const decoded = decodeMapObservationMeta(meta)
  assert.equal(decoded.status, 'ok')
  assert.equal(decoded.record.observationId, 'obs-x')
  assert.equal(decodeMapObservationMeta({ kind: 'map-change' }).code, 'unknown-kind')
  assert.equal(decodeMapObservationMeta({ schemaVersion: 99, kind: 'map-observation', record }).code, 'unknown-schema-version')
  assert.equal(decodeMapObservationMeta({ schemaVersion: 1, kind: 'map-observation', record: { camera: 'x' } }).code, 'invalid-meta')
  assert.equal(decodeMapObservationMeta({
    schemaVersion: 1,
    kind: 'map-observation',
    record: { ...record, attachment: { ...record.attachment, width: 9 } },
  }).code, 'invalid-meta')
})

test('delegated observation version 4 binds a child identity and preserves prior readers', () => {
  const base = {
    observationId: 'obs-delegated', callId: 'call-1', requestSeq: 7, mapRevision: 3,
    viewId: 'v', generation: 1, cameraEpoch: 0, gestureEpoch: 0,
    attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 8, height: 4, sha256: 'a'.repeat(64) },
    capturedAt: '2026-11-15T00:00:00.000Z',
    imageSize: { width: 8, height: 4 }, mapContentRect: { x: 0, y: 0, width: 8, height: 4 },
    cssViewSize: { width: 8, height: 4 }, camera: null,
    georeference: { kind: 'none', reason: 'unreadable-camera' },
    sources: [FIXED_BASEMAP_DESCRIPTOR], basemap: null, includedOverlays: ['attribution'], limitations: [],
    composition: { schemaVersion: 1, digest: '12345678', layers: [] },
  }
  const direct = buildMapObservationMeta(base)
  assert.equal(direct.schemaVersion, 3)
  assert.equal(decodeMapObservationMeta(direct).status, 'ok')
  const delegated = { ...base, visualAnalysis: { provider: 'vision-provider', model: 'vision-model', childSessionId: 'child-1' } }
  const meta = buildMapObservationMeta(delegated)
  assert.equal(meta.schemaVersion, 4)
  assert.deepEqual(decodeMapObservationMeta(meta).record.visualAnalysis, delegated.visualAnalysis)
  assert.equal(decodeMapObservationMeta({ ...meta, schemaVersion: 3 }).code, 'invalid-meta')
  assert.equal(decodeMapObservationMeta({ ...meta, record: { ...delegated, visualAnalysis: undefined } }).code, 'invalid-meta')
  assert.equal(decodeMapObservationMeta({ ...meta, record: { ...delegated, visualAnalysis: { ...delegated.visualAnalysis, model: '' } } }).code, 'invalid-meta')
})

test('observation version 2 binds the accepted selection while version 1 stays historical', () => {
  const record = {
    observationId: 'obs-v2', callId: 'call-1', requestSeq: 7, mapRevision: 3,
    viewId: 'v', generation: 1, cameraEpoch: 0, gestureEpoch: 0,
    attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 8, height: 4, sha256: 'a'.repeat(64) },
    capturedAt: new Date().toISOString(),
    imageSize: { width: 8, height: 4 }, mapContentRect: { x: 0, y: 0, width: 8, height: 4 },
    cssViewSize: { width: 8, height: 4 }, camera: null,
    georeference: { kind: 'none', reason: 'unreadable-camera' },
    sources: [], includedOverlays: ['attribution'], limitations: ['l1'],
    basemap: selectedBasemap,
  }
  record.sources = expectedObservationSources([], selectedBasemap).sources
  assert.equal(decodeMapObservationMeta(buildMapObservationMeta(record)).status, 'ok')
  assert.equal(decodeMapObservationMeta({ schemaVersion: 2, kind: 'map-observation', record: { ...record, basemap: undefined } }).code, 'invalid-meta')
  assert.equal(decodeMapObservationMeta({ schemaVersion: 1, kind: 'map-observation', record }).code, 'invalid-meta')

  const state = {
    ...initialMapProjectionState(),
    revision: 3,
    basemap: selectedBasemap,
    observationRequest: { callId: 'call-1', requestSeq: 7, revision: 3, expiresAtMs: 1 },
  }
  assert.equal(observationCandidateOf(state, record).ok, true)
  assert.deepEqual(observationCandidateOf(state, { ...record, basemap: null }), { ok: false, code: 'observation-pairing' })
})

test('selected raster sources carry attribution, release identity, and exact screenshot policy', () => {
  const display = { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null }
  const allowed = expectedObservationSources([], selectedBasemap, display)
  assert.equal(allowed.hasUnverified, true)
  assert.deepEqual(allowed.sources.map(source => [source.id, source.policy]), [
    ['esri-world-imagery', 'approved'],
    ['esri-world-boundaries-places', 'unverified'],
  ])
  assert.equal(allowed.sources.every(source => source.attribution !== null), true)

  const unverified = createMapSourceCatalog(undefined, 'unverified', {})
  const selection = unverified.selection('esri-world-imagery', 'esri-world-boundaries-places').value
  const refused = expectedObservationSources([], selection, display)
  assert.equal(refused.hasUnverified, true)
  assert.deepEqual(refused.sources.map(source => source.policy), ['unverified', 'unverified'])
})

test('only visible positive-opacity raster sources enter a capture and an absent default label adds none', () => {
  const catalog = createMapSourceCatalog({ presets: {
    'amap-imagery-labels': { screenshot: 'allowed' },
  } }, 'allow', {})
  const labels = catalog.descriptorOf('amap-imagery-labels')
  const display = { labelsVisible: true, recentVisible: true, recentOpacity: 0, earlyVisible: false, earlySource: null }
  const captured = expectedObservationSources([], null, display, labels)
  assert.deepEqual(captured.sources.map(source => source.id), ['amap-imagery-labels'])
  assert.equal(captured.hasUnverified, false)
  const missingLabels = expectedObservationSources([], null, display, null)
  // Source licence is a readable fact, not a capture gate (remove-map-session-restrictions): an absent
  // default label contributes no source and no policy verdict.
  assert.equal(missingLabels.hasUnverified, false)
  assert.deepEqual(missingLabels.sources, [])
  const explicitWithoutLabels = catalog.selection('esri-world-imagery', null).value
  const explicit = expectedObservationSources([], explicitWithoutLabels, display, labels)
  assert.equal(explicit.hasUnverified, false, 'an explicit empty label selection renders no label source')
  assert.deepEqual(explicit.sources, [], 'the legacy default label is not applied to an explicit selection')
})

test('capture and durable record share strict camera, affine, size, rectangle, and attachment semantics', async () => {
  const base = await capture()
  const valid = {
    ...base,
    camera: {
      center: [0, 0],
      extent: [-10, -5, 10, 5],
      wkid: 3857,
      scale: 1,
      zoom: 2,
      rotation: 0,
      mode: 'map',
      padding: [0, 0, 0, 0],
    },
    georeference: { kind: 'affine-2d', coefficients: [1, 0, 0, 0, 1, 0], wkid: 3857, maxResidualCssPx: 0 },
  }
  assert.equal(mapObservationCaptureSchema.safeParse(valid).success, true)
  assert.equal(mapObservationCaptureSchema.safeParse({ ...valid, cssViewSize: { width: 0, height: 4 } }).success, false)
  assert.equal(mapObservationCaptureSchema.safeParse({ ...valid, mapContentRect: { x: 7, y: 0, width: 8, height: 4 } }).success, false)
  assert.equal(mapObservationCaptureSchema.safeParse({
    ...valid,
    camera: { ...valid.camera, mode: 'scene' },
  }).success, false)
  assert.equal(mapObservationCaptureSchema.safeParse({
    ...valid,
    georeference: { ...valid.georeference, coefficients: [1, 0, 0, 0, 0, 0] },
  }).success, false)
  assert.equal(mapObservationCaptureSchema.safeParse({
    ...valid,
    georeference: { ...valid.georeference, wkid: 4326 },
  }).success, false)
  assert.equal(mapObservationCaptureSchema.safeParse({
    ...base,
    georeference: { kind: 'none', reason: 'not-2d' },
  }).success, false)
})
