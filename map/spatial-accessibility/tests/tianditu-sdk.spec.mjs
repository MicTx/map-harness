import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TIANDITU_SDK_CAPABILITY_DECLARATION,
  TIANDITU_SDK_NETWORK_ID,
  TIANDITU_SDK_PAGE_HTML,
  createSdkPageServer,
  createTiandituSdkProvider,
  tiandituSdkNetworkRefFor,
} from '../src/tianditu-sdk.ts'
import { AccessibilityError } from '../src/errors.ts'

const KEY = 'unit-test-not-a-real-credential'
const BBOX = /** @type {const} */ ([116.25, 39.85, 116.55, 39.98])

/** One scripted bridge: pages draw from one shared outcome queue (a queue head may be a never-settling promise). */
function scriptedBridge(script) {
  const state = { pages: [], opened: 0, closedPages: 0, closed: false }
  const queue = [...script]
  const bridge = {
    state,
    async open() {
      state.opened += 1
      const page = {
        closed: false,
        async evaluate() {
          if (queue.length === 0) return new Promise(() => {})
          return queue.shift()
        },
        async close() {
          page.closed = true
          state.closedPages += 1
        },
      }
      state.pages.push(page)
      return page
    },
    async close() {
      state.closed = true
    },
  }
  return bridge
}

function providerWith(bridge, overrides = {}) {
  return createTiandituSdkProvider({ apiKey: KEY, apiKeyEnv: 'TIANDITU_SDK_TEST_KEY', bbox: BBOX, bridge, ...overrides })
}

async function assertCode(promise, code) {
  try {
    await promise
  } catch (error) {
    assert.ok(error instanceof AccessibilityError, `expected AccessibilityError, got ${error}`)
    assert.equal(error.code, code)
    assert.ok(!error.message.includes(KEY), 'failure text must not carry the key value')
    return error
  }
  throw new Error(`expected ${code}, call resolved`)
}

const OPTIONS = { mode: 'drive', slice: 'morning-peak' }

test('construction validates key and extent loudly', () => {
  assert.throws(() => createTiandituSdkProvider({ apiKey: '', apiKeyEnv: 'TIANDITU_SDK_TEST_KEY', bbox: BBOX }), /TIANDITU_SDK_TEST_KEY/)
  assert.throws(() => createTiandituSdkProvider({ apiKey: KEY, apiKeyEnv: 'X', bbox: [Number.NaN, 39, 116, 40] }), AccessibilityError)
})

test('an authorized plan prices minutes, kilometres, and polyline nodes', async () => {
  const bridge = scriptedBridge([{ ok: true, seconds: 843, kilometres: 10.55, polyline: [[116.379, 39.915], [116.401, 39.931], [116.449, 39.951]] }])
  const provider = providerWith(bridge)
  const result = await provider.route([116.379, 39.915], [116.449, 39.951], OPTIONS)
  assert.equal(result.minutes, 843 / 60)
  assert.equal(result.distanceKm, 10.55)
  assert.deepEqual(result.nodes, ['tianditu-sdk-116379000-39915000', 'tianditu-sdk-116401000-39931000', 'tianditu-sdk-116449000-39951000'])
  assert.equal(provider.networkId, TIANDITU_SDK_NETWORK_ID)
  assert.match(provider.networkRef, /^tianditu-sdk-road-network-[0-9a-f]{16}@1$/)
  assert.ok(!provider.networkRef.includes(KEY))
  assert.equal(tiandituSdkNetworkRefFor({ bbox: BBOX }), provider.networkRef)
})

test('a plan without an extractable polyline still prices with endpoint nodes', async () => {
  const bridge = scriptedBridge([{ ok: true, seconds: 600, kilometres: 9, polyline: [] }])
  const provider = providerWith(bridge)
  const result = await provider.route([116.379, 39.915], [116.449, 39.951], OPTIONS)
  assert.deepEqual(result.nodes, ['tianditu-sdk-116379000-39915000', 'tianditu-sdk-116449000-39951000'])
})

test('the stub loader build maps to retryable TEMPORARILY_UNAVAILABLE with a retry hint', async () => {
  const bridge = scriptedBridge([{ ok: false, kind: 'stub', detail: 'vendor loader served a build without service classes' }])
  const error = await assertCode(providerWith(bridge).route([116.379, 39.915], [116.449, 39.951], OPTIONS), 'TEMPORARILY_UNAVAILABLE')
  assert.match(error.message, /service classes/)
  assert.match(error.message, /retry/i)
})

test('a credential refusal and a bare no-plans outcome classify separately', async () => {
  const denied = scriptedBridge([{ ok: false, kind: 'no-plans', detail: 'invalid tk / 非法密钥' }])
  await assertCode(providerWith(denied).route([116.379, 39.915], [116.449, 39.951], OPTIONS), 'PERMISSION_DENIED')
  const bare = scriptedBridge([{ ok: false, kind: 'no-plans', detail: 'no drivable plan between the points' }])
  await assertCode(providerWith(bare).route([116.379, 39.915], [116.449, 39.951], OPTIONS), 'ACCESS_NOT_FOUND')
})

