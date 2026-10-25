/**
 * The spatial visualization method contract: the versioned {@link StyleSpec}
 * (field, unit, measure kind, denominator, classification method, actual
 * breaks, palette, and missing/overflow presentation), the {@link LegendSpec}
 * derived from it — never a second color or unit authority — the
 * {@link TimeBinding} that names a layer's temporal field and calendar, and
 * the {@link SelectionFilter} identity shared by chart brush, table, map
 * highlight, and export.
 *
 * Validation accepts the raw JSON-shaped input the tool layer forwards and
 * returns typed issues instead of throwing, so a rejected spec lists every
 * reason rather than the first. `styleVersionOf` pins one spec to a digest
 * version (`sty-…@v1`); validation refuses a payload whose declared
 * `styleVersion` does not re-derive, so a style record cannot be edited
 * without producing a new version.
 *
 * The module is environment-neutral (no Node builtins): the browser workbench
 * imports the same derivation and validation the tools run.
 *
 * @module @map-harness/spatial-viz/contract
 */

/**
 * The method identity this package computes. The version pins the classification
 * semantics (quantile/equal-interval break construction, half-open classes,
 * missing/underflow/overflow classes), the legend derivation, the time-axis
 * calendar enumeration, and the selection/export identity digests.
 */
export const VIZ_METHOD_VERSION = 'spatial-viz@1'

/** The measure kind one style classifies. Rates and densities classify the ratio, not the numerator. */
export type VizMeasure = 'total' | 'rate' | 'density'

/**
 * The series identity one style declares: observed data, a forecast, or a
 * scenario — the 显著身份区分 the legend must carry so a forecast layer is
 * never mistaken for an observed one.
 */
export type VizSeriesIdentity = 'observed' | 'forecast' | 'scenario'

/** The series identities in their fixed order (errors name them). */
export const VIZ_SERIES_IDENTITIES: readonly VizSeriesIdentity[] = ['observed', 'forecast', 'scenario']

/** The visual encoding one style draws: area/line fill color, or graduated point size. */
export type VizEncoding = 'fill' | 'size'

/** The classification methods. `manual` breaks must cite an exact statistic source ref. */
export type VizClassification = 'quantile' | 'equal-interval' | 'manual'

/** The calendar granularities the time axis bins into (in the binding's timezone). */
export type VizGranularity = 'hour' | 'day' | 'week' | 'month'

/** The granularities in their fixed order (errors and diagnostics name them). */
export const VIZ_GRANULARITIES: readonly VizGranularity[] = ['hour', 'day', 'week', 'month']

/** Minimum and maximum class count one style accepts (breaks length = classes − 1). */
export const MIN_VIZ_CLASSES = 2
export const MAX_VIZ_CLASSES = 12

/** The hex-color shape every palette and special color entry must have. */
const HEX_COLOR = /^#[0-9a-f]{6}$/u

/** Default presentation for features whose classified value is missing. */
export const DEFAULT_MISSING_COLOR = '#bdbdbd'
export const DEFAULT_MISSING_LABEL = 'no data'

/** Default presentation for values outside the styled domain (underflow and overflow). */
export const DEFAULT_OVERFLOW_COLOR = '#616161'

/**
 * The temporal binding of one styled layer: the property holding each
 * feature's ISO event time, the display timezone, the calendar granularity,
 * and the half-open window the frames enumerate. Missing times never fill a
 * frame; the axis marks unoccupied frames instead.
 */
export interface TimeBinding {
  readonly timeField: string
  /** IANA timezone the frames and labels render in (validated through `Intl`). */
  readonly timezone: string
  readonly granularity: VizGranularity
  /** Half-open window `[from, to)` in ISO-8601. */
  readonly window: { readonly from: string; readonly to: string }
}

/**
 * The style of one classified layer. Breaks partition `domain` into
 * `breaks.length + 1` half-open classes `[b_k, b_{k+1})`, the last ending at
 * `domain.max` inclusive; values below `domain.min` are underflow, values
 * above `domain.max` are overflow, non-numeric values are missing.
 */
