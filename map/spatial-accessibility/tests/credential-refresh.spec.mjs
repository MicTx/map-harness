/** Runtime credential resolution: keys stored after activation reach the next run submission. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '../../../packages/session/session-projection/lib/index.js'
import * as accessibilityPlugin from '../src/plugin.ts'
import { TIANDITU_NETWORK_ID, TIANDITU_SDK_NETWORK_ID, ACCESSIBILITY_METHOD_VERSION } from '../src/index.ts'

const EXTENT = { bbox: [116.3, 39.9, 116.31, 39.91] }

function spec(networkRef) {
  return {
    goalRevision: 1,
    studyArea: EXTENT,
    retrievalExtent: EXTENT,
    analysisSupportExtent: EXTENT,
    observationWindow: { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' },
    impedance: { travelMode: 'drive', maxMinutes: 10 },
    timeSlices: ['midday'],
    populationRef: 'res-population@v1',
    populationField: 'population',
    facilityRefs: ['res-facility@v1'],
    networkRef,
    methodVersion: ACCESSIBILITY_METHOD_VERSION,
  }
}

async function mount(t, provider) {
  const dir = mkdtempSync(join(tmpdir(), 'map-accessibility-credential-'))
  const stored = new Map()
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  const disposeCredentials = ctx.reflect.provide('credentials', {
    resolve: async (ref) => {
      const value = stored.get(ref)
      return value === undefined ? undefined : { value }
    },
  })
  t.after(async () => {
    disposeCredentials()
    await ctx.fiber.dispose()
    rmSync(dir, { recursive: true, force: true })
  })
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => '<result><distance>1</distance><duration>60</duration><routelatlon>116.3,39.9;116.31,39.91</routelatlon></result>',
  })
  const sdkBridge = {
    open: async () => ({
      evaluate: async () => ({ ok: true, seconds: 60, kilometres: 1, polyline: [[116.3, 39.9], [116.31, 39.91]] }),
      close: async () => {},
    }),
    close: async () => {},
  }
  await ctx.plugin(accessibilityPlugin, {
    root: join(dir, 'runs'),
    provider,
    tianditu: { spacingDeg: 0.02 },
    fetchImpl,
    sdkBridge,
  })
  return { service: ctx.get('spatialAccessibility'), stored }
}

for (const [provider, ref] of [
  [TIANDITU_NETWORK_ID, 'TIANDITU_API_KEY'],
  [TIANDITU_SDK_NETWORK_ID, 'TIANDITU_SDK_KEY'],
]) {
  test(`${provider} resolves a key stored after activation on the next submit`, async t => {
    let calls = 0
    const { service, stored } = await mount(t, provider)
    const submit = () => service.submit({
      operationRef: `op-${++calls}`,
      spec: spec(''),
      data: { population: [], facilities: [] },
    })

    await assert.rejects(submit(), /resolved to no key/)
    stored.set(ref, provider === TIANDITU_SDK_NETWORK_ID ? 'sdk-key' : 'rest-key')
    const first = await submit()
    assert.equal(first.status, 'queued')
    assert.equal(service.get(first.runId).spec.networkRef.includes('rest-key'), false)
    assert.equal(service.get(first.runId).spec.networkRef.includes('sdk-key'), false)

    stored.set(ref, 'rotated-key')
    const second = await submit()
    assert.equal(second.status, 'queued')
    await service.quiesce()
    stored.delete(ref)
    await assert.rejects(submit(), /resolved to no key/)
  })
}
