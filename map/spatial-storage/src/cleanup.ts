/**
 * Staging lifecycle and safe cleanup. Writers register a staging row before
 * creating bytes under `staging/`, and release the row when done; promotion
 * into `files/` plus its catalog row is the publisher's transaction. Cleanup
 * is two-phase: a read-only dry-run plan (every candidate with a keep/delete
 * decision and its reason), then an execution that re-checks each candidate —
 * pins added or writes reactivated between plan and execute make that entry
 * skip — while holding the `cleanup` lease. Published versions are never
 * cleanup candidates: P0 does not auto-collect released resources even when
 * no reference resolves (disk budget refusals are the publisher's job).
 *
 * @module @map-harness/spatial-storage/cleanup
 */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { StorageError } from './errors.ts'
import { isLeaseLive } from './leases.ts'
import { isTargetProtected } from './refs.ts'

/** The lease scope exclusive to cleanup executions. */
export const CLEANUP_LEASE_SCOPE = 'cleanup'

/** One staging row as the registry and plans see it. */
export interface StagingRow {
  readonly stagingId: string
  /** Store-relative POSIX path of the staged bytes. */
  readonly relativePath: string
  readonly state: 'active' | 'released'
  readonly ownerSessionId: string | undefined
}

/** One planned candidate and its decision. */
export type CleanupPlanEntry =
  | {
    readonly kind: 'staging-row'
    /** Store-relative POSIX path of the staged bytes. */
    readonly target: string
    readonly stagingId: string
    readonly decision: 'delete' | 'keep'
    /** Why the plan decided this way; the executor reports late changes too. */
    readonly reason: string
  }
  | {
    readonly kind: 'orphan-file'
    /** Store-relative POSIX path of the orphaned bytes. */
    readonly target: string
    readonly stagingId: undefined
    readonly decision: 'delete' | 'keep'
    readonly reason: string
  }
  | {
    readonly kind: 'published-version'
    /** Store-relative POSIX path of the published bytes. */
    readonly target: string
    readonly targetKind: 'resource' | 'artifact'
    readonly targetId: string
    readonly decision: 'delete' | 'keep'
    readonly reason: string
  }

/** The dry-run plan: complete candidate list, no mutation performed. */
export interface CleanupPlan {
  readonly planId: string
  readonly storeSchemaVersion: number
  readonly createdAt: string
  readonly entries: readonly CleanupPlanEntry[]
}

/** The execution outcome for one candidate. */
export interface CleanupResultEntry {
  readonly kind: CleanupPlanEntry['kind']
  readonly target: string
  readonly action: 'deleted' | 'kept'
  readonly reason: string
}

/**
 * Register a staging entry before creating its bytes. The row is the
 * ownership claim: cleanup only collects staging paths whose row says
 * `released`.
 * @param db - the open store handle.
 * @param entry - the store-relative POSIX path (under `staging/`) and the
 *   owning session, when the staging belongs to one.
 * @returns the staging row id.
 */
