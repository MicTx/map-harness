/**
 * `@map-harness/map-layers` — the versioned layer-presentation vocabulary:
 * SymbolStyle (single blocks per geometry plus the heatmap presentation),
 * FeatureOverride patches, ImagerySpec tile-overlay admission, group names,
 * the deterministic auto palette, the semantic symbol table, the preset
 * symbol library, and the
 * single-symbol legend derivation. A pure library the tools, the projection
 * fold, and the browser workbench consume — no host row.
 *
 * @module @map-harness/map-layers
 */
export {
  FEATURE_SEMANTICS,
  HEATMAP_RAMPS,
  LAYERS_METHOD_VERSION,
  LINE_PATTERNS,
  MARKER_SHAPES,
  MAX_BLOCK_OPACITY,
  MAX_GROUP_NAME_CHARS,
  MAX_HEATMAP_RADIUS_PX,
  MAX_IMAGERY_ATTRIBUTION_CHARS,
  MAX_IMAGERY_TEMPLATE_CHARS,
  MAX_LABEL_FIELD_CHARS,
  MAX_LABEL_ZOOM,
  MAX_LINE_WIDTH_PX,
  MAX_MARKER_SIZE_PX,
  MAX_OVERRIDE_ENTRIES,
  MAX_OVERRIDE_FEATURE_IDS,
  MAX_OVERRIDE_ID_CHARS,
  MAX_OVERRIDE_TOTAL_IDS,
  MIN_BLOCK_OPACITY,
  MIN_HEATMAP_RADIUS_PX,
  MIN_LABEL_ZOOM,
  MIN_LINE_WIDTH_PX,
  MIN_MARKER_SIZE_PX,
  imagerySpecOf,
  normalizeImageryTemplate,
  overridesVersionOf,
  symbolVersionOf,
  validateFeatureOverrides,
  validateGroupName,
  validateImagerySpec,
  validateImageryTemplate,
  validateSymbolStyle,
  type FeatureOverride,
  type FeatureSemantic,
  type LabelSpec,
  type FeatureOverrides,
  type FillSymbolBlock,
  type HeatmapBlock,
  type HeatmapRamp,
  type HeatmapSymbolStyle,
  type ImagerySpec,
  type LayersIssue,
  type LinePattern,
  type LineSymbolBlock,
  type MarkerShape,
  type PointSymbolBlock,
  type SingleSymbolStyle,
  type SymbolBlock,
  type SymbolStyle,
  type SymbolStyleDraft,
} from './contract.ts'
export {
  AUTO_FILL_OPACITY,
  AUTO_LINE_WIDTH_PX,
  AUTO_MARKER_SIZE_PX,
  AUTO_PALETTE,
  autoColorIndexOf,
  autoColorOf,
  autoSymbolOf,
  shadeOf,
} from './palette.ts'
export {
  SEMANTIC_HALO_COLOR,
  SEMANTIC_HALO_WIDTH_PX,
  resolveSingleSymbol,
  semanticBlocksOf,
  type SemanticBlocks,
} from './semantic.ts'
export {
  SYMBOL_PRESET_IDS,
  SYMBOL_PRESETS,
  resolveSymbolPreset,
  type SymbolPreset,
} from './preset.ts'
export {
  asSingleSymbol,
  legendOfSymbol,
  type SymbolLegendRow,
  type SymbolLegendSpec,
} from './legend.ts'
