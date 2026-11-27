/** SQLite persistence for one bounded, fully admitted Wayback catalog and host-verified releases. */
import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { WaybackCoreItem } from './wayback-core.ts'
import type { WaybackRelease } from './wayback.ts'
import { SourceCatalogError } from './source-error.ts'
import { WAYBACK_CATALOG_MAX_RELEASES } from './wayback-catalog-codec.ts'

const SCHEMA_VERSION = 1
const VERIFIED_SCHEMA_VERSION = 2
/** Newest schema this build reads; a higher `user_version` belongs to a newer build. */
const MAX_SUPPORTED_VERSION = VERIFIED_SCHEMA_VERSION
/** Verified records are a bounded cache, never an archive: a full store refuses new keys. */
export const MAX_VERIFIED_RELEASES = WAYBACK_CATALOG_MAX_RELEASES
const MAX_RECORD_CHARS = 2048
const RELEASE_FIELDS = ['releaseId', 'itemId', 'title', 'publishedAt', 'layerIdentifier', 'acquiredAt'] as const

interface VerifiedRecord {
  readonly releaseId: number
  readonly configDigest: string
  readonly release: WaybackRelease
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** Refuse a key argument that is not a lowercase hex digest of a supported length. */
function assertDigest(configDigest: string): void {
  if (typeof configDigest !== 'string' || !/^[0-9a-f]{8,128}$/.test(configDigest)) {
    throw new Error('invalid Wayback verified release config digest')
  }
}

function assertReleaseId(releaseId: unknown, field: string): asserts releaseId is number {
  if (typeof releaseId !== 'number' || !Number.isSafeInteger(releaseId) || releaseId <= 0) throw new Error(`invalid Wayback verified release ${field}`)
}

/**
 * Validate one release exactly as the official catalog defines it.
 * @param value - untrusted candidate.
 * @param field - name of the containing field, for the report.
 * @returns the release with only its declared fields, in a fixed order.
 */
function parseRelease(value: unknown, field: string): WaybackRelease {
  if (!isRecord(value)) throw new Error(`invalid Wayback verified release: ${field} is not an object`)
  for (const name of Object.keys(value)) {
    if (!(RELEASE_FIELDS as readonly string[]).includes(name)) throw new Error(`invalid Wayback verified release unknown field ${name}`)
  }
  assertReleaseId(value.releaseId, 'releaseId')
  const { releaseId, itemId, title, publishedAt, layerIdentifier, acquiredAt } = value
  if (typeof itemId !== 'string' || !/^[0-9a-f]{32}$/.test(itemId)) throw new Error('invalid Wayback verified release itemId')
  if (!isCalendarDate(publishedAt)) throw new Error('invalid Wayback verified release publishedAt')
  if (title !== `World Imagery (Wayback ${publishedAt})`) throw new Error('invalid Wayback verified release title')
  if (typeof layerIdentifier !== 'string' || layerIdentifier !== `WB_${publishedAt.slice(0, 4)}_R${String(layerIdentifier).slice(-2)}`
    || !/^R\d{2}$/.test(String(layerIdentifier).slice(-3))) {
    throw new Error('invalid Wayback verified release layerIdentifier')
  }
  if (acquiredAt !== null && !isCalendarDate(acquiredAt)) throw new Error('invalid Wayback verified release acquiredAt')
  return Object.freeze({ releaseId, itemId, title, publishedAt, layerIdentifier, acquiredAt })
}

/** Validate one stored or incoming record and require it to name its own key. */
function parseRecord(value: unknown): VerifiedRecord {
  let parsed: unknown = value
  if (typeof value === 'string') {
    if (value.length > MAX_RECORD_CHARS) throw new Error('Wayback verified release record exceeds the size bound')
    try {
      parsed = JSON.parse(value)
    } catch (error) {
      // The parse failure is the reported cause; the record is refused as a whole.
      throw new Error('Wayback verified release record is not JSON', { cause: error })
    }
  }
  if (!isRecord(parsed) || Object.keys(parsed).some(name => !['releaseId', 'configDigest', 'release'].includes(name))) {
    throw new Error('Wayback verified release record is malformed')
  }
  assertReleaseId(parsed.releaseId, 'releaseId')
  assertDigest(parsed.configDigest as string)
  const release = parseRelease(parsed.release, 'release')
  if (release.releaseId !== parsed.releaseId) throw new Error('Wayback verified release record releaseId disagrees with its release')
  return { releaseId: parsed.releaseId, configDigest: parsed.configDigest as string, release }
}

function canonical(record: VerifiedRecord): string {
  return JSON.stringify({ releaseId: record.releaseId, configDigest: record.configDigest, release: record.release })
}

/**
 * Run one write inside `BEGIN IMMEDIATE`; any failure rolls back and rethrows.
 * @param path - Harness-owned SQLite file.
 * @param body - receives the database and its current `user_version`.
 */
function transact(path: string, body: (database: DatabaseSync, version: number) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const database = new DatabaseSync(path)
  try {
    database.exec('BEGIN IMMEDIATE')
    const version = database.prepare('PRAGMA user_version').get()?.user_version
    if (typeof version !== 'number') throw new Error('invalid Wayback catalog schema version')
    body(database, version)
    database.exec('COMMIT')
  } finally {
    // Closing with an uncommitted transaction rolls it back.
    database.close()
  }
}

function readVersion(database: DatabaseSync): number {
  const version = database.prepare('PRAGMA user_version').get()?.user_version
  if (version !== SCHEMA_VERSION && version !== VERIFIED_SCHEMA_VERSION) {
    throw new Error(`unsupported Wayback catalog schema ${String(version)}`)
  }
  return version
}

function createCatalogTable(database: DatabaseSync): void {
  database.exec(`CREATE TABLE wayback_catalog (id INTEGER PRIMARY KEY CHECK (id = 1), items TEXT NOT NULL) STRICT;
    PRAGMA user_version = ${SCHEMA_VERSION}`)
}

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
    readVersion(database)
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
 * Catalog-only writes keep an existing schema version and never touch verified releases.
 * @param path - Harness-owned SQLite file.
 * @param items - complete validated catalog, excluding derived release timestamps.
 */
export function saveWaybackCatalog(path: string, items: readonly Omit<WaybackCoreItem, 'releaseDatetime'>[]): void {
  const json = JSON.stringify(items)
  transact(path, (database, version) => {
    if (version === 0) createCatalogTable(database)
    else if (version > MAX_SUPPORTED_VERSION) throw new Error(`unsupported Wayback catalog schema ${String(version)}`)
    database.prepare(`INSERT INTO wayback_catalog (id, items) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET items = excluded.items`).run(json)
  })
}

/**
 * Load one host-verified release, validating the stored record before it is returned.
 * The caller must still compare the returned release with its own recomputed descriptor.
 * @param path - Harness-owned SQLite file.
 * @param releaseId - official release number.
 * @param configDigest - release-derived digest computed by the host, never by the client.
 * @returns the frozen release, or undefined when the file, schema table, or key is absent.
 */
export function loadVerifiedWaybackRelease(path: string, releaseId: number, configDigest: string): WaybackRelease | undefined {
  assertReleaseId(releaseId, 'releaseId')
  assertDigest(configDigest)
  try {
    statSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    if (readVersion(database) === SCHEMA_VERSION) return undefined
    const row = database.prepare('SELECT record FROM wayback_verified_release WHERE release_id = ? AND config_digest = ?')
      .get(releaseId, configDigest)
    if (row === undefined || typeof row.record !== 'string') return undefined
    const record = parseRecord(row.record)
    if (record.releaseId !== releaseId || record.configDigest !== configDigest) throw new Error('Wayback verified release record does not match its key')
    return record.release
  } finally {
    database.close()
  }
}

/**
 * Store one host-verified release under its `(releaseId, configDigest)` key.
 * A repeat of an identical record is a no-op; a different record for the same key is refused.
 * The first store migrates the file from schema v1 to v2 without rewriting the catalog.
 * A full store refuses the write and evicts nothing.
 * @param path - Harness-owned SQLite file.
 * @param release - release the host verified against the official catalog.
 * @param configDigest - release-derived digest computed by the host, never by the client.
 */
export function saveVerifiedWaybackRelease(path: string, release: WaybackRelease, configDigest: string): void {
  assertDigest(configDigest)
  const validated = parseRelease(release, 'release')
  const record: VerifiedRecord = { releaseId: validated.releaseId, configDigest, release: validated }
  const json = canonical(record)
  if (json.length > MAX_RECORD_CHARS) throw new Error('Wayback verified release record exceeds the size bound')
  transact(path, (database, version) => {
    if (version === 0) createCatalogTable(database)
    else if (version > MAX_SUPPORTED_VERSION) throw new Error(`unsupported Wayback catalog schema ${String(version)}`)
    if (version < VERIFIED_SCHEMA_VERSION) {
      database.exec(`CREATE TABLE wayback_verified_release (
        release_id INTEGER NOT NULL,
        config_digest TEXT NOT NULL,
        record TEXT NOT NULL,
        PRIMARY KEY (release_id, config_digest)
      ) STRICT;
      PRAGMA user_version = ${VERIFIED_SCHEMA_VERSION}`)
    }
    const existing = database.prepare('SELECT record FROM wayback_verified_release WHERE release_id = ? AND config_digest = ?')
      .get(record.releaseId, configDigest)
    if (existing !== undefined) {
      if (typeof existing.record !== 'string' || canonical(parseRecord(existing.record)) !== json) {
        throw new Error(`Wayback verified release conflict for release ${record.releaseId}`)
      }
      return
    }
    const { count } = database.prepare('SELECT COUNT(*) AS count FROM wayback_verified_release').get() as { count: number }
    if (count >= MAX_VERIFIED_RELEASES) throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
    database.prepare('INSERT INTO wayback_verified_release (release_id, config_digest, record) VALUES (?, ?, ?)')
      .run(record.releaseId, configDigest, json)
  })
}
