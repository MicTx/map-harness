/**
 * The budget plane: hard cumulative limits checked BEFORE a final operation
 * commits, with named refusals that leave the previous state untouched.
 *
 * The model has two halves the design's cost section keeps apart:
 *
 * - **Hard budgets** ({@link PerfHardBudgets}): bytes (cumulative session,
 *   meta, projection, display), scan rows, wall time, concurrency slots, and
 *   steps. Every one is enforced by {@link PerfBudgetLedger}: a spend that
 *   fits on its own still refuses when the accumulated total would cross the
 *   limit — the single-legal-but-cumulative-over case is the one this plane
 *   exists for.
 * - **Estimated costs** ({@link PerfEstimatedCost}): provider-side money and
 *   quota guesses. They are recorded on reports and never accepted by any
 *   admission function, so an estimate can never refuse what a hard budget
 *   admits.
 *
 * Refusal semantics: {@link PerfBudgetLedger.admissionFor} is a pure
 * projection of current state plus one proposal; {@link PerfBudgetLedger.apply}
 * commits a spend only after the caller decided. A refused proposal mutates
 * nothing — the caller keeps the previous state, appends nothing, publishes
 * nothing.
 *
 * @module @map-harness/spatial-perf/budgets
 */
import type { PerfEstimatedCost, PerfHardBudgets } from './contract.ts'

/** The stable refusal codes a budget check carries. */
export type PerfBudgetCode =
  | 'session-bytes'
  | 'meta-bytes'
  | 'projection-bytes'
  | 'display-bytes'
  | 'scan-rows'
  | 'time-budget'
  | 'concurrency'
  | 'steps'

/** One spend proposal (or accumulated spend) against the hard budgets. */
export interface PerfSpend {
  /** Serialized bytes this operation appends to the session log. */
  readonly sessionBytes?: number
  /** Serialized bytes of the `meta.spatial` records this operation appends. */
  readonly metaBytes?: number
  /** Serialized bytes this operation adds to the projection state. */
  readonly projectionDeltaBytes?: number
  /** Serialized bytes of the display copies this operation derives. */
  readonly displayBytes?: number
  /** Rows this operation scans. */
  readonly scanRows?: number
  /** Wall-clock milliseconds this operation has already spent (checked pre-commit). */
  readonly timeMs?: number
  /** Steps this operation consumes. */
  readonly steps?: number
}

/** The pure admission decision for one proposal. */
export type PerfAdmission =
  | { readonly status: 'admitted'; readonly projected: PerfSpend }
  | {
    readonly status: 'refused'
    readonly code: PerfBudgetCode
    /** The budget field that refused. */
    readonly field: keyof PerfHardBudgets
    readonly limit: number
    /** The total the proposal would have produced. */
    readonly projected: number
  }

/** The refusal error a committed-through helper carries (admission first keeps this off the happy path). */
export class PerfBudgetRefusal extends Error {
  /** The stable refusal code. */
  readonly code: PerfBudgetCode
  /** The budget field that refused. */
  readonly field: keyof PerfHardBudgets
  readonly limit: number
  /** The total the refused proposal would have produced. */
  readonly projected: number

  constructor(admission: Extract<PerfAdmission, { status: 'refused' }>) {
    super(
      `perf budget refused before commit: ${admission.field} would reach ${admission.projected} against the ${admission.limit} limit (${admission.code}); the previous state stands`,
    )
    this.name = 'PerfBudgetRefusal'
    this.code = admission.code
    this.field = admission.field
    this.limit = admission.limit
    this.projected = admission.projected
  }
}

/**
 * The cumulative budget ledger. One measured session (or one benchmark run)
 * owns one ledger; the concurrency half is slot-shaped because it bounds
 * simultaneous work rather than accumulated volume.
 */
export class PerfBudgetLedger {
  private readonly budgets: PerfHardBudgets
  private spent: Required<Mutable<PerfSpend>> = zeroSpend()
  private slotsInUse = 0

