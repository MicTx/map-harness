/**
 * The controlled causal-effect computation. It estimates one treatment's
 * effect on one outcome under an explicitly declared identification design —
 * `covariate-adjustment` (cross-sectional OLS with balance, overlap, and
 * interference diagnostics) or `difference-in-differences` (two-period panel
 * first-difference with the Welch interval) — and downgrades the result to
 * the `association` claim level whenever a design is absent, a diagnostic
 * fails, or interference cannot be assessed. The causal level still states
 * its assumptions: unmeasured confounding is never excluded by these
 * diagnostics alone, and no natural-language claim is accepted as evidence.
 *
 * @module @map-harness/spatial-decision/causal
 */
import { buildWeightMatrix, type LonLat } from '@map-harness/spatial-statistics'
import {
  BALANCE_SMD_LIMIT,
  INTERFERENCE_SHARE_LIMIT,
  MAX_ANALYSIS_ROWS,
  MIN_ANALYSIS_ROWS,
  OVERLAP_SHARE_MIN,
  type ClaimLevel,
  type DowngradeReason,
  type EffectSpec,
  type IntervalLevel,
} from './contract.ts'
import { DecisionError } from './errors.ts'
import { isFiniteNumber, olsFit, tQuantile } from './linalg.ts'
import type { AnalysisRow, DecisionPublish, DecisionEvidenceHead, RowAccounting } from './attribution.ts'

/** One balance/overlap diagnostic row for one covariate. */
export interface EffectDiagnosticRow {
  readonly field: string
  /** Standardized mean difference (treated − control) over the pooled sd. */
  readonly smd: number
  /** Minimum of the treated-in-control and control-in-treated envelope shares. */
  readonly overlapShare: number
}

/** The interference (spillover) diagnostic report. */
export interface InterferenceReport {
  /** Whether a band was declared and the diagnostic ran. */
  readonly assessed: boolean
  /** Control rows with at least one treated neighbor inside the band, over all control rows. */
  readonly controlsWithTreatedNeighborShare: number | null
  /** Largest treated-neighbor share any control row shows. */
  readonly maxControlTreatedNeighborShare: number | null
}

/** The interval the effect carries. */
export interface EffectInterval {
  readonly estimate: number
  readonly se: number
  readonly low: number
  readonly high: number
  readonly level: IntervalLevel
  readonly df: number
}

/** The difference-in-differences detail rows. */
export interface DiDDetail {
  readonly unitsUsed: number
  readonly unitsDropped: number
  readonly treatedDeltaMean: number
  readonly controlDeltaMean: number
}

/** The effect evidence: estimate, interval, diagnostics, and the honest claim level. */
export interface EffectEvidence extends DecisionEvidenceHead {
  readonly claimLevel: ClaimLevel
  readonly downgradeReasons: readonly DowngradeReason[]
  readonly design: 'covariate-adjustment' | 'difference-in-differences' | 'none'
  readonly interval: EffectInterval | null
  readonly diagnostics: readonly EffectDiagnosticRow[]
  readonly maxAbsSmd: number | null
  readonly minOverlapShare: number | null
  readonly interference: InterferenceReport
  readonly assumptions: readonly string[]
  readonly treatedRows: number
  readonly controlRows: number
  readonly did: DiDDetail | null
}

/** One row marked treated or control with its numeric cells. */
interface MarkedRow {
  readonly id: string
  readonly treated: boolean
  readonly outcome: number
  readonly covariates: readonly number[]
  readonly coordinates: LonLat
}

/** Compare two raw row values under the spec's treated-value mark. */
function isTreated(value: unknown, treatedValue: number | string | boolean): boolean {
  if (typeof treatedValue === 'number') return value === treatedValue
  if (typeof treatedValue === 'boolean') {
    if (typeof value === 'boolean') return value === treatedValue
    return treatedValue ? value === 'true' || value === 1 : value === 'false' || value === 0
  }
  return value === treatedValue
}

/** The mean and unbiased variance of one sample. */
function meanVar(values: readonly number[]): { mean: number; variance: number } {
  const n = values.length
  const mean = values.reduce((s, v) => s + v, 0) / n
  const variance = n > 1 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0
  return { mean, variance }
}

