import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import { mapAddLayer } from '../src/map-tools.ts'
import { layerSetStyle } from '../src/layer-tools.ts'
import { vizClassify } from '../src/viz-tools.ts'
import * as catalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { HOST_SUBJECT } from '../../spatial-catalog/src/index.ts'
import { catalogRegister } from '../src/catalog-tools.ts'
import { vizRecommend } from '../src/viz-recommend.ts'
import { createArcgisMcpRuntime } from '../../arcgis-mcp/src/runtime.ts'

async function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'viz-recommend-'))
  const rig = await mapRig({ cwd: dir })
  t.after(async () => { await rig.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const session = rig.session('recommend')
  const collection = { type: 'FeatureCollection', features: Array.from({ length: 8 }, (_, i) => ({
    type: 'Feature', id: String(i), geometry: { type: 'Point', coordinates: [i * 0.01, 0] },
    properties: { value: i + 1, population: i === 0 ? 0 : 10, time: `2026-01-0${i + 1}T00:00:00Z`, entity: `e-${i % 2}` },
  })) }
  writeFileSync(join(dir, 'points.geojson'), JSON.stringify(collection))
  const call = rig.call(session, 'add', 'map_add_layer', { path: 'points.geojson', layer_id: 'points' })
  const added = await mapAddLayer.execute({ path: 'points.geojson', layer_id: 'points' }, rig.exec(session, { callId: 'add' }))
  rig.result(session, call, { meta: added.meta })
  return { rig, session, dir }
}

test('recommendation uses accepted layer data, is replayable and never mutates the map', async t => {
  const { rig, session } = await setup(t)
  // Turn accounting lives in the same projection state as map content; a tool
  // call legitimately opens a turn. "Never mutates the map" covers content.
  const mapState = () => {
    const { interaction, ...rest } = rig.state(session)
    return JSON.stringify(rest)
  }
  const before = mapState()
  const args = { scenario: 'density', layer_id: 'points' }
  const call = rig.call(session, 'recommend', 'viz_recommend', args)
  const result = await vizRecommend.execute(args, rig.exec(session, { callId: 'recommend' }))
  assert.equal(result.status, 'recommended')
  assert.equal(result.primary.id, 'heatmap')
  assert.equal(result.data_profile.featureCount, 8)
  assert.equal(result.analysisExecuted, false)
  assert.deepEqual(result.nextTools, ['layer_set_style'])
  const text = vizRecommend.output.render(args, result).map(block => block.text).join('\n')
  rig.result(session, call, { text })
  const logged = session.snapshotEvents().findLast(event => event.type === 'tool/result')
  assert.deepEqual(JSON.parse(logged.data.message.content[0].text), result)
  assert.equal(mapState(), before)
  const observed = { status: result.status, type: result.primary.id, nextTools: result.nextTools, analysisExecuted: result.analysisExecuted,
    data_profile: result.data_profile, rendered: text }
  const expected = new URL('./expected/viz-recommend.json', import.meta.url)
  if (process.env.MAP_VIZ_RECORD_EXPECTED === '1') writeFileSync(expected, JSON.stringify(observed, null, 2) + '\n')
  assert.deepEqual(observed, JSON.parse(readFileSync(expected, 'utf8')))
})

test('MCP and direct recommendation agree and invalid input cannot reach another session', async t => {
  const { rig, session } = await setup(t)
  const runtime = await createArcgisMcpRuntime()
  t.after(() => runtime.dispose())
  const args = { scenario: 'magnitude', layer_id: 'points', field: 'value', unit: 'people' }
  const direct = await vizRecommend.execute(args, rig.exec(session))
  const mcp = await runtime.service.callTool('viz_recommend', args, rig.exec(session))
  assert.equal(mcp.isError, undefined)
  assert.deepEqual(mcp.structuredContent, direct)
  assert.equal(direct.primary.id, 'graduated-symbol')
  const other = rig.session('other')
  const missing = await vizRecommend.execute(args, rig.exec(other))
  assert.equal(missing.status, 'needs-data')
  for (const input of [{ ...args, scenario: 'invented' }, { ...args, type: 'rainbow' }, { ...args, sessionId: 'other' },
    { ...args, field: 'x'.repeat(129) }, { ...args, time_binding: { timeField: 'time', timezone: 'UTC' } }]) {
    await assert.rejects(vizRecommend.execute(input, rig.exec(session)), /invalid|INVALID|unknown|unrecognized/i)
  }
})

test('native and MCP discovery expose nested time fields and reject flat or open objects', async t => {
  const { rig, session } = await setup(t)
  const runtime = await createArcgisMcpRuntime()
  t.after(() => runtime.dispose())
  const native = vizRecommend.parameters.properties.time_binding
  const mcp = runtime.service.catalog().find(tool => tool.name === 'viz_recommend').inputSchema.properties.time_binding
  for (const schema of [native, mcp]) {
    assert.equal(schema.type, 'object')
    assert.equal(schema.additionalProperties, false)
    assert.deepEqual([...schema.required].sort(), ['granularity', 'timeField', 'timezone', 'window'])
    assert.deepEqual(schema.properties.granularity.enum, ['hour', 'day', 'week', 'month'])
    assert.equal(schema.properties.window.type, 'object')
    assert.equal(schema.properties.window.additionalProperties, false)
    assert.deepEqual([...schema.properties.window.required].sort(), ['from', 'to'])
  }
  const time_binding = { timeField: 'time', timezone: 'UTC', granularity: 'day',
    window: { from: '2026-01-01T00:00:00Z', to: '2026-01-09T00:00:00Z' } }
  const args = { scenario: 'flow', layer_id: 'points', entity_field: 'entity', field: 'value', unit: 'people', time_binding }
  const direct = await vizRecommend.execute(args, rig.exec(session))
  const result = await runtime.service.callTool('viz_recommend', args, rig.exec(session))
  assert.deepEqual(result.structuredContent, direct)
  assert.deepEqual(direct.gaps, ['versioned-resource-ref'])
  assert.match(direct.data_profile.distinctCountSemantics, /2 means at least 2/)
  for (const binding of [
    { timeField: 'time', timezone: 'UTC', granularity: 'day', ...time_binding.window },
    { ...time_binding, window: time_binding.window.from },
    { ...time_binding, window: { ...time_binding.window, extra: true } },
  ]) {
    await assert.rejects(vizRecommend.execute({ ...args, time_binding: binding }, rig.exec(session)), { code: 'INVALID_ARGS' })
    const rejected = await runtime.service.callTool('viz_recommend', { ...args, time_binding: binding }, rig.exec(session))
    assert.equal(rejected.isError, true)
  }
})

test('catalog discovery is bounded, explicit unsupported methods stay unsupported', async t => {
  const { rig, session } = await setup(t)
  const unsupported = await vizRecommend.execute({ scenario: 'aggregation', type: 'hexbin', layer_id: 'points' }, rig.exec(session))
  assert.equal(unsupported.status, 'unsupported')
  assert.deepEqual(unsupported.nextTools, [])
  const discovery = await vizRecommend.execute({ scenario: 'density' }, rig.exec(session))
  assert.equal(discovery.status, 'needs-data')
  assert.ok(discovery.gaps.includes('loaded-data'))
  assert.ok(Buffer.byteLength(JSON.stringify(discovery)) < 16384)
})

test('revoked and recalled display copies refuse before field profiling on either comparison side', async t => {
  const { rig, session, dir } = await setup(t)
  await rig.ctx.plugin(catalogPlugin, { root: join(dir, 'catalog') })
  const catalog = rig.ctx.get('spatialCatalog').forSession(session.id)
  async function registerLayer(name) {
    rig.call(session, `reg-${name}`, 'catalog_register', { path: 'points.geojson', name })
    const registered = await catalogRegister.execute({ path: 'points.geojson', name }, rig.exec(session, { callId: `reg-${name}` }))
    const args = { ref: registered.resource.ref, layer_id: name }
    const call = rig.call(session, `add-${name}`, 'map_add_layer', args)
    const added = await mapAddLayer.execute(args, rig.exec(session, { callId: `add-${name}` }))
    rig.result(session, call, { meta: added.meta })
    return registered.resource.ref
  }
  const ref = await registerLayer('governed')
  const args = { scenario: 'magnitude', layer_id: 'governed', field: 'value', unit: 'people' }
  assert.equal((await vizRecommend.execute(args, rig.exec(session))).status, 'recommended')
  await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref, state: 'revoked' })
  await assert.rejects(vizRecommend.execute(args, rig.exec(session)), /GOVERNANCE_REVOKED/)
  await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref, state: 'granted' })
  await rig.ctx.get('spatialCatalog').recallCopies({ subject: HOST_SUBJECT, scope: { kind: 'object', objectKind: 'resource', ref }, origin: 'test' })
  await assert.rejects(vizRecommend.execute(args, rig.exec(session)), /GOVERNANCE_RECALLED/)
  await registerLayer('safe')
  await assert.rejects(vizRecommend.execute({ ...args, scenario: 'compare', layer_id: 'safe', comparison_layer_id: 'governed' }, rig.exec(session)), /GOVERNANCE_RECALLED/)
})

