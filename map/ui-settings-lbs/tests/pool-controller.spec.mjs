import test from 'node:test'
import assert from 'node:assert/strict'
import { LBS_KEYRING_NS, LBS_VENDOR_IDS, slotRef } from '../../lbs-keyring/src/contract.ts'
import { LbsPoolController } from '../src/client/pool-controller.ts'

/** Scripted settings namespace + credentials Remote with call logs. */
function bench(options = {}) {
  const configured = new Set(options.configured ?? ['TIANDITU_API_KEY'])
  const unwritable = new Set(options.unwritable ?? [])
  const describeCalls = []
  const setCalls = []
  const unsetCalls = []
  const mutateCalls = []
  let snapshot = {
    status: options.unavailable === true ? 'unavailable' : 'ready',
    value: options.value ?? { vendors: { tianditu: { mode: 'priority', slots: [
      { id: 's0', ref: slotRef('tianditu', 0), label: '', enabled: true },
      { id: 's1', ref: slotRef('tianditu', 1), label: '', enabled: true },
    ], cursor: 0 } } },
    writable: options.readOnly !== true,
    revision: 4,
  }
  const listeners = new Set()
  const form = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    async mutate(ops, revision) {
      mutateCalls.push({ ops, revision })
      if (options.refuseMutate === true) return false
      const [first] = ops
      const [, vendorId] = first.path
      snapshot = { ...snapshot, value: { vendors: { ...snapshot.value.vendors, [vendorId]: first.value } }, revision: revision + 1 }
      return true
    },
  }
  const remote = {
    credentials: {
      describe(refs) {
        describeCalls.push([...refs])
        if (options.describeFails === true) return Promise.resolve({ ok: false, value: {} })
        return Promise.resolve({ ok: true, value: Object.fromEntries(refs.map(ref => [ref, {
          configured: configured.has(ref), writable: !unwritable.has(ref),
        }])) })
      },
      set(ref, value) {
        setCalls.push([ref, value])
        if (options.refuseSet === true) return Promise.reject(new Error('credential/rejected'))
        configured.add(ref)
        return Promise.resolve()
      },
      unset(ref) { unsetCalls.push(ref); configured.delete(ref); return Promise.resolve() },
    },
  }
  const ctx = {
    remote,
    configForms: { get(ns) { assert.equal(ns, LBS_KEYRING_NS); return form } },
  }
  const controller = new LbsPoolController(ctx)
  return { controller, face: controller.inject(), describeCalls, setCalls, unsetCalls, mutateCalls, configured }
}

/** Wait for the controller's fire-and-forget save to settle. */
async function settled(face) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!face.hooks.lbs.getSnapshot().shell.saving) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('save did not settle')
}

test('load describes every named reference in one batch and publishes a six-vendor state', async () => {
  const b = bench()
  await b.face.load()
  assert.equal(b.describeCalls.length, 1)
  assert.equal(b.describeCalls[0].length, LBS_VENDOR_IDS.length + 1)
  assert.equal(b.describeCalls[0].includes('TIANDITU_API_KEY_2'), true)
  const state = b.face.hooks.lbs.getSnapshot()
  assert.equal(state.vendors.length, LBS_VENDOR_IDS.length)
  assert.equal(state.shell.available, true)
  assert.equal(state.shell.writable, true)
  const tianditu = state.vendors.find(vendor => vendor.id === 'tianditu')
  assert.equal(tianditu.rows[0].configured, true)
  assert.equal(tianditu.rows[1].configured, false)
  assert.equal(tianditu.rows.every(row => row.text === ''), true)
  b.controller.dispose()
})

test('an unserved namespace keeps the legacy single-key rows and stays read-only', async () => {
  const b = bench({ unavailable: true })
  await b.face.load()
  const state = b.face.hooks.lbs.getSnapshot()
  for (const vendor of state.vendors) assert.equal(vendor.rows.length, 1)
  assert.equal(state.shell.available, true)
  assert.equal(state.shell.writable, false)
  assert.equal(b.describeCalls[0].length, LBS_VENDOR_IDS.length)
  b.controller.dispose()
})

test('a failed describe marks the form unavailable with no configured rows', async () => {
  const b = bench({ describeFails: true })
  await b.face.load()
  const state = b.face.hooks.lbs.getSnapshot()
  assert.equal(state.shell.available, false)
  assert.equal(state.vendors.every(vendor => vendor.rows.every(row => !row.configured)), true)
  b.controller.dispose()
})

test('a staged draft saves through credentials.set and never seeds a stored value back', async () => {
  const b = bench()
  await b.face.load()
  b.face.actions.edit('tianditu:s0', '  new-secret  ')
  assert.equal(b.face.hooks.lbs.getSnapshot().shell.dirty, true)
  b.face.actions.save()
  await settled(b.face)
  assert.deepEqual(b.setCalls, [['TIANDITU_API_KEY', 'new-secret']])
  const state = b.face.hooks.lbs.getSnapshot()
  assert.equal(state.shell.dirty, false)
  assert.equal(state.vendors.find(v => v.id === 'tianditu').rows[0].text, '')
  b.controller.dispose()
})

test('an empty draft never writes, and discard drops every draft', async () => {
  const b = bench()
  await b.face.load()
  b.face.actions.edit('tianditu:s0', '   ')
  b.face.actions.save()
  await settled(b.face)
  assert.deepEqual(b.setCalls, [])
  b.face.actions.discard()
  assert.equal(b.face.hooks.lbs.getSnapshot().shell.dirty, false)
  b.controller.dispose()
})

