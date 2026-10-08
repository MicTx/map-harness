/**
 * P0a MCP protocol fixtures for the in-process ArcGIS provider: the real
 * InMemoryTransport pair dispatching the existing handlers against a REAL
 * session projection through the map rig — versioned durable meta on
 * successful structured results, Native content/meta consistency, trusted
 * per-session binding, and the refusal paths (schema errors, unknown tools,
 * workspace escape, cancellation, direct service calls without an accepted
 * `tool/call`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '../../../packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../packages/core/tools/lib/index.js'
import { ToolCallId } from '../../../packages/llm/llm/lib/index.js'
import { mapRig, pointCollection } from '../../map-container/tests/map-rig.mjs'
import { createSpatialMcpToolDefinitions } from '../../tools/src/mcp-tools.ts'
import {
  geoArea,
  geoBuffer,
  geoDistance,
  geoIntersect,
  mapAddLayer,
  mapGetState,
  mapRemoveLayer,
  mapSetMode,
  mapSetView,
  mapApplyPatch,
  mapUndo,
  catalogRegister,
  catalogResolve,
  mapSave,
  decisionUpdate,
  runSubmit,
  runGet,
  runCancel,
  statsZonal,
  statsAutocorrelation,
  statsHotspot,
  patternChange,
  patternCluster,
  patternFlow,
  attributionAssociation,
  attributionExplain,
  attributionEffect,
  forecastValidate,
  forecastFit,
  forecastPredict,
  scenarioCompare,
  locationAllocate,
  vizAggregate,
  terrainViewshed,
  vizCreateStyle,
  vizClassify,
  vizCompare,
  terrainAddLayer,
  geoLineOfSight,
  streamOpen,
  streamAdvance,
  streamPause,
  streamResume,
  streamMaterialize,
  scaleIngest,
  scaleRead,
  scaleScan,
} from '../../tools/src/index.ts'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { createArcgisMcpRuntime } from '../src/runtime.ts'

const directTools = [
  mapAddLayer, mapRemoveLayer, mapSetView, mapSetMode, mapGetState,
  mapApplyPatch, mapUndo,
  geoBuffer, geoArea, geoIntersect, geoDistance,
  catalogRegister, catalogResolve, mapSave,
  decisionUpdate,
  runSubmit, runGet, runCancel,
  statsZonal, statsAutocorrelation, statsHotspot,
  patternChange, patternCluster, patternFlow,
  attributionAssociation, attributionExplain, attributionEffect,
  forecastValidate, forecastFit, forecastPredict,
  scenarioCompare, locationAllocate,
  vizCreateStyle, vizClassify, vizCompare, vizAggregate,
  terrainAddLayer, geoLineOfSight, terrainViewshed,
  streamOpen, streamAdvance, streamPause, streamResume, streamMaterialize,
  scaleIngest, scaleRead, scaleScan,
]

const squareCollection = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[116.0, 39.0], [116.01, 39.0], [116.01, 39.01], [116.0, 39.01], [116.0, 39.0]]] }, properties: {} }],
}

function resultText(result) {
  return result.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

async function assertMcpFailure(promise, pattern) {
  try {
    const result = await promise
    assert.equal(result.isError, true)
    assert.match(resultText(result), pattern)
  } catch (error) {
    assert.match(String(error), pattern)
  }
}

test('real MCP transport lists the forty-six fixed schemas and returns foldable versioned meta from accepted calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-mcp-'))
  writeFileSync(join(dir, 'point.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  const runtime = await createArcgisMcpRuntime()
  try {
    const catalog = runtime.service.catalog()
    assert.deepEqual(catalog.map(tool => tool.name).sort(), directTools.map(tool => tool.name).sort())
    const byName = new Map(catalog.map(tool => [tool.name, tool]))
    for (const direct of directTools) {
      const inputSchema = byName.get(direct.name)?.inputSchema
      assert.ok(inputSchema)
      assert.equal(Object.hasOwn(inputSchema.properties ?? {}, 'sessionId'), false)
      assert.equal(inputSchema.additionalProperties, false)
      assert.deepEqual(
        Object.keys(inputSchema.properties ?? {}).sort(),
        Object.keys(direct.parameters.properties ?? {}).sort(),
      )
      assert.deepEqual(
        [...(inputSchema.required ?? [])].sort(),
        [...(direct.parameters.required ?? [])].sort(),
      )
    }

    const session = rig.session('session-a')
    const call = rig.call(session, 'call-add', 'map_add_layer', { path: 'point.geojson', layer_id: 'point' })
    const added = await runtime.service.callTool(
      'map_add_layer',
      { path: 'point.geojson', layer_id: 'point' },
      rig.exec(session, { callId: 'call-add' }),
    )
    assert.equal(added.isError, undefined)
    assert.equal(added.structuredContent.layer.id, 'point')
    assert.equal(added.structuredContent.meta.kind, 'map-change')
    assert.equal(added.structuredContent.meta.schemaVersion, 4)
    assert.equal(added.structuredContent.meta.sourceCallSeq, call.seq)
    assert.equal(added.structuredContent.meta.change.layer.id, 'point')
    assert.equal(resultText(added).includes('"meta"'), false)
    assert.equal(rig.state(session).layers.length, 0, 'the MCP handler itself must not mutate the authoritative map')

    // The commit completes only through the accepted session result.
    rig.result(session, call, { meta: added.structuredContent.meta })
    assert.equal(rig.state(session).layers.length, 1)
    const state = await mapGetState.execute({}, rig.exec(session))
    assert.deepEqual(state.layers.map(layer => layer.id), ['point'])
  } finally {
    await runtime.dispose()
    await rig.dispose()
  }
})

test('trusted ToolExecution binds concurrent calls to separate sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-mcp-sessions-'))
  const rig = await mapRig({ cwd: dir })
  const runtime = await createArcgisMcpRuntime()
  try {
    const a = rig.session('session-a')
    const b = rig.session('session-b')
    const callA = rig.call(a, 'bind-view', 'map_set_view', { center: [116.4, 39.9], zoom: 9 })
    const callB = rig.call(b, 'bind-mode', 'map_set_mode', { mode: 'scene' })
    const [viewed, moded] = await Promise.all([
      runtime.service.callTool('map_set_view', { center: [116.4, 39.9], zoom: 9 }, rig.exec(a, { callId: 'bind-view' })),
      runtime.service.callTool('map_set_mode', { mode: 'scene' }, rig.exec(b, { callId: 'bind-mode' })),
    ])
    rig.result(a, callA, { meta: viewed.structuredContent.meta })
    rig.result(b, callB, { meta: moded.structuredContent.meta })
    assert.deepEqual(rig.state(a).view.center, [116.4, 39.9])
    assert.equal(rig.state(a).mode, 'map')
    assert.deepEqual(rig.state(b).view.center, [0, 0])
    assert.equal(rig.state(b).mode, 'scene')
  } finally {
    await runtime.dispose()
    await rig.dispose()
  }
})

test('schema errors, unknown tools, missing sessions, escapes, and cancellation cannot mutate the map', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-mcp-errors-'))
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace)
  const outside = join(dir, 'outside.geojson')
  writeFileSync(outside, JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: workspace })
  const runtime = await createArcgisMcpRuntime()
  try {
    const session = rig.session('session-safe')
    const exec = rig.exec(session)
    await assertMcpFailure(
      runtime.service.callTool('map_set_mode', { mode: 'scene', sessionId: 'session-other' }, exec),
      /sessionId|unrecognized|invalid/i,
    )
    await assertMcpFailure(
      runtime.service.callTool('map_unknown', {}, exec),
      /unknown|not found|tool/i,
    )
    await assertMcpFailure(
      runtime.service.callTool('map_set_mode', { mode: 'scene' }, { signal: exec.signal }),
      /agent session/i,
    )
    const escapeCall = rig.call(session, 'escape', 'map_add_layer', { path: outside, layer_id: 'escape' })
    await assertMcpFailure(
      runtime.service.callTool('map_add_layer', { path: outside, layer_id: 'escape' }, rig.exec(session, { callId: 'escape' })),
      /session workspace/i,
    )
    assert.equal(rig.state(session).layers.length, 0)

    const controller = new AbortController()
    controller.abort()
    const abortCall = rig.call(session, 'aborted', 'map_set_view', { center: [10, 20], zoom: 4 })
    await assertMcpFailure(
      runtime.service.callTool(
        'map_set_view',
        { center: [10, 20], zoom: 4 },
        rig.exec(session, { callId: 'aborted', signal: controller.signal }),
      ),
      /abort|cancel/i,
    )
    // The loop settles an aborted call with a synthetic error result (no meta).
    rig.result(session, abortCall, { isError: true, text: 'tool call aborted' })
    const state = rig.state(session)
    assert.equal(state.layers.length, 0)
    assert.deepEqual(state.view.center, [0, 0])
    assert.equal(state.mode, 'map')
    void escapeCall
  } finally {
    await runtime.dispose()
    await rig.dispose()
  }
})

test('direct service calls without an accepted tool/call cannot bypass the session single-writer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-mcp-direct-'))
  const rig = await mapRig({ cwd: dir })
  const runtime = await createArcgisMcpRuntime()
  try {
    const session = rig.session('session-direct')
    // No tool/call was appended: the handler must refuse to propose a change.
    await assertMcpFailure(
      runtime.service.callTool('map_set_view', { center: [5, 6], zoom: 3 }, rig.exec(session, { callId: 'unlogged' })),
      /accepted tool\/call/,
    )
    assert.equal(rig.state(session).revision, 0)
    assert.deepEqual(rig.state(session).view.center, [0, 0])
    assert.deepEqual(rig.state(session).pendingCalls, [])
  } finally {
    await runtime.dispose()
    await rig.dispose()
  }
})

test('ToolRuntime Native content and spatial meta come from one canonical result and fold on accept', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-mcp-runtime-'))
  writeFileSync(join(dir, 'point.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  const runtime = await createArcgisMcpRuntime()
  try {
    await rig.ctx.plugin(SystemPrompt)
    await rig.ctx.plugin(ToolRuntime)
    for (const tool of createSpatialMcpToolDefinitions(rig.ctx, runtime.service)) rig.ctx.tools.register(tool)
    const session = rig.session('session-runtime')
    const callId = ToolCallId('mcp-add')
    const args = { path: 'point.geojson', layer_id: 'point' }
    // The agent loop appends the call event before dispatching the body.
    const call = rig.call(session, callId, 'map_add_layer', args)
    const result = await rig.ctx.tools.execute({
      agent: { ctx: rig.ctx, session },
      name: 'map_add_layer',
      arguments: args,
      callId,
      signal: new AbortController().signal,
    })

    assert.equal(result.isError, false)
    const meta = result.meta
    assert.equal(meta.kind, 'map-change')
    assert.equal(meta.schemaVersion, 4)
    assert.equal(meta.sourceCallSeq, call.seq)
    assert.equal(meta.change.layer.id, 'point')

    // Native model content carries the key fields the meta records: id,
    // feature count, and totals all appear in the text projection.
    const content = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.ok(content.includes('"point"'), 'layer id must be model-visible')
    assert.ok(content.includes('"featureCount":1'), 'feature count must be model-visible')
    assert.ok(!content.includes('"meta"'), 'durable meta stays out of model content')
    assert.equal(meta.change.layer.data.features.length, 1)
    assert.deepEqual(result.value.structuredContent.meta, meta)

    // The accepted result folds; map_get_state then reads the same facts.
    rig.result(session, call, { meta })
    const state = await mapGetState.execute({}, rig.exec(session))
    assert.deepEqual(state.layers.map(layer => layer.id), ['point'])
    assert.equal(state.layers[0].featureCount, 1)
  } finally {
    await runtime.dispose()
    await rig.dispose()
  }
})

test('runtime disposal is idempotent and rejects later calls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-mcp-dispose-'))
  const rig = await mapRig({ cwd: dir })
  const runtime = await createArcgisMcpRuntime()
  await runtime.dispose()
  await runtime.dispose()
  const session = rig.session('session-disposed')
  await assert.rejects(
    runtime.service.callTool('map_get_state', {}, rig.exec(session)),
    /disposed/i,
  )
  await rig.dispose()
})

test('geo tools dispatch through the real MCP transport with the legacy path semantics intact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-mcp-geo-'))
  writeFileSync(join(dir, 'square.geojson'), JSON.stringify(squareCollection))
  writeFileSync(join(dir, 'null-first.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: null, properties: { name: 'attribute-only' } },
      { type: 'Feature', geometry: squareCollection.features[0].geometry, properties: {} },
    ],
  }))
  const rig = await mapRig({ cwd: dir })
  const runtime = await createArcgisMcpRuntime()
  try {
    const session = rig.session('session-geo')
    const exec = rig.exec(session)
    const direct = await geoArea.execute({ path: 'square.geojson' }, exec)
    const call = rig.call(session, 'geo-area', 'geo_area', { path: 'square.geojson' })
    const viaMcp = await runtime.service.callTool('geo_area', { path: 'square.geojson' }, exec)
    assert.equal(viaMcp.isError, undefined)
    assert.equal(viaMcp.structuredContent.area_m2, direct.area_m2)
    assert.equal(viaMcp.structuredContent.meta.kind, 'analysis-result')
    assert.equal(viaMcp.structuredContent.meta.schemaVersion, 2)
    assert.equal(viaMcp.structuredContent.meta.inputs[0].featureIndex, 0)
    assert.ok(resultText(viaMcp).includes('"area_m2"'), 'metrics are model-visible content')
    assert.equal(resultText(viaMcp).includes('analysis-result'), false, 'durable meta stays out of content')

    // The feature_index path branch keeps selecting the second feature.
    const second = await runtime.service.callTool('geo_area', { path: 'null-first.geojson', feature_index: 1 }, exec)
    assert.equal(second.isError, undefined)
    assert.equal(second.structuredContent.feature_index, 1)
    assert.equal(second.structuredContent.meta.inputs[0].featureIndex, 1)

    // First-geometry tools consume the first feature with a geometry.
    const buffered = await runtime.service.callTool('geo_buffer', { path: 'null-first.geojson', distance_m: 10 }, rig.exec(session, { callId: 'geo-buffer' }))
    assert.equal(buffered.isError, undefined)
    assert.equal(buffered.structuredContent.feature_index, 1)

    // The accepted geo result carries analysis meta; the authoritative map is untouched.
    rig.result(session, call, { meta: viaMcp.structuredContent.meta })
    const state = rig.state(session)
    assert.equal(state.layers.length, 0)
    assert.equal(state.revision, 0)
    assert.deepEqual(state.diagnostics, [], 'analysis meta never produces map diagnostics')
    void exec
  } finally {
    await runtime.dispose()
    await rig.dispose()
  }
})

test('structured geo errors keep stable codes and cancellation through MCP', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arcgis-mcp-geo-errors-'))
  const workspace = join(root, 'workspace')
  mkdirSync(workspace)
  const outside = join(root, 'outside.geojson')
  writeFileSync(outside, JSON.stringify(squareCollection))
  writeFileSync(join(workspace, 'square.geojson'), JSON.stringify(squareCollection))
  const rig = await mapRig({ cwd: workspace })
  const runtime = await createArcgisMcpRuntime()
  try {
    const session = rig.session('session-geo-errors')
    const exec = rig.exec(session)
    await assertMcpFailure(
      runtime.service.callTool('geo_area', { path: 'square.geojson', crs: 'EPSG:9999' }, exec),
      /CRS_UNKNOWN/,
    )
    await assertMcpFailure(
      runtime.service.callTool('geo_area', { path: outside }, exec),
      /WORKSPACE_ESCAPE/,
    )
    await assertMcpFailure(
      runtime.service.callTool('geo_distance', { path_a: 'square.geojson', path_b: 'missing.geojson' }, exec),
      /SPATIAL_SERVICE_UNAVAILABLE/,
    )
    // No accepted tool/call and no session workspace: a bypassed geo call fails loud.
    await assertMcpFailure(
      runtime.service.callTool('geo_area', { path: 'square.geojson' }, { signal: new AbortController().signal }),
      /agent session/i,
    )

    const controller = new AbortController()
    controller.abort()
    await assertMcpFailure(
      runtime.service.callTool('geo_area', { path: 'square.geojson' }, rig.exec(session, { signal: controller.signal })),
      /abort|cancel|CALL_CANCELED/i,
    )
    assert.equal(rig.state(session).revision, 0)
    assert.deepEqual(rig.state(session).pendingCalls, [])
  } finally {
    await runtime.dispose()
    await rig.dispose()
  }
})

test('geo analysis meta with unknown versions stays read-only in the session projection', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-mcp-geo-replay-'))
  writeFileSync(join(dir, 'square.geojson'), JSON.stringify(squareCollection))
  const rig = await mapRig({ cwd: dir })
  const runtime = await createArcgisMcpRuntime()
  try {
    const session = rig.session('session-replay')
    const exec = rig.exec(session)
    const call = rig.call(session, 'geo-area-2', 'geo_area', { path: 'square.geojson' })
    const result = await runtime.service.callTool('geo_area', { path: 'square.geojson' }, exec)
    assert.equal(result.isError, undefined)

    // A well-formed analysis meta and an unknown-version twin both fold nothing.
    rig.result(session, call, { meta: result.structuredContent.meta })
    const futureCall = rig.call(session, 'geo-area-3', 'geo_area', { path: 'square.geojson' })
    rig.result(session, futureCall, { meta: { ...result.structuredContent.meta, schemaVersion: 99 } })
    const state = rig.state(session)
    assert.equal(state.layers.length, 0)
    assert.equal(state.revision, 0)
    assert.deepEqual(state.diagnostics, [])
  } finally {
    await runtime.dispose()
    await rig.dispose()
  }
})

test('the SDK dispatch entry refuses a revoked resource through the same MCP callTool path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-mcp-governance-'))
  writeFileSync(join(dir, 'point.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: join(dir, 'store') })
  const runtime = await createArcgisMcpRuntime()
  try {
    const session = rig.session('session-sdk')
    const regCall = rig.call(session, 'sdk-reg', 'catalog_register', { path: 'point.geojson', name: 'points' })
    const registered = await runtime.service.callTool(
      'catalog_register', { path: 'point.geojson', name: 'points' }, rig.exec(session, { callId: 'sdk-reg' }),
    )
    assert.equal(registered.isError, undefined)
    rig.result(session, regCall, { text: 'ok' })
    const ref = registered.structuredContent.resource.ref

    // Revoke through the Host governance plane (no tool exposes this).
    await rig.ctx.get('spatialCatalog').forSession(session.id).setObjectState({
      subject: { subjectId: 'host', kind: 'host' }, objectKind: 'resource', ref, state: 'revoked',
    })

    rig.call(session, 'sdk-res', 'catalog_resolve', { resource: ref })
    await assertMcpFailure(
      runtime.service.callTool('catalog_resolve', { resource: ref }, rig.exec(session, { callId: 'sdk-res' })),
      /GOVERNANCE_REVOKED.*not remotely recalled or erased/s,
    )
  } finally {
    await runtime.dispose()
    await rig.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
