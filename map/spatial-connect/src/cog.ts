/**
 * The COG connector: proves a declared Cloud-Optimized GeoTIFF URL
 * connectable through HTTP ranged access — the transport property COG
 * requires — plus a structural validation of the TIFF header and the first
 * image file directory (IFD0). At most three range requests are issued
 * (header, directory count, directory entries) and only inline tag values
 * are interpreted: no pixel data, no external tag payloads, no tile reads.
 * Nothing is downloaded or stored (the connection-capability contract).
 *
 * ## Range discipline
 *
 * - `Range: bytes=0-15` must answer `206`; a `200` means the server ignores
 *   ranged access — the COG channel does not exist at this URL
 *   (`unsupported-channel`), never a degraded pass.
 * - Classic TIFF (magic 42): 2-byte entry count, 12-byte entries; BigTIFF
 *   (magic 43): 8-byte count, 20-byte entries with 64-bit offsets. Both
 *   byte orders (`II`, `MM`) are accepted.
 * - A directory with more than {@link TIFF_MAX_IFD_ENTRIES} entries is
 *   `invalid-content`: connection capability never negotiates its read budget.
 * - Tiled layout (TileWidth/TileLength/TileOffsets present) is the COG
 *   capability verdict; a striped TIFF is reported as-is (`invalid-content`
 *   naming the striped layout), not fabricated into capability.
 *
 * ## Outcome mapping
 *
 * 206 + valid TIFF + tiled → `connected` with directory facts; 200 to a
 * range request → `unsupported-channel`; wrong magic → `invalid-content`
 * (`not a TIFF`); striped layout → `invalid-content`; 401/403 →
 * `auth-rejected`; 404/410 → `not-found`; transport/DNS/TLS failures →
 * `unreachable`; deadline → `timeout`; caller abort → `aborted`; framing
 * violations (directory past the fetched window, absurd offsets) →
 * `protocol-violated`.
 *
 * @module @map-harness/spatial-connect/cog
 */
import type { CogConnectionSpec, CogVerificationFacts, ConnectionVerification } from './contract.ts'
import { COG_MAX_DIRECTORY_BYTES, COG_MAX_RANGE_REQUESTS, DEFAULT_TIMEOUT_MS, TIFF_MAX_IFD_ENTRIES, bounded, defaultNowMs, sanitizeDetail } from './contract.ts'

/** Structural subset of `fetch` the connector needs; injectable for fixtures. */
export interface CogFetch {
  /** One request against the raster URL. */
  (url: string, init: { readonly method: string; readonly headers: Record<string, string>; readonly signal?: AbortSignal }): Promise<{
    readonly ok: boolean
    readonly status: number
    readonly headers: { get(name: string): string | null }
    arrayBuffer(): Promise<ArrayBuffer>
  }>
}

/** The credentials a verification holds in memory for the exchange only. */
export interface CogCredentials {
  /** The bearer token, when the deployment references one. */
  readonly token?: string
}

/** Extra verification options: deadlines, cancellation, clocks, transport. */
export interface CogVerifyOptions {
  /** Caller cancellation carried into every range request. */
  readonly signal?: AbortSignal
  /** Wall-clock deadline override for the whole exchange. */
  readonly timeoutMs?: number
  /** Monotonic clock for the latency report; defaults to `performance.now`. */
  readonly now?: () => number
  /** Transport seam; defaults to the global `fetch`. */
  readonly fetchImpl?: CogFetch
}

/** TIFF compression codes the report names; unknown codes report the number only. */
const COMPRESSION_NAMES: ReadonlyMap<number, string> = new Map([
  [1, 'none'], [5, 'lzw'], [6, 'jpeg-old'], [7, 'jpeg'], [8, 'deflate'], [32773, 'packbits'],
])

/** TIFF tag numbers the directory scan interprets. */
const TAG_IMAGE_WIDTH = 256
const TAG_IMAGE_LENGTH = 257
const TAG_BITS_PER_SAMPLE = 258
const TAG_COMPRESSION = 259
const TAG_SAMPLES_PER_PIXEL = 277
const TAG_TILE_WIDTH = 322
const TAG_TILE_LENGTH = 323
const TAG_TILE_OFFSETS = 324
const TAG_MODEL_PIXEL_SCALE = 33550
const TAG_MODEL_TIEPOINT = 33922
const TAG_GEO_KEY_DIRECTORY = 34735
const TAG_GDAL_METADATA = 42112

