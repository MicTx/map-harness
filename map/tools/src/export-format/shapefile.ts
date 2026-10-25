/**
 * Minimal Shapefile writer for `data_export`: real SHP/SHX/DBF/PRJ
 * components packed as a stored-method ZIP. The input is always the
 * canonical WGS84 collection; one export carries exactly one geometry
 * family (point / line / polygon — Multi* map onto SHP's native
 * multi-part records), and a mixed collection refuses with per-type
 * counts instead of degrading. DBF fields are fixed-width: a string
 * property whose UTF-8 bytes exceed the 254-byte dBASE limit fails loudly
 * naming the field, never truncating silently. Ring orientation is
 * normalized on write (outer clockwise, holes counter-clockwise) so the
 * reader-side regrouping reproduces holes.
 */
import type { GeoJsonFeatureCollection } from '@map-harness/map-container'
import { SpatialError } from '../spatial-errors.ts'
import { zipBytesOf } from './zip.ts'

/** SHP shape type codes this writer emits. */
const SHP_POINT = 1
const SHP_MULTIPOINT = 8
const SHP_POLYLINE = 3
const SHP_POLYGON = 5

/** dBASE string field byte-width ceiling. */
const MAX_DBF_FIELD_BYTES = 254

/** The WKT carried as .prj for every export (WGS84 geographic). */
const WGS84_PRJ_WKT = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'

type Position = [number, number]

/** One feature flattened for writing: geometry parts plus properties. */
interface FlatFeature {
  readonly points: readonly Position[] | null
  readonly partSets: readonly Position[][] | null
  readonly properties: Record<string, unknown>
}

/** Signed area of one ring (positive = counter-clockwise). */
function signedAreaOf(ring: readonly Position[]): number {
  let sum = 0
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index]!
    const [x2, y2] = ring[index + 1]!
    sum += x1 * y2 - x2 * y1
  }
  return sum
}

/** Reverse one ring's point order. */
function reversedRing(ring: readonly Position[]): Position[] {
  return [...ring].reverse()
}

/**
 * Flatten one feature's geometry into the writer's family model.
 * @returns the flat feature, or `undefined` for null geometries.
 */
function flattenGeometry(feature: { geometry: { type: string; coordinates?: unknown } | null; properties?: Record<string, unknown> }): FlatFeature | undefined {
  const geometry = feature.geometry
  const properties = feature.properties ?? {}
  if (geometry === null) return undefined
  if (geometry.type === 'Point') {
    return { points: [geometry.coordinates as Position], partSets: null, properties }
  }
  if (geometry.type === 'MultiPoint') {
    return { points: geometry.coordinates as Position[], partSets: null, properties }
  }
  if (geometry.type === 'LineString') {
    return { points: null, partSets: [geometry.coordinates as Position[]], properties }
  }
  if (geometry.type === 'MultiLineString') {
    return { points: null, partSets: geometry.coordinates as Position[][], properties }
  }
  if (geometry.type === 'Polygon') {
    const rings = geometry.coordinates as Position[][]
    return { points: null, partSets: orientPolygon(rings), properties }
  }
  if (geometry.type === 'MultiPolygon') {
    const polygons = geometry.coordinates as Position[][][]
    return { points: null, partSets: polygons.flatMap(polygon => orientPolygon(polygon)), properties }
  }
  throw new SpatialError('GEOMETRY_UNSUPPORTED', `feature geometry "${geometry.type}" has no shapefile mapping (export as geojson)`)
}

/** Orient one polygon's rings for SHP: outer clockwise, holes CCW. */
function orientPolygon(rings: readonly Position[][]): Position[][] {
  return rings.map((ring, index) => {
    const wantClockwise = index === 0
    const isClockwise = signedAreaOf(ring) < 0
    return wantClockwise === isClockwise ? [...ring] : reversedRing(ring)
  })
}

/** DBF field descriptor. */
interface DbfField {
  /** Original property key the cells read from. */
  readonly key: string
  /** dBASE column name (≤10 bytes, unique). */
  readonly name: string
  readonly type: 'C' | 'N' | 'L'
  readonly length: number
  readonly decimal: number
}

