/**
 * Key-activated live re-verification lane: when `MCP_TRANSPORT_LIVE_URL`
 * names a real remote streamable-HTTP MCP endpoint (optional
 * `MCP_TRANSPORT_LIVE_TOKEN` bearer), run one bounded verification against
 * it and assert the report is well-formed. Self-skips without the variable
 * so the keyless suite stays the contract owner.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MCP_EXCHANGE_OUTCOMES } from '../src/contract.ts'
import { verifyRemoteMcp } from '../src/client.ts'

const liveUrl = process.env.MCP_TRANSPORT_LIVE_URL
const liveToken = process.env.MCP_TRANSPORT_LIVE_TOKEN

test('live re-verification over a real remote endpoint', { skip: liveUrl === undefined ? 'MCP_TRANSPORT_LIVE_URL is not set' : false }, async () => {
  const report = await verifyRemoteMcp(
    { id: 'live-remote', kind: 'http', url: liveUrl, ...(liveToken === undefined ? {} : { timeoutMs: undefined }) },
    liveToken === undefined ? {} : { token: liveToken },
  )
  assert.ok(MCP_EXCHANGE_OUTCOMES.includes(report.outcome))
  assert.ok(report.durationMs >= 0)
  assert.ok(report.detail.length > 0)
})
