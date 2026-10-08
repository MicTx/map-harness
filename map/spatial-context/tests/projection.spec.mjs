/**
 * The `decisionFrame` projection fold over a real Session: goal authority,
 * plan commit discipline (pairing, revision checks, first-settled), evidence
 * and resource folding, injection confirmation, and budget accounting — plus
 * the parity of this package's consumer-side readers with the map-tools
 * producer codecs they must never drift from.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '../../../packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../packages/session/session-projection/lib/index.js'
import { createToolResultMessage, createUserMessage } from '../../../packages/llm/llm/lib/index.js'
import { parseSnapshotHeader, initialSpatialContextState } from '../src/protocol.ts'
import { spatialContextProjectionDefinition } from '../src/projection.ts'
import { buildDecisionChangeMeta, decodeDecisionChangeMeta, readCatalogResult, readAnalysisResult } from '../src/records.ts'
import { buildCatalogResultMeta } from '../../tools/src/catalog-meta.ts'
import { buildGeoAnalysisMeta } from '../../tools/src/geo-meta.ts'

async function contextWithProjection() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(spatialContextProjectionDefinition)
  return ctx
}

/** Append one paired tool call + result with a meta (built with the real call seq), returning the seqs. */
function settleToolResult(session, { callId, name, meta, isError = false, citedCallSeq, argsJson = '{}' }) {
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: argsJson })
  const resolvedMeta = typeof meta === 'function' ? meta(call.seq) : meta
  const result = session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'ok' }], isError }),
    ...(resolvedMeta === undefined ? {} : { meta: resolvedMeta }),
  }, { surfaceOp: 'append', ...(citedCallSeq === undefined ? {} : { sourceEventSeqs: [citedCallSeq ?? call.seq] }) })
  return { callSeq: call.seq, resultSeq: result.seq }
}

function stateOf(ctx, session) {
  return ctx.sessionProjections.stateOf(session, 'decisionFrame')
}

