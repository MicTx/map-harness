/**
 * The Mapbox road-network adapter: a configured network source of this
 * deployment, enabled by a deployment Config choice plus a user-held access
 * token. It maps Directions API v5 onto the {@link NetworkProvider} `route`
 * face and Isochrone API v1 onto `serviceArea`, and maps every vendor failure
 * onto the existing {@link AccessibilityError} codes without inventing new
 * protocol vocabulary.
 *
 * ## Capability declaration (mappable face)
 *
 * - `networkId`/`networkRef`: `mapbox-road-network-<digest>@1`; the digest
 *   covers the support bbox only — the ref identifies the adapter
 *   configuration, never a vendor data snapshot (and never the token).
 * - `route`: one Directions v5 call. `walk` maps to `mapbox/walking`, `bike`
 *   to `mapbox/cycling`, `drive` to `mapbox/driving`. Minutes come from
 *   `duration` (seconds / 60) and kilometres from `distance` (metres / 1000);
 *   path nodes are the quantised GeoJSON LineString (`geometries=geojson`).
 * - `serviceArea`: one Isochrone v1 call with `polygons=true` and a single
 *   `contours_minutes` contour at the budget. The returned polygon is the
 *   service area; its exterior ring is sampled into nodes whose minutes are
 *   the contour value (the origin node carries 0).
 * - `pricesMode`: `walk`, `bike`, and `drive`.
 * - Cancellation: every vendor call carries the caller's `AbortSignal` into
 *   the transport and is checked before the call.
 * - Coordinate datum: Mapbox serves WGS84, the harness contract, so
 *   coordinates pass through unchanged.
 *
 * ## Declared shrinks (unmappable face, honest not fabricated)
 *
 * See {@link MAPBOX_CAPABILITY_DECLARATION}. The vendor terms require results
 * to be displayed on a Mapbox map; that is a deployment legal notice recorded
 * in the limitations, not a code-enforced gate.
 *
 * @module @map-harness/spatial-accessibility/mapbox
 */
import { AccessibilityError, type AccessibilityErrorCode } from './errors.ts'
import { sha256Hex, type ExtentBox, type LonLat, type TravelMode } from './contract.ts'
import type { NetworkProvider, NetworkNode, PoiPage } from './network.ts'

/** The Mapbox network source id this adapter serves. */
export const MAPBOX_NETWORK_ID = 'mapbox-road-network'

/** Environment variable the deployment Config references for the access token. */
export const DEFAULT_MAPBOX_ACCESS_TOKEN_ENV = 'MAPBOX_ACCESS_TOKEN'

/**
 * The Mapbox API root. Protocol constant; deployments that need a TLS or
 * mirror root set the Config `baseUrl`, which reaches {@link MapboxProviderConfig.baseUrl}.
 */
export const MAPBOX_BASE_URL = 'https://api.mapbox.com'

/** Directions v5 profiles this adapter prices, one per travel mode. */
export const MAPBOX_PROFILES: Readonly<Record<TravelMode, string>> = {
  walk: 'mapbox/walking',
  bike: 'mapbox/cycling',
  drive: 'mapbox/driving',
}

/** Minimum coordinate points one Directions call accepts. */
export const MAPBOX_MIN_COORDINATES = 2

/** Maximum coordinate points one Directions call accepts. */
export const MAPBOX_MAX_COORDINATES = 25

/** The vendor documents a GET URL ceiling near this many bytes. */
export const MAPBOX_MAX_URL_BYTES = 8192

/** Minimum isochrone contour in minutes. */
export const MAPBOX_MIN_CONTOUR_MINUTES = 1

/** Maximum isochrone contour in minutes. */
export const MAPBOX_MAX_CONTOUR_MINUTES = 60

/** Maximum contours one Isochrone call accepts. */
export const MAPBOX_MAX_CONTOURS = 4

/** The vendor isochrone rate limit, requests per minute. */
export const MAPBOX_ISOCHRONE_PER_MINUTE = 300

/** Maximum returned route nodes; longer vendor lines are stride-sampled. */
export const MAPBOX_MAX_ROUTE_NODES = 1024

/** Default per-request transport timeout in milliseconds. */
export const DEFAULT_MAPBOX_TIMEOUT_MS = 10_000

/** Structural subset of `fetch` the adapter needs; injectable for fixtures. */
export interface MapboxFetch {
  /** One GET against the vendor endpoint. */
  (url: string, init: { readonly signal?: AbortSignal }): Promise<{
    readonly ok: boolean
    readonly status: number
    text(): Promise<string>
  }>
}