/** The standardized mean difference between two groups over the pooled sd. */
function smd(treated: readonly number[], control: readonly number[]): number {
  const a = meanVar(treated)
  const b = meanVar(control)
  const pooled = Math.sqrt((a.variance + b.variance) / 2)
  if (pooled === 0) return 0
  return (a.mean - b.mean) / pooled
}

/** The minimum envelope-overlap share of two groups over one covariate. */
function overlapShare(treated: readonly number[], control: readonly number[]): number {
  const tMin = Math.min(...treated)
  const tMax = Math.max(...treated)
  const cMin = Math.min(...control)
  const cMax = Math.max(...control)
  const insideT = treated.filter(value => value >= cMin && value <= cMax).length / treated.length
  const insideC = control.filter(value => value >= tMin && value <= tMax).length / control.length
  return Math.min(insideT, insideC)
}

/**
 * Estimate the treatment effect under the declared (or absent) design and
 * report the honest claim level with its downgrade reasons.
 * @param rows - the prepared analysis rows.
 * @param spec - the validated effect spec.
 * @param publish - the artifact seam the diagnostics table publishes through.
 * @returns the effect evidence.
 */
export async function computeEffect(
  rows: readonly AnalysisRow[],
  spec: EffectSpec,
  publish: DecisionPublish,
): Promise<EffectEvidence> {
  if (rows.length > MAX_ANALYSIS_ROWS) {
    throw new DecisionError('DECISION_INVALID_INPUT', `the analysis table exceeds the ${MAX_ANALYSIS_ROWS}-row budget`)
  }
  const did = spec.design === 'difference-in-differences'
  const limitations = [
    'unmeasured confounding is not excluded by these diagnostics; the causal level rests on the declared design assumptions holding',
    'the estimate applies to the analysis rows\' population and window; applicability outside them is not established by this computation',
    'post-intervention feedback data and same-source artifacts are not independent confirmatory evidence',
  ]
  const artifacts: { label: string; ref: string }[] = []
  if (did) {
    return computeDiD(rows, spec, publish, limitations, artifacts)
  }
  return computeCrossSectional(rows, spec, publish, limitations, artifacts)
}

