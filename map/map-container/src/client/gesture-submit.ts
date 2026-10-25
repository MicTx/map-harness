/**
 * Client write channels, submission half: forwards bounded observation and
 * request texts into the session queue through the same client session
 * prompt path the composer uses (design §11.1 — client submissions ride the
 * standard admission path; §11.2 — only stable rests and explicit submits
 * enter). The submit source labels the retain reference so gesture and
 * panel channels hold independent references.
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
    /** Independent references retained by the map panel write channel. */
    mapPanel: unknown
  }
}

/** The client write channels a submit can serve; each carries its own reference source. */
export type GestureSubmitSource = 'mapGesture' | 'mapPanel'

/** The client-plane sessions service as this module consumes it. */
interface ClientSessionsContext {
  get(name: 'sessions'): ISessions | undefined
}

/** Submit one bounded observation text; `mode` picks steer (running) or queue (explicit). */
export type GestureSubmit = (sessionId: string, text: string, mode: 'queue' | 'steer') => Promise<boolean>

/** Submit one bounded panel request text; panel requests always queue. */
export type PanelSubmit = (sessionId: string, text: string, mode: 'queue') => Promise<boolean>

/**
 * Create the submission callback bound to the client context's sessions
 * service and one write channel's reference source. Retention is
 * reference-counted, so a submit during an open map tab adds no second
 * scope.
 * @param ctx - client root context carrying the sessions service.
 * @param source - the write channel whose reference source retains the session.
 * @returns the submission callback; `false` results are holds/failures, never map-state changes.
 */
export function createGestureSubmit(ctx: ClientContext, source: GestureSubmitSource = 'mapGesture'): GestureSubmit {
  // The typed view isolates this module from the host-plane `sessions` merge
  // (core SessionStore) that also lands on the cordis Context type.
  const clientCtx = ctx as ClientSessionsContext
  return async (sessionId, text, mode) => {
    const sessions = clientCtx.get('sessions')
    if (sessions === undefined) return false
    return sessions.using(sessionId as SessionId, { source }, async reference =>
      (await reference.binding.session.prompt([{ type: 'text', text }], mode)).ok,
    )
  }
}
