/**
 * The LBS settings section's controller: one write-only key row per vendor,
 * staged through the shared settings-form model and written through the
 * credentials Remote domain rather than any settings document. No settings
 * namespace carries these fields — the page binds `credentials.describe` for
 * the configured badges and `credentials.set` / `credentials.unset` for the
 * writes, addressed by the same environment-variable reference each consumer
 * resolves.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote Context merge (the credentials namespace and its
// forwarded update event).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormActions, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LbsSettingsLocaleKey } from './locales.ts'

/** One vendor row the page edits. */
export interface LbsVendorSpec {
  /** Stable row and locale suffix id. */
  readonly id: string
  /** Credential reference the row writes; the same environment name the consumers resolve. */
  readonly ref: string
  /** Locale key naming the vendor (`vendor.<id>`). */
  readonly labelKey: LbsSettingsLocaleKey
  /** Locale key of the per-row hint (`apiKeyHint.<id>`). */
  readonly hintKey: LbsSettingsLocaleKey
}

/** The vendor rows this page manages, in display order. */
export const LBS_VENDORS: readonly LbsVendorSpec[] = [
  { id: 'tianditu', ref: 'TIANDITU_API_KEY', labelKey: 'vendor.tianditu', hintKey: 'apiKeyHint.tianditu' },
  { id: 'tiandituSdk', ref: 'TIANDITU_SDK_KEY', labelKey: 'vendor.tiandituSdk', hintKey: 'apiKeyHint.tiandituSdk' },
  { id: 'amap', ref: 'AMAP_API_KEY', labelKey: 'vendor.amap', hintKey: 'apiKeyHint.amap' },
  { id: 'baidu', ref: 'BAIDU_API_KEY', labelKey: 'vendor.baidu', hintKey: 'apiKeyHint.baidu' },
  { id: 'tencent', ref: 'TENCENT_MAP_KEY', labelKey: 'vendor.tencent', hintKey: 'apiKeyHint.tencent' },
  { id: 'mapbox', ref: 'MAPBOX_ACCESS_TOKEN', labelKey: 'vendor.mapbox', hintKey: 'apiKeyHint.mapbox' },
]

/** The staged-form face the controller consumes; `SettingsFormModel` implements it. */
export interface LbsFormModel {
  /** @param project - builds the state from the form's current reads. */
  bind<S>(project: () => S): SnapshotStore<S>
  /** @returns the form frame state. */
  shell(): SettingsFormShell
  /** @param field - the row id. */
  field(field: string): { text: string }
  /** @returns the shared edit/save/discard actions. */
  actions(): SettingsFormActions
  /** Release the form's accepted-value subscription. */
  dispose(): void
}

/** One row's view state. */
export interface LbsRowState {
  readonly spec: LbsVendorSpec
  /** Staged draft text; blank on load, never seeded with the stored secret. */
  readonly text: string
  /** Whether the Host reports any layer supplies a value for this reference. */
  readonly configured: boolean
  /** Whether `credentials.set` can affect this reference (false disables the row). */
  readonly writable: boolean
  /** Whether the row's last clear was refused. */
  readonly failed: boolean
}

/** What the section renders. */
export interface LbsSectionState {
  /** The shared form frame's availability and save state. */
  readonly shell: SettingsFormShell
  readonly rows: readonly LbsRowState[]
}

/** The registration-side face the section's slot entry injects. */
export interface LbsSectionFace {
  hooks: {
    /** Section snapshot bound by the renderer. */
    lbs: SnapshotStore<LbsSectionState>
  }
  /** Re-read every row's configured state. */
  load: () => Promise<void>
  /** Shared form actions: stage edits, save, and discard. */
  actions: SettingsFormActions
  /** Remove the row's stored key. */
  clear: (id: string) => Promise<void>
}

/**
 * Bridge the credentials domain onto the shared settings form: one
 * `describe` batch read seeds every row's configured badge, staged keys land
 * on the form's single save, and a clear is its own immediate write.
 */
export class LbsSectionController {
  private readonly ctx: ClientContext
  private readonly model: LbsFormModel
  private readonly rows = new Map<string, { configured: boolean; writable: boolean; failed: boolean }>()
  private readonly store: SnapshotStore<LbsSectionState>
  private readonly face: LbsSectionFace
  private available = false

  /**
   * @param ctx - the page plugin's context, whose `remote.credentials` namespace answers for the rows.
   * @param model - the shared staged-form model that owns the key drafts.
   */
  constructor(ctx: ClientContext, model: LbsFormModel) {
    this.ctx = ctx
    this.model = model
    for (const spec of LBS_VENDORS) {
      this.rows.set(spec.id, { configured: false, writable: true, failed: false })
    }
    this.store = this.model.bind(() => this.projection())
    this.face = {
      hooks: { lbs: this.store },
      load: async () => { await this.load() },
      actions: this.model.actions(),
      clear: async (id) => { await this.clear(id) },
    }
  }

  /** Describe every row's reference and publish the answers. */
  async load(): Promise<void> {
    const response = await this.ctx.remote.credentials.describe(LBS_VENDORS.map(vendor => vendor.ref))
    if (!response.ok) {
      this.available = false
      this.store.set(this.projection())
      return
    }
    this.available = true
    for (const vendor of LBS_VENDORS) {
      const view = response.value[vendor.ref]
      const row = this.rows.get(vendor.id)
      if (row === undefined) continue
      row.configured = view?.configured ?? false
      row.writable = view?.writable ?? true
    }
    this.store.set(this.projection())
  }

  /**
   * Re-read one row's reference after the Host reports a change for it.
   * @param ref - the reference the Host reports as changed.
   */
  async refreshCredential(ref: string): Promise<void> {
    const vendor = LBS_VENDORS.find(item => item.ref === ref)
    if (vendor === undefined) return
    const response = await this.ctx.remote.credentials.describe([ref])
    if (!response.ok) return
    const view = response.value[ref]
    const row = this.rows.get(vendor.id)
    if (row === undefined) return
    row.configured = view?.configured ?? false
    row.writable = view?.writable ?? true
    this.store.set(this.projection())
  }

  /** Remove one row's stored key through the credentials domain. */
  async clear(id: string): Promise<void> {
    const vendor = LBS_VENDORS.find(item => item.id === id)
    const row = this.rows.get(id)
    if (vendor === undefined || row === undefined) return
    try {
      await this.ctx.remote.credentials.unset(vendor.ref)
      row.failed = false
      await this.refreshCredential(vendor.ref)
    } catch {
      row.failed = true
      this.store.set(this.projection())
    }
  }

  /** The face the section's slot entry injects. */
  inject(): LbsSectionFace {
    return this.face
  }

  /** Release the model's accepted-value subscription. */
  dispose(): void { this.model.dispose() }

  private projection(): LbsSectionState {
    const shell = this.model.shell()
    const rows = [...this.rows.values()]
    return {
      shell: {
        ...shell,
        available: this.available && shell.available,
        writable: shell.writable && this.available && rows.some(row => row.writable),
      },
      rows: LBS_VENDORS.map(spec => {
        const row = this.rows.get(spec.id)
        return {
          spec,
          text: this.model.field(spec.id).text,
          configured: row?.configured ?? false,
          writable: row?.writable ?? true,
          failed: row?.failed ?? false,
        }
      }),
    }
  }
}
