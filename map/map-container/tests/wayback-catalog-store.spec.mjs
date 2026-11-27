import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  MAX_VERIFIED_RELEASES,
  loadVerifiedWaybackRelease,
  loadWaybackCatalog,
  saveVerifiedWaybackRelease,
  saveWaybackCatalog,
} from '../src/wayback-catalog-store.ts'

const DIGEST = 'a'.repeat(64)
const OTHER_DIGEST = 'b'.repeat(64)

function release(overrides = {}) {
  return Object.freeze({
    releaseId: 100,
    itemId: '0'.repeat(31) + '1',
    title: 'World Imagery (Wayback 2020-01-02)',
    publishedAt: '2020-01-02',
    layerIdentifier: 'WB_2020_R01',
    acquiredAt: null,
    ...overrides,
  })
}

const CATALOG = [{
  releaseNum: 7,
  itemID: '7'.repeat(32),
  itemTitle: 'World Imagery (Wayback 2014-02-20)',
  releaseDateLabel: '2014-02-20',
  layerIdentifier: 'WB_2014_R01',
}]

function tempPath(t) {
  const root = mkdtempSync(join(tmpdir(), 'wayback-verified-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'cache', 'map', 'wayback-catalog.sqlite')
}

function inspect(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      version: database.prepare('PRAGMA user_version').get().user_version,
      catalog: database.prepare('SELECT items FROM wayback_catalog WHERE id = 1').get()?.items ?? null,
      rows: database.prepare("SELECT name FROM sqlite_master WHERE name = 'wayback_verified_release' AND type = 'table'").get() === undefined
        ? []
        : database.prepare('SELECT release_id, config_digest, record FROM wayback_verified_release ORDER BY release_id, config_digest').all(),
    }
  } finally {
    database.close()
  }
}

function withWrite(path, run) {
  const database = new DatabaseSync(path)
  try {
    run(database)
  } finally {
    database.close()
  }
}

test('loading never creates or migrates: missing file and catalog-only v1 yield undefined', t => {
  const path = tempPath(t)
  assert.equal(loadVerifiedWaybackRelease(path, 100, DIGEST), undefined)
  assert.equal(existsSync(path), false)

  saveWaybackCatalog(path, CATALOG)
  const before = readFileSync(path)
  assert.equal(loadVerifiedWaybackRelease(path, 100, DIGEST), undefined)
  assert.equal(loadVerifiedWaybackRelease(path, 7, DIGEST), undefined)
  assert.deepEqual(readFileSync(path), before)
})

test('the first verified release creates schema v2 and survives reopening', t => {
  const path = tempPath(t)
  saveVerifiedWaybackRelease(path, release(), DIGEST)
  const state = inspect(path)
  assert.equal(state.version, 2)
  assert.equal(state.rows.length, 1)
  assert.deepEqual([state.rows[0].release_id, state.rows[0].config_digest], [100, DIGEST])
  const loaded = loadVerifiedWaybackRelease(path, 100, DIGEST)
  assert.deepEqual(loaded, release())
  assert.ok(Object.isFrozen(loaded))
  assert.equal(loadVerifiedWaybackRelease(path, 100, OTHER_DIGEST), undefined)
  assert.equal(loadVerifiedWaybackRelease(path, 101, DIGEST), undefined)
})

test('v1 catalog and v2 verified rows coexist and neither writer rewrites the other', t => {
  const path = tempPath(t)
  saveWaybackCatalog(path, CATALOG)
  assert.equal(inspect(path).version, 1, 'catalog-only writes keep v1')

  saveVerifiedWaybackRelease(path, release(), DIGEST)
  assert.equal(inspect(path).version, 2)
  assert.deepEqual(loadWaybackCatalog(path), CATALOG)

  const nextCatalog = [...CATALOG, { ...CATALOG[0], releaseNum: 8, itemID: '8'.repeat(32) }]
  saveWaybackCatalog(path, nextCatalog)
  assert.equal(inspect(path).version, 2)
  assert.deepEqual(loadWaybackCatalog(path), nextCatalog)
  assert.deepEqual(loadVerifiedWaybackRelease(path, 100, DIGEST), release())
})

