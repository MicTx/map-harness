/**
 * Isolated official Wayback calls with a bounded, same-origin host transport.
 * @module @map-harness/map-container/wayback-transport
 */
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createSourceNetwork, type SourceNetwork, type SourceNetworkDependencies } from './source-network.ts'
import { DEFAULT_SOURCE_NETWORK_CONFIG, type ResolvedSourceNetworkConfig } from './source-network-config.ts'
import { SourceCatalogError } from './source-error.ts'
import { admitSourceImage } from './source-image.ts'
import type { ResolvedMapSource } from './sources.ts'
import { waybackDescriptor, type WaybackCore } from './wayback.ts'
import type { WaybackCoreItem, WaybackCoreMetadata } from './wayback-core.ts'

const CONFIG_URL = 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json'
const WAYBACK_HOST = /^wayback(?:-a|-b)?\.maptiles\.arcgis\.com$/
const WAYBACK_PATH = /^\/arcgis\/rest\/services\/World_Imagery\/(?:WMTS\/1\.0\.0\/default028mm\/MapServer\/tile|MapServer\/tilemap)\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/
const METADATA_PATH = /^\/arcgis\/rest\/services\/World_Imagery_Metadata_\d{4}_r\d{2}\/MapServer\/(?:0|[1-9]\d?)\/query$/

/** Operation-local network injection for deterministic host transport tests. */
export interface WaybackTransportDependencies extends SourceNetworkDependencies {
  readonly network?: SourceNetwork
  readonly operationTimeoutMs?: number
}

function admit(url: URL): void {
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '' || url.hash !== '') throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  if (url.href === CONFIG_URL) return
  if (url.hostname === 'metadata.maptiles.arcgis.com' && METADATA_PATH.test(url.pathname)) {
    const expected = new Set(['f', 'where', 'outfields', 'geometry', 'returngeometry', 'geometrytype', 'spatialrel'])
    const seen = new Set<string>()
    for (const [key, value] of url.searchParams) {
      const normalized = key.toLowerCase()
      if (!expected.has(normalized) || seen.has(normalized) || value.length > 2_048) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
      seen.add(normalized)
    }
    if (seen.size !== expected.size || url.searchParams.get('f') !== 'json' || url.searchParams.get('where') !== '1=1'
      || url.searchParams.get('returnGeometry') !== 'false' || url.searchParams.get('geometryType') !== 'esriGeometryPoint'
      || url.searchParams.get('spatialRel') !== 'esriSpatialRelIntersects'
      || url.searchParams.get('outFields') !== 'SRC_DATE2,NICE_DESC,SRC_DESC,SAMP_RES,SRC_ACC') throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    let geometry: unknown
    try {
      geometry = JSON.parse(url.searchParams.get('geometry') ?? '')
    } catch (error) {
      if (error instanceof SyntaxError) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
      throw error
    }
    if (typeof geometry !== 'object' || geometry === null || Array.isArray(geometry)) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    const point = geometry as { x?: unknown; y?: unknown; spatialReference?: unknown }
    if (Object.keys(point).length !== 3 || typeof point.x !== 'number' || !Number.isFinite(point.x) || point.x < -180 || point.x > 180
      || typeof point.y !== 'number' || !Number.isFinite(point.y) || point.y < -85.0511287798066 || point.y > 85.0511287798066
      || typeof point.spatialReference !== 'object' || point.spatialReference === null || Array.isArray(point.spatialReference)
      || Object.keys(point.spatialReference).length !== 1 || (point.spatialReference as { wkid?: unknown }).wkid !== 4326) {
      throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    }
    return
  }
  const tile = WAYBACK_PATH.exec(url.pathname)
  if (!WAYBACK_HOST.test(url.hostname) || tile === null || url.search !== '') throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  const [release, level, row, col] = tile.slice(1).map(Number)
  if (![release, level, row, col].every(Number.isSafeInteger) || release! <= 0 || level! < 0 || level! > 23
    || row! < 0 || col! < 0 || row! >= 2 ** level! || col! >= 2 ** level!) {
    throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  }
}

/**
 * Reject an official catalog body that the official reader would silently truncate.
 * The reader filters out any numeric entry it cannot validate, so one damaged
 * entry would otherwise replace the last verified catalog with a shorter list.
 * @param body - raw official config JSON.
 */
function admitCatalog(body: Buffer): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  const catalog = parsed as Record<string, unknown>
  for (const key of Object.keys(catalog)) {
    const releaseId = Number(key)
    if (Number.isNaN(releaseId)) continue
    // The official reader resolves the item by numeric index, so validate the
    // entry it will actually read.
    const value = catalog[String(releaseId)]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    const item = value as Record<string, unknown>
    for (const field of ['itemTitle', 'itemID', 'itemURL', 'metadataLayerUrl', 'metadataLayerItemID', 'layerIdentifier']) {
      if (typeof item[field] !== 'string') throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    }
    const title = /^World Imagery \(Wayback (\d{4}-\d{2}-\d{2})\)$/.exec(item.itemTitle as string)
    const label = title?.[1]
    if (label === undefined) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    const date = new Date(`${label}T00:00:00Z`)
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== label) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }
}

