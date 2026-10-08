/**
 * Tencent Maps road-network adapter. It maps the Directions v1 and Place v1
 * JSON faces onto the NetworkProvider contract and keeps unsupported vendor
 * features explicit.
 *
 * @module @map-harness/spatial-accessibility/tencent
 */
import { AccessibilityError, type AccessibilityErrorCode } from './errors.ts'
import { sha256Hex, type ExtentBox, type LonLat, type TravelMode } from './contract.ts'
import type { NetworkNode, NetworkProvider, PoiPage } from './network.ts'

/** Tencent network source id. */
export const TENCENT_NETWORK_ID = 'tencent-road-network'
/** Default environment variable containing the Tencent map key. */
export const DEFAULT_TENCENT_API_KEY_ENV = 'TENCENT_MAP_KEY'
/** Compatibility alias for callers that name the credential as a map key. */
export const DEFAULT_TENCENT_MAP_KEY_ENV = DEFAULT_TENCENT_API_KEY_ENV
/** Tencent location REST root. */
export const TENCENT_BASE_URL = 'https://apis.map.qq.com'
/** Tencent Place v1 page-size ceiling. */
export const TENCENT_MAX_PAGE_SIZE = 20
/** Bounded identical-query pagination window. */
export const TENCENT_PAGE_WINDOW_ROWS = 500
/** Maximum lattice nodes sampled for a service area. */
export const TENCENT_MAX_LATTICE_NODES = 512
/** Minimum sampling spacing in degrees. */
export const TENCENT_MIN_SPACING_DEG = 0.00001
/** Maximum route nodes returned to the caller. */
export const TENCENT_MAX_ROUTE_NODES = 1024
/** Default request timeout. */
export const DEFAULT_TENCENT_TIMEOUT_MS = 10_000

const PRICED_MODES: readonly TravelMode[] = ['walk', 'drive']

/** Injectable fetch seam used by fixture tests. */
export interface TencentFetch {
  (url: string, init: { readonly signal?: AbortSignal }): Promise<{
    readonly ok: boolean
    readonly status: number
    text(): Promise<string>
  }>
}

/** Tencent adapter construction options. */
export interface TencentProviderConfig {
  readonly apiKey: string
  readonly apiKeyEnv: string
  readonly bbox: ExtentBox
  readonly spacingDeg?: number
  readonly timeoutMs?: number
  readonly fetchImpl?: TencentFetch
  readonly baseUrl?: string
}

/** Common vendor capability declaration shape. */
export interface TencentCapabilityDeclaration {
  readonly vendor: string
  readonly networkId: string
  readonly mappable: readonly { readonly face: string; readonly mapping: string }[]
  readonly shrunk: readonly { readonly face: string; readonly vendorFact: string; readonly behavior: string }[]
}

/** Load-bearing capability statement for the Tencent adapter. */
export const TENCENT_CAPABILITY_DECLARATION: TencentCapabilityDeclaration = {
  vendor: 'tencent',
  networkId: TENCENT_NETWORK_ID,
  mappable: [
    { face: 'route walk/drive', mapping: 'one Direction v1 call; duration seconds / 60, distance metres / 1000, decoded polyline folded into nodes' },
    { face: 'serviceArea', mapping: 'bounded sampling lattice routed from the origin; samples within the budget are returned' },
    { face: 'readPois', mapping: 'Place v1 rectangle search with bounded page_index/page_size' },
    { face: 'cancellation', mapping: 'AbortSignal is checked before and during every transport call' },
  ],
  shrunk: [
    { face: 'bike', vendorFact: 'the selected Direction v1 faces are driving and walking', behavior: 'bike fails METHOD_NOT_APPLICABLE' },
    { face: 'barriers', vendorFact: 'the route endpoints accept no barrier geometry', behavior: 'barriers fail ACCESS_INVALID_INPUT' },
    { face: 'time-slice pricing', vendorFact: 'route duration is the vendor estimate, not a slice model', behavior: 'slice is accepted without changing vendor pricing' },
    { face: 'network version', vendorFact: 'the API exposes no road-data snapshot identity', behavior: 'networkRef identifies bbox and spacing only' },
    { face: 'coordinate datum', vendorFact: 'the web service accepts geographic lon/lat pairs', behavior: 'coordinates pass through unchanged' },
    { face: 'pagination window', vendorFact: 'Place v1 reads are bounded per identical query', behavior: `reads past ${TENCENT_PAGE_WINDOW_ROWS} rows report RATE_LIMITED` },
  ],
}

