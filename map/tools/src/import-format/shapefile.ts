/**
 * Shapefile ZIP import admission for `data_import`. The ZIP container is
 * admitted by a hand-rolled central-directory reader before anything
 * decompresses: entry count, path traversal, and declared uncompressed
 * totals are checked up front, extraction is bounded, and lying local
 * headers refuse as malformed. Geometry comes from `shpjs` `parseShp` in
 * NATIVE coordinates (no `.prj` is ever passed to it, so it cannot silently
 * reproject), attributes from `parseDbf` under a `.cpg` label, the DBF LDID
 * header byte, or a UTF-8 attempt. CRS is resolved explicitly by the caller,
 * from a proj4-constructible `.prj` (transformed exactly once through the
 * shared reprojection path), or not at all — a missing or unconstructible
 * CRS never silently becomes WGS84; it stops at `needs_confirmation`.
 */
import { inflateRawSync } from 'node:zlib'
import { parseDbf, parseShp } from 'shpjs'
import proj4 from 'proj4'
import { assertCrsSupported, loadGeoJsonString, toWgs84 } from '../geo-source.ts'
import { SpatialError } from '../spatial-errors.ts'
import {
  type CrsCandidate,
  type ImportAdmission,
  type ImportOutcome,
  type PrjConclusion,
  importFingerprintOf,
  sourceDigestOf,
} from './admission.ts'
import { MAX_IMPORT_FEATURES, MAX_ZIP_DECOMPRESSED_BYTES, MAX_ZIP_ENTRIES } from './limits.ts'

/** One admitted ZIP entry from the central directory. */
interface ZipEntry {
  readonly name: string
  readonly method: number
  readonly compressedSize: number
  readonly uncompressedSize: number
  readonly localOffset: number
}

/** One import request shape for the shapefile channel. */
export interface ShapefileImportRequest {
  readonly bytes: Uint8Array
  /** Explicit CRS decision (from the confirmation flow); overrides `.prj`. */
  readonly crs?: string
}

/** ESRI LDID header byte to TextDecoder label (ESRI LDID registry subset). */
const LDID_TABLE: Readonly<Record<number, string>> = {
  0x01: 'ibm866',
  0x02: 'cp850',
  0x03: 'windows-1252',
  0x04: 'macintosh',
  0x64: 'cp852',
  0x65: 'cp866',
  0x66: 'cp895',
  0x67: 'cp620',
  0x68: 'cp737',
  0x69: 'cp857',
  0x6a: 'cp861',
  0x6b: 'cp865',
  0x6c: 'cp863',
  0x78: 'windows-932',
  0x79: 'windows-949',
  0x7a: 'windows-950',
  0x7b: 'windows-1250',
  0x7c: 'windows-1251',
  0x7d: 'gbk',
}

/** Local file header signature. */
const LOCAL_SIG = 0x04034b50
/** Central directory header signature. */
const CENTRAL_SIG = 0x02014b50
/** End-of-central-directory signature. */
const EOCD_SIG = 0x06054b50

/** Reject a malformed container with a stable, path-free message. */
function malformed(detail: string): never {
  throw new SpatialError('IMPORT_FORMAT_INVALID', `shapefile ZIP is malformed (${detail})`)
}

/**
 * Validate the SHP record chain and count its records. The record walk must
 * end exactly at the file length — a truncated tail would otherwise parse as
 * a silently shorter feature set.
 * @throws {SpatialError} `INVALID_ARGUMENT` for malformed structure.
 */
function validateShpStructure(shp: Uint8Array): number {
  const view = new DataView(shp.buffer, shp.byteOffset, shp.byteLength)
  if (shp.byteLength < 100 || view.getInt32(0) !== 9994 || view.getInt32(28, true) !== 1000) {
    malformed('.shp header')
  }
  let offset = 100
  let records = 0
  while (offset < shp.byteLength) {
    if (offset + 8 > shp.byteLength) malformed('.shp record chain')
    const contentWords = view.getInt32(offset + 4)
    if (contentWords <= 0) malformed('.shp record chain')
    offset += 8 + contentWords * 2
    records += 1
  }
  if (offset !== shp.byteLength) malformed('.shp record chain')
  return records
}

