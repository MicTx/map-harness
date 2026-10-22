/**
 * The spatial observability operations contract (`spatial-observability@1`):
 * the versioned vocabulary every correlation field, outcome, error code,
 * health plane, metric label, and sanitization rule in this package carries.
 *
 * The contract fixes five things:
 *
 * - **Correlation** — one operation carries `operationRef` (the canonical
 *   `op:<domain>:<sessionId>#<sourceCallSeq>` identity), the optional durable
 *   `runId` and `goalRevision`, and the high-cardinality `traceId`. The trace
 *   id follows an operation across tools, artifacts, Sessions, and map render;
 *   it is welcome in logs and traces and forbidden as a metric label.
 * - **Outcomes** — the closed six-value vocabulary
 *   (`succeeded`/`partial`/`failed`/`cancelled`/`outcome_unknown`/`degraded`)
 *   the design requires; a settlement that cannot be known records
 *   `outcome_unknown` instead of guessing a success.
 * - **Error codes** — the versioned closed code set with fixed meanings; log
 *   text is never the machine protocol's only source.
 * - **Low-cardinality metrics** — metric names, label keys, and label values
 *   all come from closed vocabularies; per-metric cardinality is capped and a
 *   cap breach refuses loudly (a code bug, not a runtime condition).
 * - **Sanitization** — credentials, user data, geometry payloads, and
 *   arbitrary filesystem paths never enter logs, metric labels, or the
 *   diagnostic export; the sanitizer's redactions are visible in its result.
 *
 * @module @map-harness/spatial-observability/contract
 */
import { randomBytes } from 'node:crypto'

/**
 * The observability method identity this package computes; a report citing
 * another version is refused. The version pins every rule this package
 * ships: the correlation field grammar, the closed outcome/error-code/health/
 * label vocabularies, the sanitization rules, the sampling policy that never
 * drops failures or audit facts silently, the fault-injection points, and the
 * bounded diagnostic export layout.
 */
export const OBSERVABILITY_METHOD_VERSION = 'spatial-observability@1'

// -- correlation --------------------------------------------------------------

/** Maximum characters of one correlation identifier component. */
export const MAX_CORRELATION_ID_CHARS = 128

/** The charset an `operationRef` domain or session component may carry. */
const CORRELATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

/** The input one operation's correlation identity is built from. */
export interface ObsCorrelationInput {
  /** Authorization domain of the caller (for example `local`). */
  readonly domain: string
  /** Session the operation ran in. */
  readonly sessionId: string
  /** The Session's `sourceCallSeq` of the originating `tool/call`. */
  readonly sourceCallSeq: number
  /** Durable run identifier, when the operation belongs to a durable run. */
  readonly runId?: string
  /** Decision-frame goal revision in force, when the session carries one. */
  readonly goalRevision?: number
  /** Explicit trace id; a fresh one is generated when omitted. */
  readonly traceId?: string
}

/** One operation's correlation identity, propagated through the ambient scope. */
export interface ObsCorrelation {
  /** Canonical `op:<domain>:<sessionId>#<sourceCallSeq>` identity. */
  readonly operationRef: string
  /** Durable run identifier, when present. */
  readonly runId?: string
  /** Decision-frame goal revision, when present. */
  readonly goalRevision?: number
  /** High-cardinality trace id; allowed in logs/traces, never a metric label. */
  readonly traceId: string
}

/**
 * Build the canonical operation reference from its parts. The identity is
 * `op:<domain>:<sessionId>#<sourceCallSeq>` — the authorization domain plus
 * the originating Session call identity the design's side-effect recovery
 * section fixes (request digests stay a separate consistency check and never
 * enter the identity).
 * @param input - the correlation parts; component charset and bounds validate here.
 * @returns the canonical operationRef string.
 * @throws when a component is empty, over-long, or carries characters outside the allowed set.
 */
export function operationRefOf(input: ObsCorrelationInput): string {
  assertComponent('domain', input.domain)
  assertComponent('sessionId', input.sessionId)
  if (!Number.isInteger(input.sourceCallSeq) || input.sourceCallSeq < 0) {
    throw new Error(`operationRef sourceCallSeq must be a nonnegative integer, got ${String(input.sourceCallSeq)}`)
  }
  return `op:${input.domain}:${input.sessionId}#${input.sourceCallSeq}`
}

