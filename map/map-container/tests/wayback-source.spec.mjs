import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWaybackService, waybackDescriptor, WAYBACK_ENDPOINT } from '../src/wayback.ts'
import { createMapSourceCatalog } from '../src/sources.ts'
import { createMapSourceService } from '../src/source-service.ts'
import { createMapSourceRoutes } from '../src/source-route.ts'
import { parseWaybackCapabilities } from '../src/wayback-capabilities.ts'
import { compileSourceResource } from '../src/source-resource.ts'
import sharp from 'sharp'

const officialCapabilities = readFileSync(new URL('./fixtures/wayback-capabilities.xml', import.meta.url))

function item(releaseNum, title, layerIdentifier) {
  return {
    releaseNum,
    itemID: `${releaseNum}`.padStart(32, '0'),
    itemTitle: title,
    itemURL: `${WAYBACK_ENDPOINT}/tile/${releaseNum}/{level}/{row}/{col}`,
    metadataLayerUrl: `https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_${layerIdentifier.slice(3, 7)}_r${layerIdentifier.slice(-2)}/MapServer`,
    metadataLayerItemID: `${releaseNum}`.padStart(32, 'f'),
    layerIdentifier,
    releaseDateLabel: title.match(/\d{4}-\d{2}-\d{2}/)[0],
  }
}

const releases = [
  item(43291, 'World Imagery (Wayback 2026-10-29)', 'WB_2026_R10'),
  item(10, 'World Imagery (Wayback 2014-02-20)', 'WB_2014_R01'),
]

/** The default three-layer imagery display a route-consumer state carries. */
const idleImagery = { labelsVisible: false, recentVisible: true, recentOpacity: 1, earlyVisible: false, earlySource: null }

function wayback(overrides = {}) {
  return createWaybackService({
    core: {
      async getWaybackItems() { return releases },
      async getWaybackItemsWithLocalChanges() { return releases },
      async getMetadata(_point, _zoom, releaseNumber) {
        return { date: releaseNumber === 10 ? '2010-01-02' : null, provider: 'Example', resolution: null, accuracy: null }
      },
    },
    ...overrides,
  })
}

