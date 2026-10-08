/**
 * Amap adapter gates (keyless, fixture transport): the adapter passes the
 * shared provider-contract assertions against a deterministic fixture that
 * speaks the vendor wire format, the same assertions double-run green against
 * the controlled provider (capability-face equivalence), and the
 * adapter-specific behavior is pinned: vendor infocode mapping, key hygiene
 * (never in messages or refs), datum crossing, the declared shrinks (bike,
 * barriers, time-slice pricing, pagination window), and cancellation through
 * real transport checkpoints. The real-API lane lives in
 * `vendor-contract.spec.mjs` and self-skips without a key.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AccessibilityError,
  AMAP_CAPABILITY_DECLARATION,
  AMAP_NETWORK_ID,
  AMAP_PROVIDER_LIMITATIONS,
  CONTROLLED_NETWORK_ID,
  classifyAmapInfocode,
  collectPois,
  createAmapNetworkProvider,
  createControlledNetworkProvider,
} from '../src/index.ts'
import {
  assertCancellationContract,
  assertDeniedLoud,
  assertIdentityContract,
  assertPaginationContract,
  assertPartialReadNeverComplete,
  assertRouteModePricing,
  assertServiceAreaBudgetContract,
  assertUnpricedModeContract,
  assertUnreachableLoud,
} from './provider-contract.shared.mjs'

const FIXTURE_KEY = 'amap-fixture-key-1234'
const BBOX = [116.3, 39.9, 116.36, 39.94]
const BEIJING_A = [116.305, 39.905]
const BEIJING_B = [116.355, 39.935]
const TOKYO = [139.6917, 35.6895]
const OSAKA = [135.5023, 34.6937]

/** An AbortError-shaped rejection, the way the real transport surfaces aborts. */
function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

/** Deterministic great-circle-ish distance in km between two GCJ points. */
function fixtureDistanceKm(a, b) {
  const midLat = ((a[1] + b[1]) / 2) * Math.PI / 180
  const dLon = (b[0] - a[0]) * Math.PI / 180
  const dLat = (b[1] - a[1]) * Math.PI / 180
  const x = dLon * Math.cos(midLat)
  return Math.sqrt(x * x + dLat * dLat) * 6371
}

/** Whether a GCJ point lies inside the region the fixture vendor serves (mainland-China proxy). */
function fixtureServes(lon, lat) {
  return lon > 73 && lon < 136 && lat > 18 && lat < 54
}

/**
 * The fixture Amap transport: parses the vendor wire format, prices routes
 * deterministically (walk 5 / drive 30 km/h plus a fixed 60 s), serves a
 * deterministic POI directory per polygon (≈4 rows per 0.01°² cell, vendor
 * count included), and can script the vendor failure ladder (invalid key,
 * quota, http, non-JSON, per-call faults, unroutable samples, held requests).
 */
