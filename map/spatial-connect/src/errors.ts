/**
 * Stable machine-readable failure codes for the external connection plane.
 * These codes carry the *program-side* failures of `@map-harness/spatial-connect`:
 * an invalid connection configuration, a declared connection whose credential
 * reference resolves to nothing at load, a programming error in the connector
 * wiring, or a caller abort. They are deliberately distinct from the
 * {@link ConnectionOutcome} vocabulary: a connection check that reaches a
 * server and gets refused is a *result* (an outcome on a verification report),
 * never an exception — only failures of this process to honor its own
 * contract throw {@link ConnectError}. Codes are protocol constants, not
 * configuration.
 */

/** The program-side failure families the connection plane reports. */
export type ConnectErrorCode =
  | 'CONNECT_CONFIG_INVALID'
  | 'CONNECT_CREDENTIAL_MISSING'
  | 'CONNECT_UNKNOWN_CONNECTION'
  | 'CONNECT_STATE'
  | 'CONNECT_ABORTED'

/**
 * One connection-plane failure with a stable code prefix in its
 * model-visible text. The text is `<code>: <diagnostics>`, never contains a
 * credential value or a host absolute path, and never contains a secret: the
 * constructors take diagnostics that were already sanitized at the call site.
 */
export class ConnectError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: ConnectErrorCode
  constructor(code: ConnectErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'ConnectError'
    this.code = code
  }
}
