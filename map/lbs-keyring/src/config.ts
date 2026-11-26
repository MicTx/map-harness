/**
 * Volatile settings namespace for LBS key pools. The namespace id is the
 * map-web profile entry id, so the settings page and the Host service address
 * the same document through `configForms` / `ctx.settings`.
 *
 * @module @map-harness/lbs-keyring/config
 */

import z from '@deepseek-ai/schemastery'
import { LBS_KEY_MODES } from './contract.ts'

export { LBS_KEYRING_NS } from './contract.ts'

/** One ordered slot. */
const slot = z.object({
  id: z.string().required(),
  ref: z.string().required(),
  label: z.string().default(''),
  enabled: z.boolean().default(true),
})

/** Runtime health records are validated by `normalizeDocument` at the read boundary. */
const pool = z.object({
  mode: z.union(LBS_KEY_MODES).default('priority'),
  slots: z.array(slot).default([]),
  cursor: z.natural().default(0),
  health: z.dict(z.any()).default({}),
})

/**
 * Deployment config. `vendors` is volatile so the page can add, remove and
 * reorder keys without remounting the plugin; absent vendors keep the legacy
 * single-key behavior through `normalizeDocument`.
 */
export const Config = z.object({
  vendors: z.dict(pool).default({}).volatile(),
  cooldownScale: z.number().min(0).max(10).default(1).volatile(),
})

/** Resolved config type; volatile fields are stable references with `.get()`. */
export interface LbsKeyringConfig {
  /** Pool sections keyed by vendor id. */
  vendors: { get(): unknown }
  /** Multiplier for outcome cooldowns. */
  cooldownScale: { get(): number }
}
