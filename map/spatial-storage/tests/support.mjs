/**
 * Shared fixtures for the spatial-storage suites: tracked temp roots and
 * seeded published rows. Every store a test touches lives under one tracked
 * root so teardown removes the bytes even when an assertion throws.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Bytes } from '../src/checksum.ts'
import { migrateStore } from '../src/migrate.ts'
import { openStoreDatabase, storeDbPath } from '../src/schema.ts'

export { trackedTmpDir, withTrackedTmpDir } from '../../tests/support/reliability.mjs'

/**
 * Create a fresh store root with the baseline schema applied and return the
 * open handle (the test owns closing).
 * @param {string} root - the store root directory.
 * @returns {import('node:sqlite').DatabaseSync} the open handle at version 1.
 */
export function freshStore(root) {
  migrateStore(root)
  return openStoreDatabase(storeDbPath(root))
}

/**
 * Seed one published resource row plus its file bytes.
 * @param {string} root - the store root.
 * @param {import('node:sqlite').DatabaseSync} db - the open store handle.
 * @param {string} id - the resource id.
 * @param {string} content - the file content to admit.
 * @param {{ relativePath?: string }} [options] - store-relative path override.
 * @returns {{ relativePath: string, sha256: string }} the seeded identity.
 */
export function seedPublishedResource(root, db, id, content, options = {}) {
  const relativePath = options.relativePath ?? `files/shared/${id}.blob`
  const absolute = join(root, relativePath)
  mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true })
  writeFileSync(absolute, content)
  db.prepare(
    'INSERT INTO catalog_resources (resource_id, version, state, relative_path, sha256, bytes, schema_digest, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 1, 'published', relativePath, sha256Bytes(Buffer.from(content)), Buffer.byteLength(content), 'schema-digest-1', new Date().toISOString())
  return { relativePath, sha256: sha256Bytes(Buffer.from(content)) }
}

/**
 * Seed one published artifact row plus its file bytes.
 * @param {string} root - the store root.
 * @param {import('node:sqlite').DatabaseSync} db - the open store handle.
 * @param {string} id - the artifact id.
 * @param {string} content - the file content to admit.
 * @returns {{ relativePath: string, sha256: string }} the seeded identity.
 */
export function seedPublishedArtifact(root, db, id, content) {
  const relativePath = `files/derived/${id}.blob`
  const absolute = join(root, relativePath)
  mkdirSync(absolute.slice(0, absolute.lastIndexOf('/')), { recursive: true })
  writeFileSync(absolute, content)
  db.prepare(
    'INSERT INTO artifacts (artifact_id, version, state, relative_path, sha256, bytes, input_refs, method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, 1, 'published', relativePath, sha256Bytes(Buffer.from(content)), Buffer.byteLength(content), '[]', 'fixture-method', new Date().toISOString())
  return { relativePath, sha256: sha256Bytes(Buffer.from(content)) }
}

/**
 * Write one session-style JSONL log file (the test stands in for the
 * upstream session store path).
 * @param {string} dir - the directory to place the log in.
 * @param {string} sessionId - the session id.
 * @param {string[]} lines - the JSONL lines.
 * @returns {string} the log's absolute path.
 */
export function writeSessionLog(dir, sessionId, lines) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const logPath = join(dir, `${sessionId}.jsonl`)
  writeFileSync(logPath, `${lines.join('\n')}\n`)
  return logPath
}
