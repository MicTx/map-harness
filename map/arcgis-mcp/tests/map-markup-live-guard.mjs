/** Guard for the isolated visual markup qualification profile. */
import { appendFileSync } from 'node:fs'

/** Loader identity of the test-only guard. */
export const name = 'map-markup-live-guard'
/** Services owned by the shipped host. */
export const inject = ['tools']

/** Restrict the isolated agent to the visual candidate loop. */
export function apply(ctx, config) {
  const allowed = new Set(['map_observe', 'map_markup'])
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: [...allowed] })
  })
  ctx.tools.guard(execution => {
    if (allowed.has(execution.name)) return undefined
    appendFileSync(config.log, JSON.stringify({ name: execution.name, callId: execution.callId }) + '\n')
    return 'VISUAL_MARKUP_QUALIFICATION_ONLY: only map_observe and map_markup are permitted.'
  })
}
