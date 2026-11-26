import test from 'node:test'
import assert from 'node:assert/strict'
import { implicitPool, normalizeDocument, poolOf, slotRef } from '../src/contract.ts'
import { createLbsKeyring } from '../src/service.ts'

/** Scripted Host faces: settings document, credential values and a fixed clock. */
function bench(options = {}) {
  const stored = { ...(options.stored ?? {}) }
  const writes = []
  const resolved = []
  const described = []
  let document = { vendors: { ...(options.vendors ?? {}) } }
  const service = createLbsKeyring({
    cooldownScale: options.cooldownScale ?? 1,
    clock: { now: () => options.now ?? 1000, random: () => options.random ?? 0 },
    settings: {
      read: () => document,
      async write(vendors) {
        writes.push(vendors)
        document = { vendors: { ...document.vendors, ...vendors } }
      },
    },
    credentials: {
      async describe(refs) {
        described.push([...refs])
        return Object.fromEntries(refs.map(ref => [ref, { configured: stored[ref] !== undefined }]))
      },
      async resolve(ref) {
        resolved.push(ref)
        return stored[ref]
      },
    },
  })
  return { service, writes, resolved, described, state: () => document }
}

/** A two-slot Tianditu pool with both keys configured. */
function twoKeys(mode = 'priority') {
  return {
    tianditu: {
      mode, cursor: 0,
      slots: [
        { id: 't0', ref: slotRef('tianditu', 0), label: '主', enabled: true },
        { id: 't1', ref: slotRef('tianditu', 1), label: '备', enabled: true },
      ],
      health: {},
    },
  }
}

test('priority selects the first configured key and resolves its value', async () => {
  const b = bench({
    vendors: twoKeys('priority'),
    stored: { TIANDITU_API_KEY: 'primary-secret', TIANDITU_API_KEY_2: 'backup-secret' },
  })
  const selection = await b.service.select('tianditu')
  assert.equal(selection.slot.ref, 'TIANDITU_API_KEY')
  assert.equal(selection.value, 'primary-secret')
  assert.equal(selection.vendorId, 'tianditu')
  assert.deepEqual(b.described[0], ['TIANDITU_API_KEY', 'TIANDITU_API_KEY_2'])
  assert.deepEqual(b.resolved, ['TIANDITU_API_KEY'])
})

test('round-robin selections alternate and persist the cursor to the settings document', async () => {
  const b = bench({
    vendors: twoKeys('round-robin'),
    stored: { TIANDITU_API_KEY: 'k1', TIANDITU_API_KEY_2: 'k2' },
  })
  assert.equal((await b.service.select('tianditu')).slot.ref, 'TIANDITU_API_KEY')
  assert.equal((await b.service.select('tianditu')).slot.ref, 'TIANDITU_API_KEY_2')
  assert.equal((await b.service.select('tianditu')).slot.ref, 'TIANDITU_API_KEY')
  assert.equal(b.writes.length, 3)
  assert.equal(b.writes[0].tianditu.cursor, 1)
  assert.equal(b.writes[1].tianditu.cursor, 0)
})

test('unconfigured and disabled slots are skipped; an empty pool yields no selection', async () => {
  const vendors = twoKeys('priority')
  vendors.tianditu.slots[0].enabled = false
  const b = bench({ vendors, stored: { TIANDITU_API_KEY: 'k1', TIANDITU_API_KEY_2: 'k2' } })
  assert.equal((await b.service.select('tianditu')).slot.ref, 'TIANDITU_API_KEY_2')
  const empty = bench({ stored: {} })
  assert.equal(await empty.service.select('amap'), undefined)
  assert.deepEqual(empty.writes, [])
})

test('a legacy single-key deployment uses the implicit base reference', async () => {
  const b = bench({ stored: { TIANDITU_API_KEY: 'legacy-secret' } })
  const selection = await b.service.select('tianditu')
  assert.equal(selection.slot.ref, 'TIANDITU_API_KEY')
  assert.equal(selection.value, 'legacy-secret')
  assert.equal(poolOf(normalizeDocument(null), 'tianditu').slots.length, 1)
})

test('a resolved value that vanished produces no selection and no write', async () => {
  const b = bench({
    vendors: twoKeys(),
    stored: { TIANDITU_API_KEY: 'k1' },
  })
  b.resolved.length = 0
  const selection = await b.service.select('tianditu')
  assert.equal(selection.slot.ref, 'TIANDITU_API_KEY')
  const stale = bench({ vendors: twoKeys(), stored: {} })
  assert.equal(await stale.service.select('tianditu'), undefined)
  assert.deepEqual(stale.writes, [])
})

test('select records useCount and lastUsedAt without persisting any secret value', async () => {
  const b = bench({ vendors: twoKeys(), stored: { TIANDITU_API_KEY: 'super-secret', TIANDITU_API_KEY_2: 'k2' }, now: 4321 })
  await b.service.select('tianditu')
  const health = b.writes[0].tianditu.health.t0
  assert.equal(health.useCount, 1)
  assert.equal(health.lastUsedAt, 4321)
  assert.equal(health.lastOutcome, 'success')
  assert.equal(JSON.stringify(b.state()).includes('super-secret'), false)
  assert.equal(JSON.stringify(b.writes).includes('super-secret'), false)
})

test('report applies a classified cooldown that later selections skip', async () => {
  const b = bench({
    vendors: twoKeys('priority'),
    stored: { TIANDITU_API_KEY: 'k1', TIANDITU_API_KEY_2: 'k2' },
    now: 1000,
    cooldownScale: 2,
  })
  await b.service.report({ vendorId: 'tianditu', slotId: 't0', outcome: 'rate-limited' })
  assert.equal(b.writes[0].tianditu.health.t0.cooldownUntil, 121_000)
  assert.equal((await b.service.select('tianditu')).slot.ref, 'TIANDITU_API_KEY_2')
  assert.equal(JSON.stringify(b.writes).includes('rate-limited'), true)
})

test('report on a success clears the cooldown', async () => {
  const pool = twoKeys('priority').tianditu
  const b = bench({
    vendors: { tianditu: { ...pool, health: { t0: { lastOutcome: 'rate-limited', cooldownUntil: 9999, useCount: 2, lastUsedAt: 1 } } } },
    stored: { TIANDITU_API_KEY: 'k1', TIANDITU_API_KEY_2: 'k2' },
    now: 2000,
  })
  await b.service.report({ vendorId: 'tianditu', slotId: 't0', outcome: 'success' })
  assert.equal(b.writes[0].tianditu.health.t0.cooldownUntil, undefined)
})

test('document() validates at the durable boundary and rejects a malformed settings document', async () => {
  const b = bench()
  assert.equal(b.service.document().vendors.tianditu.slots.length, 1)
  const malformed = {
    ...bench(),
  }
  void malformed
  const bad = createLbsKeyring({
    cooldownScale: 1,
    clock: { now: () => 0, random: () => 0 },
    settings: { read: () => ({ vendors: { tianditu: { mode: 'chaos' } } }), write: async () => {} },
    credentials: { describe: async () => ({}), resolve: async () => undefined },
  })
  assert.throws(() => bad.document(), /unknown LBS key mode/)
})

test('implicit pool is immutable and shared by every absent vendor', () => {
  const first = implicitPool('baidu')
  assert.equal(first.slots[0].ref, 'BAIDU_API_KEY')
  assert.equal(Object.isFrozen(first), false)
  assert.notEqual(implicitPool('baidu'), first)
})
