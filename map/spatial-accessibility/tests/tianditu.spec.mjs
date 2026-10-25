/**
 * Tianditu adapter gates (keyless, fixture transport): the adapter passes the
 * shared provider-contract assertions against a deterministic fixture that
 * speaks the vendor wire format (XML `<result>` with kilometres and seconds),
 * the same assertions double-run green against the controlled provider
 * (capability-face equivalence), and the adapter-specific behavior is pinned:
 * vendor response-form mapping, key hygiene (never in messages or refs), the
 * CGCS2000 pass-through (no GCJ-02 offset, the explicit counterpart of the
 * Amap transform), kilometres already being kilometres, and the declared
 * shrinks (service area, POI directory, bike, barriers, time-slice pricing).
 * The real-API lane lives in `vendor-contract.spec.mjs` and self-skips
 * without `TIANDITU_API_KEY`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AccessibilityError,
  CONTROLLED_NETWORK_ID,
  classifyTiandituFailure,
  createControlledNetworkProvider,
  createTiandituNetworkProvider,
  parseDriveXml,
  TIANDITU_CAPABILITY_DECLARATION,
  TIANDITU_NETWORK_ID,
  TIANDITU_PROVIDER_LIMITATIONS,
  TIANDITU_STYLE_FASTEST,
  TIANDITU_STYLE_WALK,
} from '../src/index.ts'
import {
  assertCancellationContract,
  assertDeniedLoud,
  assertIdentityContract,
  assertRouteModePricing,
  assertUnpricedModeContract,
  assertUnreachableLoud,
} from './provider-contract.shared.mjs'

const FIXTURE_KEY = 'tianditu-fixture-key-1234'
const BBOX = [116.3, 39.9, 116.36, 39.94]
const BEIJING_A = [116.305, 39.905]
const BEIJING_B = [116.355, 39.935]
const TOKYO = [139.6917, 35.6895]
const OSAKA = [135.5023, 34.6937]

/** An AbortError-shaped rejection, the way the real transport surfaces aborts. */
function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}

/** Deterministic distance in km between two points (equirectangular). */
function fixtureDistanceKm(a, b) {
  const midLat = ((a[1] + b[1]) / 2) * Math.PI / 180
  const dLon = (b[0] - a[0]) * Math.PI / 180
  const dLat = (b[1] - a[1]) * Math.PI / 180
  const x = dLon * Math.cos(midLat)
  return Math.sqrt(x * x + dLat * dLat) * 6371
}

/** Whether a point lies inside the region the fixture vendor serves. */
function fixtureServes(lon, lat) {
  return lon > 73 && lon < 136 && lat > 18 && lat < 54
}

/** One vendor XML success body: distance in kilometres, duration in seconds. */
function driveXml(origin, destination, kilometres, seconds) {
  const mid = [(origin[0] + destination[0]) / 2, (origin[1] + destination[1]) / 2]
  const line = [origin, mid, destination].map(point => point.map(value => Math.round(value * 1e6) / 1e6).join(',')).join(';')
  return `<result><distance>${kilometres.toFixed(3)}</distance><duration>${Math.round(seconds)}</duration><routelatlon>${line}</routelatlon></result>`
}

/**
 * The fixture Tianditu transport: parses the vendor query (`postStr` JSON plus
 * `tk`), prices routes deterministically (walk 5 / drive 30 km/h plus 60 s),
 * and scripts the vendor failure forms (invalid key, quota, unroutable pair,
 * unexpected body, http, held requests).
 */
function fixtureTransport(options = {}) {
  const state = { calls: [] }
  const transport = async (url, init) => {
    const parsed = new URL(url)
    const key = parsed.searchParams.get('tk')
    const postStr = JSON.parse(parsed.searchParams.get('postStr'))
    state.calls.push({ path: parsed.pathname, key, postStr, type: parsed.searchParams.get('type'), url })
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
      return body('<html>密钥错误</html>')
    }
    if (options.unexpectedBody === true) {
      return body('<html>gateway page</html>')
    }
    if (options.quota === true) {
      return body('<result><msg>访问超限</msg></result>')
    }
    const origin = postStr.orig.split(',').map(Number)
    const destination = postStr.dest.split(',').map(Number)
    if (!fixtureServes(...origin) || !fixtureServes(...destination)) {
      return body('<result><msg>无法规划路线</msg></result>')
    }
    const kilometres = fixtureDistanceKm(origin, destination)
    const speed = postStr.style === TIANDITU_STYLE_WALK ? 5 : 30
    return body(driveXml(origin, destination, kilometres, kilometres / speed * 3600 + 60))
  }
  return { transport, state }
}

