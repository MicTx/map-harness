import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createWaybackService, waybackDescriptor, waybackSelectionMatches, WAYBACK_ENDPOINT } from '../src/wayback.ts'
import { WaybackCatalogPreparingError } from '../src/source-error.ts'
import { parseBasemapSelection } from '../../layers/src/basemap.ts'

function item(releaseNum, title, overrides = {}) {
  return {
    releaseNum,
    itemID: `${releaseNum}`.padStart(32, '0'),
    itemTitle: title,
    itemURL: `${WAYBACK_ENDPOINT}/tile/${releaseNum}/{level}/{row}/{col}`,
    metadataLayerUrl: `https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_${title.match(/Wayback (\d{4})/)[1]}_r01/MapServer`,
    metadataLayerItemID: `${releaseNum}`.padStart(32, 'f'),
    layerIdentifier: `WB_${title.match(/Wayback (\d{4})/)[1]}_R01`,
    releaseDateLabel: title.match(/\d{4}-\d{2}-\d{2}/)[0],
    ...overrides,
  }
}

const releases = [
  item(100, 'World Imagery (Wayback 2020-01-02)'),
  item(7, 'World Imagery (Wayback 2014-02-20)'),
]

function storedItems(path) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1)
    return JSON.parse(database.prepare('SELECT items FROM wayback_catalog WHERE id = 1').get().items)
  } finally {
    database.close()
  }
}

function core(overrides = {}) {
  return {
    async getWaybackItems() { return releases },
    async getWaybackItemsWithLocalChanges() { return releases },
    async getMetadata() { return { date: null, provider: null, resolution: null, accuracy: null } },
    ...overrides,
  }
}

