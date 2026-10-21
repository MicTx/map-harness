import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { CatalogError } from './errors.ts'
import { GovernanceError } from './governance-errors.ts'
import {
  MAX_OBJECT_COPIES,
  TENANT_DEFAULT,
  notAvailableDetail,
  recalledDetail,
  revokedDetail,
  tombstonedDetail,
} from './governance.ts'
import type {
  AclGrantRecord,
  AclState,
  AuditRecord,
  GovernanceCopyChannel,
  GovernanceObjectKind,
} from './governance.ts'

/** One ACL row as read back from `governance_acl`. */
interface AclRow {
  readonly tenant: string
  readonly object_kind: string
  readonly ref: string
  readonly domain: string
  readonly state: string
  readonly grant_version: number | bigint
  readonly updated_at: string
}

function rowToGrant(row: AclRow): AclGrantRecord {
  return {
    tenant: row.tenant,
    objectKind: row.object_kind as GovernanceObjectKind,
    ref: row.ref,
    domain: row.domain,
    state: row.state as AclState,
    grantVersion: Number(row.grant_version),
    updatedAt: row.updated_at,
  }
}

/**
 * Read one object's ACL grant under one domain and tenant.
 * @param db - the open catalog store.
 * @param objectKind - the protected object kind.
 * @param ref - the object's exact public ref (or session id).
 * @param domain - the authorization domain.
 * @param tenant - the grant's tenant; defaults to the single-tenant default.
 * @returns the grant, or `undefined` when the object has no row under that
 *   tenant (a grant under another tenant reads as missing, without
 *   disclosing that it exists).
 */
export function readGrant(
  db: DatabaseSync,
  objectKind: GovernanceObjectKind,
  ref: string,
  domain: string,
  tenant: string = TENANT_DEFAULT,
): AclGrantRecord | undefined {
  const row = db.prepare(
    'SELECT tenant, object_kind, ref, domain, state, grant_version, updated_at FROM governance_acl '
    + 'WHERE tenant = ? AND object_kind = ? AND ref = ? AND domain = ?',
  ).get(tenant, objectKind, ref, domain) as AclRow | undefined
  return row === undefined ? undefined : rowToGrant(row)
}

/**
 * Write the initial `granted` grant for a freshly published object, inside
 * the caller's publish transaction. `INSERT OR IGNORE` keeps republication
 * idempotent and never resets an administrator-set state.
 * @param db - the open catalog store (inside an open transaction).
 * @param objectKind - the protected object kind.
 * @param ref - the object's exact public ref.
 * @param domain - the domain the object is published under.
 * @param tenant - the tenant the grant belongs to; defaults to the
 *   single-tenant default.
 */
export function grantOnPublish(
  db: DatabaseSync,
  objectKind: GovernanceObjectKind,
  ref: string,
  domain: string,
  tenant: string = TENANT_DEFAULT,
): void {
  db.prepare(
    'INSERT OR IGNORE INTO governance_acl (tenant, object_kind, ref, domain, state, grant_version, updated_at) '
    + 'VALUES (?, ?, ?, ?, \'granted\', 1, ?)',
  ).run(tenant, objectKind, ref, domain, new Date().toISOString())
}

/**
 * Refuse when one object's ACL grant is revoked, tombstoned, or missing —
 * the repository's own fail-closed gate (the service layer audits the same
 * decision before reaching here; this check keeps direct repository reads
 * honest too).
 * @param db - the open catalog store.
 * @param kind - the protected object kind.
 * @param ref - the object's exact public ref.
 * @param domain - the reader's authorization domain.
 * @param tenant - the grant's tenant; defaults to the single-tenant default.
 * @throws {GovernanceError} `GOVERNANCE_REVOKED`/`GOVERNANCE_TOMBSTONED`
 *   with the copy-limit note, or `GOVERNANCE_DENIED` without disclosing
 *   existence when no grant row exists under the tenant.
 */