/** The cross-sectional (covariate-adjustment) path. */
async function computeCrossSectional(
  rows: readonly AnalysisRow[],
  spec: EffectSpec,
  publish: DecisionPublish,
  limitations: string[],
  artifacts: { label: string; ref: string }[],
): Promise<EffectEvidence> {
  const dropped: Record<string, number> = {}
  const marked: MarkedRow[] = []
  for (const row of rows) {
    const outcome = row.values[spec.outcomeField]
    const covariates: number[] = spec.factorFields.map(field => row.values[field] ?? Number.NaN)
    const treatedRaw = row.marks?.[spec.treatmentField]
    if (!isFiniteNumber(outcome) || covariates.some(cell => !isFiniteNumber(cell)) || treatedRaw === undefined) {
      const key = 'missing-fields'
      dropped[key] = (dropped[key] ?? 0) + 1
      continue
    }
    marked.push({
      id: row.id,
      treated: isTreated(treatedRaw, spec.treatedValue),
      outcome,
      covariates,
      coordinates: row.coordinates,
    })
  }
  const head = { limitations, artifacts, accounting: { used: marked.length, droppedByReason: dropped } as RowAccounting }
  const treated = marked.filter(row => row.treated)
  const control = marked.filter(row => !row.treated)
  if (treated.length === 0 || control.length === 0) {
    return {
      ...head,
      status: 'not_applicable',
      notApplicableReason: 'no-treatment-variation',
      claimLevel: 'unknown',
      downgradeReasons: [],
      design: spec.design ?? 'none',
      interval: null,
      diagnostics: [],
      maxAbsSmd: null,
      minOverlapShare: null,
      interference: { assessed: false, controlsWithTreatedNeighborShare: null, maxControlTreatedNeighborShare: null },
      assumptions: [],
      treatedRows: treated.length,
      controlRows: control.length,
      did: null,
    }
  }
  if (marked.length < MIN_ANALYSIS_ROWS) {
    return {
      ...head,
      status: 'not_applicable',
      notApplicableReason: 'too-few-valid-rows',
      claimLevel: 'unknown',
      downgradeReasons: [],
      design: spec.design ?? 'none',
      interval: null,
      diagnostics: [],
      maxAbsSmd: null,
      minOverlapShare: null,
      interference: { assessed: false, controlsWithTreatedNeighborShare: null, maxControlTreatedNeighborShare: null },
      assumptions: [],
      treatedRows: treated.length,
      controlRows: control.length,
      did: null,
    }
  }
  // Diagnostics on the raw covariates.
  const diagnostics: EffectDiagnosticRow[] = spec.factorFields.map((field, f) => ({
    field,
    smd: smd(treated.map(row => row.covariates[f] ?? 0), control.map(row => row.covariates[f] ?? 0)),
    overlapShare: overlapShare(treated.map(row => row.covariates[f] ?? 0), control.map(row => row.covariates[f] ?? 0)),
  }))
  const maxAbsSmd = Math.max(...diagnostics.map(row => Math.abs(row.smd)))
  const minOverlapShare = Math.min(...diagnostics.map(row => row.overlapShare))
  // Adjusted effect: OLS y ~ 1 + T + C.
  const design = marked.map(row => [1, row.treated ? 1 : 0, ...row.covariates])
  const fit = olsFit(design, marked.map(row => row.outcome))
  if (fit === undefined) {
    return {
      ...head,
      status: 'not_applicable',
      notApplicableReason: 'no-factor-variation',
      claimLevel: 'unknown',
      downgradeReasons: [],
      design: spec.design ?? 'none',
      interval: null,
      diagnostics,
      maxAbsSmd,
      minOverlapShare,
      interference: { assessed: false, controlsWithTreatedNeighborShare: null, maxControlTreatedNeighborShare: null },
      assumptions: [],
      treatedRows: treated.length,
      controlRows: control.length,
      did: null,
    }
  }
  const effect = fit.beta[1] ?? 0
  const se = fit.se[1] ?? 0
  const critical = tQuantile((1 + spec.intervalLevel) / 2, fit.df)
  const interval: EffectInterval = {
    estimate: effect,
    se,
    low: effect - critical * se,
    high: effect + critical * se,
    level: spec.intervalLevel,
    df: fit.df,
  }
  // Interference diagnostic: treated-neighbor exposure of control rows.
  const controlIndexes = marked.flatMap((row, index) => row.treated ? [] : [index])
  const interference = interferenceReport(controlIndexes, marked, spec)
  // Claim level: causal only with a declared design, passing diagnostics, and an assessed interference band.
  const downgradeReasons: DowngradeReason[] = []
  if (spec.design === undefined) downgradeReasons.push('no-identification-design')
  if (maxAbsSmd > BALANCE_SMD_LIMIT) downgradeReasons.push('imbalance-above-limit')
  if (minOverlapShare < OVERLAP_SHARE_MIN) downgradeReasons.push('overlap-below-limit')
  if (!interference.assessed) downgradeReasons.push('interference-not-assessed')
  else if ((interference.controlsWithTreatedNeighborShare ?? 0) > INTERFERENCE_SHARE_LIMIT) downgradeReasons.push('interference-suspected')
  const claimLevel: ClaimLevel = downgradeReasons.length === 0 ? 'causal' : 'association'
  const assumptions = [
    `conditional independence given the declared covariates (${spec.factorFields.join(', ')})`,
    'SUTVA/no-interference within the declared band',
    `positivity: every treated profile has comparable control support (overlap ≥ ${OVERLAP_SHARE_MIN})`,
  ]
  const table = { kind: 'attribution-effect', methodVersion: spec.methodVersion, diagnostics, interval, interference, claimLevel, downgradeReasons }
  artifacts.push({ label: 'effect-diagnostics', ref: (await publish('effect-diagnostics', new TextEncoder().encode(JSON.stringify(table)))).ref })
  return {
    ...head,
    status: 'succeeded',
    claimLevel,
    downgradeReasons,
    design: spec.design ?? 'none',
    interval,
    diagnostics,
    maxAbsSmd,
    minOverlapShare,
    interference,
    assumptions,
    treatedRows: treated.length,
    controlRows: control.length,
    did: null,
  }
}

