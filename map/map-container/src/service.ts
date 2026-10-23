/**
 * The `ctx.map` service contract: the projection-derived read face the map
 * tools validate against. Since P0a the `mapContainer` session projection is
 * the single authoritative map state; this service only reads it and resolves
 * call pairing — there is no write path. The browser half never uses this
 * face (it consumes the projection wire value through `useProjection`).
 */
import type {} from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { MapPendingCall, MapProjectionState } from './protocol.ts'

/** Cordis service name for the map container read face. */
export const MAP_CONTAINER_SERVICE = 'map'

/**
 * The `ctx.map` service face: authoritative reads over the accepted
 * projection state. Tools resolve it from the agent context through
 * `ctx.get('map')` (host-plane service).
 */
export interface MapContainerService {
  /**
   * Read one session's authoritative plain-JSON projection state.
   * @param session - the live session whose accepted events are folded.
   * @returns the state covering every committed event.
   */
  stateOf(session: Session): MapProjectionState
  /**
   * Resolve the accepted `tool/call` entry a ToolRuntime call pairs with —
   * the trusted source of the durable `sourceCallSeq` commit meta cites.
   * @param session - the live session that accepted the call.
   * @param callId - the ToolRuntime call id of the executing call.
   * @returns the pending call entry, or `undefined` when this call has no
   *   accepted `tool/call` in the session log (direct execution outside the
   *   agent loop cannot mutate the authoritative map).
   */
  pendingCallOf(session: Session, callId: string): MapPendingCall | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Projection-derived map container read face (no write path since P0a). */
    map: MapContainerService
  }
}
