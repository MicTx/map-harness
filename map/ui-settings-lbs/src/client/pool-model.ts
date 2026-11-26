/**
 * Pure LBS settings page model: projects the pool document and value-free
 * credential descriptions into the state the section renders, and derives the
 * settings path operations for structural edits. No Remote calls and no React
 * imports live here, so the whole model runs under `node --test`.
 *
 * @module @map-harness/ui-settings-lbs/client/pool-model
 */

import {
  LBS_BASE_REFS, LBS_KEY_MODES, LBS_MAX_KEYS_PER_VENDOR, LBS_VENDOR_IDS,
  normalizeDocument, poolOf, slotRef,
  type LbsKeyMode, type LbsKeySlot, type LbsPoolDocument, type LbsVendorId,
  type LbsVendorPool, type LbsVendorStatus,
} from '@map-harness/lbs-keyring/contract'
import { projectVendorStatus } from '@map-harness/lbs-keyring/policy'

/** Credential description for one reference, projected value-free. */
export interface LbsCredentialInfo {
  readonly configured: boolean
  readonly writable: boolean
}

/** Form frame state the shared SettingsForm consumes. */
export interface LbsShellState {
  readonly available: boolean
  readonly writable: boolean
  readonly dirty: boolean
  readonly invalid: boolean
  readonly saving: boolean
  readonly failed: boolean
}

/** One key row the section renders. */
export interface LbsPoolRow {
  readonly vendorId: LbsVendorId
  readonly slot: LbsKeySlot
  readonly configured: boolean
  readonly writable: boolean
  readonly enabled: boolean
  readonly active: boolean
  readonly cooling: boolean
  readonly useCount: number
  readonly lastUsedAt: number | undefined
  readonly failed: boolean
  /** Staged secret draft; blank on load, never seeded with a stored value. */
  readonly text: string
}

/** One vendor group the section renders. */
export interface LbsPoolVendor {
  readonly id: LbsVendorId
  readonly mode: LbsKeyMode
  readonly rows: readonly LbsPoolRow[]
  readonly configuredCount: number
  /** Ref of the slot currently serving, or undefined when no slot can serve. */
  readonly activeRef: string | undefined
  readonly canAdd: boolean
  readonly canRemove: boolean
}

/** What the section renders. */
export interface LbsPoolState {
  readonly shell: LbsShellState
  readonly vendors: readonly LbsPoolVendor[]
  readonly modes: readonly LbsKeyMode[]
  readonly maxKeys: number
}

/** Inputs to the projection. */
export interface LbsPoolProjectionInput {
  /** Raw settings namespace value, or undefined when the namespace is unserved. */
  readonly raw: unknown
  /** Credential descriptions keyed by reference. */
  readonly credentials: Readonly<Record<string, LbsCredentialInfo>>
  /** Whether the credentials domain answered. */
  readonly available: boolean
  /** Whether the settings namespace is served; false projects the legacy single key. */
  readonly structured: boolean
  /** Namespace writability. */
  readonly writable: boolean
  /** Staged secret drafts keyed by slot id. */
  readonly drafts: Readonly<Record<string, string>>
  /** Failed rows keyed by slot id. */
  readonly failed: ReadonlySet<string>
  /** Whether a save is in flight. */
  readonly saving: boolean
  /** Epoch milliseconds injected by the controller. */
  readonly now: number
}

/** Assert a closed union is exhaustive. */
function assertNever(value: never): never {
  throw new TypeError(`unknown LBS edit: ${String(value)}`)
}

/**
 * Build the settings section state from the pool document and value-free
 * credential descriptions. An unserved namespace projects the implicit single
 * key per vendor, preserving the legacy page.
 * @param input - projection inputs.
 * @returns the state the renderer consumes.
 */
export function projectPoolState(input: LbsPoolProjectionInput): LbsPoolState {
  const document = input.structured ? normalizeDocument(input.raw) : normalizeDocument(null)
  const vendors = LBS_VENDOR_IDS.map(vendorId => {
    const pool = poolOf(document, vendorId)
    const configured = new Set<string>()
    const writable = new Set<string>()
    for (const slot of pool.slots) {
      if (input.credentials[slot.ref]?.configured === true) configured.add(slot.ref)
      if (input.credentials[slot.ref]?.writable === true) writable.add(slot.ref)
    }
    const status: LbsVendorStatus = projectVendorStatus(vendorId, pool, configured, writable, input.now)
    const rows: LbsPoolRow[] = status.slots.map(row => ({
      vendorId,
      slot: row.slot,
      configured: row.configured,
      writable: row.writable,
      enabled: row.slot.enabled,
      active: row.active,
      cooling: row.cooling,
      useCount: row.health.useCount,
      lastUsedAt: row.health.lastUsedAt,
      failed: input.failed.has(`${vendorId}:${row.slot.id}`),
      text: input.drafts[`${vendorId}:${row.slot.id}`] ?? '',
    }))
    return {
      id: vendorId,
      mode: status.mode,
      rows,
      configuredCount: status.configuredCount,
      activeRef: status.activeRef,
      canAdd: input.structured && input.writable && pool.slots.length < LBS_MAX_KEYS_PER_VENDOR,
      canRemove: input.structured && input.writable && pool.slots.length > 1,
    }
  })
  const dirty = Object.values(input.drafts).some(text => text.trim().length > 0)
  return {
    shell: {
      available: input.available,
      writable: input.writable,
      dirty,
      invalid: false,
      saving: input.saving,
      failed: input.failed.size > 0,
    },
    vendors,
    modes: LBS_KEY_MODES,
    maxKeys: LBS_MAX_KEYS_PER_VENDOR,
  }
}