test('timeout, load-error, parse, and non-contract outcomes stay loud and temporary', async () => {
  for (const outcome of [
    { ok: false, kind: 'timeout', detail: 'did not settle' },
    { ok: false, kind: 'load-error', detail: 'script load failed' },
    { ok: false, kind: 'parse', detail: 'no duration field' },
    { ok: true, seconds: Number.NaN, kilometres: 1 },
    'not-an-object',
  ]) {
    const bridge = scriptedBridge([outcome])
    await assertCode(providerWith(bridge).route([116.379, 39.915], [116.449, 39.951], OPTIONS), 'TEMPORARILY_UNAVAILABLE')
  }
})

test('a wall-budget timeout closes the page and the next call reopens one', async () => {
  const hanging = scriptedBridge([new Promise(() => {}), { ok: true, seconds: 60, kilometres: 1, polyline: [] }])
  const hangingProvider = providerWith(hanging, { timeoutMs: 400 })
  // the head of the script queue never settles: the first drive hits the wall budget
  await assertCode(hangingProvider.route([116.379, 39.915], [116.449, 39.951], OPTIONS), 'TEMPORARILY_UNAVAILABLE')
  assert.equal(hanging.state.closedPages, 1, 'the dead page must be closed')
  const recovered = await hangingProvider.route([116.379, 39.915], [116.449, 39.951], OPTIONS)
  assert.equal(recovered.minutes, 1)
  assert.equal(hanging.state.opened, 2, 'the bridge reopens a page after the drop')
})

test('caller cancellation aborts, closes the page, and the provider stays reusable', async () => {
  const bridge = scriptedBridge([])
  const provider = providerWith(bridge)
  const controller = new AbortController()
  const call = provider.route([116.379, 39.915], [116.449, 39.951], { ...OPTIONS, signal: controller.signal })
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(call, error => error instanceof Error)
  assert.equal(bridge.state.closedPages, 1)
  // already-aborted signals refuse before opening anything
  const refused = provider.route([116.379, 39.915], [116.449, 39.951], { ...OPTIONS, signal: AbortSignal.abort() })
  await assert.rejects(refused, error => error instanceof Error)
})

test('shrunk faces fail METHOD_NOT_APPLICABLE and unsupported modes are refused', async () => {
  const provider = providerWith(scriptedBridge([]))
  assert.equal(provider.pricesMode('drive'), true)
  assert.equal(provider.pricesMode('walk'), false)
  await assert.rejects(provider.serviceArea([116.4, 39.9], 10, { mode: 'drive', slice: 'morning-peak' }), error => error instanceof AccessibilityError && error.code === 'METHOD_NOT_APPLICABLE')
  await assert.rejects(provider.readPois(BBOX, { page: 0, pageSize: 10 }), error => error instanceof AccessibilityError && error.code === 'METHOD_NOT_APPLICABLE')
  await assert.rejects(provider.route([116.379, 39.915], [116.449, 39.951], { ...OPTIONS, mode: 'walk' }), error => error instanceof AccessibilityError && error.code === 'METHOD_NOT_APPLICABLE')
  await assert.rejects(provider.route([116.379, 39.915], [116.449, 39.951], { ...OPTIONS, barriers: [{ from: [116.38, 39.91], to: [116.39, 39.92], kind: 'blocked' }] }), error => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT')
})

test('the page server serves the key in the body only, over loopback, and releases its port', async () => {
  const server = await createSdkPageServer(KEY)
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
  assert.ok(!server.url.includes(KEY), 'the URL must not carry the key')
  const response = await fetch(server.url)
  const body = await response.text()
  assert.equal(response.status, 200)
  assert.ok(body.includes('api.tianditu.gov.cn/api?v=4.0&tk='), 'the page loads the vendor JS API')
  assert.ok(body.includes(KEY), 'the key reaches the page body (loopback-only)')
  assert.ok(TIANDITU_SDK_PAGE_HTML.includes('__TIANDITU_SDK_KEY__'), 'the template keeps the injection marker')
  await server.close()
  await assert.rejects(fetch(server.url))
})

test('the capability declaration names the SDK lane and its shrunk faces', () => {
  assert.equal(TIANDITU_SDK_CAPABILITY_DECLARATION.networkId, TIANDITU_SDK_NETWORK_ID)
  const faces = TIANDITU_SDK_CAPABILITY_DECLARATION.shrunk.map(face => face.face)
  for (const expected of ['route walk', 'serviceArea', 'readPois', 'barriers', 'time-slice pricing', 'network version', 'coordinate datum']) {
    assert.ok(faces.includes(expected), `missing shrunk face ${expected}`)
  }
})
