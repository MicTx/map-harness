/** Keyless Baidu fixture lane: wire shape, pagination, route pricing, and loud shrinks. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AccessibilityError,
  BAIDU_CAPABILITY_DECLARATION,
  BAIDU_NETWORK_ID,
  CONTROLLED_NETWORK_ID,
  classifyBaiduFailure,
  createBaiduNetworkProvider,
  createControlledNetworkProvider,
  parseBaiduRoute,
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

const KEY = 'baidu-fixture-secret'
const BBOX = [116.3, 39.9, 116.36, 39.94]
const A = [116.305, 39.905]
const B = [116.355, 39.935]

function distanceKm(a, b) {
  const mid = ((a[1] + b[1]) / 2) * Math.PI / 180
  const x = (b[0] - a[0]) * Math.PI / 180 * Math.cos(mid)
  const y = (b[1] - a[1]) * Math.PI / 180
  return Math.sqrt(x * x + y * y) * 6371
}

function fixtureTransport(options = {}) {
  const state = { calls: [] }
  const transport = async (url, init) => {
    const parsed = new URL(url)
    const path = parsed.pathname
    state.calls.push({ path, url: parsed, key: parsed.searchParams.get('ak') })
    init?.signal?.throwIfAborted()
    if (options.httpStatus !== undefined) return { ok: false, status: options.httpStatus, text: async () => '' }
    if (parsed.searchParams.get('ak') !== (options.validKey ?? KEY)) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 5, message: 'AK invalid' }) }
    if (options.rate === true || (options.rateOnCall !== undefined && state.calls.length === options.rateOnCall)) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 4, message: 'quota exceeded' }) }
    if (path === '/place/v2/search') {
      const bounds = parsed.searchParams.get('bounds').split(',').map(Number)
      const empty = bounds[1] > 119
      const total = empty ? 0 : (options.poiTotal ?? 13)
      const page = Number(parsed.searchParams.get('page_num'))
      const size = Number(parsed.searchParams.get('page_size'))
      const results = page * size >= total ? [] : Array.from({ length: Math.min(size, total - page * size) }, (_, index) => {
        const id = page * size + index
        return { uid: `poi-${id}`, location: { lng: 116.31 + id / 10000, lat: 39.91 + id / 10000 } }
      })
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 0, total, results }) }
    }
    const origin = parsed.searchParams.get('origin').split(',').map(Number).reverse()
    const destination = parsed.searchParams.get('destination').split(',').map(Number).reverse()
    if (options.unreachable?.(origin, destination)) return { ok: true, status: 200, text: async () => JSON.stringify({ status: 0, message: 'no route found', result: { routes: [] } }) }
    const km = distanceKm(origin, destination)
    const driving = path.endsWith('/driving')
    const seconds = km / (driving ? 30 : 5) * 3600 + 60
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 0, result: { routes: [{ distance: Math.round(km * 1000), duration: Math.round(seconds), steps: [{ path: `${origin[0]},${origin[1]};${destination[0]},${destination[1]}` }] }] } }) }
  }
  return { transport, state }
}

function fixtureProvider(overrides = {}) {
  const handle = fixtureTransport(overrides.fixture ?? {})
  return { provider: createBaiduNetworkProvider({ apiKey: overrides.apiKey ?? KEY, apiKeyEnv: 'BAIDU_API_KEY', bbox: overrides.bbox ?? BBOX, spacingDeg: overrides.spacingDeg ?? 0.02, fetchImpl: handle.transport }), state: handle.state }
}

test('identity, declaration, and shared contracts hold for Baidu and controlled providers', async () => {
  const { provider } = fixtureProvider()
  await assertIdentityContract(provider, () => fixtureProvider().provider, { networkId: BAIDU_NETWORK_ID, refPattern: /^baidu-road-network-[0-9a-f]{16}@1$/ })
  await assertIdentityContract(createControlledNetworkProvider({ bbox: BBOX }), () => createControlledNetworkProvider({ bbox: BBOX }), { networkId: CONTROLLED_NETWORK_ID, refPattern: /^controlled-lattice-[0-9a-f]{16}@1$/ })
  assert.deepEqual(BAIDU_CAPABILITY_DECLARATION.mappable.map(face => face.face), ['route walk/drive', 'serviceArea', 'readPois', 'cancellation'])
  await assertRouteModePricing(provider, A, B)
  await assertRouteModePricing(createControlledNetworkProvider({ bbox: BBOX, spacingDeg: 0.02 }), A, B)
  await assertServiceAreaBudgetContract(provider, A, 20, 100)
  await assertUnpricedModeContract(provider, 'bike', A)
})

test('fixture wire shape carries ak, lat/lng coordinates, and Place v2 pagination', async () => {
  const { provider, state } = fixtureProvider()
  const route = await provider.route(A, B, { mode: 'drive', slice: 'midday' })
  assert.equal(state.calls[0].path, '/directionlite/v1/driving')
  assert.equal(state.calls[0].key, KEY)
  assert.equal(state.calls[0].url.searchParams.get('origin'), `${A[1]},${A[0]}`)
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

test('status mapping and route parser stay inside the existing vocabulary', () => {
  assert.equal(classifyBaiduFailure(3, 'permission'), 'PERMISSION_DENIED')
  assert.equal(classifyBaiduFailure(4, 'quota'), 'RATE_LIMITED')
  assert.equal(classifyBaiduFailure(2, 'bad parameter'), 'ACCESS_INVALID_INPUT')
  assert.equal(classifyBaiduFailure(0, 'no route found'), 'ACCESS_NOT_FOUND')
  const parsed = parseBaiduRoute({ result: { routes: [{ distance: 1200, duration: 180, steps: [{ path: '116.3,39.9;116.31,39.91' }] }] } })
  assert.deepEqual(parsed, { metres: 1200, seconds: 180, path: [[116.3, 39.9], [116.31, 39.91]] })
  assert.equal(parseBaiduRoute({ result: { routes: [] } }), undefined)
})
