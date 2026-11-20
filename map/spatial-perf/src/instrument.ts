/**
 * The segmented measurement plane: a bounded sampler that records how long
 * each named segment took, under which bounded labels, with which outcome —
 * plus byte and memory samplers for the planes the design's runtime-metrics
 * section names (peak memory, session/meta/display bytes, scan volumes).
 *
 * Three rules keep the telemetry honest:
 *
 * - **Labels never carry payload.** Label keys come from the closed
 *   {@link PERF_LABEL_KEYS} vocabulary and values are short strings; passing
 *   a result document, geometry, or error text as a label refuses loudly at
 *   the sampler, not in review.
 * - **Failure paths are sampled, not swallowed.** A measured function that
 *   throws still records its sample (outcome `failed`) before the original
 *   error rethrows; the sampler itself never converts a failure into a
 *   success sample and never hides one.
 * - **Overflow degrades visibly.** The record buffer is fixed-capacity; past
 *   capacity the sampler marks telemetry `degraded`, counts dropped samples,
 *   and keeps counting — it never grows without bound and never pretends the
 *   excess was measured.
 *
 * @module @map-harness/spatial-perf/instrument
 */
import {
  MAX_LABEL_VALUE_CHARS,
  PERF_LABEL_KEYS,
  PERF_OUTCOMES,
  PERF_SEGMENTS,
  type PerfLabels,
  type PerfOutcome,
  type PerfSegment,
} from './contract.ts'

/** One recorded sample: which segment, how long, which outcome, what labels. */
export interface PerfSampleRecord {
  /** Monotonic 1-based sample index within one sampler. */
  readonly seq: number
  readonly segment: PerfSegment
  readonly labels: PerfLabels
  /** Wall-clock milliseconds the segment took (float ms; reports round). */
  readonly wallMs: number
  readonly outcome: PerfOutcome
}

/** The aggregate of one (segment, outcome) pair over one sampler's samples. */
export interface PerfSegmentSummary {
  readonly segment: PerfSegment
  readonly outcome: PerfOutcome
  /** Sample count. */
  readonly count: number
  /** Total wall-clock milliseconds (rounded to 3 decimals). */
  readonly totalMs: number
  /** Slowest sample in milliseconds. */
  readonly maxMs: number
  /** Nearest-rank median in milliseconds. */
  readonly p50Ms: number
  /** Nearest-rank 95th percentile in milliseconds. */
  readonly p95Ms: number
}

/** The whole sampler's summary: per-segment aggregates plus telemetry health. */
export interface PerfSummary {
  readonly segments: readonly PerfSegmentSummary[]
  readonly sampleCount: number
  readonly degraded: boolean
  readonly droppedSamples: number
}

/** The rank one summary needs before a percentile exists (need at least this many samples). */
const MIN_PERCENTILE_SAMPLES = 2

/**
 * The bounded segmented sampler. One benchmark run (or one measured plane)
 * owns one sampler; samples are read through {@link PerfSampler.summary} or
 * the raw {@link PerfSampler.records}.
 */
export class PerfSampler {
  private readonly capacity: number
  private buffer: PerfSampleRecord[] = []
  private nextSeq = 1
  private dropped = 0
  private readonly active = new Map<PerfSegment, { readonly startedAt: bigint; readonly labels: PerfLabels }>()

  /**
   * @param options - `capacity` bounds the record buffer (default 4096).
   */
  constructor(options: { capacity?: number } = {}) {
    this.capacity = options.capacity ?? 4_096
  }

  /** The recorded samples so far (bounded; overflow counts as dropped, not silent). */
  get records(): readonly PerfSampleRecord[] {
    return this.buffer
  }

  /** Whether the buffer overflowed (samples were dropped past the capacity). */
  get degraded(): boolean {
    return this.dropped > 0
  }

  /** How many samples were dropped past the capacity. */
  get droppedSamples(): number {
    return this.dropped
  }

