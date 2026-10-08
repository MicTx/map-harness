/**
 * The spatial statistics computations: zonal summaries over grouped
 * observation units, global Moran's I with its local LISA decomposition, and
 * Getis-Ord Gi* hotspots. Every weighted statistic runs on one seeded
 * permutation test (global: full value permutation; local: conditional
 * permutation around the fixed focal unit) and reports both the permutation
 * spread and the Cliff–Ord randomization standard deviation as independent
 * spread estimates. Applicability refusals return `not_applicable` evidence
 * instead of inventing p-values: too few valid units, an all-constant field,
 * or a band that leaves every unit unconnected. Unit exclusion is named, and
 * the full per-unit tables leave only through the artifact seam.
 *
 * @module @map-harness/spatial-statistics/stats
 */
import {
  ISLAND_RULE,
  MAX_UNITS,
  MIN_WEIGHTED_UNITS,
  STATS_METHOD_VERSION,
  type AutocorrelationSpec,
  type HotspotSpec,
  type NotApplicableReason,
  type Standardization,
  type StatStatus,
  type ZonalSpec,
} from './contract.ts'
import { StatisticsError } from './errors.ts'
import { mulberry32, shuffled } from './rand.ts'
import { buildWeightMatrix, lagOf, type LonLat, type WeightEdge } from './weights.ts'

/** One observation unit a spatial statistic consumes. */
export interface StatUnit {
  readonly id: string
  readonly coordinates: LonLat
  /** The numeric field value; non-finite values never enter a computation. */
  readonly value: number
  /** Optional positive rate denominator (zonal weighted aggregates). */
  readonly denominator?: number
  /** Optional zone label (zonal grouping). */
  readonly zone?: string
}

/** One bounded diagnostic a computation reports. */
export interface StatDiagnostic {
  readonly code: 'observation-invalid' | 'denominator-invalid' | 'island-excluded' | 'constant-zone' | 'rows-truncated'
  readonly unitId?: string
  readonly zone?: string
  readonly message: string
}

/** The artifact seam the caller binds to catalog publication. */
export type StatPublish = (label: string, bytes: Uint8Array) => Promise<{ ref: string }>

/** Shared evidence head every statistic result carries. */
export interface StatEvidenceHead {
  readonly kind: string
  readonly status: StatStatus
  readonly notApplicableReason?: NotApplicableReason
  readonly methodVersion: typeof STATS_METHOD_VERSION
  readonly inputRefs: { readonly resourceRef: string }
  readonly field: string
  readonly unitCount: number
  readonly validCount: number
  readonly diagnostics: readonly StatDiagnostic[]
  readonly limitations: readonly string[]
  readonly artifacts: readonly { readonly label: string; readonly ref: string }[]
}

/** One zone summary row. */
export interface ZonalRow {
  readonly zone: string
  readonly count: number
  readonly validCount: number
  readonly missingCount: number
  readonly sum: number
  readonly mean: number | null
  readonly min: number | null
  readonly max: number | null
  /** Population dispersion (ddof=0); `null` for single-observation zones. */
  readonly std: number | null
  /** Σ(field·denominator)/Σ(denominator); present with a denominator field. */
  readonly weightedMean: number | null
  /** Σ(field)/Σ(denominator); present with a denominator field. */
  readonly rate: number | null
}

/** The zonal evidence record a completed computation returns. */
export interface ZonalEvidence extends StatEvidenceHead {
  readonly kind: 'zonal-summary'
  readonly denominatorField: string | null
  readonly zoneField: string | null
  readonly zones: readonly ZonalRow[]
}

/** One LISA row of the local autocorrelation decomposition. */
export interface LisaRow {
  readonly unitId: string
  readonly z: number
  readonly lag: number
  readonly localI: number
  readonly pseudoP: number
  readonly correctedP: number | null
  readonly classification: 'high-high' | 'low-low' | 'high-low' | 'low-high' | 'not-significant'
}

