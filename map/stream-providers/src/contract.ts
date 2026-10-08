/**
 * The versioned `stream-providers@1` contract: the two real stream source
 * families a deployment can declare (a standard SSE endpoint and an
 * OpenAI-compatible streaming completions relay), the closed read-outcome
 * vocabulary, the bounded read-round policy every source honors, and the
 * by-name credential-reference grammar (`cc-switch:<name>` — the value is
 * fetched from the cc-switch store at execution rounds and never enters
 * config, logs, error text, or summaries).
 *
 * Access capability means a declared real stream source can be opened over a
 * real network channel, read in bounded rounds (a parked in-flight read
 * survives the round deadline so a quiet stream is held, not killed), and
 * closed quiescently. Multi-source fusion is the contract's second half: a
 * declared fusion binds 2..8 sources behind one fused event-time horizon —
 * the minimum over the live sources' max received event times — so a lagging
 * source holds the fused conclusion back instead of burning the revision
 * budget, with per-source pending queues, namespaced event ids
 * (`sourceId::eventId`), and per-source counters. No stream host is deployed
 * by this project: the keyless lanes prove the reader face against loopback
 * fixtures; the live lane verifies the real DeepSeek flash endpoint
 * (2026-10-07 deployment decision).
 *
 * Protocol constants (deadline bounds, round budgets, capacity caps) are
 * fixed here and never configurable: endpoints, models, prompts, and
 * credential references are the deployment-varying choices and live in the
 * plugin Config; the read discipline is the contract.
 *
 * @module @map-harness/stream-providers/contract
 */

/** Version identity of this contract; bump only on structural changes. */
export const STREAM_PROVIDERS_VERSION = 'stream-providers@1'

/** The real stream source kinds this plane can read. */
export type StreamSourceKind = 'sse' | 'completions'

/**
 * The closed vocabulary of source read outcomes. Every value except
 * `streaming` names a *failed read round* carried on the source state and
 * the verification report, never a throw past the service face; `streaming`
 * is the only outcome that proves the channel open and readable.
 * `source-closed` names a clean end (SSE close, completions `[DONE]`), which
 * is a terminal state, not a failure.
 */
export type StreamReadOutcome =
  | 'streaming'
  | 'unreachable'
  | 'auth-rejected'
  | 'http-error'
  | 'content-type-violated'
  | 'stream-violated'
  | 'timeout'
  | 'aborted'
  | 'source-closed'

/** All outcomes in their canonical order; assertions iterate this list. */
export const STREAM_READ_OUTCOMES: readonly StreamReadOutcome[] = [
  'streaming', 'unreachable', 'auth-rejected', 'http-error',
  'content-type-violated', 'stream-violated', 'timeout', 'aborted',
  'source-closed',
]

/** Source or fusion id rule: lowercase letter, then letters/digits/hyphens, ≤64 chars. */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** Credential-reference prefix: the only credential store this plane reads. */
export const CREDENTIAL_STORE = 'cc-switch' as const

/** Maximum number of declared sources (bounded config). */
export const MAX_SOURCES = 16

/** Maximum number of declared fusions (bounded config). */
export const MAX_FUSIONS = 16

/** A fusion binds at least this many sources (one source is no fusion). */
export const FUSION_MIN_SOURCES = 2

/** A fusion binds at most this many sources (bounded horizon computation). */
export const FUSION_MAX_SOURCES = 8

/** Bounds for every read round's wall-clock deadline, in milliseconds. */
export const MIN_TIMEOUT_MS = 1000
export const MAX_TIMEOUT_MS = 60_000
export const DEFAULT_TIMEOUT_MS = 10_000

/** Events one read round may consume from the wire before it yields. */
export const MIN_EVENTS_PER_FETCH = 1
export const MAX_EVENTS_PER_FETCH = 1024
export const DEFAULT_EVENTS_PER_FETCH = 256

/** Bytes one accumulated line may span before the stream is violated. */
export const MIN_LINE_BYTES = 1024
export const MAX_LINE_BYTES = 1_048_576
export const DEFAULT_LINE_BYTES = 65_536

/** Events one source's pending queue holds before the source is held back. */
export const MIN_PENDING_CAPACITY = 1
export const MAX_PENDING_CAPACITY = 4096
export const DEFAULT_PENDING_CAPACITY = 1024

