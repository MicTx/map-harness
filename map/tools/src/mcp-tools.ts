import type { Context } from '@deepseek-ai/cordis'
import { createMcpToolDefinition, type McpResult } from '@deepseek-ai/dsh-mcp-client'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  SPATIAL_MCP_TOOL_NAMES,
  type SpatialToolName,
} from './spatial-catalog.ts'
import type { ArcgisMcpService } from './mcp-service.ts'

const supportedNames = new Set<string>(SPATIAL_MCP_TOOL_NAMES)

/** Narrow one JSON value to a string-keyed object. */
function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read durable map metadata from one canonical MCP structured result. */
function presentationMeta(value: JsonValue): JsonValue | null {
  const result = value as unknown as McpResult
  if (!isRecord(result.structuredContent)) return null
  return result.structuredContent.meta ?? null
}

/**
 * Adapt the internal MCP tools — the fixed spatial catalog of `map_*` container
 * tools and `geo_*` analysis tools — to the existing unqualified ToolRuntime
 * names. The raw result's `meta` remains absent from `output.render` and is
 * published only through ToolRuntime presentation metadata for the session
 * projection and durable log.
 * @param ctx - agent-scoped context that owns the returned definitions.
 * @param service - host MCP provider bound at execution time.
 * @returns unregistered tool definitions in the provider's tools/list order.
 */
export function createSpatialMcpToolDefinitions(
  ctx: Context,
  service: ArcgisMcpService,
): readonly ToolDefinition[] {
  const seen = new Set<string>()
  return service.catalog().map((descriptor) => {
    if (!supportedNames.has(descriptor.name)) {
      throw new Error(`unsupported internal MCP tool "${descriptor.name}"`)
    }
    if (seen.has(descriptor.name)) {
      throw new Error(`duplicate internal MCP tool "${descriptor.name}"`)
    }
    if (descriptor.taskRequired === true) {
      // P0a compatibility mode is Native model-direct dispatch only; the
      // task execution extension has no validated persistence path, so its
      // tools fail loud at definition time instead of at first call.
      throw new Error(`internal MCP tool "${descriptor.name}" requires task-based execution, which the map surface does not support`)
    }
    seen.add(descriptor.name)
    const name = descriptor.name as SpatialToolName
    const base = createMcpToolDefinition(ctx, {
      name,
      rawName: name,
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      outputSchema: descriptor.outputSchema,
      call: (args, execution) => service.callTool(name, args, execution),
    })
    return {
      ...base,
      output: {
        ...base.output,
        presentationMeta: (_args, value) => presentationMeta(value),
      },
    }
  })
}
