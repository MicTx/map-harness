/**
 * The Amap (高德) road-network adapter: the second configured network source
 * of this deployment, enabled by a deployment Config choice plus a user-held
 * API key. It maps the vendor's Web-service route planning (v3
 * `direction/driving` / `direction/walking`) and polygon POI search (v3
 * `place/polygon`) onto the {@link NetworkProvider} face the coverage
 * computation consumes, and maps every vendor failure onto the existing
 * {@link AccessibilityError} codes without inventing new protocol vocabulary.
 *
 * ## Capability declaration (mappable face)
 *
 * - `networkId`/`networkRef`: `amap-road-network-<digest>@1`; the digest
 *   covers the sampling bbox and spacing only — Amap exposes no road-data
 *   version identity, so the ref identifies the adapter configuration, never
 *   a vendor data snapshot (and never the API key). Deployments that need a
 *   TLS or mirror root set {@link AmapProviderConfig.baseUrl}; omission keeps
 *   {@link AMAP_BASE_URL}.
 * - `route`: one vendor route call per mode (`walk`, `drive`); minutes and
 *   kilometres come from the vendor's `duration` (seconds) and `distance`
 *   (metres); path nodes are the quantised returned polyline.
 * - `serviceArea`: the vendor has no isochrone service. The adapter routes
 *   from the origin to every node of its deterministic sampling lattice over
 *   the support extent and keeps the samples whose real route minutes fit the
 *   budget — a sampled service area whose resolution is bounded by the
 *   lattice spacing.
 * - `readPois`: `place/polygon` with the vendor pagination (`page` 1-based,
 *   `offset` ≤ 25); an empty page beyond the total carries no items.
 * - `snapPoint`: nearest sampling-lattice node, straight-line.
 * - `pricesMode`: `walk` and `drive` only.
 * - Cancellation: every vendor call carries the caller's `AbortSignal` into
 *   the transport and is checked between calls; aborts surface as
 *   `AbortError` from real checkpoints, never as a Promise timeout.
 *
 * ## Declared shrinks (unmappable face, honest not fabricated)
 *
 * See {@link AMAP_CAPABILITY_DECLARATION}; each entry names the face, the
 * vendor fact behind the shrink, and the loud behavior callers observe.
 *
 * @module @map-harness/spatial-accessibility/amap
 */
import { AccessibilityError, type AccessibilityErrorCode } from './errors.ts'
import { sha256Hex, type ExtentBox, type LonLat, type TravelMode } from './contract.ts'
import type { NetworkProvider, NetworkNode, PoiPage } from './network.ts'

/** The Amap network source id this adapter serves. */
export const AMAP_NETWORK_ID = 'amap-road-network'

/** Environment variable the deployment Config references for the API key. */
export const DEFAULT_AMAP_API_KEY_ENV = 'AMAP_API_KEY'

/**
 * The Amap Web-service REST root. Protocol constant; deployments that need a
 * TLS or mirror root set {@link AmapProviderConfig.baseUrl}.
 */
export const AMAP_BASE_URL = 'https://restapi.amap.com'

/**
 * The largest page size the vendor place API reliably serves (`offset` ≤ 25
 * per the vendor pagination contract); larger requests are the caller's to
 * avoid and surface as vendor `INVALID_PARAMS`.
 */
export const AMAP_MAX_PAGE_SIZE = 25

/**
 * The vendor place API serves at most 200 rows per identical query ("同请求
 * 参数翻页查询最多支持获取200条数据"). Reads that need more rows stop at the
 * window edge with `RATE_LIMITED` so a collection reports `partial`, never a
 * reshaped complete read.
 */
export const AMAP_PAGE_WINDOW_ROWS = 200

/** Maximum sampling-lattice nodes one adapter may route per service area. */
export const AMAP_MAX_LATTICE_NODES = 512

/** Minimum sampling spacing in degrees (≈1 m); a denser lattice is refused. */
export const AMAP_MIN_SPACING_DEG = 0.00001

/** Maximum returned route nodes; longer vendor polylines are stride-sampled. */
export const AMAP_MAX_ROUTE_NODES = 1024

/** Default per-request transport timeout in milliseconds. */
export const DEFAULT_AMAP_TIMEOUT_MS = 10_000

/** The modes the vendor route services this adapter prices. */
const PRICED_MODES: readonly TravelMode[] = ['walk', 'drive']

