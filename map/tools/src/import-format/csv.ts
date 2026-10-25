/**
 * CSV import admission for `data_import`: bounded decode (BOM sniff with an
 * explicit override), RFC 4180 parsing through `csv-parse`, and coordinate
 * column resolution. Unambiguous strong aliases (`lon`, `经度`, …) select
 * automatically; weak aliases (`x`, `y`) and numeric-range plausibility only
 * ever surface as candidates on a `needs_confirmation` outcome, because a
 * silently mis-picked coordinate column is exactly the error the
 * confirmation flow exists to prevent. The `ready` collection always
 * re-enters {@link loadGeoJsonString}, so CSV-sourced resources face the
 * identical GeoJSON budget, CRS, and WGS84-range admission as direct
 * GeoJSON imports.
 */
import { parse as parseCsvRecords } from 'csv-parse/sync'
import { isWgs84FamilyCrs } from '@map-harness/spatial-catalog'
import { loadGeoJsonString } from '../geo-source.ts'
import { SpatialError } from '../spatial-errors.ts'
import {
  type ColumnCandidate,
  type ColumnCandidates,
  type ColumnMapping,
  type ImportAdmission,
  type ImportOutcome,
  importFingerprintOf,
  sourceDigestOf,
} from './admission.ts'
import { MAX_IMPORT_FEATURES } from './limits.ts'

/** Headers that name a longitude unambiguously and auto-select. */
const STRONG_LON_ALIASES = new Set(['lon', 'longitude', 'lng', '经度', '东经', '经度lon', '经度e'])
/** Headers that name a latitude unambiguously and auto-select. */
const STRONG_LAT_ALIASES = new Set(['lat', 'latitude', '纬度', '北纬', '纬度n'])
/** Headers that often carry a longitude but never auto-select alone. */
const WEAK_LON_ALIASES = new Set(['long', 'x', 'x坐标', 'londeg', 'easting'])
/** Headers that often carry a latitude but never auto-select alone. */
const WEAK_LAT_ALIASES = new Set(['y', 'y坐标', 'latdeg', 'northing'])
/** Headers that name a stable feature id. */
const ID_ALIASES = new Set(['id', 'fid', 'oid', 'gid', 'uuid', '编号', '序号'])
/** Data rows sampled for numeric-range plausibility. */
const RANGE_SAMPLE_ROWS = 200
/** Fraction of numeric samples a column needs for range plausibility. */
const RANGE_NUMERIC_FRACTION = 0.8

/** One import request shape for the CSV channel. */
export interface CsvImportRequest {
  readonly bytes: Uint8Array
  /** Declared source CRS; defaults to WGS84. */
  readonly crs?: string
  /** Explicit encoding (for example `gbk`); defaults to BOM sniff. */
  readonly encoding?: string
  /** Explicit longitude column; requires `latColumn`. */
  readonly lonColumn?: string
  /** Explicit latitude column; requires `lonColumn`. */
  readonly latColumn?: string
  /** Explicit id column; optional companion of the coordinate columns. */
  readonly idColumn?: string
}

/** Normalize one header for alias matching: case, separators, brackets. */
function normalizeHeader(name: string): string {
  return name.trim().toLowerCase().replaceAll(/[​\s_\-:：.()（）]/g, '')
}

/** Sniff a BOM into a TextDecoder label; UTF-8 is the fallback. */
function sniffEncoding(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8'
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  return 'utf-8'
}

/**
 * Decode the raw bytes with the requested encoding or the sniffed BOM label.
 * @throws {SpatialError} `INVALID_ARGUMENT` when the bytes cannot decode.
 */
function decodeCsv(bytes: Uint8Array, requested: string | undefined): { text: string; encoding: string } {
  const encoding = requested ?? sniffEncoding(bytes)
  try {
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
    return { text: text.replace(/^\ufeff/, ''), encoding }
  } catch {
    throw new SpatialError('IMPORT_ENCODING_INVALID', `CSV content cannot be decoded as ${encoding}; pass an explicit encoding parameter`)
  }
}

/**
 * Parse RFC 4180 records (quotes, escaped quotes, embedded newlines) with
 * blank lines skipped; ragged rows refuse as malformed structure.
 * @throws {SpatialError} `INVALID_ARGUMENT` on structural CSV errors.
 */
function parseRecords(text: string): string[][] {
  try {
    return parseCsvRecords(text, { skip_empty_lines: true }) as string[][]
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : 'CSV_INVALID_RECORD'
    throw new SpatialError('IMPORT_FORMAT_INVALID', `CSV structure is malformed (${code}); fix quoting or field counts`)
  }
}

/** Numeric samples of one column over the sampled rows. */
function numericSamplesOf(records: readonly string[][], index: number): number[] {
  const samples: number[] = []
  const limit = Math.min(records.length, RANGE_SAMPLE_ROWS)
  for (let row = 1; row < limit; row += 1) {
    const cell = records[row]?.[index]?.trim()
    if (cell === undefined || cell === '') continue
    const value = Number(cell)
    if (Number.isFinite(value)) samples.push(value)
  }
  return samples
}

