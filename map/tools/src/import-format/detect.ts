/**
 * Format detection and the two-phase admission assembly for `data_import`:
 * one bounded workspace read through the shared `geo-source` file admission,
 * format resolution by explicit declaration, extension, or content sniff
 * (ambiguity stops at `needs_confirmation` with format candidates), dispatch
 * into the per-format parsers, and the confirmation gate. Every call —
 * first call or confirmation call — re-reads the file and re-derives the
 * candidate set from scratch, so a confirmation only ever authorizes the
 * exact bytes it fingerprinted; a file that changed in between is refused
 * with a fresh confirmation request instead of importing under a stale
 * decision. The module performs no catalog writes on any path.
 */
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { GeoJsonFeatureCollection } from '@map-harness/map-container'
import { loadGeoJsonString, readBoundedWorkspaceFile } from '../geo-source.ts'
import { SpatialError } from '../spatial-errors.ts'
import {
  type ImportAdmission,
  type ImportFormat,
  type ImportOutcome,
  importFingerprintOf,
  sourceDigestOf,
} from './admission.ts'
import { parseCsvImport } from './csv.ts'
import { parseKmlImport } from './kml.ts'
import { parseShapefileImport } from './shapefile.ts'
import { MAX_IMPORT_FILE_BYTES } from './limits.ts'

/** One import request as the `data_import` tool receives it. */
export interface ImportRequest {
  /** Workspace-relative path, admitted through the shared file admission. */
  readonly path: string
  /** Explicit format declaration; wins over extension and sniffing. */
  readonly format?: ImportFormat
  /** Declared source CRS (CSV/Shapefile; KML refuses it). */
  readonly crs?: string
  /** Explicit text encoding for CSV. */
  readonly encoding?: string
  /** Explicit CSV coordinate columns (skip column confirmation). */
  readonly lonColumn?: string
  readonly latColumn?: string
  readonly idColumn?: string
  /** Confirmation gate: the fingerprint the caller is answering. */
  readonly confirm?: { readonly fingerprint: string }
}

/** Extension to format, consulted before content sniffing. */
const EXTENSION_FORMATS: Readonly<Record<string, ImportFormat>> = {
  geojson: 'geojson',
  json: 'geojson',
  csv: 'csv',
  tsv: 'csv',
  kml: 'kml',
  zip: 'shapefile',
}

/** Best-effort decode for sniffing only; never used for the real parse. */
function sniffText(bytes: Uint8Array): string {
  const label = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be'
      : 'utf-8'
  return new TextDecoder(label).decode(bytes.subarray(0, 4096)).replace(/^\ufeff/, '')
}

/** Whether sniffed text opens like XML. */
function looksLikeXml(text: string): boolean {
  return /^\s*(<\?xml|<kml[\s>]|<kml\b)/i.test(text) || /^\s*<[a-zA-Z]/.test(text)
}

/** Whether sniffed text is a JSON FeatureCollection. */
function looksLikeGeoJson(text: string): boolean {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('{')) return false
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown; features?: unknown }
    return parsed.type === 'FeatureCollection' && Array.isArray(parsed.features)
  } catch {
    return false
  }
}

/** Whether sniffed text plausibly opens a delimited text table. */
function looksLikeCsv(text: string): boolean {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('<') || trimmed.startsWith('{') || trimmed.startsWith('[')) return false
  const firstLine = trimmed.split(/\r?\n/, 1)[0] ?? ''
  if (!firstLine.includes(',') && !firstLine.includes('\t') && !firstLine.includes(';')) return false
  const delimiter = firstLine.includes(',') ? ',' : firstLine.includes('\t') ? '\t' : ';'
  const fields = firstLine.split(delimiter).length
  if (fields < 2) return false
  const lines = trimmed.split(/\r?\n/).filter(line => line !== '')
  return lines.length === 1 || lines.slice(1).every(line => line.split(delimiter).length === fields)
}

/**
 * Resolve the import format: explicit declaration, then extension, then
 * content sniff. A ZIP that carries no shapefile set refuses instead of
 * sniffing further; a fully ambiguous payload stops at format candidates.
 */
function detectFormat(bytes: Uint8Array, extension: string | undefined, declared: ImportFormat | undefined): {
  format: ImportFormat | null
  candidates: readonly ImportFormat[] | null
} {
  if (declared !== undefined) return { format: declared, candidates: null }
  const byExtension = extension === undefined ? undefined : EXTENSION_FORMATS[extension]
  if (byExtension !== undefined) return { format: byExtension, candidates: null }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
    return { format: 'shapefile', candidates: null }
  }
  const text = sniffText(bytes)
  const candidates: ImportFormat[] = []
  if (looksLikeGeoJson(text)) candidates.push('geojson')
  if (looksLikeXml(text)) candidates.push('kml')
  if (looksLikeCsv(text)) candidates.push('csv')
  if (candidates.length === 1) return { format: candidates[0]!, candidates: null }
  return { format: null, candidates: candidates.length > 0 ? candidates : ['geojson', 'csv', 'kml', 'shapefile'] }
}

