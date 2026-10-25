/**
 * The P0c `decision_update` tool: the model's only write path into the
 * PlanState. It validates the candidate against the authoritative frame —
 * the cited goal revision, the expected plan revision, and the cited
 * evidence seqs — and checks the budget preflight BEFORE the record is
 * composed, so an exhausted task refuses loudly instead of spending further.
 * The update only commits when the Session accepts the successful result
 * carrying its versioned `decision-change` meta; the projection folds it
 * with the same checks, so a stale or replayed record never applies.
 *
 * @module @map-harness/map-tools/decision-tools
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  checkBudget,
  checkGapRetry,
  checkPlanUpdate,
  MAX_PLAN_LIST_ENTRIES,
  type BudgetConfig,
  type PlanUpdateRefusal,
  type SpatialContextService,
} from '@map-harness/spatial-context'
import { buildDecisionChangeMeta, type DecisionPlanUpdate } from '@map-harness/spatial-context'
import { renderJson } from './output.ts'
import { sessionOf } from './catalog-tools.ts'
import { decodeJsonParam } from './json-param.ts'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'

/** The tool session a decision tool requires (inferred; no extra package dep). */
type ToolSession = NonNullable<ToolRunContext['agent']>['session']

/** Resolve the spatial-context service from the executing agent's context. */
export function spatialContextOf(exec: ToolRunContext): SpatialContextService {
  const service = serviceOf<SpatialContextService>(exec, 'spatialContext')
  if (service === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'spatial context service is unavailable in this process')
  }
  return service
}

/** Map a plan-update refusal onto its stable model-facing error code. */
function refusalError(refusal: PlanUpdateRefusal, detail: string): SpatialError {
  switch (refusal) {
    case 'goal-revision-stale':
      return new SpatialError('GOAL_REVISION_STALE', detail)
    case 'plan-revision-conflict':
      return new SpatialError('PLAN_REVISION_CONFLICT', detail)
    case 'unknown-evidence-ref':
      return new SpatialError('UNKNOWN_EVIDENCE_REF', detail)
    /* v8 ignore next -- the refusal union is closed; this keeps the function total */
    default:
      return new SpatialError('INVALID_ARGUMENT', detail)
  }
}

/**
 * `decision_update`: submit one bounded plan update (tentative
 * interpretation, method candidates, steps, gaps) against the current goal.
 * Only the PlanState changes — never the user's acceptance criteria and
 * never the EvidenceLedger.
 */
