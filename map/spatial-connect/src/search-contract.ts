/** Validated requests and deployment configuration for online spatial search. */
import { z } from 'zod'

/** Cordis service name for online spatial retrieval. */
export const SPATIAL_SEARCH_SERVICE = 'spatialSearch'

/** Stable failures; vendor payloads and credentials never enter error messages. */
export type SearchErrorCode = 'SEARCH_INVALID_INPUT' | 'SEARCH_NOT_CONFIGURED' | 'SEARCH_AUTH_DENIED' | 'SEARCH_RATE_LIMITED' | 'SEARCH_TIMEOUT' | 'SEARCH_CANCELLED' | 'SEARCH_RESPONSE_INVALID' | 'SEARCH_TOO_LARGE' | 'SEARCH_UNAVAILABLE' | 'SEARCH_DISPOSED'

/** An online search refusal with a machine-readable code. */
export class SearchError extends Error {
  readonly code: SearchErrorCode
  /**
   * @param code - failure category.
   * @param detail - credential-free diagnostic.
   */
  constructor(code: SearchErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'SearchError'
    this.code = code
  }
}

const label = z.string().trim().min(1).max(256)
const point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)])
const bbox = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .refine(value => value[0] <= value[2] && value[1] <= value[3], 'bbox must not wrap or be inverted')
const requestSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('geocode'), query: label }).strict(),
  z.object({ kind: z.literal('reverse'), point }).strict(),
  z.object({ kind: z.literal('district'), query: label, boundary: z.boolean().default(false) }).strict(),
  z.object({
    kind: z.literal('search'), query: label, bbox: bbox.optional(), region: z.string().regex(/^\d{6,12}$/).optional(),
    limit: z.number().int().min(1).max(20).default(10), offset: z.number().int().nonnegative().max(10000).default(0),
    level: z.number().int().min(1).max(18).default(12),
  }).strict().refine(value => (value.bbox === undefined) !== (value.region === undefined), 'search requires exactly one of bbox or region'),
])

/** A resolved vendor request; defaults are filled before execution. */
export type SpatialSearchRequest = z.infer<typeof requestSchema>

/**
 * Parse untrusted model JSON without inferring a study area or default city.
 * @param input - request JSON.
 * @returns a validated request with explicit defaults.
 */
export function resolveSearchRequest(input: unknown): SpatialSearchRequest {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success) throw new SearchError('SEARCH_INVALID_INPUT', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  return parsed.data
}

/** Deployment-only settings; model requests cannot name endpoints or credentials. */
export interface SpatialSearchConfig {
  apiKeyEnv?: string
  baseUrl?: string
  timeoutMs?: number
  maxResponseBytes?: number
  maxConcurrent?: number
  maxCoordinates?: number
}

const configSchema = z.object({
  apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('TIANDITU_API_KEY'),
  baseUrl: z.string().default('https://api.tianditu.gov.cn'),
  timeoutMs: z.number().int().min(50).max(60000).default(10000),
  maxResponseBytes: z.number().int().min(1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
  maxConcurrent: z.number().int().min(1).max(16).default(4),
  maxCoordinates: z.number().int().min(4).max(100000).default(20000),
}).strict()

/** Resolved in-memory configuration. The key must never be persisted or logged. */
export interface SpatialSearchSpec extends z.infer<typeof configSchema> {
  readonly apiKey: string
}

/**
 * Resolve credentials and transport limits at plugin load.
 * @param config - deployment settings.
 * @param env - environment used only to resolve the named credential.
 * @returns in-memory settings; HTTP is accepted only for literal loopback fixtures.
 */
export function resolveSearchConfig(config: SpatialSearchConfig, env: NodeJS.ProcessEnv): SpatialSearchSpec {
  const parsed = configSchema.safeParse(config)
  if (!parsed.success) throw new SearchError('SEARCH_INVALID_INPUT', 'invalid spatial search configuration')
  const values = parsed.data
  let url: URL
  try { url = new URL(values.baseUrl) } catch (error) {
    void error
    throw new SearchError('SEARCH_INVALID_INPUT', 'search baseUrl must be an HTTPS origin')
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new SearchError('SEARCH_INVALID_INPUT', 'search baseUrl must be an HTTPS origin without credentials, path or query; HTTP is loopback-only')
  }
  const apiKey = env[values.apiKeyEnv]?.trim()
  if (!apiKey) throw new SearchError('SEARCH_NOT_CONFIGURED', `set the configured credential environment variable ${values.apiKeyEnv}`)
  return { ...values, baseUrl: url.origin, apiKey }
}

/** Minimal validated GeoJSON returned by the provider. */
export interface SearchFeature {
  readonly type: 'Feature'
  readonly geometry: { readonly type: 'Point'; readonly coordinates: readonly [number, number] } | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly (readonly [number, number])[])[] }
  readonly properties: Readonly<Record<string, string>>
}

/** One bounded search page, ready for immutable catalog registration. */
export interface SpatialSearchResult {
  readonly provider: 'tianditu'
  readonly nativeCrs: 'EPSG:4490'
  readonly request: SpatialSearchRequest
  readonly retrievedAt: string
  readonly data: { readonly type: 'FeatureCollection'; readonly features: readonly SearchFeature[] }
  readonly total: number
  readonly hasMore: boolean
  readonly nextOffset: number | null
  readonly limitations: readonly string[]
}

/** Host service for read-only searches; publication belongs to catalog_register. */
export interface SpatialSearchService {
  /**
   * @param input - model JSON.
   * @param signal - caller cancellation.
   * @returns a bounded validated page.
   */
  search(input: unknown, signal?: AbortSignal): Promise<SpatialSearchResult>
  /** Abort and await every owned request; repeated close calls are safe. */
  close(): Promise<void>
}
