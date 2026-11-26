/** Building-footprint retrieval: a bounded, deployment-configured source of WGS84 polygons for AOI refinement. */
import { z } from 'zod'

/** Cordis service name for footprint retrieval. */
export const SPATIAL_FOOTPRINTS_SERVICE = 'spatialFootprints'

/** Stable failures; vendor payloads and endpoints never enter error messages. */
export type FootprintErrorCode =
  | 'FOOTPRINTS_INVALID_INPUT'
  | 'FOOTPRINTS_NOT_CONFIGURED'
  | 'FOOTPRINTS_UNAVAILABLE'
  | 'FOOTPRINTS_TIMEOUT'
  | 'FOOTPRINTS_CANCELLED'
  | 'FOOTPRINTS_DISPOSED'
  | 'FOOTPRINTS_RATE_LIMITED'
  | 'FOOTPRINTS_TOO_LARGE'
  | 'FOOTPRINTS_RESPONSE_INVALID'
  | 'FOOTPRINTS_SOURCE_INVALID'

/** A footprint retrieval refusal with a machine-readable code. */
export class FootprintError extends Error {
  readonly code: FootprintErrorCode
  /**
   * @param code - failure category.
   * @param detail - credential-free diagnostic.
   */
  constructor(code: FootprintErrorCode, detail: string) {
    super(`${code}: ${detail}`)
    this.name = 'FootprintError'
    this.code = code
  }
}

const bbox = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().min(-180).max(180), z.number().min(-90).max(90)])
  .refine(value => value[0] <= value[2] && value[1] <= value[3], 'bbox must not wrap or be inverted')
  .refine(value => Math.max(value[2] - value[0], value[3] - value[1]) <= 0.05, 'bbox exceeds the 0.05° refinement window')

const requestSchema = z.object({
  kind: z.literal('footprints'),
  bbox,
  /** Optional OSM `building` value filter (for example `retail`, `commercial`); omitted returns every building. */
  building: z.string().trim().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(500).default(200),
}).strict()

/** A validated footprint request; the window is bounded so one call can never pull a district. */
export type FootprintRequest = z.infer<typeof requestSchema>

/**
 * Parse untrusted model JSON for a footprint query.
 * @param input - request JSON.
 * @returns a validated request with an explicit limit.
 */
export function resolveFootprintRequest(input: unknown): FootprintRequest {
  const parsed = requestSchema.safeParse(input)
  if (!parsed.success) throw new FootprintError('FOOTPRINTS_INVALID_INPUT', parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
  return parsed.data
}

/** Deployment-only settings; model requests never name endpoints. */
export interface FootprintsConfig {
  /** Overpass-compatible interpreter endpoint. Default is the public OSM instance; declare a self-hosted or private one for reliability. */
  baseUrl?: string
  /** Per-call budget. Overpass is slow; the default leaves room for one bounded query. */
  timeoutMs?: number
  maxResponseBytes?: number
  maxConcurrent?: number
  /** Bounded retries for transport-level failures (5xx / network); never for 4xx. */
  maxRetries?: number
  /** OSM data is ODbL; the deployment may name a different licence for a private source. */
  licence?: string
  attribution?: string
}

const configSchema = z.object({
  baseUrl: z.string().default('https://overpass-api.de/api/interpreter'),
  timeoutMs: z.number().int().min(500).max(120000).default(45000),
  maxResponseBytes: z.number().int().min(1024).max(32 * 1024 * 1024).default(8 * 1024 * 1024),
  maxConcurrent: z.number().int().min(1).max(4).default(2),
  maxRetries: z.number().int().min(0).max(2).default(1),
  licence: z.string().trim().min(1).max(128).default('ODbL 1.0 (OpenStreetMap contributors)'),
  attribution: z.string().trim().min(1).max(256).default('© OpenStreetMap contributors'),
}).strict()

/** Resolved in-memory configuration. */
export interface FootprintsSpec extends z.infer<typeof configSchema> {
  /** True when the deployment declared the endpoint rather than relying on the public default. */
  readonly declared: boolean
}

/**
 * Validate the footprint source at plugin load.
 * @param config - deployment settings.
 * @returns in-memory settings; HTTP is accepted only for literal loopback fixtures.
 */
export function resolveFootprintsConfig(config: FootprintsConfig | undefined): FootprintsSpec {
  const parsed = configSchema.safeParse(config ?? {})
  if (!parsed.success) throw new FootprintError('FOOTPRINTS_INVALID_INPUT', 'invalid footprint source configuration')
  const values = parsed.data
  let url: URL
  try { url = new URL(values.baseUrl) } catch (error) {
    void error
    throw new FootprintError('FOOTPRINTS_INVALID_INPUT', 'footprints baseUrl must be an absolute URL')
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new FootprintError('FOOTPRINTS_INVALID_INPUT', 'footprints baseUrl must be HTTPS (HTTP is loopback-only) without credentials, query or fragment')
  }
  return { ...values, baseUrl: url.href.replace(/\/$/, ''), declared: config?.baseUrl !== undefined }
}

/** One building footprint in WGS84, with the vendor tags the selection step needs. */
export interface Footprint {
  readonly type: 'Feature'
  readonly geometry: { readonly type: 'Polygon'; readonly coordinates: readonly (readonly (readonly [number, number])[])[] }
  readonly properties: {
    readonly id: string
    readonly name: string | null
    readonly building: string | null
    readonly levels: number | null
    readonly height: number | null
  }
}

/** One bounded footprint page, ready for the refinement tool; never published directly. */
export interface FootprintResult {
  readonly provider: 'osm-overpass'
  readonly nativeCrs: 'EPSG:4326'
  readonly request: FootprintRequest
  readonly retrievedAt: string
  readonly licence: string
  readonly attribution: string
  readonly data: { readonly type: 'FeatureCollection'; readonly features: readonly Footprint[] }
  readonly total: number
  readonly truncated: boolean
  readonly limitations: readonly string[]
}

/** Host service for read-only footprint retrieval. */
export interface SpatialFootprintsService {
  /**
   * @param input - model JSON.
   * @param signal - caller cancellation.
   * @returns a bounded validated page; an empty page is a valid answer (no buildings mapped here).
   */
  footprints(input: unknown, signal?: AbortSignal): Promise<FootprintResult>
  /** Abort and await every owned request; repeated close calls are safe. */
  close(): Promise<void>
}
