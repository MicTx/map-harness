/**
 * The semantic symbol table: each {@link FeatureSemantic} word maps to one
 * complete point/line/fill block set in the Mapbox-style visual language
 * (white-haloed markers, saturated route lines, translucent fills with a
 * same-hue outline). `resolveSingleSymbol` expands a declared semantic under
 * the explicit blocks, so the renderer and the legend read one resolved
 * symbol and never re-decide a color.
 *
 * Resolution is per block: an explicit `point`/`line`/`fill` block replaces
 * the semantic block of its geometry family whole; families the symbol does
 * not name come from the semantic table.
 *
 * @module @map-harness/map-layers/semantic
 */
import { LAYERS_METHOD_VERSION, symbolVersionOf } from './contract.ts'
import type {
  FeatureSemantic,
  FillSymbolBlock,
  LinePattern,
  LineSymbolBlock,
  MarkerShape,
  PointSymbolBlock,
  SingleSymbolStyle,
  SymbolStyleDraft,
} from './contract.ts'

/** The marker halo every semantic point wears (white ring against any basemap). */
export const SEMANTIC_HALO_COLOR = '#ffffff'

/** The halo width of semantic markers in pixels. */
export const SEMANTIC_HALO_WIDTH_PX = 1.5

/** One semantic row: hue, marker shape and size, line width and pattern, fill opacity. */
interface SemanticRow {
  readonly color: string
  readonly shape: MarkerShape
  readonly sizePx: number
  readonly widthPx: number
  readonly pattern: LinePattern
  readonly fillOpacity: number
  readonly outlineWidthPx: number
}

/** The fixed semantic table. Colors follow the Mapbox Studio default hues. */
const SEMANTIC_ROWS: Readonly<Record<FeatureSemantic, SemanticRow>> = Object.freeze({
  poi: { color: '#4264fb', shape: 'circle', sizePx: 9, widthPx: 2, pattern: 'solid', fillOpacity: 0.25, outlineWidthPx: 1.2 },
  facility: { color: '#e55e5e', shape: 'square', sizePx: 10, widthPx: 2, pattern: 'solid', fillOpacity: 0.25, outlineWidthPx: 1.2 },
  transit: { color: '#7753eb', shape: 'diamond', sizePx: 10, widthPx: 3, pattern: 'solid', fillOpacity: 0.2, outlineWidthPx: 1.2 },
  road: { color: '#f2a93b', shape: 'circle', sizePx: 7, widthPx: 3, pattern: 'solid', fillOpacity: 0.2, outlineWidthPx: 1 },
  route: { color: '#1f6feb', shape: 'circle', sizePx: 8, widthPx: 4.5, pattern: 'solid', fillOpacity: 0.2, outlineWidthPx: 1.5 },
  boundary: { color: '#8b6fb3', shape: 'cross', sizePx: 8, widthPx: 1.5, pattern: 'dash', fillOpacity: 0, outlineWidthPx: 1.5 },
  water: { color: '#3d9ad1', shape: 'circle', sizePx: 8, widthPx: 2, pattern: 'solid', fillOpacity: 0.35, outlineWidthPx: 1 },
  green: { color: '#3ba55c', shape: 'triangle', sizePx: 9, widthPx: 2, pattern: 'solid', fillOpacity: 0.3, outlineWidthPx: 1 },
  building: { color: '#8792a2', shape: 'square', sizePx: 8, widthPx: 1.5, pattern: 'solid', fillOpacity: 0.45, outlineWidthPx: 0.8 },
  landuse: { color: '#d9a441', shape: 'square', sizePx: 8, widthPx: 1.5, pattern: 'solid', fillOpacity: 0.25, outlineWidthPx: 0.8 },
  aoi: { color: '#ee4e8b', shape: 'circle', sizePx: 9, widthPx: 2, pattern: 'dash', fillOpacity: 0.08, outlineWidthPx: 2 },
  hotspot: { color: '#e8453c', shape: 'triangle', sizePx: 11, widthPx: 2.5, pattern: 'solid', fillOpacity: 0.35, outlineWidthPx: 1.2 },
})

/** The three geometry blocks one semantic resolves to. */
export interface SemanticBlocks {
  readonly point: PointSymbolBlock
  readonly line: LineSymbolBlock
  readonly fill: FillSymbolBlock
}

/**
 * The default blocks of one semantic word.
 * @param semantic - the declared feature semantics.
 * @returns the complete point/line/fill block set.
 */
