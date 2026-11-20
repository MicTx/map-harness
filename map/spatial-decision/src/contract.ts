/**
 * The P3 decision-models method contract: the versioned `AttributionSpec`
 * (association, model explanation, and controlled causal effect), `ForecastSpec`
 * (training cutoff, feature availability, holdouts, baseline, and interval
 * level), and `ScenarioSpec` (candidate comparison and constrained allocation
 * with capacity/cost/equity weights) inputs, their structural validation at
 * the input boundary, and the canonical request digest. Every default the
 * tools apply is written into the resolved spec — nothing lives only inside a
 * computation function. Validation accepts the raw JSON-shaped input the tool
 * layer forwards and returns typed issues instead of throwing, so a rejected
 * input lists every reason rather than the first.
 *
 * @module @map-harness/spatial-decision/contract
 */
import { createHash } from 'node:crypto'

/**
 * The method identity this package computes; a spec citing another version
 * is refused. The version pins every formula this package ships: Pearson /
 * Spearman association with seeded permutation tests, ordinary-least-squares
 * model explanations with variance-inflation and contribution shares,
 * covariate-adjustment and two-period difference-in-differences effect
 * estimation with balance/overlap/interference diagnostics and Student-t
 * intervals, linear/threshold/quadratic-ridge forecasts with naive/mean
 * baselines, forward-holdout validation, prediction intervals, drift and
 * out-of-domain detection, and greedy or bounded-global coverage allocation
 * with the documented weight objective and fixed sensitivity set.
 */
export const DECISION_METHOD_VERSION = 'p3-spatial-decision@2'

/**
 * The result-status vocabulary (shared with the P2 statistics layer).
 * `not_applicable` and `unknown` are honest answers: too few valid rows, a
 * constant outcome, or no treatment variation never fabricate an estimate.
 */
export type DecisionStatus = 'succeeded' | 'partial' | 'not_applicable' | 'unknown'

/** The structured reasons a decision computation can be out of applicability. */
export type NotApplicableReason =
  | 'too-few-valid-rows'
  | 'constant-outcome'
  | 'no-treatment-variation'
  | 'no-factor-variation'
  | 'time-coverage-insufficient'
  | 'no-valid-observations'
  | 'no-feasible-candidate'
  | 'combination-domain-too-large'

/**
 * The epistemic claim level an attribution result carries (design §12.2).
 * `association` and `model-explanation` never upgrade to `causal`; the causal
 * level requires a declared identification design whose balance, overlap, and
 * interference diagnostics all pass, and it still states its assumptions.
 */
export type ClaimLevel = 'association' | 'model-explanation' | 'causal' | 'unknown'

/** One reason an effect estimate stayed below the causal claim level. */
export type DowngradeReason =
  | 'no-identification-design'
  | 'imbalance-above-limit'
  | 'overlap-below-limit'
  | 'interference-suspected'
  | 'interference-not-assessed'

/** Half-open time window `[from, to)` in ISO-8601 with offset or `Z`. */
export interface TimeWindow {
  readonly from: string
  readonly to: string
}

/** The calendar granularities the forecast bins time into (UTC). */
export type Granularity = 'day' | 'week' | 'month'

/** The granularities in their fixed order (diagnostics and errors name them). */
export const GRANULARITIES: readonly Granularity[] = ['day', 'week', 'month']

/** The prediction-interval levels the forecast tools accept. */
export const INTERVAL_LEVELS = [0.8, 0.9, 0.95] as const

/** One accepted interval level. */
export type IntervalLevel = typeof INTERVAL_LEVELS[number]

/** Default prediction-interval level the tool resolution writes into the spec. */
export const DEFAULT_INTERVAL_LEVEL: IntervalLevel = 0.9

/** Minimum valid rows any attribution or forecast computation runs on. */
export const MIN_ANALYSIS_ROWS = 8

/** Maximum rows one bounded computation accepts. */
export const MAX_ANALYSIS_ROWS = 5000

/** Maximum candidate factors one attribution spec accepts. */
export const MAX_FACTORS = 8

/** Maximum forecast feature fields one spec accepts. */
export const MAX_FORECAST_FEATURES = 8

