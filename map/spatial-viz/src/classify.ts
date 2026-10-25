/**
 * The classification computations behind one {@link StyleSpec}: break
 * construction from frozen values (quantile and equal-interval; manual breaks
 * only with their statistic source ref), the per-value class assignment with
 * explicit missing/underflow/overflow classes, per-class counting, the
 * graduated size scale that gives point classes a non-color encoding, and the
 * unified-domain pair a comparison freezes both layers onto.
 *
 * Breaks always derive from the values the layer actually renders — the tools
 * compute them from the accepted projection's display copy, and a `manual`
 * spec cites the exact statistic ref its breaks came from. Nothing here
 * invents a range.
 *
 * @module @map-harness/spatial-viz/classify
 */
import {
  DEFAULT_MISSING_COLOR,
  DEFAULT_MISSING_LABEL,
  DEFAULT_OVERFLOW_COLOR,
  MAX_VIZ_CLASSES,
  MIN_VIZ_CLASSES,
  VIZ_SERIES_IDENTITIES,
  styleVersionOf,
  type StyleSpec,
  type VizClassification,
  type VizEncoding,
  type VizIssue,
  type VizMeasure,
  type VizSeriesIdentity,
} from './contract.ts'

/** The outcome of classifying one value: a class index, or the named special class. */
export type ClassifiedValue = number | 'missing' | 'underflow' | 'overflow'

/**
 * Compute classification breaks over one frozen value set. Quantile breaks
 * sit at even distinct-value ranks, always between two distinct values
 * (midpoints), so a boundary never makes an always-empty class and heavily
 * tied data honestly reduces the class count to its distinct support.
 * Equal-interval breaks span the observed range evenly; a collapsed range
 * yields one class. The result carries the effective class count.
 * @param values - the numeric values the breaks partition; `NaN` entries are ignored.
 * @param method - `quantile` or `equal-interval`.
 * @param classCount - requested class count in `[2, 12]`.
 * @returns the strictly increasing breaks and the effective class count (1 when the data is constant).
 * @throws {Error} when `classCount` is outside `[2, 12]` or the method is unknown.
 */
export function computeBreaks(
  values: readonly number[],
  method: Exclude<VizClassification, 'manual'>,
  classCount: number,
): { breaks: number[]; effectiveClassCount: number } {
  if (!Number.isInteger(classCount) || classCount < MIN_VIZ_CLASSES || classCount > MAX_VIZ_CLASSES) {
    throw new Error(`class_count must be an integer in [${MIN_VIZ_CLASSES}, ${MAX_VIZ_CLASSES}], got ${String(classCount)}`)
  }
  const finite = values.filter(value => Number.isFinite(value))
  const distinct = Array.from(new Set(finite)).toSorted((a, b) => a - b)
  if (distinct.length <= 1) return { breaks: [], effectiveClassCount: 1 }
  const breaks: number[] = []
  if (method === 'quantile') {
    const count = Math.min(classCount - 1, distinct.length - 1)
    for (let at = 1; at <= count; at += 1) {
      // The rank the at-th break splits at, never before the first or after
      // the last distinct value; the boundary sits between its neighbors.
      const rank = Math.min(Math.max(at, Math.floor((at * distinct.length) / classCount)), distinct.length - 1)
      const lower = distinct[rank - 1]
      const upper = distinct[rank]
      if (lower === undefined || upper === undefined) break
      breaks.push((lower + upper) / 2)
    }
  } else {
    const min = distinct[0] as number
    const max = distinct[distinct.length - 1] as number
    for (let at = 1; at < classCount; at += 1) {
      const boundary = min + ((max - min) * at) / classCount
      if (boundary > min && boundary < max) breaks.push(boundary)
    }
  }
  const effectiveClassCount = breaks.length === 0 ? 1 : breaks.length + 1
  return { breaks, effectiveClassCount }
}