/** TIFF field types with inline-value sizes the scan understands. */
const FIELD_TYPE_SIZES: ReadonlyMap<number, number> = new Map([
  [1, 1], [2, 1], [3, 2], [4, 4], [5, 8], [6, 1], [7, 1], [8, 2], [9, 4], [10, 8], [11, 4], [12, 8], [16, 8], [17, 8], [18, 8],
])

/** One parsed IFD entry, inline value only. */
interface IfdEntry {
  readonly tag: number
  readonly fieldType: number
  readonly count: number
  readonly value: number
}

/** Read one unsigned integer of the given width at a byte offset, honoring byte order. */
function readUint(bytes: Uint8Array, offset: number, width: number, littleEndian: boolean): number {
  let value = 0
  for (let i = 0; i < width; i++) {
    const byte = bytes[offset + i]
    if (byte === undefined) throw new Error(`read past the fetched window at ${String(offset)}`)
    if (littleEndian) value += byte * 256 ** i
    else value = value * 256 + byte
  }
  return value
}

/** Parse one IFD (classic or BigTIFF) out of a fetched window; inline values only. */
function parseDirectory(bytes: Uint8Array, dirOffset: number, bigTiff: boolean, littleEndian: boolean): { entries: IfdEntry[]; bytesRead: number } {
  const countWidth = bigTiff ? 8 : 2
  const entrySize = bigTiff ? 20 : 12
  const count = readUint(bytes, dirOffset, countWidth, littleEndian)
  if (count > TIFF_MAX_IFD_ENTRIES) {
    throw new DirectoryTooLarge(count)
  }
  const entries: IfdEntry[] = []
  let cursor = dirOffset + countWidth
  for (let index = 0; index < count; index++) {
    const tag = readUint(bytes, cursor, 2, littleEndian)
    const fieldType = readUint(bytes, cursor + 2, 2, littleEndian)
    const countOfValues = bigTiff ? readUint(bytes, cursor + 4, 8, littleEndian) : readUint(bytes, cursor + 4, 4, littleEndian)
    const unitSize = FIELD_TYPE_SIZES.get(fieldType) ?? 0
    const byteLength = unitSize * countOfValues
    // The value is inline only when it fits the value slot (4 bytes classic, 8 BigTIFF).
    const slotWidth = bigTiff ? 8 : 4
    let value = Number.NaN
    if (byteLength > 0 && byteLength <= slotWidth && (fieldType === 1 || fieldType === 3 || fieldType === 4 || fieldType === 8 || fieldType === 9 || fieldType === 16 || fieldType === 17)) {
      const valueOffset = bigTiff ? cursor + 12 : cursor + 8
      value = readUint(bytes, valueOffset, Math.min(byteLength, slotWidth), littleEndian)
    }
    entries.push({ tag, fieldType, count: countOfValues, value })
    cursor += entrySize
  }
  return { entries, bytesRead: cursor - dirOffset }
}

/** Named refusal when a directory exceeds the entry budget. */
class DirectoryTooLarge extends Error {
  readonly count: number

  constructor(count: number) {
    super(`the image directory carries ${String(count)} entries, above the ${String(TIFF_MAX_IFD_ENTRIES)} budget`)
    this.name = 'DirectoryTooLarge'
    this.count = count
  }
}

/** Named framing violation (offsets past the fetched window, absurd sizes). */
class FramingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FramingError'
  }
}

/**
 * Verify one COG connection and produce the report.
 * @param spec - the validated connection specification.
 * @param credentials - the resolved bearer token, when the deployment references one.
 * @param options - deadline, cancellation, clock, and transport overrides.
 * @returns the verification report; server-side answers are results, never throws.
 */
