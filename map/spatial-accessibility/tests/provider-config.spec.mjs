/**
 * Network-source Config gates: the credential/config plane the vendor adapters
 * mount through — schema normalization (each credential field is an
 * environment-variable reference with a name default, never a key value),
 * loud selection (controlled default, exactly six configured ids, a vendor
 * choice without a resolvable credential fails at load instead of falling
 * back), and key hygiene (the value never appears in error text or network
 * refs).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AccessibilityError,
  AMAP_NETWORK_ID,
  Config,
  CONFIGURED_NETWORK_IDS,
  CONTROLLED_NETWORK_ID,
  AMAP_BASE_URL,
  DEFAULT_AMAP_API_KEY_ENV,
  DEFAULT_MAPBOX_ACCESS_TOKEN_ENV,
  DEFAULT_TIANDITU_API_KEY_ENV,
  DEFAULT_BAIDU_API_KEY_ENV,
  DEFAULT_TENCENT_API_KEY_ENV,
  MAPBOX_BASE_URL,
  TIANDITU_BASE_URL,
  MAPBOX_NETWORK_ID,
  TIANDITU_NETWORK_ID,
  BAIDU_NETWORK_ID,
  TENCENT_NETWORK_ID,
  createAmapNetworkProvider,
  createMapboxNetworkProvider,
  createTiandituNetworkProvider,
  createBaiduNetworkProvider,
  createTencentNetworkProvider,
  resolveNetworkSource,
} from '../src/index.ts'

/** Config fragment with only the required root, as the Loader would receive it. */
function baseConfig(overrides = {}) {
  return { root: '/tmp/accessibility-store', ...overrides }
}

test('the config schema defaults the credential reference to the env name, never a key value', () => {
  const plain = Config(baseConfig())
  assert.equal(plain.provider, undefined, 'no schemastery default for the provider id: an unset source stays the controlled lattice')
  // The nested vendor blocks materialize their inner credential-reference defaults, the llm-deepseek precedent.
  const withBlocks = Config(baseConfig({ amap: {}, tianditu: {}, mapbox: {}, baidu: {}, tencent: {} }))
  assert.equal(withBlocks.amap?.apiKeyEnv, DEFAULT_AMAP_API_KEY_ENV)
  assert.equal(withBlocks.tianditu?.apiKeyEnv, DEFAULT_TIANDITU_API_KEY_ENV)
  assert.equal(withBlocks.mapbox?.accessTokenEnv, DEFAULT_MAPBOX_ACCESS_TOKEN_ENV)
  assert.equal(withBlocks.baidu?.apiKeyEnv, DEFAULT_BAIDU_API_KEY_ENV)
  assert.equal(withBlocks.tencent?.apiKeyEnv, DEFAULT_TENCENT_API_KEY_ENV)
  const serialized = JSON.stringify(withBlocks)
  assert.match(serialized, /AMAP_API_KEY/, 'the config carries the amap env name as the credential reference')
  assert.match(serialized, /TIANDITU_API_KEY/, 'the config carries the tianditu env name as the credential reference')
  assert.match(serialized, /MAPBOX_ACCESS_TOKEN/, 'the config carries the mapbox env name as the credential reference')
  assert.match(serialized, /BAIDU_API_KEY/, 'the config carries the baidu env name as the credential reference')
  assert.match(serialized, /TENCENT_MAP_KEY/, 'the config carries the tencent env name as the credential reference')
  assert.equal(/apiKey"?\s*:\s*"[A-Za-z0-9]{20,}/.test(serialized), false, 'no key value can live in config serialization')
  assert.equal(/accessToken"?\s*:\s*"pk\./.test(serialized), false, 'no token value can live in config serialization')
})

