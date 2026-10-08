/**
 * The versioned `spatial-connect@1` contract: the three external connection
 * kinds (PostGIS, S3-compatible object store, COG over HTTP), their validated
 * connection specifications, the closed verification-outcome vocabulary, and
 * the read-budget invariant every connector honors. Connection capability
 * means a configured endpoint can be reached, authenticated, and proven to
 * speak its protocol through one bounded exchange that reads metadata only —
 * server version, bucket region, TIFF headers. No connector moves feature or
 * pixel bytes into this project's stores: external channels never hold
 * resident synchronized data (2026-10-07 deployment decision).
 *
 * Protocol constants (default ports, timeouts bounds, read budgets, entry
 * caps) are fixed here and never configurable: endpoints, credentials,
 * addressing, and TLS mode are the deployment-varying choices and live in the
 * plugin Config; the wire discipline is the contract.
 *
 * @module @map-harness/spatial-connect/contract
 */

/** Version identity of this contract; bump only on structural changes. */
export const SPATIAL_CONNECT_VERSION = 'spatial-connect@1'

/** The external connection kinds this plane can prove connectable. */
export type ConnectionKind = 'postgis' | 'object-storage' | 'cog'

/** The closed vocabulary of TLS modes for TCP-based connectors. */
export type TlsMode = 'disable' | 'prefer' | 'require'

/**
 * The closed vocabulary of verification outcomes. Every value is a result, not
 * an exception: a refused check is a successfully executed check whose answer
 * is refusal. `connected` is the only outcome that proves the channel usable.
 */
export type ConnectionOutcome =
  | 'connected'
  | 'auth-rejected'
  | 'unreachable'
  | 'timeout'
  | 'server-refused'
  | 'not-found'
  | 'protocol-violated'
  | 'unsupported-channel'
  | 'invalid-content'
  | 'aborted'

/** All outcomes in their canonical order; assertions iterate this list. */
export const CONNECTION_OUTCOMES: readonly ConnectionOutcome[] = [
  'connected', 'auth-rejected', 'unreachable', 'timeout', 'server-refused',
  'not-found', 'protocol-violated', 'unsupported-channel', 'invalid-content', 'aborted',
]

/** Connection id rule: lowercase letter, then letters/digits/hyphens, ≤64 chars. */
const CONNECTION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

/** Lowercase DNS hostname or IPv4; IPv6 brackets are rejected (deployment records them as hosts). */
const HOST_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

/** Object-store bucket names: lowercase alphanumerics, hyphens, dots; alnum first and last. */
const BUCKET_PATTERN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/

/** Maximum number of declared connections across all kinds (bounded config). */
export const MAX_CONNECTIONS = 16

/** Default TCP port for PostgreSQL wire connections. */
export const POSTGRES_DEFAULT_PORT = 5432

/** Bounds for every connector's wall-clock deadline, in milliseconds. */
export const MIN_TIMEOUT_MS = 1000
export const MAX_TIMEOUT_MS = 60_000
export const DEFAULT_TIMEOUT_MS = 10_000

/**
 * The COG read budget: at most three HTTP range requests (header, directory
 * count, directory entries) and at most this many bytes of directory payload.
 */
export const COG_MAX_RANGE_REQUESTS = 3
export const COG_MAX_DIRECTORY_BYTES = 16 * 1024

/** At most this many IFD entries parsed from one directory; larger is invalid content. */
export const TIFF_MAX_IFD_ENTRIES = 128

/** A named PostGIS connection as the deployment declares it (credential by env reference only). */
export interface PostgresConnectionSpec {
  /** Unique connection id across all kinds. */
  readonly id: string
  /** Server hostname (no userinfo, no scheme). */
  readonly host: string
  /** Server port; defaults to {@link POSTGRES_DEFAULT_PORT} when omitted. */
  readonly port?: number
  /** Database name to authenticate against. */
  readonly database: string
  /** Role name to authenticate as. */
  readonly user: string
  /** Environment-variable name holding the role password; the value never enters config or logs. */
  readonly passwordEnv: string
  /** TLS negotiation: `disable` never asks, `prefer` upgrades when offered, `require` refuses cleartext. */
  readonly ssl: TlsMode
  /** Wall-clock deadline for the whole verification exchange. */
  readonly timeoutMs?: number
}

/** S3 addressing styles: path-style keeps the bucket in the path, virtual-hosted moves it into the host. */
export type S3Addressing = 'path' | 'virtual-hosted'

/** A named S3-compatible object-store connection as the deployment declares it. */
export interface ObjectStoreConnectionSpec {
  /** Unique connection id across all kinds. */
  readonly id: string
  /** Service root, `http(s)://host[:port]`, no trailing slash, path, query, or userinfo. */
  readonly endpoint: string
  /** Signing region (SigV4 scope input; S3-compatible servers require a consistent value). */
  readonly region: string
  /** Bucket name to verify against. */
  readonly bucket: string
  /** Environment-variable name holding the access key id. */
  readonly accessKeyIdEnv: string
  /** Environment-variable name holding the secret access key. */
  readonly secretAccessKeyEnv: string
  /** Optional environment-variable name holding a session token (temporary credentials). */
  readonly sessionTokenEnv?: string
  /** Bucket addressing; path-style is the default for S3-compatible deployments. */
  readonly addressing: S3Addressing
  /** Wall-clock deadline for the whole verification exchange. */
  readonly timeoutMs?: number
}

