import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSourceCache } from '../src/source-cache.ts'

test('hits promote entries and insertion evicts the least-recently used value', () => {
  const cache = createSourceCache(2, 20)
  cache.set('a', 'A', 3)
  cache.set('b', 'B', 4)
  assert.deepEqual(cache.stats(), { entries: 2, bytes: 9 })
  assert.equal(cache.get('a'), 'A')
  cache.set('c', 'C', 5)
  assert.equal(cache.get('b'), undefined)
  assert.equal(cache.get('a'), 'A')
  assert.equal(cache.get('c'), 'C')
  assert.deepEqual(cache.stats(), { entries: 2, bytes: 10 })
})

test('replacement removes the prior key before eviction and oversized replacement removes it', () => {
  const cache = createSourceCache(2, 20)
  cache.set('a', 'A', 3)
  cache.set('b', 'B', 4)
  cache.get('a')
  cache.set('c', 'C', 5)
  cache.set('a', 'A2', 19)
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 20 })
  assert.equal(cache.get('c'), undefined)
  assert.equal(cache.get('a'), 'A2')
  cache.set('a', 'A3', 20)
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 })
  assert.equal(cache.get('a'), undefined)
})

test('UTF-8 key bytes count toward exact limits and entry bounds evict independently', () => {
  const exact = createSourceCache(2, 8)
  exact.set('界', 'value', 5)
  assert.deepEqual(exact.stats(), { entries: 1, bytes: 8 })
  const tooSmall = createSourceCache(2, 7)
  tooSmall.set('界', 'value', 5)
  assert.deepEqual(tooSmall.stats(), { entries: 0, bytes: 0 })

  const countBound = createSourceCache(1, 100)
  countBound.set('first', 'A', 1)
  countBound.set('second', 'B', 1)
  assert.equal(countBound.get('first'), undefined)
  assert.equal(countBound.get('second'), 'B')
  assert.deepEqual(countBound.stats(), { entries: 1, bytes: 7 })
})

test('oversized unrelated values do not evict; identity, delete, clear, and stats stay local', () => {
  const cache = createSourceCache(3, 8)
  const value = { nested: ['opaque'] }
  cache.set('ok', value, 4)
  cache.set('oversized', { ignored: true }, 100)
  assert.equal(cache.get('ok'), value)
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 6 })
  const firstStats = cache.stats()
  firstStats.entries = 99
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 6 })
  cache.delete('ok')
  cache.delete('ok')
  cache.clear()
  cache.clear()
  assert.equal(cache.get('ok'), undefined)
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0 })
})
