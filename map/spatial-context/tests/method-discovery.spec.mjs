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
  ['topology', '对设施做 500 米缓冲并计算面积与相交'],
  ['network', '评估社区的路网可达与通勤覆盖'],
  ['statistics', '分区统计均值并做热点与自相关分析'],
  ['spatiotemporal', '分析人口的时序变化与流动模式'],
  ['site-selection', '做新站点选址优化与需求预测'],
  ['terrain', '计算坡度与可视域视线分析'],
]

test('every analysis family is discoverable with prerequisites, parameters, units, limitations, and stops', () => {
  assert.equal(METHOD_CARD_SET_VERSION, 6, 'the controlled-knowledge set revision advanced')
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
  assert.equal(METHOD_CARDS.length, 11)
})

test('a buffer never impersonates a road network: discovery separates the families', () => {
  const bufferQuestion = selectCards(frameWith('给设施做缓冲范围分析'))
  assert.ok(bufferQuestion.some(card => card.id === 'topology'))
  assert.ok(!bufferQuestion.some(card => card.id === 'network'), 'a buffer ask selects geometry, not network')

  const network = METHOD_CARDS.find(card => card.id === 'network')
  assert.ok(network.misjudgments.some(line => line.includes('缓冲冒充路网')), 'the network card rejects buffer substitution explicitly')
  assert.ok(network.preconditions.some(line => line.includes('run_*')), 'network reachability must come from the run tools')

  const geometry = METHOD_CARDS.find(card => card.id === 'topology')
  assert.ok(geometry.misjudgments.some(line => line.includes('不是路网可达')), 'the geometry card bounds its own claim')
})

