/**
 * Closed native resource vocabulary compiled only against host-resolved sources.
 * Private URLs in returned plans never cross the server boundary.
 * @module @map-harness/map-container/source-resource
 */
import type { ResolvedMapSource } from './sources.ts'
import type { MapServerMetadata } from './source-mapserver.ts'
import type { WmtsMetadata } from './source-wmts.ts'
import { canonicalSourceWkid as canonicalWkid } from '@map-harness/map-layers'
import { SourceCatalogError } from './source-error.ts'
import { MAX_SOURCE_IMAGE_PIXELS, PUBLIC_WMTS_IDS } from './source-render-protocol.ts'

/** Native metadata and configured source owned by one source service activation. */
export type ResolvedNativeSource =
  | { readonly adapter: 'arcgis-mapserver'; readonly resolved: ResolvedMapSource; readonly metadata: MapServerMetadata }
  | { readonly adapter: 'wmts'; readonly resolved: ResolvedMapSource; readonly metadata: WmtsMetadata }
  | { readonly adapter: 'xyz'; readonly resolved: ResolvedMapSource }

/** The actual engine WKID, after resolving the logical record's default engine. */
export interface SourceResourceView {
  readonly wkid: number
}

/** A native SDK document or a bounded private image request. */
export type SourceResourcePlan =
  | { readonly kind: 'metadata'; readonly payload: 'json' | 'xml' }
  | {
    readonly kind: 'image'
    readonly url: URL
    readonly width: number
    readonly height: number
    /** Private canonical key, not a public ETag or a diagnostic string. */
    readonly cacheKey: string
  }

/** A compiler-admitted native image operation with exact expected dimensions. */
export type SourceImagePlan = Extract<SourceResourcePlan, { readonly kind: 'image' }>

/** Host-only upstream metadata request, before credentials are attached. */
export interface SourceMetadataRequest {
  readonly url: URL
  readonly payload: 'json' | 'xml'
}

function denied(): never {
  throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
}

function scalar(value: string): number {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) denied()
  const number = Number(value)
  if (!Number.isFinite(number)) denied()
  return number
}

function integer(value: string, minimum: number, maximum: number): number {
  if (!/^-?(?:0|[1-9]\d*)$/.test(value)) denied()
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) denied()
  return number
}

function fields(query: URLSearchParams): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  for (const [key, value] of query) {
    const name = key.toLowerCase()
    if (result.size >= 16 || result.has(name) || name.length > 64 || value.length > (name === 'layers' ? 4_096 : 2_048)) denied()
    result.set(name, value)
  }
  return result
}

function only(input: ReadonlyMap<string, string>, names: readonly string[]): void {
  for (const name of input.keys()) if (!names.includes(name)) denied()
}

function required(input: ReadonlyMap<string, string>, name: string): string {
  const value = input.get(name)
  if (value === undefined || value.length === 0) denied()
  return value
}

function equals(input: ReadonlyMap<string, string>, name: string, expected: string): void {
  if (required(input, name) !== expected) denied()
}

function compiledUrl(endpoint: string, suffix: string, parameters: Readonly<Record<string, string>>): URL {
  const url = new URL(endpoint)
  if (suffix !== '') url.pathname = url.pathname.replace(/\/$/, '') + suffix
  const names = Object.keys(parameters).map(name => name.toLowerCase())
  for (const key of url.searchParams.keys()) if (names.includes(key.toLowerCase())) denied()
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value)
  return url
}

function image(url: URL, width: number, height: number): SourceResourcePlan {
  return { kind: 'image', url, width, height, cacheKey: url.href }
}

function mapserverTile(source: Extract<ResolvedNativeSource, { adapter: 'arcgis-mapserver' }>, input: ReadonlyMap<string, string>): SourceResourcePlan {
  only(input, ['resource', 'level', 'row', 'col', 'blanktile'])
  const level = integer(required(input, 'level'), 0, 32)
  const bounds = source.metadata.tileBounds.find(bounds => bounds.level === level)
  const info = source.metadata.service.tileInfo
  if (bounds === undefined || info === undefined) denied()
  const row = integer(required(input, 'row'), bounds.minRow, bounds.maxRow)
  const col = integer(required(input, 'col'), bounds.minCol, bounds.maxCol)
  const blankTile = input.get('blanktile')
  if (blankTile !== undefined && blankTile !== 'false') denied()
  const url = compiledUrl(source.resolved.endpoint, `/tile/${level}/${row}/${col}`, blankTile === undefined ? {} : { blankTile })
  return image(url, info.cols, info.rows)
}