/** A named COG (Cloud-Optimized GeoTIFF) connection as the deployment declares it. */
export interface CogConnectionSpec {
  /** Unique connection id across all kinds. */
  readonly id: string
  /** Absolute `http(s)` URL of the raster (a pre-signed URL may carry its own query). */
  readonly url: string
  /** Optional environment-variable name holding a bearer token for the request. */
  readonly tokenEnv?: string
  /** Wall-clock deadline for the whole verification exchange. */
  readonly timeoutMs?: number
}

/** Any declared connection, discriminated by kind. */
export type AnyConnectionSpec = PostgresConnectionSpec | ObjectStoreConnectionSpec | CogConnectionSpec

/** Facts a PostGIS verification reports when the server answers. */
export interface PostgresVerificationFacts {
  /** Server version string (bounded, server-reported). */
  readonly serverVersion: string
  /** Selected server parameters, bounded to the identity-relevant set. */
  readonly parameters: readonly { readonly name: string; readonly value: string }[]
}

/** Facts an object-store verification reports when the service answers. */
export interface ObjectStoreVerificationFacts {
  /** The region the service reported for the bucket, when it reports one. */
  readonly bucketRegion?: string
  /** Bucket name as the service echoed it (must match the configured bucket). */
  readonly bucketName: string
  /** The addressing style the request used. */
  readonly addressing: S3Addressing
  /** Rows listed by the zero-key listing (proof the exchange read no object bytes). */
  readonly keyCount: number
}

/** Facts a COG verification reports from the TIFF directory (inline values only). */
export interface CogVerificationFacts {
  /** BigTIFF (magic 43) versus classic TIFF (magic 42). */
  readonly bigTiff: boolean
  /** Image width in pixels, when the directory states it inline. */
  readonly width?: number
  /** Image height in pixels, when the directory states it inline. */
  readonly height?: number
  /** Bits per sample, first value, when stated inline. */
  readonly bitsPerSample?: number
  /** Samples (bands) per pixel, when stated inline. */
  readonly samplesPerPixel?: number
  /** Compression codec, numeric code and name when recognized. */
  readonly compression: { readonly code: number; readonly name?: string }
  /** Tile layout: tiled (COG-capable) versus striped TIFF. */
  readonly tiled: boolean
  /** Tile width in pixels, when stated inline. */
  readonly tileWidth?: number
  /** Tile height in pixels, when stated inline. */
  readonly tileHeight?: number
  /** Number of tile offsets present in the directory. */
  readonly tileCount?: number
  /** Georeferencing tag presence (ModelPixelScale + ModelTiepoint). */
  readonly georeferenced: boolean
  /** GeoKeyDirectory tag presence. */
  readonly hasGeoKeys: boolean
  /** GDAL_METADATA tag presence. */
  readonly hasGdalMetadata: boolean
}

/** Kind-specific facts; present exactly when the outcome is `connected`. */
export type ConnectionFacts = PostgresVerificationFacts | ObjectStoreVerificationFacts | CogVerificationFacts

/** One connection verification report: the unit of the connection-capability contract. */
export interface ConnectionVerification {
  /** The configured connection id this report describes. */
  readonly connectionId: string
  /** The connection kind. */
  readonly kind: ConnectionKind
  /** The closed outcome; `connected` is the only positive proof. */
  readonly outcome: ConnectionOutcome
  /**
   * Bounded, sanitized diagnostic text naming what the server said or the
   * transport did. Never contains credentials, signatures, or paths.
   */
  readonly detail: string
  /** Measured exchange duration in milliseconds (monotonic clock). */
  readonly latencyMs: number
  /** Kind-specific facts, present exactly when `outcome` is `connected`. */
  readonly facts?: ConnectionFacts
}

