/**
 * The workbench symbol-legend derivation: the single-symbol legend face of
 * the first visible layer that carries a presentation symbol without a
 * classification style. The rows come from `map-layers` `legendOfSymbol`,
 * block opacity included, so the legend renders the same rgba the map does.
 *
 * A classified layer's legend stays with `spatial-viz` `legendOf(style)` —
 * the symbol face never competes with the classification authority, and a
 * heatmap presentation carries no single-symbol rows.
 *
 * @module @map-harness/map-container/client/symbol-legend
 */
import { inferredSymbolOf, legendOfSymbol, type FeatureSemantic, type SymbolLegendRow } from '@map-harness/map-layers'
import type { MapContainerWire } from './state.ts'
import { legendFamiliesOf } from './panel-view.ts'

/** The symbol-legend face the workbench legend section renders. */
export interface SymbolLegendFace {
  readonly layerId: string
  readonly title: string
  readonly symbolVersion: string
  /** The declared feature semantics, when the symbol names one (the legend caption). */
  readonly semantic?: FeatureSemantic
  readonly rows: readonly SymbolLegendRow[]
}

/**
 * Derive the symbol legend of one wire snapshot: the first visible layer
 * carrying a single-presentation symbol and no classification style.
 * @param wire - the current `mapContainer` wire value.
 * @returns the symbol-legend face, or `null` when no layer qualifies.
 */
export function symbolLegendOf(wire: MapContainerWire): SymbolLegendFace | null {
  for (const layer of wire.layers) {
    if (layer.visible === false) continue
    if (layer.style !== undefined) continue
    const symbol = layer.symbol === undefined ? inferredSymbolOf(layer.name, layer.id) : layer.symbol
    if (symbol === undefined || symbol.presentation !== 'single') continue
    const legend = legendOfSymbol(symbol, legendFamiliesOf(layer.data))
    return {
      layerId: layer.id,
      title: layer.name,
      symbolVersion: symbol.symbolVersion,
      ...(legend.semantic === undefined ? {} : { semantic: legend.semantic }),
      rows: legend.rows,
    }
  }
  return null
}
