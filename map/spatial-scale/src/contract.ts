/**
 * The distributed-scale data channel contract (`spatial-scale@1`): the
 * fully-specified, versioned binding every scale resource, read, and worker
 * job carries. The contract fixes four things before any bytes move:
 *
 * - **Identity** — a scale version is an immutable, content-addressed copy of
 *   one registered resource, chunked into row groups (the GeoParquet-style
 *   object layout) with a per-chunk sha256 digest, byte length, and bbox;
 *   the manifest carries schema, CRS, time range, and the authorization
 *   domain, and is the version's single commit point.
 * - **Bounds** — every read and scan names the budget it runs under
 *   (chunk rows, bytes per read, rows per read, scan memory, job slots,
 *   queue depth, job timeout). Oversized work refuses with a stable code;
 *   it is never silently truncated and never unbounded.
 * - **The fixed workload** — the benchmark inputs (row count, chunking,
 *   query pattern, concurrency, recovery point) and the recorded thresholds
 *   (latency, memory, scan throughput, concurrency, recovery) the benchmark
 *   must meet on the recorded hardware. Thresholds are measurements, not
 *   promises: they were recorded from real runs of {@link runScaleBenchmark}
 *   and a run that cannot meet them fails.
 * - **The worker protocol** — the plain-JSON job request and reply lines the
 *   worker process speaks, so the coordinating process and the scan process
 *   agree without sharing code.
 *
 * Validation accepts the raw JSON-shaped input the tool layer forwards and
 * returns typed issues instead of throwing, so a rejected spec lists every
 * reason rather than the first.
 *
 * @module @map-harness/spatial-scale/contract
 */
import { createHash } from 'node:crypto'

/**
 * The method identity this package computes; a spec citing another version is
 * refused. The version pins every rule this package ships: content-addressed
 * immutable chunked versions, digest-verified bounded reads, the range/tile/
 * query read family, the worker job protocol, staged publication, and the
 * scan record layout.
 */
export const SCALE_METHOD_VERSION = 'spatial-scale@1'

// -- budget bounds -----------------------------------------------------------

/** Chunk size (rows per chunk) bounds at ingest. */
export const MIN_CHUNK_ROWS = 1
export const MAX_CHUNK_ROWS = 65_536

/** Rows one bounded read may return to its caller. */
export const MIN_ROWS_PER_READ = 1
export const MAX_ROWS_PER_READ = 65_536

/** Bytes one bounded read may pull from the provider. */
export const MIN_BYTES_PER_READ = 1
export const MAX_BYTES_PER_READ = 64 * 1024 * 1024

/** Structural scan-memory bound: the coordinating process retains at most this many sampled rows per scan. */
export const MIN_SCAN_SAMPLE_ROWS = 1
export const MAX_SCAN_SAMPLE_ROWS = 65_536

/** Worker job slots (true concurrency) bounds. */
export const MIN_JOB_SLOTS = 1
export const MAX_JOB_SLOTS = 16

/** Bounded job queue depth beyond the occupied slots. */
export const MIN_QUEUE_DEPTH = 0
export const MAX_QUEUE_DEPTH = 256

/** Job timeout, milliseconds; a timed-out job is `failed`, never silently terminated. */
export const MIN_JOB_TIMEOUT_MS = 1
export const MAX_JOB_TIMEOUT_MS = 10 * 60_000

/** One ingest carries at most this many rows (the channel's per-call bound). */
export const MAX_INGEST_ROWS = 1_000_000

// -- recorded deployment budgets ---------------------------------------------

/**
 * The recorded budgets every scale read and job in this deployment runs
 * under. These are the deployment-owned defaults the tool layer writes into
 * every request explicitly (never hidden defaults inside the runtime); they
 * bound what one model-driven call can move.
 */
export const SCALE_BUDGETS: ScaleBudgets = {
  chunkRows: 2_048,
  maxRowsPerRead: 8_192,
  maxBytesPerRead: 4 * 1024 * 1024,
  scanSampleRows: 512,
  jobSlots: 2,
  queueDepth: 8,
  jobTimeoutMs: 60_000,
}

