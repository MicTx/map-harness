import { test } from 'node:test'
import assert from 'node:assert/strict'
import { placeFeatureCard } from '../src/client/feature-card-placement.ts'

const viewport = { width: 800, height: 600 }
const anchor = { left: 400, top: 280, right: 420, bottom: 320 }

test('the card prefers the feature right side with its measured size', () => {
  const placement = placeFeatureCard({ anchor, card: { width: 200, height: 100 }, viewport, obstacles: [] })
  assert.deepEqual(placement, {
    left: 428,
    top: 250,
    width: 200,
    height: 100,
    side: 'right',
    overlap: 0,
    constrained: false,
  })
})

test('blocked right space flips the card to the left side', () => {
  const placement = placeFeatureCard({
    anchor,
    card: { width: 200, height: 100 },
    viewport,
    obstacles: [{ left: 425, top: 180, right: 800, bottom: 420 }],
  })
  assert.equal(placement.side, 'left')
  assert.equal(placement.left, 192)
  assert.equal(placement.overlap, 0)
})

test('top and bottom anchors use the corresponding vertical side', () => {
  const sideBlockers = bottom => [
    { left: 190, top: bottom - 140, right: 260, bottom },
    { left: 360, top: bottom - 140, right: 530, bottom },
  ]
  const top = placeFeatureCard({
    anchor: { left: 300, top: 500, right: 320, bottom: 520 },
    card: { width: 100, height: 100 },
    viewport,
    obstacles: sideBlockers(570),
  })
  assert.equal(top.side, 'top')
  assert.equal(top.top, 392)
  assert.equal(top.left, 260)

  const bottom = placeFeatureCard({
    anchor: { left: 300, top: 50, right: 320, bottom: 70 },
    card: { width: 100, height: 100 },
    viewport,
    obstacles: sideBlockers(140),
  })
  assert.equal(bottom.side, 'bottom')
  assert.equal(bottom.top, 78)
  assert.equal(bottom.left, 260)
})

test('a constrained placement shrinks only when the measured card cannot fit', () => {
  const placement = placeFeatureCard({
    anchor: { left: 140, top: 140, right: 160, bottom: 160 },
    card: { width: 260, height: 260 },
    viewport: { width: 300, height: 300 },
    obstacles: [],
  })
  assert.equal(placement.constrained, true)
  assert.equal(placement.overlap, 0)
  assert.ok(placement.width < 260 || placement.height < 260)
  assert.ok(placement.left >= 8 && placement.top >= 8
    && placement.left + placement.width <= 292 && placement.top + placement.height <= 292)
})

test('a fully blocked map still returns the minimum-overlap bounded rectangle', () => {
  const placement = placeFeatureCard({
    anchor: { left: 90, top: 90, right: 110, bottom: 110 },
    card: { width: 180, height: 180 },
    viewport: { width: 200, height: 200 },
    obstacles: [
      { left: 0, top: 0, right: 200, bottom: 60 },
      { left: 0, top: 60, right: 70, bottom: 200 },
      { left: 130, top: 60, right: 200, bottom: 200 },
      { left: 70, top: 140, right: 130, bottom: 200 },
    ],
  })
  assert.ok(placement.left >= 8 && placement.top >= 8
    && placement.left + placement.width <= 192 && placement.top + placement.height <= 192)
  assert.equal(placement.constrained, true)
  const repeat = placeFeatureCard({
    anchor: { left: 90, top: 90, right: 110, bottom: 110 },
    card: { width: 180, height: 180 },
    viewport: { width: 200, height: 200 },
    obstacles: [
      { left: 0, top: 0, right: 200, bottom: 60 },
      { left: 0, top: 60, right: 70, bottom: 200 },
      { left: 130, top: 60, right: 200, bottom: 200 },
      { left: 70, top: 140, right: 130, bottom: 200 },
    ],
  })
  assert.deepEqual(repeat, placement)
})

test('invalid measurements return no placement', () => {
  const invalid = { left: Number.NaN, top: 0, right: 1, bottom: 1 }
  assert.equal(placeFeatureCard({ anchor: invalid, card: { width: 1, height: 1 }, viewport, obstacles: [] }), null)
  assert.equal(placeFeatureCard({ anchor, card: { width: -1, height: 1 }, viewport, obstacles: [] }), null)
  assert.equal(placeFeatureCard({ anchor, card: { width: 1, height: 1 }, viewport, obstacles: [invalid] }), null)
})