test('unknown CRS, denominator-free rates, and correlation-as-causation are named refusals', () => {
  const geometry = METHOD_CARDS.find(card => card.id === 'topology')
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

test('visualization discovery names the real recommendation entry and refuses capability substitution', () => {
  const selected = selectCards(frameWith('为这些点选可视化方法，绘制热力专题图'))
  const card = selected.find(entry => entry.id === 'visualization')
  assert.ok(card)
  assert.ok(card.preconditions.some(text => text.includes('viz_recommend')))
  assert.ok(card.stopConditions.some(text => text.includes('unsupported')))
  assert.ok(card.misjudgments.some(text => text.includes('热力颜色不是显著性热点')))
})

test('two-image visual-change discovery stays exclusive and refuses inferred dates', () => {
  const selected = selectCards(frameWith('比较两期影像，标出新增或消失的变化候选'))
  const change = selected.find(entry => entry.id === 'visual-change-candidates')
  assert.ok(change, 'a two-image question discovers the visual-change card')
  assert.ok(change.preconditions.some(text => text.includes('map_compare_views')), 'the card requires both saved images and a comparison id')
  assert.ok(change.outputs.some(text => text.includes('没有面积、发生日期或精度')))
  assert.ok(change.misjudgments.some(text => text.includes('发布日当当地拍摄日')))
  const single = selectCards(frameWith('圈出画面里的蓝色三角形'))
  assert.ok(single.some(card => card.id === 'visual-candidates'), 'a single-image ask still selects the V6 card')
  assert.ok(!single.some(card => card.id === 'visual-change-candidates'), 'a single-image ask does not select the two-image card')
})

test('discovery stays bounded: at most MAX_RENDERED_CARDS render, evidence-check first', () => {
  const everything = '选址预测的地形坡度可视域统计热点时序流动路网可达缓冲面积距离的结论依据'
  const selected = selectCards(frameWith(everything, [{ evidenceId: 'ev-1', seq: 2, kind: 'analysis-result', tool: 'geo_buffer', status: 'succeeded', limitations: [] }]))
  assert.ok(selected.length <= MAX_RENDERED_CARDS, `bounded to ${MAX_RENDERED_CARDS} (got ${selected.length})`)
  assert.equal(selected[0].id, 'evidence-check', 'the conclusion guard keeps priority')

  const none = selectCards(frameWith(null))
  assert.deepEqual(none, [], 'no goal selects nothing')
})

function withPlan(frame, names) {
  return { ...frame, plan: { planRevision: 1, goalRevision: 1, questionId: 'q-1', methods: names.map(name => ({ name })), steps: [], gaps: [], sourceSeq: 2 } }
}

// [question, card ids that must be selected, card ids that must not be selected]
const SELECTION_TRUTH_TABLE = [
  ['做一张人口热力可视化专题图', ['visualization'], ['terrain']],
  ['做一个视线与可视域分析', ['terrain'], ['visualization']],
  ['这里有多少医院', ['locate'], []],
  ['计算附近学校的数量', ['locate'], []],
  ['district demand forecast by demographic group', ['site-selection'], ['terrain']],
  ['load the DEM and read the slope', ['terrain'], []],
  ['对设施做 500 米缓冲并计算面积与相交', ['topology'], ['network']],
  ['what is the map container state', [], ['topology']],
]

test('selection truth table: no substring collisions and no silent misses', () => {
  for (const [question, included, excluded] of SELECTION_TRUTH_TABLE) {
    const ids = selectCards(frameWith(question)).map(card => card.id)
    for (const id of included) assert.ok(ids.includes(id), `${question} should select ${id} (got ${ids.join(',') || 'none'})`)
    for (const id of excluded) assert.ok(!ids.includes(id), `${question} must not select ${id} (got ${ids.join(',')})`)
  }
})

test('causal wording selects the evidence guard before any evidence settles', () => {
  for (const question of ['这个影响因素和房价有因果关系吗', '哪些因素导致了空置率上升', '对房价做归因分析']) {
    assert.ok(selectCards(frameWith(question)).some(card => card.id === 'evidence-check'), question)
  }
  assert.ok(!selectCards(frameWith('为什么空置率偏高')).some(card => card.id === 'evidence-check'), 'plain explanation wording still needs settled evidence')
})

test('plan methods keep their cards across follow-up questions, within the render bound', () => {
  assert.deepEqual(selectCards(frameWith('继续')), [], 'a bare follow-up without a plan selects nothing')
  assert.deepEqual(selectCards(withPlan(frameWith('继续'), ['network'])).map(card => card.id), ['network'])
  assert.deepEqual(selectCards(withPlan(frameWith('继续'), ['not-a-card'])), [], 'unknown method names never select a card')
  const crowded = selectCards(withPlan(frameWith('做一张人口热力可视化专题图并统计热点和时序变化'), ['network', 'terrain']))
  assert.ok(crowded.length <= MAX_RENDERED_CARDS, `bounded to ${MAX_RENDERED_CARDS} (got ${crowded.length})`)
  assert.ok(crowded.some(card => card.id === 'visualization'), 'current-question matches rank before sticky cards')
})

test('buffer, area, and overlay guidance lives on one topology card', () => {
  assert.ok(!METHOD_CARDS.some(card => card.id === 'geometry'), 'the geometry card is merged into topology')
  const topology = METHOD_CARDS.find(card => card.id === 'topology')
  assert.ok(topology.triggers.includes('面积'), 'area questions still select the card')
  assert.ok(topology.misjudgments.some(line => line.includes('不是路网可达')), 'a buffer is still not network reachability')
  assert.ok(topology.stopConditions.some(line => line.includes('未知 CRS')), 'unknown CRS still refuses computation')
})

test('count questions carry the study-area and source-coverage guard on the locate card', () => {
  const locate = METHOD_CARDS.find(card => card.id === 'locate')
  assert.ok(locate.preconditions.some(line => line.includes('去重')), 'counting dedupes before it reports a number')
  assert.ok(locate.preconditions.some(line => line.includes('POI')), 'POI source coverage bias is declared')
  assert.ok(locate.stopConditions.some(line => line.includes('map_refine_aoi')), 'an unset study area is resolved before counting')
})
