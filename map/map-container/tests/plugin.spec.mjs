/**
 * Host-plugin lifecycle fixtures for `@map-harness/map-container`: the
 * projection-derived `ctx.map` read face and the `mapContainer` session
 * projection mount and unmount with the plugin fiber, a reload starts from
 * fresh state (the HMR-safety contract every registry owes), and sibling
 * sessions stay isolated because the fold keys on the Session.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '../../../packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../packages/session/session-projection/lib/index.js'
import { createToolResultMessage } from '../../../packages/llm/llm/lib/index.js'
import * as mapContainerPlugin from '../src/plugin.ts'

/** Mount the projection host the container plugin injects. */
async function projectionContext() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return ctx
}

test('the plugin provides the ctx.map read face and registers the mapContainer projection', async () => {
  const ctx = await projectionContext()
  const fiber = await ctx.plugin(mapContainerPlugin)
  try {
    assert.equal(typeof ctx.map.stateOf, 'function', 'ctx.map must be provided')
    assert.equal(typeof ctx.map.pendingCallOf, 'function')

    const session = ctx.sessions.create(SessionId('plugin-mount'))
    const projected = ctx.sessionProjections.stateOf(session, 'mapContainer')
    assert.ok(projected !== undefined, 'the mapContainer projection unit must be registered')
    assert.equal(projected.mode, 'map')
    assert.deepEqual(ctx.map.stateOf(session), projected, 'the read face returns the authoritative projection state')

    // The fold commits through accepted session events only: one paired
    // tool/call + successful tool/result with durable meta drives it.
    const callId = 'plugin-spec-call'
    const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'map_set_mode', arguments: JSON.stringify({ mode: 'scene' }) })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'scene' }], isError: false }),
      meta: {
        schemaVersion: 1, kind: 'map-change', sourceCallSeq: call.seq, targetRevision: 0,
        change: { op: 'set-mode', mode: 'scene' },
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    assert.equal(ctx.map.stateOf(session).mode, 'scene', 'the projection folds the committed map mutation')
    assert.equal(ctx.map.stateOf(session).revision, 1)
    assert.deepEqual(
      ctx.map.pendingCallOf(session, callId),
      undefined,
      'a settled call leaves no pending entry',
    )
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

test('the read face resolves the accepted tool/call pairing for commit meta', async () => {
  const ctx = await projectionContext()
  const fiber = await ctx.plugin(mapContainerPlugin)
  try {
    const session = ctx.sessions.create(SessionId('plugin-pending'))
    const call = session.append('tool/call', { turn: 1, step: 1, callId: 'pair-1', name: 'map_set_view', arguments: JSON.stringify({ center: [1, 2] }) })
    assert.deepEqual(ctx.map.pendingCallOf(session, 'pair-1'), { callId: 'pair-1', callSeq: call.seq, name: 'map_set_view' })
    assert.equal(ctx.map.pendingCallOf(session, 'missing'), undefined)
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})

test('unmount removes the service, and a reload mounts a fresh read face', async () => {
  const ctx = await projectionContext()
  const fiber = await ctx.plugin(mapContainerPlugin)
  const session = ctx.sessions.create(SessionId('reload-session'))
  await fiber.dispose()
  assert.equal(ctx.get('map'), undefined, 'ctx.map must leave with the plugin fiber')

  const reloaded = await ctx.plugin(mapContainerPlugin)
  assert.equal(ctx.map.stateOf(session).mode, 'map', 'a reload starts from the initial state, not the disposed fold')
  await reloaded.dispose()
  await ctx.fiber.dispose()
})

test('sibling sessions fold independently through the same unit', async () => {
  const ctx = await projectionContext()
  const fiber = await ctx.plugin(mapContainerPlugin)
  try {
    const a = ctx.sessions.create(SessionId('session-a'))
    const b = ctx.sessions.create(SessionId('session-b'))
    for (const session of [a, b]) {
      const call = session.append('tool/call', { turn: 1, step: 1, callId: `mode-${session.id}`, name: 'map_set_mode', arguments: JSON.stringify({ mode: 'scene' }) })
      session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({ callId: `mode-${session.id}`, content: [{ type: 'text', text: 'scene' }], isError: false }),
        meta: {
          schemaVersion: 1, kind: 'map-change', sourceCallSeq: call.seq, targetRevision: 0,
          change: { op: 'set-mode', mode: 'scene' },
        },
      }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    }
    assert.equal(ctx.map.stateOf(a).mode, 'scene')
    assert.equal(ctx.map.stateOf(b).mode, 'scene')
    assert.equal(ctx.map.stateOf(a).lastCallId, 'mode-session-a')
    assert.equal(ctx.map.stateOf(b).lastCallId, 'mode-session-b')
  } finally {
    await fiber.dispose()
    await ctx.fiber.dispose()
  }
})