/** Shorten one property key to a unique ≤10-byte dBASE field name. */
function fieldNameOf(key: string, taken: Set<string>): string {
  let base = Buffer.from(key, 'utf8').subarray(0, 10).toString('utf8')
  // A multibyte cut can leave a broken trailing sequence; drop it.
  while (base.length > 0 && /[\uFFFD]$/.test(base) === true && Buffer.byteLength(base, 'utf8') > 10) {
    base = base.slice(0, -1)
  }
  let candidate = base
  let suffix = 0
  while (taken.has(candidate)) {
    suffix += 1
    const tail = `_${suffix}`
    candidate = Buffer.from(base, 'utf8').subarray(0, 10 - tail.length).toString('utf8') + tail
  }
  taken.add(candidate)
  return candidate
}

/** Derive the DBF field set from every feature's properties. */
function dbfFieldsOf(features: readonly FlatFeature[]): DbfField[] {
  const keys: string[] = []
  for (const feature of features) {
    for (const key of Object.keys(feature.properties)) {
      if (!keys.includes(key)) keys.push(key)
    }
  }
  const taken = new Set<string>()
  return keys.map(key => {
    const values = features.map(feature => feature.properties[key]).filter(value => value !== null && value !== undefined)
    const name = fieldNameOf(key, taken)
    const base = { key, name }
    if (values.every(value => typeof value === 'boolean')) return { ...base, type: 'L', length: 1, decimal: 0 }
    if (values.length > 0 && values.every(value => typeof value === 'number' && Number.isFinite(value))) {
      const texts = values.map(value => String(value))
      const maxLength = Math.max(...texts.map(text => text.length))
      const maxDecimal = Math.max(0, ...texts.map(text => {
        const dot = text.indexOf('.')
        return dot === -1 ? 0 : text.length - dot - 1
      }))
      return { ...base, type: 'N', length: Math.max(maxLength, 1), decimal: Math.min(maxDecimal, 15) }
    }
    const byteLength = Math.max(1, ...values.map(value => {
      const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
      return Buffer.byteLength(text, 'utf8')
    }))
    if (byteLength > MAX_DBF_FIELD_BYTES) {
      throw new SpatialError(
        'INVALID_ARGUMENT',
        `property "${key}" needs ${byteLength} bytes, above the ${MAX_DBF_FIELD_BYTES}-byte dBASE field limit; shorten the value or export as geojson`,
      )
    }
    return { ...base, type: 'C', length: byteLength, decimal: 0 }
  })
}

/** Encode one cell for the declared field. */
function dbfCellOf(field: DbfField, value: unknown): Buffer {
  if (value === null || value === undefined) return Buffer.alloc(field.length, 0x20)
  if (field.type === 'L') return Buffer.from(value === true || value === 'true' ? 'T' : 'F', 'latin1')
  const text = field.type === 'N'
    ? String(value)
    : typeof value === 'object' ? JSON.stringify(value) : String(value)
  const encoded = Buffer.from(text, 'utf8')
  if (encoded.length > field.length) {
    // Numbers were sized to their maximum; a breach here is a writer bug.
    throw new SpatialError('INVALID_ARGUMENT', `property value "${text.slice(0, 32)}" exceeds its computed dBASE width`)
  }
  const padded = Buffer.alloc(field.length, field.type === 'N' ? 0x20 : 0x20)
  if (field.type === 'N') {
    encoded.copy(padded, field.length - encoded.length)
  } else {
    encoded.copy(padded, 0)
  }
  return padded
}

/** Build the .dbf component. */
function dbfBytesOf(features: readonly FlatFeature[], fields: readonly DbfField[]): Buffer {
  const recordLength = 1 + fields.reduce((sum, field) => sum + field.length, 0)
  const headerLength = 32 + 32 * fields.length + 1
  const header = Buffer.alloc(headerLength)
  header.writeUInt8(0x03, 0)
  // The last-update date pins to 1980-01-01 like the ZIP stamp: identical
  // input must serialize to identical bytes so artifact digests stay
  // content-addressed and recorded replays compare byte-exact.
  header.writeUInt8(80, 1)
  header.writeUInt8(1, 2)
  header.writeUInt8(1, 3)
  header.writeUInt32LE(features.length, 4)
  header.writeUInt16LE(headerLength, 8)
  header.writeUInt16LE(recordLength, 10)
  header.writeUInt8(0x57, 29)
  fields.forEach((field, index) => {
    const at = 32 + index * 32
    Buffer.from(field.name, 'utf8').subarray(0, 11).copy(header, at)
    header.writeUInt8(field.type.charCodeAt(0), at + 11)
    header.writeUInt8(field.length, at + 16)
    header.writeUInt8(field.decimal, at + 17)
  })
  header.writeUInt8(0x0D, headerLength - 1)
  const records = Buffer.alloc(features.length * recordLength + 1)
  features.forEach((feature, rowIndex) => {
    const base = rowIndex * recordLength
    records.writeUInt8(0x20, base)
    let cursor = base + 1
    for (const field of fields) {
      const cell = dbfCellOf(field, feature.properties[field.key] ?? null)
      cell.copy(records, cursor)
      cursor += field.length
    }
  })
  records.writeUInt8(0x1A, features.length * recordLength)
  return Buffer.concat([header, records])
}

