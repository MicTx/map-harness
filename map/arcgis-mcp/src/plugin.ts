import type { Context } from '@deepseek-ai/cordis'
import { ARCGIS_MCP_SERVICE } from '@map-harness/map-tools'
import { createArcgisMcpRuntime } from './runtime.ts'

/** Function-plugin name under the Loader. */
export const name = '@map-harness/arcgis-mcp'

/** The in-process provider has no host service prerequisites. */
export const inject: string[] = []

/**
 * Initialize the MCP client/server pair and provide it to agent-scoped map tools.
 * @param ctx - host context receiving the provider service.
 */
export async function apply(ctx: Context): Promise<void> {
  const runtime = await createArcgisMcpRuntime()
  try {
    ctx.effect(() => {
      const unprovide = ctx.reflect.provide(ARCGIS_MCP_SERVICE, runtime.service)
      return async () => {
        void unprovide()
        await runtime.dispose()
      }
    }, '@map-harness/arcgis-mcp: provider')
  } catch (error: unknown) {
    await runtime.dispose()
    throw error
  }
}
