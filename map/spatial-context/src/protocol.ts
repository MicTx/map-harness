/**
 * The `decisionFrame` protocol: the plain-JSON persisted state of the
 * spatial-context projection and the pure fold every accepted session event
 * passes through.
 *
 * Commit discipline (P0a precedent, design §5.3): the state only folds
 * accepted session events. A GoalContract advances on every accepted real
 * `user/message` (`source.kind === 'user'`); a PlanState revision folds only
 * from a successful, paired, first-settled `decision_update` result whose
 * versioned `decision-change` record cites the current goal and plan
 * revisions; evidence folds only from settled spatial tool results with a
 * decodable record — failed results fold as bounded `failed-tool` entries,
 * and unknown versions are read-only diagnostics. Snapshot injections fold
 * only from snapshot `user/message` events that actually entered the
 * surface, so an injection is never confirmed by composition alone.
 *
 * @module @map-harness/spatial-context/protocol
 */
import { z } from 'zod'
import {
  bounded,
  checkPlanUpdate,
  evidenceIdOf,
  isUserAuthoritySource,
  MAX_EVIDENCE_ENTRIES,
  MAX_FRAME_DIAGNOSTICS,
  MAX_GOAL_QUESTION_CHARS,
  MAX_INJECTION_RECORDS,
  MAX_PENDING_FRAME_CALLS,
  MAX_RESOURCE_CANDIDATES,
  MAX_SEEN_TOOLS,
  questionIdOf,
  type DecisionFrame,
  type EvidenceEntry,
  type FrameDiagnosticCode,
  type GoalContract,
  type InjectionRecord,
  type PlanGap,
  type PlanState,
  type ResourceCandidate,
} from './frame.ts'
import {
  foldConsumption,
  foldContextBytes,
  foldGapRetry,
  foldStep,
  initialBudgetLedger,
  type BudgetLedger,
} from './budget.ts'
import {
  decodeDecisionChangeMeta,
  readAnalysisResult,
  readCatalogResult,
  readSaveReceipt,
} from './records.ts'

/**
 * The plugin name every injected snapshot message cites as its source
 * plugin. The fold recognizes exactly this name; look-alike sources never
 * confirm injections.
 */
export const SPATIAL_CONTEXT_PLUGIN_NAME = '@map-harness/spatial-context'

/** Persisted-state generation of the `decisionFrame` unit. */
export const DECISION_FRAME_STATE_VERSION = 1

/** The fixed spatial tool names whose calls/results the frame folds. Pinned to the map-tools unified catalog by a parity test. */
export const FRAME_SPATIAL_TOOL_NAMES = [
  'map_add_layer',
  'map_remove_layer',
  'map_set_view',
  'map_set_mode',
  'map_get_state',
  'geo_buffer',
  'geo_area',
  'geo_intersect',
  'geo_distance',
  'catalog_register',
  'catalog_resolve',
  'map_save',
  'decision_update',
] as const

/** One spatial tool name the frame folds. */
export type FrameSpatialToolName = typeof FRAME_SPATIAL_TOOL_NAMES[number]

/** Maximum serialized spatial meta bytes retained per fold diagnostic line. */
const MAX_LIMITATION_LINES = 8

/** Maximum characters of one folded limitation/diagnostic line. */
const MAX_LIMITATION_CHARS = 200

/** One unsettled spatial call between its `tool/call` and `tool/result`. */
export interface PendingFrameCall {
  readonly callId: string
  /** Seq of the accepted `tool/call`. */
  readonly callSeq: number
  readonly name: FrameSpatialToolName
}

/**
 * The plain-JSON persisted state of the `decisionFrame` projection
 * (cache-writeable by contract): the authoritative DecisionFrame plus the
 * fold bookkeeping (pending calls, budget ledger).
 */
export interface SpatialContextState extends DecisionFrame {
  /** Self-describing persisted-state generation; the unit's `stateVersion` equals it. */
  readonly stateVersion: typeof DECISION_FRAME_STATE_VERSION
  readonly pendingCalls: readonly PendingFrameCall[]
  readonly budget: BudgetLedger
}

/** The initial plain-JSON state for a fresh session. */
export function initialSpatialContextState(): SpatialContextState {
  return {
    stateVersion: DECISION_FRAME_STATE_VERSION,
    goal: null,
    plan: null,
    evidence: [],
    resources: [],
    injections: [],
    diagnostics: [],
    seenTools: [],
    pendingCalls: [],
    budget: initialBudgetLedger(),
  }
}