/** One SHP record body builder per family. */
function shpRecordOf(shapeType: number, flat: FlatFeature): { content: Buffer; contentWords: number } {
  let content: Buffer
  if (shapeType === SHP_POINT) {
    const [x, y] = flat.points![0]!
    content = Buffer.alloc(20)
    content.writeInt32LE(shapeType, 0)
    content.writeDoubleLE(x, 4)
    content.writeDoubleLE(y, 12)
  } else {
    const parts = shapeType === SHP_MULTIPOINT ? null : flat.partSets!
    const points = shapeType === SHP_MULTIPOINT ? flat.points! : parts!.flat()
    const xs = points.map(point => point[0])
    const ys = points.map(point => point[1])
    if (shapeType === SHP_MULTIPOINT) {
      content = Buffer.alloc(40 + points.length * 16)
      content.writeInt32LE(shapeType, 0)
      content.writeDoubleLE(Math.min(...xs), 4)
      content.writeDoubleLE(Math.min(...ys), 12)
      content.writeDoubleLE(Math.max(...xs), 20)
      content.writeDoubleLE(Math.max(...ys), 28)
      content.writeInt32LE(points.length, 36)
      points.forEach(([x, y], index) => {
        content.writeDoubleLE(x, 40 + index * 16)
        content.writeDoubleLE(y, 48 + index * 16)
      })
    } else {
      content = Buffer.alloc(44 + parts!.length * 4 + points.length * 16)
      content.writeInt32LE(shapeType, 0)
      content.writeDoubleLE(Math.min(...xs), 4)
      content.writeDoubleLE(Math.min(...ys), 12)
      content.writeDoubleLE(Math.max(...xs), 20)
      content.writeDoubleLE(Math.max(...ys), 28)
      content.writeInt32LE(parts!.length, 36)
      content.writeInt32LE(points.length, 40)
      let cursor = 0
      parts!.forEach((part, partIndex) => {
        content.writeInt32LE(cursor, 44 + partIndex * 4)
        cursor += part.length
      })
      points.forEach(([x, y], index) => {
        content.writeDoubleLE(x, 44 + parts!.length * 4 + index * 16)
        content.writeDoubleLE(y, 44 + parts!.length * 4 + index * 16 + 8)
      })
    }
  }
  return { content, contentWords: content.length / 2 }
}

/** The geometry-type census an export refuses with when families mix. */
function censusOf(collection: GeoJsonFeatureCollection): string {
  const counts = new Map<string, number>()
  for (const feature of collection.features as Array<{ geometry: { type: string } | null }>) {
    const type = feature.geometry?.type ?? 'null'
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts.entries()].map(([type, count]) => `${type}:${count}`).join(', ')
}

/**
 * Serialize one WGS84 collection as a real shapefile ZIP
 * (.shp/.shx/.dbf/.prj/.cpg, stored method).
 * @param collection - canonical WGS84 FeatureCollection.
 * @param options - the base name for the component files.
 * @returns the packed ZIP bytes.
 * @throws {SpatialError} `GEOMETRY_UNSUPPORTED` when geometry families mix;
 *   `INVALID_ARGUMENT` when a string property exceeds the dBASE width
 *   limit (the field is named) or a width contract is breached.
 */