function catalogPath(t) {
  const root = mkdtempSync(join(tmpdir(), 'wayback-source-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return join(root, 'catalog.sqlite')
}

async function serviceFixture() {
  const history = wayback()
  await history.refreshCatalog()
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const requests = []
  const service = createMapSourceService(catalog, {
    createResolver: () => ({
      async resolve4() { return ['93.184.216.34'] },
      async resolve6() { return [] },
      cancel() {},
    }),
  }, history)
  return { history, catalog, service, requests }
}

test('real official capabilities admit the exact fixed release matrix', () => {
  const metadata = parseWaybackCapabilities(officialCapabilities, 43291, 'WB_2026_R10')
  assert.equal(metadata.matrices.length, 24)
  assert.equal(metadata.matrices[23].maxTileRow, 2 ** 23 - 1)
  assert.throws(() => parseWaybackCapabilities(officialCapabilities, 43291, 'WB_1999_R99'), { code: 'SOURCE_UNAVAILABLE' })
  assert.throws(() => parseWaybackCapabilities(officialCapabilities, 10, 'WB_2026_R10'), { code: 'SOURCE_UNAVAILABLE' })
  assert.throws(() => parseWaybackCapabilities(officialCapabilities, 15084, 'WB_2014_R01'), { code: 'SOURCE_UNAVAILABLE' })
  assert.throws(() => parseWaybackCapabilities(officialCapabilities, 30584, 'WB_2015_R04'), { code: 'SOURCE_UNAVAILABLE' })
  const duplicated = officialCapabilities.toString('utf8').replace(
    '/tile/30584/{TileMatrix}/{TileRow}/{TileCol}', '/tile/15084/{TileMatrix}/{TileRow}/{TileCol}',
  )
  assert.throws(() => parseWaybackCapabilities(Buffer.from(duplicated), 15084, 'WB_2015_R14'), { code: 'SOURCE_UNAVAILABLE' })
})

test('an official catalog identifier mismatch still selects only its fixed capability release', async () => {
  const historical = item(15084, 'World Imagery (Wayback 2015-03-18)', 'WB_2015_R14')
  const history = createWaybackService({
    core: {
      async getWaybackItems() { return [historical] },
      async getWaybackItemsWithLocalChanges() { return [historical] },
      async getMetadata() { return null },
    },
  })
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const network = {
    async request(input) {
      assert.equal(input.payload, 'xml')
      return { status: 200, body: officialCapabilities, contentType: 'application/xml', cache: {} }
    },
    dispose() {},
  }
  const service = createMapSourceService(catalog, { network }, history)
  try {
    await history.refreshCatalog()
    const source = await service.waybackRelease(15084)
    const binding = await service.prepare(source)
    assert.equal(binding.native.metadata.nativeLayer, 'WB_2015_R04')
    const plan = compileSourceResource(binding.native, { wkid: 3857 }, new URLSearchParams({
      resource: 'wmts', SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetTile',
      LAYER: 'source', STYLE: 'default', FORMAT: 'image/jpeg', TILEMATRIXSET: 'grid', TILEMATRIX: '0', TILEROW: '0', TILECOL: '0',
    }))
    assert.equal(plan.url.pathname.endsWith('/tile/15084/0/0/0'), true)
  } finally {
    await service.dispose()
    await history.dispose()
  }
})

test('fixed historical selection is restored only against the official release', async () => {
  const { catalog, service } = await serviceFixture()
  const descriptor = await service.waybackRelease(10)
  const restored = await catalog.waybackSelection(descriptor)
  assert.deepEqual(restored, descriptor)
  await assert.rejects(catalog.waybackSelection({ ...descriptor, title: 'Substituted latest' }), { code: 'SOURCE_CHANGED' })
  await assert.rejects(catalog.waybackSelection({ ...descriptor, screenshot: 'allowed' }), { code: 'SOURCE_CHANGED' })
  // A persisted release that left the official catalog fails by name; it is
  // never replaced by the current latest release.
  await assert.rejects(
    catalog.waybackSelection({ ...descriptor, release: { ...descriptor.release, version: '7' } }),
    { code: 'SOURCE_NOT_FOUND' },
  )
  assert.equal(descriptor.screenshot, 'unverified')
  assert.equal(descriptor.automatedMapUse, 'unverified')
  service.dispose()
})

test('synchronous source verification survives service restart without trusting forged permissions', async () => {
  const history = wayback()
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  await history.refreshCatalog()
  const source = await catalog.waybackDescriptor(10)
  const restartedHistory = wayback()
  const restartedCatalog = createMapSourceCatalog(undefined, 'allow', {}, restartedHistory)
  const service = createMapSourceService(restartedCatalog, {}, restartedHistory)
  try {
    assert.throws(() => service.verifySource(source), { code: 'SOURCE_UNAVAILABLE' })
    await restartedHistory.refreshCatalog()
    assert.doesNotThrow(() => service.verifySource(source))
    assert.throws(() => service.verifySource({ ...source, automatedMapUse: 'allowed' }), { code: 'SOURCE_CHANGED' })
    assert.throws(() => service.verifySource({ ...source, configDigest: 'a'.repeat(64) }), { code: 'SOURCE_CHANGED' })
  } finally {
    await history.dispose()
    await service.dispose()
    await restartedHistory.dispose()
  }
})

test('fixed release respects deployment read-only and disabled settings', async () => {
  const history = wayback()
  const readOnly = createMapSourceCatalog({ allowChanges: false }, 'allow', {}, history)
  await history.refreshCatalog()
  const descriptor = await readOnly.waybackDescriptor(10)
  await assert.rejects(readOnly.waybackSelection(descriptor), { code: 'SOURCE_READ_ONLY' })
  assert.deepEqual(await readOnly.verifyWaybackSource(descriptor), descriptor)
  const disabled = createMapSourceCatalog({ presets: { 'esri-wayback': { enabled: false } } }, 'allow', {}, history)
  await assert.rejects(disabled.waybackDescriptor(10), { code: 'SOURCE_UNAVAILABLE' })
  await assert.rejects(disabled.verifyWaybackSource(descriptor), { code: 'SOURCE_UNAVAILABLE' })
  await history.dispose()
})

test('disabled Wayback settings refuse every official read before network I/O', async () => {
  let calls = { items: 0, local: 0, metadata: 0 }
  const history = createWaybackService({
    core: {
      async getWaybackItems() { calls.items += 1; return releases },
      async getWaybackItemsWithLocalChanges() { calls.local += 1; return releases },
      async getMetadata() { calls.metadata += 1; return null },
    },
  })
  const catalog = createMapSourceCatalog({ presets: { 'esri-wayback': { enabled: false } } }, 'allow', {}, history)
  const service = createMapSourceService(catalog, {}, history)
  const viewport = { center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326 }
  const descriptor = waybackDescriptor({
    releaseId: 10, itemId: '0'.repeat(32), title: 'World Imagery (Wayback 2014-02-20)',
    publishedAt: '2014-02-20', layerIdentifier: 'WB_2014_R01', acquiredAt: null,
  })
  try {
    await assert.rejects(service.prepare(descriptor), { code: 'SOURCE_UNAVAILABLE' })
    await assert.rejects(service.waybackCatalog({}), { code: 'SOURCE_UNAVAILABLE' })
    await assert.rejects(service.waybackLocal({ lon: 1, lat: 2 }, 12), { code: 'SOURCE_UNAVAILABLE' })
    await assert.rejects(service.waybackMetadata({ lon: 1, lat: 2 }, 12, 10), { code: 'SOURCE_UNAVAILABLE' })
    await assert.rejects(service.waybackCoverage(viewport, 12, 10), { code: 'SOURCE_UNAVAILABLE' })
    assert.deepEqual(calls, { items: 0, local: 0, metadata: 0 })
  } finally {
    await service.dispose()
  }
})

test('disposing a source activation cancels its evidence read but keeps the shared catalog for its replacement', async () => {
  const entered = Promise.withResolvers()
  const history = wayback({ core: {
    async getWaybackItems() { return releases },
    async getWaybackItemsWithLocalChanges() { return releases },
    getMetadata(_point, _zoom, _releaseId, signal) {
      entered.resolve()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    },
  } })
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const previous = createMapSourceService(catalog, {}, history)
  const next = createMapSourceService(catalog, {}, history)
  try {
    await history.refreshCatalog()
    const read = previous.waybackMetadata({ lon: 1, lat: 2 }, 12, 10)
    await entered.promise
    const cancelled = assert.rejects(read, { code: 'SOURCE_CANCELLED' })
    await previous.dispose()
    await cancelled
    await assert.rejects(previous.waybackCatalog(), { code: 'SOURCE_CANCELLED' })
    assert.equal((await next.waybackRelease(10)).release.version, '10')
  } finally {
    await previous.dispose()
    await next.dispose()
    await history.dispose()
  }
})

test('cancelling one renderer does not cancel startup sync or another renderer', async t => {
  const delayed = Promise.withResolvers()
  let calls = 0
  const history = createWaybackService({
    core: {
      async getWaybackItems() { calls += 1; await delayed.promise; return releases },
      async getWaybackItemsWithLocalChanges() { return [] },
      async getMetadata() { return null },
    },
  })
  const cancelled = new AbortController()
  history.startCatalogSync(catalogPath(t), (_stage, error) => { throw error })
  try {
    const first = history.waitForCatalog(cancelled.signal)
    const second = history.waitForCatalog()
    cancelled.abort()
    await assert.rejects(first, { code: 'SOURCE_CANCELLED' })
    assert.equal(calls, 1)
    assert.throws(() => history.listReleases(), { name: 'SourceCatalogError', code: 'SOURCE_UNAVAILABLE' })
    delayed.resolve()
    await second
    assert.deepEqual(history.listReleases().map(release => release.releaseId), [43291, 10])
    assert.equal(calls, 1)
  } finally {
    delayed.resolve()
    await history.dispose()
  }
})

test('Wayback catalog is bounded and local evidence preserves unknown dates', async () => {
  const { service } = await serviceFixture()
  const page = await service.waybackCatalog({ pageSize: 1 })
  assert.equal(page.releases.length, 1)
  assert.equal(page.releases[0].releaseId, 43291)
  assert.equal(typeof page.nextCursor, 'string')
  const next = await service.waybackCatalog({ pageSize: 1, cursor: page.nextCursor })
  assert.equal(next.releases[0].releaseId, 10)
  const local = await service.waybackLocal({ lon: 1, lat: 2 }, 12)
  assert.equal(local.coverage, 'sampled')
  assert.deepEqual(local.releases.map(item => [item.releaseId, item.acquiredAt]), [[10, '2010-01-02'], [43291, null]])
  service.dispose()
})

test('direct local evidence uses the declared Wayback budget, not the resource timeout', async () => {
  const wait = () => new Promise(resolve => setTimeout(resolve, 40))
  const fixture = async (waybackTimeoutMs, networkTimeoutMs) => {
    const history = createWaybackService({
      requestTimeoutMs: waybackTimeoutMs,
      core: {
        async getWaybackItems() { return releases },
        async getWaybackItemsWithLocalChanges() { await wait(); return releases },
        async getMetadata() { await wait(); return { date: '2010-01-02' } },
      },
    })
    const catalog = createMapSourceCatalog({ proxy: { requestTimeoutMs: networkTimeoutMs } }, 'allow', {}, history)
    await history.refreshCatalog()
    return { service: createMapSourceService(catalog, {}, history), history }
  }
  // A tight resource timeout must not preempt the declared Wayback budget.
  const generous = await fixture(500, 5)
  try {
    assert.equal((await generous.service.waybackLocal({ lon: 1, lat: 2 }, 12)).coverage, 'sampled')
  } finally {
    await generous.service.dispose()
    await generous.history.dispose()
  }
  // A generous resource timeout must not extend the declared Wayback budget.
  const tight = await fixture(75, 15_000)
  try {
    await assert.rejects(tight.service.waybackLocal({ lon: 1, lat: 2 }, 12), { code: 'SOURCE_TIMEOUT' })
  } finally {
    await tight.service.dispose()
    await tight.history.dispose()
  }
})

test('fixed-release viewport samples distinguish uniform, partial, missing and unknown metadata', async () => {
  const points = []
  let mode = 'uniform'
  const history = createWaybackService({
    core: {
      async getWaybackItems() { return releases },
      async getWaybackItemsWithLocalChanges() { return releases },
      async getMetadata(point) {
        points.push(point)
        if (mode === 'missing' && point.longitude === 0 && point.latitude === 2) return null
        if (mode === 'unknown' && point.longitude === 0 && point.latitude === 2) return { date: null }
        return { date: mode === 'different' && point.longitude === 0 && point.latitude === 2 ? '2012-01-01' : '2010-01-02' }
      },
    },
  })
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const service = createMapSourceService(catalog, {}, history)
  const viewport = { center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326 }
  try {
    await history.refreshCatalog()
    const uniform = await service.waybackCoverage(viewport, 12, 10)
    assert.equal(uniform.coverage, 'sampled')
    assert.deepEqual(uniform.samples.map(sample => sample.point), [
      { lon: 1, lat: 1 }, { lon: 0, lat: 0 }, { lon: 0, lat: 2 }, { lon: 2, lat: 0 }, { lon: 2, lat: 2 },
    ])
    assert.equal(points.length, 5)
    mode = 'different'
    assert.equal((await service.waybackCoverage(viewport, 12, 10)).coverage, 'partial')
    mode = 'missing'
    const missing = await service.waybackCoverage(viewport, 12, 10)
    assert.equal(missing.coverage, 'partial')
    assert.equal(missing.samples[2].status, 'missing')
    mode = 'unknown'
    assert.equal((await service.waybackCoverage(viewport, 12, 10)).coverage, 'unknown')
    const wrapped = await service.waybackCoverage({ ...viewport, extent: [-181, 0, 2, 2] }, 12, 10)
    assert.equal(wrapped.coverage, 'unknown')
    assert.equal(wrapped.samples[1].status, 'unavailable')
    mode = 'uniform'
    points.length = 0
    const cornerCenter = await service.waybackCoverage({ ...viewport, center: [0, 0] }, 12, 10)
    assert.equal(cornerCenter.coverage, 'sampled')
    assert.equal(points.length, 4)
    await assert.rejects(service.waybackCoverage({ ...viewport, center: [-181, 1] }, 12, 10), { code: 'SOURCE_RESOURCE_DENIED' })
    await assert.rejects(service.waybackCoverage(viewport, 9, 10), { code: 'SOURCE_RESOURCE_DENIED' })
  } finally {
    await service.dispose()
  }
})

test('fixed-release coverage cancellation aborts every in-flight point query', async () => {
  const started = Promise.withResolvers()
  let active = 0
  let cancelled = 0
  const history = createWaybackService({
    core: {
      async getWaybackItems() { return releases },
      async getWaybackItemsWithLocalChanges() { return releases },
      getMetadata(_point, _zoom, _release, signal) {
        active += 1
        if (active === 4) started.resolve()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { cancelled += 1; reject(new Error('cancelled')) }, { once: true })
        })
      },
    },
  })
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const service = createMapSourceService(catalog, {}, history)
  const controller = new AbortController()
  await history.refreshCatalog()
  const pending = service.waybackCoverage({ center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326 }, 12, 10, controller.signal)
  try {
    await started.promise
    controller.abort()
    await assert.rejects(pending, { code: 'SOURCE_CANCELLED' })
  } finally {
    controller.abort()
    await service.dispose()
    await history.dispose()
  }
  assert.equal(cancelled, active)
})