/** One field of the resource schema the manifest records. */
export interface ScaleField {
  readonly name: string
  readonly type: 'number' | 'string' | 'boolean' | 'unknown'
}

/** The schema the manifest records for one version. */
export interface ScaleSchema {
  readonly fields: readonly ScaleField[]
  readonly geometryTypes: readonly string[]
  readonly featureCount: number
}

/** One chunk of the immutable version: a GeoParquet-style row group on disk. */
export interface ScaleChunkEntry {
  /** 0-based chunk index within the version. */
  readonly index: number
  /** Rows stored in this chunk. */
  readonly rows: number
  /** Serialized byte length of the chunk file. */
  readonly bytes: number
  /** sha256 hex digest of the exact chunk bytes. */
  readonly digest: string
  /** Chunk bbox over stored coordinates: `[minLon, minLat, maxLon, maxLat]`, or `null` when the chunk stores no coordinates. */
  readonly bbox: readonly [number, number, number, number] | null
}

/**
 * The immutable version manifest — the single commit point of one scale
 * version. The manifest names the source it copied (a registered resource
 * ref plus content digest), the schema/CRS/time/authorization metadata every
 * consumer checks, and the chunk index every read resolves against. A
 * version directory without its manifest is an unfinished stage and is never
 * readable.
 */
export interface ScaleResourceManifest {
  readonly methodVersion: typeof SCALE_METHOD_VERSION
  /** Stable resource id within the scale store (`[a-z0-9][a-z0-9-]{0,63}`). */
  readonly resourceId: string
  /** The registered catalog resource ref (`res-…@vN`) the bytes were copied from. */
  readonly sourceRef: string
  /** The source content digest the copy verifies against. */
  readonly sourceDigest: string
  /** Full content digest of the copied feature bytes (identity of this version). */
  readonly contentDigest: string
  readonly nativeCrs: string
  readonly schema: ScaleSchema
  /** Observed event-time range of the declared time field, or `null` without one. */
  readonly timeRange: { readonly from: string; readonly to: string } | null
  /** The authorization domain reads must present. */
  readonly authorization: string
  /** Rows per chunk the ingest fixed. */
  readonly chunkRows: number
  readonly chunks: readonly ScaleChunkEntry[]
  readonly totalBytes: number
  /** ISO ingest timestamp. */
  readonly ingestedAt: string
}

/** The per-read bounds one read or job runs under (deployment-owned, explicit in every request). */
export interface ScaleBudgets {
  /** Rows per chunk at ingest. */
  readonly chunkRows: number
  /** Rows one read may return. */
  readonly maxRowsPerRead: number
  /** Bytes one range read may pull. */
  readonly maxBytesPerRead: number
  /** Rows one scan may sample into its bounded result. */
  readonly scanSampleRows: number
  /** Worker job slots (true concurrency). */
  readonly jobSlots: number
  /** Queue depth beyond the occupied slots; a full queue refuses submission. */
  readonly queueDepth: number
  /** Job timeout, milliseconds. */
  readonly jobTimeoutMs: number
}

/** The comparison operators a query or worker predicate may express. */
export const SCALE_OPS = ['>', '>=', '<', '<=', '==', '!='] as const

/** One comparison operator. */
export type ScaleOp = typeof SCALE_OPS[number]

/** The count/sum/min/max fold one query or scan reports over its matches. */
export interface ScaleAggregate {
  readonly count: number
  readonly sum: number
  readonly min: number
  readonly max: number
}

/** The bounded read family. */
export type ScaleReadKind = 'range' | 'tile' | 'query'

/**
 * One bounded read request. `range` reads a consecutive chunk window
 * (the resume cursor is the next chunk index); `tile` reads the rows of one
 * grid cell at the manifest extent's fixed zoom; `query` scans a predicate
 * across the version's chunks.
 */
export type ScaleReadRequest =
  | { readonly kind: 'range'; readonly fromChunk: number; readonly chunks: number }
  | { readonly kind: 'tile'; readonly z: number; readonly x: number; readonly y: number }
  | { readonly kind: 'query'; readonly field: string; readonly op: ScaleOp; readonly value: number }