/** Endpoint validation: `http(s)://host[:port]` root with no trailing slash, path, query, fragment, or userinfo. */
export const HTTP_ROOT_PATTERN = /^https?:\/\/(?![^/?#]*@)[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[1-9][0-9]{0,4})?$/i

/** Validate a connection id shape; returns the failure text or `undefined` when valid. */
export function connectionIdProblem(id: string): string | undefined {
  if (!CONNECTION_ID_PATTERN.test(id)) {
    return `connection id "${bounded(id)}" must match ${CONNECTION_ID_PATTERN.source}`
  }
  return undefined
}

/** Validate a host shape; returns the failure text or `undefined` when valid. */
export function hostProblem(host: string): string | undefined {
  if (host.length === 0 || host.length > 253 || !HOST_PATTERN.test(host)) {
    return `host "${bounded(host)}" must be a lowercase hostname or IPv4 without scheme or userinfo`
  }
  return undefined
}

/** Validate a wall-clock timeout against the contract bounds. */
export function timeoutProblem(timeoutMs: number | undefined): string | undefined {
  if (timeoutMs === undefined) return undefined
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return `timeout ${String(timeoutMs)} must be an integer between ${String(MIN_TIMEOUT_MS)} and ${String(MAX_TIMEOUT_MS)}`
  }
  return undefined
}

/** Validate a PostGIS connection spec; every field failure is collected, named, and bounded. */
export function postgresSpecProblem(spec: PostgresConnectionSpec): string | undefined {
  const problems: string[] = []
  const idProblem = connectionIdProblem(spec.id)
  if (idProblem !== undefined) problems.push(idProblem)
  const host = hostProblem(spec.host)
  if (host !== undefined) problems.push(host)
  if (spec.port !== undefined && (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535)) {
    problems.push(`port ${String(spec.port)} must be an integer between 1 and 65535`)
  }
  if (spec.database.length === 0 || spec.database.length > 63) {
    problems.push('database must be 1–63 characters')
  }
  if (spec.user.length === 0 || spec.user.length > 63) {
    problems.push('user must be 1–63 characters')
  }
  if (spec.passwordEnv.length === 0) {
    problems.push('passwordEnv must name the environment variable holding the role password')
  }
  if (spec.ssl !== 'disable' && spec.ssl !== 'prefer' && spec.ssl !== 'require') {
    problems.push(`ssl "${bounded(spec.ssl)}" must be one of disable | prefer | require`)
  }
  const timeout = timeoutProblem(spec.timeoutMs)
  if (timeout !== undefined) problems.push(timeout)
  return problems.length === 0 ? undefined : problems.join('; ')
}

/** Validate an object-store connection spec; every field failure is collected, named, and bounded. */
export function objectStoreSpecProblem(spec: ObjectStoreConnectionSpec): string | undefined {
  const problems: string[] = []
  const idProblem = connectionIdProblem(spec.id)
  if (idProblem !== undefined) problems.push(idProblem)
  if (!HTTP_ROOT_PATTERN.test(spec.endpoint)) {
    problems.push(`endpoint "${bounded(spec.endpoint)}" must be an http(s) root without trailing slash, path, query, or userinfo`)
  }
  if (spec.region.length === 0 || spec.region.length > 64) {
    problems.push('region must be 1–64 characters')
  }
  if (spec.bucket.length === 0 || spec.bucket.length > 63 || !BUCKET_PATTERN.test(spec.bucket)) {
    problems.push('bucket must be 1–63 lowercase alphanumeric/hyphen/dot characters, alnum first and last')
  }
  if (spec.accessKeyIdEnv.length === 0) problems.push('accessKeyIdEnv must name the access key id variable')
  if (spec.secretAccessKeyEnv.length === 0) problems.push('secretAccessKeyEnv must name the secret access key variable')
  if (spec.addressing !== 'path' && spec.addressing !== 'virtual-hosted') {
    problems.push(`addressing "${bounded(spec.addressing)}" must be path or virtual-hosted`)
  }
  const timeout = timeoutProblem(spec.timeoutMs)
  if (timeout !== undefined) problems.push(timeout)
  return problems.length === 0 ? undefined : problems.join('; ')
}

/** Validate a COG connection spec; every field failure is collected, named, and bounded. */
export function cogSpecProblem(spec: CogConnectionSpec): string | undefined {
  const problems: string[] = []
  const idProblem = connectionIdProblem(spec.id)
  if (idProblem !== undefined) problems.push(idProblem)
  let url: URL
  try {
    url = new URL(spec.url)
  } catch {
    problems.push(`url "${bounded(spec.url)}" must be an absolute http(s) URL`)
    return problems.join('; ')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    problems.push(`url protocol "${bounded(url.protocol)}" must be http or https`)
  }
  if (url.username !== '' || url.password !== '') {
    problems.push('url must not carry userinfo; credentials go through tokenEnv')
  }
  const timeout = timeoutProblem(spec.timeoutMs)
  if (timeout !== undefined) problems.push(timeout)
  return problems.length === 0 ? undefined : problems.join('; ')
}

/**
 * Bound one free-text fragment before it enters a detail or failure message:
 * cap length and collapse to visible characters so server echo cannot smuggle
 * control bytes or bulk payload into model-visible text.
 * @param text - the fragment to bound.
 * @returns the bounded fragment.
 */
export function bounded(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f]/g, ' ')
  return flat.length <= 200 ? flat : `${flat.slice(0, 200)}…`
}

/** The monotonic millisecond clock the verification report measures against; injectable for tests. */
export type NowMs = () => number

/** The default monotonic clock: `performance.now`, immune to wall-clock steps. */
export const defaultNowMs: NowMs = () => performance.now()

/**
 * Guard that a detail never carries credential material: connectors call this
 * before constructing a report; tests assert it stays honest.
 * @param detail - the candidate detail text.
 * @param secrets - the secret values this exchange held (empty strings ignored).
 * @returns the detail when clean; `'[redacted]'` if any secret leaked in.
 */
export function sanitizeDetail(detail: string, secrets: readonly (string | undefined)[]): string {
  for (const secret of secrets) {
    if (secret !== undefined && secret.length > 0 && detail.includes(secret)) return '[redacted]'
  }
  return detail
}
