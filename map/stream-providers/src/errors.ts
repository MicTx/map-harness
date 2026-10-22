/**
 * Stable machine-readable failure codes for the stream provider plane.
 * These codes carry the *program-side* failures of
 * `@map-harness/stream-providers`: an invalid source or fusion
 * configuration, a credential reference that resolves to nothing in the
 * cc-switch store at the execution round that needs it, or addressing an
 * unknown source or fusion. They are deliberately distinct from the
 * {@link StreamReadOutcome} vocabulary: an endpoint that is unreachable,
 * refuses the credential, or violates the stream framing is a *result* of
 * the read (an outcome on the source state and the verification report),
 * never a program failure. Codes are protocol constants, not configuration.
 */

/** The program-side failure families the provider plane reports. */
export type StreamProvidersErrorCode =
  | 'STREAM_PROVIDERS_CONFIG_INVALID'
  | 'STREAM_PROVIDERS_CREDENTIAL_UNRESOLVED'
  | 'STREAM_PROVIDERS_CREDENTIAL_STORE_UNAVAILABLE'
  | 'STREAM_PROVIDERS_UNKNOWN_SOURCE'
  | 'STREAM_PROVIDERS_UNKNOWN_FUSION'
  | 'STREAM_PROVIDERS_STATE'

/**
 * One provider-plane configuration/credential/state failure with a stable
 * code prefix. The text is `<code>: <diagnostics>` and never contains a
 * credential value or a host absolute path; constructors take diagnostics
 * already sanitized at the call site.
 */
export class StreamProvidersError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: StreamProvidersErrorCode
  constructor(code: StreamProvidersErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'StreamProvidersError'
    this.code = code
  }
}

/**
 * Map one caught credential-plane failure onto the read outcome
 * vocabulary: a credential refusal is an answer about the source, not a
 * program failure, so engine rounds and verification reports carry it as
 * the `auth-rejected` outcome with the sanitized, by-name detail.
 * @param error - the thrown {@link StreamProvidersError} from credential resolution.
 * @returns the outcome and bounded detail for the round report.
 */
export function streamCredentialFailure(error: StreamProvidersError): { outcome: 'auth-rejected'; detail: string } {
  const message = error.message.split('\n', 1)[0] ?? 'credential resolution failed'
  return { outcome: 'auth-rejected', detail: message.length > 512 ? `${message.slice(0, 511)}…` : message }
}
