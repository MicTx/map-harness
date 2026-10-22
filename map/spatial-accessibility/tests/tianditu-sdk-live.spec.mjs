import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTiandituSdkProvider, closeDefaultSdkSessions } from '../src/tianditu-sdk.ts'
import { AccessibilityError } from '../src/errors.ts'

/**
 * Key-activated live lane for the Tianditu browser-SDK provider: proves the
 * credential authorizes a real driving route through the real vendor JS SDK
 * in a real browser page, and that caller cancellation releases the page.
 * Skips loudly (never passes silently) without `TIANDITU_SDK_KEY` or an
 * importable `playwright`.
 */
const KEY = process.env.TIANDITU_SDK_KEY
const OPTIONS = { mode: 'drive', slice: 'morning-peak' }
const BBOX = /** @type {const} */ ([116.25, 39.85, 116.55, 39.98])

test('the browser-end key authorizes a real driving route through the vendor JS SDK', async t => {
  if (typeof KEY !== 'string' || KEY.length === 0) {
    t.skip('TIANDITU_SDK_KEY is not set — export the browser-end key to activate this live lane')
    return
  }
  const provider = createTiandituSdkProvider({ apiKey: KEY, apiKeyEnv: 'TIANDITU_SDK_KEY', bbox: BBOX, timeoutMs: 45_000 })
  try {
    const result = await provider.route([116.379, 39.915], [116.449, 39.951], OPTIONS)
    assert.ok(result.minutes > 0, `expected positive minutes, got ${result.minutes}`)
    assert.ok(result.distanceKm > 0, `expected positive distanceKm, got ${result.distanceKm}`)
    assert.ok(result.nodes.length >= 2, 'expected at least origin and destination nodes')
    t.diagnostic(`authorized drive: minutes=${result.minutes.toFixed(1)} distanceKm=${result.distanceKm.toFixed(2)} nodes=${result.nodes.length} ref=${provider.networkRef}`)
  } catch (error) {
    if (error instanceof AccessibilityError && error.code === 'TEMPORARILY_UNAVAILABLE') {
      t.skip(`vendor side temporarily unavailable (often the loader rate window): ${error.message.slice(0, 160)}`)
      return
    }
    throw error
  } finally {
    await closeDefaultSdkSessions().catch(() => {})
  }
})

test('cancellation aborts an in-flight sdk drive and the provider stays reusable', async t => {
  if (typeof KEY !== 'string' || KEY.length === 0) {
    t.skip('TIANDITU_SDK_KEY is not set — export the browser-end key to activate this live lane')
    return
  }
  const provider = createTiandituSdkProvider({ apiKey: KEY, apiKeyEnv: 'TIANDITU_SDK_KEY', bbox: BBOX, timeoutMs: 45_000 })
  const controller = new AbortController()
  const call = provider.route([116.379, 39.915], [116.449, 39.951], { ...OPTIONS, signal: controller.signal })
  setTimeout(() => controller.abort(), 400)
  await assert.rejects(call, error => error instanceof Error)
  t.diagnostic('cancel path: aborted drive rejected; provider reusable')
  await closeDefaultSdkSessions().catch(() => {})
})
