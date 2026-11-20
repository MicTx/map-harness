/**
 * The `streamProviders` service face: the declared real stream sources and
 * fusions of this deployment, listed sanitized, verified with one bounded
 * exchange, and driven through open fusion handles. The surface mirrors the
 * transport plane's shape — `listSources` names the declared set (credential
 * *references* only, never values), `verifySource` runs one bounded read
 * round whose every answer, credential refusals included, is an outcome on
 * the report, and the fusion dispatch plane (`openFusion` /
 * `fusionAdvance` / `pauseSource` / `resumeSource` / `closeFusion`) drives
 * the engine. Credential values resolve at the execution round that opens a
 * source — cc-switch is the rotation point — and live only in the reader's
 * memory; they never enter summaries, reports, or errors. Unknown ids are
 * named program errors; wire conditions never are.
 *
 * @module @map-harness/stream-providers/service
 */
import type {
  AnyStreamSourceSpec,
  StreamFusionSpec,
  StreamSourceVerification,
} from './contract.ts'
import { boundDetail, MAX_DETAIL_LENGTH } from './contract.ts'
import type { FusionAdvanceReport, FusionSourceReport } from './fusion.ts'
import { streamCredentialFailure } from './errors.ts'

/** Service name under `ctx.reflect.provide`. */
export const STREAM_PROVIDERS_SERVICE = 'streamProviders'

/** Options the service's exchange methods accept. */
export interface StreamServiceOptions {
  /** Caller cancellation, threaded to every exchange the round makes. */
  readonly signal?: AbortSignal
  /** Per-exchange deadline override, honored by every source read. */
  readonly timeoutMs?: number
}

/** One declared source as `listSources` reports it. */
export interface StreamSourceSummary {
  /** Declared source id. */
  readonly id: string
  /** Source family. */
  readonly kind: 'sse' | 'completions'
  /** Endpoint identity (URL) — carries no credential value. */
  readonly endpoint: string
  /** Credential reference by name (`cc-switch:<name>`), or null for an unauthenticated feed. */
  readonly credentialRef: string | null
}

/** One declared fusion as the service reports it. */
export interface StreamFusionSummary {
  /** Declared fusion id. */
  readonly id: string
  /** Bound source ids in declaration order. */
  readonly sources: readonly string[]
  /** Current per-source state faces, when the fusion is open. */
  readonly perSource: readonly FusionSourceReport[] | null
}

/** The host-facing stream provider service. */
export interface StreamProvidersService {
  /** Every declared source spec, in declaration order. */
  readonly specs: readonly AnyStreamSourceSpec[]
  /** Every declared fusion spec, in declaration order. */
  readonly fusionSpecs: readonly StreamFusionSpec[]
  /** Name the declared sources with sanitized endpoint identities. */
  listSources(): readonly StreamSourceSummary[]
  /** Name the declared fusions with their bound source sets. */
  listFusions(): readonly StreamFusionSummary[]
  /**
   * Run one bounded verification read over a fresh reader for one source.
   * Credential refusals resolve to the `auth-rejected` outcome with the
   * sanitized, by-name detail; wire answers are outcomes, not throws.
   * @param id - a declared source id.
   * @param options - deadline and cancellation for the whole exchange.
   * @returns the verification report.
   * @throws StreamProvidersError only when `id` is not declared.
   */
  verifySource(id: string, options?: StreamServiceOptions): Promise<StreamSourceVerification>
  /**
   * Open (or return the already open) fusion engine for one declared
   * fusion; readers resolve their credentials lazily at first read.
   * @param id - a declared fusion id.
   * @returns the open fusion's summary with its per-source state faces.
   * @throws StreamProvidersError when `id` is not declared.
   */
  openFusion(id: string): Promise<StreamFusionSummary>
  /**
   * Run one fusion round on the open engine.
   * @param id - a declared fusion id.
   * @param options - deadline and cancellation threaded to every source read.
   * @returns the round's report (released events, batches, horizon, states).
   * @throws StreamProvidersError when `id` is not declared or not open.
   */
  fusionAdvance(id: string, options?: StreamServiceOptions): Promise<FusionAdvanceReport>
  /**
   * Pause one bound source inside an open fusion.
   * @param fusionId - a declared fusion id.
   * @param sourceId - the source id to pause.
   * @throws StreamProvidersError when either id is unknown or the fusion is not open.
   */
  pauseSource(fusionId: string, sourceId: string): void
  /**
   * Resume one paused source inside an open fusion.
   * @param fusionId - a declared fusion id.
   * @param sourceId - the source id to resume.
   * @throws StreamProvidersError when either id is unknown or the fusion is not open.
   */
  resumeSource(fusionId: string, sourceId: string): void
  /**
   * Close the open fusion engine for one id, tearing every reader down.
   * @param id - a declared fusion id.
   * @returns true when an engine was closed, false when none was open.
   */
  closeFusion(id: string): Promise<boolean>
}

/** Sanitize one failure detail to the contract's bounded, path-free form. */
/** Sanitize one failure detail to the contract's bounded, path-free form. */
export function sanitizeDetail(text: string): string {
  return boundDetail(text.slice(0, MAX_DETAIL_LENGTH))
}

/** Credential refusals map onto the read outcome vocabulary; re-exported for the service consumers. */
export { streamCredentialFailure as credentialOutcome }