/** Adapter construction options. */
export interface MapboxProviderConfig {
  /** The resolved access token; held in memory only, never in refs, logs, or errors. */
  readonly accessToken: string
  /**
   * Environment-variable name the token was resolved through; used in loud
   * failure text (the name only — never the value).
   */
  readonly accessTokenEnv: string
  /** The support extent the provider identity digests. */
  readonly bbox: ExtentBox
  /** Per-request transport timeout in milliseconds (1000–60000). */
  readonly timeoutMs?: number
  /** Transport seam; defaults to the global `fetch`. */
  readonly fetchImpl?: MapboxFetch
  /** Vendor root override; defaults to {@link MAPBOX_BASE_URL}. */
  readonly baseUrl?: string
}

/** The structured capability/limitation declaration of one vendor adapter. */
export interface VendorCapabilityDeclaration {
  /** Human-readable vendor name. */
  readonly vendor: string
  /** The network id this declaration describes. */
  readonly networkId: string
  /** Faces that map onto the provider contract, with how they map. */
  readonly mappable: readonly { readonly face: string; readonly mapping: string }[]
  /** Faces the vendor cannot serve, with the vendor fact and the loud behavior. */
  readonly shrunk: readonly { readonly face: string; readonly vendorFact: string; readonly behavior: string }[]
}

/**
 * The load-bearing capability declaration: docs cite it and tests assert it
 * stays in step with the implemented behavior. Shrunk faces fail loud with
 * the named behavior — none of them silently degrades.
 */
export const MAPBOX_CAPABILITY_DECLARATION: VendorCapabilityDeclaration = {
  vendor: 'mapbox',
  networkId: MAPBOX_NETWORK_ID,
  mappable: [
    { face: 'route walk/bike/drive', mapping: 'one Directions v5 call; profile mapbox/walking|cycling|driving; minutes = duration seconds / 60, kilometres = distance metres / 1000, nodes = quantised GeoJSON LineString' },
    { face: 'serviceArea', mapping: 'one Isochrone v1 call with polygons=true and one contours_minutes contour; the polygon ring is the area and the contour value is its minutes' },
    { face: 'cancellation', mapping: 'caller AbortSignal checked before the call and carried into every vendor request' },
  ],
  shrunk: [
    { face: 'readPois', vendorFact: 'Directions and Isochrone return routes and contours, not a POI directory', behavior: 'readPois fails METHOD_NOT_APPLICABLE' },
    { face: 'barriers', vendorFact: 'neither mapped service takes a barrier input', behavior: 'barrier segments fail ACCESS_INVALID_INPUT naming the shrink; they are never silently ignored' },
    { face: 'time-slice pricing', vendorFact: 'durations are the vendor\'s current estimates; driving-traffic is a live profile, not a slice factor', behavior: 'the slice parameter is accepted and does not change pricing; evidence limitations state it' },
    { face: 'isochrone contour bounds', vendorFact: 'contours_minutes accepts 1–60 and at most 4 contours, and one coordinate per call', behavior: 'a budget outside 1–60 fails ACCESS_INVALID_INPUT; the adapter sends exactly one contour for one coordinate' },
    { face: 'directions coordinate bounds', vendorFact: 'one Directions call accepts 2–25 coordinates and a GET URL near 8192 bytes', behavior: 'the origin-destination face sends 2 coordinates; a URL over the ceiling fails ACCESS_INVALID_INPUT before the request' },
    { face: 'network version', vendorFact: 'the mapped services expose no road-data version identity', behavior: 'networkRef digests the adapter configuration (bbox), never a vendor data snapshot and never the token' },
    { face: 'coordinate datum', vendorFact: 'Mapbox serves WGS84, the harness contract', behavior: 'coordinates pass through unchanged' },
    { face: 'display terms', vendorFact: 'Mapbox terms require results to be displayed on a Mapbox map', behavior: 'recorded as a deployment legal notice in the limitations; the adapter does not enforce display' },
  ],
}

/** The limitation sentences adapter results carry; mirrors the load-bearing shrinks. */
export const MAPBOX_PROVIDER_LIMITATIONS: readonly string[] = [
  'mapbox durations are the vendor\'s current estimates; time slices do not change pricing',
  'mapbox isochrones cover one coordinate and 1–60 minutes with at most 4 contours; this adapter sends one contour',
  'mapbox serves WGS84; coordinates pass through unchanged',
  'mapbox terms require results to be displayed on a Mapbox map; internal analysis use is a deployment legal notice, not enforced here',
  'mapbox exposes no road-data version identity; networkRef identifies the adapter configuration, not a vendor data snapshot',
]

