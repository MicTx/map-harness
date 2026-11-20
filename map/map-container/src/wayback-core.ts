/**
 * Small ESM adapter for the official CJS Wayback library.
 * Process-global configuration remains untouched.
 * @module @map-harness/map-container/wayback-core
 */

/** Official release catalog entry. */
export interface WaybackCoreItem {
  readonly releaseNum: number
  readonly itemID: string
  readonly itemTitle: string
  readonly itemURL: string
  readonly metadataLayerUrl: string
  readonly metadataLayerItemID: string
  readonly layerIdentifier: string
  readonly releaseDateLabel: string
  readonly releaseDatetime: number
}

/** Acquisition metadata returned for one release and point. */
export interface WaybackCoreMetadata {
  readonly date?: unknown
  readonly provider?: unknown
  readonly source?: unknown
  readonly resolution?: unknown
  readonly accuracy?: unknown
}

/**
 * Catalog identity a metadata read must still match. The official reader
 * resolves the metadata layer from its own live config, so a changed item
 * would otherwise be indistinguishable from the verified release.
 */
export interface WaybackCoreMetadataIdentity {
  readonly itemId: string
  readonly metadataLayerUrl: string
}
