/**
 * The immutable chunked object provider: a GeoParquet-style row-group store
 * over a controlled local directory. One ingest copies one registered
 * resource's features into an immutable, content-addressed version — chunks
 * of fixed row counts with a per-chunk sha256 digest, byte length, and bbox,
 * committed by writing the manifest last — and every later read resolves
 * against that manifest, never against the mutable source.
 *
 * The read family is deliberately bounded: a `range` read verifies a
 * consecutive chunk window and hands back a resume cursor (the next chunk
 * index), a `tile` read prunes whole chunks by their bbox before touching
 * bytes, and a `query` scan folds a predicate across the version while
 * capping the sampled rows. Every read checks the authorization domain,
 * verifies chunk digests after reading, and refuses oversized requests with
 * a stable code instead of truncating silently.
 *
 * @module @map-harness/spatial-scale/store
 */
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_INGEST_ROWS,
  SCALE_METHOD_VERSION,
  manifestDigestOf,
  parseScaleRef,
  renderScaleIssues,
  scaleRefOf,
  validateScaleRead,
  type ScaleAggregate,
  type ScaleBudgets,
  type ScaleChunkEntry,
  type ScaleField,
  type ScaleReadRequest,
  type ScaleResourceManifest,
  type ScaleSchema,
  type ScaleWorkload,
} from './contract.ts'

/** Why one store operation refused. */
export type ScaleStoreCode =
  | 'SCALE_INVALID_INPUT'
  | 'SCALE_INVALID_REF'
  | 'SCALE_NOT_FOUND'
  | 'SCALE_FORBIDDEN'
  | 'SCALE_TOO_LARGE'
  | 'SCALE_CONFLICT'
  | 'SCALE_REF_CONFLICT'
  | 'SCALE_IO'

