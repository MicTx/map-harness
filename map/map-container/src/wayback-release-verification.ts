/**
 * Host-side independent verification of one canonical fixed Wayback release.
 * Only the official portal item and the official WMTS capabilities document are read;
 * tile, catalog and item-supplied URLs are never requested.
 * @module @map-harness/map-container/wayback-release-verification
 */
import { parseWaybackCapabilities } from './wayback-capabilities.ts'
import { SourceCatalogError } from './source-error.ts'
import type { SourceNetwork } from './source-network.ts'
import { parseSourceXml, xmlElement, xmlElements, xmlText } from './source-xml.ts'
import type { WmtsMetadata } from './source-wmts.ts'
import { WAYBACK_ENDPOINT, waybackDescriptor, type WaybackRelease } from './wayback.ts'

const PORTAL_ORIGIN = 'https://www.arcgis.com'
const WAYBACK_ORIGIN = 'https://wayback.maptiles.arcgis.com'
/** Service root of the generic item `url`; the tile paths below extend it. */
const WMTS_PATH = '/arcgis/rest/services/World_Imagery/WMTS'
/** Fixed capabilities URL, the same request the source service reads. */
const CAPABILITIES_URL = `${WAYBACK_ENDPOINT}?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetCapabilities`

/** The only portal owner, organization, sharing level and type allowed to publish Wayback imagery. */
const ITEM_OWNER = 'esri_imagery'
const ITEM_ORG_ID = 'P3ePLMYs2RVChkJx'
const ITEM_TYPE = 'WMTS'
/** Catalog and WMTS layer ids of the only release where they differ. */
const LAYER_EXCEPTION_RELEASE = 15084
const LAYER_EXCEPTION = Object.freeze({ layerIdentifier: 'WB_2015_R14', nativeLayer: 'WB_2015_R04' })

/** Exact fixed tile URLs for one release: the WMTS template, or the catalog form older items use. */
const TILE_PATH = /^\/arcgis\/rest\/services\/World_Imagery\/WMTS\/1\.0\.0\/(?:[{]TileMatrixSet[}]\/MapServer\/tile\/(\d+)\/[{]TileMatrix[}]\/[{]TileRow[}]\/[{]TileCol[}]|default028mm\/MapServer\/tile\/(\d+)\/[{]level[}]\/[{]row[}]\/[{]col[}])$/

/** An untrusted browser hint; the host must verify all fields against official sources. */
export interface WaybackReleaseVerificationRequest {
  /** Official positive release number. */
  readonly releaseId: number
  /** Official portal item id. */
  readonly itemId: string
  /** Official catalog layer id. */
  readonly layerIdentifier: string
  /** Official publication date, `YYYY-MM-DD`. */
  readonly publishedAt: string
}

/** Verified canonical release and the native metadata compiled from the same fixed document. */
export interface VerifiedWaybackRelease {
  readonly release: WaybackRelease
  readonly wmts: WmtsMetadata
  /** Official HTTPS fixed tile template; a request target only, never requested here. */
  readonly templateUrl: string
}

/** Portal item `url`: the generic service URL or this release's exact fixed tile URL. */
function admitItemUrl(value: unknown, releaseId: number): void {
  if (typeof value !== 'string') throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  if (value === `${WAYBACK_ORIGIN}${WMTS_PATH}`) return
  if (fixedTileUrl(value, releaseId) === null) throw new SourceCatalogError('SOURCE_CHANGED')
}

/**
 * Match a fixed tile URL for one release on the official host, over HTTP or HTTPS.
 * @param value - untrusted URL text.
 * @param releaseId - release the path must name.
 * @returns the tile path, or `null` when it is not that fixed URL.
 */
function fixedTileUrl(value: unknown, releaseId: number): string | null {
  if (typeof value !== 'string') return null
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return null
  }
  // `URL.pathname` percent-encodes the template braces.
  const match = TILE_PATH.exec(safeDecode(url.pathname))
  const named = match === null ? NaN : Number(match[1] ?? match[2])
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.host !== 'wayback.maptiles.arcgis.com' || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || match === null || named !== releaseId) return null
  return url.pathname
}

function record(value: unknown, code: 'SOURCE_CONFIG_INVALID' | 'SOURCE_UNAVAILABLE'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SourceCatalogError(code)
  return value as Record<string, unknown>
}

function safeDecode(pathname: string): string {
  try {
    return decodeURI(pathname)
  } catch (error) {
    if (!(error instanceof URIError)) throw error
    return ''
  }
}

function calendarDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new SourceCatalogError('SOURCE_CONFIG_INVALID')
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new SourceCatalogError('SOURCE_CONFIG_INVALID')
  return value
}

/**
 * Validate one verification request structurally.
 * @param value - untrusted host input; unknown fields are rejected.
 * @returns the validated request.
 */
