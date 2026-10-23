/**
 * Keyless sse-lane coverage against a real loopback listener: every outcome
 * in the closed vocabulary is produced by real wire behavior, not mocks —
 * `streaming` (bounded rounds, budget yield, parked-read continuation,
 * reopens), `unreachable` (no listener), `auth-rejected` (bearer check),
 * `http-error`, `content-type-violated`, `stream-violated` (oversized line,
 * invalid UTF-8), `timeout` (open deadline), `aborted` (pre-aborted signal),
 * and `source-closed` (clean end, terminal).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SseSourceReader } from '../src/sse.ts'
import { STREAM_READ_OUTCOMES } from '../src/contract.ts'
import { freePort, startFixture } from './loopback.ts'

test('sse: streaming — bounded rounds read events and honor the per-round budget', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--events', '4'])
  try {
    const reader = new SseSourceReader(
      { id: 'sse-burst', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, maxEventsPerFetch: 2, timeoutMs: 1000 },
      () => undefined,
    )
    const first = await reader.readRound()
    assert.equal(first.live, true)
    assert.equal(first.events.length, 2)
    assert.equal(first.events[0]?.eventId, 'evt-0')
    assert.equal(first.rejected, 0)
    const second = await reader.readRound()
    assert.equal(second.live, true)
    assert.equal(second.events.length, 2)
    assert.equal(second.events[0]?.eventId, 'evt-2')
    assert.equal(second.events[1]?.eventId, 'evt-3')
    // A quiet stream stays live: the round expires, the parked read survives.
    const quiet = await reader.readRound()
    assert.equal(quiet.live, true)
    assert.equal(quiet.events.length, 0)
    assert.equal(reader.state, 'live')
    await reader.close()
    assert.equal(reader.state, 'unopened')
  } finally {
    await fixture.stop()
  }
})

test('sse: close is quiescent and a later round reopens the endpoint', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--events', '4'])
  try {
    const reader = new SseSourceReader(
      { id: 'sse-reopen', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, timeoutMs: 1000 },
      () => undefined,
    )
    const first = await reader.readRound()
    assert.equal(first.events.length, 4)
    await reader.close()
    assert.equal(reader.state, 'unopened')
    const reopened = await reader.readRound()
    assert.equal(reopened.live, true)
    assert.equal(reopened.events.length, 4)
    await reader.close()
  } finally {
    await fixture.stop()
  }
})

test('sse: a bearer credential is sent and a mismatched one reports auth-rejected', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--events', '2', '--token', 'loopback-secret'])
  try {
    const refused = new SseSourceReader(
      { id: 'sse-auth', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, credentialRef: 'cc-switch:loopback', timeoutMs: 1000 },
      () => 'wrong-value',
    )
    const refusedRound = await refused.readRound()
    assert.equal(refusedRound.live, false)
    assert.equal(refusedRound.failure?.outcome, 'auth-rejected')
    assert.ok(refusedRound.failure?.outcome === 'auth-rejected' && refusedRound.failure.detail.includes('401'))
    assert.ok(refusedRound.failure?.detail !== undefined && !refusedRound.failure.detail.includes('wrong-value'))
    const accepted = new SseSourceReader(
      { id: 'sse-auth-ok', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, timeoutMs: 1000 },
      () => 'loopback-secret',
    )
    const acceptedRound = await accepted.readRound()
    assert.equal(acceptedRound.live, true)
    assert.equal(acceptedRound.events.length, 2)
    await accepted.close()
  } finally {
    await fixture.stop()
  }
})

test('sse: unreachable — no listener answers the open', async () => {
  const port = await freePort()
  const reader = new SseSourceReader(
    { id: 'sse-dead', kind: 'sse', url: `http://127.0.0.1:${String(port)}/feed`, timeoutMs: 1000 },
    () => undefined,
  )
  const round = await reader.readRound()
  assert.equal(round.failure?.outcome, 'unreachable')
  assert.equal(reader.state, 'failed')
  await reader.close()
})

test('sse: http-error — a refused status carries through', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--status', '503'])
  try {
    const reader = new SseSourceReader(
      { id: 'sse-http', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, timeoutMs: 1000 },
      () => undefined,
    )
    const round = await reader.readRound()
    assert.equal(round.failure?.outcome, 'http-error')
    assert.ok(round.failure?.outcome === 'http-error' && round.failure.detail.includes('503'))
  } finally {
    await fixture.stop()
  }
})

test('sse: content-type-violated — a non-event-stream body is refused', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--content-type', 'text/plain', '--events', '1'])
  try {
    const reader = new SseSourceReader(
      { id: 'sse-ctype', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, timeoutMs: 1000 },
      () => undefined,
    )
    const round = await reader.readRound()
    assert.equal(round.failure?.outcome, 'content-type-violated')
    assert.ok(round.failure?.outcome === 'content-type-violated' && round.failure.detail.includes('text/plain'))
  } finally {
    await fixture.stop()
  }
})

test('sse: timeout — an endpoint that never answers expires the open deadline', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--stall-open'])
  try {
    const reader = new SseSourceReader(
      { id: 'sse-stall', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, timeoutMs: 1000 },
      () => undefined,
    )
    const startedAt = Date.now()
    const round = await reader.readRound()
    assert.equal(round.failure?.outcome, 'timeout')
    assert.ok(Date.now() - startedAt >= 900)
  } finally {
    await fixture.stop()
  }
})

test('sse: a quiet round parks its read and the next round resumes it live', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--events', '6', '--interval', '200'])
  try {
    const reader = new SseSourceReader(
      { id: 'sse-interval', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, maxEventsPerFetch: 1, timeoutMs: 1500 },
      () => undefined,
    )
    for (let index = 0; index < 3; index += 1) {
      const round = await reader.readRound()
      assert.equal(round.live, true, `round ${String(index)} stayed live`)
      assert.equal(round.events.length, 1)
      assert.equal(round.events[0]?.eventId, `evt-${String(index)}`)
      assert.equal(round.failure, undefined)
    }
    assert.equal(reader.state, 'live')
    await reader.close()
  } finally {
    await fixture.stop()
  }
})

test('sse: stream-violated — an oversized line closes the channel', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--big-line'])
  try {
    const reader = new SseSourceReader(
      { id: 'sse-big', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, timeoutMs: 1000 },
      () => undefined,
    )
    const round = await reader.readRound()
    assert.equal(round.failure?.outcome, 'stream-violated')
    assert.ok(round.failure?.outcome === 'stream-violated' && round.failure.detail.includes('cap'))
  } finally {
    await fixture.stop()
  }
})

test('sse: stream-violated — invalid UTF-8 in a data line closes the channel', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--bad-utf8'])
  try {
    const reader = new SseSourceReader(
      { id: 'sse-utf8', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, timeoutMs: 1000 },
      () => undefined,
    )
    const round = await reader.readRound()
    assert.equal(round.failure?.outcome, 'stream-violated')
    assert.ok(round.failure?.outcome === 'stream-violated' && round.failure.detail.includes('UTF-8'))
  } finally {
    await fixture.stop()
  }
})

test('sse: source-closed — a clean end is terminal and later rounds stay ended', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--events', '2', '--end'])
  try {
    const reader = new SseSourceReader(
      { id: 'sse-end', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, timeoutMs: 1000 },
      () => undefined,
    )
    const round = await reader.readRound()
    assert.equal(round.ended, true)
    assert.equal(round.events.length, 2)
    assert.equal(reader.state, 'ended')
    const after = await reader.readRound()
    assert.equal(after.ended, true)
    assert.equal(after.events.length, 0)
    await reader.close()
    assert.equal(reader.state, 'ended')
  } finally {
    await fixture.stop()
  }
})

test('sse: shape rejects are counted per round, never fatal', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--events', '3', '--reject-mix'])
  try {
    const reader = new SseSourceReader(
      { id: 'sse-shape', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, timeoutMs: 1000 },
      () => undefined,
    )
    const round = await reader.readRound()
    assert.equal(round.failure, undefined)
    assert.equal(round.rejected, 1)
    assert.equal(round.events.length, 3)
    await reader.close()
  } finally {
    await fixture.stop()
  }
})

test('sse: an array payload delivers multiple events in one frame', async () => {
  const fixture = await startFixture('loopback-sse-server', ['--events', '2', '--array'])
  try {
    const reader = new SseSourceReader(
      { id: 'sse-array', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, timeoutMs: 1000 },
      () => undefined,
    )
    const round = await reader.readRound()
    assert.equal(round.events.length, 2)
    assert.equal(round.events[0]?.eventId, 'evt-0')
    assert.equal(round.events[1]?.eventId, 'evt-1')
    await reader.close()
  } finally {
    await fixture.stop()
  }
})

test('sse: aborted — a pre-aborted signal refuses the open exchange', async () => {
  const controller = new AbortController()
  controller.abort(new Error('operator teardown'))
  const reader = new SseSourceReader(
    { id: 'sse-abort', kind: 'sse', url: 'http://127.0.0.1:1/feed', timeoutMs: 1000 },
    () => undefined,
  )
  const round = await reader.readRound({ signal: controller.signal })
  assert.equal(round.failure?.outcome, 'aborted')
})

test('sse: the outcome vocabulary stays the closed nine', () => {
  assert.deepEqual(STREAM_READ_OUTCOMES, [
    'streaming', 'unreachable', 'auth-rejected', 'http-error',
    'content-type-violated', 'stream-violated', 'timeout', 'aborted',
    'source-closed',
  ])
})
