/**
 * The P2 statistics method contract: the versioned `StatisticSpec` and
 * `PatternSpec` inputs (observation units via exact catalog refs, field and
 * denominator, weight-matrix definition, standardization, island handling,
 * permutation count/seed, multiple-testing policy, observation windows,
 * granularity, missing-data rules, forward holdout, and the output version),
 * their structural validation at the input boundary, and the canonical
 * request digest. Every default the tools apply is written into the resolved
 * spec — nothing lives only inside an algorithm function. Validation accepts
 * the raw JSON-shaped input the tool layer forwards and returns typed issues
 * instead of throwing, so a rejected input lists every reason rather than
 * the first.
 *
 * @module @map-harness/spatial-statistics/contract
 */
import { createHash } from 'node:crypto'

/**
 * The method identity this package computes; a spec citing another version
 * is refused. The version pins every formula this package ships: zonal
 * summaries (population ddof=0 dispersion), global/local Moran's I,
 * Getis-Ord Gi*, density-based space-time clusters, and origin-destination
 * flows, together with the seeded permutation machinery and the
 * Benjamini–Hochberg / Bonferroni corrections.
 */
export const STATS_METHOD_VERSION = 'p2-spatial-statistics@1'

/**
 * The result-status vocabulary (design §4.3). `not_applicable` and `unknown`
 * are honest answers: too few valid units, an all-constant field, or a time
 * window too sparse to support the statistic never fabricate a p-value or a
 * series.
 */
export type StatStatus = 'succeeded' | 'partial' | 'not_applicable' | 'unknown'

/** The structured reasons a statistic can be out of applicability. */
export type NotApplicableReason =
  | 'too-few-valid-units'
  | 'constant-field'
  | 'no-weight-neighbors'
  | 'time-coverage-insufficient'
  | 'no-valid-observations'

/** Half-open time window `[from, to)` in ISO-8601 with offset or `Z`. */
export interface TimeWindow {
  readonly from: string
  readonly to: string
}

/** The fixed missing-data convention of every pattern method: gaps stay gaps. */
export const MISSING_DATA_RULE = 'never-interpolate' as const

/** The fixed late-data convention: records at or after `to` are excluded with a diagnostic. */
export const LATE_DATA_RULE = 'exclude-with-diagnostic' as const

/** The fixed island handling of every weighted statistic. */
export const ISLAND_RULE = 'exclude-with-diagnostic' as const

/**
 * The distance-decay-free weight definition: binary neighbors within one
 * great-circle band. The band is the analyst's scale declaration, so it is a
 * required spec field, never an algorithm default.
 */
export interface WeightSpec {
  readonly kind: 'distance-band'
  /** Neighbor threshold in meters (great-circle); fixed cap applies. */
  readonly bandMeters: number
}

/** Weight standardization applied before any weighted statistic. */
export type Standardization = 'row' | 'binary'

/** The multiple-testing policies the local statistics accept. */
export type MultipleTesting = 'none' | 'bonferroni' | 'fdr-bh'

/** The calendar granularities the pattern methods bin time into (UTC). */
export type Granularity = 'day' | 'week' | 'month'

/** The granularities in their fixed order (diagnostics and errors name them). */
export const GRANULARITIES: readonly Granularity[] = ['day', 'week', 'month']

/** Default permutation count the zonal-tool resolution writes into the spec. */
export const DEFAULT_PERMUTATIONS = 199

/** Fixed default permutation seed; recorded in every output that used it. */
export const DEFAULT_PERMUTATION_SEED = 20260924

/** Default multiple-testing policy for the local statistics. */
export const DEFAULT_MULTIPLE_TESTING: MultipleTesting = 'fdr-bh'

/** Default time-bin coverage fraction a pattern window must reach. */
export const DEFAULT_MIN_COVERAGE = 0.6

/** Default forward-holdout blocks (last `k` granularity bins held out). */
export const DEFAULT_HOLDOUT_BLOCKS = 1

/** Default default max chain gap (in bins) an entity flow tolerates before the chain breaks. */
export const DEFAULT_MAX_GAP_BINS = 1

