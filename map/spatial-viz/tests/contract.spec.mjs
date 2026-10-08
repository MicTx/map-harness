/**
 * Contract fixtures: style vocabulary and parenthesis rules, break
 * monotonicity, version integrity, key-order-independent digests, time
 * bindings, and the legend derivation that never re-decides colors.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MISSING_COLOR,
  DEFAULT_OVERFLOW_COLOR,
  MAX_VIZ_CLASSES,
  MIN_VIZ_CLASSES,
  VIZ_METHOD_VERSION,
  buildStyle,
  legendOf,
  paletteOf,
  stableStringify,
  styleVersionOf,
  validateStyleSpec,
  vizDigestOf,
} from '../src/index.ts'

/** One valid style the negative fixtures mutate. */
const validStyle = {
  methodVersion: VIZ_METHOD_VERSION,
  field: 'population',
  unit: '人',
  measure: 'total',
  encoding: 'fill',
  classification: 'quantile',
  breaks: [100, 200, 300],
  domain: { min: 0, max: 400 },
  palette: ['#f7fbff', '#c6dbef', '#6baed6', '#08306b'],
  missingColor: DEFAULT_MISSING_COLOR,
  overflowColor: DEFAULT_OVERFLOW_COLOR,
  missingLabel: 'no data',
  seriesIdentity: 'observed',
  styleVersion: '',
}

test('a valid spec passes validation and its version re-derives', () => {
  const style = { ...validStyle, styleVersion: styleVersionOf(validStyle) }
  assert.deepEqual(validateStyleSpec(style), [])
  assert.match(style.styleVersion, /^sty-[0-9a-f]{12}@v1$/u)
})

test('key order never changes the digest or the derived version', () => {
  const left = { ...validStyle, styleVersion: undefined }
  const reordered = {}
  for (const key of Object.keys(left).reverse()) reordered[key] = left[key]
  assert.equal(stableStringify(left), stableStringify(reordered))
  assert.equal(vizDigestOf(left), vizDigestOf(reordered))
  assert.equal(styleVersionOf(left), styleVersionOf(reordered))
})

test('undefined properties drop out of the canonical text instead of serializing', () => {
  assert.equal(stableStringify({ a: 1, b: undefined }), '{"a":1}')
})

test('every structural rejection is named in one pass', () => {
  const broken = {
    methodVersion: 'other@1',
    field: '',
    unit: '',
    measure: 'ratio',
    encoding: 'glow',
    classification: 'jenks',
    breaks: [300, 100, 200],
    domain: { min: 10, max: 5 },
    palette: ['#red', '#00ff00', '#0000gg', '#123456'],
    missingColor: 'gray',
    overflowColor: 'dark',
    missingLabel: '',
    styleVersion: 'sty-deadbeefdead@v1',
  }
  const codes = validateStyleSpec(broken).map(issue => `${issue.field}:${issue.code}`)
  assert.ok(codes.includes('methodVersion:unknown-method-version'))
  assert.ok(codes.includes('field:required'))
  assert.ok(codes.includes('unit:required'))
  assert.ok(codes.includes('measure:unknown-vocabulary'))
  assert.ok(codes.includes('encoding:unknown-vocabulary'))
  assert.ok(codes.includes('classification:unknown-vocabulary'))
  assert.ok(codes.includes('breaks:not-strictly-increasing'))
  assert.ok(codes.includes('domain:invalid-domain'))
  assert.ok(codes.includes('palette:invalid-color'))
  assert.ok(codes.includes('missingColor:invalid-color'))
  assert.ok(codes.includes('overflowColor:invalid-color'))
  assert.ok(codes.includes('missingLabel:required'))
  // The version-mismatch check only runs when the structure is otherwise valid;
  // this broken payload is refused on structure without a misleading version code.
  assert.equal(codes.includes('styleVersion:version-mismatch'), false)
})

test('measure parenthesis: rates need a denominator, totals refuse one, size encoding needs totals', () => {
  const rateMissingDenominator = validateStyleSpec({
    ...validStyle,
    measure: 'rate',
    styleVersion: 'sty-000000000000@v1',
  })
  assert.deepEqual(rateMissingDenominator.filter(issue => issue.field === 'denominatorField'), [
    { field: 'denominatorField', code: 'denominator-required' },
  ])

  const totalWithDenominator = validateStyleSpec({
    ...validStyle,
    denominatorField: 'area_km2',
    styleVersion: styleVersionOf({ ...validStyle, denominatorField: 'area_km2' }),
  })
  assert.deepEqual(totalWithDenominator, [{ field: 'denominatorField', code: 'denominator-unexpected' }])

  const rateWithSize = validateStyleSpec({
    ...validStyle,
    measure: 'density',
    denominatorField: 'area_km2',
    encoding: 'size',
  })
  // The styleVersion was derived for the `total` payload; the fixed measure also flips it.
  const codes = rateWithSize.map(issue => issue.code)
  assert.ok(codes.includes('size-encoding-requires-total'))
  assert.ok(codes.includes('styleVersion:required') === false)
})

