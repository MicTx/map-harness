/**
 * Synthetic shapefile ZIP generator for import fixtures (test-only). Builds
 * minimal but spec-conformant .shp/.shx/.dbf/.prj/.cpg components and packs
 * them into stored-method ZIPs with a hand-rolled writer, so malformed
 * variants (traversal names, inflated declared sizes, lying local headers)
 * are as constructible as valid ones. Every fixture is synthetic data.
 */
import { crc32, deflateRawSync } from 'node:zlib'

/** SHP shape type codes this generator emits. */
export const SHAPE_TYPES = { point: 1, polyline: 3, polygon: 5, multipoint: 8 }

/**
 * Build the .shp component for a list of geometries.
 * @param {number} shapeType - SHP type code (1, 3, 5, or 8).
 * @param {Array} geometries - shapes in the per-type layout below.
 * @returns {{ bytes: Buffer, recordOffsets: Array<{ offsetWords: number, contentWords: number }> }}
 *   point geometry: [x, y]; polyline/polygon: { parts: [[ [x, y], … ], …] };
 *   multipoint: [[x, y], …].
 */
export function buildShp(shapeType, geometries) {
  const records = []
  let bbox = [Infinity, Infinity, -Infinity, -Infinity]
  const expand = (points) => {
    for (const [x, y] of points) {
      bbox[0] = Math.min(bbox[0], x); bbox[1] = Math.min(bbox[1], y)
      bbox[2] = Math.max(bbox[2], x); bbox[3] = Math.max(bbox[3], y)
    }
  }
  geometries.forEach((geometry, index) => {
    let content
    const boxOf = (points) => {
      const xs = points.map(point => point[0])
      const ys = points.map(point => point[1])
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
    }
    if (shapeType === SHAPE_TYPES.point) {
      const [x, y] = geometry
      expand([[x, y]])
      content = Buffer.alloc(20)
      content.writeInt32LE(shapeType, 0)
      content.writeDoubleLE(x, 4)
      content.writeDoubleLE(y, 12)
    } else if (shapeType === SHAPE_TYPES.multipoint) {
      expand(geometry)
      const box = boxOf(geometry)
      content = Buffer.alloc(40 + geometry.length * 16)
      content.writeInt32LE(shapeType, 0)
      content.writeDoubleLE(box[0], 4)
      content.writeDoubleLE(box[1], 12)
      content.writeDoubleLE(box[2], 20)
      content.writeDoubleLE(box[3], 28)
      content.writeInt32LE(geometry.length, 36)
      geometry.forEach(([x, y], point) => {
        content.writeDoubleLE(x, 40 + point * 16)
        content.writeDoubleLE(y, 48 + point * 16)
      })
    } else {
      const parts = geometry.parts
      const points = parts.flat()
      expand(points)
      const box = boxOf(points)
      content = Buffer.alloc(44 + parts.length * 4 + points.length * 16)
      content.writeInt32LE(shapeType, 0)
      content.writeDoubleLE(box[0], 4)
      content.writeDoubleLE(box[1], 12)
      content.writeDoubleLE(box[2], 20)
      content.writeDoubleLE(box[3], 28)
      content.writeInt32LE(parts.length, 36)
      content.writeInt32LE(points.length, 40)
      let cursor = 0
      parts.forEach((part, partIndex) => {
        content.writeInt32LE(cursor, 44 + partIndex * 4)
        cursor += part.length
      })
      points.forEach(([x, y], pointIndex) => {
        content.writeDoubleLE(x, 44 + parts.length * 4 + pointIndex * 16)
        content.writeDoubleLE(y, 44 + parts.length * 4 + pointIndex * 16 + 8)
      })
    }
    records.push({ index: index + 1, content })
  })
  let offsetWords = 50
  const recordOffsets = []
  const chunks = []
  for (const record of records) {
    const contentWords = record.content.length / 2
    const header = Buffer.alloc(8)
    header.writeInt32BE(record.index, 0)
    header.writeInt32BE(contentWords, 4)
    chunks.push(header, record.content)
    recordOffsets.push({ offsetWords, contentWords })
    offsetWords += 4 + contentWords
  }
  const body = Buffer.concat(chunks)
  const fileBytes = 100 + body.length
  const head = Buffer.alloc(100)
  head.writeInt32BE(9994, 0)
  head.writeInt32BE(Math.ceil(fileBytes / 2), 24)
  head.writeInt32LE(1000, 28)
  head.writeInt32LE(shapeType, 32)
  if (Number.isFinite(bbox[0])) {
    head.writeDoubleLE(bbox[0], 36); head.writeDoubleLE(bbox[2], 44)
    head.writeDoubleLE(bbox[1], 52); head.writeDoubleLE(bbox[3], 60)
  }
  return { bytes: Buffer.concat([head, body]), recordOffsets }
}

/**
 * Build the .shx index component for the offsets a {@link buildShp} run recorded.
 * @param {Array<{ offsetWords: number, contentWords: number }>} recordOffsets
 * @returns {Buffer}
 */
