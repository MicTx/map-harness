/**
 * The catalog's governance vocabulary: authorization subjects, sensitivity
 * domains, per-object ACL grants with monotonic grant versions, the pure
 * decision core every governed entry evaluates, minimum-privilege derivation
 * for derived objects, and the append-only audit record. The contract is
 * map-owned: subjects come from the Host (never from model parameters or MCP
 * annotations), revocation blocks future access only, and existing copies in
 * session logs, reports, exports, and client devices are never remotely
 * recalled — the copy-limit note is part of the contract itself.
 *
 * @module @map-harness/spatial-catalog/governance
 */
import { GovernanceError } from './governance-errors.ts'

/** Version of the governance contract this module pins. */
export const GOVERNANCE_CONTRACT_VERSION = 'spatial-governance@1'

/**
 * The successor contract this module also implements: `spatial-governance@2`
 * adds the tenant dimension (subjects, grants, audit, and caches scope by
 * tenant; cross-tenant rows read as missing without disclosing existence)
 * and the copy recall plane (registered copies deny on next use after a
 * recall event; unregistered copies stay out of reach and erasure is never
 * promised). The `@1` surface and its single-tenant behavior are preserved
 * verbatim — deployments that declare no tenant keep today's semantics.
 */
export const GOVERNANCE_CONTRACT_VERSION_V2 = 'spatial-governance@2'

/** The kinds of catalog-linked objects an ACL grant can protect. */
export type GovernanceObjectKind =
  | 'resource'
  | 'semantic'
  | 'artifact'
  | 'session'
  | 'export'

/**
 * The governed entry operations. Read-family operations cover the catalog
 * read paths; `context` covers model-context candidate gating; `display`
 * covers map display copies; `save` covers cross-storage export receipts;
 * the session operations cover the session-linked catalog seam; the
 * governance operations cover ACL state transitions themselves.
 */
export type GovernanceOperation =
  | 'resolve'
  | 'read'
  | 'execute'
  | 'context'
  | 'display'
  | 'save'
  | 'open'
  | 'list'
  | 'resume'
  | 'fork'
  | 'publish'
  | 'revoke'
  | 'tombstone'
  | 'restore'
  | 'copy'
  | 'recall'

/** ACL state of one protected object under one domain. */
export type AclState = 'granted' | 'revoked' | 'tombstoned'

/** One authorization decision. */
export type GovernanceDecision = 'allowed' | 'denied'

/**
 * Who is asking. Subjects are Host/provider identities constructed in
 * host-owned code; a request whose subject is missing or model-supplied is
 * denied, never defaulted. The optional tenant names the subject's tenant
 * (`@2`); it comes from the same host-owned sources as the subject itself.
 */
export interface GovernanceSubject {
  readonly subjectId: string
  readonly kind: 'host' | 'provider'
  /** The subject's tenant id; `@1` shapes without it read as the default tenant. */
  readonly tenant?: string
}

/** The Host subject every in-process enforcement defaults to. */
export const HOST_SUBJECT: GovernanceSubject = { subjectId: 'host', kind: 'host' }

/** One authorization request the decision core evaluates. */
export interface GovernanceRequest {
  readonly subject: GovernanceSubject
  readonly operation: GovernanceOperation
  readonly objectKind: GovernanceObjectKind
  /** Exact ref of the protected object (public ref form, or a session id). */
  readonly ref: string
  /** Authorization domain the request reads under. */
  readonly domain: string
  /** Session the operation belongs to, when the caller has one. */
  readonly sessionId?: string
  /** Resource version number, when the object is a versioned resource. */
  readonly resourceVersion?: number
  /**
   * The request's tenant id (`@2`); absent reads as the single-tenant
   * default, so `@1` call shapes keep their exact behavior.
   */
  readonly tenant?: string
}

/** One ACL grant row: object × domain state with a monotonic grant version. */
export interface AclGrantRecord {
  /** The tenant the grant belongs to (`@2`); absent reads as the default tenant. */
  readonly tenant?: string
  readonly objectKind: GovernanceObjectKind
  readonly ref: string
  readonly domain: string
  readonly state: AclState
  /** Monotonic per-grant version; every state transition bumps it by one. */
  readonly grantVersion: number
  readonly updatedAt: string
}

