/**
 * The S3-compatible object-store connector: proves a declared endpoint
 * connectable and the credentials valid through one AWS Signature Version 4
 * signed `ListObjectsV2` request with `max-keys=0` — a listing that returns
 * metadata about the bucket and zero object keys. No object bytes are
 * fetched; nothing is synchronized or stored (the connection-capability
 * contract).
 *
 * ## Signing discipline
 *
 * - SigV4 over the service `s3`: canonical request (method, canonical URI,
 *   sorted canonical query, sorted signed headers, `x-amz-content-sha256` of
 *   the empty body), string-to-sign (algorithm, `x-amz-date`, scope
 *   `<date>/<region>/s3/aws4_request`, canonical-request hash), HMAC-SHA256
 *   key chain secret→date→region→service→signing.
 * - The access key id appears in the `Authorization` header credential scope;
 *   the secret access key and the derived signature never appear in any
 *   message, report, or error text ({@link sanitizeDetail} holds them back).
 * - Addressing: `path` keeps the bucket in the URI (`<endpoint>/<bucket>/`),
 *   `virtual-hosted` moves it into the Host header. Path-style is the default —
 *   S3-compatible deployments (self-hosted gateways especially) serve it
 *   universally.
 *
 * ## Outcome mapping
 *
 * HTTP 200 → `connected` (bucket echoed, zero keys); 301/400 with
 * `x-amz-bucket-region` → `server-refused` naming the hinted region (the
 * region is a signing input; correcting it is a configuration action, not a
 * silent retry); 401/403 → `auth-rejected` with the service error code;
 * 404/NoSuchBucket → `not-found`; transport/DNS/TLS failures → `unreachable`;
 * deadline → `timeout`; caller abort → `aborted`; non-XML or contract-breaking
 * 200 body → `protocol-violated`.
 *
 * @module @map-harness/spatial-connect/objectstore
 */
import { createHash, createHmac } from 'node:crypto'
import type { ConnectionVerification, ObjectStoreConnectionSpec, ObjectStoreVerificationFacts } from './contract.ts'
import { DEFAULT_TIMEOUT_MS, bounded, defaultNowMs, sanitizeDetail } from './contract.ts'

/** SHA-256 of the empty string — the unsigned payload hash of a zero-body GET. */
export const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** The SigV4 algorithm identifier; a protocol constant. */
const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256'

/** The service name in the signing scope. */
const S3_SERVICE = 's3'

/** The terminal scope segment. */
const SIGV4_TERMINATOR = 'aws4_request'

/** Structural subset of `fetch` the connector needs; injectable for fixtures. */
export interface ObjectStoreFetch {
  /** One request against the service endpoint. */
  (url: string, init: { readonly method: string; readonly headers: Record<string, string>; readonly signal?: AbortSignal }): Promise<{
    readonly ok: boolean
    readonly status: number
    readonly headers: { get(name: string): string | null }
    text(): Promise<string>
  }>
}

/** The credentials a verification holds in memory for the exchange only. */
export interface ObjectStoreCredentials {
  /** The access key id (public identity; still never echoed into error text). */
  readonly accessKeyId: string
  /** The secret access key. */
  readonly secretAccessKey: string
  /** The session token, when temporary credentials are in use. */
  readonly sessionToken?: string
}

/** Extra verification options: deadlines, cancellation, clocks, transport. */
export interface ObjectStoreVerifyOptions {
  /** Caller cancellation carried into the transport request. */
  readonly signal?: AbortSignal
  /** Wall-clock deadline override for the whole exchange. */
  readonly timeoutMs?: number
  /** Monotonic clock for the latency report; defaults to `performance.now`. */
  readonly now?: () => number
  /** Transport seam; defaults to the global `fetch`. */
  readonly fetchImpl?: ObjectStoreFetch
}