export function buildShx(recordOffsets) {
  const head = Buffer.alloc(100)
  head.writeInt32BE(9994, 0)
  head.writeInt32BE(50 + recordOffsets.length * 4, 24)
  head.writeInt32LE(1000, 28)
  head.writeInt32LE(0, 32)
  const records = Buffer.alloc(recordOffsets.length * 8)
  recordOffsets.forEach((record, index) => {
    records.writeInt32BE(record.offsetWords, index * 8)
    records.writeInt32BE(record.contentWords, index * 8 + 4)
  })
  return Buffer.concat([head, records])
}

/**
 * Build the .dbf attribute component.
 * @param {object} options
 * @param {Array<{name: string, type?: string, length: number, decimal?: number}>} options.fields
 * @param {Array<Array<string|number|Uint8Array>>} options.rows - one value per field,
 *   pre-encoded when given as bytes (non-ASCII fixtures).
 * @param {number} [options.ldid=0] - language driver id written at header byte 29.
 * @returns {Buffer}
 */
export function buildDbf({ fields, rows, ldid = 0 }) {
  const recordLength = 1 + fields.reduce((sum, field) => sum + field.length, 0)
  const headerLength = 32 + 32 * fields.length + 1
  const header = Buffer.alloc(headerLength)
  const now = new Date()
  header.writeUInt8(0x03, 0)
  header.writeUInt8(now.getFullYear() - 1900, 1)
  header.writeUInt8(now.getMonth() + 1, 2)
  header.writeUInt8(now.getDate(), 3)
  header.writeUInt32LE(rows.length, 4)
  header.writeUInt16LE(headerLength, 8)
  header.writeUInt16LE(recordLength, 10)
  header.writeUInt8(ldid, 29)
  fields.forEach((field, index) => {
    const at = 32 + index * 32
    const name = field.name instanceof Uint8Array ? Buffer.from(field.name) : Buffer.from(field.name, 'latin1')
    name.copy(header, at, 0, Math.min(11, name.length))
    header.writeUInt8(field.type?.charCodeAt(0) ?? 0x43, at + 11)
    header.writeUInt8(field.length, at + 16)
    header.writeUInt8(field.decimal ?? 0, at + 17)
  })
  header.writeUInt8(0x0D, headerLength - 1)
  const body = Buffer.alloc(rows.length * recordLength + 1)
  rows.forEach((row, rowIndex) => {
    const base = rowIndex * recordLength
    body.writeUInt8(0x20, base)
    let cursor = base + 1
    row.forEach((value, fieldIndex) => {
      const field = fields[fieldIndex]
      let encoded
      if (value instanceof Uint8Array) encoded = Buffer.from(value)
      else encoded = Buffer.from(String(value), 'latin1')
      encoded.copy(body, cursor, 0, field.length)
      cursor += field.length
    })
  })
  body.writeUInt8(0x1A, rows.length * recordLength)
  return Buffer.concat([header, body])
}

/**
 * Pack entries into a ZIP (stored method by default; deflate on request).
 * @param {Array<{name: string, data: Buffer|Uint8Array, deflate?: boolean, declaredSize?: number}>} entries
 *   `declaredSize` lies in the central directory on purpose (malformed fixtures).
 * @returns {Buffer}
 */
export function zipOf(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  const stamp = (buffer, at) => {
    buffer.writeUInt16LE(0, at)
    buffer.writeUInt16LE(0x21, at + 2)
  }
  for (const entry of entries) {
    const payload = entry.deflate ? deflateRawSync(Buffer.from(entry.data)) : Buffer.from(entry.data)
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(Buffer.from(entry.data)) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8)
    stamp(local, 10)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.declaredSize ?? entry.data.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, payload)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10)
    stamp(central, 12)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.declaredSize ?? entry.data.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuffer)
    offset += 30 + nameBuffer.length + payload.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/**
 * Build one valid shapefile ZIP from geometries and attribute rows.
 * @param {object} options - `shapeType`, `geometries`, `fields`, `rows`,
 *   `prj` (string | null), `cpg` (string | null), `ldid` (number), `basename`.
 * @returns {Buffer} the packed ZIP.
 */
export function shapefileZip({ shapeType, geometries, fields = [], rows = [], prj = null, cpg = null, ldid = 0, basename = 'layer' }) {
  const shp = buildShp(shapeType, geometries)
  const entries = [
    { name: `${basename}.shp`, data: shp.bytes },
    { name: `${basename}.shx`, data: buildShx(shp.recordOffsets) },
    { name: `${basename}.dbf`, data: buildDbf({ fields, rows, ldid }) },
  ]
  if (prj !== null) entries.push({ name: `${basename}.prj`, data: Buffer.from(prj, 'latin1') })
  if (cpg !== null) entries.push({ name: `${basename}.cpg`, data: Buffer.from(cpg, 'latin1') })
  return zipOf(entries)
}

/** ESRI WKT for CGCS2000 / 3-degree Gauss-Kruger CM 117E (EPSG:4547 family). */
export const CGCS2000_CM117_WKT = 'PROJCS["CGCS2000_3_degree_Gauss_Kruger_CM_117E",GEOGCS["GCS_China_Geodetic_Coordinate_System_2000",DATUM["D_China_2000",SPHEROID["CGCS2000",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",117.0],PARAMETER["Scale_Factor",1.0],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]'

/** ESRI WKT for a plain WGS84 geographic CRS. */
export const WGS84_WKT = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