export function assertGranted(
  db: DatabaseSync,
  kind: GovernanceObjectKind,
  ref: string,
  domain: string,
  tenant: string = TENANT_DEFAULT,
): void {
  const grant = readGrant(db, kind, ref, domain, tenant)
  if (grant === undefined) {
    throw new GovernanceError('GOVERNANCE_DENIED', notAvailableDetail(ref))
  }
  if (grant.state === 'revoked') throw new GovernanceError('GOVERNANCE_REVOKED', revokedDetail(ref))
  if (grant.state === 'tombstoned') throw new GovernanceError('GOVERNANCE_TOMBSTONED', tombstonedDetail(ref))
}

/**
 * Apply one ACL state transition: insert a fresh grant at version 1, or bump
 * the existing grant's version when its state actually changes. The
 * transition itself is the caller's authorization duty — this repository
 * records it, it does not decide it.
 * @param db - the open catalog store.
 * @param objectKind - the protected object kind.
 * @param ref - the object's exact public ref.
 * @param domain - the authorization domain.
 * @param state - the target state.
 * @param tenant - the grant's tenant; defaults to the single-tenant default.
 * @returns the grant record after the transition.
 */
export function transitionGrant(
  db: DatabaseSync,
  objectKind: GovernanceObjectKind,
  ref: string,
  domain: string,
  state: AclState,
  tenant: string = TENANT_DEFAULT,
): AclGrantRecord {
  const now = new Date().toISOString()
  return withGovernanceTransaction(db, () => {
    const existing = readGrant(db, objectKind, ref, domain, tenant)
    if (existing === undefined) {
      db.prepare(
        'INSERT INTO governance_acl (tenant, object_kind, ref, domain, state, grant_version, updated_at) '
        + 'VALUES (?, ?, ?, ?, ?, 1, ?)',
      ).run(tenant, objectKind, ref, domain, state, now)
    } else if (existing.state !== state) {
      db.prepare(
        'UPDATE governance_acl SET state = ?, grant_version = grant_version + 1, updated_at = ? '
        + 'WHERE tenant = ? AND object_kind = ? AND ref = ? AND domain = ?',
      ).run(state, now, tenant, objectKind, ref, domain)
    }
    const grant = readGrant(db, objectKind, ref, domain, tenant)
    if (grant === undefined) {
      throw new CatalogError('CATALOG_IO', `governance grant for ${ref} disappeared during its own transition`)
    }
    return grant
  })
}

/** One audit trail filter: every field is optional and conjunctive. */
export interface AuditFilter {
  readonly objectKind?: GovernanceObjectKind
  readonly ref?: string
  readonly sessionId?: string
  /** Restrict the read to one tenant; absent reads every tenant's rows. */
  readonly tenant?: string
  /** Maximum records returned; the newest are kept. Defaults to 100. */
  readonly limit?: number
}

/** The bound on one audit-trail read. */
export const MAX_AUDIT_TRAIL = 1000

/**
 * Append one audit fact. Append-only: no update or delete path exists.
 * @param db - the open catalog store.
 * @param record - the fact to record (minus identity and timestamp); a
 *   missing tenant is stored under the single-tenant default.
 * @returns the stored record with its identity and timestamp.
 */
export function appendAudit(
  db: DatabaseSync,
  record: Omit<AuditRecord, 'auditId' | 'at'>,
): AuditRecord {
  const tenant = record.tenant ?? TENANT_DEFAULT
  const stored: AuditRecord = {
    ...record,
    tenant,
    auditId: randomUUID(),
    at: new Date().toISOString(),
  }
  db.prepare(
    'INSERT INTO governance_audit '
    + '(tenant, audit_id, at, subject_id, session_id, object_kind, ref, resource_version, operation, decision, reason_code, domain, grant_version) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    tenant,
    stored.auditId,
    stored.at,
    stored.subjectId,
    stored.sessionId,
    stored.objectKind,
    stored.ref,
    stored.resourceVersion,
    stored.operation,
    stored.decision,
    stored.reasonCode,
    stored.domain,
    stored.grantVersion,
  )
  return stored
}

/**
 * Read the audit trail, newest first, bounded.
 * @param db - the open catalog store.
 * @param filter - optional conjunctive filter.
 * @returns the matching records, newest first.
 */
