/**
 * Shared admission vocabulary for the data-import formats (`csv`, `kml`,
 * `shapefile`; `geojson` reuses the direct GeoJSON admission). One import
 * either resolves fully — `ready`, carrying a canonical WGS84
 * FeatureCollection that already passed the shared GeoJSON admission — or it
 * stops at `needs_confirmation`, carrying every derived candidate and a
 * fingerprint bound to the exact source bytes, so a later confirmation can
 * prove it confirmed this file and not an earlier one.
 */
import { createHash } from 'node:crypto'
import type { GeoJsonFeatureCollection } from '@map-harness/map-container'

/** The import formats `data_import` admits. */
export type ImportFormat = 'geojson' | 'csv' | 'kml' | 'shapefile'

/** One candidate column with the reasons it was derived. */
export interface ColumnCandidate {
  readonly column: string
  readonly reasons: readonly string[]
}

/** Derived coordinate-column candidates for one role. */
export interface ColumnCandidates {
  readonly lon: readonly ColumnCandidate[]
  readonly lat: readonly ColumnCandidate[]
  readonly id: readonly ColumnCandidate[]
}

/** The coordinate (and optional id) column mapping an import resolved to. */
export interface ColumnMapping {
  readonly lonColumn: string
  readonly latColumn: string
  readonly idColumn?: string
  readonly reasons: readonly string[]
}

/** What a shapefile `.prj` admission concluded about its WKT. */
export interface PrjConclusion {
  /** Human-readable summary of the WKT name/authority, never the full text. */
  readonly wktSummary: string
  /** Whether proj4 could construct a converter from the WKT. */
  readonly proj4Constructible: boolean
}

/** One CRS candidate an unresolved import offers for confirmation. */
export interface CrsCandidate {
  readonly crs: string
  readonly reasons: readonly string[]
}

/**
 * The admission record every import outcome carries: what was read, how it
 * was decoded, which CRS it resolved to, and every ambiguity left open.
 * `warnings` never swallow drops or ignored references — they are reported,
 * counted, and carried into the model-visible result.
 */
export interface ImportAdmission {
  readonly format: ImportFormat
  /** Alternative formats an ambiguous sniff offers for explicit choice. */
  readonly formatCandidates: readonly ImportFormat[] | null
  /** Encoding actually used for decoding (sniffed or explicit). */
  readonly encoding: string
  /** CRS the canonical collection is declared in. */
  readonly nativeCrs: string
  /** sha256 over the raw source bytes, hex. */
  readonly sourceDigest: string
  readonly columnMapping: ColumnMapping | null
  readonly columnCandidates: ColumnCandidates | null
  readonly prjConclusion: PrjConclusion | null
  /** CRS candidates awaiting confirmation (shapefile CRS resolution). */
  readonly crsCandidates: readonly CrsCandidate[] | null
  readonly warnings: readonly string[]
  /** sha256 over the normalized decision inputs (see {@link importFingerprintOf}). */
  readonly candidatesFingerprint: string
}

/** One import outcome: stop at confirmation, or resolve fully. */
export type ImportOutcome =
  | { readonly kind: 'needs_confirmation'; readonly admission: ImportAdmission }
  | { readonly kind: 'ready'; readonly geojson: GeoJsonFeatureCollection; readonly admission: ImportAdmission }

/**
 * SHA-256 over one value with object keys sorted recursively, so equivalent
 * candidate sets hash identically regardless of insertion order.
 * @param value - JSON-shaped value to canonicalize.
 * @returns hex digest.
 */
export function canonicalFingerprint(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize)
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, child]) => [key, canonicalize(child)]),
      )
    }
    return input
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex')
}

/**
 * SHA-256 over the raw source bytes — the content identity every
 * confirmation binds to.
 * @param bytes - raw file bytes.
 * @returns hex digest.
 */
export function sourceDigestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The confirmation fingerprint: a digest over everything the confirmation
 * decided — format, exact file content, encoding, CRS conclusion, and the
 * derived candidate set. A file edited between the two calls changes the
 * source digest and therefore the fingerprint, so a stale confirmation can
 * never authorize new content.
 * @param parts - the decision inputs.
 * @returns hex digest.
 */
export function importFingerprintOf(parts: {
  readonly format: ImportFormat
  readonly sourceDigest: string
  readonly encoding: string
  readonly nativeCrs: string
  readonly candidates: unknown
}): string {
  return canonicalFingerprint({
    format: parts.format,
    sourceDigest: parts.sourceDigest,
    encoding: parts.encoding,
    nativeCrs: parts.nativeCrs,
    candidates: parts.candidates,
  })
}
