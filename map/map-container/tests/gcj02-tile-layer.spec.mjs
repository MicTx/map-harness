import test from 'node:test'
import assert from 'node:assert/strict'
import {
  sourceTileRange,
  sourcePixelOf,
  tileLatitudeOf,
  tileLongitudeOf,
  tileXOf,
  tileYOf,
  wgs84ToGcj02,
} from '../src/client/gcj02-tile-layer.ts'

test('GCJ-02 tile correction round-trips WGS84 screen coordinates', () => {
  const level = 13
  const wgsX = tileXOf(116.404, level) * 256
  const wgsY = tileYOf(39.915, level) * 256
  const row = Math.floor(wgsY / 256)
  const col = Math.floor(wgsX / 256)
  const pixelX = Math.round(wgsX - col * 256)
  const pixelY = Math.round(wgsY - row * 256)
  const [longitude, latitude] = wgs84ToGcj02(
    tileLongitudeOf((col * 256 + pixelX + 0.5) / 256, level),
    tileLatitudeOf((row * 256 + pixelY + 0.5) / 256, level),
  )
  const corrected = sourcePixelOf(level, row, col, pixelX, pixelY)
  assert.ok(Math.abs(tileLongitudeOf(corrected[0] / 256, level) - longitude) < 1e-10)
  assert.ok(Math.abs(tileLatitudeOf(corrected[1] / 256, level) - latitude) < 1e-10)
})

test('GCJ-02 source range covers every requested pixel and validates tile coordinates', () => {
  const level = 13
  const wgsX = tileXOf(116.404, level) * 256
  const wgsY = tileYOf(39.915, level) * 256
  const row = Math.floor(wgsY / 256)
  const col = Math.floor(wgsX / 256)
  const range = sourceTileRange(level, row, col)
  for (const [pixelX, pixelY] of [[0, 0], [255, 255], [128, 128]]) {
    const [sourceX, sourceY] = sourcePixelOf(level, row, col, pixelX, pixelY)
    assert.ok(sourceX >= range.min.x * 256 && sourceX <= (range.max.x + 1) * 256)
    assert.ok(sourceY >= range.min.y * 256 && sourceY <= (range.max.y + 1) * 256)
  }
  assert.throws(() => sourceTileRange(level, -1, 0), RangeError)
  assert.throws(() => sourceTileRange(level, 0, 2 ** level), RangeError)
})