/** Minimum valid units any weighted statistic runs on after admission. */
export const MIN_WEIGHTED_UNITS = 8

/** Maximum units one bounded computation accepts. */
export const MAX_UNITS = 5000

/** Maximum neighbor band in meters. */
export const MAX_BAND_METERS = 500_000

/** Maximum permutations per seeded test. */
export const MAX_PERMUTATIONS = 999

/** Minimum permutations when a permutation test is requested. */
export const MIN_PERMUTATIONS = 9

/**
 * The versioned zonal-statistics input: groups of observation units with one
 * numeric field, an optional rate denominator field, and the zone attribute
 * the groups form from. All values come from one exact catalog version.
 */
export interface ZonalSpec {
  /** Goal revision the spec was written against; diagnostic bookkeeping only. */
  readonly goalRevision: number
  /** Exact resource ref (`res-…@vN`) of the observation units. */
  readonly resourceRef: string
  /** Numeric property summarised per zone. */
  readonly field: string
  /** Optional positive denominator property; enables the weighted mean and the sum-rate. */
  readonly denominatorField?: string
  /** Optional property whose distinct values form the zones; absence means one zone. */
  readonly zoneField?: string
  readonly methodVersion: string
}

/**
 * The versioned spatial-autocorrelation input: global Moran's I plus its
 * local LISA decomposition, both tested by seeded permutation under the
 * declared weight matrix, standardization, and multiple-testing policy.
 */
export interface AutocorrelationSpec {
  readonly goalRevision: number
  readonly resourceRef: string
  readonly field: string
  readonly weights: WeightSpec
  /** Row standardization rescales each row to sum one; binary keeps 0/1 weights. */
  readonly standardization: Standardization
  /** Permutation redraws for the pseudo p-values. */
  readonly permutations: number
  /** Seed of the deterministic permutation stream. */
  readonly seed: number
  /** Correction applied to the local pseudo p-values. */
  readonly multipleTesting: MultipleTesting
  readonly methodVersion: string
}

/**
 * The versioned hotspot input: Getis-Ord Gi* (self-inclusive neighbor sum)
 * with seeded permutation p-values and the declared multiple-testing policy.
 */
export interface HotspotSpec {
  readonly goalRevision: number
  readonly resourceRef: string
  readonly field: string
  readonly weights: WeightSpec
  readonly standardization: Standardization
  readonly permutations: number
  readonly seed: number
  readonly multipleTesting: MultipleTesting
  readonly methodVersion: string
}

/** The shared head of every pattern spec: one exact resource, one field, one window. */
export interface PatternSpecBase {
  readonly goalRevision: number
  readonly resourceRef: string
  /** Numeric property the pattern summarizes. */
  readonly field: string
  /** Property holding each observation's event time (ISO-8601). */
  readonly eventTimeField: string
  /** Half-open observation window `[from, to)`; records outside are excluded with diagnostics. */
  readonly window: TimeWindow
  /** UTC calendar bin the time axis uses. */
  readonly granularity: Granularity
  /** Fraction of expected bins that must be occupied before any result is applicable. */
  readonly minCoverage: number
  /** Last `k` granularity bins held out for the time-forward stability check. */
  readonly holdoutBlocks: number
  readonly methodVersion: string
}

/**
 * The versioned change input: two ordered sub-windows inside the observation
 * window. The comparison window starts at or after the baseline window ends
 * — the time-forward guarantee — and every delta compares the same frozen
 * spatial unit across the two windows. `blockMeters` fixes the spatial grid
 * the per-block deltas report on.
 */
export interface ChangeSpec extends PatternSpecBase {
  readonly baselineWindow: TimeWindow
  readonly comparisonWindow: TimeWindow
  /** Spatial block size in meters for the per-block delta rows. */
  readonly blockMeters: number
  /**
   * Optional property grouping observations into one spatial unit across
   * time (for example a device or community id); when absent, each feature
   * is its own unit and multi-observation units never form.
   */
  readonly unitField?: string
}

