/**
 * The checkpoint/resume and materialization plane: the full workbench state
 * encodes to one bounded plain-JSON checkpoint (spec, scenario cursor,
 * intake buffer, dedup window, live windows with their append-only revision
 * ledgers, counters, and the recorded materializations), and resumes into a
 * fresh runtime that continues the stream exactly where the checkpoint
 * stopped — at-least-once redelivery around a crash surfaces as duplicate
 * event ids, which dedup absorbs, and a window already closed before the
 * checkpoint is never closed a second time.
 *
 * Materialization is digest-pinned: an export's identity is the sha256 of
 * its window conclusions, so re-materializing an unchanged state recognizes
 * the already-published artifact instead of minting a second one, and a
 * changed state produces a NEW digest — a published report is never
 * rewritten.
 *
 * @module @map-harness/spatial-realtime/checkpoint
 */
import { createHash } from 'node:crypto'
import {
  REALTIME_METHOD_VERSION,
  windowRevisionDigestOf,
  type StreamEvent,
  type StreamScenario,
  type StreamSpec,
  type WindowAggregate,
  type WindowStatus,
} from './contract.ts'
import { validateStreamScenario, validateStreamSpec } from './contract.ts'
import { MAX_MATERIALIZED_ENTRIES, StreamRuntime, type MaterializationRecord } from './runtime.ts'

/** Wire identity of one checkpoint record. */
export const STREAM_CHECKPOINT_KIND = 'spatial-realtime-checkpoint'

/** Wire/protocol version of the checkpoint record; unknown versions refuse instead of guessing. */
export const STREAM_CHECKPOINT_SCHEMA_VERSION = 1

/** Upper bound on one serialized checkpoint. The dedup window, intake buffer, and live windows are bounded, so exceeding the cap means a misconfigured spec, not a bigger stream. */
export const MAX_CHECKPOINT_BYTES = 1_048_576

/** Upper bound on windows one materialized export carries; a longer stream materializes in passes. */
export const MAX_EXPORT_WINDOWS = 4_096

/** Why one checkpoint or export refused. */
export type StreamCheckpointCode =
  | 'invalid-checkpoint'
  | 'unknown-schema-version'
  | 'unknown-kind'
  | 'method-version'
  | 'oversized-checkpoint'
  | 'export-too-large'
  | 'export-empty'

/** The encoded workbench state: plain JSON, checkpoint-cache-writeable by contract. */
export interface StreamCheckpoint {
  readonly schemaVersion: typeof STREAM_CHECKPOINT_SCHEMA_VERSION
  readonly kind: typeof STREAM_CHECKPOINT_KIND
  readonly methodVersion: typeof REALTIME_METHOD_VERSION
  readonly spec: StreamSpec
  readonly scenario: StreamScenario
  readonly cursor: { readonly batchIndex: number; readonly admittedInBatch: number }
  readonly paused: boolean
  /** Admitted-but-unprocessed events with the ingest time admission stamped. */
  readonly buffer: readonly (readonly [StreamEvent, number])[]
  /** Dedup window in eviction order (oldest first). */
  readonly dedupIds: readonly string[]
  readonly windows: readonly {
    readonly startMs: number
    readonly endMs: number
    readonly status: WindowStatus
    readonly revisions: readonly { readonly revision: number; readonly digest: string; readonly aggregate: WindowAggregate }[]
  }[]
  readonly gapFrontierMs: number | null
  readonly maxEventTimeMs: number | null
  readonly lastIngestTimeMs: number | null
  readonly lastProcessTimeMs: number | null
  readonly evictedClosedWindows: number
  readonly counters: {
    readonly admitted: number
    readonly processed: number
    readonly duplicatesDropped: number
    readonly tooLateDropped: number
    readonly heldByBackpressure: number
    readonly offlineBatches: number
  }
  readonly materialized: readonly MaterializationRecord[]
}

/** Decode outcome for one checkpoint value: resumable or refused with a code. */
export type DecodedStreamCheckpoint =
  | { readonly status: 'ok'; readonly checkpoint: StreamCheckpoint }
  | { readonly status: 'refused'; readonly code: StreamCheckpointCode }