/** The two-period difference-in-differences path. */
async function computeDiD(
  rows: readonly AnalysisRow[],
  spec: EffectSpec,
  publish: DecisionPublish,
  limitations: string[],
  artifacts: { label: string; ref: string }[],
): Promise<EffectEvidence> {
  const periodField = spec.periodField ?? ''
  const unitField = spec.unitField ?? ''
  const dropped: Record<string, number> = {}
  // Panel: one unit's pre and post rows.
  const panel = new Map<string, { pre?: { outcome: number; covariates: readonly number[]; coordinates: LonLat; treated: boolean }; post?: { outcome: number; coordinates: LonLat } }>()
  for (const row of rows) {
    const outcome = row.values[spec.outcomeField]
    const covariates: number[] = spec.factorFields.map(field => row.values[field] ?? Number.NaN)
    const unitRaw = row.marks?.[unitField]
    const periodRaw = row.marks?.[periodField]
    const treatedRaw = row.marks?.[spec.treatmentField]
    if (!isFiniteNumber(outcome) || unitRaw === undefined || treatedRaw === undefined) {
      dropped['missing-fields'] = (dropped['missing-fields'] ?? 0) + 1
      continue
    }
    const unit = String(unitRaw)
    const entry = panel.get(unit) ?? {}
    if (periodRaw === spec.preValue) {
      entry.pre = { outcome, covariates, coordinates: row.coordinates, treated: isTreated(treatedRaw, spec.treatedValue) }
    } else if (periodRaw === spec.postValue) {
      entry.post = { outcome, coordinates: row.coordinates }
    } else {
      dropped['period-unmatched'] = (dropped['period-unmatched'] ?? 0) + 1
      continue
    }
    panel.set(unit, entry)
  }
  const deltas: { treated: boolean; delta: number; covariates: readonly number[]; coordinates: LonLat }[] = []
  for (const entry of panel.values()) {
    if (entry.pre === undefined || entry.post === undefined) {
      dropped['incomplete-panel-unit'] = (dropped['incomplete-panel-unit'] ?? 0) + 1
      continue
    }
    deltas.push({
      treated: entry.pre.treated,
      delta: entry.post.outcome - entry.pre.outcome,
      covariates: entry.pre.covariates,
      coordinates: entry.pre.coordinates,
    })
  }
  const treated = deltas.filter(row => row.treated)
  const control = deltas.filter(row => !row.treated)
  const head = { limitations, artifacts, accounting: { used: deltas.length, droppedByReason: dropped } as RowAccounting }
  const base = {
    downgradeReasons: [] as DowngradeReason[],
    design: 'difference-in-differences' as const,
    interval: null as EffectInterval | null,
    diagnostics: [] as EffectDiagnosticRow[],
    maxAbsSmd: null as number | null,
    minOverlapShare: null as number | null,
    interference: { assessed: false, controlsWithTreatedNeighborShare: null, maxControlTreatedNeighborShare: null } as InterferenceReport,
    assumptions: [] as string[],
    treatedRows: treated.length,
    controlRows: control.length,
    did: null as DiDDetail | null,
  }
  if (treated.length === 0 || control.length === 0) {
    return {
      ...head,
      ...base,
      status: 'not_applicable',
      notApplicableReason: 'no-treatment-variation',
      claimLevel: 'unknown',
    }
  }
  if (deltas.length < MIN_ANALYSIS_ROWS) {
    return {
      ...head,
      ...base,
      status: 'not_applicable',
      notApplicableReason: 'too-few-valid-rows',
      claimLevel: 'unknown',
    }
  }
  // Balance on the pre-period covariates (the pre values are untouched by the intervention window).
  const diagnostics: EffectDiagnosticRow[] = spec.factorFields.map((field, f) => ({
    field,
    smd: smd(treated.map(row => row.covariates[f] ?? 0), control.map(row => row.covariates[f] ?? 0)),
    overlapShare: overlapShare(treated.map(row => row.covariates[f] ?? 0), control.map(row => row.covariates[f] ?? 0)),
  }))
  const maxAbsSmd = Math.max(...diagnostics.map(row => Math.abs(row.smd)))
  const minOverlapShare = Math.min(...diagnostics.map(row => row.overlapShare))
  // First-difference effect with the Welch interval.
  const tStats = meanVar(treated.map(row => row.delta))
  const cStats = meanVar(control.map(row => row.delta))
  const estimate = tStats.mean - cStats.mean
  const se = Math.sqrt(tStats.variance / treated.length + cStats.variance / control.length)
  const df = (tStats.variance / treated.length + cStats.variance / control.length) ** 2
    / ((tStats.variance / treated.length) ** 2 / (treated.length - 1) + (cStats.variance / control.length) ** 2 / (control.length - 1))
  const critical = tQuantile((1 + spec.intervalLevel) / 2, df)
  const interval: EffectInterval = {
    estimate,
    se,
    low: estimate - critical * se,
    high: estimate + critical * se,
    level: spec.intervalLevel,
    df,
  }
  const controlIndexes = deltas.flatMap((row, index) => row.treated ? [] : [index])
  const interference = interferenceReport(controlIndexes, deltas, spec)
  const downgradeReasons: DowngradeReason[] = []
  if (maxAbsSmd > BALANCE_SMD_LIMIT) downgradeReasons.push('imbalance-above-limit')
  if (minOverlapShare < OVERLAP_SHARE_MIN) downgradeReasons.push('overlap-below-limit')
  if (!interference.assessed) downgradeReasons.push('interference-not-assessed')
  else if ((interference.controlsWithTreatedNeighborShare ?? 0) > INTERFERENCE_SHARE_LIMIT) downgradeReasons.push('interference-suspected')
  const claimLevel: ClaimLevel = downgradeReasons.length === 0 ? 'causal' : 'association'
  const assumptions = [
    'parallel trends: without the intervention both groups would have moved identically (two periods cannot test this)',
    'no anticipatory behavior before the post period',
    'SUTVA/no-interference within the declared band',
  ]
  const detail: DiDDetail = {
    unitsUsed: deltas.length,
    unitsDropped: panel.size - deltas.length,
    treatedDeltaMean: tStats.mean,
    controlDeltaMean: cStats.mean,
  }
  const table = { kind: 'attribution-effect', methodVersion: spec.methodVersion, diagnostics, interval, interference, claimLevel, downgradeReasons, detail }
  artifacts.push({ label: 'effect-diagnostics', ref: (await publish('effect-diagnostics', new TextEncoder().encode(JSON.stringify(table)))).ref })
  return {
    ...head,
    status: 'succeeded',
    claimLevel,
    downgradeReasons,
    design: 'difference-in-differences',
    interval,
    diagnostics,
    maxAbsSmd,
    minOverlapShare,
    interference,
    assumptions,
    treatedRows: treated.length,
    controlRows: control.length,
    did: detail,
  }
}

