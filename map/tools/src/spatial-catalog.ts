/**
 * The unified identity table for every model-visible spatial tool of the map
 * layer: the fixed name set the internal MCP provider must serve, the family
 * each tool belongs to, the package that owns its handlers, and the versioned
 * durable `tool/result.meta` kind its successful results carry. The provider's
 * `tools/list` freeze, the agent-scoped MCP adapter, and the final model
 * assemble all cross-check against this one table, so an unknown, duplicate,
 * or missing name fails loud at definition time instead of drifting.
 */
import { MAP_META_KIND, MAP_META_SCHEMA_VERSION, MAP_MUTATION_TOOL_NAMES } from '@map-harness/map-container'
import { CATALOG_META_KIND, CATALOG_META_SCHEMA_VERSION } from './catalog-meta.ts'
import { DECISION_META_KIND, DECISION_META_SCHEMA_VERSION } from '@map-harness/spatial-context'
import { DECISION_MODEL_META_KIND, DECISION_MODEL_META_SCHEMA_VERSION } from './decision-meta.ts'
import { GEO_META_KIND, GEO_META_SCHEMA_VERSION } from './geo-meta.ts'
import { ARCGIS_MAP_TOOL_NAMES, COLLAB_TOOL_NAMES, DATA_CHAIN_TOOL_NAMES, DECISION_MODEL_TOOL_NAMES, DECISION_TOOL_NAMES, GEO_TOOL_NAMES, RUN_TOOL_NAMES, SCALE_TOOL_NAMES, STAT_TOOL_NAMES, STREAM_TOOL_NAMES, TERRAIN_TOOL_NAMES } from './mcp-service.ts'
import { RUN_META_KIND, RUN_META_SCHEMA_VERSION } from './run-meta.ts'
import { SCALE_META_KIND, SCALE_META_SCHEMA_VERSION } from './scale-meta.ts'
import { MAP_SAVE_META_KIND, MAP_SAVE_META_SCHEMA_VERSION } from './save-meta.ts'
import { STAT_META_KIND, STAT_META_SCHEMA_VERSION } from './stat-meta.ts'
import { TERRAIN_META_KIND, TERRAIN_META_SCHEMA_VERSION } from './terrain-meta.ts'
import { VIZ_META_KIND, VIZ_META_SCHEMA_VERSION } from './viz-meta.ts'
import { VIZ_TOOL_NAMES } from './mcp-service.ts'

/**
 * The fixed spatial tool names served by the internal MCP provider. Public
 * ToolRuntime name and raw MCP name are identical: the internal provider is
 * the sole authority for these names, so no server qualification is needed.
 */
export const SPATIAL_MCP_TOOL_NAMES = [...ARCGIS_MAP_TOOL_NAMES, ...GEO_TOOL_NAMES, ...DATA_CHAIN_TOOL_NAMES, ...DECISION_TOOL_NAMES, ...COLLAB_TOOL_NAMES, ...RUN_TOOL_NAMES, ...STAT_TOOL_NAMES, ...DECISION_MODEL_TOOL_NAMES, ...VIZ_TOOL_NAMES, ...TERRAIN_TOOL_NAMES, ...STREAM_TOOL_NAMES, ...SCALE_TOOL_NAMES] as const

/** One name of the fixed spatial catalog. */
export type SpatialToolName = typeof SPATIAL_MCP_TOOL_NAMES[number]

/** The capability family one spatial tool belongs to. */
export type SpatialToolFamily =
  | 'map-mutation'
  | 'map-read'
  | 'geo-analysis'
  | 'catalog-write'
  | 'catalog-read'
  | 'map-save'
  | 'decision-write'
  | 'run-submit'
  | 'run-read'
  | 'run-cancel'
  | 'stat-analysis'
  | 'decision-model'
  | 'viz-style'
  | 'collab-write'
  | 'terrain-display'
  | 'terrain-analysis'
  | 'stream-workbench'
  | 'stream-materialize'
  | 'scale-ingest'
  | 'scale-read'
  | 'scale-scan'

/** Families whose side effects require native model-direct dispatch. */
const NATIVE_ONLY_FAMILIES: readonly SpatialToolFamily[] = ['map-mutation', 'catalog-write', 'map-save', 'decision-write', 'run-submit', 'run-cancel', 'viz-style', 'collab-write', 'terrain-display', 'stream-workbench', 'stream-materialize', 'scale-ingest', 'scale-scan']

