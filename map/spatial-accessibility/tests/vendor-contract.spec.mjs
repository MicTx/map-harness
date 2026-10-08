/**
 * Real-vendor contract gate (key-activated lane): the four ledger retry
 * classes — cross-region, pagination-missing, cancellation, invalid key —
 * asserted against the real Amap, Tianditu, Mapbox, Baidu, and Tencent APIs through the
 * shipped adapters. Without the documented credential env (see
 * map/docs/spatial-accessibility.md) that vendor's real-API tests self-skip
 * and the suite still exits 0, the repository convention for keyed lanes.
 * The same four classes double-run green against the controlled provider in
 * this file, so the assertion set itself is proven provider-agnostic
 * (fixture equivalence); the keyless unit lanes in `amap.spec.mjs`,
 * `tianditu.spec.mjs`, `mapbox.spec.mjs`, `baidu.spec.mjs`, and `tencent.spec.mjs` cover each adapter's wire
 * behavior against a fixture transport.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AccessibilityError,
  AMAP_PAGE_WINDOW_ROWS,
  BAIDU_PAGE_WINDOW_ROWS,
  collectPois,
  createAmapNetworkProvider,
  createBaiduNetworkProvider,
  createControlledNetworkProvider,
  createMapboxNetworkProvider,
  createTencentNetworkProvider,
  createTiandituNetworkProvider,
} from '../src/index.ts'
import {
  assertCancellationContract,
  assertDeniedLoud,
  assertPaginationContract,
  assertPartialReadNeverComplete,
  assertRouteModePricing,
  assertServiceAreaBudgetContract,
  assertUnreachableLoud,
} from './provider-contract.shared.mjs'

/** The documented credential environment variables; absent ⇒ that vendor's lane self-skips (exit 0). */
const API_KEY = process.env.AMAP_API_KEY
const TIANDITU_KEY = process.env.TIANDITU_API_KEY
const MAPBOX_TOKEN = process.env.MAPBOX_ACCESS_TOKEN
const BAIDU_KEY = process.env.BAIDU_API_KEY
const TENCENT_KEY = process.env.TENCENT_MAP_KEY
const SKIP = API_KEY ? false : 'AMAP_API_KEY is not set — key-activated vendor lane self-skips; set it to re-verify the real Amap contract (see map/docs/spatial-accessibility.md)'
const SKIP_TIANDITU = TIANDITU_KEY ? false : 'TIANDITU_API_KEY is not set — key-activated vendor lane self-skips; set it to re-verify the real Tianditu contract (see map/docs/spatial-accessibility.md)'
const SKIP_MAPBOX = MAPBOX_TOKEN ? false : 'MAPBOX_ACCESS_TOKEN is not set — key-activated vendor lane self-skips; set it to re-verify the real Mapbox contract (see map/docs/spatial-accessibility.md)'
const SKIP_BAIDU = BAIDU_KEY ? false : 'BAIDU_API_KEY is not set — key-activated vendor lane self-skips; set it to re-verify the real Baidu contract (see map/docs/spatial-accessibility.md)'
const SKIP_TENCENT = TENCENT_KEY ? false : 'TENCENT_MAP_KEY is not set — key-activated vendor lane self-skips; set it to re-verify the real Tencent contract (see map/docs/spatial-accessibility.md)'

/** Real Beijing fixtures the vendor serves. */
const BEIJING_CENTER = [116.397, 39.909]
const BEIJING_NORTH = [116.427, 39.99]
const TOKYO = [139.6917, 35.6895]
const OSAKA = [135.5023, 34.6937]
const POI_BBOX = [116.420, 39.9, 116.436, 39.912]

/** Real-API provider over a small support extent (coarse spacing keeps the call volume bounded). */
function amapProvider(overrides = {}) {
  return createAmapNetworkProvider({
    apiKey: overrides.apiKey ?? API_KEY ?? '',
    apiKeyEnv: 'AMAP_API_KEY',
    bbox: overrides.bbox ?? [116.39, 39.9, 116.44, 39.94],
    spacingDeg: overrides.spacingDeg ?? 0.03,
    timeoutMs: 15_000,
  })
}

