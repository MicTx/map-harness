/**
 * ArcGIS MapServer metadata admission and minimal SDK JSON reconstruction.
 * Transport bounds bytes; this decoder bounds values, depth and native fields.
 * @module @map-harness/map-container/source-mapserver
 */
import { canonicalSourceWkid as nativeWkid, type BasemapSource } from '@map-harness/map-layers'
import { SourceCatalogError } from './source-error.ts'

/** Validated numeric spatial reference without WKT or external references. */
export interface SourceSpatialReference {
  readonly wkid: number
  readonly latestWkid?: number
}

/** Validated extent in its declared native spatial reference. */
export interface SourceExtent {
  readonly xmin: number
  readonly ymin: number
  readonly xmax: number
  readonly ymax: number
  readonly spatialReference: SourceSpatialReference
}

/** One native ArcGIS cache LOD; level is not an application zoom. */
export interface SourceLod {
  readonly level: number
  readonly resolution: number
  readonly scale: number
}

/** Cache geometry copied only from actual validated service metadata. */
export interface SourceTileInfo {
  readonly rows: number
  readonly cols: number
  readonly dpi: number
  readonly format: string
  readonly origin: { readonly x: number; readonly y: number }
  readonly spatialReference: SourceSpatialReference
  readonly lods: readonly SourceLod[]
}

/** Safe numeric layer hierarchy required by native MapImageLayer rendering. */
export interface SourceSublayer {
  readonly id: number
  readonly name: string
  readonly parentLayerId: number
  readonly subLayerIds: readonly number[] | null
  readonly defaultVisibility: boolean
  readonly minScale: number
  readonly maxScale: number
}

/** The complete MapServer metadata whitelist sent to the SDK. */
export interface SourceMapServerInfo {
  readonly currentVersion: number
  readonly capabilities: 'Map' | ''
  readonly singleFusedMapCache: boolean
  readonly spatialReference: SourceSpatialReference
  readonly fullExtent: SourceExtent
  readonly initialExtent: SourceExtent
  readonly copyrightText: string
  readonly supportedImageFormatTypes: string
  readonly supportsDynamicLayers: false
  readonly layers: readonly SourceSublayer[]
  readonly tileInfo?: SourceTileInfo
  readonly maxImageWidth?: number
  readonly maxImageHeight?: number
}

/** Host-only capabilities; no original service document survives admission. */
export interface MapServerMetadata {
  readonly nativeWkid: number
  readonly supportsExport: boolean
  readonly service: SourceMapServerInfo
  readonly tileBounds: readonly MapServerTileBounds[]
}

/** Native cache indices derived from its declared extent, origin and resolution. */
export interface MapServerTileBounds {
  readonly level: number
  readonly minRow: number
  readonly maxRow: number
  readonly minCol: number
  readonly maxCol: number
}

const imageFormats = new Set(['PNG', 'PNG8', 'PNG24', 'PNG32', 'JPG', 'JPEG'])
const tileFormats = new Set([...imageFormats, 'MIXED'])

function unavailable(): never {
  throw new SourceCatalogError('SOURCE_UNAVAILABLE')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) unavailable()
  return value
}

function finite(value: unknown, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) unavailable()
  return value
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const number = finite(value, minimum, maximum)
  if (!Number.isSafeInteger(number)) unavailable()
  return number
}

function spatialReference(value: unknown, expected?: SourceSpatialReference): SourceSpatialReference {
  if (value === undefined && expected !== undefined) return expected
  const raw = object(value)
  const wkid = integer(raw.wkid, 1)
  const latestWkid = raw.latestWkid === undefined ? undefined : integer(raw.latestWkid, 1)
  if (latestWkid !== undefined && nativeWkid(latestWkid) !== nativeWkid(wkid)) unavailable()
  const normalized = nativeWkid(latestWkid ?? wkid)
  if (expected !== undefined && normalized !== nativeWkid(expected.latestWkid ?? expected.wkid)) unavailable()
  return { wkid: wkid === 900913 ? 3857 : wkid, ...(latestWkid === undefined ? {} : { latestWkid }) }
}