  /**
   * @param budgets - the hard budgets this ledger enforces (deployment-owned, explicit).
   * @throws when the budgets fail their own structural validation contract.
   */
  constructor(budgets: PerfHardBudgets) {
    const issues = validateBudgetShape(budgets)
    if (issues.length > 0) {
      throw new Error(`perf budgets invalid: ${issues.join('; ')}`)
    }
    this.budgets = budgets
  }

  /** The budgets this ledger enforces. */
  get limits(): PerfHardBudgets {
    return this.budgets
  }

  /** The accumulated spend so far (read-only copy). */
  get accumulated(): Required<PerfSpend> {
    return { ...this.spent }
  }

  /** Slots currently held. */
  get activeSlots(): number {
    return this.slotsInUse
  }

  /**
   * The pure admission decision for one proposal against the accumulated
   * spend. The byte planes (session/meta/projection/display) and steps are
   * CUMULATIVE: a spend that fits on its own still refuses when the
   * accumulated total would cross. Scan rows and wall time are
   * PER-FINAL-OPERATION: the proposal's own value compares against the limit.
   * The first crossing names its plane and nothing mutates.
   * @param proposal - the spend one final operation wants to commit.
   * @returns admitted with the projected totals, or refused with the plane.
   */
  admissionFor(proposal: PerfSpend): PerfAdmission {
    const projected = {
      sessionBytes: this.spent.sessionBytes + (proposal.sessionBytes ?? 0),
      metaBytes: this.spent.metaBytes + (proposal.metaBytes ?? 0),
      projectionDeltaBytes: this.spent.projectionDeltaBytes + (proposal.projectionDeltaBytes ?? 0),
      displayBytes: this.spent.displayBytes + (proposal.displayBytes ?? 0),
      scanRows: this.spent.scanRows + (proposal.scanRows ?? 0),
      timeMs: this.spent.timeMs + (proposal.timeMs ?? 0),
      steps: this.spent.steps + (proposal.steps ?? 0),
    }
    const cumulativeChecks: readonly { code: PerfBudgetCode; field: keyof PerfHardBudgets; limit: number; projected: number }[] = [
      { code: 'session-bytes', field: 'maxSessionBytes', limit: this.budgets.maxSessionBytes, projected: projected.sessionBytes },
      { code: 'meta-bytes', field: 'maxMetaBytes', limit: this.budgets.maxMetaBytes, projected: projected.metaBytes },
      { code: 'projection-bytes', field: 'maxProjectionBytes', limit: this.budgets.maxProjectionBytes, projected: projected.projectionDeltaBytes },
      { code: 'display-bytes', field: 'maxDisplayBytes', limit: this.budgets.maxDisplayBytes, projected: projected.displayBytes },
      { code: 'steps', field: 'maxSteps', limit: this.budgets.maxSteps, projected: projected.steps },
    ]
    for (const check of cumulativeChecks) {
      if (check.projected > check.limit) {
        return { status: 'refused', code: check.code, field: check.field, limit: check.limit, projected: check.projected }
      }
    }
    if (proposal.scanRows !== undefined && proposal.scanRows > this.budgets.maxScanRows) {
      return { status: 'refused', code: 'scan-rows', field: 'maxScanRows', limit: this.budgets.maxScanRows, projected: proposal.scanRows }
    }
    if (proposal.timeMs !== undefined && proposal.timeMs > this.budgets.maxTimeMs) {
      return { status: 'refused', code: 'time-budget', field: 'maxTimeMs', limit: this.budgets.maxTimeMs, projected: proposal.timeMs }
    }
    return { status: 'admitted', projected }
  }