/** A fixture-backed provider factory over the shared Beijing extent. */
function fixtureProvider(overrides = {}) {
  const { transport } = fixtureTransport(overrides.fixture ?? {})
  return createTiandituNetworkProvider({
    apiKey: overrides.apiKey ?? FIXTURE_KEY,
    apiKeyEnv: 'TIANDITU_API_KEY',
    bbox: overrides.bbox ?? BBOX,
    fetchImpl: transport,
  })
}

/** A fixture provider with an explicit transport handle (for wire assertions). */
function fixtureProviderWith(overrides = {}) {
  const handle = fixtureTransport(overrides.fixture ?? {})
  const provider = createTiandituNetworkProvider({
    apiKey: overrides.apiKey ?? FIXTURE_KEY,
    apiKeyEnv: 'TIANDITU_API_KEY',
    bbox: overrides.bbox ?? BBOX,
    fetchImpl: handle.transport,
  })
  return { provider, state: handle.state }
}

test('the adapter serves its network identity and the ref excludes the key', () => {
  const provider = fixtureProvider()
  assert.equal(provider.networkId, TIANDITU_NETWORK_ID)
  assert.match(provider.networkRef, /^tianditu-road-network-[0-9a-f]{16}@1$/)
  assert.equal(fixtureProvider({ apiKey: 'another-fixture-key' }).networkRef, provider.networkRef)
  assert.notEqual(fixtureProvider({ bbox: [116.3, 39.9, 116.4, 39.96] }).networkRef, provider.networkRef)
})

test('the capability declaration names exactly the implemented faces and shrinks', () => {
  assert.equal(TIANDITU_CAPABILITY_DECLARATION.networkId, TIANDITU_NETWORK_ID)
  assert.deepEqual(TIANDITU_CAPABILITY_DECLARATION.mappable.map(face => face.face), ['route walk/drive', 'cancellation', 'serviceArea'])
  assert.deepEqual(
    TIANDITU_CAPABILITY_DECLARATION.shrunk.map(face => face.face),
    ['readPois', 'bike', 'barriers', 'time-slice pricing', 'network version', 'coordinate datum', 'via points'],
    'every declared shrink must stay pinned; changing one without a test is a drift',
  )
  assert.equal(TIANDITU_PROVIDER_LIMITATIONS.length, 4, 'the limitation sentences mirror the load-bearing faces')
})

test('the shared identity and route contracts double-run green on adapter and controlled provider', async () => {
  await assertIdentityContract(fixtureProvider(), () => fixtureProvider(), { networkId: TIANDITU_NETWORK_ID, refPattern: /^tianditu-road-network-[0-9a-f]{16}@1$/ })
  await assertIdentityContract(
    createControlledNetworkProvider({ bbox: BBOX }),
    () => createControlledNetworkProvider({ bbox: BBOX }),
    { networkId: CONTROLLED_NETWORK_ID, refPattern: /^controlled-lattice-[0-9a-f]{16}@1$/ },
  )
  await assertRouteModePricing(fixtureProvider(), BEIJING_A, BEIJING_B)
  await assertRouteModePricing(createControlledNetworkProvider({ bbox: BBOX, spacingDeg: 0.02 }), BEIJING_A, BEIJING_B)
  await assertUnpricedModeContract(fixtureProvider(), 'bike', BEIJING_A)
})

