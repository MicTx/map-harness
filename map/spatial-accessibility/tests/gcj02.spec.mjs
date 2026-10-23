/** Reference vector checked against coordtransform@2.1.2; no vendor key or network is needed. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gcj02ToWgs84, wgs84ToGcj02 } from '../src/gcj02.ts'

test('the shared approximation matches the independent Beijing vector within declared tolerances', () => {
  const wgs = [116.404, 39.915]
  const expectedGcj = [116.41024449916938, 39.91640428150164]
  const actual = wgs84ToGcj02(wgs)
  assert.ok(Math.abs(actual[0] - expectedGcj[0]) < 1e-10)
  assert.ok(Math.abs(actual[1] - expectedGcj[1]) < 1e-10)
  const inverse = gcj02ToWgs84(...expectedGcj)
  assert.ok(Math.abs(inverse[0] - wgs[0]) < 0.00002)
  assert.ok(Math.abs(inverse[1] - wgs[1]) < 0.00002)
  assert.notDeepEqual(inverse, wgs, 'the approximate inverse must not be represented as lossless')
})

test('outside-region points pass through without a China datum offset', () => {
  for (const point of [[0, 0], [-73.9857, 40.7484], [139.6917, 35.6895]]) {
    assert.deepEqual(wgs84ToGcj02(point), point)
    assert.deepEqual(gcj02ToWgs84(...point), point)
  }
})
