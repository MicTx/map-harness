/** Map Harness occupants for the generic browser-brand slots. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { MapHarnessMark, MapHarnessName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill the sidebar brand slots as one declaration-aware registration set.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.inject('sidebar.brand.mark', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, MapHarnessMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, MapHarnessName)
    }))
}
