/**
 * The DecisionFrame domain: the GoalContract / PlanState / EvidenceLedger
 * triple and the source-authority rules that keep them separate.
 *
 * Authority rules (design §3.3, audit D06): only an accepted real user
 * message — `source.kind === 'user'` — changes the GoalContract. Plugin
 * user-role context, model output, and tool results never do, no matter what
 * seqs they cite. The model's `decision_update` results write only the
 * PlanState, and only when they cite the current goal and plan revisions.
 * The EvidenceLedger folds settled tool results and machine-checkable
 * outcomes only; a model can never mark evidence complete by assertion.
 *
 * Every record is plain JSON and bounded; the projection state that carries
 * these records is the single authoritative fold of accepted session events.
 *
 * @module @map-harness/spatial-context/frame
 */

/** Wire version of the decisionFrame domain records folded by the projection. */
export const DECISION_FRAME_STATE_VERSION = 1

/** Maximum goal question text characters retained per goal revision. */
export const MAX_GOAL_QUESTION_CHARS = 2000

/** Maximum plan records retained (oldest dropped first). */
export const MAX_PLAN_HISTORY = 8

/** Maximum unsettled spatial calls tracked between `tool/call` and `tool/result`. */
export const MAX_PENDING_FRAME_CALLS = 64

/** Maximum distinct spatial tool names retained in the seen-tools list. */
export const MAX_SEEN_TOOLS = 16

/** Maximum interpretation/steps/gap list entries inside one plan update. */
export const MAX_PLAN_LIST_ENTRIES = 32

/** Maximum evidence entries retained (oldest dropped first). */
export const MAX_EVIDENCE_ENTRIES = 64

/** Maximum resource candidates retained (oldest dropped first). */
export const MAX_RESOURCE_CANDIDATES = 32

/** Maximum accepted-injection records retained (oldest dropped first). */
export const MAX_INJECTION_RECORDS = 32

/** Maximum bounded read-only diagnostics retained (oldest dropped first). */
export const MAX_FRAME_DIAGNOSTICS = 16

/** How one GoalContract change was authorized. */
export type GoalSourceKind = 'user-message'

/** One accepted GoalContract revision. */
export interface GoalContract {
  /** Stable question identity derived from the authorizing message seq. */
  readonly questionId: string
  /** Monotonic goal revision; advances exactly on each accepted real user message. */
  readonly goalRevision: number
  /** Bounded text of the authorizing user message. */
  readonly question: string
  /** Seq of the accepted `user/message` event that authorized this goal. */
  readonly sourceSeq: number
  /** How the goal was authorized — a real user message, nothing else. */
  readonly sourceKind: GoalSourceKind
  /** Epoch millis of the authorizing event (the log's own timestamp). */
  readonly acceptedAt: number
}

/** Why one plan-update candidate was refused. */
export type PlanUpdateRefusal =
  | 'goal-revision-stale'
  | 'plan-revision-conflict'
  | 'unknown-evidence-ref'

/** One model-proposed method candidate inside a plan update. */
export interface PlanMethod {
  /** Method or card id the plan proposes (for example a method card id). */
  readonly name: string
  /** Bounded rationale citing why this method applies. */
  readonly rationale?: string
}

/** One open/resolved data or authorization gap the plan tracks. */
export interface PlanGap {
  /** Stable gap id supplied by the planner (repeated remediation keys on it). */
  readonly id: string
  /** Bounded description of what is missing. */
  readonly description: string
  readonly status: 'open' | 'blocked' | 'resolved'
}

/** One accepted PlanState revision. */
export interface PlanState {
  /** Monotonic plan revision; advances only on an accepted `decision_update` result. */
  readonly planRevision: number
  /** The goal revision this plan was written against. */
  readonly goalRevision: number
  /** The question identity this plan was written against. */
  readonly questionId: string
  /** Tentative model interpretation of the goal — never user authority. */
  readonly interpretation?: string
  readonly methods: readonly PlanMethod[]
  readonly steps: readonly string[]
  readonly gaps: readonly PlanGap[]
  /** Seq of the accepted `tool/result` that carried this revision. */
  readonly sourceSeq: number
}

/** Evidence record status vocabulary; `succeeded` requires a settled result, never an assertion. */
export type EvidenceStatus = 'succeeded' | 'partial' | 'unknown' | 'not_applicable' | 'failed'

/** Which durable record kind one evidence entry folded from. */
export type EvidenceKind = 'analysis-result' | 'catalog-result' | 'map-save-receipt' | 'failed-tool' | 'decision-change'

/** One EvidenceLedger entry: a settled, bounded fact about what actually ran. */
export interface EvidenceEntry {
  /** Stable identity derived from the result seq. */
  readonly evidenceId: string
  /** Seq of the settled `tool/result` event. */
  readonly seq: number
  readonly kind: EvidenceKind
  /** The spatial tool that produced the record. */
  readonly tool: string
  readonly status: EvidenceStatus
  /** Exact resource/artifact ref the record cited, when present. */
  readonly ref?: string
  /** Content digest the record pinned, when present. */
  readonly contentDigest?: string
  /** Feature count the record actually consumed (scan accounting), when present. */
  readonly scanFeatures?: number
  /** Bounded limitation/diagnostic lines preserved from the record. */
  readonly limitations: readonly string[]
}