/** The autocorrelation evidence record a completed computation returns. */
export interface AutocorrelationEvidence extends StatEvidenceHead {
  readonly kind: 'spatial-autocorrelation'
  readonly weights: {
    readonly kind: 'distance-band'
    readonly bandMeters: number
    readonly standardization: Standardization
    readonly s0: number
    readonly islandCount: number
  }
  readonly moranI: number | null
  readonly expectedI: number | null
  readonly zValue: number | null
  readonly pseudoP: number | null
  readonly randomizationSd: number | null
  readonly permutationSd: number | null
  readonly permutation: { readonly count: number; readonly seed: number }
  readonly multipleTesting: AutocorrelationSpec['multipleTesting']
  readonly local: readonly LisaRow[]
}

/** One Gi* row of the hotspot table. */
export interface HotspotRow {
  readonly unitId: string
  readonly giStarZ: number
  readonly pseudoP: number
  readonly correctedP: number | null
  readonly classification: 'hotspot' | 'coldspot' | 'not-significant'
}

/** The hotspot evidence record a completed computation returns. */
export interface HotspotEvidence extends StatEvidenceHead {
  readonly kind: 'hotspot'
  readonly weights: {
    readonly kind: 'distance-band'
    readonly bandMeters: number
    readonly standardization: Standardization
    readonly s0: number
    readonly islandCount: number
  }
  readonly permutation: { readonly count: number; readonly seed: number }
  readonly multipleTesting: HotspotSpec['multipleTesting']
  readonly rows: readonly HotspotRow[]
}

/** The fixed local-significance alpha; a protocol constant, not configuration. */
export const SIGNIFICANCE_ALPHA = 0.05

/** Maximum evidence rows carried inline; the full table leaves through the artifact seam. */
export const MAX_EVIDENCE_ROWS = 256

/** Admit the value-bearing units one statistic consumes; exclusions are named. */
function admitUnits(units: readonly StatUnit[], diagnostics: StatDiagnostic[], options: { requireDenominator?: boolean } = {}): StatUnit[] {
  if (units.length > MAX_UNITS) {
    throw new StatisticsError('STATS_INVALID_INPUT', `unit table exceeds the bounded limit of ${MAX_UNITS} units`)
  }
  const admitted: StatUnit[] = []
  for (const unit of units) {
    if (!Number.isFinite(unit.value)) {
      diagnostics.push({ code: 'observation-invalid', ...(unit.id === undefined ? {} : { unitId: unit.id }), message: 'the unit carries no usable field value and is excluded' })
      continue
    }
    if (options.requireDenominator === true && (unit.denominator === undefined || !Number.isFinite(unit.denominator) || unit.denominator <= 0)) {
      diagnostics.push({ code: 'denominator-invalid', ...(unit.id === undefined ? {} : { unitId: unit.id }), message: 'the unit carries no positive denominator and is excluded from the weighted aggregates' })
      continue
    }
    admitted.push(unit)
  }
  return admitted
}

/** Head fields shared by every evidence the statistics return. */
function evidenceHead<K extends string>(
  kind: K,
  status: StatStatus,
  spec: ZonalSpec | AutocorrelationSpec | HotspotSpec,
  unitCount: number,
  validCount: number,
  diagnostics: readonly StatDiagnostic[],
  limitations: readonly string[],
  artifacts: { label: string; ref: string }[],
): Omit<StatEvidenceHead, 'kind'> & { kind: K } {
  return {
    kind,
    status,
    methodVersion: STATS_METHOD_VERSION,
    inputRefs: { resourceRef: spec.resourceRef },
    field: spec.field,
    unitCount,
    validCount,
    diagnostics,
    limitations,
    artifacts,
  }
}

/** Flag partial status when any admitted unit was excluded on the way. */
function statusFor(excludedCount: number): StatStatus {
  return excludedCount > 0 ? 'partial' : 'succeeded'
}

/**
 * Summarize one field per zone (the whole area when the spec declares no
 * zone field). The denominator field enables the weighted mean and the
 * sum-rate; units without a usable denominator are excluded from those
 * aggregates only, and named.
 * @param units - the resource's observation units.
 * @param spec - the validated zonal spec.
 * @param publish - the optional artifact seam (per-zone full table).
 * @returns the zonal evidence; `not_applicable` with no valid unit.
 */