/**
 * The plain-JSON predicate protocol the worker process evaluates. Kept
 * trivially small so the coordinating process and the scan process agree
 * without sharing code: one field, one operator, one numeric value.
 */
export interface ScaleWorkerPredicate {
  readonly field: string
  readonly op: ScaleOp
  readonly value: number
}

/** One job request line the parent writes to the worker process (plain JSON, one line). */
export interface ScaleJobRequest {
  readonly methodVersion: typeof SCALE_METHOD_VERSION
  readonly manifestPath: string
  readonly chunks: readonly { readonly path: string; readonly start: number; readonly end: number; readonly digest: string; readonly rows: number }[]
  readonly predicate: ScaleWorkerPredicate | null
  readonly sampleRows: number
  /**
   * Injected fault or pacing point for deterministic tests; production jobs
   * carry none. `crash` exits hard after `afterChunks` chunks, `hang` stops
   * the step loop (the timeout's kill target), and `pace` slows the chunk
   * loop by `paceMs` per chunk so a cancel demonstrably lands mid-scan.
   */
  readonly fault?: {
    readonly kind: 'crash' | 'hang' | 'pace'
    readonly afterChunks?: number
    readonly paceMs?: number
  }
}

/** One progress line the worker process emits after each chunk. */
export interface ScaleJobProgress {
  readonly type: 'progress'
  readonly chunksDone: number
  readonly rowsScanned: number
  readonly bytesScanned: number
  readonly matches: number
}

/** One cancel acknowledgment the worker emits after stopping at a chunk boundary. */
export interface ScaleJobCancelled {
  readonly type: 'cancelled'
  readonly chunksDone: number
  readonly rowsScanned: number
  readonly bytesScanned: number
}

/** The final result line the worker emits on completion. */
export interface ScaleJobResult {
  readonly type: 'result'
  readonly chunksDone: number
  readonly rowsScanned: number
  readonly bytesScanned: number
  readonly truncated: boolean
  readonly aggregate: ScaleAggregate
  /** Up to `sampleRows` matching rows, in scan order, coordinates rounded to six decimals. */
  readonly sample: readonly { readonly index: number; readonly lon: number | null; readonly lat: number | null; readonly value: number | null }[]
}

/** One protocol-level failure line the worker emits instead of a result. */
export interface ScaleJobFailed {
  readonly type: 'failed'
  readonly code: 'digest-mismatch' | 'method-version'
  readonly message: string
}

/** Any reply line the worker process writes. */
export type ScaleJobReply = ScaleJobProgress | ScaleJobCancelled | ScaleJobResult | ScaleJobFailed

// -- fixed workload and recorded thresholds ----------------------------------

/**
 * The fixed benchmark workload: a deterministic generated point dataset with
 * a known aggregate, chunked and scanned the way the channel always works.
 * Every benchmark run ingests exactly this workload into a fresh store, so
 * two runs measure the same bytes and their aggregates must be identical.
 */
export interface ScaleWorkload {
  /** Deterministic PRNG seed (the workload is reproducible byte-for-byte). */
  readonly seed: number
  /** Rows the workload carries. */
  readonly rows: number
  /** Rows per chunk. */
  readonly chunkRows: number
  /** WGS84 lon span the generated points cover, centered on 0. */
  readonly lonSpan: number
  /** WGS84 lat span the generated points cover, centered on 0. */
  readonly latSpan: number
  /** The numeric field the benchmark queries. */
  readonly field: string
  /** The query predicate (field, op, value) the benchmark scans. */
  readonly predicate: ScaleWorkerPredicate
  /** Parallel jobs the concurrency benchmark runs. */
  readonly concurrency: number
  /** The chunk count the crash-recovery run crashes after. */
  readonly recoveryAfterChunks: number
}

