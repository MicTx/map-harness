/**
 * Node-half Cordis plugin: registers the `spatialCatalog` projection and
 * provides the host-plane service the map tools resolve. The store root is a
 * required, validated config field set by the profile's composition — a
 * missing or invalid root fails loud at load. Every conversation owns an
 * independent store library under `<root>/sessions/<sessionId>/`; the
 * service opens (and migrates) one session's database on its first use and
 * keeps the handle for the process lifetime, so sessions never share rows,
 * bytes, or locks, and the root keeps no shared database.
 *
 * Every built-in read path (resolve, byte reads, durability confirmation)
 * enforces the governance plane before any content leaves the catalog: the
 * ACL decision runs first, the decision is audited either way, and a
 * resource resolution is additionally served through the authorization-
 * scoped retrieval cache whose entries pin the grant version they were
 * admitted under. Enforcement covers every consumer of the service —
 * direct tool calls, MCP dispatch, and resumed sessions alike.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { listSessionStores, sessionStoreRoot, STORE_DB_NAME } from '@map-harness/spatial-storage'
import { CatalogError } from './errors.ts'
import { GovernanceError, type GovernanceErrorCode } from './governance-errors.ts'
import { spatialCatalogProjectionDefinition } from './projection.ts'
import {
  publishArtifact as publishArtifactRepo,
  readArtifactBytes as readArtifactBytesRepo,
} from './artifacts.ts'
import {
  lookupPublication,
  readResourceBytes as readResourceBytesRepo,
  readResourceChunks as readResourceChunksRepo,
  registerResource as registerResourceRepo,
} from './register.ts'
import { resolveResource as resolveResourceRepo } from './resolve.ts'
import {
  SPATIAL_CATALOG_SERVICE,
  type CatalogAuthorizeInput,
  type CatalogAuditFilter,
  type CatalogRecallFilter,
  type CatalogRecallInput,
  type CatalogCopyFilter,
  type CatalogRecallResult,
  type CatalogRegisterCopyInput,
  type SessionSpatialCatalog,
  type SpatialCatalogService,
} from './service.ts'
import { openCatalogStore, type CatalogStore } from './store.ts'
import { confirmDurability as confirmDurabilityRepo } from './artifacts.ts'
import {
  registerSemanticDefinition as registerSemanticDefinitionRepo,
  searchSemanticDefinitions as searchSemanticDefinitionsRepo,
} from './semantic.ts'
import {
  appendAudit,
  listAudit,
  listCopies,
  listRecalls,
  readGrant,
  recallAffects,
  recordRecall,
  registerCopy as registerCopyRepo,
  transitionGrant,
} from './governance-repo.ts'
import {
  decide,
  DOMAIN_LOCAL,
  HOST_SUBJECT,
  notAvailableDetail,
  recalledDetail,
  revokedDetail,
  TENANT_DEFAULT,
  TENANT_ID_PATTERN,
  tombstonedDetail,
  type AclGrantRecord,
  type AclState,
  type AuditRecord,
  type GovernanceDecisionResult,
  type GovernanceObjectKind,
} from './governance.ts'
import { RetrievalCache } from './retrieval-cache.ts'
import { rowIdOfRef } from './refs.ts'

/** Plugin config for the catalog store location, store budget, and domain. */
export interface CatalogPluginConfig {
  /**
   * Store root directory holding one independent database and file area per
   * session under `sessions/<sessionId>/`. Required.
   */
  root: string
  /** Maximum published store bytes per session library; when absent a session store has no byte budget. */
  maxStoreBytes?: number
  /**
   * The authorization domain this deployment reads and publishes under.
   * Defaults to the single `local` P0 domain; a deployment that serves a
   * sensitive domain names it here, and model-supplied domain arguments are
   * clamped against it.
   */
  authorizationDomain?: string
  /**
   * The tenant this deployment serves. Defaults to the single-tenant
   * `default`; every store this plugin opens serves that tenant and refuses
   * governance rows under any other tenant at open.
   */
  tenant?: string
  /**
   * The tenant ids this deployment acknowledges for cross-tenant
   * authorization requests. When declared, an `authorize` request naming a
   * tenant outside the registry fails loud (`GOVERNANCE_INVALID_INPUT`);
   * when absent only the id syntax is checked.
   */
  tenants?: string[]
}

