import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LBS_MAX_KEYS_PER_VENDOR, LBS_VENDOR_IDS, normalizeDocument, poolOf, slotRef,
} from '../../lbs-keyring/src/contract.ts'
import {
  applyPoolEdit, baseRefOf, legacyRefs, projectPoolState, refsOf, vendorOp,
} from '../src/client/pool-model.ts'

/** Build a raw settings value with a configured two-slot Tianditu pool. */
function raw() {
  return { vendors: { tianditu: { mode: 'round-robin', cursor: 1, slots: [
    { id: 's0', ref: slotRef('tianditu', 0), label: '主', enabled: true },
    { id: 's1', ref: slotRef('tianditu', 1), label: '备', enabled: true },
  ], health: { s0: { lastOutcome: 'success', useCount: 7, lastUsedAt: 1234 } } } } }
}

/** Credential descriptions for a set of configured refs. */
function credentials(...refs) {
  return Object.fromEntries(refs.map(ref => [ref, { configured: true, writable: true }]))
}

/** Baseline projection inputs. */
function input(overrides = {}) {
  return {
    raw: raw(),
    credentials: credentials('TIANDITU_API_KEY', 'TIANDITU_API_KEY_2'),
    available: true,
    structured: true,
    writable: true,
    drafts: {},
    failed: new Set(),
    saving: false,
    now: 2000,
    ...overrides,
  }
}

test('projection renders one row per slot with per-slot configured, writable, active and cooling state', () => {
  const state = projectPoolState(input())
  assert.equal(state.vendors.length, LBS_VENDOR_IDS.length)
  const tianditu = state.vendors.find(vendor => vendor.id === 'tianditu')
  assert.equal(tianditu.rows.length, 2)
  assert.equal(tianditu.configuredCount, 2)
  assert.equal(tianditu.mode, 'round-robin')
  assert.equal(tianditu.rows[0].configured, true)
  assert.equal(tianditu.rows[0].writable, true)
  assert.equal(tianditu.rows[0].useCount, 7)
  assert.equal(tianditu.rows[0].lastUsedAt, 1234)
  assert.equal(state.maxKeys, LBS_MAX_KEYS_PER_VENDOR)
  assert.deepEqual([...state.modes], ['round-robin', 'priority', 'random'])
  assert.equal(state.shell.dirty, false)
  assert.equal(state.shell.available, true)
})

test('an unserved namespace projects the legacy single key per vendor and is read-only', () => {
  const state = projectPoolState(input({ available: true, structured: false, writable: false, raw: undefined }))
  for (const vendor of state.vendors) {
    assert.equal(vendor.rows.length, 1)
    assert.equal(vendor.rows[0].slot.ref, baseRefOf(vendor.id))
    assert.equal(vendor.canAdd, false)
    assert.equal(vendor.canRemove, false)
  }
  assert.equal(state.shell.available, true)
  assert.equal(state.shell.writable, false)
  assert.deepEqual([...legacyRefs()], LBS_VENDOR_IDS.map(baseRefOf))
})

test('staged drafts drive the dirty shell and failed rows surface without echoing secrets', () => {
  const state = projectPoolState(input({
    drafts: { 'tianditu:s0': 'new-secret' },
    failed: new Set(['tianditu:s1']),
    saving: true,
  }))
  assert.equal(state.shell.dirty, true)
  assert.equal(state.shell.saving, true)
  assert.equal(state.shell.failed, true)
  const tianditu = state.vendors.find(vendor => vendor.id === 'tianditu')
  assert.equal(tianditu.rows[0].text, 'new-secret')
  assert.equal(tianditu.rows[1].failed, true)
  assert.equal(state.shell.invalid, false)
})

test('add allocates the first unused stable reference and never renumbers existing slots', () => {
  const document = normalizeDocument(raw())
  const first = applyPoolEdit(document, { kind: 'add', vendorId: 'tianditu' }, { nextSlotSerial: 1 })
  assert.equal(first.added.ref, 'TIANDITU_API_KEY_3')
  assert.equal(first.added.enabled, true)
  assert.deepEqual(poolOf(first.document, 'tianditu').slots.map(slot => slot.ref), [
    'TIANDITU_API_KEY', 'TIANDITU_API_KEY_2', 'TIANDITU_API_KEY_3',
  ])
  const second = applyPoolEdit(first.document, { kind: 'remove', vendorId: 'tianditu', slotId: 's1' }, { nextSlotSerial: 2 })
  assert.deepEqual(poolOf(second.document, 'tianditu').slots.map(slot => slot.ref), [
    'TIANDITU_API_KEY', 'TIANDITU_API_KEY_3',
  ])
  const third = applyPoolEdit(second.document, { kind: 'add', vendorId: 'tianditu' }, { nextSlotSerial: 3 })
  assert.equal(third.added.ref, 'TIANDITU_API_KEY_2', 'a freed suffix is reused without touching other refs')
})

