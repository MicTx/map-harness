import type {} from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Cordis service name for the internal ArcGIS MCP provider. */
export const ARCGIS_MCP_SERVICE = 'arcgisMcp'

/** The fixed MCP map-tool catalog for the map container. */
export const ARCGIS_MAP_TOOL_NAMES = [
  'map_add_layer',
  'map_remove_layer',
  'map_set_view',
  'map_set_mode',
  'map_get_state',
] as const

/** The fixed MCP geo-analysis catalog served by the same internal provider. */
export const GEO_TOOL_NAMES = [
  'geo_buffer',
  'geo_area',
  'geo_intersect',
  'geo_distance',
] as const

/** The fixed P0b catalog/save tools served by the same internal provider. */
export const DATA_CHAIN_TOOL_NAMES = [
  'catalog_register',
  'catalog_resolve',
  'map_save',
] as const

/** The fixed P0c decision tool served by the same internal provider. */
export const DECISION_TOOL_NAMES = [
  'decision_update',
] as const

/** The fixed P1 run-job tools served by the same internal provider. */
export const RUN_TOOL_NAMES = [
  'run_submit',
  'run_get',
  'run_cancel',
] as const

/** The fixed P2 spatial-statistics and spatiotemporal-pattern tools. */
export const STAT_TOOL_NAMES = [
  'stats_zonal',
  'stats_autocorrelation',
  'stats_hotspot',
  'pattern_change',
  'pattern_cluster',
  'pattern_flow',
] as const

/** The fixed P3 attribution/forecast/scenario decision-model tools. */
export const DECISION_MODEL_TOOL_NAMES = [
  'attribution_association',
  'attribution_explain',
  'attribution_effect',
  'forecast_validate',
  'forecast_fit',
  'forecast_predict',
  'scenario_compare',
  'location_allocate',
] as const

/** The fixed visualization workbench tools served by the same internal provider. */
export const VIZ_TOOL_NAMES = [
  'viz_create_style',
  'viz_classify',
  'viz_compare',
  'viz_aggregate',
] as const

/** The fixed collaboration tools (conditional patches and compensating undo). */
export const COLLAB_TOOL_NAMES = [
  'map_apply_patch',
  'map_undo',
] as const

/** The fixed terrain tools (preview display and line-of-sight analysis). */
export const TERRAIN_TOOL_NAMES = [
  'terrain_add_layer',
  'geo_line_of_sight',
  'terrain_viewshed',
] as const

/** The fixed realtime stream workbench tools (open/advance/pause/resume/materialize). */
export const STREAM_TOOL_NAMES = [
  'stream_open',
  'stream_advance',
  'stream_pause',
  'stream_resume',
  'stream_materialize',
] as const

/** The fixed distributed-scale data-channel tools (ingest/read/scan). */
export const SCALE_TOOL_NAMES = [
  'scale_ingest',
  'scale_read',
  'scale_scan',
] as const

/** One raw MCP map tool name supported by the ArcGIS map provider. */
export type ArcgisMapToolName = typeof ARCGIS_MAP_TOOL_NAMES[number]

/** One raw MCP geo-analysis tool name supported by the internal provider. */
export type GeoToolName = typeof GEO_TOOL_NAMES[number]

/** One raw MCP data-chain tool name (catalog and save) served by the internal provider. */
export type DataChainToolName = typeof DATA_CHAIN_TOOL_NAMES[number]

/** One raw MCP decision tool name served by the internal provider. */
export type DecisionToolName = typeof DECISION_TOOL_NAMES[number]

/** One raw MCP run-job tool name served by the internal provider. */
export type RunToolName = typeof RUN_TOOL_NAMES[number]

/** One raw MCP stat/pattern tool name served by the internal provider. */
export type StatToolName = typeof STAT_TOOL_NAMES[number]

/** One raw MCP decision-model tool name served by the internal provider. */
export type DecisionModelToolName = typeof DECISION_MODEL_TOOL_NAMES[number]

/** One raw MCP visualization tool name served by the internal provider. */
export type VizToolName = typeof VIZ_TOOL_NAMES[number]

/** One raw MCP collaboration tool name served by the internal provider. */
export type CollabToolName = typeof COLLAB_TOOL_NAMES[number]

/** One raw MCP terrain tool name served by the internal provider. */
export type TerrainToolName = typeof TERRAIN_TOOL_NAMES[number]

/** One raw MCP realtime stream tool name served by the internal provider. */
export type StreamToolName = typeof STREAM_TOOL_NAMES[number]

/** One raw MCP distributed-scale tool name served by the internal provider. */
export type ScaleToolName = typeof SCALE_TOOL_NAMES[number]

/** One tools/list entry consumed by the map-tools MCP adapter. */
export interface ArcgisMcpToolDescriptor {
  readonly name: ArcgisMapToolName | GeoToolName | DataChainToolName | DecisionToolName | RunToolName | StatToolName | DecisionModelToolName | VizToolName | CollabToolName | TerrainToolName | StreamToolName | ScaleToolName
  readonly description: string
  readonly inputSchema: Record<string, unknown>
  readonly outputSchema?: unknown
  readonly taskRequired?: boolean
}

/** Host-provided internal MCP connection used by the agent-scoped map-tools consumer. */
export interface ArcgisMcpService {
  /** @returns the immutable tool generation discovered through MCP tools/list. */
  catalog(): readonly ArcgisMcpToolDescriptor[]
  /**
   * Call one raw MCP tool with the exact ToolRuntime execution that owns the request.
   * @param name - raw MCP tool name from {@link catalog}.
   * @param args - model arguments already admitted by ToolRuntime.
   * @param execution - trusted execution carrying the current Agent and cancellation signal.
   * @returns the raw MCP CallToolResult validated by the ToolRuntime adapter.
   */
  callTool(name: ArcgisMapToolName | GeoToolName | DataChainToolName | DecisionToolName | RunToolName | StatToolName | DecisionModelToolName | VizToolName | CollabToolName | TerrainToolName | StreamToolName | ScaleToolName, args: Record<string, unknown>, execution: ToolExecution): Promise<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Internal ArcGIS MCP provider; the model never receives this service directly. */
    arcgisMcp: ArcgisMcpService
  }
}
