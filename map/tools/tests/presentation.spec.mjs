import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '../../../packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../packages/core/tools/lib/index.js'
import * as directTools from '../src/a-index.ts'
import { SPATIAL_MCP_TOOL_NAMES } from '../src/spatial-catalog.ts'
import { PRESENTATION_DICTIONARY, presentCallOf, presentResultOf, withPresentation } from '../src/presentation/index.ts'

const textOf = view => view.content?.map(b => b.text).join('\n') ?? ''

test('the shared dictionary covers exactly the spatial catalog', () => {
  assert.deepEqual(Object.keys(PRESENTATION_DICTIONARY).sort(), [...SPATIAL_MCP_TOOL_NAMES].sort())
})

test('direct registration attaches cards to every catalog tool', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(directTools)
    for (const name of SPATIAL_MCP_TOOL_NAMES) {
      const view = ctx.tools.get(name).presentCall({})
      assert.equal(view.card, 'generic')
      assert.ok(!view.title.includes(name), `${name} title must not show the raw tool name`)
    }
  } finally {
    await ctx.dispose?.()
  }
})

test('a tool without an entry is refused at registration', () => {
  assert.throws(() => withPresentation({ name: 'map_new_tool' }), /no presentation dictionary entry/)
})

test('Host cards render argument and result lines', () => {
  const call = presentCallOf(PRESENTATION_DICTIONARY.map_add_layer, { name: '学校分布', path: 'data/schools.geojson' })
  assert.equal(call.title, '添加图层 · 学校分布')
  assert.equal(call.kind, 'edit')
  assert.match(textOf(call), /- 文件：schools\.geojson/)
  const ok = presentResultOf(PRESENTATION_DICTIONARY.map_add_layer, { name: '学校' },
    { content: [{ type: 'text', text: JSON.stringify({ layer: { name: '学校', featureCount: 128 } }) }], isError: false })
  assert.match(textOf(ok), /要素数：128 个/)
  const failed = presentResultOf(PRESENTATION_DICTIONARY.geo_area, { path: 'a.geojson' },
    { content: [{ type: 'text', text: 'CRS_UNKNOWN: EPSG:9999 is not supported' }], isError: true })
  assert.equal(failed.title, '计算面积 · a.geojson（失败）')
  assert.match(textOf(failed), /错误码：CRS_UNKNOWN/)
})
