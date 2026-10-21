/**
 * Snapshot composition units: baseline vs increment selection against the
 * visible surface, digest dedupe, method-card rendering, and stop advisories.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { composeSnapshot, digestOf, isDuplicate, visibleInjectionsOf, MAX_SNAPSHOT_EVIDENCE } from '../src/snapshot.ts'
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
  assert.ok(composed.text.includes('[locate v1]'), 'the locate card is selected by the question keywords')
  assert.ok(composed.text.includes('[topology v1]'), 'buffer/相交 keywords select the topology card')
  assert.ok(composed.text.includes('decision_update'), 'available tools are listed')
  assert.ok(composed.text.includes('停止建议: none'), 'no stop advisory while work may proceed')
  assert.ok(composed.bytes > 0)
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

test('cards select deterministically and stop advisories downgrade honestly', () => {
  // Evidence-check card triggers only with evidence + decision wording.
  const empty = initialSpatialContextState()
  assert.deepEqual(selectCards(empty), [], 'no goal: no cards')

  const frame = frameOf({
    evidence: [{ evidenceId: 'ev-1', seq: 1, kind: 'catalog-result', tool: 'catalog_resolve', status: 'succeeded', limitations: [] }],
  })
  const cards = selectCards(frame)
  assert.ok(cards.some(card => card.id === 'evidence-check'), 'evidence + decision wording selects the check card')
  assert.ok(cards.every(card => card.version === 1), 'cards carry their controlled-knowledge version')
  assert.equal(METHOD_CARDS.length, 9, 'the controlled set carries the three P0c cards plus the six analysis families')

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