/** Limitation sentences carried by Tencent evidence. */
export const TENCENT_PROVIDER_LIMITATIONS: readonly string[] = [
  'tencent durations are the vendor current estimates; time slices do not change pricing',
  'service areas are sampled at the adapter lattice spacing',
  'tencent route coordinates pass through without an unverified datum transform',
  `tencent place reads are bounded to ${TENCENT_PAGE_WINDOW_ROWS} rows per identical query`,
]

/** Classify a Tencent status/message into the existing error vocabulary. */
export function classifyTencentFailure(status: unknown, message: unknown = undefined): AccessibilityErrorCode {
  const code = Number(status)
  const text = typeof message === 'string' ? message.toLowerCase() : ''
  if ([110, 310].includes(code) || /key|密钥|权限|授权/.test(text)) return 'PERMISSION_DENIED'
  if ([120, 121, 122, 311, 312].includes(code) || /超限|频繁|配额|quota|limit/.test(text)) return 'RATE_LIMITED'
  if ([100, 101, 200].includes(code) || /参数|格式|invalid/.test(text)) return 'ACCESS_INVALID_INPUT'
  if (/无法规划|没有结果|无路线|not found|no route/.test(text)) return 'ACCESS_NOT_FOUND'
  return 'TEMPORARILY_UNAVAILABLE'
}

type TencentBody = {
  readonly status?: unknown
  readonly message?: unknown
  readonly result?: unknown
}

/** Narrow one Tencent route result to distance, duration and decoded path. */
export interface TencentRouteResult {
  readonly metres: number
  readonly seconds: number
  readonly path: readonly LonLat[]
}

/** Decode Tencent's delta-encoded 1e-6 latitude/longitude polyline. */
export function decodeTencentPolyline(value: unknown): readonly LonLat[] {
  if (!Array.isArray(value) || value.length < 2) return []
  const numbers = value.map(Number)
  if (numbers.some(number => !Number.isFinite(number))) return []
  const decoded: LonLat[] = []
  let lat = numbers[0]!
  let lon = numbers[1]!
  const scale = Math.abs(lat) > 90 || Math.abs(lon) > 180 ? 1e6 : 1
  if (scale === 1) {
    for (let index = 0; index + 1 < numbers.length; index += 2) {
      const pairLat = numbers[index]!
      const pairLon = numbers[index + 1]!
      if (Math.abs(pairLat) > 90 || Math.abs(pairLon) > 180) return []
      decoded.push([pairLon, pairLat])
    }
    return decoded
  }
  lat /= scale
  lon /= scale
  decoded.push([lon, lat])
  for (let index = 2; index + 1 < numbers.length; index += 2) {
    lat += numbers[index]! / 1e6
    lon += numbers[index + 1]! / 1e6
    decoded.push([lon, lat])
  }
  return decoded
}