/** Events one fused release may carry (oldest event times first; surplus stays pending). */
export const MIN_EVENTS_PER_RELEASE = 1
export const MAX_EVENTS_PER_RELEASE = 4096
export const DEFAULT_EVENTS_PER_RELEASE = 512

/** Server-side completion budget for one completions relay request. */
export const MIN_MAX_TOKENS = 256
export const MAX_MAX_TOKENS = 8192
export const DEFAULT_MAX_TOKENS = 1024

/** Maximum length of a completions relay seed prompt. */
export const MAX_PROMPT_LENGTH = 2048

/** Maximum length of any single model name. */
export const MAX_MODEL_LENGTH = 128

/** Maximum serialized length of one outcome detail line; longer is truncated. */
export const MAX_DETAIL_LENGTH = 512

/** A named standard SSE endpoint source as the deployment declares it. */
export interface SseSourceSpec {
  /** Unique source id across both kinds. */
  readonly id: string
  /** Discriminator for the SSE source family. */
  readonly kind: 'sse'
  /** Endpoint URL: `http(s)`, a host, no userinfo, no fragment. */
  readonly url: string
  /** By-name credential reference (`cc-switch:<name>`); omitted means an unauthenticated feed. */
  readonly credentialRef?: string
  /** Wall-clock deadline for the open exchange and any single read round. */
  readonly timeoutMs?: number
  /** Events one read round may consume before it yields. */
  readonly maxEventsPerFetch?: number
  /** Bytes one SSE data payload may span before the stream is violated. */
  readonly maxLineBytes?: number
}

/**
 * A named OpenAI-compatible streaming completions relay source. The model is
 * instructed to stream newline-delimited JSON events in the
 * {@link StreamEvent} wire shape; token deltas are assembled into lines and
 * each complete line is parsed as one event (or an array of events).
 */
export interface CompletionsSourceSpec {
  /** Unique source id across both kinds. */
  readonly id: string
  /** Discriminator for the completions relay family. */
  readonly kind: 'completions'
  /** Chat-completions endpoint URL: `http(s)`, a host, no userinfo, no fragment. */
  readonly url: string
  /** Model id the relay requests (for example `deepseek-flash`). */
  readonly model: string
  /** By-name credential reference (`cc-switch:<name>`); required — a keyless relay is refused. */
  readonly credentialRef: string
  /** Seed topic folded into the fixed relay instruction; bounded. */
  readonly prompt?: string
  /** Base event time the relay instruction anchors monotonically increasing `eventTimeMs` to. */
  readonly eventTimeBaseMs?: number
  /** Server-side token budget for one relay request. */
  readonly maxTokens?: number
  /** Wall-clock deadline for the open exchange and any single read round. */
  readonly timeoutMs?: number
  /** Events one read round may consume before it yields. */
  readonly maxEventsPerFetch?: number
  /** Bytes one NDJSON event line may span before the stream is violated. */
  readonly maxLineBytes?: number
}

/** Any declared source spec. */
export type AnyStreamSourceSpec = SseSourceSpec | CompletionsSourceSpec

/** A declared multi-source fusion: one fused horizon over 2..8 named sources. */
export interface StreamFusionSpec {
  /** Unique fusion id. */
  readonly id: string
  /** Declared source ids this fusion binds, in declaration order (the release tiebreak). */
  readonly sources: readonly string[]
  /** Events each source's pending queue holds before that source is held back. */
  readonly pendingCapacity?: number
  /** Events one fused release may carry. */
  readonly maxEventsPerRelease?: number
}

/** The report one bounded source verification produces. */
export interface StreamSourceVerification {
  /** The verified source id. */
  readonly id: string
  /** The source family that produced this report. */
  readonly kind: StreamSourceKind
  /** The closed outcome vocabulary value naming the read result. */
  readonly outcome: StreamReadOutcome
  /** Sanitized, bounded diagnostic; never a credential value or host absolute path. */
  readonly detail: string
  /** Wire events the verifying read observed, when the stream opened. */
  readonly eventsObserved: number
  /** Whole-exchange wall time in milliseconds. */
  readonly durationMs: number
}

/** Validate a source or fusion id against the contract rule. */
export function streamIdProblem(id: string): string | undefined {
  if (!ID_PATTERN.test(id)) {
    return `id "${redact(id)}" must match ${ID_PATTERN.source} (lowercase letter first, letters/digits/hyphens, at most 64 chars)`
  }
  return undefined
}

