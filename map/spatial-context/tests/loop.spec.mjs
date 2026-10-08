/**
 * Real-loop composition fixtures (keyless, mock adapter): the pre-step
 * listener injects the bounded baseline ahead of the first admitted request,
 * deduplicates against the visible surface, injects increments after new
 * evidence settles, rebuilds the baseline after compaction hides it, and
 * never starts a request or commits state for reject / empty-first-step /
 * pre-admission cancellation. The model requests themselves are asserted —
 * not just the listener's return value.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId } from '../../../packages/llm/llm/lib/index.js'
import SessionStore, { SessionId } from '../../../packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../packages/session/session-projection/lib/index.js'
import SystemPrompt from '../../../packages/core/system-prompt/lib/index.js'
import ToolRuntime from '../../../packages/core/tools/lib/index.js'
import AgentRegistry from '../../../packages/core/agent/lib/index.js'
import AgentLoop from '../../../packages/core/agent-loop/lib/index.js'
import * as spatialContext from '../src/index.ts'
import * as spatialContextAgent from '../src/agent.ts'
import { decisionUpdate } from '../../tools/src/decision-tools.ts'

const SCX_HEADER = 'spatial-context/snapshot v1'

/** Chunk script helpers over the built llm lib. */
function textResponse(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** A scripted response that calls one tool with JSON arguments. */
function toolCallResponse(rawCallId, name, args) {
  const callId = ToolCallId(rawCallId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson.slice(0, 5) },
    { type: 'tool-call-delta', index: 0, id: callId, argumentsDelta: argumentsJson.slice(5) },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Deterministic mock adapter recording every model request it sees. */
class ScriptAdapter extends LlmAdapter {
  requests = []
  constructor(script) {
    super()
    this.script = script
  }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }
  async *stream(options) {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptAdapter: script exhausted')
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

/** A gate listener mounted BEFORE the spatial-context plugin so tests can force reject/empty/cancel first. */
const gate = { mode: 'pass' }

async function harness(adapter) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.on('agent/pre-step', async (payload, next) => {
    if (gate.mode === 'reject') return { kind: 'reject' }
    if (gate.mode === 'empty-first' && payload.step === 1) return { kind: 'enter', messages: [] }
    if (gate.mode === 'cancel' && payload.step === 1) {
      payload.agent.cancel({ kind: 'user' })
    }
    return next()
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(decisionUpdate)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(spatialContext)
  await ctx.plugin(spatialContextAgent, { budget: { maxModelSteps: 64 } })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('scx-loop'), { provider: 'mock', model: 'mock' })
  return { ctx, agent }
}

function waitForIdle(ctx, agent) {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function frameOf(ctx, agent) {
  return ctx.spatialContext.frameOf(agent.session)
}

/** The snapshot texts a model request carried, in order. */
function requestSnapshots(request) {
  return request.messages
    .map(message => message.content)
    .map(blocks => Array.isArray(blocks)
      ? blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
      : '')
    .filter(text => text.startsWith(SCX_HEADER))
}

function logSnapshotMessages(session) {
  return session.snapshotEvents().filter(event =>
    event.type === 'user/message'
    && (event.data.source.kind === 'spatial-context' || event.data.source.kind === 'plugin')
    && event.data.source.plugin === '@map-harness/spatial-context')
}

const GOAL_TEXT = '定位覆盖不足的社区，用缓冲和相交检查，并核对证据结论'

test('the first admitted request carries the bounded baseline; the snapshot enters the log as a user/message', async () => {
  const adapter = new ScriptAdapter([textResponse('收到')])
  const { ctx, agent } = await harness(adapter)
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: GOAL_TEXT }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    assert.equal(adapter.requests.length, 1, 'exactly one model call ran')
    const snapshots = requestSnapshots(adapter.requests[0])
    assert.equal(snapshots.length, 1, 'the request carried exactly one snapshot message')
    const snapshotText = snapshots[0]
    const [headerLine, ...bodyLines] = snapshotText.split('\n')
    assert.match(headerLine, /^spatial-context\/snapshot v1 kind=baseline goal=1 digest=[0-9a-f]{16}$/)
    const body = bodyLines.join('\n')
    // Keyless model-request snapshot: the exact content the model saw is pinned.
    assert.ok(body.includes(`目标: ${GOAL_TEXT}`), 'the goal text is rendered verbatim')
    assert.ok(body.includes('goalRevision=1, questionId='), 'the goal identity is rendered')
    assert.ok(body.includes('来源=user/message'), 'the goal cites its authorizing message')
    assert.ok(body.includes('计划: 尚无已接受计划'), 'the empty plan state is explicit')
    assert.ok(body.includes('[locate v1]') && body.includes('[topology v1]'), 'question-matched cards render with versions')
    assert.ok(!body.includes('[evidence-check v1]'), 'the evidence-check card stays out before any evidence settles')
    assert.ok(body.includes('预算: steps 0/64'), 'the budget line renders')
    assert.ok(body.includes('停止建议: none'), 'no premature stop advisory')

    // Admission: only the log proves the injection happened.
    const confirmed = logSnapshotMessages(agent.session)
    assert.equal(confirmed.length, 1, 'the snapshot message was accepted as a user/message')
    const frame = frameOf(ctx, agent)
    assert.equal(frame.injections.length, 1, 'the projection confirmed the injection')
    assert.equal(frame.injections[0].form, 'baseline')
    assert.ok(frame.budget.contextBytes > 0, 'context bytes counted the admitted snapshot')
    assert.equal(frame.goal.goalRevision, 1, 'the goal committed from the real user message')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('mid-turn steps inject increments for newly settled facts; unchanged turns inject nothing', async () => {
  // Turn 1: the model asks for a plan update; the accepted result settles
  // plan revision 1; the loop's continuation step claims the tool result (a
  // non-user message) and must see an increment, not a repeated baseline.
  const adapter = new ScriptAdapter([
    toolCallResponse('call-1', 'decision_update', { goal_revision: 1, expected_plan_revision: 0, steps: ['登记资源', '缓冲'], gaps: [{ id: 'gap-net', description: '缺路网', status: 'open' }] }),
    textResponse('计划已记录'),
  ])
  const { ctx, agent } = await harness(adapter)
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: GOAL_TEXT }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    assert.equal(adapter.requests.length, 2, 'step 1 (tool call) and step 2 (continuation) both ran')
    assert.equal(frameOf(ctx, agent).plan?.planRevision, 1, 'the accepted decision_update folded the plan')
    const baseline = requestSnapshots(adapter.requests[0])
    const carried = requestSnapshots(adapter.requests[1])
    assert.equal(baseline.length, 1, 'step 1 carried exactly the baseline')
    assert.equal(carried.length, 2, 'step 2 carried the history baseline plus one increment')
    assert.match(carried[0], /kind=baseline/, 'the step-1 baseline remains in the request history')
    assert.match(carried[1], /kind=increment goal=1/, 'the continuation step saw an increment')
    assert.ok(carried[1].includes('planRevision=1'), 'the increment lists the plan update')
    assert.ok(carried[1].includes('gap-net(open)'), 'the increment lists the new gap')
    assert.equal(frameOf(ctx, agent).injections.length, 2, 'baseline and increment were both admitted')

    // A later turn whose claimed messages carry no new facts and no real
    // user message injects nothing new (followup wakes the idle driver).
    const before = frameOf(ctx, agent).injections.length
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '工具续跑上下文（非用户授权）' }],
      source: { kind: 'plugin', plugin: 'rig' },
    }))
    await waitForIdle(ctx, agent)
    assert.equal(adapter.requests.length, 3, 'the wake ran one more step')
    assert.equal(frameOf(ctx, agent).injections.length, before, 'dedupe suppressed a re-injection')
    assert.equal(requestSnapshots(adapter.requests[2]).length, 2, 'no third snapshot entered the request')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('compaction hiding the baseline rebuilds a full bounded baseline on the next real request', async () => {
  const adapter = new ScriptAdapter([textResponse('ok'), textResponse('重建后')])
  const { ctx, agent } = await harness(adapter)
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: GOAL_TEXT }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Compaction: replace every visible node after the protected system head
    // with one summary message (the upstream surface-replacement contract).
    const session = agent.session
    const nodes = [...session.surface.nodes]
    const startSeq = nodes[1]
    const endSeq = nodes.at(-1)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '压缩摘要：此前对话被压缩；结构化目标与证据以注入为准' }],
      source: { kind: 'plugin', plugin: 'compaction-test' },
    }), { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs: nodes.slice(1) })
    assert.equal(
      [...session.surface.nodes].some((seq) => {
        const event = session.eventAt(seq)
        return event?.type === 'user/message' && event.data.source.plugin === '@map-harness/spatial-context'
      }),
      false,
      'the compaction removed the baseline from the visible surface',
    )

    // A continuation that is not user authority claims the step: the goal
    // stays revision 1, and its baseline is gone from the surface.
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: '工具续跑上下文（非用户授权）' }],
      source: { kind: 'plugin', plugin: 'rig' },
    }))
    await waitForIdle(ctx, agent)
    const snapshots = requestSnapshots(adapter.requests[1])
    assert.equal(snapshots.length, 1)
    assert.match(snapshots[0], /kind=baseline goal=1/, 'the same goal\'s full baseline was rebuilt after compaction')
    assert.ok(snapshots[0].includes(`目标: ${GOAL_TEXT}`), 'the rebuilt baseline re-renders the goal')
    assert.equal(frameOf(ctx, agent).injections.length, 2, 'the rebuilt baseline was admitted')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('reject and empty-first-step never inject and never start a model request', async () => {
  for (const mode of ['reject', 'empty-first']) {
    gate.mode = mode
    const adapter = new ScriptAdapter([])
    const { ctx, agent } = await harness(adapter)
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: GOAL_TEXT }], source: { kind: 'user' } }))
      await waitForIdle(ctx, agent)
      assert.equal(adapter.requests.length, 0, `${mode}: the loop spent no model call`)
      assert.equal(logSnapshotMessages(agent.session).length, 0, `${mode}: nothing was injected`)
      const frame = frameOf(ctx, agent)
      assert.equal(frame.goal, null, `${mode}: the claimed message never entered, so no goal committed`)
      assert.equal(frame.injections.length, 0)
    } finally {
      await ctx.fiber.dispose()
    }
  }
  gate.mode = 'pass'
})

