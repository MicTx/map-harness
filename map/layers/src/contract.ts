/**
 * The map-layer presentation contract: the versioned {@link SymbolStyle}
 * (single-symbol blocks per geometry plus the heatmap presentation), the
 * per-feature {@link FeatureOverride} patches layered above it, the
 * {@link ImagerySpec} a tile overlay layer carries, and the layer-group name
 * vocabulary — each with its full validator and digest version token.
 *
 * The classification authority stays with `spatial-viz` (`StyleSpec`); this
 * contract is the presentation authority and the two are orthogonal: a
 * classified layer resolves class colors from its style, unclassified
 * dimensions from its symbol. Heatmap presentation is mutually exclusive
 * with a classification style (density coloring vs class coloring) and
 * requires an all-Point layer — enforced at the tool and fold boundaries,
 * not re-decided here.
 *
 * Version tokens derive the same way `styleVersionOf` does: a digest over
 * every field except the token itself, so a record cannot be edited without
 * producing a new version. Validation returns every issue (typed field plus
 * stable code) instead of throwing, mirroring `validateStyleSpec`.
 *
 * The module is environment-neutral (no Node builtins): the tools, the
 * projection fold, and the browser workbench import the same validation.
 *
 * @module @map-harness/map-layers/contract
 */
import { isHexColor, vizDigestOf } from '@map-harness/spatial-viz'

/**
 * The method identity this package versions. Pins the symbol vocabulary
 * (shapes, patterns, ramps), the block bounds, the override grammar, the
 * imagery template admission, and the digest version semantics.
 */
export const LAYERS_METHOD_VERSION = 'map-layers@1'

/** The ArcGIS-native marker shapes a point block accepts. */
export type MarkerShape = 'circle' | 'square' | 'cross' | 'x' | 'diamond' | 'triangle'

/** Marker shapes in their fixed order (errors name them). */
export const MARKER_SHAPES: readonly MarkerShape[] = ['circle', 'square', 'cross', 'x', 'diamond', 'triangle']

/** The line patterns a line block accepts. */
export type LinePattern = 'solid' | 'dash' | 'dot' | 'dash-dot'

/** Line patterns in their fixed order (errors name them). */
export const LINE_PATTERNS: readonly LinePattern[] = ['solid', 'dash', 'dot', 'dash-dot']

/** The heatmap gradient presets a heatmap block accepts. */
export type HeatmapRamp = 'viridis' | 'plasma' | 'inferno' | 'magma' | 'blues' | 'reds'

/** Heatmap ramps in their fixed order (errors name them). */
export const HEATMAP_RAMPS: readonly HeatmapRamp[] = ['viridis', 'plasma', 'inferno', 'magma', 'blues', 'reds']

/** Point marker diameter bounds in pixels. */
export const MIN_MARKER_SIZE_PX = 3
export const MAX_MARKER_SIZE_PX = 40

/** Line and outline width bounds in pixels. */
export const MIN_LINE_WIDTH_PX = 0.5
export const MAX_LINE_WIDTH_PX = 12

/** Heatmap radius bounds in pixels. */
export const MIN_HEATMAP_RADIUS_PX = 8
export const MAX_HEATMAP_RADIUS_PX = 60

/** Block-level opacity bounds (multiplies the layer-level opacity at render). */
export const MIN_BLOCK_OPACITY = 0
export const MAX_BLOCK_OPACITY = 1

/** Maximum override entries one layer carries. */
export const MAX_OVERRIDE_ENTRIES = 16

/** Maximum feature ids one override entry names. */
export const MAX_OVERRIDE_FEATURE_IDS = 256

/** Maximum total feature ids one layer's overrides name. */
export const MAX_OVERRIDE_TOTAL_IDS = 1024

/** Maximum feature-id length one override accepts. */
export const MAX_OVERRIDE_ID_CHARS = 128

/** Maximum serialized characters of one imagery URL template. */
export const MAX_IMAGERY_TEMPLATE_CHARS = 512

/** Maximum serialized characters of one imagery attribution line. */
export const MAX_IMAGERY_ATTRIBUTION_CHARS = 200

/** Maximum serialized characters of one layer-group display name. */
export const MAX_GROUP_NAME_CHARS = 64

/**
 * The point symbol block: shape, fill color, diameter, optional block
 * opacity, and an optional outline. `opacity` defaults to 1 and multiplies
 * the layer-level opacity — it never replaces it.
 */
