/**
 * Stable machine-readable failure codes for the P2 statistics layer. Every
 * failure the contract and computations report is a {@link StatisticsError}
 * whose model-visible text starts with one of these codes; the code is the
 * contract and the text after it is diagnostics. Applicability refusals
 * (`too few units`, `constant field`, sparse windows) are result statuses,
 * not errors — errors here mean the request could not be answered at all.
 * Codes are protocol constants, not configuration.
 */

/** The failure families the statistics layer reports. */
export type StatisticsErrorCode =
  | 'STATS_INVALID_INPUT'
  | 'STATS_STATE'
  | 'STATS_IO'

/** One statistics failure with a stable code prefix in its model-visible text. */
export class StatisticsError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: StatisticsErrorCode
  constructor(code: StatisticsErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.name = 'StatisticsError'
    this.code = code
  }
}