export async function computeZonal(
  units: readonly StatUnit[],
  spec: ZonalSpec,
  publish?: StatPublish,
): Promise<ZonalEvidence> {
  const diagnostics: StatDiagnostic[] = []
  const admitted = admitUnits(units, diagnostics)
  const artifacts: { label: string; ref: string }[] = []
  const withDenominator = spec.denominatorField === undefined
    ? admitted
    : admitUnits(admitted, diagnostics, { requireDenominator: true })
  const head = evidenceHead('zonal-summary', 'succeeded', spec, units.length, admitted.length, diagnostics, limitationsFor(spec), artifacts)
  if (admitted.length === 0) {
    return { ...head, status: 'not_applicable', notApplicableReason: 'no-valid-observations', denominatorField: spec.denominatorField ?? null, zoneField: spec.zoneField ?? null, zones: [] }
  }
  const rows = new Map<string, { values: number[]; missing: number; weighted: { num: number; den: number } }>()
  for (const unit of admitted) {
    const zone = unit.zone ?? '—'
    const row = rows.get(zone) ?? { values: [], missing: 0, weighted: { num: 0, den: 0 } }
    row.values.push(unit.value)
    rows.set(zone, row)
  }
  for (const unit of units) {
    if (Number.isFinite(unit.value)) continue
    const zone = unit.zone ?? '—'
    const row = rows.get(zone)
    if (row !== undefined) row.missing += 1
  }
  const zoneRows: ZonalRow[] = [...rows.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([zone, row]) => {
    const values = row.values
    const count = values.length + row.missing
    const sum = values.reduce((total, value) => total + value, 0)
    const mean = values.length > 0 ? sum / values.length : null
    let std: number | null = null
    if (values.length > 1) {
      const variance = values.reduce((total, value) => total + (value - (mean as number)) ** 2, 0) / values.length
      std = Math.sqrt(variance)
    } else if (values.length === 1) {
      diagnostics.push({ code: 'constant-zone', zone, message: 'the zone carries a single observation; its dispersion is not reported' })
    }
    let weightedMean: number | null = null
    let rate: number | null = null
    if (spec.denominatorField !== undefined) {
      const denominated = withDenominator.filter(unit => (unit.zone ?? '—') === zone)
      const denSum = denominated.reduce((total, unit) => total + (unit.denominator ?? 0), 0)
      if (denSum > 0) {
        weightedMean = denominated.reduce((total, unit) => total + unit.value * (unit.denominator ?? 0), 0) / denSum
        rate = sum / denSum
      } else {
        diagnostics.push({ code: 'denominator-invalid', zone, message: 'the zone carries no positive denominator; weighted aggregates are not reported' })
      }
    }
    return {
      zone,
      count,
      validCount: values.length,
      missingCount: row.missing,
      sum,
      mean,
      min: values.length > 0 ? Math.min(...values) : null,
      max: values.length > 0 ? Math.max(...values) : null,
      std,
      weightedMean,
      rate,
    }
  })
  const status = statusFor(units.length - admitted.length)
  if (zoneRows.length > MAX_EVIDENCE_ROWS) {
    diagnostics.push({ code: 'rows-truncated', message: `the zone table carries ${zoneRows.length} rows; the evidence keeps the first ${MAX_EVIDENCE_ROWS} (the artifact keeps all)` })
  }
  const evidence: ZonalEvidence = {
    ...head,
    status,
    denominatorField: spec.denominatorField ?? null,
    zoneField: spec.zoneField ?? null,
    zones: zoneRows.slice(0, MAX_EVIDENCE_ROWS),
  }
  await publishTable(publish, artifacts, 'zonal-table', {
    kind: evidence.kind,
    methodVersion: evidence.methodVersion,
    resourceRef: spec.resourceRef,
    field: spec.field,
    zones: zoneRows,
  })
  return evidence
}

/**
 * Global Moran's I plus the local LISA decomposition under one seeded
 * permutation test. Islands are excluded with a diagnostic before the
 * applicability checks; the local rows use conditional permutation around
 * the fixed focal value; the declared correction applies to the local
 * pseudo p-values.
 * @param units - the resource's observation units.
 * @param spec - the validated autocorrelation spec.
 * @param publish - the optional artifact seam (per-unit full table).
 * @returns the autocorrelation evidence.
 */
