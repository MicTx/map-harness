/** Cross-module acceptance of a synthetic facility decision; no live road or population claims. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as JsonlSessionPersistence from '../../../packages/session/session-persistence-jsonl/lib/index.js'
import { createAssistantMessage } from '../../../packages/llm/llm/lib/index.js'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as catalogPlugin from '../../spatial-catalog/src/plugin.ts'
import * as accessibilityPlugin from '../../spatial-accessibility/src/plugin.ts'
import { HOST_SUBJECT } from '../../spatial-catalog/src/index.ts'
import { attributeRowsOf, dataRefOf, exportManifestOf, histogramOf, legendOf } from '../../spatial-viz/src/index.ts'
import { catalogRegister, catalogResolve, mapSave } from '../src/catalog-tools.ts'
import { mapAddLayer } from '../src/map-tools.ts'
import { runSubmit, runGet } from '../src/run-tools.ts'
import { scenarioCompare } from '../src/decision-model-tools.ts'
import { vizClassify } from '../src/viz-tools.ts'

const fixtures = fileURLToPath(new URL('./fixtures/facility-decision/', import.meta.url))

async function environment(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-facility-decision-'))
  let rig
  let writer
  async function closeCurrent() {
    const current = rig
    rig = undefined
    const handle = writer
    writer = undefined
    try {
      await handle?.close()
    } finally {
      await current?.dispose()
    }
  }
  t.after(async () => {
    try {
      await closeCurrent()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  cpSync(fixtures, join(root, 'inputs'), { recursive: true })
  async function mount() {
    rig = await mapRig({ cwd: root })
    await rig.ctx.plugin(catalogPlugin, { root: join(root, 'catalog') })
    await rig.ctx.plugin(accessibilityPlugin, { root: join(root, 'runs') })
    await rig.ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  }
  await mount()
  const session = rig.session('facility-decision')
  writer = await rig.ctx.sessionPersistence.create(session.header)
  let calls = 0
  async function invoke(tool, args, { signal } = {}) {
    const turn = ++calls
    const callId = `facility-call-${turn}`
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      turn, step: 1, stream: [],
      message: createAssistantMessage({
        source: { provider: 'fixture', model: 'facility-decision' },
        content: [{ type: 'tool-call', id: callId, name: tool.name, arguments: JSON.stringify(args) }],
      }),
    }, { surfaceOp: 'append' })
    const call = rig.call(session, callId, tool.name, args)
    try {
      const value = await tool.execute(args, rig.exec(session, { callId, signal }))
      const meta = tool.output.presentationMeta?.(args, value)
      const text = tool.output.render(args, value).filter(block => block.type === 'text').map(block => block.text).join('\n')
      rig.result(session, call, { text, ...(meta == null ? {} : { meta }) })
      return value
    } catch (error) {
      rig.result(session, call, { isError: true, text: error.message })
      throw error
    } finally {
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
  }
  async function register(name) {
    return invoke(catalogRegister, { path: `inputs/${name}.geojson`, name })
  }
  return {
    root,
    session,
    invoke,
    register,
    get rig() { return rig },
    async restart() {
      await closeCurrent()
      await mount()
    },
  }
}

function coverageArgs(populationRef, facilityRef, id, longitude) {
  return {
    goal_revision: 1,
    population_ref: populationRef,
    population_field: 'population',
    facility_refs: [facilityRef],
    travel_mode: 'walk',
    max_minutes: 10,
    time_slices: ['midday'],
    study_area: [115.98, 39.48, 116.03, 39.52],
    retrieval_extent: [115.97, 39.47, 116.04, 39.53],
    support_extent: [115.96, 39.46, 116.05, 39.54],
    observation_from: '2026-06-01T00:00:00Z',
    observation_to: '2026-06-30T00:00:00Z',
    entrances: [{ facility: id, lon: longitude, lat: 39.5 }],
    capacities: { [id]: 1000 },
  }
}

function assertCoverage(record, covered) {
  assert.equal(record.status, 'succeeded')
  assert.equal(record.metrics.populationDenominator, 350)
  assert.equal(record.metrics.coveredPopulation, covered)
  assert.equal(record.metrics.uncoveredPopulation, 350 - covered)
  assert.equal(record.metrics.coverageRatio, covered / 350)
}

test('measured coverage drives the decision, styled export and durable recovery', { timeout: 30_000 }, async t => {
  const env = await environment(t)
  const population = await env.register('population')
  const west = await env.register('west')
  const east = await env.register('east')
  const readings = []
  for (const [id, resource, longitude, expected] of [
    ['west', west, 116, 150], ['east', east, 116.02, 200],
  ]) {
    const run = await env.invoke(runSubmit, coverageArgs(population.resource.ref, resource.resource.ref, id, longitude))
    await env.rig.ctx.get('spatialAccessibility').quiesce()
    const result = await env.invoke(runGet, { run_id: run.run_id })
    assertCoverage(result, expected)
    assert.ok(result.limitations.length > 0)
    readings.push(result)
  }
  // The independent oracle must reject a false coverage claim, not merely compare two implementations.
  assert.throws(() => assertCoverage(readings[0], 350), assert.AssertionError)
  const compared = await env.invoke(scenarioCompare, {
    goal_revision: 1,
    groups: [{ id: 'population', demand: 350 }],
    candidates: [
      { id: 'west', cost: 5, served: [{ group: 'population', amount: readings[0].metrics.coveredPopulation }] },
      { id: 'east', cost: 6, served: [{ group: 'population', amount: readings[1].metrics.coveredPopulation }] },
      { id: 'over-budget', cost: 20, served: [{ group: 'population', amount: 350 }] },
    ],
    weights: { coverage: 1, equity: 0, cost: 0 },
    budget: 10,
  })
  assert.equal(compared.top_id, 'east')
  assert.equal(compared.default_scenario, false)
  assert.deepEqual(compared.rows.find(row => row.id === 'over-budget').infeasible_reasons, ['over-budget'])
  assert.equal(compared.rows.find(row => row.id === 'over-budget').rank, null)

  await env.invoke(mapAddLayer, { ref: population.resource.ref, layer_id: 'population' })
  await env.invoke(mapAddLayer, { ref: east.resource.ref, layer_id: 'selected-facility' })
  const classified = await env.invoke(vizClassify, {
    layer_id: 'population', field: 'population', unit: 'people', classification: 'quantile', class_count: 3,
  })
  const state = env.rig.state(env.session)
  assert.deepEqual(state.layers.map(layer => layer.id), ['population', 'selected-facility'])
  const layer = state.layers[0]
  assert.equal(layer.style.styleVersion, classified.layers[0].style_version)
  assert.equal(dataRefOf(layer), population.resource.ref)
  const features = layer.data.features
  const legend = legendOf(layer.style)
  const bins = histogramOf(legend, layer.style, features.map(feature => feature.properties.population))
  assert.deepEqual(bins.filter(bin => bin.kind === 'class').map(bin => bin.count), [1, 1, 1])
  const table = attributeRowsOf(features, ['population', 'community'])
  assert.deepEqual(table.rows.map(row => row.values), [[100, 'west'], [50, 'west'], [200, 'east']])
  assert.equal(table.truncated, 0)
  const exported = exportManifestOf({
    mapRevision: state.revision, frame: null, filterRevision: null, failures: [],
    layers: state.layers.map(item => ({
      layerId: item.id, name: item.name, styleVersion: item.style?.styleVersion ?? null,
      dataRef: dataRefOf(item), displayDigest: item.displayDigest ?? null, featureCount: item.data.features.length,
    })),
  })
  assert.equal(exported.layers[0].styleVersion, layer.style.styleVersion)
  assert.equal(exported.layers[0].dataRef, population.resource.ref)
  assert.equal(exported.layers[1].dataRef, east.resource.ref)
  const saved = await env.invoke(mapSave, { map_revision: state.revision })
  assert.equal(saved.saved, true)
  assert.equal(saved.session_flush, 'confirmed')
  assert.equal(saved.revision, exported.mapRevision)
  assert.ok(saved.confirmed_refs.includes(population.resource.ref))
  assert.ok(saved.confirmed_refs.includes(east.resource.ref))
  assert.equal(await env.rig.ctx.sessions.flush(env.session), true)
  const expectedView = JSON.parse(JSON.stringify(env.rig.view(env.session)))
  const sessionId = env.session.id

  // The next owner reads disk after all first-instance handles have closed.
  await env.restart()
  const handle = await env.rig.ctx.sessionPersistence.open(sessionId, 'read')
  let restored
  try {
    const { events } = await handle.read()
    restored = env.rig.ctx.sessionProjections.restore({}, events, 0, handle.header, 0)
    assert.ok(events.some(event => event.type === 'tool/result'
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes('"top_id":"east"'))))
  } finally {
    await handle.close()
  }
  assert.deepEqual(restored.snapshot.values.mapContainer, expectedView)
  for (const [index, covered] of [150, 200].entries()) {
    const record = env.rig.ctx.get('spatialAccessibility').get(readings[index].run_id)
    assert.equal(record.status, 'succeeded')
    assert.equal(record.result.evidence.coveredPopulation, covered)
  }
  // Mutable source replacement cannot alter the accepted version or the recovered map.
  writeFileSync(join(env.root, 'inputs', 'population.geojson'), '{"type":"FeatureCollection","features":[]}\n')
  const stored = await env.rig.ctx.get('spatialCatalog').forSession(sessionId).readResourceBytes(population.resource.ref, 'local', 1024 * 1024)
  assert.equal(JSON.parse(Buffer.from(stored.bytes).toString('utf8')).features.length, 3)
})

test('missing data, cancellation and revocation cannot silently publish a decision', { timeout: 30_000 }, async t => {
  const env = await environment(t)
  const population = await env.register('population')
  const west = await env.register('west')
  const args = coverageArgs(population.resource.ref, west.resource.ref, 'west', 116)
  const initialRevision = env.rig.state(env.session).revision
  await assert.rejects(env.invoke(catalogRegister, { path: 'inputs/missing.geojson', name: 'missing' }))
  const abort = new AbortController()
  abort.abort(new Error('cancelled by analyst'))
  await assert.rejects(env.invoke(runSubmit, args, { signal: abort.signal }), /cancelled by analyst/)
  await assert.rejects(env.invoke(runSubmit, { ...args, support_extent: [115.9, 39.4, 115.95, 39.45] }), /extent-nesting/)
  const catalog = env.rig.ctx.get('spatialCatalog').forSession(env.session.id)
  await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref: population.resource.ref, state: 'revoked' })
  await assert.rejects(env.invoke(catalogResolve, { resource: population.resource.ref }), error => error.code === 'GOVERNANCE_REVOKED')
  await assert.rejects(env.invoke(mapAddLayer, { ref: population.resource.ref, layer_id: 'revoked' }), error => error.code === 'GOVERNANCE_REVOKED')
  assert.equal(env.rig.state(env.session).revision, initialRevision)
  assert.equal(env.rig.state(env.session).layers.length, 0)
  assert.deepEqual(await catalog.auditTrail({ objectKind: 'artifact' }), [])
})

test('the live recording compares measured results and saves the selected version', () => {
  const scenario = new URL('../../../snapshots/session/map-facility-decision/', import.meta.url)
  for (const name of ['population', 'west', 'east']) {
    assert.equal(readFileSync(new URL(`workspace/${name}.geojson`, scenario), 'utf8'), readFileSync(join(fixtures, `${name}.geojson`), 'utf8'))
  }
  const rows = readFileSync(new URL('session.v4.jsonl', scenario), 'utf8').trim().split('\n').map(JSON.parse)
  const calls = rows.filter(row => row.type === 'tool/call').map(row => row.data)
  const results = new Map(rows.filter(row => row.type === 'tool/result').map(row => {
    assert.equal(row.data.message.isError, false)
    return [row.data.message.toolCallId, JSON.parse(row.data.message.content.find(block => block.type === 'text').text)]
  }))
  assert.equal(calls.length, results.size)
  const readouts = calls.filter(call => call.name === 'run_get').map(call => results.get(call.callId))
  assert.equal(readouts.length, 2)
  for (const [index, covered] of [150, 200].entries()) assertCoverage(readouts[index], covered)
  const comparison = calls.find(call => call.name === 'scenario_compare')
  const args = JSON.parse(comparison.arguments)
  const candidates = typeof args.candidates === 'string' ? JSON.parse(args.candidates) : args.candidates
  assert.equal(candidates.find(candidate => candidate.id === 'west').served[0].amount, readouts[0].metrics.coveredPopulation)
  assert.equal(candidates.find(candidate => candidate.id === 'east').served[0].amount, readouts[1].metrics.coveredPopulation)
  assert.equal(results.get(comparison.callId).top_id, 'east')
  const save = results.get(calls.findLast(call => call.name === 'map_save').callId)
  assert.equal(save.saved, true)
  assert.equal(save.session_flush, 'confirmed')
  assert.equal(save.revision, 4)
  const final = rows.filter(row => row.type === 'assistant/message').at(-1).data.message.content
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.match(final, /150\s*\/\s*350/)
  assert.match(final, /200\s*\/\s*350/)
  assert.match(final, /synthetic/i)
  assert.match(final, /not a global|not global/i)
  assert.doesNotMatch(final, /\{\{(?:workflow|id):/)
})