/**
 * Classify one value against one style. Classes are half-open `[b_k, b_{k+1})`
 * with the last class ending at `domain.max` inclusive; values below
 * `domain.min` are underflow, values above `domain.max` are overflow, and
 * non-finite values are missing.
 * @param style - the validated style to classify against.
 * @param value - the (already measured) value; for rate/density styles this is the ratio.
 * @returns the class index, or the named special class.
 */
export function classifyValue(style: StyleSpec, value: number): ClassifiedValue {
  if (!Number.isFinite(value)) return 'missing'
  if (value < style.domain.min) return 'underflow'
  if (value > style.domain.max) return 'overflow'
  for (let at = 0; at < style.breaks.length; at += 1) {
    if (value < (style.breaks[at] as number)) return at
  }
  return style.breaks.length
}

/**
 * Count one value set per class plus the missing/underflow/overflow classes.
 * @param style - the validated style to classify against.
 * @param values - the measured values.
 * @returns per-class counts (indexed like the palette), and the special-class counts.
 */
export function countClasses(style: StyleSpec, values: readonly number[]): {
  counts: number[]
  missing: number
  underflow: number
  overflow: number
} {
  const counts = new Array<number>(style.palette.length).fill(0)
  let missing = 0
  let underflow = 0
  let overflow = 0
  for (const value of values) {
    const classified = classifyValue(style, value)
    if (classified === 'missing') missing += 1
    else if (classified === 'underflow') underflow += 1
    else if (classified === 'overflow') overflow += 1
    else counts[classified] = (counts[classified] ?? 0) + 1
  }
  return { counts, missing, underflow, overflow }
}

/**
 * Measure one feature's classified value: for `rate`/`density` styles the
 * ratio of the numerator field over the denominator property (a missing,
 * non-numeric, or non-positive denominator is a missing value — never a zero
 * or an invented ratio), for `total` styles the numerator field itself.
 * @param properties - the feature properties.
 * @param style - the style naming the fields.
 * @returns the measured value, or `NaN` when missing.
 */
export function measureValueOf(properties: Record<string, unknown> | null | undefined, style: Pick<StyleSpec, 'field' | 'measure' | 'denominatorField'>): number {
  const raw = properties?.[style.field]
  const numerator = typeof raw === 'number' ? raw : Number.NaN
  if (style.measure === 'total' || style.denominatorField === undefined) return numerator
  const denominatorRaw = properties?.[style.denominatorField]
  const denominator = typeof denominatorRaw === 'number' ? denominatorRaw : Number.NaN
  if (!Number.isFinite(denominator) || denominator <= 0) return Number.NaN
  return numerator / denominator
}

/** The graduated point-size scale: class 0 renders at `minPx`, the top class at `maxPx`. */
export const SIZE_MIN_PX = 8
export const SIZE_MAX_PX = 20

/**
 * The graduated size one class renders at. Size encoding is the non-color
 * encoding for point totals: class order stays readable without hue.
 * @param classIndex - the class index (special classes clamp to the extremes).
 * @param classCount - the total class count.
 * @returns the point diameter in px.
 */
export function sizeForClass(classIndex: number, classCount: number): number {
  if (classCount <= 1) return SIZE_MIN_PX
  const clamped = Math.min(Math.max(classIndex, 0), classCount - 1)
  return Math.round(SIZE_MIN_PX + ((SIZE_MAX_PX - SIZE_MIN_PX) * clamped) / (classCount - 1))
}

/** The fixed sequential ramp (light → dark) the tools slice palettes from; an interpolation constant, not a configuration. */
export const SEQUENTIAL_RAMP = ['#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6', '#4292c6', '#2171b5', '#08519c', '#08306b'] as const

/**
 * Slice one class palette from the fixed sequential ramp by even index steps.
 * @param classCount - the palette length in `[2, 12]`.
 * @returns `classCount` hex colors, light → dark.
 */
