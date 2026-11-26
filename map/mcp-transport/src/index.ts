/**
 * Public entry of `@map-harness/mcp-transport`: the versioned
 * `mcp-transport@1` contract, the remote MCP client face, the program-side
 * error codes, and the host plugin (`name`/`inject`/`apply`/`Config`) that
 * validates deployment configuration, resolves credential references, and
 * provides the `mcpTransport` service for the process lifetime.
 *
 * @module @map-harness/mcp-transport
 */
export * from './contract.ts'
export * from './errors.ts'
export * from './client.ts'
export * from './service.ts'
export { name, inject, apply, Config, resolveMcpConnections, buildMcpTransportService } from './plugin.ts'
export type { McpTransportPluginConfig, ResolvedMcpConnection } from './plugin.ts'
