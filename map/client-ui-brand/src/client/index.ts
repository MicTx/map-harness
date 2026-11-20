/** Map Harness occupants for the generic browser-brand slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MapHarnessMark, MapHarnessName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill the brand slots as declaration-aware registrations: the sidebar mark
 * and name plus the blank-session hero mark, so the whole product shows the
 * same map-pin identity.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.inject('sidebar.brand.mark', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, MapHarnessMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, MapHarnessName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, MapHarnessMark))
}