/** The versioned space-time cluster input: DBSCAN over space and time bins. */
export interface ClusterSpec extends PatternSpecBase {
  /** Spatial radius in meters (great-circle). */
  readonly epsMeters: number
  /** Temporal radius in granularity bins. */
  readonly epsBins: number
  /** Core-point threshold (neighbors including self). */
  readonly minPts: number
  /** Spatial block size in meters for the per-block participation rows. */
  readonly blockMeters: number
}

/**
 * The versioned origin-destination flow input: consecutive observations of
 * one entity contribute a cell-to-cell transition; a chain gap larger than
 * `maxGapBins` breaks the chain instead of being interpolated. Flows need no
 * value field; the field stays optional.
 */
export interface FlowSpec extends Omit<PatternSpecBase, 'field'> {
  /** Optional numeric property summarized per flow (mean at destination). */
  readonly field?: string
  /** Property identifying the moving entity. */
  readonly entityField: string
  /** Flow grid cell size in meters. */
  readonly cellMeters: number
  /** Chain gaps above this many bins break the transition (never interpolated). */
  readonly maxGapBins: number
  /** Flows in the reported top table. */
  readonly topK: number
}

/** The resolved-stat union the tools hand to the computations. */
export type StatSpec = ZonalSpec | AutocorrelationSpec | HotspotSpec
/** The resolved-pattern union the tools hand to the computations. */
export type PatternSpec = ChangeSpec | ClusterSpec | FlowSpec

/** The structured validation issue codes the contract reports. */
export type StatIssueCode =
  | 'spec-invalid'
  | 'ref-invalid'
  | 'field-missing'
  | 'denominator-invalid'
  | 'zone-invalid'
  | 'window-invalid'
  | 'window-order'
  | 'granularity-unknown'
  | 'coverage-invalid'
  | 'holdout-invalid'
  | 'weight-invalid'
  | 'standardization-unknown'
  | 'perm-invalid'
  | 'seed-invalid'
  | 'testing-invalid'
  | 'cluster-invalid'
  | 'flow-invalid'
  | 'time-field-missing'
  | 'entity-field-missing'
  | 'method-version-invalid'
  | 'goal-revision-invalid'

/** One structured reason a statistics/pattern spec input was rejected. */
export interface StatIssue {
  readonly code: StatIssueCode
  readonly field: string
  readonly message: string
}

/** The catalog ref grammar the versioned inputs must satisfy (`res-…@vN`). */
const RESOURCE_REF_PATTERN = /^res-[A-Za-z0-9-]+@v[1-9][0-9]*$/

