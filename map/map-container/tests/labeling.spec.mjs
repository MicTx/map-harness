/**
 * Label placement fixtures: field resolution and truncation, collision-free
 * greedy placement (labels vs labels, labels vs markers, viewport edges),
 * the variable-anchor fallback order, and geometry anchors.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLUSTER_CELL_PX,
  LABEL_FIELD_CANDIDATES,
  MAX_LABEL_CHARS,
  clusterUnplaced,
  labelAnchorOf,
  labelTextOf,
  labelWidthOf,
  placeLabels,
} from '../src/client/labeling.ts'

const viewport = { width: 800, height: 600 }

function pointAt(key, x, y, text = key) {
  return { key, text, kind: 'point', x, y, markerPx: 10 }
}

/** The screen box of one placed label (same estimate the placer uses). */
function boxOf(label) {
  const width = labelWidthOf(label.text) + 4
  const height = 16
  return { left: label.x - width / 2, right: label.x + width / 2, top: label.y - height / 2, bottom: label.y + height / 2 }
}

test('label text reads the declared field, else the first name-like field, bounded and collapsed', () => {
  assert.equal(labelTextOf({ name: 'A', title: 'B' }, undefined), 'A')
  assert.equal(labelTextOf({ 名称: '人民医院' }, undefined), '人民医院')
  assert.ok(LABEL_FIELD_CANDIDATES.includes('名称'))
  assert.equal(labelTextOf({ name: 'A', code: 42 }, 'code'), '42')
  assert.equal(labelTextOf({ name: '  two\n lines ' }, undefined), 'two lines')
  assert.equal(labelTextOf({ name: '' , title: 'fallback' }, undefined), 'fallback')
  assert.equal(labelTextOf({ name: Number.NaN }, undefined), null)
  assert.equal(labelTextOf({ other: 'x' }, undefined), null)
  assert.equal(labelTextOf(null, 'name'), null)
  assert.equal(labelTextOf(Object.create({ name: 'inherited' }), undefined), null, 'inherited keys never label')
  const long = labelTextOf({ name: 'x'.repeat(100) }, undefined)
  assert.equal([...long].length, MAX_LABEL_CHARS)
  assert.ok(long.endsWith('…'))
})

test('placed labels never overlap each other or any marker', () => {
  const candidates = []
  for (let at = 0; at < 60; at += 1) candidates.push(pointAt(`p${at}`, 200 + (at % 10) * 22, 200 + Math.floor(at / 10) * 18, `Label ${at}`))
  const placed = placeLabels(candidates, viewport)
  assert.ok(placed.length > 0 && placed.length < candidates.length, `dense clusters drop some labels (${placed.length})`)
  const boxes = placed.map(boxOf)
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]; const b = boxes[j]
      const overlap = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      assert.equal(overlap, false, `${placed[i].key} overlaps ${placed[j].key}`)
    }
    for (const marker of candidates) {
      const m = { left: marker.x - 5, right: marker.x + 5, top: marker.y - 5, bottom: marker.y + 5 }
      const a = boxes[i]
      assert.equal(a.left < m.right && m.left < a.right && a.top < m.bottom && m.top < a.bottom, false, `${placed[i].key} covers marker ${marker.key}`)
    }
  }
})

test('a blocked top anchor falls back right, then bottom, then left; edges are respected', () => {
  const [first, second] = placeLabels([pointAt('a', 400, 300, 'Alpha'), pointAt('b', 400, 300, 'Beta')], viewport)
  assert.equal(first.anchor, 'top')
  assert.notEqual(second.anchor, 'top', 'the second label at the same point takes a fallback anchor')
  const spaced = placeLabels([pointAt('a', 400, 300, 'Alpha'), { key: 'blocker', text: 'X', kind: 'line', x: 400, y: 283, markerPx: 0 }], viewport)
  assert.deepEqual(spaced.map(label => label.anchor), ['top'], 'priority keeps the first claim')
  const [, right] = placeLabels([{ key: 'blocker', text: 'X', kind: 'line', x: 400, y: 283, markerPx: 0 }, pointAt('a', 400, 300, 'Alpha')], viewport)
  assert.equal(right.anchor, 'right', 'a taken top slot falls back to the right first')
  const [edge] = placeLabels([pointAt('e', 400, 4, 'Edge')], viewport)
  assert.notEqual(edge.anchor, 'top', 'a label that would leave the viewport tries another anchor')
  assert.deepEqual(placeLabels([pointAt('off', -50, -50)], viewport), [])
  assert.deepEqual(placeLabels([{ ...pointAt('nan', Number.NaN, 0) }], viewport), [])
})

