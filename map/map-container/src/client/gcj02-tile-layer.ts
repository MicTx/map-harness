/**
 * Browser tile resampling for GCJ-02 raster annotation sources. Destination
 * tiles remain in Web Mercator while source pixels are sampled through a
 * WGS84 → GCJ-02 coordinate correction.
 */
import BaseTileLayer from '@arcgis/core/layers/BaseTileLayer.js'

const TILE_SIZE = 256
const EARTH_RADIUS = 6_378_245
const EE = 0.006_693_421_622_965_943
const PI = Math.PI

/** One source tile coordinate at a Web Mercator zoom level. */
export interface TileCoord {
  readonly z: number
  readonly x: number
  readonly y: number
}

/** Convert a WGS84 longitude to a fractional XYZ tile x coordinate. */
export function tileXOf(longitude: number, z: number): number {
  return (longitude + 180) / 360 * 2 ** z
}

/** Convert a WGS84 latitude to a fractional XYZ tile y coordinate. */
export function tileYOf(latitude: number, z: number): number {
  const radians = latitude * PI / 180
  return (1 - Math.asinh(Math.tan(radians)) / PI) / 2 * 2 ** z
}

/** Convert a fractional XYZ tile coordinate to WGS84 longitude. */
export function tileLongitudeOf(x: number, z: number): number {
  return x / 2 ** z * 360 - 180
}

/** Convert a fractional XYZ tile coordinate to WGS84 latitude. */
export function tileLatitudeOf(y: number, z: number): number {
  return Math.atan(Math.sinh(PI * (1 - 2 * y / 2 ** z))) * 180 / PI
}

function transformChinaLatitude(x: number, y: number): number {
  let latitude = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  latitude += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3
  latitude += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3
  latitude += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3
  return latitude
}

function transformChinaLongitude(x: number, y: number): number {
  let longitude = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  longitude += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3
  longitude += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3
  longitude += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3
  return longitude
}

/**
 * Convert WGS84 coordinates to GCJ-02 coordinates. Locations outside the
 * China offset region are returned unchanged, matching the raster source
 * behavior used by the annotation tile service.
 */
export function wgs84ToGcj02(longitude: number, latitude: number): readonly [number, number] {
  if (longitude < 72.004 || longitude > 137.8347 || latitude < 0.8293 || latitude > 55.8271) {
    return [longitude, latitude]
  }
  const x = longitude - 105
  const y = latitude - 35
  const latitudeOffset = transformChinaLatitude(x, y)
  const longitudeOffset = transformChinaLongitude(x, y)
  const radians = latitude / 180 * PI
  let magic = Math.sin(radians)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  const latitudeDelta = latitudeOffset * 180 / ((EARTH_RADIUS * (1 - EE)) / (magic * sqrtMagic) * PI)
  const longitudeDelta = longitudeOffset * 180 / (EARTH_RADIUS / sqrtMagic * Math.cos(radians) * PI)
  return [longitude + longitudeDelta, latitude + latitudeDelta]
}

/** The source tiles required to resample one destination tile. */
export function sourceTileRange(z: number, row: number, col: number): { readonly min: TileCoord; readonly max: TileCoord } {
  if (!Number.isInteger(z) || z < 0 || !Number.isInteger(row) || row < 0 || row >= 2 ** z
    || !Number.isInteger(col) || col < 0 || col >= 2 ** z) {
    throw new RangeError('invalid-tile-coordinate')
  }
  const corners = [
    [col, row],
    [col + 1, row],
    [col, row + 1],
    [col + 1, row + 1],
  ] as const
  const source = corners.map(([x, y]) => {
    const [longitude, latitude] = wgs84ToGcj02(tileLongitudeOf(x, z), tileLatitudeOf(y, z))
    return { x: tileXOf(longitude, z), y: tileYOf(latitude, z) }
  })
  const minX = Math.floor(Math.min(...source.map(point => point.x)))
  const maxX = Math.floor(Math.max(...source.map(point => point.x)))
  const minY = Math.floor(Math.min(...source.map(point => point.y)))
  const maxY = Math.floor(Math.max(...source.map(point => point.y)))
  return {
    min: { z, x: Math.max(0, minX), y: Math.max(0, minY) },
    max: { z, x: Math.min(2 ** z - 1, maxX), y: Math.min(2 ** z - 1, maxY) },
  }
}