/** Forward-holdout length bounds (in forecast time bins). */
export const MIN_HOLDOUT_STEPS = 1
export const MAX_HOLDOUT_STEPS = 64

/** Default forward-holdout length the tool resolution writes into the spec. */
export const DEFAULT_HOLDOUT_STEPS = 4

/** Maximum horizon steps one prediction accepts. */
export const MAX_HORIZON_STEPS = 64

/** Maximum candidate schemes one scenario comparison accepts. */
export const MAX_CANDIDATES = 16

/** Maximum demand groups one scenario comparison accepts. */
export const MAX_GROUPS = 16

/** Maximum allocation sites one location-allocation accepts. */
export const MAX_SITES = 64

/** Maximum subsets the exact global allocation search may enumerate. */
export const MAX_COMBINATION_NODES = 4096

/** Maximum neighbor band in meters (shared bound with the P2 weight machinery). */
export const MAX_BAND_METERS = 500_000

/**
 * Maximum |standardized mean difference| a covariate may show after the
 * design's adjustment before the effect is downgraded below `causal`.
 * Protocol constant, not configuration: changing it is a method-version
 * change, not a tuning knob.
 */
export const BALANCE_SMD_LIMIT = 0.25

/**
 * Minimum univariate overlap share (treated rows inside the control envelope
 * of a covariate, and vice versa) the positivity diagnostic requires.
 */
export const OVERLAP_SHARE_MIN = 0.8

/**
 * Maximum share of control rows that have at least one treated neighbor
 * inside the declared interference band before the spillover diagnostic
 * downgrades the effect (`interference-suspected`).
 */
export const INTERFERENCE_SHARE_LIMIT = 0.1

/**
 * Default comparison weights the scenario tools write into the resolved spec
 * when the caller declares none. The resolved spec records
 * `defaultScenario: true` for them: they are one interpretable default
 * scenario, never the objective unique optimum (design §12.2).
 */
export const DEFAULT_SCENARIO_WEIGHTS: ScenarioWeights = { coverage: 0.5, equity: 0.3, cost: 0.2 }

/** The fixed weight-perturbation set the sensitivity report evaluates: every declared weight is halved and doubled in turn and the perturbed vector renormalized to sum one. */
export const SENSITIVITY_MULTIPLIERS = [0.5, 2] as const

/** The comparison weights one scenario objective declares; all non-negative, sum > 0. */
export interface ScenarioWeights {
  /** Weight of the demand-weighted coverage share. */
  readonly coverage: number
  /** Weight of the worst-group coverage share (the equity component). */
  readonly equity: number
  /** Weight of the normalized cost penalty. */
  readonly cost: number
}

/** One demand group of a scenario comparison: the units a proposal can serve. */
export interface DemandGroup {
  readonly id: string
  /** Total demand of the group; non-negative and finite. */
  readonly demand: number
}

/** One candidate scheme a scenario comparison evaluates. */
export interface ScenarioCandidate {
  readonly id: string
  /** Served demand per group id (missing groups count as zero); each within `[0, demand]`. */
  readonly servedByGroup: Readonly<Record<string, number>>
  /** Non-negative cost of the candidate. */
  readonly cost: number
  /** Optional hard capacity: total served must not exceed it. */
  readonly capacity?: number
}

/** The versioned scenario-comparison input: explicit groups, candidates, budget, and weights. */
export interface ScenarioCompareSpec {
  readonly goalRevision: number
  readonly groups: readonly DemandGroup[]
  readonly candidates: readonly ScenarioCandidate[]
  /** Optional total-cost budget; candidates above it stay listed as infeasible. */
  readonly budget?: number
  /** Declared value weights; absence selects the recorded default scenario. */
  readonly weights?: ScenarioWeights
  readonly methodVersion: string
}

/** One candidate allocation site of a location-allocation. */
export interface AllocateSite {
  readonly id: string
  readonly lon: number
  readonly lat: number
  /** Non-negative capacity cap on the demand the site can serve. */
  readonly capacity: number
  /** Non-negative opening cost charged against the budget. */
  readonly cost: number
}

/** The versioned location-allocation input: demand points from one resource version plus inline sites. */
export type LocationAllocateMode = 'greedy' | 'global'

