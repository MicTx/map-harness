/**
 * Health and diagnostic-export fixtures: the six planes report separately,
 * readiness is the derived aggregate that names what holds it back,
 * provider-unavailable / catalog-lag / render-failed / telemetry-dropped
 * states and their recovery arcs are queryable, and the diagnostic export is
 * bounded, sanitized, and audit-preserving under truncation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ObservabilityRuntime } from '../src/index.ts'

function tickClock() {
  let now = 1_000
  return () => (now += 5)
}

test('a fresh runtime reads ready on all six planes', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  const readiness = runtime.health.readiness()
  assert.equal(readiness.ready, true)
  assert.deepEqual(readiness.heldBack, [])
  assert.deepEqual(Object.keys(readiness.planes).sort(), ['catalog', 'data', 'process', 'provider', 'render', 'run'])
})

test('provider unavailable holds readiness back and the recovery arc is queryable', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.health.report('provider', 'unavailable', { code: 'PROVIDER_UNAVAILABLE', detail: 'lbs provider unreachable' })
  const readiness = runtime.health.readiness()
  assert.equal(readiness.ready, false)
  assert.deepEqual(readiness.heldBack.map(plane => [plane.plane, plane.status]), [['provider', 'unavailable']])
  // Degraded sorts after unavailable in the held-back list.
  runtime.health.report('run', 'degraded', { code: 'WORKER_CRASHED', detail: 'scan worker exited mid-job' })
  assert.deepEqual(
    runtime.health.readiness().heldBack.map(plane => plane.plane),
    ['provider', 'run'],
  )
  // Recovery: re-report flips the planes back; the history keeps the arc.
  runtime.health.report('provider', 'ready', { detail: 'lbs provider reachable' })
  runtime.health.report('run', 'ready', { detail: 'worker pool healthy' })
  assert.equal(runtime.health.readiness().ready, true)
  const transitions = runtime.health.transitions().map(entry => [entry.plane, entry.from, entry.to])
  assert.deepEqual(transitions, [
    ['provider', 'ready', 'unavailable'],
    ['run', 'ready', 'degraded'],
    ['provider', 'unavailable', 'ready'],
    ['run', 'degraded', 'ready'],
  ])
})

test('same-status re-reports refresh the detail without a new transition', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.health.report('data', 'degraded', { code: 'CATALOG_LAGGING', detail: 'lag 500ms' })
  runtime.health.report('data', 'degraded', { detail: 'lag 900ms' })
  // Exactly one transition (the initial flip); the refresh is not a change.
  assert.deepEqual(
    runtime.health.transitions().map(entry => [entry.plane, entry.from, entry.to]),
    [['data', 'ready', 'degraded']],
  )
  assert.equal(runtime.health.of('data').detail, 'lag 900ms')
  assert.equal(runtime.health.of('data').status, 'degraded')
  assert.equal(runtime.health.of('data').code, undefined, 'the refresh cleared the stale code')
})

test('catalog lag reads degraded with the lagging code, not unavailable', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.health.report('catalog', 'degraded', { code: 'CATALOG_LAGGING', detail: 'projection lags store by 1200ms' })
  const health = runtime.health.of('catalog')
  assert.equal(health.status, 'degraded')
  assert.equal(health.code, 'CATALOG_LAGGING')
  assert.equal(runtime.health.readiness().ready, false)
})

test('render failure and flush failure live on their own planes and counters', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.metrics.counter('obs_render_failures_total')
  runtime.metrics.counter('obs_flush_failures_total')
  runtime.health.report('render', 'degraded', { code: 'RENDER_FAILED', detail: 'display derivation threw' })
  runtime.health.report('data', 'degraded', { code: 'FLUSH_FAILED', detail: 'persistence drain failed' })
  const readiness = runtime.health.readiness()
  assert.deepEqual(readiness.heldBack.map(plane => plane.plane), ['data', 'render'])
  assert.equal(runtime.metrics.counterValue('obs_render_failures_total'), 1)
  assert.equal(runtime.metrics.counterValue('obs_flush_failures_total'), 1)
})

test('telemetry drops fold into the process plane and never throw', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock(), logCapacity: 2 })
  runtime.emit('info', 'one')
  runtime.emit('info', 'two')
  runtime.emit('info', 'three past capacity')
  runtime.emit('audit', 'audit past capacity')
  // Telemetry degraded, main result untouched: the emitter never threw.
  runtime.reportTelemetryHealth()
  const process = runtime.health.of('process')
  assert.equal(process.status, 'degraded')
  assert.equal(process.code, 'TELEMETRY_DEGRADED')
  assert.match(process.detail, /log_sample=1/)
  assert.match(process.detail, /log_audit=1/)
  assert.equal(runtime.health.readiness().ready, false)
})

test('health contract misuse refuses loudly; over-long details truncate', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  assert.throws(() => runtime.health.report('disk', /** @type {never} */ ('degraded')), /closed vocabulary/)
  assert.throws(() => runtime.health.report('data', /** @type {never} */ ('fine')), /closed vocabulary/)
  const long = 'x'.repeat(400)
  const reported = runtime.health.report('data', 'degraded', { detail: long })
  assert.ok(reported.detail.length <= 161, 'the detail truncates to the bounded length')
})

test('the diagnostic export is byte-bounded, keeps audit facts, and counts its truncation', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.scope({ domain: 'local', sessionId: 'sess-export', sourceCallSeq: 3 }, () => {
    runtime.emit('info', 'sample volume', { fields: { index: 1 } })
    runtime.emit('info', 'more sample volume')
    runtime.emit('error', 'the flush failed', { code: 'FLUSH_FAILED' })
    runtime.emit('audit', 'operator reset the fault point')
  })
  const { document, json, bytes } = runtime.exportDiagnostic({ maxBytes: 4_000 })
  assert.ok(bytes <= 4_000, `the export honors its byte budget (was ${bytes})`)
  const parsed = JSON.parse(json)
  // Audit-class records (error + audit) survive; sample records may be cut.
  const levels = parsed.logs.map(record => record.level)
  assert.ok(levels.includes('error'), 'the failure record survives truncation')
  assert.ok(levels.includes('audit'), 'the audit record survives truncation')
  if (document.truncated) {
    assert.ok(document.truncatedRecords > 0)
    // The export's own truncation is a counted telemetry drop (kind: export).
    assert.equal(runtime.metrics.counterValue('obs_telemetry_dropped_total', { kind: 'export' }), document.truncatedRecords)
  }
})

test('the diagnostic export is sanitized as a whole: credentials and paths never appear', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.emit('info', 'session snapshot', {
    fields: {
      accessToken: 'sk-live-999',
      storeRoot: '/Users/someone/secret/spatial-store',
      revision: 9,
    },
  })
  const { json } = runtime.exportDiagnostic()
  assert.ok(!json.includes('sk-live-999'), 'the credential value never reaches the export')
  assert.ok(!json.includes('/Users/someone/secret'), 'the host path never reaches the export')
  assert.ok(json.includes('[redacted:accessToken]'))
  assert.ok(json.includes('<path>'))
})

test('the export carries the versioned method identity and the full readiness face', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.health.report('provider', 'degraded', { code: 'PROVIDER_UNAVAILABLE', detail: 'flapping' })
  const { document } = runtime.exportDiagnostic()
  assert.equal(document.methodVersion, 'spatial-observability@1')
  assert.equal(document.readiness.ready, false)
  assert.equal(document.readiness.planes.provider.status, 'degraded')
  assert.equal(document.telemetryDrops.metric, 0)
})
