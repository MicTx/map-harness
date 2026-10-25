/**
 * Shared P0a test rig: mounts the REAL session store, projection registry,
 * and map-container plugin (source plane) so specs exercise the product's
 * commit protocol — accepted `tool/call` + successful `tool/result` meta —
 * instead of hand-built state. The agent loop appends the call event before
 * the body runs (packages/core/agent-loop/src/tool-calls.ts `appendToolCall`);
 * `call()` reproduces exactly that step, and `result()` reproduces the loop's
 * `appendToolResult` envelope (surfaceOp + sourceEventSeqs citation).
 */
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '../../../packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../packages/session/session-projection/lib/index.js'
import { createToolResultMessage } from '../../../packages/llm/llm/lib/index.js'
import LocalFileSystem from '../../../packages/fs/fs-local/lib/index.js'
import * as mapContainerPlugin from '../src/plugin.ts'

let rigCounter = 0

/**
 * Boot one rig: session store + projection registry + map-container plugin,
 * optionally a local filesystem rooted at `cwd`.
 * @param { { cwd?: string } } options - workspace root for the fs service.
 * @returns the rig handle (see methods).
 */
export async function mapRig({ cwd } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fsFiber = cwd === undefined ? undefined : await ctx.plugin(LocalFileSystem, { cwd })
  const mapFiber = await ctx.plugin(mapContainerPlugin)
  let turn = 0
  const sessions = new Map()
  return {
    ctx,
    /** The host-plane read face tools resolve through `ctx.get('map')`. */
    map: ctx.map,
    /** @param {string=} id - stable session id (defaults to a unique one); a repeated id returns the same live session. */
    session(id) {
      if (id !== undefined && sessions.has(id)) return sessions.get(id)
      const session = ctx.sessions.create(SessionId(id ?? `rig-session-${rigCounter += 1}`), {
        ...cwd === undefined ? {} : { meta: { cwd } },
      })
      if (id !== undefined) sessions.set(id, session)
      return session
    },
    /** Append one accepted `tool/call` (the step the agent loop does before dispatch). */
    call(session, callId, name, args) {
      turn += 1
      return session.append('tool/call', {
        turn, step: 1, callId, name, arguments: JSON.stringify(args ?? {}),
      })
    },
    /**
     * Append one settled `tool/result` exactly like the agent loop:
     * `surfaceOp: 'append'` citing the call event.
     * @param { { isError?: boolean, meta?: unknown, text?: string } } options
     */
    result(session, callEvent, { isError = false, meta, text = 'ok' } = {}) {
      return session.append('tool/result', {
        turn: callEvent.data.turn,
        step: callEvent.data.step,
        message: createToolResultMessage({
          callId: callEvent.data.callId,
          content: [{ type: 'text', text: isError ? `Error: ${text}` : text }],
          isError,
        }),
        ...meta === undefined ? {} : { meta },
      }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] })
    },
    /** The authoritative projection state for one session. */
    state(session) {
      return ctx.sessionProjections.stateOf(session, 'mapContainer')
    },
    /** The client-visible wire view for one session. */
    view(session) {
      return ctx.sessionProjections.snapshot(session, ['mapContainer']).values.mapContainer
    },
    /**
     * A ToolRunContext for direct `tool.execute` calls: the caller must have
     * appended the matching `tool/call` first (the loop's contract). `fs`
     * replaces the agent-plane filesystem service (deterministic barriers
     * inside the handler's async file window).
     */
    exec(session, { callId, signal, fs } = {}) {
      const agentCtx = fs === undefined ? ctx : {
        get: name => (name === 'fs' ? fs : ctx.get(name)),
      }
      return {
        callId,
        rootCallId: callId,
        token: Symbol.for(`map-rig-token-${callId ?? 'none'}`),
        name: 'map_rig_dispatch',
        arguments: {},
        agent: { ctx: agentCtx, session },
        signal: signal ?? new AbortController().signal,
      }
    },
    async dispose() {
      await mapFiber.dispose()
      if (fsFiber !== undefined) await fsFiber.dispose()
      await ctx.fiber.dispose()
    },
  }
}

/** A minimal WGS84 point FeatureCollection for layer fixtures. */
export function pointCollection(coordinates = [116.4, 39.9], properties = { name: 'sample' }) {
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates }, properties }],
  }
}

/** One projected-layer payload matching the persisted protocol shape. */
export function layerPayload(id, data = pointCollection(), sourceCallSeq = 0) {
  return {
    id,
    name: id,
    data,
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    sourceCallSeq,
  }
}