/** Count treated-neighbor exposure of the control rows inside the declared band. */
function interferenceReport(
  controlIndexes: readonly number[],
  all: readonly { coordinates: LonLat; treated: boolean }[],
  spec: EffectSpec,
): InterferenceReport {
  const band = spec.interferenceBandMeters
  if (band === undefined || controlIndexes.length === 0) {
    return { assessed: false, controlsWithTreatedNeighborShare: null, maxControlTreatedNeighborShare: null }
  }
  const matrix = buildWeightMatrix(all.map(row => row.coordinates), {
    weights: { kind: 'distance-band', bandMeters: band },
    standardization: 'row',
  })
  let withNeighbor = 0
  let maxShare = 0
  for (const index of controlIndexes) {
    const edges = matrix.neighbors[index] ?? []
    const treatedWeight = edges.filter(edge => (all[edge.j]?.treated ?? false)).reduce((s, edge) => s + edge.w, 0)
    const totalWeight = edges.reduce((s, edge) => s + edge.w, 0)
    const share = totalWeight > 0 ? treatedWeight / totalWeight : 0
    if (edges.some(edge => (all[edge.j]?.treated ?? false))) withNeighbor++
    maxShare = Math.max(maxShare, share)
  }
  return {
    assessed: true,
    controlsWithTreatedNeighborShare: withNeighbor / controlIndexes.length,
    maxControlTreatedNeighborShare: maxShare,
  }
}
