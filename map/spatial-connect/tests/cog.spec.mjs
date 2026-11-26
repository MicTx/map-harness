/**
 * Keyless COG lane: synthetic classic-TIFF and BigTIFF byte streams (tiled
 * and striped, little- and big-endian) served through a scripted ranged
 * fetch — the connected pass for both flavors and both byte orders, the
 * range-discipline verdicts (200 to a range request is an unsupported
 * channel, never a degraded pass), content verdicts (not a TIFF, striped
 * layout, oversized directory), the HTTP error surface (401/404), and the
 * transport failures (deadline, abort, unreachable). Range requests are
 * captured so the byte windows, the read budget (exactly three), and the
 * bearer-token handling are asserted.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COG_MAX_RANGE_REQUESTS } from '../src/contract.ts'
import { verifyCog } from '../src/cog.ts'

const SPEC = { id: 'ortho', url: 'https://cdn.example.org/ortho.tif' }

/** TIFF tag numbers the builder emits. */
const TAG = { WIDTH: 256, HEIGHT: 257, BITS: 258, COMPRESSION: 259, SAMPLES: 277, TILE_W: 322, TILE_H: 323, TILE_OFF: 324, PIXEL_SCALE: 33550, TIEPOINT: 33922, GEOKEYS: 34735, GDAL_META: 42112 }

/** Build a classic or BigTIFF image directory inside one buffer; returns the whole file. */
function buildTiff({ bigTiff = false, littleEndian = true, tiled = true, entryCount = Number.POSITIVE_INFINITY } = {}) {
  const headSize = bigTiff ? 16 : 8
  const countWidth = bigTiff ? 8 : 2
  const entrySize = bigTiff ? 20 : 12
  const nextIfdWidth = bigTiff ? 8 : 4

  /** Classic entry: tag(2) type(2) count(4) value/offset(4); BigTIFF: tag(2) type(2) count(8) value/offset(8). */
  const entries = []
  const push = (tag, fieldType, count, value, valueBytes) => entries.push({ tag, fieldType, count, value, valueBytes })

  const SHORT = 3
  const LONG = 4
  const DOUBLE = 12

  push(TAG.WIDTH, SHORT, 1, 4096)
  push(TAG.HEIGHT, SHORT, 1, 4096)
  push(TAG.BITS, SHORT, 1, 8)
  push(TAG.COMPRESSION, SHORT, 1, 5)
  push(TAG.SAMPLES, SHORT, 1, 3)
  if (tiled) {
    push(TAG.TILE_W, LONG, 1, 512)
    push(TAG.TILE_H, LONG, 1, 512)
    push(TAG.TILE_OFF, LONG, 4, 0, Buffer.alloc(16))
    push(TAG.PIXEL_SCALE, DOUBLE, 3, 0, Buffer.alloc(24))
    push(TAG.TIEPOINT, DOUBLE, 6, 0, Buffer.alloc(48))
    push(TAG.GEOKEYS, SHORT, 4, 0, Buffer.alloc(8))
    push(TAG.GDAL_META, 2, 4, 0, Buffer.alloc(4))
  } else {
    push(TAG.PIXEL_SCALE, DOUBLE, 3, 0, Buffer.alloc(24))
  }
  entries.length = Math.min(entries.length, entryCount)

  const dirOffset = headSize
  const dirBytes = countWidth + entries.length * entrySize + nextIfdWidth
  const total = dirOffset + dirBytes
  const buffer = Buffer.alloc(total)
  buffer.write(littleEndian ? 'II' : 'MM', 0, 'latin1')
  if (littleEndian) {
    buffer.writeUInt16LE(bigTiff ? 43 : 42, 2)
    if (bigTiff) {
      buffer.writeUInt16LE(8, 4)
      buffer.writeUInt16LE(0, 6)
      buffer.writeBigUInt64LE(BigInt(dirOffset), 8)
    } else {
      buffer.writeUInt32LE(dirOffset, 4)
    }
    if (bigTiff) buffer.writeBigUInt64LE(BigInt(entries.length), dirOffset)
    else buffer.writeUInt16LE(entries.length, dirOffset)
    let cursor = dirOffset + countWidth
    for (const entry of entries) {
      buffer.writeUInt16LE(entry.tag, cursor)
      buffer.writeUInt16LE(entry.fieldType, cursor + 2)
      if (bigTiff) buffer.writeBigUInt64LE(BigInt(entry.count), cursor + 4)
      else buffer.writeUInt32LE(entry.count, cursor + 4)
      if (entry.valueBytes !== undefined) {
        entry.valueBytes.copy(buffer, cursor + (bigTiff ? 12 : 8))
      } else if (entry.fieldType === SHORT) {
        // Inline values are left-justified in the slot: natural width at the slot start.
        buffer.writeUInt16LE(entry.value, cursor + (bigTiff ? 12 : 8))
      } else {
        buffer.writeUInt32LE(entry.value, cursor + (bigTiff ? 12 : 8))
      }
      cursor += entrySize
    }
    if (bigTiff) buffer.writeBigUInt64LE(0n, cursor)
    else buffer.writeUInt32LE(0, cursor)
  } else {
    buffer.writeUInt16BE(bigTiff ? 43 : 42, 2)
    if (bigTiff) {
      buffer.writeUInt16BE(8, 4)
      buffer.writeUInt16BE(0, 6)
      buffer.writeBigUInt64BE(BigInt(dirOffset), 8)
    } else {
      buffer.writeUInt32BE(dirOffset, 4)
    }
    if (bigTiff) buffer.writeBigUInt64BE(BigInt(entries.length), dirOffset)
    else buffer.writeUInt16BE(entries.length, dirOffset)
    let cursor = dirOffset + countWidth
    for (const entry of entries) {
      buffer.writeUInt16BE(entry.tag, cursor)
      buffer.writeUInt16BE(entry.fieldType, cursor + 2)
      if (bigTiff) buffer.writeBigUInt64BE(BigInt(entry.count), cursor + 4)
      else buffer.writeUInt32BE(entry.count, cursor + 4)
      if (entry.valueBytes !== undefined) {
        entry.valueBytes.copy(buffer, cursor + (bigTiff ? 12 : 8))
      } else if (entry.fieldType === SHORT) {
        buffer.writeUInt16BE(entry.value, cursor + (bigTiff ? 12 : 8))
      } else {
        buffer.writeUInt32BE(entry.value, cursor + (bigTiff ? 12 : 8))
      }
      cursor += entrySize
    }
    if (bigTiff) buffer.writeBigUInt64BE(0n, cursor)
    else buffer.writeUInt32BE(0, cursor)
  }
  return buffer
}