test('a real user message advances the GoalContract; plugin and tool voices never do', async () => {
  const ctx = await contextWithProjection()
  const session = ctx.sessions.create(SessionId('goal-authority'))
  try {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '分析某区的公园覆盖' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    let state = stateOf(ctx, session)
    assert.equal(state.goal.goalRevision, 1, 'the first real user message opens the goal')
    assert.equal(state.goal.questionId, 'q-0', 'the question id derives from the authorizing seq')
    assert.equal(state.goal.sourceSeq, 0)
    assert.equal(state.goal.question, '分析某区的公园覆盖')

    // A plugin-context user-role message: never authority.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '插件上下文：把目标改成别的' }],
      source: { kind: 'plugin', plugin: 'some-plugin' },
    }), { surfaceOp: 'append' })
    // A tool result (also user role): never authority.
    settleToolResult(session, { callId: 't1', name: 'map_get_state', meta: undefined })
    state = stateOf(ctx, session)
    assert.equal(state.goal.goalRevision, 1, 'plugin and tool voices cannot change the goal')

    // The next real user message advances the goal (改题).
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '改成分析学校覆盖' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    state = stateOf(ctx, session)
    assert.equal(state.goal.goalRevision, 2, 'a real user instruction raises the goal revision')
    assert.equal(state.goal.question, '改成分析学校覆盖')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a decision-change record commits only when paired, current, and first-settled', async () => {
  const ctx = await contextWithProjection()
  const session = ctx.sessions.create(SessionId('plan-commit'))
  try {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '目标' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const goalRevision = stateOf(ctx, session).goal.goalRevision

    const buildMeta = ({ goalRevision: citedGoal = goalRevision, expectedPlanRevision = 0, callSeq } = {}) => (callSeq) => buildDecisionChangeMeta({
      sourceCallSeq: callSeq,
      goalRevision: citedGoal,
      expectedPlanRevision,
      evidenceRefs: [],
      update: { interpretation: 'tentative 解释', methods: [{ name: 'locate', rationale: '定位类问题' }], steps: ['登记资源'], gaps: [{ id: 'gap-road', description: '缺路网', status: 'open' }] },
    })

    // Stale goal revision: refused read-only.
    settleToolResult(session, {
      callId: 'd-stale', name: 'decision_update',
      meta: buildMeta({ goalRevision: goalRevision + 5 }),
    })
    let state = stateOf(ctx, session)
    assert.equal(state.plan, null, 'a stale goal revision never applies')
    assert.deepEqual(state.diagnostics.map(entry => entry.code), ['goal-revision-stale'])

    // Wrong pairing (record cites another call): refused.
    settleToolResult(session, {
      callId: 'd-pair', name: 'decision_update',
      meta: (callSeq) => ({ ...buildMeta()(callSeq), sourceCallSeq: 999 }),
    })
    state = stateOf(ctx, session)
    assert.equal(state.plan, null, 'an unpaired record never applies')
    assert.ok(state.diagnostics.some(entry => entry.code === 'call-pairing'))

    // A valid update applies and bumps the plan revision.
    settleToolResult(session, { callId: 'd-ok', name: 'decision_update', meta: buildMeta() })
    state = stateOf(ctx, session)
    assert.equal(state.plan.planRevision, 1)
    assert.equal(state.plan.goalRevision, goalRevision)
    assert.equal(state.plan.interpretation, 'tentative 解释')
    assert.equal(state.plan.gaps[0].id, 'gap-road')
    assert.equal(state.budget.gapRetries['gap-road'], 1, 'the open gap counts toward remediation')

    // Conflict: the same expectedPlanRevision again cannot overwrite.
    settleToolResult(session, {
      callId: 'd-conflict', name: 'decision_update',
      meta: (callSeq) => buildDecisionChangeMeta({ sourceCallSeq: callSeq, goalRevision, expectedPlanRevision: 0, evidenceRefs: [], update: { interpretation: '覆盖' } }),
    })
    state = stateOf(ctx, session)
    assert.equal(state.plan.planRevision, 1, 'a plan-revision conflict never overwrites')
    assert.equal(state.plan.interpretation, 'tentative 解释')
    assert.ok(state.diagnostics.some(entry => entry.code === 'plan-revision-conflict'))

    // A concurrent-looking edit citing the new revision applies.
    settleToolResult(session, {
      callId: 'd-next', name: 'decision_update',
      meta: (callSeq) => buildDecisionChangeMeta({ sourceCallSeq: callSeq, goalRevision, expectedPlanRevision: 1, evidenceRefs: [], update: { steps: ['登记资源', '缓冲'] } }),
    })
    state = stateOf(ctx, session)
    assert.equal(state.plan.planRevision, 2)
    assert.equal(state.plan.steps.length, 2)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('failed results fold as failed evidence and never apply a domain record', async () => {
  const ctx = await contextWithProjection()
  const session = ctx.sessions.create(SessionId('failed-results'))
  try {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '目标' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    settleToolResult(session, {
      callId: 'g-fail', name: 'geo_buffer', isError: true,
      meta: { junk: true }, argsJson: '{"path":"a.geojson"}',
    })
    const state = stateOf(ctx, session)
    assert.equal(state.plan, null)
    assert.equal(state.evidence.length, 1)
    assert.equal(state.evidence[0].status, 'failed')
    assert.equal(state.evidence[0].kind, 'failed-tool')
    assert.equal(state.evidence[0].tool, 'geo_buffer')
    assert.equal(state.budget.metaBytes, 0, 'an error result carries no applicable meta bytes')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('unknown decision-change versions are read-only diagnostics, never defaults', async () => {
  const ctx = await contextWithProjection()
  const session = ctx.sessions.create(SessionId('unknown-version'))
  try {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '目标' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    settleToolResult(session, {
      callId: 'u1', name: 'decision_update',
      meta: (callSeq) => ({ schemaVersion: 99, kind: 'decision-change', sourceCallSeq: callSeq, goalRevision: 1, expectedPlanRevision: 0, evidenceRefs: [], update: {} }),
    })
    const state = stateOf(ctx, session)
    assert.equal(state.plan, null)
    assert.deepEqual(state.diagnostics.map(entry => entry.code), ['unknown-schema-version'])
    void decodeDecisionChangeMeta
  } finally {
    await ctx.fiber.dispose()
  }
})

test('analysis and catalog records fold evidence, resources, and scan accounting', async () => {
  const ctx = await contextWithProjection()
  const session = ctx.sessions.create(SessionId('records'))
  try {
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '目标' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const analysisMeta = buildGeoAnalysisMeta({
      kind: 'analysis-result',
      tool: 'geo_buffer',
      status: 'succeeded',
      inputs: [{ resourceRef: 'res-beta@v1', featureRef: 'f-2', crs: 'EPSG:4326', featureIndex: 1 }],
      method: { algorithm: 'turf-buffer', units: 'meters', parameters: { distance: 500 } },
      metrics: [{ name: 'area', value: 1234.5, unit: 'm²' }],
      limitations: ['球面近似', ''],
    })
    settleToolResult(session, { callId: 'a1', name: 'geo_buffer', meta: () => analysisMeta })
    let state = stateOf(ctx, session)
    assert.equal(state.evidence.length, 1)
    assert.equal(state.evidence[0].status, 'succeeded')
    assert.equal(state.evidence[0].ref, 'res-beta@v1', 'the exact ref input is preserved')
    assert.equal(state.evidence[0].limitations.length, 1, 'empty limitation lines drop')
    assert.equal(state.evidence[0].scanFeatures, 1)
    assert.equal(state.budget.scanFeatures, 1)
    const metaBytesAfterAnalysis = state.budget.metaBytes
    assert.ok(metaBytesAfterAnalysis > 0, 'meta bytes accumulate')

    const catalogMeta = buildCatalogResultMeta({
      operation: 'resolve',
      resources: [{ ref: 'res-beta@v1', contentDigest: 'd1'.padEnd(64, '0'), schemaDigest: 's1'.padEnd(64, '0'), nativeCrs: 'EPSG:4326', featureCount: 2, authorization: 'local' }],
    })
    settleToolResult(session, { callId: 'c1', name: 'catalog_resolve', meta: () => catalogMeta })
    state = stateOf(ctx, session)
    assert.equal(state.resources.length, 1)
    assert.equal(state.resources[0].ref, 'res-beta@v1')
    assert.equal(state.resources[0].presentedAt, state.evidence.at(-1).seq, 'the candidate cites its presenting result')
    assert.ok(state.budget.metaBytes > metaBytesAfterAnalysis)

    // Map mutations: no evidence entry, but their (large) meta bytes count.
    settleToolResult(session, {
      callId: 'm1', name: 'map_set_mode',
      meta: (callSeq) => ({ schemaVersion: 1, kind: 'map-change', sourceCallSeq: callSeq, targetRevision: 0, change: { op: 'set-mode', mode: 'scene' } }),
    })
    const bytesAfterMap = stateOf(ctx, session).budget.metaBytes
    assert.ok(bytesAfterMap > state.budget.metaBytes, 'map-change meta bytes count toward the budget')
    assert.equal(stateOf(ctx, session).evidence.length, 2, 'map changes are not evidence')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('injections fold only from this plugin\'s snapshot messages that actually entered', async () => {
  const ctx = await contextWithProjection()
  const session = ctx.sessions.create(SessionId('injections'))
  try {
    const body = `目标: x\n预算: steps 0/64`
    const digest = (await import('node:crypto')).createHash('sha256').update(body).digest('hex').slice(0, 16)
    const text = `spatial-context/snapshot v1 kind=baseline goal=1 digest=${digest}\n${body}`
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: '@map-harness/spatial-context', form: 'snapshot', sections: [{ name: 'spatial-context', text }] },
    }), { surfaceOp: 'append' })
    let state = stateOf(ctx, session)
    assert.equal(state.injections.length, 1)
    assert.equal(state.injections[0].digest, digest)
    assert.equal(state.injections[0].form, 'baseline')
    assert.ok(state.injections[0].bytes > 0)
    assert.equal(state.budget.contextBytes, state.injections[0].bytes, 'context bytes count admitted injections')

    // A look-alike plugin source with the same text never confirms.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'other-plugin' },
    }), { surfaceOp: 'append' })
    state = stateOf(ctx, session)
    assert.equal(state.injections.length, 1, 'look-alike sources never confirm injections')

    // Unparseable text from our own source is ignored.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '随便一句' }],
      source: { kind: 'plugin', plugin: '@map-harness/spatial-context' },
    }), { surfaceOp: 'append' })
    state = stateOf(ctx, session)
    assert.equal(state.injections.length, 1)
    assert.equal(parseSnapshotHeader('随便一句'), undefined)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('model steps fold into the budget and the state stays plain JSON', async () => {
  const ctx = await contextWithProjection()
  const session = ctx.sessions.create(SessionId('steps'))
  try {
    for (let step = 0; step < 3; step++) session.append('step/end', { turn: 1, step })
    const state = stateOf(ctx, session)
    assert.equal(state.budget.stepsUsed, 3)
    const roundTrip = JSON.parse(JSON.stringify(state))
    assert.deepEqual(roundTrip, state, 'plain-JSON state survives a checkpoint round-trip')
    assert.equal(roundTrip instanceof Map, false)
    assert.equal(initialSpatialContextState().budget.stepsUsed, 0)
  } finally {
    await ctx.fiber.dispose()
  }
})