/** Structural edits the controller can apply to the pool document. */
export type LbsPoolEdit =
  | { readonly kind: 'add'; readonly vendorId: LbsVendorId }
  | { readonly kind: 'remove'; readonly vendorId: LbsVendorId; readonly slotId: string }
  | { readonly kind: 'move'; readonly vendorId: LbsVendorId; readonly slotId: string; readonly delta: -1 | 1 }
  | { readonly kind: 'enable'; readonly vendorId: LbsVendorId; readonly slotId: string; readonly enabled: boolean }
  | { readonly kind: 'mode'; readonly vendorId: LbsVendorId; readonly mode: LbsKeyMode }
  | { readonly kind: 'label'; readonly vendorId: LbsVendorId; readonly slotId: string; readonly label: string }

/** Result of applying one edit. */
export interface LbsPoolEditResult {
  readonly document: LbsPoolDocument
  /** New slot whose secret the page should stage, when an `add` succeeded. */
  readonly added: LbsKeySlot | undefined
}

/** Inputs to a structural edit beyond the edit itself. */
export interface LbsPoolEditInput {
  /** Monotonic suffix making new slot ids stable and non-reused. */
  readonly nextSlotSerial: number
}

/**
 * Apply one structural edit to a normalized document. Slot references stay
 * stable: reordering never reassigns a reference, and removal never renumbers
 * the remaining slots.
 * @param document - current normalized document.
 * @param edit - edit to apply.
 * @param input - deterministic id inputs.
 * @returns the next document and any newly created slot.
 */
export function applyPoolEdit(document: LbsPoolDocument, edit: LbsPoolEdit, input: LbsPoolEditInput): LbsPoolEditResult {
  const pool = poolOf(document, edit.vendorId)
  const vendors = { ...document.vendors }
  const write = (next: LbsVendorPool): LbsPoolEditResult => {
    vendors[edit.vendorId] = next
    return { document: { vendors }, added: undefined }
  }
  switch (edit.kind) {
    case 'add': {
      const used = new Set(pool.slots.map(slot => slot.ref))
      let index = 0
      while (used.has(slotRef(edit.vendorId, index))) index += 1
      if (pool.slots.length >= LBS_MAX_KEYS_PER_VENDOR || index >= LBS_MAX_KEYS_PER_VENDOR) {
        return { document, added: undefined }
      }
      const slot: LbsKeySlot = {
        id: `${edit.vendorId}-slot-${String(input.nextSlotSerial)}`,
        ref: slotRef(edit.vendorId, index),
        label: '',
        enabled: true,
      }
      vendors[edit.vendorId] = { ...pool, slots: [...pool.slots, slot] }
      return { document: { vendors }, added: slot }
    }
    case 'remove': {
      const index = pool.slots.findIndex(slot => slot.id === edit.slotId)
      if (index < 0 || pool.slots.length <= 1) return { document, added: undefined }
      const slots = pool.slots.filter(slot => slot.id !== edit.slotId)
      const health = { ...pool.health }
      Reflect.deleteProperty(health, edit.slotId)
      return write({ ...pool, slots, health, cursor: 0 })
    }
    case 'move': {
      const index = pool.slots.findIndex(slot => slot.id === edit.slotId)
      const target = index + edit.delta
      if (index < 0 || target < 0 || target >= pool.slots.length) return { document, added: undefined }
      const slots = [...pool.slots]
      const moved = slots[index]
      if (moved === undefined) return { document, added: undefined }
      slots.splice(index, 1)
      slots.splice(target, 0, moved)
      return write({ ...pool, slots, cursor: 0 })
    }
    case 'enable':
      return write({ ...pool, slots: pool.slots.map(slot => slot.id === edit.slotId ? { ...slot, enabled: edit.enabled } : slot) })
    case 'mode':
      return write({ ...pool, mode: edit.mode, cursor: 0 })
    case 'label':
      return write({ ...pool, slots: pool.slots.map(slot => slot.id === edit.slotId ? { ...slot, label: edit.label.slice(0, 64) } : slot) })
    default:
      return assertNever(edit)
  }
}

/**
 * Compute the settings path op that replaces one vendor section. Path ops keep
 * other vendors and secret values untouched.
 * @param vendorId - vendor to write.
 * @param pool - the vendor's next pool section.
 * @returns one path-addressed mutation.
 */
export function vendorOp(vendorId: LbsVendorId, pool: LbsVendorPool): { op: 'set'; path: string[]; value: unknown } {
  return { op: 'set', path: ['vendors', vendorId], value: pool }
}

/**
 * Collect every reference a document names, for one batched `describe` call.
 * @param raw - raw settings namespace value.
 * @returns references in vendor display order.
 */
export function refsOf(raw: unknown): readonly string[] {
  const document = normalizeDocument(raw)
  const refs = new Set<string>()
  for (const vendorId of LBS_VENDOR_IDS) {
    for (const slot of poolOf(document, vendorId).slots) refs.add(slot.ref)
  }
  return [...refs]
}

/** Implicit single-key roster used when the namespace is unserved. */
export function legacyRefs(): readonly string[] {
  return LBS_VENDOR_IDS.map(vendorId => LBS_BASE_REFS[vendorId])
}

/** Base reference for one vendor, used by consumer fallback diagnostics. */
export function baseRefOf(vendorId: LbsVendorId): string {
  return LBS_BASE_REFS[vendorId]
}
