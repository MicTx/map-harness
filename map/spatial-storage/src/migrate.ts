/**
 * The store migration runner: forward-only, dry-runnable, and crash-safe.
 * Each step applies inside one `BEGIN IMMEDIATE` transaction that also writes
 * the `migration_journal` row and bumps `PRAGMA user_version`, so a step is
 * committed whole or not at all — a process killed mid-step rolls back on the
 * next open and a re-run continues from the recorded version. Before the
 * first write on an existing store the runner records a `VACUUM INTO`
 * snapshot plus its sha256 (backup-before-write); the report carries the
 * whole-file digests on both sides of the run.
 *
 * @module @map-harness/spatial-storage/migrate
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { sha256File } from './checksum.ts'
import { StorageError } from './errors.ts'
import {
  createStoreRoot,
  MIGRATION_DEFAULT_TENANT,
  openStoreDatabase,
  SPATIAL_STORE_SCHEMA_VERSION,
  STORE_MIGRATION_STEPS,
  storeDbPath,
  storeSchemaVersion,
  type StoreMigrationContext,
  type StoreMigrationStep,
} from './schema.ts'

/** The journal table records every committed step; the runner owns its DDL. */
const JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS migration_journal (
  to_version INTEGER PRIMARY KEY,
  from_version INTEGER NOT NULL,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
`

/** One pending step as planned or applied. */
export interface MigrationStepInfo {
  readonly from: number
  readonly to: number
  readonly name: string
}

/** The read-only outcome of planning a migration. */
export interface MigrationPlan {
  /** The store's recorded schema version. */
  readonly current: number
  /** The version the plan targets. */
  readonly target: number
  /** The steps between them, in application order. */
  readonly pending: readonly MigrationStepInfo[]
}

/** The pre-migration snapshot taken by backup-before-write. */
export interface MigrationBackup {
  /** Absolute path of the consistent snapshot file. */
  readonly path: string
  /**
   * sha256 of the snapshot file itself (integrity evidence). `VACUUM INTO`
   * may compact the copy, so the snapshot is logically identical to the
   * pre-run store — same schema version, same rows — not byte-identical.
   */
  readonly sha256: string
  readonly bytes: number
}

/** What one migration run did, with its surrounding evidence. */
export interface MigrationReport {
  /** The steps this run applied in order; empty when already at target. */
  readonly applied: readonly MigrationStepInfo[]
  /** True when the store was already at the target version (no write). */
  readonly alreadyCurrent: boolean
  /** sha256 of the database file before the run; null on a no-op run. */
  readonly beforeChecksum: string | null
  /** sha256 of the database file after the run; null on a no-op run. */
  readonly afterChecksum: string | null
  /** The backup-before-write snapshot, when one was taken. */
  readonly backup: MigrationBackup | null
}

/**
 * Validate one migration list as a contiguous forward chain from version 0.
 * @param steps - the candidate list.
 * @returns the list's maximum version (its target).
 * @throws {StorageError} `invalid-migration-list` when the chain is broken.
 */
function validateStepList(steps: readonly StoreMigrationStep[]): number {
  let expected = 0
  for (const step of steps) {
    if (step.from !== expected) {
      throw new StorageError(
        'invalid-migration-list',
        `migration step "${step.name}" starts at version ${step.from} but the chain expects ${expected}`,
      )
    }
    if (step.to !== step.from + 1) {
      throw new StorageError(
        'invalid-migration-list',
        `migration step "${step.name}" must raise the version by exactly one (${step.from} -> ${step.to})`,
      )
    }
    expected = step.to
  }
  return expected
}

/** Read-only planning over one open connection. */
function planOn(db: DatabaseSync, steps: readonly StoreMigrationStep[], targetVersion: number): MigrationPlan {
  const current = storeSchemaVersion(db)
  const pending = steps
    .filter(step => step.to > current && step.to <= targetVersion)
    .map(step => ({ from: step.from, to: step.to, name: step.name }))
  return { current, target: targetVersion, pending }
}

/**
 * Plan a migration without writing: opens a read-only connection, reads the
 * recorded version, and lists the steps that would run.
 * @param dbPath - the store database file.
 * @param options - `steps` defaults to the production list;
 *   `supportedSchemaVersion` must cover the list's maximum (fixtures pass
 *   their list's maximum).
 * @returns the plan.
 * @throws {StorageError} `future-schema-version` when the store is newer
 *   than `supportedSchemaVersion`, or `invalid-migration-list` for a broken chain.
 */
export function dryRunStoreMigration(
  dbPath: string,
  options: { steps?: readonly StoreMigrationStep[]; supportedSchemaVersion?: number } = {},
): MigrationPlan {
  const steps = options.steps ?? STORE_MIGRATION_STEPS
  const target = validateStepList(steps)
  const db = openStoreDatabase(dbPath, {
    readOnly: true,
    supportedSchemaVersion: options.supportedSchemaVersion ?? Math.max(SPATIAL_STORE_SCHEMA_VERSION, target),
  })
  try {
    return planOn(db, steps, target)
  } finally {
    db.close()
  }
}

/**
 * Plan a migration over an already-open connection (read-only scan).
 * @param db - the open store handle.
 * @param steps - the migration list; defaults to the production list.
 * @returns the plan.
 */
export function planStoreMigration(db: DatabaseSync, steps: readonly StoreMigrationStep[] = STORE_MIGRATION_STEPS): MigrationPlan {
  const target = validateStepList(steps)
  return planOn(db, steps, target)
}

/** Escape one path for embedding in the single-quoted `VACUUM INTO` literal. */
function vacuumPath(path: string): string {
  return `'${path.replace(/'/g, "''")}'`
}

