/**
 * Snapshot composition units: baseline vs increment selection against the
 * visible surface, digest dedupe, method-card rendering, and stop advisories.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeBudgetNotice, composeSnapshot, digestOf, isDuplicate, lastVisibleLinesOf, visibleInjectionsOf, MAX_SNAPSHOT_EVIDENCE, STOP_NOTICE_RESERVE_BYTES } from '../src/snapshot.ts'
import { evaluateStops, selectCards, METHOD_CARDS } from '../src/cards.ts'
import { initialSpatialContextState, parseSnapshotHeader } from '../src/protocol.ts'
import { DEFAULT_BUDGET_CONFIG } from '../src/budget.ts'

const BUDGET = DEFAULT_BUDGET_CONFIG

function frameOf(overrides = {}) {
  const base = initialSpatialContextState()
  return {
    ...base,
    budget: { ...base.budget, ...(overrides.budgetDelta ?? {}) },
    ...overrides,
    goal: overrides.goal === undefined ? {
      questionId: 'q-0',
      goalRevision: 1,
      question: '定位覆盖不足的社区，用缓冲和相交检查，并核对证据结论',
      sourceSeq: 0,
      sourceKind: 'user-message',
      acceptedAt: 1_000,
    } : overrides.goal,
  }
}

function inputsOf(frame, overrides = {}) {
  return {
    frame,
    mapRevision: 2,
    mapLayerCount: 1,
    mapLayers: [{ id: 'community', name: '社区', visible: true }],
    mapView: { center: [116.4, 39.9], zoom: 9, wkid: 4326 },
    mapAoi: null,
    budget: BUDGET,
    nowMs: 2_000,
    ...overrides,
  }
}

test('the first composition is a full baseline carrying goal, plan, map, cards, and budget', () => {
  const frame = frameOf()
  const composed = composeSnapshot(inputsOf(frame), [])
  assert.ok(composed, 'a goal without visible snapshots composes a baseline')
  assert.equal(composed.kind, 'baseline')
  const header = parseSnapshotHeader(composed.text)
  assert.ok(header)
  assert.equal(header.kind, 'baseline')
  assert.equal(header.goal, 1)
  assert.equal(header.digest, digestOf(composed.text.split('\n').slice(1).join('\n')), 'the digest covers the body')
  assert.ok(composed.text.includes('goalRevision=1'), 'the goal revision is rendered')
  assert.ok(composed.text.includes('q-0'))
  assert.ok(composed.text.includes('地图: revision=2'), 'the map snapshot is bounded into the baseline')
  assert.ok(composed.text.includes('视窗: center=[116.4, 39.9] zoom=9 wkid=4326'), 'the viewport is rendered distinctly from the AOI')
  assert.ok(composed.text.includes('AOI: 未设置'), 'an unset AOI is stated, never conflated with the viewport')
  assert.ok(composed.text.includes('待定调用=0'), 'the pending-call count is stated')
  assert.ok(composed.text.includes('[locate v2]'), 'the locate card is selected by the question keywords')
  assert.ok(composed.text.includes('[topology v2]'), 'buffer/相交 keywords select the topology card')
  assert.ok(composed.text.includes('decision_update'), 'available tools are listed')
  assert.ok(composed.text.includes('停止建议: none'), 'no stop advisory while work may proceed')
  assert.ok(composed.bytes > 0)
})

test('the model context distinguishes agent candidate decisions from user review', () => {
  const input = inputsOf(frameOf(), {
    mapProposals: [{ id: 'candidate-1', name: 'Roof', status: 'agent-applied' }],
    mapChanges: [{ id: 'change-1', name: 'Road', status: 'agent-dismissed' }],
  })
  const composed = composeSnapshot(input, [])
  assert.ok(composed.text.includes('candidate-1=Roof(Agent 已应用)'))
  assert.ok(composed.text.includes('change-1=Road(Agent 已排除)'))
})

test('an increment lists only what settled after the last admitted snapshot', () => {
  const frame = frameOf({
    evidence: [{ evidenceId: 'ev-9', seq: 9, kind: 'analysis-result', tool: 'geo_buffer', status: 'succeeded', ref: 'res-a@v1', scanFeatures: 1, limitations: [] }],
  })
  const baselineVisible = [{ seq: 5, kind: 'baseline', goal: 1, digest: '0'.repeat(16) }]
  const increment = composeSnapshot(inputsOf(frame), baselineVisible)
  assert.ok(increment, 'new evidence composes an increment')
  assert.equal(increment.kind, 'increment')
  assert.ok(increment.text.includes('[ev-9]'), 'the increment lists the new evidence entry')
  assert.ok(!increment.text.includes('goalRevision='), 'the increment does not repeat the baseline goal block')

  // Nothing new: no injection at all.
  const quiet = composeSnapshot(inputsOf(frameOf()), baselineVisible)
  assert.equal(quiet, undefined, 'no new facts compose no message')

  // Nothing visible at all (compaction hid the baseline): full baseline again.
  const afterCompaction = composeSnapshot(inputsOf(frame), [])
  assert.equal(afterCompaction.kind, 'baseline', 'a hidden baseline is rebuilt as a full bounded baseline')

  // An older goal's snapshots do not count as the current baseline.
  const staleGoal = composeSnapshot(inputsOf(frame), [{ seq: 4, kind: 'baseline', goal: 0, digest: '1'.repeat(16) }])
  assert.equal(staleGoal.kind, 'baseline', 'an old-goal baseline never suppresses the new goal')
})

test('an identical visible snapshot suppresses re-injection', () => {
  const frame = frameOf()
  const composed = composeSnapshot(inputsOf(frame), [])
  assert.ok(composed)
  const visible = visibleInjectionsOf([{ seq: 3, text: composed.text }])
  assert.equal(visible.length, 1)
  assert.equal(isDuplicate(composed, visible), true, 'the exact snapshot is already visible')
  assert.equal(isDuplicate(composed, []), false)
})

test('rendered method cards state their outputs so the evidence form is visible at the decision point', () => {
  const composed = composeSnapshot(inputsOf(frameOf()), [])
  assert.match(composed.text, /^ {2}输出: 定位结果及其来源引用/m, 'the locate card renders its outputs line')
  assert.match(composed.text, /^ {2}输出: 分析结果指标与单位/m, 'the topology card renders its outputs line')
})

const SINCE = [{ seq: 3, kind: 'baseline', goal: 1, digest: '0'.repeat(16) }]

function linesSeenAfter(...texts) {
  return lastVisibleLinesOf(texts.map((text, at) => ({ seq: 3 + at, text })))
}

function blockedPlan(goalRevision = 1) {
  return { planRevision: 1, goalRevision, questionId: 'q-0', methods: [], steps: [], gaps: [{ id: 'gap-net', description: '缺路网', status: 'blocked' }], sourceSeq: 2 }
}

test('an increment re-renders the map lines that differ from what the model last saw', () => {
  const frame = frameOf()
  const baseline = composeSnapshot(inputsOf(frame), [])
  const lastLines = linesSeenAfter(baseline.text)
  assert.equal(composeSnapshot(inputsOf(frame, { lastLines }), SINCE), undefined, 'an unchanged map adds nothing')

  const changed = composeSnapshot(inputsOf(frame, {
    lastLines,
    mapLayerCount: 2,
    mapLayers: [{ id: 'community', name: '社区', visible: true }, { id: 'ring', name: '缓冲500m', visible: false }],
    mapAoi: { name: '核心区', ring: [[116.2, 39.85], [116.3, 39.85], [116.3, 39.95], [116.2, 39.95]] },
    mapProposals: [{ id: 'candidate-1', name: 'Roof', status: 'accepted' }],
  }), SINCE)
  assert.ok(changed, 'a layer, AOI, or candidate change composes an increment')
  assert.equal(changed.kind, 'increment')
  assert.ok(changed.text.includes('ring=缓冲500m(隐藏)'), 'the new layer and its visibility are stated')
  assert.match(changed.text, /^AOI: 核心区 外接框=/m, 'the AOI the user set replaces the stale unset line')
  assert.ok(changed.text.includes('candidate-1=Roof(已接受)'), 'the reviewed candidate is stated')
  assert.ok(!changed.text.includes('视觉变化候选:'), 'a line that did not change is not repeated')
  assert.ok(!changed.text.includes('目标:'), 'the increment does not repeat the baseline goal block')
})

test('a stop advisory that appears after the baseline reaches the model and does not repeat while it holds', () => {
  const frame = frameOf()
  const baseline = composeSnapshot(inputsOf(frame), [])
  const lastLines = linesSeenAfter(baseline.text)

  const blocked = composeSnapshot(inputsOf(frameOf({ plan: blockedPlan() }), { lastLines }), SINCE)
  assert.ok(blocked, 'a changed stop advisory composes an increment even with no new fact')
  assert.match(blocked.text, /^停止建议: blocked — /m)

  const late = 1_000 + BUDGET.maxElapsedMs + 5
  const exhausted = composeSnapshot(inputsOf(frame, { lastLines, nowMs: late }), SINCE)
  assert.ok(exhausted, 'an exhausted time budget is delivered instead of staying silent')
  assert.match(exhausted.text, /^停止建议: budget — .*time-exhausted/m)

  const seen = linesSeenAfter(baseline.text, exhausted.text)
  const visible = [...SINCE, { seq: 4, kind: 'increment', goal: 1, digest: exhausted.digest }]
  assert.equal(composeSnapshot(inputsOf(frame, { lastLines: seen, nowMs: late + 90_000 }), visible), undefined, 'the elapsed counter alone never re-injects')
})

test('the budget notice is a fixed-form increment that fits the reserve and dedupes by digest', () => {
  const notice = composeBudgetNotice(1, 1_000)
  const header = parseSnapshotHeader(notice.text)
  assert.ok(header, 'the notice carries a parseable snapshot header')
  assert.equal(header.kind, 'increment')
  assert.equal(header.goal, 1)
  assert.match(notice.text, /^停止建议: budget — .*context-bytes-exhausted/m)
  assert.ok(notice.bytes < STOP_NOTICE_RESERVE_BYTES, `the notice (${notice.bytes} B) fits the reserve (${STOP_NOTICE_RESERVE_BYTES} B)`)
  assert.equal(composeBudgetNotice(1, 1_000).digest, notice.digest, 'the body is stable, so a visible notice suppresses a repeat')
  assert.equal(composeBudgetNotice(2, 1_000).digest, notice.digest, 'the budget is per task, so one visible notice covers every goal')
  assert.equal(isDuplicate(notice, visibleInjectionsOf([{ seq: 5, text: notice.text }])), true)
})

test('a plan written for an earlier goal is labelled, never silently dropped or trusted', () => {
  const goal = { questionId: 'q-5', goalRevision: 2, question: '继续', sourceSeq: 5, sourceKind: 'user-message', acceptedAt: 1_000 }
  const frame = frameOf({ goal, plan: blockedPlan(1) })
  const stop = evaluateStops(frame, undefined)
  assert.equal(stop.kind, 'blocked', 'a follow-up message does not clear a blocked gap')
  assert.match(stop.reason, /旧目标/)
  assert.equal(evaluateStops(frameOf({ plan: blockedPlan(1) }), undefined).reason.includes('旧目标'), false, 'a plan for the current goal carries no label')
  const composed = composeSnapshot(inputsOf(frame), [])
  assert.match(composed.text, /^计划: planRevision=1 .*写于旧目标/m)
  assert.ok(composed.text.includes('goal_revision=2'), 'the label names the revision a new update must cite')
})

test('cards select deterministically and stop advisories downgrade honestly', () => {
  // Evidence-check card triggers only with evidence + decision wording.
  const empty = initialSpatialContextState()
  assert.deepEqual(selectCards(empty), [], 'no goal: no cards')

  const frame = frameOf({
    evidence: [{ evidenceId: 'ev-1', seq: 1, kind: 'catalog-result', tool: 'catalog_resolve', status: 'succeeded', limitations: [] }],
  })
  const cards = selectCards(frame)
  assert.ok(cards.some(card => card.id === 'evidence-check'), 'evidence + decision wording selects the check card')
  assert.ok(cards.every(card => card.version >= 1), 'cards carry their controlled-knowledge version')
  assert.equal(METHOD_CARDS.length, 11, 'the controlled set includes single-image and two-image visual discovery')

  // Blocked gap → blocked advisory, never success.
  const blocked = frameOf({
    plan: { planRevision: 1, goalRevision: 1, questionId: 'q-0', methods: [], steps: [], gaps: [{ id: 'gap-net', description: '缺路网', status: 'blocked' }], sourceSeq: 2 },
  })
  assert.equal(evaluateStops(blocked, undefined).kind, 'blocked')

  // Open gaps without any evidence → not_applicable (no default values as evidence).
  const missingData = frameOf({
    plan: { planRevision: 1, goalRevision: 1, questionId: 'q-0', methods: [], steps: [], gaps: [{ id: 'gap-data', description: '缺人口', status: 'open' }], sourceSeq: 2 },
  })
  assert.equal(evaluateStops(missingData, undefined).kind, 'not_applicable')

  // Open gaps with evidence → partial delivery.
  const partial = frameOf({
    evidence: [{ evidenceId: 'ev-1', seq: 1, kind: 'catalog-result', tool: 'catalog_resolve', status: 'succeeded', limitations: [] }],
    plan: { planRevision: 1, goalRevision: 1, questionId: 'q-0', methods: [], steps: [], gaps: [{ id: 'gap-data', description: '缺人口', status: 'open' }], sourceSeq: 2 },
  })
  assert.equal(evaluateStops(partial, undefined).kind, 'partial')

  // Budget refusal → budget advisory naming the counter.
  const budgetStop = evaluateStops(frameOf(), { code: 'steps-exhausted', used: 64, limit: 64 })
  assert.equal(budgetStop.kind, 'budget')
  assert.ok(budgetStop.reason.includes('steps-exhausted'))

  // unknown/not_applicable statuses never render as success in the ledger line.
  const unknown = frameOf({
    evidence: [{ evidenceId: 'ev-2', seq: 2, kind: 'analysis-result', tool: 'geo_area', status: 'unknown', limitations: [] }],
  })
  const composed = composeSnapshot(inputsOf(unknown), [])
  assert.ok(composed.text.includes('geo_area unknown'), 'unknown status stays unknown in the snapshot')
})

test('evidence lines state the reported values, the claim level, and an earlier goal', () => {
  const goal = { questionId: 'q-5', goalRevision: 2, question: '继续', sourceSeq: 5, sourceKind: 'user-message', acceptedAt: 1_000 }
  const evidence = [
    { evidenceId: 'ev-7', seq: 7, kind: 'analysis-result', tool: 'attribution_association', status: 'succeeded', limitations: [], metrics: [{ name: 'rho', value: 0.42 }], claimLevel: 'association', goalRevision: 1 },
    { evidenceId: 'ev-9', seq: 9, kind: 'analysis-result', tool: 'geo_area', status: 'succeeded', limitations: [], metrics: [{ name: 'area', value: 12.5, unit: 'm²' }, { name: 'perimeter', value: null }], goalRevision: 2 },
  ]
  const composed = composeSnapshot(inputsOf(frameOf({ goal, evidence })), [])
  const earlier = composed.text.split('\n').find(line => line.includes('[ev-7]'))
  const current = composed.text.split('\n').find(line => line.includes('[ev-9]'))
  assert.match(earlier, /rho=0\.42 claim=association \[旧目标 goalRevision=1\]/)
  assert.match(current, /area=12\.5 m², perimeter=无/, 'values render with units and a missing value is stated')
  assert.doesNotMatch(current, /旧目标/, 'evidence for the current goal carries no label')
})

test('snapshot bounds hold for evidence rendering', () => {
  const evidence = Array.from({ length: MAX_SNAPSHOT_EVIDENCE + 4 }, (_, at) => ({
    evidenceId: `ev-${at}`, seq: at + 1, kind: 'analysis-result', tool: 'geo_area', status: 'succeeded', limitations: [],
  }))
  const composed = composeSnapshot(inputsOf(frameOf({ evidence })), [])
  const lines = composed.text.split('\n').filter(line => line.includes('[ev-'))
  assert.equal(lines.length, MAX_SNAPSHOT_EVIDENCE, 'only the bounded newest evidence renders')
})

test('a candidate revoked after its resolve renders the explicit unavailable marker, never silently', () => {
  const resources = [{
    ref: 'res-aaaabbbbccccddddeeeeffff@v1',
    contentDigest: 'deadbeefdeadbeefdeadbeefdeadbeef',
    schemaDigest: 'feedfacefeedfacefeedfacefeedface',
    nativeCrs: 'EPSG:4326',
    featureCount: 2,
    authorization: 'local',
    presentedAt: 3,
  }]
  const composed = composeSnapshot(inputsOf(frameOf({ resources }), {
    refAvailability: ref => (ref === resources[0].ref ? 'revoked' : 'unknown'),
  }), [])
  assert.ok(composed, 'a candidate-bearing frame composes a baseline')
  assert.match(composed.text, /已撤权/, 'the revoked candidate carries the unavailable marker')
  assert.match(composed.text, /不会被远程召回或擦除/, 'the marker restates the copy limit instead of an erasure promise')
  assert.ok(composed.text.includes(resources[0].ref), 'the candidate itself stays listed (not silently dropped)')

  const tombstoned = composeSnapshot(inputsOf(frameOf({ resources }), {
    refAvailability: () => 'tombstoned',
  }), [])
  assert.match(tombstoned.text, /已标记不可用/, 'tombstone is expressed distinctly from revocation')

  // A recalled candidate renders its own marker: future use is refused and
  // the note promises no erasure of existing copies — distinct from both the
  // revoked and tombstoned markers.
  const recalled = composeSnapshot(inputsOf(frameOf({ resources }), {
    refAvailability: () => 'recalled',
  }), [])
  assert.match(recalled.text, /已召回/, 'recall is expressed distinctly from revocation and tombstone')
  assert.match(recalled.text, /召回不擦除已存在的副本/, 'the recall marker states the no-erasure boundary')
  assert.doesNotMatch(recalled.text, /已撤权/)
  assert.ok(recalled.text.includes(resources[0].ref), 'the recalled candidate stays listed (not silently dropped)')

  // Without governance gating (no catalog unit mounted) the line stays as before.
  const ungated = composeSnapshot(inputsOf(frameOf({ resources })), [])
  assert.doesNotMatch(ungated.text, /已撤权/)
  // An available candidate renders without any marker.
  const available = composeSnapshot(inputsOf(frameOf({ resources }), { refAvailability: () => 'available' }), [])
  assert.doesNotMatch(available.text, /已撤权/)
})

test('layer visibility, AOI-vs-viewport, pending calls, and clipping render honestly', () => {
  const frame = frameOf({
    pendingCalls: [{ callId: 'p1', callSeq: 7, name: 'run_get' }],
  })
  const nineLayers = Array.from({ length: 9 }, (_, at) => ({ id: `layer-${at + 1}`, name: `层${at + 1}`, visible: at !== 1 }))
  const composed = composeSnapshot(inputsOf(frame, {
    mapLayerCount: 9,
    mapLayers: nineLayers,
    mapView: { center: [121.5, 31.2], zoom: 8, wkid: 4326 },
    mapAoi: { name: '核心区', ring: [[116.2, 39.85], [116.3, 39.85], [116.3, 39.95], [116.2, 39.95]] },
  }), [])
  assert.ok(composed)
  assert.ok(composed.text.includes('待定调用=1'), 'unsettled spatial calls are visible')
  assert.ok(composed.text.includes('layer-1=层1(显示)'))
  assert.ok(composed.text.includes('layer-2=层2(隐藏)'), 'hidden layers are stated, never presented as visible')
  assert.ok(composed.text.includes('另有 1 层未列出'), 'the layer list clips at eight with an explicit note')
  const viewportLine = composed.text.split('\n').find(l => l.startsWith('视窗:'))
  const aoiLine = composed.text.split('\n').find(l => l.startsWith('AOI:'))
  assert.ok(viewportLine.includes('center=[121.5, 31.2]'))
  assert.match(aoiLine, /AOI: 核心区 外接框=\[116\.2, 39\.85, 116\.3, 39\.95\]/)
  assert.notEqual(viewportLine, aoiLine, 'the viewport and the AOI are distinct facts')
})

test('the map block composes from the current projection, so an undone layer is gone', () => {
  const frame = frameOf()
  const before = composeSnapshot(inputsOf(frame, {
    mapLayerCount: 2,
    mapLayers: [{ id: 'zones', name: '研究区', visible: true }, { id: 'ghost', name: '已撤销', visible: true }],
    mapRevision: 4,
  }), [])
  assert.ok(before.text.includes('ghost=已撤销'))
  // The undo folded: revision moved and the compensated layer left the
  // authoritative projection — the context renders the post-undo truth.
  const after = composeSnapshot(inputsOf(frame, {
    mapLayerCount: 1,
    mapLayers: [{ id: 'zones', name: '研究区', visible: true }],
    mapRevision: 5,
  }), [])
  assert.ok(!after.text.includes('ghost'), 'an undone layer is not presented as present')
  assert.ok(after.text.includes('revision=5'), 'the post-undo revision is the one cited')
})

test('the user viewport and map environment enter the baseline, and an increment only after the user moved', () => {
  const frame = frameOf()
  const userViewport = { center: [121.47, 31.23], zoom: 12.4, extent: [121.4, 31.2, 121.55, 31.27], wkid: 4326, mode: 'map' }
  const baseline = composeSnapshot(inputsOf(frame, { userViewport, mapEnvironment: { mode: 'map', basemap: 'Esri World Imagery 影像' } }), [])
  assert.ok(baseline.text.includes('用户视窗: center=[121.47, 31.23] zoom=12.4 可见范围=[121.4, 31.2, 121.55, 31.27]'))
  assert.ok(baseline.text.includes('地图环境: 2D 地图, 底图=Esri World Imagery 影像'))
  const header = parseSnapshotHeader(baseline.text)
  const visible = [{ seq: 5, kind: 'baseline', goal: header.goal, digest: header.digest }]
  const lastLines = lastVisibleLinesOf([{ seq: 5, text: baseline.text }])
  assert.equal(lastLines['用户视窗:'], baseline.text.split('\n').find(line => line.startsWith('用户视窗:')), 'the visible viewport line is tracked')
  assert.equal(composeSnapshot(inputsOf(frame, { userViewport, lastLines }), visible), undefined, 'an unmoved camera adds nothing')
  const moved = composeSnapshot(inputsOf(frame, { userViewport: { ...userViewport, center: [113.26, 23.13] }, lastLines }), visible)
  assert.equal(moved.kind, 'increment')
  assert.ok(moved.text.includes('用户视窗: center=[113.26, 23.13]'))
})
