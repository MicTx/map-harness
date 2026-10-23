/**
 * Cross-module acceptance of the layer workbench (P4 linked chain): the
 * confirmed two-round import → resolve → ref-loaded layers → preset +
 * per-feature style → batched state → whole-map export with byte-digest
 * identity → save → closed-reopen restore from disk, plus the three
 * negative families (malformed import leaves zero catalog rows, stale
 * expected_revision refuses, revoked sources refuse to export). Real
 * catalog, projection, and JSONL persistence; synthetic data only.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as JsonlSessionPersistence from '../../../packages/session/session-persistence-jsonl/lib/index.js'
import { createAssistantMessage } from '../../../packages/llm/llm/lib/index.js'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as catalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { HOST_SUBJECT } from '../../spatial-catalog/src/index.ts'
import { featureIdOf } from '../../spatial-viz/src/index.ts'
import { catalogRegister, catalogResolve, mapSave } from '../src/catalog-tools.ts'
import { dataExport, dataImport } from '../src/data-tools.ts'
import { layerSetState, layerSetStyle } from '../src/layer-tools.ts'
import { mapAddLayer } from '../src/map-tools.ts'

const sharedFixtures = fileURLToPath(new URL('../../arcgis-mcp/tests/fixtures/layer-workbench/', import.meta.url))
const toolFixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

/** The layer-workbench environment: real rig + catalog + JSONL persistence over one temp root. */
async function environment(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-layer-workbench-'))
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
  mkdirSync(join(root, 'inputs'), { recursive: true })
  for (const name of ['hospitals.csv', 'hospitals.confirmed.csv', 'hospitals-gbk.csv', 'roads.shp.zip', 'truncated.shp.zip']) {
    cpSync(join(sharedFixtures, name), join(root, 'inputs', name))
  }
  cpSync(join(toolFixtures, 'layer-workbench-hospitals.csv'), join(root, 'inputs', 'hospitals.csv'))
  async function mount() {
    rig = await mapRig({ cwd: root })
    await rig.ctx.plugin(catalogPlugin, { root: join(root, 'catalog') })
    await rig.ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  }
  await mount()
  const session = rig.session('layer-workbench')
  writer = await rig.ctx.sessionPersistence.create(session.header)
  let calls = 0
  async function invoke(tool, args) {
    calls += 1
    const turn = calls
    const callId = `lw-${turn}`
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      turn, step: 1, stream: [],
      message: createAssistantMessage({
        source: { provider: 'fixture', model: 'layer-workbench' },
        content: [{ type: 'tool-call', id: callId, name: tool.name, arguments: JSON.stringify(args) }],
      }),
    }, { surfaceOp: 'append' })
    const call = rig.call(session, callId, tool.name, args)
    try {
      const value = await tool.execute(args, rig.exec(session, { callId }))
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
  return {
    root,
    session,
    invoke,
    get rig() { return rig },
    catalog() { return rig.ctx.get('spatialCatalog').forSession(session.id) },
    async restart() {
      await closeCurrent()
      await mount()
    },
  }
}

