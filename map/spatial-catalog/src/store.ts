/**
 * The catalog's store binding: one spatial-storage store root holding one
 * session library's database, its controlled file area, and the staging area
 * publish transactions promote from. The plugin opens one root per
 * conversation under `<root>/sessions/<sessionId>/` (see
 * `sessionStoreRoot`); the store schema is owned by the monotonic
 * spatial-storage migration ladder, so every open runs the same per-library
 * create/migrate discipline, and the catalog owns the repository API and
 * its transactions on top.
 *
 * @module @map-harness/spatial-catalog/store
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  type StorageError,
  MIGRATION_DEFAULT_TENANT,
  createStoreRoot,
  migrateStore,
  openStoreDatabase,
  storeDbPath,
} from '@map-harness/spatial-storage'
import { CatalogError } from './errors.ts'

/** One open, migrated catalog store handle; the owner closes it. */
export interface CatalogStore {
  readonly root: string
  readonly db: DatabaseSync
  /** The tenant every governance row in this store belongs to. */
  readonly tenant: string
  close(): void
}

/** Options for opening one catalog store under its deployment tenant. */
export interface OpenCatalogStoreOptions {
  /**
   * The deployment tenant this store serves; defaults to the single-tenant
   * default, which is also the migration ladder's backfill tenant.
   */
  readonly tenant?: string
}

/**
 * Create (when absent), migrate to the current store version, and open one
 * catalog store root under its deployment tenant.
 * @param root - the store root directory.
 * @param options - the deployment tenant, when the deployment declares one.
 * @returns the open handle.
 * @throws {CatalogError} `CATALOG_IO` when the store cannot be created, a
 *   migrated-open precondition fails, or the store already holds governance
 *   rows under a different tenant (a store is single-tenant for its whole
 *   life), propagating the storage error's stable code (for example
 *   `future-schema-version`) in the message.
 */
export function openCatalogStore(root: string, options: OpenCatalogStoreOptions = {}): CatalogStore {
  const tenant = options.tenant ?? MIGRATION_DEFAULT_TENANT
  try {
    createStoreRoot(root)
    migrateStore(root, { tenant })
    const db = openStoreDatabase(storeDbPath(root))
    try {
      const foreign = db.prepare(
        'SELECT tenant FROM governance_acl WHERE tenant <> ? LIMIT 1',
      ).get(tenant) as { readonly tenant: string } | undefined
      if (foreign !== undefined) {
        throw new CatalogError(
          'CATALOG_IO',
          `catalog store at "${root}" holds governance rows under tenant "${foreign.tenant}" and cannot serve tenant "${tenant}"`,
        )
      }
    } catch (error: unknown) {
      db.close()
      throw error
    }
    return { root, db, tenant, close: () => { db.close() } }
  } catch (error: unknown) {
    if (error instanceof CatalogError) throw error
    throw new CatalogError('CATALOG_IO', `catalog store at "${root}" could not be opened: ${storageDetail(error)}`)
  }
}

/**
 * Run one function inside a single `BEGIN IMMEDIATE` transaction; any throw
 * rolls the whole unit back before the error propagates.
 * @typeParam T - the function's return type.
 * @param db - the open store handle.
 * @param body - the transactional unit.
 * @returns the body's result.
 */
export function withTransaction<T>(db: DatabaseSync, body: () => T): T {
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
      console.warn?.(`spatial-catalog: transaction rollback failed: ${String(rollbackError)}`)
    }
    throw error
  }
}

/** Extract the stable detail from a storage-package error. */
function storageDetail(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as StorageError).code)
    : undefined
  return code ?? String(error)
}
