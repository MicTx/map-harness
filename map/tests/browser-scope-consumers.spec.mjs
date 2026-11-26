import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

const repo = resolve(import.meta.dirname, '../..')
const vitest = join(repo, 'node_modules/vitest/vitest.mjs')

const OWNING_SUITES = [
  'packages/client/ui-schedule/tests/browser-storage-scope.client.spec.ts',
  'packages/client/ui-schedule/tests/browser-plugin.client.spec.ts',
  'packages/client/ui-schedule/tests/task-tab-bindings.client.spec.ts',
  'packages/client/ui-open-in-app/tests/browser-storage-scope.client.spec.ts',
  'packages/client/ui-plugin-manager/tests/browser-storage-scope.client.spec.ts',
  'packages/client/ui-trajectory/tests/browser-storage-scope.client.spec.ts',
]

test('enabled browser persistence consumers execute their owning Vitest behavior suites', { timeout: 240_000 }, () => {
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

test('the enabled package graph declares the existing client-store workspace dependency', () => {
  const packages = ['connection', 'ui-renderer', 'ui-schedule', 'ui-open-in-app', 'ui-plugin-manager', 'ui-trajectory']
  for (const name of packages) {
    const manifest = JSON.parse(readFileSync(join(repo, `packages/client/${name}/package.json`), 'utf8'))
    assert.ok(manifest.devDependencies?.['@deepseek-ai/dsh-client-store'], `${name} must declare client-store`)
  }
})