test('one failed coverage sample cancels its pending sibling queries', async () => {
  const started = Promise.withResolvers()
  let active = 0
  let cancelled = 0
  const history = createWaybackService({
    core: {
      async getWaybackItems() { return releases },
      async getWaybackItemsWithLocalChanges() { return releases },
      async getMetadata(point, _zoom, _release, signal) {
        active += 1
        if (active === 5) started.resolve()
        await started.promise
        if (point.longitude === 1 && point.latitude === 1) throw new Error('unavailable')
        return new Promise((_resolve, reject) => {
          if (signal.aborted) { cancelled += 1; reject(new Error('cancelled')); return }
          signal.addEventListener('abort', () => { cancelled += 1; reject(new Error('cancelled')) }, { once: true })
        })
      },
    },
  })
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const service = createMapSourceService(catalog, {}, history)
  try {
    await history.refreshCatalog()
    await assert.rejects(service.waybackCoverage({ center: [1, 1], extent: [0, 0, 2, 2], wkid: 4326 }, 12, 10), { code: 'SOURCE_UNAVAILABLE' })
  } finally {
    await service.dispose()
  }
  assert.equal(active, 5)
  assert.equal(cancelled, 4)
})

test('Wayback paging refuses malformed cursors and a changed official catalog', async () => {
  let current = releases
  const history = createWaybackService({
    core: {
      async getWaybackItems() { return current },
      async getWaybackItemsWithLocalChanges() { return [] },
      async getMetadata() { return null },
    },
  })
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const service = createMapSourceService(catalog, {}, history)
  try {
    await history.refreshCatalog()
    const first = await service.waybackCatalog({ pageSize: 1 })
    await assert.rejects(service.waybackCatalog({ cursor: '' }), { code: 'SOURCE_RESOURCE_DENIED' })
    const badOffset = Buffer.from(JSON.stringify({ digest: '0'.repeat(64), offset: -1 })).toString('base64url')
    await assert.rejects(service.waybackCatalog({ cursor: badOffset }), { code: 'SOURCE_RESOURCE_DENIED' })
    current = [releases[0]]
    await history.refreshCatalog()
    await assert.rejects(service.waybackCatalog({ cursor: first.nextCursor }), { code: 'SOURCE_CHANGED' })
  } finally {
    await service.dispose()
  }
})

