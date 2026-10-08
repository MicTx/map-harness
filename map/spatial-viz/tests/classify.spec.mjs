/**
 * Classification fixtures: break construction with honest tie collapse, the
 * half-open class assignment with explicit missing/underflow/overflow,
 * measure semantics (rates classify the ratio, never the raw numerator),
 * the graduated size scale, the fixed palette ramp, and the unified-domain
 * comparison pair.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SEQUENTIAL_RAMP,
  buildStyle,
  checkStyleInputs,
  classifyValue,
  computeBreaks,
  countClasses,
  measureValueOf,
  paletteOf,
  sizeForClass,
  styleVersionOf,
  unifyDomains,
  validateStyleSpec,
} from '../src/index.ts'

test('quantile breaks sit at even distinct-value ranks; equal-interval spans the range evenly', () => {
  const values = Array.from({ length: 100 }, (_, at) => at) // 0..99
  const quantile = computeBreaks(values, 'quantile', 4)
  // Midpoints between distinct ranks 25/50/75: boundaries never coincide with a data value.
  assert.deepEqual(quantile, { breaks: [24.5, 49.5, 74.5], effectiveClassCount: 4 })
  const interval = computeBreaks(values, 'equal-interval', 4)
  assert.deepEqual(interval.breaks.map(bound => Math.round(bound * 1e6) / 1e6), [24.75, 49.5, 74.25])
  assert.equal(interval.effectiveClassCount, 4)
})

test('heavy ties collapse honestly: classes reduce to the distinct support', () => {
  const tied = [1, 1, 1, 1, 2, 2, 2, 2]
  const collapsed = computeBreaks(tied, 'quantile', 5)
  // Two distinct values support exactly two classes; the boundary is their midpoint.
  assert.deepEqual(collapsed, { breaks: [1.5], effectiveClassCount: 2 })
  const threeValues = [1, 1, 1, 1, 2, 2, 2, 3]
  assert.deepEqual(computeBreaks(threeValues, 'quantile', 4), { breaks: [1.5, 2.5], effectiveClassCount: 3 })
  const constant = [7, 7, 7]
  assert.deepEqual(computeBreaks(constant, 'equal-interval', 5), { breaks: [], effectiveClassCount: 1 })
})

test('computeBreaks refuses class counts outside [2, 12]', () => {
  assert.throws(() => computeBreaks([1, 2], 'quantile', 1), /class_count/)
  assert.throws(() => computeBreaks([1, 2], 'quantile', 13), /class_count/)
})

test('classifyValue: half-open classes, domain-top inclusive, named special classes', () => {
  const style = buildStyle({
    field: 'v', unit: 'x', measure: 'total', encoding: 'fill',
    classification: 'quantile', breaks: [10, 20], domain: { min: 0, max: 30 },
  })
  assert.equal(classifyValue(style, 0), 0)
  assert.equal(classifyValue(style, 9.999), 0)
  assert.equal(classifyValue(style, 10), 1)
  assert.equal(classifyValue(style, 19.5), 1)
  assert.equal(classifyValue(style, 20), 2)
  assert.equal(classifyValue(style, 30), 2)
  assert.equal(classifyValue(style, -0.5), 'underflow')
  assert.equal(classifyValue(style, 30.5), 'overflow')
  assert.equal(classifyValue(style, Number.NaN), 'missing')
  assert.equal(classifyValue(style, Number.POSITIVE_INFINITY), 'missing')
})

test('countClasses counts every class plus the specials', () => {
  const style = buildStyle({
    field: 'v', unit: 'x', measure: 'total', encoding: 'fill',
    classification: 'equal-interval', breaks: [10, 20], domain: { min: 0, max: 30 },
  })
  const counted = countClasses(style, [0, 5, 10, 15, 20, 25, 30, Number.NaN, -1, 31])
  assert.deepEqual(counted, { counts: [2, 2, 3], missing: 1, underflow: 1, overflow: 1 })
})

test('rates measure the ratio; a non-positive or missing denominator is missing, never zero', () => {
  const style = { field: 'cases', measure: 'rate', denominatorField: 'population' }
  assert.equal(measureValueOf({ cases: 10, population: 200 }, style), 0.05)
  assert.equal(measureValueOf({ cases: 10, population: 0 }, style), Number.NaN)
  assert.equal(measureValueOf({ cases: 10, population: -5 }, style), Number.NaN)
  assert.equal(measureValueOf({ cases: 10 }, style), Number.NaN)
  assert.equal(measureValueOf({ population: 100 }, style), Number.NaN)
  const total = { field: 'cases', measure: 'total' }
  assert.equal(measureValueOf({ cases: 12 }, total), 12)
})

test('the size scale graduates monotonically and clamps specials', () => {
  assert.ok(sizeForClass(0, 5) < sizeForClass(2, 5))
  assert.equal(sizeForClass(4, 5), sizeForClass(99, 5))
  assert.equal(sizeForClass(2, 1), sizeForClass(0, 1))
})

test('the palette slices the fixed ramp by even steps and is stable', () => {
  assert.deepEqual(paletteOf(4), [SEQUENTIAL_RAMP[0], SEQUENTIAL_RAMP[3], SEQUENTIAL_RAMP[5], SEQUENTIAL_RAMP[8]].map(color => color))
  assert.deepEqual(paletteOf(2), [SEQUENTIAL_RAMP[0], SEQUENTIAL_RAMP[8]])
  assert.equal(paletteOf(9).every(color => /^#[0-9a-f]{6}$/u.test(color)), true)
  assert.throws(() => paletteOf(13), /palette/)
})

test('checkStyleInputs lists every bad tool argument in one pass', () => {
  const issues = checkStyleInputs({ measure: 'ratio', encoding: 'glow', classification: 'jenks' })
  assert.deepEqual(issues.map(issue => issue.field), ['measure', 'encoding', 'classification'])
  const paren = checkStyleInputs({ measure: 'rate', encoding: 'size', classification: 'quantile' })
  assert.deepEqual(paren.map(issue => `${issue.field}:${issue.code}`), [
    'denominator_field:denominator-required',
    'encoding:size-encoding-requires-total',
  ])
  const totalDenominator = checkStyleInputs({ measure: 'total', encoding: 'fill', classification: 'quantile', denominatorField: 'pop' })
  assert.deepEqual(totalDenominator, [{ field: 'denominator_field', code: 'denominator-unexpected' }])
})

test('unifyDomains freezes both styles onto one shared classification domain', () => {
  const left = { field: 'alpha', unit: 'x', measure: 'total', encoding: 'fill', values: [0, 10, 20, 30] }
  const right = { field: 'beta', unit: 'x', measure: 'total', encoding: 'fill', values: [40, 50, 60, 70] }
  const unified = unifyDomains(left, right, 'equal-interval', 4)
  assert.equal(unified.breaks.length, 3)
  // Union range [0, 70]: equal-interval breaks at 17.5, 35, 52.5.
  assert.deepEqual(unified.breaks.map(bound => Math.round(bound * 1e6) / 1e6), [17.5, 35, 52.5])
  assert.deepEqual(unified.styleLeft.domain, { min: 0, max: 70 })
  assert.deepEqual(unified.styleRight.domain, { min: 0, max: 70 })
  assert.deepEqual(unified.styleLeft.breaks, unified.styleRight.breaks)
  assert.equal(unified.styleLeft.unifiedDomain, true)
  assert.equal(unified.styleRight.unifiedDomain, true)
  // Different fields still version differently even on the shared domain.
  assert.notEqual(unified.styleLeft.styleVersion, unified.styleRight.styleVersion)
  // Both validate, versions included.
  assert.deepEqual(validateStyleSpec(unified.styleLeft), [])
  assert.deepEqual(validateStyleSpec(unified.styleRight), [])
  // Determinism: same inputs, same versions.
  const again = unifyDomains(left, right, 'equal-interval', 4)
  assert.equal(again.styleLeft.styleVersion, unified.styleLeft.styleVersion)
})

test('buildStyle writes every default into the payload and derives its version once', () => {
  const style = buildStyle({
    field: 'v', unit: 'x', measure: 'total', encoding: 'fill',
    classification: 'quantile', breaks: [5], domain: { min: 0, max: 10 },
  })
  assert.deepEqual(validateStyleSpec(style), [])
  assert.equal(style.missingColor, '#bdbdbd')
  assert.equal(style.missingLabel, 'no data')
  assert.equal(style.overflowColor, '#616161')
  assert.deepEqual(style.palette, paletteOf(2))
  assert.equal(style.styleVersion, styleVersionOf(style))
  assert.throws(() => buildStyle({
    field: 'v', unit: 'x', measure: 'total', encoding: 'fill',
    classification: 'quantile', breaks: [], domain: { min: 0, max: 1 },
  }), /constant data carries no classification/)
})