/** Parse a Tencent Directions body without trusting arbitrary nested values. */
export function parseTencentRoute(body: TencentBody): TencentRouteResult | undefined {
  const result = body.result as { readonly routes?: unknown } | undefined
  const routes = result?.routes
  if (!Array.isArray(routes) || routes.length === 0) return undefined
  const first = routes[0] as { readonly distance?: unknown; readonly duration?: unknown; readonly polyline?: unknown }
  const metres = Number(first.distance)
  const seconds = Number(first.duration)
  if (!Number.isFinite(metres) || !Number.isFinite(seconds) || metres < 0 || seconds < 0) return undefined
  return { metres, seconds, path: decodeTencentPolyline(first.polyline) }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function nodeIdOf(lon: number, lat: number): string {
  return `tencent-${Math.round(lon * 1e6)}-${Math.round(lat * 1e6)}`
}

function distanceKm(a: LonLat, b: LonLat): number {
  const mid = ((a[1] + b[1]) / 2) * Math.PI / 180
  const x = (b[0] - a[0]) * Math.PI / 180 * Math.cos(mid)
  const y = (b[1] - a[1]) * Math.PI / 180
  return Math.sqrt(x * x + y * y) * 6371
}

/** Stable provider identity for one support extent and sampling spacing. */
export function tencentNetworkRefFor(config: { readonly bbox: ExtentBox; readonly spacingDeg?: number }): string {
  const digest = sha256Hex(JSON.stringify({ id: TENCENT_NETWORK_ID, bbox: config.bbox, spacing: config.spacingDeg ?? 0.01 })).slice(0, 16)
  return `${TENCENT_NETWORK_ID}-${digest}@1`
}

/** Create a Tencent NetworkProvider. */
export function createTencentNetworkProvider(config: TencentProviderConfig): NetworkProvider {
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', `the tencent provider requires the credential environment variable ${config.apiKeyEnv} to hold a non-empty key at construction`)
  }
  if (config.bbox.some(value => !Number.isFinite(value))) throw new AccessibilityError('ACCESS_INVALID_INPUT', 'provider bbox must be finite numbers')
  const spacing = Math.max(config.spacingDeg ?? 0.01, TENCENT_MIN_SPACING_DEG)
  const [west, south, east, north] = config.bbox
  const cols = Math.max(2, Math.floor((east - west) / spacing) + 1)
  const rows = Math.max(2, Math.floor((north - south) / spacing) + 1)
  if (cols * rows > TENCENT_MAX_LATTICE_NODES) throw new AccessibilityError('ACCESS_INVALID_INPUT', `the tencent sampling lattice would need ${cols * rows} nodes; at most ${TENCENT_MAX_LATTICE_NODES} are allowed`)
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? DEFAULT_TENCENT_TIMEOUT_MS, 1000), 60_000)
  const doFetch: TencentFetch = config.fetchImpl ?? ((url, init) => fetch(url, init))
  const baseUrl = config.baseUrl ?? TENCENT_BASE_URL
  const nodes: NetworkNode[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const lon = Math.min(round6(west + col * spacing), round6(east))
      const lat = Math.min(round6(south + row * spacing), round6(north))
      nodes.push({ id: nodeIdOf(lon, lat), lon, lat })
    }
  }

  async function vendorGet(path: string, query: Readonly<Record<string, string>>, signal: AbortSignal | undefined): Promise<TencentBody> {
    if (signal?.aborted) signal.throwIfAborted()
    const params = new URLSearchParams(query)
    params.set('key', config.apiKey)
    params.set('output', 'json')
    const requestSignal = signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
    const response = await doFetch(`${baseUrl}${path}?${params.toString()}`, { signal: requestSignal })
    const text = await response.text()
    if (!response.ok) throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', `tencent transport answered http ${response.status} without a vendor body`)
    let body: unknown
    try { body = JSON.parse(text) } catch { throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'tencent transport answered a non-JSON body') }
    const record = body as TencentBody
    if (Number(record.status) !== 0) {
      const code = classifyTencentFailure(record.status, record.message)
      const detail = typeof record.message === 'string' ? record.message.replaceAll(config.apiKey, '[redacted]').slice(0, 120) : 'vendor request failed'
      throw new AccessibilityError(code, `tencent refused the request (status ${String(record.status)}: ${detail})`)
    }
    return record
  }

  function vendorCoord(point: LonLat): string {
    return `${round6(point[1])},${round6(point[0])}`
  }

  function refuseBarriers(barriers: readonly unknown[] | undefined): void {
    if (barriers !== undefined && barriers.length > 0) throw new AccessibilityError('ACCESS_INVALID_INPUT', 'the tencent provider does not support barrier segments; run this spec on the controlled provider or drop the barriers')
  }

  async function vendorRoute(origin: LonLat, destination: LonLat, mode: TravelMode, signal: AbortSignal | undefined): Promise<{ readonly minutes: number; readonly distanceKm: number; readonly nodes: readonly string[] }> {
    const path = mode === 'drive' ? '/ws/direction/v1/driving/' : '/ws/direction/v1/walking/'
    const body = await vendorGet(path, { from: vendorCoord(origin), to: vendorCoord(destination) }, signal)
    const parsed = parseTencentRoute(body)
    if (parsed === undefined) {
      const text = typeof body.message === 'string' ? body.message.toLowerCase() : ''
      if (/无法规划|没有结果|无路线|no route/.test(text)) throw new AccessibilityError('ACCESS_NOT_FOUND', 'tencent returned no route path between the requested points')
      throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'tencent answered a route body without usable distance/duration fields')
    }
    const pathNodes: string[] = [nodeIdOf(round6(origin[0]), round6(origin[1]))]
    for (const [lon, lat] of parsed.path) {
      const id = nodeIdOf(round6(lon), round6(lat))
      if (pathNodes[pathNodes.length - 1] !== id) pathNodes.push(id)
    }
    const end = nodeIdOf(round6(destination[0]), round6(destination[1]))
    if (pathNodes[pathNodes.length - 1] !== end) pathNodes.push(end)
    const bounded = pathNodes.length <= TENCENT_MAX_ROUTE_NODES ? pathNodes : pathNodes.filter((_, index) => index % Math.ceil(pathNodes.length / TENCENT_MAX_ROUTE_NODES) === 0 || index === pathNodes.length - 1)
    return { minutes: parsed.seconds / 60, distanceKm: parsed.metres / 1000, nodes: bounded }
  }

  return {
    networkId: TENCENT_NETWORK_ID,
    networkRef: tencentNetworkRefFor({ bbox: config.bbox, ...(config.spacingDeg === undefined ? {} : { spacingDeg: config.spacingDeg }) }),
    pricesMode: mode => PRICED_MODES.includes(mode),
    snapPoint(point) {
      let best: { node: NetworkNode; snapKm: number } | undefined
      for (const node of nodes) {
        const snapKm = distanceKm(point, [node.lon, node.lat])
        if (best === undefined || snapKm < best.snapKm) best = { node, snapKm }
      }
      if (best === undefined) throw new AccessibilityError('ACCESS_STATE', 'the tencent sampling lattice carries no node')
      return best
    },
    async serviceArea(origin, budgetMinutes, options) {
      if (!PRICED_MODES.includes(options.mode)) throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the tencent network does not price mode ${options.mode} (walking/driving only)`)
      refuseBarriers(options.barriers)
      const reached: { id: string; lon: number; lat: number; minutes: number }[] = [{ id: nodeIdOf(round6(origin[0]), round6(origin[1])), lon: round6(origin[0]), lat: round6(origin[1]), minutes: 0 }]
      let served = 1
      for (const node of nodes) {
        options.signal?.throwIfAborted()
        if (node.id === reached[0]?.id) continue
        try {
          const route = await vendorRoute(origin, [node.lon, node.lat], options.mode, options.signal)
          served += 1
          if (route.minutes <= budgetMinutes) reached.push({ id: node.id, lon: node.lon, lat: node.lat, minutes: route.minutes })
        } catch (error: unknown) {
          if (error instanceof AccessibilityError && error.code === 'ACCESS_NOT_FOUND') continue
          throw error
        }
      }
      if (served <= 1) throw new AccessibilityError('ACCESS_NOT_FOUND', 'tencent could route to no sampling node of the support extent')
      return { origin, budgetMinutes, nodes: reached }
    },
    async route(origin, destination, options) {
      if (!PRICED_MODES.includes(options.mode)) throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the tencent network does not price mode ${options.mode} (walking/driving only)`)
      refuseBarriers(options.barriers)
      return vendorRoute(origin, destination, options.mode, options.signal)
    },
    async readPois(bbox, options): Promise<PoiPage> {
      if (options.page < 0 || options.pageSize < 1 || options.pageSize > TENCENT_MAX_PAGE_SIZE) throw new AccessibilityError('ACCESS_INVALID_INPUT', `tencent place page_size must be between 1 and ${TENCENT_MAX_PAGE_SIZE}`)
      const [west, south, east, north] = bbox
      const body = await vendorGet('/ws/place/v1/search', {
        boundary: `rectangle(${round6(south)},${round6(west)};${round6(north)},${round6(east)})`,
        keyword: '*',
        page_size: String(options.pageSize),
        page_index: String(options.page + 1),
      }, options.signal)
      const result = body.result as { readonly count?: unknown; readonly data?: unknown } | undefined
      const total = Number(result?.count)
      if (!Number.isFinite(total) || total < 0) throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'tencent place search answered without a usable count')
      const start = options.page * options.pageSize
      if (start >= TENCENT_PAGE_WINDOW_ROWS && total > TENCENT_PAGE_WINDOW_ROWS) throw new AccessibilityError('RATE_LIMITED', `tencent place pagination window exhausted (${TENCENT_PAGE_WINDOW_ROWS} rows per identical query)`)
      const items: { id: string; coordinates: LonLat }[] = []
      if (Array.isArray(result?.data)) {
        for (const item of result.data as readonly { readonly id?: unknown; readonly location?: unknown }[]) {
          const location = item.location as { readonly lng?: unknown; readonly lat?: unknown } | undefined
          const lon = Number(location?.lng)
          const lat = Number(location?.lat)
          if (typeof item.id === 'string' && item.id.length > 0 && Number.isFinite(lon) && Number.isFinite(lat)) items.push({ id: item.id, coordinates: [round6(lon), round6(lat)] })
        }
      }
      const hasMore = total > TENCENT_PAGE_WINDOW_ROWS ? start + items.length < TENCENT_PAGE_WINDOW_ROWS : start + items.length < total
      return { items, page: options.page, total, hasMore }
    },
  }
}