test('cancelling before admission commits no goal, no plan, and no injection', async () => {
  gate.mode = 'cancel'
  const adapter = new ScriptAdapter([])
  const { ctx, agent } = await harness(adapter)
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: GOAL_TEXT }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    assert.equal(adapter.requests.length, 0, 'no model call was spent')
    const frame = frameOf(ctx, agent)
    assert.equal(frame.goal, null, 'the goal never committed: the message had not been admitted')
    assert.equal(frame.plan, null)
    assert.equal(frame.injections.length, 0, 'no injection was confirmed')
    assert.equal(agent.session.snapshotEvents().filter(event => event.type === 'user/message').length, 0, 'no user message entered the log')
  } finally {
    gate.mode = 'pass'
    await ctx.fiber.dispose()
  }
})

test('fork replays the frame; a child with the baseline visible does not re-inject on composition', async () => {
  const adapter = new ScriptAdapter([textResponse('ok')])
  const { ctx, agent } = await harness(adapter)
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: GOAL_TEXT }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const parentFrame = frameOf(ctx, agent)
    const child = ctx.sessions.fork(agent.session, undefined, SessionId('scx-fork-child'))
    const childFrame = ctx.spatialContext.frameOf(child)
    assert.equal(childFrame.goal.goalRevision, 1, 'the fork replayed the accepted goal')
    assert.deepEqual(childFrame.injections, parentFrame.injections, 'the fork replayed the confirmed injections')
    assert.deepEqual(childFrame.budget, parentFrame.budget, 'the fork replayed the budget ledger')
    // The inherited baseline is visible on the child's surface, so the next
    // composition dedupes instead of re-injecting (compose-level, since the
    // child has no agent attached).
    const visible = childFrame.injections
    assert.equal(visible.length, 1)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('decision_update through the ToolRuntime refuses conflicts and commits only the plan', async () => {
  const adapter = new ScriptAdapter([textResponse('ok')])
  const { ctx, agent } = await harness(adapter)
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: GOAL_TEXT }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const frame = ctx.spatialContext.frameOf(agent.session)
    assert.equal(frame.goal.goalRevision, 1)

    // The agent loop appends the tool/call before dispatch; mirror that so
    // the handler finds its accepted call pairing.
    const rigCall = (callId, args) => {
      agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'decision_update', arguments: JSON.stringify(args) })
      return ctx.tools.execute({
        callId: ToolCallId(callId),
        name: 'decision_update',
        arguments: args,
        agent,
        signal: new AbortController().signal,
      })
    }

    // Stale goal citation: refused before any record is built.
    const stale = await rigCall('d-stale', { goal_revision: 99, expected_plan_revision: 0, steps: ['x'] })
    assert.equal(stale.isError, true)
    assert.match(staleText(stale), /GOAL_REVISION_STALE/, 'a stale goal is a loud refusal')
    assert.equal(ctx.spatialContext.frameOf(agent.session).plan, null, 'no plan committed')

    // Wrong plan revision: conflict, also before any spend.
    const conflict = await rigCall('d-conflict', { goal_revision: 1, expected_plan_revision: 7, steps: ['x'] })
    assert.match(staleText(conflict), /PLAN_REVISION_CONFLICT/)
    assert.equal(ctx.spatialContext.frameOf(agent.session).plan, null)

    // A valid update succeeds; only its accepted result folds the plan.
    const ok = await rigCall('d-ok', {
      goal_revision: 1,
      expected_plan_revision: 0,
      steps: ['登记资源', '缓冲'],
      gaps: [{ id: 'gap-net', description: '缺路网', status: 'open' }],
    })
    assert.equal(ok.isError, false, `valid update must succeed: ${staleText(ok)}`)
    assert.equal(ok.meta.kind, 'decision-change')
    const call = agent.session.snapshotEvents().findLast(event => event.type === 'tool/call' && event.data.callId === 'd-ok')
    const result = agent.session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId: 'd-ok', content: [{ type: 'text', text: 'ok' }], isError: false }),
      meta: ok.meta,
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    assert.ok(result.seq > call.seq)
    const committed = ctx.spatialContext.frameOf(agent.session)
    assert.equal(committed.plan.planRevision, 1, 'the accepted result folded the plan write')
    assert.equal(committed.plan.steps.length, 2)
    assert.equal(committed.budget.gapRetries['gap-net'], 1)
    // The budget ledger only grew: plan updates cannot reset consumption.
    assert.ok(committed.budget.metaBytes >= frame.budget.metaBytes)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('decision_update accepts string-encoded json arguments and names a malformed one', async () => {
  const adapter = new ScriptAdapter([textResponse('ok')])
  const { ctx, agent } = await harness(adapter)
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: GOAL_TEXT }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const rigCall = (callId, args) => {
      agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'decision_update', arguments: JSON.stringify(args) })
      return ctx.tools.execute({
        callId: ToolCallId(callId),
        name: 'decision_update',
        arguments: args,
        agent,
        signal: new AbortController().signal,
      })
    }

    const encoded = await rigCall('d-string', {
      goal_revision: 1,
      expected_plan_revision: 0,
      methods: JSON.stringify([{ name: 'network-coverage', rationale: 'session-36e92064 sent methods as a string' }]),
      steps: JSON.stringify(['登记资源']),
      gaps: JSON.stringify([{ id: 'gap-net', description: '缺路网', status: 'open' }]),
      evidence_refs: JSON.stringify([]),
    })
    assert.equal(encoded.isError, false, `string-encoded methods must pass: ${staleText(encoded)}`)
    assert.equal(encoded.meta.update.methods[0].name, 'network-coverage')
    assert.deepEqual(encoded.meta.update.steps, ['登记资源'])

    const malformed = await rigCall('d-bad-json', {
      goal_revision: 1,
      expected_plan_revision: 0,
      methods: '[{broken',
    })
    assert.equal(malformed.isError, true)
    assert.match(staleText(malformed), /INVALID_ARGUMENT: methods is a string that is not valid JSON/)
    assert.match(staleText(malformed), /\[\{broken/)

    const wrongShape = await rigCall('d-shape', {
      goal_revision: 1,
      expected_plan_revision: 0,
      methods: JSON.stringify(['just-a-name']),
    })
    assert.equal(wrongShape.isError, true)
    assert.match(staleText(wrongShape), /INVALID_ARGUMENT: each method must be an object with a name/)
  } finally {
    await ctx.fiber.dispose()
  }
})

/** The model-visible text of one ToolExecutionResult. */
function staleText(result) {
  return result.content.map(block => block.text ?? '').join('\n')
}