export function listAudit(db: DatabaseSync, filter: AuditFilter = {}): readonly AuditRecord[] {
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (filter.tenant !== undefined) {
    clauses.push('tenant = ?')
    params.push(filter.tenant)
  }
  if (filter.objectKind !== undefined) {
    clauses.push('object_kind = ?')
    params.push(filter.objectKind)
  }
  if (filter.ref !== undefined) {
    clauses.push('ref = ?')
    params.push(filter.ref)
  }
  if (filter.sessionId !== undefined) {
    clauses.push('session_id = ?')
    params.push(filter.sessionId)
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
  const limit = Math.min(filter.limit ?? 100, MAX_AUDIT_TRAIL)
  const rows = db.prepare(
    'SELECT tenant, audit_id, at, subject_id, session_id, object_kind, ref, resource_version, '
    + 'operation, decision, reason_code, domain, grant_version '
    + `FROM governance_audit ${where} ORDER BY audit_seq DESC LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>
  return rows.map(row => ({
    tenant: String(row.tenant),
    auditId: String(row.audit_id),
    at: String(row.at),
    subjectId: String(row.subject_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    objectKind: row.object_kind as GovernanceObjectKind,
    ref: String(row.ref),
    resourceVersion: row.resource_version === null ? null : Number(row.resource_version),
    operation: row.operation as AuditRecord['operation'],
    decision: row.decision as AuditRecord['decision'],
    reasonCode: String(row.reason_code),
    domain: String(row.domain),
    grantVersion: row.grant_version === null ? null : Number(row.grant_version),
  }))
}

/** One registered copy row as the catalog projects it. */
export interface CopyRecord {
  readonly copySeq: number
  readonly tenant: string
  readonly objectKind: GovernanceObjectKind
  readonly ref: string
  readonly channel: GovernanceCopyChannel
  readonly holder: string
  readonly registeredAt: string
}

/** One copy-trail filter: every field is optional and conjunctive. */
export interface CopyFilter {
  readonly objectKind?: GovernanceObjectKind
  readonly ref?: string
  readonly channel?: GovernanceCopyChannel
  readonly holder?: string
  /** Maximum records returned; the oldest are kept. Defaults to 100. */
  readonly limit?: number
}

/** The bound on one copy-trail read. */
export const MAX_COPY_TRAIL = 1000

/** The fields `registerCopy` needs; identity and timestamp are derived. */
export interface RegisterCopyInput {
  readonly tenant: string
  readonly objectKind: GovernanceObjectKind
  readonly ref: string
  readonly channel: GovernanceCopyChannel
  readonly holder: string
}

/**
 * Register one copy's address, idempotent per holder: registering the same
 * (tenant, object, channel, holder) again returns the existing row. A
 * recalled object refuses new registrations outright, and the first distinct
 * holder beyond the per-object bound fails loud rather than dropping a
 * recall address silently.
 * @param db - the open catalog store.
 * @param input - the copy's address (tenant, object, channel, holder).
 * @returns the stored copy record (existing when the registration repeats).
 * @throws {GovernanceError} `GOVERNANCE_RECALLED` when a recall already
 *   covers the object, or `GOVERNANCE_INVALID_INPUT` at the copy bound.
 */
export function registerCopy(db: DatabaseSync, input: RegisterCopyInput): CopyRecord {
  if (recallAffects(db, input.tenant, input.objectKind, input.ref)) {
    throw new GovernanceError('GOVERNANCE_RECALLED', recalledDetail(input.ref))
  }
  const existing = readCopy(db, input)
  if (existing !== undefined) return existing
  const count = db.prepare(
    'SELECT COUNT(*) AS n FROM governance_copies WHERE tenant = ? AND object_kind = ? AND ref = ?',
  ).get(input.tenant, input.objectKind, input.ref) as { readonly n: number | bigint }
  if (Number(count.n) >= MAX_OBJECT_COPIES) {
    throw new GovernanceError(
      'GOVERNANCE_INVALID_INPUT',
      `${input.ref} already has ${MAX_OBJECT_COPIES} distinct registered copies; refusing to drop one silently`,
    )
  }
  const registeredAt = new Date().toISOString()
  db.prepare(
    'INSERT OR IGNORE INTO governance_copies (tenant, object_kind, ref, channel, holder, registered_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?)',
  ).run(input.tenant, input.objectKind, input.ref, input.channel, input.holder, registeredAt)
  const stored = readCopy(db, input)
  if (stored === undefined) {
    throw new CatalogError('CATALOG_IO', `copy registration for ${input.ref} (${input.holder}) did not persist`)
  }
  return stored
}

function readCopy(db: DatabaseSync, input: RegisterCopyInput): CopyRecord | undefined {
  const row = db.prepare(
    'SELECT copy_seq, tenant, object_kind, ref, channel, holder, registered_at FROM governance_copies '
    + 'WHERE tenant = ? AND object_kind = ? AND ref = ? AND channel = ? AND holder = ?',
  ).get(input.tenant, input.objectKind, input.ref, input.channel, input.holder) as Record<string, unknown> | undefined
  return row === undefined ? undefined : copyRowToRecord(row)
}

/** Project one raw `governance_copies` row into {@link CopyRecord}. */
function copyRowToRecord(row: Record<string, unknown>): CopyRecord {
  return {
    copySeq: Number(row.copy_seq),
    tenant: String(row.tenant),
    objectKind: row.object_kind as GovernanceObjectKind,
    ref: String(row.ref),
    channel: row.channel as GovernanceCopyChannel,
    holder: String(row.holder),
    registeredAt: String(row.registered_at),
  }
}

/**
 * List registered copies under one tenant, oldest first, bounded.
 * @param db - the open catalog store.
 * @param tenant - the tenant whose copies are read.
 * @param filter - optional conjunctive filter.
 * @returns the matching copy records, oldest first.
 */
export function listCopies(db: DatabaseSync, tenant: string, filter: CopyFilter = {}): readonly CopyRecord[] {
  const clauses = ['tenant = ?']
  const params: Array<string | number> = [tenant]
  if (filter.objectKind !== undefined) {
    clauses.push('object_kind = ?')
    params.push(filter.objectKind)
  }
  if (filter.ref !== undefined) {
    clauses.push('ref = ?')
    params.push(filter.ref)
  }
  if (filter.channel !== undefined) {
    clauses.push('channel = ?')
    params.push(filter.channel)
  }
  if (filter.holder !== undefined) {
    clauses.push('holder = ?')
    params.push(filter.holder)
  }
  const limit = Math.min(filter.limit ?? 100, MAX_COPY_TRAIL)
  const rows = db.prepare(
    'SELECT copy_seq, tenant, object_kind, ref, channel, holder, registered_at FROM governance_copies '
    + `WHERE ${clauses.join(' AND ')} ORDER BY copy_seq LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>
  return rows.map(copyRowToRecord)
}

/** One recall event row as the catalog projects it. */
export interface RecallRecord {
  readonly recallId: string
  readonly tenant: string
  readonly scope: 'object' | 'tenant'
  readonly objectKind: GovernanceObjectKind | null
  readonly ref: string | null
  readonly origin: string
  readonly subjectId: string
  readonly recalledAt: string
}

/** The fields `recordRecall` needs; identity and timestamp are derived. */
export interface RecordRecallInput {
  /** The recall id; generated when absent (the cross-library sweep shares one). */
  readonly recallId?: string
  readonly tenant: string
  readonly scope: 'object' | 'tenant'
  readonly objectKind: GovernanceObjectKind | null
  readonly ref: string | null
  readonly origin: string
  readonly subjectId: string
}

/**
 * Append one recall event. Append-only: a recall is never un-recorded —
 * restoring an object goes through ACL state, and the recall trail keeps
 * every decision that ever refused a copy.
 * @param db - the open catalog store.
 * @param input - the recall event (object scope carries kind and ref; tenant
 *   scope carries nulls).
 * @returns the stored recall record.
 * @throws {CatalogError} `CATALOG_IO` when an object scope lacks kind/ref or
 *   a tenant scope carries them.
 */
export function recordRecall(db: DatabaseSync, input: RecordRecallInput): RecallRecord {
  if (input.scope === 'object' && (input.objectKind === null || input.ref === null)) {
    throw new CatalogError('CATALOG_IO', 'an object-scope recall must name its object kind and ref')
  }
  if (input.scope === 'tenant' && (input.objectKind !== null || input.ref !== null)) {
    throw new CatalogError('CATALOG_IO', 'a tenant-scope recall must not narrow to an object')
  }
  const stored: RecallRecord = {
    ...input,
    recallId: input.recallId ?? randomUUID(),
    recalledAt: new Date().toISOString(),
  }
  db.prepare(
    'INSERT INTO governance_recall (recall_id, tenant, scope, object_kind, ref, origin, subject_id, recalled_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    stored.recallId,
    stored.tenant,
    stored.scope,
    stored.objectKind,
    stored.ref,
    stored.origin,
    stored.subjectId,
    stored.recalledAt,
  )
  return stored
}

/**
 * Whether a recall event covers one object under one tenant: a tenant-scope
 * recall covers every object in the tenant; an object-scope recall covers
 * its exact object.
 * @param db - the open catalog store.
 * @param tenant - the object's tenant.
 * @param objectKind - the protected object kind.
 * @param ref - the object's exact public ref.
 * @returns `true` when at least one recall event covers the object.
 */
export function recallAffects(db: DatabaseSync, tenant: string, objectKind: GovernanceObjectKind, ref: string): boolean {
  const row = db.prepare(
    'SELECT 1 AS hit FROM governance_recall WHERE tenant = ? AND (scope = \'tenant\' '
    + 'OR (scope = \'object\' AND object_kind = ? AND ref = ?)) LIMIT 1',
  ).get(tenant, objectKind, ref)
  return row !== undefined
}

/** One recall-trail filter: every field is optional and conjunctive. */
export interface RecallFilter {
  readonly scope?: 'object' | 'tenant'
  readonly objectKind?: GovernanceObjectKind
  readonly ref?: string
  /** Maximum records returned; the newest are kept. Defaults to 100. */
  readonly limit?: number
}

/** The bound on one recall-trail read. */
export const MAX_RECALL_TRAIL = 1000

/**
 * List recall events under one tenant, newest first, bounded.
 * @param db - the open catalog store.
 * @param tenant - the tenant whose recall events are read.
 * @param filter - optional conjunctive filter.
 * @returns the matching recall records, newest first.
 */
export function listRecalls(db: DatabaseSync, tenant: string, filter: RecallFilter = {}): readonly RecallRecord[] {
  const clauses = ['tenant = ?']
  const params: Array<string | number> = [tenant]
  if (filter.scope !== undefined) {
    clauses.push('scope = ?')
    params.push(filter.scope)
  }
  if (filter.objectKind !== undefined) {
    clauses.push('object_kind = ?')
    params.push(filter.objectKind)
  }
  if (filter.ref !== undefined) {
    clauses.push('ref = ?')
    params.push(filter.ref)
  }
  const limit = Math.min(filter.limit ?? 100, MAX_RECALL_TRAIL)
  const rows = db.prepare(
    'SELECT recall_id, tenant, scope, object_kind, ref, origin, subject_id, recalled_at FROM governance_recall '
    + `WHERE ${clauses.join(' AND ')} ORDER BY recalled_at DESC, rowid DESC LIMIT ?`,
  ).all(...params, limit) as Array<Record<string, unknown>>
  return rows.map(row => ({
    recallId: String(row.recall_id),
    tenant: String(row.tenant),
    scope: row.scope as 'object' | 'tenant',
    objectKind: row.object_kind === null ? null : row.object_kind as GovernanceObjectKind,
    ref: row.ref === null ? null : String(row.ref),
    origin: String(row.origin),
    subjectId: String(row.subject_id),
    recalledAt: String(row.recalled_at),
  }))
}

/**
 * Run one function inside a single `BEGIN IMMEDIATE` transaction so a grant
 * read-modify-write cannot interleave; any throw rolls the unit back.
 * @typeParam T - the function's return type.
 * @param db - the open catalog store.
 * @param body - the transactional unit.
 * @returns the body's result.
 */
function withGovernanceTransaction<T>(db: DatabaseSync, body: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = body()
    db.exec('COMMIT')
    return result
  } catch (error: unknown) {
    try {
      db.exec('ROLLBACK')
    } catch (rollbackError: unknown) {
      // The original failure is the caller's answer; a failed rollback on an
      // already-broken connection surfaces on the next store operation.
      console.warn?.(`spatial-catalog: governance rollback failed: ${String(rollbackError)}`)
    }
    throw error
  }
}
