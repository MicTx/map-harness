/**
 * The task budget ledger: the hard counters (model steps, meta bytes,
 * context bytes, scanned features) and the elapsed-time bound the loop
 * checks BEFORE expensive actions, plus the per-gap remediation limit.
 *
 * Rules (design §5.5, audit D10): counts, bytes, and time are hard limits;
 * provider cost is only ever recorded as an estimate and is not a limit.
 * The ledger lives in the decisionFrame projection state, outside the plan —
 * a planRevision update, retry, or resume can never reset consumed budget.
 * Cancellation does not refund: already-folded counters stay folded.
 *
 * @module @map-harness/spatial-context/budget
 */
import { z } from 'zod'

/** Wire version of the budget config schema the plugin validates. */
export const BUDGET_CONFIG_BOUND = 1

/** Default budget the plugin applies when the composition gives no overrides. */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxModelSteps: 64,
  maxMetaBytes: 512 * 1024,
  maxContextBytes: 256 * 1024,
  maxScanFeatures: 100_000,
  maxElapsedMs: 30 * 60 * 1000,
  maxGapRetries: 3,
}

/** Deployment-configured task budget. Every field is a hard limit; absent fields keep their defaults. */
export interface BudgetConfig {
  /** Maximum model steps (settled `step/end` events) per task. */
  readonly maxModelSteps: number
  /** Maximum cumulative serialized spatial meta bytes per task. */
  readonly maxMetaBytes: number
  /** Maximum cumulative injected snapshot bytes per task. */
  readonly maxContextBytes: number
  /** Maximum cumulative features consumed by analysis records per task. */
  readonly maxScanFeatures: number
  /** Maximum wall-clock milliseconds since the current goal was accepted. */
  readonly maxElapsedMs: number
  /** Maximum open-revisions of one gap id before remediation is blocked. */
  readonly maxGapRetries: number
}

/** Resolve the effective budget: validated overrides over the defaults. */
export function resolveBudgetConfig(overrides: Partial<BudgetConfig> | undefined): BudgetConfig {
  const merged = { ...DEFAULT_BUDGET_CONFIG, ...overrides }
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`budget.${key} must be a positive integer, got ${String(value)}`)
    }
  }
  return merged
}

/** Zod face of {@link BudgetConfig} for plugin load validation. */
export const budgetConfigSchema = z.object({
  maxModelSteps: z.number().int().positive(),
  maxMetaBytes: z.number().int().positive(),
  maxContextBytes: z.number().int().positive(),
  maxScanFeatures: z.number().int().positive(),
  maxElapsedMs: z.number().int().positive(),
  maxGapRetries: z.number().int().positive(),
}).partial()

/** The consumed counters the projection folds (plain JSON, bounded). */
export interface BudgetLedger {
  /** Settled `step/end` events since the session started. */
  readonly stepsUsed: number
  /** Cumulative serialized spatial meta bytes folded from accepted results. */
  readonly metaBytes: number
  /** Cumulative injected snapshot bytes actually admitted to the surface. */
  readonly contextBytes: number
  /** Cumulative features consumed by accepted analysis records. */
  readonly scanFeatures: number
  /** Bounded map of gap id → open-update count (remediation accounting). */
  readonly gapRetries: Readonly<Record<string, number>>
}

/** The initial zero ledger. */
export function initialBudgetLedger(): BudgetLedger {
  return { stepsUsed: 0, metaBytes: 0, contextBytes: 0, scanFeatures: 0, gapRetries: {} }
}

/** One preflight charge a caller intends to spend. */
export interface BudgetCharge {
  /** Context bytes the action would still inject (snapshot composition). */
  readonly contextBytes?: number
  /** Meta bytes the action would still attach (a candidate decision-change). */
  readonly metaBytes?: number
}

/** Why a preflight refused one action. */
export type BudgetRefusalCode =
  | 'steps-exhausted'
  | 'meta-bytes-exhausted'
  | 'context-bytes-exhausted'
  | 'scan-exhausted'
  | 'time-exhausted'
  | 'gap-retries-exhausted'

/** One preflight refusal with the counter that refused it. */
export interface BudgetRefusal {
  readonly code: BudgetRefusalCode
  /** The used/limit pair that refused the action. */
  readonly used: number
  readonly limit: number
}

