/**
 * The `ctx.spatialCatalog` service contract: the host-plane face over the
 * transactional resource catalog that the model-facing tools resolve from
 * their execution context. Every conversation owns an independent store
 * library, so the process-level service is a router: {@link
 * SpatialCatalogService.forSession} binds one session's identity to its own
 * open store and returns the session view whose methods are that library's
 * whole read/write face. The process service keeps only the operations that
 * are genuinely cross-session (the fork registration and the deployment
 * domain). Every method is bounded, synchronous-under-the-hood work exposed
 * as a promise so callers keep a uniform async seam.
 *
 * @module @map-harness/spatial-catalog/service
 */
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  ArtifactVersion,
  ObjectDurability,
  PublishArtifactInput,
  PublishArtifactResult,
  RegisterResourceInput,
  RegisterResourceResult,
  ResolvedResource,
} from './types.ts'
import type {
  RegisterSemanticDefinitionInput,
  SemanticDefinition,
  SemanticSearchResult,
} from './semantic.ts'
import type { PendingPublishCall } from './projection.ts'
import type {
  AclGrantRecord,
  AclState,
  AuditRecord,
  GovernanceCopyChannel,
  GovernanceObjectKind,
  GovernanceOperation,
  GovernanceSubject,
} from './governance.ts'

/** Cordis service name for the spatial catalog. */
export const SPATIAL_CATALOG_SERVICE = 'spatialCatalog'

/** Authorization domain the P0b single-domain deployment reads and publishes under. */
export const LOCAL_AUTHORIZATION = 'local'

/** One governance authorization request the service evaluates and audits. */
export interface CatalogAuthorizeInput {
  /** Who is asking; Host/provider identity, never a model parameter. */
  readonly subject: GovernanceSubject
  /** The governed entry operation. */
  readonly operation: GovernanceOperation
  /** The protected object kind. */
  readonly objectKind: GovernanceObjectKind
  /** Exact ref of the protected object (public ref form, or a session id). */
  readonly ref: string
  /** Authorization domain; defaults to the deployment domain. */
  readonly domain?: string
  /** Session the operation belongs to, when the caller has one. */
  readonly sessionId?: string
  /** Resource version number, when the object is a versioned resource. */
  readonly resourceVersion?: number
  /**
   * The tenant the request decides under; absent decides under the
   * deployment tenant. A grant under another tenant reads as missing and
   * denies without disclosing existence.
   */
  readonly tenant?: string
}

/** Input for registering one governed copy's address. */
export interface CatalogRegisterCopyInput {
  /** The channel the copy left the store through. */
  readonly channel: GovernanceCopyChannel
  /** The copy's holder: session id, layer id, checkpoint seq, or fork child. */
  readonly holder: string
  /** The protected object kind. */
  readonly objectKind: GovernanceObjectKind
  /** The object's exact public ref. */
  readonly ref: string
  /** Authorization domain the registration reads under; defaults to the deployment domain. */
  readonly domain?: string
  /** Session the registration belongs to, when the caller has one. */
  readonly sessionId?: string
}

/** One registered copy row as the service projects it. */
export interface CatalogCopyRecord {
  readonly copySeq: number
  readonly tenant: string
  readonly objectKind: GovernanceObjectKind
  readonly ref: string
  readonly channel: GovernanceCopyChannel
  readonly holder: string
  readonly registeredAt: string
}

/** One copy-trail read filter; every field is optional and conjunctive. */
export interface CatalogCopyFilter {
  readonly objectKind?: GovernanceObjectKind
  readonly ref?: string
  readonly channel?: GovernanceCopyChannel
  readonly holder?: string
  /** Maximum records returned (oldest first). Defaults to 100. */
  readonly limit?: number
}

/** One recall request: what the host is recalling copies of. */
export interface CatalogRecallInput {
  /** Who is recalling; Host/provider identity, never a model parameter. */
  readonly subject: GovernanceSubject
  /** The recall's scope: one exact object, or the whole deployment tenant. */
  readonly scope:
    | { readonly kind: 'object'; readonly objectKind: GovernanceObjectKind; readonly ref: string }
    | { readonly kind: 'tenant' }
  /** Free-text origin recorded on the recall event. */
  readonly origin: string
}

/** One recall event's result. */
export interface CatalogRecallResult {
  /** The recall id shared by the event row in every session library. */
  readonly recallId: string
  /** The scope that was recalled. */
  readonly scope: CatalogRecallInput['scope']
  /** How many registered copies the recall covers. */
  readonly recalledCopies: number
}