test('fixed release tile compilation never substitutes another release', async () => {
  const { service } = await serviceFixture()
  const source = await service.waybackRelease(10)
  const release = releases[1]
  const native = {
    adapter: 'wmts',
    resolved: { source, endpoint: WAYBACK_ENDPOINT, allowPrivateNetwork: false, allowHttp: false, waybackRelease: 10 },
    metadata: parseWaybackCapabilities(officialCapabilities, 10, release.layerIdentifier),
  }
  const plan = compileSourceResource(native, { wkid: 3857 }, new URLSearchParams({
    resource: 'wmts', SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetTile',
    LAYER: 'source', STYLE: 'default', FORMAT: 'image/jpeg', TILEMATRIXSET: 'grid', TILEMATRIX: '0', TILEROW: '0', TILECOL: '0',
  }))
  assert.equal(plan.url.pathname.endsWith('/tile/10/0/0/0'), true)
  assert.equal(plan.url.pathname.includes('/tile/43291/'), false)
  service.dispose()
})

test('same-origin Wayback route requires a session and returns no private endpoint', async () => {
  const { catalog, service } = await serviceFixture()
  const route = createMapSourceRoutes(service, async () => ({ basemap: catalog.selection('esri-world-imagery').value, imageryDisplay: idleImagery, mode: 'map', view: { center: [0, 0], zoom: 12, wkid: 4326 } }))
  const denied = await route.fetch(new Request('http://owner.test/api/map/wayback?operation=catalog'))
  assert.equal(denied.status, 403)
  const response = await route.fetch(new Request('http://owner.test/api/map/wayback?sessionId=known&operation=catalog&pageSize=1'))
  assert.equal(response.status, 200)
  const text = await response.text()
  assert.equal(text.includes('wayback.maptiles.arcgis.com'), false)
  route.dispose()
  service.dispose()
})