export interface LocationAllocateSpec {
  readonly goalRevision: number
  /** Exact resource ref (`res-…@vN`) of the demand points. */
  readonly resourceRef: string
  /** Numeric property holding each demand point's demand weight. */
  readonly demandField: string
  /** Optional property whose distinct values partition demand into equity groups. */
  readonly groupField?: string
  readonly sites: readonly AllocateSite[]
  /** Opening strategy; omitted preserves the deterministic greedy strategy. */
  readonly mode?: LocationAllocateMode
  /** Cover radius in meters (great-circle); demand beyond every open site stays uncovered. */
  readonly coverageRadiusMeters: number
  /** Optional opening budget; allocations above it stay unopened and named. */
  readonly budget?: number
  readonly weights?: ScenarioWeights
  readonly methodVersion: string
}

/** Feature availability at the prediction origin (design §12.2). */
export type FeatureAvailability = 'known-at-origin' | 'concurrent'

/** One forecast feature: its field and when its values are known. */
export interface ForecastFeature {
  readonly field: string
  readonly availability: FeatureAvailability
}

/** The baselines every forecast compares against. */
export type ForecastBaseline = 'naive' | 'mean'

/** Forecast model families. Omitted `modelFamily` resolves to the legacy linear family. */
export type ForecastModelFamily = 'linear' | 'threshold' | 'quadratic-ridge'

/**
 * The versioned forecast input. `window.to` is the training cutoff: rows at
 * or after it are excluded from the fit with a diagnostic (the late-data
 * rule), and every validation split stays time-forward of it.
 */
export interface ForecastSpec {
  readonly goalRevision: number
  /** Exact resource ref (`res-…@vN`) of the historical observation rows. */
  readonly resourceRef: string
  readonly outcomeField: string
  /** Property holding each row's ISO event time. */
  readonly timeField: string
  readonly features: readonly ForecastFeature[]
  /** Training window `[from, cutoff)`; the cutoff is `window.to`. */
  readonly window: TimeWindow
  readonly granularity: Granularity
  readonly baseline: ForecastBaseline
  /** Last `k` time bins held out for the time-forward validation. */
  readonly holdoutSteps: number
  /** Spatial block size in meters the per-block validation rows report on. */
  readonly blockMeters: number
  readonly intervalLevel: IntervalLevel
  /** Optional model family; omission preserves the trend-plus-features linear fit. */
  readonly modelFamily?: ForecastModelFamily
  readonly methodVersion: string
}

/**
 * The versioned prediction input: a fitted model artifact plus the rows the
 * prediction origin can legitimately observe. `concurrent` features in the
 * fitted model make this spec impossible and the tool refuses it.
 */
export interface ForecastPredictSpec {
  readonly goalRevision: number
  /** Exact artifact ref (`art-…@vN`) of the fitted model from `forecast_fit`. */
  readonly modelRef: string
  /** Exact resource ref (`res-…@vN`) of the prediction-origin feature rows. */
  readonly resourceRef: string
  /** Forward steps (in forecast bins) from the training cutoff. */
  readonly horizonSteps: number
  readonly intervalLevel: IntervalLevel
  readonly methodVersion: string
}

/** The identification designs the effect tool accepts. */
export type IdentificationDesign = 'covariate-adjustment' | 'difference-in-differences'

/** The attribution spec head shared by association, explanation, and effect. */
export interface AttributionSpecBase {
  readonly goalRevision: number
  /** Exact resource ref (`res-…@vN`) of the analysis rows. */
  readonly resourceRef: string
  readonly outcomeField: string
  /** Candidate factor fields (1–8). */
  readonly factorFields: readonly string[]
  readonly methodVersion: string
}

/** The versioned association input: per-factor correlation with a seeded permutation test. */
export interface AssociationSpec extends AttributionSpecBase {}

/** The versioned model-explanation input: standardized OLS contributions with collinearity diagnostics. */
export interface ExplainSpec extends AttributionSpecBase {}