test('invalid key surfaces PERMISSION_DENIED with the vendor verdict and no key material', { skip: SKIP }, async () => {
  const bogus = 'amap-invalid-key-contract-gate'
  const provider = amapProvider({ apiKey: bogus })
  await assertDeniedLoud(
    () => provider.route(BEIJING_CENTER, BEIJING_NORTH, { mode: 'walk', slice: 'midday' }),
    bogus,
  )
})

test('cross-region pairs fail loud through the declared mapping instead of fabricating', { skip: SKIP }, async () => {
  const provider = amapProvider()
  await assertUnreachableLoud(
    () => provider.route(TOKYO, OSAKA, { mode: 'drive', slice: 'midday' }),
    ['ACCESS_NOT_FOUND', 'PERMISSION_DENIED', 'ACCESS_INVALID_INPUT'],
  )
  // The failure must be a vendor verdict (carrying the infocode), not a transport accident.
  await assert.rejects(
    () => provider.route(TOKYO, OSAKA, { mode: 'drive', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && /infocode \d+/.test(error.message),
  )
})

test('pagination contract against the real place directory: rows, beyond-total emptiness, no reshaping', { skip: SKIP }, async () => {
  const provider = amapProvider()
  const first = await provider.readPois(POI_BBOX, { page: 0, pageSize: 10 })
  assert.ok(first.total > 0, 'the POI fixture area must carry rows for the pagination assertions')
  if (first.total <= AMAP_PAGE_WINDOW_ROWS) {
    // Small directory: full pagination completes, a page beyond the total is honestly empty.
    const full = await collectPois(provider, POI_BBOX, { pageSize: 10 })
    assert.equal(full.coverage, 'complete')
    assert.equal(full.items.length, full.total)
    const beyond = await provider.readPois(POI_BBOX, { page: Math.ceil(first.total / 10) + 3, pageSize: 10 })
    assert.equal(beyond.items.length, 0, 'a page beyond the total must not fabricate items')
    assert.equal(beyond.hasMore, false, 'a page beyond the total must end pagination')
  } else {
    // Larger directory: the vendor window stops the read partial, never complete.
    const partial = await collectPois(provider, POI_BBOX, { pageSize: 25 })
    assert.equal(partial.coverage, 'partial')
    assert.equal(partial.interruptedBy, 'RATE_LIMITED')
    assert.equal(partial.items.length, AMAP_PAGE_WINDOW_ROWS)
  }
})

test('cancellation aborts the real transport at provider checkpoints', { skip: SKIP }, async () => {
  const provider = amapProvider()
  await assertCancellationContract(() => provider.readPois(POI_BBOX, { page: 0, pageSize: 10, signal: AbortSignal.abort() }))
  const controller = new AbortController()
  const pending = provider.route(BEIJING_CENTER, BEIJING_NORTH, { mode: 'walk', slice: 'midday', signal: controller.signal })
  controller.abort()
  await assertCancellationContract(() => pending)
})

// ---------------------------------------------------------------------------
// Tianditu lane. The vendor publishes no POI directory and no isochrone, so
// the pagination class is the declared shrink (a loud refusal, never a
// fabricated page) and the pricing class is the route face only.
// ---------------------------------------------------------------------------

/** Real-API Tianditu provider over the Beijing support extent. */
function tiandituProvider(overrides = {}) {
  return createTiandituNetworkProvider({
    apiKey: overrides.apiKey ?? TIANDITU_KEY ?? '',
    apiKeyEnv: 'TIANDITU_API_KEY',
    bbox: [116.39, 39.9, 116.44, 39.94],
    timeoutMs: 15_000,
  })
}

test('tianditu invalid key surfaces PERMISSION_DENIED with no key material', { skip: SKIP_TIANDITU }, async () => {
  const bogus = 'tianditu-invalid-key-contract-gate'
  await assertDeniedLoud(
    () => tiandituProvider({ apiKey: bogus }).route(BEIJING_CENTER, BEIJING_NORTH, { mode: 'drive', slice: 'midday' }),
    bogus,
  )
})

test('tianditu cross-region pairs fail loud through the declared mapping', { skip: SKIP_TIANDITU }, async () => {
  await assertUnreachableLoud(
    () => tiandituProvider().route(TOKYO, OSAKA, { mode: 'drive', slice: 'midday' }),
    ['ACCESS_NOT_FOUND', 'PERMISSION_DENIED', 'ACCESS_INVALID_INPUT'],
  )
})

test('tianditu pagination class is the declared shrink: no directory, loud refusal', { skip: SKIP_TIANDITU }, async () => {
  await assert.rejects(
    () => tiandituProvider().readPois(POI_BBOX, { page: 0, pageSize: 10 }),
    (error) => error instanceof AccessibilityError && error.code === 'METHOD_NOT_APPLICABLE',
    'a vendor without a POI directory must refuse the page, never fabricate one',
  )
})

test('tianditu cancellation aborts the real transport at provider checkpoints', { skip: SKIP_TIANDITU }, async () => {
  await assertCancellationContract(() => tiandituProvider().route(BEIJING_CENTER, BEIJING_NORTH, { mode: 'drive', slice: 'midday', signal: AbortSignal.abort() }))
  const controller = new AbortController()
  const pending = tiandituProvider().route(BEIJING_CENTER, BEIJING_NORTH, { mode: 'walk', slice: 'midday', signal: controller.signal })
  controller.abort()
  await assertCancellationContract(() => pending)
})

test('tianditu real route pricing holds within the mappable face', { skip: SKIP_TIANDITU }, async () => {
  await assertRouteModePricing(tiandituProvider(), BEIJING_CENTER, BEIJING_NORTH)
})

// ---------------------------------------------------------------------------
// Mapbox lane. Isochrone contours are whole minutes from 1 to 60, so the
// budget contract uses that range; the pagination class is the declared
// shrink.
// ---------------------------------------------------------------------------

/** Real-API Mapbox provider over the Beijing support extent. */
function mapboxProvider(overrides = {}) {
  return createMapboxNetworkProvider({
    accessToken: overrides.accessToken ?? MAPBOX_TOKEN ?? '',
    accessTokenEnv: 'MAPBOX_ACCESS_TOKEN',
    bbox: [116.39, 39.9, 116.44, 39.94],
    timeoutMs: 15_000,
  })
}

test('mapbox invalid token surfaces PERMISSION_DENIED with no token material', { skip: SKIP_MAPBOX }, async () => {
  const bogus = 'pk.mapbox-invalid-token-contract-gate'
  await assertDeniedLoud(
    () => mapboxProvider({ accessToken: bogus }).route(BEIJING_CENTER, BEIJING_NORTH, { mode: 'drive', slice: 'midday' }),
    bogus,
  )
})

test('mapbox cross-region pairs fail loud through the declared mapping', { skip: SKIP_MAPBOX }, async () => {
  await assertUnreachableLoud(
    () => mapboxProvider().route(TOKYO, OSAKA, { mode: 'drive', slice: 'midday' }),
    ['ACCESS_NOT_FOUND', 'PERMISSION_DENIED', 'ACCESS_INVALID_INPUT'],
  )
})

test('mapbox pagination class is the declared shrink: no directory, loud refusal', { skip: SKIP_MAPBOX }, async () => {
  await assert.rejects(
    () => mapboxProvider().readPois(POI_BBOX, { page: 0, pageSize: 10 }),
    (error) => error instanceof AccessibilityError && error.code === 'METHOD_NOT_APPLICABLE',
    'a vendor without a POI directory must refuse the page, never fabricate one',
  )
})

test('mapbox cancellation aborts the real transport at provider checkpoints', { skip: SKIP_MAPBOX }, async () => {
  await assertCancellationContract(() => mapboxProvider().route(BEIJING_CENTER, BEIJING_NORTH, { mode: 'drive', slice: 'midday', signal: AbortSignal.abort() }))
  const controller = new AbortController()
  const pending = mapboxProvider().serviceArea(BEIJING_CENTER, 10, { mode: 'walk', slice: 'midday', signal: controller.signal })
  controller.abort()
  await assertCancellationContract(() => pending)
})

test('mapbox real route/service-area pricing holds within the mappable face', { skip: SKIP_MAPBOX }, async () => {
  const provider = mapboxProvider()
  await assertRouteModePricing(provider, BEIJING_CENTER, BEIJING_NORTH)
  await assertServiceAreaBudgetContract(provider, [116.41, 39.92], 5, 15)
})

test('real route/service-area pricing holds within the mappable face', { skip: SKIP }, async () => {
  const provider = amapProvider()
  await assertRouteModePricing(provider, BEIJING_CENTER, BEIJING_NORTH)
  await assertServiceAreaBudgetContract(provider, [116.41, 39.92], 2, 90)
})

// ---------------------------------------------------------------------------
// Baidu and Tencent lanes. Both providers expose route and POI pagination;
// service-area evidence is deliberately bounded to the adapter's sampling
// implementation. Credentials are optional and absent lanes self-skip.
// ---------------------------------------------------------------------------

function baiduProvider(overrides = {}) {
  return createBaiduNetworkProvider({
    apiKey: overrides.apiKey ?? BAIDU_KEY ?? '',
    apiKeyEnv: 'BAIDU_API_KEY',
    bbox: [116.39, 39.9, 116.44, 39.94],
    spacingDeg: 0.03,
    timeoutMs: 15_000,
  })
}

test('baidu invalid key surfaces PERMISSION_DENIED with no key material', { skip: SKIP_BAIDU }, async () => {
  const bogus = 'baidu-invalid-key-contract-gate'
  await assertDeniedLoud(() => baiduProvider({ apiKey: bogus }).route(BEIJING_CENTER, BEIJING_NORTH, { mode: 'drive', slice: 'midday' }), bogus)
})

test('baidu cross-region pairs fail loud through the declared mapping', { skip: SKIP_BAIDU }, async () => {
  await assertUnreachableLoud(() => baiduProvider().route(TOKYO, OSAKA, { mode: 'drive', slice: 'midday' }), ['ACCESS_NOT_FOUND', 'PERMISSION_DENIED', 'ACCESS_INVALID_INPUT'])
})

test('baidu pagination and cancellation lanes use the real adapter', { skip: SKIP_BAIDU }, async () => {
  const provider = baiduProvider()
  const first = await provider.readPois(POI_BBOX, { page: 0, pageSize: 10 })
  assert.ok(first.total >= 0)
  if (first.total <= BAIDU_PAGE_WINDOW_ROWS) {
    const full = await collectPois(provider, POI_BBOX, { pageSize: 10 })
    assert.equal(full.coverage, 'complete')
    assert.equal(full.items.length, full.total)
  }
  await assertCancellationContract(() => provider.route(BEIJING_CENTER, BEIJING_NORTH, { mode: 'walk', slice: 'midday', signal: AbortSignal.abort() }))
})

function tencentProvider(overrides = {}) {
  return createTencentNetworkProvider({
    apiKey: overrides.apiKey ?? TENCENT_KEY ?? '',
    apiKeyEnv: 'TENCENT_MAP_KEY',
    bbox: [116.39, 39.9, 116.44, 39.94],
    spacingDeg: 0.03,
    timeoutMs: 15_000,
  })
}

test('tencent invalid key surfaces PERMISSION_DENIED with no key material', { skip: SKIP_TENCENT }, async () => {
  const bogus = 'tencent-invalid-key-contract-gate'
  await assertDeniedLoud(() => tencentProvider({ apiKey: bogus }).route(BEIJING_CENTER, BEIJING_NORTH, { mode: 'drive', slice: 'midday' }), bogus)
})

test('tencent cross-region pairs fail loud through the declared mapping', { skip: SKIP_TENCENT }, async () => {
  await assertUnreachableLoud(() => tencentProvider().route(TOKYO, OSAKA, { mode: 'drive', slice: 'midday' }), ['ACCESS_NOT_FOUND', 'PERMISSION_DENIED', 'ACCESS_INVALID_INPUT'])
})

test('tencent pagination and cancellation lanes use the real adapter', { skip: SKIP_TENCENT }, async () => {
  const provider = tencentProvider()
  const first = await provider.readPois(POI_BBOX, { page: 0, pageSize: 10 })
  assert.ok(first.total >= 0)
  const controller = new AbortController()
  const pending = provider.route(BEIJING_CENTER, BEIJING_NORTH, { mode: 'walk', slice: 'midday', signal: controller.signal })
  controller.abort()
  await assertCancellationContract(() => pending)
})

// ---------------------------------------------------------------------------
// Controlled double-run: the same four classes against the controlled
// provider, always green without a key — the assertion set is provider-
// agnostic (受控 fixture 双跑等价).
// ---------------------------------------------------------------------------

test('invalid-key class double-runs green on the controlled provider (fault ladder)', async () => {
  const denied = createControlledNetworkProvider({
    bbox: [116.3, 39.9, 116.36, 39.94],
    faults: [{ op: 'route', nth: 1, code: 'PERMISSION_DENIED' }],
  })
  await assertDeniedLoud(
    () => denied.route([116.305, 39.905], [116.355, 39.935], { mode: 'walk', slice: 'midday' }),
    'never-a-secret-token',
  )
})

test('cross-region class double-runs green on the controlled provider (barrier wall)', async () => {
  const walled = createControlledNetworkProvider({ bbox: [116.3, 39.9, 116.36, 39.94], spacingDeg: 0.02 })
  const wall = { from: [116.33, 39.9], to: [116.33, 39.94], kind: 'blocked' }
  await assertUnreachableLoud(
    () => walled.route([116.305, 39.905], [116.355, 39.935], { mode: 'walk', slice: 'midday', barriers: [wall] }),
    ['ACCESS_NOT_FOUND'],
  )
})

test('pagination class double-runs green on the controlled provider (synthetic directory)', async () => {
  const provider = createControlledNetworkProvider({ bbox: [116.3, 39.9, 116.36, 39.94] })
  await assertPaginationContract(provider, [116.3, 39.9, 116.36, 39.94], [116.3, 39.9, 116.3001, 39.9001], 7)
  await assertPartialReadNeverComplete(
    () => createControlledNetworkProvider({ bbox: [116.3, 39.9, 116.36, 39.94], faults: [{ op: 'pois', nth: 2, code: 'RATE_LIMITED' }] }),
    [116.3, 39.9, 116.36, 39.94], 7,
  )
})

test('cancellation class double-runs green on the controlled provider (expansion checkpoint)', async () => {
  let expansions = 0
  const controller = new AbortController()
  const provider = createControlledNetworkProvider({
    bbox: [116.0, 39.6, 117.6, 40.8],
    spacingDeg: 0.008,
    beforeExpand: () => {
      expansions += 1
      if (expansions === 2) controller.abort()
    },
  })
  await assertCancellationContract(() => provider.serviceArea([116.8, 40.2], 120, { mode: 'walk', slice: 'midday', signal: controller.signal }))
  assert.ok(expansions < 100, 'the expansion stopped at the checkpoint, not after the full lattice')
})
