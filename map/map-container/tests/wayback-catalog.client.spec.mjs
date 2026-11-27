import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WAYBACK_CONFIG_URL, WAYBACK_ENDPOINT } from '../src/wayback-catalog-codec.ts'
import { createWaybackCatalogOwner, WAYBACK_CATALOG_STORAGE_KEY } from '../src/client/wayback-catalog.ts'

const itemId = digit => digit.repeat(32)
const entry = (release, date, digit) => ({
  itemTitle: `World Imagery (Wayback ${date})`,
  releaseDateLabel: date,
  itemID: itemId(digit),
  itemURL: `${WAYBACK_ENDPOINT}/tile/${release}/{level}/{row}/{col}`,
  metadataLayerUrl: `https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_${date.slice(0, 4)}_r01/MapServer`,
  metadataLayerItemID: itemId(digit === 'a' ? 'b' : 'c'),
  layerIdentifier: `WB_${date.slice(0, 4)}_R01`,
})
const bodyOf = (...releases) => JSON.stringify(Object.fromEntries(releases.map(([id, date, digit]) => [String(id), entry(id, date, digit)])))
const OLD = bodyOf([10, '2014-02-20', 'a'])
const NEW = bodyOf([10, '2014-02-20', 'a'], [50, '2025-10-29', 'd'])
const ids = snapshot => snapshot.releases.map(release => release.releaseId)

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    namespace: 'test',
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: key => { map.delete(key) },
    keys: () => [...map.keys()],
    subscribe: () => () => {},
  }
}

function harness({ storage = memoryStorage(), replies = [], now = 1_000_000, maxBodyBytes = 1 << 20 } = {}) {
  const queue = [...replies]
  const state = { now, calls: [], owner: undefined, replies: queue }
  const fetch = async (url, init) => {
    state.calls.push({ url, init })
    const reply = queue.shift()
    if (reply === undefined) throw new Error('unexpected fetch')
    return typeof reply === 'function' ? reply(url, init) : reply
  }
  const options = {
    storage, fetch, now: () => state.now, ttlMs: 60_000, timeoutMs: 2_000, maxBodyBytes,
  }
  state.owner = createWaybackCatalogOwner(options)
  state.restart = () => { state.owner = createWaybackCatalogOwner(options) }
  return state
}

const ok = (body, headers) => new Response(body, { status: 200, headers })

test('construction never reads storage, and the first load rejects a foreign cache version', async () => {
  const storage = memoryStorage({ [WAYBACK_CATALOG_STORAGE_KEY]: JSON.stringify({ version: 99, fetchedAt: 5, items: [] }) })
  const getItem = storage.getItem
  let reads = 0
  storage.getItem = key => { reads += 1; return getItem(key) }
  const state = harness({ storage, replies: [ok(OLD)] })
  assert.equal(reads, 0)
  assert.equal(state.calls.length, 0)
  assert.equal(state.owner.getSnapshot().phase, 'empty')
  assert.deepEqual(ids(await state.owner.ensureFresh()), [10])
  assert.equal(reads, 1)
  assert.equal(state.calls.length, 1)
})

test('a persisted record whose digest does not match its items is ignored', async () => {
  const state = harness({
    storage: memoryStorage({ [WAYBACK_CATALOG_STORAGE_KEY]: JSON.stringify({ version: 1, fetchedAt: 5, digest: 'deadbeef', items: [{ releaseNum: 10, ...entry(10, '2014-02-20', 'a') }] }) }),
    replies: [() => { throw 'connection interrupted' }, ok(NEW)],
  })
  assert.equal((await state.owner.ensureFresh()).reason, 'network')
  assert.deepEqual(ids(state.owner.getSnapshot()), [])
  assert.deepEqual(ids(await state.owner.refresh()), [50, 10])
})