/** The versioned effect input: a declared (or absent, then honest) identification design. */
export interface EffectSpec extends AttributionSpecBase {
  /** Binary treatment field (exactly two distinct values, one flagged as treated). */
  readonly treatmentField: string
  /**
   * The declared identification design. Absent means the caller declared no
   * design: the tool still computes the adjusted difference but the result
   * stays at the `association` claim level with a named downgrade reason.
   */
  readonly design?: IdentificationDesign
  /** Row value marking the treated group (for example `true` or `"treated"`). */
  readonly treatedValue: number | string | boolean
  /** Property distinguishing pre/post rows (difference-in-differences only). */
  readonly periodField?: string
  /** Row value marking the pre period (difference-in-differences only). */
  readonly preValue?: number | string | boolean
  /** Row value marking the post period (difference-in-differences only). */
  readonly postValue?: number | string | boolean
  /** Property grouping panel rows into one unit (difference-in-differences only). */
  readonly unitField?: string
  /**
   * Optional interference band in meters: when declared, the spillover
   * diagnostic counts control rows with treated neighbors inside the band.
   */
  readonly interferenceBandMeters?: number
  readonly intervalLevel: IntervalLevel
}

/** The resolved-spec union the attribution tools hand to the computations. */
export type AttributionSpec = AssociationSpec | ExplainSpec | EffectSpec

/** The resolved-spec union the tools hand to every decision computation. */
export type DecisionSpec = AttributionSpec | ForecastSpec | ForecastPredictSpec | ScenarioCompareSpec | LocationAllocateSpec

/** The structured validation issue codes the contract reports. */
export type DecisionIssueCode =
  | 'spec-invalid'
  | 'ref-invalid'
  | 'field-missing'
  | 'factor-invalid'
  | 'treatment-invalid'
  | 'treated-value-missing'
  | 'design-unknown'
  | 'period-invalid'
  | 'band-invalid'
  | 'window-invalid'
  | 'feature-invalid'
  | 'availability-unknown'
  | 'granularity-unknown'
  | 'holdout-invalid'
  | 'level-unknown'
  | 'baseline-unknown'
  | 'mode-invalid'
  | 'model-family-unknown'
  | 'groups-invalid'
  | 'candidates-invalid'
  | 'sites-invalid'
  | 'radius-invalid'
  | 'budget-invalid'
  | 'weights-invalid'
  | 'model-ref-invalid'
  | 'method-version-invalid'
  | 'goal-revision-invalid'

/** One structured reason a decision spec input was rejected. */
export interface DecisionIssue {
  readonly code: DecisionIssueCode
  readonly field: string
  readonly message: string
}

/** The catalog ref grammar the versioned inputs must satisfy (`res-…@vN`). */
const RESOURCE_REF_PATTERN = /^res-[A-Za-z0-9-]+@v[1-9][0-9]*$/

/** The published-artifact ref grammar the model input accepts (`art-…@vN`). */
export const ARTIFACT_REF_PATTERN = /^art-[A-Za-z0-9-]+@v[1-9][0-9]*$/

/** ISO-8601 timestamp with an explicit offset or `Z`. */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** Narrow one JSON value to a string-keyed object. */
export function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One non-blank string property read off a record. */
function stringField(spec: { readonly [key: string]: unknown }, field: string): string | undefined {
  const value = spec[field]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Validate the goal revision every spec carries. */
function checkGoalRevision(spec: { readonly [key: string]: unknown }, issues: DecisionIssue[]): void {
  if (typeof spec.goalRevision !== 'number' || !Number.isInteger(spec.goalRevision) || spec.goalRevision < 0) {
    issues.push({ code: 'goal-revision-invalid', field: 'goalRevision', message: 'goalRevision must be a non-negative integer' })
  }
}

/** Validate one exact resource ref. */
function checkResourceRef(spec: { readonly [key: string]: unknown }, issues: DecisionIssue[]): void {
  if (typeof spec.resourceRef !== 'string' || !RESOURCE_REF_PATTERN.test(spec.resourceRef)) {
    issues.push({ code: 'ref-invalid', field: 'resourceRef', message: 'resourceRef must be an exact resource ref res-…@vN' })
  }
}

/** Validate the method version every spec carries. */
function checkMethodVersion(spec: { readonly [key: string]: unknown }, issues: DecisionIssue[]): void {
  if (spec.methodVersion !== DECISION_METHOD_VERSION) {
    issues.push({ code: 'method-version-invalid', field: 'methodVersion', message: `methodVersion must be "${DECISION_METHOD_VERSION}"` })
  }
}

/** Validate one interval level against the fixed vocabulary. */
function checkIntervalLevel(value: unknown, field: string, issues: DecisionIssue[]): void {
  if (!(INTERVAL_LEVELS as readonly unknown[]).includes(value)) {
    issues.push({ code: 'level-unknown', field, message: `interval level must be one of ${INTERVAL_LEVELS.join(', ')}` })
  }
}

/** Validate one finite non-negative number, pushing a structured issue otherwise. */
function checkNonNegative(value: unknown, field: string, code: DecisionIssueCode, issues: DecisionIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    issues.push({ code, field, message: `${field} must be a finite non-negative number` })
  }
}