/** Build the admission record for the GeoJSON branch. */
function geojsonAdmissionOf(sourceDigest: string, nativeCrs: string, warnings: readonly string[]): ImportAdmission {
  return {
    format: 'geojson',
    formatCandidates: null,
    encoding: 'utf-8',
    nativeCrs,
    sourceDigest,
    columnMapping: null,
    columnCandidates: null,
    prjConclusion: null,
    crsCandidates: null,
    warnings,
    candidatesFingerprint: importFingerprintOf({
      format: 'geojson',
      sourceDigest,
      encoding: 'utf-8',
      nativeCrs,
      candidates: null,
    }),
  }
}

/** Admission for an ambiguous format sniff, offered for explicit choice. */
function formatAmbiguityAdmissionOf(sourceDigest: string, candidates: readonly ImportFormat[]): ImportAdmission {
  return {
    format: candidates[0]!,
    formatCandidates: candidates,
    encoding: 'unconfirmed',
    nativeCrs: 'unconfirmed',
    sourceDigest,
    columnMapping: null,
    columnCandidates: null,
    prjConclusion: null,
    crsCandidates: null,
    warnings: ['format-ambiguous:pass an explicit format parameter'],
    candidatesFingerprint: importFingerprintOf({
      format: candidates[0]!,
      sourceDigest,
      encoding: 'unconfirmed',
      nativeCrs: 'unconfirmed',
      candidates,
    }),
  }
}

/** Dispatch the per-format parse after format resolution. */
function parseByFormat(format: ImportFormat, bytes: Uint8Array, request: ImportRequest): ImportOutcome {
  const declaredCrs = request.crs === undefined ? {} : { crs: request.crs }
  if (format === 'kml') return parseKmlImport({ bytes, ...declaredCrs })
  if (format === 'shapefile') return parseShapefileImport({ bytes, ...declaredCrs })
  if (format === 'csv') {
    const present = <T,>(value: T | undefined): boolean => value !== undefined
    return parseCsvImport({
      bytes,
      ...declaredCrs,
      ...(present(request.encoding) ? { encoding: request.encoding } : {}),
      ...(present(request.lonColumn) ? { lonColumn: request.lonColumn } : {}),
      ...(present(request.latColumn) ? { latColumn: request.latColumn } : {}),
      ...(present(request.idColumn) ? { idColumn: request.idColumn } : {}),
    })
  }
  const nativeCrs = request.crs ?? 'EPSG:4326'
  const geojson = loadGeoJsonString(bytes, nativeCrs)
  return {
    kind: 'ready',
    geojson,
    admission: geojsonAdmissionOf(sourceDigestOf(bytes), nativeCrs, []),
  }
}

/**
 * Admit one import end to end: bounded read, format resolution, per-format
 * parse, and the confirmation gate. The confirmation call re-reads and
 * re-derives everything; only a fingerprint match against the exact current
 * content lets the caller's earlier decision apply.
 * @param request - the `data_import` arguments.
 * @param exec - tool execution supplying the session workspace and cancellation.
 * @returns `needs_confirmation` (format, column, or CRS ambiguity — never a
 *   partial import) or `ready` with the canonical WGS84 collection.
 * @throws {SpatialError} with a stable code, never a host path, for
 *   admission, decode, structure, range, and budget failures.
 */
export async function admitImport(request: ImportRequest, exec: ToolExecution): Promise<ImportOutcome> {
  // A canceled signal maps to the stable canceled code, never a raw
  // AbortError, so model-visible failure text stays machine-readable.
  if (exec.signal.aborted) {
    throw new SpatialError('CALL_CANCELED', 'data import was canceled before the file read')
  }
  const bytes = await readBoundedWorkspaceFile({ path: request.path }, exec, MAX_IMPORT_FILE_BYTES)
  if (exec.signal.aborted) {
    throw new SpatialError('CALL_CANCELED', 'data import was canceled after the file read')
  }
  const extension = request.path.includes('.') ? request.path.split('.').pop()!.toLowerCase() : undefined
  const { format, candidates } = detectFormat(bytes, extension, request.format)
  if (format === null) {
    return {
      kind: 'needs_confirmation',
      admission: formatAmbiguityAdmissionOf(sourceDigestOf(bytes), candidates!),
    }
  }
  // CSV-only parameters refuse on the other formats instead of being ignored.
  const csvOnly = request.encoding ?? request.lonColumn ?? request.latColumn ?? request.idColumn
  if (format !== 'csv' && csvOnly !== undefined) {
    throw new SpatialError('INVALID_ARGUMENT', 'encoding and column parameters apply to CSV imports only')
  }
  if (format !== 'csv' && format !== 'shapefile' && request.crs !== undefined && format !== 'geojson') {
    throw new SpatialError('INVALID_ARGUMENT', 'KML is fixed to WGS84; omit the crs parameter')
  }
  const derived = parseByFormat(format, bytes, request)
  if (request.confirm === undefined) return derived
  if (derived.admission.candidatesFingerprint === request.confirm.fingerprint) return derived
  // The fingerprint the caller answered no longer describes this file (or
  // its derived candidates): the content or decision inputs changed between
  // the two calls, so the old confirmation must not authorize anything. The
  // returned admission keeps the CURRENT fingerprint for the next round.
  return {
    kind: 'needs_confirmation',
    admission: {
      ...derived.admission,
      warnings: [...derived.admission.warnings, 'confirmation-fingerprint-mismatch:the file changed since the confirmation; confirm the new fingerprint'],
    },
  }
}

/** Re-exported for the tool layer: the canonical collection type it hands on. */
export type { GeoJsonFeatureCollection }
