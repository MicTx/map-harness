import test from 'node:test'
import assert from 'node:assert/strict'
import { StreamFusionEngine } from '../src/fusion.ts'

/** A scripted reader: each readRound pulls the next scripted step, never the wire. */
class ScriptedReader {
  state = 'unopened'
  lastBudget
  rounds = 0
  carried = []
  constructor(script) {
    this.script = script
  }

  async readRound(options) {
    this.rounds += 1
    this.lastBudget = options?.maxEventsPerFetch
    this.state = 'live'
    const step = this.script.length > 0 ? this.script.shift() : { events: [] }
    if (step.fail !== undefined) {
      this.state = 'failed'
      return { live: false, events: [], rejected: 0, ended: false, failure: { outcome: step.fail.outcome, detail: step.fail.detail } }
    }
    if (step.end === true) {
      this.state = 'ended'
      return { live: false, events: [], rejected: 0, ended: true }
    }
    // A reader honors its per-round budget, like the real source readers.
    const events = (step.events ?? []).slice(0, this.lastBudget)
    this.carried = [...this.carried, ...(step.events ?? []).slice(events.length)]
    return { live: true, events, rejected: 0, ended: false }
  }

  async close() {
    this.state = 'ended'
  }
}

const wire = (id, eventTimeMs, payload = 1) => ({ eventId: id, eventTimeMs, ingestTimeMs: eventTimeMs, payload })

const fusionSpec = (over = {}) => ({
  id: 'fusion-x',
  sources: ['src-a', 'src-b'],
  pendingCapacity: 8,
  maxEventsPerRelease: 8,
  ...over,
})

test('two sources fuse behind the lagging horizon', async () => {
  const fast = new ScriptedReader([
    { events: [wire('f1', 1_000), wire('f2', 9_000)] },
    { events: [wire('f3', 12_000)] },
  ])
  const slow = new ScriptedReader([{ events: [wire('s1', 5_000)] }, { events: [wire('s2', 11_000)] }, { end: true }])
  const engine = new StreamFusionEngine(fusionSpec(), [
    { sourceId: 'src-a', reader: fast },
    { sourceId: 'src-b', reader: slow },
  ])

  // Horizon = min(9000, 5000): f2 stays pending behind the laggard.
  const first = await engine.advance()
  assert.equal(first.horizonMs, 5_000)
  assert.deepEqual(first.releasedEvents.map(e => e.eventId), ['src-a::f1', 'src-b::s1'])
  assert.deepEqual(first.perSource.map(s => s.pendingLength), [1, 0])

  // Both maxima advance (12000, 11000): f3 (12000) still sits past the horizon.
  const second = await engine.advance()
  assert.equal(second.horizonMs, 11_000)
  assert.deepEqual(second.releasedEvents.map(e => e.eventId), ['src-a::f2', 'src-b::s2'])
  assert.equal(second.perSource.find(s => s.sourceId === 'src-a')?.pendingLength, 1)

  // src-b ends cleanly: a terminal source stops constraining, so f3 releases.
  const third = await engine.advance()
  assert.equal(third.horizonMs, 12_000)
  assert.deepEqual(third.releasedEvents.map(e => e.eventId), ['src-a::f3'])
  await engine.close()
})

test('release order is event time, then declaration, then arrival', async () => {
  const a = new ScriptedReader([{ events: [wire('a2', 7_000), wire('a1', 7_000)] }])
  const b = new ScriptedReader([{ events: [wire('b1', 7_000), wire('b0', 6_000)] }])
  const engine = new StreamFusionEngine(fusionSpec(), [
    { sourceId: 'src-a', reader: a },
    { sourceId: 'src-b', reader: b },
  ])
  const round = await engine.advance()
  assert.deepEqual(round.releasedEvents.map(e => e.eventId), [
    'src-b::b0', // earlier event time wins
    'src-a::a2', // tie on time: declaration order
    'src-a::a1', // same source, same time: arrival order
    'src-b::b1',
  ])
  await engine.close()
})

