/**
 * Safe source configuration and runtime failures shared by host source owners.
 * Raw upstream errors, addresses and credentials never become error causes.
 * @module @map-harness/map-container/source-error
 */
import type { SourceFailureCode } from '@map-harness/map-layers'

/** Fixed source failures suitable for wire codes and localized presentation. */
export type SourceCatalogFailureCode = SourceFailureCode
  | 'SOURCE_CONFIG_INVALID'
  | 'SOURCE_CHANGED'
  | 'SOURCE_CREDENTIAL_REJECTED'
  | 'SOURCE_TIMEOUT'
  | 'SOURCE_CANCELLED'
  | 'SOURCE_POLICY_DENIED'

const messages: Readonly<Record<SourceCatalogFailureCode, string>> = {
  SOURCE_CONFIG_INVALID: 'The map source configuration is invalid. Ask the administrator to correct it.',
  SOURCE_VERSION_UNSUPPORTED: 'This map source record uses an unsupported version. Open it with a compatible application.',
  SOURCE_RESOURCE_DENIED: 'The requested map source resource is not allowed.',
  SOURCE_COMBINATION_UNSUPPORTED: 'The selected basemap and reference labels are incompatible. Choose compatible labels or turn them off.',
  SOURCE_NOT_CONFIGURED: 'The selected map source needs deployment configuration.',
  SOURCE_UNAVAILABLE: 'The selected map service is unavailable. Keep the current data and retry or choose an authorized source.',
  SOURCE_NOT_FOUND: 'The selected map source is not configured.',
  SOURCE_LIMIT_EXCEEDED: 'The map source request exceeds its configured limit. Use a smaller request.',
  SOURCE_READ_ONLY: 'Map source changes are disabled. Keep the current selection or ask the administrator for access.',
  SOURCE_CHANGED: 'The map source configuration changed. Refresh the catalog and select it again.',
  SOURCE_CREDENTIAL_REJECTED: 'The map service rejected its configured credentials. Ask the administrator to update them.',
  SOURCE_TIMEOUT: 'The map service did not respond before the deadline. Retry or choose an authorized source.',
  SOURCE_CANCELLED: 'The map source request was cancelled.',
  SOURCE_POLICY_DENIED: 'The selected map source does not allow this operation. Choose a source with verified permission.',
}

/** A source failure that never retains raw upstream/configuration details. */
export class SourceCatalogError extends Error {
  readonly code: SourceCatalogFailureCode

  /**
   * Create one safe failure.
   * @param code - fixed source code; messages are owned here, not by upstreams.
   */
  constructor(code: SourceCatalogFailureCode) {
    super(messages[code])
    this.name = 'SourceCatalogError'
    this.code = code
  }
}
