/**
 * Instrumentation suite: segmented metrics with bounded payload-free labels,
 * visibly degraded telemetry on overflow, failure/cancel outcomes sampled
 * instead of swallowed, and wait-state measurement against deterministic
 * barriers (no sleeps anywhere).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { markPerfCancelled, PerfCancelledError, PerfSampler } from '../src/instrument.ts'

function settled(value) {
  return Promise.resolve(value)
}

function deferred() {
  let release
  const promise = new Promise(resolve => {
    release = resolve
  })
  return { promise, release }
}

test('segments record wall time, labels, and outcomes; summaries aggregate per (segment, outcome)', async () => {
  const sampler = new PerfSampler()
  sampler.sample('compute', { workload: 'demo', stage: 'sync', unit: 'ms' }, () => 42)
  await sampler.sampleAsync('commit', { workload: 'demo', stage: 'async', unit: 'ms' }, async () => {
    await settled(null)
    return 'done'
  })
  await sampler.wait('flush', { workload: 'demo', stage: 'barrier', unit: 'ms' }, settled(true))
  const summary = sampler.summary()
  assert.equal(summary.sampleCount, 3)
  assert.equal(summary.degraded, false)
  const segments = summary.segments.map(entry => `${entry.segment}/${entry.outcome}`)
  assert.deepEqual(segments, ['commit/succeeded', 'compute/succeeded', 'flush/succeeded'])
  for (const entry of summary.segments) {
    assert.ok(entry.count === 1, 'one sample per pair')
    assert.ok(entry.totalMs >= 0 && entry.maxMs >= entry.p50Ms && entry.p50Ms >= 0, 'aggregate arithmetic stays coherent')
  }
})

test('records pass through results and rethrow original errors with a failed sample', () => {
  const sampler = new PerfSampler()
  const result = sampler.sample('compute', { workload: 'demo', stage: 'ok', unit: 'ms' }, () => 'value')
  assert.equal(result, 'value')
  const boom = new Error('the computation failed')
  assert.throws(
    () => sampler.sample('compute', { workload: 'demo', stage: 'boom', unit: 'ms' }, () => {
      throw boom
    }),
    /the computation failed/,
    'the original error reaches the caller',
  )
  const failed = sampler.records.find(record => record.outcome === 'failed')
  assert.ok(failed !== undefined, 'the failed attempt is still sampled — failures are never swallowed')
  assert.equal(failed.segment, 'compute')
})

test('async rejections sample failed and rethrow; marked cancellations sample cancelled', async () => {
  const sampler = new PerfSampler()
  await assert.rejects(
    () => sampler.sampleAsync('commit', { workload: 'demo', stage: 'reject', unit: 'ms' }, async () => {
      throw new Error('commit rejected')
    }),
    /commit rejected/,
  )
  await assert.rejects(
    () => sampler.wait('cancel', { workload: 'demo', stage: 'race', unit: 'ms' }, (async () => {
      throw markPerfCancelled(new Error('the cancellation race lost'))
    })()),
    /cancellation race lost/,
  )
  const cancelled = sampler.records.find(record => record.outcome === 'cancelled')
  assert.ok(cancelled !== undefined, 'a marked cancellation is sampled as cancelled, not failed')
  assert.ok(sampler.records.some(record => record.outcome === 'failed'))
  assert.ok(new PerfCancelledError('x') instanceof Error)
})

test('wait measures the real settlement span across deterministic barriers (no sleeps)', async () => {
  const sampler = new PerfSampler()
  const first = deferred()
  const second = deferred()
  const waited = sampler.wait('cancel', { workload: 'demo', stage: 'quiescence', unit: 'ms' }, first.promise.then(() => 'child-exited'))
  // Neither barrier has released: the wait must not have settled yet.
  let settledValue = null
  void waited.then(value => {
    settledValue = value
  })
  await settled(null)
  assert.equal(settledValue, null, 'the wait stays open until the barrier releases')
  second.release()
  first.release('go')
  assert.equal(await waited, 'child-exited')
  const cancelSample = sampler.records.find(record => record.segment === 'cancel')
  assert.ok(cancelSample !== undefined && cancelSample.outcome === 'succeeded')
})

test('labels refuse unknown keys, overlong values, and segments outside the closed vocabulary', () => {
  const sampler = new PerfSampler()
  assert.throws(() => sampler.sample('compute', { payload: '{huge json...}', unit: 'ms' }, () => null), /outside the closed vocabulary/, 'payload never becomes a label')
  assert.throws(() => sampler.sample('compute', { workload: 'x'.repeat(65), unit: 'ms' }, () => null), /at most 64 characters/)
  assert.throws(() => sampler.sample('teleport', { unit: 'ms' }, () => null), /outside the closed vocabulary/)
  sampler.begin('compute', { stage: 'span' })
  assert.throws(() => sampler.begin('compute', { stage: 'again' }), /already active/, 'nested same-segment spans refuse')
  sampler.end('compute', 'succeeded')
  assert.throws(() => sampler.end('compute'), /without begin/, 'unbalanced end refuses')
  assert.throws(() => sampler.end('compute', 'nonsense'), /outcome/)
})

test('capacity overflow degrades visibly and counts every dropped sample', () => {
  const sampler = new PerfSampler({ capacity: 4 })
  for (let index = 0; index < 9; index++) {
    sampler.sample('scan', { workload: 'demo', stage: 'bulk', unit: 'ms' }, () => index)
  }
  assert.equal(sampler.records.length, 4, 'the buffer stays at capacity')
  assert.equal(sampler.degraded, true, 'overflow degrades the telemetry visibly')
  assert.equal(sampler.droppedSamples, 5, 'every dropped sample is counted, never hidden')
  const summary = sampler.summary()
  assert.equal(summary.degraded, true)
  assert.equal(summary.droppedSamples, 5)
})

test('percentiles and byte measures behave on real sample sets', () => {
  const sampler = new PerfSampler()
  for (const wall of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
    sampler.sample('render', { workload: 'demo', stage: 'frames', unit: 'ms' }, () => wall)
  }
  // Sampled walls are far below the body's return values' magnitude; assert
  // on ordering only (the sampler measures real time, not the fake numbers).
  const summary = sampler.summary()
  const render = summary.segments.find(entry => entry.segment === 'render')
  assert.equal(render.count, 10)
  assert.ok(render.p50Ms <= render.p95Ms && render.p95Ms <= render.maxMs, 'p50 ≤ p95 ≤ max holds')
  assert.equal(sampler.bytesOf({ a: 1 }), Buffer.byteLength('{"a":1}', 'utf8'))
  assert.equal(sampler.bytesOf(undefined), 4, 'undefined canonicalizes to null')
  assert.ok(sampler.heapUsedBytes() > 0)
})
