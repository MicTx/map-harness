import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '../../../packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../packages/core/tools/lib/index.js'
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

test('the unified catalog serves exactly the sixty-four fixed spatial tools with identity rows', () => {
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
    'map_draw',
    'map_fit_view',
    'map_get_state',
    'map_locate',
    'map_observe',
    'map_remove_layer',
    'map_save',
    'map_set_mode',
    'map_set_view',
    'map_undo',
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
  ])
  for (const name of SPATIAL_MCP_TOOL_NAMES) {
    const identity = spatialToolOf(name)
    assert.equal(identity.owner, '@map-harness/map-tools')
    assert.equal(identity.provider, '@map-harness/arcgis-mcp')
    assert.equal(typeof identity.metaSchemaVersion, 'number')
  }
  assert.equal(spatialToolOf('map_add_layer').family, 'map-mutation')
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
