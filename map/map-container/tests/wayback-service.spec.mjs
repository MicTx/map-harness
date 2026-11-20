import test from 'node:test'
import assert from 'node:assert/strict'
import { createWaybackService, waybackDescriptor, waybackSelectionMatches, WAYBACK_ENDPOINT } from '../src/wayback.ts'
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

function core(overrides = {}) {
  return {
    async getWaybackItems() { return releases },
    async getWaybackItemsWithLocalChanges() { return releases },
    async getMetadata() { return { date: null, provider: null, resolution: null, accuracy: null } },
    ...overrides,
  }
}

test('official releases are sorted by publication, not release-number order', async () => {
  const service = createWaybackService({ core: core() })
  const actual = await service.listReleases()
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
  const evidence = await service.metadataAt({ lon: 0, lat: 0 }, 12, 7)
  assert.equal(evidence.acquiredAt, null)
  assert.equal(evidence.publishedAt, '2014-02-20')
  service.dispose()
})

test('local changes retain official publication dates and can have only one release', async () => {
  const service = createWaybackService({ core: core({ async getWaybackItemsWithLocalChanges() { return [releases[0]] } }) })
  const actual = await service.localChanges({ lon: 1, lat: 2 }, 12)
  assert.deepEqual(actual.map(value => value.releaseId), [100])
  assert.equal(actual[0].acquiredAt, null)
  service.dispose()
})

test('local results must belong to the current official catalog and be unique', async () => {
  const foreign = item(999, 'World Imagery (Wayback 2021-01-01)')
  const missing = createWaybackService({ core: core({ async getWaybackItemsWithLocalChanges() { return [foreign] } }) })
  await assert.rejects(missing.localChanges({ lon: 1, lat: 2 }, 12), { code: 'SOURCE_CHANGED' })
  await missing.dispose()
  const duplicated = createWaybackService({ core: core({ async getWaybackItemsWithLocalChanges() { return [releases[0], releases[0]] } }) })
  await assert.rejects(duplicated.localChanges({ lon: 1, lat: 2 }, 12), { code: 'SOURCE_CHANGED' })
  await duplicated.dispose()
})

test('catalog and malformed releases fail closed; disposal cancels active work', async () => {
  const service = createWaybackService({ core: core({ async getWaybackItems() { return [item(1, 'World Imagery (Wayback 2020-01-02)', { itemURL: 'https://attacker.invalid/tile' })] } }) })
  await assert.rejects(service.listReleases(), { code: 'SOURCE_RESOURCE_DENIED' })
  service.dispose()
  await assert.rejects(service.listReleases(), { code: 'SOURCE_CANCELLED' })
})

test('cache expires and metadata preserves an explicit acquisition date', async () => {
  let now = 0
  let calls = 0
  const service = createWaybackService({
    now: () => now,
    core: core({
      async getWaybackItems() { calls += 1; return releases },
      async getMetadata() { return { date: '2010-04-03', provider: 'Example', resolution: 0.5, accuracy: 8.47 } },
    }),
  })
  await service.listReleases()
  await service.listReleases()
  assert.equal(calls, 1)
  const evidence = await service.metadataAt({ lon: 0, lat: 0 }, 12, 7)
  assert.equal(evidence.acquiredAt, '2010-04-03')
  assert.equal(evidence.resolution, '0.5')
  assert.equal(evidence.accuracy, '8.47')
  assert.notEqual(evidence.acquiredAt, evidence.publishedAt)
  now = 300001
  await service.listReleases()
  assert.equal(calls, 2)
  service.dispose()
})

test('a deadline rejects an uncooperative catalog and disposal waits for it to settle', async () => {
  let release
  const delayed = new Promise(resolve => { release = resolve })
  const service = createWaybackService({
    requestTimeoutMs: 20,
    core: core({ getWaybackItems: () => delayed }),
  })
  await assert.rejects(service.listReleases(), { code: 'SOURCE_TIMEOUT' })
  let disposed = false
  const disposal = service.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  release(releases)
  await disposal
  assert.equal(disposed, true)
  await assert.rejects(service.listReleases(), { code: 'SOURCE_CANCELLED' })
})

test('independent catalog callers do not cancel each other', async () => {
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
  const firstRead = service.listReleases(first.signal)
  const secondRead = service.listReleases()
  await new Promise(resolve => setImmediate(resolve))
  first.abort()
  await assert.rejects(firstRead, { code: 'SOURCE_CANCELLED' })
  assert.equal(reads.length, 2)
  reads[1].resolve(releases)
  assert.equal((await secondRead).length, 2)
  await service.dispose()
})

test('catalog expiration refreshes the listing but keeps the last verified fixed release', async () => {
  let now = 0
  let current = releases
  const service = createWaybackService({ cacheTtlMs: 10, now: () => now, core: core({ async getWaybackItems() { return current } }) })
  await service.listReleases()
  assert.equal(service.cachedRelease(7).releaseId, 7)
  now = 10
  // An expired listing still identifies the fixed release it last verified:
  // tile reads must not fail merely because the listing cache aged out.
  assert.equal(service.cachedRelease(7).releaseId, 7)
  current = [releases[0]]
  await service.listReleases()
  assert.equal(service.cachedRelease(7), undefined)
  await assert.rejects(service.release(7), { code: 'SOURCE_NOT_FOUND' })
  await service.dispose()
})