export function shapefileBytesOf(collection: GeoJsonFeatureCollection, options: { readonly name: string }): Buffer {
  const flats = (collection.features as Array<{ geometry: { type: string; coordinates?: unknown } | null; properties?: Record<string, unknown> }>)
    .map(flattenGeometry)
    .filter((flat): flat is FlatFeature => flat !== undefined)
  if (flats.length === 0) {
    throw new SpatialError('GEOMETRY_UNSUPPORTED', 'shapefile export requires at least one supported geometry')
  }
  const allSinglePoints = flats.every(flat => flat.points !== null && flat.points.length === 1)
  const allPoints = flats.every(flat => flat.points !== null)
  const types = new Set((collection.features as Array<{ geometry: { type: string } | null }>).map(feature => feature.geometry?.type))
  const lineTypes = new Set(['LineString', 'MultiLineString'])
  const polygonTypes = new Set(['Polygon', 'MultiPolygon'])
  const pointTypes = new Set(['Point', 'MultiPoint'])
  const hasLine = [...types].some(type => lineTypes.has(type ?? ''))
  const hasPolygon = [...types].some(type => polygonTypes.has(type ?? ''))
  const hasPoint = [...types].some(type => pointTypes.has(type ?? ''))
  const lineOrPolygonOnly = !hasPoint && hasLine !== hasPolygon
  let shapeType: number
  if (allPoints) {
    shapeType = allSinglePoints ? SHP_POINT : SHP_MULTIPOINT
  } else if (lineOrPolygonOnly) {
    shapeType = hasPolygon ? SHP_POLYGON : SHP_POLYLINE
  } else {
    throw new SpatialError('GEOMETRY_UNSUPPORTED', `mixed geometry families cannot share one shapefile: ${censusOf(collection)}; export as geojson or split the layer`)
  }
  const records: Array<{ content: Buffer; contentWords: number }> = flats.map(flat => shpRecordOf(shapeType, flat))
  let offsetWords = 50
  const offsets: Array<{ offsetWords: number; contentWords: number }> = []
  const chunks: Buffer[] = []
  records.forEach((record, index) => {
    const header = Buffer.alloc(8)
    header.writeInt32BE(index + 1, 0)
    header.writeInt32BE(record.contentWords, 4)
    chunks.push(header, record.content)
    offsets.push({ offsetWords, contentWords: record.contentWords })
    offsetWords += 4 + record.contentWords
  })
  const body = Buffer.concat(chunks)
  const fileBytes = 100 + body.length
  const xs = flats.flatMap(flat => flat.points !== null ? [...flat.points] : flat.partSets!.flat()).map(point => point[0])
  const ys = flats.flatMap(flat => flat.points !== null ? [...flat.points] : flat.partSets!.flat()).map(point => point[1])
  const shpHeader = Buffer.alloc(100)
  shpHeader.writeInt32BE(9994, 0)
  shpHeader.writeInt32BE(Math.ceil(fileBytes / 2), 24)
  shpHeader.writeInt32LE(1000, 28)
  shpHeader.writeInt32LE(shapeType, 32)
  shpHeader.writeDoubleLE(Math.min(...xs), 36)
  shpHeader.writeDoubleLE(Math.max(...xs), 44)
  shpHeader.writeDoubleLE(Math.min(...ys), 52)
  shpHeader.writeDoubleLE(Math.max(...ys), 60)
  const shxHeader = Buffer.alloc(100)
  shxHeader.writeInt32BE(9994, 0)
  shxHeader.writeInt32BE(50 + offsets.length * 4, 24)
  shxHeader.writeInt32LE(1000, 28)
  const shxRecords = Buffer.alloc(offsets.length * 8)
  offsets.forEach((offset, index) => {
    shxRecords.writeInt32BE(offset.offsetWords, index * 8)
    shxRecords.writeInt32BE(offset.contentWords, index * 8 + 4)
  })
  // dBASE field names map 1:1 onto property keys unless deduped; carry the
  // deduped set so cells read the original values.
  const fields = dbfFieldsOf(flats)
  const dbf = dbfBytesOf(flats, fields)
  const safeName = options.name.replace(/\.zip$/i, '')
  return zipBytesOf([
    { name: `${safeName}.shp`, data: Buffer.concat([shpHeader, body]) },
    { name: `${safeName}.shx`, data: Buffer.concat([shxHeader, shxRecords]) },
    { name: `${safeName}.dbf`, data: dbf },
    { name: `${safeName}.prj`, data: Buffer.from(WGS84_PRJ_WKT, 'latin1') },
    { name: `${safeName}.cpg`, data: Buffer.from('UTF-8', 'latin1') },
  ])
}