test('the shared cancel/denied/unreachable contracts double-run green', async () => {
  await assertCancellationContract(() => fixtureProvider({ fixture: { holdEveryRequestMs: 5000 } }).route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday', signal: AbortSignal.abort() }))
  const held = fixtureProviderWith({ fixture: { holdEveryRequestMs: 200 } })
  const controller = new AbortController()
  const pending = held.provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday', signal: controller.signal })
  controller.abort()
  await assertCancellationContract(() => pending)
  await assertDeniedLoud(
    () => fixtureProvider({ fixture: { validKey: 'different-expected-key' } }).route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' }),
    FIXTURE_KEY,
  )
  await assertUnreachableLoud(
    () => fixtureProvider().route(TOKYO, OSAKA, { mode: 'drive', slice: 'midday' }),
    ['ACCESS_NOT_FOUND'],
  )
  const walled = createControlledNetworkProvider({ bbox: BBOX, spacingDeg: 0.02 })
  await assertUnreachableLoud(
    () => walled.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday', barriers: [{ from: [116.33, 39.9], to: [116.33, 39.94], kind: 'blocked' }] }),
    ['ACCESS_NOT_FOUND'],
  )
})

test('HTTPS is the default and authorization or quota HTTP statuses retain their meaning', async () => {
  const { provider, state } = fixtureProviderWith()
  await provider.route(BEIJING_A, BEIJING_B, { mode: 'drive', slice: 'midday' })
  assert.equal(new URL(state.calls[0].url).protocol, 'https:')
  for (const [httpStatus, expected] of [[401, 'PERMISSION_DENIED'], [403, 'PERMISSION_DENIED'], [429, 'RATE_LIMITED']]) {
    await assert.rejects(
      () => fixtureProvider({ fixture: { httpStatus } }).route(BEIJING_A, BEIJING_B, { mode: 'drive', slice: 'midday' }),
      error => error instanceof AccessibilityError && error.code === expected && !error.message.includes(FIXTURE_KEY),
    )
  }
})

test('a refusal that echoes the submitted key is redacted before producing an error', async () => {
  const provider = createTiandituNetworkProvider({
    apiKey: FIXTURE_KEY, apiKeyEnv: 'TIANDITU_API_KEY', bbox: BBOX,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => `密钥 ${FIXTURE_KEY} 无效` }),
  })
  await assert.rejects(
    () => provider.route(BEIJING_A, BEIJING_B, { mode: 'drive', slice: 'midday' }),
    error => error instanceof AccessibilityError && error.code === 'PERMISSION_DENIED'
      && error.message.includes('[redacted]') && !error.message.includes(FIXTURE_KEY),
  )
})

test('vendor response forms map onto the existing vocabulary without new codes', () => {
  const expectations = [
    ['permission', 'PERMISSION_DENIED'],
    ['rate', 'RATE_LIMITED'],
    ['not-found', 'ACCESS_NOT_FOUND'],
    ['invalid', 'ACCESS_INVALID_INPUT'],
    ['unexpected', 'TEMPORARILY_UNAVAILABLE'],
  ]
  for (const [kind, code] of expectations) {
    assert.equal(classifyTiandituFailure(kind), code, `failure form ${kind}`)
  }
})