export interface StyleSpec {
  readonly methodVersion: typeof VIZ_METHOD_VERSION
  readonly field: string
  readonly unit: string
  readonly measure: VizMeasure
  /** The series the layer renders; written explicitly by the styling tool. */
  readonly seriesIdentity: VizSeriesIdentity
  /** Positive denominator property; required for `rate`/`density`, forbidden for `total`. */
  readonly denominatorField?: string
  readonly encoding: VizEncoding
  readonly classification: VizClassification
  /** Strictly increasing finite class boundaries, length in `[MIN_VIZ_CLASSES − 1, MAX_VIZ_CLASSES − 1]`. */
  readonly breaks: readonly number[]
  readonly domain: { readonly min: number; readonly max: number }
  /** One hex color per class, `breaks.length + 1` entries. */
  readonly palette: readonly string[]
  readonly missingColor: string
  readonly overflowColor: string
  readonly missingLabel: string
  readonly timeBinding?: TimeBinding
  /**
   * The exact `res-…@vN`/`art-…@vN` the breaks came from. Required when
   * `classification` is `manual` — a model may not invent break values — and
   * recorded beside computed breaks too, so every legend names its source.
   */
  readonly breaksSourceRef?: string
  /** True when a comparison froze both layers onto one shared domain (viz_compare). */
  readonly unifiedDomain?: boolean
  /** The digest version `styleVersionOf` derives; validation refuses a mismatch. */
  readonly styleVersion: string
}

/** One legend row for one numeric class: the half-open range `[from, to)` it covers (last class includes `to`). */
export interface LegendClassRow {
  readonly kind: 'class'
  readonly classIndex: number
  readonly color: string
  readonly from: number
  readonly to: number
  /** True only for the last class, whose upper bound is inclusive. */
  readonly toInclusive: boolean
}

/** One legend row for the missing or out-of-domain presentation. */
export interface LegendSpecialRow {
  readonly kind: 'missing' | 'underflow' | 'overflow'
  readonly color: string
}

/** One legend row: a class range or a special presentation. */
export type LegendRow = LegendClassRow | LegendSpecialRow

/**
 * The legend derived from one style. The legend carries the style's version
 * and break source — never a second color or unit authority — so layer,
 * legend, table, chart, and export render one classification.
 */
export interface LegendSpec {
  readonly methodVersion: typeof VIZ_METHOD_VERSION
  readonly styleVersion: string
  readonly field: string
  readonly unit: string
  readonly measure: VizMeasure
  readonly seriesIdentity: VizSeriesIdentity
  readonly denominatorField?: string
  readonly encoding: VizEncoding
  readonly breaksSourceRef?: string
  readonly unifiedDomain: boolean
  /** Classes in ascending order, then underflow, overflow, and missing last. */
  readonly rows: readonly LegendRow[]
}

/** The half-open chart brush one histogram selection covers. */
export interface ChartBrush {
  readonly min: number
  /** Upper bound; inclusive only when it equals the last class bound. */
  readonly max: number
}

/** The one time frame a selection is pinned to. */
export interface SelectionFrame {
  readonly index: number
  readonly fromMs: number
  readonly toMs: number
}

/**
 * The shared selection identity: chart brush, attribute-table highlight, map
 * highlight, and export all derive from one filter over one style version,
 * one data identity, and one time frame. `filterRevisionOf` pins it.
 */
export interface SelectionFilter {
  readonly methodVersion: typeof VIZ_METHOD_VERSION
  readonly styleVersion: string | null
  /** The data identity the selection spans: a catalog ref, or `display:<digest>` for path layers. */
  readonly dataRef: string
  readonly frame: SelectionFrame | null
  readonly brush: ChartBrush | null
}

/** One structured validation issue: the offending field and a stable machine code. */
export interface VizIssue {
  readonly field: string
  readonly code: string
}

/** One style export binding: the fixed identity one exported layer cites. */
export interface ExportLayerBinding {
  readonly layerId: string
  readonly name: string
  /** The style version the layer rendered, or `null` for a single-symbol layer. */
  readonly styleVersion: string | null
  /** The catalog ref the layer rendered, or `null` when added from a path. */
  readonly dataRef: string | null
  /** The display digest the layer rendered, or `null` when the tool supplied none. */
  readonly displayDigest: string | null
  readonly featureCount: number
}

/** The independent failure kinds an export reports. Rendering, data, and export failures never merge. */
export type ExportFailureKind = 'render' | 'data' | 'export'

/** One named export failure the caller already observed. */
export interface ExportFailure {
  readonly kind: ExportFailureKind
  readonly layerId: string | null
  readonly detail: string
}

/** The pinned time frame an export cites, with its zone, granularity, and local label. */
export interface ExportFrame {
  readonly index: number
  readonly fromMs: number
  readonly toMs: number
  readonly timezone: string
  readonly granularity: VizGranularity
  readonly label: string
}

/** The fixed-revision export manifest: map revision, per-layer style/data identity, time frame, and filter. */
export interface ExportManifest {
  readonly methodVersion: typeof VIZ_METHOD_VERSION
  readonly mapRevision: number
  readonly frame: ExportFrame | null
  readonly filterRevision: string | null
  readonly layers: readonly ExportLayerBinding[]
  readonly failures: readonly ExportFailure[]
}

