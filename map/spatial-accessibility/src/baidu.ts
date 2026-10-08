/**
 * Baidu Maps road-network adapter. The adapter maps the stable Baidu
 * Direction Lite and Place v2 JSON faces onto the NetworkProvider contract.
 * Unsupported faces fail loudly; no request silently falls back to another
 * network source.
 *
 * @module @map-harness/spatial-accessibility/baidu
 */
import { AccessibilityError, type AccessibilityErrorCode } from './errors.ts'
import { sha256Hex, type ExtentBox, type LonLat, type TravelMode } from './contract.ts'
import type { NetworkNode, NetworkProvider, PoiPage } from './network.ts'

/** Baidu network source id. */
export const BAIDU_NETWORK_ID = 'baidu-road-network'
/** Default environment variable containing the Baidu AK. */
export const DEFAULT_BAIDU_API_KEY_ENV = 'BAIDU_API_KEY'
/** Baidu Maps REST root. */
export const BAIDU_BASE_URL = 'https://api.map.baidu.com'
/** Baidu Place v2 page-size ceiling. */
export const BAIDU_MAX_PAGE_SIZE = 20
/** Baidu Place v2 identical-query window used by the adapter. */
export const BAIDU_PAGE_WINDOW_ROWS = 400
/** Maximum lattice nodes sampled for a service area. */
export const BAIDU_MAX_LATTICE_NODES = 512
/** Minimum sampling spacing in degrees. */
export const BAIDU_MIN_SPACING_DEG = 0.00001
/** Maximum route nodes returned to the caller. */
export const BAIDU_MAX_ROUTE_NODES = 1024
/** Default request timeout. */
export const DEFAULT_BAIDU_TIMEOUT_MS = 10_000

const PRICED_MODES: readonly TravelMode[] = ['walk', 'drive']

/** Injectable fetch seam used by fixture tests. */
export interface BaiduFetch {
  (url: string, init: { readonly signal?: AbortSignal }): Promise<{
    readonly ok: boolean
    readonly status: number
    text(): Promise<string>
  }>
}

/** Baidu adapter construction options. */
export interface BaiduProviderConfig {
  readonly apiKey: string
  readonly apiKeyEnv: string
  readonly bbox: ExtentBox
  readonly spacingDeg?: number
  readonly timeoutMs?: number
  readonly fetchImpl?: BaiduFetch
  readonly baseUrl?: string
}

/** Common vendor capability declaration shape shared by all LBS adapters. */
export interface BaiduCapabilityDeclaration {
  readonly vendor: string
  readonly networkId: string
  readonly mappable: readonly { readonly face: string; readonly mapping: string }[]
  readonly shrunk: readonly { readonly face: string; readonly vendorFact: string; readonly behavior: string }[]
}

/** Load-bearing capability statement for the Baidu adapter. */
export const BAIDU_CAPABILITY_DECLARATION: BaiduCapabilityDeclaration = {
  vendor: 'baidu',
  networkId: BAIDU_NETWORK_ID,
  mappable: [
    { face: 'route walk/drive', mapping: 'one Direction Lite call; duration seconds / 60, distance metres / 1000, steps path folded into nodes' },
    { face: 'serviceArea', mapping: 'bounded sampling lattice routed from the origin; samples within the budget are returned' },
    { face: 'readPois', mapping: 'Place v2 search with bounded page_num/page_size over the requested bounds' },
    { face: 'cancellation', mapping: 'AbortSignal is checked before and during every transport call' },
  ],
  shrunk: [
    { face: 'bike', vendorFact: 'the selected Direction Lite faces are driving and walking', behavior: 'bike fails METHOD_NOT_APPLICABLE' },
    { face: 'barriers', vendorFact: 'the route endpoints accept no barrier geometry', behavior: 'barriers fail ACCESS_INVALID_INPUT' },
    { face: 'time-slice pricing', vendorFact: 'route duration is the vendor estimate, not a slice model', behavior: 'slice is accepted without changing vendor pricing' },
    { face: 'network version', vendorFact: 'the API exposes no road-data snapshot identity', behavior: 'networkRef identifies bbox and spacing only' },
    { face: 'coordinate datum', vendorFact: 'Baidu uses BD-09 coordinates', behavior: 'coordinates pass through as the configured provider convention' },
    { face: 'pagination window', vendorFact: 'Place v2 has a bounded page window per identical query', behavior: `reads past ${BAIDU_PAGE_WINDOW_ROWS} rows report RATE_LIMITED` },
  ],
}

