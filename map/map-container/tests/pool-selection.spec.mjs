/** Keyring-backed selection: basemap catalog activation resolves one configured key. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveSourceCredentialEnv, sourceCredentialRefs } from '../src/plugin.ts'

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

/** Deployment config declaring the Tianditu WMTS binding. */
function sources() {
  return { credentials: { tianditu: { type: 'query', parameter: 'tk', env: 'TIANDITU_API_KEY' } } }
}

test('without a keyring the legacy single reference resolves unchanged', async () => {
  const env = await resolveSourceCredentialEnv(sources(), {}, credentials({ TIANDITU_API_KEY: 'legacy-tile-key' }))
  assert.equal(env.TIANDITU_API_KEY, 'legacy-tile-key')
})

test('a keyring selection overrides the legacy reference at catalog activation', async () => {
  const calls = []
  const env = await resolveSourceCredentialEnv(sources(), {}, credentials({ TIANDITU_API_KEY: 'legacy' }), keyring(['tile-key-a'], calls))
  assert.equal(env.TIANDITU_API_KEY, 'tile-key-a')
  assert.deepEqual(calls, ['tianditu'])
})

test('rebuilding the catalog selects again, so rotation advances per activation', async () => {
  const calls = []
  const kr = keyring(['tile-one', 'tile-two'], calls)
  const seam = credentials({ TIANDITU_API_KEY: 'legacy' })
  assert.equal((await resolveSourceCredentialEnv(sources(), {}, seam, kr)).TIANDITU_API_KEY, 'tile-one')
  assert.equal((await resolveSourceCredentialEnv(sources(), {}, seam, kr)).TIANDITU_API_KEY, 'tile-two')
  assert.deepEqual(calls, ['tianditu', 'tianditu'])
})

test('an exhausted keyring falls back to the legacy reference', async () => {
  const env = await resolveSourceCredentialEnv(sources(), {}, credentials({ TIANDITU_API_KEY: 'fallback-tile' }), keyring([]))
  assert.equal(env.TIANDITU_API_KEY, 'fallback-tile')
})

test('a keyring with no credentials seam still supplies a selected value', async () => {
  const env = await resolveSourceCredentialEnv(sources(), {}, undefined, keyring(['only-pool-tile']))
  assert.equal(env.TIANDITU_API_KEY, 'only-pool-tile')
})

test('numbered slot references keep the vendor prefix used for refresh', () => {
  assert.deepEqual([...sourceCredentialRefs(sources())], ['TIANDITU_API_KEY'])
  assert.equal('TIANDITU_API_KEY_2'.startsWith('TIANDITU_API_KEY_'), true)
  assert.equal('MAPBOX_ACCESS_TOKEN_3'.startsWith('MAPBOX_ACCESS_TOKEN_'), true)
  assert.equal('TIANDITU_SDK_KEY'.startsWith('TIANDITU_API_KEY_'), false)
})

test('a selected value never appears in a reference name or an overlay key', async () => {
  const env = await resolveSourceCredentialEnv(sources(), {}, credentials({}), keyring(['super-secret-tile']))
  assert.equal(Object.keys(env).includes('super-secret-tile'), false)
  assert.equal(env.TIANDITU_API_KEY, 'super-secret-tile')
})
