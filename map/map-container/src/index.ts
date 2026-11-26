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
export { viewEngineKey } from './view-policy.ts'
export { blendEarlyImagery } from './imagery-display.ts'
/** Read face of the map source service used by host tool consumers. */
export type { MapSourceService } from './source-service-protocol.ts'
export { resolveMapSourceSelection, SourceCatalogError } from './sources.ts'
export { MAP_CONTAINER_SERVICE, type MapContainerService } from './service.ts'
export {
  DEFAULT_INTERACTION_LIMITS,
  MAP_INTERACTION_SERVICE,
  MAP_USE_ROUTE,
  MAX_INTERACTION_LIMIT_BOUND,
  createMapInteractionService,
  registerInteractionRoute,
  serveMapUseRequest,
  type MapInteractionClaim,
  type MapInteractionClaimOutcome,
  type MapInteractionLimits,
  type MapInteractionService,
  type MapInteractionSubmission,
  type MapInteractionSubmitRefusal,
  type MapInteractionWait,
  type MapInteractionWireCancel,
} from './interaction.ts'
export {
  DEFAULT_MAP_USE_BUDGET,
  MAP_INTERACTION_STATE_VERSION,
  MAP_USE_REQUEST_TTL_MS,
  MAX_INTERACTION_FIELD_CHARS,
  MAX_INTERACTION_FIELDS,
  MAX_INTERACTION_HITS,
  MAX_INTERACTION_PENDING,
  initialMapInteractionState,
  mapInteractionOutcomeSchema,
  mapInteractionStateSchema,
  mapUseBudgetRefusalOf,
  mapUseBudgetSnapshotOf,
  resolveMapUseBudget,
  type MapInteractionDeclineCode,
  type MapInteractionField,
  type MapInteractionHit,
  type MapInteractionOutcome,
  type MapInteractionState,
  type MapInteractionWaitOutcome,
  type MapInteractionWire,
  type MapUseAction,
  type MapUseActionName,
  type MapUseBudget,
  type MapUseBudgetRefusal,
  type MapUseBudgetSnapshot,
  type MapUseClientRequest,
  type MapUseClickAction,
  type MapUseFinishAction,
  type MapUsePanAction,
  type MapUseZoomAction,
} from './interaction-protocol.ts'
export {
  MAX_MAP_USE_PAN_PX,
  MAX_MAP_USE_ZOOM_DELTA,
  affineOfObservation,
  cssPointOf,
  displayPointOf,
  imagePointInMapContent,
  interactionHitOf,
  panTargetOf,
  parseMapUseArguments,
  wgs84OfDisplayPoint,
  zoomTargetOf,
  type MapUseMathRefusal,
  type MapUseViewTarget,
} from './map-use.ts'
export { applyMapInteractionEvent } from './interaction-projection.ts'
export { mapUseMetaSchema, mapUseReceiptSchema, stopMapInteraction, type MapUseReceipt } from './interaction-protocol.ts'
export { MAP_VIEWPORT_ROUTE, MAP_VIEWPORT_SERVICE, createMapViewportService, registerViewportRoute, serveViewportReport, type MapLiveViewport, type MapViewportService } from './viewport.ts'
export { DEFAULT_OBSERVATION_LIMITS, MAP_OBSERVATION_SERVICE, MAX_OBSERVATION_BYTES, MAX_OBSERVATION_PENDING, createMapObservationService, registerObservationRoute, serveObservationRequest, type MapObservationCapture, type MapObservationClaim, type MapObservationClaimOutcome, type MapObservationCurrent, type MapObservationLimits, type MapObservationOutcome, type MapObservationService, type MapObservationSubmission, type MapObservationWait, type MapObservationWireCancel, type ObservationDeclineCode, type ObservationSubmitRefusal } from './observation.ts'
export { admitObservationPng, type ObservationPngRefusal, type ObservationPngVerdict } from './observation-png.ts'
export {
  FIXED_BASEMAP_SOURCE_ID,
  FIXED_BASEMAP_ATTRIBUTION,
  FIXED_BASEMAP_DESCRIPTOR,
  MAP_OBSERVATION_META_KIND,
  MAP_OBSERVATION_SCHEMA_VERSION,
  MAP_OBSERVATION_SCHEMA_VERSION_2,
  OBSERVATION_COMPOSITION_VERSION,
  MapObservationId,
  OBSERVATION_BASE_LIMITATIONS,
  OBSERVATION_HTML_OVERLAY_LIMITATION,
  OBSERVATION_NO_GEOREFERENCE_LIMITATION,
  buildMapObservationMeta,
  decodeMapObservationMeta,
  expectedObservationSources,
  observationCompositionOf,
  mapObservationCaptureSchema,
  mapObservationRecordSchema,
  type Affine2dGeoreference,
  type GeoreferenceNoneReason,
  type MapObservationMeta,
  type MapObservationMetaVerdict,
  type MapObservationCaptureShape,
  type MapObservationRecord,
  type ObservationAttachment,
  type ObservationCamera,
  type ObservationComposition,
  type ObservationCompositionLayer,
  type ObservationGeoreference,
  type ObservationRect,
  type ObservationSize,
  type ObservationSource,
  type ObservationSourceLayer,
} from './observation-protocol.ts'
export {
  VISUAL_CHANGE_ID_PREFIX,
  MAX_VISUAL_CHANGE_CANDIDATES,
  MAX_VISUAL_CHANGE_META_BYTES,
  VISUAL_CHANGE_META_KIND,
  VISUAL_COMPARISON_ID_PREFIX,
  VISUAL_COMPARISON_LIMITATIONS,
  VISUAL_COMPARISON_META_KIND,
  VISUAL_CHANGE_SCHEMA_VERSION,
  buildVisualChangeMeta,
  buildVisualComparisonMeta,
  compareObservationEvidence,
  decodeVisualChangeMeta,
  decodeVisualComparisonMeta,
  mapComparisonRecordSchema,
  parseVisualChangeItems,
  visualChangePairingCode,
  visualChangeRecordSchema,
  type ComparisonCandidate,
  type ComparisonRefusal,
  type Comparability,
  type ComparisonRelease,
  type ComparisonVerdict,
  type MapComparisonRecord,
  type VisualChangeConfidence,
  type VisualChangeItem,
  type VisualChangeKind,
  type VisualChangeMeta,
  type VisualChangeRecord,
  type VisualChangeStatus,
  type VisualComparisonMeta,
} from './comparison-protocol.ts'
export { visualChangeLayerOf } from './visual-change-layer.ts'
export { type MapObservationRequest } from './protocol.ts'
export { AGENT_ANNOTATION_META_KIND, AGENT_ANNOTATION_SCHEMA_VERSION, decodeAgentAnnotationMeta } from './agent-annotation.ts'
export {
  DISPLAY_GEOMETRY_TYPES,
  MAP_MUTATION_TOOL_NAMES,
  MAP_PENDING_TOOL_NAMES,
  MAP_META_KIND,
  MAP_META_SCHEMA_VERSION,
  MAP_PROJECTION_STATE_VERSION,
  USER_ANNOTATION_LAYER_ID,
  VISUAL_PROPOSAL_LAYER_ID,
  MAX_ANNOTATION_FEATURES,
  MAX_ANNOTATION_FEATURE_COORDINATES,
  MAX_ANNOTATION_TOTAL_COORDINATES,
  MAX_AOI_RING_POINTS,
  MAX_CHANGE_META_BYTES,
  MAX_FEATURE_OVERRIDE_ENTRIES,
  MAX_LAYER_STATE_ENTRIES,
  MAX_MAP_LAYERS,
  MAX_MAP_OPERATION_RECORDS,
  MAX_PATCH_CHANGES,
  MAX_PROJECTION_STATE_BYTES,
  MAX_SYMBOL_STYLE_ENTRIES,
  aoiDigestOf,
  buildMapChangeMeta,
  decodeMapChangeMeta,
  initialMapProjectionState,
  layerDigestOf,
  mapChangeMetaSchema,
  mapChangeAllowedForTool,
  mapProjectionStateSchema,
  observationCandidateOf,
  settleMapResult,
  settleAgentAnnotation,
  settleVisualChangeResult,
  stableDigestOf,
  settleVisualProposalResult,
  validateAnnotationGeometry,
  validateMapChangeCandidate,
  MapChangeValidationError,
  type AnnotationGeometry,
  type AnnotationUserChange,
  type AgentAnnotationMeta,
  type MapAnnotationInverse,
  type MapChangeErrorCode,
  type BaseMapChange,
  type FeatureOverridesChangeEntry,
  type LayerStateEntry,
  type MapAoi,
  type MapChange,
  type MapChangeIdentity,
  type MapChangeMeta,
  type MapDiagnostic,
  type MapDiagnosticCode,
  type ObservationCandidateVerdict,
  type MapMutationName,
  type MapPendingToolName,
  type MapOperationPostState,
  type MapOperationRecord,
  type MapPendingCall,
  type MapProjectedLayer,
  type MapProjectionState,
  type VisualChangeUserChange,
  type VisualProposalUserChange,
  type StyleChangeEntry,
  type SymbolStyleChangeEntry,
  MAX_MAP_OBSERVATION_HISTORY,
  MAX_VISUAL_COMPARISONS,
  VISUAL_CHANGE_LAYER_ID,
} from './protocol.ts'
export { name as pluginName, apply as pluginApply, inject as pluginInject, Config as pluginConfigSchema, resolveInteractionConfig, resolveObservationConfig, type MapPluginConfig, type ObservationCapturePolicy, type ResolvedInteractionConfig, type ResolvedObservationConfig } from './plugin.ts'
export { name, apply, inject } from './plugin.ts'
export { mapContainerProjectionDefinition, type ProjectedLayer } from './projection.ts'
export {
  MAX_ACTIVE_VISUAL_PROPOSALS,
  MAX_VISUAL_PROPOSAL_ITEMS,
  VISUAL_PROPOSAL_ID_PREFIX,
  VISUAL_PROPOSAL_LIMITATIONS,
  MAX_VISUAL_PROPOSAL_TEXT_BYTES,
  MAX_VISUAL_PROPOSAL_META_BYTES,
  MAX_VISUAL_PROPOSAL_COORDINATES,
  VISUAL_PROPOSAL_META_KIND,
  VISUAL_PROPOSAL_SCHEMA_VERSION,
  buildVisualProposalMeta,
  decodeVisualProposalMeta,
  parseVisualProposalItems,
  visualProposalPairingCode,
  visualProposalRecordSchema,
  type VisualProposalConfidence,
  type VisualProposalItem,
  type VisualProposalMeta,
  type VisualProposalPixelGeometry,
  type VisualProposalPurpose,
  type VisualProposalRecord,
  type VisualProposalStatus,
} from './visual-proposal-protocol.ts'
export { visualProposalGeometryOf, type VisualProposalMathRefusal } from './visual-proposal-math.ts'
export { visualProposalLayerOf } from './visual-proposal-layer.ts'
export * from './tool-cards/index.ts'