/** One resource candidate a catalog result presented to the model. */
export interface ResourceCandidate {
  /** Exact resource version ref as presented at that catalog read point. */
  readonly ref: string
  readonly contentDigest: string
  readonly schemaDigest: string
  readonly nativeCrs: string
  readonly featureCount: number
  readonly authorization: string
  /** Seq of the catalog result that presented this candidate. */
  readonly presentedAt: number
}

/** One confirmed snapshot injection: the message actually entered the model surface. */
export interface InjectionRecord {
  /** Seq of the accepted `user/message` event. */
  readonly seq: number
  /** Content digest of the injected snapshot text. */
  readonly digest: string
  readonly form: 'baseline' | 'increment'
  /** Serialized size of the injected snapshot text. */
  readonly bytes: number
}

/** Why the fold refused one candidate record and kept prior state. */
export type FrameDiagnosticCode =
  | 'failed-result'
  | 'unknown-schema-version'
  | 'unknown-kind'
  | 'invalid-meta'
  | 'oversized-meta'
  | 'call-pairing'
  | 'goal-revision-stale'
  | 'plan-revision-conflict'
  | 'unknown-evidence-ref'
  | 'pending-overflow'

/** One bounded read-only diagnostic about a refused domain write. */
export interface FrameDiagnostic {
  /** Seq of the event that produced it. */
  readonly seq: number
  readonly code: FrameDiagnosticCode
}

/** The authoritative DecisionFrame the projection folds for one session. */
export interface DecisionFrame {
  /** Current accepted goal; `null` until a real user message is accepted. */
  readonly goal: GoalContract | null
  /** Current plan revision; `null` until an accepted `decision_update` result. */
  readonly plan: PlanState | null
  /** Bounded, newest-last ledger of settled evidence. */
  readonly evidence: readonly EvidenceEntry[]
  /** Bounded resource candidates presented by accepted catalog results. */
  readonly resources: readonly ResourceCandidate[]
  /** Bounded, newest-last confirmed snapshot injections. */
  readonly injections: readonly InjectionRecord[]
  /** Bounded read-only diagnostics for refused domain writes. */
  readonly diagnostics: readonly FrameDiagnostic[]
  /** Every spatial tool name observed in accepted calls, in first-seen order. */
  readonly seenTools: readonly string[]
}

/**
 * Whether one message source carries user authority over the GoalContract.
 * Only the upstream real-user entry produces `kind: 'user'`; plugin context,
 * model output, and tool results never pass, whatever they cite.
 * @param source - the message source from an accepted `user/message`.
 */
export function isUserAuthoritySource(source: { readonly kind: string }): boolean {
  return source.kind === 'user'
}

/** Drop the oldest entries beyond the bound (shared bounded-list helper). */
export function bounded<T>(entries: readonly T[], max: number): readonly T[] {
  return entries.length <= max ? entries : entries.slice(entries.length - max)
}

/**
 * Validate one plan-update candidate against the current frame before it is
 * proposed as a `decision-change` record. The checks run twice by design:
 * the `decision_update` tool refuses before returning, and the projection
 * re-checks on fold so a replayed or stale log never applies an invalid plan.
 * @param frame - the current authoritative frame.
 * @param candidate - the goal/plan revisions and citations the update claims.
 * @returns `undefined` when the update may proceed, else the refusal code.
 */
export function checkPlanUpdate(
  frame: DecisionFrame,
  candidate: {
    readonly goalRevision: number
    readonly expectedPlanRevision: number
    readonly evidenceRefs?: readonly number[]
  },
): PlanUpdateRefusal | undefined {
  // A plan always writes against a live goal: no accepted goal, or a cited
  // revision that is not the current one, is stale — old runs never overwrite
  // a new goal.
  if (frame.goal === null || candidate.goalRevision !== frame.goal.goalRevision) {
    return 'goal-revision-stale'
  }
  const currentPlanRevision = frame.plan?.planRevision ?? 0
  if (candidate.expectedPlanRevision !== currentPlanRevision) {
    return 'plan-revision-conflict'
  }
  for (const ref of candidate.evidenceRefs ?? []) {
    if (!frame.evidence.some(entry => entry.seq === ref)) {
      return 'unknown-evidence-ref'
    }
  }
  return undefined
}

/**
 * Derive the stable question identity for one authorizing message seq.
 * @param sourceSeq - seq of the accepted real `user/message`.
 */
export function questionIdOf(sourceSeq: number): string {
  return `q-${sourceSeq}`
}

/**
 * Derive the stable evidence identity for one settled result seq.
 * @param seq - seq of the settled `tool/result`.
 */
export function evidenceIdOf(seq: number): string {
  return `ev-${seq}`
}
