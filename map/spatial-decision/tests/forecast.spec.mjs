/**
 * Forecast fixtures: the time-forward holdout beats the naive baseline on an
 * exact trend, concurrent features are loud refusals wherever a value would
 * have to exist before it is observed (validation and prediction), late rows
 * are excluded by name, intervals carry an independently recomputed width,
 * the fit→predict round trip reproduces through the serialized model record,
 * and out-of-domain / drift states are named flags instead of silent
 * extrapolations.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DECISION_METHOD_VERSION, decisionSpecDigestOf } from '../src/contract.ts'
import {
  FEATURE_DRIFT_LIMIT,
  binIndexOf,
  computeForecastFit,
  computeForecastPredict,
  computeForecastValidation,
} from '../src/forecast.ts'
import { olsFit, tQuantile } from '../src/linalg.ts'
import { mulberry32 } from '../../spatial-statistics/src/rand.ts'

const publish = async (label) => ({ ref: `art-${label}@v1` })
const METHOD = DECISION_METHOD_VERSION
const DAY = 86_400_000

/** One history row: outcome = 10 + 2·day + 3·(day mod 2). */
function historyRows({ days = 31, units = 2, noise = 0, seed = 7 } = {}) {
  const stream = mulberry32(seed)
  const rows = []
  for (let day = 0; day < days; day++) {
    for (let unit = 0; unit < units; unit++) {
      rows.push({
        id: `u${unit}`,
        coordinates: [116 + unit * 0.01, 39],
        timeMs: Date.UTC(2026, 0, 1 + day),
        values: {
          demand: 10 + 2 * day + 3 * (day % 2) + (noise === 0 ? 0 : (stream.next() * 2 - 1) * noise),
          pulse: day % 2,
          ts: undefined,
        },
      })
    }
  }
  return rows
}

const forecastSpec = {
  goalRevision: 1,
  resourceRef: 'res-history@v1',
  outcomeField: 'demand',
  timeField: 'ts',
  features: [{ field: 'pulse', availability: 'known-at-origin' }],
  window: { from: '2026-01-01T00:00:00Z', to: '2026-01-27T00:00:00Z' },
  granularity: 'day',
  baseline: 'naive',
  holdoutSteps: 5,
  blockMeters: 100_000,
  intervalLevel: 0.9,
  methodVersion: METHOD,
}

test('the time-forward holdout beats the naive baseline on an exact trend', async () => {
  const evidence = await computeForecastValidation(historyRows(), forecastSpec, publish)
  assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.holdoutBins, 5, 'the last five distinct bins are held out')
  // Cutoff Jan 27 admits days 0–25 (52 rows); holdout days 21–25 → 42 train rows.
  assert.equal(evidence.trainRows, 42)
  assert.ok(evidence.model.mae < 1e-9, `exact trend fits with zero MAE (got ${evidence.model.mae})`)
  // The naive baseline repeats day-20 values through days 21–25, so it must miss.
  assert.ok(evidence.baseline.mae > 5, `naive MAE (got ${evidence.baseline.mae})`)
  assert.ok(Math.abs(evidence.skill - 1) < 1e-9, `skill 1 on the exact trend (got ${evidence.skill})`)
  // Zero residual sigma collapses the intervals: empirical coverage is exactly 1.
  assert.equal(evidence.intervalCoverage, 1)
  assert.ok(evidence.blocks.length >= 1, 'the per-block validation rows are present')
  assert.ok(evidence.limitations.some(line => line.includes('naive baseline')))
})

test('late rows and missing fields are excluded with named diagnostics', async () => {
  const rows = [
    ...historyRows(),
    { id: 'late', coordinates: [116, 39], timeMs: Date.UTC(2026, 1, 1), values: { demand: 999, pulse: 1 } },
    { id: 'hole', coordinates: [116, 39], timeMs: Date.UTC(2026, 0, 10), values: { demand: 999 } },
  ]
  const evidence = await computeForecastValidation(rows, forecastSpec, publish)
  // Days 26–30 sit at or after the cutoff (2 units × 5 days) plus the manual late row.
  assert.equal(evidence.lateRows, 11, 'the at-or-after-cutoff rows are excluded')
  assert.equal(evidence.accounting.droppedByReason['missing-fields'], 1)
  assert.equal(evidence.accounting.droppedByReason['outside-training-window'], 11)
})

