import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as catalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { catalogRegister, catalogResolve } from '../src/catalog-tools.ts'
import { HOST_SUBJECT } from '../../spatial-catalog/src/governance.ts'
import { createArcgisMcpRuntime } from '../../arcgis-mcp/src/runtime.ts'

async function discoveryRig(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-discovery-'))
  let rig
  t.after(async () => {
    try { await rig?.dispose() } finally { rmSync(root, { recursive: true, force: true }) }
  })
  rig = await mapRig({ cwd: root })
  await rig.ctx.plugin(catalogPlugin, { root: join(root, 'catalog') })
  const session = rig.session('discover')
  let serial = 0
  return {
    rig, session,
    async register(name, properties, coordinates = [116.4, 39.9], crs = 'EPSG:4326') {
      const id = `register-${++serial}`
      const path = `${id}.geojson`
      writeFileSync(join(root, path), JSON.stringify({ type: 'FeatureCollection', features: [{
        type: 'Feature', geometry: { type: 'Point', coordinates }, properties,
      }] }))
      const args = { path, name, crs }
      const call = rig.call(session, id, 'catalog_register', args)
      const result = await catalogRegister.execute(args, rig.exec(session, { callId: id }))
      rig.result(session, call, { meta: result.meta })
      return result.resource.ref
    },
    async search(search, target = session) {
      const id = `search-${++serial}`
      const call = rig.call(target, id, 'catalog_resolve', { search })
      const result = await catalogResolve.execute({ search }, rig.exec(target, { callId: id }))
      const content = catalogResolve.output.render({ search }, result).filter(block => block.type === 'text').map(block => block.text).join('\n')
      rig.result(target, call, { meta: result.meta, text: content })
      return result
    },
  }
}

test('resource discovery lists current authorized versions without a known ref and resolves the selected result', async t => {
  const f = await discoveryRig(t)
  const old = await f.register('社区人口', { population: 10, year: 2024 })
  const current = await f.register('社区人口', { population: 20, year: 2025 })
  const other = await f.register('医院', { beds: 100 })
  const found = await f.search({})
  assert.deepEqual(found.resources.map(value => value.ref).sort(), [current, other].sort())
  assert.ok(!found.resources.some(value => value.ref === old))
  assert.equal(found.has_more, false)
  assert.equal(found.next_offset, null)
  assert.equal(found.meta.operation, 'resolve')
  assert.equal(found.meta.resources.length, 2)
  const names = await f.search({ name: '社区人口' })
  assert.equal(names.resources[0].ref, current)
  assert.deepEqual(names.resources[0].fields, [{ name: 'population', type: 'number' }, { name: 'year', type: 'number' }])
  assert.deepEqual(names.resources[0].extent, [116.4, 39.9, 116.4, 39.9])
  assert.equal(names.resources[0].extent_crs, 'EPSG:4326')
  const event = f.session.snapshotEvents().findLast(event => event.type === 'tool/result')
  const observed = JSON.parse(event.data.message.content[0].text)
  for (const resource of observed.resources) {
    assert.ok(Number.isFinite(Date.parse(resource.registered_at)))
    resource.registered_at = '<registration-time>'
  }
  const expectedPath = new URL('./expected/data-discovery.json', import.meta.url)
  if (process.env.MAP_DISCOVERY_RECORD_EXPECTED === '1') {
    mkdirSync(new URL('./expected/', import.meta.url), { recursive: true })
    writeFileSync(expectedPath, JSON.stringify(observed, null, 2) + '\n')
  }
  assert.deepEqual(observed, JSON.parse(readFileSync(expectedPath, 'utf8')))
  const versions = await f.search({ name: '社区人口', include_versions: true })
  assert.deepEqual(versions.resources.map(value => value.ref), [current, old])
  f.rig.call(f.session, 'resolve-selected', 'catalog_resolve', { resource: current })
  const resolved = await catalogResolve.execute({ resource: current }, f.rig.exec(f.session, { callId: 'resolve-selected' }))
  assert.equal(resolved.resource.ref, current)
  assert.equal(resolved.total_feature_refs, 1)
  const rendered = catalogResolve.output.render({}, found)[0].text
  assert.ok(!rendered.includes('storageRef'))
  assert.ok(!rendered.includes('catalog-result'))
})

test('metadata filters and pagination are explicit, bounded and do not treat projected coordinates as geographic', async t => {
  const f = await discoveryRig(t)
  const a = await f.register('a', { population: 10 })
  await f.register('b', { beds: 30 }, [120, 30])
  await f.register('projected', { population: 40 }, [500000, 4400000], 'EPSG:4547')
  const filtered = await f.search({ fields: ['population'], bbox: [116, 39, 117, 40], crs: 'EPSG:4326' })
  assert.deepEqual(filtered.resources.map(value => value.ref), [a])
  assert.equal((await f.search({ query: 'POPULATION' })).resources.length, 2)
  assert.equal((await f.search({ geometry_type: 'Polygon' })).resources.length, 0)
  assert.equal((await f.search({ query: "' OR 1=1 --" })).resources.length, 0)
  const first = await f.search(JSON.stringify({ limit: 2 }))
  assert.equal(first.resources.length, 2)
  assert.equal(first.has_more, true)
  assert.equal(first.next_offset, 2)
  const second = await f.search({ limit: 2, offset: first.next_offset })
  assert.equal(second.resources.length, 1)
  assert.equal(second.next_offset, null)
  assert.equal(new Set([...first.resources, ...second.resources].map(value => value.ref)).size, 3)
  assert.equal((await f.search({ time: { from: '2025-01-01T00:00:00Z' } })).resources.length, 0, 'unknown data validity cannot satisfy a time filter')
})

