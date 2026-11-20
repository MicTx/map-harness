/**
 * LBS settings section controller: owns the settings namespace subscription,
 * staged secret drafts, structural pool edits and the value-free credential
 * descriptions. Secrets cross only through `credentials.set/unset` and are
 * never read back into a draft.
 *
 * @module @map-harness/ui-settings-lbs/client/pool-controller
 */

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormActions } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  LBS_KEYRING_NS, LBS_VENDOR_IDS, normalizeDocument, poolOf,
  type LbsKeyMode, type LbsVendorId,
} from '@map-harness/lbs-keyring/contract'
import {
  applyPoolEdit, legacyRefs, projectPoolState, refsOf, vendorOp,
  type LbsCredentialInfo, type LbsPoolEdit, type LbsPoolState,
} from './pool-model.ts'

/** Narrow Remote credentials face the controller uses. */
export interface LbsCredentialsRemote {
  /** @param refs - references to describe. */
  describe(refs: string[]): Promise<
    | { ok: true; value: Readonly<Record<string, { configured: boolean; writable: boolean }>> }
    | { ok: false; error: unknown }
  >
  /** @param ref - reference to store under. @param value - non-empty secret. */
  set(ref: string, value: string): Promise<unknown>
  /** @param ref - reference to remove. */
  unset(ref: string): Promise<unknown>
}

/** Narrow config form face; `ConfigForm<T>` satisfies it. */
export interface LbsConfigForm {
  /** @returns the current namespace snapshot. */
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value: unknown
    writable: boolean
    revision: number | undefined
  }
  /** @param listener - snapshot change callback. */
  subscribe(listener: () => void): () => void
  /** @param ops - path operations. @param expectedRevision - optional fence. */
  mutate(ops: readonly unknown[], expectedRevision?: number): Promise<boolean>
}

/** Extra context inputs beyond the two remote faces. */
export interface LbsPoolControllerContext {
  readonly remote: { credentials: LbsCredentialsRemote }
  readonly configForms: { get(ns: string): LbsConfigForm }
  /** Forwarded settings and credential invalidation subscription. */
  readonly $on?: (event: string, listener: (payload: unknown) => void) => () => void
  /** @returns epoch milliseconds. */
  readonly now?: () => number
}

/** One editor card's staged writes, committed together on Apply. */
export interface LbsCardCommit {
  /** Vendor the card edits. */
  readonly vendorId: LbsVendorId
  /** Staged secret per existing slot id; blank values are ignored. */
  readonly keys: Readonly<Record<string, string>>
  /** Optional new key text; a slot is appended before the value is stored. */
  readonly newKey?: string | undefined
  /** Usage mode to commit when it differs from the stored mode. */
  readonly mode?: LbsKeyMode | undefined
}

/** Result of one card Apply. */
export interface LbsCardResult {
  /** Slot ids (or `new`) whose credential write failed. */
  readonly failed: readonly string[]
}

/** The registration-side face the section's slot entry injects. */
export interface LbsPoolFace {
  hooks: {
    /** Section snapshot bound by the renderer. */
    lbs: SnapshotStore<LbsPoolState>
  }
  /** Re-read the namespace and credential descriptions. */
  load: () => Promise<void>
  /** Stage, save and discard secret drafts. */
  actions: SettingsFormActions
  /** Remove one slot's stored key. */
  clear: (vendorId: LbsVendorId, slotRef: string) => Promise<void>
  /** Apply a structural pool edit. */
  edit: (edit: LbsPoolEdit) => Promise<void>
  /** Commit one editor card's staged keys, optional new key and mode. */
  applyCard: (commit: LbsCardCommit) => Promise<LbsCardResult>
  /** Remove one key slot's credential and its pool entry. */
  removeSlot: (vendorId: LbsVendorId, slotId: string) => Promise<void>
}

/** Credential descriptions keyed by reference, held value-free. */
type Descriptions = Record<string, LbsCredentialInfo>