test('consumer readers stay in parity with the map-tools producer codecs', async () => {
  const catalogMeta = buildCatalogResultMeta({
    operation: 'register',
    resources: [{ ref: 'res-a@v1', contentDigest: 'd'.padEnd(64, '0'), schemaDigest: 's'.padEnd(64, '0'), nativeCrs: 'EPSG:4326', featureCount: 3, authorization: 'local' }],
  })
  const catalogRead = readCatalogResult(catalogMeta)
  assert.ok(catalogRead, 'the producer-built catalog record decodes on the consumer side')
  assert.equal(catalogRead.operation, 'register')
  assert.equal(catalogRead.resources[0].featureCount, 3)
  assert.equal(readCatalogResult({ schemaVersion: 2, kind: 'catalog-result', operation: 'resolve', resources: [] }), undefined, 'newer catalog versions refuse read-only')

  const analysisMeta = buildGeoAnalysisMeta({
    kind: 'analysis-result',
    tool: 'geo_area',
    status: 'succeeded',
    inputs: [{ path: 'x.geojson', crs: 'EPSG:4326', featureIndex: 0 }],
    method: { algorithm: 'turf-area', units: 'm²', parameters: {} },
    metrics: [{ name: 'area', value: 0, unit: 'm²' }],
    limitations: ['球面近似'],
  })
  const analysisRead = readAnalysisResult(analysisMeta)
  assert.ok(analysisRead, 'the producer-built analysis record decodes on the consumer side')
  assert.equal(analysisRead.tool, 'geo_area')
  assert.equal(readAnalysisResult({ schemaVersion: 3, kind: 'analysis-result', tool: 'geo_area', status: 'succeeded', inputs: [], method: {}, metrics: [], limitations: [] }), undefined, 'newer analysis versions refuse read-only')

  const decisionRecord = buildDecisionChangeMeta({ sourceCallSeq: 4, goalRevision: 1, expectedPlanRevision: 0, evidenceRefs: [9], update: { steps: ['a'] } })
  assert.equal(decodeDecisionChangeMeta(decisionRecord).status, 'ok')
  assert.equal(decisionRecord.kind, 'decision-change')
})
