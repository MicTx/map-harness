import test from 'node:test'
import assert from 'node:assert/strict'
import { createSourceCachePolicy } from '../src/source-cache-policy.ts'

const time = Date.parse('2026-11-03T12:00:00Z')
const url = new URL('https://geo.example.test/MapServer/tile/0/0/0')
const headers = (overrides = {}) => ({
  etag: '"private-upstream-version"', lastModified: null,
  cacheControl: 'public, max-age=60', date: new Date(time).toUTCString(),
  age: '0', expires: null, vary: null, ...overrides,
})
function clock(t) {
  t.mock.timers.enable({ apis: ['Date'], now: time })
}

test('source freshness accounts for Age, apparent server age and completed request delay', t => {
  clock(t)
  const policy = createSourceCachePolicy(url, headers({ date: new Date(time - 10_000).toUTCString(), age: '20' }), time - 500)
  assert.equal(policy.storable, true)
  assert.equal(policy.isFresh(), true)
  assert.equal(policy.browserCacheControl(), 'private, max-age=39, must-revalidate')
  assert.ok(policy.bytes > 0)
  t.mock.timers.tick(40_000)
  assert.equal(policy.isFresh(), false)
  assert.equal(policy.browserCacheControl(), 'private, no-cache, max-age=0, must-revalidate')
})

test('old Date cannot become fresh again when Age is missing or short', t => {
  clock(t)
  const policy = createSourceCachePolicy(url, headers({ date: new Date(time - 100_000).toUTCString(), age: null }), time - 500)
  assert.equal(policy.isFresh(), false)
})

test('retention accounts for both library and original validator bytes without retaining mutable caller headers', t => {
  clock(t)
  const input = headers()
  const short = createSourceCachePolicy(url, headers({ etag: '"v"' }), time)
  const long = createSourceCachePolicy(url, headers({ etag: `"${'v'.repeat(100)}"` }), time)
  assert.equal(long.bytes - short.bytes, 2 * 99)
  const policy = createSourceCachePolicy(url, input, time)
  input.date = 'not-a-date'
  t.mock.timers.tick(61_000)
  const refreshed = policy.revalidated(headers({
    date: null, cacheControl: 'max-age=120',
  }), time + 61_000)
  assert.ok(refreshed)
  assert.equal(refreshed.storable, true)
})

test('source cache never uses stale-if-error or stale-while-revalidate to serve stale imagery', t => {
  clock(t)
  const policy = createSourceCachePolicy(url, headers({ cacheControl: 'max-age=1, stale-if-error=300, stale-while-revalidate=300' }), time)
  assert.equal(policy.isFresh(), true)
  t.mock.timers.tick(2_000)
  assert.equal(policy.isFresh(), false)
  assert.equal(policy.browserCacheControl(), 'private, no-cache, max-age=0, must-revalidate')
})

test('no-store and Vary wildcard prohibit retention; no-cache requires validation even with max-age', t => {
  clock(t)
  for (const override of [{ cacheControl: 'no-store, max-age=60' }, { vary: '*' }]) {
    const policy = createSourceCachePolicy(url, headers(override), time)
    assert.equal(policy.storable, false)
    assert.equal(policy.isFresh(), false)
    assert.equal(policy.browserCacheControl(), 'no-store')
  }
  const noCache = createSourceCachePolicy(url, headers({ cacheControl: 'no-cache, max-age=60' }), time)
  assert.equal(noCache.storable, true)
  assert.equal(noCache.isFresh(), false)
  assert.deepEqual(noCache.validators(), { etag: '"private-upstream-version"', lastModified: null })
})

test('no heuristic or implicit immutable freshness is invented', t => {
  clock(t)
  for (const cacheControl of [null, 'immutable']) {
    const policy = createSourceCachePolicy(url, headers({
      cacheControl,
      lastModified: new Date(time - 100 * 86400_000).toUTCString(),
    }), time)
    assert.equal(policy.isFresh(), false)
  }
})

test('ambiguous cache directives and invalid age/date never grant freshness', t => {
  clock(t)
  for (const override of [
    { cacheControl: 'max-age=1, max-age=60' },
    { cacheControl: 'max-age=1, MAX-AGE=60' },
    { cacheControl: 'extension="x,max-age=60"' },
    { cacheControl: 'max-age=NaN' },
    { cacheControl: 'max-age=-1' },
    { cacheControl: 'max-age=9007199254740993' },
    { age: '-1' }, { age: 'NaN' }, { date: 'not-a-date' },
  ]) {
    const policy = createSourceCachePolicy(url, headers(override), time)
    assert.equal(policy.storable, false)
    assert.equal(policy.isFresh(), false)
  }
  assert.equal(createSourceCachePolicy(url, headers({ cacheControl: 'PUBLIC, MAX-AGE="60"' }), time).isFresh(), true)
})

test('Expires is honored without max-age and max-age remains authoritative', t => {
  clock(t)
  assert.equal(createSourceCachePolicy(url, headers({
    cacheControl: null, expires: new Date(time + 30_000).toUTCString(),
  }), time).browserCacheControl(), 'private, max-age=30, must-revalidate')
  assert.equal(createSourceCachePolicy(url, headers({
    cacheControl: 'max-age=0', expires: new Date(time + 30_000).toUTCString(),
  }), time).isFresh(), false)
})

test('304 reuse requires matching native validators and updates only current policy, not body identity', t => {
  clock(t)
  const policy = createSourceCachePolicy(url, headers({ cacheControl: 'max-age=1' }), time)
  t.mock.timers.tick(2_000)
  const refreshed = policy.revalidated(headers({
    date: new Date(time + 2_000).toUTCString(), cacheControl: 'max-age=30',
  }), time + 2_000)
  assert.ok(refreshed)
  assert.equal(refreshed.isFresh(), true)
  assert.equal(refreshed.browserCacheControl(), 'private, max-age=30, must-revalidate')
  assert.equal(policy.revalidated(headers({ etag: '"different-version"' }), time + 2_000), null)
  const noStore = policy.revalidated(headers({
    cacheControl: 'no-store', date: new Date(time + 2_000).toUTCString(),
  }), time + 2_000)
  assert.ok(noStore)
  assert.equal(noStore.storable, false)
  assert.equal(noStore.browserCacheControl(), 'no-store')
  assert.equal(refreshed.browserCacheControl().includes('private-upstream-version'), false)
  assert.equal(refreshed.browserCacheControl().includes('geo.example.test'), false)
})