/** Validate the factor-field list the attribution specs share. */
function checkFactors(spec: { readonly [key: string]: unknown }, issues: DecisionIssue[]): void {
  const factors = spec.factorFields
  if (!Array.isArray(factors) || factors.length < 1 || factors.length > MAX_FACTORS
    || factors.some(factor => typeof factor !== 'string' || factor.trim().length === 0)) {
    issues.push({ code: 'factor-invalid', field: 'factorFields', message: `factorFields must be 1–${MAX_FACTORS} non-empty field names` })
  }
}

/**
 * Validate the raw association spec input and return every structural issue.
 * @param input - the untrusted spec value (for example raw tool arguments).
 * @returns the issues; empty when the input is structurally valid.
 */
export function validateAssociationSpec(input: unknown): readonly DecisionIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: DecisionIssue[] = []
  checkGoalRevision(input, issues)
  checkResourceRef(input, issues)
  if (stringField(input, 'outcomeField') === undefined) {
    issues.push({ code: 'field-missing', field: 'outcomeField', message: 'outcomeField names the numeric outcome property' })
  }
  checkFactors(input, issues)
  checkMethodVersion(input, issues)
  return issues
}

/** Validate the raw explain spec input and return every structural issue. */
export function validateExplainSpec(input: unknown): readonly DecisionIssue[] {
  return validateAssociationSpec(input)
}

/** Validate the treated-value / design block the effect spec carries. */
function checkEffectTreatment(spec: { readonly [key: string]: unknown }, issues: DecisionIssue[]): void {
  if (stringField(spec, 'treatmentField') === undefined) {
    issues.push({ code: 'treatment-invalid', field: 'treatmentField', message: 'treatmentField names the binary treatment property' })
  }
  if (spec.treatedValue === undefined) {
    issues.push({ code: 'treated-value-missing', field: 'treatedValue', message: 'treatedValue marks which row value counts as treated' })
  }
  const design = spec.design
  if (design !== undefined) {
    if (design !== 'covariate-adjustment' && design !== 'difference-in-differences') {
      issues.push({ code: 'design-unknown', field: 'design', message: 'design must be covariate-adjustment or difference-in-differences' })
    }
    if (design === 'difference-in-differences') {
      if (stringField(spec, 'periodField') === undefined) {
        issues.push({ code: 'period-invalid', field: 'periodField', message: 'difference-in-differences requires periodField naming the pre/post property' })
      }
      if (spec.preValue === undefined || spec.postValue === undefined) {
        issues.push({ code: 'period-invalid', field: 'preValue', message: 'difference-in-differences requires distinct preValue and postValue marks' })
      }
      if (stringField(spec, 'unitField') === undefined) {
        issues.push({ code: 'period-invalid', field: 'unitField', message: 'difference-in-differences requires unitField grouping panel rows' })
      }
    }
  }
  const band = spec.interferenceBandMeters
  if (band !== undefined && (typeof band !== 'number' || !Number.isFinite(band) || band <= 0 || band > MAX_BAND_METERS)) {
    issues.push({ code: 'band-invalid', field: 'interferenceBandMeters', message: `interferenceBandMeters must be a positive number up to ${MAX_BAND_METERS}` })
  }
  checkIntervalLevel(spec.intervalLevel, 'intervalLevel', issues)
}