/** One store construction or read failure with a stable code. */
export class ScaleStoreError extends Error {
  /** Machine-readable refusal code. */
  readonly code: ScaleStoreCode
  constructor(code: ScaleStoreCode, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}

/** One row as stored: the feature index, the original geometry, and the original properties. */
interface StoredRow {
  readonly i: number
  readonly g: unknown
  readonly p: Record<string, unknown>
}

/** One ingest request: the registered resource's admitted features plus the metadata the manifest pins. */
export interface ScaleIngestInput {
  readonly resourceId: string
  /** The registered catalog resource ref (`res-…@vN`) the features were copied from. */
  readonly sourceRef: string
  /** The source content digest the manifest records for traceability. */
  readonly sourceDigest: string
  readonly nativeCrs: string
  /** The authorization domain reads must present. */
  readonly authorization: string
  readonly chunkRows: number
  /** Property declaring each feature's ISO event time; the manifest records its observed range. */
  readonly timeField?: string
  /** The admitted GeoJSON features (Point/LineString/Polygon and Multi* alike are stored; display stays elsewhere). */
  readonly features: readonly unknown[]
}

/** One ingest result: the immutable version identity and its manifest digest. */
export interface ScaleIngestResult {
  readonly ref: string
  readonly contentDigest: string
  readonly manifestDigest: string
  readonly manifest: ScaleResourceManifest
  /** True when an identical version already existed and was returned as-is (ingest is idempotent). */
  readonly deduplicated: boolean
}

/** The row sample one bounded read returns, coordinates and values exchange-rounded. */
export interface ScaleSampleRow {
  readonly index: number
  readonly lon: number | null
  readonly lat: number | null
  readonly value: number | null
}

/** One verified range read over a consecutive chunk window. */
export interface ScaleRangeResult {
  readonly kind: 'range'
  readonly chunks: readonly ScaleChunkEntry[]
  readonly rowsScanned: number
  readonly bytesScanned: number
  readonly sample: readonly ScaleSampleRow[]
  /** The resume cursor: the next unread chunk index. */
  readonly nextChunk: number
  readonly exhausted: boolean
}

/** One tile read over the version's extent grid. */
export interface ScaleTileResult {
  readonly kind: 'tile'
  readonly z: number
  readonly x: number
  readonly y: number
  /** The tile's WGS84 bbox: `[west, south, east, north]`. */
  readonly bbox: readonly [number, number, number, number]
  /** Chunks fully read (digest-verified) for this tile; bbox-pruned chunks are not read. */
  readonly chunksRead: number
  readonly chunksPruned: number
  readonly rowsScanned: number
  readonly matches: number
  readonly sample: readonly ScaleSampleRow[]
  readonly truncated: boolean
}

/** One query scan across the version's chunks. */
export interface ScaleQueryResult {
  readonly kind: 'query'
  readonly field: string
  readonly op: string
  readonly value: number
  readonly chunksRead: number
  readonly rowsScanned: number
  readonly matches: number
  readonly aggregate: ScaleAggregate
  readonly sample: readonly ScaleSampleRow[]
  readonly truncated: boolean
}

/** Any bounded read result. */
export type ScaleReadResult = ScaleRangeResult | ScaleTileResult | ScaleQueryResult

/** The open store handle. */
export interface ScaleObjectStore {
  readonly root: string
  /** Stage, verify, and commit one immutable version (idempotent per content digest). */
  ingest(input: ScaleIngestInput): ScaleIngestResult
  /** Resolve one exact version ref against its manifest after authorization. */
  readVersion(ref: string, authorization: string): { manifest: ScaleResourceManifest; manifestDigest: string; dir: string }
  /** One bounded read (range/tile/query) against one exact version, under explicit budgets. */
  read(ref: string, read: ScaleReadRequest, authorization: string, budgets: ScaleBudgets): ScaleReadResult
  /** The absolute path of one chunk file (the worker job request consumes paths). */
  chunkPath(dir: string, index: number): string
}

/**
 * Open (creating when absent) one scale object store root.
 * @param root - the store root directory (created when absent).
 * @returns the store handle.
 * @throws {ScaleStoreError} `SCALE_IO` when the root cannot be created.
 */
export function openScaleStore(root: string): ScaleObjectStore {
  try {
    mkdirSync(join(root, 'versions'), { recursive: true })
    mkdirSync(join(root, 'staging'), { recursive: true })
  } catch (error: unknown) {
    throw new ScaleStoreError('SCALE_IO', `scale store root "${root}" could not be created: ${String(error)}`)
  }
  return {
    root,
    ingest: input => ingestInto(root, input),
    readVersion: (ref, authorization) => readVersionAt(root, ref, authorization),
    read: (ref, read, authorization, budgets) => readAt(root, ref, read, authorization, budgets),
    chunkPath: (dir, index) => join(dir, 'chunks', `${index}.ndjson`),
  }
}

// -- ingest ------------------------------------------------------------------

/** Filename-safe short digest form a version directory carries. */
function digestDir(contentDigest: string): string {
  return contentDigest.slice(0, 12)
}

/** Stage, verify, and commit one immutable version. */
function ingestInto(root: string, input: ScaleIngestInput): ScaleIngestResult {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.resourceId)) {
    throw new ScaleStoreError('SCALE_INVALID_INPUT', `resourceId "${input.resourceId}" must match [a-z0-9][a-z0-9-]{0,63}`)
  }
  if (typeof input.sourceRef !== 'string' || input.sourceRef.length === 0) {
    throw new ScaleStoreError('SCALE_INVALID_INPUT', 'sourceRef is required')
  }
  if (typeof input.sourceDigest !== 'string' || input.sourceDigest.length !== 64) {
    throw new ScaleStoreError('SCALE_INVALID_INPUT', 'sourceDigest must be a sha256 hex digest')
  }
  if (typeof input.authorization !== 'string' || input.authorization.length === 0) {
    throw new ScaleStoreError('SCALE_INVALID_INPUT', 'authorization domain is required')
  }
  if (!Number.isInteger(input.chunkRows) || input.chunkRows < 1 || input.chunkRows > 65_536) {
    throw new ScaleStoreError('SCALE_INVALID_INPUT', `chunkRows must be an integer in [1, 65536]`)
  }
  if (input.features.length > MAX_INGEST_ROWS) {
    throw new ScaleStoreError('SCALE_TOO_LARGE', `an ingest carries at most ${MAX_INGEST_ROWS} rows, got ${input.features.length}`)
  }

  const rows = input.features.map((feature, index) => rowOf(feature, index))
  const schema = schemaOf(rows)
  const timeRange = timeRangeOf(rows, input.timeField)

  // Stage: write every chunk privately, digesting the exact bytes.
  const staged = mkdtempSync(join(root, 'staging', 'ingest-'))
  try {
    const chunks: ScaleChunkEntry[] = []
    const contentHash = createHash('sha256')
    let totalBytes = 0
    for (let start = 0; start < rows.length; start += input.chunkRows) {
      const slice = rows.slice(start, start + input.chunkRows)
      const body = slice.map(row => JSON.stringify(row)).join('\n') + '\n'
      const bytes = Buffer.from(body, 'utf8')
      contentHash.update(bytes)
      const file = join(staged, `${chunks.length}.ndjson`)
      writeFileSync(file, bytes, { mode: 0o600 })
      chunks.push({
        index: chunks.length,
        rows: slice.length,
        bytes: bytes.byteLength,
        digest: createHash('sha256').update(bytes).digest('hex'),
        bbox: bboxOfRows(slice),
      })
      totalBytes += bytes.byteLength
    }
    if (chunks.length === 0) {
      throw new ScaleStoreError('SCALE_INVALID_INPUT', 'an ingest carries at least one feature')
    }
    const contentDigest = contentHash.digest('hex')
    const manifest: ScaleResourceManifest = {
      methodVersion: SCALE_METHOD_VERSION,
      resourceId: input.resourceId,
      sourceRef: input.sourceRef,
      sourceDigest: input.sourceDigest,
      contentDigest,
      nativeCrs: input.nativeCrs,
      schema,
      timeRange,
      authorization: input.authorization,
      chunkRows: input.chunkRows,
      chunks,
      totalBytes,
      ingestedAt: new Date().toISOString(),
    }
    const versionDir = join(root, 'versions', input.resourceId, digestDir(contentDigest))
    const existingManifest = readManifestAt(versionDir)
    if (existingManifest !== null) {
      // The version already exists: ingest is idempotent. A manifest whose
      // stored content digest disagrees with the computed one is corruption,
      // not a match.
      if (existingManifest.contentDigest !== contentDigest) {
        throw new ScaleStoreError('SCALE_CONFLICT', `version directory "${digestDir(contentDigest)}" carries a different content digest`)
      }
      rmSync(staged, { recursive: true, force: true })
      return { ref: scaleRefOf(input.resourceId, contentDigest), contentDigest, manifestDigest: manifestDigestOf(existingManifest), manifest: existingManifest, deduplicated: true }
    }
    // Commit: chunks first, manifest last — the manifest is the single
    // commit point, so a version directory without one is an unfinished
    // stage that no read can resolve.
    mkdirSync(join(versionDir, 'chunks'), { recursive: true })
    for (const chunk of chunks) {
      renameSync(join(staged, `${chunk.index}.ndjson`), join(versionDir, 'chunks', `${chunk.index}.ndjson`))
    }
    const stagedManifest = join(staged, 'manifest.json')
    writeFileSync(stagedManifest, JSON.stringify(manifest), { mode: 0o600 })
    renameSync(stagedManifest, join(versionDir, 'manifest.json'))
    rmSync(staged, { recursive: true, force: true })
    return { ref: scaleRefOf(input.resourceId, contentDigest), contentDigest, manifestDigest: manifestDigestOf(manifest), manifest, deduplicated: false }
  } catch (error: unknown) {
    // Any failed stage leaves no version behind and no staging residue.
    rmSync(staged, { recursive: true, force: true })
    throw error
  }
}

