/**
 * The per-session store layout under one root: each conversation owns an
 * independent SQLite store under `<root>/sessions/<sessionId>/` with the
 * exact per-store layout {@link createStoreRoot} creates, so every
 * migration/backup/checksum/cleanup discipline applies per library unchanged.
 * The `sessions/` directory itself is the root manifest — one subdirectory
 * per session store, no shared index file and no shared root database. A
 * session id becomes a path component, so it is validated at this file
 * boundary and refused loudly; sessions never share rows, bytes, or locks,
 * and nothing here ever deletes a store implicitly ({@link dropSessionStore}
 * is the only removal path and is explicit).
 *
 * @module @map-harness/spatial-storage/sessions
 */
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { StorageError } from './errors.ts'
import { STORE_DB_NAME } from './schema.ts'

/** Directory under the root holding one subdirectory per session store. */
export const SESSIONS_DIR_NAME = 'sessions'

/**
 * The session ids admissible as one path component: an ASCII alphanumeric
 * start (never `.`, never a separator, never `..`), then alphanumerics,
 * `.`, `_`, `-`, at most 128 characters. Refused ids never reach `join`.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Validate one session id for use as a store path component.
 * @param sessionId - the caller-provided session identity.
 * @throws {StorageError} `invalid-session-id` for an id that cannot name a
 *   store directory (empty, oversized, or carrying separators/traversal).
 */
export function assertValidSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) {
    throw new StorageError(
      'invalid-session-id',
      `session id ${JSON.stringify(sessionId)} cannot name a session store (required: 1-128 chars, starting alphanumeric, then only alphanumerics, ".", "_", "-")`,
    )
  }
}

/**
 * Resolve one session's store root under the shared root.
 * @param root - the store root directory the composition configures.
 * @param sessionId - the owning conversation's id.
 * @returns `<root>/sessions/<sessionId>` with the id validated first.
 * @throws {StorageError} `invalid-session-id` for an unusable id.
 */
export function sessionStoreRoot(root: string, sessionId: string): string {
  assertValidSessionId(sessionId)
  return join(root, SESSIONS_DIR_NAME, sessionId)
}

/** One session store as the root manifest lists it. */
export interface SessionStoreEntry {
  readonly sessionId: string
  /** Whether the session directory holds a database file (a first use created it). */
  readonly hasDatabase: boolean
}

/**
 * List the root manifest read-only: every session store directory under
 * `<root>/sessions/`. Directory names the id pattern refuses (foreign or
 * hand-placed entries) are skipped, never deleted; the manifest is derived
 * from the directory, so a crash mid-creation leaves at most an unlisted
 * partial directory, never a phantom manifest row.
 * @param root - the store root directory.
 * @returns the session entries in directory order; empty when no session
 *   ever used the root.
 */
export function listSessionStores(root: string): readonly SessionStoreEntry[] {
  let names: string[]
  try {
    names = readdirSync(join(root, SESSIONS_DIR_NAME))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const entries: SessionStoreEntry[] = []
  for (const name of names) {
    if (!SESSION_ID_PATTERN.test(name)) continue
    const absolute = join(root, SESSIONS_DIR_NAME, name)
    let stats
    try {
      stats = lstatSync(absolute)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!stats.isDirectory()) continue
    let hasDatabase = false
    try {
      hasDatabase = lstatSync(join(absolute, STORE_DB_NAME)).isFile()
    } catch {
      // A session directory without a database file is a first use that died
      // before `createStoreRoot` finished; it stays listed, not deleted.
    }
    entries.push({ sessionId: name, hasDatabase })
  }
  return entries
}

/**
 * Explicitly remove one session store — the only deletion path for a whole
 * library, and never invoked by any automatic lifecycle. The session
 * directory moves atomically into `<root>/trash/` before deletion, so a
 * crash mid-drop leaves the bytes visible in `trash/` instead of a
 * half-deleted session directory; link-shaped entries are unlinked, never
 * followed.
 * @param root - the store root directory.
 * @param sessionId - the conversation whose store is being dropped.
 * @throws {StorageError} `invalid-session-id` for an unusable id;
 *   `missing-session-store` when the session has no store to drop.
 */
export function dropSessionStore(root: string, sessionId: string): void {
  const sessionRoot = sessionStoreRoot(root, sessionId)
  let stats
  try {
    stats = lstatSync(sessionRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new StorageError('missing-session-store', `session "${sessionId}" has no store under "${root}" to drop`)
    }
    throw error
  }
  const trashDir = join(root, 'trash')
  mkdirSync(trashDir, { recursive: true, mode: 0o700 })
  const trashPath = join(trashDir, `${sessionId}-${randomUUID()}`)
  renameSync(sessionRoot, trashPath)
  if (stats.isSymbolicLink()) {
    // The rename moved the link itself; unlink it (never `rmSync`, which
    // refuses a link whose target is a directory) without following into
    // whatever it pointed at.
    unlinkSync(trashPath)
    return
  }
  rmSync(trashPath, { recursive: true })
}
