/**
 * Host-side LBS keyring service: selects one configured key per vendor under
 * the vendor's mode, resolves its secret through the credentials seam, and
 * persists value-free selection health back to the settings namespace.
 *
 * Secret values never enter a status record, a settings document, an error or
 * a log. Failures are reported as classified outcome codes only.
 *
 * @module @map-harness/lbs-keyring/service
 */

import {
  normalizeDocument, poolOf, type LbsKeyOutcome, type LbsKeySelection,
  type LbsPoolDocument, type LbsVendorId, type LbsVendorPool,
} from './contract.ts'
import { reportOutcome, selectSlot } from './policy.ts'

/** Narrow settings-document face the service needs. */
export interface LbsKeyringSettings {
  /** @returns the current pool document projected from the settings namespace. */
  read(): unknown
  /** Persist a new pool document section. */
  write(vendors: Readonly<Partial<Record<LbsVendorId, LbsVendorPool>>>): Promise<void>
}

/** Narrow credentials seam face the service needs. */
export interface LbsKeyringCredentials {
  /** @returns the non-empty value for one reference, or undefined when absent. */
  resolve(ref: string): Promise<string | undefined>
  /** @returns whether each reference is configured. */
  describe(refs: readonly string[]): Promise<Readonly<Record<string, { configured: boolean }>>>
}

/** Injectable clock and rand for deterministic behavior. */
export interface LbsKeyringClock {
  /** @returns epoch milliseconds. */
  now(): number
  /** @returns a uniform random value in `[0, 1)`. */
  random(): number
}

/** Dependencies owned by the plugin's `apply`. */
export interface LbsKeyringDeps {
  readonly settings: LbsKeyringSettings
  readonly credentials: LbsKeyringCredentials
  readonly clock: LbsKeyringClock
  /** Multiplier applied to the outcome cooldowns. */
  readonly cooldownScale: number
}

/** One classified outcome from a consumer. */
export interface LbsOutcomeReport {
  readonly vendorId: LbsVendorId
  readonly slotId: string
  readonly outcome: LbsKeyOutcome
}

/** Capability seam face consumed by the three LBS credential consumers. */
export interface LbsKeyringService {
  /** @param vendorId - vendor whose key should serve the next operation. */
  select(vendorId: LbsVendorId): Promise<LbsKeySelection | undefined>
  /** @param report - classified outcome for one selected slot. */
  report(report: LbsOutcomeReport): Promise<void>
  /** @returns the current normalized pool document. */
  document(): LbsPoolDocument
}

/**
 * Build the keyring service over the injected settings and credentials faces.
 * @param deps - the plugin-owned dependencies.
 * @returns the service face consumers resolve through `ctx.get('lbsKeyring')`.
 */
export function createLbsKeyring(deps: LbsKeyringDeps): LbsKeyringService {
  /** Read and validate at the durable boundary on every operation. */
  function document(): LbsPoolDocument {
    return normalizeDocument(deps.settings.read())
  }

  /** Persist one vendor section without restating the whole document. */
  async function writeVendor(vendorId: LbsVendorId, pool: LbsVendorPool): Promise<void> {
    await deps.settings.write({ [vendorId]: pool })
  }

  return {
    document,
    async select(vendorId) {
      const current = document()
      const pool = poolOf(current, vendorId)
      const refs = pool.slots.map(slot => slot.ref)
      const described = await deps.credentials.describe(refs)
      const configured = new Set(refs.filter(ref => described[ref]?.configured === true))
      const choice = selectSlot({
        pool, configured, now: deps.clock.now(), rng: deps.clock.random,
      })
      if (choice === undefined) return undefined
      const value = await deps.credentials.resolve(choice.slot.ref)
      if (value === undefined) return undefined
      const updated: LbsVendorPool = {
        ...pool,
        cursor: choice.nextCursor,
        health: {
          ...pool.health,
          [choice.slot.id]: {
            lastOutcome: 'success',
            cooldownUntil: undefined,
            useCount: (pool.health[choice.slot.id]?.useCount ?? 0) + 1,
            lastUsedAt: deps.clock.now(),
          },
        },
      }
      await writeVendor(vendorId, updated)
      return { vendorId, slot: choice.slot, value, nextCursor: choice.nextCursor }
    },
    async report(report) {
      const current = document()
      const pool = poolOf(current, report.vendorId)
      const updated = reportOutcome(pool, report.slotId, report.outcome, deps.clock.now(), deps.cooldownScale)
      await writeVendor(report.vendorId, updated)
    },
  }
}
