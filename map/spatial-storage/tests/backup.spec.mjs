/**
 * Backup bundle gates: a bundle publishes only after staging self-verifies;
 * verify refuses tampered, missing, and authorization-gated entries; restore
 * is refused whole on any bad digest; restored layers never overwrite
 * existing bytes; restoring to a fresh location yields a verifying store
 * whose references resolve; and the projection cache plus external job
 * layers are reported as explicitly not restored.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBackup, restoreBackup, verifyBackup } from '../src/backup.ts'
import { sha256File } from '../src/checksum.ts'
import { StorageError } from '../src/errors.ts'
import { verifyStore } from '../src/recovery.ts'
import { openStoreDatabase, storeDbPath, storeSchemaVersion } from '../src/schema.ts'
import { protectorsOf } from '../src/refs.ts'
import { freshStore, seedPublishedArtifact, seedPublishedResource, trackedTmpDir, writeSessionLog } from './support.mjs'

/** Build one populated store: a resource, an artifact, and a session log. */
function populatedStore(root) {
  const db = freshStore(root)
  const resource = seedPublishedResource(root, db, 'res-1', '{"type":"FeatureCollection","features":[]}')
  const artifact = seedPublishedArtifact(root, db, 'art-1', 'analysis-output-bytes')
  return { db, resource, artifact }
}

function stagingLeftovers(root) {
  return readdirSync(join(root, 'backups')).filter(name => name.startsWith('.staging-'))
}