export async function computeAutocorrelation(
  units: readonly StatUnit[],
  spec: AutocorrelationSpec,
  publish?: StatPublish,
): Promise<AutocorrelationEvidence> {
  const diagnostics: StatDiagnostic[] = []
  const admitted = admitUnits(units, diagnostics)
  const artifacts: { label: string; ref: string }[] = []
  const limitations = limitationsFor(spec)
  const base = (status: StatStatus, notApplicable?: NotApplicableReason, extra: Partial<AutocorrelationEvidence> = {}): AutocorrelationEvidence => ({
    ...evidenceHead('spatial-autocorrelation', status, spec, units.length, admitted.length, diagnostics, limitations, artifacts),
    weights: { kind: 'distance-band', bandMeters: spec.weights.bandMeters, standardization: spec.standardization, s0: 0, islandCount: 0 },
    moranI: null,
    expectedI: null,
    zValue: null,
    pseudoP: null,
    randomizationSd: null,
    permutationSd: null,
    permutation: { count: spec.permutations, seed: spec.seed },
    multipleTesting: spec.multipleTesting,
    local: [],
    ...(notApplicable === undefined ? {} : { notApplicableReason: notApplicable }),
    ...extra,
  })
  if (admitted.length < MIN_WEIGHTED_UNITS) {
    return base('not_applicable', 'too-few-valid-units')
  }
  const values = admitted.map(unit => unit.value)
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  if (values.every(value => value === mean)) {
    return base('not_applicable', 'constant-field')
  }
  const matrix = buildWeightMatrix(admitted.map(unit => unit.coordinates), spec)
  if (matrix.s0 === 0) {
    return base('not_applicable', 'no-weight-neighbors')
  }
  for (const island of matrix.islandIndexes) {
    const unit = admitted[island]
    diagnostics.push({
      code: 'island-excluded',
      ...(unit === undefined ? {} : { unitId: unit.id }),
      message: `${ISLAND_RULE}: the unit has no neighbor inside the band and is excluded`,
    })
  }
  const kept = admitted.map((unit, index) => ({ unit, index })).filter(({ index }) => !matrix.islandIndexes.includes(index))
  if (kept.length < MIN_WEIGHTED_UNITS) {
    return base('not_applicable', 'too-few-valid-units')
  }
  const keptMatrix = buildWeightMatrix(kept.map(({ unit }) => unit.coordinates), spec)
  const keptValues = kept.map(({ unit }) => unit.value)
  const deviations = keptValues.map(value => value - mean)
  const denom = deviations.reduce((total, z) => total + z * z, 0)
  const n = keptMatrix.n
  const numeratorOf = (zs: readonly number[]): number => {
    let sum = 0
    for (let i = 0; i < n; i++) {
      sum += lagOf(keptMatrix.neighbors[i] ?? [], zs) * (zs[i] ?? 0)
    }
    return sum
  }
  const moranOf = (zs: readonly number[], denomOf: number): number => (n / keptMatrix.s0) * numeratorOf(zs) / denomOf
  const moranI = moranOf(deviations, denom)
  const expectedI = -1 / (n - 1)

  // Global permutation: full value redraws under the frozen matrix.
  const random = mulberry32(spec.seed)
  const permuted: number[] = []
  const pool = [...keptValues]
  for (let run = 0; run < spec.permutations; run++) {
    shuffled(pool, random)
    const zs = pool.map(value => value - mean)
    permuted.push(moranOf(zs, zs.reduce((total, z) => total + z * z, 0)))
  }
  const spread = spreadOf(permuted)
  const extreme = permuted.filter(value => Math.abs(value - expectedI) >= Math.abs(moranI - expectedI) - 1e-12).length
  const pseudoP = (extreme + 1) / (spec.permutations + 1)

  // Local LISA under conditional permutation: the focal value stays fixed,
  // the remaining values are redrawn around it.
  const m2 = denom / n
  const locals: { unitId: string; z: number; lag: number; localI: number }[] = []
  const localP: number[] = []
  for (let i = 0; i < n; i++) {
    const row = keptMatrix.neighbors[i] ?? []
    const zi = deviations[i] ?? 0
    const lag = lagOf(row, deviations)
    const localI = m2 === 0 ? 0 : (zi / m2) * lag
    const restPool = keptValues.filter((_, index) => index !== i)
    let extremeLocal = 0
    for (let run = 0; run < spec.permutations; run++) {
      shuffled(restPool, random)
      const sample = [...restPool]
      sample.splice(i, 0, keptValues[i] as number)
      const lagStar = lagOf(row, sample.map(value => value - mean))
      const iStar = m2 === 0 ? 0 : ((keptValues[i] as number) - mean) / m2 * lagStar
      if (Math.abs(iStar) >= Math.abs(localI) - 1e-12) extremeLocal += 1
    }
    localP.push((extremeLocal + 1) / (spec.permutations + 1))
    locals.push({ unitId: (kept[i] as { unit: StatUnit }).unit.id, z: zi, lag, localI })
  }
  const corrected = correctPValues(localP, spec.multipleTesting)
  const lisaRows: LisaRow[] = locals.map((local, index) => {
    const p = corrected[index] ?? localP[index] ?? 1
    return {
      ...local,
      pseudoP: localP[index] ?? 1,
      correctedP: p,
      classification: p >= SIGNIFICANCE_ALPHA
        ? 'not-significant'
        : local.z > 0 && local.lag > 0 ? 'high-high'
        : local.z < 0 && local.lag < 0 ? 'low-low'
        : local.z > 0 ? 'high-low'
        : 'low-high',
    }
  })

  const status = statusFor(units.length - admitted.length)
  if (lisaRows.length > MAX_EVIDENCE_ROWS) {
    diagnostics.push({ code: 'rows-truncated', message: `the local table carries ${lisaRows.length} rows; the evidence keeps the first ${MAX_EVIDENCE_ROWS} in input order (the artifact keeps all)` })
  }
  const evidence: AutocorrelationEvidence = base(status, undefined, {
    weights: { kind: 'distance-band', bandMeters: spec.weights.bandMeters, standardization: spec.standardization, s0: keptMatrix.s0, islandCount: matrix.islandIndexes.length },
    moranI,
    expectedI,
    zValue: spread.sd > 0 ? (moranI - expectedI) / spread.sd : null,
    pseudoP,
    randomizationSd: randomizationSdOf(n, keptMatrix, values),
    permutationSd: spread.sd,
    local: lisaRows.slice(0, MAX_EVIDENCE_ROWS),
  })
  await publishTable(publish, artifacts, 'autocorrelation-table', {
    kind: evidence.kind,
    methodVersion: evidence.methodVersion,
    resourceRef: spec.resourceRef,
    field: spec.field,
    moranI,
    local: lisaRows.map(row => ({ ...row, correctedP: row.correctedP })),
  })
  return evidence
}