function xyzTile(source: Extract<ResolvedNativeSource, { adapter: 'xyz' }>, input: ReadonlyMap<string, string>): SourceResourcePlan {
  only(input, ['resource', 'z', 'x', 'y'])
  if (canonicalWkid(source.resolved.source.nativeWkid) !== 3857) denied()
  const z = integer(required(input, 'z'), 0, 30)
  const maximum = 2 ** z - 1
  const x = integer(required(input, 'x'), 0, maximum)
  const y = integer(required(input, 'y'), 0, maximum)
  const endpoint = source.resolved.endpoint.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y))
  return image(new URL(endpoint), 256, 256)
}

function wmts(source: Extract<ResolvedNativeSource, { adapter: 'wmts' }>, input: ReadonlyMap<string, string>): SourceResourcePlan {
  equals(input, 'service', 'WMTS')
  equals(input, 'version', '1.0.0')
  const request = required(input, 'request')
  if (request === 'GetCapabilities') {
    only(input, ['resource', 'service', 'version', 'request'])
    return { kind: 'metadata', payload: 'xml' }
  }
  if (request !== 'GetTile') denied()
  only(input, ['resource', 'service', 'version', 'request', 'layer', 'style', 'format', 'tilematrixset', 'tilematrix', 'tilerow', 'tilecol'])
  equals(input, 'layer', PUBLIC_WMTS_IDS.layer)
  equals(input, 'style', PUBLIC_WMTS_IDS.style)
  equals(input, 'tilematrixset', PUBLIC_WMTS_IDS.matrixSet)
  equals(input, 'format', source.metadata.publicFormat)
  const matrix = source.metadata.matrices.find(matrix => matrix.publicId === required(input, 'tilematrix'))
  if (matrix === undefined) denied()
  const row = integer(required(input, 'tilerow'), matrix.minTileRow, matrix.maxTileRow)
  const col = integer(required(input, 'tilecol'), matrix.minTileCol, matrix.maxTileCol)
  const metadata = source.metadata
  if (source.resolved.waybackRelease !== undefined) {
    const url = compiledUrl(source.resolved.endpoint, `/tile/${source.resolved.waybackRelease}/${matrix.nativeId}/${row}/${col}`, {})
    return image(url, matrix.tileWidth, matrix.tileHeight)
  }
  const url = compiledUrl(source.resolved.endpoint, '', {
    SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetTile',
    LAYER: metadata.nativeLayer, STYLE: metadata.nativeStyle, FORMAT: metadata.nativeFormat,
    TILEMATRIXSET: metadata.nativeMatrixSet, TILEMATRIX: matrix.nativeId,
    TILEROW: String(row), TILECOL: String(col),
  })
  return image(url, matrix.tileWidth, matrix.tileHeight)
}

function defaultLeaves(metadata: MapServerMetadata): ReadonlySet<number> {
  const layers = metadata.service.layers
  const byId = new Map(layers.map(layer => [layer.id, layer]))
  const visible = new Set<number>()
  for (const layer of layers) {
    if (layer.subLayerIds !== null) continue
    let cursor: (typeof layers)[number] | undefined = layer
    while (cursor?.defaultVisibility === true) {
      if (cursor.parentLayerId === -1) {
        visible.add(layer.id)
        break
      }
      cursor = byId.get(cursor.parentLayerId)
    }
  }
  return visible
}

function exportLayers(value: string, metadata: MapServerMetadata): string {
  if (value === 'show:-1') return value
  if (!value.startsWith('show:')) denied()
  const ids = value.slice(5).split(',').map(value => integer(value, 0, 2_147_483_647))
  const allowed = defaultLeaves(metadata)
  if (new Set(ids).size !== ids.length || ids.some(id => !allowed.has(id))) denied()
  return `show:${ids.sort((left, right) => left - right).join(',')}`
}