test('viewport coverage route uses the requested release and rejects malformed extent parameters', async () => {
  const { catalog, service } = await serviceFixture()
  const route = createMapSourceRoutes(service, async sessionId => sessionId === 'known'
    ? { basemap: catalog.selection('esri-world-imagery').value, imageryDisplay: idleImagery, mode: 'map', view: { center: [1, 1], zoom: 12, wkid: 4326 } }
    : null)
  const query = new URLSearchParams({
    sessionId: 'known', operation: 'coverage', lon: '1', lat: '1', zoom: '12', releaseId: '10',
    minX: '0', minY: '0', maxX: '2', maxY: '2', wkid: '4326',
  })
  const request = params => new Request(`http://owner.test/api/map/wayback?${params}`)
  try {
    const response = await route.fetch(request(query))
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.equal(payload.releaseId, 10)
    assert.equal(payload.coverage, 'sampled')
    assert.equal(payload.samples.length, 5)
    assert.equal(JSON.stringify(payload).includes('wayback.maptiles.arcgis.com'), false)
    const missing = new URLSearchParams(query)
    missing.delete('maxX')
    assert.equal((await route.fetch(request(missing))).status, 403)
    const unknown = new URLSearchParams(query)
    unknown.set('sessionId', 'missing')
    assert.equal((await route.fetch(request(unknown))).status, 404)
    const invalid = new URLSearchParams(query)
    invalid.set('wkid', '9999')
    assert.equal((await route.fetch(request(invalid))).status, 403)
  } finally {
    route.dispose()
    await service.dispose()
  }
})

test('local evidence reports its own acquisition failure without discarding verified releases', async () => {
  const history = createWaybackService({
    core: {
      async getWaybackItems() { return releases },
      async getWaybackItemsWithLocalChanges() { return releases },
      async getMetadata(_point, _zoom, releaseNumber) {
        if (releaseNumber === 10) throw new Error('metadata unavailable')
        return { date: '2025-01-02' }
      },
    },
  })
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const service = createMapSourceService(catalog, {}, history)
  try {
    await history.refreshCatalog()
    const result = await service.waybackLocal({ lon: 1, lat: 2 }, 12)
    assert.deepEqual(result.releases.map(entry => [entry.releaseId, entry.acquiredAt, entry.metadataStatus]), [
      [10, null, 'unavailable'], [43291, '2025-01-02', 'known'],
    ])
  } finally {
    await service.dispose()
  }
})

