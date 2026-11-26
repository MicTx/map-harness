/** Host-owned tool restrictions for the isolated visual qualification profile. */
import { appendFileSync } from 'node:fs'

/** Loader identity of the test-only guard. */
export const name = 'map-use-live-guard'
/** Services owned by the shipped host. */
export const inject = ['tools']

/**
 * Restrict the isolated agent and reject every nonvisual execution path.
 * @param ctx - test profile context.
 * @param config - fixture-owned rejection log.
 */
export function apply(ctx, config) {
  const allowed = new Set(['map_observe', 'map_use'])
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: [...allowed] })
  })
  ctx.tools.guard(execution => {
    if (allowed.has(execution.name)) return undefined
    appendFileSync(config.log, JSON.stringify({ name: execution.name, callId: execution.callId }) + '\n')
    return 'VISUAL_QUALIFICATION_ONLY: only map_observe and map_use are permitted.'
  })
}