test('the schema rejects out-of-bounds adapter tuning', () => {
  assert.throws(() => Config(baseConfig({ amap: { spacingDeg: 0.0000001 } })))
  assert.throws(() => Config(baseConfig({ amap: { spacingDeg: 5 } })))
  assert.throws(() => Config(baseConfig({ amap: { timeoutMs: 10 } })))
  assert.throws(() => Config(baseConfig({ amap: { timeoutMs: 120000 } })))
  assert.doesNotThrow(() => Config(baseConfig({ amap: { spacingDeg: 0.02, timeoutMs: 5000 } })))
  assert.throws(() => Config(baseConfig({ baidu: { spacingDeg: 0.0000001 } })))
  assert.throws(() => Config(baseConfig({ tencent: { timeoutMs: 120000 } })))
  assert.doesNotThrow(() => Config(baseConfig({ baidu: { spacingDeg: 0.02, timeoutMs: 5000 }, tencent: { spacingDeg: 0.02, timeoutMs: 5000 } })))
})

test('selection defaults to the controlled lattice and knows exactly six configured ids', () => {
  assert.deepEqual(CONFIGURED_NETWORK_IDS, [CONTROLLED_NETWORK_ID, AMAP_NETWORK_ID, TIANDITU_NETWORK_ID, MAPBOX_NETWORK_ID, BAIDU_NETWORK_ID, TENCENT_NETWORK_ID])
  assert.equal(resolveNetworkSource(baseConfig()).kind, 'controlled')
  assert.equal(resolveNetworkSource(baseConfig({ provider: CONTROLLED_NETWORK_ID })).kind, 'controlled')
})

test('an unconfigured provider id fails loud at selection, naming the configured sources', () => {
  for (const unknown of ['osm', '']) {
    assert.throws(
      () => resolveNetworkSource(baseConfig({ provider: unknown })),
      (error) => {
        assert.ok(error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT', `expected ACCESS_INVALID_INPUT for ${unknown}`)
        assert.equal(
          CONFIGURED_NETWORK_IDS.every(id => error.message.includes(id)),
          true,
          'the failure lists every configured source',
        )
        return true
      },
    )
  }
})

test('the amap choice without a resolvable key fails loud at selection, naming the env name only', () => {
  assert.throws(
    () => resolveNetworkSource(baseConfig({ provider: AMAP_NETWORK_ID }), {}),
    (error) => {
      assert.ok(error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT')
      assert.equal(error.message.includes(DEFAULT_AMAP_API_KEY_ENV), true, 'the failure names the environment variable')
      assert.equal(error.message.includes('amap-fixture-secret'), false, 'the failure never carries a key value')
      assert.equal(error.message.includes(CONTROLLED_NETWORK_ID), true, 'the refusal to fall back silently is stated')
      return true
    },
  )
  // An env holding only whitespace is not a key either.
  assert.throws(
    () => resolveNetworkSource(baseConfig({ provider: AMAP_NETWORK_ID }), { AMAP_API_KEY: '   ' }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT',
  )
})

test('the amap choice resolves the key through the configured env name', () => {
  const plan = resolveNetworkSource(
    baseConfig({ provider: AMAP_NETWORK_ID, amap: { apiKeyEnv: 'AMAP_TEST_KEY', spacingDeg: 0.05, timeoutMs: 3000 } }),
    { AMAP_TEST_KEY: 'amap-fixture-secret' },
  )
  assert.equal(plan.kind, 'amap')
  assert.equal(plan.apiKey, 'amap-fixture-secret')
  assert.equal(plan.apiKeyEnv, 'AMAP_TEST_KEY')
  assert.equal(plan.spacingDeg, 0.05)
  assert.equal(plan.timeoutMs, 3000)
})

test('the resolved plan builds a provider whose network ref excludes the key', () => {
  const shape = { bbox: [116.3, 39.9, 116.36, 39.94], spacingDeg: 0.02 }
  const build = (secret) => createAmapNetworkProvider({
    apiKey: secret,
    apiKeyEnv: DEFAULT_AMAP_API_KEY_ENV,
    ...shape,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: '1', count: '0', pois: [] }) }),
  })
  assert.equal(build('amap-fixture-secret').networkRef, build('a-completely-different-secret').networkRef)
  assert.equal(build('amap-fixture-secret').networkRef.includes('amap-fixture-secret'), false)
})