test('priority order wins contested space; lines and polygons label at their centre', () => {
  const placed = placeLabels([
    { key: 'top-layer', text: 'Main Street', kind: 'line', x: 400, y: 300, markerPx: 0 },
    { key: 'lower-layer', text: 'Main Street', kind: 'polygon', x: 402, y: 301, markerPx: 0 },
  ], viewport)
  assert.deepEqual(placed.map(label => [label.key, label.anchor]), [['top-layer', 'center']])
})

test('clusterUnplaced accounts for every dropped candidate in screen-grid cells', () => {
  const candidates = []
  for (let at = 0; at < 91; at += 1) {
    candidates.push({
      key: `p${at}`, text: `Point ${at}`, kind: 'point',
      x: 180 + (at % 10) * 7, y: 180 + Math.floor(at / 10) * 7, markerPx: 10,
      lon: 116.39 + (at % 10) * 0.001, lat: 39.89 + Math.floor(at / 10) * 0.001,
    })
  }
  const placed = placeLabels(candidates, viewport)
  const clusters = clusterUnplaced(placed, candidates, viewport)
  assert.ok(placed.length > 0 && placed.length < candidates.length, `dense screens drop labels (${placed.length}/91)`)
  assert.equal(placed.length + clusters.reduce((total, badge) => total + badge.count, 0), 91,
    'every candidate is either placed or counted in a cluster badge')
  assert.ok(clusters.length > 0)
  for (const badge of clusters) {
    assert.ok(badge.count >= 1)
    assert.ok(badge.x >= 0 && badge.x <= viewport.width && badge.y >= 0 && badge.y <= viewport.height,
      `badge centre stays on screen: ${JSON.stringify(badge)}`)
    assert.ok(badge.bbox !== null, 'candidates with coordinates yield a click-to-zoom bbox')
    const spreadX = Math.max(...clusters.map(other => other.x)) - Math.min(...clusters.map(other => other.x))
    void spreadX
  }
  // Zooming in spreads the same features over more screen space: more names, fewer or equal swallowed points.
  const zoomed = candidates.map((candidate, at) => ({
    ...candidate, x: 40 + (at % 10) * 72, y: 40 + Math.floor(at / 10) * 56,
  }))
  const placedZoomed = placeLabels(zoomed, viewport)
  const clustersZoomed = clusterUnplaced(placedZoomed, zoomed, viewport)
  assert.ok(placedZoomed.length > placed.length, 'zooming in places more names')
  assert.equal(placedZoomed.length + clustersZoomed.reduce((total, badge) => total + badge.count, 0), 91)
  assert.ok(clustersZoomed.reduce((total, badge) => total + badge.count, 0)
    < clusters.reduce((total, badge) => total + badge.count, 0), 'zooming in swallows fewer points into badges')
})

test('a cluster without coordinates keeps its count and renders no bbox', () => {
  const [only] = clusterUnplaced([], [{ key: 'x', text: 'X', kind: 'point', x: 50, y: 50, markerPx: 8 }], viewport)
  const offScreen = clusterUnplaced([], [
    { key: 'off-top', text: 'X', kind: 'point', x: 50, y: -30, markerPx: 8 },
    { key: 'off-right', text: 'X', kind: 'point', x: viewport.width + 40, y: 50, markerPx: 8 },
  ], viewport)
  assert.equal(offScreen.length, 0, 'candidates outside the viewport never badge')
  assert.equal(only.count, 1)
  assert.equal(only.bbox, null)
  assert.ok(only.key.includes('0:'), 'the cell key encodes the grid cell')
  assert.ok(CLUSTER_CELL_PX > 0)
  const none = clusterUnplaced([{ key: 'a', text: 'A', x: 1, y: 1, anchor: 'top', color: '#000' }],
    [{ key: 'a', text: 'A', kind: 'point', x: 1, y: 1, markerPx: 0 }], viewport)
  assert.equal(none.length, 0, 'a placed candidate never joins a cluster')
})

test('geometry anchors: point, line middle vertex, polygon ring average', () => {
  assert.deepEqual(labelAnchorOf({ type: 'Point', coordinates: [1, 2] }), { kind: 'point', lon: 1, lat: 2 })
  assert.deepEqual(labelAnchorOf({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] }), { kind: 'line', lon: 1, lat: 1 })
  assert.deepEqual(labelAnchorOf({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] }), { kind: 'polygon', lon: 1, lat: 1 })
  assert.equal(labelAnchorOf({ type: 'MultiPoint', coordinates: [] }), null)
  assert.equal(labelAnchorOf(null), null)
})