test('an unexpected response form says so in the failure text', async () => {
  await assert.rejects(
    () => fixtureProvider({ fixture: { unexpectedBody: true } }).route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' }),
    (error) => error instanceof AccessibilityError
      && error.code === 'TEMPORARILY_UNAVAILABLE'
      && error.message.includes('unexpected response form'),
  )
  await assert.rejects(
    () => fixtureProvider({ fixture: { httpStatus: 502 } }).route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'TEMPORARILY_UNAVAILABLE',
  )
  await assert.rejects(
    () => fixtureProvider({ fixture: { quota: true } }).route(BEIJING_A, BEIJING_B, { mode: 'drive', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'RATE_LIMITED',
  )
})

test('distance stays in kilometres and the wire carries tk, style, and no datum offset', async () => {
  const { provider, state } = fixtureProviderWith()
  const route = await provider.route(BEIJING_A, BEIJING_B, { mode: 'drive', slice: 'midday' })
  const seen = state.calls[0]
  assert.equal(seen.path, '/drive')
  assert.equal(seen.type, 'search')
  assert.equal(seen.key, FIXTURE_KEY, 'the key rides the tk parameter only')
  assert.equal(seen.postStr.style, TIANDITU_STYLE_FASTEST)
  assert.equal(seen.postStr.orig, `${BEIJING_A[0]},${BEIJING_A[1]}`, 'CGCS2000 passes through: the wire origin equals the WGS84 input')
  assert.equal(seen.postStr.mid, undefined, 'the origin-destination face never invents via points')
  const straight = fixtureDistanceKm(BEIJING_A, BEIJING_B)
  assert.ok(Math.abs(route.distanceKm - straight) < 0.01, `distance must stay in kilometres (got ${route.distanceKm}, straight ${straight})`)
  assert.ok(route.minutes > 0)
  const walk = await provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' })
  assert.equal(state.calls[1].postStr.style, TIANDITU_STYLE_WALK)
  assert.ok(walk.minutes > route.minutes)
})

test('the fixed XML schema parses kilometres, seconds, and the polyline, and refuses nested markup', () => {
  const parsed = parseDriveXml('<result><distance>3.25</distance><duration>420</duration><routelatlon>116.305,39.905;116.33,39.92</routelatlon></result>')
  assert.equal(parsed.kilometres, 3.25)
  assert.equal(parsed.seconds, 420)
  assert.deepEqual(parsed.polyline, [[116.305, 39.905], [116.33, 39.92]])
  assert.equal(parseDriveXml('<result><distance>1</distance><duration>2</duration><routelatlon><x>1</x></routelatlon></result>'), undefined)

test('the live driving-plan shape parses: attribute-carrying root and <key> echo are not refusals', () => {
  // Captured from the live service 2026-10-12: the root carries orig/dest
  // attributes and every plan echoes the request inside a <key> element.
  const live = `<?xml version="1.0" encoding="UTF-8" ?><result orig='116.379,39.915' mid='' dest='116.449,39.951'><parameters><key></key><style>0</style></parameters><routes count='15'><distance>10.55</distance><duration>730.0</duration><routelatlon>116.379,39.915;116.449,39.951</routelatlon></routes></result>`
  const parsed = parseDriveXml(live)
  assert.notEqual(parsed, undefined, 'the attribute-carrying live root must parse')
  assert.equal(parsed.kilometres, 10.55)
  assert.equal(parsed.seconds, 730)
  assert.equal(parsed.polyline.length, 2)
  // and the empty root is the vendor's no-plan answer, not an unexpected form
  assert.equal(parseDriveXml('<result></result>'), undefined)
})

test('the live invalid-key form (http 400, vendor code 308011) classifies as a credential refusal', async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => '{"code":308011,"message":"请求参数非法长度或不合规"}' })
  const provider = createTiandituNetworkProvider({ apiKey: 'fixture-only-not-a-credential', apiKeyEnv: 'TIANDITU_API_KEY', bbox: [116.3, 39.9, 116.36, 39.94], fetchImpl })
  await assert.rejects(
    provider.route([116.34, 39.92], [116.35, 39.93], { mode: 'drive', slice: 'morning-peak' }),
    (error) => error instanceof AccessibilityError && error.code === 'PERMISSION_DENIED' && !error.message.includes('fixture-only'),
  )
})
  assert.equal(parseDriveXml('not xml'), undefined)
})

test('declared shrinks fail loud exactly as declared', async () => {
  const provider = fixtureProvider()
  await assert.rejects(
    () => provider.serviceArea(BEIJING_A, 15, { mode: 'bike', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'METHOD_NOT_APPLICABLE' && error.message.includes('bike'),
  )
  await assert.rejects(
    () => provider.readPois(BBOX, { page: 0, pageSize: 7 }),
    (error) => error instanceof AccessibilityError && error.code === 'METHOD_NOT_APPLICABLE',
  )
  const midday = await provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' })
  const peak = await provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'morning-peak' })
  assert.equal(peak.minutes, midday.minutes, 'slice pricing is a declared shrink: the vendor has no slice factors')
  await assert.rejects(
    () => provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday', barriers: [{ from: [116.33, 39.9], to: [116.33, 39.94], kind: 'blocked' }] }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT',
  )
})

