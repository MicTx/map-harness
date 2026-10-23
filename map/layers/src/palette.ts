/**
 * Deterministic automatic coloring: the fixed 12-color categorical palette
 * and the pure digest assignment `autoSymbolOf(layerId)` derives from it.
 * The same layer id always resolves to the same color — no module counters,
 * no shared used-color sets, no randomness — so replays and fresh processes
 * color identically. Collisions across distinct ids are possible exactly at
 * the palette's pigeonhole rate (1-in-12); within any concrete dozen layers
 * a re-symbol is the explicit fix.
 *
 * @module @map-harness/map-layers/palette
 */
import { vizDigestOf } from '@map-harness/spatial-viz'
import { LAYERS_METHOD_VERSION, symbolVersionOf, type SymbolStyle, type SymbolStyleDraft } from './contract.ts'

/**
 * The 12-color categorical palette in the Mapbox Studio register: mid-
 * saturation hues that stay readable on both imagery and light basemaps,
 * all 6-digit hex, pairwise distinct.
 */
export const AUTO_PALETTE: readonly string[] = Object.freeze([
  '#4264fb',
  '#e55e5e',
  '#3ba55c',
  '#f2a93b',
  '#7753eb',
  '#3d9ad1',
  '#ee4e8b',
  '#8a6d3b',
  '#12a5a5',
  '#d9643a',
  '#5d6b82',
  '#a36bd1',
])

/** Default marker diameter for auto symbols (the ArcGIS-rendered default baseline). */
export const AUTO_MARKER_SIZE_PX = 8

/** Default line width for auto symbols. */
export const AUTO_LINE_WIDTH_PX = 2.5

/** Default polygon fill opacity for auto symbols (translucent fill, crisp outline). */
export const AUTO_FILL_OPACITY = 0.3

/** The white halo auto markers wear. */
const AUTO_HALO_COLOR = '#ffffff'
const AUTO_HALO_WIDTH_PX = 1.5

/** Shade multiplier deriving each auto color's outline. */
const AUTO_OUTLINE_SHADE = 0.7

/** Parse one 6-digit hex color into its RGB channels. */
function channelsOf(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

/** Render RGB channels as a 6-digit hex color. */
function hexOf(channels: readonly [number, number, number]): string {
  return `#${channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`
}

/** One channel-wise deterministic shade of a hex color. */
export function shadeOf(hex: string, factor: number): string {
  return hexOf(channelsOf(hex).map(channel => channel * factor) as [number, number, number])
}

/**
 * The palette slot one layer id deterministically occupies.
 * @param layerId - the stable layer id.
 * @returns the palette index in `[0, AUTO_PALETTE.length)`.
 */
export function autoColorIndexOf(layerId: string): number {
  return Number.parseInt(vizDigestOf(layerId).slice(0, 8), 16) % AUTO_PALETTE.length
}

/**
 * The auto color pair (fill plus outline) one layer id deterministically
 * carries.
 * @param layerId - the stable layer id.
 * @returns the base color and its derived outline.
 */
export function autoColorOf(layerId: string): { readonly color: string; readonly outline: string } {
  const color = AUTO_PALETTE[autoColorIndexOf(layerId)] as string
  return { color, outline: shadeOf(color, AUTO_OUTLINE_SHADE) }
}

/**
 * The deterministic default symbol one layer carries until an explicit
 * style replaces it: the layer id's palette color across all three geometry
 * blocks — white-haloed markers, solid lines, and a translucent fill whose
 * outline is the darker shade of the same hue.
 * @param layerId - the stable layer id.
 * @returns the complete single-presentation symbol with its derived version.
 */
export function autoSymbolOf(layerId: string): SymbolStyle {
  const { color, outline } = autoColorOf(layerId)
  const symbol: SymbolStyleDraft = {
    methodVersion: LAYERS_METHOD_VERSION,
    presentation: 'single',
    point: { shape: 'circle', color, sizePx: AUTO_MARKER_SIZE_PX, outlineColor: AUTO_HALO_COLOR, outlineWidthPx: AUTO_HALO_WIDTH_PX },
    line: { color, widthPx: AUTO_LINE_WIDTH_PX, pattern: 'solid' },
    fill: { color, opacity: AUTO_FILL_OPACITY, outlineColor: outline, outlineWidthPx: 1.2 },
  }
  return { ...symbol, symbolVersion: symbolVersionOf(symbol) }
}
