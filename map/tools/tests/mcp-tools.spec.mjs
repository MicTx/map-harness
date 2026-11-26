import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '../../../packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../packages/core/tools/lib/index.js'
import * as nativeToolExecutor from '../../../packages/core/tool-executor-native/lib/index.js'
import { executeModelToolFixture } from '../../../packages/test-support/tool-testkit/lib/index.js'
import { ToolCallId } from '../../../packages/llm/llm/lib/index.js'
import * as directTools from '../src/a-index.ts'
import { createSpatialMcpToolDefinitions } from '../src/mcp-tools.ts'
import { SPATIAL_MCP_TOOL_NAMES, spatialToolOf } from '../src/spatial-catalog.ts'

test('direct registration and reload expose the complete spatial MCP catalog', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const fiber = await ctx.plugin(directTools)
      for (const name of SPATIAL_MCP_TOOL_NAMES) assert.ok(ctx.tools.get(name), `direct registration missing ${name}`)
      assert.deepEqual(ctx.tools.schemas().map(tool => tool.name).sort(), [...SPATIAL_MCP_TOOL_NAMES].sort())
      await fiber.dispose()
      for (const name of SPATIAL_MCP_TOOL_NAMES) assert.equal(ctx.tools.get(name), undefined, `${name} must unregister`)
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

const descriptor = {
  name: 'map_set_mode',
  description: 'Switch the map mode.',
  inputSchema: {
    type: 'object',
    properties: { mode: { type: 'string', enum: ['map', 'scene'] } },
    required: ['mode'],
    additionalProperties: false,
  },
}

const geoDescriptor = {
  name: 'geo_area',
  description: 'Measure a polygon area.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' }, feature_index: { type: 'number' } },
    required: ['path'],
    additionalProperties: false,
  },
}

function serviceWith(catalog) {
  return {
    catalog: () => catalog,
    async callTool(name, args, execution) {
      return { name, args, execution }
    },
  }
}

test('the unified catalog serves exactly the fixed spatial tools with identity rows', () => {
  assert.deepEqual([...SPATIAL_MCP_TOOL_NAMES].sort(), [
    'attribution_association',
    'attribution_effect',
    'attribution_explain',
    'catalog_register',
    'catalog_resolve',
    'data_export',
    'data_import',
    'decision_update',
    'forecast_fit',
    'forecast_predict',
    'forecast_validate',
    'geo_area',
    'geo_buffer',
    'geo_contour',
    'geo_difference',
    'geo_distance',
    'geo_intersect',
    'geo_line_of_sight',
    'geo_nearest',
    'geo_perimeter',
    'geo_point_line_distance',
    'geo_union',
    'layer_set_state',
    'layer_set_style',
    'location_allocate',
    'map_add_layer',
    'map_apply_patch',
    'map_compare_views',
    'map_draw',
    'map_edit_annotation',
    'map_fit_view',
    'map_get_state',
    'map_list_basemaps',
    'map_locate',
    'map_mark_changes',
    'map_markup',
    'map_observe',
    'map_refine_aoi',
    'map_remove_layer',
    'map_save',
    'map_set_basemap',
    'map_set_imagery',
    'map_set_mode',
    'map_set_view',
    'map_undo',
    'map_use',
    'pattern_change',
    'pattern_cluster',
    'pattern_flow',
    'run_cancel',
    'run_get',
    'run_submit',
    'scale_ingest',
    'scale_read',
    'scale_scan',
    'scenario_compare',
    'stats_autocorrelation',
    'stats_hotspot',
    'stats_zonal',
    'stream_advance',
    'stream_materialize',
    'stream_open',
    'stream_pause',
    'stream_resume',
    'terrain_add_layer',
    'terrain_slope',
    'terrain_viewshed',
    'viz_aggregate',
    'viz_classify',
    'viz_compare',
    'viz_create_style',
    'viz_density',
    'viz_export_kml',
    'viz_recommend',
  ])
  for (const name of SPATIAL_MCP_TOOL_NAMES) {
    const identity = spatialToolOf(name)
    assert.equal(identity.owner, '@map-harness/map-tools')
    assert.equal(identity.provider, '@map-harness/arcgis-mcp')
    if (name === 'viz_recommend' || name === 'map_list_basemaps') {
      if (name === 'viz_recommend') assert.equal(identity.family, 'viz-read')
      assert.equal(identity.metaKind, null)
      assert.equal(identity.metaSchemaVersion, null)
    } else {
      assert.equal(typeof identity.metaSchemaVersion, 'number')
    }
  }
  assert.equal(spatialToolOf('map_add_layer').family, 'map-mutation')
  assert.equal(spatialToolOf('map_set_imagery').family, 'map-mutation')
  assert.equal(spatialToolOf('map_set_imagery').metaKind, 'map-change')
  assert.equal(spatialToolOf('map_get_state').family, 'map-read')
  assert.equal(spatialToolOf('geo_buffer').family, 'geo-analysis')
  assert.equal(spatialToolOf('catalog_register').family, 'catalog-write')
  assert.equal(spatialToolOf('data_import').family, 'catalog-data')
  assert.equal(spatialToolOf('catalog_resolve').family, 'catalog-read')
  assert.equal(spatialToolOf('map_save').family, 'map-save')
  assert.equal(spatialToolOf('layer_set_state').family, 'layer-write')
  assert.equal(spatialToolOf('layer_set_style').family, 'layer-write')
  assert.equal(spatialToolOf('layer_set_state').metaKind, 'map-change')
  assert.equal(spatialToolOf('layer_set_style').metaKind, 'map-change')
  assert.equal(spatialToolOf('decision_update').family, 'decision-write')
  assert.equal(spatialToolOf('run_submit').family, 'run-submit')
  assert.equal(spatialToolOf('run_get').family, 'run-read')
  assert.equal(spatialToolOf('run_cancel').family, 'run-cancel')
  for (const name of ['stats_zonal', 'stats_autocorrelation', 'stats_hotspot', 'pattern_change', 'pattern_cluster', 'pattern_flow']) {
    assert.equal(spatialToolOf(name).family, 'stat-analysis')
    assert.equal(spatialToolOf(name).metaKind, 'spatial-stat')
  }
  for (const name of ['attribution_association', 'attribution_explain', 'attribution_effect', 'forecast_validate', 'forecast_fit', 'forecast_predict', 'scenario_compare', 'location_allocate']) {
    assert.equal(spatialToolOf(name).family, 'decision-model')
    assert.equal(spatialToolOf(name).metaKind, 'spatial-decision')
  }
  for (const name of ['stream_open', 'stream_advance', 'stream_pause', 'stream_resume']) {
    assert.equal(spatialToolOf(name).family, 'stream-workbench')
    assert.equal(spatialToolOf(name).metaKind, 'map-change')
  }
  assert.equal(spatialToolOf('stream_materialize').family, 'stream-materialize')
  assert.equal(spatialToolOf('stream_materialize').metaKind, 'map-change')
  assert.throws(() => spatialToolOf('map_eval'), /unknown spatial tool/)
})