export interface PointSymbolBlock {
  readonly shape: MarkerShape
  readonly color: string
  readonly sizePx: number
  readonly opacity?: number
  readonly outlineColor?: string
  readonly outlineWidthPx?: number
}

/** The line symbol block: color, width, pattern, and optional block opacity. */
export interface LineSymbolBlock {
  readonly color: string
  readonly widthPx: number
  readonly pattern: LinePattern
  readonly opacity?: number
}

/**
 * The polygon fill block: fill color, optional block opacity (the「面层半透明」
 * knob), and an optional outline.
 */
export interface FillSymbolBlock {
  readonly color: string
  readonly opacity?: number
  readonly outlineColor?: string
  readonly outlineWidthPx?: number
}

/** The heatmap presentation block: optional weight field, radius, ramp, and intensity clamps. */
export interface HeatmapBlock {
  /** Property carrying each point's weight; uniform weight when absent. */
  readonly field?: string
  readonly radiusPx: number
  readonly ramp: HeatmapRamp
  readonly minIntensity?: number
  readonly maxIntensity?: number
}

/** One geometry block of the single presentation. */
export type SymbolBlock = PointSymbolBlock | LineSymbolBlock | FillSymbolBlock

/** The single-symbol presentation: one optional block per geometry family. */
export interface SingleSymbolStyle {
  readonly methodVersion: typeof LAYERS_METHOD_VERSION
  readonly presentation: 'single'
  /** Digest version {@link symbolVersionOf} derives; validation refuses a mismatch. */
  readonly symbolVersion: string
  readonly point?: PointSymbolBlock
  readonly line?: LineSymbolBlock
  readonly fill?: FillSymbolBlock
}

/** The heatmap presentation: one block, exclusive with geometry blocks. */
export interface HeatmapSymbolStyle {
  readonly methodVersion: typeof LAYERS_METHOD_VERSION
  readonly presentation: 'heatmap'
  readonly symbolVersion: string
  readonly heatmap: HeatmapBlock
}

/** The presentation style one layer carries (a whole-layer record, not per-class). */
export type SymbolStyle = SingleSymbolStyle | HeatmapSymbolStyle

/** A distributive omit over a union (plain `Omit` would collapse the variants). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** One symbol draft: any presentation without its derived version token. */
export type SymbolStyleDraft = DistributiveOmit<SymbolStyle, 'symbolVersion'>

/** One structured validation issue: the offending field and a stable machine code. */
export interface LayersIssue {
  readonly field: string
  readonly code: string
}

/**
 * The per-feature patch above the layer symbol: a sparse block patch applied
 * to every named feature. Resolution order is override > classification >
 * symbol > default; a later entry wins over an earlier one on overlap.
 */
export interface FeatureOverride {
  /** Stable feature ids (`featureIdOf` semantics); 1..256 distinct ids. */
  readonly featureIds: readonly string[]
  /** Sparse patch over one geometry block's fields; at least one field. */
  readonly patch: Readonly<Partial<PointSymbolBlock> & Partial<LineSymbolBlock> & Partial<FillSymbolBlock>>
}

/** The versioned override set one layer carries. */
export interface FeatureOverrides {
  /** Digest version {@link overridesVersionOf} derives; validation refuses a mismatch. */
  readonly overridesVersion: string
  readonly entries: readonly FeatureOverride[]
}

/**
 * The tile-overlay identity an imagery layer carries: a key-free HTTPS XYZ
 * template in its normalized ArcGIS form. The zero-key policy is structural:
 * userinfo and query strings refuse admission, so credential-carrying
 * templates never enter the projection.
 */
export interface ImagerySpec {
  readonly methodVersion: typeof LAYERS_METHOD_VERSION
  /** Normalized `{level}/{row}/{col}` HTTPS template (no query, no userinfo). */
  readonly urlTemplate: string
  readonly attribution?: string
}

/** The spec value the symbol version digest covers: everything except the token itself. */
function symbolVersionInputOf(symbol: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(symbol).filter(([key]) => key !== 'symbolVersion'))
}

/** The entries value the overrides version digest covers: the bare entry list. */
function overridesVersionInputOf(entries: readonly FeatureOverride[]): unknown {
  return entries
}