/**
 * Preflight one action against the ledger BEFORE it runs. A remaining
 * balance must cover the full prospective charge: an action is refused
 * instead of half-spending past the limit.
 * @param ledger - the counters folded so far.
 * @param config - the task budget.
 * @param nowMs - current wall time (enforcement is a live action; replayable
 *   elapsed facts stay derivable from the log's own event times).
 * @param goalAcceptedAt - epoch millis of the current goal's acceptance.
 * @param charge - the prospective spend.
 * @returns `undefined` when the action may proceed, else the refusal.
 */
export function checkBudget(
  ledger: BudgetLedger,
  config: BudgetConfig,
  nowMs: number,
  goalAcceptedAt: number | undefined,
  charge: BudgetCharge = {},
): BudgetRefusal | undefined {
  if (ledger.stepsUsed >= config.maxModelSteps) {
    return { code: 'steps-exhausted', used: ledger.stepsUsed, limit: config.maxModelSteps }
  }
  const metaTotal = ledger.metaBytes + (charge.metaBytes ?? 0)
  if (metaTotal > config.maxMetaBytes) {
    return { code: 'meta-bytes-exhausted', used: metaTotal, limit: config.maxMetaBytes }
  }
  const contextTotal = ledger.contextBytes + (charge.contextBytes ?? 0)
  if (contextTotal > config.maxContextBytes) {
    return { code: 'context-bytes-exhausted', used: contextTotal, limit: config.maxContextBytes }
  }
  if (ledger.scanFeatures >= config.maxScanFeatures) {
    return { code: 'scan-exhausted', used: ledger.scanFeatures, limit: config.maxScanFeatures }
  }
  if (goalAcceptedAt !== undefined && nowMs - goalAcceptedAt >= config.maxElapsedMs) {
    return { code: 'time-exhausted', used: nowMs - goalAcceptedAt, limit: config.maxElapsedMs }
  }
  return undefined
}

/**
 * Check one gap id against the remediation limit.
 * @param ledger - the counters folded so far.
 * @param config - the task budget.
 * @param gapId - the gap being re-opened again.
 * @returns `undefined` while the gap may still be re-opened, else the refusal.
 */
export function checkGapRetry(
  ledger: BudgetLedger,
  config: BudgetConfig,
  gapId: string,
): BudgetRefusal | undefined {
  const used = ledger.gapRetries[gapId] ?? 0
  if (used >= config.maxGapRetries) {
    return { code: 'gap-retries-exhausted', used, limit: config.maxGapRetries }
  }
  return undefined
}

/** Fold one settled model step into the ledger (pure). */
export function foldStep(ledger: BudgetLedger): BudgetLedger {
  return { ...ledger, stepsUsed: ledger.stepsUsed + 1 }
}

/**
 * Fold consumed meta bytes and scanned features into the ledger (pure).
 * @param ledger - the counters folded so far.
 * @param metaBytes - serialized size of the record that was folded.
 * @param scanFeatures - features the record consumed (0 when none).
 */
export function foldConsumption(ledger: BudgetLedger, metaBytes: number, scanFeatures: number): BudgetLedger {
  return {
    ...ledger,
    metaBytes: ledger.metaBytes + metaBytes,
    scanFeatures: ledger.scanFeatures + scanFeatures,
  }
}

/** Fold one admitted snapshot injection into the ledger (pure). */
export function foldContextBytes(ledger: BudgetLedger, bytes: number): BudgetLedger {
  return { ...ledger, contextBytes: ledger.contextBytes + bytes }
}

/**
 * Fold one gap update into the remediation accounting (pure). Only
 * re-opened gaps count toward the limit; marking a gap resolved or blocked
 * never increments it.
 * @param ledger - the counters folded so far.
 * @param gapId - the gap the update touches.
 * @param status - the update's new status.
 */
export function foldGapRetry(
  ledger: BudgetLedger,
  gapId: string,
  status: 'open' | 'blocked' | 'resolved',
): BudgetLedger {
  if (status !== 'open') return ledger
  const retries = { ...ledger.gapRetries, [gapId]: (ledger.gapRetries[gapId] ?? 0) + 1 }
  return { ...ledger, gapRetries: retries }
}
