/**
 * The attribution computations that never claim causality: `association`
 * (per-factor Pearson/Spearman correlation with a seeded permutation test)
 * and `explain` (standardized OLS contributions with collinearity
 * diagnostics). Both consume one exact resource version's prepared rows and
 * publish their full tables through the caller's artifact seam. Their claim
 * levels are fixed (`association` / `model-explanation`) — no diagnostic on
 * this path can upgrade a label, only the controlled effect tool can reach
 * `causal`, and only with a passing identification design.
 *
 * @module @map-harness/spatial-decision/attribution
 */
import {
  DEFAULT_PERMUTATION_SEED,
  DEFAULT_PERMUTATIONS,
  MAX_PERMUTATIONS,
  MIN_PERMUTATIONS,
  type LonLat,
  mulberry32,
  shuffled,
} from '@map-harness/spatial-statistics'
import { MAX_ANALYSIS_ROWS, MIN_ANALYSIS_ROWS, type AssociationSpec, type ExplainSpec } from './contract.ts'
import { DecisionError } from './errors.ts'
import { isFiniteNumber, olsFit, pearson, spearman } from './linalg.ts'

/** The artifact seam one computation publishes its full tables through. */
export type DecisionPublish = (label: string, bytes: Uint8Array) => Promise<{ ref: string }>

/** One prepared analysis row the attribution and forecast computations consume. */
export interface AnalysisRow {
  readonly id: string
  readonly coordinates: LonLat
  /** Numeric fields read off the feature properties, keyed by field name. */
  readonly values: Readonly<Record<string, number | undefined>>
  /**
   * Raw (non-numeric) property values — treatment, period, and unit marks —
   * keyed by field name; computations compare them against the spec's marks.
   */
  readonly marks?: Readonly<Record<string, unknown>>
}

/** The named-exclusion diagnostics a computation reports beside its results. */
export interface RowAccounting {
  /** Rows the computation admitted. */
  readonly used: number
  /** Rows excluded, keyed by the reason (missing value, non-numeric, …). */
  readonly droppedByReason: Readonly<Record<string, number>>
}

/** The head every attribution/forecast evidence carries. */
export interface DecisionEvidenceHead {
  readonly status: 'succeeded' | 'not_applicable' | 'unknown'
  readonly notApplicableReason?: string | undefined
  readonly limitations: readonly string[]
  readonly artifacts: readonly { label: string; ref: string }[]
  readonly accounting: RowAccounting
}

/** The deterministic permutation report one association factor carries. */
export interface AssociationPermutation {
  readonly count: number
  readonly seed: number
}

/** One factor's association row. */
export interface AssociationFactor {
  readonly field: string
  readonly n: number
  readonly pearson: number | null
  readonly spearman: number | null
  readonly permutationP: number | null
  readonly permutation: AssociationPermutation
}

/** The association evidence: correlation labels that stay correlation labels. */
export interface AssociationEvidence extends DecisionEvidenceHead {
  readonly claimLevel: 'association'
  readonly factors: readonly AssociationFactor[]
}

/** One model-explanation contribution row. */
export interface ExplainContribution {
  readonly field: string
  /** Raw OLS coefficient in the outcome's units. */
  readonly beta: number
  /** Coefficient × factor sd: the standardized contribution magnitude. */
  readonly betaStandardized: number
  /** |betaStandardized| / Σ|betaStandardized| — the share the tool reports. */
  readonly share: number | null
  readonly se: number
}

/** One collinearity diagnostic row. */
export interface ExplainVif {
  readonly field: string
  /** 1/(1−R²) of the auxiliary regression; `null` when the aux regression is singular. */
  readonly vif: number | null
  readonly collinear: boolean
}

/** The model-explanation evidence: contributions of one fitted model, not effects. */
export interface ExplainEvidence extends DecisionEvidenceHead {
  readonly claimLevel: 'model-explanation'
  readonly rowsUsed: number
  readonly rSquared: number
  readonly adjustedRSquared: number
  readonly residualSigma: number
  readonly contributions: readonly ExplainContribution[]
  readonly vif: readonly ExplainVif[]
}

/** The VIF above which a factor is flagged collinear (protocol constant). */
export const VIF_COLLINEAR_LIMIT = 5

/** Admit the row table: bounded size, minimum count, honest not_applicable. */
function admitRows(
  rows: readonly AnalysisRow[],
  read: (row: AnalysisRow) => (number | undefined)[],
): { outcome: number[]; columns: number[][]; dropped: Record<string, number> } {
  if (rows.length === 0) {
    throw new DecisionError('DECISION_INVALID_INPUT', 'the analysis table is empty after the tool admitted its rows')
  }
  if (rows.length > MAX_ANALYSIS_ROWS) {
    throw new DecisionError('DECISION_INVALID_INPUT', `the analysis table exceeds the ${MAX_ANALYSIS_ROWS}-row budget`)
  }
  const outcome: number[] = []
  const columns: number[][] = []
  const dropped: Record<string, number> = {}
  for (const row of rows) {
    const cells = read(row)
    if (cells.some(cell => !isFiniteNumber(cell))) {
      const missing = cells.filter(cell => !isFiniteNumber(cell)).length
      dropped[`missing-${missing}-fields`] = (dropped[`missing-${missing}-fields`] ?? 0) + 1
      continue
    }
    outcome.push(cells[0] as number)
    columns.push(cells.slice(1).map(cell => cell as number))
  }
  return { outcome, columns, dropped }
}