test('namespacing keeps same-name events from two sources distinct', async () => {
  const a = new ScriptedReader([{ events: [wire('shared', 1_000, 11)] }])
  const b = new ScriptedReader([{ events: [wire('shared', 1_000, 22)] }])
  const engine = new StreamFusionEngine(fusionSpec(), [
    { sourceId: 'src-a', reader: a },
    { sourceId: 'src-b', reader: b },
  ])
  const round = await engine.advance()
  assert.deepEqual(round.releasedEvents.map(e => e.eventId), ['src-a::shared', 'src-b::shared'])
  assert.deepEqual(round.releasedEvents.map(e => e.payload), [11, 22])
  await engine.close()
})

test('a full queue holds the source back from the wire', async () => {
  const reader = new ScriptedReader([
    { events: [wire('x1', 5_000), wire('x2', 6_000), wire('x3', 7_000)] },
  ])
  const other = new ScriptedReader([{ events: [wire('y1', 1_000)] }, { events: [wire('y2', 2_000)] }])
  const engine = new StreamFusionEngine(fusionSpec({ pendingCapacity: 2 }), [
    { sourceId: 'src-a', reader },
    { sourceId: 'src-b', reader: other },
  ])
  // Horizon = min(6000, 1000): src-a's events all sit above it, so only y1
  // releases and src-a's queue stays full with the two events it read.
  const first = await engine.advance()
  assert.equal(first.horizonMs, 1_000)
  assert.deepEqual(first.releasedEvents.map(e => e.eventId), ['src-b::y1'])
  assert.equal(first.perSource.find(s => s.sourceId === 'src-a')?.pendingLength, 2)
  assert.equal(reader.lastBudget, 2, 'the read is bounded by the remaining queue capacity')

  // src-a's queue is still full, so the wire is not read that round.
  const second = await engine.advance()
  assert.equal(second.perSource.find(s => s.sourceId === 'src-a')?.state, 'held')
  assert.equal(reader.rounds, 1)
  await engine.close()
})

test('an over-budget round loses nothing to the overflow carrier', async () => {
  // This reader ignores its budget and returns everything at once — the
  // engine must still neither drop events nor exceed the pending cap.
  const greedy = {
    state: 'unopened',
    async readRound() {
      this.state = 'live'
      return { live: true, events: [wire('g1', 5_000), wire('g2', 6_000), wire('g3', 7_000)], rejected: 0, ended: false }
    },
    async close() {
      this.state = 'ended'
    },
  }
  const other = new ScriptedReader([{ events: [wire('y1', 1_000)] }, { events: [wire('y2', 2_000)] }, { events: [wire('y3', 8_000)] }])
  const engine = new StreamFusionEngine(fusionSpec({ pendingCapacity: 2 }), [
    { sourceId: 'src-a', reader: greedy },
    { sourceId: 'src-b', reader: other },
  ])
  const first = await engine.advance()
  assert.equal(first.perSource.find(s => s.sourceId === 'src-a')?.pendingLength, 3, 'all three held, two queued and one carried')

  // The carrier drains into the queue as the horizon releases space.
  const second = await engine.advance()
  assert.equal(second.horizonMs, 2_000)
  const aState = second.perSource.find(s => s.sourceId === 'src-a')
  assert.equal(aState.pendingLength, 3, 'still above the horizon, still held, nothing dropped')

  const third = await engine.advance()
  assert.equal(third.horizonMs, 7_000, "the greedy feed's own maximum bounds the horizon")
  assert.equal(third.perSource.find(s => s.sourceId === 'src-a')?.released, 3, 'the carried event releases with the rest')
  await engine.close()
})

test('pause freezes a source and its queue out of the horizon and release', async () => {
  const a = new ScriptedReader([{ events: [wire('a1', 1_000)] }, { events: [wire('a2', 5_000)] }])
  const b = new ScriptedReader([{ events: [wire('b1', 4_000)] }, { events: [wire('b2', 9_000)] }])
  const engine = new StreamFusionEngine(fusionSpec(), [
    { sourceId: 'src-a', reader: a },
    { sourceId: 'src-b', reader: b },
  ])
  await engine.advance()
  engine.pauseSource('src-b')
  // src-b paused: its pending b1 (4000) neither holds back nor releases.
  const pausedRound = await engine.advance()
  assert.equal(pausedRound.horizonMs, 5_000)
  assert.deepEqual(pausedRound.releasedEvents.map(e => e.eventId), ['src-a::a2'])
  assert.equal(pausedRound.perSource.find(s => s.sourceId === 'src-b')?.state, 'paused')

  engine.resumeSource('src-b')
  const resumed = await engine.advance()
  // src-a's last delivered time (5000) still bounds the horizon, but the
  // frozen b1 (4000) is under it and releases now.
  assert.equal(resumed.horizonMs, 5_000)
  assert.ok(resumed.releasedEvents.some(e => e.eventId === 'src-b::b1'), 'the frozen queue releases after resume')
  await engine.close()
})