test('identical writes are idempotent; a conflicting record for the same key is refused intact', t => {
  const path = tempPath(t)
  saveVerifiedWaybackRelease(path, release(), DIGEST)
  const committed = inspect(path).rows
  saveVerifiedWaybackRelease(path, release(), DIGEST)
  assert.deepEqual(inspect(path).rows, committed)

  assert.throws(() => saveVerifiedWaybackRelease(path, release({ acquiredAt: '2019-12-25' }), DIGEST), /conflict/)
  assert.throws(() => saveVerifiedWaybackRelease(path, release({ title: 'World Imagery (Wayback 2020-01-03)', publishedAt: '2020-01-03' }), DIGEST), /conflict/)
  assert.deepEqual(inspect(path).rows, committed)
  assert.deepEqual(loadVerifiedWaybackRelease(path, 100, DIGEST), release())
})

test('keys are independent across config digests and releases', t => {
  const path = tempPath(t)
  const dated = release({ acquiredAt: '2019-12-25' })
  const other = release({ releaseId: 101, itemId: 'f'.repeat(32), title: 'World Imagery (Wayback 2021-03-04)',
    publishedAt: '2021-03-04', layerIdentifier: 'WB_2021_R01' })
  saveVerifiedWaybackRelease(path, release(), DIGEST)
  saveVerifiedWaybackRelease(path, dated, OTHER_DIGEST)
  saveVerifiedWaybackRelease(path, other, DIGEST)
  assert.equal(inspect(path).rows.length, 3)
  assert.deepEqual(loadVerifiedWaybackRelease(path, 100, DIGEST), release())
  assert.deepEqual(loadVerifiedWaybackRelease(path, 100, OTHER_DIGEST), dated)
  assert.deepEqual(loadVerifiedWaybackRelease(path, 101, DIGEST), other)
})

test('malformed releases and digests are rejected before touching the file', t => {
  const path = tempPath(t)
  const invalid = [
    [undefined, 'not an object'],
    [null, 'not an object'],
    [[], 'not an object'],
    [release({ releaseId: -1 }), 'releaseId'],
    [release({ releaseId: 1.5 }), 'releaseId'],
    [release({ releaseId: Number.MAX_SAFE_INTEGER + 2 }), 'releaseId'],
    [release({ itemId: 'ABC' }), 'itemId'],
    [release({ itemId: '0'.repeat(31) }), 'itemId'],
    [release({ title: 'World Imagery' }), 'title'],
    [release({ publishedAt: '2020-02-30' }), 'publishedAt'],
    [release({ publishedAt: '2020-1-02' }), 'publishedAt'],
    [release({ layerIdentifier: 'WB_2020_R1' }), 'layerIdentifier'],
    [release({ layerIdentifier: 'WB_2021_R01' }), 'layerIdentifier'],
    [release({ acquiredAt: undefined }), 'acquiredAt'],
    [release({ acquiredAt: '2019-02-30' }), 'acquiredAt'],
    [release({ acquiredAt: 1577232000000 }), 'acquiredAt'],
    [release({ extra: 'x' }), 'unknown field'],
  ]
  for (const [value, field] of invalid) {
    assert.throws(() => saveVerifiedWaybackRelease(path, value, DIGEST), new RegExp(field), String(field))
    assert.equal(existsSync(path), false, `${field} must not create the cache`)
  }
  for (const digest of ['', 'ABC', 'a'.repeat(7), 'a'.repeat(129), 'g'.repeat(64)]) {
    assert.throws(() => saveVerifiedWaybackRelease(path, release(), digest), /config digest/)
    assert.throws(() => loadVerifiedWaybackRelease(path, 100, digest), /config digest/)
  }
  assert.throws(() => saveVerifiedWaybackRelease(path, release(), DIGEST.toUpperCase()), /config digest/)
})