/** Loader config schema; validation failures fail the plugin at load. */
export const Config: z<CatalogPluginConfig> = z.object({
  root: z.string().required(),
  maxStoreBytes: z.number(),
  authorizationDomain: z.string(),
  tenant: z.string(),
  tenants: z.array(z.string()),
})

/** Function-plugin name under the Loader. */
export const name = '@map-harness/spatial-catalog'

/** Required host services: the session-projection registry this unit joins. */
export const inject: string[] = ['sessionProjections']

/** One session's open store plus its authorization-scoped retrieval cache. */
interface SessionBinding {
  readonly store: CatalogStore
  readonly cache: RetrievalCache
}

/** The kind one catalog ref addresses, for governance lookups. */
function objectKindOfRef(ref: string): GovernanceObjectKind | undefined {
  if (ref.startsWith('res-')) return 'resource'
  if (ref.startsWith('art-')) return 'artifact'
  if (ref.startsWith('def-')) return 'semantic'
  return undefined
}

/** The version number one catalog ref carries, when parseable. */
function resourceVersionOfRef(ref: string): number | undefined {
  const match = /@v([1-9][0-9]*)$/.exec(ref)
  const raw = match?.[1]
  return raw === undefined ? undefined : Number(raw)
}

/** Read the exact semantic version a resource binding currently names. */
function semanticBindingRefOf(store: CatalogStore, resourceRef: string): string | undefined {
  const row = store.db.prepare(
    'SELECT definition_id AS definitionId, definition_version AS definitionVersion FROM semantic_bindings WHERE resource_id = ?',
  ).get(rowIdOfRef(resourceRef)) as { definitionId: string; definitionVersion: number } | undefined
  return row === undefined ? undefined : `def-${row.definitionId}@v${row.definitionVersion}`
}

/** Map a denial reason code to its thrown error and model-visible detail. */
function denialError(ref: string, reasonCode: string): GovernanceError {
  const code = reasonCode as GovernanceErrorCode
  if (code === 'GOVERNANCE_REVOKED') return new GovernanceError(code, revokedDetail(ref))
  if (code === 'GOVERNANCE_TOMBSTONED') return new GovernanceError(code, tombstonedDetail(ref))
  if (code === 'GOVERNANCE_RECALLED') return new GovernanceError(code, recalledDetail(ref))
  if (code === 'GOVERNANCE_SUBJECT_REQUIRED') {
    return new GovernanceError(code, 'the authorization subject is required and comes from the host, never from model parameters')
  }
  return new GovernanceError('GOVERNANCE_DENIED', notAvailableDetail(ref))
}

