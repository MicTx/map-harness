/**
 * Host interaction fence registry: token-authenticated claim/result pairing,
 * early claims, bounded waits, named declines, timeout/cancel, and strict
 * wire validation. A wrong token never settles the valid wait.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMapInteractionService, registerInteractionRoute, serveMapUseRequest } from '../src/interaction.ts'
import { mapRig } from './map-rig.mjs'

function waitOf(overrides = {}) {
  const base = { sessionId: 's1', callId: 'call-1', requestSeq: 7, expiresAtMs: Date.now() + 5_000, ...overrides }
  return { readCurrent: () => true, ...base, signal: overrides.signal ?? new AbortController().signal }
}

test('claim issues a token; the result must carry it and settles the wait', async () => {
  const service = createMapInteractionService()
  const wait = waitOf()
  const waiting = service.waitFor(wait)
  const claimed = await service.claim(wait)
  assert.equal(claimed.status, 'claimed')
  const wrong = await service.submit({ sessionId: 's1', callId: 'call-1', requestSeq: 7, token: 'bogus', outcome: { status: 'validated' } })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.code, 'wrong-token')
  assert.equal(service.pendingCount, 1)
  const ok = await service.submit({ sessionId: 's1', callId: 'call-1', requestSeq: 7, token: claimed.token, outcome: { status: 'validated' } })
  assert.equal(ok.ok, true)
  assert.deepEqual(await waiting, { status: 'validated' })
})

test('an early claim parks until the wait arrives', async () => {
  const service = createMapInteractionService()
  const wait = waitOf()
  const claiming = service.claim(wait)
  assert.equal(service.earlyClaimCount, 1)
  const waiting = service.waitFor(wait)
  const claimed = await claiming
  assert.equal(claimed.status, 'claimed')
  await service.submit({ sessionId: 's1', callId: 'call-1', requestSeq: 7, token: claimed.token, outcome: { status: 'hits', hits: [], world: [116.4, 39.9] } })
  assert.equal((await waiting).status, 'hits')
})

test('timeout, cancellation, dispose, and a missing request settle without rejecting', async () => {
  const service = createMapInteractionService()
  const timedOut = await service.waitFor(waitOf({ expiresAtMs: Date.now() + 30 }))
  assert.equal(timedOut.status, 'timeout')
  const controller = new AbortController()
  const waiting = service.waitFor(waitOf({ callId: 'c2', signal: controller.signal }))
  controller.abort()
  assert.equal((await waiting).status, 'cancelled')
  const missing = await service.submit({ sessionId: 's1', callId: 'nope', requestSeq: 1, token: 'x', outcome: { status: 'validated' } })
  assert.equal(missing.code, 'no-pending-request')
  service.dispose()
  assert.equal(service.pendingCount, 0)
})

test('wire route validates exact fields and returns the settled hit outcome', async () => {
  const service = createMapInteractionService()
  const wait = waitOf()
  service.waitFor(wait)
  const claim = await serveMapUseRequest(new Request('http://local/api/map/use', {
    method: 'POST',
    body: JSON.stringify({ action: 'claim', sessionId: 's1', callId: 'call-1', requestSeq: 7, expiresAtMs: wait.expiresAtMs }),
  }), service)
  assert.equal(claim.status, 200)
  const { token } = await claim.json()
  const refused = await serveMapUseRequest(new Request('http://local/api/map/use', {
    method: 'POST',
    body: JSON.stringify({ action: 'result', sessionId: 's1', callId: 'call-1', requestSeq: 7, token, outcome: { status: 'hits' } }),
  }), service)
  assert.equal(refused.status, 400)
  const accepted = await serveMapUseRequest(new Request('http://local/api/map/use', {
    method: 'POST',
    body: JSON.stringify({
      action: 'result', sessionId: 's1', callId: 'call-1', requestSeq: 7, token,
      outcome: { status: 'hits', hits: [], world: [116.4, 39.9] },
    }),
  }), service)
  assert.equal(accepted.status, 200)
})

test('the host deadline wins over a long client claim and stale ownership refuses settlement', async () => {
  let now = 1000
  const service = createMapInteractionService(undefined, () => now)
  try {
    const wait = waitOf({ expiresAtMs: 1200 })
    const pending = service.waitFor(wait)
    const claim = await service.claim({ ...wait, expiresAtMs: 1000000 })
    now = 1200
    const submitted = await service.submit({ ...wait, token: claim.token, outcome: { status: 'validated' } })
    assert.equal(submitted.ok, false)
    assert.equal((await pending).status, 'timeout')
    let current = true
    const other = waitOf({ callId: 'current', expiresAtMs: 1500, readCurrent: () => current })
    const waiting = service.waitFor(other)
    const claimed = await service.claim(other)
    current = false
    assert.equal((await service.submit({ ...other, token: claimed.token, outcome: { status: 'validated' } })).ok, false)
    assert.equal((await waiting).status, 'stale')
  } finally { service.dispose() }
})

test('streaming oversized bodies are cancelled without calling the registry', async () => {
  const service = createMapInteractionService()
  let cancelled = false
  const stream = new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(128 * 1024)) },
    cancel() { cancelled = true },
  })
  const response = await serveMapUseRequest(new Request('http://local/api/map/use', { method: 'POST', body: stream, duplex: 'half' }), service)
  assert.equal(response.status, 413)
  assert.equal(cancelled, true)
  assert.equal(service.pendingCount, 0)
  service.dispose()
})

test('a timed-out or disconnected body cannot execute a complete JSON prefix', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const service = createMapInteractionService()
  let submitted = 0
  try {
    for (const mode of ['timeout', 'disconnect']) {
      const entered = Promise.withResolvers()
      const controller = new AbortController()
      let cancelled = false
      const stream = new ReadableStream({
        start(streamController) {
          streamController.enqueue(new TextEncoder().encode(JSON.stringify({ action: 'stop', sessionId: 's1', turnStartSeq: 0 })))
        },
        pull() { entered.resolve() },
        cancel() { cancelled = true },
      })
      const response = serveMapUseRequest(new Request('http://local/api/map/use', {
        method: 'POST', body: stream, duplex: 'half', signal: controller.signal,
      }), service, async () => { submitted += 1; return true })
      await entered.promise
      if (mode === 'timeout') context.mock.timers.tick(30000)
      else controller.abort()
      const result = await response
      assert.equal(result.status, 408)
      assert.equal(cancelled, true)
      assert.equal(submitted, 0)
    }
  } finally { service.dispose() }
})

test('the registered stop route persists only the resolved session turn and rejects late work after disposal', async () => {
  const rig = await mapRig()
  let registered
  let injected = 0
  let resolveAgent = async sessionId => ({ agent: {
    session: rig.session(sessionId),
    inject(message) { injected += 1; rig.session(sessionId).append('user/message', message, { surfaceOp: 'append' }) },
  } })
  const host = { get: name => name === 'connection' ? { fetch: { register(route) { registered = route; return async () => {} } } }
    : name === 'sessionController' ? { resolveAgent: (...args) => resolveAgent(...args) }
      : name === 'map' ? rig.map : undefined }
  const service = createMapInteractionService()
  const dispose = registerInteractionRoute(host, service)
  try {
    const session = rig.session('stop-route')
    const turn = session.append('turn/start', { turn: 1 })
    const request = () => new Request('http://local/api/map/use', { method: 'POST', body: JSON.stringify({ action: 'stop', sessionId: session.id, turnStartSeq: turn.seq }) })
    assert.equal((await registered.fetch(request())).status, 200)
    assert.equal(rig.map.interactionOf(session).stopped, 'user-interrupted')
    assert.equal(rig.map.interactionOf(rig.session('other')).stopped, null)
    const pending = Promise.withResolvers()
    const entered = Promise.withResolvers()
    const original = resolveAgent
    resolveAgent = async id => { entered.resolve(); await pending.promise; return original(id) }
    const response = registered.fetch(request())
    await entered.promise
    await dispose()
    pending.resolve()
    assert.equal((await response).status, 409)
    assert.equal(injected, 1)
  } finally { await dispose(); service.dispose(); await rig.dispose() }
})
