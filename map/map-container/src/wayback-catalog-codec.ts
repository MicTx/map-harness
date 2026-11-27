/**
 * Strict decoder for the official World Imagery Wayback release catalog.
 * Pure and browser-safe: the host transport and the browser catalog owner share it.
 * A damaged entry rejects the whole batch so a verified catalog is never replaced by a shorter one.
 * @module @map-harness/map-container/wayback-catalog-codec
 */
import { stableDigestOf } from './stable-digest.ts'

/** Official release catalog URL; a public credential-free JSON document. */
export const WAYBACK_CONFIG_URL = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json'
/** Official WMTS endpoint used for tile requests and capabilities. */
export const WAYBACK_ENDPOINT = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer'
/** Logical BrowserStorage key of the browser owner's last-good record. */
export const WAYBACK_CATALOG_STORAGE_KEY = 'map-harness.wayback-catalog'

/** Largest release batch the official catalog is expected to hold. */
export const WAYBACK_CATALOG_MAX_RELEASES = 256

/** Why a catalog was refused; never carries upstream text, addresses or credentials. */
export type WaybackCatalogDecodeReason =
  | 'malformed' /** Not JSON. */
  | 'shape' /** Wrong document, entry, or field type, id, or title format. */
  | 'date' /** A release date label is not a real calendar date. */
  | 'endpoint' /** A tile or metadata URL leaves its fixed official endpoint. */
  | 'count' /** Fewer than 1 or more than 256 numeric entries. */
  | 'duplicate' /** A release number or imagery item id appears twice. */

/** Strict decoder refusal with a fixed reason and no upstream cause. */
export class WaybackCatalogDecodeError extends Error {
  readonly reason: WaybackCatalogDecodeReason
  constructor(reason: WaybackCatalogDecodeReason) {
    super(`Wayback catalog refused: ${reason}`)
    this.name = 'WaybackCatalogDecodeError'
    this.reason = reason
  }
}

/** One official fixed release; acquiredAt is never inferred from publishedAt. */
export interface WaybackCatalogRelease {
  readonly releaseId: number
  readonly itemId: string
  readonly title: string
  readonly publishedAt: string
  readonly layerIdentifier: string
  readonly acquiredAt: string | null
}

/** Validated official catalog entry in the field order the digest depends on. */
export interface WaybackCatalogItem {
  readonly releaseNum: number
  readonly itemID: string
  readonly itemTitle: string
  readonly releaseDateLabel: string
  readonly layerIdentifier: string
  readonly itemURL: string
  readonly metadataLayerUrl: string
  readonly metadataLayerItemID: string
}

/** A verified batch: releases newest first, then by ascending release id. */
export interface WaybackCatalog {
  readonly releases: readonly WaybackCatalogRelease[]
  readonly items: readonly WaybackCatalogItem[]
  /** Content digest of `items`; a persisted record must carry it. */
  readonly digest: string
}

const ITEM_KEYS: readonly string[] = ['releaseNum', 'itemID', 'itemTitle', 'releaseDateLabel', 'layerIdentifier', 'itemURL', 'metadataLayerUrl', 'metadataLayerItemID']
const TITLE = /^World Imagery \(Wayback (\d{4}-\d{2}-\d{2})\)$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const HEX_ID = /^[0-9a-f]{32}$/
const LAYER = /^WB_\d{4}_R\d{2}$/
const METADATA_URL = /^https:\/\/metadata\.maptiles\.arcgis\.com\/arcgis\/rest\/services\/World_Imagery_Metadata_\d{4}_r\d{2}\/MapServer$/

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null
}

function releaseNumber(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0 ? number : null
}

