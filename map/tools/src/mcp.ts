/**
 * Agent-scoped MCP consumer entry for map-analyst. It registers the fixed
 * spatial catalog — the five ArcGIS-backed `map_*` container tools and the
 * four `geo_*` analysis tools — discovered from the host provider, so every
 * spatial tool the model can call traverses the standard MCP
 * `tools/list`/`tools/call` path with trusted execution binding. A monotonic
 * ToolRuntime guard additionally denies nested dispatch of the map mutation
 * tools at the pipeline level, beside the handlers' own refusal.
 * @module @map-harness/map-tools/mcp
 */
import type { Context } from '@deepseek-ai/cordis'
import { supportsNestedDispatch, trySpatialToolOf } from './spatial-catalog.ts'
import { createSpatialMcpToolDefinitions } from './mcp-tools.ts'
import { ARCGIS_MCP_SERVICE } from './mcp-service.ts'

/** Function-plugin name under the Loader. */
export const name = '@map-harness/map-tools/mcp'

/** Required agent services: the scoped tool registry. */
export const inject = ['tools']

/**
 * Register the MCP-backed spatial catalog and the nested-mutation guard.
 * @param ctx - agent context carrying the scoped tool registry.
 */
export function apply(ctx: Context): void {
  ctx.effect(function* () {
    const service = ctx.get(ARCGIS_MCP_SERVICE) ?? ctx.root.get(ARCGIS_MCP_SERVICE)
    if (service === undefined) {
      throw new Error('ArcGIS MCP service unavailable; mount @map-harness/arcgis-mcp in the host profile')
    }
    const tools = createSpatialMcpToolDefinitions(ctx, service)
    for (const tool of tools) yield ctx.tools.register(tool)
    // Monotonic denial at the ToolRuntime pipeline: a nested (PTC) dispatch of
    // a map mutation, a catalog publication, or a save can never pair with its
    // accepted call or produce a foldable, honest result, so it is denied
    // before the body runs regardless of which listener later touches the
    // pre-execute decision.
    yield ctx.tools.guard(exec => {
      if (exec.parent === undefined) return undefined
      const identity = trySpatialToolOf(exec.name)
      return identity !== undefined && !supportsNestedDispatch(identity.family)
        ? `nested dispatch cannot change durable state: ${exec.name} supports native model-direct calls only`
        : undefined
    })
  }, '@map-harness/map-tools/mcp: tools')
}

export { createSpatialMcpToolDefinitions } from './mcp-tools.ts'
