/**
 * The Tianditu browser-SDK road-network provider: driving routes priced by
 * the vendor JavaScript API running in a real browser page, for credentials
 * of the browser-end type that the vendor REST services refuse.
 */
import { createServer, type Server } from 'node:http'
import { sha256Hex, type ExtentBox, type TravelMode } from './contract.ts'
import { AccessibilityError } from './errors.ts'
import type { NetworkNode, NetworkProvider } from './network.ts'
import type { VendorCapabilityDeclaration } from './tianditu.ts'

/** The network id this provider serves; distinct from the REST `tianditu-road-network` lane. */
export const TIANDITU_SDK_NETWORK_ID = 'tianditu-sdk-road-network'

/** Environment-variable name the browser-end key resolves through by default. */
export const DEFAULT_TIANDITU_SDK_KEY_ENV = 'TIANDITU_SDK_KEY'

/** Same node ceiling as the REST tianditu lane; stride-sampled, never silently truncated to zero. */
export const TIANDITU_SDK_MAX_ROUTE_NODES = 1024

/** Default per-drive wall budget in milliseconds (page load + vendor call inside it). */
export const DEFAULT_TIANDITU_SDK_TIMEOUT_MS = 30_000

/**
 * The structured capability/limitation declaration of the SDK lane; mirrors
 * the REST sibling's discipline. Shrunk faces fail loud, never silently degrade.
 */
export const TIANDITU_SDK_CAPABILITY_DECLARATION: VendorCapabilityDeclaration = {
  vendor: 'tianditu-sdk',
  networkId: TIANDITU_SDK_NETWORK_ID,
  mappable: [
    { face: 'route drive', mapping: 'one T.DrivingRoute search per call inside a real browser page served from 127.0.0.1; minutes = plan duration seconds / 60, kilometres = plan distance, nodes = quantised SDK polyline (endpoints only when the plan carries no extractable polyline)' },
    { face: 'cancellation', mapping: 'caller AbortSignal closes the page (the in-flight vendor request dies with it); the session reopens a page on the next call' },
    { face: 'loader degradation', mapping: 'the vendor api script injects service classes in a second phase after onload; the page polls up to 10s before classifying a genuine stub build, which then fails TEMPORARILY_UNAVAILABLE with a retry hint and is never treated as a code defect' },
  ],
  shrunk: [
    { face: 'route walk', vendorFact: 'the SDK driving service exposes driving styles; a walking mapping is not verified', behavior: 'pricesMode(walk) is false; a walk target fails METHOD_NOT_APPLICABLE' },
    { face: 'serviceArea', vendorFact: 'the vendor publishes no isochrone API on either lane', behavior: 'serviceArea fails METHOD_NOT_APPLICABLE; route sampling is not a substitute' },
    { face: 'readPois', vendorFact: 'the SDK LocalSearch permission of the available browser-end keys is unverified', behavior: 'readPois fails METHOD_NOT_APPLICABLE; POI search stays on the lanes that own it' },
    { face: 'barriers', vendorFact: 'the SDK driving search takes no barrier input', behavior: 'barrier segments fail ACCESS_INVALID_INPUT naming the shrink' },
    { face: 'time-slice pricing', vendorFact: 'SDK durations are the vendor current estimates; no per-slice factors exist', behavior: 'the slice parameter is accepted and does not change pricing' },
    { face: 'network version', vendorFact: 'the SDK exposes no road-data version identity', behavior: 'networkRef digests the adapter configuration (bbox), never a vendor snapshot and never the key' },
    { face: 'coordinate datum', vendorFact: 'the SDK serves CGCS2000, same as the REST lane', behavior: 'coordinates pass through unchanged; the pass-through is declared' },
  ],
}

