/**
 * Interaction protocol schema and budget helpers: the persisted projection
 * shape, outcome wire shape, budget resolution/boundaries, and the snapshot
 * the tool reports after an action.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAP_USE_BUDGET,
  initialMapInteractionState,
  mapInteractionOutcomeSchema,
  mapInteractionStateSchema,
  mapUseBudgetRefusalOf,
  mapUseBudgetSnapshotOf,
  resolveMapUseBudget,
} from '../src/interaction-protocol.ts'

test('initial projection state and schema stay plain, bounded JSON', () => {
  const initial = initialMapInteractionState()
  assert.equal(initial.stateVersion, 3)
  assert.equal(initial.stopped, null)
  assert.equal(initial.turnStartSeq, null)
  assert.deepEqual(mapInteractionStateSchema.parse(initial), initial)
  assert.equal(mapInteractionStateSchema.safeParse({ ...initial, actions: -1 }).success, false)
  assert.equal(mapInteractionStateSchema.safeParse({ ...initial, request: { callId: 'c' } }).success, false)
  assert.equal(mapInteractionStateSchema.safeParse({ ...initial, extra: true }).success, false)
})

test('budget resolution rejects non-positive or non-integer values', () => {
  assert.deepEqual(resolveMapUseBudget(undefined), DEFAULT_MAP_USE_BUDGET)
  assert.deepEqual(DEFAULT_MAP_USE_BUDGET, { maxActions: null, maxObservations: null, maxElapsedMs: null })
  assert.throws(() => resolveMapUseBudget({ maxActions: 0 }), /positive integer/)
  assert.throws(() => resolveMapUseBudget({ maxObservations: 1.5 }), /positive integer/)
  assert.throws(() => resolveMapUseBudget({ maxElapsedMs: -1 }), /positive integer/)
})

test('budget refusal and snapshot report each exhausted dimension', () => {
  const budget = resolveMapUseBudget({ maxActions: 2, maxObservations: 3, maxElapsedMs: 1000 })
  const state = { ...initialMapInteractionState(), turn: 1, open: true, startedAt: 100, actions: 2, observations: 3 }
  assert.equal(mapUseBudgetRefusalOf(state, budget, 500), null)
  assert.equal(mapUseBudgetRefusalOf({ ...state, actions: 3 }, budget, 500), 'actions')
  assert.equal(mapUseBudgetRefusalOf({ ...state, observations: 4 }, budget, 500), 'observations')
  assert.equal(mapUseBudgetRefusalOf(state, budget, 1100), 'elapsed')
  assert.deepEqual(mapUseBudgetSnapshotOf(state, budget, 500), {
    actionsUsed: 2, actionsRemaining: 0,
    observationsUsed: 3, observationsRemaining: 0,
    elapsedMs: 400, elapsedRemainingMs: 600,
  })
})

test('outcome schema accepts validated, bounded hits, and named declines', () => {
  assert.deepEqual(mapInteractionOutcomeSchema.parse({ status: 'validated' }), { status: 'validated' })
  const hit = {
    layerId: 'coverage', layerName: 'Coverage', featureId: 'f-1', title: 'Coverage',
    fields: [{ name: 'name', value: 'Coverage' }], omitted: 0,
  }
  assert.deepEqual(mapInteractionOutcomeSchema.parse({ status: 'hits', hits: [hit], world: [104, 37.8] }), {
    status: 'hits', hits: [hit], world: [104, 37.8],
  })
  assert.deepEqual(mapInteractionOutcomeSchema.parse({ status: 'declined', code: 'user-interrupted' }), {
    status: 'declined', code: 'user-interrupted',
  })
  assert.equal(mapInteractionOutcomeSchema.safeParse({ status: 'declined', code: 'unknown' }).success, false)
  assert.equal(mapInteractionOutcomeSchema.safeParse({ status: 'hits', hits: [hit], world: [104, 37.8], extra: true }).success, false)
  assert.equal(mapInteractionOutcomeSchema.safeParse({
    status: 'hits', hits: [{ ...hit, fields: [{ name: 'x', value: 'y'.repeat(257) }] }], world: [1, 2],
  }).success, false)
})