test('the tianditu choice without a resolvable key fails loud, naming the env name only', () => {
  assert.throws(
    () => resolveNetworkSource(baseConfig({ provider: TIANDITU_NETWORK_ID }), {}),
    (error) => {
      assert.ok(error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT')
      assert.equal(error.message.includes(DEFAULT_TIANDITU_API_KEY_ENV), true, 'the failure names the environment variable')
      assert.equal(error.message.includes('tianditu-fixture-secret'), false, 'the failure never carries a key value')
      assert.equal(error.message.includes(CONTROLLED_NETWORK_ID), true, 'the refusal to fall back silently is stated')
      return true
    },
  )
  assert.throws(
    () => resolveNetworkSource(baseConfig({ provider: TIANDITU_NETWORK_ID }), { TIANDITU_API_KEY: '   ' }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT',
  )
})

test('the tianditu choice resolves the key through the configured env name', () => {
  const plan = resolveNetworkSource(
    baseConfig({ provider: TIANDITU_NETWORK_ID, tianditu: { apiKeyEnv: 'TIANDITU_TEST_KEY', timeoutMs: 4000 } }),
    { TIANDITU_TEST_KEY: 'tianditu-fixture-secret' },
  )
  assert.equal(plan.kind, 'tianditu')
  assert.equal(plan.apiKey, 'tianditu-fixture-secret')
  assert.equal(plan.apiKeyEnv, 'TIANDITU_TEST_KEY')
  assert.equal(plan.timeoutMs, 4000)
})

test('the mapbox choice without a resolvable token fails loud, naming the env name only', () => {
  assert.throws(
    () => resolveNetworkSource(baseConfig({ provider: MAPBOX_NETWORK_ID }), {}),
    (error) => {
      assert.ok(error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT')
      assert.equal(error.message.includes(DEFAULT_MAPBOX_ACCESS_TOKEN_ENV), true, 'the failure names the environment variable')
      assert.equal(error.message.includes('pk.mapbox-fixture-secret'), false, 'the failure never carries a token value')
      assert.equal(error.message.includes(CONTROLLED_NETWORK_ID), true, 'the refusal to fall back silently is stated')
      return true
    },
  )
  assert.throws(
    () => resolveNetworkSource(baseConfig({ provider: MAPBOX_NETWORK_ID }), { MAPBOX_ACCESS_TOKEN: '   ' }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT',
  )
})

test('the mapbox choice resolves the token through the configured env name', () => {
  const plan = resolveNetworkSource(
    baseConfig({ provider: MAPBOX_NETWORK_ID, mapbox: { accessTokenEnv: 'MAPBOX_TEST_TOKEN', timeoutMs: 5000 } }),
    { MAPBOX_TEST_TOKEN: 'pk.mapbox-fixture-secret' },
  )
  assert.equal(plan.kind, 'mapbox')
  assert.equal(plan.accessToken, 'pk.mapbox-fixture-secret')
  assert.equal(plan.accessTokenEnv, 'MAPBOX_TEST_TOKEN')
  assert.equal(plan.timeoutMs, 5000)
})

test('the baidu and tencent choices resolve credentials and tuning through their env names', () => {
  const baidu = resolveNetworkSource(
    baseConfig({ provider: BAIDU_NETWORK_ID, baidu: { apiKeyEnv: 'BAIDU_TEST_KEY', spacingDeg: 0.05, timeoutMs: 3000 } }),
    { BAIDU_TEST_KEY: 'baidu-fixture-secret' },
  )
  assert.equal(baidu.kind, 'baidu')
  assert.equal(baidu.apiKey, 'baidu-fixture-secret')
  assert.equal(baidu.apiKeyEnv, 'BAIDU_TEST_KEY')
  assert.equal(baidu.spacingDeg, 0.05)
  assert.equal(baidu.timeoutMs, 3000)
  const tencent = resolveNetworkSource(
    baseConfig({ provider: TENCENT_NETWORK_ID, tencent: { apiKeyEnv: 'TENCENT_TEST_KEY', spacingDeg: 0.04, timeoutMs: 4000 } }),
    { TENCENT_TEST_KEY: 'tencent-fixture-secret' },
  )
  assert.equal(tencent.kind, 'tencent')
  assert.equal(tencent.apiKey, 'tencent-fixture-secret')
  assert.equal(tencent.apiKeyEnv, 'TENCENT_TEST_KEY')
  assert.equal(tencent.spacingDeg, 0.04)
  assert.equal(tencent.timeoutMs, 4000)
})

test('the baidu and tencent choices refuse missing credentials and keep keys out of refs', () => {
  assert.throws(() => resolveNetworkSource(baseConfig({ provider: BAIDU_NETWORK_ID }), {}), (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT' && error.message.includes(DEFAULT_BAIDU_API_KEY_ENV))
  assert.throws(() => resolveNetworkSource(baseConfig({ provider: TENCENT_NETWORK_ID }), {}), (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT' && error.message.includes(DEFAULT_TENCENT_API_KEY_ENV))
  const bbox = [116.3, 39.9, 116.36, 39.94]
  const baidu = (key) => createBaiduNetworkProvider({ apiKey: key, apiKeyEnv: DEFAULT_BAIDU_API_KEY_ENV, bbox, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 0, total: 0, results: [] }) }) })
  const tencent = (key) => createTencentNetworkProvider({ apiKey: key, apiKeyEnv: DEFAULT_TENCENT_API_KEY_ENV, bbox, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: 0, result: { count: 0, data: [] } }) }) })
  assert.equal(baidu('baidu-fixture-secret').networkRef, baidu('other-baidu-secret').networkRef)
  assert.equal(tencent('tencent-fixture-secret').networkRef, tencent('other-tencent-secret').networkRef)
  assert.equal(baidu('baidu-fixture-secret').networkRef.includes('baidu-fixture-secret'), false)
  assert.equal(tencent('tencent-fixture-secret').networkRef.includes('tencent-fixture-secret'), false)
})

