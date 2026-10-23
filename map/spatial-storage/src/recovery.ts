/**
 * Store verification and recovery diagnostics: the read-only sweep that says,
 * per catalog/artifact entry, whether the recorded bytes are actually there,
 * intact, and readable — `ok`, `missing-file`, `digest-mismatch`,
 * `permission-denied`, or `not-regular-file` — plus the store-level status
 * that distinguishes a current store from one written by a newer build.
 * The sweep never mutates: recovery decisions consume its report.
 *
 * @module @map-harness/spatial-storage/recovery
 */
import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { sha256File } from './checksum.ts'
import { StorageError } from './errors.ts'
import { openStoreDatabase, SPATIAL_STORE_SCHEMA_VERSION, storeDbPath, storeSchemaVersion } from './schema.ts'

/** Per-entry verification status. */
export type StoreEntryStatus =
  | 'ok'
  | 'missing-file'
  | 'digest-mismatch'
  | 'permission-denied'
  | 'not-regular-file'

/** Store-level status: current, newer than this build, or unreadable. */
export type StoreStatus = 'ok' | 'unavailable-future-version' | 'unreadable'

/** One verified store entry. */
export interface StoreEntryReport {
  readonly kind: 'resource' | 'artifact'
  readonly id: string
  readonly state: string
  /** Store-relative POSIX path of the recorded bytes. */
  readonly relativePath: string
  readonly status: StoreEntryStatus
}

/** The full verification report for one store root. */
export interface StoreVerification {
  readonly root: string
  readonly store: StoreStatus
  /** The recorded schema version, when the database could be opened. */
  readonly storeSchemaVersion: number | null
  readonly entries: readonly StoreEntryReport[]
  readonly summary: { readonly ok: number; readonly unavailable: number }
}

/** Verify one catalog/artifact row's file bytes without mutating anything. */
function verifyEntryFile(root: string, relativePath: string, expectedSha256: string): StoreEntryStatus {
  const absolute = join(root, relativePath)
  if (!existsSync(absolute)) return 'missing-file'
  // lstat, never stat: a link-shaped entry at a recorded path is itself the
  // damage report — reading through it would follow an unverified target.
  let stats
  try {
    stats = lstatSync(absolute)
  } catch (error) {
    if (isPermissionError(error)) return 'permission-denied'
    throw error
  }
  if (!stats.isFile()) return 'not-regular-file'
  try {
    return sha256File(absolute) === expectedSha256 ? 'ok' : 'digest-mismatch'
  } catch (error) {
    if (isPermissionError(error)) return 'permission-denied'
    throw error
  }
}

/** EACCES/EPERM mean a mode or ownership change, not a corrupt store. */
function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM'
}

/**
 * Verify one store root: open the database read-only (a future schema
 * version reports `unavailable-future-version` instead of refusing the whole
 * sweep's report), then check every catalog and artifact row's file.
 * @param root - the store root.
 * @param options - `supportedSchemaVersion` overrides the open ceiling for
 *   fixtures; the production default is the build's own schema version.
 * @returns the layered verification report.
 */
export function verifyStore(
  root: string,
  options: { supportedSchemaVersion?: number } = {},
): StoreVerification {
  const dbPath = storeDbPath(root)
  let db: DatabaseSync | undefined
  let storeStatus: StoreStatus = 'ok'
  let version: number | null = null
  try {
    db = openStoreDatabase(dbPath, {
      readOnly: true,
      supportedSchemaVersion: options.supportedSchemaVersion ?? SPATIAL_STORE_SCHEMA_VERSION,
    })
    version = storeSchemaVersion(db)
  } catch (error) {
    if (error instanceof StorageError && error.code === 'future-schema-version') {
      storeStatus = 'unavailable-future-version'
    } else if ((error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM') {
      storeStatus = 'unreadable'
    } else {
      throw error
    }
  }
  const entries: StoreEntryReport[] = []
  if (db !== undefined) {
    try {
      for (const row of db.prepare(
        'SELECT resource_id AS id, state, relative_path AS relativePath, sha256 FROM catalog_resources ORDER BY resource_id',
      ).all() as Array<{ id: string; state: string; relativePath: string; sha256: string }>) {
        entries.push({
          kind: 'resource',
          id: row.id,
          state: row.state,
          relativePath: row.relativePath,
          status: verifyEntryFile(root, row.relativePath, row.sha256),
        })
      }
      for (const row of db.prepare(
        'SELECT artifact_id AS id, state, relative_path AS relativePath, sha256 FROM artifacts ORDER BY artifact_id',
      ).all() as Array<{ id: string; state: string; relativePath: string; sha256: string }>) {
        entries.push({
          kind: 'artifact',
          id: row.id,
          state: row.state,
          relativePath: row.relativePath,
          status: verifyEntryFile(root, row.relativePath, row.sha256),
        })
      }
    } finally {
      db.close()
    }
  }
  const ok = entries.filter(entry => entry.status === 'ok').length
  return {
    root,
    store: storeStatus,
    storeSchemaVersion: version,
    entries,
    summary: { ok, unavailable: entries.length - ok },
  }
}