/** Structural subset of `fetch` the adapter needs; injectable for fixtures. */
export interface AmapFetch {
  /** One GET against the vendor endpoint. */
  (url: string, init: { readonly signal?: AbortSignal }): Promise<{
    readonly ok: boolean
    readonly status: number
    text(): Promise<string>
  }>
}

/** Adapter construction options. */
export interface AmapProviderConfig {
  /** The resolved API key value; held in memory only, never in refs, logs, or errors. */
  readonly apiKey: string
  /**
   * Environment-variable name the key was resolved through; used in loud
   * failure text (the name only — never the value).
   */
  readonly apiKeyEnv: string
  /** The support extent the sampling lattice tiles; service areas stay inside it. */
  readonly bbox: ExtentBox
  /** Sampling-lattice spacing in degrees; bounds service-area resolution and vendor-call volume. */
  readonly spacingDeg?: number
  /** Per-request transport timeout in milliseconds (1000–60000). */
  readonly timeoutMs?: number
  /** Transport seam; defaults to the global `fetch`. */
  readonly fetchImpl?: AmapFetch
  /** Vendor root override; defaults to {@link AMAP_BASE_URL}. */
  readonly baseUrl?: string
}

/** The structured capability/limitation declaration of this adapter. */
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
export const AMAP_CAPABILITY_DECLARATION: VendorCapabilityDeclaration = {
  vendor: 'amap',
  networkId: AMAP_NETWORK_ID,
  mappable: [
    { face: 'route walk/drive', mapping: 'one v3 direction call; minutes = duration seconds / 60, kilometres = distance metres / 1000, nodes = quantised polyline' },
    { face: 'serviceArea', mapping: 'routes from the origin to every sampling-lattice node; nodes kept whose real route minutes fit the budget' },
    { face: 'readPois', mapping: 'v3 place/polygon over the bbox with vendor pagination (page 1-based, offset ≤ 25)' },
    { face: 'cancellation', mapping: 'caller AbortSignal checked between calls and carried into every vendor request' },
  ],
  shrunk: [
    { face: 'bike', vendorFact: 'v3 walking/driving share one response shape; the bicycling service uses a different v4 response face', behavior: 'pricesMode(bike) is false; a bike target fails METHOD_NOT_APPLICABLE' },
    { face: 'barriers', vendorFact: 'the route services take no barrier input', behavior: 'barrier segments fail ACCESS_INVALID_INPUT naming the shrink; they are never silently ignored' },
    { face: 'time-slice pricing', vendorFact: 'durations are the vendor\'s current real-time estimates; no per-slice factors exist', behavior: 'the slice parameter is accepted and does not change pricing; evidence limitations state it' },
    { face: 'network version', vendorFact: 'Amap exposes no road-data version identity', behavior: 'networkRef digests the adapter configuration (bbox + spacing), never a vendor data snapshot and never the key' },
    { face: 'coordinate datum', vendorFact: 'Amap serves GCJ-02; the harness contract is WGS84', behavior: 'inputs are transformed WGS84→GCJ-02 with the community-documented approximation and outputs back; the residual datum error is declared in the limitations' },
    { face: 'POI directory scope', vendorFact: 'place/polygon without keywords/types queries the vendor-default category set (商务住宅/交通设施服务)', behavior: 'readPois returns that category directory, not the complete POI universe; stated in limitations' },
    { face: 'pagination window', vendorFact: 'at most 200 rows per identical query', behavior: `reads needing more rows stop at the window edge with RATE_LIMITED so collections report partial (window = ${AMAP_PAGE_WINDOW_ROWS} rows)` },
  ],
}

/** The limitation sentences adapter results carry; mirrors the shrunk faces above. */
export const AMAP_PROVIDER_LIMITATIONS: readonly string[] = [
  'amap durations are the vendor\'s current real-time estimates; time slices do not change pricing',
  'service areas are sampled at the adapter lattice spacing; resolution is bounded by that spacing',
  'amap serves GCJ-02; coordinates cross the datum through the community-documented approximation',
  'amap place reads query the vendor-default category set and at most 200 rows per identical query',
  'amap exposes no road-data version identity; networkRef identifies the adapter configuration, not a vendor data snapshot',
]

/** Vendor infocodes this adapter maps onto `PERMISSION_DENIED`. */
const INFOCODE_PERMISSION: ReadonlySet<string> = new Set([
  '10001', '10002', '10005', '10006', '10007', '10008', '10009', '10012', '10013', '10041', '20011', '40002',
])