/**
 * Stable key-order-independent JSON text of one plain value: object keys sort,
 * arrays keep order, `undefined` properties drop. The digest input for every
 * version identity this package derives.
 * @param value - the plain JSON value to canonicalize.
 * @returns the canonical JSON text.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`
}

/**
 * The environment-neutral identity digest this package versions with: two
 * seeded FNV-1a rounds over the canonical JSON, concatenated to 12 hex chars.
 * @param value - the plain JSON value to digest.
 * @returns 12 hex characters.
 */
export function vizDigestOf(value: unknown): string {
  const text = stableStringify(value)
  let hash = 0x811c9dc5
  let seed = 0x01000193
  let out = ''
  for (let round = 0; round < 2; round += 1) {
    for (let at = 0; at < text.length; at += 1) {
      hash ^= text.charCodeAt(at)
      hash = Math.imul(hash, seed) >>> 0
    }
    out += hash.toString(16).padStart(8, '0')
    hash = 0x811c9dc5
    seed = 0x01f3c9ad
  }
  return out.slice(0, 12)
}

/** The spec value the version digest covers: everything except the derived `styleVersion` itself. */
function versionInputOf(style: Omit<StyleSpec, 'styleVersion'> & { readonly styleVersion?: string }): unknown {
  const { styleVersion: _ignored, ...rest } = style
  return rest
}

/**
 * Derive the style version of one spec (`sty-<digest>@v1`). Key-order
 * independent, so the same classification always carries the same version.
 * @param style - the spec to version; a present `styleVersion` field is ignored.
 * @returns the derived version string.
 */
export function styleVersionOf(style: Omit<StyleSpec, 'styleVersion'>): string {
  return `sty-${vizDigestOf(versionInputOf(style))}@v1`
}

/** Whether one string is a 6-digit hex color. */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value)
}

/** Whether one string names a timezone `Intl` can format. */
export function isTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}

/** Whether one string parses as an epoch timestamp. */
export function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value))
}

/**
 * Validate one style spec and return every structural issue. The check runs
 * on the raw payload the tool layer forwards (and on every style a replayed
 * record carries): vocabulary, measure/encoding/parenthesis rules, break
 * monotonicity, palette arity, timezone, window, and the declared
 * `styleVersion` re-derivation.
 * @param style - the raw spec value.
 * @returns every issue, in field order; empty when the spec is valid.
 */