test('recommended heatmap and graduated-size methods reach the existing map mutation entries', async t => {
  for (const scenario of ['density', 'magnitude']) {
    await t.test(scenario, async sub => {
      const { rig, session } = await setup(sub)
      const recommendation = await vizRecommend.execute({ scenario, layer_id: 'points', field: 'value', unit: 'people' }, rig.exec(session))
      assert.equal(recommendation.status, 'recommended')
      const tool = scenario === 'density' ? layerSetStyle : vizClassify
      assert.ok(recommendation.nextTools.includes(tool.name))
      const args = scenario === 'density'
        ? { layer_id: 'points', symbol: { methodVersion: 'map-layers@1', presentation: 'heatmap', heatmap: { field: 'value', radiusPx: 24, ramp: 'viridis' } } }
        : { layer_id: 'points', field: 'value', unit: 'people', measure: 'total', encoding: 'size', class_count: 3 }
      const call = rig.call(session, `apply-${scenario}`, tool.name, args)
      const result = await tool.execute(args, rig.exec(session, { callId: `apply-${scenario}` }))
      rig.result(session, call, { meta: result.meta })
      const layer = rig.state(session).layers.find(layer => layer.id === 'points')
      assert.equal(rig.state(session).revision, 2)
      if (scenario === 'density') assert.equal(layer.symbol.presentation, 'heatmap')
      else assert.equal(layer.style.encoding, 'size')
    })
  }
})

test('time windows use actual observations and invalid weights are not silently coerced', async t => {
  const { rig, session } = await setup(t)
  const time_binding = { timeField: 'time', timezone: 'UTC', granularity: 'day', window: { from: '2027-01-01T00:00:00Z', to: '2027-01-09T00:00:00Z' } }
  const emptyWindow = await vizRecommend.execute({ scenario: 'change', layer_id: 'points', field: 'value', unit: 'people', time_binding }, rig.exec(session))
  assert.ok(emptyWindow.gaps.includes('observations-inside-time-window'))
  const invalidWeight = await vizRecommend.execute({ scenario: 'density', layer_id: 'points', field: 'absent' }, rig.exec(session))
  assert.equal(invalidWeight.status, 'needs-data')
  const conflict = await vizRecommend.execute({ scenario: 'hotspot', layer_id: 'points', type: 'heatmap' }, rig.exec(session))
  assert.ok(conflict.gaps.includes('method-does-not-answer-scenario'))
})