function fixtureTransport(options = {}) {
  const state = { calls: [] }
  const faults = options.faults ?? []
  const transport = async (url, init) => {
    const parsed = new URL(url)
    const key = parsed.searchParams.get('key')
    state.calls.push({ path: parsed.pathname, key, url })
    init?.signal?.throwIfAborted()
    if (options.holdEveryRequestMs !== undefined && init?.signal !== undefined) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, options.holdEveryRequestMs)
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(abortError())
        }, { once: true })
      })
      init.signal.throwIfAborted()
    }
    const body = (text) => ({ ok: true, status: 200, text: async () => text })
    if (options.httpStatus !== undefined) {
      return { ok: false, status: options.httpStatus, text: async () => '' }
    }
    if (key !== (options.validKey ?? FIXTURE_KEY)) {
      return body(JSON.stringify({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }))
    }
    if (options.nonJson === true) {
      return { ok: true, status: 200, text: async () => '<html>not json</html>' }
    }
    const nth = (op) => state.calls.filter(call => call.path === op).length
    for (const fault of faults) {
      if (!parsed.pathname.includes(fault.path)) continue
      const ordinal = nth(fault.path)
      const hit = fault.repeat === true ? ordinal >= fault.nth && (ordinal - fault.nth) % fault.nth === 0 : ordinal === fault.nth
      if (hit) return body(JSON.stringify({ status: '0', info: fault.info, infocode: fault.infocode }))
    }
    if (parsed.pathname === '/v3/direction/driving' || parsed.pathname === '/v3/direction/walking') {
      const origin = parsed.searchParams.get('origin').split(',').map(Number)
      const destination = parsed.searchParams.get('destination').split(',').map(Number)
      if (!fixtureServes(...origin) || !fixtureServes(...destination)) {
        return body(JSON.stringify({ status: '0', info: 'OUT_OF_SERVICE', infocode: '20800' }))
      }
      if (options.unroutable?.(destination[0], destination[1]) === true) {
        return body(JSON.stringify({ status: '0', info: 'NO_ROADS_NEARBY', infocode: '20801' }))
      }
      const km = fixtureDistanceKm(origin, destination)
      const speed = parsed.pathname.endsWith('/walking') ? 5 : 30
      const mid = [(origin[0] + destination[0]) / 2, (origin[1] + destination[1]) / 2]
      return body(JSON.stringify({
        status: '1', info: 'OK', infocode: '10000',
        route: { paths: [{ distance: String(Math.round(km * 1000)), duration: String(Math.round(km / speed * 3600 + 60)), steps: [{ polyline: [origin, mid, destination].map(p => p.map(v => Math.round(v * 1e6) / 1e6).join(',')).join(';') }] }] },
      }))
    }
    if (parsed.pathname === '/v3/place/polygon') {
      const rect = parsed.searchParams.get('polygon').split('|').map(v => v.split(',').map(Number))
      const offset = Number(parsed.searchParams.get('offset'))
      const page = Number(parsed.searchParams.get('page'))
      const [northWest, southEast] = rect
      const area = Math.abs(southEast[0] - northWest[0]) * Math.abs(northWest[1] - southEast[1])
      const total = options.poiTotal ?? Math.min(Math.max(Math.round(area / 0.0001) * 4, 0), 4096)
      const start = (page - 1) * offset
      const count = Math.max(0, Math.min(offset, Math.min(total, 200) - start))
      const pois = []
      for (let index = 0; index < count; index++) {
        const ordinal = start + index
        const x = (ordinal * 37 % 1000) / 1000
        const y = (ordinal * 73 % 1000) / 1000
        pois.push({
          id: `B0FF0${String(ordinal).padStart(5, '0')}`,
          name: `fixture-poi-${ordinal}`,
          location: `${(northWest[0] + x * (southEast[0] - northWest[0])).toFixed(6)},${(southEast[1] + y * (northWest[1] - southEast[1])).toFixed(6)}`,
        })
      }
      return body(JSON.stringify({ status: '1', info: 'OK', infocode: '10000', count: String(total), pois }))
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: '0', info: 'UNKNOWN_PATH', infocode: '20003' }) }
  }
  return { transport, state }
}

/** A fixture-backed provider factory over the shared Beijing extent. */
function fixtureProvider(overrides = {}) {
  const { transport } = fixtureTransport(overrides.fixture ?? {})
  return createAmapNetworkProvider({
    apiKey: overrides.apiKey ?? FIXTURE_KEY,
    apiKeyEnv: 'AMAP_API_KEY',
    bbox: overrides.bbox ?? BBOX,
    spacingDeg: overrides.spacingDeg ?? 0.02,
    fetchImpl: transport,
  })
}

/** A fixture provider with an explicit transport handle (for wire assertions). */
function fixtureProviderWith(overrides = {}) {
  const handle = fixtureTransport(overrides.fixture ?? {})
  const provider = createAmapNetworkProvider({
    apiKey: overrides.apiKey ?? FIXTURE_KEY,
    apiKeyEnv: 'AMAP_API_KEY',
    bbox: overrides.bbox ?? BBOX,
    spacingDeg: overrides.spacingDeg ?? 0.02,
    fetchImpl: handle.transport,
  })
  return { provider, state: handle.state }
}