test('coverage aborts its samples at the request deadline without reading the upstream catalog', async () => {
  let catalogCalls = 0
  const started = []
  const aborted = []
  const history = createWaybackService({
    requestTimeoutMs: 30,
    core: {
      async getWaybackItems() {
        catalogCalls += 1
        return releases
      },
      async getWaybackItemsWithLocalChanges() { return [] },
      getMetadata(point, _zoom, _releaseId, signal) {
        started.push(point)
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
          aborted.push(point)
          reject(new Error('cancelled'))
        }, { once: true }))
      },
    },
  })
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const service = createMapSourceService(catalog, {}, history)
  const route = createMapSourceRoutes(service, async () => ({ basemap: null, imageryDisplay: idleImagery, mode: 'map', view: { center: [0, 0], zoom: 12, wkid: 4326 } }))
  const params = new URLSearchParams({
    sessionId: 'known', operation: 'coverage', lon: '1', lat: '1', zoom: '12', releaseId: '10',
    minX: '0', minY: '0', maxX: '2', maxY: '2', wkid: '4326',
  })
  try {
    await history.refreshCatalog()
    const result = await route.fetch(new Request(`http://owner.test/api/map/wayback?${params}`))
    assert.equal(result.status, 504)
    assert.equal((await result.json()).code, 'SOURCE_TIMEOUT')
    assert.equal(catalogCalls, 1)
    assert.equal(started.length, 5)
    assert.deepEqual(aborted, started)
  } finally {
    route.dispose()
    await service.dispose()
    await history.dispose()
  }
})

test('Wayback route deadline follows its own request timeout, not source tile timeout', async () => {
  let finish
  const delayed = new Promise(resolve => { finish = resolve })
  const history = wayback({
    requestTimeoutMs: 500,
    core: {
      async getWaybackItems() { return releases },
      async getWaybackItemsWithLocalChanges() { await delayed; return [] },
      async getMetadata() { return null },
    },
  })
  const catalog = createMapSourceCatalog({ proxy: { requestTimeoutMs: 5 } }, 'allow', {}, history)
  const service = createMapSourceService(catalog, {}, history)
  const route = createMapSourceRoutes(service, async () => ({ basemap: null, imageryDisplay: idleImagery, mode: 'map', view: { center: [0, 0], zoom: 12, wkid: 4326 } }))
  try {
    await history.refreshCatalog()
    const pending = route.fetch(new Request('http://owner.test/api/map/wayback?sessionId=known&operation=local&lon=0&lat=0&zoom=12'))
    await new Promise(resolve => setTimeout(resolve, 20))
    finish()
    assert.equal((await pending).status, 200)
  } finally {
    finish()
    route.dispose()
    await service.dispose()
    await history.dispose()
  }
})