export function registerStaging(db: DatabaseSync, entry: { relativePath: string; ownerSessionId?: string }): string {
  const stagingId = randomUUID()
  db.prepare('INSERT INTO staging (staging_id, relative_path, state, owner_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(stagingId, entry.relativePath, 'active', entry.ownerSessionId ?? null, new Date().toISOString(), new Date().toISOString())
  return stagingId
}

/**
 * Mark a staging entry released: the writer finished and the bytes are
 * either promoted or discardable.
 * @param db - the open store handle.
 * @param stagingId - the row to release.
 */
export function releaseStaging(db: DatabaseSync, stagingId: string): void {
  db.prepare('UPDATE staging SET state = ?, updated_at = ? WHERE staging_id = ?')
    .run('released', new Date().toISOString(), stagingId)
}

/**
 * List every staging row (read-only).
 * @param db - the open store handle.
 * @returns the rows in creation order.
 */
export function listStaging(db: DatabaseSync): readonly StagingRow[] {
  const rows = db.prepare(
    'SELECT staging_id AS stagingId, relative_path AS relativePath, state, owner_session_id AS ownerSessionId FROM staging ORDER BY created_at, staging_id',
  ).all() as Array<{ stagingId: string; relativePath: string; state: string; ownerSessionId: string | null }>
  return rows.map(row => ({
    stagingId: row.stagingId,
    relativePath: row.relativePath,
    state: row.state === 'active' ? 'active' : 'released',
    ownerSessionId: row.ownerSessionId ?? undefined,
  }))
}

/** Whether a backup pin currently holds one staging row. */
function stagingPinned(db: DatabaseSync, stagingId: string): boolean {
  return db.prepare('SELECT 1 FROM backup_pins WHERE target_kind = ? AND target_id = ?')
    .get('staging', stagingId) !== undefined
}

/** Whether a store-relative path is claimed by a published catalog/artifact row. */
function pathIsPublished(db: DatabaseSync, relativePath: string): boolean {
  for (const table of ['catalog_resources', 'artifacts']) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE relative_path = ?`).get(relativePath) !== undefined) return true
  }
  return false
}

/** Whether a store-relative path is claimed by any staging row. */
function pathIsStaged(db: DatabaseSync, relativePath: string): boolean {
  return db.prepare('SELECT 1 FROM staging WHERE relative_path = ?').get(relativePath) !== undefined
}

/**
 * List on-disk entries under one store directory as store-relative POSIX
 * paths. Link-shaped entries are listed but never descended into: the walk
 * `lstat`s every entry, so a symlinked directory cannot widen the scan.
 */
function listDirEntries(root: string, dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(join(root, dir))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const found: string[] = []
  for (const name of names.sort()) {
    const relativePath = `${dir}/${name}`
    const stats = lstatSync(join(root, relativePath))
    if (stats.isSymbolicLink()) {
      found.push(relativePath)
      continue
    }
    if (stats.isDirectory()) {
      found.push(...listDirEntries(root, relativePath))
      continue
    }
    found.push(relativePath)
  }
  return found
}

/**
 * Build the read-only cleanup plan for one store: every staging row and every
 * on-disk orphan under `staging/` or `files/`, with its keep/delete decision.
 * Published paths (catalog/artifact rows) are never candidates.
 * @param root - the store root.
 * @param db - the open store handle.
 * @returns the plan; executing it later re-checks every decision.
 */
export function planCleanup(root: string, db: DatabaseSync): CleanupPlan {
  const entries: CleanupPlanEntry[] = []
  for (const row of listStaging(db)) {
    if (row.state === 'active') {
      entries.push({ kind: 'staging-row', target: row.relativePath, stagingId: row.stagingId, decision: 'keep', reason: 'active-write' })
      continue
    }
    if (stagingPinned(db, row.stagingId)) {
      entries.push({ kind: 'staging-row', target: row.relativePath, stagingId: row.stagingId, decision: 'keep', reason: 'pinned' })
      continue
    }
    entries.push({ kind: 'staging-row', target: row.relativePath, stagingId: row.stagingId, decision: 'delete', reason: 'released-unprotected' })
  }
  for (const dir of ['staging', 'files']) {
    for (const relativePath of listDirEntries(root, dir)) {
      if (pathIsStaged(db, relativePath) || pathIsPublished(db, relativePath)) continue
      entries.push({ kind: 'orphan-file', target: relativePath, stagingId: undefined, decision: 'delete', reason: 'orphan' })
    }
  }
  entries.push(...releasedVersionCandidates(db))
  return {
    planId: randomUUID(),
    storeSchemaVersion: Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
    createdAt: new Date().toISOString(),
    entries,
  }
}

/**
 * Plan the released published versions: a candidate only when a release
 * marker exists and no protector edge — map/report/export/job refs, backup
 * pins, and reader pins — resolves for it. Unreleased versions are never
 * candidates, however unreferenced they are.
 */
function releasedVersionCandidates(db: DatabaseSync): Extract<CleanupPlanEntry, { kind: 'published-version' }>[] {
  const entries: Extract<CleanupPlanEntry, { kind: 'published-version' }>[] = []
  const markers = db.prepare(
    'SELECT target_kind AS targetKind, target_id AS targetId FROM released_versions ORDER BY target_kind, target_id',
  ).all() as Array<{ targetKind: 'resource' | 'artifact'; targetId: string }>
  for (const marker of markers) {
    const table = marker.targetKind === 'resource' ? 'catalog_resources' : 'artifacts'
    const idColumn = marker.targetKind === 'resource' ? 'resource_id' : 'artifact_id'
    const row = db.prepare(`SELECT relative_path AS relativePath FROM ${table} WHERE ${idColumn} = ?`)
      .get(marker.targetId) as { relativePath: string } | undefined
    if (row === undefined) continue
    const target = { kind: marker.targetKind, id: marker.targetId }
    if (isTargetProtected(db, target)) {
      entries.push({ kind: 'published-version', target: row.relativePath, targetKind: marker.targetKind, targetId: marker.targetId, decision: 'keep', reason: 'pinned' })
      continue
    }
    entries.push({ kind: 'published-version', target: row.relativePath, targetKind: marker.targetKind, targetId: marker.targetId, decision: 'delete', reason: 'released-unprotected' })
  }
  return entries
}

/**
 * Execute a cleanup plan: requires the caller to hold the live `cleanup`
 * lease, then re-checks every delete candidate at execution time — a pin or
 * reactivated write that appeared after the plan makes that entry keep.
 * Deletions move the bytes into `trash/` first (atomic rename), so a crash
 * mid-sweep never leaves a half-deleted entry at its source path.
 * @param root - the store root.
 * @param db - the open store handle.
 * @param plan - the plan from {@link planCleanup}.
 * @param lease - the `cleanup` lease id the caller holds.
 * @returns the per-candidate outcomes in plan order.
 * @throws {StorageError} `no-lease` when the lease id is unknown, expired,
 *   or out of scope; plan entries whose re-check changed report `kept` with
 *   the new reason instead of failing the run.
 */
export function executeCleanup(
  root: string,
  db: DatabaseSync,
  plan: CleanupPlan,
  lease: { leaseId: string },
): readonly CleanupResultEntry[] {
  if (!isLeaseLive(db, lease.leaseId)) {
    throw new StorageError('no-lease', `cleanup requires a live "${CLEANUP_LEASE_SCOPE}" lease; ${lease.leaseId} is unknown or expired`)
  }
  const leaseRow = db.prepare('SELECT scope FROM leases WHERE lease_id = ?').get(lease.leaseId) as { scope: string }
  if (leaseRow.scope !== CLEANUP_LEASE_SCOPE) {
    throw new StorageError('no-lease', `lease ${lease.leaseId} scopes "${leaseRow.scope}", not "${CLEANUP_LEASE_SCOPE}"`)
  }
  const results: CleanupResultEntry[] = []
  for (const entry of plan.entries) {
    if (entry.decision === 'keep') {
      results.push({ kind: entry.kind, target: entry.target, action: 'kept', reason: entry.reason })
      continue
    }
    if (entry.kind === 'staging-row') {
      results.push(executeStagingRemoval(root, db, entry))
      continue
    }
    if (entry.kind === 'published-version') {
      results.push(executePublishedRemoval(root, db, entry))
      continue
    }
    results.push(executeOrphanRemoval(root, db, entry))
  }
  return results
}

/** Re-check and remove one released published version. */
function executePublishedRemoval(root: string, db: DatabaseSync, entry: Extract<CleanupPlanEntry, { kind: 'published-version' }>): CleanupResultEntry {
  const marker = db.prepare(
    'SELECT 1 FROM released_versions WHERE target_kind = ? AND target_id = ?',
  ).get(entry.targetKind, entry.targetId)
  if (marker === undefined) {
    return { kind: entry.kind, target: entry.target, action: 'kept', reason: 'unreleased-since-plan' }
  }
  if (isTargetProtected(db, { kind: entry.targetKind, id: entry.targetId })) {
    return { kind: entry.kind, target: entry.target, action: 'kept', reason: 'pinned' }
  }
  const present = trashThroughRenameIfPresent(root, entry.target, `${entry.targetKind}-${entry.targetId}`)
  const table = entry.targetKind === 'resource' ? 'catalog_resources' : 'artifacts'
  const idColumn = entry.targetKind === 'resource' ? 'resource_id' : 'artifact_id'
  db.prepare(`DELETE FROM ${table} WHERE ${idColumn} = ?`).run(entry.targetId)
  db.prepare('DELETE FROM released_versions WHERE target_kind = ? AND target_id = ?').run(entry.targetKind, entry.targetId)
  return { kind: entry.kind, target: entry.target, action: 'deleted', reason: present ? 'released-unprotected' : 'already-gone' }
}

/** Re-check and remove one planned staging row. */
function executeStagingRemoval(root: string, db: DatabaseSync, entry: Extract<CleanupPlanEntry, { kind: 'staging-row' }>): CleanupResultEntry {
  const row = db.prepare('SELECT state FROM staging WHERE staging_id = ?').get(entry.stagingId) as { state: string } | undefined
  if (row === undefined) {
    return { kind: entry.kind, target: entry.target, action: 'kept', reason: 'already-gone' }
  }
  if (row.state === 'active') {
    return { kind: entry.kind, target: entry.target, action: 'kept', reason: 'active-write' }
  }
  if (stagingPinned(db, entry.stagingId)) {
    return { kind: entry.kind, target: entry.target, action: 'kept', reason: 'pinned' }
  }
  const present = trashThroughRenameIfPresent(root, entry.target, entry.stagingId)
  db.prepare('DELETE FROM staging WHERE staging_id = ?').run(entry.stagingId)
  return { kind: entry.kind, target: entry.target, action: 'deleted', reason: present ? 'released-unprotected' : 'already-gone' }
}

/** Re-check and remove one planned orphan file. */
function executeOrphanRemoval(root: string, db: DatabaseSync, entry: Extract<CleanupPlanEntry, { kind: 'orphan-file' }>): CleanupResultEntry {
  if (pathIsStaged(db, entry.target) || pathIsPublished(db, entry.target)) {
    return { kind: entry.kind, target: entry.target, action: 'kept', reason: 'claimed-since-plan' }
  }
  const present = trashThroughRenameIfPresent(root, entry.target, 'orphan')
  if (!present) {
    return { kind: entry.kind, target: entry.target, action: 'kept', reason: 'already-gone' }
  }
  return { kind: entry.kind, target: entry.target, action: 'deleted', reason: 'orphan' }
}

/**
 * Move one store-relative path into `trash/` and delete it there, when it
 * still exists. The rename is atomic, so the source path cannot end up
 * half-deleted; the trash-side removal failing leaves the bytes visible in
 * `trash/` for the operator and propagates.
 * @returns true when the path existed and was removed.
 */
function trashThroughRenameIfPresent(root: string, relativePath: string, token: string): boolean {
  const absolute = join(root, relativePath)
  try {
    lstatSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  const flat = relativePath.split('/').join('-').replace(/[^A-Za-z0-9._-]/g, '_').slice(-80)
  const trashPath = join(root, 'trash', `${token}-${flat}`)
  // A restored root may not carry the trash directory yet; the executor owns it.
  mkdirSync(join(root, 'trash'), { recursive: true, mode: 0o700 })
  renameSync(absolute, trashPath)
  removePath(trashPath)
  return true
}

/** Delete one path, unlinking link-shaped entries instead of following them. */
function removePath(target: string): void {
  const stats = lstatSync(target)
  if (stats.isSymbolicLink()) {
    unlinkSync(target)
    return
  }
  if (stats.isDirectory()) {
    rmSync(target, { recursive: true })
    return
  }
  rmSync(target)
}