test('the resolved vendor plans build providers whose network refs exclude the credential', () => {
  const bbox = [116.3, 39.9, 116.36, 39.94]
  const tianditu = (secret) => createTiandituNetworkProvider({
    apiKey: secret,
    apiKeyEnv: DEFAULT_TIANDITU_API_KEY_ENV,
    bbox,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<result><distance>1</distance><duration>60</duration><routelatlon>116.3,39.9</routelatlon></result>' }),
  })
  assert.equal(tianditu('tianditu-fixture-secret').networkRef, tianditu('a-completely-different-secret').networkRef)
  assert.equal(tianditu('tianditu-fixture-secret').networkRef.includes('tianditu-fixture-secret'), false)
  const mapbox = (secret) => createMapboxNetworkProvider({
    accessToken: secret,
    accessTokenEnv: DEFAULT_MAPBOX_ACCESS_TOKEN_ENV,
    bbox,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 'Ok', routes: [] }) }),
  })
  assert.equal(mapbox('pk.mapbox-fixture-secret').networkRef, mapbox('pk.a-completely-different-secret').networkRef)
  assert.equal(mapbox('pk.mapbox-fixture-secret').networkRef.includes('pk.mapbox-fixture-secret'), false)
})

/** A Config value the schema must refuse, on every vendor block. */
const REJECTED_BASE_URLS = [
  'ftp://mirror.example',
  'restapi.amap.com',
  'https://mirror.example/',
  'https://mirror.example/v3',
  'https://mirror.example?tk=leaked',
  'https://user:leaked@mirror.example',
  'http://user:leaked@mirror.example',
  '',
]

