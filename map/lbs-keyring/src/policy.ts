/**
 * Pure LBS key selection and status projection. No I/O, no credential values,
 * no global state: every decision takes its inputs explicitly so the three
 * consumers and the settings page observe the same deterministic policy.
 *
 * @module @map-harness/lbs-keyring/policy
 */

import {
  emptyHealth, implicitPool, type LbsKeyHealth, type LbsKeyMode, type LbsKeyOutcome,
  type LbsKeySlot, type LbsSlotStatus, type LbsVendorId, type LbsVendorPool, type LbsVendorStatus,
} from './contract.ts'

/** One selection decision, expressed without any secret value. */
export interface LbsSlotChoice {
  readonly slot: LbsKeySlot
  readonly index: number
  readonly nextCursor: number
}

/** Inputs every selection needs. */
export interface LbsSelectionInput {
  /** Pool section for the vendor. */
  readonly pool: LbsVendorPool
  /** References the credentials provider reports as configured. */
  readonly configured: ReadonlySet<string>
  /** Current epoch milliseconds, injected by the caller. */
  readonly now: number
  /** Injectable uniform random source in `[0, 1)` for `random` mode. */
  readonly rng?: () => number
}

/** Cooldowns applied after a classified vendor failure. */
export const LBS_COOLDOWN_MS: Readonly<Record<LbsKeyOutcome, number>> = Object.freeze({
  success: 0,
  'rate-limited': 60_000,
  'permission-denied': 300_000,
  unavailable: 10_000,
})

/** Assert a closed union is exhaustive. */
function assertNever(value: never): never {
  throw new TypeError(`unknown LBS key mode: ${String(value)}`)
}

/**
 * Whether a slot may currently receive a selection.
 * @param slot - candidate slot.
 * @param health - the slot's runtime health.
 * @param input - selection inputs.
 * @returns true when enabled, configured and not cooling.
 */
export function eligible(slot: LbsKeySlot, health: LbsKeyHealth, input: LbsSelectionInput): boolean {
  if (!slot.enabled || !input.configured.has(slot.ref)) return false
  return health.cooldownUntil === undefined || health.cooldownUntil <= input.now
}

/**
 * Choose one slot according to the vendor's mode. Disabled, unconfigured and
 * cooling slots are skipped. When every slot is cooling the choice is
 * undefined, which tells the consumer to fall back to the legacy single ref.
 * @param input - selection inputs.
 * @returns the chosen slot and the cursor to carry forward, or undefined.
 */
export function selectSlot(input: LbsSelectionInput): LbsSlotChoice | undefined {
  const { pool } = input
  const candidates = pool.slots
    .map((slot, index) => ({ slot, index, health: pool.health[slot.id] ?? emptyHealth() }))
    .filter(entry => eligible(entry.slot, entry.health, input))
  const first = candidates[0]
  if (first === undefined) return undefined
  const mode: LbsKeyMode = pool.mode
  switch (mode) {
    case 'priority': {
      return { slot: first.slot, index: first.index, nextCursor: 0 }
    }
    case 'round-robin': {
      const start = pool.cursor % pool.slots.length
      const rotated = candidates.find(entry => entry.index >= start) ?? first
      return { slot: rotated.slot, index: rotated.index, nextCursor: (rotated.index + 1) % pool.slots.length }
    }
    case 'random': {
      const draw = input.rng ?? Math.random
      const offset = Math.min(Math.floor(draw() * candidates.length), candidates.length - 1)
      const chosen = candidates[Math.max(offset, 0)] ?? first
      return { slot: chosen.slot, index: chosen.index, nextCursor: (chosen.index + 1) % pool.slots.length }
    }
    default:
      return assertNever(mode)
  }
}

/**
 * Record the outcome of one use, returning a new pool section. Health carries
 * only outcome codes, counters and timestamps; the credential value and raw
 * vendor error text never enter the document.
 * @param pool - current pool section.
 * @param slotId - slot that served the request.
 * @param outcome - classified vendor outcome.
 * @param now - current epoch milliseconds.
 * @param cooldownScale - multiplier applied to the outcome's cooldown.
 * @returns a new pool section with updated health.
 */
export function reportOutcome(
  pool: LbsVendorPool, slotId: string, outcome: LbsKeyOutcome, now: number, cooldownScale: number,
): LbsVendorPool {
  const previous = pool.health[slotId] ?? emptyHealth()
  const cooldown = Math.round(LBS_COOLDOWN_MS[outcome] * cooldownScale)
  const health: LbsKeyHealth = {
    lastOutcome: outcome,
    cooldownUntil: cooldown > 0 ? now + cooldown : undefined,
    useCount: previous.useCount + 1,
    lastUsedAt: now,
  }
  return { ...pool, health: { ...pool.health, [slotId]: health } }
}

/**
 * Build the value-free per-slot status the settings page renders.
 * @param vendorId - vendor being projected.
 * @param pool - pool section, or undefined for an unconfigured vendor.
 * @param configured - references reported as configured.
 * @param writable - references reported as writable.
 * @param now - current epoch milliseconds.
 * @returns the vendor's status rows and summary.
 */
export function projectVendorStatus(
  vendorId: LbsVendorId,
  pool: LbsVendorPool | undefined,
  configured: ReadonlySet<string>,
  writable: ReadonlySet<string>,
  now: number,
): LbsVendorStatus {
  const resolved = pool ?? implicitPool(vendorId)
  const choice = selectSlot({ pool: resolved, configured, now, rng: () => 0 })
  const activeRef = choice?.slot.ref
  const slots: LbsSlotStatus[] = resolved.slots.map(slot => {
    const health = resolved.health[slot.id] ?? emptyHealth()
    return {
      slot,
      configured: configured.has(slot.ref),
      writable: writable.has(slot.ref),
      active: activeRef === slot.ref,
      cooling: health.cooldownUntil !== undefined && health.cooldownUntil > now,
      health,
    }
  })
  return {
    vendorId,
    mode: resolved.mode,
    slots,
    configuredCount: slots.filter(row => row.configured).length,
    activeRef,
  }
}