/** ISO-8601 timestamp with an explicit offset or `Z`. */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** Narrow one JSON value to a string-keyed object. */
function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One non-blank string property read off a record. */
function stringField(spec: { readonly [key: string]: unknown }, field: string): string | undefined {
  const value = spec[field]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Validate one half-open ISO time window. */
function checkWindow(value: unknown, field: string): SpecWindowCheck {
  if (!isRecord(value)) return { issue: { code: 'window-invalid', field, message: 'window must be an object { from, to }' } }
  const from = value.from
  const to = value.to
  if (typeof from !== 'string' || typeof to !== 'string'
    || !ISO_TIMESTAMP_PATTERN.test(from) || !ISO_TIMESTAMP_PATTERN.test(to)
    || !(new Date(from).getTime() < new Date(to).getTime())) {
    return { issue: { code: 'window-invalid', field, message: 'window must be an ISO [from, to) pair with from < to' } }
  }
  return { window: { from, to } }
}

/** The outcome of one window check: either the parsed window or the issue. */
interface SpecWindowCheck {
  readonly window?: TimeWindow
  readonly issue?: StatIssue
}

/** Check `later` starts at or after `earlier` ends (the time-forward guarantee). */
function orderedWindows(earlier: TimeWindow, later: TimeWindow, field: string): StatIssue | undefined {
  return new Date(later.from).getTime() < new Date(earlier.to).getTime()
    ? { code: 'window-order', field, message: 'windows must not overlap and must stay time-forward (later starts at or after earlier ends)' }
    : undefined
}

/** Check one window lies inside the containing observation window. */
function nestedWindow(outer: TimeWindow, inner: TimeWindow, field: string): StatIssue | undefined {
  const inside = new Date(inner.from).getTime() >= new Date(outer.from).getTime()
    && new Date(inner.to).getTime() <= new Date(outer.to).getTime()
  return inside
    ? undefined
    : { code: 'window-order', field, message: 'sub-windows must lie inside the observation window' }
}

/** Validate the fields shared by every spec head; pushes into `issues`. */
function checkCommon(
  spec: { readonly [key: string]: unknown },
  issues: StatIssue[],
  options: { readonly requireTimeField?: boolean; readonly requireField?: boolean } = {},
): void {
  if (typeof spec.goalRevision !== 'number' || !Number.isInteger(spec.goalRevision) || spec.goalRevision < 0) {
    issues.push({ code: 'goal-revision-invalid', field: 'goalRevision', message: 'goalRevision must be a non-negative integer' })
  }
  if (typeof spec.resourceRef !== 'string' || !RESOURCE_REF_PATTERN.test(spec.resourceRef)) {
    issues.push({ code: 'ref-invalid', field: 'resourceRef', message: 'resourceRef must be an exact resource ref res-…@vN' })
  }
  if (options.requireField !== false && stringField(spec, 'field') === undefined) {
    issues.push({ code: 'field-missing', field: 'field', message: 'field names the numeric observation property' })
  }
  if (options.requireTimeField === true && stringField(spec, 'eventTimeField') === undefined) {
    issues.push({ code: 'time-field-missing', field: 'eventTimeField', message: 'eventTimeField names each observation\'s event time property' })
  }
  if (spec.methodVersion !== STATS_METHOD_VERSION) {
    issues.push({ code: 'method-version-invalid', field: 'methodVersion', message: `methodVersion must be "${STATS_METHOD_VERSION}"` })
  }
}

/** Validate the coverage/holdout pair the pattern specs carry. */
function checkCoverageAndHoldout(spec: { readonly [key: string]: unknown }, issues: StatIssue[]): void {
  const coverage = spec.minCoverage
  if (coverage !== undefined && (typeof coverage !== 'number' || !Number.isFinite(coverage) || coverage <= 0 || coverage > 1)) {
    issues.push({ code: 'coverage-invalid', field: 'minCoverage', message: 'minCoverage must be a number in (0, 1]' })
  }
  const holdout = spec.holdoutBlocks
  if (holdout !== undefined && (typeof holdout !== 'number' || !Number.isInteger(holdout) || holdout < 0 || holdout > 64)) {
    issues.push({ code: 'holdout-invalid', field: 'holdoutBlocks', message: 'holdoutBlocks must be an integer in [0, 64]' })
  }
}

/** Validate the granularity value against the fixed vocabulary. */
function checkGranularity(spec: { readonly [key: string]: unknown }, issues: StatIssue[]): Granularity | undefined {
  const value = spec.granularity
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(GRANULARITIES as readonly string[]).includes(value)) {
    issues.push({ code: 'granularity-unknown', field: 'granularity', message: `granularity must be one of ${GRANULARITIES.join(', ')}` })
    return undefined
  }
  return value as Granularity
}

/**
 * Validate the raw zonal spec input and return every structural issue.
 * @param input - the untrusted spec value (for example raw tool arguments).
 * @returns the issues; empty when the input is structurally valid.
 */
export function validateZonalSpec(input: unknown): readonly StatIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: StatIssue[] = []
  checkCommon(input, issues)
  const denominator = input.denominatorField
  if (denominator !== undefined && stringField(input, 'denominatorField') === undefined) {
    issues.push({ code: 'denominator-invalid', field: 'denominatorField', message: 'denominatorField must be a non-empty property name' })
  }
  if (input.zoneField !== undefined && stringField(input, 'zoneField') === undefined) {
    issues.push({ code: 'zone-invalid', field: 'zoneField', message: 'zoneField must be a non-empty property name' })
  }
  return issues
}