/**
 * Encode one runtime's full state into a bounded checkpoint.
 * @param runtime - the workbench to freeze.
 * @returns the plain-JSON checkpoint.
 * @throws {Error} with an `oversized-checkpoint` message when serialization exceeds the bound.
 */
export function encodeCheckpoint(runtime: StreamRuntime): StreamCheckpoint {
  const internals = runtimeInternals(runtime)
  const checkpoint: StreamCheckpoint = {
    schemaVersion: STREAM_CHECKPOINT_SCHEMA_VERSION,
    kind: STREAM_CHECKPOINT_KIND,
    methodVersion: REALTIME_METHOD_VERSION,
    spec: internals.spec,
    scenario: internals.scenario,
    cursor: { ...internals.cursor },
    paused: internals.paused,
    buffer: internals.buffer.map(buffered => [{ ...buffered.event }, buffered.ingestMs] as const),
    dedupIds: [...internals.dedupIds],
    windows: internals.windowStates(),
    gapFrontierMs: internals.gapFrontierMs,
    maxEventTimeMs: internals.maxEventTimeMs,
    lastIngestTimeMs: internals.lastIngestMs,
    lastProcessTimeMs: internals.lastProcessMs,
    evictedClosedWindows: internals.evictedClosed,
    counters: { ...internals.counters },
    materialized: [...internals.materialized],
  }
  const serialized = JSON.stringify(checkpoint)
  if (serialized.length > MAX_CHECKPOINT_BYTES) {
    throw new Error(`oversized-checkpoint: the serialized workbench state exceeds the ${MAX_CHECKPOINT_BYTES} byte bound`)
  }
  return checkpoint
}

/**
 * Decode one untrusted checkpoint value. Only version 1 with the recorded
 * method version and a structurally consistent body decodes; anything else —
 * including newer versions — refuses with its code and is never guessed at.
 * @param value - the untrusted checkpoint (for example from a persisted layer record).
 * @returns the decoded checkpoint, or the refusal code.
 */
export function decodeCheckpoint(value: unknown): DecodedStreamCheckpoint {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { status: 'refused', code: 'invalid-checkpoint' }
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== STREAM_CHECKPOINT_SCHEMA_VERSION) {
    return { status: 'refused', code: 'unknown-schema-version' }
  }
  if (record.kind !== STREAM_CHECKPOINT_KIND) {
    return { status: 'refused', code: 'unknown-kind' }
  }
  if (record.methodVersion !== REALTIME_METHOD_VERSION) {
    return { status: 'refused', code: 'method-version' }
  }
  if (typeof JSON.stringify(record) !== 'string' || JSON.stringify(record).length > MAX_CHECKPOINT_BYTES) {
    return { status: 'refused', code: 'oversized-checkpoint' }
  }
  const spec = record.spec
  if (validateStreamSpec(spec).length > 0) return { status: 'refused', code: 'invalid-checkpoint' }
  const scenario = record.scenario
  if (validateStreamScenario(scenario).length > 0) return { status: 'refused', code: 'invalid-checkpoint' }
  const cursor = record.cursor as { batchIndex?: unknown; admittedInBatch?: unknown } | undefined
  if (typeof cursor !== 'object' || cursor === null
    || !Number.isInteger(cursor.batchIndex) || (cursor.batchIndex as number) < 0
    || (cursor.batchIndex as number) > (scenario as StreamScenario).batches.length
    || !Number.isInteger(cursor.admittedInBatch) || (cursor.admittedInBatch as number) < 0) {
    return { status: 'refused', code: 'invalid-checkpoint' }
  }
  if (typeof record.paused !== 'boolean') return { status: 'refused', code: 'invalid-checkpoint' }
  if (!Array.isArray(record.buffer) || !Array.isArray(record.dedupIds)) {
    return { status: 'refused', code: 'invalid-checkpoint' }
  }
  for (const entry of record.buffer as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[1] !== 'number'
      || typeof entry[0] !== 'object' || entry[0] === null) {
      return { status: 'refused', code: 'invalid-checkpoint' }
    }
    if (validateStreamScenario({ batches: [{ events: [entry[0]] }] }).length > 0) {
      return { status: 'refused', code: 'invalid-checkpoint' }
    }
  }
  if (!Array.isArray(record.windows)) return { status: 'refused', code: 'invalid-checkpoint' }
  for (const window of record.windows as unknown[]) {
    if (!isEncodedWindow(window)) return { status: 'refused', code: 'invalid-checkpoint' }
  }
  if (!isCounters(record.counters) || !Array.isArray(record.materialized)) {
    return { status: 'refused', code: 'invalid-checkpoint' }
  }
  return { status: 'ok', checkpoint: record as unknown as StreamCheckpoint }
}

