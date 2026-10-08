/**
 * The forecast computations: `validate` (a time-forward holdout against the
 * declared simple baseline, with spatial-block validation rows and empirical
 * interval coverage), `fit` (the selected linear, threshold, or quadratic-ridge family through the training
 * cutoff, published as a model artifact), and `predict` (per-row predictions
 * with intervals, feature-availability enforcement, out-of-domain flags, and
 * drift detection). Every result names its baseline: a forecast only means
 * something beside the naive answer. Concurrent features are refused wherever
 * a value would have to exist before it is observed — validation and
 * prediction fail loud instead of leaking future information.
 *
 * @module @map-harness/spatial-decision/forecast
 */
import type { LonLat } from '@map-harness/spatial-statistics'
import {
  DECISION_METHOD_VERSION,
  GRANULARITIES,
  MAX_ANALYSIS_ROWS,
  type ForecastModelFamily,
  type ForecastPredictSpec,
  type ForecastSpec,
  type Granularity,
} from './contract.ts'
import { DecisionError } from './errors.ts'
import { invertMatrix, isFiniteNumber, olsFit, solveLinear, tQuantile, type OlsFit } from './linalg.ts'
import type { DecisionPublish, RowAccounting } from './attribution.ts'

/** One prepared forecast row: an event time plus the numeric field values. */
export interface ForecastRow {
  readonly id: string
  readonly coordinates: LonLat
  readonly timeMs: number
  /** Numeric fields read off the feature properties, keyed by field name. */
  readonly values: Readonly<Record<string, number | undefined>>
}

/** The feature envelope and drift baseline one fitted model carries per field. */
export interface ForecastEnvelope {
  readonly min: number
  readonly max: number
  readonly mean: number
  readonly sd: number
}

/** The fitted model record: published by `fit`, consumed by `predict`. */
export interface FittedForecastModel {
  readonly kind: 'spatial-decision-forecast-model'
  readonly methodVersion: typeof DECISION_METHOD_VERSION
  readonly specDigest: string
  readonly outcomeField: string
  readonly features: readonly { field: string; availability: string }[]
  readonly window: { from: string; to: string }
  readonly granularity: Granularity
  readonly baseline: 'naive' | 'mean'
  /** The fitted family; absent is tolerated only when reading legacy artifacts. */
  readonly modelFamily: ForecastModelFamily
  readonly intervalLevel: number
  /** Design [1, timeIndex, features…]; `xtxInv` serves the prediction variance. */
  readonly beta: readonly number[]
  readonly xtxInv: readonly (readonly number[])[]
  readonly sigma: number
  readonly df: number
  readonly rSquared: number
  readonly firstBin: number
  readonly trainBins: number
  readonly envelopes: Readonly<Record<string, ForecastEnvelope>>
  /** Per-row last observed outcome the naive baseline predicts from. */
  readonly lastObserved: Readonly<Record<string, { value: number; bin: number }>>
  readonly trainOutcomeMean: number
  /** Design column labels, persisted so model coefficients remain interpretable. */
  readonly designColumns: readonly string[]
  /** Threshold parameters when `modelFamily` is `threshold`. */
  readonly threshold?: {
    readonly feature: string
    readonly split: number
    readonly leftMean: number
    readonly rightMean: number
    readonly minLeafSamples: number
  }
  /** Fixed ridge penalty when `modelFamily` is `quadratic-ridge`. */
  readonly ridgeLambda?: number
}

/** Minimum observations each side of a threshold split must retain. */
export const MIN_THRESHOLD_LEAF_SAMPLES = 2

/** Fixed L2 penalty for the quadratic-ridge family. */
export const QUADRATIC_RIDGE_LAMBDA = 1

/** One validation metric row (model and baseline side by side). */
export interface ForecastMetric {
  readonly mae: number
  readonly rmse: number
}

/** One spatial-block validation row. */
export interface ForecastBlockRow {
  readonly block: string
  readonly rows: number
  readonly modelMae: number
  readonly baselineMae: number
}

