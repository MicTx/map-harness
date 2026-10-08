/**
 * The Tianditu (天地图) road-network adapter: a configured network source of
 * this deployment, enabled by a deployment Config choice plus a user-held key.
 * It maps the vendor's driving-plan Web service (`/drive`, XML response) onto
 * the {@link NetworkProvider} `route` face the coverage computation consumes,
 * and maps every vendor failure onto the existing {@link AccessibilityError}
 * codes without inventing new protocol vocabulary.
 *
 * ## Capability declaration (mappable face)
 *
 * - `networkId`/`networkRef`: `tianditu-road-network-<digest>@1`; the digest
 *   covers the support bbox only — Tianditu exposes no road-data version
 *   identity, so the ref identifies the adapter configuration, never a vendor
 *   data snapshot (and never the API key).
 * - `route`: one vendor `/drive` call per priced mode. `walk` maps to `style`
 *   3 and `drive` to `style` 0 (fastest). Minutes come from the vendor's
 *   `<duration>` (seconds / 60) and kilometres from `<distance>` (already
 *   kilometres — unlike Amap's metres). Path nodes are the quantised
 *   `routelatlon` polyline.
 * - `pricesMode`: `walk` and `drive` only.
 * - Cancellation: every vendor call carries the caller's `AbortSignal` into
 *   the transport and is checked before the call; aborts surface as
 *   `AbortError` from real checkpoints, never as a Promise timeout.
 * - Coordinate datum: Tianditu serves CGCS2000. At the analysis granularity
 *   this package computes, CGCS2000 and the harness WGS84 contract differ by
 *   less than a metre, so coordinates pass through unchanged — the explicit
 *   counterpart of the Amap adapter's GCJ-02 transform. The pass-through is a
 *   declared fact, pinned by tests, not an omission.
 *
 * ## Declared shrinks (unmappable face, honest not fabricated)
 *
 * See {@link TIANDITU_CAPABILITY_DECLARATION}; each entry names the face, the
 * vendor fact behind the shrink, and the loud behavior callers observe.
 *
 * @module @map-harness/spatial-accessibility/tianditu
 */
import { AccessibilityError, type AccessibilityErrorCode } from './errors.ts'
import { sha256Hex, type ExtentBox, type LonLat, type TravelMode } from './contract.ts'
import type { NetworkProvider, NetworkNode, PoiPage } from './network.ts'

/** The Tianditu network source id this adapter serves. */
export const TIANDITU_NETWORK_ID = 'tianditu-road-network'

/** Environment variable the deployment Config references for the API key (`tk`). */
export const DEFAULT_TIANDITU_API_KEY_ENV = 'TIANDITU_API_KEY'

/**
 * The Tianditu driving-plan REST root. The vendor documents `http://` as the
 * protocol constant; deployments that require TLS set the Config `baseUrl`,
 * which reaches {@link TiandituProviderConfig.baseUrl}.
 */
export const TIANDITU_BASE_URL = 'http://api.tianditu.gov.cn'

/** Vendor `style` for the fastest driving route (the drive mode mapping). */
export const TIANDITU_STYLE_FASTEST = '0'

/** Vendor `style` for the shortest driving route (documented, not the default mapping). */
export const TIANDITU_STYLE_SHORTEST = '1'

/** Vendor `style` for driving that avoids expressways (documented, not the default mapping). */
export const TIANDITU_STYLE_AVOID_HIGHWAY = '2'

/** Vendor `style` for walking (the walk mode mapping). */
export const TIANDITU_STYLE_WALK = '3'

/** Maximum returned route nodes; longer vendor polylines are stride-sampled. */
export const TIANDITU_MAX_ROUTE_NODES = 1024

/** Default per-request transport timeout in milliseconds. */
export const DEFAULT_TIANDITU_TIMEOUT_MS = 10_000

/** The modes the vendor route service this adapter prices. */
const PRICED_MODES: readonly TravelMode[] = ['walk', 'drive']

/** Structural subset of `fetch` the adapter needs; injectable for fixtures. */
export interface TiandituFetch {
  /** One GET against the vendor endpoint. */
  (url: string, init: { readonly signal?: AbortSignal }): Promise<{
    readonly ok: boolean
    readonly status: number
    text(): Promise<string>
  }>
}