export const decisionUpdate = defineTool({
  name: 'decision_update',
  description:
    'Submit one plan update for the current analysis goal: your tentative interpretation (stays tentative), '
    + 'candidate methods, steps, and data gaps. Cite the goal revision and plan revision you are editing against '
    + '(`map_get_state`-equivalent context arrives in the injected spatial snapshot). The update writes only the '
    + 'plan state — it can never change the user\'s goal, acceptance criteria, or recorded evidence. Conflicts '
    + '(stale goal/plan revision) are refused; re-read the current snapshot before retrying.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Current goal revision the plan is written against (from the injected snapshot header/目标 line).' },
    expected_plan_revision: { type: 'number', required: true, description: 'Plan revision you are editing against (0 when no plan exists yet).' },
    interpretation: { type: 'string', description: 'Tentative interpretation of the goal; never promoted to user authority.' },
    methods: { type: 'json', description: `Array of { name, rationale? } candidates (≤ ${MAX_PLAN_LIST_ENTRIES}).` },
    steps: { type: 'json', description: `Array of planned step strings (≤ ${MAX_PLAN_LIST_ENTRIES}).` },
    gaps: { type: 'json', description: `Array of { id, description, status: open|blocked|resolved } (≤ ${MAX_PLAN_LIST_ENTRIES}); repeated re-open of one id beyond the remediation limit is refused.` },
    evidence_refs: { type: 'json', description: 'Array of evidence seqs this plan cites; every ref must already be settled in the ledger.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderJson(value),
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const {
      goal_revision: goalRevision,
      expected_plan_revision: expectedPlanRevision,
      interpretation,
      methods,
      steps,
      gaps,
      evidence_refs: evidenceRefs,
    } = args as {
      goal_revision?: number
      expected_plan_revision?: number
      interpretation?: string
      methods?: unknown
      steps?: unknown
      gaps?: unknown
      evidence_refs?: unknown
    }
    if (typeof goalRevision !== 'number' || !Number.isInteger(goalRevision) || goalRevision < 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'goal_revision must be a non-negative integer')
    }
    if (typeof expectedPlanRevision !== 'number' || !Number.isInteger(expectedPlanRevision) || expectedPlanRevision < 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'expected_plan_revision must be a non-negative integer')
    }
    const update = parsePlanUpdate({
      ...(interpretation === undefined ? {} : { interpretation }),
      methods: decodeJsonParam(methods, 'methods'),
      steps: decodeJsonParam(steps, 'steps'),
      gaps: decodeJsonParam(gaps, 'gaps'),
    })
    const evidenceRefsParsed = parseNumberArray(decodeJsonParam(evidenceRefs, 'evidence_refs'), 'evidence_refs')

    const session = sessionOf(exec) as ToolSession
    const spatialContext = spatialContextOf(exec)
    const frame = spatialContext.frameOf(session)
    if (frame === undefined) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'decisionFrame projection is not registered in this process')
    }

    // Authority and budget preflight BEFORE composing the record: a stale or
    // over-budget task refuses instead of spending further.
    const refusal = checkPlanUpdate(frame, {
      goalRevision,
      expectedPlanRevision,
      evidenceRefs: evidenceRefsParsed,
    })
    if (refusal !== undefined) {
      throw refusalError(refusal, planRefusalDetail(refusal, frame, goalRevision, expectedPlanRevision))
    }
    const budgetRefusal = budgetRefusalOf(frame, spatialContext.budget, update, evidenceRefsParsed.length)
    if (budgetRefusal !== undefined) {
      throw new SpatialError(
        'BUDGET_EXHAUSTED',
        `task budget exhausted (${budgetRefusal.code}: ${budgetRefusal.used}/${budgetRefusal.limit}); plan updates cannot reset the budget`,
      )
    }
    for (const gap of update.gaps ?? []) {
      const gapRefusal = checkGapRetry(frame.budget, spatialContext.budget, gap.id)
      if (gapRefusal !== undefined) {
        throw new SpatialError(
          'BUDGET_EXHAUSTED',
          `gap "${gap.id}" exceeded the remediation limit (${gapRefusal.used}/${gapRefusal.limit} re-opens); change method or report blocked`,
        )
      }
    }

    // Pair with this call's accepted tool/call — the trusted seq the record cites.
    const pending = frame.pendingCalls.find(entry => entry.name === 'decision_update' && entry.callId === exec.callId)
    if (pending === undefined) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'decision_update requires its accepted tool/call in the session log before execution')
    }
    const meta = buildDecisionChangeMeta({
      sourceCallSeq: pending.callSeq,
      goalRevision,
      expectedPlanRevision,
      evidenceRefs: evidenceRefsParsed,
      update,
    })
    const nextPlanRevision = (frame.plan?.planRevision ?? 0) + 1
    return {
      status: 'succeeded',
      applied_plan_revision: nextPlanRevision,
      plan_writes: 'plan state only; goal, acceptance criteria, and evidence ledger unchanged',
      ...(update.interpretation === undefined ? {} : { tentative: true }),
      meta,
    } as unknown as JsonValue
  },
})

/** Build the model-facing detail for one plan-update refusal. */
function planRefusalDetail(refusal: PlanUpdateRefusal, frame: ReturnType<SpatialContextService['frameOf']> & object, goalRevision: number, expectedPlanRevision: number): string {
  switch (refusal) {
    case 'goal-revision-stale':
      return `cited goal_revision ${goalRevision} is not the current revision ${frame.goal?.goalRevision ?? 'none'}; an old run never overwrites a new goal — re-read the latest snapshot`
    case 'plan-revision-conflict':
      return `expected_plan_revision ${expectedPlanRevision} does not match current plan revision ${frame.plan?.planRevision ?? 0}; re-read the latest snapshot`
    case 'unknown-evidence-ref':
      return `cited evidence ref not found in the settled ledger`
  }
}

/** The budget preflight for one plan update (meta bytes + hard counters). */
function budgetRefusalOf(
  frame: NonNullable<ReturnType<SpatialContextService['frameOf']>>,
  budget: BudgetConfig,
  update: DecisionPlanUpdate,
  evidenceRefCount: number,
) {
  const candidateBytes = JSON.stringify({
    schemaVersion: 1,
    kind: 'decision-change',
    sourceCallSeq: 0,
    goalRevision: 0,
    expectedPlanRevision: 0,
    evidenceRefs: new Array(evidenceRefCount).fill(0),
    update,
  }).length
  return checkBudget(frame.budget, budget, Date.now(), frame.goal?.acceptedAt, { metaBytes: candidateBytes })
}

