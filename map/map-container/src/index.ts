/**
 * `@map-harness/map-container` — the map container binding layer. The node
 * half provides `ctx.map`, the projection-derived read face over the
 * authoritative `mapContainer` session projection; the browser half
 * (`exports["./client"]`) renders the ArcGIS MapView/SceneView right-Sidebar
 * tab one session's container binds to.
 *
 * Container state is session-scoped: one session owns one container, and the
 * authoritative state is the projection's plain-JSON fold of accepted
 * `tool/call`/`tool/result` events (see `protocol.ts`). The exchange format
 * between the node tool domain and the browser view is WGS84 GeoJSON
 * (RFC 7946) plus optional source-CRS metadata; the browser side reprojects
 * for display through the ArcGIS projection engine.
 * @module @map-harness/map-container
 */

export { type MapContainerState, type MapLayerRecord, type MapLayerLegend, type MapLayerStream, type MapLayerTerrain, type MapViewRecord, type MapAoiRecord, type MapOperationSummary, type GeoJsonFeatureCollection } from './registry.ts'
export { MAP_CONTAINER_SERVICE, type MapContainerService } from './service.ts'
export {
  DISPLAY_GEOMETRY_TYPES,
  MAP_MUTATION_TOOL_NAMES,
  MAP_META_KIND,
  MAP_META_SCHEMA_VERSION,
  MAP_PROJECTION_STATE_VERSION,
  MAX_AOI_RING_POINTS,
  MAX_CHANGE_META_BYTES,
  MAX_MAP_LAYERS,
  MAX_MAP_OPERATION_RECORDS,
  MAX_PATCH_CHANGES,
  MAX_PROJECTION_STATE_BYTES,
  aoiDigestOf,
  buildMapChangeMeta,
  decodeMapChangeMeta,
  initialMapProjectionState,
  layerDigestOf,
  mapChangeMetaSchema,
  mapChangeAllowedForTool,
  mapProjectionStateSchema,
  settleMapResult,
  stableDigestOf,
  validateMapChangeCandidate,
  MapChangeValidationError,
  type BaseMapChange,
  type MapAoi,
  type MapChange,
  type MapChangeIdentity,
  type MapChangeMeta,
  type MapDiagnostic,
  type MapDiagnosticCode,
  type MapMutationName,
  type MapOperationPostState,
  type MapOperationRecord,
  type MapPendingCall,
  type MapProjectedLayer,
  type MapProjectionState,
  type StyleChangeEntry,
} from './protocol.ts'
export { name as pluginName, apply as pluginApply, inject as pluginInject } from './plugin.ts'
export { name, apply, inject } from './plugin.ts'
export { mapContainerProjectionDefinition, type ProjectedLayer } from './projection.ts'
