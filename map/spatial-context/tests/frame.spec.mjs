/**
 * DecisionFrame domain units: the source-authority separation
 * (GoalContract vs plugin/model voices), the plan-update conflict checks,
 * and the bounded-record vocabulary. Pure source-plane units over `src/`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bounded,
  checkPlanUpdate,
  evidenceIdOf,
  isUserAuthoritySource,
  MAX_EVIDENCE_ENTRIES,
  MAX_PLAN_HISTORY,
  MAX_RESOURCE_CANDIDATES,
  MAX_SEEN_TOOLS,
  questionIdOf,
} from '../src/frame.ts'
import { initialSpatialContextState } from '../src/protocol.ts'

/** Build a frame with an accepted goal, an optional plan, and settled evidence. */
function frameWithGoal(goalRevision, planRevision, evidenceSeqs = []) {
  const base = initialSpatialContextState()
  return {
    ...base,
    goal: {
      questionId: `q-${goalRevision}`,
      goalRevision,
      question: `目标 v${goalRevision}`,
      sourceSeq: goalRevision,
      sourceKind: 'user-message',
      acceptedAt: 1000,
    },
    ...(planRevision === null ? {} : {
      plan: {
        planRevision,
        goalRevision,
        questionId: `q-${goalRevision}`,
        methods: [],
        steps: [],
        gaps: [],
        sourceSeq: 900 + planRevision,
      },
    }),
    evidence: evidenceSeqs.map((seq) => ({
      evidenceId: evidenceIdOf(seq),
      seq,
      kind: 'analysis-result',
      tool: 'geo_buffer',
      status: 'succeeded',
      limitations: [],
    })),
  }
}

test('only real user messages carry goal authority', () => {
  assert.equal(isUserAuthoritySource({ kind: 'user' }), true, 'the upstream user entry is the only authority')
  assert.equal(isUserAuthoritySource({ kind: 'plugin' }), false, 'plugin user-role context never authorizes')
  assert.equal(isUserAuthoritySource({ kind: 'model' }), false, 'model output never authorizes')
  assert.equal(isUserAuthoritySource({ kind: 'tool' }), false, 'tool results never authorize')
  assert.equal(isUserAuthoritySource({ kind: 'spatial-context' }), false, 'own snapshots never authorize')
})

test('a plan update requires the current goal revision, plan revision, and known evidence refs', () => {
  const frame = frameWithGoal(2, 3, [101, 102])
  assert.equal(
    checkPlanUpdate(frame, { goalRevision: 2, expectedPlanRevision: 3 }),
    undefined,
    'matching revisions pass without citations',
  )
  assert.equal(
    checkPlanUpdate(frame, { goalRevision: 1, expectedPlanRevision: 3 }),
    'goal-revision-stale',
    'a stale goal revision is refused: old runs never overwrite a new goal',
  )
  assert.equal(
    checkPlanUpdate({ ...frame, goal: null }, { goalRevision: 1, expectedPlanRevision: 3 }),
    'goal-revision-stale',
    'a plan cannot write without an accepted goal',
  )
  assert.equal(
    checkPlanUpdate(frame, { goalRevision: 2, expectedPlanRevision: 2 }),
    'plan-revision-conflict',
    'a lost-plan race is refused instead of overwriting',
  )
  assert.equal(
    checkPlanUpdate(frameWithGoal(2, null, []), { goalRevision: 2, expectedPlanRevision: 0 }),
    undefined,
    'the first plan edits against revision 0',
  )
  assert.equal(
    checkPlanUpdate(frame, { goalRevision: 2, expectedPlanRevision: 3, evidenceRefs: [101, 999] }),
    'unknown-evidence-ref',
    'citing unsettled evidence is refused',
  )
  assert.equal(
    checkPlanUpdate(frame, { goalRevision: 2, expectedPlanRevision: 3, evidenceRefs: [101] }),
    undefined,
    'citing settled evidence passes',
  )
})

test('identities are stable and derived from the log', () => {
  assert.equal(questionIdOf(7), 'q-7')
  assert.equal(evidenceIdOf(12), 'ev-12')
})

test('bounded lists keep the newest tail', () => {
  const entries = Array.from({ length: MAX_EVIDENCE_ENTRIES + 5 }, (_, at) => at)
  const kept = bounded(entries, MAX_EVIDENCE_ENTRIES)
  assert.equal(kept.length, MAX_EVIDENCE_ENTRIES)
  assert.deepEqual(kept.at(0), entries.length - MAX_EVIDENCE_ENTRIES, 'oldest dropped first')
  assert.deepEqual(kept.at(-1), entries.at(-1))
})

test('bounds stay coherent for plan history and resources', () => {
  assert.ok(MAX_PLAN_HISTORY >= 1)
  assert.ok(MAX_RESOURCE_CANDIDATES >= 1)
  assert.ok(MAX_SEEN_TOOLS >= 13, 'the seen-tools bound covers the fixed catalog')
})