/** Vendor body `code` values this adapter maps onto `ACCESS_NOT_FOUND`. */
const CODE_NOT_FOUND: ReadonlySet<string> = new Set(['NoRoute', 'NoSegment'])

/** Vendor body `code` values this adapter maps onto `ACCESS_INVALID_INPUT`. */
const CODE_INVALID: ReadonlySet<string> = new Set(['InvalidInput'])

/**
 * Classify one Mapbox failure onto the existing accessibility error
 * vocabulary. HTTP status wins when it is a documented refusal; a body `code`
 * classifies the remaining 200-with-message forms. Anything else is
 * `TEMPORARILY_UNAVAILABLE`.
 * @param status - the HTTP status, or 200 for a body-coded refusal.
 * @param bodyCode - the vendor body `code` when one was present.
 * @returns the existing code the vendor failure maps onto.
 */
export function classifyMapboxFailure(status: number, bodyCode: string | undefined): AccessibilityErrorCode {
  if (status === 401 || status === 403) return 'PERMISSION_DENIED'
  if (status === 429) return 'RATE_LIMITED'
  if (status === 404) return 'ACCESS_NOT_FOUND'
  if (status === 422) return 'ACCESS_INVALID_INPUT'
  if (bodyCode !== undefined && CODE_NOT_FOUND.has(bodyCode)) return 'ACCESS_NOT_FOUND'
  if (bodyCode !== undefined && CODE_INVALID.has(bodyCode)) return 'ACCESS_INVALID_INPUT'
  return 'TEMPORARILY_UNAVAILABLE'
}

/** Round one coordinate to the 1e-6 grid the node ids share. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Deterministic node id of one WGS84 point on the 1e-6 grid. */
function nodeIdOf(lon: number, lat: number): string {
  return `mapbox-${Math.round(lon * 1e6)}-${Math.round(lat * 1e6)}`
}

/** Format one point as the vendor `{longitude},{latitude}` path segment. */
function vendorCoord(point: LonLat): string {
  return `${round6(point[0])},${round6(point[1])}`
}

/** One vendor JSON body narrowed to the fields this adapter reads. */
interface MapboxBody {
  readonly code?: unknown
  readonly message?: unknown
  readonly routes?: unknown
  readonly features?: unknown
}

/** One parsed Directions route. */
interface DirectionsRoute {
  readonly metres: number
  readonly seconds: number
  readonly line: readonly LonLat[]
}

/** Narrow one JSON text to an object, or `undefined` when it is not JSON. */
function parseJson(text: string): MapboxBody | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as MapboxBody
    return undefined
  } catch {
    return undefined
  }
}

/** Read a GeoJSON position list, refusing anything that is not finite lon/lat pairs. */
function readPositions(value: unknown): readonly LonLat[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const positions: LonLat[] = []
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) return undefined
    const lon = entry[0]
    const lat = entry[1]
    if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) return undefined
    positions.push([lon, lat])
  }
  return positions
}

/**
 * Narrow one Directions v5 body to the first route. A body without a usable
 * route returns `undefined`.
 * @param body - the parsed vendor body.
 * @returns the route, or `undefined` when the schema does not match.
 */
export function parseDirectionsRoute(body: MapboxBody): DirectionsRoute | undefined {
  if (!Array.isArray(body.routes) || body.routes.length === 0) return undefined
  const first = body.routes[0] as { readonly distance?: unknown; readonly duration?: unknown; readonly geometry?: unknown }
  if (typeof first.distance !== 'number' || typeof first.duration !== 'number') return undefined
  if (!Number.isFinite(first.distance) || !Number.isFinite(first.duration) || first.distance < 0 || first.duration < 0) return undefined
  const geometry = first.geometry as { readonly type?: unknown; readonly coordinates?: unknown } | undefined
  if (geometry?.type !== 'LineString') return undefined
  const line = readPositions(geometry.coordinates)
  if (line === undefined) return undefined
  return { metres: first.distance, seconds: first.duration, line }
}

/** One parsed isochrone polygon. */
interface IsochronePolygon {
  readonly contour: number
  readonly ring: readonly LonLat[]
}

/**
 * Narrow one Isochrone v1 body to its first polygon feature.
 * @param body - the parsed vendor body.
 * @returns the polygon, or `undefined` when the schema does not match.
 */