/** Persisted projection state schema: validates cache rows and restore seeds. */
export const spatialContextStateSchema = z.object({
  stateVersion: z.literal(DECISION_FRAME_STATE_VERSION),
  goal: z.object({
    questionId: z.string().min(1),
    goalRevision: z.number().int().positive(),
    question: z.string().max(MAX_GOAL_QUESTION_CHARS),
    sourceSeq: z.number().int().nonnegative(),
    sourceKind: z.literal('user-message'),
    acceptedAt: z.number().int().nonnegative(),
  }).strict().nullable(),
  plan: z.object({
    planRevision: z.number().int().positive(),
    goalRevision: z.number().int().nonnegative(),
    questionId: z.string().min(1),
    interpretation: z.string().optional(),
    methods: z.array(z.object({
      name: z.string().min(1),
      rationale: z.string().optional(),
    }).strict()),
    steps: z.array(z.string()),
    gaps: z.array(z.object({
      id: z.string().min(1),
      description: z.string(),
      status: z.enum(['open', 'blocked', 'resolved']),
    }).strict()),
    sourceSeq: z.number().int().nonnegative(),
  }).strict().nullable(),
  evidence: z.array(z.object({
    evidenceId: z.string().min(1),
    seq: z.number().int().nonnegative(),
    kind: z.enum(['analysis-result', 'catalog-result', 'map-save-receipt', 'failed-tool', 'decision-change']),
    tool: z.string().min(1),
    status: z.enum(['succeeded', 'partial', 'unknown', 'not_applicable', 'failed']),
    ref: z.string().optional(),
    contentDigest: z.string().optional(),
    scanFeatures: z.number().int().nonnegative().optional(),
    limitations: z.array(z.string()),
  }).strict()),
  resources: z.array(z.object({
    ref: z.string().min(1),
    contentDigest: z.string().min(1),
    schemaDigest: z.string().min(1),
    nativeCrs: z.string(),
    featureCount: z.number().int().nonnegative(),
    authorization: z.string(),
    presentedAt: z.number().int().nonnegative(),
  }).strict()),
  injections: z.array(z.object({
    seq: z.number().int().nonnegative(),
    digest: z.string().min(1),
    form: z.enum(['baseline', 'increment']),
    bytes: z.number().int().nonnegative(),
  }).strict()),
  diagnostics: z.array(z.object({
    seq: z.number().int().nonnegative(),
    code: z.enum([
      'failed-result',
      'unknown-schema-version',
      'unknown-kind',
      'invalid-meta',
      'oversized-meta',
      'call-pairing',
      'goal-revision-stale',
      'plan-revision-conflict',
      'unknown-evidence-ref',
      'pending-overflow',
    ]),
  }).strict()),
  seenTools: z.array(z.string().min(1)),
  pendingCalls: z.array(z.object({
    callId: z.string().min(1),
    callSeq: z.number().int().nonnegative(),
    name: z.enum(FRAME_SPATIAL_TOOL_NAMES),
  }).strict()),
  budget: z.object({
    stepsUsed: z.number().int().nonnegative(),
    metaBytes: z.number().int().nonnegative(),
    contextBytes: z.number().int().nonnegative(),
    scanFeatures: z.number().int().nonnegative(),
    gapRetries: z.record(z.string(), z.number().int().nonnegative()),
  }).strict(),
}).strict() as unknown as z.ZodType<SpatialContextState>

/** Append one diagnostic, dropping the oldest beyond the bound. */
function withDiagnostic(state: SpatialContextState, seq: number, code: FrameDiagnosticCode): SpatialContextState {
  const diagnostics = [...state.diagnostics, { seq, code }]
  return { ...state, diagnostics: bounded(diagnostics, MAX_FRAME_DIAGNOSTICS) }
}

/** Drop the oldest beyond the bound on bounded lists (pure helper). */
function withEntry<T>(entries: readonly T[], entry: T, max: number): readonly T[] {
  return bounded([...entries, entry], max)
}

/** Extract the bounded text of one user message from its text blocks. */
function textOfContent(content: readonly { readonly type: string; readonly text?: string }[]): string {
  const text = content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
  return text.length > MAX_GOAL_QUESTION_CHARS ? text.slice(0, MAX_GOAL_QUESTION_CHARS) : text
}

