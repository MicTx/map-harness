/**
 * The catalog's record vocabulary: immutable resource versions, stable
 * feature refs, frozen retrieval bundles, analysis-artifact versions, and the
 * per-object durability status. These records are the shared contract between
 * the catalog repository, the model-facing tools, and the map display layer;
 * every field is plain JSON so the records survive serialization unchanged.
 *
 * @module @map-harness/spatial-catalog/types
 */
import type { ArtifactId, ArtifactRef, FeatureRef, OperationRef, ResourceId, ResourceRef } from './refs.ts'
import type { SemanticDefinition } from './semantic.ts'

/** Lifecycle state of one published catalog object. */
export type LifecycleState = 'available' | 'revoked'

/** One immutable resource version as registered (the stored bytes stay in their declared native CRS). */
export interface ResourceVersion {
  /** Exact model-visible ref of this version. */
  readonly ref: ResourceRef
  /** Logical resource this version belongs to. */
  readonly resourceId: ResourceId
  /** Monotonic version within the logical resource; a new head never invalidates an older version. */
  readonly version: number
  /** sha256 of the stored bytes — the immutable content identity. */
  readonly contentDigest: string
  /** sha256 over the canonical schema record (field names/type classes plus geometry types). */
  readonly schemaDigest: string
  /** The frozen schema field table the digest commits to. */
  readonly schemaFields: readonly { readonly name: string; readonly type: string }[]
  /** Declared media type of the stored bytes (`application/geo+json`). */
  readonly mediaType: string
  /** Stored byte count. */
  readonly byteCount: number
  /** Number of features the stored collection carries. */
  readonly featureCount: number
  /** Every geometry type present, in first-seen order. */
  readonly geometryTypes: readonly string[]
  /** Declared CRS the stored coordinates are in (validated at the tool boundary). */
  readonly nativeCrs: string
  /** Declared coordinate convention (`wgs84-geographic` or `projected-grid`). */
  readonly coordinateConvention: string
  /** Coordinate extent `[minX, minY, maxX, maxY]` in native CRS coordinates, when any geometry exists. */
  readonly extent: readonly [number, number, number, number] | null
  /** Optional validity window the data claims to describe. */
  readonly validTime: { readonly from?: string; readonly to?: string } | null
  /** sha256 of the registered source path label — recorded origin without exposing the host path. */
  readonly sourceDigest: string
  /** Store-relative POSIX path of the immutable bytes inside the controlled file area. */
  readonly storageRef: string
  /** Authorization domain the version is published under. */
  readonly authorization: string
  readonly lifecycleState: LifecycleState
  readonly registeredAt: string
}

/** One feature's stable identity inside one resource version. */
export interface FeatureRefEntry {
  readonly featureRef: FeatureRef
  /** The feature's original identifier from the source data, when one existed. */
  readonly originalId: string | null
  /** Zero-based position of the feature in the stored collection. */
  readonly featureIndex: number
}

/** The frozen retrieval context one exact resolution produced. */
export interface RetrievalBundle {
  /** The exact resource version this bundle fixes. */
  readonly resourceRef: ResourceRef
  readonly contentDigest: string
  readonly schemaDigest: string
  /** Semantic definition version bound to the resource, when one exists. */
  readonly semanticDefinition: { readonly definitionId: string; readonly version: number } | null
  /** Field-mapping version of that binding, when one exists. */
  readonly mappingVersion: number | null
  /** Transform identity the convergence to WGS84 display coordinates applies. */
  readonly transformVersion: string
  /** Where and when the catalog was read — the observation anchor, never a global invalidation key. */
  readonly catalogReadPoint: { readonly readId: string; readonly readAt: string }
  /** The authorization grant version the read was admitted under (P0b: the static domain grant). */
  readonly authorizationVersion: string
}

/** The schema record one resolution reports (derived from the stored bytes at register time). */
export interface ResourceSchema {
  /** Property fields across the collection's features with their JSON type classes. */
  readonly fields: readonly { readonly name: string; readonly type: string }[]
  readonly geometryTypes: readonly string[]
  readonly featureCount: number
}