/** Normalize one feature into the stored row form, refusing non-object features. */
function rowOf(feature: unknown, index: number): StoredRow {
  if (typeof feature !== 'object' || feature === null) {
    throw new ScaleStoreError('SCALE_INVALID_INPUT', `feature ${index} is not an object`)
  }
  const record = feature as { geometry?: unknown; properties?: unknown }
  if (record.properties !== undefined && (typeof record.properties !== 'object' || record.properties === null || Array.isArray(record.properties))) {
    throw new ScaleStoreError('SCALE_INVALID_INPUT', `feature ${index} carries non-object properties`)
  }
  return { i: index, g: record.geometry ?? null, p: (record.properties ?? {}) as Record<string, unknown> }
}

/** Infer the stored schema from the rows' observed property types and geometries. */
function schemaOf(rows: readonly StoredRow[]): ScaleSchema {
  const types = new Map<string, ScaleField['type']>()
  const geometryTypes = new Set<string>()
  const rank: ScaleField['type'][] = ['unknown', 'boolean', 'string', 'number']
  for (const row of rows) {
    for (const [name, value] of Object.entries(row.p)) {
      const observed: ScaleField['type'] = typeof value === 'number' ? 'number'
        : typeof value === 'string' ? 'string'
        : typeof value === 'boolean' ? 'boolean'
        : 'unknown'
      const existing = types.get(name)
      // A column observed at mixed types widens toward the less specific type.
      if (existing === undefined || rank.indexOf(observed) > rank.indexOf(existing)) types.set(name, observed)
    }
    const geometry = row.g as { type?: unknown } | null
    if (typeof geometry?.type === 'string') geometryTypes.add(geometry.type)
  }
  return {
    fields: [...types.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, type]) => ({ name, type })),
    geometryTypes: [...geometryTypes].sort(),
    featureCount: rows.length,
  }
}

