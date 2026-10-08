import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { resolveStreamRegistry, buildStreamProvidersService } from '../src/plugin.ts'

/** Build one cc-switch fixture store with the given provider rows. */
function fixtureStore(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'stream-providers-store-'))
  const dbPath = join(dir, 'cc-switch.db')
  const database = new DatabaseSync(dbPath)
  database.exec('CREATE TABLE providers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, app_type TEXT, settings_config TEXT)')
  const insert = database.prepare('INSERT INTO providers (name, app_type, settings_config) VALUES (?, ?, ?)')
  for (const row of rows) {
    insert.run(row.name, row.appType ?? null, JSON.stringify(row.settings ?? {}))
  }
  database.close()
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const declared = (over = {}) => ({
  sources: [
    { id: 'feed-a', kind: 'sse', url: 'http://127.0.0.1:9/feed', credentialRef: 'cc-switch:DeepSeek' },
    { id: 'relay-b', kind: 'completions', url: 'http://127.0.0.1:9/v1/chat/completions', model: 'deepseek-flash', credentialRef: 'cc-switch:DeepSeek' },
  ],
  fusions: [{ id: 'fusion-1', sources: ['feed-a', 'relay-b'] }],
  ...over,
})

test('listSources reports sanitized identities, references by name only', () => {
  const { service, closeAll } = buildStreamProvidersService(resolveStreamRegistry(declared()))
  try {
    const listed = service.listSources()
    assert.deepEqual(listed.map(source => source.id), ['feed-a', 'relay-b'])
    assert.deepEqual(listed.map(source => source.credentialRef), ['cc-switch:DeepSeek', 'cc-switch:DeepSeek'])
    assert.equal(listed[0].endpoint, 'http://127.0.0.1:9/feed')
    assert.deepEqual(service.listFusions().map(fusion => fusion.sources), [['feed-a', 'relay-b']])
    assert.equal(service.listFusions()[0].perSource, null, 'a closed fusion reports no state faces')
    const dump = JSON.stringify(service.listSources()) + JSON.stringify(service.specs)
    assert.ok(!dump.includes('sk-'), 'no credential value shape appears in any summary')
  } finally {
    void closeAll()
  }
})

test('resolveStreamRegistry refuses invalid declarations loudly and by name', () => {
  const cases = [
    {
      config: declared({ sources: [{ id: 'feed-a', kind: 'sse', url: 'http://x/f' }, { id: 'feed-a', kind: 'sse', url: 'http://x/g' }] }),
      match: /feed-a is declared more than once/,
    },
    {
      config: declared({ sources: [{ id: 'UPPER', kind: 'sse', url: 'http://x/f' }] }),
      match: /UPPER/,
    },
    {
      config: declared({ sources: [{ id: 'feed-a', kind: 'sse', url: 'http://x/f', credentialRef: 'env:KEY' }] }),
      match: /feed-a: /,
    },
    {
      config: declared({ sources: [{ id: 'feed-a', kind: 'sse', url: 'http://x/f' }], fusions: [{ id: 'fusion-1', sources: ['feed-a', 'ghost'] }] }),
      match: /fusion-1: /,
    },
    {
      config: declared({ sources: [{ id: 'feed-a', kind: 'sse', url: 'http://x/f' }], fusions: [{ id: 'fusion-1', sources: ['feed-a'] }] }),
      match: /fusion-1: /,
    },
  ]
  for (const { config, match } of cases) {
    assert.throws(() => resolveStreamRegistry(config), match)
  }
})

test('verifySource maps the four credential refusals to auth-rejected, by name never value', async () => {
  // (1) the store is unavailable: no file at the configured path.
  const missing = fixtureStore([])
  missing.cleanup()
  const { service: down, closeAll: closeDown } = buildStreamProvidersService(resolveStreamRegistry(declared({ ccSwitchDb: missing.dbPath })))
  try {
    const report = await down.verifySource('feed-a', { timeoutMs: 1000 })
    assert.equal(report.outcome, 'auth-rejected')
    assert.ok(report.detail.includes('DeepSeek'), 'the refusal names the credential name')
    assert.ok(!report.detail.includes(missing.dbPath), 'the refusal carries no host path')
  } finally {
    await closeDown()
  }

  // (2) no provider carries the name.
  const empty = fixtureStore([])
  const { service: noName, closeAll: closeNoName } = buildStreamProvidersService(resolveStreamRegistry(declared({ ccSwitchDb: empty.dbPath })))
  try {
    const report = await noName.verifySource('feed-a', { timeoutMs: 1000 })
    assert.equal(report.outcome, 'auth-rejected')
    assert.match(report.detail, /DeepSeek.*matches no provider/)
  } finally {
    await closeNoName()
    empty.cleanup()
  }

  // (3) the named provider carries no api key in its settings.
  const keyless = fixtureStore([{ name: 'DeepSeek', appType: 'api', settings: { baseUrl: 'https://api.deepseek.com' } }])
  const { service: noKey, closeAll: closeNoKey } = buildStreamProvidersService(resolveStreamRegistry(declared({ ccSwitchDb: keyless.dbPath })))
  try {
    const report = await noKey.verifySource('feed-a', { timeoutMs: 1000 })
    assert.equal(report.outcome, 'auth-rejected')
    assert.match(report.detail, /none carrying an api key/)
  } finally {
    await closeNoKey()
    keyless.cleanup()
  }

  // (4) same-named providers disagree on the key.
  const split = fixtureStore([
    { name: 'DeepSeek', appType: 'api', settings: { apiKey: 'sk-one' } },
    { name: 'DeepSeek', appType: 'cli', settings: { apiKey: 'sk-two' } },
  ])
  const { service: disagree, closeAll: closeDisagree } = buildStreamProvidersService(resolveStreamRegistry(declared({ ccSwitchDb: split.dbPath })))
  try {
    const report = await disagree.verifySource('feed-a', { timeoutMs: 1000 })
    assert.equal(report.outcome, 'auth-rejected')
    assert.match(report.detail, /disagree on the key/)
    assert.ok(!report.detail.includes('sk-one') && !report.detail.includes('sk-two'), 'no key value leaks')
  } finally {
    await closeDisagree()
    split.cleanup()
  }
})