/** One recall event row as the service projects it. */
export interface CatalogRecallRecord {
  readonly recallId: string
  readonly tenant: string
  readonly scope: 'object' | 'tenant'
  readonly objectKind: GovernanceObjectKind | null
  readonly ref: string | null
  readonly origin: string
  readonly subjectId: string
  readonly recalledAt: string
}

/** One recall-trail read filter; every field is optional and conjunctive. */
export interface CatalogRecallFilter {
  readonly scope?: 'object' | 'tenant'
  readonly objectKind?: GovernanceObjectKind
  readonly ref?: string
  /** Maximum records returned (newest first). Defaults to 100. */
  readonly limit?: number
}

/** One ACL state transition request (the Host/provider governance plane). */
export interface CatalogSetObjectStateInput {
  /** Who is transitioning; Host/provider identity, never a model parameter. */
  readonly subject: GovernanceSubject
  readonly objectKind: GovernanceObjectKind
  readonly ref: string
  /** Target ACL state (`granted` restores a previously revoked object). */
  readonly state: AclState
  /** Authorization domain; defaults to the deployment domain. */
  readonly domain?: string
  /** Free-text reason recorded in the audit trail. */
  readonly reason?: string
  /** Session the transition belongs to, when the caller has one. */
  readonly sessionId?: string
}

/** One audit-trail read filter; every field is optional and conjunctive. */
export interface CatalogAuditFilter {
  readonly objectKind?: GovernanceObjectKind
  readonly ref?: string
  readonly sessionId?: string
  /** Maximum records returned (newest first). Defaults to 100. */
  readonly limit?: number
}

/**
 * The session-scoped catalog face: every method reads and writes only this
 * conversation's own store library. A ref published by another session
 * answers `CATALOG_NOT_FOUND` exactly like an unknown ref — sessions never
 * share rows, bytes, or locks, and the view refuses inputs that claim a
 * different session's identity.
 */
export interface SessionSpatialCatalog {
  /**
   * Copy, validate, and publish one immutable resource version inside one
   * transaction in this session's store. The original workspace path is
   * never stored — only its digest — and later computations read the copied
   * bytes, never the path.
   * @throws {CatalogError} `CATALOG_INVALID_INPUT` when `input.sessionId` is
   *   not this view's bound session.
   */
  register(input: RegisterResourceInput): Promise<RegisterResourceResult>
  /** Publish the next immutable version of one governed semantic definition. */
  registerSemanticDefinition(input: RegisterSemanticDefinitionInput & { readonly sessionId: string }): Promise<SemanticDefinition>
  /** Search authorized semantic definitions by business-language query. */
  searchSemanticDefinitions(input: { readonly query: string; readonly authorization: string; readonly applicability?: string; readonly limit?: number }): Promise<SemanticSearchResult>
  /** Resolve one exact resource ref into version, schema, feature ids, and a frozen bundle — inside this session's store only. */
  resolve(input: { ref: string; authorization: string; maxFeatureRefs?: number }): Promise<ResolvedResource>
  /** Read one resource version's stored bytes after authorization and digest verification. */
  readResourceBytes(ref: string, authorization: string, maxBytes: number): Promise<{ resource: ResolvedResource['resource']; bytes: Uint8Array }>
  /**
   * Stream one resource version's bytes in bounded chunks after authorization
   * and whole-content digest verification — for consumers that must not hold
   * the full file in memory.
   */
  readResourceChunks(ref: string, authorization: string, limits: { maxBytes: number; chunkBytes: number }, onChunk: (chunk: Uint8Array) => void): Promise<{ resource: ResolvedResource['resource'] }>
  /**
   * Stage, validate, and publish one immutable analysis artifact in this
   * session's store.
   * @throws {CatalogError} `CATALOG_INVALID_INPUT` when `input.sessionId` is
   *   not this view's bound session.
   */
  publishArtifact(input: PublishArtifactInput): Promise<PublishArtifactResult>
  /** Read one artifact version's stored bytes after authorization and digest verification. */
  readArtifactBytes(ref: string, authorization: string): Promise<{ artifact: ArtifactVersion; bytes: Uint8Array }>
  /**
   * Confirm the durability of published objects: file presence, digest, and
   * published catalog row, per ref — the artifact/catalog stage of a
   * cross-storage save. A revoked or tombstoned grant reports its governance
   * state instead of `ok`.
   */
  confirmDurability(refs: readonly string[]): Promise<readonly ObjectDurability[]>
  /**
   * Look up an already-published operation by its original session call —
   * the retryOf path, always inside the bound session's own store. Missing
   * records return `undefined`; callers refuse instead of re-reading any
   * mutable source. The retry's subsequent byte read re-runs the full
   * authorization check, so revocation blocks resumed retries.
   */
  lookupPublication(kind: 'register' | 'artifact', sourceCallSeq: number): Promise<{ resultRef: string } | undefined>
  /**
   * Resolve the accepted publish `tool/call` this execution pairs with —
   * the trusted `sourceCallSeq` every publish operation and retryOf cites.
   * @param session - the live session that accepted the call.
   * @param callId - the ToolRuntime call id of the executing call.
   * @returns the pending publish entry, or `undefined` when the call has no
   *   accepted publish `tool/call` in the session log.
   */
  pendingPublishCallOf(session: Session, callId: string): PendingPublishCall | undefined
  /**
   * Evaluate one governance request against this session's store and audit
   * the decision (allowed or denied). This is the governed-entry seam for
   * session-linked, export, and any entry outside the built-in read paths;
   * it never throws on a denial — callers decide how to refuse.
   */
  authorize(input: CatalogAuthorizeInput): Promise<import('./governance.ts').GovernanceDecisionResult>
  /**
   * Apply one ACL state transition (grant / revoke / tombstone) in this
   * session's store and audit it. Host/provider governance plane only — no
   * model-facing tool exposes this; subjects come from host-owned code.
   */
  setObjectState(input: CatalogSetObjectStateInput): Promise<AclGrantRecord>
  /** Read this session's append-only audit trail, newest first, bounded. */
  auditTrail(filter?: CatalogAuditFilter): Promise<readonly AuditRecord[]>
  /**
   * Register one governed copy's address in this session's store — the
   * `display` and `export` channels model-facing tools use. Idempotent per
   * holder; a recalled object refuses new registrations.
   */
  registerCopy(input: CatalogRegisterCopyInput): Promise<CatalogCopyRecord>
  /** Read this session's registered-copy trail, oldest first, bounded. */
  copyTrail(filter?: CatalogCopyFilter): Promise<readonly CatalogCopyRecord[]>
  /** Read this session's recall-event trail, newest first, bounded. */
  recallTrail(filter?: CatalogRecallFilter): Promise<readonly CatalogRecallRecord[]>
  /** The authorization domain this deployment reads and publishes under. */
  deploymentDomain(): string
  /** The tenant this deployment reads and publishes under. */
  deploymentTenant(): string
  /** This session's absolute store root (the scale channel stages its versions beside the catalog's own areas). */
  storeRoot(): string
  /**
   * The availability state of one catalog object for context-gating reads
   * (the model-context entry): `unknown` covers missing objects and
   * out-of-domain refs without disclosing which — including every ref
   * another session published. Non-available states are audited as
   * `context` denials.
   */
  refStateOf(ref: string, domain?: string): Promise<'available' | 'revoked' | 'tombstoned' | 'recalled' | 'unknown'>
}