/** Extract the first tool-result block of one `tool/result` event. */
function toolResultBlockOf(event: { readonly data: { readonly message: { readonly toolCallId?: string; readonly isError?: boolean; readonly content: readonly unknown[] } } }):
  | { readonly toolCallId: string; readonly isError: boolean }
  | undefined {
  if (typeof event.data.message.toolCallId === 'string') {
    return { toolCallId: event.data.message.toolCallId, isError: event.data.message.isError === true }
  }
  for (const candidate of event.data.message.content) {
    if (typeof candidate === 'object' && candidate !== null && 'type' in candidate
      && (candidate as { type: unknown }).type === 'tool-result'
      && 'toolCallId' in candidate && typeof (candidate as { toolCallId: unknown }).toolCallId === 'string') {
      const block = candidate as { toolCallId: string; isError?: boolean }
      return { toolCallId: block.toolCallId, isError: block.isError === true }
    }
  }
  return undefined
}

/** Fold one accepted real user message into a new GoalContract (pure). */
function foldGoal(state: SpatialContextState, event: {
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly source: { readonly kind: string }
    readonly content: readonly { readonly type: string; readonly text?: string }[]
  }
}): SpatialContextState {
  if (!isUserAuthoritySource(event.data.source)) return state
  const question = textOfContent(event.data.content)
  if (question.trim().length === 0) return state
  const goal: GoalContract = {
    questionId: questionIdOf(event.seq),
    goalRevision: (state.goal?.goalRevision ?? 0) + 1,
    question,
    sourceSeq: event.seq,
    sourceKind: 'user-message',
    acceptedAt: event.time,
  }
  return { ...state, goal }
}

/** Parsed header of one injected snapshot message. */
export interface SnapshotHeader {
  readonly kind: 'baseline' | 'increment'
  /** Goal revision the snapshot was composed against. */
  readonly goal: number
  /** Content digest of the snapshot body. */
  readonly digest: string
}

/**
 * Parse the versioned header line of one injected snapshot text. Returns
 * `undefined` for anything the current writer did not produce.
 * @param text - the full injected snapshot text.
 */
export function parseSnapshotHeader(text: string): SnapshotHeader | undefined {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'))
  const match = /^spatial-context\/snapshot v1 kind=(baseline|increment) goal=(\d+) digest=([0-9a-f]{16})$/.exec(firstLine)
  if (match === null) return undefined
  const kind = match[1]
  const goal = match[2]
  const digest = match[3]
  if (kind === undefined || goal === undefined || digest === undefined) return undefined
  return { kind: kind as 'baseline' | 'increment', goal: Number(goal), digest }
}

/** Fold one accepted snapshot injection (confirmed only by actual entry). */
function foldInjection(state: SpatialContextState, event: {
  readonly seq: number
  readonly data: {
    readonly source: { readonly kind: string; readonly plugin?: string }
    readonly content: readonly { readonly type: string; readonly text?: string }[]
  }
}): SpatialContextState {
  const source = event.data.source
  if (!((source.kind === 'spatial-context' || source.kind === 'plugin') && source.plugin === SPATIAL_CONTEXT_PLUGIN_NAME)) return state
  const text = textOfContent(event.data.content)
  const header = parseSnapshotHeader(text)
  if (header === undefined) return state
  const bytes = Buffer.byteLength(text, 'utf8')
  const record: InjectionRecord = { seq: event.seq, digest: header.digest, form: header.kind, bytes }
  const injections = withEntry(state.injections, record, MAX_INJECTION_RECORDS)
  return { ...state, injections, budget: foldContextBytes(state.budget, bytes) }
}