test('concurrent features are refusals for validation and prediction, never silent leakage', async () => {
  const concurrentSpec = {
    ...forecastSpec,
    features: [{ field: 'pulse', availability: 'concurrent' }],
  }
  await assert.rejects(
    () => computeForecastValidation(historyRows(), concurrentSpec, publish),
    (error) => error instanceof Error && error.message.includes('concurrent'),
    'time-forward validation with a concurrent feature is leakage and fails loud',
  )
  const fit = await computeForecastFit(historyRows(), concurrentSpec, 'digest', publish)
  assert.equal(fit.status, 'succeeded', 'the in-sample fit may describe concurrent features')
  assert.ok(fit.limitations.some(line => line.includes('concurrent')))
  await assert.rejects(
    () => computeForecastPredict(historyRows(), fit.model, {
      goalRevision: 1, modelRef: 'art-m@v1', resourceRef: 'res-future@v1',
      horizonSteps: 1, intervalLevel: 0.9, methodVersion: METHOD,
    }, publish),
    (error) => error instanceof Error && error.message.includes('concurrent'),
    'prediction with a concurrent feature is impossible and fails loud',
  )
})

test('the fitted model round-trips through JSON and predicts the analytic continuation', async () => {
  const fit = await computeForecastFit(historyRows(), forecastSpec, decisionSpecDigestOf(forecastSpec), publish)
  assert.equal(fit.status, 'succeeded')
  // Serialize/deserialize like the artifact store does.
  const model = JSON.parse(JSON.stringify(fit.model))
  assert.equal(model.kind, 'spatial-decision-forecast-model')
  const futureRows = [
    { id: 'u0', coordinates: [116, 39], timeMs: Date.UTC(2026, 1, 4), values: { pulse: 0 } },
    { id: 'u1', coordinates: [116.01, 39], timeMs: Date.UTC(2026, 1, 4), values: { pulse: 1 } },
  ]
  const evidence = await computeForecastPredict(futureRows, model, {
    goalRevision: 1, modelRef: 'art-m@v1', resourceRef: 'res-future@v1',
    horizonSteps: 4, intervalLevel: 0.9, methodVersion: METHOD,
  }, publish)
  assert.equal(evidence.status, 'succeeded')
  assert.equal(evidence.horizonBins, 4)
  // Day 25 + 4 → day 29: u0 (pulse 0) predicts 10 + 58 = 68; u1 (pulse 1) predicts 71.
  const u0 = evidence.rows.find(row => row.id === 'u0')
  const u1 = evidence.rows.find(row => row.id === 'u1')
  assert.ok(u0 && u1)
  assert.ok(Math.abs(u0.predicted - 68) < 1e-9, `u0 prediction (got ${u0.predicted})`)
  assert.ok(Math.abs(u1.predicted - 71) < 1e-9, `u1 prediction (got ${u1.predicted})`)
  // The naive baseline uses each row's last observed value (both saw day 25 → 63).
  assert.ok(Math.abs(u0.baseline - 63) < 1e-9, `naive baseline (got ${u0.baseline})`)
  assert.deepEqual(evidence.driftedFeatures, [], 'identical feature levels do not drift')
  assert.equal(evidence.rowsOutOfDomain, 0)
  assert.equal(evidence.modelRef, 'art-m@v1')
})

test('out-of-domain features and drifted means are named, never silently extrapolated', async () => {
  const fit = await computeForecastFit(historyRows({ days: 20 }), { ...forecastSpec, window: { from: '2026-01-01T00:00:00Z', to: '2026-01-21T00:00:00Z' } }, 'digest', publish)
  const model = JSON.parse(JSON.stringify(fit.model))
  // pulse ∈ {0,1} in training; prediction rows carry 0, 2 (out of domain), and a drifted mean (> 0.5 sd).
  const futureRows = [
    { id: 'a', coordinates: [116, 39], timeMs: Date.UTC(2026, 1, 1), values: { pulse: 0 } },
    { id: 'b', coordinates: [116, 39], timeMs: Date.UTC(2026, 1, 1), values: { pulse: 2 } },
  ]
  const evidence = await computeForecastPredict(futureRows, model, {
    goalRevision: 1, modelRef: 'art-m@v1', resourceRef: 'res-future@v1',
    horizonSteps: 1, intervalLevel: 0.9, methodVersion: METHOD,
  }, publish)
  const flagged = evidence.rows.find(row => row.id === 'b')
  assert.ok(flagged)
  assert.deepEqual(flagged.outOfDomainFeatures, ['pulse'], 'the out-of-range feature is named on the row')
  assert.equal(evidence.rowsOutOfDomain, 1)
  assert.ok(evidence.driftedFeatures.includes('pulse'), `drift named (got ${evidence.driftedFeatures})`)
  assert.ok(evidence.limitations.some(line => line.includes('drift detected')))
  // The drift flag uses the documented limit: |shift| / sd > 0.5.
  assert.ok(FEATURE_DRIFT_LIMIT === 0.5)
})

