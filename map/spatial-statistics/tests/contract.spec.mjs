/**
 * P2 statistics contract fixtures: every validator returns ALL structural
 * issues at once (never the first), the fixed vocabularies refuse unknown
 * values, the window ordering rules hold (time-forward, non-overlapping,
 * nested in the observation window), and the canonical digest is
 * key-order-independent but content-sensitive.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GRANULARITIES,
  MAX_BAND_METERS,
  MAX_PERMUTATIONS,
  MIN_PERMUTATIONS,
  STATS_METHOD_VERSION,
  statSpecDigestOf,
  validateAutocorrelationSpec,
  validateChangeSpec,
  validateClusterSpec,
  validateFlowSpec,
  validateHotspotSpec,
  validateZonalSpec,
} from '../src/contract.ts'

const validZonal = {
  goalRevision: 3,
  resourceRef: 'res-units@v2',
  field: 'population',
  methodVersion: STATS_METHOD_VERSION,
}

test('the zonal validator accepts the minimal spec and names every missing field', () => {
  assert.deepEqual(validateZonalSpec(validZonal), [])
  const issues = validateZonalSpec({})
  const codes = issues.map(issue => issue.code)
  assert.ok(codes.includes('goal-revision-invalid'))
  assert.ok(codes.includes('ref-invalid'))
  assert.ok(codes.includes('field-missing'))
  assert.ok(codes.includes('method-version-invalid'))
  // Non-record input gets exactly the spec-invalid refusal.
  assert.deepEqual(validateZonalSpec('nope'), [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }])
})

test('the zonal validator refuses an empty denominator or zone field name', () => {
  assert.deepEqual(
    validateZonalSpec({ ...validZonal, denominatorField: '', zoneField: '  ' }).map(issue => issue.code),
    ['denominator-invalid', 'zone-invalid'],
  )
})

test('the weighted validators collect every issue in one pass', () => {
  const base = { ...validZonal }
  const issues = validateAutocorrelationSpec({
    ...base,
    weights: { kind: 'queen', bandMeters: -1 },
    standardization: 'cosine',
    permutations: 2,
    seed: -7,
    multipleTesting: 'holm',
  })
  const codes = issues.map(issue => issue.code)
  for (const code of ['weight-invalid', 'standardization-unknown', 'perm-invalid', 'seed-invalid', 'testing-invalid']) {
    assert.ok(codes.includes(code), `expected ${code} among ${JSON.stringify(codes)}`)
  }
  // The same validation face covers the hotspot spec; its standardization is
  // required there too.
  assert.deepEqual(
    validateHotspotSpec({ ...base, weights: { kind: 'distance-band', bandMeters: 500 } }).map(issue => issue.code),
    ['standardization-unknown'],
  )
})

test('the weight validators accept the fixed distance-band form inside the cap', () => {
  const spec = { ...validZonal, weights: { kind: 'distance-band', bandMeters: MAX_BAND_METERS }, standardization: 'row', permutations: MIN_PERMUTATIONS, seed: 0, multipleTesting: 'none' }
  assert.deepEqual(validateAutocorrelationSpec(spec), [])
  const over = validateAutocorrelationSpec({ ...spec, weights: { kind: 'distance-band', bandMeters: MAX_BAND_METERS + 1 } })
  assert.equal(over.length, 1)
  assert.equal(over[0].code, 'weight-invalid')
  assert.ok(JSON.stringify(validateAutocorrelationSpec({ ...spec, permutations: MAX_PERMUTATIONS + 1 })).includes('perm-invalid'))
})

const validWindow = { from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' }

function validChange() {
  return {
    goalRevision: 0,
    resourceRef: 'res-obs@v1',
    field: 'value',
    eventTimeField: 'time',
    window: validWindow,
    baselineWindow: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
    comparisonWindow: { from: '2026-02-01T00:00:00Z', to: '2026-03-01T00:00:00Z' },
    blockMeters: 1000,
    granularity: 'day',
    minCoverage: 0.6,
    holdoutBlocks: 1,
    methodVersion: STATS_METHOD_VERSION,
  }
}

test('the change validator enforces the time-forward ordering and nesting', () => {
  assert.deepEqual(validateChangeSpec(validChange()), [])
  const overlapping = validateChangeSpec({ ...validChange(), comparisonWindow: { from: '2026-01-15T00:00:00Z', to: '2026-02-15T00:00:00Z' } })
  assert.ok(overlapping.some(issue => issue.code === 'window-order'), 'overlapping sub-windows are refused')
  const backwards = validateChangeSpec({ ...validChange(), baselineWindow: { from: '2026-02-01T00:00:00Z', to: '2026-02-15T00:00:00Z' } })
  assert.ok(backwards.some(issue => issue.code === 'window-order'), 'a baseline after the comparison is refused')
  const outside = validateChangeSpec({ ...validChange(), comparisonWindow: { from: '2026-03-01T00:00:00Z', to: '2026-04-01T00:00:00Z' } })
  assert.ok(outside.some(issue => issue.code === 'window-order'), 'a sub-window outside the observation window is refused')
  const malformed = validateChangeSpec({ ...validChange(), window: { from: 'nope', to: '2026-03-01T00:00:00Z' } })
  assert.ok(malformed.some(issue => issue.code === 'window-invalid'))
})

test('the change validator bounds coverage, holdout, granularity, and blocks', () => {
  const codes = validateChangeSpec({ ...validChange(), minCoverage: 0, holdoutBlocks: 200, granularity: 'hour' }).map(issue => issue.code)
  assert.deepEqual([...codes].sort(), ['coverage-invalid', 'granularity-unknown', 'holdout-invalid'])
  assert.deepEqual(validateChangeSpec({ ...validChange(), blockMeters: 0 }).map(issue => issue.code), ['flow-invalid'])
})

test('the cluster validator bounds eps, minPts, and blocks', () => {
  const valid = {
    ...validChange(),
    epsMeters: 800,
    epsBins: 1,
    minPts: 3,
  }
  delete valid.baselineWindow
  delete valid.comparisonWindow
  assert.deepEqual(validateClusterSpec(valid), [])
  const issues = validateClusterSpec({ ...valid, epsMeters: -5, epsBins: -1, minPts: 1 })
  assert.equal(issues.filter(issue => issue.code === 'cluster-invalid').length, 3)
})

test('the flow validator requires the entity field and bounds the cell grid', () => {
  const valid = {
    goalRevision: 1,
    resourceRef: 'res-tracks@v1',
    eventTimeField: 'time',
    entityField: 'device',
    window: validWindow,
    granularity: 'day',
    cellMeters: 500,
    maxGapBins: 1,
    topK: 16,
    methodVersion: STATS_METHOD_VERSION,
  }
  assert.deepEqual(validateFlowSpec(valid), [])
  const issues = validateFlowSpec({ ...valid, entityField: '', cellMeters: 0, topK: 0 })
  const codes = issues.map(issue => issue.code)
  assert.ok(codes.includes('entity-field-missing'))
  assert.equal(codes.filter(code => code === 'flow-invalid').length, 2)
  // The flow field stays optional.
  assert.ok(!codes.includes('field-missing'))
})

test('the digest is key-order-independent and content-sensitive', () => {
  const a = { goalRevision: 1, resourceRef: 'res-x@v1', field: 'f', methodVersion: STATS_METHOD_VERSION }
  const b = { methodVersion: STATS_METHOD_VERSION, field: 'f', resourceRef: 'res-x@v1', goalRevision: 1 }
  assert.equal(statSpecDigestOf(a), statSpecDigestOf(b))
  assert.notEqual(statSpecDigestOf(a), statSpecDigestOf({ ...a, field: 'g' }))
})

test('the granularity vocabulary is the fixed UTC calendar set', () => {
  assert.deepEqual([...GRANULARITIES], ['day', 'week', 'month'])
})
