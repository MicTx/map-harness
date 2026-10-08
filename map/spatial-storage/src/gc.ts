/**
 * Published-version lifecycle: reader pins (pin before use), explicit release
 * markers (finalize then reclaim), and the one-call collection entry. A
 * published version becomes a cleanup candidate only when a release marker
 * exists AND no protector edge — including reader pins — resolves for it;
 * the cleaner re-checks both at execution time. Collection reuses the
 * `cleanup` lease and the atomic trash protocol; reclaimed versions read
 * back as their existing missing-row unavailable semantics, never as empty
 * data. Design §6.4: no TTL, no cross-store enumeration, session close
 * releases nothing.
 *
 * @module @map-harness/spatial-storage/gc
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StorageError } from './errors.ts'
import { acquireLease, releaseLease } from './leases.ts'
import type { CleanupResultEntry } from './cleanup.ts'
import { executeCleanup, planCleanup } from './cleanup.ts'
import type { RefTarget } from './refs.ts'

/** The target kinds a release marker can name: the byte-carrying versions. */
export const GC_TARGET_KINDS = ['resource', 'artifact'] as const
export type GcTargetKind = (typeof GC_TARGET_KINDS)[number]

/** One acquired reader pin's identity. */
export interface ReaderPin {
  readonly pinId: string
  readonly kind: string
  readonly id: string
  readonly owner: string
}

/** The table and id column that store one target kind's rows. */
const TARGET_TABLES: Record<GcTargetKind, { table: string; idColumn: string }> = {
  resource: { table: 'catalog_resources', idColumn: 'resource_id' },
  artifact: { table: 'artifacts', idColumn: 'artifact_id' },
}

function assertGcTarget(db: DatabaseSync, target: RefTarget): void {
  const table = TARGET_TABLES[target.kind as GcTargetKind]
  if (table === undefined) {
    throw new StorageError(
      'unsupported-gc-target',
      `kind "${target.kind}" carries no file bytes; only ${GC_TARGET_KINDS.join('/')} versions are reclaimable`,
    )
  }
  const row = db.prepare(`SELECT 1 FROM ${table.table} WHERE ${table.idColumn} = ?`).get(target.id)
  if (row === undefined) {
    throw new StorageError('unknown-target', `${target.kind} "${target.id}" has no row in this store`)
  }
}

/**
 * Pin one target as a live reader. Idempotent per (kind, id, owner): a
 * re-acquire returns the existing pin. The pin protects the target against
 * collection until {@link releaseReaderPin};
 * @param db - the open store handle.
 * @param target - the target being read.
 * @param owner - stable reader identity (session, job, or export id).
 * @returns the acquired pin.
 * @throws {StorageError} `unknown-target` when no such row exists.
 */
export function acquireReaderPin(db: DatabaseSync, target: RefTarget, owner: string): ReaderPin {
  assertGcTarget(db, target)
  const existing = db.prepare(
    'SELECT pin_id AS pinId FROM reader_pins WHERE target_kind = ? AND target_id = ? AND owner = ?',
  ).get(target.kind, target.id, owner) as { pinId: string } | undefined
  if (existing !== undefined) {
    return { pinId: existing.pinId, kind: target.kind, id: target.id, owner }
  }
  const pinId = randomUUID()
  db.prepare(
    'INSERT INTO reader_pins (pin_id, target_kind, target_id, owner, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(pinId, target.kind, target.id, owner, new Date().toISOString())
  return { pinId, kind: target.kind, id: target.id, owner }
}

/**
 * Release one reader pin. Releasing an unknown pin refuses loudly — pin
 * bookkeeping is the collection protocol's safety edge, never best-effort.
 * @param db - the open store handle.
 * @param target - the pinned target.
 * @param owner - the reader identity the pin was acquired under.
 * @throws {StorageError} `unknown-reader-pin` when no such pin exists.
 */
export function releaseReaderPin(db: DatabaseSync, target: RefTarget, owner: string): void {
  const result = db.prepare(
    'DELETE FROM reader_pins WHERE target_kind = ? AND target_id = ? AND owner = ?',
  ).run(target.kind, target.id, owner)
  if (Number(result.changes) === 0) {
    throw new StorageError('unknown-reader-pin', `no reader pin for ${target.kind} "${target.id}" owned by "${owner}"`)
  }
}

/**
 * Mark one published version finalized (terminated): the owner asserts no
 * future reader will need it. Idempotent. The version keeps resolving until
 * a collection pass actually reclaims it — release is a lifecycle fact, not
 * an immediate deletion.
 * @param db - the open store handle.
 * @param target - the published version to finalize.
 * @throws {StorageError} `unsupported-gc-target` for non-byte targets;
 *   `unknown-target` when no such row exists.
 */
export function releaseVersion(db: DatabaseSync, target: RefTarget): void {
  assertGcTarget(db, target)
  db.prepare(
    'INSERT OR REPLACE INTO released_versions (target_kind, target_id, released_at) VALUES (?, ?, ?)',
  ).run(target.kind, target.id, new Date().toISOString())
}

/**
 * Whether one target carries a release marker.
 * @param db - the open store handle.
 * @param target - the target to check.
 */
export function isReleased(db: DatabaseSync, target: RefTarget): boolean {
  const row = db.prepare(
    'SELECT 1 FROM released_versions WHERE target_kind = ? AND target_id = ?',
  ).get(target.kind, target.id)
  return row !== undefined
}

/** One completed collection pass's summary. */
export interface CollectionRun {
  readonly planId: string
  readonly results: readonly CleanupResultEntry[]
}

/**
 * Run one collection pass under a fresh `cleanup` lease: plan, execute with
 * per-candidate re-checks, release the lease. This is the runbook's
 * acquire → plan → execute → release sequence as one entry; concurrent
 * collectors surface the existing `lease-held` refusal.
 * @param root - the store root.
 * @param db - the open store handle.
 * @param owner - collector identity for the lease.
 * @param ttlMs - lease time-to-live in milliseconds.
 * @returns the plan id and per-candidate outcomes.
 * @throws {StorageError} `lease-held` when another collector holds the lease.
 */
export function collectGarbage(root: string, db: DatabaseSync, owner: string, ttlMs: number): CollectionRun {
  const lease = acquireLease(db, { scope: 'cleanup', owner, ttlMs })
  try {
    const plan = planCleanup(root, db)
    const results = executeCleanup(root, db, plan, { leaseId: lease.leaseId })
    return { planId: plan.planId, results }
  } finally {
    releaseLease(db, lease.leaseId)
  }
}
