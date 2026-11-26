/**
 * Private upstream HTTP caching, without stale-image recovery or header passthrough.
 * @module @map-harness/map-container/source-cache-policy
 */
import CachePolicy from 'http-cache-semantics'
import type { SourceNetworkValidators, SourceResponseCacheHeaders } from './source-network.ts'

/** Credential-scope policy; the caller separately owns image bytes and scope keys. */
export interface SourceCachePolicy {
  readonly storable: boolean
  /** Serialized private metadata bytes, including upstream validators and URL. */
  readonly bytes: number
  /** @returns whether these bytes can be used now without upstream revalidation. */
  isFresh(): boolean
  /** @returns private upstream conditional headers, never browser validators. */
  validators(): SourceNetworkValidators
  /**
   * Admit a matching native 304; null requires an unconditional bounded read.
   * @param headers - only the current upstream 304 cache headers.
   * @param requestStartedAt - wall-clock milliseconds before the upstream request.
   * @returns current policy for the same body, or null when validators do not match.
   */
  revalidated(headers: SourceResponseCacheHeaders, requestStartedAt: number): SourceCachePolicy | null
  /** @returns safe private browser directives, not raw provider cache headers. */
  browserCacheControl(): string
}

const numericDirectives = new Set(['max-age', 's-maxage', 'stale-if-error', 'stale-while-revalidate'])
const flagDirectives = new Set(['public', 'must-revalidate', 'proxy-revalidate', 'immutable', 'no-transform'])

function normalizedControl(value: string | null): string | undefined {
  if (value === null) return undefined
  const seen = new Set<string>()
  const output: string[] = []
  for (const part of value.split(',')) {
    const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?:=([!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\\,]*"))?$/.exec(part.trim())
    if (match === null) return 'no-store'
    const name = match[1]!.toLowerCase()
    const raw = match[2]
    if (seen.has(name)) return 'no-store'
    seen.add(name)
    if (numericDirectives.has(name)) {
      const digits = raw?.replace(/^"|"$/g, '')
      if (digits === undefined || !/^\d+$/.test(digits)
        || !Number.isSafeInteger(Number(digits)) || Number(digits) > Number.MAX_SAFE_INTEGER / 1_000) return 'no-store'
      output.push(`${name}=${digits}`)
    } else if (name === 'no-store' || name === 'no-cache' || name === 'private') {
      output.push(name)
    } else {
      if (flagDirectives.has(name) && raw !== undefined) return 'no-store'
      output.push(raw === undefined ? name : `${name}=${raw}`)
    }
  }
  return output.join(',')
}

function effectiveHeaders(before: SourceResponseCacheHeaders, after: SourceResponseCacheHeaders): SourceResponseCacheHeaders {
  return {
    etag: after.etag ?? before.etag,
    lastModified: after.lastModified ?? before.lastModified,
    cacheControl: after.cacheControl ?? before.cacheControl,
    date: after.date ?? before.date,
    age: after.age,
    expires: after.expires ?? before.expires,
    vary: after.vary ?? before.vary,
  }
}

function responseHeaders(
  input: SourceResponseCacheHeaders,
  requestStartedAt: number,
  previous?: SourceResponseCacheHeaders,
): CachePolicy.Headers {
  const now = Date.now()
  const date = input.date ?? previous?.date ?? null
  const parsedDate = date === null ? null : Date.parse(date)
  const age = input.age === null ? 0 : Number(input.age)
  const invalidAge = input.age !== null && (!/^\d+$/.test(input.age) || !Number.isSafeInteger(age) || age < 0)
  const invalidDate = parsedDate !== null && !Number.isFinite(parsedDate)
  const apparentAge = parsedDate === null || invalidDate ? 0 : Math.max(0, (now - parsedDate) / 1_000)
  const correctedAge = Math.max(apparentAge, (invalidAge ? 0 : age) + Math.max(0, now - requestStartedAt) / 1_000)
  // Seed known fields on the original response so native 304 merging can add them.
  const result: CachePolicy.Headers = previous === undefined ? {
    etag: undefined, 'last-modified': undefined, 'cache-control': undefined,
    date: undefined, age: undefined, expires: undefined, vary: undefined,
  } : {}
  const supplied = {
    etag: input.etag, 'last-modified': input.lastModified,
    'cache-control': normalizedControl(input.cacheControl),
    date: input.date, expires: input.expires, vary: input.vary,
  }
  for (const [name, value] of Object.entries(supplied)) if (value != null) result[name] = value
  // The native policy reads integer Age; rounding down would extend freshness.
  result.age = String(Math.ceil(correctedAge))
  if (invalidAge || invalidDate) result['cache-control'] = 'no-store'
  return result
}

function wrapPolicy(policy: CachePolicy, request: CachePolicy.HttpRequest, original: SourceResponseCacheHeaders): SourceCachePolicy {
  const wildcard = original.vary?.split(',').some(name => name.trim() === '*') === true
  const storable = !wildcard && policy.storable()
  const isFresh = (): boolean => storable && !policy.stale() && policy.satisfiesWithoutRevalidation(request)
  return {
    storable,
    bytes: Buffer.byteLength(JSON.stringify({ policy: policy.toObject(), original }), 'utf8'),
    isFresh,
    validators() {
      const headers = policy.revalidationHeaders(request)
      const etag = headers['if-none-match']
      const lastModified = headers['if-modified-since']
      return { etag: typeof etag === 'string' ? etag : null, lastModified: typeof lastModified === 'string' ? lastModified : null }
    },
    revalidated(headers, requestStartedAt) {
      const updated = policy.revalidatedPolicy(request, { status: 304, headers: responseHeaders(headers, requestStartedAt, original) })
      return updated.matches && !updated.modified
        ? wrapPolicy(updated.policy, request, effectiveHeaders(original, headers))
        : null
    },
    browserCacheControl() {
      if (!storable) return 'no-store'
      if (!isFresh()) return 'private, no-cache, max-age=0, must-revalidate'
      const remaining = Math.max(0, Math.floor(policy.maxAge() - policy.age()))
      return `private, max-age=${remaining}, must-revalidate`
    },
  }
}

/**
 * Resolve a cache policy for a configured, credential-scope image request.
 * Unknown/ambiguous header syntax is non-storable; heuristic/stale recovery is disabled.
 * @param url - compiled private upstream URL before credentials are bound.
 * @param headers - bounded cache fields from the controlled transport.
 * @param requestStartedAt - wall-clock milliseconds before the upstream request.
 * @returns private policy metadata, never an authorization or a source selection.
 */
export function createSourceCachePolicy(url: URL, headers: SourceResponseCacheHeaders, requestStartedAt: number): SourceCachePolicy {
  const snapshot = { ...headers }
  const request: CachePolicy.HttpRequest = {
    url: url.href, method: 'GET', headers: { accept: 'image/png,image/jpeg', 'accept-encoding': 'identity' },
  }
  const policy = new CachePolicy(request, { status: 200, headers: responseHeaders(snapshot, requestStartedAt) }, {
    shared: false, cacheHeuristic: 0, immutableMinTimeToLive: 0, ignoreCargoCult: false,
  })
  return wrapPolicy(policy, request, snapshot)
}
