/**
 * The `mcpTransport` service face: the declared remote MCP connections of
 * this deployment, listed and verified at connection capability. The host
 * surface mirrors `spatialConnect`: `listConnections` names the declared set
 * (credential *references* only, never values), and `verifyConnection` runs
 * one bounded exchange whose result is a {@link McpConnectionVerification}
 * report — every remote answer, including refusals, is an outcome on the
 * report. On top of that, the service exposes the dispatch plane
 * `openRemoteMcp` provides: `openConnection` (cached per id, closed
 * explicitly or by plugin disposal), `callTool` (uses a cached connection,
 * or opens and closes a transient one), and `closeConnection`.
 *
 * @module @map-harness/mcp-transport/service
 */
import type { CallToolResult } from '@modelcontextprotocol/client'
import type { AnyConnectionSpec, McpConnectionVerification, McpConnectionKind } from './contract.ts'
import type { RemoteMcpConnection } from './client.ts'

/** Service name under `ctx.reflect.provide`. */
export const MCP_TRANSPORT_SERVICE = 'mcpTransport'

/** One declared connection as `listConnections` reports it. */
export interface McpConnectionSummary {
  /** Declared connection id. */
  readonly id: string
  /** Connection family. */
  readonly kind: McpConnectionKind
  /** Endpoint identity: command and arg count for stdio, URL for http; credential references by name only. */
  readonly endpoint: string
}

/** Options the service's verification and open methods accept. */
export interface McpServiceOptions {
  /** Caller cancellation; an already-aborted signal yields the `aborted` outcome. */
  readonly signal?: AbortSignal
  /** Per-exchange deadline override. */
  readonly timeoutMs?: number
}

/** The host-facing remote MCP transport service. */
export interface McpTransportService {
  /** Every declared connection spec, in declaration order. */
  readonly specs: readonly AnyConnectionSpec[]
  /** Name the declared connections with sanitized endpoint identities. */
  listConnections(): readonly McpConnectionSummary[]
  /**
   * Run one bounded verification exchange over a fresh connection.
   * @param id - a declared connection id.
   * @param options - deadline and cancellation for the whole exchange.
   * @returns the report; remote answers are outcomes, not throws.
   * @throws McpTransportError only when `id` is not declared.
   */
  verifyConnection(id: string, options?: McpServiceOptions): Promise<McpConnectionVerification>
  /**
   * Open (or return the already open) cached connection for one id.
   * @param id - a declared connection id.
   * @param options - deadline and cancellation for the open exchange.
   * @throws McpTransportError when `id` is not declared; McpExchangeError when the exchange fails.
   */
  openConnection(id: string, options?: McpServiceOptions): Promise<RemoteMcpConnection>
  /**
   * Dispatch one tool call, over the cached connection when one is open and
   * over a transient open-handshake-call-close exchange otherwise.
   * @param id - a declared connection id.
   * @param name - raw MCP tool name.
   * @param args - tool arguments as the server's schema expects.
   * @param options - deadline and cancellation for the exchange.
   * @returns the raw MCP result (server `isError` content included).
   * @throws McpTransportError when `id` is not declared; McpExchangeError when the exchange fails.
   */
  callTool(id: string, name: string, args: Readonly<Record<string, unknown>>, options?: McpServiceOptions): Promise<CallToolResult>
  /**
   * Close the cached connection for one id, quiescently.
   * @param id - a declared connection id.
   * @returns true when a cached connection was closed, false when none was open.
   */
  closeConnection(id: string): Promise<boolean>
}