/** Track one accepted spatial tool call (pending until its result settles). */
function foldToolCall(state: SpatialContextState, event: {
  readonly seq: number
  readonly data: { readonly callId: string; readonly name: string }
}): SpatialContextState {
  if (!(FRAME_SPATIAL_TOOL_NAMES as readonly string[]).includes(event.data.name)) return state
  const seenTools = state.seenTools.includes(event.data.name)
    ? state.seenTools
    : bounded([...state.seenTools, event.data.name], MAX_SEEN_TOOLS)
  const entry: PendingFrameCall = {
    callId: event.data.callId,
    callSeq: event.seq,
    name: event.data.name as FrameSpatialToolName,
  }
  const next: SpatialContextState = { ...state, seenTools }
  if (state.pendingCalls.length + 1 > MAX_PENDING_FRAME_CALLS) {
    // Damaged or adversarial logs must not grow pending calls without bound:
    // evict the oldest into a bounded diagnostic; its later result settles
    // as unpaired and changes nothing.
    return withDiagnostic({ ...next, pendingCalls: [...state.pendingCalls.slice(1), entry] }, event.seq, 'pending-overflow')
  }
  return { ...next, pendingCalls: [...state.pendingCalls, entry] }
}

/** Bounded limitation lines folded from a record's own list or an error text. */
function boundedLimitations(lines: readonly string[]): readonly string[] {
  return bounded(
    lines.filter(line => line.trim().length > 0).map(line => line.length > MAX_LIMITATION_CHARS ? line.slice(0, MAX_LIMITATION_CHARS) : line),
    MAX_LIMITATION_LINES,
  )
}

/** The plan candidate a decoded decision-change record carries, as the fold applies it. */
function planOfUpdate(
  goal: GoalContract,
  planRevision: number,
  sourceSeq: number,
  update: {
    readonly interpretation?: string
    readonly methods?: readonly { readonly name: string; readonly rationale?: string }[]
    readonly steps?: readonly string[]
    readonly gaps?: readonly PlanGap[]
  },
): PlanState {
  return {
    planRevision,
    goalRevision: goal.goalRevision,
    questionId: goal.questionId,
    ...(update.interpretation === undefined ? {} : { interpretation: update.interpretation }),
    methods: update.methods ?? [],
    steps: update.steps ?? [],
    gaps: update.gaps ?? [],
    sourceSeq,
  }
}

/** Inputs to settling one paired spatial `tool/result` (mirrors the map protocol). */
export interface SettleFrameResultInput {
  /** Seq of the `tool/result` event being folded. */
  readonly resultSeq: number
  /** The pending entry the result settles (already removed by the caller). */
  readonly pending: PendingFrameCall
  /** Whether the result block is an error result. */
  readonly isError: boolean
  /** The durable `tool/result.meta` value, when the event carried one. */
  readonly meta: unknown
  /** The call seq the event itself cites (`sourceEventSeqs[0]`), when present. */
  readonly citedCallSeq: number | undefined
}

/**
 * Settle one paired spatial result (pure): fold evidence, plan, resources,
 * budget consumption, and diagnostics per the record kind. Error results
 * fold a bounded `failed-tool` entry and never apply a domain record;
 * decode refusals and conflict checks record a bounded read-only diagnostic
 * and keep prior state.
 * @param state - the state with the pending entry already removed.
 * @param input - the settled result's identity, error flag, meta, citation.
 * @returns the next state.
 */
export function settleFrameResult(state: SpatialContextState, input: SettleFrameResultInput): SpatialContextState {
  const { resultSeq, pending, isError, meta, citedCallSeq } = input
  if (isError) {
    const entry: EvidenceEntry = {
      evidenceId: evidenceIdOf(resultSeq),
      seq: resultSeq,
      kind: 'failed-tool',
      tool: pending.name,
      status: 'failed',
      limitations: [typeof meta === 'object' && meta !== null ? 'failed tool result; any carried meta is not applicable' : 'failed tool result'],
    }
    return { ...state, evidence: withEntry(state.evidence, entry, MAX_EVIDENCE_ENTRIES) }
  }
  if (meta === undefined) return state
  const metaBytes = JSON.stringify(meta).length
  if (pending.name === 'decision_update') {
    return settleDecisionChange(state, resultSeq, pending, meta, citedCallSeq, metaBytes)
  }
  if (pending.name.startsWith('geo_')) {
    return settleAnalysis(state, resultSeq, pending, meta, metaBytes)
  }
  if (pending.name.startsWith('catalog_')) {
    return settleCatalog(state, resultSeq, pending, meta, metaBytes)
  }
  if (pending.name === 'map_save') {
    return settleSave(state, resultSeq, pending, meta, metaBytes)
  }
  // Map mutations fold their meta bytes into the budget (display copies are
  // the largest metas) but leave evidence to the mapContainer projection.
  return { ...state, budget: foldConsumption(state.budget, metaBytes, 0) }
}