/** Validate the SHX index and check its record count against the .shp. */
function validateShxStructure(shx: Uint8Array, shpRecords: number): void {
  const view = new DataView(shx.buffer, shx.byteOffset, shx.byteLength)
  if (shx.byteLength < 100 || view.getInt32(0) !== 9994 || view.getInt32(28, true) !== 1000) {
    malformed('.shx header')
  }
  if ((shx.byteLength - 100) % 8 !== 0 || (shx.byteLength - 100) / 8 !== shpRecords) {
    malformed('.shx record count')
  }
}

/**
 * Read every entry from the ZIP central directory.
 * @throws {SpatialError} `INVALID_ARGUMENT` for malformed structure,
 *   `RESOURCE_TOO_LARGE` beyond the entry-count budget.
 */
function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const scanStart = Math.max(0, bytes.byteLength - 0x10000 - 22)
  let eocd = -1
  for (let at = bytes.byteLength - 22; at >= scanStart; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIG) {
      eocd = at
      break
    }
  }
  if (eocd < 0) malformed('end-of-central-directory record not found')
  const entryCount = view.getUint16(eocd + 10, true)
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `shapefile ZIP exceeds the ${MAX_ZIP_ENTRIES} entry limit`)
  }
  const directoryOffset = view.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []
  let cursor = directoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.byteLength || view.getUint32(cursor, true) !== CENTRAL_SIG) {
      malformed(`central directory entry ${index}`)
    }
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const uncompressedSize = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const nameEnd = cursor + 46 + nameLength
    if (nameEnd > bytes.byteLength) malformed(`central directory entry ${index} name`)
    entries.push({
      name: Buffer.from(bytes.subarray(cursor + 46, nameEnd)).toString('utf8'),
      method,
      compressedSize,
      uncompressedSize,
      localOffset,
    })
    cursor = nameEnd + extraLength + commentLength
  }
  return entries
}

/** Reject traversal or absolute entry names before any extraction. */
function assertSafeEntryName(name: string): void {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    malformed(`entry "${name}" uses an absolute path`)
  }
  if (normalized.split('/').some(segment => segment === '..')) {
    malformed(`entry "${name}" traverses outside the archive`)
  }
}

/**
 * Extract one admitted entry with a bounded, declared-size-honest read.
 * @throws {SpatialError} `INVALID_ARGUMENT` for unsupported or lying entries,
 *   `RESOURCE_TOO_LARGE` when inflation exceeds the decompression budget.
 */
function extractEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (entry.localOffset + 30 > bytes.byteLength || view.getUint32(entry.localOffset, true) !== LOCAL_SIG) {
    malformed(`local header of "${entry.name}"`)
  }
  const nameLength = view.getUint16(entry.localOffset + 26, true)
  const extraLength = view.getUint16(entry.localOffset + 28, true)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > bytes.byteLength) malformed(`data of "${entry.name}"`)
  const raw = bytes.subarray(dataStart, dataEnd)
  if (entry.method === 0) {
    if (raw.length !== entry.uncompressedSize) malformed(`declared size of "${entry.name}"`)
    return raw
  }
  if (entry.method === 8) {
    let inflated: Buffer
    try {
      // `maxOutput` bounds inflation at runtime; the installed type stubs lag
      // behind the Node runtime option.
      inflated = inflateRawSync(raw, { maxOutput: MAX_ZIP_DECOMPRESSED_BYTES + 1 } as { maxOutput: number } & import('node:zlib').ZlibOptions)
    } catch {
      malformed(`deflate stream of "${entry.name}"`)
    }
    if (inflated.length > MAX_ZIP_DECOMPRESSED_BYTES) {
      throw new SpatialError('RESOURCE_TOO_LARGE', `shapefile ZIP decompression exceeds the ${MAX_ZIP_DECOMPRESSED_BYTES} byte limit`)
    }
    if (inflated.length !== entry.uncompressedSize) malformed(`declared size of "${entry.name}"`)
    return inflated
  }
  malformed(`compression method ${entry.method} of "${entry.name}"`)
}