test('a refused write keeps only its own draft and marks that row failed', async () => {
  const b = bench({ refuseSet: true })
  await b.face.load()
  b.face.actions.edit('tianditu:s0', 'rejected')
  b.face.actions.save()
  await settled(b.face)
  const state = b.face.hooks.lbs.getSnapshot()
  assert.equal(state.vendors.find(v => v.id === 'tianditu').rows[0].failed, true)
  assert.equal(state.vendors.find(v => v.id === 'tianditu').rows[0].text, 'rejected')
  assert.equal(state.vendors.find(v => v.id === 'tianditu').rows[1].failed, false)
  b.controller.dispose()
})

test('clear goes through credentials.unset and refreshes the row', async () => {
  const b = bench()
  await b.face.load()
  await b.face.clear('tianditu', slotRef('tianditu', 0))
  assert.deepEqual(b.unsetCalls, ['TIANDITU_API_KEY'])
  assert.equal(b.face.hooks.lbs.getSnapshot().vendors.find(v => v.id === 'tianditu').rows[0].configured, false)
  b.controller.dispose()
})

test('a structural add writes one path op for the vendor and clears a removed key', async () => {
  const b = bench()
  await b.face.load()
  await b.face.edit({ kind: 'add', vendorId: 'tianditu' })
  assert.equal(b.mutateCalls.length, 1)
  assert.deepEqual(b.mutateCalls[0].ops[0].path, ['vendors', 'tianditu'])
  assert.equal(b.mutateCalls[0].revision, 4)
  assert.equal(b.face.hooks.lbs.getSnapshot().vendors.find(v => v.id === 'tianditu').rows.length, 3)
  await b.face.edit({ kind: 'remove', vendorId: 'tianditu', slotId: 's1' })
  assert.equal(b.face.hooks.lbs.getSnapshot().vendors.find(v => v.id === 'tianditu').rows.length, 2)
  b.controller.dispose()
})

test('a refused structural edit marks the structure failed and does not write credentials', async () => {
  const b = bench({ refuseMutate: true })
  await b.face.load()
  await b.face.edit({ kind: 'mode', vendorId: 'tianditu', mode: 'random' })
  assert.equal(b.face.hooks.lbs.getSnapshot().shell.failed, true)
  assert.deepEqual(b.setCalls, [])
  assert.deepEqual(b.unsetCalls, [])
  b.controller.dispose()
})

test('the injected face keeps stable load/actions references and disposal releases listeners', () => {
  const b = bench()
  assert.equal(b.controller.inject(), b.face)
  assert.equal(b.controller.inject().actions, b.face.actions)
  b.controller.dispose()
  b.controller.dispose()
})

test('applyCard commits staged keys, a new key and a mode as one card unit', async () => {
  const b = bench({ configured: ['TIANDITU_API_KEY'] })
  await b.face.load()
  const result = await b.face.applyCard({
    vendorId: 'tianditu',
    keys: { s1: 'backup-secret' },
    newKey: 'third-secret',
    mode: 'round-robin',
  })
  assert.deepEqual(result.failed, [])
  assert.ok(b.setCalls.some(([ref, value]) => ref === 'TIANDITU_API_KEY_2' && value === 'backup-secret'))
  assert.ok(b.setCalls.some(([, value]) => value === 'third-secret'))
  assert.equal(b.mutateCalls.length, 1)
  const tianditu = b.face.hooks.lbs.getSnapshot().vendors.find(v => v.id === 'tianditu')
  assert.equal(tianditu.mode, 'round-robin')
  assert.equal(tianditu.rows.length, 3)
  b.controller.dispose()
})

test('applyCard reports a refused credential write and keeps the namespace edit', async () => {
  const b = bench({ configured: [], refuseSet: true })
  await b.face.load()
  const result = await b.face.applyCard({ vendorId: 'tianditu', keys: { s0: 'rejected' } })
  assert.deepEqual(result.failed, ['s0'])
  assert.equal(b.face.hooks.lbs.getSnapshot().vendors.find(v => v.id === 'tianditu').rows[0].configured, false)
  b.controller.dispose()
})

test('applyCard refuses every staged field when the namespace write is rejected', async () => {
  const b = bench({ configured: [], refuseMutate: true })
  await b.face.load()
  const result = await b.face.applyCard({ vendorId: 'tianditu', keys: { s0: 'x' }, newKey: 'y' })
  assert.deepEqual(result.failed, ['s0'])
  assert.deepEqual(b.setCalls, [])
  b.controller.dispose()
})

test('removeSlot clears the credential and drops the slot, keeping at least one', async () => {
  const b = bench({ configured: ['TIANDITU_API_KEY', 'TIANDITU_API_KEY_2'] })
  await b.face.load()
  await b.face.removeSlot('tianditu', 's1')
  assert.deepEqual(b.unsetCalls, ['TIANDITU_API_KEY_2'])
  assert.equal(b.face.hooks.lbs.getSnapshot().vendors.find(v => v.id === 'tianditu').rows.length, 1)
  await b.face.removeSlot('tianditu', 's0')
  assert.equal(b.face.hooks.lbs.getSnapshot().vendors.find(v => v.id === 'tianditu').rows.length, 1)
  b.controller.dispose()
})