/** The weight/standardization/permutation/testing block shared by the weighted specs. */
function checkWeighted(
  spec: { readonly [key: string]: unknown },
  issues: StatIssue[],
): {
  weights?: WeightSpec | undefined
  standardization?: Standardization | undefined
  permutations?: number | undefined
  seed?: number | undefined
  multipleTesting?: MultipleTesting | undefined
} {
  const weightsRaw = spec.weights
  let weights: WeightSpec | undefined
  if (!isRecord(weightsRaw)) {
    issues.push({ code: 'weight-invalid', field: 'weights', message: 'weights must be { kind: "distance-band", bandMeters }' })
  } else if (weightsRaw.kind !== 'distance-band'
    || typeof weightsRaw.bandMeters !== 'number'
    || !Number.isFinite(weightsRaw.bandMeters)
    || weightsRaw.bandMeters <= 0
    || weightsRaw.bandMeters > MAX_BAND_METERS) {
    issues.push({ code: 'weight-invalid', field: 'weights.bandMeters', message: `weights must be a distance-band with bandMeters in (0, ${MAX_BAND_METERS}]` })
  } else {
    weights = { kind: 'distance-band', bandMeters: weightsRaw.bandMeters }
  }
  // Standardization is required on every weighted spec: the tool layer fills
  // its declared default into the resolved spec before validation.
  let standardization: Standardization | undefined
  if (spec.standardization === 'row' || spec.standardization === 'binary') {
    standardization = spec.standardization
  } else {
    issues.push({ code: 'standardization-unknown', field: 'standardization', message: 'standardization must be row or binary' })
  }
  let permutations: number | undefined
  if (spec.permutations !== undefined) {
    if (typeof spec.permutations !== 'number' || !Number.isInteger(spec.permutations)
      || spec.permutations < MIN_PERMUTATIONS || spec.permutations > MAX_PERMUTATIONS) {
      issues.push({ code: 'perm-invalid', field: 'permutations', message: `permutations must be an integer in [${MIN_PERMUTATIONS}, ${MAX_PERMUTATIONS}]` })
    } else {
      permutations = spec.permutations
    }
  }
  let seed: number | undefined
  if (spec.seed !== undefined) {
    if (typeof spec.seed !== 'number' || !Number.isInteger(spec.seed) || spec.seed < 0) {
      issues.push({ code: 'seed-invalid', field: 'seed', message: 'seed must be a non-negative integer' })
    } else {
      seed = spec.seed
    }
  }
  let multipleTesting: MultipleTesting | undefined
  if (spec.multipleTesting !== undefined) {
    if (spec.multipleTesting === 'none' || spec.multipleTesting === 'bonferroni' || spec.multipleTesting === 'fdr-bh') {
      multipleTesting = spec.multipleTesting
    } else {
      issues.push({ code: 'testing-invalid', field: 'multipleTesting', message: 'multipleTesting must be none, bonferroni, or fdr-bh' })
    }
  }
  return { weights, standardization, permutations, seed, multipleTesting }
}

/** Validate the raw autocorrelation spec input and return every structural issue. */
export function validateAutocorrelationSpec(input: unknown): readonly StatIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: StatIssue[] = []
  checkCommon(input, issues)
  checkWeighted(input, issues)
  return issues
}

/** Validate the raw hotspot spec input and return every structural issue. */
export function validateHotspotSpec(input: unknown): readonly StatIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: StatIssue[] = []
  checkCommon(input, issues)
  checkWeighted(input, issues)
  return issues
}

/** Validate one spatial block size the change/cluster specs carry. */
function checkBlockMeters(spec: { readonly [key: string]: unknown }, issues: StatIssue[]): void {
  const value = spec.blockMeters
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_BAND_METERS) {
    issues.push({ code: 'flow-invalid', field: 'blockMeters', message: `blockMeters must be a positive number up to ${MAX_BAND_METERS}` })
  }
}