/** Whether one encoded window entry carries a consistent, digest-verified body. */
function isEncodedWindow(window: unknown): boolean {
  if (typeof window !== 'object' || window === null) return false
  const record = window as {
    startMs?: unknown; endMs?: unknown; status?: unknown; revisions?: unknown
  }
  if (!Number.isFinite(record.startMs) || !Number.isFinite(record.endMs)) return false
  if (record.status !== 'open' && record.status !== 'closed' && record.status !== 'revised' && record.status !== 'empty') return false
  if (!Array.isArray(record.revisions) || record.revisions.length === 0) return false
  let previous = 0
  for (const revision of record.revisions as unknown[]) {
    if (typeof revision !== 'object' || revision === null) return false
    const entry = revision as { revision?: unknown; digest?: unknown; aggregate?: unknown }
    if (entry.revision !== previous + 1 || typeof entry.digest !== 'string' || entry.digest.length !== 64) return false
    if (!isAggregate(entry.aggregate)) return false
    const aggregate = entry.aggregate as WindowAggregate
    const expected = windowRevisionDigestOf(record.startMs as number, record.endMs as number, entry.revision as number, aggregate)
    if (entry.digest !== expected) return false
    previous = entry.revision as number
  }
  return true
}

/** Whether one value carries the six aggregate fields as finite numbers. */
function isAggregate(value: unknown): value is WindowAggregate {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  for (const key of ['count', 'sum', 'min', 'max', 'mean', 'meanLon', 'meanLat']) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key] as number)) return false
  }
  if (!Number.isInteger(record.count) || (record.count as number) < 0) return false
  return true
}

/** Whether one value carries the six monotone counters as nonnegative integers. */
function isCounters(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  for (const key of ['admitted', 'processed', 'duplicatesDropped', 'tooLateDropped', 'heldByBackpressure', 'offlineBatches']) {
    const count = record[key]
    if (typeof count !== 'number' || !Number.isInteger(count) || (count as number) < 0) return false
  }
  return true
}

/**
 * Resume one workbench from a decoded checkpoint: the runtime continues
 * exactly where the freeze stopped — same spec, same scenario position,
 * same windows, same counters, same dedup window.
 * @param checkpoint - a checkpoint this module's `decodeCheckpoint` accepted.
 * @returns the restored runtime.
 */
export function resumeCheckpoint(checkpoint: StreamCheckpoint): StreamRuntime {
  return StreamRuntime.restore(
    checkpoint.spec,
    checkpoint.scenario,
    {
      batchIndex: checkpoint.cursor.batchIndex,
      admittedInBatch: checkpoint.cursor.admittedInBatch,
      paused: checkpoint.paused,
      buffer: checkpoint.buffer.map(([event, ingestMs]) => ({ event, ingestMs })),
      dedupIds: [...checkpoint.dedupIds],
      windows: checkpoint.windows.map(window => ({
        startMs: window.startMs,
        endMs: window.endMs,
        status: window.status,
        revisions: window.revisions.map(entry => ({ revision: entry.revision, digest: entry.digest, aggregate: { ...entry.aggregate } })),
      })),
      gapFrontierMs: checkpoint.gapFrontierMs,
      maxEventTimeMs: checkpoint.maxEventTimeMs,
      lastIngestMs: checkpoint.lastIngestTimeMs,
      lastProcessMs: checkpoint.lastProcessTimeMs,
      evictedClosed: checkpoint.evictedClosedWindows,
      counters: { ...checkpoint.counters },
      materialized: [...checkpoint.materialized].slice(-MAX_MATERIALIZED_ENTRIES),
    },
  )
}