test('method-version drift between fit and predict is refused', async () => {
  const fit = await computeForecastFit(historyRows({ days: 20 }), { ...forecastSpec, window: { from: '2026-01-01T00:00:00Z', to: '2026-01-21T00:00:00Z' } }, 'digest', publish)
  const stale = { ...JSON.parse(JSON.stringify(fit.model)), methodVersion: 'p3-spatial-decision@0' }
  await assert.rejects(
    () => computeForecastPredict([], stale, {
      goalRevision: 1, modelRef: 'art-m@v1', resourceRef: 'res-future@v1',
      horizonSteps: 1, intervalLevel: 0.9, methodVersion: METHOD,
    }, publish),
    (error) => error instanceof Error && error.message.includes('will not reuse'),
  )
})

test('noisy holdout metrics and interval coverage match an independent recomputation', async () => {
  const rows = historyRows({ days: 31, noise: 1, seed: 11 })
  const evidence = await computeForecastValidation(rows, forecastSpec, publish)
  assert.equal(evidence.status, 'succeeded')
  assert.ok(evidence.intervalCoverage >= 0.8, `coverage at the 0.9 level (got ${evidence.intervalCoverage})`)
  // Second code path over the same frozen rows: an inline design build + OLS +
  // per-holdout-row prediction, compared metric by metric with the evidence.
  const originDay = Math.floor(Date.UTC(2026, 0, 1) / DAY)
  const dayOf = row => Math.floor(row.timeMs / DAY) - originDay
  const designRowOf = row => [1, dayOf(row), dayOf(row) % 2]
  // Train days 0–20 (Jan 1–21); holdout days 21–25 (Jan 22–26).
  const trainRows = rows.filter(row => row.timeMs < Date.UTC(2026, 0, 22))
  const holdoutRows = rows.filter(row => row.timeMs >= Date.UTC(2026, 0, 22) && row.timeMs < Date.UTC(2026, 0, 27))
  const fit = olsFit(trainRows.map(designRowOf), trainRows.map(row => row.values.demand))
  assert.ok(fit !== undefined)
  const predictOf = row => designRowOf(row).reduce((s, value, col) => s + value * (fit.beta[col] ?? 0), 0)
  const mae = holdoutRows.reduce((s, row) => s + Math.abs((row.values.demand ?? 0) - predictOf(row)), 0) / holdoutRows.length
  const critical = tQuantile(0.95, fit.df)
  let covered = 0
  for (const row of holdoutRows) {
    const x = designRowOf(row)
    const xtxRow = [0, 1, 2].map(a => x.reduce((s, value, b) => s + value * (fit.xtxInv[b]?.[a] ?? 0), 0))
    const leverage = x.reduce((s, value, col) => s + value * (xtxRow[col] ?? 0), 0)
    const width = critical * fit.sigma * Math.sqrt(1 + leverage)
    if (Math.abs((row.values.demand ?? 0) - predictOf(row)) <= width) covered++
  }
  assert.ok(Math.abs(mae - evidence.model.mae) < 1e-9, `independent MAE (got ${mae} vs ${evidence.model.mae})`)
  assert.ok(Math.abs(covered / holdoutRows.length - evidence.intervalCoverage) < 1e-9, 'independent coverage')
})

test('binIndexOf anchors day/week/month bins deterministically', () => {
  assert.equal(binIndexOf(Date.UTC(2026, 0, 1), 'day'), Math.floor(Date.UTC(2026, 0, 1) / DAY))
  assert.equal(binIndexOf(Date.UTC(2026, 0, 8), 'week') - binIndexOf(Date.UTC(2026, 0, 1), 'week'), 1)
  assert.equal(binIndexOf(Date.UTC(2026, 1, 1), 'month') - binIndexOf(Date.UTC(2026, 0, 1), 'month'), 1)
  assert.equal(binIndexOf(Date.UTC(2027, 0, 1), 'month') - binIndexOf(Date.UTC(2026, 0, 1), 'month'), 12)
})