export function parseWaybackReleaseVerificationRequest(value: unknown): WaybackReleaseVerificationRequest {
  const input = record(value, 'SOURCE_CONFIG_INVALID')
  const keys = ['releaseId', 'itemId', 'layerIdentifier', 'publishedAt']
  if (Object.keys(input).length !== keys.length || keys.some(key => !(key in input))) throw new SourceCatalogError('SOURCE_CONFIG_INVALID')
  const { releaseId, itemId, layerIdentifier, publishedAt } = input
  if (typeof releaseId !== 'number' || !Number.isSafeInteger(releaseId) || releaseId <= 0 || releaseId >= 2 ** 31
    || typeof itemId !== 'string' || !/^[0-9a-f]{32}$/.test(itemId)
    || typeof layerIdentifier !== 'string' || !/^WB_\d{4}_R\d{2}$/.test(layerIdentifier)) throw new SourceCatalogError('SOURCE_CONFIG_INVALID')
  return { releaseId, itemId, layerIdentifier, publishedAt: calendarDate(publishedAt) }
}

/**
 * Verify one canonical fixed release against the official portal item and WMTS document.
 * @param value - untrusted request; see {@link parseWaybackReleaseVerificationRequest}.
 * @param network - host-owned transport; redirects, credentials, per-request deadlines and response bounds stay its contract.
 * @param signal - host cancellation; an aborted signal settles with `SOURCE_CANCELLED`.
 * @returns the canonical release, native WMTS metadata and the fixed tile template.
 */
export async function verifyWaybackRelease(
  value: unknown,
  network: SourceNetwork,
  signal?: AbortSignal,
): Promise<VerifiedWaybackRelease> {
  const request = parseWaybackReleaseVerificationRequest(value)
  const changed = (): void => {
    if (signal?.aborted) throw new SourceCatalogError('SOURCE_CANCELLED')
  }
  const read = async (url: URL, payload: 'json' | 'xml'): Promise<Buffer> => {
    changed()
    const source = {
      source: waybackDescriptor({ ...request, title: titleOf(request.publishedAt), acquiredAt: null }),
      endpoint: url.origin,
      allowPrivateNetwork: false,
      allowHttp: false,
    }
    let response
    try {
      response = await network.request({ source, url, payload, ...(signal === undefined ? {} : { signal }) })
    } catch (error) {
      changed()
      throw error instanceof SourceCatalogError ? error : new SourceCatalogError('SOURCE_UNAVAILABLE')
    }
    changed()
    if (response.status !== 200) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    return response.body
  }
  const readItem = async (url: URL): Promise<Record<string, unknown>> => {
    try {
      return record(JSON.parse((await read(url, 'json')).toString('utf8')), 'SOURCE_UNAVAILABLE')
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    }
  }
  const itemPath = `/sharing/rest/content/items/${request.itemId}`
  const item = await readItem(new URL(`${itemPath}?f=json`, PORTAL_ORIGIN))
  const title = titleOf(request.publishedAt)
  if ([item.id, item.owner, item.orgId, item.type, item.access, item.title].some(field => typeof field !== 'string')) {
    throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }
  if (item.id !== request.itemId || item.owner !== ITEM_OWNER || item.orgId !== ITEM_ORG_ID || item.type !== ITEM_TYPE
    || item.access !== 'public' || item.title !== title) throw new SourceCatalogError('SOURCE_CHANGED')
  if (typeof item.url !== 'string') throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  admitItemUrl(item.url, request.releaseId)
  const generic = item.url === `${WAYBACK_ORIGIN}${WMTS_PATH}`
  if (generic || item.data !== undefined) {
    // Generic portal items identify the fixed release in /data.templateUrl, not /data.wmtsInfo.url.
    const data = item.data === undefined
      ? await readItem(new URL(`${itemPath}/data?f=json`, PORTAL_ORIGIN))
      : record(item.data, 'SOURCE_UNAVAILABLE')
    if (typeof data.templateUrl !== 'string') throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    if (fixedTileUrl(data.templateUrl, request.releaseId) === null) throw new SourceCatalogError('SOURCE_CHANGED')
  }
  const body = await read(new URL(CAPABILITIES_URL), 'xml')
  const contents = xmlElement(xmlElement(parseSourceXml(body), 'Capabilities'), 'Contents')
  const nativeLayer = request.releaseId === LAYER_EXCEPTION_RELEASE ? LAYER_EXCEPTION.nativeLayer : request.layerIdentifier
  const layers = xmlElements(contents, 'Layer').filter(layer => xmlText(xmlElement(layer, 'Identifier')) === nativeLayer)
  if (layers.length !== 1) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  const titles = xmlElements(layers[0]!, 'Title').map(xmlText)
  if (titles.some(value => value !== title)) throw new SourceCatalogError('SOURCE_CHANGED')
  const wmts = parseWaybackCapabilities(body, request.releaseId, request.layerIdentifier, request.publishedAt)
  return {
    release: { ...request, title, acquiredAt: null },
    wmts,
    templateUrl: `${WAYBACK_ORIGIN}${WMTS_PATH}/1.0.0/{TileMatrixSet}/MapServer/tile/${request.releaseId}/{TileMatrix}/{TileRow}/{TileCol}`,
  }
}

function titleOf(publishedAt: string): string {
  return `World Imagery (Wayback ${publishedAt})`
}
