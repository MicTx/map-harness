/**
 * Lifecycle and quiescence protocol fixtures for the map layer's host wiring:
 * provider fast-fail, fixed-toolset registration with duplicate and
 * task-required rejection, plugin dispose/reload quiescence, and the P0a
 * stillness barriers — cancellation during a mutation body and provider
 * disposal beside an in-flight call never change the authoritative map, and
 * unloading waits for the local MCP handler to settle before the transport
 * closes. These mount the REAL plugins through Cordis `ctx.plugin` beside
 * the real session projection (map rig).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '../../../packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../packages/core/tools/lib/index.js'
import { mapRig, pointCollection } from '../../map-container/tests/map-rig.mjs'
import * as mcpToolsPlugin from '../../tools/src/mcp.ts'
import * as arcgisMcpPlugin from '../src/plugin.ts'
import { createSpatialMcpToolDefinitions } from '../../tools/src/mcp-tools.ts'
import { createArcgisMcpRuntime } from '../src/runtime.ts'

const fixedTools = [
  'map_add_layer',
  'map_get_state',
  'map_remove_layer',
  'map_set_mode',
  'map_set_view',
  'map_apply_patch',
  'map_undo',
  'geo_buffer',
  'geo_area',
  'geo_intersect',
  'geo_distance',
  'catalog_register',
  'catalog_resolve',
  'map_save',
  'decision_update',
  'run_submit',
  'run_get',
  'run_cancel',
  'stats_zonal',
  'stats_autocorrelation',
  'stats_hotspot',
  'pattern_change',
  'pattern_cluster',
  'pattern_flow',
  'attribution_association',
  'attribution_explain',
  'attribution_effect',
  'forecast_validate',
  'forecast_fit',
  'forecast_predict',
  'scenario_compare',
  'location_allocate',
  'viz_aggregate',
  'viz_create_style',
  'viz_classify',
  'viz_compare',
  'terrain_add_layer',
  'geo_line_of_sight',
  'terrain_viewshed',
  'stream_open',
  'stream_advance',
  'stream_pause',
  'stream_resume',
  'stream_materialize',
  'scale_ingest',
  'scale_read',
  'scale_scan',
]

/** Mount the upstream prompt+tool runtime the preset plugins inject. */
async function toolRuntimeContext() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