test('threshold family selects one split with minimum leaves and round-trips', async () => {
  const rows = []
  for (let day = 0; day < 16; day++) {
    const x = day % 2
    rows.push({
      id: `u${day % 2}`,
      coordinates: [116, 39],
      timeMs: Date.UTC(2026, 0, 1 + day),
      values: { demand: x === 0 ? 3 : 13, x },
    })
  }
  const spec = {
    ...forecastSpec,
    modelFamily: 'threshold',
    features: [{ field: 'x', availability: 'known-at-origin' }],
    window: { from: '2026-01-01T00:00:00Z', to: '2026-01-17T00:00:00Z' },
  }
  const fit = await computeForecastFit(rows, spec, 'threshold-digest', publish)
  assert.equal(fit.modelFamily, 'threshold')
  assert.equal(fit.model.modelFamily, 'threshold')
  assert.equal(fit.model.threshold?.feature, 'x')
  assert.equal(fit.model.threshold?.minLeafSamples, 2)
  assert.ok(fit.limitations.some(line => line.includes('single-split')))
  const validation = await computeForecastValidation(rows, spec, publish)
  assert.equal(validation.status, 'succeeded')
  assert.ok(validation.model.mae < validation.baseline.mae, 'threshold holdout must beat the naive baseline')
  const model = JSON.parse(JSON.stringify(fit.model))
  const prediction = await computeForecastPredict([
    { id: 'u0', coordinates: [116, 39], timeMs: Date.UTC(2026, 1, 1), values: { x: 0 } },
    { id: 'u1', coordinates: [116, 39], timeMs: Date.UTC(2026, 1, 1), values: { x: 1 } },
  ], model, {
    goalRevision: 1, modelRef: 'art-threshold@v1', resourceRef: 'res-future@v1',
    horizonSteps: 1, intervalLevel: 0.9, methodVersion: METHOD,
  }, publish)
  assert.equal(prediction.modelFamily, 'threshold')
  assert.equal(prediction.rows.find(row => row.id === 'u0')?.predicted, 3)
  assert.equal(prediction.rows.find(row => row.id === 'u1')?.predicted, 13)
})

test('quadratic-ridge expands explicit squares and matches an independent ridge recomputation', async () => {
  const rows = []
  for (let day = 0; day < 16; day++) {
    const x = day - 7
    rows.push({
      id: `u${day % 2}`,
      coordinates: [116, 39],
      timeMs: Date.UTC(2026, 0, 1 + day),
      values: { demand: 5 + 2 * x + 0.5 * x ** 2, x },
    })
  }
  const spec = {
    ...forecastSpec,
    modelFamily: 'quadratic-ridge',
    features: [{ field: 'x', availability: 'known-at-origin' }],
    window: { from: '2026-01-01T00:00:00Z', to: '2026-01-17T00:00:00Z' },
  }
  const fit = await computeForecastFit(rows, spec, 'quadratic-digest', publish)
  assert.equal(fit.modelFamily, 'quadratic-ridge')
  assert.equal(fit.model.ridgeLambda, 1)
  assert.deepEqual(fit.model.designColumns, ['intercept', 'time', 'time^2', 'x', 'x^2'])
  assert.ok(fit.limitations.some(line => line.includes('fixed ridge penalty 1')))
  const model = JSON.parse(JSON.stringify(fit.model))
  const evidence = await computeForecastPredict([
    { id: 'u0', coordinates: [116, 39], timeMs: Date.UTC(2026, 1, 1), values: { x: 8 } },
  ], model, {
    goalRevision: 1, modelRef: 'art-quadratic@v1', resourceRef: 'res-future@v1',
    horizonSteps: 1, intervalLevel: 0.9, methodVersion: METHOD,
  }, publish)
  assert.equal(evidence.modelFamily, 'quadratic-ridge')
  const design = rows.map((row, day) => [1, day, day ** 2, row.values.x, row.values.x ** 2])
  const xtx = Array.from({ length: 5 }, () => Array(5).fill(0))
  const xty = Array(5).fill(0)
  for (let i = 0; i < design.length; i++) {
    for (let a = 0; a < 5; a++) {
      xty[a] += design[i][a] * rows[i].values.demand
      for (let b = 0; b < 5; b++) xtx[a][b] += design[i][a] * design[i][b]
    }
  }
  for (let diagonal = 1; diagonal < 5; diagonal++) xtx[diagonal][diagonal] += 1
  for (let col = 0; col < 5; col++) {
    let pivot = col
    for (let row = col + 1; row < 5; row++) if (Math.abs(xtx[row][col]) > Math.abs(xtx[pivot][col])) pivot = row
    ;[xtx[col], xtx[pivot]] = [xtx[pivot], xtx[col]]
    ;[xty[col], xty[pivot]] = [xty[pivot], xty[col]]
    for (let row = col + 1; row < 5; row++) {
      const factor = xtx[row][col] / xtx[col][col]
      for (let k = col; k < 5; k++) xtx[row][k] -= factor * xtx[col][k]
      xty[row] -= factor * xty[col]
    }
  }
  const beta = Array(5).fill(0)
  for (let row = 4; row >= 0; row--) {
    beta[row] = (xty[row] - xtx[row].slice(row + 1).reduce((sum, value, offset) => sum + value * beta[row + 1 + offset], 0)) / xtx[row][row]
  }
  const expected = [1, 16, 16 ** 2, 8, 8 ** 2].reduce((sum, value, col) => sum + value * beta[col], 0)
  assert.ok(Math.abs((evidence.rows[0]?.predicted ?? 0) - expected) < 1e-9, `independent ridge prediction (got ${evidence.rows[0]?.predicted} vs ${expected})`)
})
