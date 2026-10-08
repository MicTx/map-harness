/**
 * Stable machine-readable failure codes for the P3 decision-models layer.
 * Every failure the contract and computations report is a
 * {@link DecisionError} whose model-visible text starts with one of these
 * codes; the code is the contract and the text after it is diagnostics.
 * Applicability refusals (too few rows, constant outcome, no treatment
 * variation, sparse windows) are result statuses, not errors — errors here
 * mean the request could not be answered at all. Codes are protocol
 * constants, not configuration.
 */

/** The failure families the decision-models layer reports. */
export type DecisionErrorCode =
  | 'DECISION_INVALID_INPUT'
  | 'DECISION_STATE'
  | 'DECISION_IO'

/** One decision-models failure with a stable code prefix in its model-visible text. */
export class DecisionError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: DecisionErrorCode
  constructor(code: DecisionErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'DecisionError'
    this.code = code
  }
}