/** The time-forward validation evidence. */
export interface ForecastValidationEvidence {
  readonly status: 'succeeded' | 'not_applicable' | 'unknown'
  readonly notApplicableReason?: string | undefined
  readonly limitations: readonly string[]
  readonly modelFamily: ForecastModelFamily
  readonly artifacts: readonly { label: string; ref: string }[]
  readonly accounting: RowAccounting
  readonly trainRows: number
  readonly holdoutRows: number
  readonly holdoutBins: number
  readonly model: ForecastMetric
  readonly baseline: ForecastMetric
  /** 1 − MAE_model / MAE_baseline; `null` when the baseline is perfect. */
  readonly skill: number | null
  /** Empirical fraction of holdout rows inside the declared interval. */
  readonly intervalCoverage: number
  readonly blocks: readonly ForecastBlockRow[]
  readonly lateRows: number
}

/** The fit evidence: the model record and its in-sample identity. */
export interface ForecastFitEvidence {
  readonly status: 'succeeded' | 'not_applicable' | 'unknown'
  readonly notApplicableReason?: string | undefined
  readonly limitations: readonly string[]
  readonly modelFamily: ForecastModelFamily
  readonly artifacts: readonly { label: string; ref: string }[]
  readonly accounting: RowAccounting
  readonly trainRows: number
  readonly rSquared: number
  readonly adjustedRSquared: number
  readonly residualSigma: number
  readonly coefficients: readonly { field: string; beta: number; se: number }[]
  readonly model: FittedForecastModel
}

/** One per-row prediction outcome. */
export interface ForecastPredictionRow {
  readonly id: string
  readonly predicted: number
  readonly low: number
  readonly high: number
  readonly baseline: number
  readonly outOfDomainFeatures: readonly string[]
}

/** The prediction evidence: intervals, baselines, and honest domain flags. */
export interface ForecastPredictionEvidence {
  readonly status: 'succeeded' | 'not_applicable' | 'unknown'
  readonly notApplicableReason?: string | undefined
  readonly limitations: readonly string[]
  readonly modelFamily: ForecastModelFamily
  readonly artifacts: readonly { label: string; ref: string }[]
  readonly accounting: RowAccounting
  readonly horizonBins: number
  readonly rows: readonly ForecastPredictionRow[]
  /** Per-feature drift |mean − trainMean| / trainSd above the limit names the field. */
  readonly driftedFeatures: readonly string[]
  readonly rowsOutOfDomain: number
  readonly modelRef: string
}

/** The feature drift a prediction flags: standardized mean shift over this share of a training sd. */
export const FEATURE_DRIFT_LIMIT = 0.5

/** The UTC bin ordinal one timestamp falls into (day/week anchored to the epoch, month to the calendar). */
export function binIndexOf(timeMs: number, granularity: Granularity): number {
  if (granularity === 'day') return Math.floor(timeMs / 86_400_000)
  if (granularity === 'week') return Math.floor(timeMs / 604_800_000)
  const date = new Date(timeMs)
  return date.getUTCFullYear() * 12 + date.getUTCMonth()
}

/** Admit forecast rows: outcome, time, and — per availability — feature values must be numeric. */
function admitForecastRows(
  rows: readonly ForecastRow[],
  spec: ForecastSpec,
): { outcome: number[]; time: number[]; features: number[][]; coordinates: LonLat[]; ids: string[]; dropped: Record<string, number>; late: number } {
  if (rows.length > MAX_ANALYSIS_ROWS) {
    throw new DecisionError('DECISION_INVALID_INPUT', `the forecast table exceeds the ${MAX_ANALYSIS_ROWS}-row budget`)
  }
  const cutoffMs = new Date(spec.window.to).getTime()
  const fromMs = new Date(spec.window.from).getTime()
  const outcome: number[] = []
  const time: number[] = []
  const features: number[][] = []
  const coordinates: LonLat[] = []
  const ids: string[] = []
  const dropped: Record<string, number> = {}
  let late = 0
  for (const row of rows) {
    const value = row.values[spec.outcomeField]
    const cells = spec.features.map(feature => row.values[feature.field])
    if (!isFiniteNumber(value) || !Number.isFinite(row.timeMs) || cells.some(cell => !isFiniteNumber(cell))) {
      dropped['missing-fields'] = (dropped['missing-fields'] ?? 0) + 1
      continue
    }
    if (row.timeMs < fromMs || row.timeMs >= cutoffMs) {
      late++
      continue
    }
    outcome.push(value)
    time.push(row.timeMs)
    features.push(cells.map(cell => cell as number))
    coordinates.push(row.coordinates)
    ids.push(row.id)
  }
  return { outcome, time, features, coordinates, ids, dropped, late }
}