/** Reject malformed tilemap evidence before the official reader can treat it as no change. */
function admitTilemap(body: Buffer): void {
  let value: unknown
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  const tilemap = value as { data?: unknown; select?: unknown; size?: unknown }
  if (!Array.isArray(tilemap.data) || tilemap.data.length !== 1 || ![0, 1].includes(tilemap.data[0])) {
    throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }
  if (tilemap.select !== undefined && (!Array.isArray(tilemap.select) || tilemap.select.length !== 1
    || !Number.isSafeInteger(tilemap.select[0]) || tilemap.select[0] < 0)) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  if (tilemap.size !== undefined && (!Array.isArray(tilemap.size) || tilemap.size.length > 1
    || (tilemap.size.length === 1 && (!Number.isSafeInteger(tilemap.size[0]) || tilemap.size[0] < 0)))) {
    throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }
  // The official reader falls back to the queried release when `select` is
  // absent (observed for a real 10842 tilemap), so only field shapes are
  // enforced; cross-field contradictions stay the reader's protocol.
  if (tilemap.data[0] === 1 && tilemap.size === undefined) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
}

/** One disposable Wayback transport; each call owns its worker and network requests. */
export class WaybackOfficialTransport implements WaybackCore {
  private readonly network: SourceNetwork
  private readonly workers = new Set<Worker>()
  private readonly operations = new Set<Promise<unknown>>()
  private readonly controllers = new Set<AbortController>()
  private readonly workerUrl: URL
  private readonly timeoutMs: number
  private disposed = false
  private disposal: Promise<void> | undefined