/**
 * Getis-Ord Gi* hotspots under one seeded permutation test. The statistic
 * always includes the focal unit in its neighbor sum (the Gi* form); the
 * declared correction applies to the local pseudo p-values before the
 * fixed-alpha classification.
 * @param units - the resource's observation units.
 * @param spec - the validated hotspot spec.
 * @param publish - the optional artifact seam (per-unit full table).
 * @returns the hotspot evidence.
 */
export async function computeHotspot(
  units: readonly StatUnit[],
  spec: HotspotSpec,
  publish?: StatPublish,
): Promise<HotspotEvidence> {
  const diagnostics: StatDiagnostic[] = []
  const admitted = admitUnits(units, diagnostics)
  const artifacts: { label: string; ref: string }[] = []
  const limitations = limitationsFor(spec)
  const base = (status: StatStatus, notApplicable?: NotApplicableReason, extra: Partial<HotspotEvidence> = {}): HotspotEvidence => ({
    ...evidenceHead('hotspot', status, spec, units.length, admitted.length, diagnostics, limitations, artifacts),
    weights: { kind: 'distance-band', bandMeters: spec.weights.bandMeters, standardization: spec.standardization, s0: 0, islandCount: 0 },
    permutation: { count: spec.permutations, seed: spec.seed },
    multipleTesting: spec.multipleTesting,
    rows: [],
    ...(notApplicable === undefined ? {} : { notApplicableReason: notApplicable }),
    ...extra,
  })
  if (admitted.length < MIN_WEIGHTED_UNITS) {
    return base('not_applicable', 'too-few-valid-units')
  }
  const values = admitted.map(unit => unit.value)
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  if (values.every(value => value === mean)) {
    return base('not_applicable', 'constant-field')
  }
  const matrix = buildWeightMatrix(admitted.map(unit => unit.coordinates), spec)
  if (matrix.s0 === 0) {
    return base('not_applicable', 'no-weight-neighbors')
  }
  for (const island of matrix.islandIndexes) {
    const unit = admitted[island]
    diagnostics.push({
      code: 'island-excluded',
      ...(unit === undefined ? {} : { unitId: unit.id }),
      message: `${ISLAND_RULE}: the unit has no neighbor inside the band and is excluded`,
    })
  }
  const kept = admitted.map((unit, index) => ({ unit, index })).filter(({ index }) => !matrix.islandIndexes.includes(index))
  if (kept.length < MIN_WEIGHTED_UNITS) {
    return base('not_applicable', 'too-few-valid-units')
  }
  // Gi* adds the focal unit to its own neighbor sum before standardization.
  const keptCoordinates = kept.map(({ unit }) => unit.coordinates)
  const keptMatrix = buildWeightMatrix(keptCoordinates, { weights: spec.weights, standardization: 'binary' })
  const selfLooped: WeightEdge[][] = keptMatrix.neighbors.map((row, i) => [{ j: i, w: 1 }, ...row.map(edge => ({ j: edge.j, w: edge.w }))])
  const giS0 = spec.standardization === 'row'
    ? kept.length
    : selfLooped.reduce((sum, row) => sum + row.length, 0)
  if (spec.standardization === 'row') {
    for (let i = 0; i < selfLooped.length; i++) {
      const row = selfLooped[i] as WeightEdge[]
      const total = row.reduce((sum, edge) => sum + edge.w, 0)
      selfLooped[i] = row.map(edge => ({ j: edge.j, w: edge.w / total }))
    }
  }
  const n = kept.length
  const populationSd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n)
  const giZOf = (xs: readonly number[]): number[] => {
    return selfLooped.map((row) => {
      let weighted = 0
      let wi = 0
      let wi2 = 0
      for (const edge of row) {
        weighted += edge.w * (xs[edge.j] ?? 0)
        wi += edge.w
        wi2 += edge.w * edge.w
      }
      const denominator = populationSd * Math.sqrt(Math.max(0, (n * wi2 - wi * wi)) / (n - 1))
      return denominator === 0 ? 0 : (weighted - wi * mean) / denominator
    })
  }
  const observed = giZOf(keptValuesOf(kept))

  // Permutation: full value redraws under the frozen Gi* matrix.
  const random = mulberry32(spec.seed)
  const extremes = new Array<number>(n).fill(0)
  const pool = [...keptValuesOf(kept)]
  for (let run = 0; run < spec.permutations; run++) {
    shuffled(pool, random)
    const zs = giZOf(pool)
    for (const [i, z] of zs.entries()) {
      if (Math.abs(z) >= Math.abs(observed[i] ?? 0) - 1e-12) extremes[i] = (extremes[i] ?? 0) + 1
    }
  }
  const localP = extremes.map(extreme => (extreme + 1) / (spec.permutations + 1))
  const corrected = correctPValues(localP, spec.multipleTesting)
  const rows: HotspotRow[] = kept.map(({ unit }, i): HotspotRow => {
    const z = observed[i] ?? 0
    const p = corrected[i] ?? localP[i] ?? 1
    return {
      unitId: unit.id,
      giStarZ: z,
      pseudoP: localP[i] ?? 1,
      correctedP: p,
      classification: p >= SIGNIFICANCE_ALPHA ? 'not-significant' : z > 0 ? 'hotspot' : 'coldspot',
    }
  }).sort((a, b) => b.giStarZ - a.giStarZ)

  const status = statusFor(units.length - admitted.length)
  if (rows.length > MAX_EVIDENCE_ROWS) {
    diagnostics.push({ code: 'rows-truncated', message: `the hotspot table carries ${rows.length} rows; the evidence keeps the top ${MAX_EVIDENCE_ROWS} by Gi* z (the artifact keeps all)` })
  }
  const evidence: HotspotEvidence = base(status, undefined, {
    weights: { kind: 'distance-band', bandMeters: spec.weights.bandMeters, standardization: spec.standardization, s0: giS0, islandCount: matrix.islandIndexes.length },
    rows: rows.slice(0, MAX_EVIDENCE_ROWS),
  })
  await publishTable(publish, artifacts, 'hotspot-table', {
    kind: evidence.kind,
    methodVersion: evidence.methodVersion,
    resourceRef: spec.resourceRef,
    field: spec.field,
    rows,
  })
  return evidence
}

