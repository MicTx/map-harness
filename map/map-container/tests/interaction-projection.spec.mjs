import test from 'node:test'
import assert from 'node:assert/strict'
import { mapContainerProjectionDefinition as projection } from '../src/projection.ts'
import { applyMapInteractionEvent } from '../src/interaction-projection.ts'
import { initialMapInteractionState, mapUseBudgetRefusalOf, resolveMapUseBudget } from '../src/interaction-protocol.ts'

const call = (seq, turn, name, args) => ({ type: 'tool/call', seq, time: 100 + seq, data: { turn, step: 1, callId: `call-${seq}`, name, arguments: JSON.stringify(args) } })
const start = (seq, turn) => ({ type: 'turn/start', seq, time: 100 + seq, data: { turn } })

test('only an explicit new turn opens accounting; duplicate or old starts preserve usage', () => {
  let state = applyMapInteractionEvent(initialMapInteractionState(), call(0, 1, 'map_observe', {}))
  assert.equal(state.open, false)
  state = applyMapInteractionEvent(state, start(1, 1))
  state = applyMapInteractionEvent(state, call(2, 1, 'map_observe', {}))
  assert.equal(state.observations, 1)
  assert.equal(applyMapInteractionEvent(state, start(3, 1)), state)
  assert.equal(applyMapInteractionEvent(state, call(4, 2, 'map_observe', {})), state)
  const next = applyMapInteractionEvent(state, start(5, 2))
  assert.equal(next.observations, 0)
  assert.equal(next.turnStartSeq, 5)
})

test('a malformed action is charged without stopping the turn', () => {
  let state = applyMapInteractionEvent(initialMapInteractionState(), start(1, 1))
  state = applyMapInteractionEvent(state, call(2, 1, 'map_use', { action: 'invalid' }))
  assert.equal(state.actions, 1)
  assert.equal(state.stopped, null)
  state = applyMapInteractionEvent(state, call(3, 1, 'map_use', { action: 'finish' }))
  assert.equal(state.actions, 1)
  assert.equal(state.request.action, 'finish')
})

test('an accepted call replay does not charge again and cannot replace the in-flight owner', () => {
  let state = applyMapInteractionEvent(initialMapInteractionState(), start(1, 1))
  const first = call(2, 1, 'map_use', { action: 'pan', observation_id: 'obs', dx_px: 1, dy_px: 0 })
  state = applyMapInteractionEvent(state, first)
  assert.equal(applyMapInteractionEvent(state, first), state)
  state = applyMapInteractionEvent(state, call(3, 1, 'map_use', { action: 'zoom', observation_id: 'obs', delta_zoom: 1 }))
  assert.equal(state.actions, 2)
  assert.equal(state.request.requestSeq, 2)
})

test('default map use remains available beyond the former action, observation and elapsed limits', () => {
  const budget = resolveMapUseBudget(undefined)
  for (const name of ['map_observe', 'map_use']) {
    let state = applyMapInteractionEvent(initialMapInteractionState(), start(0, 1))
    for (let index = 1; index <= 25; index += 1) {
      state = applyMapInteractionEvent(state, call(index, 1, name, { action: 'pan', observation_id: 'obs', dx_px: 1, dy_px: 0 }))
    }
    assert.equal(mapUseBudgetRefusalOf(state, budget, state.startedAt + 121_000), null)
  }
})

test('the twentieth attempt is admitted and the twenty-first is denied for each independent budget', () => {
  const budget = resolveMapUseBudget({ maxActions: 20, maxObservations: 20, maxElapsedMs: 120_000 })
  for (const name of ['map_observe', 'map_use']) {
    let state = applyMapInteractionEvent(initialMapInteractionState(), start(0, 1))
    for (let index = 1; index <= 21; index += 1) {
      state = applyMapInteractionEvent(state, call(index, 1, name, { action: 'pan', observation_id: 'obs', dx_px: 1, dy_px: 0 }))
      assert.equal(mapUseBudgetRefusalOf(state, budget, state.observedAt + 1), index <= 20 ? null : name === 'map_use' ? 'actions' : 'observations')
    }
  }
  const state = { ...initialMapInteractionState(), startedAt: 100 }
  assert.equal(mapUseBudgetRefusalOf(state, budget, 120099), null)
  assert.equal(mapUseBudgetRefusalOf(state, budget, 120100), 'elapsed')
})

test('the map snapshot carries accounting and request together, including through serialization', () => {
  let state = projection.apply(projection.init(), start(0, 1))
  state = projection.apply(state, call(1, 1, 'map_use', { action: 'pan', observation_id: 'obs', dx_px: 1, dy_px: 2 }))
  assert.equal(state.interaction.request.requestSeq, state.pendingCalls[0].callSeq)
  assert.deepEqual(projection.stateSchema.parse(JSON.parse(JSON.stringify(state))), state)
  assert.deepEqual(projection.wire.view(state).interaction, state.interaction)
  const closed = projection.apply(state, { type: 'turn/end', seq: 2, time: 105, data: { turn: 1, reason: { kind: 'done' } } })
  assert.equal(closed.interaction.request, null)
  assert.equal(closed.interaction.actions, 1)
})

test('a host clock rollback cannot enlarge the remaining map budget after a recorded step', () => {
  let state = applyMapInteractionEvent(initialMapInteractionState(), { ...start(0, 1), time: 100000 })
  state = applyMapInteractionEvent(state, { type: 'step/end', seq: 1, time: 190000, data: { turn: 1, step: 1 } })
  state = applyMapInteractionEvent(state, { ...call(2, 1, 'map_observe', {}), time: 130000 })
  assert.equal(state.observedAt, 190000)
  assert.equal(mapUseBudgetRefusalOf(state, resolveMapUseBudget(undefined), 130000), 'elapsed')
})