export function parseIsochronePolygon(body: MapboxBody): IsochronePolygon | undefined {
  if (!Array.isArray(body.features) || body.features.length === 0) return undefined
  const feature = body.features[0] as { readonly properties?: unknown; readonly geometry?: unknown }
  const properties = feature.properties as { readonly contour?: unknown } | undefined
  const geometry = feature.geometry as { readonly type?: unknown; readonly coordinates?: unknown } | undefined
  if (typeof properties?.contour !== 'number' || geometry?.type !== 'Polygon') return undefined
  if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) return undefined
  const ring = readPositions(geometry.coordinates[0])
  if (ring === undefined) return undefined
  return { contour: properties.contour, ring }
}

/**
 * The network version identity of one adapter configuration. The digest
 * covers the support bbox only: the token must never enter a ref that
 * evidence and logs carry.
 * @param config - the support bbox.
 * @returns `mapbox-road-network-<16 hex>@1`.
 */
export function mapboxNetworkRefFor(config: { readonly bbox: ExtentBox }): string {
  const digest = sha256Hex(JSON.stringify({ id: MAPBOX_NETWORK_ID, bbox: config.bbox })).slice(0, 16)
  return `${MAPBOX_NETWORK_ID}-${digest}@1`
}

/**
 * Create the Mapbox road-network provider. Construction validates the
 * configuration and fails loud (`ACCESS_INVALID_INPUT`) on an unusable
 * extent or an empty token; nothing degrades silently to another source.
 * @param config - resolved token (value), its env name, support bbox, timeout, and transport.
 * @returns the provider.
 * @throws {AccessibilityError} `ACCESS_INVALID_INPUT` on an unusable configuration.
 */