/** Limitation sentences carried by Baidu evidence. */
export const BAIDU_PROVIDER_LIMITATIONS: readonly string[] = [
  'baidu durations are the vendor current estimates; time slices do not change pricing',
  'service areas are sampled at the adapter lattice spacing',
  'baidu coordinates use the vendor BD-09 convention; no unverified datum transform is invented',
  `baidu place reads are bounded to ${BAIDU_PAGE_WINDOW_ROWS} rows per identical query`,
]

/** Classify a Baidu status/message into the existing error vocabulary. */
export function classifyBaiduFailure(status: unknown, message: unknown = undefined): AccessibilityErrorCode {
  const code = typeof status === 'number' ? status : Number(status)
  const text = typeof message === 'string' ? message.toLowerCase() : ''
  if (code === 3 || code === 5 || /ak|key|权限|授权|认证/.test(text)) return 'PERMISSION_DENIED'
  if (code === 4 || /配额|超限|频繁|quota|limit/.test(text)) return 'RATE_LIMITED'
  if (code === 2 || /参数|格式|invalid/.test(text)) return 'ACCESS_INVALID_INPUT'
  if (/无结果|没有路线|无法规划|not found|no route/.test(text)) return 'ACCESS_NOT_FOUND'
  return 'TEMPORARILY_UNAVAILABLE'
}

type BaiduBody = {
  readonly status?: unknown
  readonly message?: unknown
  readonly total?: unknown
  readonly results?: unknown
  readonly result?: unknown
}

/** Narrow one route result to the fields used by the provider. */
export interface BaiduRouteResult {
  readonly metres: number
  readonly seconds: number
  readonly path: readonly LonLat[]
}