/** Validate the raw effect spec input and return every structural issue. */
export function validateEffectSpec(input: unknown): readonly DecisionIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: DecisionIssue[] = []
  checkGoalRevision(input, issues)
  checkResourceRef(input, issues)
  if (stringField(input, 'outcomeField') === undefined) {
    issues.push({ code: 'field-missing', field: 'outcomeField', message: 'outcomeField names the numeric outcome property' })
  }
  checkFactors(input, issues)
  checkEffectTreatment(input, issues)
  checkMethodVersion(input, issues)
  return issues
}

/** Validate the training window the forecast spec carries. */
function checkForecastWindow(spec: { readonly [key: string]: unknown }, issues: DecisionIssue[]): void {
  const window = spec.window
  if (!isRecord(window)
    || typeof window.from !== 'string' || typeof window.to !== 'string'
    || !ISO_TIMESTAMP_PATTERN.test(window.from) || !ISO_TIMESTAMP_PATTERN.test(window.to)
    || !(new Date(window.from).getTime() < new Date(window.to).getTime())) {
    issues.push({ code: 'window-invalid', field: 'window', message: 'window must be an ISO [from, cutoff) pair with from < cutoff' })
  }
}

/** Validate the feature list the forecast spec carries. */
function checkForecastFeatures(spec: { readonly [key: string]: unknown }, issues: DecisionIssue[]): void {
  const features = spec.features
  if (!Array.isArray(features) || features.length > MAX_FORECAST_FEATURES) {
    issues.push({ code: 'feature-invalid', field: 'features', message: `features must hold at most ${MAX_FORECAST_FEATURES} entries` })
    return
  }
  for (const [index, feature] of features.entries()) {
    if (!isRecord(feature) || typeof feature.field !== 'string' || feature.field.trim().length === 0) {
      issues.push({ code: 'feature-invalid', field: `features[${index}]`, message: 'each feature names a field' })
      continue
    }
    if (feature.availability !== 'known-at-origin' && feature.availability !== 'concurrent') {
      issues.push({ code: 'availability-unknown', field: `features[${index}].availability`, message: 'availability must be known-at-origin or concurrent' })
    }
  }
}

/** Validate the raw forecast spec input and return every structural issue. */
export function validateForecastSpec(input: unknown): readonly DecisionIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: DecisionIssue[] = []
  checkGoalRevision(input, issues)
  checkResourceRef(input, issues)
  if (stringField(input, 'outcomeField') === undefined) {
    issues.push({ code: 'field-missing', field: 'outcomeField', message: 'outcomeField names the numeric outcome property' })
  }
  if (stringField(input, 'timeField') === undefined) {
    issues.push({ code: 'field-missing', field: 'timeField', message: 'timeField names each row\'s ISO event time property' })
  }
  checkForecastFeatures(input, issues)
  checkForecastWindow(input, issues)
  if (!(GRANULARITIES as readonly string[]).includes(input.granularity as Granularity)) {
    issues.push({ code: 'granularity-unknown', field: 'granularity', message: `granularity must be one of ${GRANULARITIES.join(', ')}` })
  }
  if (input.baseline !== 'naive' && input.baseline !== 'mean') {
    issues.push({ code: 'baseline-unknown', field: 'baseline', message: 'baseline must be naive or mean' })
  }
  if (input.modelFamily !== undefined
    && input.modelFamily !== 'linear'
    && input.modelFamily !== 'threshold'
    && input.modelFamily !== 'quadratic-ridge') {
    issues.push({ code: 'model-family-unknown', field: 'modelFamily', message: 'modelFamily must be linear, threshold, or quadratic-ridge' })
  }
  if (input.modelFamily === 'threshold' && (!Array.isArray(input.features) || input.features.length < 1)) {
    issues.push({ code: 'feature-invalid', field: 'features', message: 'threshold forecasts require at least one candidate feature' })
  }
  const holdout = input.holdoutSteps
  if (typeof holdout !== 'number' || !Number.isInteger(holdout) || holdout < MIN_HOLDOUT_STEPS || holdout > MAX_HOLDOUT_STEPS) {
    issues.push({ code: 'holdout-invalid', field: 'holdoutSteps', message: `holdoutSteps must be an integer in [${MIN_HOLDOUT_STEPS}, ${MAX_HOLDOUT_STEPS}]` })
  }
  const block = input.blockMeters
  if (typeof block !== 'number' || !Number.isFinite(block) || block <= 0 || block > MAX_BAND_METERS) {
    issues.push({ code: 'band-invalid', field: 'blockMeters', message: `blockMeters must be a positive number up to ${MAX_BAND_METERS}` })
  }
  checkIntervalLevel(input.intervalLevel, 'intervalLevel', issues)
  checkMethodVersion(input, issues)
  return issues
}