test('two sessions render distinct fixed releases and reject stale cross-session resource identities', async () => {
  const history = wayback()
  await history.refreshCatalog()
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const requests = []
  const images = new Map([
    [10, await sharp({ create: { width: 256, height: 256, channels: 3, background: '#d02020' } }).jpeg().toBuffer()],
    [43291, await sharp({ create: { width: 256, height: 256, channels: 3, background: '#2040d0' } }).jpeg().toBuffer()],
  ])
  const cache = { etag: null, lastModified: null, cacheControl: 'no-store', date: null, age: null, expires: null, vary: null }
  const network = {
    async request(input) {
      requests.push(input.url.href)
      if (input.payload === 'xml') return { status: 200, body: officialCapabilities, contentType: 'application/xml', cache }
      const releaseId = Number(/\/tile\/(\d+)\//.exec(input.url.pathname)?.[1])
      const body = images.get(releaseId)
      assert.ok(body, `unexpected tile request ${input.url.pathname}`)
      return { status: 200, body, contentType: 'image/jpeg', cache }
    },
    dispose() {},
  }
  const service = createMapSourceService(catalog, { network }, history)
  const oldSource = await service.waybackRelease(10)
  const newSource = await service.waybackRelease(43291)
  const states = new Map([
    ['old', { basemap: { schemaVersion: 1, basemap: oldSource, labels: null }, imageryDisplay: idleImagery, mode: 'map', view: { center: [0, 0], zoom: 12, wkid: 4326 } }],
    ['new', { basemap: { schemaVersion: 1, basemap: newSource, labels: null }, imageryDisplay: idleImagery, mode: 'map', view: { center: [0, 0], zoom: 12, wkid: 4326 } }],
  ])
  const route = createMapSourceRoutes(service, async sessionId => states.get(sessionId) ?? null)
  try {
    const [oldRender, newRender] = await Promise.all(['old', 'new'].map(sessionId => route.fetch(new Request(`http://owner.test/api/map/sources/render?sessionId=${sessionId}`))))
    assert.equal(oldRender.status, 200)
    assert.equal(newRender.status, 200)
    const oldDescriptor = await oldRender.json()
    const newDescriptor = await newRender.json()
    assert.equal(oldDescriptor.basemap.layerKind, 'wmts')
    assert.equal(newDescriptor.basemap.layerKind, 'wmts')
    assert.notEqual(oldDescriptor.basemap.nativeEpoch, newDescriptor.basemap.nativeEpoch)
    const tileQuery = href => {
      const query = new URLSearchParams(href.split('?')[1])
      for (const [key, value] of Object.entries({ service: 'WMTS', version: '1.0.0', request: 'GetTile', layer: 'source', style: 'default', format: 'image/jpeg', tilematrixset: 'grid', tilematrix: '0', tilerow: '0', tilecol: '0' })) query.set(key, value)
      return query
    }
    const oldQuery = tileQuery(oldDescriptor.basemap.resourceHref)
    const newQuery = tileQuery(newDescriptor.basemap.resourceHref)
    const [oldTile, newTile] = await Promise.all([oldQuery, newQuery].map(query => route.fetch(new Request(`http://owner.test/api/map/sources/resource?${query}`))))
    assert.equal(oldTile.status, 200)
    assert.equal(newTile.status, 200)
    assert.deepEqual(Buffer.from(await oldTile.arrayBuffer()), images.get(10))
    assert.deepEqual(Buffer.from(await newTile.arrayBuffer()), images.get(43291))
    oldQuery.set('sessionId', 'new')
    const mismatched = await route.fetch(new Request(`http://owner.test/api/map/sources/resource?${oldQuery}`))
    assert.equal(mismatched.status, 409)
    assert.equal(requests.filter(url => url.includes('/tile/10/')).length, 1)
    assert.equal(requests.filter(url => url.includes('/tile/43291/')).length, 1)
  } finally {
    route.dispose()
    await service.dispose()
  }
})

test('cold render restores the exact fixed Wayback overlay without opening the catalog', async t => {
  const original = wayback()
  await original.refreshCatalog()
  const originalCatalog = createMapSourceCatalog(undefined, 'allow', {}, original)
  const source = await originalCatalog.waybackDescriptor(10)
  await original.dispose()
  const history = wayback()
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const paths = []
  const tile = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#d02020' } }).jpeg().toBuffer()
  const cache = { etag: null, lastModified: null, cacheControl: 'no-store', date: null, age: null, expires: null, vary: null }
  const network = {
    async request(input) {
      paths.push(input.url.pathname)
      return input.payload === 'xml'
        ? { status: 200, body: officialCapabilities, contentType: 'application/xml', cache }
        : { status: 200, body: tile, contentType: 'image/jpeg', cache }
    },
    dispose() {},
  }
  const service = createMapSourceService(catalog, { network }, history)
  const state = {
    basemap: catalog.selection('esri-world-imagery', null).value,
    imageryDisplay: { ...idleImagery, recentOpacity: 0.5, earlyVisible: true, earlySource: source },
    mode: 'map', view: { center: [0, 0], zoom: 12, wkid: 4326 },
  }
  const route = createMapSourceRoutes(service, async () => state)
  try {
    assert.throws(() => service.verifySource(source), { code: 'SOURCE_UNAVAILABLE' })
    history.startCatalogSync(catalogPath(t), (_stage, error) => { throw error })
    const response = await route.fetch(new Request('http://owner.test/api/map/sources/render?sessionId=cold'))
    const descriptor = await response.json()
    assert.equal(response.status, 200, JSON.stringify(descriptor))
    assert.deepEqual(descriptor.earlyImagery.source, source)
    assert.equal(descriptor.earlyImagery.source.release.version, '10')
    assert.equal(descriptor.earlyImagery.source.release.acquiredAt, null)
    assert.equal(descriptor.display.recentOpacity, 0.5)
    const query = new URLSearchParams(descriptor.earlyImagery.resourceHref.split('?')[1])
    for (const [key, value] of Object.entries({ service: 'WMTS', version: '1.0.0', request: 'GetTile', layer: 'source', style: 'default', format: 'image/jpeg', tilematrixset: 'grid', tilematrix: '0', tilerow: '0', tilecol: '0' })) query.set(key, value)
    const image = await route.fetch(new Request(`http://owner.test/api/map/sources/resource?${query}`))
    assert.equal(image.status, 200)
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), tile)
    assert.ok(paths.some(path => path.endsWith('/tile/10/0/0/0')))
    assert.ok(paths.every(path => !path.includes('/tile/43291/')))
  } finally {
    route.dispose()
    await service.dispose()
    await history.dispose()
  }
})

