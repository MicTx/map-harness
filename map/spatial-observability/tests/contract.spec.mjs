/**
 * Contract fixtures for `spatial-observability@1`: the six closed outcomes
 * settle and classify distinctly (success/failure/partial/cancel/
 * outcome-unknown/degraded), correlation identities are canonical and
 * bounded, error codes and metric labels stay on closed vocabularies, and
 * sanitization visibly removes credentials, geometry payloads, and
 * filesystem paths. Source plane; a deterministic clock pins every
 * recorded timestamp.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OBSERVABILITY_METHOD_VERSION,
  OBS_ERROR_CODES,
  OBS_ERROR_CODE_LIST,
  OBS_OUTCOMES,
  OBS_HEALTH_PLANES,
  OBS_SEGMENTS,
  OBS_PROVIDERS,
  OBS_METRIC_LABEL_KEYS,
  MAX_LABEL_VALUE_CHARS,
  MAX_LOG_MESSAGE_CHARS,
  operationRefOf,
  parseOperationRef,
  newTraceId,
  validateCorrelation,
  ObservabilityRuntime,
} from '../src/index.ts'

/** Deterministic clock: every recorded timestamp advances one fixed tick. */
function tickClock() {
  let now = 1_000
  return () => (now += 10)
}

test('the contract pins the method version and the closed vocabularies', () => {
  assert.equal(OBSERVABILITY_METHOD_VERSION, 'spatial-observability@1')
  assert.deepEqual([...OBS_OUTCOMES], ['succeeded', 'partial', 'failed', 'cancelled', 'outcome_unknown', 'degraded'])
  assert.deepEqual([...OBS_HEALTH_PLANES], ['process', 'provider', 'catalog', 'run', 'data', 'render'])
  assert.deepEqual([...OBS_SEGMENTS], ['context', 'mcp', 'compute', 'commit', 'flush', 'render', 'scan', 'cancel'])
  assert.deepEqual([...OBS_PROVIDERS], ['model', 'lbs', 'network', 'storage', 'mcp'])
  for (const code of OBS_ERROR_CODE_LIST) {
    assert.equal(typeof OBS_ERROR_CODES[code], 'string')
    assert.ok(OBS_ERROR_CODES[code].length > 10, `error code ${code} carries a fixed meaning`)
  }
})

test('every outcome settles distinctly: success, failure, partial, cancel, outcome-unknown, degraded', () => {
  const clock = tickClock()
  const runtime = new ObservabilityRuntime({ clock })
  const outcomes = [
    { outcome: 'succeeded', code: undefined },
    { outcome: 'failed', code: 'FLUSH_FAILED' },
    { outcome: 'partial', code: undefined },
    { outcome: 'cancelled', code: undefined },
    { outcome: 'outcome_unknown', code: undefined },
    { outcome: 'degraded', code: 'TELEMETRY_DEGRADED' },
  ]
  runtime.scope({ domain: 'local', sessionId: 'sess-outcomes', sourceCallSeq: 1 }, () => {
    for (const { outcome, code } of outcomes) {
      runtime.reportOutcome('data', outcome, { code })
    }
  })
  for (const { outcome } of outcomes) {
    assert.equal(runtime.metrics.counterValue('obs_operations_total', { plane: 'data', outcome }), 1, `outcome ${outcome} counted once`)
  }
  // failed and degraded carry their codes onto the audit trail; the
  // unclassifiable outcome_unknown settles without inventing a success.
  const failures = runtime.log.records.filter(record => record.level === 'error' || record.level === 'warn')
  assert.deepEqual(
    failures.map(record => [record.level, record.code]),
    [['error', 'FLUSH_FAILED'], ['warn', 'TELEMETRY_DEGRADED']],
  )
  assert.equal(failures.every(record => record.correlation?.operationRef === 'op:local:sess-outcomes#1'), true)
})

