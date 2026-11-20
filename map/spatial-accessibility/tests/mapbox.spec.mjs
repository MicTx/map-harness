/**
 * Mapbox adapter gates (keyless, fixture transport): the adapter passes the
 * shared provider-contract assertions against a deterministic fixture that
 * speaks the Directions v5 and Isochrone v1 wire formats, the same assertions
 * double-run green against the controlled provider, and the adapter-specific
 * behavior is pinned: HTTP 401/403/404/422/429 mapping, the HTTP 200
 * "No route found" form, contour bounds, the WGS84 pass-through, metres-to-
 * kilometres conversion, and the declared shrinks. The real-API lane lives in
 * `vendor-contract.spec.mjs` and self-skips without `MAPBOX_ACCESS_TOKEN`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AccessibilityError,
  CONTROLLED_NETWORK_ID,
  classifyMapboxFailure,
  createControlledNetworkProvider,
  createMapboxNetworkProvider,
  MAPBOX_CAPABILITY_DECLARATION,
  MAPBOX_MAX_CONTOUR_MINUTES,
  MAPBOX_MAX_URL_BYTES,
  MAPBOX_NETWORK_ID,
  MAPBOX_PROFILES,
  MAPBOX_PROVIDER_LIMITATIONS,
} from '../src/index.ts'
import {
  assertCancellationContract,
  assertDeniedLoud,
  assertIdentityContract,
  assertRouteModePricing,
  assertServiceAreaBudgetContract,
  assertUnreachableLoud,
} from './provider-contract.shared.mjs'

const FIXTURE_TOKEN = 'pk.mapbox-fixture-token-1234'
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

/**
 * A ring around one origin whose vertex count grows with the contour, so a
 * larger budget reaches strictly more nodes — the service-area contract.
 */
function ringAround(origin, minutes) {
  const [lon, lat] = origin
  const span = 0.001 * minutes
  const steps = minutes
  const ring = []
  for (let step = 0; step < steps; step++) {
    const angle = (2 * Math.PI * step) / steps
    ring.push([lon + Math.cos(angle) * span, lat + Math.sin(angle) * span])
  }
  ring.push(ring[0])
  return ring
}

/**
 * The fixture Mapbox transport: parses the vendor path and `access_token`,
 * prices routes deterministically (walk 5 / bike 12 / drive 30 km/h plus
 * 60 s), serves an isochrone polygon whose span grows with the contour, and
 * scripts the documented failure forms.
 */
function fixtureTransport(options = {}) {
  const state = { calls: [] }
  const transport = async (url, init) => {
    const parsed = new URL(url)
    const token = parsed.searchParams.get('access_token')
    state.calls.push({ path: parsed.pathname, token, params: Object.fromEntries(parsed.searchParams), url })
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
    const json = (status, value) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) })
    if (options.httpStatus !== undefined) {
      return json(options.httpStatus, options.httpBody ?? { message: `http ${options.httpStatus}` })
    }
    if (token !== (options.validToken ?? FIXTURE_TOKEN)) {
      return json(401, { message: 'Not Authorized - Invalid Token' })
    }
    if (options.noRouteMessage === true) {
      return json(200, { message: 'No route found' })
    }
    if (parsed.pathname.startsWith('/directions/v5/')) {
      const segments = parsed.pathname.split('/')
      const profile = `${segments[3]}/${segments[4]}`
      const coordinates = segments[5].split(';').map(pair => pair.split(',').map(Number))
      const [origin, destination] = coordinates
      if (!fixtureServes(...origin) || !fixtureServes(...destination)) {
        return json(200, { code: 'NoRoute', message: 'No route found' })
      }
      const kilometres = fixtureDistanceKm(origin, destination)
      const speed = profile === MAPBOX_PROFILES.walk ? 5 : profile === MAPBOX_PROFILES.bike ? 12 : 30
      const mid = [(origin[0] + destination[0]) / 2, (origin[1] + destination[1]) / 2]
      return json(200, {
        code: 'Ok',
        routes: [{
          distance: kilometres * 1000,
          duration: kilometres / speed * 3600 + 60,
          geometry: { type: 'LineString', coordinates: [origin, mid, destination] },
        }],
      })
    }
    if (parsed.pathname.startsWith('/isochrone/v1/')) {
      const segments = parsed.pathname.split('/')
      const origin = segments[5].split(',').map(Number)
      if (!fixtureServes(...origin)) {
        return json(200, { message: 'No route found' })
      }
      const minutes = Number(parsed.searchParams.get('contours_minutes'))
      return json(200, {
        type: 'FeatureCollection',
        features: [{
          properties: { contour: minutes, metric: 'time' },
          geometry: { type: 'Polygon', coordinates: [ringAround(origin, minutes)] },
        }],
      })
    }
    return json(200, { code: 'InvalidInput', message: 'unrecognized path' })
  }
  return { transport, state }
}