test('hostile stored rows are refused on read and leave the file unchanged', t => {
  const path = tempPath(t)
  saveVerifiedWaybackRelease(path, release(), DIGEST)
  const tamper = (sql) => withWrite(path, database => database.exec(sql))
  const scenarios = [
    ["UPDATE wayback_verified_release SET record = 'not json'"],
    ["UPDATE wayback_verified_release SET record = '{\"releaseId\":100,\"configDigest\":\"" + DIGEST + "\",\"release\":null}'"],
    ["UPDATE wayback_verified_release SET record = '{}'"],
    ["UPDATE wayback_verified_release SET record = '" + JSON.stringify({ releaseId: 100, configDigest: OTHER_DIGEST, release: release() }) + "'"],
    ["UPDATE wayback_verified_release SET record = '" + JSON.stringify({ releaseId: 101, configDigest: DIGEST, release: release() }) + "'"],
    ["UPDATE wayback_verified_release SET record = '" + JSON.stringify({ releaseId: 100, configDigest: DIGEST, release: release({ title: 'World Imagery (Wayback 2020-01-03)' }) }) + "'"],
    ["UPDATE wayback_verified_release SET record = '" + JSON.stringify({ releaseId: 100, configDigest: DIGEST, release: release({ releaseId: '100' }) }) + "'"],
    ["UPDATE wayback_verified_release SET record = '" + 'x'.repeat(4096) + "'"],
  ]
  for (const [sql] of scenarios) {
    const good = inspect(path).rows
    tamper(sql)
    const hostile = readFileSync(path)
    assert.throws(() => loadVerifiedWaybackRelease(path, 100, DIGEST), /Wayback verified release/)
    assert.throws(() => saveVerifiedWaybackRelease(path, release(), DIGEST), /Wayback verified release/)
    assert.deepEqual(readFileSync(path), hostile, 'a refused read or write must not modify the file')
    withWrite(path, database => database.prepare('DELETE FROM wayback_verified_release').run())
    saveVerifiedWaybackRelease(path, release(), DIGEST)
    assert.deepEqual(inspect(path).rows, good)
  }
})

test('a future schema is refused by both readers and both writers without modification', t => {
  const path = tempPath(t)
  saveVerifiedWaybackRelease(path, release(), DIGEST)
  withWrite(path, database => database.exec('PRAGMA user_version = 3'))
  const future = readFileSync(path)
  assert.throws(() => loadVerifiedWaybackRelease(path, 100, DIGEST), /schema/)
  assert.throws(() => saveVerifiedWaybackRelease(path, release(), OTHER_DIGEST), /schema/)
  assert.throws(() => loadWaybackCatalog(path), /schema/)
  assert.throws(() => saveWaybackCatalog(path, CATALOG), /schema/)
  assert.deepEqual(readFileSync(path), future)
})

test('a failed migration rolls back and keeps the v1 catalog readable', t => {
  const path = tempPath(t)
  saveWaybackCatalog(path, CATALOG)
  withWrite(path, database => database.exec('CREATE VIEW wayback_verified_release AS SELECT 1'))
  assert.throws(() => saveVerifiedWaybackRelease(path, release(), DIGEST))
  assert.equal(inspect(path).version, 1)
  assert.equal(inspect(path).catalog, JSON.stringify(CATALOG))
  assert.deepEqual(loadWaybackCatalog(path), CATALOG)
})

test('the fixed row bound fails safely without evicting referenced records', t => {
  const path = tempPath(t)
  const firstDigest = 'c'.repeat(63) + '0'
  for (let index = 0; index < MAX_VERIFIED_RELEASES; index += 1) {
    saveVerifiedWaybackRelease(path, release({ releaseId: 200 + index }), index === 0 ? firstDigest : DIGEST)
  }
  const full = inspect(path)
  assert.equal(full.rows.length, MAX_VERIFIED_RELEASES)

  assert.throws(() => saveVerifiedWaybackRelease(path, release(), DIGEST), { code: 'SOURCE_LIMIT_EXCEEDED' })
  assert.throws(() => saveVerifiedWaybackRelease(path, release({ releaseId: 200 }), OTHER_DIGEST), { code: 'SOURCE_LIMIT_EXCEEDED' })
  assert.deepEqual(inspect(path), full)
  for (let index = 0; index < MAX_VERIFIED_RELEASES; index += 1) {
    assert.deepEqual(loadVerifiedWaybackRelease(path, 200 + index, index === 0 ? firstDigest : DIGEST), release({ releaseId: 200 + index }))
  }
  saveVerifiedWaybackRelease(path, release({ releaseId: 200 + MAX_VERIFIED_RELEASES - 1 }), DIGEST)
})

test('an oversized record cannot be planted through the writer', t => {
  const path = tempPath(t)
  assert.throws(() => saveVerifiedWaybackRelease(path, release({ title: `World Imagery (Wayback 2020-01-02)${'x'.repeat(4096)}` }), DIGEST), /title/)
  assert.equal(existsSync(path), false)
})