/** Vendor infocodes this adapter maps onto `RATE_LIMITED`. */
const INFOCODE_RATE: ReadonlySet<string> = new Set([
  '10003', '10004', '10010', '10014', '10015', '10019', '10020', '10021', '10029', '10044', '10045', '40000', '40003',
])

/** Vendor infocodes this adapter maps onto `ACCESS_INVALID_INPUT`. */
const INFOCODE_INVALID: ReadonlySet<string> = new Set(['20000', '20001', '20002', '20803'])

/** Vendor infocodes this adapter maps onto `ACCESS_NOT_FOUND` (no routable network). */
const INFOCODE_NOT_FOUND: ReadonlySet<string> = new Set(['20800', '20801', '20802'])

/**
 * Classify one vendor `infocode` onto the existing accessibility error
 * vocabulary. Unknown codes fall back to `TEMPORARILY_UNAVAILABLE`: an
 * unrecognised vendor failure is never reshaped into a semantic answer.
 * @param infocode - the vendor `infocode` string (for example `10001`).
 * @returns the existing code the vendor failure maps onto.
 */
export function classifyAmapInfocode(infocode: string): AccessibilityErrorCode {
  if (INFOCODE_PERMISSION.has(infocode)) return 'PERMISSION_DENIED'
  if (INFOCODE_RATE.has(infocode)) return 'RATE_LIMITED'
  if (INFOCODE_INVALID.has(infocode)) return 'ACCESS_INVALID_INPUT'
  if (INFOCODE_NOT_FOUND.has(infocode)) return 'ACCESS_NOT_FOUND'
  if (infocode.startsWith('3')) return 'TEMPORARILY_UNAVAILABLE'
  return 'TEMPORARILY_UNAVAILABLE'
}

/** Build the accessibility failure for one vendor error body (no key material ever enters the text). */
function vendorFailure(infocode: unknown, info: unknown): AccessibilityError {
  const codeText = typeof infocode === 'string' ? infocode : String(infocode ?? 'unknown')
  const code = classifyAmapInfocode(codeText)
  const infoText = typeof info === 'string' && info.length > 0 ? info.slice(0, 120) : 'vendor request failed'
  // infocode/info are vendor diagnostics; the API key travels in the URL only
  // and must never reach message text.
  return new AccessibilityError(code, `amap refused the request (infocode ${codeText}: ${infoText})`)
}

// ---------------------------------------------------------------------------
// Coordinate datum: WGS84 (harness contract) ↔ GCJ-02 (Amap services).
// The transform is the community-documented approximation of China's offset
// datum; Amap publishes no exact inverse, so the round trip carries a small
// residual error (typically a few metres), which the limitations declare.
// ---------------------------------------------------------------------------

/** Krassovsky ellipsoid constants of the community GCJ-02 approximation. */
const GCJ_A = 6378245
const GCJ_EE = 0.00669342162296594323

/** Whether a point lies inside the region China's offset datum applies to. */
function insideChina(lon: number, lat: number): boolean {
  return lon >= 72.004 && lon <= 137.8347 && lat >= 0.8293 && lat <= 55.8271
}

/** The latitude-side offset polynomial of the GCJ-02 approximation (input in local degree offsets). */
function transformLatOffset(x: number, y: number): number {
  let offset = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  offset += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3
  offset += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3
  offset += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3
  return offset
}

/** The longitude-side offset polynomial of the GCJ-02 approximation (input in local degree offsets). */
function transformLonOffset(x: number, y: number): number {
  let offset = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  offset += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3
  offset += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3
  return offset
}

/** The GCJ-02 offset of one point, in degrees. */
function gcjOffset(lon: number, lat: number): [number, number] {
  const x = lon - 105
  const y = lat - 35
  const radLat = lat / 180 * Math.PI
  let magic = 1 - GCJ_EE * Math.sin(radLat) * Math.sin(radLat)
  const sqrtMagic = Math.sqrt(magic)
  const dLat = (transformLatOffset(x, y) * 180) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI)
  const dLon = (transformLonOffset(x, y) * 180) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI)
  return [dLon, dLat]
}

/** Transform WGS84 to the GCJ-02 datum the vendor services expect; points outside China pass through unchanged. */
function wgs84ToGcj02(point: LonLat): [number, number] {
  const [lon, lat] = point
  if (!insideChina(lon, lat) || !Number.isFinite(lon) || !Number.isFinite(lat)) return [lon, lat]
  const [dLon, dLat] = gcjOffset(lon, lat)
  return [lon + dLon, lat + dLat]
}

