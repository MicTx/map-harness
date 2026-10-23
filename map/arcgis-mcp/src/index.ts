/**
 * `@map-harness/arcgis-mcp` provides a standards-based in-process MCP server
 * for the five ArcGIS-backed map tools. Agent-scoped consumers bind each call
 * to the exact ToolRuntime execution; the MCP request schema never accepts a
 * session identity.
 * @module @map-harness/arcgis-mcp
 */
export { name, inject, apply } from './plugin.ts'
export {
  createArcgisMcpRuntime,
  EXECUTION_TOKEN_META_KEY,
  type ArcgisMcpRuntime,
} from './runtime.ts'
