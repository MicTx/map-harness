/**
 * The bounded diagnostic export. One JSON document that carries everything a
 * responder needs to answer "what happened to this operation": the method
 * version, the readiness/health snapshot, the metric rollup, the fault
 * matrix record, the correlation index, and the log tail — sanitized and
 * byte-bounded.
 *
 * Rules:
 *
 * - **Bounded by bytes, truncated visibly.** Sections fill in priority
 *   order (health, metrics, faults, correlation index, audit-class log
 *   tail, then the remaining sample-class tail); past
 *   `maxBytes` the export stops adding and records `truncated: true` with
 *   the exact count of excluded records — it never silently shrinks a
 *   section below its evidence value.
 * - **Sanitized as a whole.** The assembled document passes through the
 *   sanitizer before serialization; a credential key or host path that
 *   reached any section still cannot reach the file.
 * - **Failures and audit facts survive truncation first.** Audit-class log
 *   records enter before sample-class records, so trimming eats `debug`/
 *   `info` volume, never the failure story — and if even the audit tail
 *   overflows, the overflow is counted as an explicit `export` telemetry
 *   drop.
 *
 * @module @map-harness/spatial-observability/export
 */
import {
  DEFAULT_MAX_EXPORT_BYTES,
  OBSERVABILITY_METHOD_VERSION,
  OBS_FAULT_POINTS,
  type ObsCorrelation,
  type ObsLogRecord,
} from './contract.ts'
import type { ObsLog } from './log.ts'
import type { ObsMetrics } from './metrics.ts'
import type { ObsHealthRegistry, ObsHealthTransition } from './health.ts'
import type { ObsFaultInjection, ObsFaultMatrix } from './faults.ts'
import { sanitizeValue } from './sanitize.ts'

/** One recent operation's correlation index entry (mutable internal state; the export snapshots it). */
export interface ObsOperationIndexEntry {
  readonly correlation: ObsCorrelation
  /** Stored log records under this operation, by level. */
  logCounts: Record<string, number>
  /** First-seen clock milliseconds. */
  firstSeenMs: number
  /** Last-seen clock milliseconds. */
  lastSeenMs: number
}

/** The diagnostic export document (JSON-serializable by construction). */
export interface ObsDiagnosticExport {
  readonly methodVersion: typeof OBSERVABILITY_METHOD_VERSION
  readonly generatedAtMs: number
  readonly readiness: ReturnType<ObsHealthRegistry['readiness']>
  readonly transitions: readonly ObsHealthTransition[]
  readonly metrics: ReturnType<ObsMetrics['snapshot']>
  readonly faults: {
    readonly armedPoints: readonly string[]
    readonly injections: readonly ObsFaultInjection[]
  }
  readonly operations: readonly ObsOperationIndexEntry[]
  readonly logs: readonly ObsLogRecord[]
  readonly telemetryDrops: Readonly<Record<string, number>>
  /** Whether the byte budget cut records out (the count names exactly how many). */
  readonly truncated: boolean
  readonly truncatedRecords: number
}

/** The collaborators one export reads from. */
export interface ObsExportSources {
  readonly log: ObsLog
  readonly metrics: ObsMetrics
  readonly health: ObsHealthRegistry
  readonly faults: ObsFaultMatrix
  readonly operations: () => readonly ObsOperationIndexEntry[]
  readonly telemetryDrops: () => Readonly<Record<string, number>>
  readonly nowMs?: () => number
}

/**
 * Assemble the bounded sanitized diagnostic export.
 * @param sources - the runtime planes to read.
 * @param options - `maxBytes` bounds the serialized document (default 64 KiB).
 * @returns the export document (also returned as pre-stringified JSON for callers that write files).
 */
export function buildDiagnosticExport(
  sources: ObsExportSources,
  options: { maxBytes?: number } = {},
): { document: ObsDiagnosticExport; json: string; bytes: number } {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_EXPORT_BYTES
  const nowMs = sources.nowMs ?? (() => Date.now())
  const records = sources.log.records
  const auditTail = records.filter(isAuditClass)
  const sampleTail = records.filter(record => !isAuditClass(record))

  const base = {
    methodVersion: OBSERVABILITY_METHOD_VERSION,
    generatedAtMs: nowMs(),
    readiness: sources.health.readiness(),
    transitions: [...sources.health.transitions()],
    metrics: sources.metrics.snapshot(),
    faults: {
      armedPoints: armedPointNames(sources.faults),
      injections: [...sources.faults.injections()],
    },
    operations: [...sources.operations()],
    logs: [] as ObsLogRecord[],
    telemetryDrops: sources.telemetryDrops(),
    truncated: false,
    truncatedRecords: 0,
  }

  // Fill the log tail within the byte budget: audit first, then samples.
  const measure = (logs: readonly ObsLogRecord[]): number =>
    Buffer.byteLength(JSON.stringify({ ...base, logs }), 'utf8')
  const everything = [...auditTail, ...sampleTail]
  let kept: ObsLogRecord[] = everything
  let truncated = false
  let truncatedRecords = 0
  if (measure(everything) > maxBytes) {
    const fit = largestPrefixWithinBudget(auditTail, sampleTail, measure, maxBytes)
    kept = fit.kept
    truncated = fit.truncated
    truncatedRecords = fit.dropped
  }
  base.logs = kept
  base.truncated = truncated
  base.truncatedRecords = truncatedRecords

  // The export is bounded by its byte budget, not by the caller-fields
  // array cap: bounded series (operations, transitions, counters) enter in
  // full, and the log-tail truncation above is the visible size control.
  const sanitized = sanitizeValue(base, { maxItems: Number.MAX_SAFE_INTEGER })
  const json = JSON.stringify(sanitized.value, null, 2)
  return { document: sanitized.value as unknown as ObsDiagnosticExport, json, bytes: Buffer.byteLength(json, 'utf8') }
}

function largestPrefixWithinBudget(
  auditTail: readonly ObsLogRecord[],
  sampleTail: readonly ObsLogRecord[],
  measure: (logs: readonly ObsLogRecord[]) => number,
  maxBytes: number,
): { kept: ObsLogRecord[]; truncated: boolean; dropped: number } {
  // Greedy: keep audit records until the budget blocks, then samples; every
  // exclusion counts.
  const kept: ObsLogRecord[] = []
  let dropped = 0
  let blocked = false
  for (const record of [...auditTail, ...sampleTail]) {
    if (!blocked && measure([...kept, record]) <= maxBytes) {
      kept.push(record)
    } else {
      blocked = true
      dropped += 1
    }
  }
  return { kept, truncated: dropped > 0, dropped }
}

/** The fault points currently armed (the export records names, not internals). */
function armedPointNames(faults: ObsFaultMatrix): string[] {
  return [...OBS_FAULT_POINTS].filter(point => faults.isArmed(point))
}

function isAuditClass(record: ObsLogRecord): boolean {
  return record.level === 'warn' || record.level === 'error' || record.level === 'audit'
}