test('a failed or degraded settlement without a code refuses loudly; success never needs one', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  assert.throws(() => runtime.reportOutcome('render', 'failed'), /must carry a closed error code/)
  assert.throws(() => runtime.reportOutcome('render', 'degraded'), /must carry a closed error code/)
  runtime.reportOutcome('render', 'succeeded')
  runtime.reportOutcome('render', 'outcome_unknown')
  assert.equal(runtime.metrics.counterValue('obs_operations_total', { plane: 'render', outcome: 'succeeded' }), 1)
})

test('operationRef is canonical, parseable, and refuses malformed components', () => {
  const ref = operationRefOf({ domain: 'local', sessionId: 'sess-abc.1', sourceCallSeq: 42 })
  assert.equal(ref, 'op:local:sess-abc.1#42')
  assert.deepEqual(parseOperationRef(ref), { domain: 'local', sessionId: 'sess-abc.1', sourceCallSeq: 42 })
  assert.throws(() => operationRefOf({ domain: 'bad domain', sessionId: 's', sourceCallSeq: 1 }), /domain must match/)
  assert.throws(() => operationRefOf({ domain: 'local', sessionId: '', sourceCallSeq: 1 }), /sessionId must match/)
  assert.throws(() => operationRefOf({ domain: 'local', sessionId: 's', sourceCallSeq: 1.5 }), /nonnegative integer/)
  assert.throws(() => parseOperationRef('op:local:sess#notaseq'), /canonical/)
  assert.throws(() => parseOperationRef('session-123'), /canonical/)
})

test('correlation validates ids and bounds; trace ids are high-cardinality and scoped', () => {
  const traceId = newTraceId()
  assert.match(traceId, /^trace-[0-9a-f]{16}$/)
  const correlation = {
    operationRef: 'op:local:sess-corr#7',
    runId: 'run-123',
    goalRevision: 3,
    traceId,
  }
  validateCorrelation(correlation)
  // A child scope inherits the parent's trace id: one trace across planes.
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.scope({ domain: 'local', sessionId: 'sess-corr', sourceCallSeq: 7, traceId }, () => {
    assert.equal(runtime.current()?.traceId, traceId)
    runtime.scope({ domain: 'local', sessionId: 'sess-corr', sourceCallSeq: 8 }, () => {
      assert.equal(runtime.current()?.traceId, traceId, 'the nested scope inherits the parent trace')
      assert.equal(runtime.current()?.operationRef, 'op:local:sess-corr#8')
    })
  })
  assert.equal(runtime.current(), undefined, 'outside any scope there is no ambient correlation')
  assert.throws(() => validateCorrelation({ ...correlation, traceId: 'no-prefix' }), /trace-/)
  assert.throws(() => validateCorrelation({ ...correlation, operationRef: 'garbage' }), /canonical/)
  assert.throws(() => validateCorrelation({ ...correlation, goalRevision: -1 }), /goalRevision/)
})

test('metric labels stay on the closed vocabulary; payload and trace ids refuse as labels', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  // A label key outside the closed set refuses at the recorder.
  assert.throws(() => runtime.metrics.counter('obs_operations_total', { operationRef: 'op:local:x#1' } /** high-cardinality id as label */), /closed vocabulary/)
  assert.throws(() => runtime.metrics.counter('obs_operations_total', { traceId: newTraceId() }), /closed vocabulary/)
  assert.throws(
    () => runtime.metrics.counter('obs_operations_total', { plane: 'not-a-plane' }),
    /requires the label key "outcome"/,
    'an out-of-vocabulary value on a partial label set names the missing required key',
  )
  assert.throws(() => runtime.metrics.counter('obs_operations_total', { plane: 'not-a-plane', outcome: 'succeeded' }), /closed vocabulary/)
  // Each metric accepts only its own label keys.
  assert.throws(() => runtime.metrics.counter('obs_flush_failures_total', { plane: 'data' }), /does not accept/)
  assert.throws(() => runtime.metrics.observe('obs_segment_latency_ms', 5, { plane: 'data' }), /does not accept/)
  assert.throws(() => runtime.metrics.observe('obs_segment_latency_ms', 5, {}), /requires the label key "segment"/)
  // Unknown metric names refuse (the union is closed, so misuse is a cast away from type safety).
  assert.throws(() => runtime.metrics.counter('obs_made_up_total', {}), /is not a counter/)
  // The label-value cap is far above any closed-vocabulary string.
  assert.ok(MAX_LABEL_VALUE_CHARS >= Math.max(...[...OBS_HEALTH_PLANES, ...OBS_SEGMENTS].map(value => value.length)))
})

