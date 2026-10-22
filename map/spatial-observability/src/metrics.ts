/**
 * The low-cardinality metrics plane. Metric names, label keys, and label
 * values all come from the closed contract vocabularies; the recorder refuses
 * loudly on anything else, because a payload value that slipped into a label
 * is a cardinality-explosion bug that must fail here — before it reaches an
 * external monitoring system.
 *
 * Runtime conditions are different: past the fixed series capacity the
 * recorder counts a drop and keeps serving — telemetry degradation stays
 * visible (the runtime rolls it into `obs_telemetry_dropped_total{kind:
 * metric}`), and the main spatial result is never blocked.
 *
 * @module @map-harness/spatial-observability/metrics
 */
import {
  assertInVocabulary,
  DEFAULT_OBS_CAPACITY,
  metricLabelKeys,
  OBS_DROP_KINDS,
  OBS_ERROR_CODE_LIST,
  OBS_HEALTH_PLANES,
  OBS_METRIC_LABEL_KEYS,
  OBS_OUTCOMES,
  OBS_PROVIDERS,
  OBS_SEGMENTS,
  type ObsDropKind,
  type ObsErrorCode,
  type ObsHealthPlane,
  type ObsMetricLabels,
  type ObsMetricName,
  type ObsOutcome,
  type ObsProvider,
} from './contract.ts'

/** One counter series: a closed name plus its closed label set. */
export interface ObsCounterSnapshot {
  readonly name: ObsMetricName
  readonly labels: ObsMetricLabels
  readonly count: number
}

/** One latency/bytes/wait observation series with nearest-rank percentiles. */
export interface ObsObservationSnapshot {
  readonly name: ObsMetricName
  readonly labels: ObsMetricLabels
  readonly count: number
  readonly total: number
  readonly max: number
  readonly p50: number
  readonly p95: number
}

/** The whole registry's snapshot: counters, observation series, gauges, drop health. */
export interface ObsMetricsSnapshot {
  readonly counters: readonly ObsCounterSnapshot[]
  readonly observations: readonly ObsObservationSnapshot[]
  readonly gauges: readonly ObsCounterSnapshot[]
  readonly degraded: boolean
  readonly droppedObservations: number
}

/** The observation-series names `observe()` accepts. */
export type ObsObservationName = 'obs_segment_latency_ms' | 'obs_segment_bytes' | 'obs_queue_wait_ms'

/** Round to 3 decimals; the reporting unit is ms/bytes at that resolution. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** One bounded metrics registry. */
export class ObsMetrics {
  private readonly capacity: number
  private counters = new Map<string, { name: ObsMetricName; labels: ObsMetricLabels; count: number }>()
  private observationSeries = new Map<string, { name: ObsMetricName; labels: ObsMetricLabels; values: number[] }>()
  private gauges = new Map<string, { name: ObsMetricName; labels: ObsMetricLabels; count: number }>()
  private dropped = 0

  /** @param options - `capacity` bounds the total series count (default 1024). */
  constructor(options: { capacity?: number } = {}) {
    this.capacity = options.capacity ?? DEFAULT_OBS_CAPACITY
  }

  /** Observation values dropped past the capacity (exact, never silent). */
  get droppedObservations(): number {
    return this.dropped
  }

  /** Whether any observation was dropped (telemetry degraded). */
  get degraded(): boolean {
    return this.dropped > 0
  }

  /**
   * Increment one closed counter series.
   * @param name - the closed counter name (the `*_total` set).
   * @param labels - closed label set; unknown keys or values refuse loudly.
   * @param by - the increment (positive integer, default 1).
   */
  counter(name: ObsMetricName, labels: ObsMetricLabels = {}, by = 1): void {
    assertCounterName(name)
    assertLabels(name, labels)
    if (!Number.isInteger(by) || by <= 0) throw new Error(`counter increment must be a positive integer, got ${String(by)}`)
    const key = seriesKey(name, labels)
    const existing = this.counters.get(key)
    if (existing !== undefined) {
      existing.count += by
      return
    }
    if (this.counters.size + 1 > this.capacity) {
      this.dropped += by
      return
    }
    this.counters.set(key, { name, labels, count: by })
  }