/**
 * Parse a canonical operation reference back to its parts.
 * @param ref - a string produced by {@link operationRefOf}.
 * @returns the parsed components.
 * @throws when the string does not match the canonical grammar.
 */
export function parseOperationRef(ref: string): { domain: string; sessionId: string; sourceCallSeq: number } {
  const match = /^op:([^:]+):([^#]+)#(\d+)$/.exec(ref)
  if (match === null) {
    throw new Error(`operationRef "${truncateForMessage(ref)}" does not match the canonical op:<domain>:<sessionId>#<seq> grammar`)
  }
  return { domain: match[1]!, sessionId: match[2]!, sourceCallSeq: Number(match[3]) }
}

/** Validate one correlation identity as a whole (fields present, bounded, well-formed). */
export function validateCorrelation(correlation: ObsCorrelation): void {
  const parsed = parseOperationRef(correlation.operationRef)
  assertComponent('domain', parsed.domain)
  assertComponent('sessionId', parsed.sessionId)
  if (correlation.runId !== undefined) assertComponent('runId', correlation.runId)
  if (correlation.goalRevision !== undefined && (!Number.isInteger(correlation.goalRevision) || correlation.goalRevision < 0)) {
    throw new Error(`correlation goalRevision must be a nonnegative integer, got ${String(correlation.goalRevision)}`)
  }
  if (!correlation.traceId.startsWith('trace-') || correlation.traceId.length < 7 || correlation.traceId.length > MAX_CORRELATION_ID_CHARS) {
    throw new Error(`correlation traceId must be a "trace-" prefixed id of at most ${MAX_CORRELATION_ID_CHARS} characters`)
  }
}

/**
 * Generate a fresh high-cardinality trace id (`trace-` + 16 hex chars from
 * crypto randomness). High cardinality is the point — and the reason trace
 * ids are rejected as metric labels.
 * @returns the generated trace id.
 */
export function newTraceId(): string {
  const hex = randomBytes(8).toString('hex')
  return `trace-${hex}`
}

function assertComponent(name: string, value: string): void {
  if (!CORRELATION_ID_PATTERN.test(value)) {
    throw new Error(`correlation ${name} must match ${CORRELATION_ID_PATTERN.source} (got "${truncateForMessage(value)}")`)
  }
}

// -- outcomes -----------------------------------------------------------------

/**
 * The closed outcome vocabulary. Every recorded settlement names exactly one:
 * `succeeded`, `partial` (some legs succeeded, named others did not),
 * `failed`, `cancelled`, `outcome_unknown` (the settlement cannot be known —
 * a killed worker, a lost response after a possible remote commit), and
 * `degraded` (the operation delivered with visibly reduced telemetry or
 * capability). Outcomes never default: a caller that cannot classify records
 * `outcome_unknown`.
 */
export const OBS_OUTCOMES = ['succeeded', 'partial', 'failed', 'cancelled', 'outcome_unknown', 'degraded'] as const

/** One recorded operation outcome. */
export type ObsOutcome = typeof OBS_OUTCOMES[number]

// -- error codes --------------------------------------------------------------

/**
 * The versioned closed error-code set. Each code has one fixed meaning; the
 * codes are the machine-readable protocol for failure classification, and
 * prose stays secondary. Adding or renaming a code is a contract version
 * change, never a local edit.
 */
export const OBS_ERROR_CODES = {
  FLUSH_FAILED: 'the durability checkpoint barrier failed; the accepted state stays accepted and is not reported durable',
  ARTIFACT_PUBLISH_FAILED: 'the catalog artifact publication ladder failed; nothing is reported as published',
  PROVIDER_RATE_LIMITED: 'the provider admitted the request as rate-limited; retry after backoff',
  PROVIDER_UNAVAILABLE: 'the provider is unreachable or refused the call; the dependent capability is unavailable',
  WORKER_CRASHED: 'the worker process died before settling; the outcome is outcome_unknown until the record says otherwise',
  RENDER_FAILED: 'the map render or display derivation failed; the data result stays valid and the render plane reports failed',
  CATALOG_LAGGING: 'the catalog projection lags its transactional store; reads stay consistent but freshness is degraded',
  CATALOG_UNAVAILABLE: 'the catalog store cannot be reached; registration, resolution, and publication are unavailable',
  TELEMETRY_DEGRADED: 'the observability plane itself dropped events or a sink failed; counts are exact, main results are unaffected',
  OPERATION_CONFLICT: 'the same operation identity arrived with a different request digest; blind resend is refused',
} as const

/** One observability error code. */
export type ObsErrorCode = keyof typeof OBS_ERROR_CODES

/** The closed code list (array form for membership checks). */
export const OBS_ERROR_CODE_LIST = Object.keys(OBS_ERROR_CODES) as readonly ObsErrorCode[]

/** The fixed meaning of one error code. */
export function errorCodeMeaning(code: ObsErrorCode): string {
  return OBS_ERROR_CODES[code]
}

// -- health planes ------------------------------------------------------------

/**
 * The separated health planes. No single boolean hides a partial failure:
 * `process` (the harness process itself, including telemetry self-health),
 * `provider` (model/LBS/network/storage/MCP providers), `catalog` (the
 * transactional resource catalog and its projections), `run` (durable run
 * execution, including workers), `data` (data durability: flush, chunk
 * stores, staged bytes), and `render` (display derivation and map render).
 */
export const OBS_HEALTH_PLANES = ['process', 'provider', 'catalog', 'run', 'data', 'render'] as const

/** One health plane name. */
export type ObsHealthPlane = typeof OBS_HEALTH_PLANES[number]

/** The closed health status vocabulary for one plane. */
export const OBS_HEALTH_STATUSES = ['ready', 'degraded', 'unavailable'] as const

/** One health plane status. */
export type ObsHealthStatus = typeof OBS_HEALTH_STATUSES[number]

/** Maximum characters of one health detail string (short, bounded, sanitized). */
export const MAX_HEALTH_DETAIL_CHARS = 160

// -- metrics vocabulary -------------------------------------------------------

/**
 * The closed measurement segments (the design §13.3 runtime-metrics points).
 * Latency, bytes, and queue observations all name one segment.
 */
export const OBS_SEGMENTS = ['context', 'mcp', 'compute', 'commit', 'flush', 'render', 'scan', 'cancel'] as const

/** One measurement segment name. */
export type ObsSegment = typeof OBS_SEGMENTS[number]

/** The closed provider vocabulary (a metric label, never free-form). */
export const OBS_PROVIDERS = ['model', 'lbs', 'network', 'storage', 'mcp'] as const

/** One provider label value. */
export type ObsProvider = typeof OBS_PROVIDERS[number]

/**
 * The closed metric label keys. Payload content, identifiers, and trace ids
 * never become labels — a label outside this vocabulary refuses loudly at the
 * recorder.
 */
export const OBS_METRIC_LABEL_KEYS = ['plane', 'segment', 'outcome', 'code', 'provider', 'kind'] as const

/** One metric label key. */
export type ObsMetricLabelKey = typeof OBS_METRIC_LABEL_KEYS[number]

/** One metric label set: every present key carries a closed-vocabulary value. */
export type ObsMetricLabels = Partial<{
  plane: ObsHealthPlane
  segment: ObsSegment
  outcome: ObsOutcome
  code: ObsErrorCode
  provider: ObsProvider
  kind: ObsDropKind
}>

/**
 * The closed metric names. Each fixes its allowed label keys:
 *
 * - `obs_operations_total{plane,outcome}` — settled operations per plane and outcome.
 * - `obs_segment_latency_ms{segment}` — per-segment wall-clock observations (ms).
 * - `obs_segment_bytes{segment}` — per-segment byte movement (meta/projection/display/scan planes).
 * - `obs_queue_wait_ms{plane}` — queue wait per plane.
 * - `obs_queue_depth{plane}` — queue depth gauge per plane.
 * - `obs_flush_failures_total{}` — durability checkpoint failures.
 * - `obs_artifact_publish_failures_total{}` — artifact publication failures.
 * - `obs_provider_calls_total{provider,outcome}` — provider calls per outcome.
 * - `obs_provider_rate_limited_total{provider}` — rate-limit refusals.
 * - `obs_render_failures_total{}` — render/display-derivation failures.
 * - `obs_fault_injections_total{code}` — deterministic fault injections.
 * - `obs_telemetry_dropped_total{kind}` — telemetry's own dropped events (`log_sample`, `log_audit`, `metric`, `export`).
 *
 * A metric's declared label keys are *required* on every record — an
 * unlabeled series is not a shape this vocabulary defines.
 */
export const OBS_METRICS = {
  obs_operations_total: ['plane', 'outcome'],
  obs_segment_latency_ms: ['segment'],
  obs_segment_bytes: ['segment'],
  obs_queue_wait_ms: ['plane'],
  obs_queue_depth: ['plane'],
  obs_flush_failures_total: [],
  obs_artifact_publish_failures_total: [],
  obs_provider_calls_total: ['provider', 'outcome'],
  obs_provider_rate_limited_total: ['provider'],
  obs_render_failures_total: [],
  obs_fault_injections_total: ['code'],
  obs_telemetry_dropped_total: ['kind'],
} as const

/** One closed metric name. */
export type ObsMetricName = keyof typeof OBS_METRICS

/** The closed telemetry-drop kinds (`obs_telemetry_dropped_total{kind}`). */
export const OBS_DROP_KINDS = ['log_sample', 'log_audit', 'metric', 'export'] as const

/** One telemetry-drop kind. */
export type ObsDropKind = typeof OBS_DROP_KINDS[number]

/** Maximum distinct label sets per metric; a breach is a cardinality-explosion bug and refuses loudly. */
export const OBS_MAX_CARDINALITY_PER_METRIC = 64

/** Maximum characters of one label value's derived string (closed vocabularies stay far below). */
export const MAX_LABEL_VALUE_CHARS = 48

/** The label keys each metric accepts, as a readonly map. */
export function metricLabelKeys(name: ObsMetricName): readonly string[] {
  return OBS_METRICS[name]
}

// -- logs ---------------------------------------------------------------------

/** The closed log levels. `audit` carries safety-relevant facts and is never sampled. */
export const OBS_LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'audit'] as const

/** One log level. */
export type ObsLogLevel = typeof OBS_LOG_LEVELS[number]

/** Maximum characters of one structured log message (a short fact, not a payload). */
export const MAX_LOG_MESSAGE_CHARS = 256

/** One structured log record: correlation fields attached, fields sanitized. */
export interface ObsLogRecord {
  /** Monotonic 1-based record index within one log. */
  readonly seq: number
  /** Wall-clock milliseconds from the injected clock (or `Date.now`). */
  readonly atMs: number
  readonly level: ObsLogLevel
  /** The error code, when the record classifies a failure or degradation. */
  readonly code?: ObsErrorCode
  /** Short static fact — never payload content. */
  readonly message: string
  /** Correlation fields from the ambient scope, when one is active. */
  readonly correlation?: ObsCorrelation
  /** Sanitized caller fields (credentials/geometry/paths already replaced). */
  readonly fields?: Record<string, unknown>
}

// -- fault injection ----------------------------------------------------------

/**
 * The closed fault-injection points (the failure matrix the tasks name).
 * Each point maps to the health plane its failure degrades.
 */
export const OBS_FAULT_POINTS = ['flush', 'artifact-publish', 'provider', 'worker', 'render'] as const

/** One fault-injection point name. */
export type ObsFaultPoint = typeof OBS_FAULT_POINTS[number]

/** The health plane each fault point degrades. */
export const OBS_FAULT_POINT_PLANES: Record<ObsFaultPoint, ObsHealthPlane> = {
  flush: 'data',
  'artifact-publish': 'catalog',
  provider: 'provider',
  worker: 'run',
  render: 'render',
}

/** The default error code each fault point injects. */
export const OBS_FAULT_POINT_CODES: Record<ObsFaultPoint, ObsErrorCode> = {
  flush: 'FLUSH_FAILED',
  'artifact-publish': 'ARTIFACT_PUBLISH_FAILED',
  provider: 'PROVIDER_RATE_LIMITED',
  worker: 'WORKER_CRASHED',
  render: 'RENDER_FAILED',
}

// -- bounds -------------------------------------------------------------------

/** Default record capacity of one bounded buffer (logs, metric series, histories). */
export const DEFAULT_OBS_CAPACITY = 1_024

/** Default byte budget of the diagnostic export. */
export const DEFAULT_MAX_EXPORT_BYTES = 64 * 1024

/** Validate a closed-vocabulary membership; misuse is a code bug and refuses loudly. */
export function assertInVocabulary<T extends string>(value: string, vocabulary: readonly T[], what: string): asserts value is T {
  if (!(vocabulary as readonly string[]).includes(value)) {
    throw new Error(`${what} "${value}" is outside the closed vocabulary (${vocabulary.join(', ')})`)
  }
}

function truncateForMessage(value: string): string {
  return value.length > 64 ? `${value.slice(0, 61)}...` : value
}
