import test from 'node:test'
import assert from 'node:assert/strict'
import { mapRig } from './map-rig.mjs'
import { waybackDescriptor } from '../src/wayback.ts'
import { buildMapChangeMeta, validateMapChangeCandidate } from '../src/protocol.ts'
import { MAP_PROJECTION_STATE_VERSION, MAX_PROJECTION_STATE_BYTES, withWaybackComparison } from '../src/protocol.ts'
import { expectedObservationSources } from '../src/observation-protocol.ts'
import { parseUserChangeRecord, userChangeNoticeText, userChangeOfNoticeText, admitUserChange } from '../src/user-change.ts'
import { mapContainerProjectionDefinition } from '../src/projection.ts'
import { serveChangeRequest } from '../src/change-route.ts'
import { admitWaybackComparison } from '../src/plugin.ts'
import { SourceCatalogError } from '../src/source-error.ts'

const selected = waybackDescriptor({
  releaseId: 10,
  itemId: '903f0abe9c3b452dafe1ca5b8dd858b9',
  title: 'World Imagery (Wayback 2014-02-20)',
  publishedAt: '2014-02-20',
  layerIdentifier: 'WB_2014_R01',
  acquiredAt: null,
})
const recent = waybackDescriptor({
  releaseId: 43291,
  itemId: '089e60f6167847f8a14726009c16db66',
  title: 'World Imagery (Wayback 2026-10-29)',
  publishedAt: '2026-10-29',
  layerIdentifier: 'WB_2026_R10',
  acquiredAt: null,
})

test('a fixed historical release survives projection rebuild without replaying external work', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('wayback-restore')
    const before = rig.state(session)
    const call = rig.call(session, 'wayback-select', 'map_set_basemap', { source_id: 'esri-wayback', release_id: 10 })
    const change = { op: 'set-basemap', selection: { schemaVersion: 1, basemap: selected, labels: null } }
    const target = validateMapChangeCandidate(before, change)
    await rig.result(session, call, { meta: buildMapChangeMeta(call.seq, target, change) })
    const state = rig.state(session)
    assert.equal(state.revision, 1)
    assert.deepEqual(state.basemap.basemap.release, { version: '10', publishedAt: '2014-02-20', acquiredAt: null })
    assert.deepEqual(state.view, before.view)
    assert.deepEqual(state.layers, before.layers)
    const registry = rig.ctx.sessionProjections
    const checkpoint = registry.checkpoint(session)
    const floor = registry.restoreFloor(checkpoint)
    const events = session.snapshotEvents()
    const full = registry.restore({}, events, 0, session.header, session.inheritedEventCount)
    const tail = registry.restore(checkpoint, events.filter(event => event.seq >= floor), floor, session.header, session.inheritedEventCount)
    assert.deepEqual(tail.snapshot.values.mapContainer, full.snapshot.values.mapContainer)
    assert.deepEqual(full.snapshot.values.mapContainer.basemap, state.basemap)
    const capture = expectedObservationSources(state.layers, state.basemap)
    assert.equal(capture.sources[0].id, 'esri-wayback')
    assert.equal(capture.sources[0].version, '10')
  } finally {
    await rig.dispose()
  }
})

test('a prepared earlier/recent pair is versioned, persisted and does not switch the map', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('wayback-comparison')
    const before = rig.state(session)
    const record = parseUserChangeRecord({
      operationId: 'prepare-history', targetRevision: 0,
      change: { op: 'set-wayback-comparison', pair: { early: selected, recent, point: { lon: 116, lat: 39 }, zoom: 12 } },
    })
    assert.ok(record)
    const text = userChangeNoticeText('Prepare historical comparison', record)
    assert.match(text, /\[map-user-change v4\]/)
    session.append('agent/inbox/spliced', {
      target: 'next-step', start: 0,
      inserted: [{ id: 'history-prepare', role: 'user', content: [{ type: 'text', text }], source: { kind: 'map-user-change', form: 'notice', summary: 'Prepare historical comparison' } }],
    })
    const state = rig.state(session)
    assert.equal(MAP_PROJECTION_STATE_VERSION, 21)
    assert.equal(state.revision, 1)
    assert.deepEqual(state.basemap, before.basemap)
    assert.deepEqual(state.view, before.view)
    assert.deepEqual(state.waybackComparison, record.change.pair)
    const restored = rig.ctx.sessionProjections.restore({}, session.snapshotEvents(), 0, session.header, session.inheritedEventCount)
    assert.deepEqual(restored.snapshot.values.mapContainer.waybackComparison, record.change.pair)
  } finally {
    await rig.dispose()
  }
})