export function semanticBlocksOf(semantic: FeatureSemantic): SemanticBlocks {
  const row = SEMANTIC_ROWS[semantic]
  return {
    point: { shape: row.shape, color: row.color, sizePx: row.sizePx, outlineColor: SEMANTIC_HALO_COLOR, outlineWidthPx: SEMANTIC_HALO_WIDTH_PX },
    line: { color: row.color, widthPx: row.widthPx, pattern: row.pattern },
    fill: { color: row.color, opacity: row.fillOpacity, outlineColor: row.color, outlineWidthPx: row.outlineWidthPx },
  }
}

/**
 * Expand a single symbol's semantic defaults under its explicit blocks. A
 * symbol without a semantic returns unchanged (same reference).
 * @param symbol - the validated single-presentation symbol.
 * @returns the symbol with every geometry family resolved.
 */
export function resolveSingleSymbol(symbol: SingleSymbolStyle): SingleSymbolStyle {
  if (symbol.semantic === undefined) return symbol
  const base = semanticBlocksOf(symbol.semantic)
  return {
    ...symbol,
    point: symbol.point ?? base.point,
    line: symbol.line ?? base.line,
    fill: symbol.fill ?? base.fill,
  }
}

/**
 * Keyword rules in priority order (specific before general): CJK terms match
 * as substrings, ASCII words only at word boundaries so `bus` never matches
 * `business`.
 */
const SEMANTIC_RULES: readonly (readonly [FeatureSemantic, RegExp])[] = [
  ['hotspot', /热点|热力|聚集|(^|[^a-z])(hotspots?|clusters?)([^a-z]|$)/],
  ['aoi', /研究区|分析范围|(^|[^a-z])(aoi|study[ _-]?area)([^a-z]|$)/],
  ['boundary', /边界|行政区|区划|(^|[^a-z])(boundar(y|ies)|admin|districts?)([^a-z]|$)/],
  ['water', /水系|水域|河流|湖泊|海洋|(^|[^a-z])(water|rivers?|lakes?|sea)([^a-z]|$)/],
  ['green', /绿地|绿化|公园|森林|林地|(^|[^a-z])(green|parks?|forests?)([^a-z]|$)/],
  ['building', /建筑|楼宇|(^|[^a-z])(buildings?|footprints?)([^a-z]|$)/],
  ['landuse', /用地|土地|(^|[^a-z])(land[ _-]?use|landcover|zoning)([^a-z]|$)/],
  ['route', /路径|路线|导航|等时|(^|[^a-z])(routes?|paths?|isochrones?|trajector(y|ies))([^a-z]|$)/],
  ['road', /道路|路网|街道|公路|(^|[^a-z])(roads?|streets?|highways?)([^a-z]|$)/],
  ['transit', /地铁|公交|轨道|车站|(^|[^a-z])(transit|metro|subway|bus|stations?)([^a-z]|$)/],
  ['facility', /医院|医疗|学校|学院|商场|设施|(^|[^a-z])(hospitals?|schools?|clinics?|facilit(y|ies))([^a-z]|$)/],
  ['poi', /兴趣点|餐厅|商店|(^|[^a-z])(pois?|shops?|restaurants?)([^a-z]|$)/],
]

/**
 * Infer a layer's feature semantic from its display name and id, so a layer
 * that declared no symbol still wears the style of what it is.
 * @param texts - the layer name and id (any order).
 * @returns the first matching semantic, or `undefined` when none matches.
 */
export function inferSemanticOf(...texts: readonly string[]): FeatureSemantic | undefined {
  const haystack = texts.join(' ').toLowerCase()
  return SEMANTIC_RULES.find(([, pattern]) => pattern.test(haystack))?.[0]
}

/**
 * The complete single symbol a layer without a declared symbol wears: the
 * semantic its name or id implies, resolved to point/line/fill blocks. The
 * map, the layer chip, and the legend all read this one value, so they agree.
 * @param texts - the layer name and id (any order).
 * @returns the versioned symbol, or `undefined` when no semantic matches.
 */
export function inferredSymbolOf(...texts: readonly string[]): SingleSymbolStyle | undefined {
  const semantic = inferSemanticOf(...texts)
  if (semantic === undefined) return undefined
  const draft: SymbolStyleDraft = { methodVersion: LAYERS_METHOD_VERSION, presentation: 'single', semantic }
  return resolveSingleSymbol({ ...draft, symbolVersion: symbolVersionOf(draft) })
}
