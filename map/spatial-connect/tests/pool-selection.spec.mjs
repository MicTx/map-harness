/** Keyring-backed selection: online search resolves one configured key per call. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveCredentialEnv } from '../src/plugin.ts'

/** Scripted credentials seam with one value per reference. */
function credentials(values) {
  return {
    resolve: async (ref) => values[ref] === undefined ? undefined : { value: values[ref], source: 'file' },
    describe: async (ref) => ({ configured: values[ref] !== undefined, writable: true }),
  }
}

/** Scripted keyring whose selections advance through a caller-owned sequence. */
function keyring(sequence, calls = []) {
  return {
    async select(vendorId) {
      calls.push(vendorId)
      const next = sequence.shift()
      return next === undefined ? undefined : { slot: { id: `s${String(next)}`, ref: 'TIANDITU_API_KEY' }, value: next }
    },
    async report() {},
  }
}

/** Deployment config with the optional Tianditu search lane declared. */
function config() {
  return { tianditu: { apiKeyEnv: 'TIANDITU_API_KEY' } }
}

test('without a keyring the legacy single reference resolves unchanged', async () => {
  const env = await resolveCredentialEnv(config(), {}, credentials({ TIANDITU_API_KEY: 'legacy-key' }))
  assert.equal(env.TIANDITU_API_KEY, 'legacy-key')
})

test('a keyring selection overrides the legacy reference for one search', async () => {
  const calls = []
  const env = await resolveCredentialEnv(config(), {}, credentials({ TIANDITU_API_KEY: 'legacy-key' }), keyring(['search-key-a'], calls))
  assert.equal(env.TIANDITU_API_KEY, 'search-key-a')
  assert.deepEqual(calls, ['tianditu'])
})

test('consecutive searches rotate across pool keys', async () => {
  const calls = []
  const kr = keyring(['key-one', 'key-two', 'key-three'], calls)
  const seam = credentials({ TIANDITU_API_KEY: 'legacy-key' })
  assert.equal((await resolveCredentialEnv(config(), {}, seam, kr)).TIANDITU_API_KEY, 'key-one')
  assert.equal((await resolveCredentialEnv(config(), {}, seam, kr)).TIANDITU_API_KEY, 'key-two')
  assert.equal((await resolveCredentialEnv(config(), {}, seam, kr)).TIANDITU_API_KEY, 'key-three')
  assert.deepEqual(calls, ['tianditu', 'tianditu', 'tianditu'])
})

test('non-LBS connection credentials still resolve through the seam', async () => {
  const kr = keyring(['pool-key'])
  const cfg = {
    tianditu: { apiKeyEnv: 'TIANDITU_API_KEY' },
    postgis: [{ id: 'db', passwordEnv: 'PG_PASSWORD' }],
  }
  const env = await resolveCredentialEnv(cfg, {}, credentials({ TIANDITU_API_KEY: 'legacy', PG_PASSWORD: 'db-secret' }), kr)
  assert.equal(env.TIANDITU_API_KEY, 'pool-key')
  assert.equal(env.PG_PASSWORD, 'db-secret')
})

test('an exhausted keyring falls back to the legacy reference and an undefined keyring keeps ambient env', async () => {
  const fallback = await resolveCredentialEnv(config(), {}, credentials({ TIANDITU_API_KEY: 'fallback' }), keyring([]))
  assert.equal(fallback.TIANDITU_API_KEY, 'fallback')
  const ambient = await resolveCredentialEnv(config(), { TIANDITU_API_KEY: 'ambient-key' }, undefined)
  assert.equal(ambient.TIANDITU_API_KEY, 'ambient-key')
})

test('a selected value never enters a reference name or the ambient overlay keys', async () => {
  const env = await resolveCredentialEnv(config(), {}, credentials({}), keyring(['super-secret']))
  assert.equal(Object.keys(env).includes('super-secret'), false)
  assert.equal(env.TIANDITU_API_KEY, 'super-secret')
})