/**
 * Bridge the settings namespace and the credentials Remote onto one
 * section snapshot. Structural edits write one path op per vendor; secret
 * drafts write through `credentials.set` on save.
 */
export class LbsPoolController {
  private readonly ctx: LbsPoolControllerContext
  private readonly form: LbsConfigForm
  private readonly store: SnapshotStore<LbsPoolState>
  private readonly face: LbsPoolFace
  private descriptions: Descriptions = {}
  private drafts: Record<string, string> = {}
  private failed = new Set<string>()
  private saving = false
  private available = false
  private structured = false
  private writable = false
  private slotSerial = 0
  private unsubscribe: () => void = () => {}
  private invalidate: Array<() => void> = []
  private disposed = false

  /** @param ctx - browser plugin context faces. */
  constructor(ctx: LbsPoolControllerContext) {
    this.ctx = ctx
    this.form = ctx.configForms.get(LBS_KEYRING_NS) as LbsConfigForm
    this.store = makeStore(() => this.projection())
    this.face = {
      hooks: { lbs: this.store },
      load: async () => { await this.load() },
      actions: {
        edit: (field, text) => { this.editDraft(field, text) },
        resetField: (field) => { this.resetDraft(field) },
        save: () => { void this.save() },
        discard: () => { this.discard() },
      },
      clear: async (vendorId, slotRef) => { await this.clear(vendorId, slotRef) },
      edit: async (change) => { await this.edit(change) },
      applyCard: async (commit) => { return await this.applyCard(commit) },
      removeSlot: async (vendorId, slotId) => { await this.removeSlot(vendorId, slotId) },
    }
    this.unsubscribe = this.form.subscribe(() => { this.publish() })
    if (ctx.$on !== undefined) {
      this.invalidate = [
        ctx.$on('settings/document-updated', () => { this.publish() }),
        ctx.$on('credentials/reference-updated', (ref) => { void this.refreshCredential(String(ref)) }),
      ]
    }
  }

  /** Re-read the namespace view and describe every named reference. */
  async load(): Promise<void> {
    const snapshot = this.form.getSnapshot()
    this.structured = snapshot.status === 'ready'
    this.writable = this.structured && snapshot.writable
    const refs = this.structured ? refsOf(snapshot.value) : legacyRefs()
    const response = await this.ctx.remote.credentials.describe([...refs])
    if (!response.ok) {
      this.available = false
      this.descriptions = {}
      this.publish()
      return
    }
    this.available = true
    this.descriptions = response.value
    this.publish()
  }

  /** Re-describe one reference after the Host reports a change. */
  async refreshCredential(ref: string): Promise<void> {
    const refs = this.structured ? refsOf(this.form.getSnapshot().value) : legacyRefs()
    if (!refs.includes(ref)) return
    const response = await this.ctx.remote.credentials.describe([ref])
    if (!response.ok) return
    const described = response.value[ref]
    if (described !== undefined) this.descriptions = { ...this.descriptions, [ref]: described }
    this.publish()
  }

  /** Stage one secret draft for a slot. */
  editDraft(field: string, text: string): void {
    this.drafts = { ...this.drafts, [field]: text }
    this.publish()
  }

  /** Drop one staged draft. */
  resetDraft(field: string): void {
    const drafts = { ...this.drafts }
    Reflect.deleteProperty(drafts, field)
    this.drafts = drafts
    this.publish()
  }

  /** Write every non-empty staged draft through the credentials Remote. */
  async save(): Promise<void> {
    if (this.saving) return
    const writes = Object.entries(this.drafts).filter(([, text]) => text.trim().length > 0)
    if (writes.length === 0) return
    this.saving = true
    this.publish()
    const nextFailed = new Set(this.failed)
    const remaining: Record<string, string> = {}
    for (const [field, text] of writes) {
      const ref = this.refForField(field)
      if (ref === undefined) continue
      try {
        await this.ctx.remote.credentials.set(ref, text.trim())
        nextFailed.delete(field)
      } catch {
        nextFailed.add(field)
        remaining[field] = text
      }
    }
    this.drafts = remaining
    this.failed = nextFailed
    this.saving = false
    await this.load()
  }