test('first ensureFresh fetches credential-free, publishes ready and persists a versioned record', async () => {
  const storage = memoryStorage()
  const state = harness({ storage, replies: [ok(NEW)] })
  const owner = state.owner
  const seen = []
  const unsubscribe = owner.subscribe(() => seen.push(owner.getSnapshot().phase + (owner.getSnapshot().refreshing ? ':loading' : '')))
  const initial = owner.getSnapshot()
  assert.deepEqual({ ...initial, releases: initial.releases.length }, { phase: 'empty', releases: 0, fetchedAt: null, digest: null, refreshing: false, reason: null })
  const settled = await owner.ensureFresh()
  assert.equal(seen.join(','), 'empty:loading,ready')
  assert.equal(owner.getSnapshot(), settled)
  assert.deepEqual(ids(settled), [50, 10])
  assert.equal(settled.fetchedAt, 1_000_000)
  assert.equal(settled.reason, null)
  assert.ok(Object.isFrozen(settled) && Object.isFrozen(settled.releases))
  const { url, init } = state.calls[0]
  assert.equal(url, WAYBACK_CONFIG_URL)
  const { signal, ...request } = init
  assert.deepEqual(request, {
    method: 'GET', mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
    headers: { accept: 'application/json' },
  })
  assert.ok(signal instanceof AbortSignal)
  const saved = JSON.parse(storage.getItem(WAYBACK_CATALOG_STORAGE_KEY))
  assert.equal(saved.version, 1)
  assert.equal(saved.fetchedAt, 1_000_000)
  assert.equal(saved.digest, settled.digest)
  assert.equal(saved.items.length, 2)
  unsubscribe()
  assert.equal(seen.length, 2)
})

test('a persisted record restores after restart and stays fresh until the TTL passes', async () => {
  const storage = memoryStorage()
  const first = harness({ storage, replies: [ok(OLD)] })
  await first.owner.ensureFresh()
  const second = harness({ storage, replies: [ok(NEW)] })
  await second.owner.ensureFresh()
  assert.deepEqual(ids(second.owner.getSnapshot()), [10])
  assert.equal(second.owner.getSnapshot().fetchedAt, 1_000_000)
  assert.equal(second.calls.length, 0)
  second.now += 60_000
  const settled = await second.owner.ensureFresh()
  assert.equal(second.calls.length, 1)
  assert.deepEqual(ids(settled), [50, 10])
})

test('concurrent ensureFresh calls share one request; refresh forces a new one', async () => {
  let release
  const state = harness({ replies: [() => new Promise(resolve => { release = resolve })]})
  const owner = state.owner
  const first = owner.ensureFresh()
  const second = owner.ensureFresh()
  await Promise.resolve()
  assert.equal(state.calls.length, 1)
  assert.equal(owner.getSnapshot().refreshing, true)
  release(ok(OLD))
  assert.equal(await first, await second)
  assert.equal(state.calls.length, 1)
  state.replies.push(ok(NEW))
  assert.deepEqual(ids(await owner.refresh()), [50, 10])
  assert.equal(state.calls.length, 2)
})

for (const [name, reply, reason] of [
  ['HTTP failure', new Response('x', { status: 503 }), 'http'],
  ['network failure', () => { throw new TypeError('Failed to fetch https://secret.example') }, 'network'],
  ['invalid catalog', ok('{"10":[]}'), 'invalid'],
  ['oversized body', () => new Response(new ReadableStream({ pull: c => c.enqueue(new Uint8Array(2_097_152)), cancel() {} }), { status: 200 }), 'oversized'],
]) {
  test(`a ${name} keeps the stale ready catalog with reason ${reason}, and a forced retry recovers`, async () => {
      const storage = memoryStorage()
      const state = harness({ storage, replies: [ok(OLD), reply, ok(NEW)] })
      await state.owner.ensureFresh()
      state.now += 60_000
      const failed = await state.owner.ensureFresh()
      assert.equal(failed.phase, 'ready')
      assert.deepEqual(ids(failed), [10])
      assert.equal(failed.fetchedAt, 1_000_000)
      assert.equal(failed.reason, reason)
      assert.equal(failed.refreshing, false)
      assert.equal(JSON.parse(storage.getItem(WAYBACK_CATALOG_STORAGE_KEY)).items.length, 1)
      state.now += 60_000
      const recovered = await state.owner.refresh()
      assert.equal(recovered.reason, null)
      assert.deepEqual(ids(recovered), [50, 10])
    })
}

