/**
 * Fault-injection matrix fixtures: the five named points (flush,
 * artifact-publish, provider, worker, render) inject coded failures
 * deterministically, every injection is audit evidence, recovery is the
 * same call site replaying through after disarm, and the whole inject →
 * fail → replay → recover arc reads from the health transitions, the
 * counters, and the diagnostic export.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ObservabilityRuntime, OBS_FAULT_POINTS, OBS_FAULT_POINT_CODES, OBS_FAULT_POINT_PLANES } from '../src/index.ts'

function tickClock() {
  let now = 1_000
  return () => (now += 5)
}

test('each armed point injects its default coded failure without invoking the real call', () => {
  for (const point of OBS_FAULT_POINTS) {
    const runtime = new ObservabilityRuntime({ clock: tickClock() })
    let realRan = false
    runtime.faults.arm(point)
    assert.equal(runtime.faults.isArmed(point), true)
    assert.throws(
      () => runtime.faults.hit(point, () => { realRan = true }),
      error => {
        assert.equal(error.name, 'ObsFaultError')
        assert.equal(error.code, OBS_FAULT_POINT_CODES[point])
        assert.equal(error.point, point)
        assert.equal(error.stillArmed, false)
        return true
      },
      `point ${point} injected ${OBS_FAULT_POINT_CODES[point]}`,
    )
    assert.equal(realRan, false, `the real ${point} call never ran while armed`)
    assert.equal(runtime.faults.isArmed(point), false, 'a single-shot point disarms itself')
  }
})

test('a disarmed hit runs the real call; its own failure propagates untouched', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  const value = runtime.faults.hit('flush', () => ({ drained: true }))
  assert.deepEqual(value, { drained: true })
  assert.throws(
    () => runtime.faults.hit('flush', () => { throw new Error('the writer really failed') }),
    /the writer really failed/,
  )
  assert.equal(runtime.faults.injections().length, 0, 'a plain pass-through is not an injection')
})

test('multi-shot arming fails exactly N times, then the same call site recovers by replay', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.faults.arm('artifact-publish', { times: 2 })
  const attempts = []
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const published = runtime.faults.hit('artifact-publish', () => `art-pub-${attempt}`)
      attempts.push(['succeeded', published])
    } catch (error) {
      attempts.push(['failed', error.code, error.stillArmed])
    }
  }
  assert.deepEqual(attempts, [
    ['failed', 'ARTIFACT_PUBLISH_FAILED', true],
    ['failed', 'ARTIFACT_PUBLISH_FAILED', false],
    ['succeeded', 'art-pub-3'],
  ], 'two armed failures inject, the third attempt replays through and succeeds')
  assert.equal(runtime.faults.injections().length, 2)
})

test('arming refuses misuse: double-arm, bad times, unknown code override', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.faults.arm('provider')
  assert.throws(() => runtime.faults.arm('provider'), /already armed/)
  runtime.faults.reset('provider')
  assert.throws(() => runtime.faults.arm('flush', { times: 0 }), /positive integer/)
  assert.throws(() => runtime.faults.arm('flush', { code: 'NOT_A_CODE' }), /closed vocabulary/)
  runtime.faults.arm('provider', { code: 'PROVIDER_UNAVAILABLE' })
  assert.throws(() => runtime.faults.hit('provider', () => 1), error => error.code === 'PROVIDER_UNAVAILABLE')
})

test('every injection is audit evidence with correlation, counters, and plane effects', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.scope({ domain: 'local', sessionId: 'sess-fault', sourceCallSeq: 9 }, () => {
    runtime.faults.arm('render')
    try {
      runtime.hit('render', () => 'view')
    } catch (error) {
      runtime.reportFault(error.point)
      runtime.reportOutcome('render', 'failed', { code: error.code })
      runtime.health.report('render', 'degraded', { code: error.code, detail: 'display derivation failed (injected)' })
    }
  })
  // The fault matrix audited the injection with the ambient correlation.
  const injection = runtime.faults.injections()[0]
  assert.equal(injection.correlation?.operationRef, 'op:local:sess-fault#9')
  // The runtime logged the audit fact and counted the series.
  assert.equal(runtime.metrics.counterValue('obs_fault_injections_total', { code: 'RENDER_FAILED' }), 1)
  assert.equal(runtime.metrics.counterValue('obs_operations_total', { plane: 'render', outcome: 'failed' }), 1)
  const audit = runtime.log.records.find(record => record.level === 'audit')
  assert.equal(audit.code, 'RENDER_FAILED')
  assert.equal(audit.correlation?.operationRef, 'op:local:sess-fault#9')
  // The failure record and the degraded plane hold readiness back.
  assert.equal(runtime.health.readiness().ready, false)
  assert.equal(runtime.health.of('render').code, 'RENDER_FAILED')
})

test('the flush fault arc: inject → data degraded → replay → recovered, all queryable', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  const drain = () => ({ drained: true, seq: 1 })
  // Injected flush failure: accepted state stays accepted, durability refuses.
  runtime.faults.arm('flush')
  let settled
  try {
    settled = runtime.hit('flush', drain)
  } catch (error) {
    runtime.metrics.counter('obs_flush_failures_total')
    runtime.reportFault('flush')
    runtime.reportOutcome('data', 'failed', { code: error.code })
    runtime.health.report('data', 'degraded', { code: error.code, detail: 'flush barrier failed (injected)' })
    settled = { drained: false }
  }
  assert.deepEqual(settled, { drained: false })
  assert.equal(runtime.health.readiness().ready, false)
  // Recovery: the point disarmed, the same call site replays through.
  const replayed = runtime.hit('flush', drain)
  assert.deepEqual(replayed, { drained: true, seq: 1 })
  runtime.reportOutcome('data', 'succeeded')
  runtime.health.report('data', 'ready', { detail: 'flush barrier drained on replay' })
  assert.equal(runtime.health.readiness().ready, true)
  // The full arc reads from the transition history.
  assert.deepEqual(
    runtime.health.transitions().map(entry => `${entry.plane}:${entry.from}->${entry.to}`),
    ['data:ready->degraded', 'data:degraded->ready'],
  )
  assert.equal(runtime.metrics.counterValue('obs_flush_failures_total'), 1)
  // ...and from the diagnostic export.
  const { document } = runtime.exportDiagnostic()
  assert.equal(document.faults.injections.length, 1)
  assert.equal(document.faults.armedPoints.length, 0)
  assert.equal(document.readiness.ready, true)
  const auditCodes = runtime.log.records.filter(record => record.level === 'audit').map(record => record.code)
  assert.deepEqual(auditCodes, ['FLUSH_FAILED'])
})

test('the worker crash classifies outcome_unknown, never a fabricated result', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.faults.arm('worker')
  try {
    runtime.faults.hit('worker', () => ({ rows: 10 }))
  } catch (error) {
    assert.equal(error.code, 'WORKER_CRASHED')
    // The worker died before settling: the honest outcome is "unknown".
    runtime.reportOutcome(OBS_FAULT_POINT_PLANES.worker, 'outcome_unknown')
    runtime.health.report('run', 'degraded', { code: error.code, detail: 'scan worker exited before settling' })
  }
  assert.equal(runtime.metrics.counterValue('obs_operations_total', { plane: 'run', outcome: 'outcome_unknown' }), 1)
  assert.equal(runtime.health.readiness().ready, false)
})

test('the provider rate-limit leg counts its own named series', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.faults.arm('provider')
  try {
    runtime.faults.hit('provider', () => 'lbs page 2')
  } catch (error) {
    runtime.metrics.countProviderCall('lbs', 'failed')
    runtime.metrics.countProviderRateLimit('lbs', error.code)
    runtime.reportOutcome('provider', 'failed', { code: error.code })
  }
  assert.equal(runtime.metrics.counterValue('obs_provider_rate_limited_total', { provider: 'lbs' }), 1)
  assert.equal(runtime.metrics.counterValue('obs_provider_calls_total', { provider: 'lbs', outcome: 'failed' }), 1)
})

test('resetAll disarms everything; reset names one point', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.faults.arm('flush')
  runtime.faults.arm('render')
  runtime.faults.reset('flush')
  assert.equal(runtime.faults.isArmed('flush'), false)
  assert.equal(runtime.faults.isArmed('render'), true)
  runtime.faults.resetAll()
  assert.equal(runtime.faults.isArmed('render'), false)
})
