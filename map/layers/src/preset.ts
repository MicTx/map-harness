/**
 * The built-in symbol preset library: stable `preset:<name>` ids, each a
 * display label plus a complete SymbolStyle draft over the ArcGIS-native
 * shape/pattern/ramp vocabulary. A preset is an explicit resolve step — the
 * tool boundary expands the id into the full symbol and re-validates it
 * before anything enters the projection, so no implicit defaulting happens
 * downstream. Transparency tiers are first-class (the「半透明」presets carry
 * block opacity).
 *
 * @module @map-harness/map-layers/preset
 */
import { LAYERS_METHOD_VERSION, symbolVersionOf, type SymbolStyle, type SymbolStyleDraft } from './contract.ts'

/** One built-in preset: its stable id, display label, and complete symbol draft. */
export interface SymbolPreset {
  /** Stable full id (`preset:<name>`). */
  readonly id: string
  /** Human-readable display label. */
  readonly label: string
  readonly symbol: SymbolStyle
}

/** Stamp one draft with its derived symbol version. */
function versioned(draft: SymbolStyleDraft): SymbolStyle {
  return { ...draft, symbolVersion: symbolVersionOf(draft) }
}

/** The fixed preset table. Ids are load-bearing: never reword one. */
export const SYMBOL_PRESETS: readonly SymbolPreset[] = Object.freeze([
  {
    id: 'preset:marker-circle-blue',
    label: 'Blue circle markers',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      point: { shape: 'circle', color: '#1f77b4', sizePx: 8, outlineColor: '#14405e', outlineWidthPx: 1 },
    }),
  },
  {
    id: 'preset:marker-square-red-large',
    label: 'Large red squares (translucent)',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      point: { shape: 'square', color: '#e53935', sizePx: 14, opacity: 0.8, outlineColor: '#7f1d1d', outlineWidthPx: 1.5 },
    }),
  },
  {
    id: 'preset:marker-diamond-amber',
    label: 'Amber diamonds',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      point: { shape: 'diamond', color: '#daa037', sizePx: 10, outlineColor: '#6b4f1b', outlineWidthPx: 1 },
    }),
  },
  {
    id: 'preset:marker-triangle-green',
    label: 'Green triangles',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      point: { shape: 'triangle', color: '#2ca02c', sizePx: 10, outlineColor: '#145214', outlineWidthPx: 1 },
    }),
  },
  {
    id: 'preset:marker-cross-gray',
    label: 'Gray crosses',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      point: { shape: 'cross', color: '#7f7f7f', sizePx: 9 },
    }),
  },
  {
    id: 'preset:marker-x-magenta',
    label: 'Magenta x marks',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      point: { shape: 'x', color: '#e377c2', sizePx: 9 },
    }),
  },
  {
    id: 'preset:line-solid-blue',
    label: 'Solid blue lines',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      line: { color: '#1f77b4', widthPx: 2, pattern: 'solid' },
    }),
  },
  {
    id: 'preset:line-dashed-red',
    label: 'Dashed red lines',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      line: { color: '#d62728', widthPx: 2.5, pattern: 'dash' },
    }),
  },
  {
    id: 'preset:line-dotted-green',
    label: 'Dotted green lines',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      line: { color: '#2ca02c', widthPx: 1.5, pattern: 'dot' },
    }),
  },
  {
    id: 'preset:line-dashdot-purple',
    label: 'Dash-dot purple lines (translucent)',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      line: { color: '#9467bd', widthPx: 3, pattern: 'dash-dot', opacity: 0.75 },
    }),
  },
  {
    id: 'preset:fill-solid-teal',
    label: 'Solid teal fills',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      fill: { color: '#17a398', outlineColor: '#0b504c', outlineWidthPx: 1.5 },
    }),
  },
  {
    id: 'preset:fill-translucent-orange',
    label: 'Translucent orange fills',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      fill: { color: '#ff7f0e', opacity: 0.45, outlineColor: '#7f3f07', outlineWidthPx: 1 },
    }),
  },
  {
    id: 'preset:fill-outline-only',
    label: 'Outline-only fills',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'single',
      fill: { color: '#3969a8', opacity: 0, outlineColor: '#3969a8', outlineWidthPx: 2 },
    }),
  },
  {
    id: 'preset:heatmap-viridis',
    label: 'Heatmap (viridis)',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'heatmap',
      heatmap: { radiusPx: 24, ramp: 'viridis' },
    }),
  },
  {
    id: 'preset:heatmap-blues-wide',
    label: 'Wide heatmap (blues)',
    symbol: versioned({
      methodVersion: LAYERS_METHOD_VERSION,
      presentation: 'heatmap',
      heatmap: { radiusPx: 40, ramp: 'blues' },
    }),
  },
])

/** The preset table indexed by full id. */
const PRESETS_BY_ID = new Map(SYMBOL_PRESETS.map(preset => [preset.id, preset]))

/**
 * Resolve one preset by its stable id or bare name (`preset:x` or `x`).
 * Resolution is the explicit expansion step the tool boundary runs — the
 * caller re-validates nothing here because every table entry is valid by
 * construction.
 * @param idOrName - the full preset id (`preset:<name>`) or its bare name.
 * @returns the preset, or `undefined` when no table entry matches.
 */
export function resolveSymbolPreset(idOrName: string): SymbolPreset | undefined {
  const id = idOrName.startsWith('preset:') ? idOrName : `preset:${idOrName}`
  return PRESETS_BY_ID.get(id)
}

/** Every stable preset id, in table order. */
export const SYMBOL_PRESET_IDS: readonly string[] = Object.freeze(SYMBOL_PRESETS.map(preset => preset.id))