test('the adapter serves its network identity and the ref excludes the key', () => {
  const provider = fixtureProvider()
  assert.equal(provider.networkId, AMAP_NETWORK_ID)
  assert.match(provider.networkRef, /^amap-road-network-[0-9a-f]{16}@1$/)
  // The digest covers the sampling shape only: different keys rebuild the same ref.
  assert.equal(fixtureProvider({ apiKey: 'another-fixture-key' }).networkRef, provider.networkRef)
  assert.notEqual(fixtureProvider({ spacingDeg: 0.03 }).networkRef, provider.networkRef)
})

test('the capability declaration names exactly the implemented faces and shrinks', () => {
  assert.equal(AMAP_CAPABILITY_DECLARATION.networkId, AMAP_NETWORK_ID)
  assert.deepEqual(AMAP_CAPABILITY_DECLARATION.mappable.map(face => face.face), ['route walk/drive', 'serviceArea', 'readPois', 'cancellation'])
  assert.deepEqual(
    AMAP_CAPABILITY_DECLARATION.shrunk.map(face => face.face),
    ['bike', 'barriers', 'time-slice pricing', 'network version', 'coordinate datum', 'POI directory scope', 'pagination window'],
    'every declared shrink must stay pinned; changing one without a test is a drift',
  )
  assert.equal(AMAP_PROVIDER_LIMITATIONS.length, 5, 'the limitation sentences mirror the shrunk faces')
})

test('the shared identity contract double-runs green on adapter and controlled provider', async () => {
  await assertIdentityContract(fixtureProvider(), () => fixtureProvider(), { networkId: AMAP_NETWORK_ID, refPattern: /^amap-road-network-[0-9a-f]{16}@1$/ })
  await assertIdentityContract(
    createControlledNetworkProvider({ bbox: BBOX }),
    () => createControlledNetworkProvider({ bbox: BBOX }),
    { networkId: CONTROLLED_NETWORK_ID, refPattern: /^controlled-lattice-[0-9a-f]{16}@1$/ },
  )
})

test('the shared route/service-area/mode contracts double-run green on both providers', async () => {
  const amap = fixtureProvider({ spacingDeg: 0.02 })
  const controlled = createControlledNetworkProvider({ bbox: BBOX, spacingDeg: 0.02 })
  await assertRouteModePricing(amap, BEIJING_A, BEIJING_B)
  await assertServiceAreaBudgetContract(amap, [116.33, 39.92], 3, 240)
  await assertUnpricedModeContract(amap, 'bike', [116.33, 39.92])
  await assertRouteModePricing(controlled, BEIJING_A, BEIJING_B)
  await assertServiceAreaBudgetContract(controlled, [116.33, 39.92], 2, 30)
  await assertUnpricedModeContract(createControlledNetworkProvider({ bbox: BBOX, spacingDeg: 0.02, speedKmhPerMode: { bike: undefined } }), 'bike', [116.33, 39.92])
})

test('the shared pagination contract double-runs green on both providers', async () => {
  const emptyBbox = [116.3, 39.9, 116.3001, 39.9001]
  await assertPaginationContract(fixtureProvider({ spacingDeg: 0.02 }), BBOX, emptyBbox, 7)
  await assertPaginationContract(createControlledNetworkProvider({ bbox: BBOX }), BBOX, emptyBbox, 7)
})