export function createMapboxNetworkProvider(config: MapboxProviderConfig): NetworkProvider {
  if (typeof config.accessToken !== 'string' || config.accessToken.length === 0) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', `the mapbox provider requires the credential environment variable ${config.accessTokenEnv} to hold a non-empty token at construction`)
  }
  if (config.bbox.some(value => !Number.isFinite(value))) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', 'provider bbox must be finite numbers')
  }
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? DEFAULT_MAPBOX_TIMEOUT_MS, 1000), 60_000)
  const doFetch: MapboxFetch = config.fetchImpl ?? ((url, init) => fetch(url, init))
  const baseUrl = config.baseUrl ?? MAPBOX_BASE_URL

  /** One vendor GET. The token rides in `access_token` only and never enters messages. */
  async function vendorGet(path: string, query: Readonly<Record<string, string>>, signal: AbortSignal | undefined): Promise<MapboxBody> {
    if (signal?.aborted) signal.throwIfAborted()
    const params = new URLSearchParams(query)
    params.set('access_token', config.accessToken)
    const url = `${baseUrl}${path}?${params.toString()}`
    if (Buffer.byteLength(url) > MAPBOX_MAX_URL_BYTES) {
      throw new AccessibilityError('ACCESS_INVALID_INPUT', `the mapbox request URL is ${Buffer.byteLength(url)} bytes, over the vendor ceiling of ${MAPBOX_MAX_URL_BYTES}`)
    }
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
    const response = await doFetch(url, { signal: requestSignal })
    const text = await response.text()
    const body = parseJson(text)
    if (!response.ok) {
      const bodyCode = typeof body?.code === 'string' ? body.code : undefined
      const code = classifyMapboxFailure(response.status, bodyCode)
      const message = typeof body?.message === 'string' ? body.message.slice(0, 120) : `http ${response.status}`
      throw new AccessibilityError(code, `mapbox refused the request (http ${response.status}${bodyCode === undefined ? '' : `, ${bodyCode}`}: ${message})`)
    }
    if (body === undefined) {
      throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'mapbox answered an unexpected response form (non-JSON body)')
    }
    if (typeof body.code === 'string' && body.code !== 'Ok') {
      const code = classifyMapboxFailure(response.status, body.code)
      const message = typeof body.message === 'string' ? body.message.slice(0, 120) : body.code
      throw new AccessibilityError(code, `mapbox refused the request (${body.code}: ${message})`)
    }
    if (typeof body.message === 'string' && /no route found/i.test(body.message) && body.routes === undefined && body.features === undefined) {
      throw new AccessibilityError('ACCESS_NOT_FOUND', `mapbox refused the request (http 200, No route found: ${body.message.slice(0, 120)})`)
    }
    return body
  }

  /** Refuse barrier segments loudly: the mapped services take no barrier input. */
  function refuseBarriers(barriers: readonly unknown[] | undefined): void {
    if (barriers !== undefined && barriers.length > 0) {
      throw new AccessibilityError('ACCESS_INVALID_INPUT', 'the mapbox provider does not support barrier segments; run this spec on the controlled provider or drop the barriers')
    }
  }

  /** Bound a node list, keeping both endpoints. */
  function boundNodes(nodes: readonly string[]): readonly string[] {
    if (nodes.length <= MAPBOX_MAX_ROUTE_NODES) return nodes
    const stride = Math.ceil(nodes.length / MAPBOX_MAX_ROUTE_NODES)
    return nodes.filter((_, index) => index % stride === 0 || index === nodes.length - 1)
  }

  return {
    networkId: MAPBOX_NETWORK_ID,
    networkRef: mapboxNetworkRefFor({ bbox: config.bbox }),
    pricesMode(mode) {
      return MAPBOX_PROFILES[mode] !== undefined
    },
    snapPoint(point) {
      const node: NetworkNode = { id: nodeIdOf(round6(point[0]), round6(point[1])), lon: round6(point[0]), lat: round6(point[1]) }
      return { node, snapKm: 0 }
    },
    async serviceArea(origin, budgetMinutes, options) {
      if (MAPBOX_PROFILES[options.mode] === undefined) {
        throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the mapbox network does not price mode ${options.mode}`)
      }
      refuseBarriers(options.barriers)
      if (!Number.isInteger(budgetMinutes) || budgetMinutes < MAPBOX_MIN_CONTOUR_MINUTES || budgetMinutes > MAPBOX_MAX_CONTOUR_MINUTES) {
        throw new AccessibilityError('ACCESS_INVALID_INPUT', `mapbox isochrone contours_minutes accepts integers from ${MAPBOX_MIN_CONTOUR_MINUTES} to ${MAPBOX_MAX_CONTOUR_MINUTES}; ${budgetMinutes} is outside that range`)
      }
      const body = await vendorGet(
        `/isochrone/v1/${MAPBOX_PROFILES[options.mode]}/${vendorCoord(origin)}`,
        { contours_minutes: String(budgetMinutes), polygons: 'true' },
        options.signal,
      )
      const polygon = parseIsochronePolygon(body)
      if (polygon === undefined) {
        throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'mapbox answered an unexpected response form (isochrone body without a polygon feature)')
      }
      const nodes = [{ id: nodeIdOf(round6(origin[0]), round6(origin[1])), lon: round6(origin[0]), lat: round6(origin[1]), minutes: 0 }]
      for (const [lon, lat] of polygon.ring) {
        const id = nodeIdOf(round6(lon), round6(lat))
        if (nodes.some(node => node.id === id)) continue
        nodes.push({ id, lon: round6(lon), lat: round6(lat), minutes: polygon.contour })
      }
      return { origin, budgetMinutes, nodes }
    },
    async route(origin, destination, options) {
      if (MAPBOX_PROFILES[options.mode] === undefined) {
        throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the mapbox network does not price mode ${options.mode}`)
      }
      refuseBarriers(options.barriers)
      const coordinates = `${vendorCoord(origin)};${vendorCoord(destination)}`
      const body = await vendorGet(
        `/directions/v5/${MAPBOX_PROFILES[options.mode]}/${coordinates}`,
        { geometries: 'geojson', overview: 'full' },
        options.signal,
      )
      const parsed = parseDirectionsRoute(body)
      if (parsed === undefined) {
        throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'mapbox answered an unexpected response form (directions body without a usable route)')
      }
      const nodes = [nodeIdOf(round6(origin[0]), round6(origin[1]))]
      for (const [lon, lat] of parsed.line) {
        const id = nodeIdOf(round6(lon), round6(lat))
        if (nodes[nodes.length - 1] !== id) nodes.push(id)
      }
      const end = nodeIdOf(round6(destination[0]), round6(destination[1]))
      if (nodes[nodes.length - 1] !== end) nodes.push(end)
      return { minutes: parsed.seconds / 60, distanceKm: parsed.metres / 1000, nodes: boundNodes(nodes) }
    },
    readPois(): Promise<PoiPage> {
      return Promise.reject(new AccessibilityError('METHOD_NOT_APPLICABLE', 'the mapbox directions/isochrone provider does not serve a POI directory'))
    },
  }
}
