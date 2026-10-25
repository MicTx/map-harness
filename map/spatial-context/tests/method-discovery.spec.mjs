/**
 * Method-knowledge discovery fixtures (task-method-discovery): the six
 * analysis families (geometry / network / statistics / spatiotemporal /
 * site-selection / terrain) stay discoverable through deterministic trigger
 * matching, each carrying its data prerequisites, parameters, units,
 * limitations, and stop conditions — and the negative guidance the migration
 * requires: a buffer never impersonates a road network, an unknown CRS
 * refuses, a rate without a denominator is not a rate, and correlation never
 * impersonates causation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_RENDERED_CARDS, METHOD_CARD_SET_VERSION, METHOD_CARDS, selectCards } from '../src/cards.ts'
import { initialSpatialContextState } from '../src/protocol.ts'

function frameWith(question, evidence = []) {
  const base = initialSpatialContextState()
  return {
    ...base,
    goal: question === null ? null : {
      questionId: 'q-1',
      goalRevision: 1,
      question,
      sourceSeq: 1,
      sourceKind: 'user-message',
      acceptedAt: 1,
    },
    evidence,
  }
}

const FAMILY_QUESTIONS = [
  ['geometry', '对设施做 500 米缓冲并计算面积与相交'],
  ['network', '评估社区的路网可达与通勤覆盖'],
  ['statistics', '分区统计均值并做热点与自相关分析'],
  ['spatiotemporal', '分析人口的时序变化与流动模式'],
  ['site-selection', '做新站点选址优化与需求预测'],
  ['terrain', '计算坡度与可视域视线分析'],
]

test('every analysis family is discoverable with prerequisites, parameters, units, limitations, and stops', () => {
  assert.equal(METHOD_CARD_SET_VERSION, 2, 'the controlled-knowledge set revision advanced')
  for (const [id, question] of FAMILY_QUESTIONS) {
    const selected = selectCards(frameWith(question))
    const card = selected.find(entry => entry.id === id)
    assert.ok(card, `${id} is discoverable from its family question`)
    assert.ok(card.requiredData.length > 0, `${id} states its data prerequisites`)
    assert.ok(card.preconditions.length > 0, `${id} states parameter preconditions`)
    assert.ok(card.outputs.length > 0 && /单位|版本|指标|证据|入账/.test(card.outputs.join('; ')), `${id} states units/versioned outputs`)
    assert.ok(card.misjudgments.length > 0, `${id} states its limitations`)
    assert.ok(card.stopConditions.length > 0, `${id} states stop conditions`)
  }
  // The three P0c cards stay discoverable unchanged.
  for (const [id, question] of [['locate', '这个地名在哪里定位'], ['topology', '用缓冲和相交检查拓扑']]) {
    assert.ok(selectCards(frameWith(question)).some(card => card.id === id), `${id} remains discoverable`)
  }
  assert.equal(METHOD_CARDS.length, 9)
})

test('a buffer never impersonates a road network: discovery separates the families', () => {
  const bufferQuestion = selectCards(frameWith('给设施做缓冲范围分析'))
  assert.ok(bufferQuestion.some(card => card.id === 'geometry'))
  assert.ok(!bufferQuestion.some(card => card.id === 'network'), 'a buffer ask selects geometry, not network')

  const network = METHOD_CARDS.find(card => card.id === 'network')
  assert.ok(network.misjudgments.some(line => line.includes('缓冲冒充路网')), 'the network card rejects buffer substitution explicitly')
  assert.ok(network.preconditions.some(line => line.includes('run_*')), 'network reachability must come from the run tools')

  const geometry = METHOD_CARDS.find(card => card.id === 'geometry')
  assert.ok(geometry.misjudgments.some(line => line.includes('不是路网可达')), 'the geometry card bounds its own claim')
})

test('unknown CRS, denominator-free rates, and correlation-as-causation are named refusals', () => {
  const geometry = METHOD_CARDS.find(card => card.id === 'geometry')
  assert.ok(geometry.stopConditions.some(line => line.includes('未知 CRS')), 'unknown CRS refuses computation')

  const statistics = METHOD_CARDS.find(card => card.id === 'statistics')
  assert.ok(statistics.preconditions.some(line => line.includes('无分母不是率')), 'a rate requires a positive denominator')
  assert.ok(statistics.misjudgments.some(line => line.includes('相关不等于因果')), 'correlation is not causation')

  const siteSelection = METHOD_CARDS.find(card => card.id === 'site-selection')
  assert.ok(siteSelection.misjudgments.some(line => line.includes('相关冒充因果')), 'site selection repeats the causality guard')
  assert.ok(siteSelection.requiredData.some(line => line.includes('forecast_validate')), 'forecasting requires validation first')

  const terrain = METHOD_CARDS.find(card => card.id === 'terrain')
  assert.ok(terrain.preconditions.some(line => line.includes('视锥绘制不是可视域')), 'a view cone is not a viewshed')
})

test('discovery stays bounded: at most MAX_RENDERED_CARDS render, evidence-check first', () => {
  const everything = '选址预测的地形坡度可视域统计热点时序流动路网可达缓冲面积距离的结论依据'
  const selected = selectCards(frameWith(everything, [{ evidenceId: 'ev-1', seq: 2, kind: 'analysis-result', tool: 'geo_buffer', status: 'succeeded', limitations: [] }]))
  assert.ok(selected.length <= MAX_RENDERED_CARDS, `bounded to ${MAX_RENDERED_CARDS} (got ${selected.length})`)
  assert.equal(selected[0].id, 'evidence-check', 'the conclusion guard keeps priority')

  const none = selectCards(frameWith(null))
  assert.deepEqual(none, [], 'no goal selects nothing')
})