/** Approximate inverse: GCJ-02 back to WGS84 by subtracting the forward offset at the GCJ point (residual error declared). */
function gcj02ToWgs84(lon: number, lat: number): [number, number] {
  if (!insideChina(lon, lat)) return [lon, lat]
  const [dLon, dLat] = gcjOffset(lon, lat)
  return [lon - dLon, lat - dLat]
}

/** Round one coordinate to the 1e-6 grid the vendor and node ids share. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Deterministic node id of one WGS84 point on the 1e-6 grid. */
function nodeIdOf(lon: number, lat: number): string {
  return `amap-${Math.round(lon * 1e6)}-${Math.round(lat * 1e6)}`
}

/** Great-circle distance in km between two WGS84 points (equirectangular approximation over small spans). */
function distanceKm(a: LonLat, b: LonLat): number {
  const midLatRad = ((a[1] + b[1]) / 2) * Math.PI / 180
  const dLon = (b[0] - a[0]) * Math.PI / 180
  const dLat = (b[1] - a[1]) * Math.PI / 180
  const x = dLon * Math.cos(midLatRad)
  return Math.sqrt(x * x + dLat * dLat) * 6371
}

/** One vendor JSON body narrowed to the fields this adapter reads. */
type AmapBody = { readonly status?: unknown; readonly info?: unknown; readonly infocode?: unknown; readonly count?: unknown; readonly pois?: unknown; readonly route?: unknown }

/**
 * The network version identity of one adapter configuration. The digest
 * covers the sampling shape only: the API key must never enter a ref that
 * evidence and logs carry.
 * @param config - the sampling bbox and spacing.
 * @returns `amap-road-network-<16 hex>@1`.
 */
export function amapNetworkRefFor(config: { readonly bbox: ExtentBox; readonly spacingDeg?: number }): string {
  const spacing = config.spacingDeg ?? 0.01
  const digest = sha256Hex(JSON.stringify({ id: AMAP_NETWORK_ID, bbox: config.bbox, spacing })).slice(0, 16)
  return `${AMAP_NETWORK_ID}-${digest}@1`
}

/**
 * Create the Amap road-network provider. Construction validates the
 * configuration and fails loud (`ACCESS_INVALID_INPUT`) on an unusable
 * extent, spacing, empty key, or an oversized sampling lattice; nothing
 * degrades silently to another source.
 * @param config - resolved key (value), its env name, sampling shape, timeout, root override, and transport.
 * @returns the provider.
 * @throws {AccessibilityError} `ACCESS_INVALID_INPUT` on an unusable configuration.
 */