  /**
   * Observe one latency (ms), byte movement, or queue wait value on a closed series.
   * @param name - the closed observation name.
   * @param value - the nonnegative finite observed value.
   * @param labels - closed label set (the metric's segment/plane).
   */
  observe(name: ObsObservationName, value: number, labels: ObsMetricLabels): void {
    assertLabels(name, labels)
    if (!Number.isFinite(value) || value < 0) throw new Error(`observation must be a nonnegative finite number, got ${String(value)}`)
    const key = seriesKey(name, labels)
    const existing = this.observationSeries.get(key)
    if (existing !== undefined) {
      if (existing.values.length + 1 > this.capacity) {
        this.dropped += 1
        return
      }
      existing.values.push(round3(value))
      return
    }
    if (this.observationSeries.size + 1 > this.capacity) {
      this.dropped += 1
      return
    }
    this.observationSeries.set(key, { name, labels, values: [round3(value)] })
  }

  /**
   * Set one queue-depth gauge for a plane (a gauge replaces, it does not accumulate).
   * @param plane - the closed plane the queue belongs to.
   * @param depth - the current depth (nonnegative integer).
   */
  gaugeQueueDepth(plane: ObsHealthPlane, depth: number): void {
    assertLabels('obs_queue_depth', { plane })
    if (!Number.isInteger(depth) || depth < 0) throw new Error(`queue depth must be a nonnegative integer, got ${String(depth)}`)
    const key = seriesKey('obs_queue_depth', { plane })
    const existing = this.gauges.get(key)
    if (existing !== undefined) {
      existing.count = depth
      return
    }
    if (this.gauges.size + 1 > this.capacity) {
      this.dropped += 1
      return
    }
    this.gauges.set(key, { name: 'obs_queue_depth', labels: { plane }, count: depth })
  }

  /**
   * Record one settled operation on `obs_operations_total{plane,outcome}`.
   * @param plane - the plane the operation ran on.
   * @param outcome - the closed outcome.
   */
  countOperation(plane: ObsHealthPlane, outcome: ObsOutcome): void {
    this.counter('obs_operations_total', { plane, outcome })
  }

  /**
   * Count one provider call (and its rate-limit refusal) on the closed provider vocabulary.
   * @param provider - the closed provider.
   * @param outcome - the closed outcome of the call.
   */
  countProviderCall(provider: ObsProvider, outcome: ObsOutcome): void {
    this.counter('obs_provider_calls_total', { provider, outcome })
  }

  /**
   * Count one provider rate-limit refusal on `obs_provider_rate_limited_total{provider}`.
   * @param provider - the closed provider.
   * @param code - must be the rate-limit code (the only code this series accepts).
   */
  countProviderRateLimit(provider: ObsProvider, code: ObsErrorCode): void {
    if (code !== 'PROVIDER_RATE_LIMITED') {
      throw new Error(`obs_provider_rate_limited_total only accepts PROVIDER_RATE_LIMITED, got ${code}`)
    }
    this.counter('obs_provider_rate_limited_total', { provider })
  }

  /**
   * Count one telemetry drop on the closed drop-kind vocabulary (the
   * observability plane's own failure accounting; log/metric/export planes
   * report their drops through here in the runtime rollup).
   * @param kind - the closed drop kind.
   * @param by - the dropped amount (positive integer, default 1).
   */
  countTelemetryDrop(kind: ObsDropKind, by = 1): void {
    this.counter('obs_telemetry_dropped_total', { kind }, by)
  }

