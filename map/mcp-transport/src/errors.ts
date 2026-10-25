/**
 * Stable machine-readable failure codes for the remote MCP transport plane.
 * These codes carry the *program-side* failures of `@map-harness/mcp-transport`:
 * an invalid connection configuration, a declared connection whose credential
 * reference resolves to nothing at load, dispatching over an unknown
 * connection, or a transport that fails its own close. They are deliberately
 * distinct from the {@link McpExchangeOutcome} vocabulary: a remote endpoint
 * that is unreachable, refuses the handshake, or dies mid-call is a *result*
 * of the exchange (an outcome on an {@link McpExchangeError} or a
 * verification report), never a program failure — a caller abort is likewise
 * the `aborted` exchange outcome. Codes are protocol constants, not
 * configuration.
 */

/** The program-side failure families the transport plane reports. */
export type McpTransportErrorCode =
  | 'MCP_TRANSPORT_CONFIG_INVALID'
  | 'MCP_TRANSPORT_CREDENTIAL_MISSING'
  | 'MCP_TRANSPORT_UNKNOWN_CONNECTION'
  | 'MCP_TRANSPORT_STATE'

/**
 * One transport-plane configuration/state failure with a stable code prefix.
 * The text is `<code>: <diagnostics>` and never contains a credential value
 * or a host absolute path; constructors take diagnostics already sanitized
 * at the call site.
 */
export class McpTransportError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: McpTransportErrorCode
  constructor(code: McpTransportErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'McpTransportError'
    this.code = code
  }
}