export function createAmapNetworkProvider(config: AmapProviderConfig): NetworkProvider {
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', `the amap provider requires the credential environment variable ${config.apiKeyEnv} to hold a non-empty key at construction`)
  }
  if (config.bbox.some(v => !Number.isFinite(v))) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', 'provider bbox must be finite numbers')
  }
  const spacing = Math.max(config.spacingDeg ?? 0.01, AMAP_MIN_SPACING_DEG)
  const [west, south, east, north] = config.bbox
  const cols = Math.max(2, Math.floor((east - west) / spacing) + 1)
  const rows = Math.max(2, Math.floor((north - south) / spacing) + 1)
  if (cols * rows > AMAP_MAX_LATTICE_NODES) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', `the amap sampling lattice would need ${cols * rows} nodes; at most ${AMAP_MAX_LATTICE_NODES} are allowed — widen the spacing or narrow the support extent`)
  }
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? DEFAULT_AMAP_TIMEOUT_MS, 1000), 60_000)
  const doFetch: AmapFetch = config.fetchImpl ?? ((url, init) => fetch(url, init))
  const baseUrl = config.baseUrl ?? AMAP_BASE_URL

  /** The deterministic sampling lattice over the support extent. */
  const nodes: NetworkNode[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const lon = Math.min(round6(west + col * spacing), round6(east))
      const lat = Math.min(round6(south + row * spacing), round6(north))
      nodes.push({ id: nodeIdOf(lon, lat), lon, lat })
    }
  }

  /**
   * One vendor GET: combines the caller signal with the request timeout,
   * refuses non-2xx and non-JSON bodies, and maps `status:"0"` bodies onto
   * the accessibility vocabulary.
   */
  async function vendorGet(path: string, query: Readonly<Record<string, string>>, signal: AbortSignal | undefined): Promise<AmapBody> {
    if (signal?.aborted) signal.throwIfAborted()
    const params = new URLSearchParams(query)
    // The key rides in the query only; it never enters messages or refs.
    params.set('key', config.apiKey)
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
    const response = await doFetch(`${baseUrl}${path}?${params.toString()}`, { signal: requestSignal })
    const text = await response.text()
    if (!response.ok) {
      throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', `amap transport answered http ${response.status} without a vendor body`)
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'amap transport answered a non-JSON body')
    }
    const record = body as AmapBody
    if (record.status !== '1') {
      throw vendorFailure(record.infocode, record.info)
    }
    return record
  }

  /** Format one WGS84 point as the vendor `lon,lat` (≤6 decimals, GCJ-02). */
  function vendorCoord(point: LonLat): string {
    const [lon, lat] = wgs84ToGcj02(point)
    return `${round6(lon)},${round6(lat)}`
  }

  /** One vendor route call; returns minutes, kilometres, and the quantised polyline node ids. */
  async function vendorRoute(origin: LonLat, destination: LonLat, mode: TravelMode, signal: AbortSignal | undefined): Promise<{ minutes: number; distanceKm: number; nodes: string[] }> {
    const path = mode === 'drive' ? '/v3/direction/driving' : '/v3/direction/walking'
    const body = await vendorGet(path, { origin: vendorCoord(origin), destination: vendorCoord(destination) }, signal)
    const paths = (body.route as { readonly paths?: unknown } | undefined)?.paths
    if (!Array.isArray(paths) || paths.length === 0) {
      throw new AccessibilityError('ACCESS_NOT_FOUND', 'amap returned no route path between the requested points')
    }
    const first = paths[0] as { readonly distance?: unknown; readonly duration?: unknown; readonly steps?: unknown }
    const metres = Number(first.distance)
    const seconds = Number(first.duration)
    if (!Number.isFinite(metres) || !Number.isFinite(seconds) || metres < 0 || seconds < 0) {
      throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'amap returned a route path without usable distance/duration fields')
    }
    const nodesOfPath: string[] = [nodeIdOf(origin[0], origin[1])]
    if (Array.isArray(first.steps)) {
      for (const step of first.steps as readonly { readonly polyline?: unknown }[]) {
        if (typeof step.polyline !== 'string') continue
        for (const vertex of step.polyline.split(';')) {
          const [lonText, latText] = vertex.split(',')
          const lon = Number(lonText)
          const lat = Number(latText)
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
          const [wgsLon, wgsLat] = gcj02ToWgs84(lon, lat)
          const id = nodeIdOf(round6(wgsLon), round6(wgsLat))
          if (nodesOfPath[nodesOfPath.length - 1] !== id) nodesOfPath.push(id)
        }
      }
    }
    nodesOfPath.push(nodeIdOf(destination[0], destination[1]))
    // Bound the returned path: stride-sample long vendor polylines, keep the endpoints.
    const bounded = nodesOfPath.length <= AMAP_MAX_ROUTE_NODES
      ? nodesOfPath
      : nodesOfPath.filter((_, index) => index % Math.ceil(nodesOfPath.length / AMAP_MAX_ROUTE_NODES) === 0 || index === nodesOfPath.length - 1)
    return { minutes: seconds / 60, distanceKm: metres / 1000, nodes: bounded }
  }

  /** Refuse barrier segments loudly: the vendor takes no barrier input (declared shrink). */
  function refuseBarriers(barriers: readonly unknown[] | undefined): void {
    if (barriers !== undefined && barriers.length > 0) {
      throw new AccessibilityError('ACCESS_INVALID_INPUT', 'the amap provider does not support barrier segments; run this spec on the controlled provider or drop the barriers')
    }
  }

  return {
    networkId: AMAP_NETWORK_ID,
    networkRef: amapNetworkRefFor({ bbox: config.bbox, ...(config.spacingDeg === undefined ? {} : { spacingDeg: config.spacingDeg }) }),
    pricesMode(mode) {
      return PRICED_MODES.includes(mode)
    },
    snapPoint(point) {
      let best: { node: NetworkNode; snapKm: number } | undefined
      for (const node of nodes) {
        const snapKm = distanceKm(point, [node.lon, node.lat])
        if (best === undefined || snapKm < best.snapKm) best = { node, snapKm }
      }
      if (best === undefined) throw new AccessibilityError('ACCESS_STATE', 'the amap sampling lattice carries no node')
      return best
    },
    async serviceArea(origin, budgetMinutes, options) {
      if (!PRICED_MODES.includes(options.mode)) {
        throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the amap network does not price mode ${options.mode} (v3 walking/driving only)`)
      }
      refuseBarriers(options.barriers)
      const reached: { id: string; lon: number; lat: number; minutes: number }[] = [{
        id: nodeIdOf(round6(origin[0]), round6(origin[1])),
        lon: round6(origin[0]),
        lat: round6(origin[1]),
        minutes: 0,
      }]
      let served = 1
      for (const node of nodes) {
        // Real checkpoint: cancellation lands between vendor calls.
        options.signal?.throwIfAborted()
        if (node.id === reached[0]?.id) continue
        try {
          const route = await vendorRoute(origin, [node.lon, node.lat], options.mode, options.signal)
          served += 1
          if (route.minutes <= budgetMinutes) {
            reached.push({ id: node.id, lon: node.lon, lat: node.lat, minutes: route.minutes })
          }
        } catch (error: unknown) {
          if (error instanceof AccessibilityError && error.code === 'ACCESS_NOT_FOUND') {
            // The vendor states no routable network reaches this sample: a
            // network fact, not a failure — the sample stays out of the area.
            continue
          }
          // Rate/permission/unavailable and aborts fail the whole area loud;
          // a partial sample sweep is never reshaped into a complete one.
          throw error
        }
      }
      if (served <= 1) {
        throw new AccessibilityError('ACCESS_NOT_FOUND', 'amap could route to no sampling node of the support extent (out of service region or no roads nearby)')
      }
      return { origin, budgetMinutes, nodes: reached }
    },
    async route(origin, destination, options) {
      if (!PRICED_MODES.includes(options.mode)) {
        throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the amap network does not price mode ${options.mode} (v3 walking/driving only)`)
      }
      refuseBarriers(options.barriers)
      const route = await vendorRoute(origin, destination, options.mode, options.signal)
      return { minutes: route.minutes, distanceKm: route.distanceKm, nodes: route.nodes }
    },
    async readPois(bbox, options): Promise<PoiPage> {
      const start = options.page * options.pageSize
      const [w, s, e, n] = bbox
      const northWest = wgs84ToGcj02([w, n])
      const southEast = wgs84ToGcj02([e, s])
      const body = await vendorGet('/v3/place/polygon', {
        polygon: `${round6(northWest[0])},${round6(northWest[1])}|${round6(southEast[0])},${round6(southEast[1])}`,
        offset: String(options.pageSize),
        page: String(options.page + 1),
      }, options.signal)
      const total = Number(body.count)
      if (!Number.isFinite(total) || total < 0) {
        throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'amap place search answered without a usable count')
      }
      if (start >= AMAP_PAGE_WINDOW_ROWS && total > AMAP_PAGE_WINDOW_ROWS) {
        throw new AccessibilityError('RATE_LIMITED', `amap place pagination window exhausted (${AMAP_PAGE_WINDOW_ROWS} rows per identical query) while ${total} matched; a larger read reports partial, never a reshaped complete one`)
      }
      const items: { id: string; coordinates: LonLat }[] = []
      if (Array.isArray(body.pois)) {
        for (const poi of body.pois as readonly { readonly id?: unknown; readonly location?: unknown }[]) {
          if (typeof poi.id !== 'string' || poi.id.length === 0 || typeof poi.location !== 'string') continue
          const [lonText, latText] = poi.location.split(',')
          const lon = Number(lonText)
          const lat = Number(latText)
          if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
          const [wgsLon, wgsLat] = gcj02ToWgs84(lon, lat)
          items.push({ id: poi.id, coordinates: [round6(wgsLon), round6(wgsLat)] })
        }
      }
      // Within the window, page against the true count. Past the window edge
      // with a larger true count, keep `hasMore` true so the next request
      // throws RATE_LIMITED and collections report partial — a 200-row read
      // of a larger directory is never labeled complete.
      const hasMore = total > AMAP_PAGE_WINDOW_ROWS ? start < AMAP_PAGE_WINDOW_ROWS : start + items.length < total
      return { items, page: options.page, total, hasMore }
    },
  }
}