test('move, enable, mode and label edits keep references attached to their slots', () => {
  const document = normalizeDocument(raw())
  const moved = applyPoolEdit(document, { kind: 'move', vendorId: 'tianditu', slotId: 's1', delta: -1 }, { nextSlotSerial: 1 })
  assert.deepEqual(poolOf(moved.document, 'tianditu').slots.map(slot => slot.id), ['s1', 's0'])
  assert.deepEqual(poolOf(moved.document, 'tianditu').slots.map(slot => slot.ref), [
    'TIANDITU_API_KEY_2', 'TIANDITU_API_KEY',
  ])
  const disabled = applyPoolEdit(moved.document, { kind: 'enable', vendorId: 'tianditu', slotId: 's0', enabled: false }, { nextSlotSerial: 2 })
  assert.equal(poolOf(disabled.document, 'tianditu').slots.find(slot => slot.id === 's0').enabled, false)
  const mode = applyPoolEdit(disabled.document, { kind: 'mode', vendorId: 'tianditu', mode: 'priority' }, { nextSlotSerial: 3 })
  assert.equal(poolOf(mode.document, 'tianditu').mode, 'priority')
  assert.equal(poolOf(mode.document, 'tianditu').cursor, 0)
  const labeled = applyPoolEdit(mode.document, { kind: 'label', vendorId: 'tianditu', slotId: 's0', label: '备用线路' }, { nextSlotSerial: 4 })
  assert.equal(poolOf(labeled.document, 'tianditu').slots.find(slot => slot.id === 's0').label, '备用线路')
  assert.equal(poolOf(labeled.document, 'tianditu').slots.find(slot => slot.id === 's0').ref, 'TIANDITU_API_KEY')
})

test('add is capped, remove keeps at least one slot, and move out of range is a no-op', () => {
  let document = normalizeDocument(raw())
  for (let serial = 1; serial <= LBS_MAX_KEYS_PER_VENDOR + 2; serial += 1) {
    document = applyPoolEdit(document, { kind: 'add', vendorId: 'tianditu' }, { nextSlotSerial: serial }).document
  }
  assert.equal(poolOf(document, 'tianditu').slots.length, LBS_MAX_KEYS_PER_VENDOR)
  const capped = applyPoolEdit(document, { kind: 'add', vendorId: 'tianditu' }, { nextSlotSerial: 99 })
  assert.equal(capped.added, undefined)
  const single = normalizeDocument(null)
  assert.equal(applyPoolEdit(single, { kind: 'remove', vendorId: 'amap', slotId: 'amap-0' }, { nextSlotSerial: 1 }).added, undefined)
  assert.equal(poolOf(single, 'amap').slots.length, 1)
  const outOfRange = applyPoolEdit(document, { kind: 'move', vendorId: 'tianditu', slotId: 's0', delta: -1 }, { nextSlotSerial: 1 })
  assert.deepEqual(poolOf(outOfRange.document, 'tianditu').slots.map(slot => slot.id), poolOf(document, 'tianditu').slots.map(slot => slot.id))
})

test('refsOf stays bounded and vendorOp writes only one vendor section', () => {
  const refs = refsOf(raw())
  assert.equal(refs.includes('TIANDITU_API_KEY_2'), true)
  assert.ok(refs.length <= LBS_VENDOR_IDS.length * LBS_MAX_KEYS_PER_VENDOR)
  const op = vendorOp('amap', poolOf(normalizeDocument(raw()), 'amap'))
  assert.equal(op.op, 'set')
  assert.deepEqual(op.path, ['vendors', 'amap'])
  assert.ok(Array.isArray(op.value.slots))
})

test('a malformed namespace fails loud instead of silently dropping rows', () => {
  assert.throws(() => projectPoolState(input({ raw: { vendors: { tianditu: { mode: 'chaos' } } } })), /unknown LBS key mode/)
  assert.throws(() => refsOf({ vendors: { tianditu: { slots: [{ id: 'x', ref: 'bad-ref' }] } } }), /illegal LBS credential reference/)
})