  /**
   * Measure one synchronous segment around one function. The function's
   * return value passes through; a throw records the sample with outcome
   * `failed` (or `cancelled` when the caller pre-labels the throw) and
   * rethrows the original error.
   * @param segment - the closed-vocabulary segment name.
   * @param labels - bounded labels (known keys, short values).
   * @param body - the measured function.
   * @returns the function's result.
   */
  sample<T>(segment: PerfSegment, labels: PerfLabels, body: () => T): T {
    const startedAt = process.hrtime.bigint()
    let outcome: PerfOutcome = 'succeeded'
    try {
      return body()
    } catch (error) {
      outcome = outcomeForThrown(error)
      throw error
    } finally {
      this.record(segment, labels, startedAt, outcome)
    }
  }

  /**
   * Measure one asynchronous segment around one promise-returning function.
   * A rejection records outcome `failed` (or the caller's cancelled marker)
   * and rethrows the original reason.
   * @param segment - the closed-vocabulary segment name.
   * @param labels - bounded labels.
   * @param body - the measured async function.
   * @returns the promise's resolution.
   */
  async sampleAsync<T>(segment: PerfSegment, labels: PerfLabels, body: () => Promise<T>): Promise<T> {
    const startedAt = process.hrtime.bigint()
    let outcome: PerfOutcome = 'succeeded'
    try {
      return await body()
    } catch (error) {
      outcome = outcomeForThrown(error)
      throw error
    } finally {
      this.record(segment, labels, startedAt, outcome)
    }
  }

  /**
   * Begin one explicit segment (for spans that end in a different stack
   * frame). Unbalanced or duplicated active segments of the same name refuse
   * loudly — silent overlap would misattribute the span.
   * @param segment - the closed-vocabulary segment name.
   * @param labels - bounded labels captured at begin.
   */
  begin(segment: PerfSegment, labels: PerfLabels = {}): void {
    assertSegment(segment)
    assertLabels(labels)
    if (this.active.has(segment)) {
      throw new Error(`perf segment "${segment}" is already active; nested spans of one segment refuse`)
    }
    this.active.set(segment, { startedAt: process.hrtime.bigint(), labels })
  }

  /**
   * End one explicit segment and record its sample.
   * @param segment - the segment previously begun.
   * @param outcome - the settled outcome (default `succeeded`).
   */
  end(segment: PerfSegment, outcome: PerfOutcome = 'succeeded'): void {
    assertSegment(segment)
    assertOutcome(outcome)
    const span = this.active.get(segment)
    if (span === undefined) {
      throw new Error(`perf segment "${segment}" end without begin`)
    }
    this.active.delete(segment)
    this.record(segment, span.labels, span.startedAt, outcome)
  }

  /**
   * Measure one wait state to its deterministic settlement: from the call to
   * the promise's resolution (flush barrier, cancel-to-quiescence, display
   * derivation). No sleeps — the wall time ends exactly when the awaited
   * work settles. The wait's rejection records `failed` and rethrows.
   * @param segment - the segment whose settlement is measured (`flush`,
   *   `cancel`, `render`, …).
   * @param labels - bounded labels.
   * @param until - the promise whose settlement ends the measurement.
   * @returns the promise's resolution.
   */
  async wait<T>(segment: PerfSegment, labels: PerfLabels, until: Promise<T>): Promise<T> {
    const startedAt = process.hrtime.bigint()
    let outcome: PerfOutcome = 'succeeded'
    try {
      return await until
    } catch (error) {
      outcome = outcomeForThrown(error)
      throw error
    } finally {
      this.record(segment, labels, startedAt, outcome)
    }
  }

  /** Current process heap-used bytes (the caller marks before/after and diffs). */
  heapUsedBytes(): number {
    return process.memoryUsage().heapUsed
  }

  /**
   * The serialized UTF-8 byte length of one JSON value — the byte measure
   * every bytes budget spends (meta, display, projection, session envelopes).
   * @param value - the JSON value to measure.
   * @returns the UTF-8 byte length of its canonical JSON form.
   */
  bytesOf(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8')
  }