/**
 * Validate a by-name credential reference. Grammar: `cc-switch:<name>` where
 * the name is 1..128 chars, carries no colon, no control characters, and no
 * leading/trailing whitespace. The name identifies a provider entry in the
 * cc-switch store; the value never enters this contract.
 */
export function credentialRefProblem(ref: string): string | undefined {
  if (ref.length === 0) {
    return 'credential reference must not be empty'
  }
  const separator = ref.indexOf(':')
  if (separator === -1) {
    return `credential reference "${redact(ref)}" must name its store as ${CREDENTIAL_STORE}:<name>`
  }
  const store = ref.slice(0, separator)
  if (store !== CREDENTIAL_STORE) {
    return `credential reference names store "${redact(store)}"; only ${CREDENTIAL_STORE}:<name> is supported`
  }
  const name = ref.slice(separator + 1)
  if (name.length === 0 || name.length > 128) {
    return `credential name in "${redact(ref)}" must be 1..128 chars`
  }
  if (name.includes(':')) {
    return `credential name in "${redact(ref)}" must not contain a colon`
  }
  if (name !== name.trim()) {
    return `credential name in "${redact(ref)}" must not carry leading or trailing whitespace`
  }
  for (const char of name) {
    if (char < ' ' || char === '\x7f') {
      return `credential name in "${redact(ref)}" must not contain control characters`
    }
  }
  return undefined
}

/** Validate the deadline field shared by both families. */
function timeoutProblem(timeoutMs: number | undefined): string | undefined {
  if (timeoutMs === undefined) return undefined
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return `timeoutMs must be an integer between ${String(MIN_TIMEOUT_MS)} and ${String(MAX_TIMEOUT_MS)}`
  }
  return undefined
}

/** Validate the per-round fetch budget shared by both families. */
function fetchBudgetProblem(maxEventsPerFetch: number | undefined): string | undefined {
  if (maxEventsPerFetch === undefined) return undefined
  if (!Number.isInteger(maxEventsPerFetch) || maxEventsPerFetch < MIN_EVENTS_PER_FETCH || maxEventsPerFetch > MAX_EVENTS_PER_FETCH) {
    return `maxEventsPerFetch must be an integer between ${String(MIN_EVENTS_PER_FETCH)} and ${String(MAX_EVENTS_PER_FETCH)}`
  }
  return undefined
}

/** Validate the line-byte cap shared by both families. */
function lineBytesProblem(maxLineBytes: number | undefined): string | undefined {
  if (maxLineBytes === undefined) return undefined
  if (!Number.isInteger(maxLineBytes) || maxLineBytes < MIN_LINE_BYTES || maxLineBytes > MAX_LINE_BYTES) {
    return `maxLineBytes must be an integer between ${String(MIN_LINE_BYTES)} and ${String(MAX_LINE_BYTES)}`
  }
  return undefined
}

/** Validate an endpoint URL: absolute `http(s)`, a host, no userinfo, no fragment. */
function endpointUrlProblem(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return `url "${redact(url)}" does not parse as an absolute URL`
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `url scheme must be http or https, got "${parsed.protocol}"`
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'url must not carry userinfo credentials'
  }
  if (parsed.hash !== '') {
    return 'url must not carry a fragment'
  }
  if (parsed.host === '') {
    return 'url must name a host'
  }
  return undefined
}

/** Validate an SSE source spec; returns the first problem or undefined. */
export function sseSpecProblem(spec: SseSourceSpec): string | undefined {
  const urlProblem = endpointUrlProblem(spec.url)
  if (urlProblem !== undefined) return urlProblem
  if (spec.credentialRef !== undefined) {
    const refProblem = credentialRefProblem(spec.credentialRef)
    if (refProblem !== undefined) return refProblem
  }
  const budget = fetchBudgetProblem(spec.maxEventsPerFetch)
  if (budget !== undefined) return budget
  const lineBytes = lineBytesProblem(spec.maxLineBytes)
  if (lineBytes !== undefined) return lineBytes
  return timeoutProblem(spec.timeoutMs)
}

