/**
 * Instrumentation fixtures: the segmented metric planes (latency, bytes,
 * scan, queue wait/depth, flush, render, provider) record under the closed
 * vocabulary with bounded, low-cardinality series; correlation attaches to
 * every record and metric-adjacent audit fact from the ambient scope; and
 * the bounded operation index answers "what happened to this operation".
 * Source plane; deterministic clock.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ObservabilityRuntime,
  OBS_SEGMENTS,
  OBSERVABILITY_METHOD_VERSION,
} from '../src/index.ts'

function tickClock() {
  let now = 1_000
  return () => (now += 5)
}

test('segment latency records every closed segment with count and percentiles', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  for (const segment of OBS_SEGMENTS) {
    runtime.measure(segment, () => {
      // Deterministic work so every observation is a real measured span.
      let sum = 0
      for (let index = 0; index < 200; index += 1) sum += index
      return sum
    })
  }
  const snapshot = runtime.metrics.snapshot()
  assert.equal(snapshot.observations.length, OBS_SEGMENTS.length)
  for (const segment of OBS_SEGMENTS) {
    const series = snapshot.observations.find(entry => entry.name === 'obs_segment_latency_ms' && entry.labels.segment === segment)
    assert.ok(series !== undefined, `segment ${segment} measured`)
    assert.equal(series.count, 1)
    assert.ok(series.p50 >= 0 && series.max >= series.p50)
  }
})

test('a throwing measured segment still records its observation and rethrows', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  assert.throws(() => runtime.measure('compute', () => { throw new Error('compute exploded') }), /compute exploded/)
  assert.equal(runtime.metrics.observationCount('obs_segment_latency_ms', { segment: 'compute' }), 1)
})

test('bytes, scan, queue wait, and queue depth record on their closed planes', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  const meta = { kind: 'map-change', revision: 4, layers: [{ id: 'roads' }] }
  runtime.metrics.observe('obs_segment_bytes', Buffer.byteLength(JSON.stringify(meta), 'utf8'), { segment: 'commit' })
  runtime.metrics.observe('obs_segment_bytes', 2_048, { segment: 'scan' })
  runtime.metrics.observe('obs_queue_wait_ms', 12.5, { plane: 'run' })
  runtime.metrics.gaugeQueueDepth('run', 3)
  runtime.metrics.gaugeQueueDepth('run', 1, )
  const snapshot = runtime.metrics.snapshot()
  const commitBytes = snapshot.observations.find(entry => entry.name === 'obs_segment_bytes' && entry.labels.segment === 'commit')
  assert.equal(commitBytes.count, 1)
  assert.ok(commitBytes.max > 0)
  assert.equal(snapshot.observations.find(entry => entry.labels.segment === 'scan').max, 2048)
  const queueWait = snapshot.observations.find(entry => entry.name === 'obs_queue_wait_ms')
  assert.equal(queueWait.labels.plane, 'run')
  assert.equal(queueWait.p50, 12.5)
  assert.deepEqual(snapshot.gauges.map(gauge => [gauge.labels.plane, gauge.count]), [['run', 1]], 'a gauge replaces, it does not accumulate')
})

test('flush, artifact-publish, and render failure counters stay separate named series', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.metrics.counter('obs_flush_failures_total')
  runtime.metrics.counter('obs_flush_failures_total')
  runtime.metrics.counter('obs_artifact_publish_failures_total')
  runtime.metrics.counter('obs_render_failures_total')
  assert.equal(runtime.metrics.counterValue('obs_flush_failures_total'), 2)
  assert.equal(runtime.metrics.counterValue('obs_artifact_publish_failures_total'), 1)
  assert.equal(runtime.metrics.counterValue('obs_render_failures_total'), 1)
})

test('provider calls and rate-limit refusals count on the closed provider vocabulary', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  runtime.metrics.countProviderCall('lbs', 'succeeded')
  runtime.metrics.countProviderCall('lbs', 'failed')
  runtime.metrics.countProviderRateLimit('lbs', 'PROVIDER_RATE_LIMITED')
  assert.equal(runtime.metrics.counterValue('obs_provider_calls_total', { provider: 'lbs', outcome: 'succeeded' }), 1)
  assert.equal(runtime.metrics.counterValue('obs_provider_calls_total', { provider: 'lbs', outcome: 'failed' }), 1)
  assert.equal(runtime.metrics.counterValue('obs_provider_rate_limited_total', { provider: 'lbs' }), 1)
  assert.throws(() => runtime.metrics.countProviderRateLimit('lbs', 'FLUSH_FAILED'), /only accepts PROVIDER_RATE_LIMITED/)
})

test('one operation correlates across planes without threading parameters', async () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  const trace = await runtime.scope({ domain: 'local', sessionId: 'sess-flow', sourceCallSeq: 11, runId: 'run-77', goalRevision: 2 }, async () => {
    // Tool plane: arguments serialization (context) + tool event.
    runtime.measure('context', () => JSON.stringify({ name: 'map_add_layer', args: { id: 'roads' } }))
    runtime.emit('info', 'tool call received')
    // Artifact plane: a catalog publication.
    runtime.measure('commit', () => 'artifact res-x@v1')
    runtime.emit('info', 'artifact published')
    // Session plane: the accepted settlement.
    runtime.reportOutcome('data', 'succeeded')
    // Render plane: display derivation.
    runtime.measure('render', () => ({ layers: 1 }))
    runtime.emit('info', 'display derived')
    await Promise.resolve()
    runtime.emit('info', 'async continuation still correlated')
    return runtime.current()
  })
  assert.equal(runtime.current(), undefined, 'the scope closed; assertions read stored facts')
  assert.equal(trace.operationRef, 'op:local:sess-flow#11')
  assert.equal(trace.runId, 'run-77')
  assert.equal(trace.goalRevision, 2)
  const correlated = runtime.log.records.filter(record => record.level === 'info')
  assert.equal(correlated.length, 4)
  for (const record of correlated) {
    assert.equal(record.correlation.operationRef, 'op:local:sess-flow#11')
    assert.equal(record.correlation.traceId, trace.traceId)
    assert.equal(record.correlation.runId, 'run-77')
  }
  // The correlation index answers the query the runbook starts from.
  const exportDoc = runtime.exportDiagnostic().document
  const entry = exportDoc.operations.find(candidate => candidate.correlation.operationRef === 'op:local:sess-flow#11')
  assert.ok(entry !== undefined, 'the operation is queryable in the diagnostic export')
  assert.equal(entry.logCounts.info, 4)
  assert.equal(entry.correlation.goalRevision, 2)
})

test('the operation index stays bounded (LRU) as operations accumulate', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  for (let seq = 0; seq < 300; seq += 1) {
    runtime.scope({ domain: 'local', sessionId: 'sess-burst', sourceCallSeq: seq }, () => {
      runtime.reportOutcome('data', 'succeeded')
    })
  }
  const exportDoc = runtime.exportDiagnostic().document
  assert.ok(exportDoc.operations.length <= 256, 'the index holds at most its bounded capacity')
  const newest = exportDoc.operations.find(entry => entry.correlation.operationRef === 'op:local:sess-burst#299')
  assert.ok(newest !== undefined, 'the newest operation survives eviction')
  const oldest = exportDoc.operations.find(entry => entry.correlation.operationRef === 'op:local:sess-burst#0')
  assert.equal(oldest, undefined, 'the oldest operation was evicted')
})

test('metric series stay low-cardinality: one distinct series per closed label combination', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  for (const outcome of ['succeeded', 'failed', 'partial', 'cancelled', 'outcome_unknown', 'degraded']) {
    runtime.metrics.countOperation('data', /** @type {never} */ (outcome))
  }
  const operations = runtime.metrics.snapshot().counters.filter(counter => counter.name === 'obs_operations_total')
  assert.equal(operations.length, 6, 'six planes-outcome series, never one per operation')
  assert.equal(operations.reduce((sum, counter) => sum + counter.count, 0), 6)
})

test('the runtime reports its pinned method version', () => {
  const runtime = new ObservabilityRuntime({ clock: tickClock() })
  assert.equal(runtime.methodVersion, OBSERVABILITY_METHOD_VERSION)
})