export function paletteOf(classCount: number): string[] {
  if (!Number.isInteger(classCount) || classCount < MIN_VIZ_CLASSES || classCount > MAX_VIZ_CLASSES) {
    throw new Error(`palette class_count must be an integer in [${MIN_VIZ_CLASSES}, ${MAX_VIZ_CLASSES}], got ${String(classCount)}`)
  }
  const last = SEQUENTIAL_RAMP.length - 1
  return Array.from({ length: classCount }, (_, at) => {
    const index = Math.round((at * last) / (classCount - 1))
    return SEQUENTIAL_RAMP[index] as string
  })
}

/** One built style plus the honest collapse note when ties reduced the requested class count. */
export interface BuiltStyle extends StyleSpec {
  readonly requestedClassCount?: number
  readonly effectiveClassCount?: number
}

/**
 * Assemble one validated style from computed parts: the exact payload the
 * `viz_*` tools persist. Every input the caller chose is already in hand —
 * defaults are written here, never hidden inside the renderer. Constant data
 * (no breaks) has no classification and is refused here; the tools refuse it
 * upstream with a named `constant-field` status before assembling.
 * @param parts - the resolved style inputs (breaks already computed from frozen values).
 * @returns the assembled style with its derived version.
 * @throws {Error} when `breaks` is empty — constant data carries no classification.
 */
export function buildStyle(parts: {
  readonly field: string
  readonly unit: string
  readonly measure: VizMeasure
  readonly seriesIdentity?: VizSeriesIdentity
  readonly denominatorField?: string
  readonly encoding: VizEncoding
  readonly classification: VizClassification
  readonly breaks: readonly number[]
  readonly domain: { readonly min: number; readonly max: number }
  readonly timeBinding?: StyleSpec['timeBinding']
  readonly breaksSourceRef?: string
  readonly unifiedDomain?: boolean
  readonly missingColor?: string
  readonly missingLabel?: string
  readonly overflowColor?: string
  readonly styleVersion?: string
}): BuiltStyle {
  if (parts.breaks.length === 0) {
    throw new Error('a style needs at least one class break; constant data carries no classification')
  }
  const classCount = parts.breaks.length + 1
  const assembled = {
    methodVersion: 'spatial-viz@1' as const,
    field: parts.field,
    unit: parts.unit,
    measure: parts.measure,
    seriesIdentity: parts.seriesIdentity ?? 'observed',
    ...(parts.denominatorField === undefined ? {} : { denominatorField: parts.denominatorField }),
    ...(parts.denominatorField === undefined ? {} : { denominatorField: parts.denominatorField }),
    encoding: parts.encoding,
    classification: parts.classification,
    breaks: parts.breaks,
    domain: parts.domain,
    palette: paletteOf(classCount),
    missingColor: parts.missingColor ?? DEFAULT_MISSING_COLOR,
    overflowColor: parts.overflowColor ?? DEFAULT_OVERFLOW_COLOR,
    missingLabel: parts.missingLabel ?? DEFAULT_MISSING_LABEL,
    ...(parts.timeBinding === undefined ? {} : { timeBinding: parts.timeBinding }),
    ...(parts.breaksSourceRef === undefined ? {} : { breaksSourceRef: parts.breaksSourceRef }),
    ...(parts.unifiedDomain === undefined ? {} : { unifiedDomain: parts.unifiedDomain }),
  }
  const style: BuiltStyle = { ...assembled, styleVersion: parts.styleVersion ?? styleVersionOf(assembled) }
  return style
}

/**
 * Freeze two styles onto one unified classification domain: the breaks derive
 * from the union of both value sets, and both styles share the identical
 * boundaries and domain so one color always means the same value on both
 * layers. Per-layer re-classification of a shared ramp is exactly the
 * comparison mistake this refuses.
 * @param left - the resolved inputs for layer A (breaks recomputed from `valuesLeft`).
 * @param right - the resolved inputs for layer B.
 * @returns both styles carrying `unifiedDomain: true` and the shared breaks.
 */
