/**
 * The single-symbol legend derivation: `legendOfSymbol` reads the geometry
 * blocks of one single-presentation symbol into legend rows carrying the
 * block opacity explicitly, so the legend and the renderer compose the same
 * rgba. The legend derives — it never re-decides a color: a classified
 * layer's legend still comes from `spatial-viz` `legendOf(style)`, and this
 * derivation serves only layers carrying a symbol without a classification.
 *
 * @module @map-harness/map-layers/legend
 */
import { resolveSingleSymbol } from './semantic.ts'
import { LAYERS_METHOD_VERSION, type FeatureSemantic, type FillSymbolBlock, type MarkerShape, type LineSymbolBlock, type PointSymbolBlock, type SingleSymbolStyle, type SymbolStyle } from './contract.ts'

/** One legend row: the geometry family, its colors, and its block opacity. */
export interface SymbolLegendRow {
  readonly geometry: 'point' | 'line' | 'fill'
  /** The marker shape a point row draws (point rows only). */
  readonly shape?: MarkerShape
  readonly color: string
  readonly outline?: string
  /** Block opacity in `[0, 1]`; explicit so the legend renders the same rgba the map does. */
  readonly opacity: number
}

/** The legend derived from one single-presentation symbol. */
export interface SymbolLegendSpec {
  readonly methodVersion: typeof LAYERS_METHOD_VERSION
  readonly symbolVersion: string
  readonly presentation: 'single'
  /** The declared feature semantics, when the symbol names one (the legend caption). */
  readonly semantic?: FeatureSemantic
  readonly rows: readonly SymbolLegendRow[]
}

/** Narrow one symbol style to its single-presentation face. */
export function asSingleSymbol(symbol: SymbolStyle): SingleSymbolStyle | undefined {
  return symbol.presentation === 'single' ? symbol : undefined
}

/** One point block's legend row. */
function rowOfPoint(point: PointSymbolBlock): SymbolLegendRow {
  return {
    geometry: 'point',
    shape: point.shape,
    color: point.color,
    ...(point.outlineColor === undefined ? {} : { outline: point.outlineColor }),
    opacity: point.opacity ?? 1,
  }
}

/** One line block's legend row. */
function rowOfLine(line: LineSymbolBlock): SymbolLegendRow {
  return { geometry: 'line', color: line.color, opacity: line.opacity ?? 1 }
}

/** One fill block's legend row. */
function rowOfFill(fill: FillSymbolBlock): SymbolLegendRow {
  return {
    geometry: 'fill',
    color: fill.color,
    ...(fill.outlineColor === undefined ? {} : { outline: fill.outlineColor }),
    opacity: fill.opacity ?? 1,
  }
}

/**
 * Derive the legend of one single-presentation symbol, one row per resolved
 * geometry block in point/line/fill order. Semantic defaults resolve first
 * (`resolveSingleSymbol`), so the legend shows the blocks the map draws;
 * `families` narrows the rows to the geometry the layer's data carries.
 * @param declared - the validated single-presentation symbol.
 * @param families - the geometry families to keep; all when absent.
 * @returns the legend specification.
 */
export function legendOfSymbol(declared: SingleSymbolStyle, families?: ReadonlySet<SymbolLegendRow['geometry']>): SymbolLegendSpec {
  const symbol = resolveSingleSymbol(declared)
  const rows: SymbolLegendRow[] = []
  if (symbol.point !== undefined) rows.push(rowOfPoint(symbol.point))
  if (symbol.line !== undefined) rows.push(rowOfLine(symbol.line))
  if (symbol.fill !== undefined) rows.push(rowOfFill(symbol.fill))
  return {
    methodVersion: LAYERS_METHOD_VERSION,
    symbolVersion: symbol.symbolVersion,
    presentation: 'single',
    ...(symbol.semantic === undefined ? {} : { semantic: symbol.semantic }),
    rows: families === undefined ? rows : rows.filter(row => families.has(row.geometry)),
  }
}