/** Locate the .shp/.shx/.dbf set and optional .prj/.cpg inside the entries. */
function componentsOf(entries: readonly ZipEntry[]): {
  shp: ZipEntry
  shx: ZipEntry
  dbf: ZipEntry
  prj: ZipEntry | undefined
  cpg: ZipEntry | undefined
  ignored: number
} {
  const byExtension = new Map<string, ZipEntry[]>()
  for (const entry of entries) {
    assertSafeEntryName(entry.name)
    const dot = entry.name.lastIndexOf('.')
    const extension = dot === -1 ? '' : entry.name.slice(dot + 1).toLowerCase()
    const list = byExtension.get(extension) ?? []
    list.push(entry)
    byExtension.set(extension, list)
  }
  const baseOf = (entry: ZipEntry): string => {
    const slash = entry.name.lastIndexOf('/')
    const leaf = slash === -1 ? entry.name : entry.name.slice(slash + 1)
    const dot = leaf.lastIndexOf('.')
    return dot === -1 ? leaf : leaf.slice(0, dot)
  }
  const shapeEntries = byExtension.get('shp') ?? []
  const indexEntries = byExtension.get('shx') ?? []
  const dbfEntries = byExtension.get('dbf') ?? []
  const shapeBase = baseOf(shapeEntries[0] ?? { name: '' } as ZipEntry)
  const matching = (list: readonly ZipEntry[]): ZipEntry | undefined =>
    list.find(entry => baseOf(entry) === shapeBase)
  const shp = matching(shapeEntries)
  const shx = matching(indexEntries)
  const dbf = matching(dbfEntries)
  if (shp === undefined || shx === undefined || dbf === undefined || shapeEntries.length !== 1 || indexEntries.filter(entry => baseOf(entry) === shapeBase).length !== 1 || dbfEntries.filter(entry => baseOf(entry) === shapeBase).length !== 1) {
    throw new SpatialError('IMPORT_FORMAT_INVALID', 'shapefile ZIP must carry exactly one matching .shp/.shx/.dbf set')
  }
  const prj = matching(byExtension.get('prj') ?? [])
  const cpg = matching(byExtension.get('cpg') ?? [])
  const known = new Set([shp.name, shx.name, dbf.name, prj?.name, cpg?.name])
  const ignored = entries.filter(entry => !known.has(entry.name)).length
  return { shp, shx, dbf, prj, cpg, ignored }
}

/** Resolve the DBF text encoding: `.cpg` label, LDID byte, or UTF-8 attempt. */
function dbfEncodingOf(dbf: Uint8Array, cpgLabel: string | undefined): string {
  if (cpgLabel !== undefined) {
    const trimmed = cpgLabel.trim()
    try {
      new TextDecoder(trimmed)
    } catch {
      throw new SpatialError('IMPORT_ENCODING_INVALID', `shapefile .cpg declares unsupported encoding "${trimmed}"`)
    }
    return trimmed.toLowerCase()
  }
  const ldid = dbf[29] ?? 0
  const label = LDID_TABLE[ldid]
  if (label !== undefined) return label
  if (ldid !== 0) {
    throw new SpatialError('IMPORT_ENCODING_INVALID', `DBF language driver id 0x${ldid.toString(16).padStart(2, '0')} has no known encoding; supply a .cpg`)
  }
  return 'utf-8'
}

/** Reject memo fields and undecodable DBF text under the chosen encoding. */
function admitDbf(dbf: Uint8Array, encoding: string): void {
  const view = new DataView(dbf.buffer, dbf.byteOffset, dbf.byteLength)
  if (dbf.byteLength < 32) malformed('DBF header')
  const headerLength = view.getUint16(8, true)
  for (let offset = 32; offset + 32 <= Math.min(headerLength, dbf.byteLength); offset += 32) {
    if (view.getUint8(offset) === 0x0D) break
    if (dbf[offset + 11] === 0x4D /* 'M' */) {
      throw new SpatialError('IMPORT_FORMAT_INVALID', 'DBF memo fields are not supported; export attribute columns instead')
    }
  }
  // Only the text-bearing regions must decode: the binary header fields
  // (lengths, counts) legally hold non-UTF-8 bytes. Field names live in the
  // descriptor rows; values live after the header.
  const decoder = new TextDecoder(encoding, { fatal: true })
  try {
    for (let offset = 32; offset + 32 <= Math.min(headerLength, dbf.byteLength); offset += 32) {
      if (view.getUint8(offset) === 0x0D) break
      decoder.decode(dbf.subarray(offset, offset + 11))
    }
    decoder.decode(dbf.subarray(Math.min(headerLength, dbf.byteLength)))
  } catch {
    throw new SpatialError('IMPORT_ENCODING_INVALID', `DBF content cannot be decoded as ${encoding}; supply a .cpg declaring the correct encoding`)
  }
}