/** Finalize the row accounting record. */
function accountingOf(used: number, dropped: Record<string, number>): RowAccounting {
  return { used, droppedByReason: dropped }
}

/**
 * Compute the per-factor association of one outcome with seeded permutation
 * p-values. Constant outcomes or factors, or fewer than
 * {@link MIN_ANALYSIS_ROWS} complete rows, are honest `not_applicable`
 * results — never fabricated correlations.
 * @param rows - the prepared analysis rows.
 * @param spec - the validated association spec.
 * @param publish - the artifact seam the full factor table publishes through.
 * @returns the association evidence.
 */
export async function computeAssociation(
  rows: readonly AnalysisRow[],
  spec: AssociationSpec,
  publish: DecisionPublish,
): Promise<AssociationEvidence> {
  const fields = spec.factorFields
  const admitted = admitRows(rows, row => [(row.values[spec.outcomeField]), ...fields.map(field => row.values[field])])
  const { outcome, columns, dropped } = admitted
  const limitations = [
    'association measures co-movement only: no output on this path is a causal effect',
    'spatial autocorrelation inflates the effective sample size; permutation p-values assume exchangeable rows',
    'same-source artifacts and exploratory factor choices are not independent confirmatory evidence',
  ]
  const artifacts: { label: string; ref: string }[] = []
  if (outcome.length < MIN_ANALYSIS_ROWS) {
    return {
      status: 'not_applicable',
      notApplicableReason: 'too-few-valid-rows',
      claimLevel: 'association',
      factors: [],
      limitations,
      artifacts,
      accounting: accountingOf(outcome.length, dropped),
    }
  }
  const outcomeConstant = new Set(outcome).size === 1
  if (outcomeConstant) {
    return {
      status: 'not_applicable',
      notApplicableReason: 'constant-outcome',
      claimLevel: 'association',
      factors: [],
      limitations,
      artifacts,
      accounting: accountingOf(outcome.length, dropped),
    }
  }
  const seed = DEFAULT_PERMUTATION_SEED
  const count = DEFAULT_PERMUTATIONS
  const factors: AssociationFactor[] = []
  for (let f = 0; f < fields.length; f++) {
    const field = fields[f] ?? ''
    const factor = columns.map(column => column[f] ?? Number.NaN)
    if (new Set(factor).size === 1) {
      factors.push({ field, n: factor.length, pearson: null, spearman: null, permutationP: null, permutation: { count, seed } })
      continue
    }
    const r = pearson(factor, outcome)
    const rho = spearman(factor, outcome)
    if (r === undefined) {
      factors.push({ field, n: factor.length, pearson: null, spearman: null, permutationP: null, permutation: { count, seed } })
      continue
    }
    const stream = mulberry32(seed)
    let extremes = 0
    for (let i = 0; i < count; i++) {
      const permuted = shuffled([...outcome], stream)
      const rPerm = pearson(factor, permuted)
      if (rPerm !== undefined && Math.abs(rPerm) >= Math.abs(r)) extremes++
    }
    factors.push({
      field,
      n: factor.length,
      pearson: r,
      spearman: rho ?? null,
      permutationP: (extremes + 1) / (count + 1),
      permutation: { count, seed },
    })
  }
  const table = { kind: 'attribution-association', methodVersion: spec.methodVersion, factors }
  artifacts.push({ label: 'association-table', ref: (await publish('association-table', new TextEncoder().encode(JSON.stringify(table)))).ref })
  return {
    status: 'succeeded',
    claimLevel: 'association',
    factors,
    limitations,
    artifacts,
    accounting: accountingOf(outcome.length, dropped),
  }
}

/**
 * Fit one outcome-on-factors OLS and report the standardized contributions,
 * R², and variance-inflation diagnostics. The claim level is fixed at
 * `model-explanation`: contribution shares explain the fitted model, never
 * the data-generating process.
 * @param rows - the prepared analysis rows.
 * @param spec - the validated explain spec.
 * @param publish - the artifact seam the full table publishes through.
 * @returns the explanation evidence.
 */