/** The bin ordinals of the admitted rows. */
function binsOf(times: readonly number[], granularity: Granularity): number[] {
  return times.map(time => binIndexOf(time, granularity))
}

/** Envelope statistics of one numeric sample. */
function envelopeOf(values: readonly number[]): ForecastEnvelope {
  const min = Math.min(...values)
  const max = Math.max(...values)
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const sd = values.length > 1
    ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1))
    : 0
  return { min, max, mean, sd }
}

interface ForecastFitCore {
  readonly family: ForecastModelFamily
  readonly fit: OlsFit
  readonly firstBin: number
  readonly designColumns: readonly string[]
  readonly designRow: (features: readonly number[], bin: number) => number[]
  readonly threshold?: FittedForecastModel['threshold']
}

/** Ridge fit for the explicit quadratic design. The intercept is unpenalized. */
function quadraticRidgeFit(
  design: readonly (readonly number[])[],
  outcome: readonly number[],
  lambda: number,
): OlsFit | undefined {
  const n = outcome.length
  const p = design[0]?.length ?? 0
  if (n === 0 || p === 0 || design.some(row => row.length !== p)) return undefined
  const xtx: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0))
  const xty = new Array<number>(p).fill(0)
  for (let i = 0; i < n; i++) {
    const row = design[i]
    if (row === undefined) return undefined
    for (let a = 0; a < p; a++) {
      xty[a] = (xty[a] ?? 0) + (row[a] ?? 0) * (outcome[i] ?? 0)
      for (let b = 0; b < p; b++) {
        xtx[a]![b] = (xtx[a]?.[b] ?? 0) + (row[a] ?? 0) * (row[b] ?? 0)
      }
    }
  }
  for (let diagonal = 1; diagonal < p; diagonal++) {
    xtx[diagonal]![diagonal] = (xtx[diagonal]?.[diagonal] ?? 0) + lambda
  }
  const xtxInv = invertMatrix(xtx)
  const beta = solveLinear(xtx, xty)
  if (xtxInv === undefined || beta === undefined) return undefined
  const fitted = design.map(row => row.reduce((sum, value, col) => sum + value * (beta[col] ?? 0), 0))
  const mean = outcome.reduce((sum, value) => sum + value, 0) / n
  let rss = 0
  let tss = 0
  for (let i = 0; i < n; i++) {
    rss += ((outcome[i] ?? 0) - (fitted[i] ?? 0)) ** 2
    tss += ((outcome[i] ?? 0) - mean) ** 2
  }
  const df = Math.max(1, n - p)
  const sigma2 = rss / df
  return {
    beta,
    xtxInv,
    sigma: Math.sqrt(sigma2),
    df,
    fitted,
    se: beta.map((_, col) => Math.sqrt(Math.max(0, sigma2 * (xtxInv[col]?.[col] ?? 0)))),
    rSquared: tss > 0 ? 1 - rss / tss : 0,
  }
}