/**
 * The `ctx.spatialCatalog` service face: the process-level router over the
 * per-session store libraries. Tools resolve it from the agent context
 * through `ctx.get('spatialCatalog')` and immediately bind their session via
 * {@link forSession}.
 */
export interface SpatialCatalogService {
  /**
   * Bind one conversation to its own store library: the first call opens
   * (creating and migrating when absent) the session's database under the
   * configured root and later calls reuse the open handle for the process
   * lifetime.
   * @param sessionId - the calling conversation's session id.
   * @returns the session-scoped catalog view.
   */
  forSession(sessionId: string): SessionSpatialCatalog
  /** The authorization domain this deployment reads and publishes under. */
  deploymentDomain(): string
  /**
   * Register a fork across two session libraries: the child session's store
   * records the parent pointer and inherits the parent session object's ACL
   * state (a revoked parent yields a revoked child row) — resource and
   * artifact visibility is never inherited; each conversation reads only its
   * own library. A parent that never used the catalog has no session grant
   * and the fork is denied with `GOVERNANCE_DENIED`.
   */
  forkSession(parentSessionId: string, childSessionId: string, domain?: string): Promise<AclGrantRecord>
  /** The tenant this deployment reads and publishes under. */
  deploymentTenant(): string
  /**
   * Record one recall event across every session library under the
   * deployment root and refuse future use of the registered copies it
   * covers: each covered copy is audited (`recall`/`GOVERNANCE_RECALLED`),
   * each store's recall event row makes the next governed use deny, and
   * cached resolutions for covered refs are dropped. Recall is
   * append-only — restoring access goes through ACL state, never through
   * un-recording an event.
   */
  recallCopies(input: CatalogRecallInput): Promise<CatalogRecallResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Map-owned transactional spatial catalog (host-plane service). */
    spatialCatalog: SpatialCatalogService
  }
}
