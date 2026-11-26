/**
 * LBS key pool contract: the vendor roster, slot-reference grammar, usage
 * modes and the value-free status vocabulary shared by the Host keyring
 * service, the settings section and the three credential consumers.
 *
 * Secret values never enter this module. A slot names a credential reference;
 * only the credentials seam holds its value.
 *
 * @module @map-harness/lbs-keyring/contract
 */

// Type-only: makes the `/** Profile entry id that owns the pool document in the settings namespace. */
export const LBS_KEYRING_NS = 'map-lbs-keyring'

/** Stable vendor ids, in settings display order. */
export const LBS_VENDOR_IDS = [
  'tianditu', 'tiandituSdk', 'amap', 'baidu', 'tencent', 'mapbox',
] as const

/** Stable row and locale-suffix identity. */
export type LbsVendorId = typeof LBS_VENDOR_IDS[number]

/** Legacy single-key reference each vendor resolved before key pools existed. */
export const LBS_BASE_REFS: Readonly<Record<LbsVendorId, string>> = Object.freeze({
  tianditu: 'TIANDITU_API_KEY',
  tiandituSdk: 'TIANDITU_SDK_KEY',
  amap: 'AMAP_API_KEY',
  baidu: 'BAIDU_API_KEY',
  tencent: 'TENCENT_MAP_KEY',
  mapbox: 'MAPBOX_ACCESS_TOKEN',
})

/** Key selection strategies. `priority` preserves declared order. */
export const LBS_KEY_MODES = ['round-robin', 'priority', 'random'] as const

/** Key selection strategy. */
export type LbsKeyMode = typeof LBS_KEY_MODES[number]

/**
 * Per-vendor slot bound. Six vendors times eight slots stays inside the
 * credentials Remote `describe` batch bound of 64.
 */
export const LBS_MAX_KEYS_PER_VENDOR = 8

/** POSIX identifier grammar every credential reference must satisfy. */
export const LBS_CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One configured key slot. `ref` is stable for the slot's lifetime. */
export interface LbsKeySlot {
  /** Stable slot id, used as the row identity and the form field id. */
  readonly id: string
  /** Credential reference holding the slot's secret; never the secret itself. */
  readonly ref: string
  /** User-assigned short label. */
  readonly label: string
  /** Disabled slots stay in the pool but never receive a selection. */
  readonly enabled: boolean
}

/** Health outcomes a consumer may report for one selected slot. */
export type LbsKeyOutcome = 'success' | 'rate-limited' | 'permission-denied' | 'unavailable'

/** Runtime health state for one slot, persisted value-free. */
export interface LbsKeyHealth {
  /** Outcome code of the last reported use; never raw vendor text. */
  readonly lastOutcome: LbsKeyOutcome | undefined
  /** Epoch milliseconds after which a cooling slot may be selected again. */
  readonly cooldownUntil: number | undefined
  /** Number of selections attributed to this slot. */
  readonly useCount: number
  /** Epoch milliseconds of the last selection. */
  readonly lastUsedAt: number | undefined
}

/** Per-vendor pool document section. */
export interface LbsVendorPool {
  readonly mode: LbsKeyMode
  readonly slots: readonly LbsKeySlot[]
  /** Rotation cursor into `slots`, carried in the document so restarts continue. */
  readonly cursor: number
  /** Runtime health keyed by slot id. */
  readonly health: Readonly<Record<string, LbsKeyHealth>>
}

/** Whole settings namespace document. */
export interface LbsPoolDocument {
  readonly vendors: Readonly<Partial<Record<LbsVendorId, LbsVendorPool>>>
}

/** Result of one selection. */
export interface LbsKeySelection {
  readonly vendorId: LbsVendorId
  readonly slot: LbsKeySlot
  /** Credential value resolved for `slot.ref`; caller holds it in memory only. */
  readonly value: string
  /** Cursor carried forward for the next selection. */
  readonly nextCursor: number
}

/** Value-free status of one slot, projected for the settings page. */
export interface LbsSlotStatus {
  readonly slot: LbsKeySlot
  /** Whether the credentials provider reports a stored value for the slot. */
  readonly configured: boolean
  /** Whether the credentials provider accepts writes for the slot. */
  readonly writable: boolean
  /** Whether the slot is currently selected under the vendor's mode. */
  readonly active: boolean
  /** Whether the slot is cooling after a rate limit or permission failure. */
  readonly cooling: boolean
  readonly health: LbsKeyHealth
}