/** A ranged-fetch over an in-memory buffer: 206 slices, header echo, signal honoring. */
function rangeFetch(file, { statusFor = () => 206, honorSignal = true } = {}) {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, init })
    const match = /bytes=(\d+)-(\d+)/.exec(init.headers.range ?? '')
    if (match === null) throw new Error('no range header on the request')
    const start = Number(match[1])
    const end = Number(match[2])
    const status = statusFor(start, end)
    if (status === 200) {
      return { ok: true, status: 200, headers: { get: () => null }, arrayBuffer: async () => file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) }
    }
    if (status === 401 || status === 404) {
      return { ok: false, status, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }
    }
    const slice = file.subarray(start, end + 1)
    return {
      ok: true,
      status: 206,
      headers: { get: name => (name === 'content-range' ? `bytes ${String(start)}-${String(end)}/${String(file.length)}` : null) },
      arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    }
  }
  return { fetchImpl, requests }
}

test('a classic little-endian tiled TIFF verifies connected with full directory facts', async () => {
  const file = buildTiff()
  const { fetchImpl, requests } = rangeFetch(file)
  const report = await verifyCog(SPEC, {}, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'connected', report.detail)
  assert.equal(report.kind, 'cog')
  const facts = report.facts
  assert.ok(facts !== undefined && 'tiled' in facts)
  assert.equal(facts.bigTiff, false)
  assert.equal(facts.width, 4096)
  assert.equal(facts.height, 4096)
  assert.equal(facts.bitsPerSample, 8)
  assert.equal(facts.samplesPerPixel, 3)
  assert.deepEqual(facts.compression, { code: 5, name: 'lzw' })
  assert.equal(facts.tiled, true)
  assert.equal(facts.tileWidth, 512)
  assert.equal(facts.tileHeight, 512)
  assert.equal(facts.tileCount, 4)
  assert.equal(facts.georeferenced, true)
  assert.equal(facts.hasGeoKeys, true)
  assert.equal(facts.hasGdalMetadata, true)
  // Exactly three range reads: header, directory count, directory entries.
  assert.equal(requests.length, 3)
  assert.equal(requests.length <= COG_MAX_RANGE_REQUESTS, true)
  const [header, count, directory] = requests
  assert.match(header.init.headers.range, /^bytes=0-15$/)
  assert.match(count.init.headers.range, /^bytes=8-9$/)
  assert.match(directory.init.headers.range, /^bytes=8-\d+$/)
})