test('startup commits the catalog without a read; scheduled bad batches cannot replace it in SQLite or memory', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const root = mkdtempSync(join(tmpdir(), 'wayback-catalog-'))
  const path = join(root, 'cache', 'map', 'wayback-catalog.sqlite')
  const valid = Promise.withResolvers()
  const calls = []
  const failures = []
  const service = createWaybackService({ cacheTtlMs: 60, core: core({
    async getWaybackItems() {
      calls.push('catalog')
      if (calls.length === 1) return valid.promise
      return [item(777, 'World Imagery (Wayback 2022-01-02)'), { ...releases[1], releaseDateLabel: '2014-02-30' }]
    },
    async getWaybackItemsWithLocalChanges() { calls.push('local'); throw new Error('not part of sync') },
    async getMetadata() { calls.push('metadata'); throw new Error('not part of sync') },
  }) })
  const restarted = createWaybackService({ core: core({
    async getWaybackItems() { calls.push('offline catalog'); throw new Error('offline') },
    async getMetadata(_point, _zoom, releaseId, _signal, expected) {
      assert.equal(releaseId, 7)
      assert.deepEqual(expected, { itemId: releases[1].itemID, metadataLayerUrl: releases[1].metadataLayerUrl })
      return { date: '2013-05-12' }
    },
  }) })
  const report = (stage, error) => failures.push([stage, error.code])
  try {
    service.startCatalogSync(path, report)
    assert.equal(existsSync(path), false)
    valid.resolve(releases)
    await service.waitForCatalog()
    const committed = storedItems(path)
    assert.deepEqual(committed, releases)
    assert.deepEqual(calls, ['catalog'])

    t.mock.timers.tick(59)
    assert.equal(service.release(7).releaseId, 7)
    assert.deepEqual(calls, ['catalog'])
    t.mock.timers.tick(1)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(failures, [['validate', 'SOURCE_UNAVAILABLE']])
    assert.deepEqual(storedItems(path), committed)
    assert.deepEqual(service.listReleases().map(release => release.releaseId), [100, 7])
    await service.dispose()
    t.mock.timers.tick(60)
    assert.deepEqual(calls, ['catalog', 'catalog'])

    restarted.startCatalogSync(path, report)
    assert.equal(restarted.release(7).releaseId, 7)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(failures, [['validate', 'SOURCE_UNAVAILABLE'], ['fetch', 'SOURCE_UNAVAILABLE']])
    assert.deepEqual(restarted.listReleases().map(release => release.releaseId), [100, 7])
    const restored = await restarted.metadataAt({ lon: 0, lat: 0 }, 12, 7)
    assert.equal(restored.acquiredAt, '2013-05-12')
    assert.deepEqual(calls, ['catalog', 'catalog', 'offline catalog'])
    assert.deepEqual(storedItems(path), committed)
  } finally {
    valid.resolve(releases)
    await service.dispose()
    await restarted.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unfinished cold sync is preparing; dispose cancels it before it can write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wayback-cancel-'))
  const path = join(root, 'catalog.sqlite')
  const started = Promise.withResolvers()
  const held = Promise.withResolvers()
  const service = createWaybackService({ core: core({
    getWaybackItems(signal) { started.resolve(signal); return held.promise },
  }) })
  try {
    service.startCatalogSync(path, (_stage, error) => { throw error })
    const signal = await started.promise
    assert.throws(() => service.listReleases(), WaybackCatalogPreparingError)
    assert.throws(() => service.release(7), WaybackCatalogPreparingError)
    let settled = false
    const disposed = service.dispose().then(() => { settled = true })
    assert.equal(signal.aborted, true)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    held.resolve(releases)
    await disposed
    assert.equal(existsSync(path), false)
  } finally {
    held.resolve(releases)
    await service.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('official releases are sorted by publication, not release-number order', async () => {
  const service = createWaybackService({ core: core() })
  await service.refreshCatalog()
  const actual = service.listReleases()
  assert.deepEqual(actual.map(value => value.releaseId), [100, 7])
  assert.equal(actual[1].publishedAt, '2014-02-20')
  assert.equal(actual[0].acquiredAt, null)
  const descriptor = waybackDescriptor(actual[1])
  assert.equal(descriptor.id, 'esri-wayback')
  assert.equal(descriptor.release.version, '7')
  assert.equal(parseBasemapSelection({ schemaVersion: 1, basemap: descriptor, labels: null }).ok, true)
  assert.equal(waybackSelectionMatches(descriptor, actual[1]), true)
  assert.equal(waybackSelectionMatches({ ...descriptor, release: { ...descriptor.release, acquiredAt: '2014-02-20' } }, actual[1]), false)
  assert.equal(waybackSelectionMatches({ ...descriptor, screenshot: 'denied' }, actual[1]), false)
  assert.equal(waybackSelectionMatches({ ...descriptor, automatedMapUse: 'denied' }, actual[1]), false)
  service.dispose()
})

test('unknown metadata does not fall back to publication or the Unix epoch', async () => {
  const service = createWaybackService({ core: core() })
  await service.refreshCatalog()
  const evidence = await service.metadataAt({ lon: 0, lat: 0 }, 12, 7)
  assert.equal(evidence.acquiredAt, null)
  assert.equal(evidence.publishedAt, '2014-02-20')
  service.dispose()
})

test('local changes retain official publication dates and can have only one release', async () => {
  const service = createWaybackService({ core: core({ async getWaybackItemsWithLocalChanges() { return [releases[0]] } }) })
  await service.refreshCatalog()
  const actual = await service.localChanges({ lon: 1, lat: 2 }, 12)
  assert.deepEqual(actual.map(value => value.releaseId), [100])
  assert.equal(actual[0].acquiredAt, null)
  service.dispose()
})

test('local results must belong to the current official catalog and be unique', async () => {
  const foreign = item(999, 'World Imagery (Wayback 2021-01-01)')
  const missing = createWaybackService({ core: core({ async getWaybackItemsWithLocalChanges() { return [foreign] } }) })
  await missing.refreshCatalog()
  await assert.rejects(missing.localChanges({ lon: 1, lat: 2 }, 12), { code: 'SOURCE_CHANGED' })
  await missing.dispose()
  const duplicated = createWaybackService({ core: core({ async getWaybackItemsWithLocalChanges() { return [releases[0], releases[0]] } }) })
  await duplicated.refreshCatalog()
  await assert.rejects(duplicated.localChanges({ lon: 1, lat: 2 }, 12), { code: 'SOURCE_CHANGED' })
  await duplicated.dispose()
})

test('catalog and malformed releases fail closed; disposal cancels active work', async () => {
  const service = createWaybackService({ core: core({ async getWaybackItems() { return [item(1, 'World Imagery (Wayback 2020-01-02)', { itemURL: 'https://attacker.invalid/tile' })] } }) })
  await assert.rejects(service.refreshCatalog(), { code: 'SOURCE_RESOURCE_DENIED' })
  service.dispose()
  assert.throws(() => service.listReleases(), { code: 'SOURCE_CANCELLED' })
})

test('catalog reads never refresh, and metadata preserves an explicit acquisition date', async () => {
  let now = 0
  let calls = 0
  const service = createWaybackService({
    now: () => now,
    core: core({
      async getWaybackItems() { calls += 1; return releases },
      async getMetadata() { return { date: '2010-04-03', provider: 'Example', resolution: 0.5, accuracy: 8.47 } },
    }),
  })
  assert.throws(() => service.listReleases(), { code: 'SOURCE_UNAVAILABLE' })
  assert.equal(calls, 0)
  await service.refreshCatalog()
  service.listReleases()
  assert.equal(calls, 1)
  const evidence = await service.metadataAt({ lon: 0, lat: 0 }, 12, 7)
  assert.equal(evidence.acquiredAt, '2010-04-03')
  assert.equal(evidence.resolution, '0.5')
  assert.equal(evidence.accuracy, '8.47')
  assert.notEqual(evidence.acquiredAt, evidence.publishedAt)
  now = 300001
  assert.equal(service.listReleases().length, 2)
  assert.equal(service.release(7).releaseId, 7)
  assert.equal(calls, 1)
  service.dispose()
})

test('a deadline rejects an uncooperative catalog and disposal waits for it to settle', async () => {
  let release
  const delayed = new Promise(resolve => { release = resolve })
  const service = createWaybackService({
    requestTimeoutMs: 20,
    core: core({ getWaybackItems: () => delayed }),
  })
  await assert.rejects(service.refreshCatalog(), { code: 'SOURCE_TIMEOUT' })
  let disposed = false
  const disposal = service.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  release(releases)
  await disposal
  assert.equal(disposed, true)
  assert.throws(() => service.listReleases(), { code: 'SOURCE_CANCELLED' })
})

test('independent refresh operations do not cancel each other', async () => {
  const reads = []
  const service = createWaybackService({
    core: core({
      getWaybackItems(signal) {
        return new Promise((resolve, reject) => {
          reads.push({ resolve, reject })
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        })
      },
    }),
  })
  const first = new AbortController()
  const firstRead = service.refreshCatalog(first.signal)
  const secondRead = service.refreshCatalog()
  await new Promise(resolve => setImmediate(resolve))
  first.abort()
  await assert.rejects(firstRead, { code: 'SOURCE_CANCELLED' })
  assert.equal(reads.length, 2)
  reads[1].resolve(releases)
  assert.equal((await secondRead).length, 2)
  await service.dispose()
})

test('only a successful refresh can remove a fixed release from the local catalog', async () => {
  let current = releases
  const service = createWaybackService({ core: core({ async getWaybackItems() { return current } }) })
  await service.refreshCatalog()
  assert.equal(service.cachedRelease(7).releaseId, 7)
  current = [releases[0]]
  assert.equal(service.release(7).releaseId, 7)
  await service.refreshCatalog()
  assert.equal(service.cachedRelease(7), undefined)
  assert.throws(() => service.release(7), { code: 'SOURCE_NOT_FOUND' })
  await service.dispose()
})

test('a failed catalog refresh keeps the last verified fixed release', async () => {
  let broken = false
  const service = createWaybackService({
    core: core({ async getWaybackItems() { if (broken) throw new Error('damaged catalog'); return releases } }),
  })
  try {
    await service.refreshCatalog()
    broken = true
    await assert.rejects(service.refreshCatalog(), { code: 'SOURCE_UNAVAILABLE' })
    assert.equal(service.release(7).releaseId, 7)
  } finally {
    await service.dispose()
  }
})

test('metadata reads carry the verified catalog identity to the reader', async () => {
  let received
  const service = createWaybackService({
    core: core({
      async getMetadata(_point, _zoom, releaseNumber, _signal, expected) {
        received = { releaseNumber, expected }
        return { date: '2010-04-03' }
      },
    }),
  })
  try {
    await service.refreshCatalog()
    const evidence = await service.metadataAt({ lon: 0, lat: 0 }, 12, 7)
    assert.equal(evidence.acquiredAt, '2010-04-03')
    assert.deepEqual(received, {
      releaseNumber: 7,
      expected: {
        itemId: '7'.padStart(32, '0'),
        metadataLayerUrl: 'https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2014_r01/MapServer',
      },
    })
  } finally {
    await service.dispose()
  }
})

test('local evidence rejects a release whose live metadata identity drifted', async () => {
  const drifted = { ...releases[0], metadataLayerUrl: releases[0].metadataLayerUrl.replace('2020', '2021') }
  const service = createWaybackService({ core: core({ async getWaybackItemsWithLocalChanges() { return [drifted] } }) })
  try {
    // The normalized release is unchanged, so only the live item identity can
    // tell the drifted official config apart from the verified catalog.
    await service.refreshCatalog()
    await assert.rejects(service.localChanges({ lon: 1, lat: 2 }, 12), { code: 'SOURCE_CHANGED' })
  } finally {
    await service.dispose()
  }
})

test('metadata reads keep the identity of the catalog snapshot that supplied the release', async () => {
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  let current = releases
  const drifted = {
    ...releases[0],
    itemID: 'd'.repeat(32),
    metadataLayerUrl: releases[0].metadataLayerUrl.replace('2020', '2021'),
  }
  const service = createWaybackService({
    core: core({
      async getWaybackItems() { return current },
      async getMetadata(_point, _zoom, releaseNumber, _signal, expected) {
        entered.resolve({ releaseNumber, expected })
        await finish.promise
        return { date: '2010-04-03' }
      },
    }),
  })
  try {
    await service.refreshCatalog()
    const pendingMetadata = service.metadataAt({ lon: 0, lat: 0 }, 12, 100)
    const received = await entered.promise
    current = [drifted, releases[1]]
    await service.refreshCatalog()
    assert.equal(service.release(100).itemId, drifted.itemID)
    finish.resolve()
    const evidence = await pendingMetadata
    assert.equal(evidence.publishedAt, '2020-01-02')
    // The release object came from the older snapshot, so its identity must
    // come from that snapshot too; the newer cached generation cannot lend it.
    assert.deepEqual(received, {
      releaseNumber: 100,
      expected: { itemId: '100'.padStart(32, '0'), metadataLayerUrl: releases[0].metadataLayerUrl },
    })
  } finally {
    finish.resolve()
    await service.dispose()
  }
})

test('local evidence is bound to the catalog snapshot it captured', async () => {
  const entered = Promise.withResolvers()
  const finish = Promise.withResolvers()
  let current = releases
  const drifted = {
    ...releases[0],
    itemID: 'd'.repeat(32),
    metadataLayerUrl: releases[0].metadataLayerUrl.replace('2020', '2021'),
  }
  const service = createWaybackService({
    core: core({
      async getWaybackItems() { return current },
      async getWaybackItemsWithLocalChanges() { entered.resolve(); await finish.promise; return releases },
    }),
  })
  try {
    await service.refreshCatalog()
    const local = service.localChanges({ lon: 1, lat: 2 }, 12)
    await entered.promise
    current = [drifted, releases[1]]
    await service.refreshCatalog()
    finish.resolve()
    // The live items still match the older captured snapshot; comparing them
    // against a newer cached identity would reject honest evidence.
    assert.deepEqual((await local).map(value => value.releaseId), [7, 100])
  } finally {
    finish.resolve()
    await service.dispose()
  }
})

test('coverage samples keep the identity of the release snapshot captured at start', async () => {
  const expecteds = []
  let reads = 0
  let current = releases
  const drifted = {
    ...releases[0],
    itemID: 'd'.repeat(32),
    metadataLayerUrl: releases[0].metadataLayerUrl.replace('2020', '2021'),
  }
  const service = createWaybackService({
    sampleConcurrency: () => 1,
    core: core({
      async getWaybackItems() { return current },
      async getMetadata(_point, _zoom, _releaseNumber, _signal, expected) {
        expecteds.push(expected)
        reads += 1
        if (reads === 1) {
          current = [drifted, releases[1]]
          await service.refreshCatalog()
        }
        return { date: '2010-04-03' }
      },
    }),
  })
  try {
    await service.refreshCatalog()
    assert.equal((await service.coverage({ center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326 }, 12, 100)).coverage, 'sampled')
    assert.ok(expecteds.length >= 2)
    for (const expected of expecteds) {
      assert.deepEqual(expected, { itemId: '100'.padStart(32, '0'), metadataLayerUrl: releases[0].metadataLayerUrl })
    }
  } finally {
    await service.dispose()
  }
})

test('local evidence is bounded by point, zoom, and the current catalog generation', async () => {
  let now = 0
  let catalog = releases
  let localCalls = 0
  const service = createWaybackService({
    cacheTtlMs: 10, localCacheMaxEntries: 1, now: () => now,
    core: core({
      async getWaybackItems() { return catalog },
      async getWaybackItemsWithLocalChanges() { localCalls += 1; return [catalog[0]] },
    }),
  })
  try {
    await service.refreshCatalog()
    await service.localChanges({ lon: 1, lat: 2 }, 12)
    await service.localChanges({ lon: 1, lat: 2 }, 12)
    assert.equal(localCalls, 1)
    await service.localChanges({ lon: 3, lat: 2 }, 12)
    await service.localChanges({ lon: 1, lat: 2 }, 12)
    assert.equal(localCalls, 3)
    now = 11
    catalog = [releases[1]]
    await service.refreshCatalog()
    assert.equal((await service.localChanges({ lon: 1, lat: 2 }, 12))[0].releaseId, 7)
    assert.equal(localCalls, 4)
  } finally {
    await service.dispose()
  }
})

test('a capacity-refused catalog read never suppresses an in-flight successful refresh', async () => {
  const held = Promise.withResolvers()
  const service = createWaybackService({
    maxConcurrentRequests: 1,
    core: core({ getWaybackItems: () => held.promise }),
  })
  try {
    const first = service.refreshCatalog()
    await assert.rejects(service.refreshCatalog(), { code: 'SOURCE_LIMIT_EXCEEDED' })
    held.resolve(releases)
    assert.equal((await first).length, 2)
    assert.equal(service.cachedRelease(7)?.releaseId, 7)
  } finally {
    await service.dispose()
  }
})

test('a cancelled newer catalog read still lets the older successful refresh cache', async () => {
  const pending = []
  const service = createWaybackService({ core: core({ getWaybackItems: () => new Promise(resolve => pending.push(resolve)) }) })
  try {
    const older = service.refreshCatalog()
    const newerController = new AbortController()
    const newer = service.refreshCatalog(newerController.signal)
    await new Promise(resolve => setImmediate(resolve))
    newerController.abort()
    await assert.rejects(newer, { code: 'SOURCE_CANCELLED' })
    pending[0](releases)
    assert.equal((await older).length, 2)
    assert.equal(service.cachedRelease(7)?.releaseId, 7)
  } finally {
    pending[1]?.(releases)
    await service.dispose()
  }
})

test('a late older catalog response cannot replace a newer completed refresh', async () => {
  const pending = []
  const service = createWaybackService({ core: core({ getWaybackItems: () => new Promise(resolve => pending.push(resolve)) }) })
  try {
    const olderRead = service.refreshCatalog()
    const newerRead = service.refreshCatalog()
    await new Promise(resolve => setImmediate(resolve))
    pending[1]([releases[0]])
    assert.equal((await newerRead).length, 1)
    pending[0](releases)
    assert.equal((await olderRead).length, 2)
    assert.equal(service.cachedRelease(7), undefined)
    assert.equal(service.listReleases().length, 1)
  } finally {
    await service.dispose()
  }
})

test('coverage disposal waits for samples that ignore cancellation', async () => {
  const started = Promise.withResolvers()
  const held = Promise.withResolvers()
  let entered = 0
  const service = createWaybackService({
    core: core({
      getMetadata() {
        entered += 1
        if (entered === 5) started.resolve()
        return held.promise
      },
    }),
  })
  await service.refreshCatalog()
  const pending = service.coverage({ center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326 }, 12, 7)
  await started.promise
  const refusal = assert.rejects(pending, { code: 'SOURCE_CANCELLED' })
  const disposal = service.dispose()
  await refusal
  let disposed = false
  void disposal.then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  held.resolve(null)
  await disposal
  assert.equal(disposed, true)
})

test('coverage treats same-day metadata disagreement as partial, not sampled', async () => {
  const date = '2010-04-03'
  const sampled = createWaybackService({ core: core({ async getMetadata() { return { date, provider: 'Example', resolution: 0.5, accuracy: 8.47 } } }) })
  try {
    await sampled.refreshCatalog()
    assert.equal((await sampled.coverage({ center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326 }, 12, 7)).coverage, 'sampled')
  } finally {
    await sampled.dispose()
  }
  const differing = createWaybackService({
    core: core({
      async getMetadata(point) {
        return point.longitude === 1 && point.latitude === 1
          ? { date, provider: 'Example', resolution: 0.5, accuracy: 8.47 }
          : { date, provider: 'Other', resolution: 10, accuracy: 8.47 }
      },
    }),
  })
  try {
    await differing.refreshCatalog()
    assert.equal((await differing.coverage({ center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326 }, 12, 7)).coverage, 'partial')
  } finally {
    await differing.dispose()
  }
})

test('coverage never exceeds the owning source network concurrency', async () => {
  let active = 0
  let peak = 0
  const service = createWaybackService({
    sampleConcurrency: () => 1,
    core: core({
      getMetadata() {
        active += 1
        peak = Math.max(peak, active)
        return new Promise(resolve => setImmediate(() => {
          active -= 1
          resolve({ date: '2010-04-03', provider: 'Example', resolution: 0.5, accuracy: 8.47 })
        }))
      },
    }),
  })
  try {
    await service.refreshCatalog()
    assert.equal((await service.coverage({ center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326 }, 12, 7)).coverage, 'sampled')
    assert.equal(peak, 1)
  } finally {
    await service.dispose()
  }
})
