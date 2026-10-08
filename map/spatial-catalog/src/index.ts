/**
 * `@map-harness/spatial-catalog` — the map-owned transactional resource
 * catalog. Registration copies source bytes into the controlled file area,
 * digests them, assigns stable feature refs, and publishes the version with
 * its publish intent in one transaction; resolution filters by authorization,
 * returns the frozen schema and feature identities, and pins a
 * RetrievalBundle; artifact publication gives computations the same
 * immutable-copy treatment with inherited authorization. The store schema is
 * owned by the monotonic spatial-storage migration ladder; this package owns
 * the repository API, the transactions, and the session projection that pairs
 * publish calls with their durable call seqs.
 *
 * @module @map-harness/spatial-catalog
 */
export { CatalogError, type CatalogErrorCode } from './errors.ts'
export {
  formatArtifactRef,
  formatResourceRef,
  newArtifactId,
  newResourceId,
  operationRefOf,
  parseCatalogRef,
  resourceIdFromName,
  rowIdOfRef,
  sha256BytesHex,
  sha256Hex,
  type ArtifactId,
  type ArtifactRef,
  type FeatureRef,
  type OperationRef,
  type ParsedCatalogRef,
  type ResourceId,
  type ResourceRef,
} from './refs.ts'
export {
  coordinateConventionOf,
  isWgs84FamilyCrs,
  isSupportedDisplayWkid,
  SUPPORTED_DISPLAY_WKIDS,
  transformVersionOf,
  type CoordinateConvention,
} from './crs.ts'
export {
  admitCollection,
  validateGeoJsonValue,
  validateGeoJsonProperties,
  DISPLAY_GEOMETRY_TYPES,
  MAX_FEATURE_PROPERTIES_BYTES,
  MAX_PROPERTY_DEPTH,
  MAX_REGISTER_BYTES,
  MAX_REGISTER_COORDINATES,
  MAX_REGISTER_DEPTH,
  MAX_REGISTER_FEATURES,
  type AdmittedCollection,
  type GeoJsonAdmissionOptions,
  type ValidatedGeoJsonValue,
  type ResourceSchemaRecord,
} from './geojson.ts'
export {
  openCatalogStore,
  withTransaction,
  type CatalogStore,
} from './store.ts'
export {
  featureRefsOf,
  lookupPublication,
  publishedBytes,
  readResourceBytes,
  readResourceChunks,
  readVersionRow,
  registerResource,
  RESOURCE_MEDIA_TYPE,
} from './register.ts'
export {
  MAX_RESOLVE_FEATURE_REFS,
  resolveResource,
  versionRowId,
  type ResolveInput,
} from './resolve.ts'
export {
  ARTIFACT_MEDIA_TYPE,
  bindResource,
  confirmDurability,
  MAX_ARTIFACT_BYTES,
  publishArtifact,
  readArtifactBytes,
  readArtifactRow,
} from './artifacts.ts'
export {
  MAX_SEMANTIC_CANDIDATES,
  readSemanticDefinition,
  registerSemanticDefinition,
  searchSemanticDefinitions,
  type RegisterSemanticDefinitionInput,
  type SemanticCandidate,
  type SemanticDefinition,
  type SemanticJsonValue,
  type SemanticSearchResult,
} from './semantic.ts'
export {
  initialSpatialCatalogState,
  MAX_PENDING_PUBLISH_CALLS,
  PUBLISH_TOOL_NAMES,
  SPATIAL_CATALOG_STATE_VERSION,
  spatialCatalogProjectionDefinition,
  type PendingPublishCall,
  type SpatialCatalogProjectionState,
} from './projection.ts'
export {
  LOCAL_AUTHORIZATION,
  SPATIAL_CATALOG_SERVICE,
  type CatalogAuthorizeInput,
  type CatalogAuditFilter,
  type CatalogCopyFilter,
  type CatalogCopyRecord,
  type CatalogRecallFilter,
  type CatalogRecallInput,
  type CatalogRecallRecord,
  type CatalogRecallResult,
  type CatalogRegisterCopyInput,
  type CatalogSetObjectStateInput,
  type SessionSpatialCatalog,
  type SpatialCatalogService,
} from './service.ts'
export {
  appendAudit,
  grantOnPublish,
  listAudit,
  listCopies,
  listRecalls,
  MAX_AUDIT_TRAIL,
  MAX_COPY_TRAIL,
  MAX_RECALL_TRAIL,
  readGrant,
  recallAffects,
  recordRecall,
  registerCopy,
  transitionGrant,
  type AuditFilter,
  type CopyFilter,
  type CopyRecord,
  type RecallFilter,
  type RecallRecord,
} from './governance-repo.ts'
export {
  assertValidTenantId,
  AUTHORIZATION_LATTICE,
  COPY_LIMIT_NOTE,
  decide,
  deriveAuthorization,
  DOMAIN_LOCAL,
  DOMAIN_SENSITIVE,
  GOVERNANCE_CONTRACT_VERSION,
  GOVERNANCE_CONTRACT_VERSION_V2,
  GOVERNANCE_COPY_CHANNELS,
  HOST_SUBJECT,
  MAX_OBJECT_COPIES,
  notAvailableDetail,
  RECALL_NOTE,
  recalledDetail,
  revokedDetail,
  TENANT_DEFAULT,
  TENANT_ID_PATTERN,
  tombstonedDetail,
  type AclGrantRecord,
  type AclState,
  type AuditRecord,
  type GovernanceCopyChannel,
  type GovernanceDecision,
  type GovernanceDecisionResult,
  type GovernanceObjectKind,
  type GovernanceOperation,
  type GovernanceRequest,
  type GovernanceSubject,
} from './governance.ts'
export { GovernanceError, type GovernanceErrorCode } from './governance-errors.ts'
export {
  RETRIEVAL_CACHE_CAPACITY,
  RetrievalCache,
  type RetrievalCacheEntry,
  type RetrievalCacheStats,
} from './retrieval-cache.ts'
export type {
  ArtifactMethod,
  ArtifactVersion,
  CatalogObjectKind,
  FeatureRefEntry,
  LifecycleState,
  ObjectDurability,
  ObjectDurabilityStatus,
  PublishArtifactInput,
  PublishArtifactResult,
  RegisterResourceInput,
  RegisterResourceResult,
  ResolvedResource,
  ResourceSchema,
  ResourceVersion,
  RetrievalBundle,
} from './types.ts'
export { name, apply, inject, Config, type CatalogPluginConfig } from './plugin.ts'
