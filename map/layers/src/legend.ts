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
import { LAYERS_METHOD_VERSION, type FillSymbolBlock, type LineSymbolBlock, type PointSymbolBlock, type SingleSymbolStyle, type SymbolStyle } from './contract.ts'

/** One legend row: the geometry family, its colors, and its block opacity. */
export interface SymbolLegendRow {
  readonly geometry: 'point' | 'line' | 'fill'
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
 * Derive the legend of one single-presentation symbol, one row per geometry
 * block in point/line/fill order.
 * @param symbol - the validated single-presentation symbol.
 * @returns the legend specification.
 */
export function legendOfSymbol(symbol: SingleSymbolStyle): SymbolLegendSpec {
  const rows: SymbolLegendRow[] = []
  if (symbol.point !== undefined) rows.push(rowOfPoint(symbol.point))
  if (symbol.line !== undefined) rows.push(rowOfLine(symbol.line))
  if (symbol.fill !== undefined) rows.push(rowOfFill(symbol.fill))
  return {
    methodVersion: LAYERS_METHOD_VERSION,
    symbolVersion: symbol.symbolVersion,
    presentation: 'single',
    rows,
  }
}