function extent(value: unknown, reference: SourceSpatialReference): SourceExtent {
  const raw = object(value)
  const xmin = finite(raw.xmin)
  const ymin = finite(raw.ymin)
  const xmax = finite(raw.xmax)
  const ymax = finite(raw.ymax)
  if (xmin >= xmax || ymin >= ymax || !Number.isFinite(xmax - xmin) || !Number.isFinite(ymax - ymin)) unavailable()
  return { xmin, ymin, xmax, ymax, spatialReference: spatialReference(raw.spatialReference, reference) }
}

function tileInfo(value: unknown, reference: SourceSpatialReference): SourceTileInfo {
  const raw = object(value)
  const origin = object(raw.origin)
  const format = typeof raw.format === 'string' ? raw.format.toUpperCase() : ''
  if (!tileFormats.has(format) || !Array.isArray(raw.lods) || raw.lods.length === 0 || raw.lods.length > 64) unavailable()
  const lods = raw.lods.map((value: unknown): SourceLod => {
    const lod = object(value)
    const resolution = finite(lod.resolution, Number.MIN_VALUE)
    const scale = finite(lod.scale, Number.MIN_VALUE)
    return { level: integer(lod.level, 0, 32), resolution, scale }
  })
  for (let index = 1; index < lods.length; index += 1) {
    const previous = lods[index - 1]!
    const current = lods[index]!
    if (previous.level >= current.level || previous.resolution <= current.resolution || previous.scale <= current.scale) unavailable()
  }
  return {
    rows: integer(raw.rows, 1, 4_096),
    cols: integer(raw.cols, 1, 4_096),
    dpi: finite(raw.dpi, Number.MIN_VALUE, 1_200),
    format,
    origin: { x: finite(origin.x), y: finite(origin.y) },
    spatialReference: spatialReference(raw.spatialReference, reference),
    lods,
  }
}

function sublayers(value: unknown): readonly SourceSublayer[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 256) unavailable()
  const layers = value.map((value: unknown): SourceSublayer => {
    const raw = object(value)
    const id = integer(raw.id, 0, 2_147_483_647)
    const parentLayerId = raw.parentLayerId === undefined ? -1 : integer(raw.parentLayerId, -1, 2_147_483_647)
    if (typeof raw.defaultVisibility !== 'boolean') unavailable()
    const children = raw.subLayerIds
    if (children !== undefined && children !== null && !Array.isArray(children)) unavailable()
    const subLayerIds = children === undefined || children === null ? null : children.map((child: unknown) => integer(child, 0, 2_147_483_647))
    if (subLayerIds !== null && new Set(subLayerIds).size !== subLayerIds.length) unavailable()
    const minScale = raw.minScale === undefined ? 0 : finite(raw.minScale, 0)
    const maxScale = raw.maxScale === undefined ? 0 : finite(raw.maxScale, 0)
    if (minScale > 0 && maxScale > 0 && minScale < maxScale) unavailable()
    return { id, name: String(id), parentLayerId, subLayerIds, defaultVisibility: raw.defaultVisibility, minScale, maxScale }
  })
  const byId = new Map(layers.map(layer => [layer.id, layer]))
  if (byId.size !== layers.length) unavailable()
  for (const layer of layers) {
    if (layer.parentLayerId !== -1 && !byId.get(layer.parentLayerId)?.subLayerIds?.includes(layer.id)) unavailable()
    for (const child of layer.subLayerIds ?? []) if (byId.get(child)?.parentLayerId !== layer.id) unavailable()
    const visited = new Set<number>()
    let cursor: SourceSublayer | undefined = layer
    while (cursor !== undefined) {
      if (visited.has(cursor.id)) unavailable()
      visited.add(cursor.id)
      cursor = cursor.parentLayerId === -1 ? undefined : byId.get(cursor.parentLayerId)
    }
  }
  return layers
}

