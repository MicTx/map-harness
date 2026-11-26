/**
 * The evidence projections over the statistics: lineage grouping that keeps
 * same-source products from counting as independent evidence, the
 * multi-scale ladder that reruns one autocorrelation over declared weight
 * bands and reports their disagreement, and the legend domain derived from
 * one frozen result object — so layer, legend, attribute summary, and
 * session evidence all cite the same method version, the same input
 * versions, and the same classification breaks. Nothing here recomputes a
 * statistic from a rendering sample.
 *
 * @module @map-harness/spatial-statistics/evidence
 */
import { STATS_METHOD_VERSION } from './contract.ts'
import { computeAutocorrelation, type AutocorrelationEvidence, type StatUnit } from './stats.ts'
import type { WeightSpec } from './contract.ts'

/** One evidence row the lineage groups: the exact inputs one product came from. */
export interface EvidenceLineageRow {
  /** The product identity (for example an artifact ref). */
  readonly resultRef: string
  /** The exact input refs the product consumed, order-insensitive. */
  readonly inputRefs: readonly string[]
  /** The method version that produced the product. */
  readonly methodVersion: string
}

/** One lineage group: products from the same inputs and method are one evidence. */
export interface EvidenceLineageGroup {
  readonly lineageId: string
  readonly inputRefs: readonly string[]
  readonly methodVersion: string
  readonly resultRefs: readonly string[]
}

/**
 * Group evidence rows by their input lineage: the sorted input refs plus the
 * method version form the lineage id, so two products derived from the same
 * frozen inputs land in one group and never double as independent evidence.
 * @param rows - the products to group.
 * @returns the groups in first-appearance order plus the independent count.
 */
export function groupEvidenceByLineage(rows: readonly EvidenceLineageRow[]): { groups: readonly EvidenceLineageGroup[]; independentEvidenceCount: number } {
  const groups = new Map<string, EvidenceLineageGroup & { resultRefs: string[] }>()
  for (const row of rows) {
    const inputRefs = [...row.inputRefs].sort()
    const lineageId = `${row.methodVersion}|${inputRefs.join('+')}`
    const group = groups.get(lineageId) ?? { lineageId, inputRefs, methodVersion: row.methodVersion, resultRefs: [] }
    group.resultRefs.push(row.resultRef)
    groups.set(lineageId, group)
  }
  const ordered = [...groups.values()]
  return { groups: ordered, independentEvidenceCount: ordered.length }
}

/** One rung of the multi-scale ladder: the same statistic at one band. */
export interface ScaleLadderRow {
  readonly bandMeters: number
  readonly status: AutocorrelationEvidence['status']
  readonly notApplicableReason: AutocorrelationEvidence['notApplicableReason']
  readonly unitCount: number
  readonly islandCount: number
  readonly moranI: number | null
  readonly pseudoP: number | null
}

/** The multi-scale comparison a ladder run produces. */
export interface ScaleLadder {
  readonly methodVersion: typeof STATS_METHOD_VERSION
  readonly field: string
  readonly rows: readonly ScaleLadderRow[]
  /**
   * True when every applicable rung agrees in the sign of its global
   * statistic; a `false` value is the recorded scale-sensitivity warning,
   * not an error.
   */
  readonly signAgreement: boolean
}

/**
 * Rerun the global autocorrelation over a ladder of declared bands so the
 * scale dependence of the statistic is recorded instead of hidden. Each
 * rung is a full computation with the same seed, so the ladder is
 * reproducible end to end.
 * @param units - the resource's observation units.
 * @param field - the field name the ladder reports beside each rung.
 * @param bands - the declared weight bands, oldest first.
 * @param options - standardization, permutations, seed, and multiple-testing policy.
 * @returns the ladder with its agreement verdict.
 */
export async function compareScales(
  units: readonly StatUnit[],
  field: string,
  bands: readonly WeightSpec[],
  options: { standardization: 'row' | 'binary'; permutations: number; seed: number; multipleTesting: 'none' | 'bonferroni' | 'fdr-bh' },
): Promise<ScaleLadder> {
  const rows: ScaleLadderRow[] = []
  for (const band of bands) {
    const evidence = await computeAutocorrelation(units, {
      goalRevision: 0,
      resourceRef: 'res-scale-ladder@v1',
      field,
      weights: band,
      standardization: options.standardization,
      permutations: options.permutations,
      seed: options.seed,
      multipleTesting: options.multipleTesting,
      methodVersion: STATS_METHOD_VERSION,
    })
    rows.push({
      bandMeters: band.bandMeters,
      status: evidence.status,
      notApplicableReason: evidence.notApplicableReason,
      unitCount: evidence.unitCount,
      islandCount: evidence.weights.islandCount,
      moranI: evidence.moranI,
      pseudoP: evidence.pseudoP,
    })
  }
  const applicable = rows.filter(row => row.moranI !== null)
  const signAgreement = applicable.length <= 1 || applicable.every(row => (row.moranI as number) > 0) || applicable.every(row => (row.moranI as number) < 0)
  return { methodVersion: STATS_METHOD_VERSION, field, rows, signAgreement }
}

/** The classification conventions the legend domain supports. */
export type LegendClassification = 'quantile-5' | 'quantile-7'

/** The legend domain derived from one frozen result's numeric values. */
export interface LegendDomain {
  /** The method version the source result carries — the legend never upgrades it. */
  readonly methodVersion: typeof STATS_METHOD_VERSION
  readonly field: string
  readonly classification: LegendClassification
  /** The breaks computed once from the source result's values (ascending). */
  readonly breaks: readonly number[]
  readonly unit: 'statistic'
}

/** The numeric values one result's legend draws from. */
export type LegendSource =
  | { readonly kind: 'spatial-autocorrelation'; readonly field: string; readonly values: readonly number[] }
  | { readonly kind: 'hotspot'; readonly field: string; readonly values: readonly number[] }
  | { readonly kind: 'zonal-summary'; readonly field: string; readonly values: readonly number[] }

/**
 * Derive the legend classification domain from one frozen result's values.
 * The breaks come from the given values only — a later rendering never
 * recomputes them, so layer, legend, attribute summary, and evidence stay on
 * one classification.
 * @param source - the result kind, field, and the values the legend classifies.
 * @param classification - the fixed classification convention.
 * @returns the legend domain, or `undefined` when fewer than two distinct values exist.
 */
export function legendDomainOf(source: LegendSource, classification: LegendClassification = 'quantile-5'): LegendDomain | undefined {
  const values = [...source.values].filter(value => Number.isFinite(value)).sort((a, b) => a - b)
  const classes = classification === 'quantile-5' ? 5 : 7
  if (values.length < classes) return undefined
  const distinct = new Set(values)
  if (distinct.size < classes) return undefined
  const breaks: number[] = []
  for (let rank = 1; rank < classes; rank++) {
    const position = (values.length * rank) / classes
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    const low = values[lower] as number
    const high = values[upper] as number
    breaks.push(low + (high - low) * (position - lower))
  }
  return { methodVersion: STATS_METHOD_VERSION, field: source.field, classification, breaks, unit: 'statistic' }
}
