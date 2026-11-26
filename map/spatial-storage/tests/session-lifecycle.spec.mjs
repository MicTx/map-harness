/**
 * Per-session lifecycle gates: a conversation's first use creates its whole
 * library layout, a SIGKILLed child mid-upgrade rolls that library's step
 * back without touching a neighbor, the recovery sweep reports per library
 * (damage in one conversation never marks another), staging/orphan cleanup
 * runs inside one library only, and the retention policy holds by default
 * (nothing is ever dropped automatically) while the explicit drop is the
 * only removal path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256File } from '../src/checksum.ts'
import { acquireLease, releaseLease } from '../src/leases.ts'
import { executeCleanup, planCleanup, registerStaging, releaseStaging } from '../src/cleanup.ts'
import { migrateStore } from '../src/migrate.ts'
import { openStoreDatabase, STORE_DB_NAME, STORE_MIGRATION_STEPS, storeDbPath, STORE_DIRS, storeSchemaVersion } from '../src/schema.ts'
import { verifyStore } from '../src/recovery.ts'
import { dropSessionStore, listSessionStores, sessionStoreRoot } from '../src/sessions.ts'
import { seedPublishedResource } from './support.mjs'
import { trackedTmpDir } from './support.mjs'

test('a session\'s first use creates the complete library layout in one step', () => {
  const dir = trackedTmpDir('session-lifecycle-first-use')
  try {
    const root = sessionStoreRoot(dir.path, 'sess-first')
    assert.equal(existsSync(root), false)
    migrateStore(root)
    for (const owned of [STORE_DB_NAME, ...STORE_DIRS]) {
      assert.equal(existsSync(join(root, owned)), true, `first use creates ${owned}`)
    }
    assert.deepEqual(listSessionStores(dir.path).map(entry => entry.sessionId), ['sess-first'])
  } finally {
    dir.dispose()
  }
})

test('a SIGKILLed upgrade inside one library rolls back there and leaves the neighbor intact', () => {
  const dir = trackedTmpDir('session-lifecycle-crash')
  try {
    const rootA = sessionStoreRoot(dir.path, 'sess-crash')
    const rootB = sessionStoreRoot(dir.path, 'sess-quiet')
    migrateStore(rootA)
    migrateStore(rootB)
    const checksumB = sha256File(storeDbPath(rootB))

    // The child runs the real runner against session A's library only and
    // dies by SIGKILL inside the crash step's open transaction.
    const childScript = [
      `import { migrateStore } from '${new URL('../src/migrate.ts', import.meta.url).href}'`,
      `import { STORE_MIGRATION_STEPS } from '${new URL('../src/schema.ts', import.meta.url).href}'`,
      `import { sessionStoreRoot } from '${new URL('../src/sessions.ts', import.meta.url).href}'`,
      'const steps = [',
      '  ...STORE_MIGRATION_STEPS,',
      "  { from: 6, to: 7, name: 'fixture-v5', up: db => db.exec('CREATE TABLE fixture_v6 (id TEXT PRIMARY KEY)') },",
      "  { from: 7, to: 8, name: 'fixture-crash', up: db => {",
      "    db.exec('CREATE TABLE crash_probe (x TEXT)')",
      "    process.kill(process.pid, 'SIGKILL')",
      '  } },',
      ']',
      'const report = migrateStore(sessionStoreRoot(process.argv[2], process.argv[3]), { steps })',
      "console.log('unexpected completion: ' + JSON.stringify(report))",
    ].join('\n')
    const childPath = join(dir.path, 'crash-child.mjs')
    writeFileSync(childPath, `${childScript}\n`)

    const child = spawnSync(process.execPath, ['--experimental-strip-types', childPath, dir.path, 'sess-crash'], { encoding: 'utf8' })
    assert.equal(child.status, null, `the child died by signal (stdout: ${child.stdout.trim()})`)
    assert.equal(child.signal, 'SIGKILL')

    const db = openStoreDatabase(storeDbPath(rootA), { supportedSchemaVersion: 8 })
    try {
      assert.equal(storeSchemaVersion(db), 7, 'the killed step rolled back to the last commit')
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'crash_probe'").get(), undefined)
      // A re-run continues from the recorded version and completes the ladder.
      const resumed = migrateStore(rootA, {
        steps: [
          ...STORE_MIGRATION_STEPS,
          { from: 6, to: 7, name: 'fixture-v5', up: d => d.exec('CREATE TABLE IF NOT EXISTS fixture_v6 (id TEXT PRIMARY KEY)') },
          { from: 7, to: 8, name: 'fixture-resume', up: d => d.exec('ALTER TABLE fixture_v6 ADD COLUMN extra TEXT') },
        ],
      })
      assert.deepEqual(resumed.applied.map(step => step.to), [8], 'the re-run continues from the committed v7')
    } finally {
      db.close()
    }
    // Session B never moved: recovery is scoped to the crashed library.
    assert.equal(sha256File(storeDbPath(rootB)), checksumB)
    const dbBcheck = openStoreDatabase(storeDbPath(rootB))
    try {
      assert.equal(storeSchemaVersion(dbBcheck), 6)
    } finally {
      dbBcheck.close()
    }
  } finally {
    dir.dispose()
  }
})

test('the recovery sweep verifies per library: damage in one session never marks another', () => {
  const dir = trackedTmpDir('session-lifecycle-recovery')
  try {
    const roots = {
      healthy: sessionStoreRoot(dir.path, 'sess-healthy'),
      damaged: sessionStoreRoot(dir.path, 'sess-damaged'),
    }
    for (const root of Object.values(roots)) {
      migrateStore(root)
      const db = openStoreDatabase(storeDbPath(root))
      try {
        seedPublishedResource(root, db, 'res-lifecycle', 'bytes-lifecycle')
      } finally {
        db.close()
      }
    }
    writeFileSync(join(roots.damaged, 'files', 'shared', 'res-lifecycle.blob'), 'tampered')

    const healthy = verifyStore(roots.healthy)
    assert.equal(healthy.store, 'ok')
    assert.equal(healthy.summary.unavailable, 0)
    const damaged = verifyStore(roots.damaged)
    assert.equal(damaged.store, 'ok')
    assert.equal(damaged.summary.unavailable, 1, 'the tampered entry reports digest-mismatch in its own library')
    assert.equal(damaged.entries[0].status, 'digest-mismatch')
  } finally {
    dir.dispose()
  }
})

test('staging and orphan cleanup run inside one library only', () => {
  const dir = trackedTmpDir('session-lifecycle-cleanup')
  try {
    const rootA = sessionStoreRoot(dir.path, 'sess-clean')
    const rootB = sessionStoreRoot(dir.path, 'sess-keep')
    for (const root of [rootA, rootB]) migrateStore(root)
    const dbA = openStoreDatabase(storeDbPath(rootA))
    const dbB = openStoreDatabase(storeDbPath(rootB))
    try {
      // Session A releases one staging row and leaves one orphan byte; both
      // are cleanup candidates inside A's library only.
      const stagingId = registerStaging(dbA, { relativePath: 'staging/a-done.bin' })
      writeFileSync(join(rootA, 'staging', 'a-done.bin'), 'done')
      releaseStaging(dbA, stagingId)
      writeFileSync(join(rootA, 'files', 'orphan-a.bin'), 'orphan')
      // Session B holds one active staging row: never a candidate.
      registerStaging(dbB, { relativePath: 'staging/b-active.bin' })
      writeFileSync(join(rootB, 'staging', 'b-active.bin'), 'active')

      const lease = acquireLease(dbA, { scope: 'cleanup', owner: 'a-cleaner', ttlMs: 60_000 })
      const results = executeCleanup(rootA, dbA, planCleanup(rootA, dbA), { leaseId: lease.leaseId })
      releaseLease(dbA, lease.leaseId)
      assert.deepEqual(
        results.filter(entry => entry.action === 'deleted').map(entry => entry.target).sort(),
        ['files/orphan-a.bin', 'staging/a-done.bin'],
        'the released staging row and the orphan are collected inside A',
      )
      assert.equal(existsSync(join(rootB, 'staging', 'b-active.bin')), true, "B's active write is untouched")
      assert.equal(dbB.prepare('SELECT COUNT(*) AS n FROM staging').get().n, 1, "B's staging row survives A's cleanup")
    } finally {
      dbA.close()
      dbB.close()
    }
  } finally {
    dir.dispose()
  }
})

test('retention: sessions are kept by default; the explicit drop is the only removal', () => {
  const dir = trackedTmpDir('session-lifecycle-retention')
  try {
    const ids = ['sess-r1', 'sess-r2', 'sess-r3']
    for (const id of ids) migrateStore(sessionStoreRoot(dir.path, id))
    // Nothing runs automatically: repeated opens, listings, and recovery
    // sweeps never remove a library.
    for (const id of ids) migrateStore(sessionStoreRoot(dir.path, id))
    for (const id of ids) verifyStore(sessionStoreRoot(dir.path, id))
    assert.deepEqual(listSessionStores(dir.path).map(entry => entry.sessionId), ids)
    // The explicit drop removes exactly the named conversation.
    dropSessionStore(dir.path, 'sess-r2')
    assert.deepEqual(listSessionStores(dir.path).map(entry => entry.sessionId), ['sess-r1', 'sess-r3'])
    assert.equal(existsSync(sessionStoreRoot(dir.path, 'sess-r2')), false)
  } finally {
    dir.dispose()
  }
})