test('discovery excludes revoked, recalled, foreign-domain and foreign-session metadata before pagination', async t => {
  const f = await discoveryRig(t)
  const revoked = await f.register('revoked', { private_field: 1 })
  const visible = await f.register('visible', { public_field: 2 })
  const catalog = f.rig.ctx.spatialCatalog.forSession(f.session.id)
  await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref: revoked, state: 'revoked' })
  assert.deepEqual((await f.search({ limit: 1 })).resources.map(value => value.ref), [visible])
  assert.equal((await f.search({ query: 'private_field' })).resources.length, 0)
  assert.equal((await f.search({}, f.rig.session('other'))).resources.length, 0)
  assert.equal((await catalog.searchResources({ authorization: 'other', search: {} })).resources.length, 0)
  await f.rig.ctx.spatialCatalog.recallCopies({ subject: HOST_SUBJECT, scope: { kind: 'object', objectKind: 'resource', ref: visible }, origin: 'test' })
  assert.equal((await f.search({})).resources.length, 0)
})

test('resource discovery reaches the model through real MCP with the same schema and frozen candidate identities', async t => {
  const f = await discoveryRig(t)
  const ref = await f.register('population', { population: 8 })
  const runtime = await createArcgisMcpRuntime()
  t.after(() => runtime.dispose())
  const descriptor = runtime.service.catalog().find(tool => tool.name === 'catalog_resolve')
  assert.ok(descriptor.inputSchema.properties.search)
  const call = f.rig.call(f.session, 'mcp-discover', 'catalog_resolve', { search: { fields: ['population'] } })
  const result = await runtime.service.callTool('catalog_resolve', { search: { fields: ['population'] } }, f.rig.exec(f.session, { callId: 'mcp-discover' }))
  assert.equal(result.isError, undefined)
  assert.equal(result.structuredContent.resources[0].ref, ref)
  assert.equal(result.structuredContent.meta.resources[0].ref, ref)
  f.rig.result(f.session, call, { meta: result.structuredContent.meta })
  const rendered = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.ok(rendered.includes(ref))
  assert.ok(!rendered.includes('storageRef'))
})

test('a revoked latest version never makes discovery silently fall back to an older version', async t => {
  const f = await discoveryRig(t)
  const old = await f.register('history', { x: 1 })
  const current = await f.register('history', { x: 2 })
  const catalog = f.rig.ctx.spatialCatalog.forSession(f.session.id)
  await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref: current, state: 'tombstoned' })
  assert.equal((await f.search({ name: 'history' })).resources.length, 0)
  assert.deepEqual((await f.search({ name: 'history', include_versions: true })).resources.map(value => value.ref), [old])
})

test('time discovery uses data validity with inclusive overlap, not registration time', async t => {
  const f = await discoveryRig(t)
  const catalog = f.rig.ctx.spatialCatalog.forSession(f.session.id)
  const registered = await catalog.register({
    name: 'dated', sourceLabel: 'dated.geojson', sessionId: f.session.id, sourceCallSeq: 500,
    nativeCrs: 'EPSG:4326', authorization: 'local', enforceWgs84Range: true,
    validTime: { from: '2024-01-01T00:00:00Z', to: '2024-12-31T23:59:59Z' },
    bytes: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [] })),
  })
  assert.deepEqual((await f.search({ time: { from: '2024-06-01T08:00:00+08:00', to: '2025-01-01T00:00:00Z' } })).resources.map(value => value.ref), [registered.resource.ref])
  assert.equal((await f.search({ time: { from: '2025-01-01T00:00:00Z' } })).resources.length, 0)
  assert.equal((await f.search({ bbox: [0, 0, 1, 1], crs: 'EPSG:4326' })).resources.length, 0, 'an empty geometry has no extent')
})

test('resource previews bound field metadata and cancelled requests cannot return a successful result', async t => {
  const f = await discoveryRig(t)
  const properties = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field_${index}`, index]))
  properties['x'.repeat(300)] = 0
  await f.register('wide', properties)
  const result = await f.search({})
  assert.equal(result.resources[0].fields.length, 16)
  assert.equal(result.resources[0].total_fields, 21)
  assert.ok(result.resources[0].fields.every(field => field.name.length <= 256))
  const controller = new AbortController()
  const call = f.rig.call(f.session, 'cancel-search', 'catalog_resolve', { search: {} })
  const pending = catalogResolve.execute({ search: {} }, f.rig.exec(f.session, { callId: call.data.callId, signal: controller.signal }))
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  await f.rig.ctx.spatialCatalog.recallCopies({ subject: HOST_SUBJECT, scope: { kind: 'tenant' }, origin: 'test' })
  const unavailable = await f.search({})
  assert.deepEqual(unavailable.resources, [])
  assert.equal(unavailable.has_more, false)
})

test('invalid discovery JSON, ambiguous branches and incompatible filters fail explicitly', async t => {
  const f = await discoveryRig(t)
  for (const search of [null, [], { limit: 17 }, { offset: -1 }, { query: '' }, { bbox: [0, 0, 1, 1] }, { bbox: [2, 0, 1, 1], crs: 'EPSG:4326' }, { fields: [''] }, { time: { from: 'yesterday' } }, { time: { from: '2026-01-01T00:00:00Z', to: '2025-01-01T00:00:00Z' } }, { unexpected: true }, '{broken']) {
    await assert.rejects(f.search(search), /INVALID_(INPUT|ARGUMENT)/)
  }
  await assert.rejects(catalogResolve.execute({ search: {}, query: 'population' }, f.rig.exec(f.session)), /exactly one/)
  await assert.rejects(catalogResolve.execute({ search: {}, limit: 4 }, f.rig.exec(f.session)), /search.*limit|limit.*search/)
})