  /** The snapshot: counters, observation percentiles, gauges, drop health. */
  snapshot(): ObsMetricsSnapshot {
    const counters = [...this.counters.values()]
      .map(series => ({ name: series.name, labels: series.labels, count: series.count }))
      .sort((a, b) => a.name.localeCompare(b.name) || labelKey(a.labels).localeCompare(labelKey(b.labels)))
    const observations = [...this.observationSeries.values()]
      .map(series => {
        const sorted = [...series.values].sort((a, b) => a - b)
        return {
          name: series.name,
          labels: series.labels,
          count: sorted.length,
          total: round3(sorted.reduce((sum, value) => sum + value, 0)),
          max: sorted[sorted.length - 1] ?? 0,
          p50: percentile(sorted, 0.5),
          p95: percentile(sorted, 0.95),
        }
      })
      .sort((a, b) => a.name.localeCompare(b.name) || labelKey(a.labels).localeCompare(labelKey(b.labels)))
    const gauges = [...this.gauges.values()]
      .map(series => ({ name: series.name, labels: series.labels, count: series.count }))
      .sort((a, b) => labelKey(a.labels).localeCompare(labelKey(b.labels)))
    return {
      counters,
      observations,
      gauges,
      degraded: this.dropped > 0,
      droppedObservations: this.dropped,
    }
  }

  /** The current value of one counter series, or 0 when never touched. */
  counterValue(name: ObsMetricName, labels: ObsMetricLabels = {}): number {
    return this.counters.get(seriesKey(name, labels))?.count ?? 0
  }

  /** The observation count of one series, or 0 when never touched. */
  observationCount(name: ObsObservationName, labels: ObsMetricLabels): number {
    return this.observationSeries.get(seriesKey(name, labels))?.values.length ?? 0
  }
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length < 2) return sorted[0] ?? 0
  const rank = Math.max(1, Math.ceil(quantile * sorted.length))
  return sorted[rank - 1]!
}

const COUNTER_NAMES: readonly string[] = [
  'obs_operations_total',
  'obs_flush_failures_total',
  'obs_artifact_publish_failures_total',
  'obs_provider_calls_total',
  'obs_provider_rate_limited_total',
  'obs_render_failures_total',
  'obs_fault_injections_total',
  'obs_telemetry_dropped_total',
]

function assertCounterName(name: ObsMetricName): void {
  if (!COUNTER_NAMES.includes(name)) {
    throw new Error(`"${name}" is not a counter; use observe() for latency/bytes/wait series`)
  }
}

/** Validate labels against the metric's fixed label keys and the closed value vocabularies. */
function assertLabels(name: ObsMetricName, labels: ObsMetricLabels): void {
  const allowed = metricLabelKeys(name)
  for (const key of Object.keys(labels)) {
    assertInVocabulary(key, OBS_METRIC_LABEL_KEYS, 'metric label key')
    if (!(allowed as readonly string[]).includes(key)) {
      throw new Error(`metric "${name}" does not accept the label key "${key}" (accepts: ${allowed.join(', ') || 'none'})`)
    }
  }
  // The declared keys are required: a series without its full label set
  // would be an unlabeled shape the vocabulary never defined.
  for (const key of allowed) {
    if (!(key in labels)) {
      throw new Error(`metric "${name}" requires the label key "${key}"`)
    }
  }
  if (labels.plane !== undefined) assertInVocabulary(labels.plane, OBS_HEALTH_PLANES, 'label plane')
  if (labels.segment !== undefined) assertInVocabulary(labels.segment, OBS_SEGMENTS, 'label segment')
  if (labels.outcome !== undefined) assertInVocabulary(labels.outcome, OBS_OUTCOMES, 'label outcome')
  if (labels.code !== undefined) assertInVocabulary(labels.code, OBS_ERROR_CODE_LIST, 'label code')
  if (labels.provider !== undefined) assertInVocabulary(labels.provider, OBS_PROVIDERS, 'label provider')
  if (labels.kind !== undefined) assertInVocabulary(labels.kind, OBS_DROP_KINDS, 'label kind')
}

function seriesKey(name: ObsMetricName, labels: ObsMetricLabels): string {
  return `${name}\u0000${labelKey(labels)}`
}

function labelKey(labels: ObsMetricLabels): string {
  return OBS_METRIC_LABEL_KEYS.map(key => labels[key] ?? '').join('\u0001')
}
