/**
 * Recovery diagnostics gates: the verification sweep reports every damaged
 * condition per entry — missing file, digest mismatch, permission change,
 * link-shaped entry — never mutates, reports a store written by a newer
 * build as explicitly unavailable, and leaves fork-protected references
 * intact for the next recovery decision.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256File } from '../src/checksum.ts'
import { StorageError } from '../src/errors.ts'
import { verifyStore } from '../src/recovery.ts'
import { migrateStore } from '../src/migrate.ts'
import { openStoreDatabase, STORE_MIGRATION_STEPS, storeDbPath, storeSchemaVersion } from '../src/schema.ts'
import { protectorsOf } from '../src/refs.ts'
import { freshStore, seedPublishedArtifact, seedPublishedResource, trackedTmpDir } from './support.mjs'

test('a clean store verifies with every entry ok', () => {
  const dir = trackedTmpDir('recovery-clean')
  try {
    const db = freshStore(dir.path)
    try {
      seedPublishedResource(dir.path, db, 'res-ok', 'resource-bytes')
      seedPublishedArtifact(dir.path, db, 'art-ok', 'artifact-bytes')
      const report = verifyStore(dir.path)
      assert.equal(report.store, 'ok')
      assert.equal(report.storeSchemaVersion, storeSchemaVersion(db))
      assert.deepEqual(report.summary, { ok: 2, unavailable: 0 })
      assert.deepEqual(report.entries.map(entry => entry.status), ['ok', 'ok'])
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('a deleted file reports missing-file without touching the store', () => {
  const dir = trackedTmpDir('recovery-missing')
  try {
    const db = freshStore(dir.path)
    let seeded
    try {
      seeded = seedPublishedResource(dir.path, db, 'res-gone', 'vanish-bytes')
    } finally {
      db.close()
    }
    const before = sha256File(storeDbPath(dir.path))
    rmSync(join(dir.path, seeded.relativePath))
    const report = verifyStore(dir.path)
    assert.deepEqual(report.summary, { ok: 0, unavailable: 1 })
    assert.deepEqual(report.entries[0], {
      kind: 'resource',
      id: 'res-gone',
      state: 'published',
      relativePath: seeded.relativePath,
      status: 'missing-file',
    })
    assert.equal(sha256File(storeDbPath(dir.path)), before, 'verification is read-only')
  } finally {
    dir.dispose()
  }
})

test('tampered bytes report digest-mismatch, not silent success', () => {
  const dir = trackedTmpDir('recovery-digest')
  try {
    const db = freshStore(dir.path)
    let seeded
    try {
      seeded = seedPublishedResource(dir.path, db, 'res-tampered', 'original-bytes')
    } finally {
      db.close()
    }
    writeFileSync(join(dir.path, seeded.relativePath), 'replaced-bytes')
    const report = verifyStore(dir.path)
    assert.equal(report.entries[0].status, 'digest-mismatch')
  } finally {
    dir.dispose()
  }
})

test('a mode change reports permission-denied', () => {
  const dir = trackedTmpDir('recovery-permission')
  try {
    if (process.getuid?.() === 0) {
      // Root reads bypass mode bits; the permission case is POSIX-owner only.
      return
    }
    const db = freshStore(dir.path)
    let seeded
    try {
      seeded = seedPublishedArtifact(dir.path, db, 'art-locked', 'locked-bytes')
    } finally {
      db.close()
    }
    chmodSync(join(dir.path, seeded.relativePath), 0o000)
    const report = verifyStore(dir.path)
    assert.equal(report.entries[0].status, 'permission-denied')
    assert.deepEqual(report.summary, { ok: 0, unavailable: 1 })
    chmodSync(join(dir.path, seeded.relativePath), 0o644)
  } finally {
    dir.dispose()
  }
})

test('a link-shaped entry at a recorded path reports not-regular-file', () => {
  const dir = trackedTmpDir('recovery-symlink')
  try {
    const db = freshStore(dir.path)
    let seeded
    try {
      seeded = seedPublishedResource(dir.path, db, 'res-link', 'link-me')
    } finally {
      db.close()
    }
    const absolute = join(dir.path, seeded.relativePath)
    rmSync(absolute)
    symlinkSync(join(dir.path, 'outside-target.bin'), absolute)
    writeFileSync(join(dir.path, 'outside-target.bin'), 'elsewhere')
    const report = verifyStore(dir.path)
    assert.equal(report.entries[0].status, 'not-regular-file', 'verification never follows a recorded symlink')
  } finally {
    dir.dispose()
  }
})

test('a store written by a newer build reports unavailable and refuses open', () => {
  const dir = trackedTmpDir('recovery-future')
  try {
    const steps = [
      ...STORE_MIGRATION_STEPS,
      { from: 6, to: 7, name: 'future-step', up: db => db.exec('CREATE TABLE future_build (x TEXT)') },
    ]
    migrateStore(dir.path, { steps })
    const report = verifyStore(dir.path)
    assert.equal(report.store, 'unavailable-future-version')
    assert.equal(report.storeSchemaVersion, null)
    assert.deepEqual(report.entries, [], 'a store this build cannot open reports no entries')
    assert.throws(() => openStoreDatabase(storeDbPath(dir.path)), error => error instanceof StorageError && error.code === 'future-schema-version')
    // With the future build's ceiling the same store verifies normally.
    const withCeiling = verifyStore(dir.path, { supportedSchemaVersion: 7 })
    assert.equal(withCeiling.store, 'ok')
  } finally {
    dir.dispose()
  }
})

test('fork-protected references survive as store rows independent of session logs', () => {
  const dir = trackedTmpDir('recovery-fork')
  try {
    const db = freshStore(dir.path)
    try {
      seedPublishedResource(dir.path, db, 'res-fork', 'evidence-bytes')
      db.prepare('INSERT INTO session_refs (session_id, parent_session_id) VALUES (?, ?)').run('child-session', 'parent-session')
      db.prepare('INSERT INTO export_refs (session_id, export_id, target_kind, target_id) VALUES (?, ?, ?, ?)')
        .run('child-session', 'export-child', 'resource', 'res-fork')
    } finally {
      db.close()
    }
    const reopened = openStoreDatabase(storeDbPath(dir.path))
    try {
      // The parent session has no row of its own: the child's edge alone
      // resolves, which is what a restore of a fork without its parent keeps.
      assert.deepEqual(protectorsOf(reopened, { kind: 'resource', id: 'res-fork' }).map(row => row.kind), ['export'])
      assert.equal(existsSync(storeDbPath(dir.path)), true)
    } finally {
      reopened.close()
    }
    const report = verifyStore(dir.path)
    assert.deepEqual(report.summary, { ok: 1, unavailable: 0 })
  } finally {
    dir.dispose()
  }
})