/** A fixture-backed provider factory over the shared Beijing extent. */
function fixtureProvider(overrides = {}) {
  const { transport } = fixtureTransport(overrides.fixture ?? {})
  return createMapboxNetworkProvider({
    accessToken: overrides.accessToken ?? FIXTURE_TOKEN,
    accessTokenEnv: 'MAPBOX_ACCESS_TOKEN',
    bbox: overrides.bbox ?? BBOX,
    fetchImpl: transport,
  })
}

/** A fixture provider with an explicit transport handle (for wire assertions). */
function fixtureProviderWith(overrides = {}) {
  const handle = fixtureTransport(overrides.fixture ?? {})
  const provider = createMapboxNetworkProvider({
    accessToken: overrides.accessToken ?? FIXTURE_TOKEN,
    accessTokenEnv: 'MAPBOX_ACCESS_TOKEN',
    bbox: overrides.bbox ?? BBOX,
    fetchImpl: handle.transport,
  })
  return { provider, state: handle.state }
}

test('the adapter serves its network identity and the ref excludes the token', () => {
  const provider = fixtureProvider()
  assert.equal(provider.networkId, MAPBOX_NETWORK_ID)
  assert.match(provider.networkRef, /^mapbox-road-network-[0-9a-f]{16}@1$/)
  assert.equal(fixtureProvider({ accessToken: 'pk.another-fixture-token' }).networkRef, provider.networkRef)
  assert.notEqual(fixtureProvider({ bbox: [116.3, 39.9, 116.4, 39.96] }).networkRef, provider.networkRef)
  assert.equal(provider.networkRef.includes(FIXTURE_TOKEN), false)
})

test('the capability declaration names exactly the implemented faces and shrinks', () => {
  assert.equal(MAPBOX_CAPABILITY_DECLARATION.networkId, MAPBOX_NETWORK_ID)
  assert.deepEqual(MAPBOX_CAPABILITY_DECLARATION.mappable.map(face => face.face), ['route walk/bike/drive', 'serviceArea', 'cancellation'])
  assert.deepEqual(
    MAPBOX_CAPABILITY_DECLARATION.shrunk.map(face => face.face),
    ['readPois', 'barriers', 'time-slice pricing', 'isochrone contour bounds', 'directions coordinate bounds', 'network version', 'coordinate datum', 'display terms'],
    'every declared shrink must stay pinned; changing one without a test is a drift',
  )
  assert.equal(MAPBOX_PROVIDER_LIMITATIONS.length, 5, 'the limitation sentences mirror the load-bearing shrinks')
  assert.ok(MAPBOX_PROVIDER_LIMITATIONS.some(line => line.includes('displayed on a Mapbox map')), 'the terms notice is a limitation, not a code gate')
})