/** The limitation sentences SDK-lane adapter results carry; mirrors the shrunk faces above. */
export const TIANDITU_SDK_PROVIDER_LIMITATIONS: readonly string[] = [
  'tianditu-sdk durations are the vendor current estimates; time slices do not change pricing',
  'the tianditu SDK lane prices drive only; walk targets fail loud instead of being approximated',
  'the vendor loader injects service classes after onload; the page waits before classifying a stub, and a genuine stub reports as retryable, never as a code defect',
  'tianditu serves CGCS2000; coordinates pass through unchanged because the WGS84 difference is below analysis granularity',
  'tianditu exposes no road-data version identity; networkRef identifies the adapter configuration, not a vendor data snapshot',
]

/** One page the bridge holds open; the concrete face is a Playwright page, tests inject fakes. */
export interface SdkBrowserPage {
  /** Evaluate one expression in the page and await its value (promises resolve). */
  evaluate(expression: string): Promise<unknown>
  /** Close the page; in-flight evaluations reject. */
  close(): Promise<void>
}

/** The browser seam: opens pages at a URL. Tests inject fakes; the default is Playwright. */
export interface SdkBrowserBridge {
  /** Open one page at the given URL. */
  open(url: string): Promise<SdkBrowserPage>
  /** Release the browser (pages must be closed first). */
  close(): Promise<void>
}

/** The page-side outcome contract of `window.__sdkDrive`; plain JSON both directions. */
export interface SdkDriveOutcome {
  readonly ok: boolean
  /** Present when `ok`: plan duration in seconds (defensively extracted). */
  readonly seconds?: number
  /** Present when `ok`: plan distance in kilometres. */
  readonly kilometres?: number
  /** Present when `ok`: the plan polyline as `[lon, lat]` pairs; may be empty. */
  readonly polyline?: readonly (readonly [number, number])[]
  /** Present when `!ok`: `stub | no-plans | timeout | load-error | parse`. */
  readonly kind?: string
  /** Present when `!ok`: a short vendor-side detail without key material. */
  readonly detail?: string
}

