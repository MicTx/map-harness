/**
 * Stable machine-readable failure codes for the spatial catalog. Every
 * failure the catalog reports is a {@link CatalogError} whose model-visible
 * text starts with one of these codes; the code vocabulary is the contract
 * and the text after it is diagnostics. Codes are protocol constants, not
 * configuration.
 */

/** The failure families the catalog reports. */
export type CatalogErrorCode =
  | 'CATALOG_INVALID_INPUT'
  | 'CATALOG_NOT_FOUND'
  | 'CATALOG_REVOKED'
  | 'CATALOG_DIGEST_MISMATCH'
  | 'CATALOG_CONFLICT'
  | 'CATALOG_STORE_FULL'
  | 'CATALOG_OPERATION_NOT_PUBLISHED'
  | 'CATALOG_IO'
  | 'CATALOG_SERVICE_UNAVAILABLE'

/**
 * One catalog failure with a stable code prefix in its model-visible text.
 * The text is `<code>: <diagnostics>` and never contains a host absolute
 * path — stored identities are catalog refs and store-relative paths.
 */
export class CatalogError extends Error {
  /** Stable machine-readable failure code. */
  readonly code: CatalogErrorCode
  constructor(code: CatalogErrorCode, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}