/** The GCJ-02 source coordinate for one destination tile pixel. */
export function sourcePixelOf(level: number, row: number, col: number, pixelX: number, pixelY: number): readonly [number, number] {
  if (!Number.isInteger(level) || level < 0 || !Number.isInteger(row) || row < 0 || row >= 2 ** level
    || !Number.isInteger(col) || col < 0 || col >= 2 ** level
    || !Number.isInteger(pixelX) || pixelX < 0 || pixelX >= TILE_SIZE
    || !Number.isInteger(pixelY) || pixelY < 0 || pixelY >= TILE_SIZE) {
    throw new RangeError('invalid-tile-coordinate')
  }
  const x = (col * TILE_SIZE + pixelX + 0.5) / TILE_SIZE
  const y = (row * TILE_SIZE + pixelY + 0.5) / TILE_SIZE
  const [longitude, latitude] = wgs84ToGcj02(tileLongitudeOf(x, level), tileLatitudeOf(y, level))
  return [tileXOf(longitude, level) * TILE_SIZE, tileYOf(latitude, level) * TILE_SIZE]
}

async function fetchImage(url: string, signal: AbortSignal | undefined): Promise<CanvasImageSource> {
  const response = await fetch(url, signal === undefined ? undefined : { signal })
  if (!response.ok) throw new Error(`tile-http-${response.status}`)
  const bitmap = await createImageBitmap(await response.blob())
  return bitmap
}

/** A Web Mercator XYZ layer that resamples GCJ-02 source tiles into WGS84 tiles. */
export class Gcj02XYZTileLayer extends BaseTileLayer {
  readonly urlTemplate: string

  constructor(options: { readonly urlTemplate: string; readonly title: string; readonly copyright: string }) {
    super({ title: options.title, copyright: options.copyright })
    this.urlTemplate = options.urlTemplate
  }

  override getTileUrl(level: number, row: number, col: number): string {
    return this.urlTemplate.replaceAll('{z}', String(level)).replaceAll('{x}', String(col)).replaceAll('{y}', String(row))
  }

  override async fetchTile(level: number, row: number, col: number, options?: { readonly signal?: AbortSignal }): Promise<HTMLCanvasElement> {
    const range = sourceTileRange(level, row, col)
    const sourceCanvas = document.createElement('canvas')
    sourceCanvas.width = (range.max.x - range.min.x + 1) * TILE_SIZE
    sourceCanvas.height = (range.max.y - range.min.y + 1) * TILE_SIZE
    const sourceContext = sourceCanvas.getContext('2d')
    if (sourceContext === null) throw new Error('tile-canvas-unavailable')
    for (let sourceY = range.min.y; sourceY <= range.max.y; sourceY += 1) {
      for (let sourceX = range.min.x; sourceX <= range.max.x; sourceX += 1) {
        const image = await fetchImage(this.getTileUrl(level, sourceY, sourceX), options?.signal)
        sourceContext.drawImage(image, (sourceX - range.min.x) * TILE_SIZE, (sourceY - range.min.y) * TILE_SIZE)
      }
    }
    const destination = document.createElement('canvas')
    destination.width = TILE_SIZE
    destination.height = TILE_SIZE
    const destinationContext = destination.getContext('2d')
    if (destinationContext === null) throw new Error('tile-canvas-unavailable')
    const sourcePixels = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height)
    const output = destinationContext.createImageData(TILE_SIZE, TILE_SIZE)
    for (let pixelY = 0; pixelY < TILE_SIZE; pixelY += 1) {
      for (let pixelX = 0; pixelX < TILE_SIZE; pixelX += 1) {
        const [sourceX, sourceY] = sourcePixelOf(level, row, col, pixelX, pixelY)
        const localX = Math.max(0, Math.min(sourceCanvas.width - 1, Math.round(sourceX - range.min.x * TILE_SIZE)))
        const localY = Math.max(0, Math.min(sourceCanvas.height - 1, Math.round(sourceY - range.min.y * TILE_SIZE)))
        const sourceOffset = (localY * sourceCanvas.width + localX) * 4
        const outputOffset = (pixelY * TILE_SIZE + pixelX) * 4
        output.data[outputOffset] = sourcePixels.data[sourceOffset] ?? 0
        output.data[outputOffset + 1] = sourcePixels.data[sourceOffset + 1] ?? 0
        output.data[outputOffset + 2] = sourcePixels.data[sourceOffset + 2] ?? 0
        output.data[outputOffset + 3] = sourcePixels.data[sourceOffset + 3] ?? 0
      }
    }
    destinationContext.putImageData(output, 0, 0)
    return destination
  }
}
