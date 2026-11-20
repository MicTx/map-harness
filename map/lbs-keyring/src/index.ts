/**
 * Host plugin that owns the LBS key pools settings namespace and provides the
 * `lbsKeyring` capability the accessibility, search and basemap consumers
 * resolve through. The plugin never holds a secret value beyond one selection.
 *
 * @module @map-harness/lbs-keyring
 */

import type { Context } from '@deepseek-ai/cordis'
import { credentialRef, isCredentialRefName } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { SettingsForms } from '@deepseek-ai/dsh-settings'
import { LBS_KEYRING_NS, type LbsKeyringConfig } from './config.ts'
import { normalizeDocument } from './contract.ts'
import { createLbsKeyring, type LbsKeyringService } from './service.ts'

export { Config, LBS_KEYRING_NS } from './config.ts'
export type { LbsKeyringConfig } from './config.ts'
export * from './contract.ts'
export * from './policy.ts'
export { createLbsKeyring } from './service.ts'
export type {
  LbsKeyringClock, LbsKeyringCredentials, LbsKeyringDeps, LbsKeyringService,
  LbsKeyringSettings, LbsOutcomeReport,
} from './service.ts'

/** Function-plugin identity under the Loader. */
/** Optional Host services; absent services keep the legacy single-key path. */
export const inject = ['settings', 'credentials']

export const name = '@map-harness/lbs-keyring'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional Host service selecting one configured LBS key per vendor. */
    lbsKeyring?: LbsKeyringService
  }
}

/**
 * Mount the keyring service over the settings namespace and the credentials
 * seam. Both services are optional: without them the page and consumers keep
 * the legacy single-reference behavior.
 * @param ctx - the Host plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: LbsKeyringConfig): void {
  const settings = ctx.get('settings', false) as SettingsForms | undefined
  const credentials = ctx.get('credentials', false) as CredentialProvider | undefined
  let fallback: unknown = { vendors: {} }

  const service = createLbsKeyring({
    cooldownScale: config.cooldownScale.get() ?? 1,
    clock: { now: () => Date.now(), random: () => Math.random() },
    settings: {
      read() {
        if (settings === undefined) return fallback
        return { vendors: config.vendors.get(), cooldownScale: config.cooldownScale.get() }
      },
      async write(vendors) {
        if (settings === undefined) {
          fallback = { vendors: { ...normalizeDocument(fallback).vendors, ...vendors } }
          return
        }
        const ops = Object.entries(vendors).map(([vendorId, current]) => ({
          op: 'set' as const, path: ['vendors', vendorId], value: current,
        }))
        await settings.mutate(LBS_KEYRING_NS, ops)
      },
    },
    credentials: {
      async describe(refs) {
        const result: Record<string, { configured: boolean }> = {}
        if (credentials === undefined) return result
        for (const ref of refs) {
          if (!isCredentialRefName(ref)) continue
          const info = await credentials.describe(credentialRef(ref))
          result[ref] = { configured: info.configured }
        }
        return result
      },
      async resolve(ref) {
        if (credentials === undefined || !isCredentialRefName(ref)) return undefined
        const resolved = await credentials.resolve(credentialRef(ref))
        return resolved?.value
      },
    },
  })

  const dispose = ctx.reflect.provide('lbsKeyring', service)
  ctx.effect(() => () => { void dispose() }, '@map-harness/lbs-keyring: service')
}