/**
 * Derive every coordinate/id candidate the header and data admit.
 *
 * Range candidates are pair-gated: coordinates come in pairs, so a lone
 * small-numeric column (a count, a score) is never offered as latitude —
 * both roles must have a plausible column before any range candidate is
 * emitted, and aliases suppress range noise for the roles they cover.
 */
function columnCandidatesOf(header: readonly string[], records: readonly string[][], geographic: boolean): ColumnCandidates {
  const lon: ColumnCandidate[] = []
  const lat: ColumnCandidate[] = []
  const id: ColumnCandidate[] = []
  const lonRange: ColumnCandidate[] = []
  const latRange: ColumnCandidate[] = []
  header.forEach((rawName, index) => {
    const normalized = normalizeHeader(rawName)
    const reasons: string[] = []
    if (STRONG_LON_ALIASES.has(normalized)) reasons.push(`alias:${normalized}`)
    else if (WEAK_LON_ALIASES.has(normalized)) reasons.push(`weak-alias:${normalized}`)
    if (reasons.length > 0) lon.push({ column: rawName, reasons })
    const latReasons: string[] = []
    if (STRONG_LAT_ALIASES.has(normalized)) latReasons.push(`alias:${normalized}`)
    else if (WEAK_LAT_ALIASES.has(normalized)) latReasons.push(`weak-alias:${normalized}`)
    if (latReasons.length > 0) lat.push({ column: rawName, reasons: latReasons })
    if (ID_ALIASES.has(normalized)) id.push({ column: rawName, reasons: [`alias:${normalized}`] })
    if (reasons.length === 0 && latReasons.length === 0 && geographic) {
      const samples = numericSamplesOf(records, index)
      const nonEmpty = records.slice(1, Math.min(records.length, RANGE_SAMPLE_ROWS))
        .filter(row => (row[index]?.trim() ?? '') !== '').length
      if (nonEmpty > 0 && samples.length / nonEmpty >= RANGE_NUMERIC_FRACTION) {
        if (samples.every(value => Math.abs(value) <= 180) && samples.some(value => Math.abs(value) > 90)) {
          lonRange.push({ column: rawName, reasons: ['range:lon-plausible'] })
        } else if (samples.every(value => Math.abs(value) <= 90)) {
          latRange.push({ column: rawName, reasons: ['range:lat-plausible'] })
        }
      }
    }
  })
  if (lon.length === 0 && lat.length === 0 && lonRange.length > 0 && latRange.length > 0) {
    lon.push(...lonRange)
    lat.push(...latRange)
  }
  return { lon, lat, id }
}

/** Resolve the explicit column mapping after validating it against the header. */
function explicitMappingOf(request: CsvImportRequest, header: readonly string[]): ColumnMapping {
  const { lonColumn, latColumn, idColumn } = request
  if ((lonColumn === undefined) !== (latColumn === undefined)) {
    throw new SpatialError('INVALID_ARGUMENT', 'lon_column and lat_column are required together')
  }
  const requireColumn = (name: string, role: string): void => {
    if (!header.includes(name)) {
      throw new SpatialError('INVALID_ARGUMENT', `${role} column "${name}" is not in the CSV header`)
    }
  }
  requireColumn(lonColumn!, 'lon')
  requireColumn(latColumn!, 'lat')
  if (idColumn !== undefined) requireColumn(idColumn, 'id')
  return {
    lonColumn: lonColumn!,
    latColumn: latColumn!,
    ...(idColumn === undefined ? {} : { idColumn }),
    reasons: ['explicit'],
  }
}

/** Type one property cell: booleans, round-trip numbers, strings otherwise. */
function propertyValueOf(raw: string): string | number | boolean {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  const numeric = Number(trimmed)
  if (trimmed !== '' && Number.isFinite(numeric) && String(numeric) === trimmed) return numeric
  return raw
}

/**
 * Build Point features under the resolved mapping. Rows with an empty
 * coordinate cell are dropped and counted; non-numeric coordinate cells
 * refuse with the row and column named.
 * @throws {SpatialError} `INVALID_ARGUMENT` on type errors;
 *   `RESOURCE_TOO_LARGE` beyond the feature budget.
 */