/** Adapter construction options. */
export interface TiandituProviderConfig {
  /** The resolved API key value (`tk`); held in memory only, never in refs, logs, or errors. */
  readonly apiKey: string
  /**
   * Environment-variable name the key was resolved through; used in loud
   * failure text (the name only — never the value).
   */
  readonly apiKeyEnv: string
  /** The support extent the provider identity digests; routes are not clipped to it. */
  readonly bbox: ExtentBox
  /** Per-request transport timeout in milliseconds (1000–60000). */
  readonly timeoutMs?: number
  /** Transport seam; defaults to the global `fetch`. */
  readonly fetchImpl?: TiandituFetch
  /** Vendor root override; defaults to {@link TIANDITU_BASE_URL}. */
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
export const TIANDITU_CAPABILITY_DECLARATION: VendorCapabilityDeclaration = {
  vendor: 'tianditu',
  networkId: TIANDITU_NETWORK_ID,
  mappable: [
    { face: 'route walk/drive', mapping: 'one /drive call; style 3 for walk and style 0 for drive; minutes = duration seconds / 60, kilometres = distance kilometres, nodes = quantised routelatlon polyline' },
    { face: 'cancellation', mapping: 'caller AbortSignal checked before the call and carried into every vendor request' },
  ],
  shrunk: [
    { face: 'serviceArea', vendorFact: 'Tianditu publishes no isochrone or service-area API', behavior: 'serviceArea fails METHOD_NOT_APPLICABLE; the adapter never approximates an isochrone by sampling routes' },
    { face: 'readPois', vendorFact: 'the driving-plan service returns routes, not a paginated POI directory', behavior: 'readPois fails METHOD_NOT_APPLICABLE; POI search is a different vendor service and is not mapped' },
    { face: 'bike', vendorFact: 'the documented styles are fastest/shortest/avoid-highway driving and walking; no cycling style exists', behavior: 'pricesMode(bike) is false; a bike target fails METHOD_NOT_APPLICABLE' },
    { face: 'barriers', vendorFact: 'the driving-plan service takes no barrier input', behavior: 'barrier segments fail ACCESS_INVALID_INPUT naming the shrink; they are never silently ignored' },
    { face: 'time-slice pricing', vendorFact: 'durations are the vendor\'s current estimates; no per-slice factors exist', behavior: 'the slice parameter is accepted and does not change pricing; evidence limitations state it' },
    { face: 'network version', vendorFact: 'Tianditu exposes no road-data version identity', behavior: 'networkRef digests the adapter configuration (bbox), never a vendor data snapshot and never the key' },
    { face: 'coordinate datum', vendorFact: 'Tianditu serves CGCS2000; the difference from WGS84 is below analysis granularity', behavior: 'coordinates pass through unchanged; the pass-through is declared, unlike the Amap GCJ-02 transform' },
    { face: 'via points', vendorFact: 'the vendor accepts mid waypoints, but the provider route face is origin-to-destination', behavior: 'mid is never sent; the adapter does not invent intermediate stops' },
  ],
}

/** The limitation sentences adapter results carry; mirrors the shrunk faces above. */
export const TIANDITU_PROVIDER_LIMITATIONS: readonly string[] = [
  'tianditu durations are the vendor\'s current estimates; time slices do not change pricing',
  'tianditu publishes no isochrone API; service areas fail loud instead of being approximated from route samples',
  'tianditu serves CGCS2000; coordinates pass through unchanged because the WGS84 difference is below analysis granularity',
  'tianditu exposes no road-data version identity; networkRef identifies the adapter configuration, not a vendor data snapshot',
]

/**
 * One classified vendor failure. The vendor publishes no error-code table for
 * the driving-plan service, so classification follows the response forms the
 * fixture lane pins: an auth/key refusal, a quota refusal, an unroutable pair,
 * and everything else (including an unexpected response form).
 */
export type TiandituFailureKind = 'permission' | 'rate' | 'not-found' | 'invalid' | 'unexpected'

/**
 * Classify one vendor failure form onto the existing accessibility error
 * vocabulary. `unexpected` covers a response whose form the documented schema
 * does not describe; its message must say the response form was unexpected.
 * @param kind - the observed response form.
 * @returns the existing code the vendor failure maps onto.
 */
export function classifyTiandituFailure(kind: TiandituFailureKind): AccessibilityErrorCode {
  if (kind === 'permission') return 'PERMISSION_DENIED'
  if (kind === 'rate') return 'RATE_LIMITED'
  if (kind === 'not-found') return 'ACCESS_NOT_FOUND'
  if (kind === 'invalid') return 'ACCESS_INVALID_INPUT'
  return 'TEMPORARILY_UNAVAILABLE'
}

/** Round one coordinate to the 1e-6 grid the node ids share. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Deterministic node id of one point on the 1e-6 grid. */
function nodeIdOf(lon: number, lat: number): string {
  return `tianditu-${Math.round(lon * 1e6)}-${Math.round(lat * 1e6)}`
}

/**
 * Read the text of one XML element. The driving-plan response is a fixed
 * schema (`<result>` root, `<distance>`, `<duration>`, `<routelatlon>`); this
 * reads that schema only and never evaluates markup. Attributes, nested
 * markup, and a missing element all return `undefined`.
 * @param xml - the vendor response text.
 * @param tag - the element name.
 * @returns the decoded text, or `undefined` when the element is absent.
 */
export function readXmlText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)
  if (match === null) return undefined
  const raw = match[1] ?? ''
  if (raw.includes('<')) return undefined
  return raw
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
    .trim()
}

