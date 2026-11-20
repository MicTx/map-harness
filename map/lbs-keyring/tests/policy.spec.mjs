import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LBS_BASE_REFS, LBS_MAX_KEYS_PER_VENDOR, LBS_VENDOR_IDS, allRefs, implicitPool,
  normalizeDocument, poolOf, slotRef, vendorOfRef,
} from '../src/contract.ts'
import { projectVendorStatus, reportOutcome, selectSlot } from '../src/policy.ts'

/** Build a vendor pool with numbered slots and an optional mode. */
function pool(mode = 'priority', count = 3) {
  return {
    mode,
    cursor: 0,
    slots: Array.from({ length: count }, (_, index) => ({
      id: `tianditu-${String(index)}`, ref: slotRef('tianditu', index), label: '', enabled: true,
    })),
    health: {},
  }
}

/** Configured set for the first `n` slots of a vendor. */
function configured(n, vendorId = 'tianditu') {
  return new Set(Array.from({ length: n }, (_, index) => slotRef(vendorId, index)))
}

test('slot zero keeps the legacy reference and extra slots stay inside the ref grammar', () => {
  assert.equal(slotRef('tianditu', 0), 'TIANDITU_API_KEY')
  assert.equal(slotRef('tianditu', 1), 'TIANDITU_API_KEY_2')
  assert.match(slotRef('mapbox', 7), /^[A-Za-z_][A-Za-z0-9_]*$/)
  for (const vendorId of LBS_VENDOR_IDS) {
    assert.equal(slotRef(vendorId, 0), LBS_BASE_REFS[vendorId])
  }
})

test('an absent vendor materializes an implicit single key so old deployments need no migration', () => {
  const document = normalizeDocument(null)
  for (const vendorId of LBS_VENDOR_IDS) {
    const resolved = poolOf(document, vendorId)
    assert.equal(resolved.slots.length, 1)
    assert.equal(resolved.slots[0].ref, LBS_BASE_REFS[vendorId])
    assert.equal(resolved.mode, 'priority')
  }
  assert.equal(implicitPool('amap').slots[0].ref, 'AMAP_API_KEY')
})

test('normalizeDocument rejects illegal refs, duplicate refs, foreign refs, bad modes and over-cap pools', () => {
  const vendor = (slots, extra = {}) => ({ vendors: { tianditu: { mode: 'priority', slots, ...extra } } })
  assert.throws(() => normalizeDocument(vendor([{ id: 'a', ref: 'bad-ref' }])), /illegal LBS credential reference/)
  assert.throws(() => normalizeDocument(vendor([
    { id: 'a', ref: 'TIANDITU_API_KEY' }, { id: 'b', ref: 'TIANDITU_API_KEY' },
  ])), /duplicate credential references/)
  assert.throws(() => normalizeDocument(vendor([{ id: 'a', ref: 'AMAP_API_KEY' }])), /belongs to another vendor/)
  assert.throws(() => normalizeDocument(vendor([], { mode: 'chaos' })), /unknown LBS key mode/)
  const many = Array.from({ length: LBS_MAX_KEYS_PER_VENDOR + 1 }, (_, index) => ({
    id: `s${String(index)}`, ref: slotRef('tianditu', index),
  }))
  assert.throws(() => normalizeDocument(vendor(many)), /exceeds the per-vendor slot bound/)
  assert.throws(() => normalizeDocument({ vendors: [] }), /vendors must be an object/)
})

test('normalizeDocument preserves slot order, labels, disabled flags, cursor and health', () => {
  const document = normalizeDocument({ vendors: { tianditu: {
    mode: 'round-robin', cursor: 5,
    slots: [
      { id: 'a', ref: 'TIANDITU_API_KEY', label: '主', enabled: true },
      { id: 'b', ref: 'TIANDITU_API_KEY_2', label: '备', enabled: false },
    ],
    health: { a: { lastOutcome: 'rate-limited', useCount: 4, lastUsedAt: 100, cooldownUntil: 500 } },
  } } })
  const resolved = poolOf(document, 'tianditu')
  assert.deepEqual(resolved.slots.map(slot => slot.ref), ['TIANDITU_API_KEY', 'TIANDITU_API_KEY_2'])
  assert.equal(resolved.slots[0].label, '主')
  assert.equal(resolved.slots[1].enabled, false)
  assert.equal(resolved.cursor, 1)
  assert.equal(resolved.health.a.useCount, 4)
  assert.equal(resolved.health.a.lastOutcome, 'rate-limited')
  assert.equal(allRefs(document).includes('TIANDITU_API_KEY_2'), true)
  assert.equal(vendorOfRef('TIANDITU_API_KEY_2', document), 'tianditu')
  assert.equal(vendorOfRef('AMAP_API_KEY', document), 'amap')
  assert.equal(vendorOfRef('UNRELATED', document), undefined)
})

test('priority mode always picks the first eligible slot in declared order', () => {
  const p = pool('priority', 3)
  const input = { pool: p, configured: configured(3), now: 0 }
  assert.equal(selectSlot(input).slot.ref, 'TIANDITU_API_KEY')
  assert.equal(selectSlot(input).nextCursor, 0)
  const skipped = { ...input, configured: new Set(['TIANDITU_API_KEY_3']) }
  assert.equal(selectSlot(skipped).slot.ref, 'TIANDITU_API_KEY_3')
})

