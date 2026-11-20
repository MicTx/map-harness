/** Keyring-backed selection: accessibility resolves one configured key per run submission. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveCredentialEnv } from '../src/plugin.ts'

/** Scripted credentials seam with one value per reference. */
function credentials(values) {
  return {
    resolve: async (ref) => values[ref] === undefined ? undefined : { value: values[ref], source: 'file' },
    describe: async (ref) => ({ configured: values[ref] !== undefined, writable: true }),
  }
}

/** Scripted keyring that rotates through configured values. */
function keyring(sequence, calls = []) {
  return {
    async select(vendorId) {
      calls.push(vendorId)
      const next = sequence.shift()
      return next === undefined ? undefined : { slot: { id: `s${String(next)}`, ref: `TIANDITU_API_KEY_${String(next)}` }, value: next }
    },
    async report() {},
  }
}

/** Deployment config selecting the Tianditu REST lane. */
function config() {
  return { root: '/tmp/accessibility-pool', provider: 'tianditu-road-network' }
}

test('without a keyring the legacy single reference resolves unchanged', async () => {
  const env = await resolveCredentialEnv(config(), {}, credentials({ TIANDITU_API_KEY: 'legacy-key' }))
  assert.equal(env.TIANDITU_API_KEY, 'legacy-key')
})

test('a keyring selection overrides the legacy reference for this run submission', async () => {
  const calls = []
  const kr = keyring(['pool-key-a'], calls)
  const env = await resolveCredentialEnv(config(), {}, credentials({ TIANDITU_API_KEY: 'legacy-key' }), kr)
  assert.equal(env.TIANDITU_API_KEY, 'pool-key-a')
  assert.deepEqual(calls, ['tianditu'])
})

test('each submission selects again, so rotation advances across runs', async () => {
  const calls = []
  const kr = keyring(['first-key', 'second-key'], calls)
  const seam = credentials({ TIANDITU_API_KEY: 'legacy-key' })
  const first = await resolveCredentialEnv(config(), {}, seam, kr)
  const second = await resolveCredentialEnv(config(), {}, seam, kr)
  assert.equal(first.TIANDITU_API_KEY, 'first-key')
  assert.equal(second.TIANDITU_API_KEY, 'second-key')
  assert.deepEqual(calls, ['tianditu', 'tianditu'])
})

test('an exhausted keyring falls back to the legacy reference', async () => {
  const kr = keyring([])
  const env = await resolveCredentialEnv(config(), {}, credentials({ TIANDITU_API_KEY: 'fallback-key' }), kr)
  assert.equal(env.TIANDITU_API_KEY, 'fallback-key')
})

test('a keyring with no credentials seam still supplies a selected value', async () => {
  const kr = keyring(['only-pool-key'])
  const env = await resolveCredentialEnv(config(), {}, undefined, kr)
  assert.equal(env.TIANDITU_API_KEY, 'only-pool-key')
})

test('unrelated connection references never reach the keyring', async () => {
  const calls = []
  const kr = keyring(['unused'], calls)
  const cfg = { root: '/tmp/accessibility-pool', provider: 'controlled-lattice' }
  const env = await resolveCredentialEnv(cfg, { OTHER: 'ambient' }, credentials({}), kr)
  assert.equal(env.OTHER, 'ambient')
  assert.deepEqual(calls, [])
})

test('a resolved value never appears in a credential reference or error text', async () => {
  const kr = keyring(['super-secret-value'])
  const env = await resolveCredentialEnv(config(), {}, credentials({}), kr)
  assert.equal(Object.keys(env).includes('super-secret-value'), false)
  assert.equal(JSON.stringify(Object.keys(env)).includes('super-secret-value'), false)
})

/** Probe helper so the branded ref constructor stays exercised by the suite. */
test('credential references keep the POSIX grammar for numbered slots', () => {
  assert.equal(credentialRef('TIANDITU_API_KEY_2'), 'TIANDITU_API_KEY_2')
})
