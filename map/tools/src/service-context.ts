import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Resolve a host service through an agent scope and its Cordis context parents. */
export function serviceOf<T>(exec: Pick<ToolExecution, 'agent'>, name: string): T | undefined {
  let context = exec.agent?.ctx as (Context & { fiber?: { parent?: Context } }) | undefined
  for (let depth = 0; context !== undefined && depth < 16; depth += 1) {
    const value = context.get(name) as T | undefined
    if (value !== undefined) return value
    context = context.fiber?.parent as (Context & { fiber?: { parent?: Context } }) | undefined
  }
  return undefined
}