/**
 * Derive the symbol version of one style (`sym-<digest>@v1`). Key-order
 * independent, so the same presentation always carries the same version.
 * @param symbol - the style to version; a present `symbolVersion` is ignored.
 * @returns the derived version string.
 */
export function symbolVersionOf(symbol: SymbolStyleDraft): string {
  return `sym-${vizDigestOf(symbolVersionInputOf(symbol))}@v1`
}

/** Derive the version of one raw (untyped) payload — the validator's re-derivation face. */
function derivedSymbolVersionOf(value: object): string {
  return `sym-${vizDigestOf(symbolVersionInputOf(value))}@v1`
}

/**
 * Derive the overrides version of one entry list (`ovr-<digest>@v1`).
 * @param entries - the override entries to version.
 * @returns the derived version string.
 */
export function overridesVersionOf(entries: readonly FeatureOverride[]): string {
  return `ovr-${vizDigestOf(overridesVersionInputOf(entries))}@v1`
}

/** Report one bound violation when a value is outside `[min, max]`. */
function checkBound(issues: LayersIssue[], field: string, value: unknown, min: number, max: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    issues.push({ field, code: 'out-of-range' })
  }
}

/** Report one hex-color violation. */
function checkColor(issues: LayersIssue[], field: string, value: unknown): void {
  if (!isHexColor(value)) issues.push({ field, code: 'invalid-color' })
}

/** The union of optional outline fields every block shares. */
interface OutlineFields {
  readonly outlineColor?: string
  readonly outlineWidthPx?: number
}

/** Validate one block's outline fields. */
function checkOutline(issues: LayersIssue[], block: OutlineFields, prefix: string): void {
  if (block.outlineColor !== undefined) checkColor(issues, `${prefix}.outlineColor`, block.outlineColor)
  if (block.outlineWidthPx !== undefined) checkBound(issues, `${prefix}.outlineWidthPx`, block.outlineWidthPx, MIN_LINE_WIDTH_PX, MAX_LINE_WIDTH_PX)
}

/** Check one block-level opacity field. */
function checkBlockOpacity(issues: LayersIssue[], field: string, value: unknown): void {
  if (value !== undefined) checkBound(issues, field, value, MIN_BLOCK_OPACITY, MAX_BLOCK_OPACITY)
}

/**
 * Validate one symbol style and return every structural issue: vocabulary,
 * bounds, presentation exclusivity, and the declared `symbolVersion`
 * re-derivation. Layer-dependent rules (all-Point data, no coexisting
 * classification style) belong to the tool and fold boundaries.
 * @param symbol - the raw style value.
 * @returns every issue, in field order; empty when the style is valid.
 */
