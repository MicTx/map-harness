/**
 * Stable machine-readable failure codes for the catalog's governance plane.
 * Every governance refusal is a {@link GovernanceError} whose model-visible
 * text starts with one of these codes; the code vocabulary is the contract
 * and the text after it is diagnostics. Codes are protocol constants, not
 * configuration.
 */

/** The failure families the governance plane reports. */
export type GovernanceErrorCode =
  | 'GOVERNANCE_DENIED'
  | 'GOVERNANCE_REVOKED'
  | 'GOVERNANCE_TOMBSTONED'
  | 'GOVERNANCE_RECALLED'
  | 'GOVERNANCE_SUBJECT_REQUIRED'
  | 'GOVERNANCE_DOMAIN_UNKNOWN'
  | 'GOVERNANCE_INVALID_INPUT'
  | 'GOVERNANCE_IO'

/**
 * One governance failure with a stable code prefix in its model-visible text.
 * The text is `<code>: <diagnostics>` and never contains a host absolute
 * path; revocation and tombstone refusals carry the copy-limit note so no
 * surface ever promises recall or erasure of existing copies.
 */
export class GovernanceError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: GovernanceErrorCode
  constructor(code: GovernanceErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}
