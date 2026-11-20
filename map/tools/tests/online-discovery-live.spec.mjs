/** Opt-in Tianditu retrieval against the configured deployment credential. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpatialSearch, resolveSearchConfig } from '../../spatial-connect/src/search.ts'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as catalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { catalogRegister } from '../src/catalog-tools.ts'

const enabled = process.env.MAP_SPATIAL_SEARCH_LIVE === 'tianditu'

test('live Tianditu geocoding, POIs and reverse lookup publish immutable resource versions', { skip: !enabled, timeout: 60000 }, async t => {
  const service = createSpatialSearch(resolveSearchConfig({ apiKeyEnv: 'TIANDITU_API_KEY', timeoutMs: 15000 }, process.env))
  const root = mkdtempSync(join(tmpdir(), 'map-search-live-'))
  let rig
  t.after(async () => { await service.close(); await rig?.dispose(); rmSync(root, { recursive: true, force: true }) })
  rig = await mapRig({ cwd: root })
  await rig.ctx.plugin(catalogPlugin, { root: join(root, 'catalog') })
  rig.ctx.effect(() => rig.ctx.reflect.provide('spatialSearch', service))
  const session = rig.session('live-search')
  for (const [index, online] of [
    { kind: 'geocode', query: '北京市天安门' },
    { kind: 'search', query: '医院', bbox: [116.35, 39.85, 116.45, 39.95], limit: 2 },
    { kind: 'reverse', point: [116.397, 39.908] },
  ].entries()) {
    const callId = `live-${index}`
    const call = rig.call(session, callId, 'catalog_register', { online })
    const result = await catalogRegister.execute({ online }, rig.exec(session, { callId }))
    rig.result(session, call, { meta: result.meta })
    assert.equal(result.source.provider, 'tianditu')
    assert.equal(result.source.result_status, 'found')
    assert.ok(result.resource.featureCount > 0)
    assert.equal(result.resource.nativeCrs, 'EPSG:4490')
    t.diagnostic(`${online.kind}: found=${result.resource.featureCount}, resource=${result.resource.ref}, CRS=${result.resource.nativeCrs}`)
  }
})

test('live Tianditu administrative boundary retrieval', { skip: process.env.MAP_SPATIAL_DISTRICT_LIVE !== '1', timeout: 30000 }, async t => {
  const service = createSpatialSearch(resolveSearchConfig({ apiKeyEnv: 'TIANDITU_API_KEY', timeoutMs: 15000 }, process.env))
  t.after(() => service.close())
  const result = await service.search({ kind: 'district', query: '北京市东城区', boundary: true })
  assert.ok(result.data.features.length > 0)
  assert.ok(result.data.features.every(feature => feature.geometry.type === 'Polygon'))
  t.diagnostic(`district: boundaries=${result.data.features.length}, CRS=${result.nativeCrs}`)
})
