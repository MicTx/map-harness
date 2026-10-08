/**
 * Gesture write channel, submission half: forwards bounded observation texts
 * into the session queue through the same client session prompt path the
 * composer uses (design §11.1 — client submissions ride the standard
 * admission path; §11.2 — only stable rests and explicit submits enter).
 * @module @map-harness/map-container/client/gesture-submit
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Independent references retained by the map gesture write channel. */
    mapGesture: unknown
  }
}

/** The client-plane sessions service as this module consumes it. */
interface ClientSessionsContext {
  get(name: 'sessions'): ISessions | undefined
}

/** Submit one bounded observation text; `mode` picks steer (running) or queue (explicit). */
export type GestureSubmit = (sessionId: string, text: string, mode: 'queue' | 'steer') => Promise<boolean>

/**
 * Create the submission callback bound to the client context's sessions
 * service. Retention is reference-counted, so a submit during an open map
 * tab adds no second scope.
 * @param ctx - client root context carrying the sessions service.
 * @returns the submission callback; `false` results are holds/failures, never map-state changes.
 */
export function createGestureSubmit(ctx: ClientContext): GestureSubmit {
  // The typed view isolates this module from the host-plane `sessions` merge
  // (core SessionStore) that also lands on the cordis Context type.
  const clientCtx = ctx as ClientSessionsContext
  return async (sessionId, text, mode) => {
    const sessions = clientCtx.get('sessions')
    if (sessions === undefined) return false
    return sessions.using(sessionId as SessionId, { source: 'mapGesture' }, async reference =>
      (await reference.binding.session.prompt([{ type: 'text', text }], mode)).ok,
    )
  }
}
