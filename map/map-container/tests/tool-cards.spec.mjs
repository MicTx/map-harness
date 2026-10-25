import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CARD_LINES, TOOL_CARD_DICTIONARY, cardLinesOf, cardTitleOf, errorLinesOf, toolCardEntryOf } from '../src/tool-cards/index.ts'
import { toolCardModelOf } from '../src/client/tool-card-model.ts'

const KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'fetch', 'other'])
const D = TOOL_CARD_DICTIONARY
const result = (argsRaw, value, isError = false) => ({ phase: 'result', argsRaw, text: typeof value === 'string' ? value : JSON.stringify(value), isError, interrupted: false })

test('entries name a Chinese action and a known kind', () => {
  for (const [name, entry] of Object.entries(D)) {
    assert.match(entry.action, /\p{Script=Han}/u, name)
    assert.doesNotMatch(entry.action, /_/, name)
    assert.ok(KINDS.has(entry.kind), name)
  }
  assert.equal(toolCardEntryOf('bash'), undefined)
  assert.equal(toolCardEntryOf('toString'), undefined)
})

test('titles summarize the key argument and hide geometry payloads', () => {
  assert.equal(cardTitleOf(D.map_add_layer, { name: '学校分布', path: 'data/sub/schools.geojson' }), '添加图层 · 学校分布')
  assert.equal(cardTitleOf(D.map_set_view, { center: [120.15312, 30.28745], zoom: 12 }), '移动视图 · 120.153°E, 30.287°N')
  assert.deepEqual(cardLinesOf(D.map_draw.args, undefined), [])
  const lines = cardLinesOf(D.map_draw.args, { kind: 'polygon', coordinates: [[1, 2], [3, 4], [5, 6]], label: '入口' })
  assert.deepEqual(lines.map(l => `${l.label}:${l.text}`), ['标注:入口', '类型:面', '顶点数:3 个'])
})

test('values carry units and nested result members resolve', () => {
  const buffer = cardLinesOf(D.geo_buffer.result, { distance_m: 1500, area_m2: 2_500_000, status: 'succeeded' })
  assert.deepEqual(buffer.slice(0, 2).map(l => l.text), ['1.5 公里', '2.5 平方公里'])
  const layer = cardLinesOf(D.map_add_layer.result, { layer: { name: '学校', featureCount: 1280 }, total_layers: 3 })
  assert.deepEqual(layer.map(l => l.text), ['学校', '1,280 个', '3 个'])
})

test('error lines split the stable code from the reason', () => {
  assert.deepEqual(errorLinesOf('CRS_UNKNOWN: EPSG:9999 is not supported\nstack'), [
    { label: '错误码', text: 'CRS_UNKNOWN' }, { label: '原因', text: 'EPSG:9999 is not supported' },
  ])
  assert.deepEqual(errorLinesOf('plain failure'), [{ label: '原因', text: 'plain failure' }])
})

test('row model follows the call lifecycle', () => {
  const e = D.geo_area
  assert.equal(toolCardModelOf(e, { phase: 'preparing' }).state, 'preparing')
  const running = toolCardModelOf(e, { phase: 'start', argsRaw: '{"path":"a/b.geojson"}' })
  assert.deepEqual([running.state, running.title], ['running', '计算面积 · b.geojson'])
  const ok = toolCardModelOf(e, result('{"path":"b.geojson"}', { area_m2: 3200, status: 'succeeded' }))
  assert.deepEqual([ok.state, ok.result[0].text], ['ok', '3,200 平方米'])
  const failed = toolCardModelOf(e, result('{"path":"b.geojson"}', 'INVALID_GEOJSON: no features', true))
  assert.deepEqual([failed.state, failed.result.at(-1).text], ['error', 'no features'])
  const stopped = toolCardModelOf(e, { ...result(null, ''), interrupted: true })
  assert.deepEqual([stopped.state, stopped.title, stopped.raw], ['stopped', '计算面积', null])
})

test('malformed or partial input degrades to the action name', () => {
  for (const entry of Object.values(D)) {
    for (const argsRaw of ['', '{"pa', 'null', '[]', '{"center":"x","bbox":[1],"coordinates":5}']) {
      const model = toolCardModelOf(entry, { phase: 'start', argsRaw })
      assert.ok(model.title.startsWith(entry.action))
      assert.ok(model.args.length <= MAX_CARD_LINES)
    }
    assert.equal(toolCardModelOf(entry, result('{}', 'not json')).result.length, 0)
  }
})