/**
 * Host plugin body: validate the root at load, register the publish-pairing
 * projection, and provide the per-session store router for the process
 * lifetime.
 * @param ctx - the host root context receiving the service.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: CatalogPluginConfig): void {
  if (config.maxStoreBytes !== undefined && (!Number.isInteger(config.maxStoreBytes) || config.maxStoreBytes < 1)) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `maxStoreBytes must be a positive integer, got ${config.maxStoreBytes}`)
  }
  const domain = config.authorizationDomain ?? DOMAIN_LOCAL
  if (domain.length === 0) {
    throw new CatalogError('CATALOG_INVALID_INPUT', 'authorizationDomain must be a non-empty string')
  }
  if (config.tenant !== undefined && !TENANT_ID_PATTERN.test(config.tenant)) {
    throw new CatalogError('CATALOG_INVALID_INPUT', `tenant must match ${TENANT_ID_PATTERN.source}, got "${config.tenant}"`)
  }
  // Schemastery defaults an absent array to `[]`; only a declared,
  // non-empty registry is meaningful (an empty declaration acknowledges no
  // cross-tenant requests and reads as undeclared).
  const declaredTenants = config.tenants !== undefined && config.tenants.length > 0 ? config.tenants : undefined
  if (declaredTenants !== undefined) {
    const seen = new Set<string>()
    for (const declared of declaredTenants) {
      if (!TENANT_ID_PATTERN.test(declared)) {
        throw new CatalogError('CATALOG_INVALID_INPUT', `tenants entries must match ${TENANT_ID_PATTERN.source}, got "${declared}"`)
      }
      if (seen.has(declared)) {
        throw new CatalogError('CATALOG_INVALID_INPUT', `tenants declares "${declared}" more than once`)
      }
      seen.add(declared)
    }
    if (config.tenant !== undefined && !declaredTenants.includes(config.tenant)) {
      throw new CatalogError('CATALOG_INVALID_INPUT', `tenant "${config.tenant}" must be declared in tenants when both are present`)
    }
  }
  const root = resolvePath(config.root)
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
  } catch (error: unknown) {
    throw new CatalogError('CATALOG_IO', `store root "${root}" could not be created: ${String(error instanceof Error ? error.message : error)}`)
  }
  if (existsSync(join(root, STORE_DB_NAME))) {
    // A pre-per-session deployment left one shared database at the root. It
    // is neither read nor deleted: the new layout serves every conversation
    // from its own library under sessions/, and moving the legacy bytes is
    // the operator's explicit decision (see docs/storage-lifecycle.md).
    console.warn?.(`spatial-catalog: found a legacy shared database at "${join(root, STORE_DB_NAME)}"; per-session stores under "${join(root, 'sessions')}" are used instead and the legacy file is left untouched`)
  }
  const tenant = config.tenant ?? TENANT_DEFAULT
  const options = config.maxStoreBytes === undefined ? { tenant } : { maxStoreBytes: config.maxStoreBytes, tenant }
  const bindings = new Map<string, SessionBinding>()

  /**
   * Open (creating and migrating when absent) one session's library, or
   * return the already-open binding. Handles stay open for the process
   * lifetime and close together at disposal.
   */
  const bindingOf = (sessionId: string): SessionBinding => {
    const existing = bindings.get(sessionId)
    if (existing !== undefined) return existing
    let sessionRoot: string
    try {
      sessionRoot = sessionStoreRoot(root, sessionId)
    } catch (error: unknown) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
      if (code === 'invalid-session-id') {
        throw new CatalogError('CATALOG_INVALID_INPUT', `session id cannot name a session store: ${error instanceof Error ? error.message : String(error)}`)
      }
      throw error
    }
    let store: CatalogStore
    try {
      store = openCatalogStore(sessionRoot, { tenant })
    } catch (error: unknown) {
      throw error instanceof CatalogError ? error : new CatalogError('CATALOG_IO', `store open failed: ${String(error)}`)
    }
    const binding: SessionBinding = { store, cache: new RetrievalCache() }
    bindings.set(sessionId, binding)
    return binding
  }

  /**
   * Bind one conversation to its library view. Every repository call below
   * targets this session's own database only.
   */
  const viewFor = (sessionId: string): SessionSpatialCatalog => {
    const { store, cache } = bindingOf(sessionId)

    /**
     * Refuse inputs that claim another session's identity: intent rows,
     * staging ownership, and operation refs must land in the caller's own
     * library, never contaminate a neighbor's store.
     */
    const assertOwnedSession = (inputSessionId: string): void => {
      if (inputSessionId !== sessionId) {
        throw new CatalogError('CATALOG_INVALID_INPUT', `this catalog view is bound to session "${sessionId}" and refuses to publish for session "${inputSessionId}"`)
      }
    }

    /**
     * Evaluate one governance request, audit it either way, and throw the
     * model-visible refusal on a governance denial (revoked, tombstoned,
     * recalled, or a subjectless request). A missing grant row is audited
     * but not thrown: the catalog read itself answers unknown refs with the
     * documented `CATALOG_NOT_FOUND` (identical for unknown and
     * unauthorized, so no existence disclosure), and the repository's own
     * fail-closed gate catches the corrupt existing-row-without-grant case.
     * An allowed decision is re-checked against the recall trail: a
     * recalled object denies on next use, before any read path runs.
     */
    const enforce = (
      operation: CatalogAuthorizeInput['operation'],
      objectKind: GovernanceObjectKind,
      ref: string,
      requestDomain: string,
      attribution: { sessionId?: string; resourceVersion?: number } = {},
    ): GovernanceDecisionResult => {
      const grant = readGrant(store.db, objectKind, ref, requestDomain, store.tenant)
      let result = decide(
        { subject: HOST_SUBJECT, operation, objectKind, ref, domain: requestDomain, tenant: store.tenant, ...attribution },
        grant,
      )
      if (result.decision === 'allowed' && recallAffects(store.db, store.tenant, objectKind, ref)) {
        result = { decision: 'denied', reasonCode: 'GOVERNANCE_RECALLED', grantVersion: result.grantVersion }
      }
      appendAudit(store.db, {
        subjectId: HOST_SUBJECT.subjectId,
        sessionId: attribution.sessionId ?? null,
        objectKind,
        ref,
        resourceVersion: attribution.resourceVersion ?? null,
        operation,
        decision: result.decision,
        reasonCode: result.reasonCode,
        domain: requestDomain,
        grantVersion: result.grantVersion,
        tenant: store.tenant,
      })
      if (result.decision === 'denied' && result.reasonCode !== 'GOVERNANCE_DENIED') {
        throw denialError(ref, result.reasonCode)
      }
      return result
    }

    const view: SessionSpatialCatalog = {
      async register(input) {
        assertOwnedSession(input.sessionId)
        const result = await registerResourceRepo(store.db, store.root, input, options)
        // Publish admits the new version under its own domain (the grant row
        // is written inside the publish transaction); the audit trail records
        // the admission fact for traceability.
        appendAudit(store.db, {
          subjectId: HOST_SUBJECT.subjectId,
          sessionId: input.sessionId,
          objectKind: 'resource',
          ref: result.resource.ref,
          resourceVersion: result.resource.version,
          operation: 'publish',
          decision: 'allowed',
          reasonCode: 'GOVERNANCE_ALLOWED',
          domain: result.resource.authorization,
          grantVersion: readGrant(store.db, 'resource', result.resource.ref, result.resource.authorization, store.tenant)?.grantVersion ?? null,
          tenant: store.tenant,
        })
        return result
      },
      async registerSemanticDefinition(input) {
        assertOwnedSession(input.sessionId)
        if (input.authorization !== domain) throw new CatalogError('CATALOG_INVALID_INPUT', 'semantic publication domain must match the deployment')
        return registerSemanticDefinitionRepo(store.db, { ...input, tenant: store.tenant })
      },
      async searchSemanticDefinitions(input) {
        const result = searchSemanticDefinitionsRepo(store.db, input)
        for (const candidate of result.candidates) enforce('context', 'semantic', candidate.definition.ref, input.authorization)
        return result
      },
      async resolve(input) {
        const version = resourceVersionOfRef(input.ref)
        const admission = enforce('resolve', 'resource', input.ref, input.authorization, version === undefined ? {} : { resourceVersion: version })
        const grantVersion = admission.grantVersion
        if (admission.decision === 'allowed' && grantVersion !== null) {
          const semanticRef = semanticBindingRefOf(store, input.ref)
          if (semanticRef !== undefined) enforce('resolve', 'semantic', semanticRef, input.authorization)
          // Bound resources revalidate the exact definition grant before a
          // cache hit; a changed binding therefore changes this key.
          const cached = cache.get(store.tenant, input.authorization, input.ref, grantVersion, semanticRef)
          if (cached !== undefined) return cached
          const resolved = resolveResourceRepo(store.db, { ...input, tenant: store.tenant })
          // Every fresh resolution is a governed copy entering the model's
          // context; its address registers so a later recall refuses the
          // next use (idempotent per session holder).
          registerCopyRepo(store.db, {
            tenant: store.tenant, objectKind: 'resource', ref: input.ref, channel: 'context', holder: sessionId,
          })
          cache.put(store.tenant, input.authorization, input.ref, grantVersion, resolved, semanticRef)
          return resolved
        }
        // An audited fall-through (no grant row): the repository answers.
        return resolveResourceRepo(store.db, { ...input, tenant: store.tenant })
      },
      async readResourceBytes(ref, authorization, maxBytes) {
        enforce('read', 'resource', ref, authorization)
        return readResourceBytesRepo(store.db, store.root, ref, authorization, maxBytes, store.tenant)
      },
      async readResourceChunks(ref, authorization, limits, onChunk) {
        enforce('read', 'resource', ref, authorization)
        return readResourceChunksRepo(store.db, store.root, ref, authorization, limits, onChunk, store.tenant)
      },
      async publishArtifact(input) {
        assertOwnedSession(input.sessionId)
        const result = await publishArtifactRepo(store.db, store.root, input, options)
        appendAudit(store.db, {
          subjectId: HOST_SUBJECT.subjectId,
          sessionId: input.sessionId,
          objectKind: 'artifact',
          ref: result.artifact.ref,
          resourceVersion: null,
          operation: 'publish',
          decision: 'allowed',
          reasonCode: 'GOVERNANCE_ALLOWED',
          domain: result.artifact.authorization,
          grantVersion: readGrant(store.db, 'artifact', result.artifact.ref, result.artifact.authorization, store.tenant)?.grantVersion ?? null,
          tenant: store.tenant,
        })
        return result
      },
      async readArtifactBytes(ref, authorization) {
        enforce('read', 'artifact', ref, authorization)
        return readArtifactBytesRepo(store.db, store.root, ref, authorization, store.tenant)
      },
      async confirmDurability(refs) {
        const confirmations = confirmDurabilityRepo(store.db, store.root, refs, store.tenant)
        for (const entry of confirmations) {
          if (entry.status === 'revoked' || entry.status === 'tombstoned' || entry.status === 'recalled') {
            appendAudit(store.db, {
              subjectId: HOST_SUBJECT.subjectId,
              sessionId: null,
              objectKind: entry.kind,
              ref: entry.ref,
              resourceVersion: null,
              operation: 'save',
              decision: 'denied',
              reasonCode: entry.status === 'revoked' ? 'GOVERNANCE_REVOKED' : entry.status === 'recalled' ? 'GOVERNANCE_RECALLED' : 'GOVERNANCE_TOMBSTONED',
              domain,
              grantVersion: null,
              tenant: store.tenant,
            })
          }
        }
        return confirmations
      },
      async lookupPublication(kind, sourceCallSeq) {
        return lookupPublication(store.db, kind, sessionId, sourceCallSeq)
      },
      pendingPublishCallOf(session, callId) {
        const state = ctx.sessionProjections.stateOf(session, 'spatialCatalog')
        if (state === undefined) {
          throw new Error('spatialCatalog projection is not registered in this process')
        }
        return state.pendingCalls.find(pending => pending.callId === callId)
      },
      async authorize(input) {
        const requestDomain = input.domain ?? domain
        if (input.tenant !== undefined) {
          if (!TENANT_ID_PATTERN.test(input.tenant)) {
            throw new GovernanceError('GOVERNANCE_INVALID_INPUT', `tenant must match ${TENANT_ID_PATTERN.source}, got "${input.tenant}"`)
          }
          if (declaredTenants !== undefined && !declaredTenants.includes(input.tenant)) {
            throw new GovernanceError('GOVERNANCE_INVALID_INPUT', `tenant "${input.tenant}" is not declared by this deployment`)
          }
        }
        const requestTenant = input.tenant ?? store.tenant
        const grant = readGrant(store.db, input.objectKind, input.ref, requestDomain, requestTenant)
        const result = decide(
          {
            subject: input.subject,
            operation: input.operation,
            objectKind: input.objectKind,
            ref: input.ref,
            domain: requestDomain,
            tenant: requestTenant,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            ...(input.resourceVersion === undefined ? {} : { resourceVersion: input.resourceVersion }),
          },
          grant,
        )
        appendAudit(store.db, {
          subjectId: input.subject.subjectId,
          sessionId: input.sessionId ?? null,
          objectKind: input.objectKind,
          ref: input.ref,
          resourceVersion: input.resourceVersion ?? null,
          operation: input.operation,
          decision: result.decision,
          reasonCode: result.reasonCode,
          domain: requestDomain,
          grantVersion: result.grantVersion,
          tenant: requestTenant,
        })
        return result
      },
      async setObjectState(input) {
        const requestDomain = input.domain ?? domain
        const grant = transitionGrant(store.db, input.objectKind, input.ref, requestDomain, input.state, store.tenant)
        appendAudit(store.db, {
          subjectId: input.subject.subjectId,
          sessionId: input.sessionId ?? null,
          objectKind: input.objectKind,
          ref: input.ref,
          resourceVersion: null,
          operation: input.state === 'granted' ? 'restore' : input.state === 'revoked' ? 'revoke' : 'tombstone',
          decision: 'allowed',
          reasonCode: 'GOVERNANCE_ALLOWED',
          domain: requestDomain,
          grantVersion: grant.grantVersion,
          tenant: store.tenant,
        })
        if (input.objectKind === 'resource' || input.objectKind === 'artifact') {
          cache.invalidate(store.tenant, requestDomain, input.ref)
        }
        return grant
      },
      async auditTrail(filter: CatalogAuditFilter = {}) {
        return listAudit(store.db, { ...filter, tenant: store.tenant })
      },
      async registerCopy(input: CatalogRegisterCopyInput) {
        const requestDomain = input.domain ?? domain
        const decision = enforce('copy', input.objectKind, input.ref, requestDomain, input.sessionId === undefined ? {} : { sessionId: input.sessionId })
        // Registration has no content-level fallback to fold a denial into,
        // so every denied decision refuses closed instead of registering the
        // address anyway.
        if (decision.decision === 'denied') throw denialError(input.ref, decision.reasonCode)
        return registerCopyRepo(store.db, {
          tenant: store.tenant,
          objectKind: input.objectKind,
          ref: input.ref,
          channel: input.channel,
          holder: input.holder,
        })
      },
      async copyTrail(filter: CatalogCopyFilter = {}) {
        return listCopies(store.db, store.tenant, filter)
      },
      async recallTrail(filter: CatalogRecallFilter = {}) {
        return listRecalls(store.db, store.tenant, filter)
      },
      deploymentDomain() {
        return domain
      },
      deploymentTenant() {
        return store.tenant
      },
      storeRoot() {
        return store.root
      },
      async refStateOf(ref, requestDomain) {
        const kind = objectKindOfRef(ref)
        const useDomain = requestDomain ?? domain
        if (kind === undefined) return 'unknown'
        const row = store.db.prepare(
          'SELECT state, domain FROM governance_acl WHERE object_kind = ? AND ref = ?',
        ).get(kind, ref) as { state: string; domain: string } | undefined
        if (row === undefined) return 'unknown'
        if (recallAffects(store.db, store.tenant, kind, ref)) {
          appendAudit(store.db, {
            subjectId: HOST_SUBJECT.subjectId,
            sessionId: null,
            objectKind: kind,
            ref,
            resourceVersion: null,
            operation: 'context',
            decision: 'denied',
            reasonCode: 'GOVERNANCE_RECALLED',
            domain: useDomain,
            grantVersion: null,
            tenant: store.tenant,
          })
          return 'recalled'
        }
        if (row.state === 'granted') return 'available'
        const state = row.state as AclState
        appendAudit(store.db, {
          subjectId: HOST_SUBJECT.subjectId,
          sessionId: null,
          objectKind: kind,
          ref,
          resourceVersion: null,
          operation: 'context',
          decision: 'denied',
          reasonCode: state === 'revoked' ? 'GOVERNANCE_REVOKED' : 'GOVERNANCE_TOMBSTONED',
          domain: useDomain,
          grantVersion: null,
          tenant: store.tenant,
        })
        return state === 'revoked' ? 'revoked' : 'tombstoned'
      },
    }
    return view
  }

  const service: SpatialCatalogService = {
    forSession(sessionId) {
      return viewFor(sessionId)
    },
    deploymentDomain() {
      return domain
    },
    deploymentTenant() {
      return tenant
    },
    async forkSession(parentSessionId, childSessionId, requestDomain) {
      const useDomain = requestDomain ?? domain
      let parentDbPath: string
      try {
        parentDbPath = join(sessionStoreRoot(root, parentSessionId), STORE_DB_NAME)
      } catch (error: unknown) {
        throw new CatalogError('CATALOG_INVALID_INPUT', `parent session id cannot name a session store: ${error instanceof Error ? error.message : String(error)}`)
      }
      // A parent that never used the catalog has no library and no session
      // grant; the fork is denied exactly like an unknown session object.
      if (!existsSync(parentDbPath)) {
        throw new GovernanceError('GOVERNANCE_DENIED', notAvailableDetail(`session ${parentSessionId}`))
      }
      const parent = bindingOf(parentSessionId)
      const child = bindingOf(childSessionId)
      // A recalled parent session object refuses the fork before any child
      // state is written; the fork itself is a governed copy.
      if (recallAffects(parent.store.db, parent.store.tenant, 'session', parentSessionId)) {
        throw new GovernanceError('GOVERNANCE_RECALLED', recalledDetail(`session ${parentSessionId}`))
      }
      const parentGrant = readGrant(parent.store.db, 'session', parentSessionId, useDomain, parent.store.tenant)
      if (parentGrant === undefined) {
        throw new GovernanceError('GOVERNANCE_DENIED', notAvailableDetail(`session ${parentSessionId}`))
      }
      const childGrant = transitionGrant(child.store.db, 'session', childSessionId, useDomain, parentGrant.state, child.store.tenant)
      child.store.db.prepare(
        'INSERT OR REPLACE INTO session_refs (session_id, parent_session_id) VALUES (?, ?)',
      ).run(childSessionId, parentSessionId)
      // The fork registers as a copy of the parent session object in the
      // parent's library, so a later recall of the parent refuses future
      // forks on next use.
      registerCopyRepo(parent.store.db, {
        tenant: parent.store.tenant, objectKind: 'session', ref: parentSessionId, channel: 'fork', holder: childSessionId,
      })
      appendAudit(child.store.db, {
        subjectId: HOST_SUBJECT.subjectId,
        sessionId: childSessionId,
        objectKind: 'session',
        ref: childSessionId,
        resourceVersion: null,
        operation: 'fork',
        decision: 'allowed',
        reasonCode: 'GOVERNANCE_ALLOWED',
        domain: useDomain,
        grantVersion: childGrant.grantVersion,
        tenant: child.store.tenant,
      })
      return childGrant
    },
    async recallCopies(input: CatalogRecallInput): Promise<CatalogRecallResult> {
      if (input.subject.subjectId.length === 0) {
        throw new GovernanceError('GOVERNANCE_SUBJECT_REQUIRED', 'the recall subject is required and comes from the host, never from model parameters')
      }
      if (input.origin.length === 0) {
        throw new GovernanceError('GOVERNANCE_INVALID_INPUT', 'origin must be a non-empty string naming the recall origin')
      }
      if (input.scope.kind === 'object' && objectKindOfRef(input.scope.ref) !== input.scope.objectKind
        && input.scope.objectKind !== 'session') {
        throw new GovernanceError('GOVERNANCE_INVALID_INPUT', `ref "${input.scope.ref}" does not address a ${input.scope.objectKind} object`)
      }
      const recallId = randomUUID()
      let recalledCopies = 0
      // The event lands in every session library so the next governed use
      // denies wherever it happens; copies are audited per store.
      for (const entry of listSessionStores(root)) {
        const { store, cache } = bindingOf(entry.sessionId)
        recordRecall(store.db, {
          recallId,
          tenant: store.tenant,
          scope: input.scope.kind,
          objectKind: input.scope.kind === 'object' ? input.scope.objectKind : null,
          ref: input.scope.kind === 'object' ? input.scope.ref : null,
          origin: input.origin,
          subjectId: input.subject.subjectId,
        })
        const inScope = listCopies(store.db, store.tenant, input.scope.kind === 'object'
          ? { objectKind: input.scope.objectKind, ref: input.scope.ref, limit: 1000 }
          : { limit: 1000 })
        for (const copy of inScope) {
          appendAudit(store.db, {
            subjectId: input.subject.subjectId,
            sessionId: copy.channel === 'context' || copy.channel === 'fork' ? copy.holder : null,
            objectKind: copy.objectKind,
            ref: copy.ref,
            resourceVersion: null,
            operation: 'recall',
            decision: 'denied',
            reasonCode: 'GOVERNANCE_RECALLED',
            domain,
            grantVersion: null,
            tenant: store.tenant,
          })
          cache.invalidateRef(copy.ref)
        }
        recalledCopies += inScope.length
      }
      return { recallId, scope: input.scope, recalledCopies }
    },
  }
  ctx.effect(() => ctx.sessionProjections.register(spatialCatalogProjectionDefinition), '@map-harness/spatial-catalog: projection')
  ctx.effect(() => {
    const unprovide = ctx.reflect.provide(SPATIAL_CATALOG_SERVICE, service)
    return () => {
      void unprovide()
      for (const binding of bindings.values()) binding.store.close()
      bindings.clear()
    }
  }, '@map-harness/spatial-catalog: service')
}

/** Re-export for consumers that need the record types with the service. */
export type { AclGrantRecord, AuditRecord }