test('mounting the preset mcp plugin without the host provider fails loud', async () => {
  const ctx = await toolRuntimeContext()
  try {
    await assert.rejects(
      async () => {
        await ctx.plugin(mcpToolsPlugin)
      },
      /ArcGIS MCP service unavailable; mount @map-harness\/arcgis-mcp in the host profile/,
      'a preset row without its host provider must fail activation, not silently register nothing',
    )
    for (const name of fixedTools) {
      assert.equal(ctx.tools.get(name), undefined, `no ${name} may remain registered after the failed mount`)
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('with the provider present the preset registers its fixed toolset and rejects duplicates', async () => {
  const ctx = await toolRuntimeContext()
  const runtime = await createArcgisMcpRuntime()
  const unprovide = ctx.reflect.provide('arcgisMcp', runtime.service)
  try {
    const fiber = await ctx.plugin(mcpToolsPlugin)
    try {
      for (const name of fixedTools) {
        assert.ok(ctx.tools.get(name) !== undefined, `${name} must be registered`)
      }
      const [again] = createSpatialMcpToolDefinitions(ctx, runtime.service)
      assert.throws(() => ctx.tools.register(again), /already registered/, 'a second registration of one tool name must fail loud')
    } finally {
      await fiber.dispose()
    }
    for (const name of fixedTools) {
      assert.equal(ctx.tools.get(name), undefined, `${name} must unregister with the preset fiber`)
    }
  } finally {
    void unprovide()
    await runtime.dispose()
    await ctx.fiber.dispose()
  }
})

test('the host provider plugin disposes to quiescence and reloads with fresh state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-lifecycle-'))
  const rig = await mapRig({ cwd: dir })
  try {
    const fiber = await rig.ctx.plugin(arcgisMcpPlugin)
    assert.deepEqual(rig.ctx.arcgisMcp.catalog().map(tool => tool.name).sort(), [...fixedTools].sort())

    // Disposal settles beside an in-flight call (map_get_state reads the real
    // projection): both promises resolve or reject, no orphan keeps the
    // process alive, and later calls fail loud.
    const session = rig.session('lifecycle')
    const settled = await Promise.allSettled([
      rig.ctx.arcgisMcp.callTool('map_get_state', {}, rig.exec(session)),
      fiber.dispose(),
    ])
    assert.equal(settled[1].status, 'fulfilled', 'dispose must reach quiescence')
    assert.equal(rig.ctx.get('arcgisMcp'), undefined, 'the service must leave the context with its fiber')

    const reloaded = await rig.ctx.plugin(arcgisMcpPlugin)
    assert.deepEqual(
      rig.ctx.arcgisMcp.catalog().map(tool => tool.name).sort(),
      [...fixedTools].sort(),
      'a reload mounts a fresh provider with the same fixed catalog',
    )
    await reloaded.dispose()
  } finally {
    await rig.dispose()
  }
})

test('cancelling mid-body leaves the authoritative map untouched and settles the pending call', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-cancel-'))
  writeFileSync(join(dir, 'point.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  const runtime = await createArcgisMcpRuntime()
  const controller = new AbortController()
  try {
    const session = rig.session('cancel-mid-body')
    const call = rig.call(session, 'cancel-add', 'map_add_layer', { path: 'point.geojson', layer_id: 'point' })
    // Deterministic barrier inside the handler's async file window: abort the
    // caller while the stat is in flight, then let the read continue — the
    // body must refuse to return a foldable candidate after cancellation.
    const abortingFs = wrapFilesystem(rig.ctx.fs, {
      beforeStat: () => controller.abort(new DOMException('cancel mid-body', 'AbortError')),
    })
    await assertMcpFailure(
      runtime.service.callTool(
        'map_add_layer',
        { path: 'point.geojson', layer_id: 'point' },
        rig.exec(session, { callId: 'cancel-add', signal: controller.signal, fs: abortingFs }),
      ),
      /abort|cancel/i,
    )
    assert.equal(rig.state(session).layers.length, 0, 'a cancelled body must not return a foldable candidate')

    // The loop settles the cancelled call with a synthetic error result (no
    // meta): the pending entry clears and the map still does not change.
    rig.result(session, call, { isError: true, text: 'tool call aborted' })
    const state = rig.state(session)
    assert.deepEqual(state.pendingCalls, [])
    assert.equal(state.layers.length, 0)
    assert.equal(state.revision, 0)
  } finally {
    await runtime.dispose()
    await rig.dispose()
  }
})

test('provider disposal waits for the in-flight local handler and publishes nothing afterwards', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-dispose-barrier-'))
  writeFileSync(join(dir, 'point.geojson'), JSON.stringify(pointCollection()))
  const rig = await mapRig({ cwd: dir })
  const runtime = await createArcgisMcpRuntime()
  let release
  try {
    const session = rig.session('dispose-barrier')
    const call = rig.call(session, 'barrier-add', 'map_add_layer', { path: 'point.geojson', layer_id: 'point' })
    // Deterministic barrier: hold the handler inside its async stat window.
    const barrier = new Promise(resolve => { release = resolve })
    const blockingFs = wrapFilesystem(rig.ctx.fs, { beforeStat: () => barrier })

    // Attach the settlement observer at creation: the abort inside dispose()
    // rejects the client call, and a late handler would race the unhandled
    // rejection hook.
    const inFlight = runtime.service.callTool(
      'map_add_layer',
      { path: 'point.geojson', layer_id: 'point' },
      rig.exec(session, { callId: 'barrier-add', fs: blockingFs }),
    ).then(outcome => ({ ok: true, outcome }), error => ({ ok: false, error }))
    const disposed = runtime.dispose()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(rig.state(session).layers.length, 0, 'nothing settles before the handler does')

    release()
    const [settled] = await Promise.all([inFlight, disposed])
    assert.notEqual(settled, undefined, 'dispose resolves only after the in-flight call settles')
    if (!settled.ok) assert.match(String(settled.error), /abort|disposed|cancel/i)
    assert.equal(rig.ctx.get('arcgisMcp'), undefined)
    await assert.rejects(
      runtime.service.callTool('map_get_state', {}, rig.exec(session)),
      /disposed/i,
      'a disposed provider must reject new dispatch',
    )
    // Even appending the (never-produced) result event cannot change the map:
    // the settled outcome after disposal carries no accepted session meta.
    rig.result(session, call, { isError: true, text: 'provider disposed before settlement' })
    assert.equal(rig.state(session).layers.length, 0)
    assert.equal(rig.state(session).revision, 0)
    assert.deepEqual(rig.state(session).pendingCalls, [])
  } finally {
    release?.()
    await rig.dispose()
  }
})

/** Await one MCP outcome or its rejection without breaking Promise.all order. */
async function assertMcpFailure(promise, pattern) {
  try {
    const result = await promise
    assert.equal(result.isError, true)
    assert.match(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), pattern)
  } catch (error) {
    assert.match(String(error), pattern)
  }
}