/** One append-only audit fact: who did what to which object, and the result. */
export interface AuditRecord {
  readonly auditId: string
  readonly at: string
  /** The tenant the fact belongs to (`@2`); absent reads as the default tenant. */
  readonly tenant?: string
  readonly subjectId: string
  readonly sessionId: string | null
  readonly objectKind: GovernanceObjectKind
  readonly ref: string
  readonly resourceVersion: number | null
  readonly operation: GovernanceOperation
  readonly decision: GovernanceDecision
  readonly reasonCode: string
  readonly domain: string
  readonly grantVersion: number | null
}

/** The outcome the decision core produces for one request. */
export interface GovernanceDecisionResult {
  readonly decision: GovernanceDecision
  /** Stable reason code; allowed decisions carry `GOVERNANCE_ALLOWED`. */
  readonly reasonCode: string
  /** Grant version the decision was admitted under, when a grant exists. */
  readonly grantVersion: number | null
}

/**
 * Decide one request against one grant row (pure; no I/O). A missing grant
 * denies with the non-disclosure reason — the caller renders the same
 * "not available" message as an unknown ref, so denials never disclose
 * existence. A grant under another tenant reads as missing for the same
 * reason (`@2`): tenant isolation is a provable decision, never an
 * accident of storage. Revoked and tombstoned are distinct denial reasons.
 * @param request - the authorization request.
 * @param grant - the object's ACL row under the request domain, when present.
 * @returns the decision with its reason code and grant version.
 */
export function decide(request: GovernanceRequest, grant: AclGrantRecord | undefined): GovernanceDecisionResult {
  if (request.subject.subjectId.length === 0) {
    return { decision: 'denied', reasonCode: 'GOVERNANCE_SUBJECT_REQUIRED', grantVersion: null }
  }
  const requestTenant = request.tenant ?? TENANT_DEFAULT
  if (grant !== undefined && (grant.tenant ?? TENANT_DEFAULT) !== requestTenant) {
    return { decision: 'denied', reasonCode: 'GOVERNANCE_DENIED', grantVersion: null }
  }
  if (grant === undefined) {
    return { decision: 'denied', reasonCode: 'GOVERNANCE_DENIED', grantVersion: null }
  }
  if (grant.state === 'granted') {
    return { decision: 'allowed', reasonCode: 'GOVERNANCE_ALLOWED', grantVersion: grant.grantVersion }
  }
  return {
    decision: 'denied',
    reasonCode: grant.state === 'revoked' ? 'GOVERNANCE_REVOKED' : 'GOVERNANCE_TOMBSTONED',
    grantVersion: grant.grantVersion,
  }
}

/**
 * The ordered P0 sensitivity lattice: `local` (non-sensitive samples) ranks
 * below `sensitive`. The lattice is a protocol constant, not configuration.
 */
export const AUTHORIZATION_LATTICE = {
  local: 0,
  sensitive: 1,
} as const

/** The single-domain default the P0 deployment reads and publishes under. */
export const DOMAIN_LOCAL = 'local'

/** The sensitive domain rank above `local`. */
export const DOMAIN_SENSITIVE = 'sensitive'

/**
 * Derive the minimum-privilege authorization of a derived object from the
 * objects it was computed from. A single input domain derives as itself (a
 * deployment may run under one custom domain label no ordering needs to
 * rank); mixed inputs require every domain to rank on the sensitivity
 * lattice and derive the strictest one. Derivation never widens — a
 * `sensitive` input always yields `sensitive` — and a mixed list containing
 * an unranked domain fails loud instead of guessing strictness.
 * @param inputDomains - the authorization domains of every consumed input.
 * @returns the derived domain.
 * @throws {GovernanceError} `GOVERNANCE_DOMAIN_UNKNOWN` for an empty input
 *   list or a mixed list containing a domain outside the lattice.
 */
