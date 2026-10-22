/**
 * The observability runtime: one facade that binds the correlation scope,
 * structured log, metrics, health, and fault matrix into the single entry
 * point consumers (tools, providers, the catalog, run services, the render
 * plane) adopt.
 *
 * - **The ambient scope carries correlation.** `runtime.scope(correlation, …)`
 *   propagates `operationRef`/`runId`/`goalRevision`/`traceId` through async
 *   continuations (`AsyncLocalStorage`), so every record, metric, and audit
 *   fact emitted inside the scope correlates without threading parameters —
 *   and the same operation reads as one chain across tool, artifact, Session,
 *   and render planes.
 * - **Telemetry failure never blocks the main result.** The sink is guarded;
 *   dropped records and observations are counted on the
 *   `obs_telemetry_dropped_total{kind}` series; telemetry self-health is a
 *   queryable fact (`telemetryHealth()`), not an exception.
 * - **Contract misuse fails loud.** A payload value in a label, a bad level,
 *   an out-of-vocabulary code: those are code bugs and throw at the call
 *   site — the boundary between "the telemetry is degraded" (counted) and
 *   "the caller misused the contract" (refused) is deliberate.
 *
 * @module @map-harness/spatial-observability/runtime
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  DEFAULT_OBS_CAPACITY,
  newTraceId,
  OBSERVABILITY_METHOD_VERSION,
  OBS_DROP_KINDS,
  OBS_FAULT_POINT_CODES,
  OBS_FAULT_POINT_PLANES,
  operationRefOf,
  validateCorrelation,
  type ObsCorrelation,
  type ObsErrorCode,
  type ObsFaultPoint,
  type ObsHealthPlane,
  type ObsLogLevel,
  type ObsLogRecord,
  type ObsOutcome,
  type ObsSegment,
} from './contract.ts'
import { ObsLog } from './log.ts'
import { ObsMetrics } from './metrics.ts'
import { ObsHealthRegistry } from './health.ts'
import { ObsFaultMatrix } from './faults.ts'
import { buildDiagnosticExport, type ObsDiagnosticExport, type ObsOperationIndexEntry } from './export.ts'

/** The correlation scope input: canonical parts, or a prebuilt operationRef. */
export interface ObsScopeInput {
  /** Authorization domain (used with `sessionId` + `sourceCallSeq` to build the operationRef). */
  readonly domain?: string
  /** Session the operation runs in. */
  readonly sessionId?: string
  /** The originating `tool/call` seq. */
  readonly sourceCallSeq?: number
  /** A prebuilt canonical operationRef (overrides the parts form). */
  readonly operationRef?: string
  /** Durable run identifier, when present. */
  readonly runId?: string
  /** Decision-frame goal revision, when present. */
  readonly goalRevision?: number
  /** Explicit trace id; inherits the enclosing scope's, else a fresh one. */
  readonly traceId?: string
}

/** Runtime construction options; every bound is capped by default. */
export interface ObservabilityRuntimeOptions {
  /** Log record buffer capacity (default 1024). */
  readonly logCapacity?: number
  /** Keep 1-in-N `debug`/`info` records; failures/audit facts are never sampled (default 1). */
  readonly sampleEvery?: number
  /** Guarded log sink (console, OTLP adapter, …); a throw is counted, never propagated. */
  readonly sink?: (record: ObsLogRecord) => void
  /** Total metric series capacity (default 1024). */
  readonly metricCapacity?: number
  /** Diagnostic export byte budget (default 64 KiB). */
  readonly maxExportBytes?: number
  /** Clock override (milliseconds); tests inject deterministic time. */
  readonly clock?: () => number
}

/** The correlation-index capacity (bounded, oldest evicted). */
const OPERATION_INDEX_CAPACITY = 256

/**
 * One observability runtime. Owns the ambient correlation scope and the four
 * telemetry planes; consumers hold one instance per process or per plane
 * scope.
 */