/** Build and fit one forecast family; all callers share this exact expansion. */
function fitForecastFamily(
  spec: ForecastSpec,
  outcome: readonly number[],
  features: readonly (readonly number[])[],
  bins: readonly number[],
): ForecastFitCore | undefined {
  const family: ForecastModelFamily = spec.modelFamily ?? 'linear'
  const firstBin = bins.length > 0 ? Math.min(...bins) : 0
  if (family === 'linear') {
    const designColumns = ['intercept', 'time', ...spec.features.map(feature => feature.field)]
    const designRow = (values: readonly number[], bin: number) => [1, bin - firstBin, ...values]
    const fit = olsFit(features.map((values, index) => designRow(values, bins[index] ?? firstBin)), outcome)
    return fit === undefined ? undefined : { family, fit, firstBin, designColumns, designRow }
  }
  if (family === 'quadratic-ridge') {
    const designColumns = [
      'intercept', 'time', 'time^2',
      ...spec.features.map(feature => feature.field),
      ...spec.features.map(feature => `${feature.field}^2`),
    ]
    const designRow = (values: readonly number[], bin: number) => {
      const time = bin - firstBin
      return [1, time, time ** 2, ...values, ...values.map(value => value ** 2)]
    }
    const fit = quadraticRidgeFit(features.map((values, index) => designRow(values, bins[index] ?? firstBin)), outcome, QUADRATIC_RIDGE_LAMBDA)
    return fit === undefined ? undefined : { family, fit, firstBin, designColumns, designRow }
  }
  // Threshold is a one-split model. Candidate fields and split points are
  // searched deterministically; the selected field is persisted in the model.
  if (outcome.length < MIN_THRESHOLD_LEAF_SAMPLES * 2) return undefined
  let best: { fit: OlsFit; feature: number; split: number; leftMean: number; rightMean: number; sse: number } | undefined
  for (let feature = 0; feature < spec.features.length; feature++) {
    const values = features.map(row => row[feature] ?? Number.NaN)
    const unique = [...new Set(values)].filter(Number.isFinite).sort((a, b) => a - b)
    for (let i = 0; i + 1 < unique.length; i++) {
      const low = unique[i]
      const high = unique[i + 1]
      if (low === undefined || high === undefined || low === high) continue
      const split = (low + high) / 2
      const left = values.reduce<number[]>((acc, value, index) => {
        if (value <= split) acc.push(index)
        return acc
      }, [])
      const right = values.length - left.length
      if (left.length < MIN_THRESHOLD_LEAF_SAMPLES || right < MIN_THRESHOLD_LEAF_SAMPLES) continue
      const design = values.map(value => [1, value > split ? 1 : 0])
      const fit = olsFit(design, outcome)
      if (fit === undefined) continue
      const sse = fit.fitted.reduce((sum, predicted, index) => sum + ((outcome[index] ?? 0) - predicted) ** 2, 0)
      const leftMean = left.reduce((sum, index) => sum + (outcome[index] ?? 0), 0) / left.length
      const rightMean = (outcome.reduce((sum, value) => sum + value, 0) - left.reduce((sum, index) => sum + (outcome[index] ?? 0), 0)) / right
      if (best === undefined || sse < best.sse - 1e-12
        || (Math.abs(sse - best.sse) <= 1e-12 && (feature < best.feature || (feature === best.feature && split < best.split)))) {
        best = { fit, feature, split, leftMean, rightMean, sse }
      }
    }
  }
  if (best === undefined) return undefined
  const selected = spec.features[best.feature]
  if (selected === undefined) return undefined
  const designColumns = ['intercept', `threshold:${selected.field}`]
  const designRow = (values: readonly number[]) => [1, (values[best.feature] ?? Number.NaN) > best.split ? 1 : 0]
  return {
    family,
    fit: best.fit,
    firstBin,
    designColumns,
    designRow: (values) => designRow(values),
    threshold: {
      feature: selected.field,
      split: best.split,
      leftMean: best.leftMean,
      rightMean: best.rightMean,
      minLeafSamples: MIN_THRESHOLD_LEAF_SAMPLES,
    },
  }
}

/** Build a design row from serialized model metadata for prediction. */
function serializedDesignRow(model: FittedForecastModel, values: readonly number[], bin: number): number[] {
  const family = model.modelFamily ?? 'linear'
  // Prediction passes the absolute model bin so this remains correct when the
  // training window starts far after the Unix epoch.
  if (family === 'linear') return [1, bin - model.firstBin, ...values]
  if (family === 'quadratic-ridge') {
    const time = bin - model.firstBin
    return [1, time, time ** 2, ...values, ...values.map(value => value ** 2)]
  }
  const selected = model.features.findIndex(feature => feature.field === model.threshold?.feature)
  const indicator = selected >= 0 && (values[selected] ?? Number.NaN) > (model.threshold?.split ?? Number.NaN) ? 1 : 0
  return [1, indicator]
}

/**
 * Run the time-forward holdout validation against the declared baseline.
 * Refuses `concurrent` features: their holdout values would not have existed
 * at the training cutoff, so evaluating on them is leakage.
 * @param rows - the prepared historical rows.
 * @param spec - the validated forecast spec.
 * @param publish - the artifact seam the per-row table publishes through.
 * @returns the validation evidence.
 */