/** Parse and bound one plan-update payload from the model arguments. */
function parsePlanUpdate(args: {
  interpretation?: string | undefined
  methods?: unknown
  steps?: unknown
  gaps?: unknown
}): DecisionPlanUpdate {
  if (args.interpretation !== undefined && (typeof args.interpretation !== 'string' || args.interpretation.length === 0)) {
    throw new SpatialError('INVALID_ARGUMENT', 'interpretation must be a non-empty string when given')
  }
  const methods = parseMethodArray(args.methods)
  const steps = parseStringArray(args.steps, 'steps')
  const gaps = parseGapArray(args.gaps)
  return {
    ...(args.interpretation === undefined ? {} : { interpretation: args.interpretation }),
    ...(methods === undefined || methods.length === 0 ? {} : { methods }),
    ...(steps.length === 0 ? {} : { steps }),
    ...(gaps === undefined || gaps.length === 0 ? {} : { gaps }),
  }
}

/** Parse the bounded method-candidate array. */
function parseMethodArray(value: unknown): DecisionPlanUpdate['methods'] {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new SpatialError('INVALID_ARGUMENT', 'methods must be an array')
  if (value.length > MAX_PLAN_LIST_ENTRIES) {
    throw new SpatialError('INVALID_ARGUMENT', `methods accepts at most ${MAX_PLAN_LIST_ENTRIES} entries`)
  }
  const methods = value.map((entry: unknown) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new SpatialError('INVALID_ARGUMENT', 'each method must be an object with a name')
    }
    const { name, rationale } = entry as { name?: unknown; rationale?: unknown }
    if (typeof name !== 'string' || name.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'each method needs a non-empty name')
    }
    if (rationale !== undefined && typeof rationale !== 'string') {
      throw new SpatialError('INVALID_ARGUMENT', 'method rationale must be a string when given')
    }
    return { name, ...(rationale === undefined ? {} : { rationale }) }
  })
  return methods.length === 0 ? undefined : methods
}

/** Parse the bounded step array. */
function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new SpatialError('INVALID_ARGUMENT', `${field} must be an array`)
  if (value.length > MAX_PLAN_LIST_ENTRIES) {
    throw new SpatialError('INVALID_ARGUMENT', `${field} accepts at most ${MAX_PLAN_LIST_ENTRIES} entries`)
  }
  return value.map((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', `each ${field} entry must be a non-empty string`)
    }
    return entry
  })
}

/** Parse the bounded gap array. */
function parseGapArray(value: unknown): DecisionPlanUpdate['gaps'] {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new SpatialError('INVALID_ARGUMENT', 'gaps must be an array')
  if (value.length > MAX_PLAN_LIST_ENTRIES) {
    throw new SpatialError('INVALID_ARGUMENT', `gaps accepts at most ${MAX_PLAN_LIST_ENTRIES} entries`)
  }
  const gaps = value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new SpatialError('INVALID_ARGUMENT', 'each gap must be an object { id, description, status }')
    }
    const { id, description, status } = entry as { id?: unknown; description?: unknown; status?: unknown }
    if (typeof id !== 'string' || id.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'each gap needs a non-empty id')
    }
    if (typeof description !== 'string' || description.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'each gap needs a non-empty description')
    }
    if (status !== 'open' && status !== 'blocked' && status !== 'resolved') {
      throw new SpatialError('INVALID_ARGUMENT', 'gap status must be open, blocked, or resolved')
    }
    return { id, description, status } as { id: string; description: string; status: 'open' | 'blocked' | 'resolved' }
  })
  return gaps.length === 0 ? undefined : gaps
}

/** Parse a bounded number array (evidence refs). */
function parseNumberArray(value: unknown, field: string): number[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new SpatialError('INVALID_ARGUMENT', `${field} must be an array`)
  if (value.length > MAX_PLAN_LIST_ENTRIES) {
    throw new SpatialError('INVALID_ARGUMENT', `${field} accepts at most ${MAX_PLAN_LIST_ENTRIES} entries`)
  }
  return value.map((entry) => {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) {
      throw new SpatialError('INVALID_ARGUMENT', `each ${field} entry must be a non-negative integer seq`)
    }
    return entry
  })
}