/** The fields one successful driving-plan response carries. */
interface DriveResult {
  readonly kilometres: number
  readonly seconds: number
  readonly polyline: readonly LonLat[]
}

/**
 * Narrow one vendor XML body to a usable driving-plan result. A body that is
 * not the documented `<result>` schema returns `undefined` so the caller can
 * fail it as an unexpected response form.
 * @param xml - the vendor response text.
 * @returns the parsed result, or `undefined` when the schema does not match.
 */
export function parseDriveXml(xml: string): DriveResult | undefined {
  if (!xml.includes('<result>') || !xml.includes('</result>')) return undefined
  const distance = Number(readXmlText(xml, 'distance'))
  const duration = Number(readXmlText(xml, 'duration'))
  const line = readXmlText(xml, 'routelatlon')
  if (!Number.isFinite(distance) || !Number.isFinite(duration) || distance < 0 || duration < 0) return undefined
  if (line === undefined || line.length === 0) return undefined
  const polyline: LonLat[] = []
  for (const vertex of line.split(';')) {
    if (vertex.length === 0) continue
    const [lonText, latText] = vertex.split(',')
    const lon = Number(lonText)
    const lat = Number(latText)
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined
    polyline.push([lon, lat])
  }
  if (polyline.length === 0) return undefined
  return { kilometres: distance, seconds: duration, polyline }
}

/** Observed vendor refusal forms, matched against the response text (never against the key). */
const PERMISSION_MARKERS = ['密钥', '权限', 'key', 'tk', '非法']
const RATE_MARKERS = ['配额', '访问超限', '请求超限', '频繁']
const NOT_FOUND_MARKERS = ['无法规划', '没有结果', '无结果', '未找到']
const INVALID_MARKERS = ['参数', '格式错误', '经纬度']

/** Classify a non-schema vendor body by the markers it carries. */
function failureKindOf(text: string): TiandituFailureKind {
  const folded = text.toLowerCase()
  if (PERMISSION_MARKERS.some(marker => folded.includes(marker.toLowerCase()))) return 'permission'
  if (RATE_MARKERS.some(marker => folded.includes(marker))) return 'rate'
  if (NOT_FOUND_MARKERS.some(marker => folded.includes(marker))) return 'not-found'
  if (INVALID_MARKERS.some(marker => folded.includes(marker))) return 'invalid'
  return 'unexpected'
}

/** Build the accessibility failure for one vendor body (no key material ever enters the text). */
function vendorFailure(text: string): AccessibilityError {
  const kind = failureKindOf(text)
  const code = classifyTiandituFailure(kind)
  const excerpt = text.replaceAll(/\s+/g, ' ').slice(0, 120)
  if (kind === 'unexpected') {
    return new AccessibilityError(code, `tianditu answered an unexpected response form (${excerpt || 'empty body'})`)
  }
  return new AccessibilityError(code, `tianditu refused the request (${excerpt || kind})`)
}

/**
 * The network version identity of one adapter configuration. The digest
 * covers the support bbox only: the API key must never enter a ref that
 * evidence and logs carry.
 * @param config - the support bbox.
 * @returns `tianditu-road-network-<16 hex>@1`.
 */
export function tiandituNetworkRefFor(config: { readonly bbox: ExtentBox }): string {
  const digest = sha256Hex(JSON.stringify({ id: TIANDITU_NETWORK_ID, bbox: config.bbox })).slice(0, 16)
  return `${TIANDITU_NETWORK_ID}-${digest}@1`
}

/**
 * Create the Tianditu road-network provider. Construction validates the
 * configuration and fails loud (`ACCESS_INVALID_INPUT`) on an unusable
 * extent or an empty key; nothing degrades silently to another source.
 * @param config - resolved key (value), its env name, support bbox, timeout, and transport.
 * @returns the provider.
 * @throws {AccessibilityError} `ACCESS_INVALID_INPUT` on an unusable configuration.
 */
