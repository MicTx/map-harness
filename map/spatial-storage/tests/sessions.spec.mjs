/**
 * Per-session store layout gates: the session id is validated at the file
 * boundary before it ever names a directory, every session library gets the
 * same migration/backup/checksum discipline independently (one library's
 * upgrade never touches a neighbor), and the root manifest derives from the
 * `sessions/` directory while the explicit drop is the only removal path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StorageError } from '../src/errors.ts'
import { sha256File } from '../src/checksum.ts'
import { dryRunStoreMigration, migrateStore } from '../src/migrate.ts'
import { openStoreDatabase, STORE_MIGRATION_STEPS, storeDbPath, storeSchemaVersion } from '../src/schema.ts'
import { assertValidSessionId, dropSessionStore, listSessionStores, sessionStoreRoot } from '../src/sessions.ts'
import { trackedTmpDir } from './support.mjs'

test('the session root lands under sessions/ and refuses ids that cannot name a directory', () => {
  const dir = trackedTmpDir('sessions-path')
  try {
    assert.equal(sessionStoreRoot(dir.path, 'sess-001'), join(dir.path, 'sessions', 'sess-001'))
    for (const bad of ['', '..', '.', '../escape', 'a/b', '/abs', 'a\\b', 'a b', '.hidden', 'x'.repeat(129), 'sess\nid']) {
      assert.throws(() => sessionStoreRoot(dir.path, bad), (error) => error instanceof StorageError && error.code === 'invalid-session-id', `id ${JSON.stringify(bad)} refuses`)
      assert.throws(() => assertValidSessionId(bad), /cannot name a session store/)
    }
    for (const good of ['s', 'A9', 'sess.001_x-y', '20260926T000000Z', 'x'.repeat(128)]) {
      assertValidSessionId(good)
    }
  } finally {
    dir.dispose()
  }
})

test('each session library carries the full migration ladder with per-library evidence', () => {
  const dir = trackedTmpDir('sessions-migrate')
  try {
    for (const sessionId of ['sess-a', 'sess-b']) {
      const root = sessionStoreRoot(dir.path, sessionId)
      const report = migrateStore(root)
      assert.equal(report.alreadyCurrent, false)
      assert.deepEqual(report.applied.map(step => step.name), STORE_MIGRATION_STEPS.map(step => step.name))
      assert.ok(report.afterChecksum !== null && report.beforeChecksum !== null)
      assert.equal(report.backup, null, 'a fresh session library has no pre-state to back up')
      const db = openStoreDatabase(storeDbPath(root))
      try {
        assert.equal(storeSchemaVersion(db), 6)
      } finally {
        db.close()
      }
      // The re-run is a per-library no-op.
      const again = migrateStore(root)
      assert.equal(again.alreadyCurrent, true)
      assert.equal(again.applied.length, 0)
    }
    // Two independent database files, one per session, nothing at the root.
    assert.equal(existsSync(join(dir.path, 'store.db')), false)
    assert.equal(existsSync(join(dir.path, 'sessions', 'sess-a', 'store.db')), true)
    assert.equal(existsSync(join(dir.path, 'sessions', 'sess-b', 'store.db')), true)
  } finally {
    dir.dispose()
  }
})

test('a per-library upgrade takes backup-before-write and leaves the neighbor untouched', () => {
  const dir = trackedTmpDir('sessions-upgrade')
  try {
    const stepsA = STORE_MIGRATION_STEPS.slice(0, 1)
    const rootA = sessionStoreRoot(dir.path, 'sess-old')
    migrateStore(rootA, { steps: stepsA })
    const rootB = sessionStoreRoot(dir.path, 'sess-new')
    migrateStore(rootB)
    const checksumB = sha256File(storeDbPath(rootB))

    const plan = dryRunStoreMigration(storeDbPath(rootA))
    assert.deepEqual(plan.pending.map(step => step.name), ['p0b-catalog-chain', 'spatial-governance', 'semantic-index', 'published-version-gc', 'governance-tenant-recall'])
    const report = migrateStore(rootA)
    assert.equal(report.backup !== null, true, 'an existing library is snapshotted before the first write')
    assert.equal(existsSync(report.backup.path), true)
    assert.equal(report.backup.sha256.length, 64)

    // The neighbor's bytes never moved.
    assert.equal(sha256File(storeDbPath(rootB)), checksumB)
    const dbA = openStoreDatabase(storeDbPath(rootA))
    try {
        assert.equal(storeSchemaVersion(dbA), 6)
    } finally {
      dbA.close()
    }
  } finally {
    dir.dispose()
  }
})

test('the root manifest derives from sessions/ and skips foreign entries', () => {
  const dir = trackedTmpDir('sessions-manifest')
  try {
    assert.deepEqual(listSessionStores(dir.path), [], 'an unused root has no session stores')
    const rootA = sessionStoreRoot(dir.path, 'sess-a')
    migrateStore(rootA)
    // A partial first use: a session directory whose database never landed.
    mkdirSync(sessionStoreRoot(dir.path, 'sess-partial'), { recursive: true })
    // Foreign entries the id pattern refuses are listed never, deleted never.
    mkdirSync(join(dir.path, 'sessions', 'weird name'), { recursive: true })
    writeFileSync(join(dir.path, 'sessions', 'plain-file'), 'x')
    const listed = listSessionStores(dir.path)
    assert.deepEqual(listed.map(entry => entry.sessionId), ['sess-a', 'sess-partial'])
    assert.equal(listed[0].hasDatabase, true)
    assert.equal(listed[1].hasDatabase, false)
  } finally {
    dir.dispose()
  }
})

test('dropSessionStore removes exactly one library through trash and refuses the absent', () => {
  const dir = trackedTmpDir('sessions-drop')
  try {
    const rootA = sessionStoreRoot(dir.path, 'sess-a')
    const rootB = sessionStoreRoot(dir.path, 'sess-b')
    migrateStore(rootA)
    migrateStore(rootB)
    dropSessionStore(dir.path, 'sess-a')
    assert.equal(existsSync(rootA), false)
    assert.equal(existsSync(rootB), true, 'a drop never touches a neighbor library')
    assert.deepEqual(listSessionStores(dir.path).map(entry => entry.sessionId), ['sess-b'])
    assert.throws(() => dropSessionStore(dir.path, 'sess-a'), (error) => error instanceof StorageError && error.code === 'missing-session-store')
    assert.throws(() => dropSessionStore(dir.path, '../escape'), (error) => error instanceof StorageError && error.code === 'invalid-session-id')
  } finally {
    dir.dispose()
  }
})

test('dropSessionStore unlinks a link-shaped session directory without following it', () => {
  const dir = trackedTmpDir('sessions-drop-link')
  try {
    const target = join(dir.path, 'real-target')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'keep.txt'), 'bytes')
    const linkPath = sessionStoreRoot(dir.path, 'sess-link')
    mkdirSync(join(dir.path, 'sessions'), { recursive: true })
    symlinkSync(target, linkPath)
    dropSessionStore(dir.path, 'sess-link')
    assert.equal(existsSync(linkPath), false, 'the link itself is gone')
    assert.equal(existsSync(join(target, 'keep.txt')), true, 'the link target is untouched')
  } finally {
    dir.dispose()
  }
})

test('a legacy shared database at the root is never read as a session library', () => {
  const dir = trackedTmpDir('sessions-legacy')
  try {
    // A pre-per-session deployment left one shared database at the root.
    migrateStore(dir.path)
    assert.equal(existsSync(join(dir.path, 'store.db')), true)
    // Session libraries still live under sessions/ beside the legacy file.
    const root = sessionStoreRoot(dir.path, 'sess-new')
    migrateStore(root)
    const db = openStoreDatabase(storeDbPath(root))
    try {
        assert.equal(storeSchemaVersion(db), 6)
    } finally {
      db.close()
    }
    assert.deepEqual(listSessionStores(dir.path).map(entry => entry.sessionId), ['sess-new'])
    // The manifest never lists the legacy layout: it is not a session.
    rmSync(join(dir.path, 'store.db'))
    assert.deepEqual(listSessionStores(dir.path).map(entry => entry.sessionId), ['sess-new'])
  } finally {
    dir.dispose()
  }
})