/** Values of the kept units in their kept order. */
function keptValuesOf(kept: readonly { unit: StatUnit }[]): number[] {
  return kept.map(({ unit }) => unit.value)
}

/** Mean and sd of one permutation sample around its own mean. */
function spreadOf(sample: readonly number[]): { mean: number; sd: number } {
  const mean = sample.reduce((total, value) => total + value, 0) / sample.length
  const variance = sample.length > 1
    ? sample.reduce((total, value) => total + (value - mean) ** 2, 0) / (sample.length - 1)
    : 0
  return { mean, sd: Math.sqrt(variance) }
}

/**
 * The Cliff–Ord closed-form spread of global Moran's I under the
 * randomization hypothesis. This is the large-sample moment approximation:
 * it converges to the exact permutation spread as n grows, but small
 * heavily-kurtosed samples can pull it visibly apart from the exact
 * distribution the seeded permutation test enumerates — there the
 * permutation sd is authoritative. `null` below four units, where the
 * formula divides by zero.
 */
export function randomizationSdOf(n: number, matrix: { s0: number; s1: number; s2: number }, values: readonly number[]): number | null {
  if (n < 4 || matrix.s0 === 0) return null
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  const sse = values.reduce((total, value) => total + (value - mean) ** 2, 0)
  if (sse === 0) return null
  const b2 = (n * values.reduce((total, value) => total + (value - mean) ** 4, 0)) / sse ** 2
  const { s0, s1, s2 } = matrix
  const variance = (
    n * ((n * n - 3 * n + 3) * s1 - n * s2 + 3 * s0 * s0)
    - b2 * ((n * n - n) * s1 - 2 * n * s2 + 6 * s0 * s0)
  ) / ((n - 1) * (n - 2) * (n - 3) * s0 * s0)
  return variance >= 0 ? Math.sqrt(variance) : null
}

