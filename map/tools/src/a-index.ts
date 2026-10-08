/**
 * `@map-harness/map-tools` — the model-facing map and spatial-analysis tools.
 * Mounting this plugin registers the fixed spatial catalog (`map_*` container
 * tools and `geo_*` analysis tools) into `ctx.tools`; the map-analyst agent
 * preset selects them for the sessions that should carry map capabilities.
 * @module @map-harness/map-tools
 */


import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { mapAddLayer, mapRemoveLayer, mapSetView, mapSetMode, mapGetState } from './map-tools.ts'
import { geoBuffer, geoArea, geoIntersect, geoDistance } from './geo-tools.ts'
import { catalogRegister, catalogResolve, mapSave } from './catalog-tools.ts'
import { decisionUpdate } from './decision-tools.ts'
import { runSubmit, runGet, runCancel } from './run-tools.ts'
import { statsZonal, statsAutocorrelation, statsHotspot, patternChange, patternCluster, patternFlow } from './stat-tools.ts'
import {
  attributionAssociation,
  attributionExplain,
  attributionEffect,
  forecastValidate,
  forecastFit,
  forecastPredict,
  scenarioCompare,
  locationAllocate,
} from './decision-model-tools.ts'
import { vizAggregate, vizCreateStyle, vizClassify, vizCompare } from './viz-tools.ts'
import { mapApplyPatch, mapUndo } from './collab-tools.ts'
import { terrainAddLayer, geoLineOfSight, terrainViewshed } from './terrain-tools.ts'
import { streamOpen, streamAdvance, streamPause, streamResume, streamMaterialize } from './stream-tools.ts'
import { scaleIngest, scaleRead, scaleScan } from './scale-tools.ts'
import { createSpatialMcpToolDefinitions } from './mcp-tools.ts'
import { ARCGIS_MCP_SERVICE } from './mcp-service.ts'

/** Function-plugin name under the Loader. */
export const name = '@map-harness/map-tools'

/** Required host services: the tool registry the tools register into. */
export const inject = ['tools']

/** Resolve the spatial catalog for this agent composition. */
function resolveSpatialTools(ctx: Context): readonly ToolDefinition[] {
  const service = ctx.get(ARCGIS_MCP_SERVICE)
  if (service !== undefined) return createSpatialMcpToolDefinitions(ctx, service)
  return [mapAddLayer, mapRemoveLayer, mapSetView, mapSetMode, mapGetState, mapApplyPatch, mapUndo, geoBuffer, geoArea, geoIntersect, geoDistance, catalogRegister, catalogResolve, mapSave, decisionUpdate, runSubmit, runGet, runCancel, statsZonal, statsAutocorrelation, statsHotspot, patternChange, patternCluster, patternFlow, attributionAssociation, attributionExplain, attributionEffect, forecastValidate, forecastFit, forecastPredict, scenarioCompare, locationAllocate, vizCreateStyle, vizClassify, vizCompare, vizAggregate, terrainAddLayer, geoLineOfSight, streamOpen, streamAdvance, streamPause, streamResume, streamMaterialize, scaleIngest, scaleRead, scaleScan]
}

