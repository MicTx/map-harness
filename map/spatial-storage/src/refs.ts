/**
 * The store's reference graph: which sessions, map layers, reports, exports,
 * jobs, and backup pins protect a resource/artifact/stream/intent version.
 * All edges live in store tables and are read here read-only; references use
 * stable ids and store-relative paths, never machine-local absolute paths,
 * so a backup restored at a new location keeps every edge resolvable.
 *
 * @module @map-harness/spatial-storage/refs
 */
import type { DatabaseSync } from 'node:sqlite'

/** The target kinds reference edges can point at. */
export type RefTargetKind = 'resource' | 'artifact' | 'stream' | 'intent'

/** One protectable store target. */
export interface RefTarget {
  readonly kind: RefTargetKind
  readonly id: string
}

/** The protector kinds the graph distinguishes. */
export type RefProtectorKind = 'session' | 'map-layer' | 'report' | 'export' | 'job' | 'backup-pin' | 'reader-pin'

/** One protector edge found for a target. */
export interface RefProtector {
  readonly kind: RefProtectorKind
  /** Owning session id, when the protector belongs to one. */
  readonly sessionId: string | undefined
  /** The layer/report/export/job id or pin reason naming the edge. */
  readonly detail: string
}

/**
 * List every protector edge for one target, across the session-scoped edge
 * tables and backup pins. A target protected only by a fork child's edges is
 * protected: the edges live in the store, not in either session's log.
 * @param db - the open store handle.
 * @param target - the target to resolve.
 * @returns the protector edges, in table order.
 */
export function protectorsOf(db: DatabaseSync, target: RefTarget): readonly RefProtector[] {
  const found: RefProtector[] = []
  for (const row of db.prepare(
    'SELECT session_id AS sessionId, layer_id AS layerId FROM map_refs WHERE target_kind = ? AND target_id = ?',
  ).all(target.kind, target.id) as Array<{ sessionId: string; layerId: string }>) {
    found.push({ kind: 'map-layer', sessionId: row.sessionId, detail: row.layerId })
  }
  for (const row of db.prepare(
    'SELECT session_id AS sessionId, report_id AS reportId FROM report_refs WHERE target_kind = ? AND target_id = ?',
  ).all(target.kind, target.id) as Array<{ sessionId: string; reportId: string }>) {
    found.push({ kind: 'report', sessionId: row.sessionId, detail: row.reportId })
  }
  for (const row of db.prepare(
    'SELECT session_id AS sessionId, export_id AS exportId FROM export_refs WHERE target_kind = ? AND target_id = ?',
  ).all(target.kind, target.id) as Array<{ sessionId: string; exportId: string }>) {
    found.push({ kind: 'export', sessionId: row.sessionId, detail: row.exportId })
  }
  for (const row of db.prepare(
    'SELECT session_id AS sessionId, job_id AS jobId, state FROM job_refs WHERE target_kind = ? AND target_id = ?',
  ).all(target.kind, target.id) as Array<{ sessionId: string; jobId: string; state: string }>) {
    found.push({ kind: 'job', sessionId: row.sessionId, detail: `${row.jobId}(${row.state})` })
  }
  for (const row of db.prepare(
    'SELECT reason FROM backup_pins WHERE target_kind = ? AND target_id = ?',
  ).all(target.kind, target.id) as Array<{ reason: string }>) {
    found.push({ kind: 'backup-pin', sessionId: undefined, detail: row.reason })
  }
  for (const row of db.prepare(
    'SELECT owner FROM reader_pins WHERE target_kind = ? AND target_id = ?',
  ).all(target.kind, target.id) as Array<{ owner: string }>) {
    found.push({ kind: 'reader-pin', sessionId: undefined, detail: row.owner })
  }
  return found
}

/**
 * Check whether any protector edge resolves for one target.
 * @param db - the open store handle.
 * @param target - the target to check.
 * @returns true when at least one edge protects the target.
 */
export function isTargetProtected(db: DatabaseSync, target: RefTarget): boolean {
  return protectorsOf(db, target).length > 0
}

/**
 * List a session's fork ancestry row (its parent session id, when forked).
 * @param db - the open store handle.
 * @param sessionId - the session to resolve.
 * @returns the parent session id, or undefined for a root session.
 */
export function parentSessionOf(db: DatabaseSync, sessionId: string): string | undefined {
  const row = db.prepare('SELECT parent_session_id AS parent FROM session_refs WHERE session_id = ?')
    .get(sessionId) as { parent: string | null } | undefined
  return row?.parent ?? undefined
}