  /** Drop all drafts and failures. */
  discard(): void {
    this.drafts = {}
    this.failed = new Set<string>()
    this.publish()
  }

  /** Remove one slot's stored key. */
  async clear(vendorId: LbsVendorId, slotRef: string): Promise<void> {
    const field = this.fieldForRef(vendorId, slotRef)
    try {
      await this.ctx.remote.credentials.unset(slotRef)
      if (field !== undefined) {
        this.failed.delete(field)
        Reflect.deleteProperty(this.drafts, field)
      }
      await this.refreshCredential(slotRef)
    } catch {
      if (field !== undefined) this.failed.add(field)
      this.publish()
    }
  }

  /** Apply one structural edit through a single settings path op. */
  async edit(change: LbsPoolEdit): Promise<void> {
    if (!this.structured || !this.writable) return
    const snapshot = this.form.getSnapshot()
    const current = normalizeDocument(snapshot.value)
    const result = applyPoolEdit(current, change, { nextSlotSerial: ++this.slotSerial })
    const pool = poolOf(result.document, change.vendorId)
    const accepted = await this.form.mutate([vendorOp(change.vendorId, pool)], snapshot.revision)
    if (!accepted) {
      this.failed.add(`${change.vendorId}:structure`)
      this.publish()
      return
    }
    if (result.added !== undefined) {
      this.descriptions = { ...this.descriptions, [result.added.ref]: { configured: false, writable: true } }
    }
    if (change.kind === 'remove') {
      const removed = poolOf(current, change.vendorId).slots.find(slot => slot.id === change.slotId)
      if (removed !== undefined && this.descriptions[removed.ref]?.configured === true) {
        try { await this.ctx.remote.credentials.unset(removed.ref) } catch { /* next save reports it */ }
      }
    }
    await this.load()
  }

  /**
   * Commit one editor card as a unit: the optional new slot and the mode first
   * through one settings path op, then each staged secret through the
   * credentials Remote. A refused structural write reports every staged field
   * so the card keeps its drafts.
   * @param commit - vendor, staged keys, optional new key and mode.
   * @returns the ids whose credential write failed.
   */
  async applyCard(commit: LbsCardCommit): Promise<LbsCardResult> {
    if (!this.structured || !this.writable) return { failed: Object.keys(commit.keys) }
    const snapshot = this.form.getSnapshot()
    const original = normalizeDocument(snapshot.value)
    let document = original
    let addedRef: string | undefined
    const newText = commit.newKey?.trim() ?? ''
    if (newText.length > 0) {
      const added = applyPoolEdit(document, { kind: 'add', vendorId: commit.vendorId }, { nextSlotSerial: ++this.slotSerial })
      document = added.document
      addedRef = added.added?.ref
    }
    if (commit.mode !== undefined && commit.mode !== poolOf(document, commit.vendorId).mode) {
      document = applyPoolEdit(document, { kind: 'mode', vendorId: commit.vendorId, mode: commit.mode }, { nextSlotSerial: this.slotSerial }).document
    }
    const pool = poolOf(document, commit.vendorId)
    const structurallyChanged = document !== original
    if (structurallyChanged) {
      const accepted = await this.form.mutate([vendorOp(commit.vendorId, pool)], snapshot.revision)
      if (!accepted) {
        this.failed.add(`${commit.vendorId}:structure`)
        this.publish()
        return { failed: Object.keys(commit.keys) }
      }
      this.failed.delete(`${commit.vendorId}:structure`)
    }
    const writes: { id: string; ref: string; value: string }[] = []
    for (const [slotId, text] of Object.entries(commit.keys)) {
      const value = text.trim()
      if (value.length === 0) continue
      const slot = pool.slots.find(entry => entry.id === slotId)
      if (slot !== undefined) writes.push({ id: slotId, ref: slot.ref, value })
    }
    if (addedRef !== undefined) writes.push({ id: 'new', ref: addedRef, value: newText })
    const failed: string[] = []
    for (const write of writes) {
      try {
        await this.ctx.remote.credentials.set(write.ref, write.value)
      } catch {
        failed.push(write.id)
      }
    }
    for (const [slotId] of Object.entries(commit.keys)) {
      if (failed.includes(slotId)) continue
      Reflect.deleteProperty(this.drafts, `${commit.vendorId}:${slotId}`)
    }
    await this.load()
    return { failed }
  }