test('each vendor baseUrl is optional and a valid http(s) root is accepted', () => {
  const accepted = Config(baseConfig({
    amap: { baseUrl: 'https://amap-mirror.example' },
    tianditu: { baseUrl: 'https://tianditu-mirror.example' },
    mapbox: { baseUrl: 'http://mapbox-mirror.example' },
  }))
  assert.equal(accepted.amap?.baseUrl, 'https://amap-mirror.example')
  assert.equal(accepted.tianditu?.baseUrl, 'https://tianditu-mirror.example')
  assert.equal(accepted.mapbox?.baseUrl, 'http://mapbox-mirror.example')
  const omitted = Config(baseConfig({ amap: {}, tianditu: {}, mapbox: {} }))
  assert.equal(omitted.amap?.baseUrl, undefined)
  assert.equal(omitted.tianditu?.baseUrl, undefined)
  assert.equal(omitted.mapbox?.baseUrl, undefined)
})

test('a vendor baseUrl that is not an http(s) root, or that carries a credential, is refused', () => {
  for (const block of ['amap', 'tianditu', 'mapbox', 'baidu', 'tencent']) {
    for (const baseUrl of REJECTED_BASE_URLS) {
      assert.throws(
        () => Config(baseConfig({ [block]: { baseUrl } })),
        (error) => {
          assert.equal(String(error).includes('leaked'), false, `${block} rejection must not echo a credential from the refused URL`)
          return true
        },
        `${block} must refuse ${baseUrl || '<empty>'}`,
      )
    }
  }
})

test('a configured baseUrl reaches the resolved plan and is omitted when unset', () => {
  const amap = resolveNetworkSource(
    baseConfig({ provider: AMAP_NETWORK_ID, amap: { baseUrl: 'https://amap-mirror.example' } }),
    { AMAP_API_KEY: 'amap-fixture-secret' },
  )
  assert.equal(amap.baseUrl, 'https://amap-mirror.example')
  const tianditu = resolveNetworkSource(
    baseConfig({ provider: TIANDITU_NETWORK_ID, tianditu: { baseUrl: 'https://tianditu-mirror.example' } }),
    { TIANDITU_API_KEY: 'tianditu-fixture-secret' },
  )
  assert.equal(tianditu.baseUrl, 'https://tianditu-mirror.example')
  const mapbox = resolveNetworkSource(
    baseConfig({ provider: MAPBOX_NETWORK_ID, mapbox: { baseUrl: 'https://mapbox-mirror.example' } }),
    { MAPBOX_ACCESS_TOKEN: 'pk.mapbox-fixture-secret' },
  )
  assert.equal(mapbox.baseUrl, 'https://mapbox-mirror.example')
  const defaults = [
    resolveNetworkSource(baseConfig({ provider: AMAP_NETWORK_ID }), { AMAP_API_KEY: 'amap-fixture-secret' }),
    resolveNetworkSource(baseConfig({ provider: TIANDITU_NETWORK_ID }), { TIANDITU_API_KEY: 'tianditu-fixture-secret' }),
    resolveNetworkSource(baseConfig({ provider: MAPBOX_NETWORK_ID }), { MAPBOX_ACCESS_TOKEN: 'pk.mapbox-fixture-secret' }),
  ]
  assert.deepEqual(defaults.map(plan => plan.baseUrl), [undefined, undefined, undefined])
})