/** @param value - Calendar date text. @returns The date, or null when it is not a real date. */
function calendarDate(value: unknown): string | null {
  if (typeof value !== 'string' || !DATE.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null
}

function finish(entries: readonly { release: WaybackCatalogRelease; item: WaybackCatalogItem }[]): WaybackCatalog {
  if (new Set(entries.map(({ release }) => release.releaseId)).size !== entries.length
    || new Set(entries.map(({ item }) => item.itemID)).size !== entries.length) {
    throw new WaybackCatalogDecodeError('duplicate')
  }
  const sorted = [...entries].sort((left, right) =>
    right.release.publishedAt.localeCompare(left.release.publishedAt) || left.release.releaseId - right.release.releaseId)
  const releases = Object.freeze(sorted.map(({ release }) => Object.freeze(release)))
  const items = Object.freeze(sorted.map(({ item }) => Object.freeze(item)))
  return Object.freeze({ releases, items, digest: stableDigestOf(items) })
}

/**
 * Validate one official entry carrying `releaseNum`.
 * @param value - Decoded JSON entry.
 * @returns The release and its validated item.
 * @throws WaybackCatalogDecodeError with `shape`, `date`, or `endpoint` when the entry is not an intact official release.
 */
export function normalizeWaybackCatalogItem(value: unknown): { release: WaybackCatalogRelease; item: WaybackCatalogItem } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WaybackCatalogDecodeError('shape')
  const entry = value as Record<string, unknown>
  if (Object.keys(entry).some(key => !ITEM_KEYS.includes(key))) throw new WaybackCatalogDecodeError('shape')
  const releaseId = releaseNumber(entry.releaseNum)
  const itemId = text(entry.itemID)
  const title = text(entry.itemTitle)
  const layerIdentifier = text(entry.layerIdentifier)
  if (releaseId === null || itemId === null || !HEX_ID.test(itemId) || title === null || layerIdentifier === null || !LAYER.test(layerIdentifier)) {
    throw new WaybackCatalogDecodeError('shape')
  }
  const label = TITLE.exec(title)?.[1]
  if (label === undefined) throw new WaybackCatalogDecodeError('shape')
  const publishedAt = calendarDate(label)
  if (publishedAt === null) throw new WaybackCatalogDecodeError('date')
  const metadataItemId = text(entry.metadataLayerItemID)
  if (typeof entry.metadataLayerUrl !== 'string' || metadataItemId === null || !HEX_ID.test(metadataItemId)) {
    throw new WaybackCatalogDecodeError('shape')
  }
  if (entry.itemURL !== `${WAYBACK_ENDPOINT}/tile/${releaseId}/{level}/{row}/{col}` || !METADATA_URL.test(entry.metadataLayerUrl)) {
    throw new WaybackCatalogDecodeError('endpoint')
  }
  return {
    release: { releaseId, itemId, title, publishedAt, layerIdentifier, acquiredAt: null },
    item: {
      releaseNum: releaseId, itemID: itemId, itemTitle: title, releaseDateLabel: publishedAt,
      layerIdentifier, itemURL: entry.itemURL, metadataLayerUrl: entry.metadataLayerUrl, metadataLayerItemID: metadataItemId,
    },
  }
}

/**
 * Decode the raw official `waybackconfig.json` text: an object keyed by release number.
 * Non-numeric keys are ignored, as the official reader ignores them.
 * @param body - Raw response text.
 * @returns The verified newest-first catalog.
 * @throws WaybackCatalogDecodeError when the batch is not intact.
 */
export function decodeWaybackCatalog(body: string): WaybackCatalog {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new WaybackCatalogDecodeError('malformed')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new WaybackCatalogDecodeError('shape')
  const catalog = parsed as Record<string, unknown>
  const keys = Object.keys(catalog).map(Number).filter(releaseId => !Number.isNaN(releaseId))
  if (keys.length === 0 || keys.length > WAYBACK_CATALOG_MAX_RELEASES) throw new WaybackCatalogDecodeError('count')
  return finish(keys.map(releaseId => normalizeWaybackCatalogItem({ ...toEntry(catalog[String(releaseId)]), releaseNum: releaseId })))
}

function toEntry(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new WaybackCatalogDecodeError('shape')
  return value as Record<string, unknown>
}

/**
 * Decode a persisted list of previously verified items; each must carry exactly the canonical fields.
 * @param raw - Decoded `items` of a stored record.
 * @returns The verified newest-first catalog.
 * @throws WaybackCatalogDecodeError when any entry changed since it was verified.
 */
export function decodeWaybackCatalogItems(raw: unknown): WaybackCatalog {
  if (!Array.isArray(raw)) throw new WaybackCatalogDecodeError('shape')
  if (raw.length === 0 || raw.length > WAYBACK_CATALOG_MAX_RELEASES) throw new WaybackCatalogDecodeError('count')
  return finish(raw.map(value => {
    const entry = toEntry(value)
    if (Object.keys(entry).length !== ITEM_KEYS.length) throw new WaybackCatalogDecodeError('shape')
    return normalizeWaybackCatalogItem(entry)
  }))
}

/**
 * Validate a persisted last-good record and return its catalog when every field matches.
 * @param textValue - Stored record text.
 * @returns The catalog and fetch time, or null when the record is not a valid version-1 record.
 */
export function readWaybackCatalogRecord(textValue: string | null): { catalog: WaybackCatalog; fetchedAt: number } | null {
  if (textValue === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(textValue)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (Object.keys(record).length !== 4 || record.version !== 1 || typeof record.fetchedAt !== 'number'
    || !Number.isSafeInteger(record.fetchedAt) || record.fetchedAt < 0 || typeof record.digest !== 'string') return null
  let catalog: WaybackCatalog
  try {
    catalog = decodeWaybackCatalogItems(record.items)
  } catch (error) {
    if (error instanceof WaybackCatalogDecodeError) return null
    throw error
  }
  return catalog.digest === record.digest ? { catalog, fetchedAt: record.fetchedAt } : null
}

/**
 * Serialize a verified catalog as the versioned last-good record.
 * @param catalog - Verified catalog.
 * @param fetchedAt - Clock time in milliseconds of the successful fetch.
 * @returns JSON text for BrowserStorage.
 */
export function writeWaybackCatalogRecord(catalog: WaybackCatalog, fetchedAt: number): string {
  return JSON.stringify({ version: 1, fetchedAt, digest: catalog.digest, items: catalog.items })
}