test('the linked chain: confirmed import, styled layers, digest-verified export, and closed-reopen recovery', { timeout: 60_000 }, async t => {
  const env = await environment(t)
  // (A) The ambiguous CSV stops at needs_confirmation with zero rows published.
  const gated = await env.invoke(dataImport, { path: 'inputs/hospitals.csv', name: 'hospitals' })
  assert.equal(gated.status, 'needs_confirmation')
  assert.ok(gated.admission.column_candidates.lon.some(entry => entry.column === 'x'))
  assert.match(gated.candidates_fingerprint, /^[0-9a-f]{64}$/)
  assert.equal((await env.catalog().searchResources({ search: {}, authorization: env.catalog().deploymentDomain() })).resources.length, 0)

  // (A) The confirmation round trip resolves the columns and publishes v1.
  const imported = await env.invoke(dataImport, {
    path: 'inputs/hospitals.csv', name: 'hospitals',
    lon_column: 'x', lat_column: 'y', confirm: { fingerprint: gated.candidates_fingerprint },
  })
  assert.equal(imported.status, 'succeeded')
  assert.equal(imported.resource.featureCount, 3)
  const hospitalsRef = imported.resource.ref

  // (A) The shapefile rides in without confirmation (WGS84 .prj).
  const roads = await env.invoke(dataImport, { path: 'inputs/roads.shp.zip', name: 'roads' })
  assert.equal(roads.status, 'succeeded')
  assert.equal(roads.resource.featureCount, 2)
  assert.deepEqual(roads.resource.geometryTypes, ['LineString'])
  const roadsRef = roads.resource.ref

  const resolved = await env.invoke(catalogResolve, { resource: hospitalsRef })
  assert.equal(resolved.bundle.resourceRef, hospitalsRef)

  await env.invoke(mapAddLayer, { ref: hospitalsRef, layer_id: 'hospitals', name: '医院' })
  await env.invoke(mapAddLayer, { ref: roadsRef, layer_id: 'roads', name: '道路' })
  let state = env.rig.state(env.session)
  assert.deepEqual(state.layers.map(layer => layer.id), ['hospitals', 'roads'])

  // (C) Preset symbol + per-feature overrides compose onto the hospitals layer.
  const preset = await env.invoke(layerSetStyle, { layer_id: 'hospitals', preset: 'marker-square-red-large' })
  assert.match(preset.symbol_version, /^sym-/)
  const featureIds = state.layers[0].data.features.map((feature, index) => featureIdOf(feature, index)).slice(0, 3)
  const overridden = await env.invoke(layerSetStyle, {
    layer_id: 'hospitals',
    overrides: [{ featureIds, patch: { color: '#0055ff' } }],
  })
  assert.match(overridden.overrides_version, /^ovr-/)

  // (C) Batched state groups both layers in one revision.
  const stateCall = await env.invoke(layerSetState, {
    states: [
      { layer_id: 'hospitals', group: '医疗' },
      { layer_id: 'roads', group: '交通', opacity: 0.8 },
    ],
  })
  assert.equal(stateCall.states.length, 2)
  state = env.rig.state(env.session)
  assert.equal(state.layers[0].group, '医疗')
  assert.equal(state.layers[1].group, '交通')
  assert.equal(state.layers[1].opacity, 0.8)

  // (E) Whole-map export: one artifact per ref-loaded layer, digests verified.
  const exported = await env.invoke(dataExport, { map: true, format: 'geojson' })
  assert.equal(exported.status, 'succeeded')
  assert.deepEqual(exported.exported.map(entry => entry.layer_id).sort(), ['hospitals', 'roads'])
  const catalog = env.catalog()
  for (const entry of exported.exported) {
    const { artifact, bytes } = await catalog.readArtifactBytes(entry.artifact.ref, catalog.deploymentDomain())
    const digest = createHash('sha256').update(Buffer.from(bytes)).digest('hex')
    assert.equal(digest, entry.artifact.content_digest, `${entry.layer_id} export bytes must hash to the published digest`)
    assert.equal(artifact.byteCount, entry.artifact.byte_count)
    const collection = JSON.parse(Buffer.from(bytes).toString('utf8'))
    assert.equal(collection.type, 'FeatureCollection')
    assert.equal(collection.features.length, entry.artifact.feature_count)
  }

  // (F) Save pins every ref; the projection view is captured for restore.
  const beforeRevision = env.rig.state(env.session).revision
  const saved = await env.invoke(mapSave, { map_revision: beforeRevision })
  assert.equal(saved.saved, true)
  assert.equal(saved.session_flush, 'confirmed')
  assert.ok(saved.confirmed_refs.includes(hospitalsRef))
  assert.ok(saved.confirmed_refs.includes(roadsRef))
  assert.equal(await env.rig.ctx.sessions.flush(env.session), true)
  const expectedView = JSON.parse(JSON.stringify(env.rig.view(env.session)))
  const sessionId = env.session.id
  const artifactRefs = exported.exported.map(entry => entry.artifact.ref)
  const expectedDigests = exported.exported.map(entry => entry.artifact.content_digest)

  // (F) The next owner reads disk after every first-instance handle closed.
  await env.restart()
  const reopened = env.catalog()
  const handle = await env.rig.ctx.sessionPersistence.open(sessionId, 'read')
  let restoredView
  try {
    const { events } = await handle.read()
    restoredView = env.rig.ctx.sessionProjections.restore({}, events, 0, handle.header, 0).snapshot.values.mapContainer
    assert.ok(events.some(event => event.type === 'tool/result'
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes('"saved"'))))
  } finally {
    await handle.close()
  }
  assert.deepEqual(restoredView, expectedView, 'the reopened projection replays the identical map view')
  assert.equal(restoredView.revision, beforeRevision)
  for (const [index, ref] of artifactRefs.entries()) {
    const { bytes } = await reopened.readArtifactBytes(ref, reopened.deploymentDomain())
    assert.equal(createHash('sha256').update(Buffer.from(bytes)).digest('hex'), expectedDigests[index])
  }
  const stored = await reopened.readResourceBytes(hospitalsRef, 'local', 1024 * 1024)
  assert.equal(JSON.parse(Buffer.from(stored.bytes).toString('utf8')).features.length, 3)
})