export async function verifyCog(spec: CogConnectionSpec, credentials: CogCredentials = {}, options: CogVerifyOptions = {}): Promise<ConnectionVerification> {
  const now = options.now ?? defaultNowMs
  const startedAt = now()
  const doFetch: CogFetch = options.fetchImpl ?? (async (url, init) => await fetch(url, init as RequestInit))
  const deadline = AbortSignal.any([AbortSignal.timeout(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS), ...(options.signal === undefined ? [] : [options.signal])])
  let rangeRequests = 0
  const finish = (outcome: ConnectionVerification['outcome'], detail: string, facts?: CogVerificationFacts): ConnectionVerification => ({
    connectionId: spec.id,
    kind: 'cog',
    outcome,
    detail: sanitizeDetail(detail, [credentials.token]),
    latencyMs: Math.max(0, now() - startedAt),
    ...(facts === undefined ? {} : { facts }),
  })

  /** One bounded ranged GET; returns null when the server answers without 206. */
  async function rangedGet(start: number, endInclusive: number): Promise<{ status: number; bytes: Uint8Array; ok: boolean; headers: { get(name: string): string | null } }> {
    if (rangeRequests >= COG_MAX_RANGE_REQUESTS) {
      throw new FramingError(`the read budget of ${String(COG_MAX_RANGE_REQUESTS)} range requests is exhausted`)
    }
    rangeRequests++
    const headers: Record<string, string> = { range: `bytes=${String(start)}-${String(endInclusive)}` }
    if (credentials.token !== undefined) headers.authorization = `Bearer ${credentials.token}`
    const response = await doFetch(spec.url, { method: 'GET', headers, signal: deadline })
    const bytes = new Uint8Array(await response.arrayBuffer())
    // A 206 must carry exactly the asked window; a full-body answer is the
    // caller's unsupported-channel verdict, not a framing error.
    if (response.status === 206 && (bytes.length > endInclusive - start + 1 || bytes.length > COG_MAX_DIRECTORY_BYTES + 64)) {
      throw new FramingError(`a ranged request for ${String(endInclusive - start + 1)} bytes returned ${String(bytes.length)}; the server violates Range`)
    }
    return { status: response.status, bytes, ok: response.ok, headers: response.headers }
  }

  try {
    // --- Header: byte order + magic + first IFD offset ----------------------
    const header = await rangedGet(0, 15)
    if (header.status === 200) {
      return finish('unsupported-channel', 'the server answered a range request with a full-body 200; COG requires ranged access')
    }
    if (header.status === 401 || header.status === 403) {
      return finish('auth-rejected', `the server refused the range request with http ${String(header.status)}`)
    }
    if (header.status === 404 || header.status === 410) {
      return finish('not-found', `the server reports the raster absent (http ${String(header.status)})`)
    }
    if (header.status !== 206) {
      return finish('server-refused', `the server answered http ${String(header.status)} to the range request`)
    }
    const order = String.fromCharCode(header.bytes[0] ?? 0, header.bytes[1] ?? 0)
    if (order !== 'II' && order !== 'MM') {
      return finish('invalid-content', 'the payload does not start with a TIFF byte-order mark (II/MM)')
    }
    const littleEndian = order === 'II'
    const magic = readUint(header.bytes, 2, 2, littleEndian)
    if (magic !== 42 && magic !== 43) {
      return finish('invalid-content', `the payload magic ${String(magic)} is neither classic TIFF (42) nor BigTIFF (43)`)
    }
    const bigTiff = magic === 43
    if (bigTiff) {
      const offsetSize = readUint(header.bytes, 4, 2, littleEndian)
      const reserved = readUint(header.bytes, 6, 2, littleEndian)
      if (offsetSize !== 8 || reserved !== 0) {
        return finish('invalid-content', 'the BigTIFF header does not carry the 8-byte offset size with zero padding')
      }
    }
    const ifdOffset = bigTiff ? readUint(header.bytes, 8, 8, littleEndian) : readUint(header.bytes, 4, 4, littleEndian)

    // --- Directory: count, then entries, inside the read budget --------------
    const countWidth = bigTiff ? 8 : 2
    const countRead = await rangedGet(ifdOffset, ifdOffset + countWidth - 1)
    if (countRead.status !== 206) {
      return finish('server-refused', `the server answered http ${String(countRead.status)} to the directory-count range request`)
    }
    const count = readUint(countRead.bytes, 0, countWidth, littleEndian)
    if (count > TIFF_MAX_IFD_ENTRIES) {
      return finish('invalid-content', `the image directory carries ${String(count)} entries, above the ${String(TIFF_MAX_IFD_ENTRIES)} budget`)
    }
    const entrySize = bigTiff ? 20 : 12
    const entriesLength = countWidth + count * entrySize + (bigTiff ? 8 : 4)
    if (entriesLength > COG_MAX_DIRECTORY_BYTES) {
      return finish('invalid-content', `the image directory needs ${String(entriesLength)} bytes, above the ${String(COG_MAX_DIRECTORY_BYTES)}-byte read budget`)
    }
    const directoryRead = await rangedGet(ifdOffset, ifdOffset + entriesLength - 1)
    if (directoryRead.status !== 206) {
      return finish('server-refused', `the server answered http ${String(directoryRead.status)} to the directory range request`)
    }
    const { entries } = parseDirectory(directoryRead.bytes, 0, bigTiff, littleEndian)

    // --- Facts from inline values; presence-only for external payloads -------
    const entryOf = (tag: number): IfdEntry | undefined => entries.find(candidate => candidate.tag === tag)
    const inline = (tag: number): number | undefined => {
      const entry = entryOf(tag)
      if (entry === undefined || Number.isNaN(entry.value)) return undefined
      return entry.value
    }
    const compressionCode = inline(TAG_COMPRESSION) ?? 1
    const compressionName = COMPRESSION_NAMES.get(compressionCode)
    const width = inline(TAG_IMAGE_WIDTH)
    const height = inline(TAG_IMAGE_LENGTH)
    const bitsPerSample = inline(TAG_BITS_PER_SAMPLE)
    const samplesPerPixel = inline(TAG_SAMPLES_PER_PIXEL)
    const tileWidth = inline(TAG_TILE_WIDTH)
    const tileHeight = inline(TAG_TILE_LENGTH)
    const hasTileWidth = entryOf(TAG_TILE_WIDTH) !== undefined
    const hasTileLength = entryOf(TAG_TILE_LENGTH) !== undefined
    const tileOffsets = entryOf(TAG_TILE_OFFSETS)
    const tiled = hasTileWidth && hasTileLength && tileOffsets !== undefined
    if (!tiled) {
      return finish('invalid-content', 'the TIFF is striped (no tile layout); it is not COG-capable over this channel')
    }
    const facts: CogVerificationFacts = {
      bigTiff,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(bitsPerSample === undefined ? {} : { bitsPerSample }),
      ...(samplesPerPixel === undefined ? {} : { samplesPerPixel }),
      compression: { code: compressionCode, ...(compressionName === undefined ? {} : { name: compressionName }) },
      tiled,
      ...(tileWidth === undefined ? {} : { tileWidth }),
      ...(tileHeight === undefined ? {} : { tileHeight }),
      ...(tileOffsets === undefined ? {} : { tileCount: tileOffsets.count }),
      georeferenced: entryOf(TAG_MODEL_PIXEL_SCALE) !== undefined && entryOf(TAG_MODEL_TIEPOINT) !== undefined,
      hasGeoKeys: entryOf(TAG_GEO_KEY_DIRECTORY) !== undefined,
      hasGdalMetadata: entryOf(TAG_GDAL_METADATA) !== undefined,
    }
    return finish('connected', `ranged access proven; a ${bigTiff ? 'BigTIFF' : 'classic TIFF'} directory with ${String(entries.length)} entries validated`, facts)
  } catch (error: unknown) {
    return finish(...describeFailure(error, options.signal))
  }
}

/** Fold one caught failure onto outcome + detail; caller abort outranks the deadline. */
function describeFailure(error: unknown, signal: AbortSignal | undefined): [ConnectionVerification['outcome'], string] {
  if (signal?.aborted === true) return ['aborted', 'verification aborted by the caller']
  if (error instanceof DirectoryTooLarge) return ['invalid-content', bounded(error.message)]
  if (error instanceof FramingError) return ['protocol-violated', bounded(error.message)]
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return ['timeout', 'the verification deadline elapsed before the server answered']
    return ['unreachable', `transport failure (${error.name}): ${bounded(error.message)}`]
  }
  return ['unreachable', 'unknown transport failure']
}
