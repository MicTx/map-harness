/** SQLite persistence for one bounded, fully admitted Wayback catalog. */
import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { WaybackCoreItem } from './wayback-core.ts'

const SCHEMA_VERSION = 1

/**
 * Load the stored catalog for revalidation without creating or modifying the cache.
 * @param path - Harness-owned SQLite file.
 * @returns untrusted catalog JSON, or undefined if no snapshot has been committed.
 */
export function loadWaybackCatalog(path: string): unknown {
  try {
    statSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    if (database.prepare('PRAGMA user_version').get()?.user_version !== SCHEMA_VERSION) {
      throw new Error('unsupported Wayback catalog schema')
    }
    const row = database.prepare('SELECT items FROM wayback_catalog WHERE id = 1').get()
    if (row === undefined) return undefined
    if (typeof row.items !== 'string') throw new Error('invalid Wayback catalog row')
    const items: unknown = JSON.parse(row.items)
    return items
  } finally {
    database.close()
  }
}

/**
 * Atomically replace the catalog; a failed write leaves the previous snapshot intact.
 * @param path - Harness-owned SQLite file.
 * @param items - complete validated catalog, excluding derived release timestamps.
 */
export function saveWaybackCatalog(path: string, items: readonly Omit<WaybackCoreItem, 'releaseDatetime'>[]): void {
  const json = JSON.stringify(items)
  mkdirSync(dirname(path), { recursive: true })
  const database = new DatabaseSync(path)
  try {
    database.exec('BEGIN IMMEDIATE')
    const version = database.prepare('PRAGMA user_version').get()?.user_version
    if (version === 0) {
      database.exec(`CREATE TABLE wayback_catalog (id INTEGER PRIMARY KEY CHECK (id = 1), items TEXT NOT NULL) STRICT;
        PRAGMA user_version = ${SCHEMA_VERSION}`)
    } else if (version !== SCHEMA_VERSION) {
      throw new Error('unsupported Wayback catalog schema')
    }
    database.prepare(`INSERT INTO wayback_catalog (id, items) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET items = excluded.items`).run(json)
    database.exec('COMMIT')
  } finally {
    database.close()
  }
}