test('a prepared comparison cannot push the persisted projection past its byte budget', () => {
  const pair = { early: selected, recent, point: { lon: 116, lat: 39 }, zoom: 12 }
  const budgetState = filler => ({ revision: 0, operations: [], waybackComparison: null, layers: [], filler: 'x'.repeat(filler) })
  const foldProbe = withWaybackComparison(budgetState(0), pair, 'prepare-budget', 9)
  assert.ok(foldProbe)
  const foldFiller = MAX_PROJECTION_STATE_BYTES - Buffer.byteLength(JSON.stringify(foldProbe), 'utf8')
  assert.ok(foldFiller > 0)
  const exact = budgetState(foldFiller)
  const fitted = withWaybackComparison(exact, pair, 'prepare-budget', 9)
  assert.ok(fitted)
  assert.equal(Buffer.byteLength(JSON.stringify(fitted), 'utf8'), MAX_PROJECTION_STATE_BYTES)
  const oversized = budgetState(foldFiller + 1)
  assert.equal(withWaybackComparison(oversized, pair, 'prepare-budget', 9), undefined)
  const record = parseUserChangeRecord({
    operationId: 'prepare-budget', targetRevision: 0,
    change: { op: 'set-wayback-comparison', pair },
  })
  assert.ok(record)
  const admittedProbe = withWaybackComparison(budgetState(0), pair, 'prepare-budget', Number.MAX_SAFE_INTEGER)
  assert.ok(admittedProbe)
  const admittedFiller = MAX_PROJECTION_STATE_BYTES - Buffer.byteLength(JSON.stringify(admittedProbe), 'utf8')
  assert.equal(admitUserChange(budgetState(admittedFiller), record, () => undefined).ok, true)
  assert.deepEqual(admitUserChange(budgetState(admittedFiller + 1), record, () => undefined), { ok: false, code: 'oversized' })
  const text = userChangeNoticeText('Prepare historical comparison', record)
  const splice = () => ({
    type: 'agent/inbox/spliced', seq: 9, time: 0,
    data: { target: 'next-step', start: 0, inserted: [{
      id: 'prepare-budget', role: 'user', content: [{ type: 'text', text }],
      source: { kind: 'map-user-change', form: 'notice', summary: 'Prepare historical comparison' },
    }] },
  })
  assert.equal(mapContainerProjectionDefinition.apply(oversized, splice()).revision, 0)
  const folded = mapContainerProjectionDefinition.apply(exact, splice())
  assert.equal(folded.revision, 1)
  assert.deepEqual(folded.waybackComparison, pair)
  assert.ok(Buffer.byteLength(JSON.stringify(folded), 'utf8') <= MAX_PROJECTION_STATE_BYTES)
})

test('older durable formats refuse comparison operations and malformed pairs', () => {
  const pair = { early: selected, recent, point: { lon: 116, lat: 39 }, zoom: 12 }
  const change = { op: 'set-wayback-comparison', pair }
  assert.equal(parseUserChangeRecord({ operationId: 'invalid', targetRevision: 0, change: { ...change, pair: { ...pair, recent: selected } } }), undefined)
  const payload = JSON.stringify({ operationId: 'old-version', targetRevision: 0, change })
  assert.equal(userChangeOfNoticeText(`Old\n[map-user-change v3]\n${payload}`), undefined)
  assert.ok(userChangeOfNoticeText(`New\n[map-user-change v4]\n${payload}`))
})

test('comparison submission rejects a forged or unverified source before the Session changes', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('wayback-refusal')
    let checks = 0
    const host = {
      agentOf: async () => ({ session, inject: message => session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] }) }),
      stateOf: () => rig.state(session),
      async admitBasemap(_state, selection) {
        checks += 1
        return selection.basemap.release.version === '43291' ? 'SOURCE_CHANGED' : undefined
      },
      admitComparison: async () => undefined,
    }
    const request = new Request('http://owner.test/api/map/change', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, summary: 'Prepare comparison', record: {
        operationId: 'comparison-refused', targetRevision: 0,
        change: { op: 'set-wayback-comparison', pair: { early: selected, recent, point: { lon: 116, lat: 39 }, zoom: 12 } },
      } }),
    })
    const result = await serveChangeRequest(request, host)
    assert.equal(result.status, 409)
    assert.equal(checks, 2)
    assert.equal(rig.state(session).revision, 0)
    assert.equal(rig.state(session).waybackComparison, null)
  } finally {
    await rig.dispose()
  }
})