test('a configured baseUrl is the root the adapter fetches, and omission keeps the vendor constant', async () => {
  const bbox = [116.3, 39.9, 116.36, 39.94]
  const origin = [116.31, 39.91]
  const destination = [116.34, 39.93]
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    const path = new URL(url).pathname
    if (path.startsWith('/v3/')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: '1', info: 'OK', infocode: '10000', route: { paths: [{ distance: '1000', duration: '120', steps: [{ polyline: '116.31,39.91;116.34,39.93' }] }] } }) }
    }
    if (path === '/drive') {
      return { ok: true, status: 200, text: async () => '<result><distance>1.2</distance><duration>180</duration><routelatlon>116.31,39.91;116.34,39.93</routelatlon></result>' }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ code: 'Ok', routes: [{ duration: 120, distance: 1000, geometry: { type: 'LineString', coordinates: [[116.31, 39.91], [116.34, 39.93]] } }], waypoints: [{}, {}] }) }
  }
  const route = { mode: 'drive', slice: 'midday' }
  await createAmapNetworkProvider({ apiKey: 'amap-fixture-secret', apiKeyEnv: DEFAULT_AMAP_API_KEY_ENV, bbox, spacingDeg: 0.02, baseUrl: 'https://amap-mirror.example', fetchImpl }).route(origin, destination, route)
  await createTiandituNetworkProvider({ apiKey: 'tianditu-fixture-secret', apiKeyEnv: DEFAULT_TIANDITU_API_KEY_ENV, bbox, baseUrl: 'https://tianditu-mirror.example', fetchImpl }).route(origin, destination, route)
  await createMapboxNetworkProvider({ accessToken: 'pk.mapbox-fixture-secret', accessTokenEnv: DEFAULT_MAPBOX_ACCESS_TOKEN_ENV, bbox, baseUrl: 'https://mapbox-mirror.example', fetchImpl }).route(origin, destination, route)
  assert.equal(calls[0].startsWith('https://amap-mirror.example/v3/'), true)
  assert.equal(calls[1].startsWith('https://tianditu-mirror.example/drive?'), true)
  assert.equal(calls[2].startsWith('https://mapbox-mirror.example/directions/v5/'), true)
  calls.length = 0
  await createAmapNetworkProvider({ apiKey: 'amap-fixture-secret', apiKeyEnv: DEFAULT_AMAP_API_KEY_ENV, bbox, spacingDeg: 0.02, fetchImpl }).route(origin, destination, route)
  await createTiandituNetworkProvider({ apiKey: 'tianditu-fixture-secret', apiKeyEnv: DEFAULT_TIANDITU_API_KEY_ENV, bbox, fetchImpl }).route(origin, destination, route)
  await createMapboxNetworkProvider({ accessToken: 'pk.mapbox-fixture-secret', accessTokenEnv: DEFAULT_MAPBOX_ACCESS_TOKEN_ENV, bbox, fetchImpl }).route(origin, destination, route)
  assert.equal(calls[0].startsWith(`${AMAP_BASE_URL}/v3/`), true)
  assert.equal(calls[1].startsWith(`${TIANDITU_BASE_URL}/drive?`), true)
  assert.equal(calls[2].startsWith(`${MAPBOX_BASE_URL}/directions/v5/`), true)
  for (const url of calls) {
    const root = new URL(url)
    assert.equal(root.username, '', 'the vendor root carries no userinfo')
    assert.equal(root.password, '', 'the vendor root carries no userinfo')
  }
})

test('an omitted baseUrl stays out of the composition dump', () => {
  const dumped = JSON.stringify(Config(baseConfig({ amap: {}, tianditu: {}, mapbox: {} })))
  assert.equal(dumped.includes('baseUrl'), false, 'an omitted root must not materialize a default that would change the dump')
  assert.equal(dumped.includes(AMAP_BASE_URL), false)
  assert.equal(dumped.includes(TIANDITU_BASE_URL), false)
  assert.equal(dumped.includes(MAPBOX_BASE_URL), false)
})

test('an empty key value refuses construction even if selection was bypassed', () => {
  assert.throws(
    () => createAmapNetworkProvider({ apiKey: '', apiKeyEnv: DEFAULT_AMAP_API_KEY_ENV, bbox: [116.3, 39.9, 116.36, 39.94] }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT' && error.message.includes(DEFAULT_AMAP_API_KEY_ENV),
  )
})
