/**
 * The LBS key pool settings section, browser half: one group per vendor with
 * multiple write-only key rows, per-key status and a usage mode. The page
 * registers into the settings shell's `settings.section` slot so it sits beside
 * General, Models, and Plugins. Pool structure lives in the Host settings
 * namespace; secret values cross only through the credentials Remote domain.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { LBS_KEYRING_NS } from '@map-harness/lbs-keyring/contract'
import { LbsSection } from './LbsSection.tsx'
import { LbsPoolController, type LbsPoolFace } from './pool-controller.ts'
import { en, zh, type LbsSettingsLocaleKey } from './locales.ts'

/** Component props bound by the settings-section renderer. */
export type { LbsSectionProps } from './LbsSection.tsx'
/** Pool state, row, vendor, edit and controller contracts. */
export type {
  LbsCredentialInfo, LbsPoolEdit, LbsPoolEditResult, LbsPoolRow,
  LbsPoolState, LbsPoolVendor, LbsShellState,
} from './pool-model.ts'
/** Controller face injected into the section by the renderer. */
export type { LbsPoolFace } from './pool-controller.ts'
/** Locale key set owned by this plugin's dictionary namespace. */
export type { LbsSettingsLocaleKey } from './locales.ts'
/** Legacy single-key controller contracts, retained for existing consumers. */
export {
  LBS_VENDORS, LbsSectionController,
} from './lbs-section-controller.ts'
/** Legacy single-key controller contracts, retained for existing consumers. */
export type {
  LbsFormModel, LbsRowState, LbsSectionFace, LbsSectionState, LbsVendorSpec,
} from './lbs-section-controller.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** LBS key pool settings section copy. */
    'settings.lbs': LbsSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.lbs'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

/**
 * Mount the LBS key pool section while the settings namespace is served.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-lbs: dictionaries')
  void ctx.configForms.get(LBS_KEYRING_NS).getSnapshot()
  const controller = new LbsPoolController({
    remote: ctx.remote,
    configForms: ctx.configForms,
    $on: (event, listener) => subscribeRemote(ctx, event, listener),
  })
  const face: LbsPoolFace = controller.inject()
  ctx.effect(() => () => { controller.dispose() }, 'ui-settings-lbs: pool controller')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'lbs',
    order: 40,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: () => face,
  }, LbsSection))
}

/** Subscribe to the two forwarded events the controller refreshes on. */
function subscribeRemote(
  ctx: ClientContext,
  event: string,
  listener: (payload: unknown) => void,
): () => void {
  if (event === 'settings/document-updated') {
    return ctx.remote.$on('settings/document-updated', () => { listener(undefined) })
  }
  if (event === 'credentials/reference-updated') {
    return ctx.remote.$on('credentials/reference-updated', (ref) => { listener(ref) })
  }
  return () => {}
}