/** Fold one decision-change record: conflict checks first, then the plan write. */
function settleDecisionChange(
  state: SpatialContextState,
  resultSeq: number,
  pending: PendingFrameCall,
  meta: unknown,
  citedCallSeq: number | undefined,
  metaBytes: number,
): SpatialContextState {
  const decoded = decodeDecisionChangeMeta(meta)
  if (decoded.status !== 'ok') {
    return withDiagnostic(state, resultSeq, diagnosticCodeOf(decoded.code))
  }
  const record = decoded.meta
  if (record.sourceCallSeq !== pending.callSeq
    || (citedCallSeq !== undefined && citedCallSeq !== pending.callSeq)) {
    return withDiagnostic(state, resultSeq, 'call-pairing')
  }
  const refusal = checkPlanUpdate(state, {
    goalRevision: record.goalRevision,
    expectedPlanRevision: record.expectedPlanRevision,
    evidenceRefs: record.evidenceRefs,
  })
  if (refusal !== undefined) {
    return withDiagnostic(state, resultSeq, refusal)
  }
  const goal = state.goal as GoalContract
  const nextPlanRevision = (state.plan?.planRevision ?? 0) + 1
  let next: SpatialContextState = {
    ...state,
    plan: planOfUpdate(goal, nextPlanRevision, resultSeq, record.update),
  }
  for (const gap of record.update.gaps ?? []) {
    next = { ...next, budget: foldGapRetry(next.budget, gap.id, gap.status) }
  }
  return { ...next, budget: foldConsumption(next.budget, metaBytes, 0) }
}

/** Fold one analysis-result record into evidence and scan accounting. */
function settleAnalysis(
  state: SpatialContextState,
  resultSeq: number,
  pending: PendingFrameCall,
  meta: unknown,
  metaBytes: number,
): SpatialContextState {
  const read = readAnalysisResult(meta)
  if (read === undefined) {
    return withDiagnostic(state, resultSeq, 'invalid-meta')
  }
  const firstRefInput = read.inputs.find((input): input is Extract<typeof input, { resourceRef: string }> => 'resourceRef' in input)
  const entry: EvidenceEntry = {
    evidenceId: evidenceIdOf(resultSeq),
    seq: resultSeq,
    kind: 'analysis-result',
    tool: pending.name,
    status: 'succeeded',
    ...(firstRefInput !== undefined ? { ref: firstRefInput.resourceRef } : {}),
    scanFeatures: read.inputs.length,
    limitations: boundedLimitations(read.limitations),
  }
  const next: SpatialContextState = { ...state, evidence: withEntry(state.evidence, entry, MAX_EVIDENCE_ENTRIES) }
  return { ...next, budget: foldConsumption(next.budget, metaBytes, read.inputs.length) }
}

/** Fold one catalog-result record into resource candidates and evidence. */
function settleCatalog(
  state: SpatialContextState,
  resultSeq: number,
  pending: PendingFrameCall,
  meta: unknown,
  metaBytes: number,
): SpatialContextState {
  const read = readCatalogResult(meta)
  if (read === undefined) {
    return withDiagnostic(state, resultSeq, 'invalid-meta')
  }
  let resources = state.resources
  for (const resource of read.resources) {
    const candidate: ResourceCandidate = { ...resource, presentedAt: resultSeq }
    resources = [...resources.filter(existing => existing.ref !== candidate.ref), candidate]
  }
  resources = bounded(resources, MAX_RESOURCE_CANDIDATES)
  const first = read.resources[0]
  const entry: EvidenceEntry = {
    evidenceId: evidenceIdOf(resultSeq),
    seq: resultSeq,
    kind: 'catalog-result',
    tool: pending.name,
    status: 'succeeded',
    ...(first !== undefined ? { ref: first.ref, contentDigest: first.contentDigest } : {}),
    limitations: [],
  }
  const settled: SpatialContextState = { ...state, resources, evidence: withEntry(state.evidence, entry, MAX_EVIDENCE_ENTRIES) }
  return { ...settled, budget: foldConsumption(settled.budget, metaBytes, 0) }
}