  /**
   * Remove one key slot as a unit: clear its credential, then drop its pool
   * entry. The last slot of a vendor is kept, matching the legacy single-key
   * posture.
   * @param vendorId - vendor owning the slot.
   * @param slotId - slot identity.
   */
  async removeSlot(vendorId: LbsVendorId, slotId: string): Promise<void> {
    if (!this.structured || !this.writable) return
    const snapshot = this.form.getSnapshot()
    const current = normalizeDocument(snapshot.value)
    const slot = poolOf(current, vendorId).slots.find(entry => entry.id === slotId)
    if (slot === undefined || poolOf(current, vendorId).slots.length <= 1) return
    try { await this.ctx.remote.credentials.unset(slot.ref) } catch { /* reload reports it */ }
    const result = applyPoolEdit(current, { kind: 'remove', vendorId, slotId }, { nextSlotSerial: this.slotSerial })
    await this.form.mutate([vendorOp(vendorId, poolOf(result.document, vendorId))], snapshot.revision)
    Reflect.deleteProperty(this.drafts, `${vendorId}:${slotId}`)
    await this.load()
  }

  /** The face the section's slot entry injects. */
  inject(): LbsPoolFace {
    return this.face
  }

  /** Release the form subscription and event listeners. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    for (const off of this.invalidate) off()
    this.invalidate = []
  }

  /** Resolve the credential reference behind one staged draft field. */
  private refForField(field: string): string | undefined {
    const [vendorId, ...rest] = field.split(':')
    if (!isVendorId(vendorId)) return undefined
    const pool = poolOf(normalizeDocument(this.form.getSnapshot().value), vendorId)
    return pool.slots.find(slot => `${vendorId}:${slot.id}` === `${vendorId}:${rest.join(':')}`)?.ref
  }

  /** Resolve the draft field for one slot reference. */
  private fieldForRef(vendorId: LbsVendorId, ref: string): string | undefined {
    const pool = poolOf(normalizeDocument(this.form.getSnapshot().value), vendorId)
    const slot = pool.slots.find(entry => entry.ref === ref)
    return slot === undefined ? undefined : `${vendorId}:${slot.id}`
  }

  /** Publish the current projection into the snapshot store. */
  private publish(): void {
    const snapshot = this.form.getSnapshot()
    this.structured = this.structured && snapshot.status !== 'unavailable'
    this.writable = this.structured && snapshot.writable
    this.store.set(this.projection())
  }

  /** @returns the current section state. */
  private projection(): LbsPoolState {
    return projectPoolState({
      raw: this.form.getSnapshot().value,
      credentials: this.descriptions,
      available: this.available,
      structured: this.structured,
      writable: this.writable,
      drafts: this.drafts,
      failed: this.failed,
      saving: this.saving,
      now: this.ctx.now?.() ?? Date.now(),
    })
  }
}

/** Narrow a string to the vendor id union. */
function isVendorId(value: string | undefined): value is LbsVendorId {
  return value !== undefined && (LBS_VENDOR_IDS as readonly string[]).includes(value)
}

/** Minimal in-memory snapshot store compatible with the renderer's hook face. */
function makeStore<S>(project: () => S): SnapshotStore<S> {
  let current = project()
  const listeners = new Set<() => void>()
  return {
    getSnapshot() { return current },
    set(value: S) {
      current = value
      for (const listener of listeners) listener()
    },
    update() { /* the controller replaces state wholesale */ },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
