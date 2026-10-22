/**
 * Scope leases: short-lived, owner-named mutual exclusion for store-wide
 * operations (cleanup) and long operations that must survive plan/execute
 * windows. One live lease per scope, enforced by a unique scope index and
 * acquired inside a write transaction; an expired lease is takeable — the
 * previous owner forfeited it by missing its renewal.
 *
 * @module @map-harness/spatial-storage/leases
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { StorageError } from './errors.ts'

/** One live or historical lease row as returned by the queries. */
export interface StoreLease {
  readonly leaseId: string
  readonly scope: string
  readonly owner: string
  readonly expiresAtMs: number
}

/**
 * Acquire the lease for one scope. Expired rows for the scope are reclaimed
 * in the same transaction; a live lease held by another owner refuses.
 * @param db - the open store handle.
 * @param request - the scope, the acquiring owner's name, and the time-to-live.
 * @returns the new lease id and its expiry.
 * @throws {StorageError} `lease-held` when a live lease for the scope exists.
 */
export function acquireLease(
  db: DatabaseSync,
  request: { scope: string; owner: string; ttlMs: number },
): { leaseId: string; expiresAtMs: number } {
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM leases WHERE scope = ? AND expires_at_ms <= ?').run(request.scope, now)
    const existing = db.prepare('SELECT lease_id AS leaseId, owner FROM leases WHERE scope = ?')
      .get(request.scope) as { leaseId: string; owner: string } | undefined
    if (existing !== undefined) {
      throw new StorageError(
        'lease-held',
        `scope "${request.scope}" is held by "${existing.owner}" (lease ${existing.leaseId})`,
      )
    }
    const leaseId = randomUUID()
    const expiresAtMs = now + request.ttlMs
    db.prepare('INSERT INTO leases (lease_id, scope, owner, expires_at_ms, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(leaseId, request.scope, request.owner, expiresAtMs, new Date(now).toISOString())
    db.exec('COMMIT')
    return { leaseId, expiresAtMs }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/**
 * Extend one lease's expiry.
 * @param db - the open store handle.
 * @param leaseId - the id {@link acquireLease} returned.
 * @param ttlMs - the new time-to-live from now.
 * @returns the new expiry.
 * @throws {StorageError} `no-lease` when the lease was released or expired
 *   and reclaimed.
 */
export function renewLease(db: DatabaseSync, leaseId: string, ttlMs: number): number {
  const result = db.prepare('UPDATE leases SET expires_at_ms = ? WHERE lease_id = ?')
    .run(Date.now() + ttlMs, leaseId)
  if (Number(result.changes) !== 1) {
    throw new StorageError('no-lease', `lease ${leaseId} is gone; re-acquire the scope`)
  }
  const row = db.prepare('SELECT expires_at_ms AS expiresAtMs FROM leases WHERE lease_id = ?')
    .get(leaseId) as { expiresAtMs: number }
  return Number(row.expiresAtMs)
}

/**
 * Release one lease, whether or not it has expired.
 * @param db - the open store handle.
 * @param leaseId - the id to release.
 */
export function releaseLease(db: DatabaseSync, leaseId: string): void {
  db.prepare('DELETE FROM leases WHERE lease_id = ?').run(leaseId)
}

/**
 * Check one lease's liveness without modifying it.
 * @param db - the open store handle.
 * @param leaseId - the lease to check.
 * @returns true when the lease row exists and has not expired.
 */
export function isLeaseLive(db: DatabaseSync, leaseId: string): boolean {
  const row = db.prepare('SELECT expires_at_ms AS expiresAtMs FROM leases WHERE lease_id = ?')
    .get(leaseId) as { expiresAtMs: number } | undefined
  return row !== undefined && Number(row.expiresAtMs) > Date.now()
}
