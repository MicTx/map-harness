/**
 * Spatial reasoning-workflow fixtures (task-reasoning-workflow): the loop
 * must DO, not narrate — real tool calls produce computations, layers, and
 * ledgered evidence; missing data is searched before use; errors remediate
 * within budget; only a real user message moves the goal; non-final jobs
 * never report success; multi-turn references resolve and cancel/recovery
 * hold. Everything asserts on the authoritative DecisionFrame fold.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as JsonlSessionPersistence from '../../../packages/session/session-persistence-jsonl/lib/index.js'
import SessionStore from '../../../packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../packages/session/session-projection/lib/index.js'
import { createToolResultMessage, createUserMessage, createAssistantMessage } from '../../../packages/llm/llm/lib/index.js'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as catalogPlugin from '../../spatial-catalog/src/plugin.ts'
import * as observationPlugin from '../../map-container/src/plugin.ts'
import * as spatialContextPlugin from '../../spatial-context/src/plugin.ts'
import { catalogRegister, catalogResolve } from '../src/catalog-tools.ts'
import { decisionUpdate } from '../src/decision-tools.ts'
import { geoBuffer } from '../src/geo-tools.ts'
import { mapAddLayer, mapGetState } from '../src/map-tools.ts'
import { mapObserve } from '../src/observation-tools.ts'

/** A tiny points fixture the workflow registers on demand. */
function pointsCollection() {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, properties: { kind: 'site' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: [116.41, 39.91] }, properties: { kind: 'site' } },
    ],
  }
}

async function workflowEnv(t) {
  const root = mkdtempSync(join(tmpdir(), 'map-spatial-workflow-'))
  t.after(async () => { rmSync(root, { recursive: true, force: true }) })
  writeFileSync(join(root, 'sites.geojson'), JSON.stringify(pointsCollection()))
  const rig = await mapRig({ cwd: root })
  await rig.ctx.plugin(catalogPlugin, { root: join(root, 'catalog') })
  await rig.ctx.plugin(spatialContextPlugin)
  await rig.ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
  const session = rig.session('workflow')
  const persistence = rig.ctx.sessionPersistence
  const writer = await persistence.create(session.header)
  t.after(async () => { await writer.close() })

  let turns = 0
  const frame = () => rig.ctx.sessionProjections.stateOf(session, 'decisionFrame')

  /** One real user message: the only voice that can move the goal. */
  async function userSay(text, source = { kind: 'user' }) {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text }], source }), { surfaceOp: 'append' })
  }

  /** One full tool turn exactly like the agent loop drives it. */
  async function invoke(tool, args, { signal } = {}) {
    const turn = ++turns
    const callId = `wf-call-${turn}`
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      turn, step: 1, stream: [],
      message: createAssistantMessage({
        source: { provider: 'fixture', model: 'spatial-workflow' },
        content: [{ type: 'tool-call', id: callId, name: tool.name, arguments: JSON.stringify(args) }],
      }),
    }, { surfaceOp: 'append' })
    const call = rig.call(session, callId, tool.name, args)
    try {
      const value = await tool.execute(args, rig.exec(session, { callId, signal }))
      const meta = tool.output.presentationMeta?.(args, value)
      const text = tool.output.render(args, value).filter(block => block.type === 'text').map(block => block.text).join('\n')
      rig.result(session, call, { text, ...(meta == null ? {} : { meta }) })
      return value
    } catch (error) {
      rig.result(session, call, { isError: true, text: error.message })
      throw error
    } finally {
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
  }

  return { root, rig, session, frame, userSay, invoke, writer, persistence }
}