test('round-robin advances through configured slots and wraps at the end', () => {
  let cursor = 0
  const seen = []
  for (let step = 0; step < 4; step += 1) {
    const choice = selectSlot({ pool: { ...pool('round-robin', 3), cursor }, configured: configured(3), now: 0 })
    seen.push(choice.slot.ref)
    cursor = choice.nextCursor
  }
  assert.deepEqual(seen, [
    'TIANDITU_API_KEY', 'TIANDITU_API_KEY_2', 'TIANDITU_API_KEY_3', 'TIANDITU_API_KEY',
  ])
})

test('round-robin and priority skip disabled, unconfigured and cooling slots', () => {
  const p = pool('round-robin', 3)
  const withDisabled = { ...p, slots: p.slots.map((slot, index) => index === 0 ? { ...slot, enabled: false } : slot) }
  assert.equal(selectSlot({ pool: withDisabled, configured: configured(3), now: 0 }).slot.ref, 'TIANDITU_API_KEY_2')
  const cooling = {
    ...p,
    health: { 'tianditu-0': { lastOutcome: 'rate-limited', cooldownUntil: 5000, useCount: 1, lastUsedAt: 0 } },
  }
  assert.equal(selectSlot({ pool: cooling, configured: configured(3), now: 1000 }).slot.ref, 'TIANDITU_API_KEY_2')
  assert.equal(selectSlot({ pool: cooling, configured: configured(3), now: 6000 }).slot.ref, 'TIANDITU_API_KEY')
  assert.equal(selectSlot({ pool: cooling, configured: configured(0), now: 0 }), undefined)
})

test('random mode uses the injected source and stays inside the eligible set', () => {
  const p = pool('random', 3)
  const input = { pool: p, configured: configured(3), now: 0 }
  assert.equal(selectSlot({ ...input, rng: () => 0 }).slot.ref, 'TIANDITU_API_KEY')
  assert.equal(selectSlot({ ...input, rng: () => 0.5 }).slot.ref, 'TIANDITU_API_KEY_2')
  assert.equal(selectSlot({ ...input, rng: () => 0.99 }).slot.ref, 'TIANDITU_API_KEY_3')
  const limited = { ...input, configured: new Set(['TIANDITU_API_KEY_3']), rng: () => 0.99 }
  assert.equal(selectSlot(limited).slot.ref, 'TIANDITU_API_KEY_3')
})

test('reportOutcome records codes, counters and cooldowns without ever carrying a secret', () => {
  const p = pool('round-robin', 2)
  const limited = reportOutcome(p, 'tianditu-0', 'rate-limited', 1000, 1)
  assert.equal(limited.health['tianditu-0'].lastOutcome, 'rate-limited')
  assert.equal(limited.health['tianditu-0'].cooldownUntil, 61_000)
  assert.equal(limited.health['tianditu-0'].useCount, 1)
  assert.equal(limited.health['tianditu-0'].lastUsedAt, 1000)
  const denied = reportOutcome(limited, 'tianditu-0', 'permission-denied', 2000, 2)
  assert.equal(denied.health['tianditu-0'].cooldownUntil, 602_000)
  assert.equal(denied.health['tianditu-0'].useCount, 2)
  const success = reportOutcome(denied, 'tianditu-0', 'success', 3000, 1)
  assert.equal(success.health['tianditu-0'].cooldownUntil, undefined)
  assert.equal(success.health['tianditu-0'].useCount, 3)
  assert.equal(p.health['tianditu-0'], undefined, 'the input pool stays immutable')
  assert.equal(JSON.stringify(success).includes('secret-value'), false)
})

test('projectVendorStatus reports per-slot configured, writable, active and cooling state', () => {
  const p = pool('priority', 3)
  const status = projectVendorStatus('tianditu', p, configured(2), new Set(['TIANDITU_API_KEY']), 0)
  assert.equal(status.configuredCount, 2)
  assert.equal(status.activeRef, 'TIANDITU_API_KEY')
  assert.equal(status.slots[0].active, true)
  assert.equal(status.slots[0].writable, true)
  assert.equal(status.slots[1].active, false)
  assert.equal(status.slots[1].writable, false)
  assert.equal(status.slots[2].configured, false)
  const cooling = reportOutcome(p, 'tianditu-0', 'rate-limited', 0, 1)
  const cooled = projectVendorStatus('tianditu', cooling, configured(3), new Set(), 1000)
  assert.equal(cooled.slots[0].cooling, true)
  assert.equal(cooled.activeRef, 'TIANDITU_API_KEY_2')
  assert.equal(JSON.stringify(cooled).includes('TIANDITU_API_KEY_2'), true)
})

test('allRefs stays inside the Remote describe batch bound of 64', () => {
  const document = normalizeDocument({ vendors: Object.fromEntries(LBS_VENDOR_IDS.map(vendorId => [
    vendorId,
    { mode: 'round-robin', slots: Array.from({ length: LBS_MAX_KEYS_PER_VENDOR }, (_, index) => ({
      id: `${vendorId}-${String(index)}`, ref: slotRef(vendorId, index), label: '', enabled: true,
    })) },
  ])) })
  assert.equal(allRefs(document).length, LBS_VENDOR_IDS.length * LBS_MAX_KEYS_PER_VENDOR)
  assert.ok(allRefs(document).length <= 64)
})