/** One signed request's inputs, exported so tests can cross-check the recipe. */
export interface SigV4RequestInput {
  /** Request method. */
  readonly method: string
  /** Canonical URI (path only, starting with `/`). */
  readonly canonicalUri: string
  /** Canonical query string (sorted, encoded, no leading `?`). */
  readonly canonicalQuery: string
  /** The headers that carry into the canonical request, host included. */
  readonly headers: Readonly<Record<string, string>>
  /** The header names to sign, lowercase, sorted. */
  readonly signedHeaders: readonly string[]
  /** The payload hash (hex sha256). */
  readonly payloadHash: string
  /** The ISO-basic UTC timestamp (`YYYYMMDDTHHMMSSZ`). */
  readonly amzDate: string
  /** The signing region. */
  readonly region: string
  /** The access key id. */
  readonly accessKeyId: string
  /** The secret access key. */
  readonly secretAccessKey: string
  /** The session token, when temporary credentials are in use. */
  readonly sessionToken?: string
}

/** The built pieces of one signed request. */
export interface SigV4Request {
  /** Every header to send (signed plus `Authorization`). */
  readonly headers: Readonly<Record<string, string>>
  /** The `Authorization` header value. */
  readonly authorization: string
}

/** HMAC-SHA256 with a key given as a string or bytes; raw digest. */
function hmacRaw(key: string | Uint8Array, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * Build one SigV4-signed request from its inputs. The recipe is the exported
 * contract: tests re-derive the signature with an independent implementation
 * and compare, so a regression here fails the keyless lane.
 * @param input - the request inputs (method, canonical parts, keys, region, timestamp).
 * @returns the request URL, headers, and authorization line.
 */
export function signSigV4(input: SigV4RequestInput): SigV4Request {
  const signedHeaders = [...input.signedHeaders].sort().join(';')
  const canonicalHeaders = [...input.signedHeaders]
    .sort()
    .map(name => `${name}:${input.headers[name]!.trim()}\n`)
    .join('')
  const canonicalRequest = [
    input.method,
    input.canonicalUri,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join('\n')
  const date = input.amzDate.slice(0, 8)
  const scope = `${date}/${input.region}/${S3_SERVICE}/${SIGV4_TERMINATOR}`
  const stringToSign = [
    SIGV4_ALGORITHM,
    input.amzDate,
    scope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n')
  const kDate = hmacRaw(`AWS4${input.secretAccessKey}`, date)
  const kRegion = hmacRaw(kDate, input.region)
  const kService = hmacRaw(kRegion, S3_SERVICE)
  const kSigning = hmacRaw(kService, SIGV4_TERMINATOR)
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')
  const authorization = `${SIGV4_ALGORITHM} Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { headers: input.headers, authorization }
}

/** Extract one XML element's text from a bounded body; entity-decoded, absent ⇒ undefined. */
function xmlText(body: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body)
  if (match === null) return undefined
  return match[1]!
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'')
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&amp;/g, '&')
}

/**
 * Verify one object-store connection and produce the report.
 * @param spec - the validated connection specification.
 * @param credentials - the resolved keys, held in memory for this exchange only.
 * @param options - deadline, cancellation, clock, and transport overrides.
 * @returns the verification report; service-side answers are results, never throws.
 */
export async function verifyObjectStore(spec: ObjectStoreConnectionSpec, credentials: ObjectStoreCredentials, options: ObjectStoreVerifyOptions = {}): Promise<ConnectionVerification> {
  const now = options.now ?? defaultNowMs
  const startedAt = now()
  const doFetch: ObjectStoreFetch = options.fetchImpl ?? (async (url, init) => await fetch(url, init as RequestInit))
  const deadline = AbortSignal.any([AbortSignal.timeout(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS), ...(options.signal === undefined ? [] : [options.signal])])
  const finish = (outcome: ConnectionVerification['outcome'], detail: string, facts?: ObjectStoreVerificationFacts): ConnectionVerification => ({
    connectionId: spec.id,
    kind: 'object-storage',
    outcome,
    detail: sanitizeDetail(detail, [credentials.secretAccessKey, credentials.sessionToken]),
    latencyMs: Math.max(0, now() - startedAt),
    ...(facts === undefined ? {} : { facts }),
  })

  const endpointUrl = new URL(spec.endpoint)
  const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const requestUrl = new URL(spec.endpoint)
  if (spec.addressing === 'virtual-hosted') {
    requestUrl.hostname = `${spec.bucket}.${endpointUrl.hostname}`
  } else {
    requestUrl.pathname = `/${spec.bucket}/`
  }
  requestUrl.search = 'list-type=2&max-keys=0'
  const headers: Record<string, string> = {
    host: requestUrl.host,
    'x-amz-content-sha256': EMPTY_BODY_SHA256,
    'x-amz-date': amzDate,
  }
  if (credentials.sessionToken !== undefined) headers['x-amz-security-token'] = credentials.sessionToken
  const signedHeaders = Object.keys(headers)
  const signed = signSigV4({
    method: 'GET',
    canonicalUri: spec.addressing === 'virtual-hosted' ? '/' : `/${spec.bucket}/`,
    canonicalQuery: 'list-type=2&max-keys=0',
    headers,
    signedHeaders,
    payloadHash: EMPTY_BODY_SHA256,
    amzDate,
    region: spec.region,
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    ...(credentials.sessionToken === undefined ? {} : { sessionToken: credentials.sessionToken }),
  })
  const requestHeaders = { ...headers, authorization: signed.authorization }

  try {
    const response = await doFetch(requestUrl.toString(), { method: 'GET', headers: requestHeaders, signal: deadline })
    const body = await response.text()
    if (response.status === 200) {
      const name = xmlText(body, 'Name')
      const keyCountText = xmlText(body, 'KeyCount')
      const keyCount = keyCountText === undefined ? undefined : Number(keyCountText)
      if (name !== spec.bucket) {
        return finish('protocol-violated', `the listing answered for bucket "${bounded(name ?? '(none)')}" while the connection names "${spec.bucket}"`)
      }
      if (keyCount !== 0) {
        return finish('protocol-violated', `a max-keys=0 listing answered KeyCount ${keyCountText ?? '(absent)'}; the service violates the request contract`)
      }
      const hintedRegion = response.headers.get('x-amz-bucket-region') ?? undefined
      return finish('connected', 'signed listing accepted; the bucket echoed with zero keys', {
        bucketName: name,
        addressing: spec.addressing,
        ...(hintedRegion === undefined || hintedRegion.length === 0 ? {} : { bucketRegion: hintedRegion }),
        keyCount: 0,
      })
    }
    if (response.status === 401 || response.status === 403) {
      const code = xmlText(body, 'Code') ?? `http ${String(response.status)}`
      const message = xmlText(body, 'Message')
      return finish('auth-rejected', `the service refused the credentials (${code}${message === undefined ? '' : `: ${bounded(message)}`})`)
    }
    if (response.status === 404) {
      return finish('not-found', `the service reports no bucket "${spec.bucket}" at this endpoint`)
    }
    if (response.status === 301 || response.status === 400) {
      const hintedRegion = response.headers.get('x-amz-bucket-region')
      if (hintedRegion !== null && hintedRegion.length > 0) {
        return finish('server-refused', `wrong signing region (configured "${spec.region}"; the service hints "${bounded(hintedRegion)}")`)
      }
      const code = xmlText(body, 'Code') ?? `http ${String(response.status)}`
      return finish('server-refused', `the service refused the request (${code})`)
    }
    return finish('server-refused', `the service answered http ${String(response.status)}; connection capability stays unproven`)
  } catch (error: unknown) {
    return finish(...describeFailure(error, options.signal))
  }
}

/** Fold one caught failure onto outcome + detail; caller abort outranks the deadline. */
function describeFailure(error: unknown, signal: AbortSignal | undefined): [ConnectionVerification['outcome'], string] {
  if (signal?.aborted === true) return ['aborted', 'verification aborted by the caller']
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return ['timeout', 'the verification deadline elapsed before the service answered']
    return ['unreachable', `transport failure (${error.name}): ${bounded(error.message)}`]
  }
  return ['unreachable', 'unknown transport failure']
}