/** One exact authorized resolution: the version, its schema, feature identities, and bundle. */
export interface ResolvedResource {
  /** Exact bound definition content; empty when this resource has no binding. */
  readonly semanticDefinitions: readonly SemanticDefinition[]
  readonly resource: ResourceVersion
  readonly schema: ResourceSchema
  /** Bounded feature-ref listing (the full list up to the resolve cap). */
  readonly featureRefs: readonly FeatureRefEntry[]
  readonly totalFeatureRefs: number
  readonly bundle: RetrievalBundle
}

/** Method identity and parameters one artifact was computed with. */
export interface ArtifactMethod {
  readonly algorithm: string
  readonly units: string
  readonly parameters: Readonly<Record<string, number | string>>
}

/** One immutable analysis-artifact version published by a computation. */
export interface ArtifactVersion {
  /** Exact model-visible ref of this artifact version. */
  readonly ref: ArtifactRef
  readonly artifactId: ArtifactId
  readonly version: number
  /** Every input the computation consumed, as exact catalog refs (`res-…@vN`, plus feature refs). */
  readonly inputRefs: readonly string[]
  readonly method: ArtifactMethod
  /** sha256 over the canonical request inputs (method + parameters + input refs). */
  readonly parametersDigest: string
  /** CRS the artifact's coordinates are in (`EPSG:4326` for the WGS84 product family). */
  readonly analysisCrs: string
  readonly contentDigest: string
  readonly byteCount: number
  /** Store-relative POSIX path of the immutable artifact bytes. */
  readonly storageRef: string
  /** Publication status (`available`); revoked products refuse reads. */
  readonly status: LifecycleState
  /** Session that computed and published the artifact. */
  readonly createdBy: string
  /** Authorization domain inherited from the inputs' minimum privilege. */
  readonly authorization: string
  readonly createdAt: string
}

/** The kind of catalog object one ref addresses. */
export type CatalogObjectKind = 'resource' | 'artifact'

/** One registration request: bytes plus their validated declaration. */
export interface RegisterResourceInput {
  /** Human-readable resource name; re-registering one name yields the next version of that resource. */
  readonly name?: string
  /** The exact source bytes to copy into the controlled file area. */
  readonly bytes: Uint8Array
  /** Workspace-relative source label; only its digest is recorded. */
  readonly sourceLabel: string
  /** Declared native CRS of the bytes (validated at the tool boundary). */
  readonly nativeCrs: string
  /** Reject coordinates outside the geographic range (WGS84-family declarations). */
  readonly enforceWgs84Range: boolean
  /** Optional validity window the data claims to describe. */
  readonly validTime?: { readonly from?: string; readonly to?: string }
  /** Authorization domain to publish under. */
  readonly authorization: string
  /** Session that performs the registration. */
  readonly sessionId: string
  /** Seq of the session's accepted `tool/call` whose publication this is. */
  readonly sourceCallSeq: number
}

/** One registration outcome. */
export interface RegisterResourceResult {
  readonly resource: ResourceVersion
  readonly featureRefs: readonly FeatureRefEntry[]
  readonly operationRef: OperationRef
  /** True when an identical, already-published operation was returned instead of a new version. */
  readonly deduplicated: boolean
}

/** One artifact publication request. */
export interface PublishArtifactInput {
  readonly bytes: Uint8Array
  /** Exact catalog refs the computation consumed (`res-…@vN`, optionally with `+f-…`). */
  readonly inputRefs: readonly string[]
  readonly method: ArtifactMethod
  /** CRS the artifact coordinates are in. */
  readonly analysisCrs: string
  /** Session that computed the artifact. */
  readonly sessionId: string
  /** Seq of the session's accepted `tool/call` whose publication this is. */
  readonly sourceCallSeq: number
  /** Authorization domains of every consumed input; the artifact inherits the minimum. */
  readonly inputAuthorizations: readonly string[]
}

/** One publication outcome. */
export interface PublishArtifactResult {
  readonly artifact: ArtifactVersion
  readonly operationRef: OperationRef
  /** True when an identical, already-published operation was returned. */
  readonly deduplicated: boolean
}

/** Per-object durability status reported by a confirmation sweep. */
export type ObjectDurabilityStatus =
  | 'ok'
  | 'missing-file'
  | 'digest-mismatch'
  | 'unpublished'
  | 'revoked'
  | 'tombstoned'
  | 'recalled'

/** One object's durability confirmation result. */
export interface ObjectDurability {
  readonly ref: string
  readonly kind: CatalogObjectKind
  readonly status: ObjectDurabilityStatus
}
