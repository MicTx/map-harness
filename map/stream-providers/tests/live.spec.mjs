/**
 * Key-activated live verification lane: when `STREAM_PROVIDERS_LIVE=deepseek`
 * and the cc-switch store resolves the credential name, run one bounded
 * real-wire verification against api.deepseek.com (default `deepseek-flash`,
 * `STREAM_PROVIDERS_LIVE_MODEL` overrides) and assert the report is a
 * well-formed read outcome — streaming success or a named failure with a
 * detail — never a credential value. Self-skips without the variable so the
 * keyless suite stays the contract owner.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { STREAM_READ_OUTCOMES } from '../src/contract.ts'
import { resolveStreamRegistry, buildStreamProvidersService } from '../src/plugin.ts'

const liveKind = process.env.STREAM_PROVIDERS_LIVE
const liveModel = process.env.STREAM_PROVIDERS_LIVE_MODEL ?? 'deepseek-flash'
const liveCredentialName = process.env.STREAM_PROVIDERS_LIVE_CREDENTIAL ?? 'DeepSeek'

test('live verification against the real DeepSeek completions endpoint', { skip: liveKind !== 'deepseek' ? 'STREAM_PROVIDERS_LIVE is not set to deepseek' : false }, async () => {
  const registry = resolveStreamRegistry({
    sources: [
      {
        id: 'live-deepseek',
        kind: 'completions',
        url: 'https://api.deepseek.com/chat/completions',
        model: liveModel,
        credentialRef: `cc-switch:${liveCredentialName}`,
      },
    ],
    fusions: [],
    ccSwitchDb: join(homedir(), '.cc-switch', 'cc-switch.db'),
  })
  const { service, closeAll } = buildStreamProvidersService(registry)
  try {
    const report = await service.verifySource('live-deepseek', { timeoutMs: 30_000 })
    assert.ok(STREAM_READ_OUTCOMES.includes(report.outcome), `outcome must be a live-vocabulary member, got ${report.outcome}`)
    assert.ok(report.durationMs >= 0)
    if (report.outcome === 'streaming' || report.outcome === 'source-closed') {
      assert.ok(report.detail.length === 0 || report.detail.includes(liveModel) || !report.detail.includes('sk-'), 'success detail never carries a credential value')
    } else {
      assert.ok(report.detail.length > 0, 'a failure outcome carries a detail')
      assert.ok(!report.detail.includes('sk-'), 'no credential value appears in the detail')
    }
    console.log(`[stream-providers live] outcome=${report.outcome} events=${report.eventsObserved ?? 0} detail=${report.detail}`)
  } finally {
    await closeAll()
  }
})