/** Value-free status of one vendor, projected for the settings page. */
export interface LbsVendorStatus {
  readonly vendorId: LbsVendorId
  readonly mode: LbsKeyMode
  readonly slots: readonly LbsSlotStatus[]
  /** Number of configured slots. */
  readonly configuredCount: number
  /** Ref of the active slot, or undefined when no slot can serve. */
  readonly activeRef: string | undefined
}

/** Empty health record for a newly created slot. */
export function emptyHealth(): LbsKeyHealth {
  return { lastOutcome: undefined, cooldownUntil: undefined, useCount: 0, lastUsedAt: undefined }
}

/**
 * Derive the credential reference for a slot index. Index zero keeps the
 * legacy base reference, so an existing single-key deployment needs no
 * migration and additional slots get stable numbered references.
 * @param vendorId - vendor whose base reference anchors the slot.
 * @param index - zero-based slot index.
 * @returns a POSIX identifier legal as a credential reference.
 */
export function slotRef(vendorId: LbsVendorId, index: number): string {
  const base = LBS_BASE_REFS[vendorId]
  return index === 0 ? base : `${base}_${String(index + 1)}`
}

/**
 * Build the implicit single-key pool for a vendor with no configured section.
 * @param vendorId - vendor to seed.
 * @returns a pool whose only slot resolves the legacy reference.
 */
export function implicitPool(vendorId: LbsVendorId): LbsVendorPool {
  return {
    mode: 'priority',
    cursor: 0,
    slots: [{ id: `${vendorId}-0`, ref: slotRef(vendorId, 0), label: '', enabled: true }],
    health: {},
  }
}

/**
 * Validate and normalize an untrusted pool document read from the settings
 * namespace or another durable boundary. Unknown vendors, illegal references,
 * duplicate references and over-cap pools are rejected rather than repaired
 * silently.
 * @param raw - parsed JSON value.
 * @returns a normalized document with implicit pools for absent vendors.
 */
export function normalizeDocument(raw: unknown): LbsPoolDocument {
  if (raw === undefined || raw === null) return { vendors: {} }
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('LBS pool document must be an object')
  const container = raw as Record<string, unknown>
  const source = container.vendors
  if (source !== undefined && (typeof source !== 'object' || source === null || Array.isArray(source))) {
    throw new TypeError('LBS pool vendors must be an object')
  }
  const entries = (source ?? {}) as Record<string, unknown>
  const vendors: Partial<Record<LbsVendorId, LbsVendorPool>> = {}
  for (const vendorId of LBS_VENDOR_IDS) {
    const value = entries[vendorId]
    vendors[vendorId] = value === undefined ? implicitPool(vendorId) : normalizeVendorPool(vendorId, value)
  }
  return { vendors }
}

/** Validate one vendor section. */
function normalizeVendorPool(vendorId: LbsVendorId, raw: unknown): LbsVendorPool {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('LBS vendor pool must be an object')
  const value = raw as Record<string, unknown>
  const mode = value.mode
  if (mode !== undefined && !LBS_KEY_MODES.includes(mode as LbsKeyMode)) throw new TypeError('unknown LBS key mode')
  const slotsRaw = value.slots
  if (slotsRaw !== undefined && !Array.isArray(slotsRaw)) throw new TypeError('LBS slots must be an array')
  const slots = (slotsRaw ?? []).map((entry, index) => normalizeSlot(vendorId, index, entry))
  if (slots.length > LBS_MAX_KEYS_PER_VENDOR) throw new TypeError('LBS pool exceeds the per-vendor slot bound')
  const refs = new Set(slots.map(slot => slot.ref))
  if (refs.size !== slots.length) throw new TypeError('LBS pool has duplicate credential references')
  const cursor = typeof value.cursor === 'number' && Number.isInteger(value.cursor) && value.cursor >= 0
    ? value.cursor % Math.max(slots.length, 1) : 0
  const health = normalizeHealth(value.health, slots)
  return {
    mode: (mode ?? 'priority') as LbsKeyMode,
    slots: slots.length === 0 ? implicitPool(vendorId).slots : slots,
    cursor,
    health,
  }
}

/** Validate one slot and reject illegal or cross-vendor references. */
function normalizeSlot(vendorId: LbsVendorId, index: number, raw: unknown): LbsKeySlot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('LBS slot must be an object')
  const value = raw as Record<string, unknown>
  const id = typeof value.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value.id) ? value.id : `${vendorId}-${String(index)}`
  const ref = value.ref
  if (typeof ref !== 'string' || !LBS_CREDENTIAL_REF.test(ref)) throw new TypeError('illegal LBS credential reference')
  const base = LBS_BASE_REFS[vendorId]
  if (ref !== base && !ref.startsWith(`${base}_`)) throw new TypeError('LBS slot reference belongs to another vendor')
  const label = typeof value.label === 'string' ? value.label.slice(0, 64) : ''
  return { id, ref, label, enabled: value.enabled !== false }
}

