/** Streaming FeatureCollection scanner and grid aggregation: exactness, bounds, determinism. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateGridFeatures,
  createFeatureCollectionScanner,
  createGridAggregator,
  GridAggregateFailure,
  scanFeatureCollectionChunks,
  StreamScanFailure,
} from '../src/index.ts'

function collectionOf(features) {
  return { type: 'FeatureCollection', features }
}

function pointFeature(id, lon, lat, score) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id, score },
  }
}

/** Split bytes into odd-sized chunks so features span boundaries. */
function chunkBytes(bytes, sizes) {
  const chunks = []
  let at = 0
  let index = 0
  while (at < bytes.length) {
    const size = sizes[index % sizes.length]
    chunks.push(bytes.subarray(at, at + size))
    at += size
    index += 1
  }
  return chunks
}

function utf8(text) {
  return new TextEncoder().encode(text)
}

test('the scanner visits every feature in order across chunk boundaries', () => {
  const features = [
    pointFeature('a', 116.1, 39.1, 1),
    pointFeature('b', 116.2, 39.2, 2),
    pointFeature('c', 116.3, 39.3, 3),
  ]
  const bytes = utf8(JSON.stringify(collectionOf(features)))
  const seen = []
  const count = scanFeatureCollectionChunks(chunkBytes(bytes, [7, 13, 3]), feature => seen.push(feature), { maxBytes: 1 << 20 })
  assert.equal(count, 3)
  assert.deepEqual(seen.map(feature => feature.id), ['a', 'b', 'c'])
  assert.deepEqual(JSON.parse(JSON.stringify(seen)), features, 'round-trip preserves the feature objects')
})

test('compact and pretty-printed collections scan identically to JSON.parse', () => {
  const features = [pointFeature('x', 1.5, 2.5, 9), pointFeature('y', -3.25, 4.75, null)]
  for (const text of [JSON.stringify(collectionOf(features)), JSON.stringify(collectionOf(features), null, 2)]) {
    const seen = []
    scanFeatureCollectionChunks(chunkBytes(utf8(text), [11]), feature => seen.push(feature), { maxBytes: 1 << 20 })
    assert.deepEqual(JSON.parse(JSON.stringify(seen)), features)
  }
})

test('unicode escapes and nested arrays inside strings do not confuse the depth pass', () => {
  const feature = pointFeature('u', 1, 2, 3)
  feature.properties = { note: 'brace } inside \\" and [array]', values: [1, [2, [3]]] }
  const text = JSON.stringify(collectionOf([feature]))
  const seen = []
  scanFeatureCollectionChunks(chunkBytes(utf8(text), [5, 17, 2]), feature => seen.push(feature), { maxBytes: 1 << 20 })
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].properties.note, feature.properties.note)
  assert.deepEqual(seen[0].properties.values, [1, [2, [3]]])
})

test('oversize streams refuse at the byte limit; truncated streams refuse at close', () => {
  const features = Array.from({ length: 40 }, (_, index) => pointFeature(`f${index}`, 116 + index * 0.01, 39, index))
  const bytes = utf8(JSON.stringify(collectionOf(features)))
  assert.throws(
    () => scanFeatureCollectionChunks(chunkBytes(bytes, [64]), () => {}, { maxBytes: 256 }),
    error => error instanceof StreamScanFailure && error.code === 'stream-byte-limit-exceeded',
  )
  const truncated = utf8('{"type":"FeatureCollection","features":[{"type":"Feature","id":"cut"')
  assert.throws(
    () => scanFeatureCollectionChunks([truncated], () => {}, { maxBytes: 1 << 20 }),
    error => error instanceof StreamScanFailure && error.code === 'truncated-collection',
  )
  assert.throws(
    () => scanFeatureCollectionChunks([utf8('{"type":"Point"}')], () => {}, { maxBytes: 1 << 20 }),
    error => error instanceof StreamScanFailure && error.code === 'invalid-collection-shape',
  )
})

test('grid aggregation matches the hand-computed lattice and sums', () => {
  // Dyadic coordinates and a 0.25° grid: the lattice indices are exact integers.
  const features = [
    pointFeature('a', 116.5, 39.25, 10),
    pointFeature('b', 116.75, 39.5, 4),
    pointFeature('c', 116.75, 39.25, 6),
    pointFeature('d', 116.5, 39.25, null),
  ]
  const result = aggregateGridFeatures(features, { cellSizeDeg: 0.25, measure: 'sum', field: 'score', maxCells: 100 })
  // a,d → 466:157; c → 467:157; b → 467:158 (floor(116.5/0.25)=466, floor(116.75/0.25)=467).
  assert.equal(result.cells.length, 3)
  assert.equal(result.matched, 4)
  assert.equal(result.skipped, 0)
  const byCell = new Map(result.cells.map(cell => [`${cell.properties.cell_x}:${cell.properties.cell_y}`, cell]))
  const shared = byCell.get('466:157')
  assert.equal(shared.properties.count, 2)
  assert.equal(shared.properties.sum, 10, 'a contributes 10; d counts without summing')
  assert.equal(byCell.get('467:157').properties.sum, 6)
  assert.equal(byCell.get('467:158').properties.sum, 4)
  // Determinism: the identical input reproduces identical output.
  const again = aggregateGridFeatures(features, { cellSizeDeg: 0.25, measure: 'sum', field: 'score', maxCells: 100 })
  assert.deepEqual(again, result)
})

test('the incremental aggregator equals the batch form and the cell cap refuses', () => {
  const features = Array.from({ length: 30 }, (_, index) => pointFeature(`f${index}`, 116 + (index % 5) * 0.2, 39 + (index % 3) * 0.2, index))
  const params = { cellSizeDeg: 0.5, measure: 'count', maxCells: 8 }
  const batch = aggregateGridFeatures(features, params)
  const incremental = createGridAggregator(params)
  for (const feature of features) incremental.push(feature)
  assert.deepEqual(incremental.result(), batch)
  assert.throws(
    () => aggregateGridFeatures(features, { cellSizeDeg: 0.01, measure: 'count', maxCells: 3 }),
    error => error instanceof GridAggregateFailure && error.code === 'grid-cell-limit-exceeded',
  )
  assert.throws(
    () => aggregateGridFeatures([pointFeature('a', 1, 1, 1)], { cellSizeDeg: 0, measure: 'count', maxCells: 3 }),
    error => error instanceof GridAggregateFailure && error.code === 'invalid-cell-size',
  )
  assert.throws(
    () => aggregateGridFeatures([pointFeature('a', 1, 1, 1)], { cellSizeDeg: 0.5, measure: 'sum', maxCells: 3 }),
    error => error instanceof GridAggregateFailure && error.code === 'sum-field-required',
  )
})

test('the streaming scanner feeds the incremental aggregator end to end', () => {
  const features = Array.from({ length: 50 }, (_, index) => pointFeature(`f${index}`, 116 + (index % 4) * 0.3, 39 + (index % 2) * 0.3, index))
  const bytes = utf8(JSON.stringify(collectionOf(features)))
  const params = { cellSizeDeg: 0.5, measure: 'sum', field: 'score', maxCells: 100 }
  const aggregator = createGridAggregator(params)
  // Feed byte-by-byte through one scanner: the harshest chunking.
  const scanner = createFeatureCollectionScanner({ maxBytes: 1 << 20 }, feature => aggregator.push(feature))
  for (const byte of bytes) {
    scanner.push(utf8(String.fromCharCode(byte)))
  }
  assert.equal(scanner.end(), 50)
  const streamed = aggregator.result()
  const batch = aggregateGridFeatures(features, params)
  assert.deepEqual(streamed, batch)
})
