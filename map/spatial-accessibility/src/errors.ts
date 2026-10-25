/**
 * Stable machine-readable failure codes for the P1 accessibility layer.
 * Every failure the contract, provider, run store, and coverage computation
 * report is an {@link AccessibilityError} whose model-visible text starts
 * with one of these codes; the code vocabulary is the contract and the text
 * after it is diagnostics. The provider-facing codes deliberately reuse the
 * design §6.3 vocabulary (`PERMISSION_DENIED`, `RATE_LIMITED`,
 * `TEMPORARILY_UNAVAILABLE`, `METHOD_NOT_APPLICABLE`, `INCOMPLETE_COVERAGE`,
 * `OUTCOME_UNKNOWN`, `OPERATION_NOT_PUBLISHED`) so partial, unavailable, and
 * unknown outcomes stay distinguishable end to end. Codes are protocol
 * constants, not configuration.
 */

/** The failure families the accessibility layer reports. */
export type AccessibilityErrorCode =
  | 'ACCESS_INVALID_INPUT'
  | 'ACCESS_NOT_FOUND'
  | 'ACCESS_CONFLICT'
  | 'ACCESS_STATE'
  | 'ACCESS_IO'
  | 'METHOD_NOT_APPLICABLE'
  | 'INCOMPLETE_COVERAGE'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'OUTCOME_UNKNOWN'
  | 'OPERATION_NOT_PUBLISHED'

/**
 * One accessibility failure with a stable code prefix in its model-visible
 * text. The text is `<code>: <diagnostics>` and never contains a host
 * absolute path.
 */
export class AccessibilityError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: AccessibilityErrorCode
  constructor(code: AccessibilityErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'AccessibilityError'
    this.code = code
  }
}

/** The internal control-flow signal a run worker raises at a cancel checkpoint. */
export class RunCancelled extends Error {
  constructor() {
    super('run cancelled at a worker checkpoint')
    this.name = 'RunCancelled'
  }
}