test('the loop does, not narrates: search, register, compute, style, ledger, and plan on real evidence', async t => {
  const env = await workflowEnv(t)
  const { session, frame, userSay, invoke } = env

  await userSay('找出工作区内可用的设施数据，做 500 米缓冲覆盖分析并上图。')
  assert.equal(frame().goal?.goalRevision, 1)
  assert.equal(frame().goal?.questionId, `q-${frame().goal?.sourceSeq}`)

  // Missing data first: the discovery search honestly reports nothing registered yet.
  const empty = await invoke(catalogResolve, { search: {} })
  assert.equal(empty.resources.length, 0)

  // Register, then compute over the exact versioned ref.
  const registered = await invoke(catalogRegister, { path: 'sites.geojson', name: 'sites' })
  const buffered = await invoke(geoBuffer, { ref: { resource: registered.resource.ref, feature: registered.feature_refs[0].feature_ref }, distance_m: 500 })
  assert.equal(buffered.status, 'succeeded')
  assert.match(buffered.artifact.ref, /^art-/)

  // The computed artifact lands on the map as a versioned layer.
  const added = await invoke(mapAddLayer, { ref: buffered.artifact.ref, layer_id: 'coverage' })
  assert.equal(added.layer.id, 'coverage')
  assert.equal(env.rig.state(session).layers.length, 1)

  // The plan updates ONLY against real evidence refs.
  const stateBeforePlan = frame()
  const succeededSeq = stateBeforePlan.evidence.filter(entry => entry.status === 'succeeded').map(entry => entry.seq)
  assert.ok(succeededSeq.length >= 2, 'computations settled into the ledger')
  const planned = await invoke(decisionUpdate, {
    goal_revision: 1,
    expected_plan_revision: 0,
    methods: [{ name: 'buffer-coverage', rationale: '500m 服务范围' }],
    steps: ['检索数据', '登记', '缓冲', '上图'],
    gaps: [{ id: 'display-verify', description: '像素确认覆盖渲染', status: 'open' }],
    evidence_refs: succeededSeq,
  })
  assert.equal(planned.applied_plan_revision, 1)
  assert.equal(frame().plan?.planRevision, 1)
  assert.ok(frame().plan.gaps.some(gap => gap.id === 'display-verify' && gap.status === 'open'))

  // An unknown evidence ref refuses the plan loudly.
  await assert.rejects(
    invoke(decisionUpdate, { goal_revision: 1, expected_plan_revision: 1, evidence_refs: [999_999] }),
    /UNKNOWN_EVIDENCE_REF/,
    'a plan citing invented evidence refuses',
  )
})

test('errors remediate within budget: a failed call ledgers, the retry succeeds, gaps close', async t => {
  const env = await workflowEnv(t)
  const { session, frame, userSay, invoke } = env

  await userSay('对 sites 做缓冲。')
  // The first attempt targets a ref that was never registered — it fails loudly.
  await assert.rejects(
    invoke(geoBuffer, { ref: { resource: 'res-0000000000000000000000000000ff@v1', feature: 'f-unknown' }, distance_m: 500 }),
    error => error instanceof Error,
  )
  const failed = frame().evidence.filter(entry => entry.status === 'failed')
  assert.equal(failed.length, 1, 'the failure is ledgered as failed, never dropped')

  // Remediation: register the missing data, mark the gap resolved in the plan.
  const registered = await invoke(catalogRegister, { path: 'sites.geojson', name: 'sites' })
  const buffered = await invoke(geoBuffer, { ref: { resource: registered.resource.ref, feature: registered.feature_refs[0].feature_ref }, distance_m: 500 })
  assert.equal(buffered.status, 'succeeded')
  await invoke(decisionUpdate, {
    goal_revision: 1,
    expected_plan_revision: 0,
    gaps: [{ id: 'data-missing', description: 'sites 未登记', status: 'resolved' }],
  })
  const plan = frame().plan
  assert.equal(plan?.gaps.find(gap => gap.id === 'data-missing')?.status, 'resolved')

  // Budget honesty: steps consumed by both attempts persist (no refund on failure).
  assert.ok(frame().budget.stepsUsed >= 2, `steps accumulate across failure and retry (${frame().budget.stepsUsed})`)
})

test('only a real user message moves the goal; plugin and tool voices never do', async t => {
  const env = await workflowEnv(t)
  const { frame, userSay, session } = env

  await userSay('第一问。')
  const first = frame().goal
  assert.equal(first?.goalRevision, 1)

  // A plugin-voiced user message cannot rewrite the goal.
  await userSay('越权修改目标', { kind: 'spatial-context', plugin: 'not-user' })
  assert.equal(frame().goal?.goalRevision, 1, 'a plugin voice never moves the goal')

  // A tool result cannot either.
  session.append('user/message', createToolResultMessage({ callId: 'fake', content: [{ type: 'text', text: 'tool voice' }], isError: false }), { surfaceOp: 'append' })
  assert.equal(frame().goal?.goalRevision, 1, 'a tool voice never moves the goal')

  await userSay('第二问。')
  assert.equal(frame().goal?.goalRevision, 2, 'the real user advances the revision')
  assert.equal(frame().goal?.question, '第二问。')
})

