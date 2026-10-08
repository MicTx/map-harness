/**
 * Reference-protection and lifecycle gates: every protector kind resolves
 * against one target, fork children protect through their own edges, cleanup
 * plans are complete dry-runs (published versions never candidates), pins and
 * active writes protect staging, plan/execute races keep late-protected
 * entries, and the cleanup lease enforces mutual exclusion.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { acquireLease, isLeaseLive, releaseLease, renewLease } from '../src/leases.ts'
import { StorageError } from '../src/errors.ts'
import { executeCleanup, planCleanup, registerStaging, releaseStaging } from '../src/cleanup.ts'
import { listPins, pinTarget, unpinTarget } from '../src/pins.ts'
import { isTargetProtected, parentSessionOf, protectorsOf } from '../src/refs.ts'
import { freshStore, seedPublishedResource, trackedTmpDir } from './support.mjs'

test('every protector kind resolves against one target', () => {
  const dir = trackedTmpDir('lifecycle-protectors')
  try {
    const db = freshStore(dir.path)
    try {
      seedPublishedResource(dir.path, db, 'res-multi', 'bytes')
      db.prepare('INSERT INTO map_refs (session_id, layer_id, target_kind, target_id) VALUES (?, ?, ?, ?)')
        .run('session-a', 'layer-1', 'resource', 'res-multi')
      db.prepare('INSERT INTO report_refs (session_id, report_id, target_kind, target_id) VALUES (?, ?, ?, ?)')
        .run('session-b', 'report-1', 'resource', 'res-multi')
      db.prepare('INSERT INTO export_refs (session_id, export_id, target_kind, target_id) VALUES (?, ?, ?, ?)')
        .run('session-c', 'export-1', 'resource', 'res-multi')
      db.prepare('INSERT INTO job_refs (session_id, job_id, state, target_kind, target_id) VALUES (?, ?, ?, ?, ?)')
        .run('session-d', 'job-1', 'running', 'resource', 'res-multi')
      pinTarget(db, { kind: 'resource', id: 'res-multi' }, 'backup-window')
      const protectors = protectorsOf(db, { kind: 'resource', id: 'res-multi' }).map(row => `${row.kind}:${row.detail}`)
      assert.deepEqual(protectors.sort(), [
        'backup-pin:backup-window',
        'export:export-1',
        'job:job-1(running)',
        'map-layer:layer-1',
        'report:report-1',
      ])
      assert.equal(isTargetProtected(db, { kind: 'resource', id: 'res-multi' }), true)
      assert.equal(isTargetProtected(db, { kind: 'resource', id: 'res-absent' }), false)
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('a fork child protects a target through its own edges even with no parent anywhere', () => {
  const dir = trackedTmpDir('lifecycle-fork')
  try {
    const db = freshStore(dir.path)
    try {
      seedPublishedResource(dir.path, db, 'res-parented', 'parent-analysis-bytes')
      db.prepare('INSERT INTO session_refs (session_id, parent_session_id) VALUES (?, ?)').run('child-1', 'parent-1')
      db.prepare('INSERT INTO report_refs (session_id, report_id, target_kind, target_id) VALUES (?, ?, ?, ?)')
        .run('child-1', 'report-child', 'resource', 'res-parented')
      assert.equal(parentSessionOf(db, 'child-1'), 'parent-1')
      assert.equal(parentSessionOf(db, 'root-1'), undefined)
      // Only the child's edge exists: the target stays protected, which is
      // what keeps a fork's frozen evidence readable after the parent dies.
      const protectors = protectorsOf(db, { kind: 'resource', id: 'res-parented' })
      assert.deepEqual(protectors.map(row => row.kind), ['report'])
      assert.equal(protectors[0].sessionId, 'child-1')
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('the cleanup plan is a complete dry-run and never lists published versions', () => {
  const dir = trackedTmpDir('lifecycle-plan')
  try {
    const db = freshStore(dir.path)
    try {
      // Published with zero references: still never a candidate (P0 no auto-GC).
      seedPublishedResource(dir.path, db, 'res-unreferenced', 'kept-bytes')
      const activeId = registerStaging(db, { relativePath: 'staging/active.tmp', ownerSessionId: 'session-w' })
      writeFileSync(join(dir.path, 'staging/active.tmp'), 'in-flight')
      const releasedId = registerStaging(db, { relativePath: 'staging/released.tmp' })
      releaseStaging(db, releasedId)
      writeFileSync(join(dir.path, 'staging/released.tmp'), 'discardable')
      // Rowless orphans: one under staging/, one under files/.
      mkdirSync(join(dir.path, 'staging'), { recursive: true })
      writeFileSync(join(dir.path, 'staging/rowless.tmp'), 'orphan')
      writeFileSync(join(dir.path, 'files/rowless.bin'), 'orphan')

      const plan = planCleanup(dir.path, db)
      assert.equal(plan.entries.length, 4)
      const byTarget = new Map(plan.entries.map(entry => [entry.target, entry]))
      assert.deepEqual(byTarget.get('staging/active.tmp'), {
        kind: 'staging-row', target: 'staging/active.tmp', stagingId: activeId, decision: 'keep', reason: 'active-write',
      })
      assert.deepEqual(byTarget.get('staging/released.tmp'), {
        kind: 'staging-row', target: 'staging/released.tmp', stagingId: releasedId, decision: 'delete', reason: 'released-unprotected',
      })
      assert.equal(byTarget.get('staging/rowless.tmp').decision, 'delete')
      assert.equal(byTarget.get('staging/rowless.tmp').reason, 'orphan')
      assert.equal(byTarget.get('files/rowless.bin').decision, 'delete')
      assert.equal(plan.entries.find(entry => entry.target.includes('res-unreferenced')), undefined, 'published rows are never candidates')

      // The plan mutated nothing.
      assert.ok(existsSync(join(dir.path, 'staging/released.tmp')))
      assert.ok(db.prepare('SELECT 1 FROM staging WHERE staging_id = ?').get(releasedId))
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('execution requires the live cleanup lease and deletes through trash', () => {
  const dir = trackedTmpDir('lifecycle-execute')
  try {
    const db = freshStore(dir.path)
    try {
      const releasedId = registerStaging(db, { relativePath: 'staging/released.tmp' })
      releaseStaging(db, releasedId)
      writeFileSync(join(dir.path, 'staging/released.tmp'), 'discardable')
      const plan = planCleanup(dir.path, db)

      assert.throws(
        () => executeCleanup(dir.path, db, plan, { leaseId: 'no-such-lease' }),
        error => error instanceof StorageError && error.code === 'no-lease',
      )
      const foreign = acquireLease(db, { scope: 'some-other-scope', owner: 'other', ttlMs: 60_000 })
      assert.throws(
        () => executeCleanup(dir.path, db, plan, { leaseId: foreign.leaseId }),
        error => error instanceof StorageError && error.code === 'no-lease',
        'a live lease of another scope does not authorize cleanup',
      )
      releaseLease(db, foreign.leaseId)

      const lease = acquireLease(db, { scope: 'cleanup', owner: 'cleaner-1', ttlMs: 60_000 })
      const results = executeCleanup(dir.path, db, plan, { leaseId: lease.leaseId })
      assert.deepEqual(results, [{
        kind: 'staging-row', target: 'staging/released.tmp', action: 'deleted', reason: 'released-unprotected',
      }])
      assert.equal(existsSync(join(dir.path, 'staging/released.tmp')), false)
      assert.equal(existsSync(join(dir.path, 'trash')), true, 'the trash directory stays for atomic moves')
      assert.equal(db.prepare('SELECT 1 FROM staging WHERE staging_id = ?').get(releasedId), undefined, 'the row goes after the bytes')
      releaseLease(db, lease.leaseId)
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('pins added between plan and execute keep the staging entry (TOCTOU guard)', () => {
  const dir = trackedTmpDir('lifecycle-toctou-pin')
  try {
    const db = freshStore(dir.path)
    try {
      const releasedId = registerStaging(db, { relativePath: 'staging/pinned-late.tmp' })
      releaseStaging(db, releasedId)
      writeFileSync(join(dir.path, 'staging/pinned-late.tmp'), 'became-pinned')
      const plan = planCleanup(dir.path, db)
      const pinId = pinTarget(db, { kind: 'staging', id: releasedId }, 'backup-started-after-plan')

      const lease = acquireLease(db, { scope: 'cleanup', owner: 'cleaner-1', ttlMs: 60_000 })
      const results = executeCleanup(dir.path, db, plan, { leaseId: lease.leaseId })
      assert.deepEqual(results, [{
        kind: 'staging-row', target: 'staging/pinned-late.tmp', action: 'kept', reason: 'pinned',
      }])
      assert.ok(existsSync(join(dir.path, 'staging/pinned-late.tmp')), 'the late pin kept the bytes')
      assert.ok(db.prepare('SELECT 1 FROM staging WHERE staging_id = ?').get(releasedId))
      releaseLease(db, lease.leaseId)

      // Once the pin is gone the next cycle collects the entry.
      unpinTarget(db, pinId)
      const secondPlan = planCleanup(dir.path, db)
      const secondLease = acquireLease(db, { scope: 'cleanup', owner: 'cleaner-1', ttlMs: 60_000 })
      const secondResults = executeCleanup(dir.path, db, secondPlan, { leaseId: secondLease.leaseId })
      assert.equal(secondResults[0].action, 'deleted')
      releaseLease(db, secondLease.leaseId)
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('a write reactivated between plan and execute keeps the staging entry', () => {
  const dir = trackedTmpDir('lifecycle-toctou-active')
  try {
    const db = freshStore(dir.path)
    try {
      const releasedId = registerStaging(db, { relativePath: 'staging/reactivated.tmp' })
      releaseStaging(db, releasedId)
      writeFileSync(join(dir.path, 'staging/reactivated.tmp'), 'reclaimed-by-writer')
      const plan = planCleanup(dir.path, db)
      // The writer takes the row back: a new owner registered the same path
      // semantics by flipping the row active again.
      db.prepare('UPDATE staging SET state = ? WHERE staging_id = ?').run('active', releasedId)

      const lease = acquireLease(db, { scope: 'cleanup', owner: 'cleaner-1', ttlMs: 60_000 })
      const results = executeCleanup(dir.path, db, plan, { leaseId: lease.leaseId })
      assert.deepEqual(results, [{
        kind: 'staging-row', target: 'staging/reactivated.tmp', action: 'kept', reason: 'active-write',
      }])
      assert.ok(existsSync(join(dir.path, 'staging/reactivated.tmp')))
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('an orphan claimed by a row between plan and execute is kept', () => {
  const dir = trackedTmpDir('lifecycle-toctou-claim')
  try {
    const db = freshStore(dir.path)
    try {
      mkdirSync(join(dir.path, 'files'), { recursive: true })
      writeFileSync(join(dir.path, 'files/late-claim.bin'), 'about-to-be-promoted')
      const plan = planCleanup(dir.path, db)
      // The publisher promoted the file: catalog row inserted before cleanup ran.
      db.prepare(
        'INSERT INTO catalog_resources (resource_id, version, state, relative_path, sha256, bytes, schema_digest, registered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run('res-late', 1, 'published', 'files/late-claim.bin', 'deadbeef'.repeat(8), 24, 'sd', '2026-09-25T00:00:00.000Z')

      const lease = acquireLease(db, { scope: 'cleanup', owner: 'cleaner-1', ttlMs: 60_000 })
      const results = executeCleanup(dir.path, db, plan, { leaseId: lease.leaseId })
      assert.deepEqual(results, [{
        kind: 'orphan-file', target: 'files/late-claim.bin', action: 'kept', reason: 'claimed-since-plan',
      }])
      assert.ok(existsSync(join(dir.path, 'files/late-claim.bin')))
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('the cleanup lease excludes concurrent cleaners and expires on schedule', () => {
  const dir = trackedTmpDir('lifecycle-lease-race')
  try {
    const db = freshStore(dir.path)
    try {
      const first = acquireLease(db, { scope: 'cleanup', owner: 'cleaner-1', ttlMs: 60_000 })
      assert.equal(isLeaseLive(db, first.leaseId), true)
      assert.throws(
        () => acquireLease(db, { scope: 'cleanup', owner: 'cleaner-2', ttlMs: 60_000 }),
        error => error instanceof StorageError && error.code === 'lease-held',
        'a second cleaner cannot hold the same scope',
      )

      const extended = renewLease(db, first.leaseId, 120_000)
      assert.ok(extended > first.expiresAtMs)
      releaseLease(db, first.leaseId)
      assert.equal(isLeaseLive(db, first.leaseId), false)

      // Expire a lease by moving its recorded expiry into the past — the
      // deterministic stand-in for the clock passing the deadline.
      const expired = acquireLease(db, { scope: 'cleanup', owner: 'cleaner-1', ttlMs: 60_000 })
      db.prepare('UPDATE leases SET expires_at_ms = ? WHERE lease_id = ?').run(Date.now() - 1, expired.leaseId)
      const second = acquireLease(db, { scope: 'cleanup', owner: 'cleaner-2', ttlMs: 60_000 })
      assert.ok(second.leaseId !== expired.leaseId, 'an expired lease is takeable')
      assert.throws(() => renewLease(db, expired.leaseId, 1000), error => error instanceof StorageError && error.code === 'no-lease')
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})

test('pins list and remove by id with idempotent target+reason pinning', () => {
  const dir = trackedTmpDir('lifecycle-pins')
  try {
    const db = freshStore(dir.path)
    try {
      const first = pinTarget(db, { kind: 'resource', id: 'res-pin' }, 'backup-window')
      const duplicate = pinTarget(db, { kind: 'resource', id: 'res-pin' }, 'backup-window')
      assert.equal(first, duplicate, 'the same target+reason pair reuses its pin')
      pinTarget(db, { kind: 'resource', id: 'res-pin' }, 'manual-hold')
      assert.equal(listPins(db).length, 2)
      unpinTarget(db, first)
      assert.deepEqual(listPins(db).map(pin => pin.reason), ['manual-hold'])
    } finally {
      db.close()
    }
  } finally {
    dir.dispose()
  }
})