export function validateSymbolStyle(symbol: unknown): LayersIssue[] {
  const issues: LayersIssue[] = []
  const fail = (field: string, code: string): void => { issues.push({ field, code }) }
  if (typeof symbol !== 'object' || symbol === null) return [{ field: 'symbol', code: 'not-an-object' }]
  const style = symbol as Record<string, unknown>
  if (style.methodVersion !== LAYERS_METHOD_VERSION) fail('methodVersion', 'unknown-method-version')
  if (style.presentation !== 'single' && style.presentation !== 'heatmap') {
    fail('presentation', 'unknown-vocabulary')
    return issues
  }
  if (style.presentation === 'single') {
    const point = style.point as Record<string, unknown> | undefined
    const line = style.line as Record<string, unknown> | undefined
    const fill = style.fill as Record<string, unknown> | undefined
    if (point === undefined && line === undefined && fill === undefined) fail('symbol', 'single-requires-one-block')
    if (style.heatmap !== undefined) fail('heatmap', 'heatmap-block-on-single')
    if (point !== undefined) {
      if (!MARKER_SHAPES.includes(point.shape as MarkerShape)) fail('point.shape', 'unknown-vocabulary')
      checkColor(issues, 'point.color', point.color)
      checkBound(issues, 'point.sizePx', point.sizePx, MIN_MARKER_SIZE_PX, MAX_MARKER_SIZE_PX)
      checkBlockOpacity(issues, 'point.opacity', point.opacity)
      checkOutline(issues, point, 'point')
    }
    if (line !== undefined) {
      checkColor(issues, 'line.color', line.color)
      checkBound(issues, 'line.widthPx', line.widthPx, MIN_LINE_WIDTH_PX, MAX_LINE_WIDTH_PX)
      if (!LINE_PATTERNS.includes(line.pattern as LinePattern)) fail('line.pattern', 'unknown-vocabulary')
      checkBlockOpacity(issues, 'line.opacity', line.opacity)
    }
    if (fill !== undefined) {
      checkColor(issues, 'fill.color', fill.color)
      checkBlockOpacity(issues, 'fill.opacity', fill.opacity)
      checkOutline(issues, fill, 'fill')
    }
  } else {
    const heatmap = style.heatmap as Record<string, unknown> | undefined
    if (typeof heatmap !== 'object' || heatmap === null) {
      fail('heatmap', 'required')
    } else {
      if (pointBlockPresent(style)) fail('point', 'geometry-block-on-heatmap')
      if (lineBlockPresent(style)) fail('line', 'geometry-block-on-heatmap')
      if (fillBlockPresent(style)) fail('fill', 'geometry-block-on-heatmap')
      if (heatmap.field !== undefined && (typeof heatmap.field !== 'string' || heatmap.field.length === 0)) fail('heatmap.field', 'required')
      checkBound(issues, 'heatmap.radiusPx', heatmap.radiusPx, MIN_HEATMAP_RADIUS_PX, MAX_HEATMAP_RADIUS_PX)
      if (!HEATMAP_RAMPS.includes(heatmap.ramp as HeatmapRamp)) fail('heatmap.ramp', 'unknown-vocabulary')
      const minIntensity = heatmap.minIntensity
      const maxIntensity = heatmap.maxIntensity
      if (minIntensity !== undefined && (typeof minIntensity !== 'number' || !Number.isFinite(minIntensity))) fail('heatmap.minIntensity', 'non-finite')
      if (maxIntensity !== undefined && (typeof maxIntensity !== 'number' || !Number.isFinite(maxIntensity))) fail('heatmap.maxIntensity', 'non-finite')
      if (typeof minIntensity === 'number' && typeof maxIntensity === 'number' && minIntensity > maxIntensity) fail('heatmap.minIntensity', 'exceeds-max')
    }
  }
  if (typeof style.symbolVersion !== 'string' || style.symbolVersion.length === 0) {
    fail('symbolVersion', 'required')
  } else if (issues.length === 0 && style.symbolVersion !== derivedSymbolVersionOf(style)) {
    fail('symbolVersion', 'version-mismatch')
  }
  return issues
}

function pointBlockPresent(style: Record<string, unknown>): boolean {
  return style.point !== undefined
}

function lineBlockPresent(style: Record<string, unknown>): boolean {
  return style.line !== undefined
}

function fillBlockPresent(style: Record<string, unknown>): boolean {
  return style.fill !== undefined
}

/** The patch fields one override accepts, with their per-field checks. */
const OVERRIDE_PATCH_FIELDS = ['shape', 'color', 'sizePx', 'opacity', 'outlineColor', 'outlineWidthPx', 'widthPx', 'pattern'] as const

/**
 * Validate one override set and return every structural issue: entry count,
 * per-entry id bounds and distinctness, patch grammar and bounds, and the
 * declared `overridesVersion` re-derivation. Whether the named feature ids
 * exist in the layer's data is a boundary check, not a structural one.
 * @param overrides - the raw overrides value.
 * @returns every issue; empty when the set is valid.
 */