export async function computeExplain(
  rows: readonly AnalysisRow[],
  spec: ExplainSpec,
  publish: DecisionPublish,
): Promise<ExplainEvidence> {
  const fields = spec.factorFields
  const admitted = admitRows(rows, row => [(row.values[spec.outcomeField]), ...fields.map(field => row.values[field])])
  const { outcome, columns, dropped } = admitted
  const limitations = [
    'contribution shares explain the fitted model under its declared factors; they are not causal effects and omitted factors can change them',
    'collinear factors split their contribution arbitrarily; the VIF table names them',
    'exploratory factor selection on the same rows inflates R²; the shares are not confirmatory evidence',
  ]
  const artifacts: { label: string; ref: string }[] = []
  const accounting = accountingOf(outcome.length, dropped)
  if (outcome.length < MIN_ANALYSIS_ROWS) {
    return {
      status: 'not_applicable',
      notApplicableReason: 'too-few-valid-rows',
      claimLevel: 'model-explanation',
      rowsUsed: outcome.length,
      rSquared: 0,
      adjustedRSquared: 0,
      residualSigma: 0,
      contributions: [],
      vif: [],
      limitations,
      artifacts,
      accounting,
    }
  }
  if (new Set(outcome).size === 1) {
    return {
      status: 'not_applicable',
      notApplicableReason: 'constant-outcome',
      claimLevel: 'model-explanation',
      rowsUsed: outcome.length,
      rSquared: 0,
      adjustedRSquared: 0,
      residualSigma: 0,
      contributions: [],
      vif: [],
      limitations,
      artifacts,
      accounting,
    }
  }
  const n = outcome.length
  const p = fields.length
  // Design: intercept + raw factors (coefficients stay in outcome units).
  const design = columns.map(column => [1, ...column])
  const fit = olsFit(design, outcome)
  if (fit === undefined) {
    return {
      status: 'not_applicable',
      notApplicableReason: 'no-factor-variation',
      claimLevel: 'model-explanation',
      rowsUsed: n,
      rSquared: 0,
      adjustedRSquared: 0,
      residualSigma: 0,
      contributions: [],
      vif: [],
      limitations,
      artifacts,
      accounting,
    }
  }
  // Standardized contributions: beta_j × sd_j.
  const sds = fields.map((_, f) => {
    const column = columns.map(column => column[f] ?? 0)
    const mean = column.reduce((s, v) => s + v, 0) / n
    return Math.sqrt(column.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1))
  })
  const betaStd = fit.beta.slice(1).map((beta, f) => beta * (sds[f] ?? 0))
  const absSum = betaStd.reduce((s, v) => s + Math.abs(v), 0)
  const contributions = fields.map((field, f) => ({
    field,
    beta: fit.beta[f + 1] ?? 0,
    betaStandardized: betaStd[f] ?? 0,
    share: absSum > 0 ? Math.abs(betaStd[f] ?? 0) / absSum : null,
    se: fit.se[f + 1] ?? 0,
  }))
  // Variance inflation: auxiliary regression of each factor on the others.
  const vif: ExplainVif[] = []
  for (let f = 0; f < p; f++) {
    const otherIdx = fields.map((_, k) => k).filter(k => k !== f)
    const auxY = columns.map(column => column[f] ?? 0)
    if (new Set(auxY).size === 1) {
      vif.push({ field: fields[f] ?? '', vif: null, collinear: true })
      continue
    }
    const auxDesign = columns.map(column => [1, ...otherIdx.map(k => column[k] ?? 0)])
    const auxFit = olsFit(auxDesign, auxY)
    if (auxFit === undefined) {
      vif.push({ field: fields[f] ?? '', vif: null, collinear: true })
      continue
    }
    const value = auxFit.rSquared >= 1 - 1e-12 ? null : 1 / (1 - auxFit.rSquared)
    vif.push({ field: fields[f] ?? '', vif: value, collinear: value === null || value > VIF_COLLINEAR_LIMIT })
  }
  const table = { kind: 'attribution-explain', methodVersion: spec.methodVersion, contributions, vif, rSquared: fit.rSquared }
  artifacts.push({ label: 'explain-table', ref: (await publish('explain-table', new TextEncoder().encode(JSON.stringify(table)))).ref })
  return {
    status: 'succeeded',
    claimLevel: 'model-explanation',
    rowsUsed: n,
    rSquared: fit.rSquared,
    adjustedRSquared: fit.df > 0 ? 1 - (1 - fit.rSquared) * (n - 1) / fit.df : 0,
    residualSigma: fit.sigma,
    contributions,
    vif,
    limitations,
    artifacts,
    accounting,
  }
}

/** Guard the permutation vocabulary against accidental misuse (exported for tests). */
export function assertPermutationBounds(count: number): void {
  if (count < MIN_PERMUTATIONS || count > MAX_PERMUTATIONS) {
    throw new DecisionError('DECISION_INVALID_INPUT', `permutation count must be in [${MIN_PERMUTATIONS}, ${MAX_PERMUTATIONS}]`)
  }
}