test('createBackup publishes a verified bundle covering db, files, and session logs', () => {
  const dir = trackedTmpDir('backup-create')
  const logDir = trackedTmpDir('backup-logs')
  try {
    const { db, resource } = populatedStore(dir.path)
    try {
      const logPath = writeSessionLog(logDir.path, 'session-1', [
        JSON.stringify({ seq: 1, type: 'user/message' }),
        JSON.stringify({ seq: 2, type: 'tool/call' }),
      ])
      const result = createBackup(dir.path, db, { sessions: [{ sessionId: 'session-1', logPath }] })
      assert.ok(existsSync(result.bundlePath))
      assert.equal(result.manifest.manifestVersion, 1)
      assert.equal(result.manifest.storeSchemaVersion, storeSchemaVersion(db))
      assert.equal(result.manifest.authorizationDigest, undefined)
      assert.deepEqual(result.manifest.entries.map(entry => entry.kind).sort(), ['artifact', 'resource', 'session-log', 'store-db'])
      const resourceEntry = result.manifest.entries.find(entry => entry.kind === 'resource')
      assert.equal(resourceEntry.sourceId, 'res-1')
      assert.equal(resourceEntry.sourcePath, resource.relativePath)
      assert.equal(resourceEntry.sha256, resource.sha256)
      assert.deepEqual(stagingLeftovers(dir.path), [], 'the staging directory is gone after publish')

      const verification = verifyBackup(result.bundlePath)
      assert.equal(verification.authorizationOk, undefined)
      assert.deepEqual(verification.entries.map(entry => entry.status), ['ok', 'ok', 'ok', 'ok'])
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
    logDir.dispose()
  }
})

test('verify refuses tampered, missing, and authorization-gated entries with per-entry status', () => {
  const dir = trackedTmpDir('backup-verify')
  try {
    const { db } = populatedStore(dir.path)
    try {
      const gated = createBackup(dir.path, db, { authorization: 'operator-token' })
      assert.throws(() => verifyBackup(gated.bundlePath), error => error instanceof StorageError && error.code === 'authorization-mismatch')
      assert.throws(
        () => verifyBackup(gated.bundlePath, { authorization: 'wrong' }),
        error => error instanceof StorageError && error.code === 'authorization-mismatch',
      )
      assert.equal(verifyBackup(gated.bundlePath, { authorization: 'operator-token' }).authorizationOk, true)

      // Tamper with the resource copy inside the bundle.
      const plain = createBackup(dir.path, db)
      const resourcePath = join(plain.bundlePath, plain.manifest.entries.find(entry => entry.kind === 'resource').path)
      writeFileSync(resourcePath, 'tampered-bytes')
      const tampered = verifyBackup(plain.bundlePath)
      assert.equal(tampered.entries.find(entry => entry.kind === 'resource').status, 'digest-mismatch')
      assert.equal(tampered.entries.find(entry => entry.kind === 'store-db').status, 'ok')

      // Remove an entry entirely.
      const artifactPath = join(plain.bundlePath, plain.manifest.entries.find(entry => entry.kind === 'artifact').path)
      rmSync(artifactPath)
      assert.equal(verifyBackup(plain.bundlePath).entries.find(entry => entry.kind === 'artifact').status, 'missing')

      // An unparsable manifest is structurally invalid.
      writeFileSync(join(plain.bundlePath, 'manifest.json'), 'not json')
      assert.throws(() => verifyBackup(plain.bundlePath), error => error instanceof StorageError && error.code === 'invalid-manifest')
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('restore refuses the whole bundle when any entry fails verification', () => {
  const dir = trackedTmpDir('backup-refuse')
  const target = trackedTmpDir('backup-refuse-target')
  try {
    const { db } = populatedStore(dir.path)
    try {
      const bundle = createBackup(dir.path, db)
      const dbEntry = bundle.manifest.entries.find(entry => entry.kind === 'store-db')
      writeFileSync(join(bundle.bundlePath, dbEntry.path), 'corrupt')
      assert.throws(
        () => restoreBackup(bundle.bundlePath, target.path),
        error => error instanceof StorageError && error.code === 'digest-mismatch' && /store\.db/.test(error.message),
      )
      assert.equal(existsSync(join(target.path, 'store.db')), false, 'nothing was written before verification failed')
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
    target.dispose()
  }
})

test('restore to a fresh root lays layers in order and the result verifies clean', () => {
  const dir = trackedTmpDir('backup-restore')
  const logDir = trackedTmpDir('backup-restore-logs')
  const target = trackedTmpDir('backup-restore-target')
  try {
    const { db } = populatedStore(dir.path)
    try {
      const logPath = writeSessionLog(logDir.path, 'session-9', [JSON.stringify({ seq: 1 })])
      const bundle = createBackup(dir.path, db, { sessions: [{ sessionId: 'session-9', logPath }] })
      const report = restoreBackup(bundle.bundlePath, target.path)
      assert.deepEqual(report.database, { status: 'restored', storeSchemaVersion: 6 })
      assert.deepEqual(report.files.map(entry => entry.status), ['restored', 'restored'])
      assert.deepEqual(report.sessions, [{
        kind: 'session-log',
        sourceId: 'session-9',
        status: 'restored',
        targetPath: 'sessions/session-9.jsonl',
      }])
      assert.equal(report.projectionCache.status, 'discarded-derived')
      assert.equal(report.externalJobs.status, 'not-covered-external')
      assert.equal(
        readFileSync(join(target.path, 'sessions/session-9.jsonl'), 'utf8'),
        readFileSync(logPath, 'utf8'),
        'session bytes restore verbatim',
      )
      const verification = verifyStore(target.path)
      assert.equal(verification.store, 'ok')
      assert.deepEqual(verification.summary, { ok: 2, unavailable: 0 }, 'every restored entry verifies against the restored database')
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
    logDir.dispose()
    target.dispose()
  }
})

test('restore never overwrites existing bytes: identical entries keep, differing entries conflict', () => {
  const dir = trackedTmpDir('backup-overwrite')
  const target = trackedTmpDir('backup-overwrite-target')
  try {
    const { db } = populatedStore(dir.path)
    let bundlePath
    try {
      bundlePath = createBackup(dir.path, db).bundlePath
      // Pre-place a differing live database at the target: restore must keep
      // it and report the conflict, never overwrite a live store.
      const live = freshStore(target.path)
      live.close()
      const report = restoreBackup(bundlePath, target.path)
      assert.equal(report.database.status, 'conflict-kept-existing', 'a differing live database is never overwritten')
      assert.equal(report.database.storeSchemaVersion, 6)
      assert.ok(report.files.every(entry => entry.status === 'restored'))
    } finally {
      db.close()
    }

    // A second restore into the completed target keeps identical files and
    // still refuses to replace the live store.
    const again = restoreBackup(bundlePath, target.path)
    assert.ok(again.files.every(entry => entry.status === 'kept-identical'))
    assert.equal(again.database.status, 'conflict-kept-existing')
  } finally {
    dir.dispose()
    target.dispose()
  }
})

test('restoring at a new location keeps references resolvable and session bytes identical', () => {
  const dir = trackedTmpDir('backup-location')
  const target = trackedTmpDir('backup-location-target')
  try {
    const db = freshStore(dir.path)
    try {
      const seeded = seedPublishedResource(dir.path, db, 'res-geo', 'geo-bytes')
      db.prepare('INSERT INTO session_refs (session_id, parent_session_id) VALUES (?, ?)').run('child-1', 'parent-1')
      db.prepare('INSERT INTO map_refs (session_id, layer_id, target_kind, target_id) VALUES (?, ?, ?, ?)')
        .run('child-1', 'layer-1', 'resource', 'res-geo')
      const logPath = writeSessionLog(dir.path, 'child-1', ['{"seq":1}'])
      const bundle = createBackup(dir.path, db, { sessions: [{ sessionId: 'child-1', logPath }] })
      const report = restoreBackup(bundle.bundlePath, target.path)
      assert.equal(report.database.status, 'restored')
    } finally {
      db.close()
    }

    // The reference graph resolves at the new root: edges live in the store,
    // never as absolute paths.
    const restored = openStoreDatabase(storeDbPath(target.path))
    try {
      assert.deepEqual(protectorsOf(restored, { kind: 'resource', id: 'res-geo' }), [
        { kind: 'map-layer', sessionId: 'child-1', detail: 'layer-1' },
      ])
    } finally {
      restored.close()
    }
    const verification = verifyStore(target.path)
    assert.deepEqual(verification.summary, { ok: 1, unavailable: 0 })
    assert.equal(verification.entries[0].relativePath, 'files/shared/res-geo.blob')
    assert.equal(sha256File(join(target.path, 'files/shared/res-geo.blob')), sha256File(join(dir.path, 'files/shared/res-geo.blob')))
  } finally {
    dir.dispose()
    target.dispose()
  }
})

test('a permission-denied session source aborts the bundle and leaves no staging behind', () => {
  const dir = trackedTmpDir('backup-permission')
  const logDir = trackedTmpDir('backup-permission-logs')
  try {
    if (process.getuid?.() === 0) {
      // Root reads bypass mode bits; the permission case is POSIX-owner only.
      return
    }
    const db = freshStore(dir.path)
    try {
      seedPublishedResource(dir.path, db, 'res-p', 'bytes')
      const logPath = writeSessionLog(logDir.path, 'session-secret', ['{"seq":1}'])
      chmodSync(logPath, 0o000)
      assert.throws(() => createBackup(dir.path, db, { sessions: [{ sessionId: 'session-secret', logPath }] }))
      chmodSync(logPath, 0o644)
      assert.deepEqual(stagingLeftovers(dir.path), [], 'the failed staging bundle is removed')
      assert.throws(
        () => verifyBackup(join(dir.path, 'backups', 'definitely-absent')),
        error => error instanceof StorageError && error.code === 'invalid-manifest',
      )
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
    logDir.dispose()
  }
})