test('MCP map adapter preserves execution and projects private metadata out of model content', async () => {
  const ctx = new Context()
  try {
    let observed
    const service = {
      catalog: () => [descriptor],
      async callTool(name, args, execution) {
        observed = { name, args, execution }
        return {
          content: [{ type: 'text', text: '{"mode":"scene"}' }],
          structuredContent: { mode: 'scene', meta: { mode: 'scene' } },
        }
      },
    }
    const [tool] = createSpatialMcpToolDefinitions(ctx, service)
    const execution = { signal: new AbortController().signal }
    const value = await tool.execute({ mode: 'scene' }, execution)

    assert.equal(tool.name, 'map_set_mode')
    assert.deepEqual(observed, {
      name: 'map_set_mode',
      args: { mode: 'scene' },
      execution,
    })
    assert.deepEqual(tool.output.presentationMeta({ mode: 'scene' }, value), { mode: 'scene' })
    assert.deepEqual(tool.output.render({ mode: 'scene' }, value), [
      { type: 'text', text: '{"mode":"scene"}' },
    ])
  } finally {
    await ctx.fiber.dispose()
  }
})

test('the adapter covers geo tools with the same meta projection and render stripping', async () => {
  const ctx = new Context()
  try {
    const canonical = {
      area_m2: 1234.5,
      bbox: [1, 2, 3, 4],
      feature_index: 0,
      status: 'succeeded',
      limitations: ['approximation'],
      meta: { schemaVersion: 1, kind: 'analysis-result', tool: 'geo_area' },
    }
    const service = {
      catalog: () => [geoDescriptor],
      async callTool() {
        return {
          content: [{ type: 'text', text: JSON.stringify({ area_m2: 1234.5, status: 'succeeded' }) }],
          structuredContent: canonical,
        }
      },
    }
    const [tool] = createSpatialMcpToolDefinitions(ctx, service)
    assert.equal(tool.name, 'geo_area')
    const value = await tool.execute({ path: 'square.geojson' }, { signal: new AbortController().signal })
    assert.deepEqual(tool.output.presentationMeta({}, value), canonical.meta)
    const rendered = tool.output.render({}, value)
    assert.equal(rendered.length, 1)
    assert.equal(rendered[0].text.includes('analysis-result'), false, 'durable meta stays out of model content')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('map_observe MCP adapter renders the canonical saved attachment as model image content', async () => {
  const ctx = new Context()
  const saved = []
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(nativeToolExecutor)
    const descriptor = {
      name: 'map_observe',
      description: 'Observe the current map.',
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    }
    const service = {
      catalog: () => [descriptor],
      async callTool() {
        saved.push({ attachmentId: 'att-observe-once' })
        return {
          content: [
            { type: 'text', text: '{"observation_id":"obs-1","revision":0}' },
            { type: 'resource_link', uri: 'attachment://att-observe-once', name: 'map-r0.png', mimeType: 'image/png' },
          ],
          structuredContent: {
            observation_id: 'obs-1',
            revision: 0,
            image: { attachmentId: 'att-observe-once', mediaType: 'image/png', bytes: 32, width: 8, height: 4 },
            meta: { schemaVersion: 1, kind: 'map-observation', record: { callId: 'observe-1', requestSeq: 3, mapRevision: 0 } },
          },
        }
      },
    }
    for (const tool of createSpatialMcpToolDefinitions(ctx, service)) ctx.tools.register(tool)
    const session = { id: 'mcp-observation-session' }
    const callId = ToolCallId('observe-1')
    const args = {}
    const result = await executeModelToolFixture(ctx, {
      agent: { ctx, session },
      name: 'map_observe',
      arguments: args,
      callId,
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, false)
    assert.equal(saved.length, 1, 'the adapter never persists a second copy')
    assert.equal(result.meta.kind, 'map-observation')
    assert.equal(result.meta.record.callId, 'observe-1')
    assert.equal(result.meta.record.mapRevision, 0)
    assert.equal(result.value.structuredContent.image.attachmentId, saved[0].attachmentId)
    assert.equal(result.content.some(block => block.type === 'image' && block.attachment.attachmentId === saved[0].attachmentId), true)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.equal(text.includes('"meta"'), false)
    assert.equal(text.includes('map-observation'), false)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('map_compare_views MCP adapter renders both saved images in before/after order', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(nativeToolExecutor)
    const service = {
      catalog: () => [{
        name: 'map_compare_views',
        description: 'Compare two saved observations.',
        inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      }],
      async callTool() {
        return {
          structuredContent: {
            comparison_id: 'vcompare-0123456789abcdef01234567',
            image_order: ['before', 'after'],
            before_image: { attachmentId: 'att-before', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
            after_image: { attachmentId: 'att-after', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
            note: 'saved evidence',
            meta: { kind: 'map-visual-comparison', schemaVersion: 2, record: { comparisonId: 'vcompare-0123456789abcdef01234567' } },
          },
        }
      },
    }
    for (const tool of createSpatialMcpToolDefinitions(ctx, service)) ctx.tools.register(tool)
    const result = await executeModelToolFixture(ctx, {
      agent: { ctx, session: { id: 'mcp-comparison-session' } },
      name: 'map_compare_views',
      arguments: {},
      callId: ToolCallId('compare-1'),
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, false)
    assert.equal(result.meta.kind, 'map-visual-comparison')
    const images = result.content.filter(block => block.type === 'image')
    assert.deepEqual(images.map(block => block.attachment.attachmentId), ['att-before', 'att-after'])
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.equal(text.includes('"meta"'), false)
    assert.equal(text.includes('"before_image"'), false)
    assert.equal(text.includes('"after_image"'), false)
    assert.match(text, /saved evidence/)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('MCP map adapter rejects duplicate or out-of-scope catalog names', () => {
  const ctx = new Context()
  try {
    const duplicate = serviceWith([descriptor, descriptor])
    assert.throws(() => createSpatialMcpToolDefinitions(ctx, duplicate), /duplicate.*map_set_mode/i)
    const unexpected = serviceWith([{ ...descriptor, name: 'map_eval' }])
    assert.throws(() => createSpatialMcpToolDefinitions(ctx, unexpected), /unsupported.*map_eval/i)
    const foreignGeo = serviceWith([{ ...geoDescriptor, name: 'geo_voronoi' }])
    assert.throws(() => createSpatialMcpToolDefinitions(ctx, foreignGeo), /unsupported.*geo_voronoi/i)
  } finally {
    void ctx.fiber.dispose()
  }
})

test('MCP map adapter refuses task-required tools at definition time', () => {
  const ctx = new Context()
  try {
    const taskRequired = serviceWith([{ ...descriptor, taskRequired: true }])
    assert.throws(
      () => createSpatialMcpToolDefinitions(ctx, taskRequired),
      /map_set_mode.*task-based execution.*does not support/,
      'the Native-only map surface must refuse task-required tools before registration',
    )
    const taskRequiredGeo = serviceWith([{ ...geoDescriptor, taskRequired: true }])
    assert.throws(
      () => createSpatialMcpToolDefinitions(ctx, taskRequiredGeo),
      /geo_area.*task-based execution.*does not support/,
      'task-required geo tools fail at definition time too',
    )
  } finally {
    void ctx.fiber.dispose()
  }
})