/** Apply the declared multiple-testing correction to one p-value family. */
export function correctPValues(pValues: readonly number[], policy: 'none' | 'bonferroni' | 'fdr-bh'): number[] {
  const m = pValues.length
  if (policy === 'none' || m === 0) return [...pValues]
  if (policy === 'bonferroni') return pValues.map(p => Math.min(1, p * m))
  // Benjamini–Hochberg step-up: sort ascending, scale by m/rank, enforce monotonicity from the largest.
  const order = [...pValues.keys()].sort((a, b) => (pValues[a] as number) - (pValues[b] as number))
  const adjusted = new Array<number>(m).fill(1)
  let running = 1
  for (let rank = m; rank >= 1; rank--) {
    const index = order[rank - 1] as number
    const candidate = Math.min(1, (pValues[index] as number) * m / rank)
    running = Math.min(running, candidate)
    adjusted[index] = running
  }
  return adjusted
}

/** The method limitations every statistics evidence carries. */
function limitationsFor(spec: ZonalSpec | AutocorrelationSpec | HotspotSpec): readonly string[] {
  if (spec.methodVersion === STATS_METHOD_VERSION && 'weights' in spec) {
    return [
      'correlation is not causation: these statistics describe spatial association under the declared weights only',
      `islands (${ISLAND_RULE}) and permutational p-values depend on the declared band of ${spec.weights.bandMeters} meters; results can change at other scales`,
      'cluster/outlier labels are statistical associations, never cause or effect statements',
    ]
  }
  return [
    'zonal aggregates describe the declared field only; the denominator rule is recorded beside every weighted row',
    'dispersion is the population standard deviation (ddof=0)',
  ]
}

/** Publish one full table through the seam when present. */
async function publishTable(
  publish: StatPublish | undefined,
  artifacts: { label: string; ref: string }[],
  label: string,
  table: unknown,
): Promise<void> {
  if (publish === undefined) return
  const published = await publish(label, new TextEncoder().encode(JSON.stringify(table)))
  artifacts.push({ label, ref: published.ref })
}