test('honest failures: malformed import leaves no rows, stale revisions refuse, revoked sources refuse export', { timeout: 60_000 }, async t => {
  const env = await environment(t)
  // The truncated shapefile refuses with the stable record-chain error and
  // leaves the catalog exactly as empty as before.
  await assert.rejects(env.invoke(dataImport, { path: 'inputs/truncated.shp.zip', name: 'broken' }), /record chain/)
  const catalog = env.catalog()
  const listing = await catalog.searchResources({ search: {}, authorization: catalog.deploymentDomain() })
  assert.equal(listing.resources.length, 0, 'a malformed import must publish nothing')
  assert.deepEqual(await catalog.auditTrail({ objectKind: 'artifact' }), [])

  // The confirmed CSV imports without any confirmation round.
  const imported = await env.invoke(dataImport, { path: 'inputs/hospitals.confirmed.csv', name: 'hospitals-confirmed' })
  assert.equal(imported.status, 'succeeded')
  const confirmedRef = imported.resource.ref
  await env.invoke(mapAddLayer, { ref: confirmedRef, layer_id: 'hospitals' })
  const revision = env.rig.state(env.session).revision

  // A stale expected_revision is a visible refusal, not a silent retry.
  await assert.rejects(
    env.invoke(layerSetState, { states: [{ layer_id: 'hospitals', visible: false }], expected_revision: revision + 5 }),
    /stale/,
  )
  assert.equal(env.rig.state(env.session).revision, revision, 'a refused change burns no revision')

  // A revoked source cannot be exported; the refusal carries the governance code.
  await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref: confirmedRef, state: 'revoked' })
  await assert.rejects(
    env.invoke(dataExport, { ref: confirmedRef, format: 'geojson' }),
    error => error.code === 'GOVERNANCE_REVOKED',
  )
  assert.equal(env.rig.state(env.session).revision, revision, 'a refused export changes no map state')
})

test('the GBK CSV imports under its explicit encoding with the strong Chinese aliases', { timeout: 60_000 }, async t => {
  const env = await environment(t)
  const imported = await env.invoke(dataImport, { path: 'inputs/hospitals-gbk.csv', name: 'hospitals-gbk', encoding: 'gbk' })
  assert.equal(imported.status, 'succeeded')
  assert.equal(imported.import.encoding, 'gbk')
  assert.equal(imported.resource.featureCount, 3)
  await env.invoke(mapAddLayer, { ref: imported.resource.ref, layer_id: 'hospitals-gbk' })
  const layer = env.rig.state(env.session).layers[0]
  assert.equal(layer.data.features[0].properties['名称'], '示例第一医院')
})