/** Summarize one WKT string and its proj4 constructibility. */
function prjConclusionOf(wkt: string): PrjConclusion {
  const name = /(?:PROJCS|GEOGCS|LOCAL_CS)\["([^"]{1,64})"/.exec(wkt)?.[1] ?? wkt.trim().slice(0, 48)
  let constructible = false
  try {
    proj4(wkt)
    constructible = true
  } catch {
    constructible = false
  }
  return { wktSummary: name, proj4Constructible: constructible }
}

/** Whether a WKT names a geographic WGS84 datum (identity, never reprojected). */
function isGeographicWgs84Wkt(wkt: string): boolean {
  return /GEOGCS/i.test(wkt) && /(WGS[ _-]?84|WGS_1984)/i.test(wkt)
}

/** Strip the parser-added `bbox` member so canonical geometries stay minimal. */
function stripBbox(geometry: unknown): unknown {
  if (geometry === null || typeof geometry !== 'object' || !('type' in geometry)) return geometry
  const { bbox: _bbox, ...rest } = geometry as Record<string, unknown>
  return rest
}

/** Assemble the shapefile admission record. */
function admissionOf(parts: {
  encoding: string
  nativeCrs: string
  sourceDigest: string
  prjConclusion: PrjConclusion | null
  crsCandidates: readonly CrsCandidate[] | null
  warnings: readonly string[]
  /** Fingerprint over the DERIVED candidate identity (stable across calls). */
  fingerprint: string
}): ImportAdmission {
  return {
    format: 'shapefile',
    formatCandidates: null,
    encoding: parts.encoding,
    nativeCrs: parts.nativeCrs,
    sourceDigest: parts.sourceDigest,
    columnMapping: null,
    columnCandidates: null,
    prjConclusion: parts.prjConclusion,
    crsCandidates: parts.crsCandidates,
    warnings: parts.warnings,
    candidatesFingerprint: parts.fingerprint,
  }
}

/**
 * Parse one shapefile ZIP import into its admission outcome.
 * @param request - raw ZIP bytes plus an optional explicit CRS decision.
 * @returns `needs_confirmation` when the CRS is missing or unconstructible
 *   (carrying candidates and a content-bound fingerprint), or `ready` with
 *   the canonical WGS84 collection — native coordinates when the source is
 *   WGS84, transformed exactly once otherwise.
 * @throws {SpatialError} with a stable code, never a host path, for
 *   container, component, encoding, structure, range, and budget failures.
 */