export function validateStyleSpec(style: unknown): VizIssue[] {
  const issues: VizIssue[] = []
  const fail = (field: string, code: string): void => { issues.push({ field, code }) }
  if (typeof style !== 'object' || style === null) {
    return [{ field: 'style', code: 'not-an-object' }]
  }
  const spec = style as Record<string, unknown>
  if (spec.methodVersion !== VIZ_METHOD_VERSION) fail('methodVersion', 'unknown-method-version')
  if (typeof spec.field !== 'string' || spec.field.length === 0) fail('field', 'required')
  if (typeof spec.unit !== 'string' || spec.unit.length === 0) fail('unit', 'required')
  if (spec.measure !== 'total' && spec.measure !== 'rate' && spec.measure !== 'density') fail('measure', 'unknown-vocabulary')
  if (!VIZ_SERIES_IDENTITIES.includes(spec.seriesIdentity as VizSeriesIdentity)) fail('seriesIdentity', 'unknown-vocabulary')
  if (spec.encoding !== 'fill' && spec.encoding !== 'size') fail('encoding', 'unknown-vocabulary')
  if (spec.classification !== 'quantile' && spec.classification !== 'equal-interval' && spec.classification !== 'manual') {
    fail('classification', 'unknown-vocabulary')
  }
  const measure = spec.measure
  if (measure === 'rate' || measure === 'density') {
    if (typeof spec.denominatorField !== 'string' || spec.denominatorField.length === 0) fail('denominatorField', 'denominator-required')
  } else if (spec.denominatorField !== undefined) {
    fail('denominatorField', 'denominator-unexpected')
  }
  if (spec.encoding === 'size' && (measure === 'rate' || measure === 'density')) {
    fail('encoding', 'size-encoding-requires-total')
  }
  const breaks = spec.breaks
  if (!Array.isArray(breaks) || breaks.length < MIN_VIZ_CLASSES - 1 || breaks.length > MAX_VIZ_CLASSES - 1) {
    fail('breaks', 'class-count-out-of-range')
  } else {
    let monotonic = true
    for (const boundary of breaks) {
      if (typeof boundary !== 'number' || !Number.isFinite(boundary)) { fail('breaks', 'non-finite'); monotonic = false; break }
    }
    if (monotonic) {
      for (let at = 1; at < breaks.length; at += 1) {
        if ((breaks[at] as number) <= (breaks[at - 1] as number)) { fail('breaks', 'not-strictly-increasing'); break }
      }
    }
  }
  const domain = spec.domain as Record<string, unknown> | undefined
  if (typeof domain !== 'object' || domain === null
    || typeof domain.min !== 'number' || !Number.isFinite(domain.min)
    || typeof domain.max !== 'number' || !Number.isFinite(domain.max)
    || (domain.min as number) >= (domain.max as number)) {
    fail('domain', 'invalid-domain')
  }
  const classCount = Array.isArray(breaks) ? breaks.length + 1 : 0
  const palette = spec.palette
  if (!Array.isArray(palette) || palette.length !== classCount) {
    fail('palette', 'palette-arity')
  } else {
    for (const color of palette) {
      if (!isHexColor(color)) { fail('palette', 'invalid-color'); break }
    }
  }
  if (!isHexColor(spec.missingColor)) fail('missingColor', 'invalid-color')
  if (!isHexColor(spec.overflowColor)) fail('overflowColor', 'invalid-color')
  if (typeof spec.missingLabel !== 'string' || spec.missingLabel.length === 0) fail('missingLabel', 'required')
  if (spec.classification === 'manual'
    && (typeof spec.breaksSourceRef !== 'string' || spec.breaksSourceRef.length === 0)) {
    fail('breaksSourceRef', 'breaks-source-required')
  }
  if (spec.breaksSourceRef !== undefined
    && (typeof spec.breaksSourceRef !== 'string' || spec.breaksSourceRef.length === 0)) {
    fail('breaksSourceRef', 'invalid-ref')
  }
  const binding = spec.timeBinding
  if (binding !== undefined) {
    if (typeof binding !== 'object' || binding === null) {
      fail('timeBinding', 'not-an-object')
    } else {
      const bound = binding as Record<string, unknown>
      if (typeof bound.timeField !== 'string' || bound.timeField.length === 0) fail('timeBinding.timeField', 'required')
      if (typeof bound.timezone !== 'string' || !isTimezone(bound.timezone)) fail('timeBinding.timezone', 'unknown-timezone')
      if (!VIZ_GRANULARITIES.includes(bound.granularity as VizGranularity)) fail('timeBinding.granularity', 'unknown-vocabulary')
      const window = bound.window as Record<string, unknown> | undefined
      if (typeof window !== 'object' || window === null
        || typeof window.from !== 'string' || !isTimestamp(window.from)
        || typeof window.to !== 'string' || !isTimestamp(window.to)
        || Date.parse(window.from as string) >= Date.parse(window.to as string)) {
        fail('timeBinding.window', 'invalid-window')
      }
    }
  }
  if (typeof spec.styleVersion !== 'string' || spec.styleVersion.length === 0) {
    fail('styleVersion', 'required')
  } else if (issues.length === 0 && spec.styleVersion !== styleVersionOf(style as StyleSpec)) {
    fail('styleVersion', 'version-mismatch')
  }
  return issues
}

/**
 * Derive the legend of one style: one row per class in ascending order, then
 * underflow, overflow, and missing. The rows carry the style's own colors and
 * bounds — the legend derives, it never re-decides.
 * @param style - the validated style the legend derives from.
 * @returns the legend specification.
 */
export function legendOf(style: StyleSpec): LegendSpec {
  const rows: LegendRow[] = []
  const bounds = [style.domain.min, ...style.breaks, style.domain.max]
  for (let classIndex = 0; classIndex < style.palette.length; classIndex += 1) {
    rows.push({
      kind: 'class',
      classIndex,
      color: style.palette[classIndex] as string,
      from: bounds[classIndex] as number,
      to: bounds[classIndex + 1] as number,
      toInclusive: classIndex === style.palette.length - 1,
    })
  }
  rows.push({ kind: 'underflow', color: style.overflowColor })
  rows.push({ kind: 'overflow', color: style.overflowColor })
  rows.push({ kind: 'missing', color: style.missingColor })
  return {
    methodVersion: style.methodVersion,
    styleVersion: style.styleVersion,
    field: style.field,
    unit: style.unit,
    measure: style.measure,
    seriesIdentity: style.seriesIdentity,
    ...(style.denominatorField === undefined ? {} : { denominatorField: style.denominatorField }),
    encoding: style.encoding,
    ...(style.breaksSourceRef === undefined ? {} : { breaksSourceRef: style.breaksSourceRef }),
    unifiedDomain: style.unifiedDomain === true,
    rows,
  }
}