test('the shared partial-read/cancel/denied contracts double-run green', async () => {
  // Adapter: quota on the 2nd pois call; controlled: the fault ladder injects the same class.
  await assertPartialReadNeverComplete(
    () => fixtureProvider({ fixture: { faults: [{ path: '/v3/place/polygon', nth: 2, infocode: '10003', info: 'DAILY_QUERY_OVER_LIMIT' }] } }),
    BBOX, 7,
  )
  await assertPartialReadNeverComplete(
    () => createControlledNetworkProvider({ bbox: BBOX, faults: [{ op: 'pois', nth: 2, code: 'RATE_LIMITED' }] }),
    BBOX, 7,
  )
  await assertCancellationContract(() => fixtureProvider({ fixture: { holdEveryRequestMs: 5000 } }).readPois(BBOX, { page: 0, pageSize: 7, signal: AbortSignal.abort() }))
  const held = fixtureProviderWith({ fixture: { holdEveryRequestMs: 200 } })
  const controller = new AbortController()
  const pending = held.provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday', signal: controller.signal })
  controller.abort()
  await assertCancellationContract(() => pending)
  const deniedProvider = fixtureProvider({ fixture: { validKey: 'different-expected-key' } })
  await assertDeniedLoud(() => deniedProvider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' }), FIXTURE_KEY)
})

test('cross-region pairs fail loud through the declared mapping, on both providers', async () => {
  const amap = fixtureProvider({ bbox: BBOX })
  await assertUnreachableLoud(
    () => amap.route(TOKYO, OSAKA, { mode: 'drive', slice: 'midday' }),
    ['ACCESS_NOT_FOUND', 'PERMISSION_DENIED', 'ACCESS_INVALID_INPUT'],
  )
  await assertUnreachableLoud(
    () => amap.serviceArea(TOKYO, 30, { mode: 'drive', slice: 'midday' }),
    ['ACCESS_NOT_FOUND', 'PERMISSION_DENIED', 'ACCESS_INVALID_INPUT'],
  )
  const walled = createControlledNetworkProvider({ bbox: BBOX, spacingDeg: 0.02 })
  const wall = { from: [116.33, 39.9], to: [116.33, 39.94], kind: 'blocked' }
  await assertUnreachableLoud(
    () => walled.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday', barriers: [wall] }),
    ['ACCESS_NOT_FOUND'],
  )
})

test('vendor infocodes map onto the existing vocabulary without new codes', () => {
  const expectations = [
    ['10001', 'PERMISSION_DENIED'], ['10002', 'PERMISSION_DENIED'], ['10012', 'PERMISSION_DENIED'],
    ['20011', 'PERMISSION_DENIED'], ['40002', 'PERMISSION_DENIED'],
    ['10003', 'RATE_LIMITED'], ['10004', 'RATE_LIMITED'], ['10019', 'RATE_LIMITED'],
    ['10044', 'RATE_LIMITED'], ['40000', 'RATE_LIMITED'],
    ['10016', 'TEMPORARILY_UNAVAILABLE'], ['20003', 'TEMPORARILY_UNAVAILABLE'], ['30001', 'TEMPORARILY_UNAVAILABLE'],
    ['20000', 'ACCESS_INVALID_INPUT'], ['20803', 'ACCESS_INVALID_INPUT'],
    ['20800', 'ACCESS_NOT_FOUND'], ['20801', 'ACCESS_NOT_FOUND'], ['20802', 'ACCESS_NOT_FOUND'],
    ['99999', 'TEMPORARILY_UNAVAILABLE'],
  ]
  for (const [infocode, code] of expectations) {
    assert.equal(classifyAmapInfocode(infocode), code, `infocode ${infocode}`)
  }
})

test('transport failures (http, non-JSON) surface as temporary unavailability, never a fabricated answer', async () => {
  const http = fixtureProvider({ fixture: { httpStatus: 502 } })
  await assert.rejects(
    () => http.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'TEMPORARILY_UNAVAILABLE',
  )
  const garbage = fixtureProvider({ fixture: { nonJson: true } })
  await assert.rejects(
    () => garbage.readPois(BBOX, { page: 0, pageSize: 7 }),
    (error) => error instanceof AccessibilityError && error.code === 'TEMPORARILY_UNAVAILABLE',
  )
})

test('inputs cross the datum to GCJ-02 and outputs come back to WGS84', async () => {
  const { provider, state } = fixtureProviderWith({ spacingDeg: 0.02 })
  const route = await provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' })
  const seen = state.calls.find(call => call.path === '/v3/direction/walking')
  assert.ok(seen, 'the fixture observed the route call')
  assert.equal(state.calls.every(call => call.key === FIXTURE_KEY), true, 'the key rides the wire only')
  const wireOrigin = new URL(seen.url).searchParams.get('origin').split(',').map(Number)
  const offsetLon = Math.abs(wireOrigin[0] - BEIJING_A[0])
  const offsetLat = Math.abs(wireOrigin[1] - BEIJING_A[1])
  assert.ok(offsetLon > 0.0005 || offsetLat > 0.0005, `the wire origin must carry the GCJ-02 offset (got ${wireOrigin})`)
  assert.ok(offsetLon < 0.01 && offsetLat < 0.01, 'the datum offset stays within the documented magnitude')
  // The first returned node id is the quantised WGS84 origin, not the GCJ-02 wire point.
  const [lon6, lat6] = route.nodes[0].replace('amap-', '').split('-').map(Number)
  assert.ok(Math.abs(lon6 / 1e6 - BEIJING_A[0]) < 1e-6 && Math.abs(lat6 / 1e6 - BEIJING_A[1]) < 1e-6)
  // POI coordinates come back inside the requested WGS84 extent.
  const page = await provider.readPois(BBOX, { page: 0, pageSize: 5 })
  assert.ok(page.items.length > 0)
  for (const item of page.items) {
    assert.ok(item.coordinates[0] >= BBOX[0] - 0.01 && item.coordinates[0] <= BBOX[2] + 0.01
      && item.coordinates[1] >= BBOX[1] - 0.01 && item.coordinates[1] <= BBOX[3] + 0.01, `poi ${item.id} left the requested extent: ${item.coordinates}`)
  }
})

test('serviceArea sampling excludes unroutable samples and fails loud when nothing routes', async () => {
  const partlyUnroutable = fixtureProvider({ fixture: { unroutable: (lon) => lon > 116.34 } })
  const area = await partlyUnroutable.serviceArea([116.31, 39.91], 240, { mode: 'walk', slice: 'midday' })
  assert.ok(area.nodes.length >= 2, 'the routable half still serves samples')
  assert.ok(area.nodes.every(node => node.lon <= 116.34 + 1e-9), 'unroutable samples stay out of the area')
  const allUnroutable = fixtureProvider({ fixture: { unroutable: () => true } })
  await assert.rejects(
    () => allUnroutable.serviceArea([116.31, 39.91], 240, { mode: 'walk', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_NOT_FOUND',
    'a fully unroutable extent must fail loud, not report an empty-but-successful area',
  )
})

test('a mid-sampling quota failure fails the whole service area loud (partial never reshaped)', async () => {
  const quotaMidSweep = fixtureProvider({ fixture: { faults: [{ path: '/v3/direction/walking', nth: 3, infocode: '10003', info: 'DAILY_QUERY_OVER_LIMIT' }] } })
  await assert.rejects(
    () => quotaMidSweep.serviceArea([116.33, 39.92], 240, { mode: 'walk', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'RATE_LIMITED',
  )
})

test('declared shrinks behave exactly as declared', async () => {
  const provider = fixtureProvider()
  // Time slices: accepted, pricing unchanged (the controlled provider differs by design).
  const midday = await provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' })
  const peak = await provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'morning-peak' })
  assert.equal(peak.minutes, midday.minutes, 'slice pricing is a declared shrink: the vendor has no slice factors')
  // Barriers: loud refusal, never silently ignored.
  await assert.rejects(
    () => provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday', barriers: [{ from: [116.33, 39.9], to: [116.33, 39.94], kind: 'blocked' }] }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT',
  )
})

test('reads beyond the vendor pagination window stop partial, never complete', async () => {
  const wide = fixtureProvider({ fixture: { poiTotal: 450 } })
  const partial = await collectPois(wide, BBOX, { pageSize: 25 })
  assert.equal(partial.coverage, 'partial')
  assert.equal(partial.interruptedBy, 'RATE_LIMITED')
  assert.equal(partial.items.length, 200, 'exactly the vendor window is served')
  assert.ok(partial.items.length < partial.total)
})

test('construction validates loudly: empty key and oversized lattices refuse', () => {
  assert.throws(
    () => createAmapNetworkProvider({ apiKey: '', apiKeyEnv: 'AMAP_API_KEY', bbox: BBOX }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT',
  )
  assert.throws(
    () => createAmapNetworkProvider({ apiKey: FIXTURE_KEY, apiKeyEnv: 'AMAP_API_KEY', bbox: [116, 39.5, 117.6, 40.8], spacingDeg: 0.002 }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT',
  )
})