/** Observe the declared time field's ISO range, refusing rows that carry none. */
function timeRangeOf(rows: readonly StoredRow[], timeField: string | undefined): { from: string; to: string } | null {
  if (timeField === undefined) return null
  let from: string | null = null
  let to: string | null = null
  for (const row of rows) {
    const value = row.p[timeField]
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw new ScaleStoreError('SCALE_INVALID_INPUT', `time field "${timeField}" must carry an ISO time string on every row (row ${row.i} does not)`)
    }
    if (from === null || value < from) from = value
    if (to === null || value > to) to = value
  }
  return from === null || to === null ? null : { from, to }
}

/** The bbox over one chunk's stored coordinates, or `null` when none are numeric. */
function bboxOfRows(rows: readonly StoredRow[]): [number, number, number, number] | null {
  let minLon = Number.POSITIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLon = Number.NEGATIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  const walk = (coords: unknown): void => {
    if (!Array.isArray(coords)) return
    const lon = coords[0]
    const lat = coords[1]
    if (coords.length >= 2 && typeof lon === 'number' && typeof lat === 'number') {
      if (lon < minLon) minLon = lon
      if (lat < minLat) minLat = lat
      if (lon > maxLon) maxLon = lon
      if (lat > maxLat) maxLat = lat
      return
    }
    coords.forEach(walk)
  }
  for (const row of rows) walk((row.g as { coordinates?: unknown } | null)?.coordinates)
  if (minLon === Number.POSITIVE_INFINITY) return null
  return [minLon, minLat, maxLon, maxLat]
}

// -- reads -------------------------------------------------------------------

/** Read and parse one version manifest, or `null` when the version directory has not committed. */
function readManifestAt(versionDir: string): ScaleResourceManifest | null {
  let raw: string
  try {
    raw = readFileSync(join(versionDir, 'manifest.json'), 'utf8')
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error: unknown) {
    throw new ScaleStoreError('SCALE_IO', `manifest is not readable JSON: ${String(error)}`)
  }
  const manifest = parsed as ScaleResourceManifest
  if (manifest.methodVersion !== SCALE_METHOD_VERSION || !Array.isArray(manifest.chunks)) {
    throw new ScaleStoreError('SCALE_IO', 'manifest carries an unknown method version or chunk index')
  }
  return manifest
}

/** Resolve one exact ref into its committed manifest, naming every refusal. */
function readVersionAt(root: string, ref: string, authorization: string): { manifest: ScaleResourceManifest; manifestDigest: string; dir: string } {
  const parsed = parseScaleRef(ref)
  if (parsed === null) {
    throw new ScaleStoreError('SCALE_INVALID_REF', `"${ref}" is not a scale version ref (scl-<id>@<digest12>)`)
  }
  if (typeof authorization !== 'string' || authorization.length === 0) {
    throw new ScaleStoreError('SCALE_FORBIDDEN', 'an authorization domain is required')
  }
  const dir = join(root, 'versions', parsed.resourceId, parsed.digestPrefix)
  const manifest = readManifestAt(dir)
  if (manifest === null) {
    throw new ScaleStoreError('SCALE_NOT_FOUND', `scale version "${ref}" is not committed`)
  }
  if (manifest.authorization !== authorization) {
    throw new ScaleStoreError('SCALE_FORBIDDEN', `scale version "${ref}" is not readable in the "${authorization}" domain`)
  }
  if (!manifest.contentDigest.startsWith(parsed.digestPrefix)) {
    throw new ScaleStoreError('SCALE_REF_CONFLICT', `ref digest prefix "${parsed.digestPrefix}" does not match the stored version`)
  }
  return { manifest, manifestDigest: manifestDigestOf(manifest), dir }
}