test('the shared identity, route, and service-area contracts double-run green', async () => {
  await assertIdentityContract(fixtureProvider(), () => fixtureProvider(), { networkId: MAPBOX_NETWORK_ID, refPattern: /^mapbox-road-network-[0-9a-f]{16}@1$/ })
  await assertIdentityContract(
    createControlledNetworkProvider({ bbox: BBOX }),
    () => createControlledNetworkProvider({ bbox: BBOX }),
    { networkId: CONTROLLED_NETWORK_ID, refPattern: /^controlled-lattice-[0-9a-f]{16}@1$/ },
  )
  await assertRouteModePricing(fixtureProvider(), BEIJING_A, BEIJING_B)
  await assertRouteModePricing(createControlledNetworkProvider({ bbox: BBOX, spacingDeg: 0.02 }), BEIJING_A, BEIJING_B)
  await assertServiceAreaBudgetContract(fixtureProvider(), BEIJING_A, 5, 15)
  await assertServiceAreaBudgetContract(createControlledNetworkProvider({ bbox: BBOX, spacingDeg: 0.02 }), BEIJING_A, 2, 30)
})

test('the shared cancel/denied/unreachable contracts double-run green', async () => {
  await assertCancellationContract(() => fixtureProvider({ fixture: { holdEveryRequestMs: 5000 } }).route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday', signal: AbortSignal.abort() }))
  const held = fixtureProviderWith({ fixture: { holdEveryRequestMs: 200 } })
  const controller = new AbortController()
  const pending = held.provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday', signal: controller.signal })
  controller.abort()
  await assertCancellationContract(() => pending)
  await assertDeniedLoud(
    () => fixtureProvider({ fixture: { validToken: 'pk.different-expected-token' } }).route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' }),
    FIXTURE_TOKEN,
  )
  await assertUnreachableLoud(
    () => fixtureProvider().route(TOKYO, OSAKA, { mode: 'drive', slice: 'midday' }),
    ['ACCESS_NOT_FOUND'],
  )
  await assertUnreachableLoud(
    () => fixtureProvider({ fixture: { noRouteMessage: true } }).route(BEIJING_A, BEIJING_B, { mode: 'drive', slice: 'midday' }),
    ['ACCESS_NOT_FOUND'],
  )
})

test('vendor statuses and body codes map onto the existing vocabulary without new codes', () => {
  const expectations = [
    [401, undefined, 'PERMISSION_DENIED'],
    [403, undefined, 'PERMISSION_DENIED'],
    [429, undefined, 'RATE_LIMITED'],
    [404, undefined, 'ACCESS_NOT_FOUND'],
    [422, undefined, 'ACCESS_INVALID_INPUT'],
    [200, 'NoRoute', 'ACCESS_NOT_FOUND'],
    [200, 'NoSegment', 'ACCESS_NOT_FOUND'],
    [200, 'InvalidInput', 'ACCESS_INVALID_INPUT'],
    [200, 'Ok', 'TEMPORARILY_UNAVAILABLE'],
    [500, undefined, 'TEMPORARILY_UNAVAILABLE'],
  ]
  for (const [status, bodyCode, code] of expectations) {
    assert.equal(classifyMapboxFailure(status, bodyCode), code, `status ${status} code ${bodyCode}`)
  }
})

test('http refusals and the 200-with-message form fail through the declared mapping', async () => {
  for (const [status, code] of [[403, 'PERMISSION_DENIED'], [404, 'ACCESS_NOT_FOUND'], [422, 'ACCESS_INVALID_INPUT'], [429, 'RATE_LIMITED']]) {
    await assert.rejects(
      () => fixtureProvider({ fixture: { httpStatus: status, httpBody: { message: `status ${status}`, code: 'Irrelevant' } } }).route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' }),
      (error) => error instanceof AccessibilityError && error.code === code && error.message.includes(`http ${status}`),
      `http ${status} must map to ${code}`,
    )
  }
  await assert.rejects(
    () => fixtureProvider({ fixture: { noRouteMessage: true } }).serviceArea(BEIJING_A, 10, { mode: 'walk', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_NOT_FOUND' && error.message.includes('No route found'),
  )
  await assert.rejects(
    () => fixtureProvider({ fixture: { httpStatus: 200, httpBody: '<html>not json</html>' } }).route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'TEMPORARILY_UNAVAILABLE' && error.message.includes('unexpected response form'),
  )
})

test('the wire carries the profile, access_token, and unshifted WGS84 coordinates', async () => {
  const { provider, state } = fixtureProviderWith()
  const route = await provider.route(BEIJING_A, BEIJING_B, { mode: 'bike', slice: 'midday' })
  const seen = state.calls[0]
  assert.equal(seen.path, `/directions/v5/${MAPBOX_PROFILES.bike}/${BEIJING_A.join(',')};${BEIJING_B.join(',')}`)
  assert.equal(seen.token, FIXTURE_TOKEN, 'the token rides access_token only')
  assert.equal(seen.params.geometries, 'geojson')
  assert.equal(seen.url.includes(FIXTURE_TOKEN), true)
  const straight = fixtureDistanceKm(BEIJING_A, BEIJING_B)
  assert.ok(Math.abs(route.distanceKm - straight) < 0.01, `metres must convert to kilometres (got ${route.distanceKm})`)
  const area = await provider.serviceArea(BEIJING_A, 10, { mode: 'walk', slice: 'midday' })
  const isochrone = state.calls[1]
  assert.equal(isochrone.path, `/isochrone/v1/${MAPBOX_PROFILES.walk}/${BEIJING_A.join(',')}`)
  assert.equal(isochrone.params.contours_minutes, '10')
  assert.equal(isochrone.params.polygons, 'true')
  assert.equal(area.nodes[0].minutes, 0)
  assert.ok(area.nodes.slice(1).every(node => node.minutes === 10))
})

test('contour bounds shrink loud and a URL over the vendor ceiling never leaves', async () => {
  const provider = fixtureProvider()
  for (const budget of [0, 61, 1.5]) {
    await assert.rejects(
      () => provider.serviceArea(BEIJING_A, budget, { mode: 'walk', slice: 'midday' }),
      (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT' && error.message.includes('contours_minutes'),
      `${budget} must be refused against the 1–${MAPBOX_MAX_CONTOUR_MINUTES} contour range`,
    )
  }
  await assert.rejects(
    () => provider.readPois(BBOX, { page: 0, pageSize: 7 }),
    (error) => error instanceof AccessibilityError && error.code === 'METHOD_NOT_APPLICABLE',
  )
  await assert.rejects(
    () => provider.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday', barriers: [{ from: [116.33, 39.9], to: [116.33, 39.94], kind: 'blocked' }] }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT',
  )
  const oversized = createMapboxNetworkProvider({
    accessToken: `pk.${'x'.repeat(MAPBOX_MAX_URL_BYTES)}`,
    accessTokenEnv: 'MAPBOX_ACCESS_TOKEN',
    bbox: BBOX,
    fetchImpl: async () => {
      throw new Error('the oversized URL must be refused before any request')
    },
  })
  await assert.rejects(
    () => oversized.route(BEIJING_A, BEIJING_B, { mode: 'walk', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT' && error.message.includes(String(MAPBOX_MAX_URL_BYTES)),
  )
})

test('time slices are accepted and do not change pricing', async () => {
  const provider = fixtureProvider()
  const midday = await provider.route(BEIJING_A, BEIJING_B, { mode: 'drive', slice: 'midday' })
  const peak = await provider.route(BEIJING_A, BEIJING_B, { mode: 'drive', slice: 'evening-peak' })
  assert.equal(peak.minutes, midday.minutes, 'slice pricing is a declared shrink')
  assert.equal(provider.pricesMode('bike'), true)
})

test('construction validates loudly: an empty token refuses', () => {
  assert.throws(
    () => createMapboxNetworkProvider({ accessToken: '', accessTokenEnv: 'MAPBOX_ACCESS_TOKEN', bbox: BBOX }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT' && error.message.includes('MAPBOX_ACCESS_TOKEN'),
  )
})