/** Validate the raw change spec input and return every structural issue. */
export function validateChangeSpec(input: unknown): readonly StatIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: StatIssue[] = []
  checkCommon(input, issues, { requireTimeField: true })
  const window = checkWindow(input.window, 'window')
  if (window.issue !== undefined) issues.push(window.issue)
  const baseline = checkWindow(input.baselineWindow, 'baselineWindow')
  if (baseline.issue !== undefined) issues.push(baseline.issue)
  const comparison = checkWindow(input.comparisonWindow, 'comparisonWindow')
  if (comparison.issue !== undefined) issues.push(comparison.issue)
  if (window.window !== undefined) {
    if (baseline.window !== undefined) {
      const issue = nestedWindow(window.window, baseline.window, 'baselineWindow')
      if (issue !== undefined) issues.push(issue)
    }
    if (comparison.window !== undefined) {
      const issue = nestedWindow(window.window, comparison.window, 'comparisonWindow')
      if (issue !== undefined) issues.push(issue)
    }
  }
  if (baseline.window !== undefined && comparison.window !== undefined) {
    const issue = orderedWindows(baseline.window, comparison.window, 'comparisonWindow')
    if (issue !== undefined) issues.push(issue)
  }
  checkGranularity(input, issues)
  checkCoverageAndHoldout(input, issues)
  checkBlockMeters(input, issues)
  if (input.unitField !== undefined && stringField(input, 'unitField') === undefined) {
    issues.push({ code: 'zone-invalid', field: 'unitField', message: 'unitField must be a non-empty property name' })
  }
  return issues
}

/** Validate the raw cluster spec input and return every structural issue. */
export function validateClusterSpec(input: unknown): readonly StatIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: StatIssue[] = []
  checkCommon(input, issues, { requireTimeField: true })
  const window = checkWindow(input.window, 'window')
  if (window.issue !== undefined) issues.push(window.issue)
  checkGranularity(input, issues)
  checkCoverageAndHoldout(input, issues)
  const epsMeters = input.epsMeters
  if (typeof epsMeters !== 'number' || !Number.isFinite(epsMeters) || epsMeters <= 0 || epsMeters > MAX_BAND_METERS) {
    issues.push({ code: 'cluster-invalid', field: 'epsMeters', message: `epsMeters must be a positive number up to ${MAX_BAND_METERS}` })
  }
  if (typeof input.epsBins !== 'number' || !Number.isInteger(input.epsBins) || input.epsBins < 0 || input.epsBins > 4096) {
    issues.push({ code: 'cluster-invalid', field: 'epsBins', message: 'epsBins must be an integer in [0, 4096]' })
  }
  if (typeof input.minPts !== 'number' || !Number.isInteger(input.minPts) || input.minPts < 2 || input.minPts > 256) {
    issues.push({ code: 'cluster-invalid', field: 'minPts', message: 'minPts must be an integer in [2, 256]' })
  }
  checkBlockMeters(input, issues)
  return issues
}

/** Validate the raw flow spec input and return every structural issue. */
export function validateFlowSpec(input: unknown): readonly StatIssue[] {
  if (!isRecord(input)) return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  const issues: StatIssue[] = []
  checkCommon(input, issues, { requireTimeField: true, requireField: false })
  if (stringField(input, 'entityField') === undefined) {
    issues.push({ code: 'entity-field-missing', field: 'entityField', message: 'entityField names the moving entity property' })
  }
  const window = checkWindow(input.window, 'window')
  if (window.issue !== undefined) issues.push(window.issue)
  checkGranularity(input, issues)
  checkCoverageAndHoldout(input, issues)
  const cellMeters = input.cellMeters
  if (typeof cellMeters !== 'number' || !Number.isFinite(cellMeters) || cellMeters <= 0 || cellMeters > MAX_BAND_METERS) {
    issues.push({ code: 'flow-invalid', field: 'cellMeters', message: `cellMeters must be a positive number up to ${MAX_BAND_METERS}` })
  }
  if (input.maxGapBins !== undefined && (typeof input.maxGapBins !== 'number' || !Number.isInteger(input.maxGapBins) || input.maxGapBins < 0 || input.maxGapBins > 4096)) {
    issues.push({ code: 'flow-invalid', field: 'maxGapBins', message: 'maxGapBins must be an integer in [0, 4096]' })
  }
  if (input.topK !== undefined && (typeof input.topK !== 'number' || !Number.isInteger(input.topK) || input.topK < 1 || input.topK > 256)) {
    issues.push({ code: 'flow-invalid', field: 'topK', message: 'topK must be an integer in [1, 256]' })
  }
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
export function statSpecDigestOf(spec: StatSpec | PatternSpec): string {
  return createHash('sha256').update(canonicalJson(spec), 'utf8').digest('hex')
}