/** Verify one chunk file against its manifest entry and return its exact bytes. */
function readVerifiedChunk(dir: string, entry: ScaleChunkEntry): Buffer {
  let bytes: Buffer
  try {
    bytes = readFileSync(join(dir, 'chunks', `${entry.index}.ndjson`))
  } catch (error: unknown) {
    throw new ScaleStoreError('SCALE_IO', `chunk ${entry.index} could not be read: ${String(error)}`)
  }
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== entry.digest || bytes.byteLength !== entry.bytes) {
    throw new ScaleStoreError('SCALE_IO', `chunk ${entry.index} failed its digest check (stored ${entry.digest}, read ${digest})`)
  }
  return bytes
}

/** Parse one chunk's stored rows. */
function parseChunkRows(bytes: Buffer): StoredRow[] {
  const rows: StoredRow[] = []
  for (const line of bytes.toString('utf8').split('\n')) {
    if (line.length === 0) continue
    rows.push(JSON.parse(line) as StoredRow)
  }
  return rows
}

/** Project one stored row into the exchange sample form. */
function sampleOf(row: StoredRow): ScaleSampleRow {
  const [lon, lat] = firstPosition(row.g as { coordinates?: unknown } | null)
  const value = row.p.value
  return {
    index: row.i,
    lon: lon === null ? null : round6(lon),
    lat: lat === null ? null : round6(lat),
    value: typeof value === 'number' ? round6(value) : null,
  }
}

/** The first numeric coordinate pair of one geometry in depth-first order, or `[null, null]`. */
function firstPosition(geometry: { coordinates?: unknown } | null): [number | null, number | null] {
  const walk = (coords: unknown): [number, number] | null => {
    if (!Array.isArray(coords)) return null
    if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
      return [coords[0] as number, coords[1] as number]
    }
    for (const nested of coords) {
      const hit = walk(nested)
      if (hit !== null) return hit
    }
    return null
  }
  return walk(geometry?.coordinates) ?? [null, null]
}

/** Round to the shared six-decimal exchange precision. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Read one bounded range: a consecutive, digest-verified chunk window with a resume cursor. */
function readRange(dir: string, manifest: ScaleResourceManifest, read: { fromChunk: number; chunks: number }, budgets: ScaleBudgets): ScaleRangeResult {
  const last = Math.min(read.fromChunk + read.chunks, manifest.chunks.length)
  const window = manifest.chunks.slice(read.fromChunk, last)
  if (window.length === 0) {
    throw new ScaleStoreError('SCALE_INVALID_INPUT', `chunk window [${read.fromChunk}, ${last}) is outside the version's ${manifest.chunks.length} chunks`)
  }
  const windowBytes = window.reduce((total, chunk) => total + chunk.bytes, 0)
  const windowRows = window.reduce((total, chunk) => total + chunk.rows, 0)
  if (windowBytes > budgets.maxBytesPerRead) {
    throw new ScaleStoreError('SCALE_TOO_LARGE', `range window carries ${windowBytes} bytes, over the ${budgets.maxBytesPerRead}-byte read budget`)
  }
  if (windowRows > budgets.maxRowsPerRead) {
    throw new ScaleStoreError('SCALE_TOO_LARGE', `range window carries ${windowRows} rows, over the ${budgets.maxRowsPerRead}-row read budget`)
  }
  const sample: ScaleSampleRow[] = []
  let rowsScanned = 0
  let bytesScanned = 0
  for (const entry of window) {
    const bytes = readVerifiedChunk(dir, entry)
    bytesScanned += bytes.byteLength
    for (const row of parseChunkRows(bytes)) {
      rowsScanned += 1
      if (sample.length < budgets.maxRowsPerRead) sample.push(sampleOf(row))
    }
  }
  const nextChunk = read.fromChunk + window.length
  return {
    kind: 'range',
    chunks: window,
    rowsScanned,
    bytesScanned,
    sample,
    nextChunk,
    exhausted: nextChunk >= manifest.chunks.length,
  }
}

