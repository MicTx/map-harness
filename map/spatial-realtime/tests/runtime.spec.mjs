/**
 * Stream runtime fixtures: duplicate ids drop at admission, out-of-order
 * arrival lands in event-time windows, the watermark closes windows and late
 * events append new revisions (never mutating old ones), offline batches
 * model the disconnect, the intake buffer and per-advance quota bound memory
 * and work (backpressure holds the source back instead of growing), the
 * open-window bound stops processing loudly, closed-window retention evicts
 * with a count, data gaps materialize as `empty` — never interpolated — and
 * the whole machine replays deterministically with one bounded summary per
 * advance (never a per-event wake).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REALTIME_METHOD_VERSION, WINDOW_EVENT_FIXTURES } from '../src/contract.ts'
import { StreamRuntime } from '../src/runtime.ts'
import { encodeCheckpoint, decodeCheckpoint, resumeCheckpoint } from '../src/checkpoint.ts'

/** The shared 10 s-window / 5 s-lateness workbench over the canonical fixtures. */
function fixtureRuntime(overrides = {}) {
  const spec = {
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
  return StreamRuntime.open(spec, { batches: structuredClone(WINDOW_EVENT_FIXTURES) })
}

function event(eventId, eventTimeMs, value, lon = 116.4, lat = 39.9) {
  return { eventId, eventTimeMs, lon, lat, value }
}

test('duplicate event ids drop at admission and count, never fold twice', () => {
  const runtime = fixtureRuntime()
  const summary = runtime.advance(1_000)
  assert.equal(summary.advancedBatches, 1)
  assert.equal(summary.admitted, 1, 'one wire event admitted of two')
  assert.equal(summary.duplicatesDropped, 1, 'the re-delivered id dropped')
  assert.equal(summary.processed, 1)
  assert.equal(runtime.status().duplicatesDropped, 1)
  const windows = runtime.windowStates()
  assert.equal(windows.length, 1)
  assert.equal(windows[0].revisions[0].aggregate.count, 1, 'the duplicate never reached the aggregate')
  assert.equal(windows[0].revisions[0].aggregate.sum, 3)
})

test('the watermark closes windows, out-of-order arrival lands by event time, and late events append a new revision', () => {
  const runtime = fixtureRuntime()
  runtime.advance(1_000)
  // Batch 2 carries evt-b-2 (t=25s) before evt-b-1 (t=11s): after admission
  // the watermark sits at 25s − 5s = 20s, so evt-b-1 is late — its window
  // (10s..20s) never existed, so it materializes directly as a closed window.
  const second = runtime.advance(2_000)
  assert.equal(second.watermarkMs, 20_000)
  assert.equal(second.windowsClosed, 1, 'the 0..10s window closed behind the watermark')
  let windows = runtime.windowStates()
  const window0 = windows.find(window => window.startMs === 0)
  assert.equal(window0.status, 'closed')
  // Batch 3 delivers evt-late-1 (t=11.5s) into the closed 10..20s window:
  // a NEW revision appends; revision 1 stays exactly as it was.
  const third = runtime.advance(3_000)
  assert.equal(third.windowsRevised, 1)
  windows = runtime.windowStates()
  const revised = windows.find(window => window.startMs === 10_000)
  assert.equal(revised.status, 'revised')
  assert.equal(revised.revisions.length, 2)
  assert.deepEqual(
    { count: revised.revisions[0].aggregate.count, sum: revised.revisions[0].aggregate.sum },
    { count: 1, sum: 5 },
    'revision 1 is untouched by the late event',
  )
  assert.deepEqual(
    { count: revised.revisions[1].aggregate.count, sum: revised.revisions[1].aggregate.sum, mean: revised.revisions[1].aggregate.mean },
    { count: 2, sum: 12, mean: 6 },
    'revision 2 folds the late value in',
  )
  // Batch 4 is the offline disconnect: nothing admits, nothing processes.
  const fourth = runtime.advance(4_000)
  assert.equal(fourth.offlineBatches, 1)
  assert.equal(fourth.admitted, 0)
  assert.equal(fourth.processed, 0)
  assert.equal(runtime.status().offlineBatches, 1)
  assert.equal(runtime.status().sourceExhausted, true, 'the offline batch still advanced the source cursor')
})

test('a bounded revision ledger drops events beyond it and says so', () => {
  // A fresh workbench over the late-event sequence with a 2-revision ledger:
  // the closed 10..20s window takes revision 1 (late materialization) and
  // revision 2 (the first late arrival); the third arrival exceeds the
  // ledger, drops, and counts.
  const spec = {
    methodVersion: REALTIME_METHOD_VERSION,
    windowSizeMs: 10_000,
    allowedLatenessMs: 5_000,
    dedupCapacity: 128,
    bufferCapacity: 64,
    maxEventsPerAdvance: 32,
    maxOpenWindows: 8,
    maxRevisionsPerWindow: 2,
  }
  const beyond = StreamRuntime.open(spec, {
    batches: [
      { events: [event('evt-b-2', 25_000, 4, 116.41, 39.91), event('evt-b-1', 11_000, 5)] },
      { events: [event('evt-late-1', 11_500, 7, 116.42, 39.92)] },
      { events: [event('evt-late-2', 11_600, 9, 116.43, 39.93)] },
    ],
  })
  beyond.advance(1_000)
  const third = beyond.advance(2_000)
  assert.equal(third.windowsRevised, 1, 'the first late arrival appended revision 2')
  const fourth = beyond.advance(3_000)
  assert.equal(fourth.tooLateDropped, 1, 'the arrival beyond the ledger dropped with a count')
  const window = beyond.windowStates().find(entry => entry.startMs === 10_000)
  assert.equal(window.revisions.length, 2, 'the ledger stayed at its bound')
})

test('the per-advance quota rate-limits processing and the surplus stays buffered', () => {
  const runtime = fixtureRuntime({ maxEventsPerAdvance: 2 })
  const scoped = StreamRuntime.open(runtime.spec, {
    batches: [{ events: [event('e1', 1_000, 1), event('e2', 2_000, 2), event('e3', 3_000, 3), event('e4', 4_000, 4), event('e5', 5_000, 5)] }],
  })
  const first = scoped.advance(1_000)
  assert.equal(first.admitted, 5, 'the intake buffer holds the whole batch')
  assert.equal(first.processed, 2, 'the quota processed only two')
  assert.equal(first.rateLimited, true, 'the advance reports the quota truncation')
  assert.equal(scoped.status().bufferLength, 3)
  const second = scoped.advance(2_000)
  assert.equal(second.advancedBatches, 0, 'the source is exhausted; only the buffer drains')
  assert.equal(second.processed, 2)
  assert.equal(second.rateLimited, true)
  const third = scoped.advance(3_000)
  assert.equal(third.processed, 1)
  assert.equal(third.rateLimited, false)
  assert.equal(scoped.status().processed, 5)
  assert.equal(scoped.status().bufferLength, 0)
})

test('a full intake buffer holds the source back and memory stays bounded', () => {
  const runtime = fixtureRuntime({ bufferCapacity: 2, maxEventsPerAdvance: 32 })
  const scoped = StreamRuntime.open(runtime.spec, {
    batches: [{ events: Array.from({ length: 5 }, (_, at) => event(`e${at}`, (at + 1) * 1_000, at)) }],
  })
  const first = scoped.advance(1_000)
  assert.equal(first.admitted, 2, 'the buffer took only its capacity')
  assert.equal(first.heldByBackpressure, 3, 'the rest stayed at the source')
  assert.equal(first.rateLimited, false, 'processing drained the buffer within the quota')
  assert.equal(scoped.status().bufferLength, 0)
  // Each further advance admits at most two more events.
  const second = scoped.advance(2_000)
  assert.equal(second.admitted, 2)
  assert.equal(second.heldByBackpressure, 1)
  const third = scoped.advance(3_000)
  assert.equal(third.admitted, 1)
  assert.equal(third.heldByBackpressure, 0)
  assert.equal(scoped.status().processed, 5)
  assert.equal(scoped.status().admitted, 5)
})

test('a slow consumer (quota 1) keeps the buffer within its bound across advances', () => {
  const runtime = fixtureRuntime({ bufferCapacity: 4, maxEventsPerAdvance: 1 })
  const scoped = StreamRuntime.open(runtime.spec, {
    batches: [{ events: Array.from({ length: 6 }, (_, at) => event(`e${at}`, (at + 1) * 1_000, at)) }],
  })
  for (let step = 1; step <= 6; step += 1) {
    const summary = scoped.advance(step * 1_000)
    assert.ok(scoped.status().bufferLength <= 4, `the buffer never exceeds its bound at step ${step}`)
    assert.ok(summary.processed <= 1, 'the quota caps processing per advance')
  }
  assert.equal(scoped.status().processed, 6)
  assert.equal(scoped.status().admitted, 6)
  assert.equal(scoped.status().bufferLength, 0)
})

test('the open-window bound stops processing loudly with the event left buffered', () => {
  const runtime = fixtureRuntime({ windowSizeMs: 1_000, allowedLatenessMs: 10_000, maxOpenWindows: 2, maxEventsPerAdvance: 32 })
  const scoped = StreamRuntime.open(runtime.spec, {
    batches: [{ events: [event('e1', 0, 1), event('e2', 2_000, 2), event('e3', 4_000, 3)] }],
  })
  const summary = scoped.advance(1_000)
  assert.equal(summary.openWindowBoundReached, true, 'the third window key refused')
  assert.equal(summary.processed, 2)
  assert.equal(scoped.status().bufferLength, 1, 'the refused event stays buffered, never dropped')
  assert.equal(scoped.status().openWindows, 2)
})

test('closed-window retention evicts the oldest conclusions with a count', () => {
  const runtime = fixtureRuntime({ windowSizeMs: 1_000, allowedLatenessMs: 0, maxOpenWindows: 2, bufferCapacity: 128, maxEventsPerAdvance: 128 })
  const events = Array.from({ length: 70 }, (_, at) => event(`e${at}`, at * 1_000, at))
  const scoped = StreamRuntime.open(runtime.spec, { batches: [{ events }] })
  const summary = scoped.advance(1_000)
  assert.equal(summary.evictedClosedWindows, 4, '70 live windows trimmed to maxOpenWindows + retention')
  const status = scoped.status()
  assert.equal(status.evictedClosedWindows, 4)
  assert.equal(status.openWindows, 1, 'the newest window stays open behind the watermark')
  const windows = scoped.windowStates()
  assert.equal(windows[0].startMs, 4_000, 'the four oldest closed windows evicted in start order')
  assert.equal(windows.length, 66)
})

test('data gaps materialize as empty windows, never interpolated, and render no feature', () => {
  const runtime = fixtureRuntime({ windowSizeMs: 1_000, allowedLatenessMs: 1_000 })
  const scoped = StreamRuntime.open(runtime.spec, {
    batches: [{ events: [event('e1', 1_000, 1)] }, { events: [event('e2', 5_000, 2)] }],
  })
  scoped.advance(1_000)
  const summary = scoped.advance(2_000)
  assert.equal(summary.gapsClosed, 2, 'the 2000ms and 3000ms windows materialized as gaps')
  assert.equal(summary.windowsClosed, 1, 'the 1000ms window closed behind the watermark')
  const status = scoped.status()
  assert.equal(status.gapWindows, 2)
  const gap = scoped.windowStates().find(window => window.startMs === 2_000)
  assert.equal(gap.status, 'empty')
  assert.equal(gap.revisions[0].aggregate.count, 0, 'a gap carries a no-data revision, not invented data')
  const display = scoped.displayFeatures(1_024)
  assert.equal(display.length, 2, 'gap windows render no feature (2000/3000ms absent, 1000ms closed, 5000ms open)')
  assert.ok(display.every(feature => feature.properties.count > 0))
})

test('pause freezes the workbench and resume continues exactly', () => {
  const runtime = fixtureRuntime()
  runtime.advance(1_000)
  const before = runtime.status()
  runtime.pause()
  const paused = runtime.advance(2_000)
  assert.equal(paused.paused, true)
  assert.equal(paused.admitted, 0)
  assert.equal(paused.processed, 0)
  assert.deepEqual(
    { batchCursor: runtime.status().batchCursor, admitted: runtime.status().admitted, windows: runtime.windowStates().length },
    { batchCursor: before.batchCursor, admitted: before.admitted, windows: before.openWindows + before.closedWindows },
  )
  runtime.resume()
  const resumed = runtime.advance(3_000)
  assert.equal(resumed.paused, false)
  assert.equal(resumed.advancedBatches, 1, 'the source continues at the frozen cursor')
  assert.equal(runtime.status().admitted, 3, 'batch 2 admits its two unique events on top of batch 1')
})

test('the runtime replays deterministically: two runs fold to identical window state', () => {
  const run = () => {
    const runtime = fixtureRuntime()
    for (let step = 1; step <= 4; step += 1) runtime.advance(step * 1_000)
    return runtime.windowStates()
  }
  assert.deepEqual(run(), run())
})

test('the status face keeps the three clocks and the lag visible', () => {
  const runtime = fixtureRuntime()
  runtime.advance(1_000)
  runtime.advance(50_000)
  const status = runtime.status()
  assert.equal(status.methodVersion, REALTIME_METHOD_VERSION)
  assert.equal(status.maxEventTimeMs, 25_000, 'event time is source-domain time')
  assert.equal(status.lastIngestTimeMs, 50_000, 'ingest time is admission time')
  assert.equal(status.lastProcessTimeMs, 50_000, 'process time is advance time')
  assert.equal(status.lagMs, 25_000, 'lag = process time − max event time')
})

test('scenario and spec validation failures refuse construction with named codes', () => {
  const spec = {
    methodVersion: REALTIME_METHOD_VERSION,
    windowSizeMs: 10_000,
    allowedLatenessMs: 5_000,
    dedupCapacity: 8,
    bufferCapacity: 8,
    maxEventsPerAdvance: 8,
    maxOpenWindows: 4,
    maxRevisionsPerWindow: 4,
  }
  assert.throws(() => StreamRuntime.open({ ...spec, methodVersion: 'spatial-realtime@0' }, { batches: [{ events: [] }] }), /spec-invalid/)
  assert.throws(() => StreamRuntime.open(spec, { batches: [{ events: [{ eventId: 'x', eventTimeMs: 1, lon: 200, lat: 0, value: 1 }] }] }), /scenario-invalid/)
})

test('advanceLive admits a live batch through the same fold without touching the scenario', () => {
  const runtime = fixtureRuntime()
  const before = runtime.status()
  const summary = runtime.advanceLive(3_000, { events: [
    event('feed-a::e1', 30_000, 7, 116.41, 39.91),
    event('feed-b::e1', 31_000, 9, 116.42, 39.92),
  ] })
  assert.equal(summary.advancedBatches, 1)
  assert.equal(summary.admitted, 2)
  assert.equal(summary.processed, 2)
  const after = runtime.status()
  assert.equal(after.batchCursor, before.batchCursor, 'the scenario cursor never moved')
  assert.equal(after.admitted, 2, 'counters see the live events')
  assert.equal(after.maxEventTimeMs, 31_000)
  // The namespaced live ids fold into the same windows the scenario uses.
  const windows = runtime.windowStates()
  const live = windows.find(window => window.startMs === 30_000)
  assert.ok(live !== undefined, 'the live events opened a window')
  assert.equal(live.revisions[0].aggregate.count, 2)
})

test('advanceLive re-admission drops at-least-once redelivery as duplicates', () => {
  const runtime = StreamRuntime.open({
    methodVersion: REALTIME_METHOD_VERSION,
    windowSizeMs: 10_000,
    allowedLatenessMs: 5_000,
    dedupCapacity: 128,
    bufferCapacity: 64,
    maxEventsPerAdvance: 32,
    maxOpenWindows: 8,
    maxRevisionsPerWindow: 4,
  }, { batches: [{ events: [] }] })
  const first = runtime.advanceLive(1_000, { events: [event('src-1::evt-0', 1_000, 5)] })
  assert.equal(first.admitted, 1)
  // The fusion engine re-pulled after a mid-stream failure: same ids, at-least-once.
  const replay = runtime.advanceLive(2_000, { events: [event('src-1::evt-0', 1_000, 5), event('src-1::evt-1', 2_000, 6)] })
  assert.equal(replay.admitted, 1)
  assert.equal(replay.duplicatesDropped, 1)
  assert.equal(runtime.status().duplicatesDropped, 1)
})

test('advanceLive offline rounds count and change nothing else', () => {
  const runtime = StreamRuntime.open({
    methodVersion: REALTIME_METHOD_VERSION,
    windowSizeMs: 10_000,
    allowedLatenessMs: 5_000,
    dedupCapacity: 128,
    bufferCapacity: 64,
    maxEventsPerAdvance: 32,
    maxOpenWindows: 8,
    maxRevisionsPerWindow: 4,
  }, { batches: [{ events: [] }] })
  const summary = runtime.advanceLive(1_000, { offline: true, events: [] })
  assert.equal(summary.offlineBatches, 1)
  assert.equal(summary.admitted, 0)
  assert.equal(runtime.status().offlineBatches, 1)
})

test('advanceLive backpressure counts the refused tail and drops it from the runtime', () => {
  const runtime = StreamRuntime.open({
    methodVersion: REALTIME_METHOD_VERSION,
    windowSizeMs: 10_000,
    allowedLatenessMs: 5_000,
    dedupCapacity: 128,
    bufferCapacity: 2,
    maxEventsPerAdvance: 1,
    maxOpenWindows: 8,
    maxRevisionsPerWindow: 4,
  }, { batches: [{ events: [] }] })
  const summary = runtime.advanceLive(1_000, { events: [
    event('s::1', 1_000, 1),
    event('s::2', 2_000, 2),
    event('s::3', 3_000, 3),
    event('s::4', 4_000, 4),
  ] })
  assert.equal(summary.admitted, 2, 'the intake buffer took exactly its capacity')
  assert.equal(summary.heldByBackpressure, 2, 'the refused tail is the caller\'s to hold')
  assert.equal(runtime.status().heldByBackpressure, 2)
  // A later round re-releases the held tail; the taken ids dedup away.
  const next = runtime.advanceLive(2_000, { events: [
    event('s::3', 3_000, 3),
    event('s::4', 4_000, 4),
  ] })
  assert.ok(next.admitted >= 1, 'the re-release lands once the buffer drained')
})

test('advanceLive refuses malformed batches loudly and leaves the workbench unchanged', () => {
  const runtime = fixtureRuntime()
  runtime.advance(1_000)
  const before = JSON.stringify(runtime.status())
  assert.throws(() => runtime.advanceLive(2_000, { events: 'nope' }), /scenario-append-invalid/)
  assert.throws(() => runtime.advanceLive(2_000, { events: [{ eventId: '', eventTimeMs: 1, lon: 0, lat: 0, value: 1 }] }), /scenario-append-invalid/)
  assert.throws(() => runtime.advanceLive(Number.NaN, { events: [] }), /spec-invalid/)
  assert.equal(JSON.stringify(runtime.status()), before, 'a refused live batch changed nothing')
})

test('a paused workbench blanks advanceLive like it blanks advance', () => {
  const runtime = fixtureRuntime()
  runtime.pause()
  const summary = runtime.advanceLive(5_000, { events: [event('s::1', 1_000, 1)] })
  assert.equal(summary.advancedBatches, 0)
  assert.equal(summary.admitted, 0)
  assert.equal(summary.paused, true)
  assert.equal(runtime.status().bufferLength, 0)
})

test('live events survive a checkpoint round-trip in the buffer they already occupy', () => {
  const runtime = StreamRuntime.open({
    methodVersion: REALTIME_METHOD_VERSION,
    windowSizeMs: 10_000,
    allowedLatenessMs: 5_000,
    dedupCapacity: 128,
    bufferCapacity: 64,
    // Quota 1: one live event stays buffered when the advance ends, which is
    // exactly the state a mid-stream checkpoint would freeze.
    maxEventsPerAdvance: 1,
    maxOpenWindows: 8,
    maxRevisionsPerWindow: 4,
  }, { batches: [{ events: [] }] })
  runtime.advanceLive(1_000, { events: [event('live::a', 1_000, 4), event('live::b', 2_000, 6)] })
  const statusBefore = runtime.status()
  const decoded = decodeCheckpoint(encodeCheckpoint(runtime))
  assert.equal(decoded.status, 'ok')
  const restored = resumeCheckpoint(decoded.checkpoint)
  assert.equal(restored.status().admitted, statusBefore.admitted)
  const summary = restored.advance(2_000)
  assert.equal(summary.processed, 1, 'the restored buffer still folds the buffered live event')
})