test('cold render reports official failure or changed release identity without substituting another source', async t => {
  const original = wayback()
  await original.refreshCatalog()
  const source = await createMapSourceCatalog(undefined, 'allow', {}, original).waybackDescriptor(10)
  await original.dispose()
  for (const entry of [
    { name: 'unavailable', read: async () => { throw new Error('official catalog offline') }, status: 502, code: 'SOURCE_UNAVAILABLE' },
    { name: 'changed', read: async () => [releases[0], { ...releases[1], itemID: 'a'.repeat(32) }], status: 409, code: 'SOURCE_CHANGED' },
    { name: 'removed', read: async () => [releases[0]], status: 404, code: 'SOURCE_NOT_FOUND' },
  ]) {
    const history = createWaybackService({ core: { getWaybackItems: entry.read, async getWaybackItemsWithLocalChanges() { return [] }, async getMetadata() { return null } } })
    const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
    let requests = 0
    const service = createMapSourceService(catalog, { network: { async request() { requests += 1; throw new Error('unexpected capabilities request') }, dispose() {} } }, history)
    const state = {
      basemap: catalog.selection('esri-world-imagery', null).value,
      imageryDisplay: { ...idleImagery, earlyVisible: true, earlySource: source },
      mode: 'map', view: { center: [0, 0], zoom: 12, wkid: 4326 },
    }
    const route = createMapSourceRoutes(service, async () => state)
    try {
      history.startCatalogSync(catalogPath(t), () => {})
      const response = await route.fetch(new Request('http://owner.test/api/map/sources/render?sessionId=cold'))
      assert.equal(response.status, entry.status, entry.name)
      assert.deepEqual(await response.json(), { ok: false, code: entry.code }, entry.name)
      assert.equal(state.imageryDisplay.earlySource.release.version, '10', entry.name)
      assert.equal(requests, 0, entry.name)
    } finally {
      route.dispose()
      await service.dispose()
      await history.dispose()
    }
  }
})

test('cold render rechecks the live session after asynchronous Wayback preparation', async t => {
  const original = wayback()
  await original.refreshCatalog()
  const originalCatalog = createMapSourceCatalog(undefined, 'allow', {}, original)
  const source = await originalCatalog.waybackDescriptor(10)
  const replacement = await originalCatalog.waybackDescriptor(43291)
  await original.dispose()
  const release = Promise.withResolvers()
  const history = createWaybackService({ core: {
    async getWaybackItems() { await release.promise; return releases },
    async getWaybackItemsWithLocalChanges() { return [] },
    async getMetadata() { return null },
  } })
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const network = { async request() { return { status: 200, body: officialCapabilities, contentType: 'application/xml', cache: {} } }, dispose() {} }
  const service = createMapSourceService(catalog, { network }, history)
  let state = {
    basemap: catalog.selection('esri-world-imagery', null).value,
    imageryDisplay: { ...idleImagery, earlyVisible: true, earlySource: source },
    mode: 'map', view: { center: [0, 0], zoom: 12, wkid: 4326 },
  }
  const entered = Promise.withResolvers()
  const route = createMapSourceRoutes(service, async () => { entered.resolve(); return state })
  try {
    history.startCatalogSync(catalogPath(t), (_stage, error) => { throw error })
    const pending = route.fetch(new Request('http://owner.test/api/map/sources/render?sessionId=cold'))
    const outcome = await Promise.race([entered.promise.then(() => 'entered'), pending.then(response => `HTTP ${response.status}`)])
    assert.equal(outcome, 'entered')
    state = { ...state, imageryDisplay: { ...state.imageryDisplay, earlySource: replacement } }
    release.resolve()
    const response = await pending
    assert.equal(response.status, 409)
    assert.deepEqual(await response.json(), { ok: false, code: 'SOURCE_CHANGED' })
    assert.equal(state.imageryDisplay.earlySource.release.version, '43291')
  } finally {
    release.resolve()
    route.dispose()
    await service.dispose()
    await history.dispose()
  }
})

test('fixed Wayback release descriptors retain release-specific identity across legacy defaults', async () => {
  const history = wayback()
  const catalog = createMapSourceCatalog(undefined, 'allow', {}, history)
  const network = {
    async request(input) {
      assert.equal(input.payload, 'xml')
      return { status: 200, body: officialCapabilities, contentType: 'application/xml', cache: {} }
    },
    dispose() {},
  }
  const service = createMapSourceService(catalog, { network }, history)
  try {
    await history.refreshCatalog()
    const release = await service.waybackRelease(10)
    const legacy = { ...release }
    delete legacy.tileAdjustment
    const binding = await service.prepare(legacy)
    assert.equal(binding.source.id, 'esri-wayback')
    assert.equal(binding.source.release.version, '10')
    assert.deepEqual(binding.source, release)
  } finally {
    await service.dispose()
  }
})
