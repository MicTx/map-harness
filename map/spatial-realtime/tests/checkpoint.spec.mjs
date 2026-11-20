/**
 * Checkpoint/resume and materialization fixtures: the full workbench state
 * encodes to a bounded checkpoint and resumes into a runtime that is
 * indistinguishable from an uninterrupted run, at-least-once redelivery
 * around the crash drops as duplicates, every malformed or tampered
 * checkpoint refuses with a named code (window revision digests are
 * re-verified, not trusted), exports are digest-pinned so a re-export of an
 * unchanged state recognizes itself, and a pinned report is never rewritten
 * by later revisions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REALTIME_METHOD_VERSION, WINDOW_EVENT_FIXTURES } from '../src/contract.ts'
import { StreamRuntime } from '../src/runtime.ts'
import {
  STREAM_CHECKPOINT_KIND,
  STREAM_CHECKPOINT_SCHEMA_VERSION,
  buildMaterializedExport,
  decodeCheckpoint,
  encodeCheckpoint,
  resumeCheckpoint,
} from '../src/checkpoint.ts'

function fixtureSpec(overrides = {}) {
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

function openFixtureRuntime(overrides = {}) {
  return StreamRuntime.open(fixtureSpec(overrides), { batches: structuredClone(WINDOW_EVENT_FIXTURES) })
}

test('a checkpoint resumes into a runtime indistinguishable from an uninterrupted run', () => {
  const uninterrupted = openFixtureRuntime()
  for (let step = 1; step <= 4; step += 1) uninterrupted.advance(step * 1_000)
  const finalStatus = uninterrupted.status()
  const finalWindows = uninterrupted.windowStates()

  const crashed = openFixtureRuntime()
  crashed.advance(1_000)
  crashed.advance(2_000)
  const checkpoint = encodeCheckpoint(crashed)
  const decoded = decodeCheckpoint(checkpoint)
  assert.equal(decoded.status, 'ok')
  const resumed = resumeCheckpoint(decoded.checkpoint)
  // The state faces agree exactly at the freeze point: windows, cursor, counters, clocks.
  assert.deepEqual(resumed.windowStates(), crashed.windowStates())
  assert.deepEqual(resumed.status(), crashed.status())
  // The remaining scenario replays identically after the resume.
  resumed.advance(3_000)
  resumed.advance(4_000)
  assert.deepEqual(resumed.windowStates(), finalWindows)
  assert.deepEqual(resumed.status(), finalStatus)
})

test('at-least-once redelivery after a resume drops as duplicates and leaves aggregates untouched', () => {
  // The reconnecting source replays batch 1 verbatim mid-stream: batch order
  // is deliver, deliver, re-deliver batch 1, late arrival.
  const runtime = StreamRuntime.open(fixtureSpec(), {
    batches: [
      structuredClone(WINDOW_EVENT_FIXTURES[0]),
      structuredClone(WINDOW_EVENT_FIXTURES[1]),
      structuredClone(WINDOW_EVENT_FIXTURES[0]),
      structuredClone(WINDOW_EVENT_FIXTURES[2]),
    ],
  })
  runtime.advance(1_000)
  runtime.advance(2_000)
  const checkpoint = encodeCheckpoint(runtime)
  const resumed = resumeCheckpoint(decodeCheckpoint(checkpoint).checkpoint)
  const redelivered = resumed.advance(3_000)
  assert.equal(redelivered.duplicatesDropped, 2, 'both re-delivered copies of evt-a-1 dropped')
  const windows = resumed.windowStates()
  assert.equal(windows.find(window => window.startMs === 0).revisions[0].aggregate.count, 1, 'the aggregate still holds one event')
  const revised = resumed.advance(4_000)
  assert.equal(revised.windowsRevised, 1, 'the stream continues normally after the redelivery')
})

test('decodeCheckpoint refuses every malformed or tampered record with a named code', () => {
  const runtime = openFixtureRuntime()
  runtime.advance(1_000)
  const checkpoint = encodeCheckpoint(runtime)
  assert.equal(decodeCheckpoint(null).code, 'invalid-checkpoint')
  assert.equal(decodeCheckpoint([]).code, 'invalid-checkpoint')
  assert.equal(decodeCheckpoint({ ...checkpoint, schemaVersion: 99 }).code, 'unknown-schema-version')
  assert.equal(decodeCheckpoint({ ...checkpoint, kind: 'other' }).code, 'unknown-kind')
  assert.equal(decodeCheckpoint({ ...checkpoint, methodVersion: 'spatial-realtime@0' }).code, 'method-version')
  const badSpec = decodeCheckpoint({ ...checkpoint, spec: { ...checkpoint.spec, windowSizeMs: -1 } })
  assert.equal(badSpec.code, 'invalid-checkpoint')
  const badScenario = decodeCheckpoint({ ...checkpoint, scenario: { batches: [] } })
  assert.equal(badScenario.code, 'invalid-checkpoint')
  // A tampered window aggregate no longer matches its pinned digest.
  const tampered = structuredClone(checkpoint)
  tampered.windows[0].revisions[0].aggregate.count = 99
  assert.equal(decodeCheckpoint(tampered).code, 'invalid-checkpoint')
  const badCounters = decodeCheckpoint({ ...checkpoint, counters: { ...checkpoint.counters, processed: -1 } })
  assert.equal(badCounters.code, 'invalid-checkpoint')
  const badCursor = decodeCheckpoint({ ...checkpoint, cursor: { batchIndex: 99, admittedInBatch: 0 } })
  assert.equal(badCursor.code, 'invalid-checkpoint')
})

test('an oversized checkpoint refuses to encode instead of growing without bound', () => {
  const spec = fixtureSpec({
    dedupCapacity: 65_536,
    bufferCapacity: 65_536,
    maxEventsPerAdvance: 65_536,
    maxOpenWindows: 4_096,
    maxRevisionsPerWindow: 64,
  })
  const batches = Array.from({ length: 34 }, (_, batch) => ({
    events: Array.from({ length: 256 }, (_, at) => ({
      eventId: `evt-${batch}-${at}-${'i'.repeat(100)}`,
      eventTimeMs: (batch * 256 + at) * 100,
      lon: 116.4,
      lat: 39.9,
      value: 1,
    })),
  }))
  const runtime = StreamRuntime.open(spec, { batches })
  for (let step = 0; step < 34; step += 1) runtime.advance(step + 1)
  assert.ok(runtime.status().dedupLength > 8_000, 'the dedup window filled far past the checkpoint budget')
  assert.throws(() => encodeCheckpoint(runtime), /oversized-checkpoint/)
})

test('the materialized export is digest-pinned: unchanged state re-recognizes itself, changed state is a new digest', () => {
  const runtime = openFixtureRuntime()
  runtime.advance(1_000)
  runtime.advance(2_000)
  const first = buildMaterializedExport(runtime, 2_000)
  assert.equal(first.status, 'ok')
  const again = buildMaterializedExport(runtime, 3_000)
  assert.equal(again.export.exportDigest, first.export.exportDigest, 'equal conclusions pin one digest even at another process time')
  // The late revision changes the 10..20s window: a new digest.
  runtime.advance(3_000)
  const afterRevision = buildMaterializedExport(runtime, 4_000)
  assert.notEqual(afterRevision.export.exportDigest, first.export.exportDigest)
  const revised = afterRevision.export.windows.find(window => window.startMs === 10_000)
  assert.equal(revised.revision, 2)
  assert.equal(revised.status, 'revised')
  assert.equal(first.export.windows.find(window => window.startMs === 10_000).revision, 1, 'the earlier export still cites revision 1')
})

test('a pinned export is never rewritten by later revisions (old reports stay fixed)', () => {
  const runtime = openFixtureRuntime()
  runtime.advance(1_000)
  runtime.advance(2_000)
  const pinned = buildMaterializedExport(runtime, 2_000)
  const snapshot = JSON.stringify(pinned.export)
  runtime.advance(3_000)
  runtime.advance(4_000)
  assert.equal(JSON.stringify(pinned.export), snapshot, 'the pinned export object is immutable')
  const fresh = buildMaterializedExport(runtime, 5_000)
  assert.notEqual(fresh.export.exportDigest, pinned.export.exportDigest)
})

test('exporting refuses before any window has closed', () => {
  const runtime = openFixtureRuntime({ allowedLatenessMs: 0 })
  runtime.advance(1_000)
  const refusal = buildMaterializedExport(runtime, 2_000)
  assert.equal(refusal.status, 'refused')
  assert.equal(refusal.code, 'export-empty')
})

test('the checkpoint round trip carries the recorded materializations for idempotent re-publish', () => {
  const runtime = openFixtureRuntime()
  runtime.advance(1_000)
  runtime.advance(2_000)
  const first = buildMaterializedExport(runtime, 2_000)
  runtime.recordMaterialization({ exportDigest: first.export.exportDigest, artifactRef: 'art-demo-1@v1', processMs: 2_000 })
  const checkpoint = encodeCheckpoint(runtime)
  const resumed = resumeCheckpoint(decodeCheckpoint(checkpoint).checkpoint)
  assert.equal(resumed.status().materializedCount, 1)
  assert.deepEqual(resumed.materializations, [{ exportDigest: first.export.exportDigest, artifactRef: 'art-demo-1@v1', processMs: 2_000 }])
})

test('the checkpoint constants stay wired (kind and version pin the wire format)', () => {
  assert.equal(STREAM_CHECKPOINT_KIND, 'spatial-realtime-checkpoint')
  assert.equal(STREAM_CHECKPOINT_SCHEMA_VERSION, 1)
})