/** Validate the raw prediction spec input and return every structural issue. */
export function validateForecastPredictSpec(input: unknown): readonly DecisionIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: DecisionIssue[] = []
  checkGoalRevision(input, issues)
  if (typeof input.modelRef !== 'string' || !ARTIFACT_REF_PATTERN.test(input.modelRef)) {
    issues.push({ code: 'model-ref-invalid', field: 'modelRef', message: 'modelRef must be an exact published artifact ref art-…@vN from forecast_fit' })
  }
  checkResourceRef(input, issues)
  const horizon = input.horizonSteps
  if (typeof horizon !== 'number' || !Number.isInteger(horizon) || horizon < 1 || horizon > MAX_HORIZON_STEPS) {
    issues.push({ code: 'holdout-invalid', field: 'horizonSteps', message: `horizonSteps must be an integer in [1, ${MAX_HORIZON_STEPS}]` })
  }
  checkIntervalLevel(input.intervalLevel, 'intervalLevel', issues)
  checkMethodVersion(input, issues)
  return issues
}

/** Validate the weights block the scenario specs carry. */
function checkWeights(spec: { readonly [key: string]: unknown }, issues: DecisionIssue[]): void {
  const weights = spec.weights
  if (weights === undefined) return
  if (!isRecord(weights)) {
    issues.push({ code: 'weights-invalid', field: 'weights', message: 'weights must be { coverage, equity, cost }' })
    return
  }
  let sum = 0
  for (const key of ['coverage', 'equity', 'cost'] as const) {
    const value = weights[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      issues.push({ code: 'weights-invalid', field: `weights.${key}`, message: `weights.${key} must be a finite non-negative number` })
      return
    }
    sum += value
  }
  if (sum <= 0) {
    issues.push({ code: 'weights-invalid', field: 'weights', message: 'weights must sum to a positive value' })
  }
}

/** Validate the raw scenario-comparison spec input and return every structural issue. */
export function validateScenarioCompareSpec(input: unknown): readonly DecisionIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: DecisionIssue[] = []
  checkGoalRevision(input, issues)
  checkMethodVersion(input, issues)
  const groups = input.groups
  if (!Array.isArray(groups) || groups.length < 1 || groups.length > MAX_GROUPS) {
    issues.push({ code: 'groups-invalid', field: 'groups', message: `groups must hold 1–${MAX_GROUPS} demand groups` })
  } else {
    const ids = new Set<string>()
    for (const [index, group] of groups.entries()) {
      if (!isRecord(group) || typeof group.id !== 'string' || group.id.trim().length === 0
        || typeof group.demand !== 'number' || !Number.isFinite(group.demand) || group.demand < 0) {
        issues.push({ code: 'groups-invalid', field: `groups[${index}]`, message: 'each group needs a non-empty id and a finite non-negative demand' })
      } else if (ids.has(group.id)) {
        issues.push({ code: 'groups-invalid', field: `groups[${index}].id`, message: 'group ids must be unique' })
      }
      if (typeof group?.id === 'string') ids.add(group.id)
    }
  }
  const candidates = input.candidates
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_CANDIDATES) {
    issues.push({ code: 'candidates-invalid', field: 'candidates', message: `candidates must hold 1–${MAX_CANDIDATES} schemes` })
  } else {
    const ids = new Set<string>()
    for (const [index, candidate] of candidates.entries()) {
      if (!isRecord(candidate) || typeof candidate.id !== 'string' || candidate.id.trim().length === 0) {
        issues.push({ code: 'candidates-invalid', field: `candidates[${index}]`, message: 'each candidate needs a non-empty id' })
        continue
      }
      if (ids.has(candidate.id)) issues.push({ code: 'candidates-invalid', field: `candidates[${index}].id`, message: 'candidate ids must be unique' })
      ids.add(candidate.id)
      checkNonNegative(candidate.cost, `candidates[${index}].cost`, 'candidates-invalid', issues)
      const capacity = candidate.capacity
      if (capacity !== undefined) checkNonNegative(capacity, `candidates[${index}].capacity`, 'candidates-invalid', issues)
      const served = candidate.servedByGroup
      if (!isRecord(served)) {
        issues.push({ code: 'candidates-invalid', field: `candidates[${index}].servedByGroup`, message: 'servedByGroup maps group id to a non-negative served amount' })
        continue
      }
      for (const [groupId, amount] of Object.entries(served)) {
        if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
          issues.push({ code: 'candidates-invalid', field: `candidates[${index}].servedByGroup.${groupId}`, message: 'served amounts must be finite and non-negative' })
        }
      }
    }
  }
  if (input.budget !== undefined) checkNonNegative(input.budget, 'budget', 'budget-invalid', issues)
  checkWeights(input, issues)
  return issues
}