test('construction validates loudly: an empty key refuses', () => {
  assert.throws(
    () => createTiandituNetworkProvider({ apiKey: '', apiKeyEnv: 'TIANDITU_API_KEY', bbox: BBOX }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT' && error.message.includes('TIANDITU_API_KEY'),
  )
})

/** Scripted vendor transport for the sampling lane: answers each /drive dest from a per-destination map. */
function samplingFetch(destinations, fallback) {
  return async (url) => {
    const postStr = new URL(url).searchParams.get('postStr') ?? '{}'
    const dest = JSON.parse(postStr).dest ?? ''
    const answer = destinations[dest] ?? fallback
    if (typeof answer === 'number') return { ok: false, status: answer, text: async () => '' }
    return { ok: true, status: 200, text: async () => answer }
  }
}

function sampleDriveXml(seconds, kilometres) {
  return `<result orig='' dest=''><distance>${kilometres}</distance><duration>${seconds}</duration><routelatlon>116.34,39.92;116.35,39.93</routelatlon></result>`
}

test('serviceArea samples the bounded lattice with real routes', async () => {
  const destinations = {
    '116.36,39.9': sampleDriveXml(600, 5),
    '116.36,39.92': sampleDriveXml(2400, 20),
    '116.34,39.9': sampleDriveXml(300, 2.5),
    '116.34,39.92': sampleDriveXml(900, 8),
  }
  const provider = createTiandituNetworkProvider({ apiKey: 'fixture-only-not-a-credential', apiKeyEnv: 'TIANDITU_API_KEY', bbox: [116.34, 39.9, 116.36, 39.92], spacingDeg: 0.02, fetchImpl: samplingFetch(destinations) })
  const area = await provider.serviceArea([116.34, 39.9], 15, { mode: 'drive', slice: 'morning-peak' })
  const ids = area.nodes.map(node => node.id)
  assert.ok(ids.includes('tianditu-116340000-39900000'), 'the origin is in the area at minute 0')
  assert.ok(area.nodes.some(node => node.minutes === 10), 'a 600s route lands as 10 minutes')
  assert.ok(!ids.includes('tianditu-116360000-39920000'), 'a 2400s route stays outside a 15-minute budget')
  assert.equal(area.budgetMinutes, 15)
})

test('serviceArea excludes unroutable samples and aborts the whole area on refusals', async () => {
  const empty = "<result></result>"
  const mixed = createTiandituNetworkProvider({ apiKey: 'fixture-only-not-a-credential', apiKeyEnv: 'TIANDITU_API_KEY', bbox: [116.34, 39.9, 116.36, 39.92], spacingDeg: 0.02, fetchImpl: samplingFetch({ '116.36,39.9': sampleDriveXml(600, 5), '116.34,39.92': sampleDriveXml(300, 2.5) }, empty) })
  const area = await mixed.serviceArea([116.34, 39.9], 15, { mode: 'drive', slice: 'morning-peak' })
  assert.ok(area.nodes.length >= 3, 'routable samples plus the origin survive; empty-result samples drop out silently')
  const denied = createTiandituNetworkProvider({ apiKey: 'fixture-only-not-a-credential', apiKeyEnv: 'TIANDITU_API_KEY', bbox: [116.34, 39.9, 116.36, 39.92], spacingDeg: 0.02, fetchImpl: samplingFetch({}, 403) })
  await assert.rejects(denied.serviceArea([116.34, 39.9], 15, { mode: 'drive', slice: 'morning-peak' }), (error) => error instanceof AccessibilityError && error.code === 'PERMISSION_DENIED')
})

test('serviceArea refuses oversized lattices and all-unroutable sweeps', async () => {
  assert.throws(() => createTiandituNetworkProvider({ apiKey: 'fixture-only-not-a-credential', apiKeyEnv: 'TIANDITU_API_KEY', bbox: [116, 39, 117, 40], spacingDeg: 0.01, fetchImpl: samplingFetch({}) }), /lattice/)
  const none = createTiandituNetworkProvider({ apiKey: 'fixture-only-not-a-credential', apiKeyEnv: 'TIANDITU_API_KEY', bbox: [116.34, 39.9, 116.36, 39.92], spacingDeg: 0.02, fetchImpl: samplingFetch({}, "<result></result>") })
  await assert.rejects(none.serviceArea([116.34, 39.9], 15, { mode: 'drive', slice: 'morning-peak' }), (error) => error instanceof AccessibilityError && error.code === 'ACCESS_NOT_FOUND')
})

test('serviceArea keeps the real cancellation checkpoint between vendor calls', async () => {
  let calls = 0
  const slow = async (url) => {
    calls += 1
    if (calls === 1) { await new Promise(resolve => setTimeout(resolve, 50)) }
    return { ok: true, status: 200, text: async () => sampleDriveXml(600, 5) }
  }
  const provider = createTiandituNetworkProvider({ apiKey: 'fixture-only-not-a-credential', apiKeyEnv: 'TIANDITU_API_KEY', bbox: [116.34, 39.9, 116.36, 39.92], spacingDeg: 0.02, fetchImpl: slow })
  const controller = new AbortController()
  const area = provider.serviceArea([116.34, 39.9], 15, { mode: 'drive', slice: 'morning-peak', signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(area)
  const after = calls
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.equal(calls, after, 'no vendor call starts after the abort checkpoint')
})
