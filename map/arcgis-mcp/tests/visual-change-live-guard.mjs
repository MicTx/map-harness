/** Guard for the isolated two-image visual-change qualification profile. */
import { appendFileSync } from 'node:fs'

/** Loader identity of the test-only guard. */
export const name = 'visual-change-live-guard'
/** Services owned by the shipped host. */
export const inject = ['tools']

/** Expose the four-step workflow but execute only the comparison tools. */
export function apply(ctx, config) {
  const visible = new Set(['map_set_basemap', 'map_observe', 'map_compare_views', 'map_mark_changes'])
  const executable = new Set(['map_compare_views', 'map_mark_changes'])
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.restrict({ allow: [...visible] })
  })
  ctx.tools.guard(execution => {
    if (executable.has(execution.name)) return undefined
    appendFileSync(config.log, JSON.stringify({ name: execution.name, callId: execution.callId }) + '\n')
    return 'VISUAL_CHANGE_QUALIFICATION_ONLY: seeded observations are fixed; only map_compare_views and map_mark_changes may execute.'
  })
}