test('offline sources drop out of the horizon', async () => {
  const a = new ScriptedReader([{ events: [wire('a1', 2_000), wire('a2', 8_000)] }, { events: [wire('a3', 9_000)] }])
  const b = new ScriptedReader([
    { fail: { outcome: 'unreachable', detail: 'the channel ceased' } },
    { events: [wire('b1', 3_000)] },
  ])
  const engine = new StreamFusionEngine(fusionSpec(), [
    { sourceId: 'src-a', reader: a },
    { sourceId: 'src-b', reader: b },
  ])
  // src-b fails its first round: the horizon runs on src-a alone, and its
  // pending 8000-bound event is not held behind a dead feed.
  const first = await engine.advance()
  assert.equal(first.horizonMs, 8_000)
  assert.deepEqual(first.releasedEvents.map(e => e.eventId), ['src-a::a1', 'src-a::a2'])
  assert.equal(first.perSource.find(s => s.sourceId === 'src-b')?.state, 'offline')

  // src-b recovers next round (the reader reopens) and rejoins the horizon:
  // its b1 (3000) is under the recomputed minimum and releases.
  const second = await engine.advance()
  assert.equal(second.horizonMs, 3_000)
  assert.ok(second.releasedEvents.some(e => e.eventId === 'src-b::b1'))
  await engine.close()
})

test('a round where every source failed reports offline', async () => {
  const a = new ScriptedReader([{ fail: { outcome: 'unreachable', detail: 'down' } }])
  const b = new ScriptedReader([{ fail: { outcome: 'auth-rejected', detail: 'no key' } }])
  const engine = new StreamFusionEngine(fusionSpec(), [
    { sourceId: 'src-a', reader: a },
    { sourceId: 'src-b', reader: b },
  ])
  const round = await engine.advance()
  assert.equal(round.offlineRound, true)
  assert.deepEqual(round.batches, [])
  assert.equal(round.horizonMs, null)
  await engine.close()
})

test('released events chunk into batches the runtime live seam accepts', async () => {
  // Both sources top out at the same event time so the horizon admits all 300.
  const burst = Array.from({ length: 300 }, (_, at) => wire(`e${String(at)}`, at % 150))
  const a = new ScriptedReader([{ events: burst.slice(0, 150) }])
  const b = new ScriptedReader([{ events: burst.slice(150) }])
  const engine = new StreamFusionEngine(fusionSpec({ pendingCapacity: 400, maxEventsPerRelease: 400 }), [
    { sourceId: 'src-a', reader: a },
    { sourceId: 'src-b', reader: b },
  ])
  const round = await engine.advance()
  assert.equal(round.releasedEvents.length, 300)
  assert.deepEqual(round.batches.map(batch => batch.events.length), [256, 44])
  assert.deepEqual(round.batches.flatMap(batch => batch.events.map(e => e.eventId)), round.releasedEvents.map(e => e.eventId))
  await engine.close()
})

test('ended sources stay terminal and stop constraining the horizon', async () => {
  const a = new ScriptedReader([{ events: [wire('a1', 1_000)] }, { events: [wire('a2', 4_000)] }])
  const b = new ScriptedReader([{ events: [wire('b1', 6_000)] }, { end: true }, { events: [wire('late', 9_000)] }])
  const engine = new StreamFusionEngine(fusionSpec(), [
    { sourceId: 'src-a', reader: a },
    { sourceId: 'src-b', reader: b },
  ])
  await engine.advance()
  // src-b ends: only src-a is conclusive, so its 4000 event releases freely.
  const round = await engine.advance()
  assert.equal(round.horizonMs, 4_000)
  assert.ok(round.releasedEvents.some(e => e.eventId === 'src-a::a2'))
  assert.equal(round.perSource.find(s => s.sourceId === 'src-b')?.state, 'ended')
  // A terminal reader is never read again.
  const still = await engine.advance()
  assert.equal(still.perSource.find(s => s.sourceId === 'src-b')?.state, 'ended')
  assert.equal(b.script.length, 1, 'the post-end step never runs')
  await engine.close()
})