export function createTiandituNetworkProvider(config: TiandituProviderConfig): NetworkProvider {
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', `the tianditu provider requires the credential environment variable ${config.apiKeyEnv} to hold a non-empty key at construction`)
  }
  if (config.bbox.some(value => !Number.isFinite(value))) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', 'provider bbox must be finite numbers')
  }
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? DEFAULT_TIANDITU_TIMEOUT_MS, 1000), 60_000)
  const doFetch: TiandituFetch = config.fetchImpl ?? ((url, init) => fetch(url, init))
  const baseUrl = config.baseUrl ?? TIANDITU_BASE_URL

  /** Format one point as the vendor `lon,lat` string. CGCS2000 passes through. */
  function vendorCoord(point: LonLat): string {
    return `${round6(point[0])},${round6(point[1])}`
  }

  /** One vendor driving-plan GET. The key rides in `tk` only and never enters messages. */
  async function vendorDrive(origin: LonLat, destination: LonLat, mode: TravelMode, signal: AbortSignal | undefined): Promise<DriveResult> {
    if (signal?.aborted) signal.throwIfAborted()
    const postStr = JSON.stringify({
      orig: vendorCoord(origin),
      dest: vendorCoord(destination),
      style: mode === 'walk' ? TIANDITU_STYLE_WALK : TIANDITU_STYLE_FASTEST,
    })
    const params = new URLSearchParams({ postStr, type: 'search', tk: config.apiKey })
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(timeoutMs)
      : AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
    const response = await doFetch(`${baseUrl}/drive?${params.toString()}`, { signal: requestSignal })
    const text = await response.text()
    if (!response.ok) {
      throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', `tianditu transport answered http ${response.status} without a vendor body`)
    }
    const parsed = parseDriveXml(text)
    if (parsed !== undefined) return parsed
    throw vendorFailure(text)
  }

  /** Refuse barrier segments loudly: the vendor takes no barrier input (declared shrink). */
  function refuseBarriers(barriers: readonly unknown[] | undefined): void {
    if (barriers !== undefined && barriers.length > 0) {
      throw new AccessibilityError('ACCESS_INVALID_INPUT', 'the tianditu provider does not support barrier segments; run this spec on the controlled provider or drop the barriers')
    }
  }

  return {
    networkId: TIANDITU_NETWORK_ID,
    networkRef: tiandituNetworkRefFor({ bbox: config.bbox }),
    pricesMode(mode) {
      return PRICED_MODES.includes(mode)
    },
    snapPoint(point) {
      // No lattice: the vendor prices the point itself, so the snap is the point.
      const node: NetworkNode = { id: nodeIdOf(round6(point[0]), round6(point[1])), lon: round6(point[0]), lat: round6(point[1]) }
      return { node, snapKm: 0 }
    },
    serviceArea() {
      return Promise.reject(new AccessibilityError('METHOD_NOT_APPLICABLE', 'the tianditu provider does not support service areas: the vendor publishes no isochrone API, and route sampling is not a substitute'))
    },
    async route(origin, destination, options) {
      if (!PRICED_MODES.includes(options.mode)) {
        throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the tianditu network does not price mode ${options.mode} (driving styles and walking only)`)
      }
      refuseBarriers(options.barriers)
      const result = await vendorDrive(origin, destination, options.mode, options.signal)
      const nodes = [nodeIdOf(round6(origin[0]), round6(origin[1]))]
      for (const [lon, lat] of result.polyline) {
        const id = nodeIdOf(round6(lon), round6(lat))
        if (nodes[nodes.length - 1] !== id) nodes.push(id)
      }
      const end = nodeIdOf(round6(destination[0]), round6(destination[1]))
      if (nodes[nodes.length - 1] !== end) nodes.push(end)
      const bounded = nodes.length <= TIANDITU_MAX_ROUTE_NODES
        ? nodes
        : nodes.filter((_, index) => index % Math.ceil(nodes.length / TIANDITU_MAX_ROUTE_NODES) === 0 || index === nodes.length - 1)
      return { minutes: result.seconds / 60, distanceKm: result.kilometres, nodes: bounded }
    },
    readPois(): Promise<PoiPage> {
      return Promise.reject(new AccessibilityError('METHOD_NOT_APPLICABLE', 'the tianditu driving-plan provider does not serve a POI directory'))
    },
  }
}