export async function computeForecastValidation(
  rows: readonly ForecastRow[],
  spec: ForecastSpec,
  publish: DecisionPublish,
): Promise<ForecastValidationEvidence> {
  if (spec.features.some(feature => feature.availability === 'concurrent')) {
    throw new DecisionError(
      'DECISION_INVALID_INPUT',
      'a concurrent feature cannot be evaluated time-forward: its holdout values would not have existed at the training cutoff (leakage). Declare it known-at-origin or drop it',
    )
  }
  const admitted = admitForecastRows(rows, spec)
  const { outcome, time, features, coordinates, ids, dropped, late } = admitted
  const limitations = [
    `skill is relative to the declared ${spec.baseline} baseline; no forecast claims usefulness without beating it`,
    'the interval coverage is empirical over the holdout rows, not a guarantee for future windows',
    'spatial-block MAE spread reports transferability across space, not across time',
    `model family: ${spec.modelFamily ?? 'linear'}`,
  ]
  const artifacts: { label: string; ref: string }[] = []
  const accounting: RowAccounting = {
    used: outcome.length,
    droppedByReason: { ...dropped, ...(late > 0 ? { 'outside-training-window': late } : {}) },
  }
  const bins = binsOf(time, spec.granularity)
  const distinctBins = [...new Set(bins)].sort((a, b) => a - b)
  if (outcome.length < 8 || distinctBins.length < spec.holdoutSteps + 2) {
    return {
      status: 'not_applicable',
      notApplicableReason: 'time-coverage-insufficient',
      limitations,
      modelFamily: spec.modelFamily ?? 'linear',
      artifacts,
      accounting,
      trainRows: 0,
      holdoutRows: 0,
      holdoutBins: 0,
      model: { mae: Number.NaN, rmse: Number.NaN },
      baseline: { mae: Number.NaN, rmse: Number.NaN },
      skill: null,
      intervalCoverage: 0,
      blocks: [],
      lateRows: late,
    }
  }
  const holdoutSet = new Set(distinctBins.slice(-spec.holdoutSteps))
  const trainIdx: number[] = []
  const holdIdx: number[] = []
  bins.forEach((bin, index) => {
    if (holdoutSet.has(bin)) holdIdx.push(index)
    else trainIdx.push(index)
  })
  const trainY = trainIdx.map(index => outcome[index] ?? 0)
  const familyFit = fitForecastFamily(
    spec,
    trainY,
    trainIdx.map(index => features[index] ?? []),
    trainIdx.map(index => bins[index] ?? 0),
  )
  if (familyFit === undefined) {
    return {
      status: 'not_applicable',
      notApplicableReason: 'no-factor-variation',
      limitations,
      modelFamily: spec.modelFamily ?? 'linear',
      artifacts,
      accounting,
      trainRows: trainIdx.length,
      holdoutRows: holdIdx.length,
      holdoutBins: holdoutSet.size,
      model: { mae: Number.NaN, rmse: Number.NaN },
      baseline: { mae: Number.NaN, rmse: Number.NaN },
      skill: null,
      intervalCoverage: 0,
      blocks: [],
      lateRows: late,
    }
  }
  const { fit, designRow: familyDesignRow } = familyFit
  // Baseline predictions from the training bins only.
  const trainBins = trainIdx.map(index => bins[index] ?? 0)
  const lastTrainBin = Math.max(...trainBins)
  const lastBinIndexes = trainIdx.filter((_, position) => trainBins[position] === lastTrainBin)
  const naiveValue = lastBinIndexes.reduce((s, index) => s + (outcome[index] ?? 0), 0) / Math.max(1, lastBinIndexes.length)
  const trainMean = trainY.reduce((s, v) => s + v, 0) / trainY.length
  const baselineOf = () => (spec.baseline === 'naive' ? naiveValue : trainMean)
  // Holdout evaluation with intervals and per-spatial-block accumulation.
  const critical = tQuantile((1 + spec.intervalLevel) / 2, fit.df)
  let absModel = 0
  let sqModel = 0
  let absBase = 0
  let sqBase = 0
  let covered = 0
  const rowTable: Record<string, unknown>[] = []
  const blocks = new Map<string, { modelAbs: number; baseAbs: number; rows: number }>()
  for (const index of holdIdx) {
    const x = familyDesignRow(features[index] ?? [], bins[index] ?? 0)
    const predicted = x.reduce((s, value, col) => s + value * (fit.beta[col] ?? 0), 0)
    const xtxRow = x.map((_, a) => x.reduce((s, value, b) => s + value * (fit.xtxInv[b]?.[a] ?? 0), 0))
    const leverage = x.reduce((s, value, col) => s + value * (xtxRow[col] ?? 0), 0)
    const width = critical * fit.sigma * Math.sqrt(1 + leverage)
    const base = baselineOf()
    const observed = outcome[index] ?? 0
    absModel += Math.abs(observed - predicted)
    sqModel += (observed - predicted) ** 2
    absBase += Math.abs(observed - base)
    sqBase += (observed - base) ** 2
    if (observed >= predicted - width && observed <= predicted + width) covered++
    rowTable.push({ id: ids[index] ?? '', predicted, low: predicted - width, high: predicted + width, baseline: base, observed })
    const block = `b${Math.floor((coordinates[index]?.[0] ?? 0) / spec.blockMeters)}:${Math.floor((coordinates[index]?.[1] ?? 0) / spec.blockMeters)}`
    const entry = blocks.get(block) ?? { modelAbs: 0, baseAbs: 0, rows: 0 }
    entry.modelAbs += Math.abs(observed - predicted)
    entry.baseAbs += Math.abs(observed - base)
    entry.rows++
    blocks.set(block, entry)
  }
  const holdoutCount = Math.max(1, holdIdx.length)
  const modelMetric = { mae: absModel / holdoutCount, rmse: Math.sqrt(sqModel / holdoutCount) }
  const baselineMetric = { mae: absBase / holdoutCount, rmse: Math.sqrt(sqBase / holdoutCount) }
  const blockRows: ForecastBlockRow[] = [...blocks.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([block, entry]) => ({
      block,
      rows: entry.rows,
      modelMae: entry.modelAbs / Math.max(1, entry.rows),
      baselineMae: entry.baseAbs / Math.max(1, entry.rows),
    }))
  artifacts.push({ label: 'validation-table', ref: (await publish('validation-table', new TextEncoder().encode(JSON.stringify({ kind: 'forecast-validation', methodVersion: spec.methodVersion, rows: rowTable })))).ref })
  return {
    status: 'succeeded',
    limitations,
    modelFamily: familyFit.family,
    artifacts,
    accounting,
    trainRows: trainIdx.length,
    holdoutRows: holdIdx.length,
    holdoutBins: holdoutSet.size,
    model: modelMetric,
    baseline: baselineMetric,
    skill: baselineMetric.mae > 0 ? 1 - modelMetric.mae / baselineMetric.mae : null,
    intervalCoverage: covered / holdoutCount,
    blocks: blockRows,
    lateRows: late,
  }
}