test('unknown source ids and closed fusions refuse loudly', async () => {
  const a = new ScriptedReader([])
  const b = new ScriptedReader([])
  const engine = new StreamFusionEngine(fusionSpec(), [
    { sourceId: 'src-a', reader: a },
    { sourceId: 'src-b', reader: b },
  ])
  assert.throws(() => engine.pauseSource('src-z'), /does not bind source "src-z"/)
  assert.throws(() => engine.resumeSource('src-z'), /does not bind source "src-z"/)
  await engine.close()
  await assert.rejects(() => engine.advance(), /the fusion is closed/)
})

test('a real two-source wire fuses behind the lagging horizon into a real runtime', async () => {
  const { startFixture } = await import('./loopback.ts')
  const { SseSourceReader } = await import('../src/sse.ts')
  const { REALTIME_METHOD_VERSION } = await import('../../spatial-realtime/src/contract.ts')
  const { StreamRuntime } = await import('../../spatial-realtime/src/runtime.ts')

  // The fast feed bursts six events and ends cleanly; the slow feed bursts
  // three and stays open and quiet — a live laggard.
  const fast = await startFixture('loopback-sse-server', ['--events', '6', '--end'])
  const slow = await startFixture('loopback-sse-server', ['--events', '3'])
  try {
    const engine = new StreamFusionEngine(
      { id: 'fusion-live', sources: ['sse-fast', 'sse-slow'], pendingCapacity: 8, maxEventsPerRelease: 8 },
      [
        { sourceId: 'sse-fast', reader: new SseSourceReader({ id: 'sse-fast', kind: 'sse', url: `http://127.0.0.1:${String(fast.port)}/feed`, maxEventsPerFetch: 4, timeoutMs: 1000 }, () => undefined) },
        { sourceId: 'sse-slow', reader: new SseSourceReader({ id: 'sse-slow', kind: 'sse', url: `http://127.0.0.1:${String(slow.port)}/feed`, timeoutMs: 1000 }, () => undefined) },
      ],
    )
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

    // Round 1: the fast feed reads all six and ends; the slow feed reads
    // its three and stays live. The horizon runs at the slow feed's
    // maximum (2000), so the fast feed's 3000+ events wait behind it.
    let processMs = 0
    const first = await engine.advance()
    assert.equal(first.horizonMs, 2_000)
    assert.equal(first.releasedEvents.length, 6)
    assert.ok(first.releasedEvents.every(e => e.eventTimeMs <= 2_000))
    for (const batch of first.batches) {
      runtime.advanceLive(processMs, batch)
    }

    // Round 2: the live laggard is quiet and still holds the horizon at
    // 2000 — the fast feed's tail stays pending.
    processMs += 100
    const stalled = await engine.advance()
    assert.equal(stalled.horizonMs, 2_000)
    assert.equal(stalled.releasedEvents.length, 0)
    assert.equal(stalled.perSource.find(s => s.sourceId === 'sse-fast')?.pendingLength, 3)

    // Pausing the stalled feed drops it from the horizon; the fast feed is
    // ended (complete), so release becomes unbounded and the tail flows.
    engine.pauseSource('sse-slow')
    processMs += 100
    const resumed = await engine.advance()
    assert.equal(resumed.horizonMs, null)
    assert.equal(resumed.releasedEvents.length, 3)
    for (const batch of resumed.batches) {
      runtime.advanceLive(processMs, batch)
    }
    const status = runtime.status()
    assert.equal(status.admitted, 9)
    assert.equal(status.processed, 9)

    // Namespacing kept the two feeds' evt-N ids distinct all the way in.
    assert.equal(status.dedupLength, 9)

    // At-least-once redelivery of a fused batch folds once: admission count holds.
    runtime.advanceLive(processMs, { events: [...first.releasedEvents] })
    assert.equal(runtime.status().admitted, 9)
    await engine.close()
  } finally {
    await fast.stop()
    await slow.stop()
  }
})
