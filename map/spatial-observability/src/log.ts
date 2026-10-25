/**
 * The structured log plane. Records are short facts with closed levels and
 * codes, correlation fields attached from the ambient scope, and caller
 * fields passed through the sanitizer before storage.
 *
 * Three rules keep the log honest under load:
 *
 * - **Failures and audit facts are never sampled away.** `warn`, `error`,
 *   and `audit` records always attempt storage; only `debug`/`info` records
 *   participate in deterministic keep-1-in-N sampling.
 * - **Overflow degrades visibly.** The buffer is fixed-capacity; past
 *   capacity records are dropped with an exact per-class dropped count and
 *   the log reports `degraded` — never unbounded growth, never a pretend
 *   retention.
 * - **Sink failures never propagate.** A throwing sink is a telemetry
 *   failure, not a caller failure: it is caught, counted (`log_sample` for
 *   non-audit classes, `log_audit` for audit-class), and the main result
 *   continues untouched.
 *
 * @module @map-harness/spatial-observability/log
 */
import {
  assertInVocabulary,
  DEFAULT_OBS_CAPACITY,
  MAX_LOG_MESSAGE_CHARS,
  OBS_DROP_KINDS,
  OBS_LOG_LEVELS,
  type ObsCorrelation,
  type ObsDropKind,
  type ObsErrorCode,
  type ObsLogLevel,
  type ObsLogRecord,
} from './contract.ts'
import { sanitizeRecord } from './sanitize.ts'

/** Where one log record goes; a throw is caught and counted, never propagated. */
export type ObsLogSink = (record: ObsLogRecord) => void

/** One bounded structured log. */
export class ObsLog {
  private readonly capacity: number
  private readonly sampleEvery: number
  private readonly sink: ObsLogSink | undefined
  private readonly clock: () => number
  private buffer: ObsLogRecord[] = []
  private nextSeq = 1
  private droppedBySampling = 0
  private droppedByCapacity = 0
  private droppedAuditRecords = 0
  private sinkFailureCount = 0
  private sampleSinkFailures = 0
  private auditSinkFailures = 0

  /**
   * @param options - `capacity` bounds the buffer (default 1024);
   *   `sampleEvery` keeps 1-in-N `debug`/`info` records (default 1 = keep
   *   all); `sink` receives every stored record; `clock` overrides `Date.now`.
   */
  constructor(options: { capacity?: number; sampleEvery?: number; sink?: ObsLogSink; clock?: () => number } = {}) {
    this.capacity = options.capacity ?? DEFAULT_OBS_CAPACITY
    if (!Number.isInteger(options.sampleEvery ?? 1) || (options.sampleEvery ?? 1) < 1) {
      throw new Error(`sampleEvery must be a positive integer, got ${String(options.sampleEvery)}`)
    }
    this.sampleEvery = options.sampleEvery ?? 1
    this.sink = options.sink
    this.clock = options.clock ?? (() => Date.now())
  }

  /** The stored records so far (bounded; overflows are counted as dropped). */
  get records(): readonly ObsLogRecord[] {
    return this.buffer
  }

  /** `debug`/`info` records dropped by sampling or capacity. */
  get droppedSamples(): number {
    return this.droppedBySampling + this.droppedByCapacity
  }

  /** `warn`/`error`/`audit` records dropped by capacity — failures never drop by sampling. */
  get droppedAudit(): number {
    return this.droppedAuditRecords
  }

  /** Sink invocations that threw (counted, never propagated). */
  get sinkFailures(): number {
    return this.sinkFailureCount
  }

  /** Whether any record was dropped or any sink failed (telemetry degraded). */
  get degraded(): boolean {
    return this.droppedSamples > 0 || this.droppedAuditRecords > 0 || this.sinkFailureCount > 0
  }

  /** Total dropped records across all classes (exact, never reconstructed). */
  get droppedTotal(): number {
    return this.droppedSamples + this.droppedAuditRecords
  }

  /** The drop counts keyed by the closed `obs_telemetry_dropped_total{kind}` vocabulary. */
  dropCounts(): Record<ObsDropKind, number> {
    const counts = Object.fromEntries(OBS_DROP_KINDS.map(kind => [kind, 0])) as Record<ObsDropKind, number>
    counts.log_sample = this.droppedBySampling + this.droppedByCapacity + this.sampleSinkFailures
    counts.log_audit = this.droppedAudit + this.auditSinkFailures
    return counts
  }

  /**
   * Emit one structured record.
   * @param level - the closed level; `audit` marks a safety-relevant fact that sampling never drops.
   * @param message - a short static fact (over-long messages refuse loudly — payload does not become prose).
   * @param options - `code` (closed error code, required for `error`), `correlation` (ambient scope value when omitted),
   *   `fields` (sanitized before storage), `forceKeep` (bypass sampling for one `debug`/`info` record).
   * @returns the stored record, or `undefined` when sampling or capacity dropped it.
   */
  emit(
    level: ObsLogLevel,
    message: string,
    options: {
      code?: ObsErrorCode
      correlation?: ObsCorrelation
      fields?: Record<string, unknown>
      forceKeep?: boolean
    } = {},
  ): ObsLogRecord | undefined {
    assertInVocabulary(level, OBS_LOG_LEVELS, 'log level')
    if (level === 'error' && options.code === undefined) {
      throw new Error('an error-level log record must carry a closed error code')
    }
    if (message.length === 0 || message.length > MAX_LOG_MESSAGE_CHARS) {
      throw new Error(`log message must be 1..${MAX_LOG_MESSAGE_CHARS} characters, got ${message.length}`)
    }
    const seq = this.nextSeq++
    const isSampleClass = level === 'debug' || level === 'info'
    if (isSampleClass && !options.forceKeep && (seq - 1) % this.sampleEvery !== 0) {
      this.droppedBySampling += 1
      return undefined
    }
    const sanitized = options.fields === undefined ? { fields: undefined, redactions: [] as readonly string[] } : sanitizeRecord(options.fields)
    const record: ObsLogRecord = {
      seq,
      atMs: this.clock(),
      level,
      ...(options.code === undefined ? {} : { code: options.code }),
      message: sanitized.redactions.length === 0 ? message : `${message} [sanitized: ${sanitized.redactions.length} field edit(s)]`,
      ...(options.correlation === undefined ? {} : { correlation: options.correlation }),
      ...(sanitized.fields === undefined ? {} : { fields: sanitized.fields }),
    }
    if (this.buffer.length + 1 > this.capacity) {
      if (isSampleClass) this.droppedByCapacity += 1
      else this.droppedAuditRecords += 1
      return undefined
    }
    this.buffer.push(record)
    this.deliverToSink(record)
    return record
  }

  private deliverToSink(record: ObsLogRecord): void {
    if (this.sink === undefined) return
    try {
      this.sink(record)
    } catch {
      // Telemetry failure, not a caller failure: counted by class, never propagated.
      this.sinkFailureCount += 1
      if (record.level === 'debug' || record.level === 'info') this.sampleSinkFailures += 1
      else this.auditSinkFailures += 1
    }
  }
}