/**
 * Take the backup-before-write snapshot: a consistent `VACUUM INTO` copy of
 * the database plus its sha256. Runs before the first migration write.
 * @param root - the store root.
 * @param db - the open (readable) connection.
 * @returns the snapshot record.
 */
function takeMigrationBackup(root: string, db: DatabaseSync): MigrationBackup {
  const path = join(root, 'backups', `pre-migration-v${storeSchemaVersion(db)}-${randomUUID()}.db`)
  db.exec(`VACUUM INTO ${vacuumPath(path)}`)
  return { path, sha256: sha256File(path), bytes: 0 }
}

/**
 * Run the forward migration on one store root.
 * @param root - the store root (created when missing).
 * @param options - `steps` defaults to the production list; `targetVersion`
 *   defaults to the list's maximum; `createBackup` (default true) snapshots
 *   an existing store before the first write; `tenant` names the deployment
 *   tenant pre-@2 governance rows backfill under (defaults to the
 *   single-tenant default).
 * @returns the migration report with checksums and the backup record.
 * @throws {StorageError} `future-schema-version` when the store is newer
 *   than the target (never downgraded); `invalid-migration-list` for a
 *   broken chain. Step failures propagate after rolling back their transaction.
 */
export function migrateStore(
  root: string,
  options: {
    steps?: readonly StoreMigrationStep[]
    targetVersion?: number
    createBackup?: boolean
    tenant?: string
  } = {},
): MigrationReport {
  const steps = options.steps ?? STORE_MIGRATION_STEPS
  const listMax = validateStepList(steps)
  const target = options.targetVersion ?? listMax
  if (target > listMax) {
    throw new StorageError(
      'invalid-migration-list',
      `target version ${target} exceeds the migration list's maximum ${listMax}`,
    )
  }
  createStoreRoot(root)
  const dbPath = storeDbPath(root)
  const db = openStoreDatabase(dbPath, {
    supportedSchemaVersion: Math.max(SPATIAL_STORE_SCHEMA_VERSION, listMax),
  })
  try {
    const current = storeSchemaVersion(db)
    if (current > target) {
      throw new StorageError(
        'future-schema-version',
        `store at "${dbPath}" has schema version ${current}, newer than the migration target ${target}; downgrading is not supported`,
      )
    }
    if (current === target) {
      return { applied: [], alreadyCurrent: true, beforeChecksum: null, afterChecksum: null, backup: null }
    }
    const beforeChecksum = sha256File(dbPath)
    const backup = current > 0 && options.createBackup !== false ? takeMigrationBackup(root, db) : null
    db.exec(JOURNAL_DDL)
    const context: StoreMigrationContext = { tenant: options.tenant ?? MIGRATION_DEFAULT_TENANT }
    const applied: MigrationStepInfo[] = []
    for (const step of steps) {
      if (step.to <= current || step.to > target) continue
      db.exec('BEGIN IMMEDIATE')
      try {
        step.up(db, context)
        db.prepare('INSERT INTO migration_journal (to_version, from_version, name, applied_at) VALUES (?, ?, ?, ?)')
          .run(step.to, step.from, step.name, new Date().toISOString())
        db.exec(`PRAGMA user_version = ${step.to}`)
        db.exec('COMMIT')
      } catch (error) {
        // The step's DDL, journal row, and version bump roll back together;
        // the taken backup stays on disk for manual recovery.
        db.exec('ROLLBACK')
        throw error
      }
      applied.push({ from: step.from, to: step.to, name: step.name })
    }
    return {
      applied,
      alreadyCurrent: false,
      beforeChecksum,
      afterChecksum: sha256File(dbPath),
      backup,
    }
  } finally {
    db.close()
  }
}