function enforceBudget(value: unknown): void {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let count = 0
  while (pending.length > 0) {
    const current = pending.pop()!
    count += 1
    if (count > 16_384 || current.depth > 32) throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
    if (typeof current.value !== 'object' || current.value === null) continue
    const children = Object.values(current.value)
    if (children.length + pending.length + count > 16_384) throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 })
  }
}

function cacheBounds(service: SourceMapServerInfo): readonly MapServerTileBounds[] {
  const info = service.tileInfo
  if (info === undefined) return []
  const extent = service.fullExtent
  return info.lods.map(lod => {
    const width = lod.resolution * info.cols
    const height = lod.resolution * info.rows
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) unavailable()
    const minCol = Math.floor((extent.xmin - info.origin.x) / width)
    const maxCol = Math.ceil((extent.xmax - info.origin.x) / width) - 1
    const minRow = Math.floor((info.origin.y - extent.ymax) / height)
    const maxRow = Math.ceil((info.origin.y - extent.ymin) / height) - 1
    if (![minCol, maxCol, minRow, maxRow].every(Number.isSafeInteger) || minCol > maxCol || minRow > maxRow) unavailable()
    return { level: lod.level, minCol, maxCol, minRow, maxRow }
  })
}

/**
 * Decode one bounded MapServer document into minimal native SDK metadata.
 * @param source - already-validated public source descriptor, not host credentials.
 * @param body - transport-bounded UTF8 bytes; original metadata stays host-only.
 * @returns reconstructed metadata; malformed or incompatible data rejects without a partial result or raw error cause.
 */
export function parseMapServerMetadata(source: BasemapSource, body: Uint8Array): MapServerMetadata {
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch (error) {
    // Both external byte and JSON syntax failures must discard the original text.
    if (error instanceof SyntaxError || error instanceof TypeError) unavailable()
    throw error
  }
  enforceBudget(value)
  const raw = object(value)
  if (raw.error !== undefined || typeof raw.singleFusedMapCache !== 'boolean') unavailable()
  const reference = spatialReference(raw.spatialReference)
  const wkid = nativeWkid(reference.latestWkid ?? reference.wkid)
  if (wkid !== nativeWkid(source.nativeWkid)) unavailable()
  const formats = raw.supportedImageFormatTypes
  if (formats !== undefined && (typeof formats !== 'string' || formats.length > 1_024)) unavailable()
  const supported = typeof formats === 'string' ? [...new Set(formats.split(',').map(value => value.trim().toUpperCase()).filter(value => imageFormats.has(value)))] : []
  const capabilities = raw.capabilities
  if (capabilities !== undefined && (typeof capabilities !== 'string' || capabilities.length > 1_024)) unavailable()
  const supportsExport = typeof capabilities === 'string' && capabilities.split(',').some(value => value.trim().toLowerCase() === 'map') && supported.length > 0
  const fullExtent = extent(raw.fullExtent, reference)
  const service: SourceMapServerInfo = {
    currentVersion: finite(raw.currentVersion, 9, 99),
    capabilities: supportsExport ? 'Map' : '',
    singleFusedMapCache: raw.singleFusedMapCache,
    spatialReference: reference,
    fullExtent,
    initialExtent: raw.initialExtent === undefined ? fullExtent : extent(raw.initialExtent, reference),
    copyrightText: source.attribution,
    supportedImageFormatTypes: supported.join(','),
    supportsDynamicLayers: false,
    layers: sublayers(raw.layers),
    ...(raw.singleFusedMapCache ? { tileInfo: tileInfo(raw.tileInfo, reference) } : {}),
    ...(raw.maxImageWidth === undefined ? {} : { maxImageWidth: Math.min(integer(raw.maxImageWidth, 1, 65_536), 4_096) }),
    ...(raw.maxImageHeight === undefined ? {} : { maxImageHeight: Math.min(integer(raw.maxImageHeight, 1, 65_536), 4_096) }),
  }
  if (!service.singleFusedMapCache && !supportsExport) unavailable()
  return { nativeWkid: wkid, supportsExport, service, tileBounds: cacheBounds(service) }
}