/** The durable meta kind one successful result of a tool carries. */
export type SpatialMetaKind = typeof MAP_META_KIND | typeof GEO_META_KIND | typeof CATALOG_META_KIND | typeof MAP_SAVE_META_KIND | typeof DECISION_META_KIND | typeof RUN_META_KIND | typeof STAT_META_KIND | typeof DECISION_MODEL_META_KIND | typeof VIZ_META_KIND | typeof TERRAIN_META_KIND | typeof SCALE_META_KIND

/** One row of the unified spatial tool catalog. */
export interface SpatialToolIdentity {
  /** Public ToolRuntime name; equal to the raw MCP name on the internal provider. */
  readonly name: SpatialToolName
  /** Capability family governing guards and fold semantics. */
  readonly family: SpatialToolFamily
  /** Package owning the tool handlers both direct and MCP dispatch reach. */
  readonly owner: '@map-harness/map-tools'
  /** Host plugin that serves the tool over `tools/list`/`tools/call`. */
  readonly provider: '@map-harness/arcgis-mcp'
  /** Durable `tool/result.meta` kind successful results carry. */
  readonly metaKind: SpatialMetaKind
  /** Wire/protocol version of the durable meta record. */
  readonly metaSchemaVersion: number
}

const IDENTITY: Readonly<Record<SpatialToolName, Omit<SpatialToolIdentity, 'name'>>> = {
  map_add_layer: { family: 'map-mutation', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  map_remove_layer: { family: 'map-mutation', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  map_set_view: { family: 'map-mutation', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  map_set_mode: { family: 'map-mutation', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  map_get_state: { family: 'map-read', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  geo_buffer: { family: 'geo-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: GEO_META_KIND, metaSchemaVersion: GEO_META_SCHEMA_VERSION },
  geo_area: { family: 'geo-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: GEO_META_KIND, metaSchemaVersion: GEO_META_SCHEMA_VERSION },
  geo_intersect: { family: 'geo-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: GEO_META_KIND, metaSchemaVersion: GEO_META_SCHEMA_VERSION },
  geo_distance: { family: 'geo-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: GEO_META_KIND, metaSchemaVersion: GEO_META_SCHEMA_VERSION },
  catalog_register: { family: 'catalog-write', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: CATALOG_META_KIND, metaSchemaVersion: CATALOG_META_SCHEMA_VERSION },
  catalog_resolve: { family: 'catalog-read', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: CATALOG_META_KIND, metaSchemaVersion: CATALOG_META_SCHEMA_VERSION },
  map_save: { family: 'map-save', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_SAVE_META_KIND, metaSchemaVersion: MAP_SAVE_META_SCHEMA_VERSION },
  decision_update: { family: 'decision-write', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: DECISION_META_KIND, metaSchemaVersion: DECISION_META_SCHEMA_VERSION },
  run_submit: { family: 'run-submit', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: RUN_META_KIND, metaSchemaVersion: RUN_META_SCHEMA_VERSION },
  run_get: { family: 'run-read', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: RUN_META_KIND, metaSchemaVersion: RUN_META_SCHEMA_VERSION },
  run_cancel: { family: 'run-cancel', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: RUN_META_KIND, metaSchemaVersion: RUN_META_SCHEMA_VERSION },
  stats_zonal: { family: 'stat-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: STAT_META_KIND, metaSchemaVersion: STAT_META_SCHEMA_VERSION },
  stats_autocorrelation: { family: 'stat-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: STAT_META_KIND, metaSchemaVersion: STAT_META_SCHEMA_VERSION },
  stats_hotspot: { family: 'stat-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: STAT_META_KIND, metaSchemaVersion: STAT_META_SCHEMA_VERSION },
  pattern_change: { family: 'stat-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: STAT_META_KIND, metaSchemaVersion: STAT_META_SCHEMA_VERSION },
  pattern_cluster: { family: 'stat-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: STAT_META_KIND, metaSchemaVersion: STAT_META_SCHEMA_VERSION },
  pattern_flow: { family: 'stat-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: STAT_META_KIND, metaSchemaVersion: STAT_META_SCHEMA_VERSION },
  attribution_association: { family: 'decision-model', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: DECISION_MODEL_META_KIND, metaSchemaVersion: DECISION_MODEL_META_SCHEMA_VERSION },
  attribution_explain: { family: 'decision-model', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: DECISION_MODEL_META_KIND, metaSchemaVersion: DECISION_MODEL_META_SCHEMA_VERSION },
  attribution_effect: { family: 'decision-model', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: DECISION_MODEL_META_KIND, metaSchemaVersion: DECISION_MODEL_META_SCHEMA_VERSION },
  forecast_validate: { family: 'decision-model', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: DECISION_MODEL_META_KIND, metaSchemaVersion: DECISION_MODEL_META_SCHEMA_VERSION },
  forecast_fit: { family: 'decision-model', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: DECISION_MODEL_META_KIND, metaSchemaVersion: DECISION_MODEL_META_SCHEMA_VERSION },
  forecast_predict: { family: 'decision-model', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: DECISION_MODEL_META_KIND, metaSchemaVersion: DECISION_MODEL_META_SCHEMA_VERSION },
  scenario_compare: { family: 'decision-model', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: DECISION_MODEL_META_KIND, metaSchemaVersion: DECISION_MODEL_META_SCHEMA_VERSION },
  location_allocate: { family: 'decision-model', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: DECISION_MODEL_META_KIND, metaSchemaVersion: DECISION_MODEL_META_SCHEMA_VERSION },
  viz_create_style: { family: 'viz-style', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: VIZ_META_KIND, metaSchemaVersion: VIZ_META_SCHEMA_VERSION },
  viz_classify: { family: 'viz-style', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  viz_compare: { family: 'viz-style', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  viz_aggregate: { family: 'viz-style', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  map_apply_patch: { family: 'collab-write', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  map_undo: { family: 'collab-write', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  terrain_add_layer: { family: 'terrain-display', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  geo_line_of_sight: { family: 'terrain-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: TERRAIN_META_KIND, metaSchemaVersion: TERRAIN_META_SCHEMA_VERSION },
  terrain_viewshed: { family: 'terrain-analysis', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: TERRAIN_META_KIND, metaSchemaVersion: TERRAIN_META_SCHEMA_VERSION },
  stream_open: { family: 'stream-workbench', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  stream_advance: { family: 'stream-workbench', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  stream_pause: { family: 'stream-workbench', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  stream_resume: { family: 'stream-workbench', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  stream_materialize: { family: 'stream-materialize', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: MAP_META_KIND, metaSchemaVersion: MAP_META_SCHEMA_VERSION },
  scale_ingest: { family: 'scale-ingest', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: SCALE_META_KIND, metaSchemaVersion: SCALE_META_SCHEMA_VERSION },
  scale_read: { family: 'scale-read', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: SCALE_META_KIND, metaSchemaVersion: SCALE_META_SCHEMA_VERSION },
  scale_scan: { family: 'scale-scan', owner: '@map-harness/map-tools', provider: '@map-harness/arcgis-mcp', metaKind: SCALE_META_KIND, metaSchemaVersion: SCALE_META_SCHEMA_VERSION },
}

/**
 * Whether one spatial tool supports nested (PTC) dispatch. Publish and save
 * families are native model-direct only — a nested dispatch cannot pair with
 * its accepted call or produce a foldable, honest result.
 * @param family - the tool's capability family.
 */
export function supportsNestedDispatch(family: SpatialToolFamily): boolean {
  return !NATIVE_ONLY_FAMILIES.includes(family)
}

/** The full fixed catalog in name order (the tools/list generation contract). */
export const SPATIAL_TOOL_CATALOG: readonly SpatialToolIdentity[] = SPATIAL_MCP_TOOL_NAMES.map(
  name => ({ name, ...IDENTITY[name] }),
)

/** The mutation names of the catalog; nested dispatch of these must be denied. */
export const SPATIAL_MUTATION_TOOL_NAMES: readonly SpatialToolName[] = MAP_MUTATION_TOOL_NAMES

/**
 * Resolve one catalog row by tool name.
 * @param name - candidate tool name from a catalog, adapter, or guard.
 * @returns the identity row.
 * @throws when the name is outside the fixed spatial catalog.
 */
export function spatialToolOf(name: string): SpatialToolIdentity {
  const row = IDENTITY[name as SpatialToolName]
  if (row === undefined) throw new Error(`unknown spatial tool "${name}"`)
  return { name: name as SpatialToolName, ...row }
}

/**
 * Resolve one catalog row without failing, for guards over foreign names.
 * @param name - candidate tool name.
 * @returns the identity row, or `undefined` outside the spatial catalog.
 */
export function trySpatialToolOf(name: string): SpatialToolIdentity | undefined {
  const row = IDENTITY[name as SpatialToolName]
  return row === undefined ? undefined : { name: name as SpatialToolName, ...row }
}

/**
 * Check one name set against the fixed catalog.
 * @param names - candidate names (for example a tools/list generation).
 * @returns the missing catalog names.
 */
export function missingSpatialTools(names: readonly string[]): readonly SpatialToolName[] {
  const present = new Set(names)
  return SPATIAL_MCP_TOOL_NAMES.filter(name => !present.has(name))
}