export function deriveAuthorization(inputDomains: readonly string[]): string {
  if (inputDomains.length === 0) {
    throw new GovernanceError('GOVERNANCE_DOMAIN_UNKNOWN', 'derivation requires at least one input authorization')
  }
  if (inputDomains.length === 1) return inputDomains[0]!
  let strictest = -1
  let strictestDomain: string | undefined
  for (const domain of inputDomains) {
    if (!(domain in AUTHORIZATION_LATTICE)) {
      throw new GovernanceError('GOVERNANCE_DOMAIN_UNKNOWN', `mixed-input derivation requires ranked domains, but "${domain}" is outside the declared sensitivity lattice`)
    }
    const rank = AUTHORIZATION_LATTICE[domain as keyof typeof AUTHORIZATION_LATTICE]
    if (rank > strictest) {
      strictest = rank
      strictestDomain = domain
    }
  }
  return strictestDomain!
}

/** The copy-limit note every revocation/tombstone surface carries verbatim. */
export const COPY_LIMIT_NOTE =
  'this blocks future access only; existing copies in session logs, reports, exports, and client devices are not remotely recalled or erased'

/**
 * The single-tenant id every `@1`-shaped call, grant row, and undeclared
 * deployment reads under (`@2`). Equal to the storage migration ladder's
 * backfill default, so pre-`@2` stores and un-tenanted code agree on it.
 */
export const TENANT_DEFAULT = 'default'

/**
 * The tenant id syntax (`@2`): lowercase alphanumeric plus hyphen, 1–64
 * characters, starting alphanumeric. A protocol constant, not configuration.
 */
export const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * The model-visible refusal detail for a revoked object: future access is
 * denied and the copy limit is stated, never an erasure promise.
 */
export function revokedDetail(ref: string): string {
  return `${ref} is revoked and unavailable for future access; ${COPY_LIMIT_NOTE}`
}

/**
 * The model-visible refusal detail for a tombstoned object: the record
 * survives as an explicit unavailable marker, and the copy limit holds.
 */
export function tombstonedDetail(ref: string): string {
  return `${ref} is tombstoned (explicitly unavailable); ${COPY_LIMIT_NOTE}`
}

/** The non-disclosure refusal detail for an unknown or out-of-domain object. */
export function notAvailableDetail(ref: string): string {
  return `${ref} is not available to this reader`
}

/**
 * Validate one tenant id against the protocol syntax, failing loud on the
 * first violation (`@2`).
 * @param tenant - the candidate tenant id.
 * @param label - what the id names, for the failure message.
 * @throws {GovernanceError} `GOVERNANCE_INVALID_INPUT` when the id is empty,
 *   malformed, or longer than the syntax allows.
 */
export function assertValidTenantId(tenant: string, label: string): void {
  if (!TENANT_ID_PATTERN.test(tenant)) {
    throw new GovernanceError('GOVERNANCE_INVALID_INPUT', `${label} must match ${TENANT_ID_PATTERN.source}, got "${tenant}"`)
  }
}

/** The channels a governed copy can leave the store through (`@2`). */
export const GOVERNANCE_COPY_CHANNELS = ['context', 'display', 'export', 'fork'] as const

/** One channel a governed copy leaves the store through (`@2`). */
export type GovernanceCopyChannel = (typeof GOVERNANCE_COPY_CHANNELS)[number]

/**
 * The bound on distinct registered copies per object (`@2`): a protocol
 * constant, not configuration. Registration is idempotent per holder, and
 * the first distinct holder beyond the bound fails loud instead of silently
 * dropping a recall address.
 */
export const MAX_OBJECT_COPIES = 1024

/**
 * The recall boundary every recall surface carries verbatim (`@2`):
 * registered copies are refused on next use; unregistered copies remain
 * beyond reach; erasure is never promised.
 */
export const RECALL_NOTE =
  'recall refuses future use of registered copies on their next use; copies that were never registered remain out of reach and no existing copy is erased'

/**
 * The model-visible refusal detail for a recalled object (`@2`): future use
 * is refused and the recall boundary is stated, never an erasure promise.
 */
export function recalledDetail(ref: string): string {
  return `${ref} has had its copies recalled and is refused for future use; ${RECALL_NOTE}`
}