test('a BigTIFF big-endian tiled TIFF verifies connected', async () => {
  const file = buildTiff({ bigTiff: true, littleEndian: false })
  const { fetchImpl, requests } = rangeFetch(file)
  const report = await verifyCog(SPEC, {}, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'connected', report.detail)
  const facts = report.facts
  assert.ok(facts !== undefined && 'tiled' in facts)
  assert.equal(facts.bigTiff, true)
  assert.equal(facts.width, 4096)
  assert.equal(facts.tileWidth, 512)
  // The directory count for BigTIFF reads 8 bytes at offset 16.
  assert.match(requests[1].init.headers.range, /^bytes=16-23$/)
})

test('a bearer token rides the authorization header on every range request', async () => {
  const file = buildTiff()
  const { fetchImpl, requests } = rangeFetch(file)
  await verifyCog(SPEC, { token: 'TOKEN_XYZ' }, { fetchImpl, now: () => 0 })
  for (const request of requests) {
    assert.equal(request.init.headers.authorization, 'Bearer TOKEN_XYZ')
  }
})

test('a 200 to a range request is an unsupported channel, never a degraded pass', async () => {
  const file = buildTiff()
  const { fetchImpl } = rangeFetch(file, { statusFor: () => 200 })
  const report = await verifyCog(SPEC, {}, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'unsupported-channel')
  assert.match(report.detail, /ranged access|200/)
})

test('a payload without a TIFF byte-order mark is invalid content', async () => {
  const file = Buffer.alloc(64, 0x20)
  const { fetchImpl } = rangeFetch(file)
  const report = await verifyCog(SPEC, {}, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'invalid-content')
  assert.match(report.detail, /byte-order/)
})

test('a striped TIFF is reported as not COG-capable', async () => {
  const file = buildTiff({ tiled: false })
  const { fetchImpl } = rangeFetch(file)
  const report = await verifyCog(SPEC, {}, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'invalid-content')
  assert.match(report.detail, /striped/)
})

test('an oversized directory is refused before the read budget is negotiated', async () => {
  // Hand-craft a header whose IFD count field declares 4096 entries.
  const file = Buffer.alloc(16)
  file.write('II', 0, 'latin1')
  file.writeUInt16LE(42, 2)
  file.writeUInt32LE(8, 4)
  file.writeUInt16LE(4096, 8)
  const { fetchImpl } = rangeFetch(file)
  const report = await verifyCog(SPEC, {}, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'invalid-content')
  assert.match(report.detail, /entries/)
})

test('a 404 is not-found for the declared raster', async () => {
  const file = buildTiff()
  const { fetchImpl } = rangeFetch(file, { statusFor: () => 404 })
  const report = await verifyCog(SPEC, {}, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'not-found')
})

test('a 401 is auth-rejected', async () => {
  const file = buildTiff()
  const { fetchImpl } = rangeFetch(file, { statusFor: () => 401 })
  const report = await verifyCog(SPEC, { token: 'TOKEN_XYZ' }, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'auth-rejected')
  assert.equal(report.detail.includes('TOKEN_XYZ'), false)
})

test('a server returning more bytes than the range asked for is a protocol violation', async () => {
  const file = buildTiff()
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url, init })
    return {
      ok: true, status: 206,
      headers: { get: () => null },
      arrayBuffer: async () => {
        const whole = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
        return whole
      },
    }
  }
  const report = await verifyCog(SPEC, {}, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'protocol-violated')
  assert.match(report.detail, /Range/)
})

test('a transport failure is unreachable and secret-free', async () => {
  const fetchImpl = async () => {
    throw Object.assign(new Error('connect EHOSTUNREACH 203.0.113.9:443'), { code: 'EHOSTUNREACH' })
  }
  const report = await verifyCog(SPEC, { token: 'TOKEN_XYZ' }, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'unreachable')
  assert.match(report.detail, /EHOSTUNREACH/)
  assert.equal(report.detail.includes('TOKEN_XYZ'), false)
})

test('a silent server hits the deadline and reports timeout', async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
  const report = await verifyCog({ ...SPEC, timeoutMs: 1000 }, {}, { fetchImpl, now: () => 0 })
  assert.equal(report.outcome, 'timeout')
})

test('caller abort reports aborted', async () => {
  const controller = new AbortController()
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
  })
  setTimeout(() => controller.abort(), 50)
  const report = await verifyCog({ ...SPEC, timeoutMs: 5000 }, {}, { fetchImpl, signal: controller.signal, now: () => 0 })
  assert.equal(report.outcome, 'aborted')
})
