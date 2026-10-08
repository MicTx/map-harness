/**
 * Keyless completions-lane coverage against a real loopback relay: token
 * deltas assemble into NDJSON event lines across split chunks and round
 * boundaries, `[DONE]` and a clean stream end both land on `source-closed`,
 * the request actually sent carries the fixed relay instruction with the
 * deployment's model/tokens/base, and every refusal family — 401 bearer
 * check, HTTP error, wrong content type, stalling endpoint, no listener,
 * pre-aborted signal — reports its outcome. Protocol misses (a non-JSON
 * chunk payload, an `error` chunk) violate the stream; narration misses
 * (a relay line that is not JSON) count as rejections, never fatal.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompletionsSourceReader } from '../src/completions.ts'
import { freePort, startFixture } from './loopback.ts'

function reportPath() {
  return join(tmpdir(), `stream-providers-report-${String(process.pid)}-${String(Math.random()).slice(2)}.json`)
}

function baseSpec(url) {
  return { id: 'relay', kind: 'completions', url, model: 'deepseek-flash', credentialRef: 'cc-switch:loopback', prompt: 'cargo ships crossing the strait', eventTimeBaseMs: 5000, timeoutMs: 1000 }
}

test('completions: streaming — split token deltas assemble into events and [DONE] ends the source', async () => {
  const fixture = await startFixture('loopback-completions-server', ['--events', '3', '--split', '4', '--token', 'loopback-secret'])
  try {
    const reader = new CompletionsSourceReader(
      { ...baseSpec(`http://127.0.0.1:${String(fixture.port)}/v1/chat/completions`), maxEventsPerFetch: 2 },
      () => 'loopback-secret',
    )
    const first = await reader.readRound()
    assert.equal(first.live, true)
    assert.equal(first.rejected, 0)
    assert.equal(first.events.length, 2)
    assert.equal(first.events[0]?.eventId, 'relay-0')
    assert.equal(first.events[0]?.eventTimeMs, 2000)
    const second = await reader.readRound()
    assert.equal(second.ended, true)
    assert.equal(second.events.length, 1)
    assert.equal(second.events[0]?.eventId, 'relay-2')
    const third = await reader.readRound()
    assert.equal(third.ended, true)
    assert.equal(third.events.length, 0)
    assert.equal(reader.state, 'ended')
  } finally {
    await fixture.stop()
  }
})

test('completions: the request carries the relay instruction, model, token budget, and time base', async () => {
  const report = reportPath()
  const fixture = await startFixture('loopback-completions-server', ['--events', '1', '--token', 'loopback-secret', '--report', report])
  try {
    const reader = new CompletionsSourceReader(
      { ...baseSpec(`http://127.0.0.1:${String(fixture.port)}/v1/chat/completions`), maxTokens: 512 },
      () => 'loopback-secret',
    )
    await reader.readRound()
    const seen = JSON.parse(readFileSync(report, 'utf8'))
    assert.equal(seen.model, 'deepseek-flash')
    assert.equal(seen.stream, true)
    assert.equal(seen.maxTokens, 512)
    assert.equal(seen.messageCount, 1)
    assert.equal(seen.systemRole, true)
    assert.ok(seen.systemHead.includes('geospatial event relay'))
    assert.ok(String(seen.systemHead).includes('starting at 5000'))
    await reader.close()
  } finally {
    rmSync(report, { force: true })
    await fixture.stop()
  }
})

test('completions: a mismatched bearer reports auth-rejected without leaking the key', async () => {
  const fixture = await startFixture('loopback-completions-server', ['--events', '1', '--token', 'loopback-secret'])
  try {
    const reader = new CompletionsSourceReader(
      baseSpec(`http://127.0.0.1:${String(fixture.port)}/v1/chat/completions`) ,
      () => 'the-wrong-key',
    )
    const round = await reader.readRound()
    assert.equal(round.failure?.outcome, 'auth-rejected')
    assert.ok(round.failure?.detail !== undefined && !round.failure.detail.includes('the-wrong-key'))
  } finally {
    await fixture.stop()
  }
})

test('completions: a non-JSON chunk payload violates the stream', async () => {
  const fixture = await startFixture('loopback-completions-server', ['--bad-json-chunk'])
  try {
    const reader = new CompletionsSourceReader(
      baseSpec(`http://127.0.0.1:${String(fixture.port)}/v1/chat/completions`) ,
      () => 'any',
    )
    const round = await reader.readRound()
    assert.equal(round.failure?.outcome, 'stream-violated')
    assert.ok(round.failure?.detail.includes('chunk payload is not JSON'))
  } finally {
    await fixture.stop()
  }
})

test('completions: an error chunk violates the stream with a bounded message', async () => {
  const fixture = await startFixture('loopback-completions-server', ['--error-chunk'])
  try {
    const reader = new CompletionsSourceReader(
      baseSpec(`http://127.0.0.1:${String(fixture.port)}/v1/chat/completions`) ,
      () => 'any',
    )
    const round = await reader.readRound()
    assert.equal(round.failure?.outcome, 'stream-violated')
    assert.ok(round.failure?.detail.includes('relay error'))
    assert.ok(round.failure?.detail === undefined || round.failure.detail.length <= 512)
  } finally {
    await fixture.stop()
  }
})

test('completions: a narration miss counts as a rejection and the valid line still lands', async () => {
  const fixture = await startFixture('loopback-completions-server', ['--events', '1', '--reject-lines'])
  try {
    const reader = new CompletionsSourceReader(
      { ...baseSpec(`http://127.0.0.1:${String(fixture.port)}/v1/chat/completions`), maxEventsPerFetch: 1 },
      () => 'any',
    )
    const first = await reader.readRound()
    assert.equal(first.rejected, 1)
    assert.equal(first.events.length, 1)
    assert.equal(first.events[0]?.eventId, 'valid-after-bad')
    const second = await reader.readRound()
    assert.equal(second.ended, true)
    assert.equal(second.events.length, 0)
  } finally {
    await fixture.stop()
  }
})

test('completions: a clean end without [DONE] still reports source-closed', async () => {
  const fixture = await startFixture('loopback-completions-server', ['--events', '2', '--no-done'])
  try {
    const reader = new CompletionsSourceReader(
      baseSpec(`http://127.0.0.1:${String(fixture.port)}/v1/chat/completions`) ,
      () => 'any',
    )
    const round = await reader.readRound()
    assert.equal(round.ended, true)
    assert.equal(round.events.length, 2)
    assert.equal(reader.state, 'ended')
  } finally {
    await fixture.stop()
  }
})

test('completions: unreachable — no listener answers the open', async () => {
  const port = await freePort()
  const reader = new CompletionsSourceReader(
    baseSpec(`http://127.0.0.1:${String(port)}/v1/chat/completions`) ,
    () => 'any',
  )
  const round = await reader.readRound()
  assert.equal(round.failure?.outcome, 'unreachable')
})

test('completions: http-error and content-type violations carry their outcomes', async () => {
  const failing = await startFixture('loopback-completions-server', ['--status', '503'])
  try {
    const reader = new CompletionsSourceReader(
      baseSpec(`http://127.0.0.1:${String(failing.port)}/v1/chat/completions`) ,
      () => 'any',
    )
    const round = await reader.readRound()
    assert.equal(round.failure?.outcome, 'http-error')
  } finally {
    await failing.stop()
  }
  const plain = await startFixture('loopback-completions-server', ['--content-type', 'application/json'])
  try {
    const reader = new CompletionsSourceReader(
      baseSpec(`http://127.0.0.1:${String(plain.port)}/v1/chat/completions`) ,
      () => 'any',
    )
    const round = await reader.readRound()
    assert.equal(round.failure?.outcome, 'content-type-violated')
  } finally {
    await plain.stop()
  }
})

test('completions: timeout — a stalling endpoint expires the open deadline; abort refuses the exchange', async () => {
  const stalled = await startFixture('loopback-completions-server', ['--stall-open'])
  try {
    const reader = new CompletionsSourceReader(
      baseSpec(`http://127.0.0.1:${String(stalled.port)}/v1/chat/completions`) ,
      () => 'any',
    )
    const round = await reader.readRound()
    assert.equal(round.failure?.outcome, 'timeout')
  } finally {
    await stalled.stop()
  }
  const controller = new AbortController()
  controller.abort(new Error('operator teardown'))
  const aborted = new CompletionsSourceReader(
    baseSpec('http://127.0.0.1:1/v1/chat/completions') ,
    () => 'any',
  )
  const abortedRound = await aborted.readRound({ signal: controller.signal })
  assert.equal(abortedRound.failure?.outcome, 'aborted')
})

test('completions: a partial line survives a round boundary and completes later', async () => {
  const fixture = await startFixture('loopback-completions-server', ['--events', '2', '--split', '6'])
  try {
    const reader = new CompletionsSourceReader(
      { ...baseSpec(`http://127.0.0.1:${String(fixture.port)}/v1/chat/completions`), maxEventsPerFetch: 1 },
      () => 'any',
    )
    const first = await reader.readRound()
    assert.equal(first.events.length, 1)
    assert.equal(first.ended, false)
    // Round 2 must finish the partially assembled second line, not re-parse.
    const second = await reader.readRound()
    assert.equal(second.events.length, 1)
    assert.equal(second.events[0]?.eventId, 'relay-1')
    // Round 3 drains the buffered [DONE] frame and ends the source.
    const third = await reader.readRound()
    assert.equal(third.ended, true)
    assert.equal(third.events.length, 0)
    await reader.close()
  } finally {
    await fixture.stop()
  }
})