/** The recorded thresholds one benchmark run must meet, with the environment they were measured on. */
export interface ScaleThresholds {
  /** Minimum full-scan throughput, rows per second, coordinating-process side. */
  readonly minScanRowsPerSecond: number
  /** Maximum heap growth during one full scan, bytes. */
  readonly maxScanHeapGrowthBytes: number
  /** Minimum ingest throughput, rows per second. */
  readonly minIngestRowsPerSecond: number
  /** Maximum wall-clock ratio the concurrent run may take over the serial scan. */
  readonly maxConcurrencyWallRatio: number
  /** Maximum wall-clock milliseconds the crashed run needs to resume and finish. */
  readonly maxRecoveryResumeMs: number
}

/** The environment the recorded thresholds were measured on; a different host re-records before comparing. */
export const SCALE_THRESHOLD_ENVIRONMENT = 'darwin arm64 (Apple Silicon), node v25.2.1, one coordinating process plus worker children, no container CPU limits'

/**
 * The frozen benchmark workload and its recorded thresholds. The thresholds
 * are measured results of {@link runScaleBenchmark} on the recorded
 * environment, rounded to a conservative operating band (roughly an order of
 * magnitude below the observed values for latency/throughput floors, and
 * above observed values for ceilings) so normal scheduler noise cannot flip
 * a gate; they are measurements, not aspirations, and a run that misses one
 * fails the benchmark loudly.
 */
export const SCALE_WORKLOAD_FIXTURE: ScaleWorkload = {
  seed: 20260925,
  rows: 24_576,
  chunkRows: 2_048,
  lonSpan: 10,
  latSpan: 8,
  field: 'value',
  predicate: { field: 'value', op: '>=', value: 0.5 },
  concurrency: 4,
  recoveryAfterChunks: 6,
} as const

/**
 * The recorded thresholds for {@link SCALE_WORKLOAD_FIXTURE} on
 * {@link SCALE_THRESHOLD_ENVIRONMENT}. Measured 2026-09-25 with three
 * `runScaleBenchmark` runs: ingest 821,686–1,629,933 rows/s, full scan
 * 333,855–339,386 rows/s, coordinating-process scan heap growth 0–392,072
 * bytes, 4-way concurrent wall 1.039–1.061× serial, crash recovery resume
 * 133–141 ms. The recorded band keeps roughly an order of magnitude of
 * headroom on the floors and a firm ceiling on memory and wall time, so
 * normal scheduler noise cannot flip a gate; a run that misses one fails
 * the benchmark loudly.
 */
export const SCALE_RECORDED_THRESHOLDS: ScaleThresholds = {
  minScanRowsPerSecond: 100_000,
  maxScanHeapGrowthBytes: 8 * 1024 * 1024,
  minIngestRowsPerSecond: 100_000,
  maxConcurrencyWallRatio: 4,
  maxRecoveryResumeMs: 5_000,
} as const

// -- validation --------------------------------------------------------------

/** One structural contract issue: which field, a stable code, and why. */
export interface ScaleIssue {
  readonly field: string
  readonly code: ScaleIssueCode
  readonly message: string
}

/** The stable validation codes a budgets/read/workload rejection carries. */
export type ScaleIssueCode =
  | 'method-version'
  | 'budgets-required'
  | 'chunk-rows-bound'
  | 'rows-per-read-bound'
  | 'bytes-per-read-bound'
  | 'sample-rows-bound'
  | 'job-slots-bound'
  | 'queue-depth-bound'
  | 'timeout-bound'
  | 'read-required'
  | 'read-kind'
  | 'range-bounds'
  | 'tile-bounds'
  | 'query-bounds'
  | 'workload-required'
  | 'workload-bounds'
  | 'resource-id'
  | 'predicate-bound'

/**
 * Validate one raw budgets value and return every structural issue.
 * @param budgets - the raw budgets value.
 * @returns the issue list; empty means the budgets may run.
 */