  /**
   * Aggregate the recorded samples by (segment, outcome).
   * @returns the summary with telemetry health.
   */
  summary(): PerfSummary {
    const groups = new Map<string, PerfSampleRecord[]>()
    for (const record of this.buffer) {
      const key = `${record.segment}\u0000${record.outcome}`
      const bucket = groups.get(key)
      if (bucket === undefined) groups.set(key, [record])
      else bucket.push(record)
    }
    const segments: PerfSegmentSummary[] = [...groups.values()].map(records => {
      const walls = records.map(record => record.wallMs).sort((a, b) => a - b)
      const total = walls.reduce((sum, wall) => sum + wall, 0)
      return {
        segment: records[0]!.segment,
        outcome: records[0]!.outcome,
        count: records.length,
        totalMs: round3(total),
        maxMs: round3(walls[walls.length - 1]!),
        p50Ms: round3(nearestRank(walls, 0.5)),
        p95Ms: round3(nearestRank(walls, 0.95)),
      }
    })
    segments.sort((a, b) => a.segment.localeCompare(b.segment) || a.outcome.localeCompare(b.outcome))
    return {
      segments,
      sampleCount: this.buffer.length,
      degraded: this.degraded,
      droppedSamples: this.dropped,
    }
  }

  /** Record one completed sample; overflow past the capacity degrades visibly. */
  private record(segment: PerfSegment, labels: PerfLabels, startedAt: bigint, outcome: PerfOutcome): void {
    assertSegment(segment)
    assertOutcome(outcome)
    assertLabels(labels)
    const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    if (this.buffer.length + 1 > this.capacity) {
      this.dropped += 1
      return
    }
    this.buffer.push({
      seq: this.nextSeq++,
      segment,
      labels,
      wallMs: round3(wallMs),
      outcome,
    })
  }
}

/** One thrown error marked cancelled (the cancellation race's losing side labels itself). */
export class PerfCancelledError extends Error {}

/**
 * Wrap an error so a measured function reports outcome `cancelled` instead of
 * `failed` (for example the cancellation race's losing side).
 * @param error - the original error.
 * @returns the marked error (the same instance, brand-tagged).
 */
export function markPerfCancelled(error: unknown): unknown {
  if (error instanceof Error) {
    Object.defineProperty(error, markSymbol, { value: true, enumerable: false })
    return error
  }
  const wrapped = new PerfCancelledError(String(error))
  Object.defineProperty(wrapped, markSymbol, { value: true, enumerable: false })
  return wrapped
}

const markSymbol = Symbol('perf-cancelled')

/** The outcome a thrown value records: cancelled when marked, failed otherwise. */
function outcomeForThrown(error: unknown): PerfOutcome {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[markSymbol] === true
    ? 'cancelled'
    : 'failed'
}

/** Nearest-rank percentile over one ascending-sorted wall list. */
function nearestRank(sorted: readonly number[], quantile: number): number {
  if (sorted.length < MIN_PERCENTILE_SAMPLES) return sorted[0] ?? 0
  const rank = Math.max(1, Math.ceil(quantile * sorted.length))
  return sorted[rank - 1]!
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Refuse anything outside the closed segment vocabulary. */
function assertSegment(segment: PerfSegment): void {
  if (!(PERF_SEGMENTS as readonly string[]).includes(segment)) {
    throw new Error(`perf segment "${String(segment)}" is outside the closed vocabulary (${PERF_SEGMENTS.join(', ')})`)
  }
}

/** Refuse unknown outcomes. */
function assertOutcome(outcome: PerfOutcome): void {
  if (!(PERF_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error(`perf outcome "${String(outcome)}" is outside the closed vocabulary (${PERF_OUTCOMES.join(', ')})`)
  }
}

/**
 * Refuse labels that could smuggle payload: unknown keys, non-string values,
 * or over-long values all refuse at the sampler.
 */
function assertLabels(labels: PerfLabels): void {
  for (const [key, value] of Object.entries(labels)) {
    if (!(PERF_LABEL_KEYS as readonly string[]).includes(key)) {
      throw new Error(`perf label key "${key}" is outside the closed vocabulary (${PERF_LABEL_KEYS.join(', ')}); payload never becomes a label`)
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LABEL_VALUE_CHARS) {
      throw new Error(`perf label "${key}" must be a nonempty string of at most ${MAX_LABEL_VALUE_CHARS} characters`)
    }
  }
}