test('manual classification refuses to pass without an exact break source', () => {
  const manual = validateStyleSpec({ ...validStyle, classification: 'manual', styleVersion: styleVersionOf(validStyle) })
  assert.deepEqual(manual, [{ field: 'breaksSourceRef', code: 'breaks-source-required' }])
  const withSource = validateStyleSpec({
    ...validStyle,
    classification: 'manual',
    breaksSourceRef: 'res-aabbccdd0011223344556677@v2',
    styleVersion: styleVersionOf({ ...validStyle, classification: 'manual', breaksSourceRef: 'res-aabbccdd0011223344556677@v2' }),
  })
  assert.deepEqual(withSource, [])
})

test('a tampered styleVersion is refused: styles cannot be edited without a new version', () => {
  const style = { ...validStyle, styleVersion: 'sty-000000000000@v1' }
  assert.deepEqual(validateStyleSpec(style), [{ field: 'styleVersion', code: 'version-mismatch' }])
})

test('time bindings validate field, timezone, granularity, and the half-open window', () => {
  const binding = { timeField: 'observed_at', timezone: 'Asia/Shanghai', granularity: 'day', window: { from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z' } }
  assert.deepEqual(validateStyleSpec({
    ...validStyle,
    timeBinding: binding,
    styleVersion: styleVersionOf({ ...validStyle, timeBinding: binding }),
  }), [])
  const broken = validateStyleSpec({
    ...validStyle,
    timeBinding: { timeField: '', timezone: 'Mars/Olympus', granularity: 'fortnight', window: { from: '2026-01-08', to: '2026-01-01' } },
    styleVersion: styleVersionOf(validStyle),
  })
  const codes = broken.map(issue => issue.field)
  assert.ok(codes.includes('timeBinding.timeField'))
  assert.ok(codes.includes('timeBinding.timezone'))
  assert.ok(codes.includes('timeBinding.granularity'))
  assert.ok(codes.includes('timeBinding.window'))
})

test('class-count bounds: breaks length in [1, 11]', () => {
  const elevenBreaks = Array.from({ length: MAX_VIZ_CLASSES - 1 }, (_, at) => at + 1)
  const wide = { ...validStyle, breaks: elevenBreaks, palette: paletteOf(MAX_VIZ_CLASSES), styleVersion: '' }
  const wideVersioned = { ...wide, styleVersion: styleVersionOf(wide) }
  assert.deepEqual(validateStyleSpec(wideVersioned), [])

  const tooMany = { ...validStyle, breaks: [...elevenBreaks, 99], styleVersion: '' }
  assert.deepEqual(validateStyleSpec({ ...tooMany, styleVersion: styleVersionOf(tooMany) }), [
    { field: 'breaks', code: 'class-count-out-of-range' },
    { field: 'palette', code: 'palette-arity' },
  ])
  assert.equal(MIN_VIZ_CLASSES, 2)
  assert.equal(MAX_VIZ_CLASSES, 12)
})

test('the legend derives from the style and never re-decides colors or units', () => {
  const style = buildStyle({
    field: 'coverage',
    unit: '%',
    measure: 'rate',
    denominatorField: 'population',
    encoding: 'fill',
    classification: 'quantile',
    breaks: [0.25, 0.5, 0.75],
    domain: { min: 0, max: 1 },
    breaksSourceRef: 'art-abc@v1',
  })
  const legend = legendOf(style)
  assert.equal(legend.styleVersion, style.styleVersion)
  assert.equal(legend.unit, '%')
  assert.equal(legend.measure, 'rate')
  assert.equal(legend.denominatorField, 'population')
  assert.equal(legend.breaksSourceRef, 'art-abc@v1')
  assert.equal(legend.rows.length, 4 + 3)
  const [first, last, underflow, overflow, missing] = [
    legend.rows[0], legend.rows[3], legend.rows[4], legend.rows[5], legend.rows[6],
  ]
  assert.deepEqual(first, { kind: 'class', classIndex: 0, color: style.palette[0], from: 0, to: 0.25, toInclusive: false })
  assert.deepEqual(last, { kind: 'class', classIndex: 3, color: style.palette[3], from: 0.75, to: 1, toInclusive: true })
  assert.deepEqual(underflow, { kind: 'underflow', color: DEFAULT_OVERFLOW_COLOR })
  assert.deepEqual(overflow, { kind: 'overflow', color: DEFAULT_OVERFLOW_COLOR })
  assert.deepEqual(missing, { kind: 'missing', color: DEFAULT_MISSING_COLOR })
})