export class ObservabilityRuntime {
  /** The structured log (correlation attached from the ambient scope). */
  readonly log: ObsLog
  /** The low-cardinality metrics registry. */
  readonly metrics: ObsMetrics
  /** The per-plane health registry (transitions audited through the log). */
  readonly health: ObsHealthRegistry
  /** The deterministic fault-injection matrix (injections audited through the log). */
  readonly faults: ObsFaultMatrix

  private readonly als = new AsyncLocalStorage<ObsCorrelation>()
  private readonly maxExportBytes: number
  private readonly clock: () => number
  private readonly operations = new Map<string, ObsOperationIndexEntry>()

  constructor(options: ObservabilityRuntimeOptions = {}) {
    this.clock = options.clock ?? (() => Date.now())
    this.maxExportBytes = options.maxExportBytes ?? 64 * 1024
    this.log = new ObsLog({
      capacity: options.logCapacity ?? DEFAULT_OBS_CAPACITY,
      sampleEvery: options.sampleEvery ?? 1,
      clock: this.clock,
      ...(options.sink === undefined ? {} : { sink: options.sink }),
    })
    this.metrics = new ObsMetrics({ capacity: options.metricCapacity ?? DEFAULT_OBS_CAPACITY })
    this.health = new ObsHealthRegistry({
      clock: this.clock,
      onTransition: transition => {
        // Fixed-template audit fact; the transition detail is a short
        // operator-facing string already bounded by the health registry.
        this.log.emit(transition.to === 'ready' ? 'info' : 'warn', `health plane "${transition.plane}" ${transition.from} -> ${transition.to}`, {
          ...(transition.code === undefined ? {} : { code: transition.code }),
          fields: { plane: transition.plane, detail: transition.detail },
        })
      },
    })
    this.faults = new ObsFaultMatrix({
      clock: this.clock,
      onInjection: injection => {
        this.log.emit('audit', `fault injected at "${injection.point}" (${injection.code})`, {
          code: injection.code,
          ...(injection.correlation === undefined ? {} : { correlation: injection.correlation }),
          fields: { remaining: injection.remaining },
        })
      },
    })
  }

  /**
   * Enter one operation's correlation scope for the duration of `body`
   * (sync or async). Nested scopes inherit the parent's `traceId` unless an
   * explicit one is given — one trace follows an operation across planes.
   * @param input - the correlation parts (or a prebuilt `operationRef`).
   * @param body - the scoped function.
   * @returns the body's result.
   */
  scope<T>(input: ObsScopeInput, body: () => T): T {
    return this.als.run(this.resolveCorrelation(input), body)
  }

  /** The active ambient correlation, or `undefined` outside any scope. */
  current(): ObsCorrelation | undefined {
    return this.als.getStore()
  }

  /**
   * Emit one log record under the ambient correlation (explicit `correlation`
   * overrides).
   * @returns the stored record, or `undefined` when sampling or capacity dropped it.
   */
  emit(
    level: ObsLogLevel,
    message: string,
    options: { code?: ObsErrorCode; correlation?: ObsCorrelation; fields?: Record<string, unknown>; forceKeep?: boolean } = {},
  ): ObsLogRecord | undefined {
    const correlation = options.correlation ?? this.current()
    const record = this.log.emit(level, message, {
      ...options,
      ...(correlation === undefined ? {} : { correlation }),
    })
    if (record !== undefined && record.correlation !== undefined) {
      this.countIndexedRecord(record.correlation.operationRef, record.level)
    }
    return record
  }

  /**
   * Observe one segment's wall-clock cost around one function: the latency
   * series records the observation (a throw records it too, then rethrows
   * the original error — a slow failure is still a measured segment).
   * @param segment - the closed segment name.
   * @param body - the measured function.
   * @returns the function's result.
   */
  measure<T>(segment: ObsSegment, body: () => T): T {
    const startedAt = process.hrtime.bigint()
    try {
      return body()
    } finally {
      const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      this.metrics.observe('obs_segment_latency_ms', wallMs, { segment })
    }
  }