export function validateFeatureOverrides(overrides: unknown): LayersIssue[] {
  const issues: LayersIssue[] = []
  const fail = (field: string, code: string): void => { issues.push({ field, code }) }
  if (typeof overrides !== 'object' || overrides === null) return [{ field: 'overrides', code: 'not-an-object' }]
  const record = overrides as Record<string, unknown>
  const entries = record.entries
  if (!Array.isArray(entries) || entries.length === 0) {
    return [{ field: 'overrides.entries', code: 'required' }]
  }
  if (entries.length > MAX_OVERRIDE_ENTRIES) fail('overrides.entries', 'too-many-entries')
  let totalIds = 0
  for (const [at, entry] of entries.entries()) {
    const prefix = `overrides.entries[${at}]`
    if (typeof entry !== 'object' || entry === null) {
      fail(prefix, 'not-an-object')
      continue
    }
    const { featureIds, patch } = entry as Record<string, unknown>
    if (!Array.isArray(featureIds) || featureIds.length === 0) {
      fail(`${prefix}.featureIds`, 'required')
    } else {
      if (featureIds.length > MAX_OVERRIDE_FEATURE_IDS) fail(`${prefix}.featureIds`, 'too-many-ids')
      const seen = new Set<string>()
      for (const id of featureIds) {
        if (typeof id !== 'string' || id.length === 0 || id.length > MAX_OVERRIDE_ID_CHARS) {
          fail(`${prefix}.featureIds`, 'invalid-id')
          break
        }
        if (seen.has(id)) {
          fail(`${prefix}.featureIds`, 'duplicate-id')
          break
        }
        seen.add(id)
      }
      totalIds += featureIds.length
    }
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      fail(`${prefix}.patch`, 'not-an-object')
      continue
    }
    const patchRecord = patch as Record<string, unknown>
    const present = OVERRIDE_PATCH_FIELDS.filter(field => patchRecord[field] !== undefined)
    if (present.length === 0) fail(`${prefix}.patch`, 'empty-patch')
    const unknownFields = Object.keys(patchRecord).filter(field => !(OVERRIDE_PATCH_FIELDS as readonly string[]).includes(field))
    if (unknownFields.length > 0) fail(`${prefix}.patch`, 'unknown-field')
    if (patchRecord.shape !== undefined && !MARKER_SHAPES.includes(patchRecord.shape as MarkerShape)) fail(`${prefix}.patch.shape`, 'unknown-vocabulary')
    if (patchRecord.pattern !== undefined && !LINE_PATTERNS.includes(patchRecord.pattern as LinePattern)) fail(`${prefix}.patch.pattern`, 'unknown-vocabulary')
    if (patchRecord.color !== undefined) checkColor(issues, `${prefix}.patch.color`, patchRecord.color)
    if (patchRecord.outlineColor !== undefined) checkColor(issues, `${prefix}.patch.outlineColor`, patchRecord.outlineColor)
    if (patchRecord.sizePx !== undefined) checkBound(issues, `${prefix}.patch.sizePx`, patchRecord.sizePx, MIN_MARKER_SIZE_PX, MAX_MARKER_SIZE_PX)
    if (patchRecord.widthPx !== undefined) checkBound(issues, `${prefix}.patch.widthPx`, patchRecord.widthPx, MIN_LINE_WIDTH_PX, MAX_LINE_WIDTH_PX)
    if (patchRecord.outlineWidthPx !== undefined) checkBound(issues, `${prefix}.patch.outlineWidthPx`, patchRecord.outlineWidthPx, MIN_LINE_WIDTH_PX, MAX_LINE_WIDTH_PX)
    checkBlockOpacity(issues, `${prefix}.patch.opacity`, patchRecord.opacity)
  }
  if (totalIds > MAX_OVERRIDE_TOTAL_IDS) fail('overrides.entries', 'too-many-total-ids')
  if (typeof record.overridesVersion !== 'string' || record.overridesVersion.length === 0) {
    fail('overrides.overridesVersion', 'required')
  } else if (issues.length === 0
    && record.overridesVersion !== overridesVersionOf(entries as FeatureOverride[])) {
    fail('overrides.overridesVersion', 'version-mismatch')
  }
  return issues
}

/** Whether one string contains no control characters (C0/C1) or whitespace besides spaces. */
function isDisplayText(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false
  }
  return true
}

/**
 * Validate one layer-group display name: 1..64 characters, no control
 * characters. Group membership is implicit — the group set is the set of
 * names in use, with no second registry.
 * @param name - the raw group name.
 * @returns the issue code, or `null` when the name is valid.
 */
export function validateGroupName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length === 0) return 'required'
  if (name.length > MAX_GROUP_NAME_CHARS) return 'too-long'
  if (!isDisplayText(name)) return 'control-characters'
  return null
}

/** The ArcGIS tile-coordinate tokens the normalized template must carry. */
const ARCGIS_TILE_TOKENS = ['{level}', '{row}', '{col}'] as const

/** The XYZ tile-coordinate tokens a raw template may carry instead. */
const XYZ_TILE_TOKENS = ['{z}', '{y}', '{x}'] as const

/** Whether every token of one set occurs in the template. */
function carriesTokens(template: string, tokens: readonly string[]): boolean {
  return tokens.every(token => template.includes(token))
}

/**
 * Validate one raw imagery URL template at the tool boundary: HTTPS, no
 * userinfo, no query or fragment, bounded length, and one complete
 * tile-coordinate token set (`{z}/{y}/{x}` or `{level}/{row}/{col}`).
 * @param urlTemplate - the raw template the caller supplied.
 * @returns every issue; empty when the template is admissible.
 */