/** Validate a completions relay spec; returns the first problem or undefined. */
export function completionsSpecProblem(spec: CompletionsSourceSpec): string | undefined {
  const urlProblem = endpointUrlProblem(spec.url)
  if (urlProblem !== undefined) return urlProblem
  if (spec.model.length === 0 || spec.model.length > MAX_MODEL_LENGTH) {
    return `model must be 1..${String(MAX_MODEL_LENGTH)} chars, got ${String(spec.model.length)}`
  }
  if (spec.model.includes('\0') || spec.model.includes('\n')) {
    return 'model must not contain NUL or newline bytes'
  }
  if (spec.credentialRef === undefined) {
    return 'completions sources require a by-name credential reference (cc-switch:<name>); a keyless relay is refused'
  }
  const refProblem = credentialRefProblem(spec.credentialRef)
  if (refProblem !== undefined) {
    return `completions sources require a by-name credential reference: ${refProblem}`
  }
  if (spec.prompt !== undefined) {
    if (spec.prompt.length > MAX_PROMPT_LENGTH) {
      return `prompt must be at most ${String(MAX_PROMPT_LENGTH)} chars, got ${String(spec.prompt.length)}`
    }
    if (spec.prompt.includes('\0')) {
      return 'prompt must not contain NUL bytes'
    }
  }
  if (spec.eventTimeBaseMs !== undefined && (!Number.isFinite(spec.eventTimeBaseMs) || spec.eventTimeBaseMs < 0)) {
    return 'eventTimeBaseMs must be a finite non-negative number'
  }
  if (spec.maxTokens !== undefined) {
    if (!Number.isInteger(spec.maxTokens) || spec.maxTokens < MIN_MAX_TOKENS || spec.maxTokens > MAX_MAX_TOKENS) {
      return `maxTokens must be an integer between ${String(MIN_MAX_TOKENS)} and ${String(MAX_MAX_TOKENS)}`
    }
  }
  const budget = fetchBudgetProblem(spec.maxEventsPerFetch)
  if (budget !== undefined) return budget
  const lineBytes = lineBytesProblem(spec.maxLineBytes)
  if (lineBytes !== undefined) return lineBytes
  return timeoutProblem(spec.timeoutMs)
}

/**
 * Validate a fusion spec against the declared source ids; returns the first
 * problem or undefined.
 * @param spec - the fusion spec to validate.
 * @param declaredSourceIds - the declared source id set the fusion may bind.
 */
export function fusionSpecProblem(spec: StreamFusionSpec, declaredSourceIds: ReadonlySet<string>): string | undefined {
  if (spec.sources.length < FUSION_MIN_SOURCES || spec.sources.length > FUSION_MAX_SOURCES) {
    return `fusion must bind ${String(FUSION_MIN_SOURCES)}..${String(FUSION_MAX_SOURCES)} sources, got ${String(spec.sources.length)}`
  }
  const seen = new Set<string>()
  for (const sourceId of spec.sources) {
    if (!declaredSourceIds.has(sourceId)) {
      return `fusion names source "${redact(sourceId)}", which is not declared`
    }
    if (seen.has(sourceId)) {
      return `fusion binds source "${redact(sourceId)}" more than once`
    }
    seen.add(sourceId)
  }
  if (spec.pendingCapacity !== undefined) {
    if (!Number.isInteger(spec.pendingCapacity) || spec.pendingCapacity < MIN_PENDING_CAPACITY || spec.pendingCapacity > MAX_PENDING_CAPACITY) {
      return `pendingCapacity must be an integer between ${String(MIN_PENDING_CAPACITY)} and ${String(MAX_PENDING_CAPACITY)}`
    }
  }
  if (spec.maxEventsPerRelease !== undefined) {
    if (!Number.isInteger(spec.maxEventsPerRelease) || spec.maxEventsPerRelease < MIN_EVENTS_PER_RELEASE || spec.maxEventsPerRelease > MAX_EVENTS_PER_RELEASE) {
      return `maxEventsPerRelease must be an integer between ${String(MIN_EVENTS_PER_RELEASE)} and ${String(MAX_EVENTS_PER_RELEASE)}`
    }
  }
  return undefined
}

/** Clamp detail text to the contract bound; credential material never reaches this function. */
export function boundDetail(text: string): string {
  if (text.length <= MAX_DETAIL_LENGTH) return text
  return `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…`
}

/** Redact free-text config fragments to a bounded shape before they enter diagnostics. */
function redact(value: string): string {
  const bounded = value.slice(0, 32)
  return bounded.length === value.length ? bounded : `${bounded}…`
}
