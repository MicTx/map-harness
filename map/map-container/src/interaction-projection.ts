/** Pure turn accounting embedded in the authoritative mapContainer projection. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { MAP_USE_REQUEST_TTL_MS, initialMapInteractionState, type MapInteractionState } from './interaction-protocol.ts'
import { parseMapUseArguments } from './map-use.ts'

/**
 * Account attempts only within an explicitly opened trusted turn.
 * @param state - current turn accounting.
 * @param event - committed Session event.
 * @returns immutable accounting without runtime effects.
 */
export function applyMapInteractionEvent(state: MapInteractionState, event: SessionEvent): MapInteractionState {
  if (event.type === 'turn/start') {
    if (event.data.turn <= state.turn) return state
    return { ...initialMapInteractionState(), lastResult: state.lastResult, turn: event.data.turn, turnStartSeq: event.seq, open: true, startedAt: event.time, observedAt: event.time }
  }
  if (event.type === 'turn/end') return state.turn !== event.data.turn ? state : { ...state, open: false, request: null }
  if ((event.type === 'tool/result' || event.type === 'step/end') && state.open && event.data.turn === state.turn) {
    return event.time > state.observedAt ? { ...state, observedAt: event.time } : state
  }
  if (event.type !== 'tool/call' || !state.open || state.turnStartSeq === null
    || event.data.turn !== state.turn || event.seq <= state.lastCallSeq) return state
  if (event.data.name !== 'map_use' && event.data.name !== 'map_observe') return state
  const current = { ...state, lastCallSeq: event.seq, observedAt: Math.max(state.observedAt, event.time) }
  if (event.data.name === 'map_observe') return { ...current, observations: state.observations + 1 }
  const action = event.data.arguments.length > 4096 ? null : parseMapUseArguments(event.data.arguments)
  const charged = { ...current, actions: state.actions + (action?.action === 'finish' ? 0 : 1) }
  if (action === null) return charged
  if (state.request !== null || (state.stopped !== null && action.action !== 'finish')) return charged
  return {
    ...charged,
    request: {
      callId: event.data.callId, requestSeq: event.seq, turn: state.turn,
      turnStartSeq: state.turnStartSeq, controlEpoch: state.controlEpoch,
      observationId: action.observationId ?? '', action: action.action,
      arguments: event.data.arguments,
      ...(action.action === 'click' ? { xPx: action.xPx, yPx: action.yPx } : {}),
      expiresAtMs: event.time + MAP_USE_REQUEST_TTL_MS,
    },
  }
}
