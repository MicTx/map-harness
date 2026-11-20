/**
 * Stored-method ZIP writer for export artifacts. The container is minimal
 * and deterministic: no compression (the shapefile payloads are already
 * bounded by the feature budget), fixed timestamps, and one central
 * directory plus EOCD — small enough to audit by reading.
 */
import { crc32 } from 'node:zlib'

/** One entry to pack. */
export interface ZipEntryInput {
  readonly name: string
  readonly data: Uint8Array
}

/** The fixed DOS date/time every export carries (1980-01-01 00:00). */
function stamp(buffer: Buffer, at: number): void {
  buffer.writeUInt16LE(0, at)
  buffer.writeUInt16LE(0x21, at + 2)
}

/**
 * Pack entries into a stored-method ZIP.
 * @param entries - named entry payloads.
 * @returns the packed archive bytes.
 */
export function zipBytesOf(entries: readonly ZipEntryInput[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const payload = Buffer.from(entry.data)
    const nameBuffer = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(payload) >>> 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    stamp(local, 10)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(payload.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, payload)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    stamp(central, 12)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(payload.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
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
