/**
 * Contract suite: the frozen workload catalog, the pinned fixture digest,
 * the hard-vs-estimated budget separation, and the recorded threshold shape.
 * Every structural rejection names its reasons instead of throwing first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PERF_ADVISORY_THROUGHPUT,
  PERF_BUDGET_BOUNDS,
  PERF_DEPLOYMENT_BUDGETS,
  PERF_FIXTURE_DIGEST,
  PERF_LABEL_KEYS,
  PERF_METHOD_VERSION,
  PERF_RECORDED_THRESHOLDS,
  PERF_THRESHOLD_ENVIRONMENT,
  PERF_SEGMENTS,
  PERF_WORKLOAD_FIXTURE,
  PERF_WORKLOAD_IDS,
  perfDigestOf,
  renderPerfIssues,
  validatePerfBudgets,
  validatePerfWorkload,
} from '../src/contract.ts'
import { perfFixturesOf } from '../src/fixtures.ts'

test('the frozen workload passes validation and the fixture digest pin holds', () => {
  assert.deepEqual(validatePerfWorkload(PERF_WORKLOAD_FIXTURE), [], 'the frozen workload must validate clean')
  const fixtures = perfFixturesOf(PERF_WORKLOAD_FIXTURE)
  assert.equal(fixtures.digest, PERF_FIXTURE_DIGEST, 'generated fixtures must match the pinned digest')
  assert.equal(fixtures.locateLayers.length, PERF_WORKLOAD_FIXTURE.locateLayerCount)
  assert.equal(fixtures.parse.featureCount, PERF_WORKLOAD_FIXTURE.parseFeatureCount)
  assert.equal(fixtures.twoPoint.fixture.features[1].geometry.coordinates[0], 10, 'the chain fixture keeps the second point at [10, 0]')
})

test('fixture generation is byte-deterministic across calls', () => {
  const first = perfFixturesOf(PERF_WORKLOAD_FIXTURE)
  const second = perfFixturesOf(PERF_WORKLOAD_FIXTURE)
  assert.equal(
    perfDigestOf({
      parse: Buffer.from(first.parse.bytes).toString('utf8'),
      polygon: first.spatialOp.polygon,
      layers: first.locateLayers,
    }),
    perfDigestOf({
      parse: Buffer.from(second.parse.bytes).toString('utf8'),
      polygon: second.spatialOp.polygon,
      layers: second.locateLayers,
    }),
    'two generations must produce identical bytes',
  )
})

test('a mutated fixture digest refuses loudly (the freeze is enforced, not decorative)', () => {
  const mutated = { ...PERF_WORKLOAD_FIXTURE, seed: PERF_WORKLOAD_FIXTURE.seed + 1 }
  assert.throws(() => perfFixturesOf(mutated), /no longer match the pinned digest/, 'a different seed must refuse against the pin')
})

test('workload validation names every out-of-bound field', () => {
  const issues = validatePerfWorkload({
    seed: -1,
    repetitions: 0,
    locateLayerCount: 10_000,
    locateLayerFeatures: 0,
    parseFeatureCount: 2 ** 20,
    spatialOpRepeats: 'many',
    recoveryMutations: 1_000,
  })
  const fields = issues.map(issue => issue.field)
  for (const field of ['seed', 'repetitions', 'locateLayerCount', 'locateLayerFeatures', 'parseFeatureCount', 'spatialOpRepeats', 'recoveryMutations']) {
    assert.ok(fields.includes(field), `validation must name ${field}`)
  }
  assert.match(renderPerfIssues(issues), /workload-bounds/)
  assert.deepEqual(validatePerfWorkload(null), [{ field: 'workload', code: 'workload-required', message: 'the workload must be an object' }])
})

test('budget validation bounds every plane and the deployment budgets validate clean', () => {
  assert.deepEqual(validatePerfBudgets(PERF_DEPLOYMENT_BUDGETS), [], 'deployment budgets must validate clean')
  const issues = validatePerfBudgets({
    maxSessionBytes: 0,
    maxMetaBytes: 1.5,
    maxProjectionBytes: -4,
    maxDisplayBytes: PERF_BUDGET_BOUNDS.maxBytes + 1,
    maxScanRows: 0,
    maxTimeMs: 0,
    maxConcurrency: 0,
    maxSteps: 0,
  })
  assert.equal(issues.length, 8, 'every out-of-bound plane is named once')
  assert.deepEqual(validatePerfBudgets('nope'), [{ field: 'budgets', code: 'budgets-required', message: 'the budgets must be an object' }])
})

test('the hard budgets carry no estimated field and the segment vocabulary is closed', () => {
  const budgetKeys = Object.keys(PERF_DEPLOYMENT_BUDGETS)
  assert.equal(budgetKeys.length, 8, 'the hard budgets have exactly their eight planes')
  assert.ok(budgetKeys.every(key => !key.toLowerCase().includes('estimated')), 'no estimated field hides in the hard budgets')
  assert.deepEqual(
    [...PERF_SEGMENTS].sort(),
    ['cancel', 'commit', 'compute', 'context', 'flush', 'mcp', 'render', 'scan'],
    'the segment vocabulary stays the design\'s named measurement points',
  )
  assert.deepEqual([...PERF_LABEL_KEYS].sort(), ['stage', 'unit', 'workload'], 'labels stay bounded and enumerable')
})

test('the v2 method and recorded thresholds carry every gate the benchmark evaluates', () => {
  assert.equal(PERF_METHOD_VERSION, 'spatial-perf@2')
  const thresholdKeys = Object.keys(PERF_RECORDED_THRESHOLDS).sort()
  assert.deepEqual(thresholdKeys, [
    'maxCancelQuiescenceMs',
    'maxChainWallMs',
    'maxFlushWaitMs',
    'maxHeapGrowthBytes',
    'maxRecoveryReplayMs',
    'maxRenderDeriveMs',
    'maxRepetitionSpreadRatio',
    'minLocateFoldsPerProbeUnit',
    'minParseFeaturesPerProbeUnit',
    'minSpatialOpsPerProbeUnit',
  ])
  for (const value of Object.values(PERF_RECORDED_THRESHOLDS)) {
    assert.equal(typeof value, 'number', 'thresholds are numbers')
    assert.ok(Number.isFinite(value) && value > 0, 'thresholds are finite and positive')
  }
  assert.ok(PERF_WORKLOAD_IDS.length === 5, 'the workload catalog closes at five workloads')
})

test('historical absolute throughput is advisory and tied to one environment record', () => {
  const bands = Object.values(PERF_ADVISORY_THROUGHPUT)
  assert.equal(bands.length, 3)
  for (const band of bands) {
    assert.ok(band.low <= band.high)
    assert.ok(band.retiredFloor < band.low)
    assert.equal(band.recordedAt, '2026-09-25')
    assert.equal(band.environment, PERF_THRESHOLD_ENVIRONMENT)
  }
})