  /**
   * Record one operation's settled outcome: the operations counter, the
   * audit trail for non-success outcomes, and the bounded correlation index.
   * A `failed`/`degraded` settlement carries its closed code onto the audit
   * log; outcomes never guess — the unclassifiable settles as
   * `outcome_unknown` with no code.
   * @param plane - the plane the operation ran on.
   * @param outcome - the closed outcome.
   * @param options - `code` (required for `failed`/`degraded`), `correlation` (ambient default).
   */
  reportOutcome(
    plane: ObsHealthPlane,
    outcome: ObsOutcome,
    options: { code?: ObsErrorCode; correlation?: ObsCorrelation } = {},
  ): void {
    this.metrics.countOperation(plane, outcome)
    const correlation = options.correlation ?? this.current()
    if (correlation !== undefined) this.touchOperation(correlation)
    if (outcome === 'failed' || outcome === 'degraded') {
      if (options.code === undefined) {
        throw new Error(`a ${outcome} settlement must carry a closed error code`)
      }
      this.log.emit(outcome === 'failed' ? 'error' : 'warn', `operation on plane "${plane}" settled ${outcome}`, {
        code: options.code,
        ...(correlation === undefined ? {} : { correlation }),
        fields: { plane },
      })
    }
  }

  /**
   * Route one call through its fault point under the ambient correlation:
   * the injection record and audit fact carry the active scope's identity
   * automatically (the bare matrix has no ambient access; call sites that
   * need correlation route through here).
   * @param point - the closed fault point.
   * @param invoke - the real call.
   * @returns the real call's result.
   * @throws the matrix's coded fault error when armed.
   */
  hit<T>(point: ObsFaultPoint, invoke: () => T): T {
    const correlation = this.current()
    return this.faults.hit(point, invoke, correlation === undefined ? {} : { correlation })
  }

  /**
   * Record one injected-fault hit: the injection counter plus the coded
   * error fact. The operation's *settlement* classification stays with
   * {@link reportOutcome} — a caller counts the failed operation exactly
   * once, choosing `failed` or `outcome_unknown` as the record supports.
   * @param point - the fault point that fired.
   * @param correlation - ambient default.
   */
  reportFault(point: ObsFaultPoint, correlation?: ObsCorrelation): void {
    const code = OBS_FAULT_POINT_CODES[point]
    const resolved = correlation ?? this.current()
    this.metrics.counter('obs_fault_injections_total', { code })
    this.log.emit('error', `fault point "${point}" fired (${code})`, {
      code,
      ...(resolved === undefined ? {} : { correlation: resolved }),
      fields: { plane: OBS_FAULT_POINT_PLANES[point] },
    })
  }

  /**
   * The telemetry plane's own health: whether any log/metric drop or sink
   * failure happened, with the exact per-kind counts. Never throws;
   * degraded telemetry is a recorded fact, not an error path.
   */
  telemetryHealth(): { degraded: boolean; drops: Readonly<Record<string, number>>; totalDrops: number } {
    const logDrops = this.log.dropCounts()
    const metricDrops = this.metrics.droppedObservations
    const drops: Record<string, number> = Object.fromEntries(OBS_DROP_KINDS.map(kind => [kind, logDrops[kind] ?? 0]))
    drops.metric = metricDrops
    const totalDrops = Object.values(drops).reduce((sum, value) => sum + value, 0)
    return { degraded: totalDrops > 0, drops, totalDrops }
  }