function buildFeatures(records: readonly string[][], header: readonly string[], mapping: ColumnMapping): {
  features: Array<{
    type: 'Feature'
    id?: string | number
    geometry: { type: 'Point'; coordinates: [number, number] }
    properties: Record<string, string | number | boolean>
  }>
  dropped: number
} {
  const lonIndex = header.indexOf(mapping.lonColumn)
  const latIndex = header.indexOf(mapping.latColumn)
  const idIndex = mapping.idColumn === undefined ? -1 : header.indexOf(mapping.idColumn)
  const features: Array<{
    type: 'Feature'
    id?: string | number
    geometry: { type: 'Point'; coordinates: [number, number] }
    properties: Record<string, string | number | boolean>
  }> = []
  let dropped = 0
  for (let row = 1; row < records.length; row += 1) {
    const record = records[row]!
    const lonCell = record[lonIndex]?.trim() ?? ''
    const latCell = record[latIndex]?.trim() ?? ''
    if (lonCell === '' || latCell === '') {
      dropped += 1
      continue
    }
    const lon = Number(lonCell)
    const lat = Number(latCell)
    if (!Number.isFinite(lon)) {
      throw new SpatialError('IMPORT_FORMAT_INVALID', `CSV row ${row} column "${mapping.lonColumn}" value "${lonCell}" is not a number`)
    }
    if (!Number.isFinite(lat)) {
      throw new SpatialError('IMPORT_FORMAT_INVALID', `CSV row ${row} column "${mapping.latColumn}" value "${latCell}" is not a number`)
    }
    const properties: Record<string, string | number | boolean> = {}
    header.forEach((name, index) => {
      if (index === lonIndex || index === latIndex || index === idIndex) return
      properties[name] = propertyValueOf(record[index] ?? '')
    })
    const idCell = idIndex === -1 ? '' : record[idIndex]?.trim() ?? ''
    features.push({
      type: 'Feature',
      ...(idCell === '' ? {} : { id: propertyValueOf(idCell) as string | number }),
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties,
    })
    if (features.length > MAX_IMPORT_FEATURES) {
      throw new SpatialError('RESOURCE_TOO_LARGE', `CSV exceeds the ${MAX_IMPORT_FEATURES} feature limit`)
    }
  }
  return { features, dropped }
}

/** Assemble the admission record shared by both outcome kinds. */
function admissionOf(parts: {
  encoding: string
  nativeCrs: string
  sourceDigest: string
  columnMapping: ColumnMapping | null
  columnCandidates: ColumnCandidates | null
  warnings: readonly string[]
}): ImportAdmission {
  return {
    format: 'csv',
    formatCandidates: null,
    encoding: parts.encoding,
    nativeCrs: parts.nativeCrs,
    sourceDigest: parts.sourceDigest,
    columnMapping: parts.columnMapping,
    columnCandidates: parts.columnCandidates,
    prjConclusion: null,
    crsCandidates: null,
    warnings: parts.warnings,
    candidatesFingerprint: importFingerprintOf({
      format: 'csv',
      sourceDigest: parts.sourceDigest,
      encoding: parts.encoding,
      nativeCrs: parts.nativeCrs,
      candidates: parts.columnCandidates ?? parts.columnMapping,
    }),
  }
}

/**
 * Parse one CSV import into its admission outcome.
 * @param request - raw bytes, optional CRS/encoding/columns.
 * @returns `needs_confirmation` with derived candidates when the coordinate
 *   mapping is ambiguous, or `ready` with the canonical WGS84 collection.
 * @throws {SpatialError} with a stable code, never a host path, for decode,
 *   structure, type, CRS, range, and budget failures.
 */
export function parseCsvImport(request: CsvImportRequest): ImportOutcome {
  const sourceDigest = sourceDigestOf(request.bytes)
  const { text, encoding } = decodeCsv(request.bytes, request.encoding)
  const records = parseRecords(text)
  if (records.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', 'CSV requires a header row')
  }
  const header = records[0]!
  const nativeCrs = request.crs ?? 'EPSG:4326'
  const geographic = isWgs84FamilyCrs(nativeCrs)
  const candidates = columnCandidatesOf(header, records, geographic)
  let mapping: ColumnMapping | null
  if (request.lonColumn !== undefined || request.latColumn !== undefined || request.idColumn !== undefined) {
    mapping = explicitMappingOf(request, header)
  } else {
    const strongLon = candidates.lon.filter(entry => entry.reasons.some(reason => reason.startsWith('alias:')))
    const strongLat = candidates.lat.filter(entry => entry.reasons.some(reason => reason.startsWith('alias:')))
    const lonIsUnique = strongLon.length === 1 && strongLon[0]!.column !== strongLat[0]?.column
    const latIsUnique = strongLat.length === 1
    mapping = lonIsUnique && latIsUnique
      ? {
          lonColumn: strongLon[0]!.column,
          latColumn: strongLat[0]!.column,
          ...(candidates.id.length === 1 ? { idColumn: candidates.id[0]!.column } : {}),
          reasons: [...strongLon[0]!.reasons, ...strongLat[0]!.reasons],
        }
      : null
  }
  if (mapping === null) {
    return {
      kind: 'needs_confirmation',
      admission: admissionOf({
        encoding,
        nativeCrs,
        sourceDigest,
        columnMapping: null,
        columnCandidates: candidates,
        warnings: [],
      }),
    }
  }
  const { features, dropped } = buildFeatures(records, header, mapping)
  const collection = { type: 'FeatureCollection', features }
  const geojson = loadGeoJsonString(Buffer.from(JSON.stringify(collection), 'utf8'), nativeCrs)
  return {
    kind: 'ready',
    geojson,
    admission: admissionOf({
      encoding,
      nativeCrs,
      sourceDigest,
      columnMapping: mapping,
      columnCandidates: candidates,
      warnings: dropped === 0 ? [] : [`dropped-rows:${dropped}`],
    }),
  }
}