/**
 * Fit the model through the training cutoff and return the publishable model
 * record. Concurrent features are allowed here — the fit is in-sample — and
 * the returned model records them so `predict` can refuse.
 * @param rows - the prepared historical rows.
 * @param spec - the validated forecast spec.
 * @param specDigest - the canonical digest of the resolved spec.
 * @param publish - the artifact seam the model record publishes through.
 * @returns the fit evidence carrying the fitted model.
 */
export async function computeForecastFit(
  rows: readonly ForecastRow[],
  spec: ForecastSpec,
  specDigest: string,
  publish: DecisionPublish,
): Promise<ForecastFitEvidence> {
  const admitted = admitForecastRows(rows, spec)
  const { outcome, time, features, ids, dropped, late } = admitted
  const family: ForecastModelFamily = spec.modelFamily ?? 'linear'
  const limitations = [
    family === 'linear'
      ? 'the model is a linear trend-plus-features fit through the declared training cutoff; it extrapolates linearly and says nothing beyond its support'
      : family === 'threshold'
        ? 'the model is a single-feature, single-split threshold fit; it is piecewise constant and cannot represent multiple breakpoints'
        : 'the model uses explicit time and feature squares with fixed ridge penalty 1; quadratic extrapolation can still be unstable outside support',
    'in-sample R² is not predictive skill; run forecast_validate against the baseline before relying on the model',
    spec.features.some(feature => feature.availability === 'concurrent')
      ? 'the model uses concurrent features: forecast_predict will refuse because their future values are unknowable'
    : 'feature values at the prediction origin must genuinely be known when the forecast is issued',
    `model family: ${family}`,
  ]
  const artifacts: { label: string; ref: string }[] = []
  const accounting: RowAccounting = {
    used: outcome.length,
    droppedByReason: { ...dropped, ...(late > 0 ? { 'outside-training-window': late } : {}) },
  }
  const bins = binsOf(time, spec.granularity)
  const familyFit = fitForecastFamily(spec, outcome, features, bins)
  if (familyFit === undefined || outcome.length < 4) {
    throw new DecisionError('DECISION_STATE', 'the training table cannot support the declared model (singular design or too few rows); forecast_validate the window first')
  }
  const { fit, firstBin, designColumns, threshold } = familyFit
  const envelopes: Record<string, ForecastEnvelope> = {}
  spec.features.forEach((feature, f) => {
    envelopes[feature.field] = envelopeOf(features.map(row => row[f] ?? 0))
  })
  // Per-row last observed outcome for the naive baseline at prediction time.
  const lastObserved: Record<string, { value: number; bin: number }> = {}
  ids.forEach((id, index) => {
    const bin = bins[index] ?? 0
    const existing = lastObserved[id]
    if (existing === undefined || bin >= existing.bin) {
      lastObserved[id] = { value: outcome[index] ?? 0, bin }
    }
  })
  const trainMean = outcome.reduce((s, v) => s + v, 0) / outcome.length
  const model: FittedForecastModel = {
    kind: 'spatial-decision-forecast-model',
    methodVersion: DECISION_METHOD_VERSION,
    specDigest,
    outcomeField: spec.outcomeField,
    features: spec.features.map(feature => ({ field: feature.field, availability: feature.availability })),
    window: { from: spec.window.from, to: spec.window.to },
    granularity: spec.granularity,
    baseline: spec.baseline,
    modelFamily: familyFit.family,
    intervalLevel: spec.intervalLevel,
    beta: fit.beta,
    xtxInv: fit.xtxInv,
    sigma: fit.sigma,
    df: fit.df,
    rSquared: fit.rSquared,
    firstBin,
    trainBins: Math.max(...bins) - firstBin + 1,
    envelopes,
    lastObserved,
    trainOutcomeMean: trainMean,
    designColumns,
    ...(threshold === undefined ? {} : { threshold }),
    ...(familyFit.family === 'quadratic-ridge' ? { ridgeLambda: QUADRATIC_RIDGE_LAMBDA } : {}),
  }
  artifacts.push({ label: 'forecast-model', ref: (await publish('forecast-model', new TextEncoder().encode(JSON.stringify(model)))).ref })
  return {
    status: 'succeeded',
    limitations,
    modelFamily: familyFit.family,
    artifacts,
    accounting,
    trainRows: outcome.length,
    rSquared: fit.rSquared,
    adjustedRSquared: fit.df > 0 ? 1 - (1 - fit.rSquared) * (outcome.length - 1) / fit.df : 0,
    residualSigma: fit.sigma,
    coefficients: familyFit.family === 'linear'
      ? spec.features.map((feature, index) => ({
        field: feature.field,
        beta: fit.beta[index + 2] ?? 0,
        se: fit.se[index + 2] ?? 0,
      }))
      : designColumns.slice(1).map((field, index) => ({
        field,
        beta: fit.beta[index + 1] ?? 0,
        se: fit.se[index + 1] ?? 0,
      })),
    model,
  }
}

