/** Published-version GC: reader pins, release markers, collection under the cleanup protocol. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageError } from '../src/errors.ts'
import {
  acquireReaderPin,
  collectGarbage,
  isReleased,
  releaseReaderPin,
  releaseVersion,
} from '../src/gc.ts'
import { acquireLease } from '../src/leases.ts'
import { planCleanup } from '../src/cleanup.ts'
import { protectorsOf } from '../src/refs.ts'
import { openStoreDatabase, storeDbPath } from '../src/schema.ts'
import { freshStore, seedPublishedArtifact, seedPublishedResource } from './support.mjs'

function freshRoot(name) {
  const root = mkdtempSync(join(tmpdir(), `spatial-gc-${name}-`))
  const db = freshStore(root)
  return { root, db, dispose: () => { db.close(); rmSync(root, { recursive: true, force: true }) } }
}

function planEntryOf(plan, targetId) {
  return plan.entries.find(entry => entry.kind === 'published-version' && entry.targetId === targetId)
}

test('reader pins are idempotent per owner and refuse unknown targets', () => {
  const store = freshRoot('pins')
  try {
    seedPublishedResource(store.root, store.db, 'res-1', 'bytes')
    const first = acquireReaderPin(store.db, { kind: 'resource', id: 'res-1' }, 'session-a')
    const again = acquireReaderPin(store.db, { kind: 'resource', id: 'res-1' }, 'session-a')
    assert.equal(again.pinId, first.pinId, 're-acquire returns the existing pin')
    const other = acquireReaderPin(store.db, { kind: 'resource', id: 'res-1' }, 'session-b')
    assert.notEqual(other.pinId, first.pinId)
    assert.deepEqual(protectorsOf(store.db, { kind: 'resource', id: 'res-1' }).map(entry => entry.kind),
      ['reader-pin', 'reader-pin'])
    releaseReaderPin(store.db, { kind: 'resource', id: 'res-1' }, 'session-a')
    assert.throws(
      () => releaseReaderPin(store.db, { kind: 'resource', id: 'res-1' }, 'session-a'),
      error => error instanceof StorageError && error.code === 'unknown-reader-pin',
    )
    assert.throws(
      () => acquireReaderPin(store.db, { kind: 'resource', id: 'res-missing' }, 'session-a'),
      error => error instanceof StorageError && error.code === 'unknown-target',
    )
    assert.throws(
      () => releaseVersion(store.db, { kind: 'stream', id: 'nope' }),
      error => error instanceof StorageError && error.code === 'unsupported-gc-target',
    )
  } finally {
    store.dispose()
  }
})

test('release is idempotent and refuses unknown rows; reads keep working until collection', () => {
  const store = freshRoot('release')
  try {
    seedPublishedResource(store.root, store.db, 'res-1', 'bytes')
    assert.equal(isReleased(store.db, { kind: 'resource', id: 'res-1' }), false)
    releaseVersion(store.db, { kind: 'resource', id: 'res-1' })
    releaseVersion(store.db, { kind: 'resource', id: 'res-1' })
    assert.equal(isReleased(store.db, { kind: 'resource', id: 'res-1' }), true)
    assert.equal(existsSync(join(store.root, 'files/shared/res-1.blob')), true, 'release is a lifecycle fact, not a deletion')
    assert.throws(
      () => releaseVersion(store.db, { kind: 'resource', id: 'res-missing' }),
      error => error instanceof StorageError && error.code === 'unknown-target',
    )
  } finally {
    store.dispose()
  }
})

test('collection reclaims a released unprotected version: bytes, row, and marker go; reads report missing', () => {
  const store = freshRoot('collect')
  try {
    const seeded = seedPublishedResource(store.root, store.db, 'res-1', 'bytes')
    const artifactSeed = seedPublishedArtifact(store.root, store.db, 'art-1', 'derived')
    releaseVersion(store.db, { kind: 'resource', id: 'res-1' })
    releaseVersion(store.db, { kind: 'artifact', id: 'art-1' })

    const plan = planCleanup(store.root, store.db)
    const resourceEntry = planEntryOf(plan, 'res-1')
    const artifactEntry = planEntryOf(plan, 'art-1')
    assert.equal(resourceEntry?.decision, 'delete')
    assert.equal(artifactEntry?.decision, 'delete')

    const run = collectGarbage(store.root, store.db, 'collector', 60_000)
    assert.equal(run.results.find(entry => entry.target === seeded.relativePath)?.action, 'deleted')
    assert.equal(run.results.find(entry => entry.target === artifactSeed.relativePath)?.action, 'deleted')
    assert.equal(existsSync(join(store.root, seeded.relativePath)), false, 'bytes leave the files/ tree')
    assert.equal(store.db.prepare('SELECT 1 FROM catalog_resources WHERE resource_id = ?').get('res-1'), undefined)
    assert.equal(store.db.prepare('SELECT 1 FROM artifacts WHERE artifact_id = ?').get('art-1'), undefined)
    assert.equal(isReleased(store.db, { kind: 'resource', id: 'res-1' }), false, 'the marker retires with the version')
  } finally {
    store.dispose()
  }
})

test('a reader pin protects a released version at plan and execution time', () => {
  const store = freshRoot('pin-protects')
  try {
    const seeded = seedPublishedResource(store.root, store.db, 'res-1', 'bytes')
    releaseVersion(store.db, { kind: 'resource', id: 'res-1' })
    acquireReaderPin(store.db, { kind: 'resource', id: 'res-1' }, 'reader-1')

    const plan = planCleanup(store.root, store.db)
    assert.equal(planEntryOf(plan, 'res-1')?.decision, 'keep')
    assert.equal(planEntryOf(plan, 'res-1')?.reason, 'pinned')

    // Pin arriving between plan and execute: the re-check keeps the version.
    const pinned = collectGarbage(store.root, store.db, 'collector', 60_000)
    assert.equal(pinned.results.find(entry => entry.target === seeded.relativePath)?.action, 'kept')
    assert.equal(existsSync(join(store.root, seeded.relativePath)), true)

    releaseReaderPin(store.db, { kind: 'resource', id: 'res-1' }, 'reader-1')
    const repinned = collectGarbage(store.root, store.db, 'collector', 60_000)
    assert.equal(repinned.results.find(entry => entry.target === seeded.relativePath)?.action, 'deleted')
  } finally {
    store.dispose()
  }
})

test('unreleased versions never become candidates, however unreferenced they are', () => {
  const store = freshRoot('unreleased')
  try {
    seedPublishedResource(store.root, store.db, 'res-live', 'bytes')
    const plan = planCleanup(store.root, store.db)
    assert.equal(planEntryOf(plan, 'res-live'), undefined)
    const run = collectGarbage(store.root, store.db, 'collector', 60_000)
    assert.equal(run.results.find(entry => entry.target === 'files/shared/res-live.blob'), undefined)
    assert.equal(existsSync(join(store.root, 'files/shared/res-live.blob')), true)
  } finally {
    store.dispose()
  }
})

test('session reference edges protect a released version from collection', () => {
  const store = freshRoot('refs-protect')
  try {
    seedPublishedResource(store.root, store.db, 'res-1', 'bytes')
    releaseVersion(store.db, { kind: 'resource', id: 'res-1' })
    store.db.prepare(
      'INSERT INTO export_refs (session_id, export_id, target_kind, target_id) VALUES (?, ?, ?, ?)',
    ).run('sess-1', 'exp-1', 'resource', 'res-1')
    const run = collectGarbage(store.root, store.db, 'collector', 60_000)
    assert.equal(run.results.find(entry => entry.target === 'files/shared/res-1.blob')?.action, 'kept')
    assert.equal(existsSync(join(store.root, 'files/shared/res-1.blob')), true)
  } finally {
    store.dispose()
  }
})

test('a concurrent collector surfaces the lease-held refusal; backup and restore keep the lifecycle resolvable', async t => {
  const store = freshRoot('concurrent')
  try {
    seedPublishedResource(store.root, store.db, 'res-1', 'bytes')
    releaseVersion(store.db, { kind: 'resource', id: 'res-1' })
    const lease = acquireLease(store.db, { scope: 'cleanup', owner: 'other-collector', ttlMs: 60_000 })
    assert.throws(
      () => collectGarbage(store.root, store.db, 'collector', 60_000),
      error => error instanceof StorageError && error.code === 'lease-held',
    )
    releaseLeaseForTest(store.db, lease.leaseId)

    // The marker rides the store db: a backup restored at a new location
    // keeps the lifecycle fact, and relative paths keep the bytes resolvable.
    const { createBackup, restoreBackup } = await import('../src/backup.ts')
    const bundle = createBackup(store.root, store.db, { sessions: [] })
    const targetRoot = mkdtempSync(join(tmpdir(), 'spatial-gc-restored-'))
    t.after(() => rmSync(targetRoot, { recursive: true, force: true }))
    restoreBackup(bundle.bundlePath, targetRoot, {})
    const restored = openStoreDatabase(storeDbPath(targetRoot))
    try {
      assert.equal(isReleased(restored, { kind: 'resource', id: 'res-1' }), true, 'the marker survives the move')
      const run = collectGarbage(targetRoot, restored, 'collector', 60_000)
      assert.equal(run.results.find(entry => entry.target === 'files/shared/res-1.blob')?.action, 'deleted')
    } finally {
      restored.close()
    }
  } finally {
    store.dispose()
  }
})

/** Release the lease directly; the test owns the id it acquired. */
function releaseLeaseForTest(db, leaseId) {
  db.prepare('DELETE FROM leases WHERE lease_id = ?').run(leaseId)
}
