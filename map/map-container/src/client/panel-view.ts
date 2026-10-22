/**
 * The layer panel's pure derivation faces: per-layer faces (type badge,
 * legend chip, reference) and the bounded attribute table. Everything derives
 * from the wire with the same authority functions the map renders through —
 * `legendOf`/`legendOfSymbol` for chips, `featureIdOf` for row ids — so the
 * panel can never present a second color or identity authority.
 *
 * Pure module: no ArcGIS imports, plain data in and out, deterministic under
 * `node --test` (the `symbol-legend.ts` precedent for component derivations).
 *
 * @module @map-harness/map-container/client/panel-view
 */
import { MAX_ATTRIBUTE_ROWS, featureIdOf, legendOf } from '@map-harness/spatial-viz'
import { asSingleSymbol, legendOfSymbol, type HeatmapRamp, type SymbolLegendRow } from '@map-harness/map-layers'
import type { MapContainerWire } from './state.ts'

/** One wire layer as the panel consumes it (the runtime wire carries `featureCount`; the shared type omits it). */
type WireLayer = MapContainerWire['layers'][number] & { readonly featureCount?: unknown }

/** The layer families the panel badges; derivation order is presentation, then data. */
export type PanelBadge = 'point' | 'line' | 'polygon' | 'heatmap' | 'imagery' | 'thematic' | 'data'

/** Attribute columns the panel table shows; further keys report as overflow. */
export const PANEL_MAX_ATTRIBUTE_COLUMNS = 12

/** Attribute rows one panel table page shows (the workbench page size). */
export const PANEL_ATTRIBUTE_PAGE_SIZE = 8

/** Characters one attribute cell keeps before truncating with an ellipsis. */
export const PANEL_ATTRIBUTE_CELL_CHARS = 48

/**
 * The fixed gradient stops one heatmap ramp renders. These mirror the
 * renderer's tables in `occurrence.ts` (`heatmapStopsOf`) — engine display
 * constants, not classification colors; move the two tables together.
 */
const HEATMAP_RAMP_STOPS: Readonly<Record<HeatmapRamp, readonly string[]>> = {
  viridis: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  plasma: ['#0d0887', '#7e03a8', '#cc4778', '#f89540', '#f0f921'],
  inferno: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'],
  magma: ['#000004', '#3b0f70', '#8c2981', '#de4968', '#fe9f6d', '#fcfdbf'],
  blues: ['#f7fbff', '#c6dbef', '#6baed6', '#2171b5', '#08306b'],
  reds: ['#fff5f0', '#fcbba1', '#fb6a4a', '#cb181d', '#67000d'],
}

/** The legend chip one layer derives: same authority functions the renderer consumes. */
export type PanelLegendChip =
  | { readonly kind: 'class'; readonly colors: readonly string[]; readonly styleVersion: string }
  | { readonly kind: 'symbol'; readonly rows: readonly SymbolLegendRow[]; readonly symbolVersion: string }
  | { readonly kind: 'heatmap'; readonly ramp: HeatmapRamp; readonly stops: readonly string[]; readonly symbolVersion: string }

/** One layer's panel face: identity, grouping, state, reference, and legend chip. */
export interface PanelLayerFace {
  readonly id: string
  readonly name: string
  readonly group: string | null
  readonly badge: PanelBadge
  readonly visible: boolean
  readonly opacity: number
  readonly featureCount: number
  /** The exact catalog ref (`resourceRef` preferred) when the layer carries one. */
  readonly ref: string | null
  readonly chip: PanelLegendChip | null
  readonly overridesVersion: string | null
}

/** The legend geometry families one layer's data carries (all families when the data is absent). */
export function legendFamiliesOf(data: unknown): ReadonlySet<SymbolLegendRow['geometry']> | undefined {
  const features = (data as { features?: { geometry?: { type?: unknown } | null }[] } | null | undefined)?.features
  if (features === undefined) return undefined
  const families = new Set<SymbolLegendRow['geometry']>()
  for (const feature of features) {
    const type = feature.geometry?.type
    if (type === 'Point') families.add('point')
    else if (type === 'LineString') families.add('line')
    else if (type === 'Polygon') families.add('fill')
  }
  return families.size === 0 ? undefined : families
}

/** The layer's first feature geometry type, when its data carries one. */
function firstGeometryOf(layer: WireLayer): string | null {
  const data = layer.data as { features?: { geometry?: { type?: unknown } | null }[] } | null
  const geometry = data?.features?.[0]?.geometry
  return typeof geometry?.type === 'string' ? geometry.type : null
}

/**
 * Derive one layer's type badge: imagery and heatmap presentations first,
 * then a classification style, then the symbol blocks, then the data's own
 * geometry, with `data` as the fallback.
 * @param layer - the wire layer.
 * @returns the badge.
 */