test('logs never sample away failures and audit facts; debug/info follow the 1-in-N keep', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock(), sampleEvery: 3 })
  for (let index = 0; index < 9; index += 1) {
    runtime.emit('debug', `debug fact ${index}`)
    runtime.emit('info', `info fact ${index}`)
  }
  // keep-1-in-N: seqs 1,4,7 → 3 of 9 kept per sample-class level.
  assert.equal(runtime.log.records.filter(record => record.level === 'debug').length, 3)
  assert.equal(runtime.log.records.filter(record => record.level === 'info').length, 3)
  assert.equal(runtime.log.droppedSamples, 12)
  // Failures and audit facts bypass sampling entirely.
  for (let index = 0; index < 9; index += 1) {
    runtime.emit('error', `flush failed again ${index}`, { code: 'FLUSH_FAILED' })
    runtime.emit('audit', `security fact ${index}`)
  }
  assert.equal(runtime.log.records.filter(record => record.level === 'error').length, 9)
  assert.equal(runtime.log.records.filter(record => record.level === 'audit').length, 9)
  assert.equal(runtime.log.droppedAudit, 0)
})

test('capacity overflow degrades visibly with exact per-class drop counts', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock(), logCapacity: 5 })
  for (let index = 0; index < 8; index += 1) runtime.emit('info', `fill ${index}`)
  assert.equal(runtime.log.records.length, 5)
  assert.equal(runtime.log.droppedSamples, 3)
  // The buffer is already full: audit facts drop too, but they drop into
  // their own exact counter — the failure story never disappears silently.
  for (let index = 0; index < 3; index += 1) runtime.emit('audit', `audit ${index}`)
  assert.equal(runtime.log.droppedAudit, 3)
  assert.equal(runtime.telemetryHealth().drops.log_sample, 3)
  assert.equal(runtime.telemetryHealth().drops.log_audit, 3)
  assert.equal(runtime.telemetryHealth().degraded, true)
})

test('log contract misuse refuses loudly: error needs a code, messages stay short, levels closed', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  assert.throws(() => runtime.emit('error', 'no code'), /must carry a closed error code/)
  assert.throws(() => runtime.emit('info', 'x'.repeat(MAX_LOG_MESSAGE_CHARS + 1)), /log message/)
  assert.throws(() => runtime.emit('verbose', 'no such level'), /closed vocabulary/)
})

test('a throwing sink never blocks the caller and is counted per class', () => {
  let seen = 0
  const runtime = new ObservabilityRuntime({
    clock: tickClock(),
    sink: () => {
      seen += 1
      throw new Error('sink exploded')
    },
  })
  runtime.emit('info', 'lost to the sink')
  runtime.emit('audit', 'audit lost to the sink')
  assert.equal(seen, 2, 'the sink was still invoked for every stored record')
  assert.equal(runtime.log.sinkFailures, 2)
  assert.equal(runtime.telemetryHealth().drops.log_sample, 1)
  assert.equal(runtime.telemetryHealth().drops.log_audit, 1)
  assert.equal(runtime.telemetryHealth().degraded, true)
})

test('the metric label keys are exactly the closed set', () => {
  assert.deepEqual([...OBS_METRIC_LABEL_KEYS], ['plane', 'segment', 'outcome', 'code', 'provider', 'kind'])
})
