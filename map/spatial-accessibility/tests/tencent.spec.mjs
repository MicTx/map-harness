/** Keyless Tencent fixture lane: wire shape, decoded polyline, pagination, and loud shrinks. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AccessibilityError,
  CONTROLLED_NETWORK_ID,
  classifyTencentFailure,
  createControlledNetworkProvider,
  createTencentNetworkProvider,
  decodeTencentPolyline,
  parseTencentRoute,
  TENCENT_CAPABILITY_DECLARATION,
  TENCENT_NETWORK_ID,
} from '../src/index.ts'
import {
  assertCancellationContract,
  assertIdentityContract,
  assertPaginationContract,
  assertPartialReadNeverComplete,
  assertRouteModePricing,
  assertServiceAreaBudgetContract,
  assertUnpricedModeContract,
  assertUnreachableLoud,
} from './provider-contract.shared.mjs'

const KEY = 'tencent-fixture-secret'
const BBOX = [116.3, 39.9, 116.36, 39.94]
const A = [116.305, 39.905]
const B = [116.355, 39.935]

function distanceKm(a, b) {
  const mid = ((a[1] + b[1]) / 2) * Math.PI / 180
  const x = (b[0] - a[0]) * Math.PI / 180 * Math.cos(mid)
  const y = (b[1] - a[1]) * Math.PI / 180
  return Math.sqrt(x * x + y * y) * 6371
}

function encodedPath(origin, destination) {
  const originLat = Math.round(origin[1] * 1e6)
  const originLon = Math.round(origin[0] * 1e6)
  return [originLat, originLon, Math.round((destination[1] - origin[1]) * 1e6), Math.round((destination[0] - origin[0]) * 1e6)]
}

function fixtureTransport(options = {}) {
  const state = { calls: [] }
  const transport = async (url, init) => {
    const parsed = new URL(url)
    const path = parsed.pathname
    state.calls.push({ path, url: parsed, key: parsed.searchParams.get('key') })
    init?.signal?.throwIfAborted()
    if (options.httpStatus !== undefined) return { ok: false, status: options.httpStatus, text: async () => '' }
    if (parsed.searchParams.get('key') !== (options.validKey ?? KEY)) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 110, message: 'invalid key' }) }
    if (options.rate === true || (options.rateOnCall !== undefined && state.calls.length === options.rateOnCall)) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 120, message: 'request limit' }) }
    if (path === '/ws/place/v1/search') {
      const boundary = parsed.searchParams.get('boundary')
      const empty = boundary.includes('120')
      const total = empty ? 0 : (options.poiTotal ?? 13)
      const page = Number(parsed.searchParams.get('page_index')) - 1
      const size = Number(parsed.searchParams.get('page_size'))
      const data = page * size >= total ? [] : Array.from({ length: Math.min(size, total - page * size) }, (_, index) => {
        const id = page * size + index
        return { id: `poi-${id}`, location: { lng: 116.31 + id / 10000, lat: 39.91 + id / 10000 } }
      })
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 0, result: { count: total, data } }) }
    }
    const from = parsed.searchParams.get('from').split(',').map(Number).reverse()
    const to = parsed.searchParams.get('to').split(',').map(Number).reverse()
    if (options.unreachable?.(from, to)) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 0, message: 'no route found', result: { routes: [] } }) }
    const km = distanceKm(from, to)
    const driving = path.includes('/driving/')
    const seconds = km / (driving ? 30 : 5) * 3600 + 60
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 0, result: { routes: [{ distance: Math.round(km * 1000), duration: Math.round(seconds), polyline: encodedPath(from, to) }] } }) }
  }
  return { transport, state }
}

function fixtureProvider(overrides = {}) {
  const handle = fixtureTransport(overrides.fixture ?? {})
  return { provider: createTencentNetworkProvider({ apiKey: overrides.apiKey ?? KEY, apiKeyEnv: 'TENCENT_MAP_KEY', bbox: overrides.bbox ?? BBOX, spacingDeg: overrides.spacingDeg ?? 0.02, fetchImpl: handle.transport }), state: handle.state }
}

test('identity, declaration, and shared contracts hold for Tencent and controlled providers', async () => {
  const { provider } = fixtureProvider()
  await assertIdentityContract(provider, () => fixtureProvider().provider, { networkId: TENCENT_NETWORK_ID, refPattern: /^tencent-road-network-[0-9a-f]{16}@1$/ })
  await assertIdentityContract(createControlledNetworkProvider({ bbox: BBOX }), () => createControlledNetworkProvider({ bbox: BBOX }), { networkId: CONTROLLED_NETWORK_ID, refPattern: /^controlled-lattice-[0-9a-f]{16}@1$/ })
  assert.deepEqual(TENCENT_CAPABILITY_DECLARATION.mappable.map(face => face.face), ['route walk/drive', 'serviceArea', 'readPois', 'cancellation'])
  await assertRouteModePricing(provider, A, B)
  await assertRouteModePricing(createControlledNetworkProvider({ bbox: BBOX, spacingDeg: 0.02 }), A, B)
  await assertServiceAreaBudgetContract(provider, A, 20, 100)
  await assertUnpricedModeContract(provider, 'bike', A)
})

test('fixture wire shape carries key, lat/lng coordinates, decoded route, and Place v1 pagination', async () => {
  const { provider, state } = fixtureProvider()
  const route = await provider.route(A, B, { mode: 'drive', slice: 'midday' })
  assert.equal(state.calls[0].path, '/ws/direction/v1/driving/')
  assert.equal(state.calls[0].key, KEY)
  assert.equal(state.calls[0].url.searchParams.get('from'), `${A[1]},${A[0]}`)
  assert.ok(route.distanceKm > 0 && route.minutes > 0)
  await assertPaginationContract(provider, BBOX, [120, 20, 120.01, 20.01], 7)
})

test('partial, cancellation, unreachable, and unsupported faces fail loudly', async () => {
  await assertPartialReadNeverComplete(() => fixtureProvider({ fixture: { rateOnCall: 2, poiTotal: 13 } }).provider, BBOX, 7)
  await assertCancellationContract(() => fixtureProvider().provider.route(A, B, { mode: 'walk', slice: 'midday', signal: AbortSignal.abort() }))
  await assertUnreachableLoud(() => fixtureProvider({ fixture: { unreachable: () => true } }).provider.route(A, B, { mode: 'drive', slice: 'midday' }), ['ACCESS_NOT_FOUND'])
  await assert.rejects(() => fixtureProvider({ fixture: { validKey: 'different' } }).provider.route(A, B, { mode: 'walk', slice: 'midday' }), error => error instanceof AccessibilityError && error.code === 'PERMISSION_DENIED' && !error.message.includes(KEY))
  await assert.rejects(() => fixtureProvider().provider.route(A, B, { mode: 'walk', slice: 'midday', barriers: [{ from: A, to: B, kind: 'blocked' }] }), error => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT')
})

test('Tencent polyline decoding, status mapping, and route parser stay bounded', () => {
  assert.deepEqual(decodeTencentPolyline([39905000, 116305000, 30000, 50000]), [[116.305, 39.905], [116.355, 39.935]])
  assert.equal(classifyTencentFailure(110, 'invalid key'), 'PERMISSION_DENIED')
  assert.equal(classifyTencentFailure(120, 'request limit'), 'RATE_LIMITED')
  assert.equal(classifyTencentFailure(100, 'bad parameter'), 'ACCESS_INVALID_INPUT')
  assert.equal(classifyTencentFailure(0, 'no route found'), 'ACCESS_NOT_FOUND')
  const parsed = parseTencentRoute({ result: { routes: [{ distance: 1200, duration: 180, polyline: [39905000, 116305000, 30000, 50000] }] } })
  assert.equal(parsed?.metres, 1200)
  assert.deepEqual(parsed?.path, [[116.305, 39.905], [116.355, 39.935]])
})