/** One axis-aligned WGS84 bbox: `[minLon, minLat, maxLon, maxLat]`. */
type ScaleBbox = readonly [number, number, number, number]

/** The WGS84 extent grid cell bbox: the grid spans the manifest bbox at 2^z × 2^z cells (y from south). */
function tileBboxOf(manifestBbox: ScaleBbox, z: number, x: number, y: number): ScaleBbox {
  const [minLon, minLat, maxLon, maxLat] = manifestBbox
  const cells = 2 ** z
  const lonStep = (maxLon - minLon) / cells
  const latStep = (maxLat - minLat) / cells
  return [
    minLon + x * lonStep,
    minLat + y * latStep,
    minLon + (x + 1) * lonStep,
    minLat + (y + 1) * latStep,
  ]
}

/** True when two bboxes intersect (closed intervals, edge contact included). */
function bboxIntersects(a: ScaleBbox, b: ScaleBbox): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]
}

/** True when one row's first coordinates fall inside the tile bbox. */
function rowInBbox(row: StoredRow, bbox: ScaleBbox): boolean {
  const [lon, lat] = firstPosition(row.g as { coordinates?: unknown } | null)
  return lon !== null && lat !== null
    && lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]
}

/** Read one extent-grid tile: prune whole chunks by bbox, verify and scan the survivors. */
function readTile(dir: string, manifest: ScaleResourceManifest, read: { z: number; x: number; y: number }, budgets: ScaleBudgets): ScaleTileResult {
  const manifestBbox = manifestBboxOf(manifest)
  if (manifestBbox === null) {
    throw new ScaleStoreError('SCALE_INVALID_INPUT', 'the version carries no griddable coordinates')
  }
  const cells = 2 ** read.z
  if (read.x >= cells || read.y >= cells) {
    throw new ScaleStoreError('SCALE_INVALID_INPUT', `tile ${read.z}/${read.x}/${read.y} is outside the ${cells}×${cells} extent grid`)
  }
  const tileBbox = tileBboxOf(manifestBbox, read.z, read.x, read.y)
  const survivors = manifest.chunks.filter(chunk => chunk.bbox === null || bboxIntersects(chunk.bbox, tileBbox))
  const sample: ScaleSampleRow[] = []
  let chunksRead = 0
  let rowsScanned = 0
  let matches = 0
  let truncated = false
  for (const entry of survivors) {
    const bytes = readVerifiedChunk(dir, entry)
    chunksRead += 1
    for (const row of parseChunkRows(bytes)) {
      rowsScanned += 1
      if (!rowInBbox(row, tileBbox)) continue
      matches += 1
      if (sample.length < budgets.maxRowsPerRead) sample.push(sampleOf(row))
      else truncated = true
    }
  }
  return {
    kind: 'tile',
    z: read.z,
    x: read.x,
    y: read.y,
    bbox: tileBbox.map(value => round6(value)) as [number, number, number, number],
    chunksRead,
    chunksPruned: manifest.chunks.length - survivors.length,
    rowsScanned,
    matches,
    sample,
    truncated,
  }
}

/** The manifest bbox over every chunk bbox, or `null` when none carry coordinates. */
function manifestBboxOf(manifest: ScaleResourceManifest): [number, number, number, number] | null {
  let bbox: [number, number, number, number] | null = null
  for (const chunk of manifest.chunks) {
    if (chunk.bbox === null) continue
    bbox = bbox === null
      ? [chunk.bbox[0], chunk.bbox[1], chunk.bbox[2], chunk.bbox[3]]
      : [Math.min(bbox[0], chunk.bbox[0]), Math.min(bbox[1], chunk.bbox[1]), Math.max(bbox[2], chunk.bbox[2]), Math.max(bbox[3], chunk.bbox[3])]
  }
  return bbox
}

/** Evaluate the plain comparison the query protocol defines. */
function compare(value: number, op: string, against: number): boolean {
  switch (op) {
    case '>': return value > against
    case '>=': return value >= against
    case '<': return value < against
    case '<=': return value <= against
    case '==': return value === against
    case '!=': return value !== against
    default: throw new ScaleStoreError('SCALE_INVALID_INPUT', `op "${op}" is not a scale comparison`)
  }
}