test('a failed catalog refresh keeps the last verified fixed release', async () => {
  let now = 0
  let broken = false
  const service = createWaybackService({
    cacheTtlMs: 10, now: () => now,
    core: core({ async getWaybackItems() { if (broken) throw new Error('damaged catalog'); return releases } }),
  })
  try {
    await service.listReleases()
    now = 11
    broken = true
    await assert.rejects(service.listReleases(), { code: 'SOURCE_UNAVAILABLE' })
    // A rejected refresh must not replace the snapshot that verified release 7.
    assert.equal(service.cachedRelease(7)?.releaseId, 7)
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
    await assert.rejects(service.localChanges({ lon: 1, lat: 2 }, 12), { code: 'SOURCE_CHANGED' })
  } finally {
    await service.dispose()
  }
})

test('metadata reads keep the identity of the catalog snapshot that supplied the release', async () => {
  const pending = []
  const received = []
  const drifted = {
    ...releases[0],
    itemID: 'd'.repeat(32),
    metadataLayerUrl: releases[0].metadataLayerUrl.replace('2020', '2021'),
  }
  const service = createWaybackService({
    core: core({
      getWaybackItems() { return new Promise(resolve => pending.push(resolve)) },
      async getMetadata(_point, _zoom, releaseNumber, _signal, expected) {
        received.push({ releaseNumber, expected })
        return { date: '2010-04-03' }
      },
    }),
  })
  try {
    // metadataAt starts an older catalog read; a newer generation lands in the
    // cache first, then the older snapshot supplies the release to read.
    const pendingMetadata = service.metadataAt({ lon: 0, lat: 0 }, 12, 100)
    await new Promise(resolve => setImmediate(resolve))
    const newer = service.listReleases()
    await new Promise(resolve => setImmediate(resolve))
    pending[1]([drifted, releases[1]])
    await newer
    pending[0](releases)
    const evidence = await pendingMetadata
    assert.equal(evidence.publishedAt, '2020-01-02')
    // The release object came from the older snapshot, so its identity must
    // come from that snapshot too; the newer cached generation cannot lend it.
    assert.deepEqual(received.at(-1), {
      releaseNumber: 100,
      expected: { itemId: '100'.padStart(32, '0'), metadataLayerUrl: releases[0].metadataLayerUrl },
    })
  } finally {
    await service.dispose()
  }
})

test('local evidence is bound to the catalog snapshot it captured', async () => {
  const pending = []
  const drifted = {
    ...releases[0],
    itemID: 'd'.repeat(32),
    metadataLayerUrl: releases[0].metadataLayerUrl.replace('2020', '2021'),
  }
  const service = createWaybackService({
    core: core({
      getWaybackItems() { return new Promise(resolve => pending.push(resolve)) },
      async getWaybackItemsWithLocalChanges() { return releases },
    }),
  })
  try {
    const local = service.localChanges({ lon: 1, lat: 2 }, 12)
    await new Promise(resolve => setImmediate(resolve))
    const newer = service.listReleases()
    await new Promise(resolve => setImmediate(resolve))
    pending[1]([drifted, releases[1]])
    await newer
    pending[0](releases)
    // The live items still match the older captured snapshot; comparing them
    // against a newer cached identity would reject honest evidence.
    assert.deepEqual((await local).map(value => value.releaseId), [7, 100])
  } finally {
    await service.dispose()
  }
})

test('coverage samples keep the identity of the release snapshot captured at start', async () => {
  const pending = []
  const expecteds = []
  let reads = 0
  let now = 0
  const drifted = {
    ...releases[0],
    itemID: 'd'.repeat(32),
    metadataLayerUrl: releases[0].metadataLayerUrl.replace('2020', '2021'),
  }
  const service = createWaybackService({
    cacheTtlMs: 10, now: () => now, sampleConcurrency: () => 1,
    core: core({
      getWaybackItems() { return new Promise(resolve => pending.push(resolve)) },
      async getMetadata(_point, _zoom, _releaseNumber, _signal, expected) {
        expecteds.push(expected)
        reads += 1
        if (reads === 1) {
          // A newer catalog generation completes while serial samples run.
          now = 11
          const newer = service.listReleases()
          await new Promise(resolve => setImmediate(resolve))
          pending[1]([drifted, releases[1]])
          await newer
        }
        return { date: '2010-04-03' }
      },
    }),
  })
  try {
    const coverage = service.coverage({ center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326 }, 12, 100)
    await new Promise(resolve => setImmediate(resolve))
    pending[0](releases)
    assert.equal((await coverage).coverage, 'sampled')
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
    await service.localChanges({ lon: 1, lat: 2 }, 12)
    await service.localChanges({ lon: 1, lat: 2 }, 12)
    assert.equal(localCalls, 1)
    await service.localChanges({ lon: 3, lat: 2 }, 12)
    await service.localChanges({ lon: 1, lat: 2 }, 12)
    assert.equal(localCalls, 3)
    now = 11
    catalog = [releases[1]]
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
    const first = service.listReleases()
    await assert.rejects(service.listReleases(), { code: 'SOURCE_LIMIT_EXCEEDED' })
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
    const older = service.listReleases()
    const newerController = new AbortController()
    const newer = service.listReleases(newerController.signal)
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
    const olderRead = service.listReleases()
    const newerRead = service.listReleases()
    await new Promise(resolve => setImmediate(resolve))
    pending[1]([releases[0]])
    assert.equal((await newerRead).length, 1)
    pending[0](releases)
    assert.equal((await olderRead).length, 2)
    assert.equal(service.cachedRelease(7), undefined)
    assert.equal((await service.listReleases()).length, 1)
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
    assert.equal((await service.coverage({ center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326 }, 12, 7)).coverage, 'sampled')
    assert.equal(peak, 1)
  } finally {
    await service.dispose()
  }
})