  /**
   * Fold the telemetry plane's own health into the `process` health plane:
   * any drop marks the process `degraded` with the telemetry code and the
   * exact drop counts (cumulative for the run — a degradation that happened
   * stays reported), a clean run reports `ready`. The main spatial result is
   * never touched either way.
   * @returns the process plane's resulting health.
   */
  reportTelemetryHealth() {
    const health = this.telemetryHealth()
    if (!health.degraded) {
      return this.health.report('process', 'ready', { detail: 'telemetry clean' })
    }
    const detail = `telemetry dropped: ${Object.entries(health.drops)
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => `${kind}=${count}`)
      .join(', ')}`
    return this.health.report('process', 'degraded', { detail, code: 'TELEMETRY_DEGRADED' })
  }

  /**
   * Assemble the bounded sanitized diagnostic export.
   * @param options - `maxBytes` override for this one export.
   */
  exportDiagnostic(options: { maxBytes?: number } = {}): { document: ObsDiagnosticExport; json: string; bytes: number } {
    const result = buildDiagnosticExport(
      {
        log: this.log,
        metrics: this.metrics,
        health: this.health,
        faults: this.faults,
        operations: () => [...this.operations.values()],
        telemetryDrops: () => this.telemetryHealth().drops,
        nowMs: this.clock,
      },
      { maxBytes: options.maxBytes ?? this.maxExportBytes },
    )
    if (result.document.truncated && result.document.truncatedRecords > 0) {
      // The export itself dropped records to fit the budget: that is a
      // counted telemetry drop, never a silent trim.
      this.metrics.countTelemetryDrop('export', result.document.truncatedRecords)
    }
    return result
  }

  /** The method version this runtime reports (pinned by the contract). */
  get methodVersion(): typeof OBSERVABILITY_METHOD_VERSION {
    return OBSERVABILITY_METHOD_VERSION
  }

  /** Canonicalize + validate one scope input, generating the trace id when absent. */
  private resolveCorrelation(input: ObsScopeInput): ObsCorrelation {
    const parent = this.als.getStore()
    const operationRef = input.operationRef ?? buildScopeOperationRef(input)
    const correlation: ObsCorrelation = {
      operationRef,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      ...(input.goalRevision === undefined ? {} : { goalRevision: input.goalRevision }),
      traceId: input.traceId ?? parent?.traceId ?? newTraceId(),
    }
    validateCorrelation(correlation)
    this.touchOperation(correlation)
    return correlation
  }

  /** Index/touch one operation (bounded LRU map; re-touch refreshes recency). */
  private touchOperation(correlation: ObsCorrelation): void {
    const existing = this.operations.get(correlation.operationRef)
    const now = this.clock()
    if (existing !== undefined) {
      existing.lastSeenMs = now
      this.operations.delete(correlation.operationRef)
      this.operations.set(correlation.operationRef, existing)
      return
    }
    if (this.operations.size + 1 > OPERATION_INDEX_CAPACITY) {
      const oldest = this.operations.keys().next().value
      if (oldest !== undefined) this.operations.delete(oldest)
    }
    this.operations.set(correlation.operationRef, {
      correlation,
      logCounts: {},
      firstSeenMs: now,
      lastSeenMs: now,
    })
  }

  /** Bump one indexed operation's stored-record level count. */
  private countIndexedRecord(operationRef: string, level: ObsLogLevel): void {
    const entry = this.operations.get(operationRef)
    if (entry === undefined) return
    entry.logCounts = { ...entry.logCounts, [level]: (entry.logCounts[level] ?? 0) + 1 }
  }
}

/**
 * Build the operationRef from explicit scope parts. Missing parts refuse
 * loudly — the defaulting domain is the caller's explicit choice, never a
 * hidden `?? 'local'`.
 */
function buildScopeOperationRef(input: ObsScopeInput): string {
  if (input.domain === undefined || input.sessionId === undefined || input.sourceCallSeq === undefined) {
    throw new Error('a correlation scope needs either an explicit operationRef or all of domain/sessionId/sourceCallSeq')
  }
  return operationRefOf({ domain: input.domain, sessionId: input.sessionId, sourceCallSeq: input.sourceCallSeq })
}