/** Validate the raw location-allocation spec input and return every structural issue. */
export function validateLocationAllocateSpec(input: unknown): readonly DecisionIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: DecisionIssue[] = []
  checkGoalRevision(input, issues)
  checkResourceRef(input, issues)
  if (stringField(input, 'demandField') === undefined) {
    issues.push({ code: 'field-missing', field: 'demandField', message: 'demandField names the numeric demand property' })
  }
  if (input.groupField !== undefined && stringField(input, 'groupField') === undefined) {
    issues.push({ code: 'field-missing', field: 'groupField', message: 'groupField must be a non-empty property name' })
  }
  if (input.mode !== undefined && input.mode !== 'greedy' && input.mode !== 'global') {
    issues.push({ code: 'mode-invalid', field: 'mode', message: 'mode must be "greedy" or "global"' })
  }
  const sites = input.sites
  if (!Array.isArray(sites) || sites.length < 1 || sites.length > MAX_SITES) {
    issues.push({ code: 'sites-invalid', field: 'sites', message: `sites must hold 1–${MAX_SITES} candidate sites` })
  } else {
    const ids = new Set<string>()
    for (const [index, site] of sites.entries()) {
      if (!isRecord(site) || typeof site.id !== 'string' || site.id.trim().length === 0) {
        issues.push({ code: 'sites-invalid', field: `sites[${index}]`, message: 'each site needs a non-empty id' })
        continue
      }
      if (ids.has(site.id)) issues.push({ code: 'sites-invalid', field: `sites[${index}].id`, message: 'site ids must be unique' })
      ids.add(site.id)
      for (const key of ['lon', 'lat', 'capacity', 'cost'] as const) {
        if (typeof site[key] !== 'number' || !Number.isFinite(site[key])) {
          issues.push({ code: 'sites-invalid', field: `sites[${index}].${key}`, message: `sites[${index}].${key} must be a finite number` })
        }
      }
      if (typeof site.capacity === 'number' && site.capacity < 0) {
        issues.push({ code: 'sites-invalid', field: `sites[${index}].capacity`, message: 'capacity must be non-negative' })
      }
      if (typeof site.cost === 'number' && site.cost < 0) {
        issues.push({ code: 'sites-invalid', field: `sites[${index}].cost`, message: 'cost must be non-negative' })
      }
    }
  }
  const radius = input.coverageRadiusMeters
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0 || radius > MAX_BAND_METERS) {
    issues.push({ code: 'radius-invalid', field: 'coverageRadiusMeters', message: `coverageRadiusMeters must be a positive number up to ${MAX_BAND_METERS}` })
  }
  if (input.budget !== undefined) checkNonNegative(input.budget, 'budget', 'budget-invalid', issues)
  checkWeights(input, issues)
  checkMethodVersion(input, issues)
  return issues
}

/** Canonical JSON of one value: object keys sorted recursively so a digest is independent of key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The canonical request digest of one spec: sha256 over the key-sorted JSON.
 * Re-running the same spec reproduces it byte for byte.
 * @param spec - the validated spec object.
 * @returns the hex digest.
 */
export function decisionSpecDigestOf(spec: DecisionSpec): string {
  return createHash('sha256').update(canonicalJson(spec), 'utf8').digest('hex')
}