export function parseShapefileImport(request: ShapefileImportRequest): ImportOutcome {
  const sourceDigest = sourceDigestOf(request.bytes)
  const entries = readZipEntries(request.bytes)
  const totalUncompressed = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
  if (totalUncompressed > MAX_ZIP_DECOMPRESSED_BYTES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `shapefile ZIP declares ${totalUncompressed} decompressed bytes, above the ${MAX_ZIP_DECOMPRESSED_BYTES} limit`)
  }
  const { shp, shx, dbf: dbfEntry, prj: prjEntry, cpg: cpgEntry, ignored } = componentsOf(entries)
  const shpBytes = extractEntry(request.bytes, shp)
  const shxBytes = extractEntry(request.bytes, shx)
  const dbfBytes = extractEntry(request.bytes, dbfEntry)
  const prjWkt = prjEntry === undefined ? undefined : Buffer.from(extractEntry(request.bytes, prjEntry)).toString('utf8').trim()
  const cpgLabel = cpgEntry === undefined ? undefined : Buffer.from(extractEntry(request.bytes, cpgEntry)).toString('utf8')
  const encoding = dbfEncodingOf(dbfBytes, cpgLabel)
  admitDbf(dbfBytes, encoding)
  const warnings: string[] = []
  if (ignored > 0) warnings.push(`ignored-zip-entries:${ignored}`)

  const shpRecords = validateShpStructure(shpBytes)
  validateShxStructure(shxBytes, shpRecords)
  if (shpRecords > MAX_IMPORT_FEATURES) {
    throw new SpatialError('RESOURCE_TOO_LARGE', `shapefile exceeds the ${MAX_IMPORT_FEATURES} feature limit`)
  }
  let geometries: Array<{ type: string; coordinates?: unknown }>
  try {
    geometries = parseShp(shpBytes) as Array<{ type: string; coordinates?: unknown }>
  } catch {
    throw new SpatialError('IMPORT_FORMAT_INVALID', 'shapefile .shp content is malformed')
  }
  if (geometries.length !== shpRecords) {
    malformed('record count disagrees with the parsed geometry count')
  }
  let rows: Array<Record<string, unknown>>
  try {
    rows = parseShpRows(dbfBytes, encoding)
  } catch {
    throw new SpatialError('IMPORT_FORMAT_INVALID', 'shapefile .dbf content is malformed')
  }
  if (rows.length !== geometries.length) {
    warnings.push(`row-count-mismatch:shp=${geometries.length},dbf=${rows.length}`)
  }

  const prjConclusion = prjWkt === undefined ? null : prjConclusionOf(prjWkt)
  // The confirmation identity is what the file itself derives — the CRS
  // candidates an unconfirmed call would see — so the fingerprint stays
  // stable across the confirmation round trip regardless of the caller's
  // resolution parameters.
  const derivedCandidates: CrsCandidate[] = []
  if (prjConclusion !== null && !prjConclusion.proj4Constructible) {
    derivedCandidates.push({ crs: prjConclusion.wktSummary, reasons: ['prj-present-but-unconstructible'] })
  }
  derivedCandidates.push({ crs: 'EPSG:4326', reasons: ['assume-geographic-wgs84'] })
  const derivedNativeCrs = prjConclusion?.proj4Constructible === true ? prjConclusion.wktSummary : 'unconfirmed'
  const fingerprint = importFingerprintOf({
    format: 'shapefile',
    sourceDigest,
    encoding,
    nativeCrs: derivedNativeCrs,
    candidates: { prjConclusion, crsCandidates: derivedCandidates },
  })
  let crs: string | undefined
  if (request.crs !== undefined) {
    assertCrsSupported(request.crs)
    crs = request.crs
    if (prjConclusion !== null && prjConclusion.proj4Constructible) warnings.push('prj-overridden-by-explicit-crs')
  } else if (prjConclusion?.proj4Constructible === true) {
    crs = prjWkt
  }
  if (crs === undefined) {
    return {
      kind: 'needs_confirmation',
      admission: admissionOf({
        encoding,
        nativeCrs: 'unconfirmed',
        sourceDigest,
        prjConclusion,
        crsCandidates: derivedCandidates,
        warnings,
        fingerprint,
      }),
    }
  }
  const isWgs84 = isWgs84FamilyDeclaration(request.crs, prjWkt)
  const features = geometries.map((geometry, index) => ({
    type: 'Feature',
    geometry: isWgs84
      ? stripBbox(geometry)
      : toWgs84(geometry as { type: string; coordinates?: unknown }, crs),
    properties: rows[index] ?? {},
  }))
  const geojson = loadGeoJsonString(Buffer.from(JSON.stringify({ type: 'FeatureCollection', features }), 'utf8'), 'EPSG:4326')
  return {
    kind: 'ready',
    geojson,
    admission: admissionOf({
      encoding,
      nativeCrs: request.crs ?? prjConclusion?.wktSummary ?? 'EPSG:4326',
      sourceDigest,
      prjConclusion,
      crsCandidates: null,
      warnings,
      fingerprint,
    }),
  }
}

/** Whether the resolved CRS needs no reprojection (explicit WGS84-family or WGS84 WKT). */
function isWgs84FamilyDeclaration(explicitCrs: string | undefined, prjWkt: string | undefined): boolean {
  if (explicitCrs !== undefined) {
    const trimmed = explicitCrs.trim().toUpperCase()
    return trimmed === 'EPSG:4326' || trimmed === 'EPSG:4490' || trimmed === 'EPSG:4269' || trimmed.startsWith('+PROJ=LONLAT')
  }
  return prjWkt !== undefined && isGeographicWgs84Wkt(prjWkt)
}

/** Parse DBF rows under the chosen encoding, isolating parser failures. */
function parseShpRows(dbfBytes: Uint8Array, encoding: string): Array<Record<string, unknown>> {
  return parseDbf(dbfBytes, encoding) as Array<Record<string, unknown>>
}
