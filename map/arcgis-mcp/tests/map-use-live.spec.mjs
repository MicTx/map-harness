/** The real-model relay distinguishes a completed SSE turn from an interrupted stream. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { createMapUseRecordingRelay, insideProjectedTriangle } from './map-use-live-fixture.mjs'
import { withTrackedTmpDir, waitFor } from '../../tests/support/reliability.mjs'

test('the click oracle uses the displayed triangle rather than an unrelated fixed-radius circle', () => {
  const vertices = [{ x: 322.7155555555728, y: 401.2352379775516 }, { x: 347.74666666669054, y: 459.4744109399762 }, { x: 297.6844444444555, y: 459.4744109399762 }]
  assert.equal(insideProjectedTriangle({ x: 324, y: 415 }, vertices), true)
  assert.equal(insideProjectedTriangle({ x: 333, y: 420 }, vertices), false)
  assert.equal(insideProjectedTriangle({ x: 360, y: 415 }, vertices), false)
  assert.equal(insideProjectedTriangle({ x: 324, y: 415 }, [...vertices].reverse()), true)
})

test('the relay rejects an absolute-form foreign origin before forwarding credentials', async () => {
  await withTrackedTmpDir('map-use-relay-origin', async ({ path }) => {
    let forwarded = 0
    const relay = createMapUseRecordingRelay({ apiKey: 'relay-test', directory: path, ablate: false, beforeFirstImage: async () => {}, fetchUpstream: async () => { forwarded += 1; return Response.json({}) } })
    try {
      await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve))
      const status = await new Promise((resolve, reject) => {
        const incoming = request({ hostname: '127.0.0.1', port: relay.server.address().port, path: 'https://foreign.invalid/anthropic/v1/messages', method: 'POST' }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)) })
        incoming.on('error', reject)
        incoming.end('{}')
      })
      assert.equal(status, 502)
      assert.equal(forwarded, 0)
    } finally {
      relay.abort()
      relay.server.closeAllConnections()
      await new Promise(resolve => relay.server.close(resolve))
    }
  })
})

for (const complete of [false, true]) test(`recording relay ${complete ? 'accepts' : 'rejects'} disconnect ${complete ? 'after' : 'before'} message_stop`, async () => {
  await withTrackedTmpDir('map-use-relay', async ({ path }) => {
    const relay = createMapUseRecordingRelay({
      apiKey: 'relay-test', directory: path, ablate: false, beforeFirstImage: async () => {},
      fetchUpstream: async (_url, { signal }) => new Response(new ReadableStream({
        start(controller) {
          const events = [{ type: 'message_start', message: { id: 'test-message', model: 'deepseek-flash', usage: { input_tokens: 1 } } }]
          if (complete) events.push({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' })
          controller.enqueue(new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')))
          signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')), { once: true })
        },
      }), { headers: { 'content-type': 'text/event-stream' } }),
    })
    try {
      await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve))
      const response = await fetch(`http://127.0.0.1:${relay.server.address().port}/anthropic/v1/messages`, {
        method: 'POST', body: JSON.stringify({ model: 'deepseek-flash', messages: [] }), headers: { 'content-type': 'application/json' },
      })
      const reader = response.body.getReader()
      assert.ok((await reader.read()).value.byteLength > 0)
      await reader.cancel()
      await waitFor(() => relay.requests[0]?.completed, { label: 'relay request settles after client disconnect' })
      assert.equal(relay.requests[0].protocolComplete, complete)
      if (complete) {
        assert.equal(relay.failure, undefined)
        assert.equal(relay.requests[0].closedAfterMessageStop, true)
        assert.equal(relay.requests[0].stopReason, 'end_turn')
        assert.equal(relay.requests[0].usage.output_tokens, 1)
      } else assert.match(relay.failure, /AbortError/u)
    } finally {
      relay.abort()
      relay.server.closeAllConnections()
      await new Promise(resolve => relay.server.close(resolve))
    }
  })
})