export function validateScaleBudgets(budgets: unknown): ScaleIssue[] {
  const issues: ScaleIssue[] = []
  const record = budgets as Partial<ScaleBudgets> | null
  if (typeof record !== 'object' || record === null) {
    return [{ field: 'budgets', code: 'budgets-required', message: 'the budgets must be an object' }]
  }
  intBound(issues, 'chunkRows', record.chunkRows, MIN_CHUNK_ROWS, MAX_CHUNK_ROWS, 'chunk-rows-bound')
  intBound(issues, 'maxRowsPerRead', record.maxRowsPerRead, MIN_ROWS_PER_READ, MAX_ROWS_PER_READ, 'rows-per-read-bound')
  intBound(issues, 'maxBytesPerRead', record.maxBytesPerRead, MIN_BYTES_PER_READ, MAX_BYTES_PER_READ, 'bytes-per-read-bound')
  intBound(issues, 'scanSampleRows', record.scanSampleRows, MIN_SCAN_SAMPLE_ROWS, MAX_SCAN_SAMPLE_ROWS, 'sample-rows-bound')
  intBound(issues, 'jobSlots', record.jobSlots, MIN_JOB_SLOTS, MAX_JOB_SLOTS, 'job-slots-bound')
  intBound(issues, 'queueDepth', record.queueDepth, MIN_QUEUE_DEPTH, MAX_QUEUE_DEPTH, 'queue-depth-bound')
  intBound(issues, 'jobTimeoutMs', record.jobTimeoutMs, MIN_JOB_TIMEOUT_MS, MAX_JOB_TIMEOUT_MS, 'timeout-bound')
  return issues
}

/** Validate one numeric integer field against an inclusive bound, recording one issue per violation. */
function intBound(issues: ScaleIssue[], field: string, value: unknown, min: number, max: number, code: ScaleIssueCode): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    issues.push({ field, code, message: `${field} must be an integer in [${min}, ${max}]` })
  }
}

/**
 * Validate one raw read request's structural form. The budget-vs-window
 * checks happen at the provider against the version's real manifest values
 * (chunk rows and byte lengths), so validation here only checks shape.
 * @param read - the raw read request.
 * @returns the issue list; empty means the read may run.
 */
export function validateScaleRead(read: unknown): ScaleIssue[] {
  const issues: ScaleIssue[] = []
  if (typeof read !== 'object' || read === null) {
    return [{ field: 'read', code: 'read-required', message: 'a read request is required' }]
  }
  const record = read as Record<string, unknown>
  if (record.kind !== 'range' && record.kind !== 'tile' && record.kind !== 'query') {
    return [{ field: 'read.kind', code: 'read-kind', message: 'read kind must be "range", "tile", or "query"' }]
  }
  if (record.kind === 'range') {
    intBound(issues, 'read.fromChunk', record.fromChunk, 0, Number.MAX_SAFE_INTEGER, 'range-bounds')
    intBound(issues, 'read.chunks', record.chunks, 1, Number.MAX_SAFE_INTEGER, 'range-bounds')
  } else if (record.kind === 'tile') {
    intBound(issues, 'read.z', record.z, 0, 22, 'tile-bounds')
    intBound(issues, 'read.x', record.x, 0, 2 ** 22, 'tile-bounds')
    intBound(issues, 'read.y', record.y, 0, 2 ** 22, 'tile-bounds')
  } else {
    predicateIssues(issues, 'read', record.field, record.op, record.value)
  }
  return issues
}

/** Record every predicate defect under one field prefix. */
function predicateIssues(issues: ScaleIssue[], prefix: string, field: unknown, op: unknown, value: unknown): void {
  if (typeof field !== 'string' || field.length === 0 || field.length > 128) {
    issues.push({ field: `${prefix}.field`, code: 'predicate-bound', message: 'field must be a nonempty string of at most 128 characters' })
  }
  if (typeof op !== 'string' || !(SCALE_OPS as readonly string[]).includes(op)) {
    issues.push({ field: `${prefix}.op`, code: 'predicate-bound', message: `op must be one of ${SCALE_OPS.join(', ')}` })
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    issues.push({ field: `${prefix}.value`, code: 'predicate-bound', message: 'value must be a finite number' })
  }
}

/**
 * Validate one raw workload value (the benchmark input contract).
 * @param workload - the raw workload value.
 * @returns the issue list; empty means the workload may run.
 */