export function unifyDomains(left: {
  readonly field: string
  readonly unit: string
  readonly measure: VizMeasure
  readonly seriesIdentity?: VizSeriesIdentity
  readonly denominatorField?: string
  readonly encoding: VizEncoding
  readonly values: readonly number[]
  readonly timeBinding?: StyleSpec['timeBinding']
}, right: {
  readonly field: string
  readonly unit: string
  readonly measure: VizMeasure
  readonly seriesIdentity?: VizSeriesIdentity
  readonly denominatorField?: string
  readonly encoding: VizEncoding
  readonly values: readonly number[]
  readonly timeBinding?: StyleSpec['timeBinding']
}, classification: Exclude<VizClassification, 'manual'>, classCount: number): { styleLeft: BuiltStyle; styleRight: BuiltStyle; breaks: number[] } {
  const union = [...left.values, ...right.values]
  const { breaks } = computeBreaks(union, classification, classCount)
  const finite = union.filter(value => Number.isFinite(value))
  const domain = {
    min: finite.length === 0 ? 0 : Math.min(...finite),
    max: finite.length === 0 ? 1 : Math.max(...finite),
  }
  const styleLeft = buildStyle({
    field: left.field,
    unit: left.unit,
    measure: left.measure,
    ...(left.seriesIdentity === undefined ? {} : { seriesIdentity: left.seriesIdentity }),
    ...(left.denominatorField === undefined ? {} : { denominatorField: left.denominatorField }),
    encoding: left.encoding,
    classification,
    breaks,
    domain,
    ...(left.timeBinding === undefined ? {} : { timeBinding: left.timeBinding }),
    unifiedDomain: true,
  })
  const styleRight = buildStyle({
    field: right.field,
    unit: right.unit,
    measure: right.measure,
    ...(right.seriesIdentity === undefined ? {} : { seriesIdentity: right.seriesIdentity }),
    ...(right.denominatorField === undefined ? {} : { denominatorField: right.denominatorField }),
    encoding: right.encoding,
    classification,
    breaks,
    domain,
    ...(right.timeBinding === undefined ? {} : { timeBinding: right.timeBinding }),
    unifiedDomain: true,
  })
  return { styleLeft, styleRight, breaks }
}

/**
 * The structural checks shared by the style tools before assembly: measure
 * and encoding parenthesis and the classification vocabulary. Returns issues
 * in contract shape so a rejected tool input lists every reason.
 * @param input - the raw tool arguments to check.
 * @returns every issue; empty when the inputs can proceed to assembly.
 */
export function checkStyleInputs(input: {
  readonly measure: unknown
  readonly seriesIdentity?: unknown
  readonly encoding: unknown
  readonly classification: unknown
  readonly denominatorField?: unknown
}): VizIssue[] {
  const issues: VizIssue[] = []
  if (input.measure !== 'total' && input.measure !== 'rate' && input.measure !== 'density') {
    issues.push({ field: 'measure', code: 'unknown-vocabulary' })
  }
  if (input.seriesIdentity !== undefined && !VIZ_SERIES_IDENTITIES.includes(input.seriesIdentity as VizSeriesIdentity)) {
    issues.push({ field: 'series_identity', code: 'unknown-vocabulary' })
  }
  if (input.encoding !== 'fill' && input.encoding !== 'size') {
    issues.push({ field: 'encoding', code: 'unknown-vocabulary' })
  }
  if (input.classification !== 'quantile' && input.classification !== 'equal-interval' && input.classification !== 'manual') {
    issues.push({ field: 'classification', code: 'unknown-vocabulary' })
  }
  if ((input.measure === 'rate' || input.measure === 'density')
    && (typeof input.denominatorField !== 'string' || input.denominatorField.length === 0)) {
    issues.push({ field: 'denominator_field', code: 'denominator-required' })
  }
  if (input.measure === 'total' && input.denominatorField !== undefined) {
    issues.push({ field: 'denominator_field', code: 'denominator-unexpected' })
  }
  if (input.encoding === 'size' && (input.measure === 'rate' || input.measure === 'density')) {
    issues.push({ field: 'encoding', code: 'size-encoding-requires-total' })
  }
  return issues
}