/** The HTML page the provider serves on 127.0.0.1: the vendor script, the key in the body only. */
export const TIANDITU_SDK_PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<div id="map" style="width:480px;height:360px"></div>
<script>
(function () {
  var KEY = '__TIANDITU_SDK_KEY__'
  function resolve(outcome) { if (window.__sdkPending) { var p = window.__sdkPending; window.__sdkPending = null; p(outcome) } }
  function loadScript(src) {
    return new Promise(function (ok, fail) {
      var s = document.createElement('script')
      s.src = src
      s.onload = function () { ok() }
      s.onerror = function () { fail(new Error('vendor script load failed')) }
      document.head.appendChild(s)
    })
  }
  window.__sdkDrive = function (oLng, oLat, dLng, dLat) {
    return new Promise(function (settle) {
      window.__sdkPending = settle
      loadScript('https://api.tianditu.gov.cn/api?v=4.0&tk=' + encodeURIComponent(KEY)).then(function () {
        // The loader injects service classes in a second phase after onload:
        // poll briefly before classifying a genuine stub build.
        var waited = 0
        function servicesReady() {
          if (window.T && typeof T.DrivingRoute === 'function') { start(); return }
          if (waited >= 10000) { resolve({ ok: false, kind: 'stub', detail: 'vendor loader served no service classes within 10s of load' }); return }
          waited += 250
          setTimeout(servicesReady, 250)
        }
        function start() {
          var map
          try { map = new T.Map('map'); map.centerAndZoom(new T.LngLat(116.404, 39.915), 10) }
          catch (error) { resolve({ ok: false, kind: 'load-error', detail: 'map init failed' }); return }
          var settled = false
          new T.DrivingRoute(map, {
            onSearchComplete: function (result) {
              if (settled) return
              settled = true
              try {
                var plans = typeof result.getNumPlans === 'function' ? result.getNumPlans() : 0
                if (!plans) {
                  var status = typeof result.getStatus === 'function' ? String(result.getStatus()) : ''
                  resolve({ ok: false, kind: 'no-plans', detail: status || 'search completed without plans' })
                  return
                }
                var plan = result.getPlan(0)
                var seconds = null
                if (typeof plan.getDuration === 'function') seconds = plan.getDuration()
                if ((seconds === null || seconds === undefined) && typeof plan.getTime === 'function') seconds = plan.getTime()
                if (typeof seconds === 'string') seconds = Number(seconds.replace(/[^0-9.]/g, ''))
                if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) { resolve({ ok: false, kind: 'parse', detail: 'plan carried no usable duration field' }); return }
                var kilometres = typeof plan.getDistance === 'function' ? plan.getDistance() : null
                if (typeof kilometres === 'string') kilometres = Number(kilometres.replace(/[^0-9.]/g, ''))
                if (kilometres === null || kilometres === undefined || !Number.isFinite(kilometres)) { resolve({ ok: false, kind: 'parse', detail: 'plan carried no usable distance field' }); return }
                var polyline = []
                if (typeof plan.getPath === 'function') { polyline = plan.getPath() || [] }
                var pairs = []
                for (var index = 0; index < polyline.length; index++) {
                  var point = polyline[index]
                  var lon = point && typeof point.getLng === 'function' ? point.getLng() : (point && point.lng !== undefined ? point.lng : (point && point.lon !== undefined ? point.lon : null))
                  var lat = point && typeof point.getLat === 'function' ? point.getLat() : (point && point.lat !== undefined ? point.lat : null)
                  if (Number.isFinite(lon) && Number.isFinite(lat)) pairs.push([Number(lon), Number(lat)])
                }
                resolve({ ok: true, seconds: seconds, kilometres: kilometres, polyline: pairs })
              } catch (error) { resolve({ ok: false, kind: 'parse', detail: String(error && error.message ? error.message : error).slice(0, 120) }) }
            }
          }).search(new T.LngLat(oLng, oLat), new T.LngLat(dLng, dLat))
        }
        servicesReady()
      }).catch(function (error) { resolve({ ok: false, kind: 'load-error', detail: String(error && error.message ? error.message : error).slice(0, 120) }) })
      setTimeout(function () { resolve({ ok: false, kind: 'timeout', detail: 'sdk drive did not settle in time' }) }, 25000)
    })
  }
})()
</script>
</body>
</html>
`

/** Observed permission refusal markers, matched against page-side detail text (never against the key). */
const SDK_PERMISSION_MARKERS = ['密钥', '权限', '非法', 'key', 'tk', 'forbidden']

/**
 * Serve the SDK page on an ephemeral 127.0.0.1 port. The key is injected into
 * the response body only: it never appears in the URL, headers, or logs.
 * @param apiKey - the browser-end key value; held in memory only.
 * @returns the page URL and the close handle for the HTTP server.
 */
export async function createSdkPageServer(apiKey: string): Promise<{ readonly url: string; readonly close: () => Promise<void> }> {
  const html = TIANDITU_SDK_PAGE_HTML.replaceAll('__TIANDITU_SDK_KEY__', apiKey.replaceAll('\'', ''))
  const server: Server = createServer((request, response) => {
    if (request.url === '/' || request.url === '/index.html') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end(html)
      return
    }
    response.statusCode = 404
    response.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'the sdk page server could not bind a loopback port')
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error)))),
  }
}

/** The module-level default session: one page server and one Playwright bridge per key, reused across providers. */
interface DefaultSdkSession {
  readonly url: string
  readonly closeServer: () => Promise<void>
  readonly bridge: SdkBrowserBridge
  page: SdkBrowserPage | null
}

const defaultSessions = new Map<string, DefaultSdkSession>()

/**
 * Create the Playwright bridge. The import is dynamic and optional: without
 * `playwright` installed the lane fails loud with install guidance instead of
 * degrading to a headless HTTP mimicry of the SDK (which the project refuses).
 * @returns the bridge over one lazily-launched Chromium.
 */
export async function createPlaywrightSdkBridge(): Promise<SdkBrowserBridge> {
  type Launchable = { launch(options: { readonly headless: boolean }): Promise<BrowserLike> }
  type BrowserLike = {
    newPage(): Promise<PageLike>
    close(): Promise<void>
  }
  type PageLike = SdkBrowserPage & {
    goto(url: string, options: { readonly waitUntil: 'load'; readonly timeout: number }): Promise<unknown>
  }
  let chromium: Launchable
  try {
    const module = await import('playwright') as unknown as { chromium: Launchable }
    chromium = module.chromium
  } catch {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', 'the tianditu-sdk provider needs the optional peer dependency "playwright" installed (npm/pnpm add playwright, browsers via `playwright install chromium`); it never mimics the SDK over plain HTTP')
  }
  const browser = await chromium.launch({ headless: true })
  return {
    async open(url) {
      const page = await browser.newPage()
      await page.goto(url, { waitUntil: 'load', timeout: 20_000 }).catch(async error => {
        await page.close().catch(() => {})
        throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', `the sdk page failed to load (${String(error instanceof Error ? error.message : error).slice(0, 80)})`)
      })
      return page
    },
    close: () => browser.close(),
  }
}

/**
 * Open (or reuse) the default session for one key: page server plus Playwright
 * bridge plus one persistent page. Providers without an injected bridge share it.
 * @param apiKey - the browser-end key value.
 * @returns the live session.
 */
export async function openDefaultSdkSession(apiKey: string): Promise<DefaultSdkSession> {
  let session = defaultSessions.get(apiKey)
  if (session === undefined) {
    const server = await createSdkPageServer(apiKey)
    const bridge = await createPlaywrightSdkBridge()
    session = { url: server.url, closeServer: server.close, bridge, page: null }
    defaultSessions.set(apiKey, session)
  }
  return session
}

/**
 * Close every default session (servers, browsers, pages). Test hygiene hook;
 * production keeps one session for the process lifetime.
 * @returns a promise that settles once all sessions are closed.
 */
export async function closeDefaultSdkSessions(): Promise<void> {
  const closing = [...defaultSessions.values()].map(async session => {
    if (session.page !== null) await session.page.close().catch(() => {})
    await session.bridge.close().catch(() => {})
    await session.closeServer().catch(() => {})
  })
  defaultSessions.clear()
  await Promise.all(closing)
}

/** Provider configuration; `bridge` injects the test seam, without it the Playwright session is used. */
export interface TiandituSdkProviderConfig {
  /** The resolved browser-end key value; held in memory only, never in refs, logs, or errors. */
  readonly apiKey: string
  /** Environment-variable name the key resolved through; failure text carries the name only. */
  readonly apiKeyEnv: string
  /** The support extent the provider identity digests; routes are not clipped to it. */
  readonly bbox: ExtentBox
  /** Per-drive wall budget in milliseconds (1000–120000). */
  readonly timeoutMs?: number
  /** Browser seam; omit for the default Playwright session. */
  readonly bridge?: SdkBrowserBridge
  /** Page URL for an injected bridge; ignored by fake bridges, defaults to a marker when omitted. */
  readonly pageUrl?: string
}

/** Round one coordinate to the 1e-6 grid the node ids share. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Deterministic node id of one point on the 1e-6 grid; SDK-lane prefix keeps the lanes' nodes disjoint. */
function nodeIdOf(lon: number, lat: number): string {
  return `tianditu-sdk-${Math.round(lon * 1e6)}-${Math.round(lat * 1e6)}`
}

/**
 * The network version identity of one SDK adapter configuration. The digest
 * covers the support bbox only: the key never enters a ref that evidence and
 * logs carry.
 * @param config - the support bbox.
 * @returns `tianditu-sdk-road-network-<16 hex>@1`.
 */
export function tiandituSdkNetworkRefFor(config: { readonly bbox: ExtentBox }): string {
  const digest = sha256Hex(JSON.stringify({ id: TIANDITU_SDK_NETWORK_ID, bbox: config.bbox })).slice(0, 16)
  return `${TIANDITU_SDK_NETWORK_ID}-${digest}@1`
}

/** Map one page-side failure outcome onto the accessibility error vocabulary; no key material enters the text. */
function sdkFailure(outcome: SdkDriveOutcome): AccessibilityError {
  const detail = (outcome.detail ?? '').slice(0, 120)
  if (outcome.kind === 'stub') {
    return new AccessibilityError('TEMPORARILY_UNAVAILABLE', `tianditu sdk loader produced no service classes within its wait budget (${detail}); retry later — a genuine stub is a vendor-side condition, not a code defect`)
  }
  if (outcome.kind === 'no-plans') {
    const folded = detail.toLowerCase()
    if (SDK_PERMISSION_MARKERS.some(marker => folded.includes(marker.toLowerCase()))) {
      return new AccessibilityError('PERMISSION_DENIED', `tianditu sdk refused the credential (${detail || 'no detail'})`)
    }
    return new AccessibilityError('ACCESS_NOT_FOUND', `tianditu sdk found no driving plan (${detail || 'no detail'})`)
  }
  if (outcome.kind === 'timeout') {
    return new AccessibilityError('TEMPORARILY_UNAVAILABLE', `tianditu sdk drive did not settle within the budget (${detail || 'timeout'})`)
  }
  if (outcome.kind === 'parse') {
    return new AccessibilityError('TEMPORARILY_UNAVAILABLE', `tianditu sdk answered an unexpected plan form (${detail || 'no detail'})`)
  }
  return new AccessibilityError('TEMPORARILY_UNAVAILABLE', `tianditu sdk page failed to start (${detail || outcome.kind || 'no detail'})`)
}

/**
 * Create the Tianditu browser-SDK road-network provider. Construction validates
 * the configuration and fails loud on an unusable extent or empty key; nothing
 * degrades silently to another source.
 * @param config - resolved key (value), its env name, support bbox, wall budget, and optional bridge.
 * @returns the provider.
 * @throws {AccessibilityError} `ACCESS_INVALID_INPUT` on an unusable configuration.
 */
export function createTiandituSdkProvider(config: TiandituSdkProviderConfig): NetworkProvider {
  if (typeof config.apiKey !== 'string' || config.apiKey.length === 0) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', `the tianditu-sdk provider requires the credential environment variable ${config.apiKeyEnv} to hold a non-empty key at construction`)
  }
  if (config.bbox.some(value => !Number.isFinite(value))) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', 'provider bbox must be finite numbers')
  }
  const timeoutMs = Math.min(Math.max(config.timeoutMs ?? DEFAULT_TIANDITU_SDK_TIMEOUT_MS, 1000), 120_000)
  let heldPage: SdkBrowserPage | null = null

  /** Refuse barrier segments loudly: the SDK driving search takes no barrier input (declared shrink). */
  function refuseBarriers(barriers: readonly unknown[] | undefined): void {
    if (barriers !== undefined && barriers.length > 0) {
      throw new AccessibilityError('ACCESS_INVALID_INPUT', 'the tianditu-sdk provider does not support barrier segments; run this spec on the controlled provider or drop the barriers')
    }
  }

  /** Resolve the page for one drive: the held page of the session, or a freshly opened one. */
  async function pageForDrive(): Promise<SdkBrowserPage> {
    if (config.bridge !== undefined) {
      if (heldPage === null) heldPage = await config.bridge.open(config.pageUrl ?? 'about:blank#sdk-test')
      return heldPage
    }
    const session = await openDefaultSdkSession(config.apiKey)
    if (session.page === null) session.page = await session.bridge.open(session.url)
    return session.page
  }

  /** Drop a dead page so the next drive reopens one. */
  async function dropPage(page: SdkBrowserPage): Promise<void> {
    if (heldPage === page) heldPage = null
    const session = defaultSessions.get(config.apiKey)
    if (session !== undefined && session.page === page) session.page = null
    await page.close().catch(() => {})
  }

  return {
    networkId: TIANDITU_SDK_NETWORK_ID,
    networkRef: tiandituSdkNetworkRefFor({ bbox: config.bbox }),
    pricesMode(mode: TravelMode) {
      return mode === 'drive'
    },
    snapPoint(point) {
      // No lattice: the vendor prices the point itself, so the snap is the point.
      const node: NetworkNode = { id: nodeIdOf(round6(point[0]), round6(point[1])), lon: round6(point[0]), lat: round6(point[1]) }
      return { node, snapKm: 0 }
    },
    serviceArea() {
      return Promise.reject(new AccessibilityError('METHOD_NOT_APPLICABLE', 'the tianditu-sdk provider does not support service areas: the vendor publishes no isochrone API, and route sampling is not a substitute'))
    },
    async route(origin, destination, options) {
      if (options.mode !== 'drive') {
        throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the tianditu-sdk network prices drive only; mode ${options.mode} fails loud instead of being approximated`)
      }
      refuseBarriers(options.barriers)
      options.signal?.throwIfAborted()
      const page = await pageForDrive()
      const expression = `window.__sdkDrive(${origin[0]}, ${origin[1]}, ${destination[0]}, ${destination[1]})`
      let wallTimer: NodeJS.Timeout | undefined
      const wall = new Promise<never>((_, reject) => {
        wallTimer = setTimeout(() => reject(new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'tianditu sdk drive exceeded its wall budget')), timeoutMs)
        options.signal?.addEventListener('abort', () => {
          if (wallTimer !== undefined) clearTimeout(wallTimer)
          reject(options.signal?.reason instanceof Error ? options.signal.reason : new DOMException('aborted', 'AbortError'))
        }, { once: true })
      })
      let outcome: SdkDriveOutcome
      try {
        outcome = await Promise.race([page.evaluate(expression) as Promise<SdkDriveOutcome>, wall])
      } catch (error) {
        await dropPage(page)
        if (error instanceof AccessibilityError) throw error
        if (options.signal?.aborted) options.signal.throwIfAborted()
        throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', `the sdk page call failed (${String(error instanceof Error ? error.message : error).slice(0, 100)})`)
      } finally {
        if (wallTimer !== undefined) clearTimeout(wallTimer)
      }
      if (outcome === null || typeof outcome !== 'object' || typeof outcome.ok !== 'boolean') {
        await dropPage(page)
        throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'tianditu sdk answered an unexpected outcome form (not the page contract)')
      }
      if (!outcome.ok) {
        throw sdkFailure(outcome)
      }
      const seconds = Number(outcome.seconds)
      const kilometres = Number(outcome.kilometres)
      if (!Number.isFinite(seconds) || !Number.isFinite(kilometres) || seconds < 0 || kilometres < 0) {
        throw new AccessibilityError('TEMPORARILY_UNAVAILABLE', 'tianditu sdk answered an unexpected plan form (unusable duration or distance)')
      }
      const nodes: string[] = [nodeIdOf(round6(origin[0]), round6(origin[1]))]
      const polyline = Array.isArray(outcome.polyline) ? outcome.polyline : []
      for (const [lon, lat] of polyline) {
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          const id = nodeIdOf(round6(lon), round6(lat))
          if (nodes[nodes.length - 1] !== id) nodes.push(id)
        }
      }
      const end = nodeIdOf(round6(destination[0]), round6(destination[1]))
      if (nodes[nodes.length - 1] !== end) nodes.push(end)
      const bounded = nodes.length <= TIANDITU_SDK_MAX_ROUTE_NODES
        ? nodes
        : nodes.filter((_, index) => index % Math.ceil(nodes.length / TIANDITU_SDK_MAX_ROUTE_NODES) === 0 || index === nodes.length - 1)
      return { minutes: seconds / 60, distanceKm: kilometres, nodes: bounded }
    },
    readPois() {
      return Promise.reject(new AccessibilityError('METHOD_NOT_APPLICABLE', 'the tianditu-sdk provider does not map POI search: the SDK LocalSearch permission of the available browser-end keys is unverified, and unmapped faces fail loud'))
    },
  }
}