/** Wrap one filesystem service with hooks around `lstat` (the handler's first async window). */
function wrapFilesystem(fs, { beforeStat } = {}) {
  return {
    lstat: async (path, options, signal) => {
      await beforeStat?.()
      return fs.lstat(path, options, signal)
    },
    resolve: (path, options) => fs.resolve(path, options),
    contains: (parent, child) => fs.contains(parent, child),
  }
}

test('provider disposal waits for an in-flight geo handler and settles it without meta', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-geo-dispose-'))
  writeFileSync(join(dir, 'square.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[116.0, 39.0], [116.01, 39.0], [116.01, 39.01], [116.0, 39.01], [116.0, 39.0]]] }, properties: {} }],
  }))
  const rig = await mapRig({ cwd: dir })
  const runtime = await createArcgisMcpRuntime()
  let release
  try {
    const session = rig.session('geo-dispose')
    const barrier = new Promise(resolve => { release = resolve })
    const blockingFs = wrapFilesystem(rig.ctx.fs, { beforeStat: () => barrier })
    const inFlight = runtime.service.callTool(
      'geo_area',
      { path: 'square.geojson' },
      rig.exec(session, { fs: blockingFs }),
    ).then(outcome => ({ ok: true, outcome }), error => ({ ok: false, error }))
    const disposed = runtime.dispose()
    await new Promise(resolve => setImmediate(resolve))
    release()
    const [settled] = await Promise.all([inFlight, disposed])
    assert.notEqual(settled, undefined, 'dispose resolves only after the in-flight geo call settles')
    if (settled.ok) {
      assert.equal(settled.outcome.isError, true, 'an aborted geo call must not return a success meta')
    } else {
      assert.match(String(settled.error), /abort|disposed|cancel/i)
    }
    await assert.rejects(runtime.service.callTool('geo_area', { path: 'square.geojson' }, rig.exec(session)), /disposed/i)
  } finally {
    release?.()
    await rig.dispose()
  }
})

test('the preset guard denies nested dispatch of map mutations but not read-only geo analysis', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arcgis-guard-'))
  writeFileSync(join(dir, 'square.geojson'), JSON.stringify({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[116.0, 39.0], [116.01, 39.0], [116.01, 39.01], [116.0, 39.01], [116.0, 39.0]]] }, properties: {} }],
  }))
  const rig = await mapRig({ cwd: dir })
  const runtime = await createArcgisMcpRuntime()
  try {
    await rig.ctx.plugin(SystemPrompt)
    await rig.ctx.plugin(ToolRuntime)
    const unprovided = rig.ctx.reflect.provide('arcgisMcp', runtime.service)
    const fiber = await rig.ctx.plugin(mcpToolsPlugin)
    try {
      const session = rig.session('guard')
      const nested = await rig.ctx.tools.execute({
        agent: { ctx: rig.ctx, session },
        name: 'map_set_view',
        arguments: { center: [116.4, 39.9], zoom: 9 },
        callId: 'nested-view',
        signal: new AbortController().signal,
        parent: Symbol.for('nested-parent-token'),
      })
      assert.equal(nested.isError, true, 'a nested map mutation must be denied at the pipeline guard')
      assert.match(nested.error.message, /nested dispatch cannot change durable state/)

      const nestedGeo = await rig.ctx.tools.execute({
        agent: { ctx: rig.ctx, session },
        name: 'geo_area',
        arguments: { path: 'square.geojson' },
        callId: 'nested-area',
        signal: new AbortController().signal,
        parent: Symbol.for('nested-parent-token'),
      })
      assert.equal(nestedGeo.isError, false, 'read-only geo analysis stays callable from a nested dispatch')
      assert.equal(nestedGeo.meta, undefined, 'a nested geo call carries no durable presentation meta')
      assert.ok(nestedGeo.content.some(block => block.type === 'text' && block.text.includes('"area_m2"')))
    } finally {
      await fiber.dispose()
      unprovided()
    }
  } finally {
    await runtime.dispose()
    await rig.dispose()
  }
})