/**
 * Host plugin body: register every map and analysis tool for the process
 * lifetime; the registry disposes them with this plugin. A mounted internal
 * MCP provider upgrades legacy installed presets to the MCP-backed
 * definitions (every spatial tool in `SPATIAL_TOOL_CATALOG` through
 * `tools/list`/`tools/call`); compositions without that provider retain the
 * direct compatibility path.
 * @param ctx - the host root context carrying the tool registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(function* () {
    const tools = resolveSpatialTools(ctx)
    for (const tool of tools) yield ctx.tools.register(tool)
  }, '@map-harness/map-tools: tools')
}

export {
  mapAddLayer, mapRemoveLayer, mapSetView, mapSetMode, mapGetState,
  mapApplyPatch, mapUndo,
  geoBuffer, geoArea, geoIntersect, geoDistance,
  catalogRegister, catalogResolve, mapSave,
  decisionUpdate,
  runSubmit, runGet, runCancel,
  statsZonal, statsAutocorrelation, statsHotspot,
  patternChange, patternCluster, patternFlow,
  attributionAssociation, attributionExplain, attributionEffect,
  forecastValidate, forecastFit, forecastPredict,
  scenarioCompare, locationAllocate,
  vizCreateStyle, vizClassify, vizCompare, vizAggregate,
  terrainAddLayer, geoLineOfSight, terrainViewshed,
  streamOpen, streamAdvance, streamPause, streamResume, streamMaterialize,
  scaleIngest, scaleRead, scaleScan,
}
export { sessionOf, requirePendingPublish, type PublishToolName } from './catalog-tools.ts'
export { spatialContextOf } from './decision-tools.ts'
export {
  ARCGIS_MCP_SERVICE,
  ARCGIS_MAP_TOOL_NAMES,
  COLLAB_TOOL_NAMES,
  DATA_CHAIN_TOOL_NAMES,
  DECISION_TOOL_NAMES,
  DECISION_MODEL_TOOL_NAMES,
  GEO_TOOL_NAMES,
  RUN_TOOL_NAMES,
  SCALE_TOOL_NAMES,
  STAT_TOOL_NAMES,
  TERRAIN_TOOL_NAMES,
  STREAM_TOOL_NAMES,
  VIZ_TOOL_NAMES,
  type ArcgisMapToolName,
  type CollabToolName,
  type DataChainToolName,
  type DecisionToolName,
  type DecisionModelToolName,
  type GeoToolName,
  type RunToolName,
  type ScaleToolName,
  type StatToolName,
  type TerrainToolName,
  type StreamToolName,
  type VizToolName,
  type ArcgisMcpService,
  type ArcgisMcpToolDescriptor,
} from './mcp-service.ts'
export {
  SPATIAL_MCP_TOOL_NAMES,
  SPATIAL_TOOL_CATALOG,
  SPATIAL_MUTATION_TOOL_NAMES,
  missingSpatialTools,
  spatialToolOf,
  trySpatialToolOf,
  type SpatialToolFamily,
  type SpatialToolIdentity,
  type SpatialMetaKind,
  type SpatialToolName,
} from './spatial-catalog.ts'
export {
  GEO_META_KIND,
  GEO_META_SCHEMA_VERSION,
  MAX_ANALYSIS_META_BYTES,
  buildGeoAnalysisMeta,
  decodeGeoAnalysisMeta,
  geoAnalysisMetaSchema,
  type DecodedGeoAnalysisMeta,
  type GeoAnalysisInputRef,
  type GeoAnalysisMeta,
  type GeoAnalysisMetric,
} from './geo-meta.ts'
export {
  CATALOG_META_KIND,
  CATALOG_META_SCHEMA_VERSION,
  MAX_CATALOG_META_BYTES,
  buildCatalogResultMeta,
  decodeCatalogResultMeta,
  catalogResultMetaSchema,
  type CatalogResultMeta,
  type CatalogResultResource,
} from './catalog-meta.ts'
export {
  MAP_SAVE_META_KIND,
  MAP_SAVE_META_SCHEMA_VERSION,
  MAX_SAVE_META_BYTES,
  buildMapSaveReceiptMeta,
  decodeMapSaveReceiptMeta,
  mapSaveReceiptMetaSchema,
  type MapSaveReceiptMeta,
  type MapSaveStageStatus,
} from './save-meta.ts'
export {
  RUN_META_KIND,
  RUN_META_SCHEMA_VERSION,
  MAX_RUN_META_BYTES,
  buildAccessibilityRunMeta,
  decodeAccessibilityRunMeta,
  accessibilityRunMetaSchema,
  type AccessibilityRunMetrics,
  type AccessibilityRunMeta,
  type DecodedAccessibilityRunMeta,
} from './run-meta.ts'
export {
  STAT_META_KIND,
  STAT_META_SCHEMA_VERSION,
  MAX_STAT_META_BYTES,
  STAT_TOOLS,
  buildSpatialStatMeta,
  decodeSpatialStatMeta,
  type SpatialStatHeadline,
  type SpatialStatMeta,
  type StatResultStatus,
  type StatToolName as StatMetaToolName,
  type DecodedSpatialStatMeta,
} from './stat-meta.ts'
export {
  VIZ_META_KIND,
  VIZ_META_SCHEMA_VERSION,
  MAX_VIZ_META_BYTES,
  VIZ_STYLE_TOOLS,
  buildVizStyleMeta,
  decodeVizStyleMeta,
  type DecodedVizStyleMeta,
  type VizStyleMeta,
} from './viz-meta.ts'
export { supportsNestedDispatch } from './spatial-catalog.ts'
export { SpatialError, type SpatialErrorCode } from './spatial-errors.ts'
export {
  DECISION_MODEL_META_KIND,
  DECISION_MODEL_META_SCHEMA_VERSION,
  MAX_DECISION_META_BYTES,
  DECISION_MODEL_TOOLS,
  buildSpatialDecisionMeta,
  decodeSpatialDecisionMeta,
  type DecodedSpatialDecisionMeta,
  type SpatialDecisionHeadline,
  type SpatialDecisionMeta,
  type DecisionResultStatus,
} from './decision-meta.ts'
export {
  TERRAIN_META_KIND,
  TERRAIN_META_SCHEMA_VERSION,
  MAX_TERRAIN_META_BYTES,
  TERRAIN_TOOLS,
  buildTerrainLosMeta,
  decodeTerrainLosMeta,
  type DecodedTerrainLosMeta,
  type TerrainLosHeadline,
  type TerrainLosMeta,
  type TerrainResultStatus,
} from './terrain-meta.ts'
export { MAX_TERRAIN_DISPLAY_POINTS } from './terrain-tools.ts'
export { MAX_STREAM_DISPLAY_WINDOWS, MAX_STREAM_STEPS, STREAM_RECORDED_DEFAULTS, STREAM_MUTATION_TOOLS } from './stream-tools.ts'
export { MAX_SCALE_CONTENT_SAMPLE, SCALE_TOOL_NAMES as SCALE_FAMILY_TOOL_NAMES } from './scale-tools.ts'
export {
  SCALE_META_KIND,
  SCALE_META_SCHEMA_VERSION,
  MAX_SCALE_META_BYTES,
  SCALE_TOOLS,
  buildSpatialScaleMeta,
  decodeSpatialScaleMeta,
  type DecodedSpatialScaleMeta,
  type ScaleToolName as ScaleMetaToolName,
  type SpatialScaleMeta,
} from './scale-meta.ts'
