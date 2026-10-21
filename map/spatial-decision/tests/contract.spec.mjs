/**
 * P3 decision-contract fixtures: every spec family validates at the boundary,
 * returns ALL structural issues at once (never just the first), refuses a
 * mismatched method version (the version snapshot), keeps the attribution /
 * forecast / optimization input vocabularies mutually exclusive (an effect
 * without a treatment field, a concurrent feature, an allocation without
 * sites are named refusals), and digests independently of key order.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DECISION_METHOD_VERSION,
  decisionSpecDigestOf,
  validateAssociationSpec,
  validateEffectSpec,
  validateExplainSpec,
  validateForecastPredictSpec,
  validateForecastSpec,
  validateLocationAllocateSpec,
  validateScenarioCompareSpec,
} from '../src/contract.ts'

const METHOD = DECISION_METHOD_VERSION

const association = {
  goalRevision: 1,
  resourceRef: 'res-units@v1',
  outcomeField: 'demand',
  factorFields: ['transit', 'green'],
  methodVersion: METHOD,
}

test('a valid spec of every family validates with zero issues', () => {
  assert.deepEqual(validateAssociationSpec(association), [])
  assert.deepEqual(validateExplainSpec(association), [])
  assert.deepEqual(validateEffectSpec({
    ...association,
    treatmentField: 'policy',
    treatedValue: true,
    design: 'covariate-adjustment',
    interferenceBandMeters: 800,
    intervalLevel: 0.95,
  }), [])
  assert.deepEqual(validateEffectSpec({
    ...association,
    treatmentField: 'policy',
    treatedValue: 'treated',
    design: 'difference-in-differences',
    periodField: 'period',
    preValue: 'pre',
    postValue: 'post',
    unitField: 'district',
    intervalLevel: 0.9,
  }), [])
  assert.deepEqual(validateForecastSpec({
    goalRevision: 1,
    resourceRef: 'res-history@v2',
    outcomeField: 'demand',
    timeField: 'ts',
    features: [{ field: 'transit', availability: 'known-at-origin' }],
    window: { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
    granularity: 'week',
    baseline: 'naive',
    holdoutSteps: 2,
    blockMeters: 1000,
    intervalLevel: 0.9,
    methodVersion: METHOD,
  }), [])
  assert.deepEqual(validateForecastPredictSpec({
    goalRevision: 1,
    modelRef: 'art-model@v1',
    resourceRef: 'res-future@v1',
    horizonSteps: 3,
    intervalLevel: 0.9,
    methodVersion: METHOD,
  }), [])
  assert.deepEqual(validateScenarioCompareSpec({
    goalRevision: 1,
    groups: [{ id: 'north', demand: 100 }],
    candidates: [{ id: 'a', cost: 1, servedByGroup: { north: 50 } }],
    budget: 10,
    weights: { coverage: 0.5, equity: 0.3, cost: 0.2 },
    methodVersion: METHOD,
  }), [])
  assert.deepEqual(validateLocationAllocateSpec({
    goalRevision: 1,
    resourceRef: 'res-demand@v1',
    demandField: 'demand',
    groupField: 'group',
    sites: [{ id: 's1', lon: 116, lat: 39, capacity: 10, cost: 1 }],
    coverageRadiusMeters: 5000,
    budget: 10,
    methodVersion: METHOD,
  }), [])
})

test('validation returns every issue of one input, not just the first', () => {
  const issues = validateEffectSpec({
    goalRevision: -1,
    resourceRef: 'not-a-ref',
    factorFields: [],
    treatedValue: undefined,
    design: 'regression-discontinuity',
    intervalLevel: 0.77,
    methodVersion: METHOD,
  })
  const codes = issues.map(issue => issue.code)
  assert.ok(codes.includes('goal-revision-invalid'))
  assert.ok(codes.includes('ref-invalid'))
  assert.ok(codes.includes('field-missing'))
  assert.ok(codes.includes('factor-invalid'))
  assert.ok(codes.includes('treatment-invalid'))
  assert.ok(codes.includes('treated-value-missing'))
  assert.ok(codes.includes('design-unknown'))
  assert.ok(codes.includes('level-unknown'))
  assert.equal(codes.includes('method-version-invalid'), false, 'the matching version is not an issue')
})

test('the version snapshot: a spec citing another method version is refused', () => {
  const issues = validateAssociationSpec({ ...association, methodVersion: 'p3-spatial-decision@0' })
  assert.deepEqual(issues.map(issue => issue.code), ['method-version-invalid'])
})

test('identification designs are mutually exclusive with their missing prerequisites', () => {
  const didMissingPeriods = validateEffectSpec({
    ...association,
    treatmentField: 'policy',
    treatedValue: 1,
    design: 'difference-in-differences',
    intervalLevel: 0.9,
  })
  const codes = didMissingPeriods.map(issue => issue.code)
  assert.ok(codes.includes('period-invalid'), 'DiD without period/unit fields is a named refusal')
  const covariateOk = validateEffectSpec({
    ...association,
    treatmentField: 'policy',
    treatedValue: 1,
    design: 'covariate-adjustment',
    intervalLevel: 0.9,
  })
  assert.deepEqual(covariateOk, [], 'covariate-adjustment needs no period fields')
})

test('forecast inputs fail loud on future-unavailable features and bad windows', () => {
  const concurrent = validateForecastSpec({
    ...validForecast(),
    features: [{ field: 'price', availability: 'concurrent' }, { field: 'bad', availability: 'sometimes' }],
  })
  const codes = concurrent.map(issue => issue.code)
  assert.ok(codes.includes('availability-unknown'), 'an unknown availability is a named issue')
  assert.equal(codes.includes('feature-invalid'), false, 'concurrent is a valid availability value; computations refuse it')
  const overlapping = validateForecastSpec({
    ...validForecast(),
    window: { from: '2026-06-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
  })
  assert.ok(overlapping.map(issue => issue.code).includes('window-invalid'))
})

test('scenario inputs keep their own vocabulary: groups, candidates, weights, sites', () => {
  const badScenario = validateScenarioCompareSpec({
    goalRevision: 0,
    groups: [{ id: 'g', demand: 1 }, { id: 'g', demand: -2 }],
    candidates: [{ id: 'a', cost: -1, servedByGroup: { g: -5 } }, { id: 'a', cost: 0, servedByGroup: 'nope' }],
    budget: -3,
    weights: { coverage: -1, equity: 0, cost: 0 },
    methodVersion: METHOD,
  })
  const codes = new Set(badScenario.map(issue => issue.code))
  for (const expected of ['groups-invalid', 'candidates-invalid', 'budget-invalid', 'weights-invalid']) {
    assert.ok(codes.has(expected), `expected ${expected} among ${[...codes].join(', ')}`)
  }
  const allZeroWeights = validateScenarioCompareSpec({
    goalRevision: 0,
    groups: [{ id: 'g', demand: 1 }],
    candidates: [{ id: 'a', cost: 0, servedByGroup: { g: 0 } }],
    weights: { coverage: 0, equity: 0, cost: 0 },
    methodVersion: METHOD,
  })
  assert.ok(allZeroWeights.map(issue => issue.code).includes('weights-invalid'), 'an all-zero weight vector is refused')
  const badSites = validateLocationAllocateSpec({
    goalRevision: 0,
    resourceRef: 'res-demand@v1',
    demandField: 'demand',
    sites: [{ id: 's', lon: Number.NaN, lat: 39, capacity: -1, cost: 0 }],
    coverageRadiusMeters: 0,
    methodVersion: METHOD,
  })
  const siteCodes = badSites.map(issue => issue.code)
  assert.ok(siteCodes.includes('sites-invalid'))
  assert.ok(siteCodes.includes('radius-invalid'))
  assert.ok(validateForecastPredictSpec({ ...validPredict(), modelRef: 'res-not-artifact@v1' }).map(issue => issue.code).includes('model-ref-invalid'))
})

test('the spec digest is independent of key order and sensitive to values', () => {
  const a = decisionSpecDigestOf(association)
  const reordered = {
    methodVersion: METHOD,
    factorFields: ['transit', 'green'],
    outcomeField: 'demand',
    resourceRef: 'res-units@v1',
    goalRevision: 1,
  }
  assert.equal(a, decisionSpecDigestOf(reordered), 'key order must not change the digest')
  assert.notEqual(a, decisionSpecDigestOf({ ...association, outcomeField: 'other' }))
})

/** One valid forecast spec the mutations build on. */
function validForecast() {
  return {
    goalRevision: 1,
    resourceRef: 'res-history@v1',
    outcomeField: 'demand',
    timeField: 'ts',
    features: [{ field: 'transit', availability: 'known-at-origin' }],
    window: { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
    granularity: 'day',
    baseline: 'naive',
    holdoutSteps: 1,
    blockMeters: 1000,
    intervalLevel: 0.9,
    methodVersion: METHOD,
  }
}

/** One valid prediction spec the mutations build on. */
function validPredict() {
  return {
    goalRevision: 1,
    modelRef: 'art-model@v1',
    resourceRef: 'res-future@v1',
    horizonSteps: 1,
    intervalLevel: 0.9,
    methodVersion: METHOD,
  }
}
