/**
 * `spatial-realtime@1` contract fixtures: spec and scenario validation
 * refuses every malformed wire input with all reasons named, the time
 * vocabulary keeps event/ingest/process time apart, and the window revision
 * digest pins exactly one window's content so two equal materializations are
 * recognizable and a changed one is not.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_ALLOWED_LATENESS_MS,
  MAX_DEDUP_CAPACITY,
  MAX_SCENARIO_BATCHES,
  MAX_SCENARIO_BATCH_EVENTS,
  MAX_WINDOW_SIZE_MS,
  REALTIME_METHOD_VERSION,
  WINDOW_EVENT_FIXTURES,
  windowRevisionDigestOf,
  validateStreamScenario,
  validateStreamSpec,
} from '../src/contract.ts'

/** A minimal valid spec to mutate per fixture. */
function validSpec(overrides = {}) {
  return {
    methodVersion: REALTIME_METHOD_VERSION,
    windowSizeMs: 10_000,
    allowedLatenessMs: 5_000,
    dedupCapacity: 128,
    bufferCapacity: 64,
    maxEventsPerAdvance: 32,
    maxOpenWindows: 8,
    maxRevisionsPerWindow: 4,
    ...overrides,
  }
}

test('spec validation refuses the method version and every out-of-bound field with all reasons named', () => {
  assert.deepEqual(validateStreamSpec(null), [{ field: 'spec', code: 'spec-required', message: 'the stream spec must be an object' }])
  const wrongVersion = validateStreamSpec({ ...validSpec(), methodVersion: 'spatial-realtime@0' })
  assert.equal(wrongVersion.length, 1)
  assert.equal(wrongVersion[0].code, 'method-version')
  const bad = validateStreamSpec(validSpec({
    windowSizeMs: 0,
    allowedLatenessMs: -1,
    dedupCapacity: 0,
    bufferCapacity: MAX_DEDUP_CAPACITY + 1,
    maxEventsPerAdvance: 0.5,
    maxOpenWindows: 0,
    maxRevisionsPerWindow: 1_000,
  }))
  assert.deepEqual(bad.map(issue => issue.code), [
    'window-size-bound',
    'lateness-bound',
    'dedup-capacity-bound',
    'buffer-capacity-bound',
    'quota-bound',
    'open-windows-bound',
    'revisions-bound',
  ])
  assert.ok(validateStreamSpec(validSpec({ windowSizeMs: MAX_WINDOW_SIZE_MS })).length === 0)
  assert.ok(validateStreamSpec(validSpec({ allowedLatenessMs: MAX_ALLOWED_LATENESS_MS })).length === 0)
})

test('scenario validation refuses missing, oversized, and malformed wire input', () => {
  assert.equal(validateStreamScenario(null)[0].code, 'scenario-required')
  assert.equal(validateStreamScenario({})[0].code, 'scenario-required')
  const tooManyBatches = validateStreamScenario({ batches: Array.from({ length: MAX_SCENARIO_BATCHES + 1 }, () => ({ events: [] })) })
  assert.equal(tooManyBatches[0].code, 'scenario-batches-bound')
  const bigBatch = { batches: [{ events: Array.from({ length: MAX_SCENARIO_BATCH_EVENTS + 1 }, () => null) }] }
  assert.equal(validateStreamScenario(bigBatch)[0].code, 'scenario-batch-events-bound')
  const malformed = validateStreamScenario({ batches: [{ events: [{ eventId: '', eventTimeMs: Number.NaN, lon: 200, lat: 95, value: Number.NaN }] }] })
  assert.equal(malformed[0].code, 'event-invalid')
  assert.match(malformed[0].message, /eventId/)
})

test('the duplicate/out-of-order/late/disconnect fixtures are all well-formed wire input', () => {
  // The four behaviors every downstream suite replays: re-delivered ids,
  // wire order that arrives out of event-time order, events beyond the
  // watermark, and an offline batch modeling the disconnect/reconnect pair.
  const issues = validateStreamScenario({ batches: WINDOW_EVENT_FIXTURES })
  assert.deepEqual(issues, [])
  const [duplicateBatch, outOfOrderBatch, lateBatch, offlineBatch] = WINDOW_EVENT_FIXTURES
  assert.equal(duplicateBatch.events[0].eventId, duplicateBatch.events[1].eventId, 'the duplicate fixture re-delivers one id')
  assert.ok(outOfOrderBatch.events[0].eventTimeMs > outOfOrderBatch.events[1].eventTimeMs, 'the out-of-order fixture arrives reversed')
  assert.ok(offlineBatch.offline === true, 'the disconnect fixture releases nothing')
  assert.equal(lateBatch.events[0].eventId, 'evt-late-1')
})

test('the window revision digest pins exactly one window revision', () => {
  const aggregate = { count: 2, sum: 7, min: 3, max: 4, mean: 3.5, meanLon: 116.4, meanLat: 39.9 }
  const first = windowRevisionDigestOf(1_000, 11_000, 1, aggregate)
  assert.equal(first, windowRevisionDigestOf(1_000, 11_000, 1, { ...aggregate }), 'equal content digests equal')
  assert.notEqual(first, windowRevisionDigestOf(1_000, 11_000, 2, aggregate), 'a new revision number is a new digest')
  assert.notEqual(first, windowRevisionDigestOf(11_000, 21_000, 1, aggregate), 'another window key is another digest')
  assert.notEqual(first, windowRevisionDigestOf(1_000, 11_000, 1, { ...aggregate, count: 3 }), 'a changed aggregate is another digest')
})