test('verifySource lands streaming over a real loopback feed with the resolved key', async () => {
  const { startFixture } = await import('./loopback.ts')
  const fixture = await startFixture('loopback-sse-server', ['--events', '2', '--end', '--token', 'sk-loopback'])
  const store = fixtureStore([{ name: 'DeepSeek', appType: 'api', settings: { apiKey: 'sk-loopback' } }])
  try {
    const config = declared({
      sources: [{ id: 'feed-a', kind: 'sse', url: `http://127.0.0.1:${String(fixture.port)}/feed`, credentialRef: 'cc-switch:DeepSeek' }],
      fusions: [],
      ccSwitchDb: store.dbPath,
    })
    const { service, closeAll } = buildStreamProvidersService(resolveStreamRegistry(config))
    try {
      const report = await service.verifySource('feed-a', { timeoutMs: 2000 })
      assert.equal(report.outcome, 'source-closed', 'the --end fixture closes cleanly after its burst')
      assert.equal(report.eventsObserved, 2)
      assert.ok(report.durationMs >= 0)
    } finally {
      await closeAll()
    }
  } finally {
    await fixture.stop()
    store.cleanup()
  }
})

test('unknown ids refuse with the named program codes', async () => {
  const { service, closeAll } = buildStreamProvidersService(resolveStreamRegistry(declared()))
  try {
    await assert.rejects(() => service.verifySource('ghost'), /STREAM_PROVIDERS_UNKNOWN_SOURCE: .*ghost/)
    assert.throws(() => service.pauseSource('fusion-1', 'feed-a'), /STREAM_PROVIDERS_STATE: fusion fusion-1 is not open/)
    await assert.rejects(() => service.fusionAdvance('ghost'), /STREAM_PROVIDERS_UNKNOWN_FUSION: .*ghost/)
    assert.throws(() => service.pauseSource('ghost', 'feed-a'), /STREAM_PROVIDERS_UNKNOWN_FUSION/)
    await service.openFusion('fusion-1')
    assert.throws(() => service.pauseSource('fusion-1', 'ghost'), /STREAM_PROVIDERS_UNKNOWN_SOURCE: fusion fusion-1 does not bind source ghost/)
  } finally {
    await closeAll()
  }
})

test('the fusion dispatch plane drives a real two-source wire end to end', async () => {
  const { startFixture } = await import('./loopback.ts')
  const fast = await startFixture('loopback-sse-server', ['--events', '4', '--end'])
  const slow = await startFixture('loopback-sse-server', ['--events', '2'])
  const store = fixtureStore([{ name: 'DeepSeek', appType: 'api', settings: { apiKey: 'sk-loopback' } }])
  try {
    const config = declared({
      sources: [
        { id: 'feed-a', kind: 'sse', url: `http://127.0.0.1:${String(fast.port)}/feed` },
        { id: 'feed-b', kind: 'sse', url: `http://127.0.0.1:${String(slow.port)}/feed` },
      ],
      fusions: [{ id: 'fusion-1', sources: ['feed-a', 'feed-b'] }],
      ccSwitchDb: store.dbPath,
    })
    const { service, closeAll } = buildStreamProvidersService(resolveStreamRegistry(config))
    try {
      const opened = await service.openFusion('fusion-1')
      assert.deepEqual(opened.sources, ['feed-a', 'feed-b'])
      assert.equal(opened.perSource.length, 2)

      const first = await service.fusionAdvance('fusion-1', { timeoutMs: 2000 })
      assert.equal(first.horizonMs, 1_000, 'the slow feed holds the horizon at its maximum')
      assert.ok(first.releasedEvents.length > 0)
      assert.ok(first.batches.length > 0)

      service.pauseSource('fusion-1', 'feed-b')
      const paused = await service.fusionAdvance('fusion-1', { timeoutMs: 2000 })
      assert.equal(paused.perSource.find(s => s.sourceId === 'feed-b').state, 'paused')
      service.resumeSource('fusion-1', 'feed-b')
      const resumed = await service.fusionAdvance('fusion-1', { timeoutMs: 2000 })
      assert.equal(resumed.perSource.find(s => s.sourceId === 'feed-b').state, 'live')

      assert.equal(await service.closeFusion('fusion-1'), true)
      assert.equal(await service.closeFusion('fusion-1'), false, 'a closed fusion stays closed')
      await assert.rejects(() => service.fusionAdvance('fusion-1'), /STREAM_PROVIDERS_STATE/)
    } finally {
      await closeAll()
    }
  } finally {
    await fast.stop()
    await slow.stop()
    store.cleanup()
  }
})