test('a redirect is refused', async () => {
  const redirected = { ...ok(OLD), redirected: true, url: 'https://example.com/other' }
  const state = harness({ replies: [redirected] })
  const settled = await state.owner.ensureFresh()
  assert.equal(settled.phase, 'empty')
  assert.equal(settled.reason, 'redirect')
})

test('the request is aborted after the timeout', async () => {
  let signal
  const state = harness({ replies: [(_url, init) => new Promise((_resolve, reject) => {
    signal = init.signal
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })] })
  const settled = await state.owner.ensureFresh()
  assert.equal(signal.aborted, true)
  assert.deepEqual({ phase: settled.phase, reason: settled.reason, refreshing: settled.refreshing }, { phase: 'empty', reason: 'timeout', refreshing: false })
})

test('a caller abort reports aborted without cancelling the shared request for others', async () => {
  let release
  const state = harness({ replies: [() => new Promise(resolve => { release = resolve })]})
  const caller = new AbortController()
  const mine = state.owner.ensureFresh(caller.signal)
  const other = state.owner.ensureFresh()
  caller.abort()
  assert.equal(state.calls[0].init.signal.aborted, false)
  assert.equal(state.owner.getSnapshot().refreshing, true)
  release(ok(OLD))
  assert.equal((await mine).reason, 'aborted')
  assert.equal((await other).reason, null)
  assert.deepEqual(ids(await state.owner.ensureFresh()), [10])
  assert.equal(state.calls.length, 1)
})

test('a body over the byte limit is cancelled and rejected', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(64)) },
    cancel() { cancelled = true },
  })
  const state = harness({ maxBodyBytes: 100, replies: [new Response(stream, { status: 200 })] })
  const settled = await state.owner.ensureFresh()
  assert.equal(settled.reason, 'oversized')
  assert.equal(cancelled, true)
  const declared = harness({ maxBodyBytes: 100, replies: [ok('{}', { 'content-length': '5000' })] })
  assert.equal((await declared.owner.ensureFresh()).reason, 'oversized')
  assert.equal(declared.calls.length, 1)
})

test('a failed persistence write keeps the fetched catalog and reports storage', async () => {
  const storage = memoryStorage()
  storage.setItem = () => { throw new Error('QuotaExceededError') }
  const state = harness({ storage, replies: [ok(OLD)] })
  const settled = await state.owner.ensureFresh()
  assert.deepEqual({ phase: settled.phase, reason: settled.reason, ids: ids(settled) }, { phase: 'ready', reason: 'storage', ids: [10] })
})

test('dispose aborts the shared request, stops notifying, and later calls report disposed', async () => {
  let signal
  const state = harness({ replies: [(_url, init) => new Promise((_resolve, reject) => {
    signal = init.signal
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })] })
  const owner = state.owner
  let notifications = 0
  owner.subscribe(() => { notifications += 1 })
  const pending = owner.ensureFresh()
  owner.dispose()
  assert.equal(signal.aborted, true)
  assert.equal((await pending).reason, 'disposed')
  assert.equal(notifications, 1)
  assert.equal((await owner.refresh()).reason, 'disposed')
  assert.equal(state.calls.length, 1)
})

test('invalid options fail at construction', () => {
  const base = { storage: memoryStorage(), ttlMs: 1, timeoutMs: 1, maxBodyBytes: 1 }
  for (const patch of [{ ttlMs: 0 }, { timeoutMs: -1 }, { maxBodyBytes: 1.5 }, { storage: undefined }]) {
    assert.throws(() => createWaybackCatalogOwner({ ...base, ...patch }), TypeError)
  }
})
