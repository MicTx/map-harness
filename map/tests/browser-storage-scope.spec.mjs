import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

const repo = resolve(import.meta.dirname, '../..')
const vitest = join(repo, 'node_modules/vitest/vitest.mjs')

const OWNING_SUITES = [
  'packages/client/store/tests/browser-storage-scope.client.spec.ts',
  'packages/client/connection/tests/browser-auth.host.spec.ts',
  'packages/client/connection/tests/browser-storage-loader.host.spec.ts',
  'packages/client/connection/tests/client-apply.client.spec.ts',
  'packages/client/ui-renderer/tests/registry.client.spec.ts',
  'packages/client/ui-renderer/tests/browser-storage-scope.client.spec.tsx',
  'packages/client/shortcuts/tests/browser-storage-scope.client.spec.ts',
  'packages/client/ui-sidebar-right/tests/browser-storage-scope.client.spec.ts',
  'packages/client/ui-conversation/tests/browser-storage-scope.client.spec.ts',
  'packages/client/ui-conversation/tests/draft-hub.client.spec.ts',
  'packages/client/ui-workspace/tests/browser-storage-scope.client.spec.ts',
  'packages/client/ui-workspace/tests/workspaces-service.client.spec.ts',
]

test('browser storage scope contract executes the owning Vitest behavior suites', { timeout: 240_000 }, () => {
  assert.ok(existsSync(vitest), 'worktree dependencies must provide vitest')
  const result = spawnSync(process.execPath, [vitest, 'run', ...OWNING_SUITES, '--maxWorkers=2', '--reporter=verbose'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, CI: '1' },
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /browser-storage-scope\.client\.spec\.ts/u)
})