  /**
   * Commit one spend after the caller's admission decision: accumulate every
   * named plane.
   * @param spend - the admitted spend to accumulate.
   */
  apply(spend: PerfSpend): void {
    this.spent = {
      sessionBytes: this.spent.sessionBytes + (spend.sessionBytes ?? 0),
      metaBytes: this.spent.metaBytes + (spend.metaBytes ?? 0),
      projectionDeltaBytes: this.spent.projectionDeltaBytes + (spend.projectionDeltaBytes ?? 0),
      displayBytes: this.spent.displayBytes + (spend.displayBytes ?? 0),
      scanRows: this.spent.scanRows + (spend.scanRows ?? 0),
      timeMs: this.spent.timeMs + (spend.timeMs ?? 0),
      steps: this.spent.steps + (spend.steps ?? 0),
    }
  }

  /**
   * Check one proposal and throw on refusal (the commit-guard helper for
   * callers that treat refusal as exceptional). Nothing accumulates on a
   * refusal; on success the spend is applied and the projected totals return.
   * @param proposal - the spend one final operation wants to commit.
   * @returns the projected totals after the applied spend.
   * @throws {PerfBudgetRefusal} when the proposal crosses any hard limit.
   */
  admitOrThrow(proposal: PerfSpend): PerfAdmission & { status: 'admitted' } {
    const admission = this.admissionFor(proposal)
    if (admission.status === 'refused') throw new PerfBudgetRefusal(admission)
    this.apply(proposal)
    return admission
  }

  /**
   * Hold one concurrency slot.
   * @throws {PerfBudgetRefusal} when every slot is busy (`concurrency`).
   */
  acquireSlot(): void {
    if (this.slotsInUse + 1 > this.budgets.maxConcurrency) {
      throw new PerfBudgetRefusal({
        status: 'refused',
        code: 'concurrency',
        field: 'maxConcurrency',
        limit: this.budgets.maxConcurrency,
        projected: this.slotsInUse + 1,
      })
    }
    this.slotsInUse += 1
  }

  /** Release one previously held slot; releasing an unheld slot refuses loudly. */
  releaseSlot(): void {
    if (this.slotsInUse === 0) {
      throw new Error('perf budget: releaseSlot without a held slot')
    }
    this.slotsInUse -= 1
  }
}

/** Record estimated (non-enforced) costs onto one report-shaped carrier. */
export interface PerfCostRecord {
  /** The recorded estimates, in call order. */
  readonly estimatedCosts: readonly PerfEstimatedCost[]
}

/**
 * Record one estimated cost. This function exists so the estimated plane has
 * exactly one home — it returns a record; it never touches a ledger, and no
 * admission path accepts its output.
 * @param costs - the ledger or carrier the estimate is recorded onto (ignored here by design).
 * @param cost - the estimated cost.
 * @returns the single-entry cost record.
 */
export function recordEstimatedCost(costs: unknown, cost: PerfEstimatedCost): PerfCostRecord {
  void costs
  return { estimatedCosts: [cost] }
}

/** The structural validation the ledger constructor runs (kept local to avoid a contract import cycle in docs). */
function validateBudgetShape(budgets: PerfHardBudgets): string[] {
  const problems: string[] = []
  const byteFields: readonly (keyof PerfHardBudgets)[] = [
    'maxSessionBytes',
    'maxMetaBytes',
    'maxProjectionBytes',
    'maxDisplayBytes',
  ]
  for (const field of byteFields) {
    if (!Number.isInteger(budgets[field]) || (budgets[field] as number) < 1) {
      problems.push(`${field} must be a positive integer`)
    }
  }
  for (const field of ['maxScanRows', 'maxTimeMs', 'maxConcurrency', 'maxSteps'] as const) {
    if (!Number.isInteger(budgets[field]) || (budgets[field] as number) < 1) {
      problems.push(`${field} must be a positive integer`)
    }
  }
  return problems
}

/** The zero spend every ledger starts from. */
function zeroSpend(): Required<Mutable<PerfSpend>> {
  return {
    sessionBytes: 0,
    metaBytes: 0,
    projectionDeltaBytes: 0,
    displayBytes: 0,
    scanRows: 0,
    timeMs: 0,
    steps: 0,
  }
}

/** Strip readonly for internal accumulation (the outward face stays readonly). */
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