/**
 * Predict one horizon ahead from a fitted model over prediction-origin rows.
 * Concurrent features, method-version drift, and level changes are loud
 * refusals; out-of-domain feature values and drifted feature means are named
 * flags, never silently ignored.
 * @param rows - the prepared prediction-origin rows (features only; outcomes are not read).
 * @param model - the fitted model record (already read from its artifact).
 * @param spec - the validated prediction spec.
 * @param publish - the artifact seam the prediction table publishes through.
 * @returns the prediction evidence.
 */
export async function computeForecastPredict(
  rows: readonly ForecastRow[],
  model: FittedForecastModel,
  spec: ForecastPredictSpec,
  publish: DecisionPublish,
): Promise<ForecastPredictionEvidence> {
  if (model.methodVersion !== DECISION_METHOD_VERSION) {
    throw new DecisionError('DECISION_INVALID_INPUT', `the model was fitted by ${model.methodVersion}; this build computes ${DECISION_METHOD_VERSION} and will not reuse it`)
  }
  if (model.features.some(feature => feature.availability === 'concurrent')) {
    throw new DecisionError('DECISION_INVALID_INPUT', `the model uses concurrent feature(s) ${model.features.filter(feature => feature.availability === 'concurrent').map(feature => feature.field).join(', ')} whose future values are unknowable; prediction is refused`)
  }
  const family: ForecastModelFamily = model.modelFamily ?? 'linear'
  const dropped: Record<string, number> = {}
  const featureNames = model.features.map(feature => feature.field)
  const rowsUsed: { id: string; x: number[]; values: number[]; outOfDomain: string[] }[] = []
  for (const row of rows) {
    const cells = featureNames.map(field => row.values[field])
    if (cells.some(cell => !isFiniteNumber(cell))) {
      dropped['missing-fields'] = (dropped['missing-fields'] ?? 0) + 1
      continue
    }
    const outOfDomain = featureNames.filter((field, f) => {
      const envelope = model.envelopes[field]
      const value = cells[f] as number
      return envelope !== undefined && (value < envelope.min || value > envelope.max)
    })
    const numericCells = cells.map(cell => cell as number)
    rowsUsed.push({
      id: row.id,
      x: serializedDesignRow(model, numericCells, model.firstBin + model.trainBins - 1 + spec.horizonSteps),
      values: numericCells,
      outOfDomain,
    })
  }
  if (rowsUsed.length === 0) {
    throw new DecisionError('DECISION_STATE', 'the prediction table has no row with every feature present')
  }
  // Feature drift between the prediction-origin rows and the training envelopes.
  const driftedFeatures = featureNames.filter((field, f) => {
    const envelope = model.envelopes[field]
    if (envelope === undefined || envelope.sd === 0 || rowsUsed.length === 0) return false
    const mean = rowsUsed.reduce((s, row) => s + (row.values[f] ?? 0), 0) / rowsUsed.length
    return Math.abs(mean - envelope.mean) / envelope.sd > FEATURE_DRIFT_LIMIT
  })
  const critical = tQuantile((1 + spec.intervalLevel) / 2, model.df)
  const predictionRows: ForecastPredictionRow[] = rowsUsed.map(row => {
    const predicted = row.x.reduce((s, value, col) => s + value * (model.beta[col] ?? 0), 0)
    const xtxRow = row.x.map((_, a) => row.x.reduce((s, value, b) => s + value * (model.xtxInv[b]?.[a] ?? 0), 0))
    const leverage = row.x.reduce((s, value, col) => s + value * (xtxRow[col] ?? 0), 0)
    const width = critical * model.sigma * Math.sqrt(1 + leverage)
    const last = model.lastObserved[row.id]
    const baseline = model.baseline === 'naive'
      ? (last !== undefined ? last.value : model.trainOutcomeMean)
      : model.trainOutcomeMean
    return { id: row.id, predicted, low: predicted - width, high: predicted + width, baseline, outOfDomainFeatures: row.outOfDomain }
  })
  const limitations = [
    family === 'linear'
      ? `predictions are one linear extrapolation ${spec.horizonSteps} bin(s) past the training cutoff against the ${model.baseline} baseline`
      : family === 'threshold'
        ? `predictions use the selected single-feature threshold ${spec.horizonSteps} bin(s) past the training cutoff against the ${model.baseline} baseline`
        : `predictions use explicit quadratic terms with fixed ridge penalty 1 ${spec.horizonSteps} bin(s) past the training cutoff against the ${model.baseline} baseline`,
    driftedFeatures.length > 0
      ? `feature drift detected: ${driftedFeatures.join(', ')} moved beyond ${FEATURE_DRIFT_LIMIT} training sd — treat the interval as optimistic`
      : 'no feature drifted beyond the declared drift limit',
    'rows flagged out-of-domain fall outside the training feature envelope; their predictions are extrapolations',
  ]
  const artifacts: { label: string; ref: string }[] = []
  artifacts.push({ label: 'prediction-table', ref: (await publish('prediction-table', new TextEncoder().encode(JSON.stringify({ kind: 'forecast-prediction', methodVersion: spec.methodVersion, modelRef: spec.modelRef, rows: predictionRows })))).ref })
  return {
    status: 'succeeded',
    limitations,
    modelFamily: family,
    artifacts,
    accounting: { used: rowsUsed.length, droppedByReason: dropped },
    horizonBins: spec.horizonSteps,
    rows: predictionRows,
    driftedFeatures,
    rowsOutOfDomain: predictionRows.filter(row => row.outOfDomainFeatures.length > 0).length,
    modelRef: spec.modelRef,
  }
}

/** The granularity names one error message names (shared with the contract vocabulary). */
export const FORECAST_GRANULARITIES: readonly string[] = GRANULARITIES