export function validateScaleWorkload(workload: unknown): ScaleIssue[] {
  const issues: ScaleIssue[] = []
  if (typeof workload !== 'object' || workload === null) {
    return [{ field: 'workload', code: 'workload-required', message: 'the workload must be an object' }]
  }
  const record = workload as Partial<ScaleWorkload>
  intBound(issues, 'seed', record.seed, 0, 2 ** 31 - 1, 'workload-bounds')
  intBound(issues, 'rows', record.rows, 1, MAX_INGEST_ROWS, 'workload-bounds')
  intBound(issues, 'chunkRows', record.chunkRows, MIN_CHUNK_ROWS, MAX_CHUNK_ROWS, 'workload-bounds')
  if (typeof record.lonSpan !== 'number' || !Number.isFinite(record.lonSpan) || record.lonSpan <= 0 || record.lonSpan > 360) {
    issues.push({ field: 'lonSpan', code: 'workload-bounds', message: 'lonSpan must be a finite number in (0, 360]' })
  }
  if (typeof record.latSpan !== 'number' || !Number.isFinite(record.latSpan) || record.latSpan <= 0 || record.latSpan > 180) {
    issues.push({ field: 'latSpan', code: 'workload-bounds', message: 'latSpan must be a finite number in (0, 180]' })
  }
  if (typeof record.field !== 'string' || record.field.length === 0) {
    issues.push({ field: 'field', code: 'workload-bounds', message: 'field must be a nonempty string' })
  }
  if (typeof record.concurrency !== 'number' || !Number.isInteger(record.concurrency) || record.concurrency < 1 || record.concurrency > MAX_JOB_SLOTS) {
    issues.push({ field: 'concurrency', code: 'workload-bounds', message: `concurrency must be an integer in [1, ${MAX_JOB_SLOTS}]` })
  }
  intBound(issues, 'recoveryAfterChunks', record.recoveryAfterChunks, 0, Number.MAX_SAFE_INTEGER, 'workload-bounds')
  predicateIssues(issues, 'predicate', record.predicate?.field, record.predicate?.op, record.predicate?.value)
  return issues
}

// -- identity ----------------------------------------------------------------

/**
 * The exact scale version ref (`scl-<resourceId>@<digest12>`): the immutable
 * identity every read, job, artifact, and scan record cites.
 * @param resourceId - the stable resource id.
 * @param contentDigest - the version's full content digest.
 * @returns the ref string.
 */
export function scaleRefOf(resourceId: string, contentDigest: string): string {
  return `scl-${resourceId}@${contentDigest.slice(0, 12)}`
}

/** One parsed scale ref. */
export interface ParsedScaleRef {
  readonly resourceId: string
  readonly digestPrefix: string
}

/**
 * Parse one scale version ref, or `null` when the string is not a scale ref
 * form. A well-formed ref whose digest prefix does not match the stored
 * manifest still refuses at read time — parsing never authorizes.
 * @param ref - the candidate ref string.
 * @returns the parsed parts, or `null` for a foreign form.
 */
export function parseScaleRef(ref: string): ParsedScaleRef | null {
  const match = /^scl-([a-z0-9][a-z0-9-]{0,63})@([0-9a-f]{12})$/.exec(ref)
  if (match === null) return null
  return { resourceId: match[1] as string, digestPrefix: match[2] as string }
}

/**
 * The canonical digest of one manifest — the identity scan records pin
 * and every rebuild re-verifies. The digest covers the whole manifest,
 * including the chunk index, so any metadata or chunk change is a different
 * manifest identity.
 * @param manifest - the manifest to digest.
 * @returns a sha256 hex digest of the canonical form.
 */
export function manifestDigestOf(manifest: ScaleResourceManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest), 'utf8').digest('hex')
}

/**
 * The canonical digest of one scan record's input parts — used by the
 * scan-record plane to pin exactly the parts a session log cites.
 * @param value - the plain-JSON value to digest.
 * @returns a sha256 hex digest.
 */
export function scaleDigestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

/** Render one issue list the way every refusal message names its reasons. */
export function renderScaleIssues(issues: readonly ScaleIssue[]): string {
  return issues.map(issue => `${issue.field} (${issue.code})`).join('; ')
}
