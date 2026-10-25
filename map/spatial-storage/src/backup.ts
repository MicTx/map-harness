/**
 * Backup bundles and layered restore. One bundle covers the store's own
 * state (database snapshot plus resource/artifact bytes) and explicitly
 * listed Session log copies; its manifest records the manifest version, the
 * store schema version, an optional authorization digest, and every entry's
 * sha256 and byte count. Publication is staging-verify-rename: the bundle
 * directory only appears after every staged entry re-verifies, so a partial
 * bundle never becomes one.
 *
 * Restore verifies the manifest, authorization, and all digests before
 * writing anything, then restores layer by layer — resource/artifact files,
 * the database, session logs — and reports each layer's outcome. Existing
 * bytes at the target are never overwritten: identical entries report
 * `kept-identical`, differing ones report `conflict-kept-existing`. Session
 * copies land under `<targetRoot>/sessions/` for the operator to place into
 * the upstream session store; this package never writes released session
 * generations itself. The projection cache is never backed up or restored
 * (derived data; it rebuilds from the session log), and external job state
 * is reported as not covered.
 *
 * @module @map-harness/spatial-storage/backup
 */
import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sha256Bytes, sha256File } from './checksum.ts'
import { StorageError } from './errors.ts'
import { openStoreDatabase, SPATIAL_STORE_SCHEMA_VERSION, storeDbPath, storeSchemaVersion } from './schema.ts'

/** The manifest layout version this build writes and accepts. */
export const BACKUP_MANIFEST_VERSION = 1

/** The manifest kind marker every bundle carries. */
export const BACKUP_MANIFEST_KIND = 'map-spatial-backup'

/** One bundle entry kind. */
export type BackupEntryKind = 'store-db' | 'resource' | 'artifact' | 'session-log'

/** One manifest entry: a bundled file with its verified identity. */
export interface BackupManifestEntry {
  readonly kind: BackupEntryKind
  /** Bundle-relative POSIX path under `data/`. */
  readonly path: string
  /** The store-relative source path, for resource/artifact entries. */
  readonly sourcePath: string | undefined
  /** The owning id: resource/artifact id or session id (`store` for the db). */
  readonly sourceId: string
  readonly sha256: string
  readonly bytes: number
}

/** The parsed manifest of one bundle. */
export interface BackupManifest {
  readonly manifestVersion: typeof BACKUP_MANIFEST_VERSION
  readonly kind: typeof BACKUP_MANIFEST_KIND
  readonly createdAt: string
  /** The store schema version the snapshot was taken at. */
  readonly storeSchemaVersion: number
  /** sha256 of the authorization token, when the bundle is authorization-gated. */
  readonly authorizationDigest: string | undefined
  readonly entries: readonly BackupManifestEntry[]
}

/** One session log to copy into a bundle. */
export interface BackupSessionInput {
  readonly sessionId: string
  /** Absolute path of the session's JSONL log file (copied verbatim). */
  readonly logPath: string
}

/** The result of creating one bundle. */
export interface BackupResult {
  /** Absolute path of the published bundle directory. */
  readonly bundlePath: string
  readonly manifest: BackupManifest
}

/** Per-entry verification status. */
export type BackupEntryStatus = 'ok' | 'digest-mismatch' | 'missing'

/** The outcome of verifying one bundle. */
export interface BackupVerification {
  readonly bundlePath: string
  /** The parsed manifest, when it read and validated structurally. */
  readonly manifest: BackupManifest | undefined
  readonly authorizationOk: boolean | undefined
  readonly entries: ReadonlyArray<BackupManifestEntry & { status: BackupEntryStatus }>
}

/** Layer statuses restore reports per restored entry. */
export type RestoredEntryStatus = 'restored' | 'kept-identical' | 'conflict-kept-existing'

/** One restored (or deliberately untouched) entry in the restore report. */
export interface RestoredEntry {
  readonly kind: BackupEntryKind
  readonly sourceId: string
  readonly status: RestoredEntryStatus
  /** Target-root-relative POSIX path written or inspected. */
  readonly targetPath: string
}

/** The database layer's outcome in the restore report. */
export interface RestoreDatabaseLayer {
  readonly status: 'restored' | 'kept-identical' | 'conflict-kept-existing'
  /** The schema version read from the restored store file, when openable. */
  readonly storeSchemaVersion: number | undefined
}

