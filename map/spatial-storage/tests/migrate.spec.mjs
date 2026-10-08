/**
 * Migration runner gates: the forward ladder preserves rows and records
 * journal evidence, re-runs are byte-level no-ops, dry-runs write nothing,
 * a failing step rolls back whole, backup-before-write snapshots a readable
 * pre-state, a SIGKILLed child mid-step recovers on the next open, and a
 * future schema version refuses instead of downgrading. Fixtures extend the
 * production list with test steps so the runner's real code path does the
 * work; the production list currently ends at the published-version-gc version.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256File } from '../src/checksum.ts'
import { StorageError } from '../src/errors.ts'
import { dryRunStoreMigration, migrateStore, planStoreMigration } from '../src/migrate.ts'
import {
  createStoreRoot,
  openStoreDatabase,
  SPATIAL_STORE_SCHEMA_VERSION,
  STORE_MIGRATION_STEPS,
  storeDbPath,
  storeSchemaVersion,
} from '../src/schema.ts'
import { trackedTmpDir } from './support.mjs'

/** The fixture ladder: the production list plus two test successor steps. */
function fixtureSteps() {
  return [
    ...STORE_MIGRATION_STEPS,
    { from: 6, to: 7, name: 'fixture-analysis-table', up: db => db.exec('CREATE TABLE fixture_v6 (id TEXT PRIMARY KEY, note TEXT NOT NULL)') },
    { from: 7, to: 8, name: 'fixture-analysis-column', up: db => db.exec('ALTER TABLE fixture_v6 ADD COLUMN extra TEXT') },
  ]
}