export function validateImageryTemplate(urlTemplate: unknown): LayersIssue[] {
  const issues: LayersIssue[] = []
  const fail = (code: string): void => { issues.push({ field: 'imagery.urlTemplate', code }) }
  if (typeof urlTemplate !== 'string' || urlTemplate.length === 0) return [{ field: 'imagery.urlTemplate', code: 'required' }]
  if (urlTemplate.length > MAX_IMAGERY_TEMPLATE_CHARS) fail('too-long')
  if (!urlTemplate.startsWith('https://')) fail('not-https')
  let parsed: URL
  try {
    parsed = new URL(urlTemplate)
  } catch {
    return [{ field: 'imagery.urlTemplate', code: 'unparseable' }]
  }
  if (parsed.username !== '' || parsed.password !== '') fail('userinfo-present')
  if (parsed.search !== '') fail('query-present')
  if (parsed.hash !== '') fail('fragment-present')
  if (/\s/u.test(urlTemplate)) fail('whitespace-present')
  const hasArcgis = carriesTokens(urlTemplate, ARCGIS_TILE_TOKENS)
  const hasXyz = carriesTokens(urlTemplate, XYZ_TILE_TOKENS)
  if (!hasArcgis && !hasXyz) fail('missing-tile-tokens')
  if (hasArcgis && hasXyz) fail('mixed-tile-tokens')
  return issues
}

/**
 * Normalize one admissible template to the ArcGIS tile tokens. XYZ
 * `{z}/{y}/{x}` maps to `{level}/{row}/{col}`; an already-normalized
 * template returns unchanged.
 * @param urlTemplate - the admissible raw template.
 * @returns the normalized template.
 */
export function normalizeImageryTemplate(urlTemplate: string): string {
  return urlTemplate.replaceAll('{z}', '{level}').replaceAll('{y}', '{row}').replaceAll('{x}', '{col}')
}

/**
 * Build one admissible, normalized imagery spec from raw tool input.
 * @param urlTemplate - the raw template.
 * @param attribution - the optional attribution line.
 * @returns the validated spec.
 * @throws {Error} naming the first issue when the input is inadmissible.
 */
export function imagerySpecOf(urlTemplate: unknown, attribution?: unknown): ImagerySpec {
  const issues = validateImageryTemplate(urlTemplate)
  if (issues.length > 0) throw new Error(`imagery template rejected: ${issues[0]?.field} (${issues[0]?.code})`)
  if (attribution !== undefined
    && (typeof attribution !== 'string' || attribution.length === 0 || attribution.length > MAX_IMAGERY_ATTRIBUTION_CHARS || !isDisplayText(attribution))) {
    throw new Error('imagery attribution rejected: attribution (invalid)')
  }
  return {
    methodVersion: LAYERS_METHOD_VERSION,
    urlTemplate: normalizeImageryTemplate(urlTemplate as string),
    ...(attribution === undefined ? {} : { attribution: attribution as string }),
  }
}

/**
 * Validate one persisted imagery spec (the fold-time face): the template
 * must already be the normalized ArcGIS form, and every structural rule of
 * {@link validateImageryTemplate} holds on it.
 * @param spec - the raw spec value.
 * @returns every issue; empty when the spec is valid.
 */
export function validateImagerySpec(spec: unknown): LayersIssue[] {
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) return [{ field: 'imagery', code: 'not-an-object' }]
  const record = spec as Record<string, unknown>
  const issues: LayersIssue[] = []
  if (record.methodVersion !== LAYERS_METHOD_VERSION) issues.push({ field: 'imagery.methodVersion', code: 'unknown-method-version' })
  issues.push(...validateImageryTemplate(record.urlTemplate))
  if (typeof record.urlTemplate === 'string' && carriesTokens(record.urlTemplate, XYZ_TILE_TOKENS)) {
    issues.push({ field: 'imagery.urlTemplate', code: 'not-normalized' })
  }
  if (record.attribution !== undefined
    && (typeof record.attribution !== 'string' || record.attribution.length === 0 || record.attribution.length > MAX_IMAGERY_ATTRIBUTION_CHARS)) {
    issues.push({ field: 'imagery.attribution', code: 'invalid' })
  }
  return issues
}