  /**
   * Create the bounded transport.
   * @param limits - host network bounds.
   * @param dependencies - optional operation-local transport dependencies.
   * @param workerUrl - optional built worker entry for isolated tests.
   */
  constructor(
    limits: ResolvedSourceNetworkConfig = DEFAULT_SOURCE_NETWORK_CONFIG,
    dependencies: WaybackTransportDependencies = {},
    workerUrl: URL = pathToFileURL(createRequire(import.meta.url).resolve('@map-harness/map-container/wayback-worker')),
  ) {
    this.network = dependencies.network ?? createSourceNetwork(limits, dependencies)
    this.workerUrl = workerUrl
    this.timeoutMs = dependencies.operationTimeoutMs ?? Math.min(limits.requestTimeoutMs * 6, 120_000)
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new SourceCatalogError('SOURCE_CONFIG_INVALID')
    }
  }

  private call(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (this.disposed || signal?.aborted) return Promise.reject(new SourceCatalogError('SOURCE_CANCELLED'))
    const task = this.run(operation, args, signal)
    this.operations.add(task)
    void task.then(() => this.operations.delete(task), () => this.operations.delete(task))
    return task
  }

  private async run(operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    // Snapshot packagers intercept worker filesystem paths, not file URLs.
    const worker = new Worker(fileURLToPath(this.workerUrl), { execArgv: [] })
    this.workers.add(worker)
    const controller = new AbortController()
    this.controllers.add(controller)
    const requests = new Set<Promise<void>>()
    let failure: SourceCatalogError | undefined
    let settled = false
    let rejectCall!: (error: SourceCatalogError) => void
    let resolveCall!: (value: unknown) => void
    const outcome = new Promise<unknown>((resolve, reject) => { resolveCall = resolve; rejectCall = reject })
    const settleFailure = (error: SourceCatalogError): void => {
      if (settled) return
      settled = true
      controller.abort(error.code)
      rejectCall(error)
    }
    const onAbort = (): void => settleFailure(new SourceCatalogError('SOURCE_CANCELLED'))
    const timer = setTimeout(() => settleFailure(new SourceCatalogError('SOURCE_TIMEOUT')), this.timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    worker.on('error', () => settleFailure(new SourceCatalogError('SOURCE_UNAVAILABLE')))
    worker.on('exit', () => {
      if (!settled) settleFailure(new SourceCatalogError('SOURCE_UNAVAILABLE'))
    })
    worker.on('message', (message: { kind?: unknown; id?: unknown; owner?: unknown; method?: unknown; url?: unknown; value?: unknown; error?: unknown; code?: unknown }) => {
      if (settled) return
      if (message.kind === 'fetch' && typeof message.id === 'number' && message.owner === 1 && typeof message.url === 'string') {
        const requestId = message.id
        const request = (async () => {
          try {
            if (message.method !== 'GET') throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
            const url = new URL(message.url as string)
            admit(url)
            const source: ResolvedMapSource = {
              source: waybackDescriptor({
                releaseId: 1, itemId: '0'.repeat(32), title: 'World Imagery (Wayback 2014-02-20)',
                publishedAt: '2014-02-20', layerIdentifier: 'WB_2014_R01', acquiredAt: null,
              }),
              endpoint: url.origin,
              allowPrivateNetwork: false,
              allowHttp: false,
            }
            const payload = WAYBACK_HOST.test(url.hostname) && url.pathname.includes('/tile/') ? 'image' : 'json'
            const response = await this.network.request({
              source, url,
              payload,
              signal: controller.signal,
            })
            if (controller.signal.aborted) return
            if (response.status !== 200) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
            // A partially damaged catalog is filtered, not rejected, by the
            // official reader; refuse it here to keep the last verified list.
            if (url.href === CONFIG_URL) admitCatalog(response.body)
            if (url.pathname.includes('/tilemap/')) admitTilemap(response.body)
            // Comparison candidates are evidence of distinct local imagery.
            // Reject mislabeled or non-image bytes before the worker hashes
            // them; the official tile grid is fixed at 256x256.
            if (payload === 'image') {
              await admitSourceImage(response.body, response.contentType,
                { kind: 'image', url, width: 256, height: 256, cacheKey: url.href })
            }
            // The official reader maps a metadata body without a features array
            // to null, which is indistinguishable from an honest empty sample.
            // Reject the malformed body here so the panel reports a query
            // failure instead of claiming an unknown acquisition date.
            if (url.pathname.endsWith('/query')) {
              let parsed: unknown
              try {
                parsed = JSON.parse(response.body.toString('utf8'))
              } catch (error) {
                if (!(error instanceof SyntaxError)) throw error
                throw new SourceCatalogError('SOURCE_UNAVAILABLE')
              }
              if (typeof parsed !== 'object' || parsed === null
                || !Array.isArray((parsed as { features?: unknown }).features)) {
                throw new SourceCatalogError('SOURCE_UNAVAILABLE')
              }
              // An empty array is honest missing evidence; a malformed feature
              // would otherwise be collapsed to null by the official reader.
              for (const feature of (parsed as { features: unknown[] }).features) {
                if (typeof feature !== 'object' || feature === null || Array.isArray(feature)
                  || typeof (feature as { attributes?: unknown }).attributes !== 'object'
                  || (feature as { attributes: unknown }).attributes === null
                  || Array.isArray((feature as { attributes: unknown }).attributes)) {
                  throw new SourceCatalogError('SOURCE_UNAVAILABLE')
                }
              }
            }
            worker.postMessage({
              kind: 'response', id: requestId, status: response.status,
              headers: response.contentType === null ? [] : [['content-type', response.contentType]],
              body: response.body.toString('base64'),
            })
          } catch (error) {
            if (controller.signal.aborted) return
            failure ??= error instanceof SourceCatalogError ? error : new SourceCatalogError('SOURCE_UNAVAILABLE')
            worker.postMessage({ kind: 'response', id: requestId, error: failure.code })
          }
        })()
        requests.add(request)
        void request.then(() => requests.delete(request), () => requests.delete(request))
      } else if (message.kind === 'result' && message.id === 1) {
        if (failure !== undefined || message.error !== undefined) {
          const code = message.code === 'SOURCE_CHANGED' ? 'SOURCE_CHANGED' : 'SOURCE_UNAVAILABLE'
          settleFailure(failure ?? new SourceCatalogError(code))
        } else {
          settled = true
          resolveCall(message.value)
        }
      }
    })
    if (signal?.aborted || this.disposed) onAbort()
    else worker.postMessage({ kind: 'call', id: 1, operation, ...args })
    try {
      return await outcome
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      controller.abort('settled')
      await worker.terminate()
      await Promise.allSettled([...requests])
      this.workers.delete(worker)
      this.controllers.delete(controller)
    }
  }

  /** Read fresh official release records. */
  getWaybackItems(signal?: AbortSignal): Promise<WaybackCoreItem[]> {
    return this.call('list', {}, signal) as Promise<WaybackCoreItem[]>
  }

  /** Read deduplicated local releases for one point. */
  getWaybackItemsWithLocalChanges(point: { longitude: number; latitude: number }, zoom: number, signal: AbortSignal): Promise<WaybackCoreItem[]> {
    return this.call('local', { point, zoom }, signal) as Promise<WaybackCoreItem[]>
  }

  /** Read official metadata for one release and point. */
  getMetadata(
    point: { longitude: number; latitude: number },
    zoom: number,
    releaseNumber: number,
    signal: AbortSignal,
    expected?: { readonly itemId: string; readonly metadataLayerUrl: string },
  ): Promise<WaybackCoreMetadata | null> {
    return this.call('metadata', { point, zoom, releaseNumber, ...(expected === undefined ? {} : { expected }) }, signal) as Promise<WaybackCoreMetadata | null>
  }

  /** Stop admission and await every worker and network operation. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    for (const controller of this.controllers) controller.abort('dispose')
    this.network.dispose()
    this.disposal = (async () => {
      await Promise.all([...this.workers].map(worker => worker.terminate()))
      await Promise.allSettled([...this.operations])
    })()
    return this.disposal
  }
}