function mapserverExport(
  source: Extract<ResolvedNativeSource, { adapter: 'arcgis-mapserver' }>,
  view: SourceResourceView,
  input: ReadonlyMap<string, string>,
): SourceResourcePlan {
  only(input, ['resource', 'bbox', 'bboxsr', 'imagesr', 'size', 'dpi', 'format', 'transparent', 'f', 'rotation', 'layers'])
  const service = source.metadata.service
  if (!source.resolved.source.supportsDynamicExport || !source.metadata.supportsExport) denied()
  equals(input, 'f', 'image')
  equals(input, 'transparent', 'true')
  const bbox = required(input, 'bbox').split(',').map(scalar)
  if (bbox.length !== 4) denied()
  const [xmin, ymin, xmax, ymax] = bbox
  if (xmin! >= xmax! || ymin! >= ymax! || !Number.isFinite(xmax! - xmin!) || !Number.isFinite(ymax! - ymin!)) denied()
  const bboxSR = integer(required(input, 'bboxsr'), 1, Number.MAX_SAFE_INTEGER)
  const imageSR = integer(required(input, 'imagesr'), 1, Number.MAX_SAFE_INTEGER)
  const allowedSr = new Set([canonicalWkid(view.wkid), source.metadata.nativeWkid])
  if (!allowedSr.has(canonicalWkid(bboxSR)) || canonicalWkid(bboxSR) !== canonicalWkid(imageSR)) denied()
  const size = required(input, 'size').split(',')
  if (size.length !== 2) denied()
  const width = integer(size[0]!, 1, Number.MAX_SAFE_INTEGER)
  const height = integer(size[1]!, 1, Number.MAX_SAFE_INTEGER)
  const dpi = scalar(required(input, 'dpi'))
  if (dpi <= 0) denied()
  if (width > Math.min(service.maxImageWidth ?? 4_096, 4_096)
    || height > Math.min(service.maxImageHeight ?? 4_096, 4_096)
    || width * height > MAX_SOURCE_IMAGE_PIXELS || dpi > 1_200) throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
  const format = required(input, 'format').toUpperCase()
  if (!service.supportedImageFormatTypes.split(',').includes(format)) denied()
  const rotation = input.get('rotation')
  if (rotation !== undefined && Math.abs(scalar(rotation)) > 360) denied()
  const layers = input.get('layers')
  const url = compiledUrl(source.resolved.endpoint, '/export', {
    f: 'image', bbox: bbox.join(','), bboxSR: String(bboxSR), imageSR: String(imageSR),
    size: `${width},${height}`, dpi: String(dpi), format: format.toLowerCase(), transparent: 'true',
    ...(rotation === undefined ? {} : { rotation: String(scalar(rotation)) }),
    ...(layers === undefined ? {} : { layers: exportLayers(layers, source.metadata) }),
  })
  return image(url, width, height)
}

/**
 * Compile an upstream metadata GET from deployment configuration only.
 * @param source - host-resolved configuration, never caller URL fields.
 * @returns native metadata request, or null for the fixed Web Mercator XYZ profile.
 */
export function metadataRequest(source: ResolvedMapSource): SourceMetadataRequest | null {
  if (source.waybackRelease !== undefined) {
    return { url: new URL(`${source.endpoint}?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetCapabilities`), payload: 'xml' }
  }
  if (source.source.adapter === 'xyz') return null
  if (source.source.adapter === 'arcgis-mapserver') {
    return { url: compiledUrl(source.endpoint, '', { f: 'json' }), payload: 'json' }
  }
  return { url: compiledUrl(source.endpoint, '', { SERVICE: 'WMTS', VERSION: '1.0.0', REQUEST: 'GetCapabilities' }), payload: 'xml' }
}

/**
 * Compile only an admitted native operation, with no arbitrary service parameters.
 * @param source - host-resolved source and admitted native metadata.
 * @param view - actual current engine, not a source-relative SDK zoom.
 * @param query - operation fields only; route identity fields were admitted separately.
 * @returns a metadata response plan or bounded image URL; refusals never contain the private URL.
 */
export function compileSourceResource(source: ResolvedNativeSource, view: SourceResourceView, query: URLSearchParams): SourceResourcePlan {
  const input = fields(query)
  const resource = required(input, 'resource')
  if (source.adapter === 'arcgis-mapserver') {
    if (resource === 'arcgis-metadata') {
      only(input, ['resource', 'f'])
      equals(input, 'f', 'json')
      return { kind: 'metadata', payload: 'json' }
    }
    if (resource === 'arcgis-tile') return mapserverTile(source, input)
    if (resource === 'arcgis-export') return mapserverExport(source, view, input)
  } else if (source.adapter === 'xyz' && resource === 'xyz-tile') {
    return xyzTile(source, input)
  } else if (source.adapter === 'wmts' && resource === 'wmts') {
    return wmts(source, input)
  }
  denied()
}