/** The full per-layer restore report. */
export interface RestoreReport {
  readonly bundlePath: string
  readonly targetRoot: string
  readonly files: readonly RestoredEntry[]
  readonly database: RestoreDatabaseLayer
  /** Session log copies, each restored or kept without overwriting. */
  readonly sessions: readonly RestoredEntry[]
  /** Always `discarded-derived`: the cache rebuilds from the session log. */
  readonly projectionCache: { readonly status: 'discarded-derived'; readonly detail: string }
  /** Always `not-covered-external`: job owners verify their own state. */
  readonly externalJobs: { readonly status: 'not-covered-external'; readonly detail: string }
}

/** The entry kinds a manifest may carry. */
const MANIFEST_ENTRY_KINDS: ReadonlySet<string> = new Set(['store-db', 'resource', 'artifact', 'session-log'])

/** Parse and structurally validate one bundle's manifest. */
function readManifest(bundlePath: string): BackupManifest {
  const manifestPath = join(bundlePath, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new StorageError('invalid-manifest', `bundle at "${bundlePath}" has no manifest.json`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    throw new StorageError('invalid-manifest', `bundle manifest at "${manifestPath}" is not valid JSON: ${String(error)}`)
  }
  const record = parsed as Partial<BackupManifest>
  if (record.manifestVersion !== BACKUP_MANIFEST_VERSION || record.kind !== BACKUP_MANIFEST_KIND || !Array.isArray(record.entries)) {
    throw new StorageError(
      'invalid-manifest',
      `bundle manifest at "${manifestPath}" carries unsupported identity (version ${String(record.manifestVersion)}, kind ${String(record.kind)})`,
    )
  }
  for (const entry of record.entries) {
    const candidate = entry as Partial<BackupManifestEntry>
    if (
      typeof candidate.kind !== 'string' || !MANIFEST_ENTRY_KINDS.has(candidate.kind)
      || typeof candidate.path !== 'string' || !candidate.path.startsWith('data/')
      || typeof candidate.sha256 !== 'string' || candidate.sha256.length !== 64
      || typeof candidate.sourceId !== 'string'
      || typeof candidate.bytes !== 'number'
    ) {
      throw new StorageError('invalid-manifest', `bundle manifest at "${manifestPath}" carries a malformed entry: ${JSON.stringify(entry).slice(0, 120)}`)
    }
  }
  return record as BackupManifest
}

/** Compute the authorization digest stored in manifests. */
function authorizationDigest(token: string): string {
  return sha256Bytes(Buffer.from(token, 'utf8'))
}

/**
 * Copy one file into the staging bundle and return its manifest entry. The
 * bundle-relative path mirrors the store-relative source path 1:1, so a
 * restore writes each byte back at its recorded store-relative location.
 */
function stageEntry(
  stagingDataDir: string,
  kind: BackupEntryKind,
  dataRelativePath: string,
  sourceId: string,
  absoluteSource: string,
  sourcePath: string | undefined,
): BackupManifestEntry {
  const target = join(stagingDataDir, dataRelativePath)
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  copyFileSync(absoluteSource, target)
  const bytes = readFileSync(target)
  return {
    kind,
    path: `data/${dataRelativePath}`,
    sourcePath,
    sourceId,
    sha256: sha256Bytes(bytes),
    bytes: bytes.length,
  }
}

/**
 * Create one backup bundle under `<root>/backups/`. The bundle appears only
 * after every staged entry re-verifies against its manifest digest; a
 * failure anywhere removes the staging directory and leaves no bundle.
 * @param root - the store root.
 * @param db - the open store handle (catalog/artifact rows enumerate the
 *   file entries).
 * @param options - `sessions` lists the session logs to copy verbatim;
 *   `authorization` gates verify/restore on a token when provided.
 * @returns the published bundle path and manifest.
 * @throws {StorageError} `missing-file` when a catalog/artifact row's file
 *   or a listed session log is gone; the staging directory is removed.
 */
export function createBackup(
  root: string,
  db: DatabaseSync,
  options: { sessions?: readonly BackupSessionInput[]; authorization?: string } = {},
): BackupResult {
  const bundleId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  const stagingPath = join(root, 'backups', `.staging-${bundleId}`)
  const finalPath = join(root, 'backups', bundleId)
  mkdirSync(join(stagingPath, 'data'), { recursive: true, mode: 0o700 })
  try {
    const entries: BackupManifestEntry[] = []
    // The snapshot comes from its own read-only connection so the copy is
    // independent of any transaction state on the caller's handle.
    const snapshotPath = join(stagingPath, 'data', 'store.db')
    const snapshotDb = new DatabaseSync(storeDbPath(root), { readOnly: true })
    try {
      snapshotDb.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`)
    } finally {
      snapshotDb.close()
    }
    const snapshotBytes = readFileSync(snapshotPath)
    entries.push({
      kind: 'store-db',
      path: 'data/store.db',
      sourcePath: undefined,
      sourceId: 'store',
      sha256: sha256Bytes(snapshotBytes),
      bytes: snapshotBytes.length,
    })
    for (const row of db.prepare('SELECT resource_id AS id, relative_path AS relativePath FROM catalog_resources ORDER BY resource_id')
      .all() as Array<{ id: string; relativePath: string }>) {
      entries.push(stageEntry(join(stagingPath, 'data'), 'resource', row.relativePath, row.id, join(root, row.relativePath), row.relativePath))
    }
    for (const row of db.prepare('SELECT artifact_id AS id, relative_path AS relativePath FROM artifacts ORDER BY artifact_id')
      .all() as Array<{ id: string; relativePath: string }>) {
      entries.push(stageEntry(join(stagingPath, 'data'), 'artifact', row.relativePath, row.id, join(root, row.relativePath), row.relativePath))
    }
    for (const session of options.sessions ?? []) {
      entries.push(stageEntry(
        join(stagingPath, 'data'),
        'session-log',
        `sessions/${session.sessionId}.jsonl`,
        session.sessionId,
        session.logPath,
        undefined,
      ))
    }
    // Self-verify before publish: a bundle's bytes must match its own
    // manifest, or the bundle directory never appears.
    for (const entry of entries) {
      if (sha256Bytes(readFileSync(join(stagingPath, entry.path))) !== entry.sha256) {
        throw new StorageError('digest-mismatch', `staged entry ${entry.path} does not match its own manifest digest`)
      }
    }
    const manifest: BackupManifest = {
      manifestVersion: BACKUP_MANIFEST_VERSION,
      kind: BACKUP_MANIFEST_KIND,
      createdAt: new Date().toISOString(),
      storeSchemaVersion: SPATIAL_STORE_SCHEMA_VERSION,
      authorizationDigest: options.authorization === undefined ? undefined : authorizationDigest(options.authorization),
      entries,
    }
    writeFileSync(join(stagingPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
    renameSync(stagingPath, finalPath)
    return { bundlePath: finalPath, manifest }
  } catch (error) {
    // Only staging directories carry the `.staging-` prefix; published
    // bundles are never removed on this path.
    if (basename(stagingPath).startsWith('.staging-')) {
      rmSync(stagingPath, { recursive: true, force: true })
    }
    throw error
  }
}

/**
 * Verify one bundle without restoring: manifest structure, authorization,
 * and every entry's on-disk digest.
 * @param bundlePath - the published bundle directory.
 * @param options - `authorization` must match the manifest digest when the
 *   bundle carries one.
 * @returns the per-entry verification.
 * @throws {StorageError} `invalid-manifest` when the manifest is missing,
 *   unparsable, or of an unsupported version/kind; `authorization-mismatch`
 *   when the token does not match.
 */
export function verifyBackup(bundlePath: string, options: { authorization?: string } = {}): BackupVerification {
  const manifest = readManifest(bundlePath)
  let authorizationOk: boolean | undefined
  if (manifest.authorizationDigest !== undefined) {
    if (options.authorization === undefined || authorizationDigest(options.authorization) !== manifest.authorizationDigest) {
      throw new StorageError('authorization-mismatch', `bundle "${bundlePath}" requires the authorization token recorded in its manifest`)
    }
    authorizationOk = true
  }
  const entries = manifest.entries.map(entry => {
    const absolute = join(bundlePath, entry.path)
    if (!existsSync(absolute)) return { ...entry, status: 'missing' as const }
    return { ...entry, status: sha256File(absolute) === entry.sha256 ? ('ok' as const) : ('digest-mismatch' as const) }
  })
  return { bundlePath, manifest, authorizationOk, entries }
}

/**
 * Restore one verified bundle into a target store root. Verification runs
 * first — any digest mismatch or authorization failure refuses the whole
 * restore — then each layer writes without overwriting existing bytes.
 * @param bundlePath - the published bundle directory.
 * @param targetRoot - the store root to restore into (created when missing).
 * @param options - `authorization` when the bundle is gated.
 * @returns the per-layer report.
 * @throws {StorageError} `invalid-manifest`, `authorization-mismatch`, or
 *   `digest-mismatch` (naming every bad entry) before any write happens.
 */
export function restoreBackup(
  bundlePath: string,
  targetRoot: string,
  options: { authorization?: string } = {},
): RestoreReport {
  const verification = verifyBackup(bundlePath, options)
  const manifest = verification.manifest
  if (manifest === undefined) {
    throw new StorageError('invalid-manifest', `bundle "${bundlePath}" has no readable manifest; refusing to restore`)
  }
  const bad = verification.entries.filter(entry => entry.status !== 'ok')
  if (bad.length > 0) {
    const named = bad.map(entry => `${entry.path} (${entry.status})`).join(', ')
    throw new StorageError('digest-mismatch', `bundle "${bundlePath}" failed verification for ${bad.length} entries: ${named}`)
  }
  mkdirSync(targetRoot, { recursive: true, mode: 0o700 })

  const files: RestoredEntry[] = []
  const sessions: RestoredEntry[] = []
  let database: RestoreDatabaseLayer = { status: 'kept-identical', storeSchemaVersion: undefined }

  // Layer order: bytes first, then the database, then sessions — so a
  // partially restored target never holds catalog rows whose files are
  // missing, and session copies never race the database they belong to.
  const dbEntry = manifest.entries.find(entry => entry.kind === 'store-db')
  for (const entry of manifest.entries) {
    if (entry.kind === 'store-db') continue
    const targetRelative = entry.kind === 'session-log'
      ? `sessions/${entry.sourceId}.jsonl`
      : (entry.sourcePath ?? '')
    const status = restoreEntryFile(join(bundlePath, entry.path), join(targetRoot, targetRelative))
    const record: RestoredEntry = { kind: entry.kind, sourceId: entry.sourceId, status, targetPath: targetRelative }
    if (entry.kind === 'session-log') sessions.push(record)
    else files.push(record)
  }
  if (dbEntry !== undefined) {
    const targetDb = storeDbPath(targetRoot)
    if (!existsSync(targetDb)) {
      copyFileSync(join(bundlePath, dbEntry.path), targetDb)
      database = { status: 'restored', storeSchemaVersion: storeSchemaVersionOf(targetDb) }
    } else {
      database = {
        status: sha256File(targetDb) === dbEntry.sha256 ? 'kept-identical' : 'conflict-kept-existing',
        storeSchemaVersion: storeSchemaVersionOf(targetDb),
      }
    }
  }
  return {
    bundlePath,
    targetRoot,
    files,
    database,
    sessions,
    projectionCache: {
      status: 'discarded-derived',
      detail: 'projection cache is derived data; it rebuilds from the restored session logs',
    },
    externalJobs: {
      status: 'not-covered-external',
      detail: 'external job state is owned by its provider; verify separately',
    },
  }
}

/** Copy one file into place with never-overwrite semantics. */
function restoreEntryFile(source: string, target: string): RestoredEntryStatus {
  if (existsSync(target)) {
    return sha256File(target) === sha256File(source) ? 'kept-identical' : 'conflict-kept-existing'
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  copyFileSync(source, target)
  return 'restored'
}

/** Read the schema version of a restored store file, reporting a future one. */
function storeSchemaVersionOf(dbPath: string): number | undefined {
  try {
    const db = openStoreDatabase(dbPath, { readOnly: true })
    try {
      return storeSchemaVersion(db)
    } finally {
      db.close()
    }
  } catch (error) {
    // A restored database newer than this build stays on disk and is
    // reported as unreadable here; opening it would breach the
    // no-downgrade contract.
    if (error instanceof StorageError && error.code === 'future-schema-version') return undefined
    throw error
  }
}
