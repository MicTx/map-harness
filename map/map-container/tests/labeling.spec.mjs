/**
 * Label placement fixtures: field resolution and truncation, collision-free
 * greedy placement (labels vs labels, labels vs markers, viewport edges),
 * the variable-anchor fallback order, and geometry anchors.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LABEL_FIELD_CANDIDATES,
  MAX_LABEL_CHARS,
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

test('geometry anchors: point, line middle vertex, polygon ring average', () => {
  assert.deepEqual(labelAnchorOf({ type: 'Point', coordinates: [1, 2] }), { kind: 'point', lon: 1, lat: 2 })
  assert.deepEqual(labelAnchorOf({ type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] }), { kind: 'line', lon: 1, lat: 1 })
  assert.deepEqual(labelAnchorOf({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] }), { kind: 'polygon', lon: 1, lat: 1 })
  assert.equal(labelAnchorOf({ type: 'MultiPoint', coordinates: [] }), null)
  assert.equal(labelAnchorOf(null), null)
})
