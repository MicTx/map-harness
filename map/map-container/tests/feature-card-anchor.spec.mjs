import { test } from 'node:test'
import assert from 'node:assert/strict'
import { featureScreenRectEqual, featureScreenRectOf } from '../src/client/feature-card-anchor.ts'

const project = (longitude, latitude) => ({ x: 400 + (longitude - 116.4) * 1000, y: 300 - (latitude - 39.9) * 1000 })
const rounded = rect => Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value * 1e6) / 1e6]))

test('a feature envelope projects to its screen bounding rectangle', () => {
  assert.deepEqual(rounded(featureScreenRectOf({ west: 116.3, south: 39.8, east: 116.5, north: 40.0 }, project)), {
    left: 300,
    top: 200,
    right: 500,
    bottom: 400,
  })
})

test('a point envelope stays exact and a failed projection falls back to the hit point', () => {
  assert.deepEqual(rounded(featureScreenRectOf({ west: 116.5, south: 39.9, east: 116.5, north: 39.9 }, project)), {
    left: 500,
    top: 300,
    right: 500,
    bottom: 300,
  })
  assert.deepEqual(featureScreenRectOf(null, () => null, { x: 12, y: 34 }), {
    left: 12,
    top: 34,
    right: 12,
    bottom: 34,
  })
  assert.equal(featureScreenRectOf(null, () => null, null), null)
  assert.equal(featureScreenRectOf({ west: 116.3, south: 39.8, east: 116.5, north: 40.0 }, () => null, null), null)
})

test('rectangle equality is stable and rejects one-pixel drift', () => {
  const rect = { left: 10, top: 20, right: 30, bottom: 40 }
  assert.equal(featureScreenRectEqual(rect, { ...rect }), true)
  assert.equal(featureScreenRectEqual(rect, { ...rect, right: 31 }), false)
  assert.equal(featureScreenRectEqual(null, null), true)
  assert.equal(featureScreenRectEqual(rect, null), false)
})
