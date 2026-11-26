/** Shared color resolution for map graphics and their panel legends. */
import { inferredSymbolOf, resolveSingleSymbol, type FeatureOverrides, type HeatmapRamp, type SingleSymbolStyle, type SymbolStyle } from '@map-harness/map-layers'
import type { ClassifiedValue, StyleSpec } from '@map-harness/spatial-viz/browser'

/** Geometry families with ArcGIS vector symbols. */
export type GeometryFamily = 'Point' | 'LineString' | 'Polygon'
/** Sparse fields from one feature override. */
export type OverridePatch = FeatureOverrides['entries'][number]['patch']

/** Unselected symbol color before layer opacity is applied. */
export interface ResolvedColor {
  readonly color: string
  readonly opacity: number
}

const DEFAULT_BASE_COLOR = '#4264fb'
const FALLBACK_FILL_OPACITY = 0.3

const HEATMAP_RAMP_STOPS: Readonly<Record<HeatmapRamp, readonly string[]>> = {
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  plasma: ['#0d0887', '#7e03a8', '#cc4778', '#f89540', '#f0f921'],
  inferno: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'],
  magma: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'],
  blues: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'],
  reds: ['#fff5f0', '#fcbba1', '#fb6a4a', '#cb181d', '#67000d'],
}

/** Resolve explicit and inferred single-symbol blocks. */
export function singleSymbolOf(layer: { readonly name: string; readonly id: string; readonly symbol?: SymbolStyle | undefined }): SingleSymbolStyle | undefined {
  if (layer.symbol !== undefined) return layer.symbol.presentation === 'single' ? resolveSingleSymbol(layer.symbol) : undefined
  return inferredSymbolOf(layer.name, layer.id)
}

/** Index overrides by feature identity; the last entry wins. */
export function overrideTableOf(overrides: FeatureOverrides | undefined): Map<string, OverridePatch> {
  const table = new Map<string, OverridePatch>()
  for (const entry of overrides?.entries ?? []) {
    for (const id of entry.featureIds) table.set(id, entry.patch)
  }
  return table
}

/** Resolve the unselected feature color and symbol opacity before layer opacity. */
export function featureColorOf(
  geometry: GeometryFamily,
  style: StyleSpec | null,
  classified: ClassifiedValue,
  symbol: SingleSymbolStyle | undefined,
  declaredSymbol: boolean,
  override: OverridePatch | undefined,
  legendColor: string | undefined,
): ResolvedColor {
  const classColor = style === null ? undefined : typeof classified === 'number'
    ? style.palette[classified] : classified === 'missing' ? style.missingColor : style.overflowColor
  const block = geometry === 'Point' ? symbol?.point : geometry === 'LineString' ? symbol?.line : symbol?.fill
  const color = override?.color ?? classColor ?? block?.color ?? legendColor ?? DEFAULT_BASE_COLOR
  const opacity = override?.opacity ?? (classColor === undefined || declaredSymbol ? block?.opacity : undefined)
    ?? (geometry === 'Polygon' && classColor === undefined && block === undefined ? FALLBACK_FILL_OPACITY : 1)
  return { color, opacity }
}

/** Convert a six-digit color and opacity to the CSS form accepted by ArcGIS and the browser. */
export function rgbaOf(color: string, opacity: number): string {
  if (opacity >= 1) return color
  const channels = [1, 3, 5].map(at => Number.parseInt(color.slice(at, at + 2), 16))
  return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${Math.max(0, Math.min(1, opacity))})`
}

/** Return the stops used by the ArcGIS heatmap renderer. */
export function heatmapStopsOf(ramp: HeatmapRamp): readonly string[] {
  return HEATMAP_RAMP_STOPS[ramp]
}