/** Scan one predicate across the version: digest-verified chunks, bounded sample, O(1) aggregate. */
function scanQuery(dir: string, manifest: ScaleResourceManifest, read: { field: string; op: string; value: number }, budgets: ScaleBudgets): ScaleQueryResult {
  const aggregate: { count: number; sum: number; min: number; max: number } = { count: 0, sum: 0, min: 0, max: 0 }
  const sample: ScaleSampleRow[] = []
  let chunksRead = 0
  let rowsScanned = 0
  let matches = 0
  let truncated = false
  for (const entry of manifest.chunks) {
    const bytes = readVerifiedChunk(dir, entry)
    chunksRead += 1
    for (const row of parseChunkRows(bytes)) {
      rowsScanned += 1
      const value = row.p[read.field]
      if (typeof value !== 'number' || !Number.isFinite(value) || !compare(value, read.op, read.value)) continue
      matches += 1
      aggregate.count += 1
      aggregate.sum += value
      aggregate.min = aggregate.count === 1 ? value : Math.min(aggregate.min, value)
      aggregate.max = aggregate.count === 1 ? value : Math.max(aggregate.max, value)
      if (sample.length < budgets.scanSampleRows) sample.push(sampleOf(row))
      else truncated = true
    }
  }
  return {
    kind: 'query',
    field: read.field,
    op: read.op,
    value: read.value,
    chunksRead,
    rowsScanned,
    matches,
    aggregate,
    sample,
    truncated,
  }
}

/** Dispatch one validated bounded read under the caller's explicit budgets. */
function readAt(root: string, ref: string, read: ScaleReadRequest, authorization: string, budgets: ScaleBudgets): ScaleReadResult {
  const issues = validateScaleRead(read)
  if (issues.length > 0) {
    throw new ScaleStoreError('SCALE_INVALID_INPUT', `read rejected: ${renderScaleIssues(issues)}`)
  }
  const { manifest, dir } = readVersionAt(root, ref, authorization)
  if (read.kind === 'range') return readRange(dir, manifest, read, budgets)
  if (read.kind === 'tile') return readTile(dir, manifest, read, budgets)
  return scanQuery(dir, manifest, read, budgets)
}

// -- deterministic workload generator -----------------------------------------

/** One mulberry32 PRNG step: the deterministic generator the fixture workload uses. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Generate the deterministic workload features: uniform points over the
 * workload's WGS84 span with the queried numeric field uniform in [0, 1).
 * Two calls with one workload produce byte-identical features.
 * @param workload - the validated workload.
 * @returns the GeoJSON Point features.
 */
export function workloadFeatures(workload: ScaleWorkload): readonly unknown[] {
  const random = mulberry32(workload.seed)
  const features: unknown[] = []
  for (let index = 0; index < workload.rows; index += 1) {
    const lon = -workload.lonSpan / 2 + random() * workload.lonSpan
    const lat = -workload.latSpan / 2 + random() * workload.latSpan
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(lon.toFixed(6)), Number(lat.toFixed(6))] },
      properties: {
        [workload.field]: Number((random() * 1).toFixed(6)),
        row_id: `row-${index}`,
      },
    })
  }
  return features
}

// -- worker request support ----------------------------------------------------

/**
 * Assemble the worker job's chunk descriptors for one full-version scan: the
 * absolute chunk paths, byte ranges, digests, and row counts the worker
 * process verifies before scanning.
 * @param store - the open store.
 * @param version - the resolved version (from `readVersion`).
 * @returns the chunk descriptors in scan order.
 */
export function jobChunksOf(store: ScaleObjectStore, version: { manifest: ScaleResourceManifest; dir: string }): { path: string; start: number; end: number; digest: string; rows: number }[] {
  return version.manifest.chunks.map(chunk => ({
    path: store.chunkPath(version.dir, chunk.index),
    start: 0,
    end: chunk.bytes,
    digest: chunk.digest,
    rows: chunk.rows,
  }))
}

/** Stat one staged file's size (the crash-recovery fixture checks staging residue). */
export function stagedSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return -1
  }
}

/** A fresh private staging directory under the given root (0700 by mkdtemp). */
export function newStagingDir(root: string, label: string): string {
  return mkdtempSync(join(root, `${label}-`))
}

/** Remove one staging directory tree (the job's temp-resource cleanup). */
export function removeStagingDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Random hex token for staging/job names. */
export function randomToken(bytes = 8): string {
  return randomBytes(bytes).toString('hex')
}