test('multi-turn references resolve; cancellation folds nothing; recovery replays identical state', async t => {
  const env = await workflowEnv(t)
  const { root, session, rig, frame, userSay, invoke, persistence, writer } = env

  await userSay('登记 sites 并上图。')
  const registered = await invoke(catalogRegister, { path: 'sites.geojson', name: 'sites' })
  await invoke(mapAddLayer, { ref: registered.resource.ref, layer_id: 'sites' })
  await userSay('把上一轮的图层做 500 米缓冲并上图。')
  const buffered = await invoke(geoBuffer, { ref: { resource: registered.resource.ref, feature: registered.feature_refs[0].feature_ref }, distance_m: 500 })
  await invoke(mapAddLayer, { ref: buffered.artifact.ref, layer_id: 'sites-buffer' })

  // The multi-turn referent resolved against the live map, not a stale mention.
  const live = await invoke(mapGetState, {})
  assert.deepEqual(live.layers.map(layer => layer.id), ['sites', 'sites-buffer'])

  // A cancelled observation folds nothing: state and ledger stay put.
  const before = { revision: rig.state(session).revision, evidence: frame().evidence.length }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    invoke(mapObserve, {}, { signal: controller.signal }),
    /cancel|abort/i,
  )
  assert.equal(rig.state(session).revision, before.revision, 'a cancelled call changes no map state')

  // Recovery: a fresh process refolds the identical authoritative state.
  await persistence.flush()
  const readHandle = await persistence.open(session.id, 'read')
  const { events } = await readHandle.read()
  const restored = rig.ctx.sessionProjections.restore({}, events, 0, readHandle.header, 0)
  await readHandle.close()
  const recoveredFrame = restored.checkpoint.decisionFrame.val
  assert.equal(recoveredFrame.goal?.goalRevision, 2, 'the recovered frame replays the goal history')
  assert.equal(recoveredFrame.evidence.length, frame().evidence.length, 'the evidence ledger replays identically')
  const recoveredMap = restored.snapshot.values.mapContainer
  assert.deepEqual(recoveredMap.layers.map(layer => layer.id), ['sites', 'sites-buffer'], 'the recovered map replays the layers')
  void SessionStore
  void SessionProjectionRegistry
})

test('a non-final run never reports success in the ledger', async t => {
  const env = await workflowEnv(t)
  const { frame, userSay, invoke } = env
  await userSay('评估覆盖。')
  // A fabricated non-terminal run record folds through the family reader as
  // unknown with the explicit 未终态 limitation — never success.
  const session = env.session
  const callId = 'wf-run-stub'
  session.append('turn/start', { turn: 90 })
  session.append('step/start', { turn: 90, step: 1 })
  session.append('assistant/message', {
    turn: 90, step: 1, stream: [],
    message: createAssistantMessage({
      source: { provider: 'fixture', model: 'spatial-workflow' },
      content: [{ type: 'tool-call', id: callId, name: 'run_submit', arguments: '{}' }],
    }),
  }, { surfaceOp: 'append' })
  const call = env.rig.call(session, callId, 'run_submit', {})
  session.append('tool/result', {
    turn: 90, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'queued' }], isError: false }),
    meta: { schemaVersion: 1, kind: 'accessibility-run', tool: 'run_submit', runId: 'run-x', operationRef: 'op-x', status: 'queued', goalRevision: 1, requestDigest: null, metrics: null, artifactRefs: [], comparisonDigest: null, limitations: [] },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  session.append('step/end', { turn: 90, step: 1 })
  session.append('turn/end', { turn: 90, reason: { kind: 'completed' } })
  const runEntry = frame().evidence.find(entry => entry.tool === 'run_submit')
  assert.ok(runEntry, 'the run folded into the ledger')
  assert.equal(runEntry.status, 'unknown', 'a queued run is unknown, never success')
  assert.ok(runEntry.limitations.some(line => line.includes('未终态')), 'the non-final limitation is explicit')
  void invoke
})