test('accepted comparison retries idempotently and stale writes cannot replace it', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('wayback-idempotency')
    const host = {
      agentOf: async () => ({ session, inject: message => session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] }) }),
      stateOf: () => rig.state(session),
      admitBasemap: async () => undefined,
      admitComparison: async () => undefined,
    }
    const makeRequest = (operationId, targetRevision, pair) => new Request('http://owner.test/api/map/change', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, summary: 'Prepare comparison', record: {
        operationId, targetRevision, change: { op: 'set-wayback-comparison', pair },
      } }),
    })
    const pair = { early: selected, recent, point: { lon: 116, lat: 39 }, zoom: 12 }
    const first = await serveChangeRequest(makeRequest('comparison-1', 0, pair), host)
    assert.equal(first.status, 200)
    const retry = await serveChangeRequest(makeRequest('comparison-1', 0, pair), host)
    assert.equal(retry.status, 200)
    assert.equal((await retry.json()).duplicate, true)
    const changed = { ...pair, point: { lon: 117, lat: 39 } }
    assert.equal((await serveChangeRequest(makeRequest('comparison-1', 0, changed), host)).status, 400)
    assert.equal((await serveChangeRequest(makeRequest('comparison-2', 0, changed), host)).status, 409)
    assert.equal(rig.state(session).revision, 1)
    assert.deepEqual(rig.state(session).waybackComparison, pair)
  } finally {
    await rig.dispose()
  }
})

test('concurrent retries of a comparison commit only one notice', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('wayback-concurrent-retry')
    const bothEntered = Promise.withResolvers()
    const resume = Promise.withResolvers()
    let entered = 0
    let injections = 0
    const host = {
      agentOf: async () => ({ session, inject: message => {
        injections += 1
        session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] })
      } }),
      stateOf: () => rig.state(session),
      async admitComparison() {
        entered += 1
        if (entered === 2) bothEntered.resolve()
        if (entered <= 2) await resume.promise
        return undefined
      },
      admitBasemap: async () => undefined,
    }
    const request = () => new Request('http://owner.test/api/map/change', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, summary: 'Prepare comparison', record: {
        operationId: 'concurrent-retry', targetRevision: 0,
        change: { op: 'set-wayback-comparison', pair: { early: selected, recent, point: { lon: 116, lat: 39 }, zoom: 12 } },
      } }),
    })
    const first = serveChangeRequest(request(), host)
    const second = serveChangeRequest(request(), host)
    await bothEntered.promise
    resume.resolve()
    const responses = await Promise.all([first, second])
    assert.deepEqual(responses.map(result => result.status), [200, 200])
    assert.equal(injections, 1)
    assert.equal(rig.state(session).revision, 1)
  } finally {
    await rig.dispose()
  }
})

test('comparison is rejected before persistence when local evidence does not match', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('wayback-local-refusal')
    let injected = false
    const host = {
      agentOf: async () => ({ session, inject: () => { injected = true } }),
      stateOf: () => rig.state(session),
      admitBasemap: async () => undefined,
      admitComparison: async () => 'SOURCE_CHANGED',
    }
    const request = new Request('http://owner.test/api/map/change', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, summary: 'Prepare comparison', record: {
        operationId: 'local-refused', targetRevision: 0,
        change: { op: 'set-wayback-comparison', pair: { early: selected, recent, point: { lon: 116, lat: 39 }, zoom: 12 } },
      } }),
    })
    const result = await serveChangeRequest(request, host)
    assert.equal(result.status, 409)
    assert.equal(injected, false)
    assert.equal(rig.state(session).waybackComparison, null)
  } finally {
    await rig.dispose()
  }
})