function seedIntent(db, operationRef) {
  db.prepare('INSERT INTO intents (operation_ref, session_id, source_call_seq, request_digest, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(operationRef, 'session-a', 7, `digest-${operationRef}`, 'pending', '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z')
}

test('fresh store applies the full ladder: version, journal row, and every owned table exist', () => {
  const dir = trackedTmpDir('migrate-fresh')
  try {
    const report = migrateStore(dir.path)
    assert.deepEqual(report.applied, [
      { from: 0, to: 1, name: 'baseline' },
      { from: 1, to: 2, name: 'p0b-catalog-chain' },
      { from: 2, to: 3, name: 'spatial-governance' },
      { from: 3, to: 4, name: 'semantic-index' },
      { from: 4, to: 5, name: 'published-version-gc' },
      { from: 5, to: 6, name: 'governance-tenant-recall' },
    ])
    assert.equal(report.alreadyCurrent, false)
    assert.ok(report.beforeChecksum !== null && report.afterChecksum !== null)
    assert.equal(report.backup, null, 'a fresh store has no pre-state to back up')
    const db = openStoreDatabase(storeDbPath(dir.path))
    try {
      assert.equal(storeSchemaVersion(db), SPATIAL_STORE_SCHEMA_VERSION)
      for (const table of [
        'catalog_resources', 'artifacts', 'intents', 'streams', 'session_refs',
        'map_refs', 'report_refs', 'export_refs', 'job_refs', 'backup_pins',
        'leases', 'staging', 'feature_refs', 'semantic_bindings',
        'governance_acl', 'governance_audit',
        'governance_copies', 'governance_recall',
        'semantic_definitions', 'semantic_aliases',
        'reader_pins', 'released_versions',
      ]) {
        assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), `table ${table} exists`)
      }
      const journal = db.prepare('SELECT to_version, from_version, name FROM migration_journal').all()
        .map(row => ({ to_version: row.to_version, from_version: row.from_version, name: row.name }))
      assert.deepEqual(journal, [
        { to_version: 1, from_version: 0, name: 'baseline' },
        { to_version: 2, from_version: 1, name: 'p0b-catalog-chain' },
        { to_version: 3, from_version: 2, name: 'spatial-governance' },
        { to_version: 4, from_version: 3, name: 'semantic-index' },
        { to_version: 5, from_version: 4, name: 'published-version-gc' },
        { to_version: 6, from_version: 5, name: 'governance-tenant-recall' },
      ])
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('forward migration preserves rows, records journal entries, and backs up the pre-state', () => {
  const dir = trackedTmpDir('migrate-forward')
  try {
    migrateStore(dir.path)
    const db = openStoreDatabase(storeDbPath(dir.path))
    try {
      seedIntent(db, 'op-1')
    } finally {
      db.close()
    }
    const before = sha256File(storeDbPath(dir.path))

    const report = migrateStore(dir.path, { steps: fixtureSteps() })
    assert.deepEqual(report.applied, [
      { from: 6, to: 7, name: 'fixture-analysis-table' },
      { from: 7, to: 8, name: 'fixture-analysis-column' },
    ])
    assert.notEqual(report.afterChecksum, before, 'the run rewrote the database file')
    assert.notEqual(report.backup, null)
    assert.equal(report.backup.sha256, sha256File(report.backup.path), 'the backup record digests the snapshot file')

    const upgraded = openStoreDatabase(storeDbPath(dir.path), { supportedSchemaVersion: 8 })
    try {
      assert.equal(storeSchemaVersion(upgraded), 8)
      const intent = upgraded.prepare('SELECT state FROM intents WHERE operation_ref = ?').get('op-1')
      assert.deepEqual({ state: intent.state }, { state: 'pending' }, 'rows survive the whole ladder')
      upgraded.prepare('INSERT INTO fixture_v6 (id, note, extra) VALUES (?, ?, ?)').run('a', 'n', 'e')
      const journal = upgraded.prepare('SELECT to_version, name FROM migration_journal ORDER BY to_version').all()
        .map(row => ({ to_version: row.to_version, name: row.name }))
      assert.deepEqual(journal, [
        { to_version: 1, name: 'baseline' },
        { to_version: 2, name: 'p0b-catalog-chain' },
        { to_version: 3, name: 'spatial-governance' },
        { to_version: 4, name: 'semantic-index' },
        { to_version: 5, name: 'published-version-gc' },
        { to_version: 6, name: 'governance-tenant-recall' },
        { to_version: 7, name: 'fixture-analysis-table' },
        { to_version: 8, name: 'fixture-analysis-column' },
      ])
    } finally {
      upgraded.close()
    }
    assert.ok(existsSync(report.backup.path))
    const snapshot = openStoreDatabase(report.backup.path)
    try {
      assert.equal(storeSchemaVersion(snapshot), 6, 'the backup stays at the pre-migration version')
      assert.ok(snapshot.prepare('SELECT 1 FROM intents WHERE operation_ref = ?').get('op-1'))
    } finally {
      snapshot.close()
    }
  } finally {
    dir.dispose()
  }
})

test('re-running a current migration is a byte-level no-op', () => {
  const dir = trackedTmpDir('migrate-idempotent')
  try {
    migrateStore(dir.path, { steps: fixtureSteps() })
    const before = sha256File(storeDbPath(dir.path))
    const again = migrateStore(dir.path, { steps: fixtureSteps() })
    assert.equal(again.alreadyCurrent, true)
    assert.deepEqual(again.applied, [])
    assert.equal(again.beforeChecksum, null)
    assert.equal(again.afterChecksum, null)
    assert.equal(again.backup, null)
    assert.equal(sha256File(storeDbPath(dir.path)), before, 'the no-op run must not touch the file')
  } finally {
    dir.dispose()
  }
})

test('dry-run lists pending steps through a read-only connection and writes nothing', () => {
    const dir = trackedTmpDir('migrate-dryrun')
  try {
    migrateStore(dir.path)
    const before = sha256File(storeDbPath(dir.path))
    const plan = dryRunStoreMigration(storeDbPath(dir.path), { steps: fixtureSteps() })
    assert.equal(plan.current, 6)
    assert.equal(plan.target, 8)
    assert.deepEqual(plan.pending.map(step => step.to), [7, 8])
    assert.equal(sha256File(storeDbPath(dir.path)), before, 'the dry run must not touch the file')
    const live = openStoreDatabase(storeDbPath(dir.path))
    try {
      assert.deepEqual(planStoreMigration(live, fixtureSteps()).pending.length, 2)
    } finally {
      live.close()
    }
  } finally {
    dir.dispose()
  }
})

test('a failing step rolls back whole: version, journal, and prior steps stay intact', () => {
  const dir = trackedTmpDir('migrate-rollback')
  try {
    migrateStore(dir.path)
    migrateStore(dir.path, {
      steps: [
        ...STORE_MIGRATION_STEPS,
        { from: 6, to: 7, name: 'fixture-good', up: db => db.exec('CREATE TABLE fixture_v6 (id TEXT PRIMARY KEY)') },
        {
          from: 7,
          to: 8,
          name: 'fixture-boom',
          up: db => {
            db.exec('CREATE TABLE boom (x TEXT)')
            throw new Error('injected step failure')
          },
        },
      ],
    })
    assert.fail('the failing migration must propagate')
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.match(error.message, /injected step failure/)
  }
  const db = openStoreDatabase(storeDbPath(dir.path), { supportedSchemaVersion: 8 })
  try {
    assert.equal(storeSchemaVersion(db), 7, 'the store keeps the last committed step')
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fixture_v6'").get(), 'the committed step stays')
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'boom'").get(), undefined, 'the failed step leaves nothing')
    assert.deepEqual(
      db.prepare('SELECT to_version FROM migration_journal ORDER BY to_version').all().map(row => row.to_version),
      [1, 2, 3, 4, 5, 6, 7],
    )
  } finally {
    db.close()
  }
  // A repaired re-run completes from the recorded version and snapshots the
  // v4 pre-state first.
  const repaired = migrateStore(dir.path, {
    steps: [
      ...STORE_MIGRATION_STEPS,
      { from: 6, to: 7, name: 'fixture-good', up: db => db.exec('CREATE TABLE IF NOT EXISTS fixture_v6 (id TEXT PRIMARY KEY)') },
      { from: 7, to: 8, name: 'fixture-fixed', up: db => db.exec('CREATE TABLE fixed (x TEXT)') },
    ],
  })
  assert.deepEqual(repaired.applied, [{ from: 7, to: 8, name: 'fixture-fixed' }])
  assert.ok(repaired.backup !== null)
  assert.equal(storeSchemaVersion(openStoreDatabase(storeDbPath(dir.path), { supportedSchemaVersion: 8 })), 8)
})

test('a SIGKILLed child mid-step rolls the step back; a re-run completes the ladder', () => {
  const dir = trackedTmpDir('migrate-crash')
  try {
    migrateStore(dir.path)
    const db = openStoreDatabase(storeDbPath(dir.path), { supportedSchemaVersion: 8 })
    try {
      seedIntent(db, 'op-crash')
    } finally {
      db.close()
    }
    // The child runs the real runner and dies by SIGKILL inside the v5
    // step's open transaction: SQLite's rollback journal must undo the step
    // on the next open, leaving the committed prefix intact.
    const childScript = [
      `import { migrateStore } from '${new URL('../src/migrate.ts', import.meta.url).href}'`,
      `import { STORE_MIGRATION_STEPS } from '${new URL('../src/schema.ts', import.meta.url).href}'`,
      'const steps = [',
      '  ...STORE_MIGRATION_STEPS,',
      "  { from: 6, to: 7, name: 'fixture-v5', up: db => db.exec('CREATE TABLE fixture_v6 (id TEXT PRIMARY KEY)') },",
      "  { from: 7, to: 8, name: 'fixture-crash', up: db => {",
      "    db.exec('CREATE TABLE crash_probe (x TEXT)')",
      "    process.kill(process.pid, 'SIGKILL')",
      '  } },',
      ']',
      'const report = migrateStore(process.argv[2], { steps })',
      "console.log('unexpected completion: ' + JSON.stringify(report))",
    ].join('\n')
    const childPath = join(dir.path, 'crash-child.mjs')
    writeFileSync(childPath, `${childScript}\n`)

    const child = spawnSync(process.execPath, ['--experimental-strip-types', childPath, dir.path], { encoding: 'utf8' })
    assert.equal(child.status, null, `the child died by signal (stdout: ${child.stdout.trim()})`)
    assert.equal(child.signal, 'SIGKILL')

    const after = openStoreDatabase(storeDbPath(dir.path), { supportedSchemaVersion: 8 })
    try {
      assert.equal(storeSchemaVersion(after), 7, 'the crash rolls back the killed step to the last commit')
      assert.ok(after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fixture_v6'").get())
      assert.equal(after.prepare("SELECT 1 FROM sqlite_master WHERE name = 'crash_probe'").get(), undefined)
      assert.deepEqual(
        after.prepare('SELECT to_version FROM migration_journal ORDER BY to_version').all().map(row => row.to_version),
        [1, 2, 3, 4, 5, 6, 7],
        'the journal never records the uncommitted step',
      )
      assert.ok(after.prepare('SELECT 1 FROM intents WHERE operation_ref = ?').get('op-crash'))
    } finally {
      after.close()
    }

    const resumed = migrateStore(dir.path, {
      steps: [
        ...STORE_MIGRATION_STEPS,
        { from: 6, to: 7, name: 'fixture-v5', up: db => db.exec('CREATE TABLE IF NOT EXISTS fixture_v6 (id TEXT PRIMARY KEY)') },
        { from: 7, to: 8, name: 'fixture-crash', up: db => db.exec('CREATE TABLE crash_probe (x TEXT)') },
      ],
    })
    assert.deepEqual(resumed.applied, [{ from: 7, to: 8, name: 'fixture-crash' }])
    const done = openStoreDatabase(storeDbPath(dir.path), { supportedSchemaVersion: 8 })
    try {
      assert.equal(storeSchemaVersion(done), 8)
      assert.ok(done.prepare('SELECT 1 FROM intents WHERE operation_ref = ?').get('op-crash'), 'the seeded row survives crash plus resume')
    } finally {
      done.close()
    }
  } finally {
    dir.dispose()
  }
})

test('a failed run leaves its pre-migration backup on disk for manual recovery', () => {
  const dir = trackedTmpDir('migrate-backup-rollback')
  try {
    migrateStore(dir.path)
    const db = openStoreDatabase(storeDbPath(dir.path))
    try {
      seedIntent(db, 'op-snapshot')
    } finally {
      db.close()
    }
    const before = sha256File(storeDbPath(dir.path))
    assert.throws(
      () => migrateStore(dir.path, {
        steps: [...STORE_MIGRATION_STEPS, { from: 6, to: 7, name: 'fails', up: () => { throw new Error('stop after backup') } }],
      }),
      /stop after backup/,
    )
    const backups = readdirSync(join(dir.path, 'backups')).filter(name => name.startsWith('pre-migration-v6-'))
    assert.equal(backups.length, 1, `exactly one pre-migration snapshot exists (saw ${JSON.stringify(backups)})`)
    const snapshot = openStoreDatabase(join(dir.path, 'backups', backups[0]))
    try {
      assert.equal(storeSchemaVersion(snapshot), 6, 'the snapshot is at the pre-run version')
      assert.ok(snapshot.prepare('SELECT 1 FROM intents WHERE operation_ref = ?').get('op-snapshot'), 'the snapshot holds the pre-run rows')
    } finally {
      snapshot.close()
    }
    assert.equal(sha256File(storeDbPath(dir.path)), before, 'the failed run left the store itself untouched')
  } finally {
    dir.dispose()
  }
})

test('a store newer than the migration target refuses instead of downgrading', () => {
  const dir = trackedTmpDir('migrate-future')
  try {
    migrateStore(dir.path, { steps: fixtureSteps() })
    assert.throws(() => migrateStore(dir.path), error => error instanceof StorageError && error.code === 'future-schema-version')
    assert.throws(
      () => migrateStore(dir.path, { steps: [...STORE_MIGRATION_STEPS, { from: 6, to: 7, name: 'down', up: () => {} }] }),
      error => error instanceof StorageError && error.code === 'future-schema-version',
    )
    assert.throws(() => dryRunStoreMigration(storeDbPath(dir.path)), error => error instanceof StorageError && error.code === 'future-schema-version')
    assert.throws(() => openStoreDatabase(storeDbPath(dir.path)), error => error instanceof StorageError && error.code === 'future-schema-version')
    assert.equal(storeSchemaVersion(openStoreDatabase(storeDbPath(dir.path), { supportedSchemaVersion: 8 })), 8)
  } finally {
    dir.dispose()
  }
})

test('store roots are created owner-only and an existing database keeps its mode', () => {
  const dir = trackedTmpDir('migrate-modes')
  try {
    const root = join(dir.path, 'nested', 'store')
    migrateStore(root)
    for (const part of ['files', 'staging', 'backups', 'trash']) {
      assert.ok(existsSync(join(root, part)), `${part}/ exists`)
    }
    const dbPath = storeDbPath(root)
    assert.equal((statSync(dbPath).mode & 0o777).toString(8), '600', 'the database file is owner-only')
    // Re-creating the root over an existing store keeps the existing mode.
    createStoreRoot(root)
    assert.equal((statSync(dbPath).mode & 0o777).toString(8), '600', 're-creating the root keeps the existing mode')
  } finally {
    dir.dispose()
  }
})

test('the 5->6 step backfills the migrating tenant without rewriting grant history', () => {
  const dir = trackedTmpDir('migrate-tenant-backfill')
  try {
    // Seed one v5 store with real governance rows.
    migrateStore(dir.path, { steps: STORE_MIGRATION_STEPS.slice(0, 5) })
    const seed = openStoreDatabase(storeDbPath(dir.path), { supportedSchemaVersion: 5 })
    try {
      seed.prepare(
        "INSERT INTO governance_acl (object_kind, ref, domain, state, grant_version, updated_at) VALUES ('resource', 'res-a@v1', 'local', 'granted', 4, '2026-10-07T00:00:00.000Z')",
      ).run()
      seed.prepare(
        "INSERT INTO governance_audit (audit_id, at, subject_id, session_id, object_kind, ref, resource_version, operation, decision, reason_code, domain, grant_version) VALUES ('a-1', '2026-10-07T00:00:01.000Z', 'host', 's-1', 'resource', 'res-a@v1', 1, 'read', 'allowed', 'GOVERNANCE_ALLOWED', 'local', 4)",
      ).run()
    } finally {
      seed.close()
    }

    const report = migrateStore(dir.path, { tenant: 'acme' })
    assert.deepEqual(report.applied, [{ from: 5, to: 6, name: 'governance-tenant-recall' }])

    const db = openStoreDatabase(storeDbPath(dir.path))
    try {
      assert.equal(storeSchemaVersion(db), 6)
      // The grant row is byte-for-byte the same fact, now scoped to the
      // migrating tenant: state, version, and timestamp are never rewritten.
      const grant = db.prepare('SELECT tenant, object_kind, ref, domain, state, grant_version, updated_at FROM governance_acl').get()
      assert.equal(grant.tenant, 'acme')
      assert.equal(grant.object_kind, 'resource')
      assert.equal(grant.ref, 'res-a@v1')
      assert.equal(grant.domain, 'local')
      assert.equal(grant.state, 'granted')
      assert.equal(grant.grant_version, 4)
      assert.equal(grant.updated_at, '2026-10-07T00:00:00.000Z')
      // The audit trail keeps its sequence and facts; only the tenant column
      // is added and backfilled.
      const audit = db.prepare('SELECT audit_seq, tenant, audit_id, reason_code, grant_version FROM governance_audit').get()
      assert.equal(audit.audit_seq, 1)
      assert.equal(audit.tenant, 'acme')
      assert.equal(audit.audit_id, 'a-1')
      assert.equal(audit.reason_code, 'GOVERNANCE_ALLOWED')
      assert.equal(audit.grant_version, 4)
      // The recall address book exists empty and deduplicates by holder.
      db.prepare(
        "INSERT INTO governance_copies (tenant, object_kind, ref, channel, holder, registered_at) VALUES ('acme', 'resource', 'res-a@v1', 'context', 's-1', '2026-10-07T00:00:02.000Z')",
      ).run()
      assert.throws(
        () => db.prepare(
          "INSERT INTO governance_copies (tenant, object_kind, ref, channel, holder, registered_at) VALUES ('acme', 'resource', 'res-a@v1', 'context', 's-1', '2026-10-07T00:00:03.000Z')",
        ).run(),
        /UNIQUE constraint failed/,
        'registering the same copy twice is idempotent at the schema level',
      )
      // The migrated store stays fully usable: new grants write under the
      // tenant-keyed primary key without lockout.
      db.prepare(
        "INSERT INTO governance_acl (tenant, object_kind, ref, domain, state, grant_version, updated_at) VALUES ('acme', 'resource', 'res-b@v1', 'local', 'granted', 1, '2026-10-07T00:00:04.000Z')",
      ).run()
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM governance_acl').get().n, 2)
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('a fresh store migrated with a named tenant lands every governance row under it', () => {
  const dir = trackedTmpDir('migrate-tenant-fresh')
  try {
    migrateStore(dir.path, { tenant: 'beta' })
    const db = openStoreDatabase(storeDbPath(dir.path))
    try {
      assert.equal(storeSchemaVersion(db), 6)
      db.prepare(
        "INSERT INTO governance_audit (tenant, audit_id, at, subject_id, session_id, object_kind, ref, resource_version, operation, decision, reason_code, domain, grant_version) VALUES ('beta', 'a-2', '2026-10-07T00:00:00.000Z', 'host', NULL, 'session', 's-1', NULL, 'open', 'allowed', 'GOVERNANCE_ALLOWED', 'local', NULL)",
      ).run()
      assert.equal(db.prepare('SELECT audit_seq FROM governance_audit').get().audit_seq, 1, 'the rebuilt AUTOINCREMENT sequence starts fresh')
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('a SIGKILL inside the 5->6 step rolls the rebuild back whole', () => {
  const dir = trackedTmpDir('migrate-tenant-crash')
  try {
    migrateStore(dir.path, { steps: STORE_MIGRATION_STEPS.slice(0, 5) })
    const seed = openStoreDatabase(storeDbPath(dir.path), { supportedSchemaVersion: 5 })
    try {
      seed.prepare(
        "INSERT INTO governance_acl (object_kind, ref, domain, state, grant_version, updated_at) VALUES ('resource', 'res-a@v1', 'local', 'granted', 2, '2026-10-07T00:00:00.000Z')",
      ).run()
    } finally {
      seed.close()
    }
    const recallStep = STORE_MIGRATION_STEPS.find(step => step.name === 'governance-tenant-recall')
    assert.ok(recallStep !== undefined, 'the production ladder carries the tenant-recall step')
    const childScript = [
      `import { migrateStore } from '${new URL('../src/migrate.ts', import.meta.url).href}'`,
      `import { STORE_MIGRATION_STEPS } from '${new URL('../src/schema.ts', import.meta.url).href}'`,
      'const recall = STORE_MIGRATION_STEPS.find(step => step.name === \'governance-tenant-recall\')',
      "if (recall === undefined) throw new Error('production ladder missing the tenant-recall step')",
      'const steps = [',
      '  ...STORE_MIGRATION_STEPS.slice(0, 5),',
      "  { from: 5, to: 6, name: recall.name, up: (db, context) => { recall.up(db, context); process.kill(process.pid, 'SIGKILL') } },",
      ']',
      "migrateStore(process.argv[2], { steps, tenant: 'acme' })",
      "console.log('unexpected completion')",
    ].join('\n')
    const childPath = join(dir.path, 'crash-child.mjs')
    writeFileSync(childPath, `${childScript}\n`)
    const child = spawnSync(process.execPath, ['--experimental-strip-types', childPath, dir.path], { encoding: 'utf8' })
    assert.equal(child.signal, 'SIGKILL')

    const after = openStoreDatabase(storeDbPath(dir.path), { supportedSchemaVersion: 5 })
    try {
      assert.equal(storeSchemaVersion(after), 5, 'the killed rebuild leaves the store at v5')
      const grant = after.prepare('SELECT object_kind, ref, domain, state, grant_version FROM governance_acl').get()
      assert.equal(grant.object_kind, 'resource')
      assert.equal(grant.ref, 'res-a@v1')
      assert.equal(grant.domain, 'local')
      assert.equal(grant.state, 'granted')
      assert.equal(grant.grant_version, 2)
      assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'governance_copies'").get().n, 0, 'the new tables rolled back too')
    } finally {
      after.close()
    }
    // The recovered re-run completes the step under the named tenant.
    const resumed = migrateStore(dir.path, { tenant: 'acme' })
    assert.deepEqual(resumed.applied, [{ from: 5, to: 6, name: 'governance-tenant-recall' }])
    const done = openStoreDatabase(storeDbPath(dir.path))
    try {
      assert.equal(done.prepare('SELECT tenant FROM governance_acl').get().tenant, 'acme')
    } finally {
      done.close()
    }
  } finally {
    dir.dispose()
  }
})