/** Parse a Direction Lite body without trusting arbitrary nested values. */
export function parseBaiduRoute(body: BaiduBody): BaiduRouteResult | undefined {
  const result = body.result as { readonly routes?: unknown } | undefined
  const routes = result?.routes
  if (!Array.isArray(routes) || routes.length === 0) return undefined
  const first = routes[0] as { readonly distance?: unknown; readonly duration?: unknown; readonly steps?: unknown }
  const metres = Number(first.distance)
  const seconds = Number(first.duration)
  if (!Number.isFinite(metres) || !Number.isFinite(seconds) || metres < 0 || seconds < 0) return undefined
  const path: LonLat[] = []
  if (Array.isArray(first.steps)) {
    for (const step of first.steps as readonly { readonly path?: unknown }[]) {
      if (typeof step.path !== 'string') continue
      for (const vertex of step.path.split(';')) {
        const [lonText, latText] = vertex.split(',')
        const lon = Number(lonText)
        const lat = Number(latText)
        if (Number.isFinite(lon) && Number.isFinite(lat)) path.push([lon, lat])
      }
    }
  }
  return { metres, seconds, path }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

function nodeIdOf(lon: number, lat: number): string {
  return `baidu-${Math.round(lon * 1e6)}-${Math.round(lat * 1e6)}`
}

function distanceKm(a: LonLat, b: LonLat): number {
  const mid = ((a[1] + b[1]) / 2) * Math.PI / 180
  const x = (b[0] - a[0]) * Math.PI / 180 * Math.cos(mid)
  const y = (b[1] - a[1]) * Math.PI / 180
  return Math.sqrt(x * x + y * y) * 6371
}

/** Stable provider identity for one support extent and sampling spacing. */
export function baiduNetworkRefFor(config: { readonly bbox: ExtentBox; readonly spacingDeg?: number }): string {
  const digest = sha256Hex(JSON.stringify({ id: BAIDU_NETWORK_ID, bbox: config.bbox, spacing: config.spacingDeg ?? 0.01 })).slice(0, 16)
  return `${BAIDU_NETWORK_ID}-${digest}@1`
}

/** Create a Baidu NetworkProvider. */
export function createBaiduNetworkProvider(config: BaiduProviderConfig): NetworkProvider {
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', `the baidu provider requires the credential environment variable ${config.apiKeyEnv} to hold a non-empty key at construction`)
  }
  if (config.bbox.some(value => !Number.isFinite(value))) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', 'provider bbox must be finite numbers')
  }
  const spacing = Math.max(config.spacingDeg ?? 0.01, BAIDU_MIN_SPACING_DEG)
  const [west, south, east, north] = config.bbox
  const cols = Math.max(2, Math.floor((east - west) / spacing) + 1)
  const rows = Math.max(2, Math.floor((north - south) / spacing) + 1)
  if (cols * rows > BAIDU_MAX_LATTICE_NODES) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', `the baidu sampling lattice would need ${cols * rows} nodes; at most ${BAIDU_MAX_LATTICE_NODES} are allowed`)
  }
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? DEFAULT_BAIDU_TIMEOUT_MS, 1000), 60_000)
  const doFetch: BaiduFetch = config.fetchImpl ?? ((url, init) => fetch(url, init))
  const baseUrl = config.baseUrl ?? BAIDU_BASE_URL
  const nodes: NetworkNode[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const lon = Math.min(round6(west + col * spacing), round6(east))
      const lat = Math.min(round6(south + row * spacing), round6(north))
      nodes.push({ id: nodeIdOf(lon, lat), lon, lat })
    }
  }

  async function vendorGet(path: string, query: Readonly<Record<string, string>>, signal: AbortSignal | undefined): Promise<BaiduBody> {
    if (signal?.aborted) signal.throwIfAborted()
    const params = new URLSearchParams(query)
    params.set('ak', config.apiKey)
    params.set('output', 'json')
    const requestSignal = signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
    const response = await doFetch(`${baseUrl}${path}?${params.toString()}`, { signal: requestSignal })
    const text = await response.text()
    if (!response.ok) throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', `baidu transport answered http ${response.status} without a vendor body`)
    let body: unknown
    try { body = JSON.parse(text) } catch { throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'baidu transport answered a non-JSON body') }
    const record = body as BaiduBody
    if (Number(record.status) !== 0) {
      const code = classifyBaiduFailure(record.status, record.message)
      const detail = typeof record.message === 'string' ? record.message.replaceAll(config.apiKey, '[redacted]').slice(0, 120) : 'vendor request failed'
      throw new AccessibilityError(code, `baidu refused the request (status ${String(record.status)}: ${detail})`)
    }
    return record
  }

  function vendorCoord(point: LonLat): string {
    return `${round6(point[1])},${round6(point[0])}`
  }

  function refuseBarriers(barriers: readonly unknown[] | undefined): void {
    if (barriers !== undefined && barriers.length > 0) throw new AccessibilityError('ACCESS_INVALID_INPUT', 'the baidu provider does not support barrier segments; run this spec on the controlled provider or drop the barriers')
  }

  async function vendorRoute(origin: LonLat, destination: LonLat, mode: TravelMode, signal: AbortSignal | undefined): Promise<{ readonly minutes: number; readonly distanceKm: number; readonly nodes: readonly string[] }> {
    const path = mode === 'drive' ? '/directionlite/v1/driving' : '/directionlite/v1/walking'
    const body = await vendorGet(path, { origin: vendorCoord(origin), destination: vendorCoord(destination) }, signal)
    const parsed = parseBaiduRoute(body)
    if (parsed === undefined) {
      const text = typeof body.message === 'string' ? body.message.toLowerCase() : ''
      if (/无结果|没有路线|无法规划|no route/.test(text)) throw new AccessibilityError('ACCESS_NOT_FOUND', 'baidu returned no route path between the requested points')
      throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'baidu answered a route body without usable distance/duration fields')
    }
    const pathNodes: string[] = [nodeIdOf(round6(origin[0]), round6(origin[1]))]
    for (const [lon, lat] of parsed.path) {
      const id = nodeIdOf(round6(lon), round6(lat))
      if (pathNodes[pathNodes.length - 1] !== id) pathNodes.push(id)
    }
    const end = nodeIdOf(round6(destination[0]), round6(destination[1]))
    if (pathNodes[pathNodes.length - 1] !== end) pathNodes.push(end)
    const bounded = pathNodes.length <= BAIDU_MAX_ROUTE_NODES ? pathNodes : pathNodes.filter((_, index) => index % Math.ceil(pathNodes.length / BAIDU_MAX_ROUTE_NODES) === 0 || index === pathNodes.length - 1)
    return { minutes: parsed.seconds / 60, distanceKm: parsed.metres / 1000, nodes: bounded }
  }

  return {
    networkId: BAIDU_NETWORK_ID,
    networkRef: baiduNetworkRefFor({ bbox: config.bbox, ...(config.spacingDeg === undefined ? {} : { spacingDeg: config.spacingDeg }) }),
    pricesMode: mode => PRICED_MODES.includes(mode),
    snapPoint(point) {
      let best: { node: NetworkNode; snapKm: number } | undefined
      for (const node of nodes) {
        const snapKm = distanceKm(point, [node.lon, node.lat])
        if (best === undefined || snapKm < best.snapKm) best = { node, snapKm }
      }
      if (best === undefined) throw new AccessibilityError('ACCESS_STATE', 'the baidu sampling lattice carries no node')
      return best
    },
    async serviceArea(origin, budgetMinutes, options) {
      if (!PRICED_MODES.includes(options.mode)) throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the baidu network does not price mode ${options.mode} (walking/driving only)`)
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
      if (served <= 1) throw new AccessibilityError('ACCESS_NOT_FOUND', 'baidu could route to no sampling node of the support extent')
      return { origin, budgetMinutes, nodes: reached }
    },
    async route(origin, destination, options) {
      if (!PRICED_MODES.includes(options.mode)) throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the baidu network does not price mode ${options.mode} (walking/driving only)`)
      refuseBarriers(options.barriers)
      return vendorRoute(origin, destination, options.mode, options.signal)
    },
    async readPois(bbox, options): Promise<PoiPage> {
      if (options.page < 0 || options.pageSize < 1 || options.pageSize > BAIDU_MAX_PAGE_SIZE) throw new AccessibilityError('ACCESS_INVALID_INPUT', `baidu place page_size must be between 1 and ${BAIDU_MAX_PAGE_SIZE}`)
      const [west, south, east, north] = bbox
      const body = await vendorGet('/place/v2/search', {
        query: '*',
        bounds: `${round6(south)},${round6(west)},${round6(north)},${round6(east)}`,
        page_num: String(options.page),
        page_size: String(options.pageSize),
      }, options.signal)
      const total = Number(body.total)
      if (!Number.isFinite(total) || total < 0) throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'baidu place search answered without a usable total')
      const start = options.page * options.pageSize
      if (start >= BAIDU_PAGE_WINDOW_ROWS && total > BAIDU_PAGE_WINDOW_ROWS) throw new AccessibilityError('RATE_LIMITED', `baidu place pagination window exhausted (${BAIDU_PAGE_WINDOW_ROWS} rows per identical query)`)
      const items: { id: string; coordinates: LonLat }[] = []
      if (Array.isArray(body.results)) {
        for (const result of body.results as readonly { readonly uid?: unknown; readonly location?: unknown }[]) {
          const location = result.location as { readonly lng?: unknown; readonly lat?: unknown } | undefined
          const lon = Number(location?.lng)
          const lat = Number(location?.lat)
          if (typeof result.uid === 'string' && result.uid.length > 0 && Number.isFinite(lon) && Number.isFinite(lat)) items.push({ id: result.uid, coordinates: [round6(lon), round6(lat)] })
        }
      }
      const hasMore = total > BAIDU_PAGE_WINDOW_ROWS ? start + items.length < BAIDU_PAGE_WINDOW_ROWS : start + items.length < total
      return { items, page: options.page, total, hasMore }
    },
  }
}