/** Fold one map-save receipt into evidence. */
function settleSave(
  state: SpatialContextState,
  resultSeq: number,
  pending: PendingFrameCall,
  meta: unknown,
  metaBytes: number,
): SpatialContextState {
  const read = readSaveReceipt(meta)
  if (read === undefined) {
    return withDiagnostic(state, resultSeq, 'invalid-meta')
  }
  const entry: EvidenceEntry = {
    evidenceId: evidenceIdOf(resultSeq),
    seq: resultSeq,
    kind: 'map-save-receipt',
    tool: pending.name,
    status: read.saved ? 'succeeded' : 'failed',
    limitations: [
      read.saved
        ? `durable through seq ${read.durableThroughSeq}, map revision ${read.revision}`
        : `save not completed; accepted state preserved at revision ${read.revision}`,
    ],
  }
  const settled: SpatialContextState = { ...state, evidence: withEntry(state.evidence, entry, MAX_EVIDENCE_ENTRIES) }
  return { ...settled, budget: foldConsumption(settled.budget, metaBytes, 0) }
}

/** Map a record decode refusal code onto the fold diagnostic vocabulary. */
function diagnosticCodeOf(code: 'unknown-schema-version' | 'unknown-kind' | 'invalid-meta' | 'oversized-meta'): FrameDiagnosticCode {
  return code
}

/** The pure `decisionFrame` fold over one accepted session event. */
export function foldSpatialContextEvent(state: SpatialContextState, event: {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: object
  readonly sourceEventSeqs?: readonly number[]
}): SpatialContextState {
  if (event.type === 'user/message') {
    const data = event.data as {
      source: { kind: string; plugin?: string }
      content: readonly { type: string; text?: string }[]
    }
    const afterGoal = foldGoal(state, { seq: event.seq, time: event.time, data })
    return foldInjection(afterGoal, { seq: event.seq, data })
  }
  if (event.type === 'step/end') {
    return { ...state, budget: foldStep(state.budget) }
  }
  if (event.type === 'tool/call') {
    const data = event.data as { callId: string; name: string }
    return foldToolCall(state, { seq: event.seq, data })
  }
  if (event.type === 'tool/result') {
    const data = event.data as {
      message: { content: readonly unknown[] }
      meta?: unknown
    }
    const block = toolResultBlockOf({ data })
    if (block === undefined) return state
    const index = state.pendingCalls.findIndex(pending => pending.callId === block.toolCallId)
    if (index === -1) return state
    const pending = state.pendingCalls[index] as PendingFrameCall
    const withoutPending = { ...state, pendingCalls: state.pendingCalls.filter((_, at) => at !== index) }
    return settleFrameResult(withoutPending, {
      resultSeq: event.seq,
      pending,
      isError: block.isError,
      meta: data.meta,
      citedCallSeq: event.sourceEventSeqs?.[0],
    })
  }
  return state
}

/**
 * The provisional frame a pre-step composes from: the accepted state plus
 * the currently claimed real user messages folded as goal candidates. The
 * claimed messages have not entered the log yet — they carry no seq — so the
 * provisional goal cites a pending identity, and the persistent GoalContract
 * still changes only when the loop actually appends the message and the
 * projection folds it (design §5.2: compose from this turn's accepted input
 * without pre-committing the target).
 * @param state - the authoritative accepted state.
 * @param claimed - the messages the pre-step claimed, in claim order.
 * @param nowMs - wall time for the provisional goal's acceptance stamp.
 * @returns a state view for composition only; never persisted.
 */
export function provisionalFrameOf(
  state: SpatialContextState,
  claimed: readonly {
    readonly source: { readonly kind: string }
    readonly content: readonly { readonly type: string; readonly text?: string }[]
  }[],
  nowMs: number,
): SpatialContextState {
  let next = state
  let pending = 0
  for (const message of claimed) {
    if (!isUserAuthoritySource(message.source)) continue
    const question = textOfContent(message.content)
    if (question.trim().length === 0) continue
    pending += 1
    const goal: GoalContract = {
      questionId: 'q-pending',
      goalRevision: (next.goal?.goalRevision ?? 0) + 1,
      question,
      sourceSeq: PENDING_GOAL_SOURCE_SEQ,
      sourceKind: 'user-message',
      acceptedAt: nowMs,
    }
    next = { ...next, goal }
  }
  return next
}

/** The sentinel source seq of a goal composed from a claimed-but-unadmitted message. */
export const PENDING_GOAL_SOURCE_SEQ = -1