export function panelBadgeOf(layer: WireLayer): PanelBadge {
  if (layer.imagery !== undefined) return 'imagery'
  if (layer.symbol?.presentation === 'heatmap') return 'heatmap'
  if (layer.style !== undefined) return 'thematic'
  if (layer.symbol !== undefined && layer.symbol.semantic === undefined) {
    if (layer.symbol.point !== undefined) return 'point'
    if (layer.symbol.line !== undefined) return 'line'
    if (layer.symbol.fill !== undefined) return 'polygon'
  }
  const geometry = firstGeometryOf(layer)
  if (geometry === 'Point') return 'point'
  if (geometry === 'LineString') return 'line'
  if (geometry === 'Polygon') return 'polygon'
  return 'data'
}

/**
 * Derive one layer's legend chip. A classification style renders its class
 * colors from `legendOf`; a single-presentation symbol renders the rows of
 * `legendOfSymbol`; a heatmap presentation renders its ramp stops. Imagery
 * layers carry no chip (the type badge is their face) — and no other color
 * is ever computed here.
 * @param layer - the wire layer.
 * @returns the chip, or `null` for imagery and chip-less layers.
 */
export function panelChipOf(layer: WireLayer): PanelLegendChip | null {
  if (layer.imagery !== undefined) return null
  if (layer.style !== undefined) {
    const rows = legendOf(layer.style).rows
    return { kind: 'class', colors: rows.filter(row => row.kind === 'class').map(row => row.color), styleVersion: layer.style.styleVersion }
  }
  if (layer.symbol?.presentation === 'heatmap') {
    return { kind: 'heatmap', ramp: layer.symbol.heatmap.ramp, stops: HEATMAP_RAMP_STOPS[layer.symbol.heatmap.ramp], symbolVersion: layer.symbol.symbolVersion }
  }
  const single = layer.symbol === undefined ? undefined : asSingleSymbol(layer.symbol)
  if (single === undefined) return null
  return { kind: 'symbol', rows: legendOfSymbol(single, legendFamiliesOf(layer.data)).rows, symbolVersion: single.symbolVersion }
}

/**
 * Derive the panel faces of every wire layer, in layer order.
 * @param wire - the current `mapContainer` wire value.
 * @returns one face per layer.
 */
export function panelFacesOf(wire: MapContainerWire): readonly PanelLayerFace[] {
  return wire.layers.map(raw => {
    const layer: WireLayer = raw
    return {
      id: layer.id,
      name: layer.name,
      group: layer.group ?? null,
      badge: panelBadgeOf(layer),
      visible: layer.visible,
      opacity: layer.opacity,
      featureCount: typeof layer.featureCount === 'number' ? layer.featureCount : (layer.data as { features?: unknown[] } | null)?.features?.length ?? 0,
      ref: layer.resourceRef ?? layer.artifactRef ?? null,
      chip: panelChipOf(layer),
      overridesVersion: layer.overrides?.overridesVersion ?? null,
    }
  })
}

/** One attribute row: the feature id plus its truncated cell values. */
export interface PanelAttributeRow {
  readonly id: string
  readonly cells: readonly string[]
}

/** The bounded attribute table one layer derives. */
export interface PanelAttributeFace {
  readonly columns: readonly string[]
  readonly rows: readonly PanelAttributeRow[]
  /** Property keys beyond the column bound. */
  readonly columnOverflow: number
  /** Features beyond the row bound. */
  readonly rowOverflow: number
  /** Whether the layer carries no renderable features (zero-feature or imagery). */
  readonly empty: boolean
}

/** Stringify one attribute value for display, truncated at the cell bound. */
function cellOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.length > PANEL_ATTRIBUTE_CELL_CHARS ? `${text.slice(0, PANEL_ATTRIBUTE_CELL_CHARS)}…` : text
}

/**
 * Derive one layer's bounded attribute table directly from its wire data —
 * the same GeoJSON the map renders, no export round-trip. Row ids are
 * `featureIdOf` (the selection's key), columns are the property keys of the
 * bounded rows in first-appearance order capped at
 * {@link PANEL_MAX_ATTRIBUTE_COLUMNS}, and values stringify with truncation.
 * @param layer - the wire layer.
 * @returns the bounded table face.
 */
export function panelAttributesOf(layer: WireLayer): PanelAttributeFace {
  const data = layer.data as { features?: { id?: unknown; properties?: Record<string, unknown> | null }[] } | null
  const all = data?.features ?? []
  const bounded = all.slice(0, MAX_ATTRIBUTE_ROWS)
  const columns: string[] = []
  for (const feature of bounded) {
    for (const key of Object.keys(feature.properties ?? {})) {
      if (!columns.includes(key)) columns.push(key)
    }
  }
  const columnOverflow = Math.max(columns.length - PANEL_MAX_ATTRIBUTE_COLUMNS, 0)
  const shown = columns.slice(0, PANEL_MAX_ATTRIBUTE_COLUMNS)
  const rows = bounded.map((feature, index) => ({
    id: featureIdOf(feature, index),
    cells: shown.map(column => cellOf(feature.properties?.[column])),
  }))
  return {
    columns: shown,
    rows,
    columnOverflow,
    rowOverflow: Math.max(all.length - MAX_ATTRIBUTE_ROWS, 0),
    empty: rows.length === 0,
  }
}