test('comparison is rejected if the viewport changes while the sources are prepared', async () => {
  const rig = await mapRig()
  try {
    const session = rig.session('wayback-viewport-race')
    let cameraRevision = 1
    let prepared = 0
    let injected = false
    const host = {
      agentOf: async () => ({ session, inject: () => { injected = true } }),
      stateOf: () => rig.state(session),
      admitComparison: async () => cameraRevision === 1 ? undefined : 'SOURCE_CHANGED',
      async admitBasemap() {
        prepared += 1
        if (prepared === 2) cameraRevision = 2
        return undefined
      },
    }
    const request = new Request('http://owner.test/api/map/change', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, summary: 'Prepare comparison', record: {
        operationId: 'viewport-race', targetRevision: 0,
        change: { op: 'set-wayback-comparison', pair: { early: selected, recent, point: { lon: 116, lat: 39 }, zoom: 12 } },
      } }),
    })
    const result = await serveChangeRequest(request, host)
    assert.equal(result.status, 409)
    assert.equal(prepared, 2)
    assert.equal(injected, false)
    assert.equal(rig.state(session).waybackComparison, null)
  } finally {
    await rig.dispose()
  }
})

test('route admission only persists a pair the live viewport and official local evidence still support', async () => {
  const pair = { early: selected, recent, point: { lon: 116, lat: 39 }, zoom: 12 }
  const viewportOf = viewport => () => viewport
  const mapCamera = overrides => ({ center: [116, 39], zoom: 12, extent: [115, 38, 117, 40], wkid: 4326, mode: 'map', at: '2026-11-08T00:00:00.000Z', ...overrides })
  const evidence = releases => async () => releases

  assert.equal(await admitWaybackComparison({ viewportOf: viewportOf(undefined) }, { localChanges: async () => { throw new Error('must not run') } })('s1', pair, new AbortController().signal), 'SOURCE_CHANGED')
  assert.equal(await admitWaybackComparison({ viewportOf: viewportOf(mapCamera({ mode: 'scene' })) }, { localChanges: async () => { throw new Error('must not run') } })('s1', pair, new AbortController().signal), 'SOURCE_CHANGED')
  assert.equal(await admitWaybackComparison({ viewportOf: viewportOf(mapCamera({ center: [117, 39] })) }, { localChanges: async () => { throw new Error('must not run') } })('s1', pair, new AbortController().signal), 'SOURCE_CHANGED')
  assert.equal(await admitWaybackComparison({ viewportOf: viewportOf(mapCamera({ zoom: 13 })) }, { localChanges: async () => { throw new Error('must not run') } })('s1', pair, new AbortController().signal), 'SOURCE_CHANGED')

  const local = ids => ids.map(releaseId => ({ releaseId, title: `t${releaseId}`, publishedAt: '2020-01-01', acquiredAt: null, provider: null, resolution: null, accuracy: null, point: pair.point, zoom: pair.zoom }))
  const admit = (viewport, ids) => admitWaybackComparison({ viewportOf: viewportOf(viewport) }, { localChanges: async () => local(ids) })
  assert.equal(await admit(mapCamera(), [10, 43291])('s1', pair, new AbortController().signal), undefined)
  assert.equal(await admit(mapCamera(), [10])('s1', pair, new AbortController().signal), 'SOURCE_CHANGED')
  assert.equal(await admit(mapCamera(), [10, 999])('s1', pair, new AbortController().signal), 'SOURCE_CHANGED')
  assert.equal(await admit(mapCamera(), [11, 43291])('s1', pair, new AbortController().signal), 'SOURCE_CHANGED')

  const webMercator = { ...mapCamera(), center: [12913060.932, 4721671.573], wkid: 3857 }
  assert.equal(await admit(webMercator, [10, 43291])('s1', pair, new AbortController().signal), undefined)

  const swapped = { ...pair, early: recent, recent: selected }
  assert.equal(await admit(mapCamera(), [10, 43291])('s1', swapped, new AbortController().signal), 'SOURCE_CHANGED')

  let calls = 0
  const raced = admitWaybackComparison({ viewportOf: (() => { calls += 1; return calls === 1 ? mapCamera() : { ...mapCamera(), zoom: 15 } }) }, { localChanges: async () => local([10, 43291]) })
  assert.equal(await raced('s1', pair, new AbortController().signal), 'SOURCE_CHANGED')

  const unavailable = admitWaybackComparison({ viewportOf: viewportOf(mapCamera()) }, { localChanges: async () => { throw new SourceCatalogError('SOURCE_UNAVAILABLE') } })
  assert.equal(await unavailable('s1', pair, new AbortController().signal), 'SOURCE_UNAVAILABLE')
  const unknown = admitWaybackComparison({ viewportOf: viewportOf(mapCamera()) }, { localChanges: async () => { throw new Error('boom') } })
  assert.equal(await unknown('s1', pair, new AbortController().signal), 'SOURCE_UNAVAILABLE')
})