/** Validate health records, dropping entries for slots that no longer exist. */
function normalizeHealth(raw: unknown, slots: readonly LbsKeySlot[]): Readonly<Record<string, LbsKeyHealth>> {
  if (raw === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const result: Record<string, LbsKeyHealth> = {}
  for (const slot of slots) {
    const value = source[slot.id]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    result[slot.id] = {
      lastOutcome: typeof entry.lastOutcome === 'string' && isOutcome(entry.lastOutcome) ? entry.lastOutcome : undefined,
      cooldownUntil: typeof entry.cooldownUntil === 'number' && Number.isFinite(entry.cooldownUntil) ? entry.cooldownUntil : undefined,
      useCount: typeof entry.useCount === 'number' && Number.isInteger(entry.useCount) && entry.useCount >= 0 ? entry.useCount : 0,
      lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : undefined,
    }
  }
  return result
}

/** Narrow a string to the closed outcome vocabulary. */
function isOutcome(value: string): value is LbsKeyOutcome {
  return value === 'success' || value === 'rate-limited' || value === 'permission-denied' || value === 'unavailable'
}

/**
 * Resolve the pool for one vendor, materializing the implicit single key when
 * the deployment has not configured a pool.
 * @param document - normalized pool document.
 * @param vendorId - vendor to resolve.
 * @returns the vendor's pool.
 */
export function poolOf(document: LbsPoolDocument, vendorId: LbsVendorId): LbsVendorPool {
  return document.vendors[vendorId] ?? implicitPool(vendorId)
}

/**
 * Collect every credential reference named by a document, in display order.
 * @param document - normalized pool document.
 * @returns deduplicated references, bounded by the Remote describe batch limit.
 */
export function allRefs(document: LbsPoolDocument): readonly string[] {
  const refs = new Set<string>()
  for (const vendorId of LBS_VENDOR_IDS) {
    for (const slot of poolOf(document, vendorId).slots) refs.add(slot.ref)
  }
  return [...refs]
}

/**
 * Map a credential reference back to its vendor. Consumers use this to learn
 * which pool a `credentials/reference-updated` event belongs to.
 * @param ref - credential reference.
 * @param document - normalized pool document.
 * @returns the owning vendor id, or undefined for an unrelated reference.
 */
export function vendorOfRef(ref: string, document: LbsPoolDocument): LbsVendorId | undefined {
  for (const vendorId of LBS_VENDOR_IDS) {
    if (poolOf(document, vendorId).slots.some(slot => slot.ref === ref)) return vendorId
  }
  return undefined
}

/**
 * Map an environment reference back to the vendor whose pool owns it. Extra
 * slots such as `TIANDITU_API_KEY_2` resolve to the same vendor as the base.
 * @param ref - credential reference a consumer resolves.
 * @returns the owning vendor id, or undefined for an unrelated reference.
 */
export function vendorForRef(ref: string): LbsVendorId | undefined {
  let best: LbsVendorId | undefined
  let bestLength = -1
  for (const vendorId of LBS_VENDOR_IDS) {
    const base = LBS_BASE_REFS[vendorId]
    if ((ref === base || ref.startsWith(`${base}_`)) && base.length > bestLength) {
      best = vendorId
      bestLength = base.length
    }
  }
  return best
}

/** Minimal Host keyring face the three LBS consumers resolve optionally. */
export interface LbsKeyringConsumerFace {
  /**
   * Select one configured key for a vendor under its usage mode.
   * @param vendorId - vendor whose key should serve the next operation.
   * @returns the selected slot reference and resolved value, or undefined.
   */
  select(vendorId: LbsVendorId): Promise<{
    readonly slot: { readonly ref: string; readonly id: string }
    readonly value: string
  } | undefined>
  /**
   * Report a classified outcome for the slot that served one operation.
   * @param report - vendor, slot id and classified outcome code.
   */
  report(report: { readonly vendorId: LbsVendorId; readonly slotId: string; readonly outcome: LbsKeyOutcome }): Promise<void>
}

/** Stable context key the Host plugin provides the keyring under. */
export const LBS_KEYRING_SERVICE = 'lbsKeyring'