/** One materialized export: the fixed, digest-pinned window conclusions a report cites. */
export interface MaterializedExport {
  readonly methodVersion: typeof REALTIME_METHOD_VERSION
  readonly windowSizeMs: number
  readonly allowedLatenessMs: number
  /** Process time the export was built at (caller-supplied, deterministic). */
  readonly exportedAtProcessMs: number
  /** Every live closed/revised/empty window with its current revision. */
  readonly windows: readonly {
    readonly startMs: number
    readonly endMs: number
    readonly status: WindowStatus
    readonly revision: number
    readonly digest: string
    readonly aggregate: WindowAggregate
  }[]
  /** sha256 over the identity fields and the window conclusions — the pin reports and artifacts cite. */
  readonly exportDigest: string
}

/**
 * Build the materialized export of one workbench's settled conclusions:
 * every live closed/revised/empty window at its current revision. Open
 * windows are never exported — their aggregate is not a conclusion yet.
 * @param runtime - the workbench to export.
 * @param exportedAtProcessMs - the process time to stamp the export with.
 * @returns the export, or the refusal code when no window has closed yet or the live set exceeds the export bound.
 */
export function buildMaterializedExport(
  runtime: StreamRuntime,
  exportedAtProcessMs: number,
): { status: 'ok'; export: MaterializedExport } | { status: 'refused'; code: StreamCheckpointCode } {
  const settled = runtime.windowStates().filter(window => window.status !== 'open')
  if (settled.length === 0) return { status: 'refused', code: 'export-empty' }
  if (settled.length > MAX_EXPORT_WINDOWS) return { status: 'refused', code: 'export-too-large' }
  const windows = settled.map(window => {
    const current = window.revisions[window.revisions.length - 1] as { revision: number; digest: string; aggregate: WindowAggregate }
    return {
      startMs: window.startMs,
      endMs: window.endMs,
      status: window.status,
      revision: current.revision,
      digest: current.digest,
      aggregate: { ...current.aggregate },
    }
  })
  const spec = runtime.spec
  const identity = {
    methodVersion: REALTIME_METHOD_VERSION,
    windowSizeMs: spec.windowSizeMs,
    allowedLatenessMs: spec.allowedLatenessMs,
    windows,
  }
  return {
    status: 'ok',
    export: {
      methodVersion: REALTIME_METHOD_VERSION,
      windowSizeMs: spec.windowSizeMs,
      allowedLatenessMs: spec.allowedLatenessMs,
      exportedAtProcessMs: exportedAtProcessMs,
      windows,
      exportDigest: createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex'),
    },
  }
}

// -- internals shared with the runtime through a narrow face --

/** The narrow internal face `encodeCheckpoint` reads; `StreamRuntime.expose` returns it. */
export interface RuntimeInternals {
  readonly spec: StreamSpec
  readonly scenario: StreamScenario
  readonly cursor: { readonly batchIndex: number; readonly admittedInBatch: number }
  readonly paused: boolean
  readonly buffer: readonly { readonly event: StreamEvent; readonly ingestMs: number }[]
  readonly dedupIds: readonly string[]
  readonly windowStates: () => ReturnType<StreamRuntime['windowStates']>
  readonly gapFrontierMs: number | null
  readonly maxEventTimeMs: number | null
  readonly lastIngestMs: number | null
  readonly lastProcessMs: number | null
  readonly evictedClosed: number
  readonly counters: {
    readonly admitted: number
    readonly processed: number
    readonly duplicatesDropped: number
    readonly tooLateDropped: number
    readonly heldByBackpressure: number
    readonly offlineBatches: number
  }
  readonly materialized: readonly MaterializationRecord[]
}

/** Read the narrow internal face of one runtime (checkpoint-plane use only). */
export function runtimeInternals(runtime: StreamRuntime): RuntimeInternals {
  return runtime.expose()
}

// Re-export so the tools package can cite the runtime failure names beside the checkpoint ones.
export { StreamRuntimeError } from './runtime.ts'
export type { StreamRuntimeCode } from './runtime.ts'
export type { StreamIssue } from './contract.ts'
