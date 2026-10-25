/**
 * The CI benchmark gate: run the frozen workload against the real production
 * planes TWICE, require every recorded threshold gate to pass on both runs,
 * and require the workload aggregates to be identical across the runs — the
 * frozen workload replays exactly, and a threshold miss fails the suite
 * loudly instead of being waved through as "data still came out right".
 *
 * Thresholds live in `src/contract.ts` (PERF_RECORDED_THRESHOLDS) with the
 * raw measured bands in the constant's comment; a different host re-records
 * before comparing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PERF_CALIBRATION_PAIRS, PERF_CALIBRATION_WORK_DIGEST, PERF_DEPLOYMENT_BUDGETS, PERF_METHOD_VERSION, PERF_RECORDED_THRESHOLDS, PERF_WORKLOAD_FIXTURE } from '../src/contract.ts'
import { compareWithBaseline, medianOf, renderTrendReport } from '../src/report.ts'
import { runPerfCalibrationProbe } from '../src/calibration.ts'
import { runPerfBenchmark } from '../src/run-benchmark.ts'
import { perfPortsOf } from './perf-rig.mjs'

const root = mkdtempSync(join(tmpdir(), 'perf-gate-'))
const wired = await perfPortsOf(root)

/** The two gate runs, produced once and judged by the tests below in order. */
const runs = []

test.after(async () => {
  await wired.dispose()
  rmSync(root, { recursive: true, force: true })
})

test('first gate run: every recorded threshold passes and every plane is observed', async (t) => {
  const report = await runPerfBenchmark(wired.ports, {
    workload: PERF_WORKLOAD_FIXTURE,
    thresholds: PERF_RECORDED_THRESHOLDS,
    budgets: PERF_DEPLOYMENT_BUDGETS,
  })
  runs.push(report)
  assert.equal(report.methodVersion, PERF_METHOD_VERSION, 'the report cites this package\'s method version')
  for (const gate of report.gates) {
    assert.ok(gate.passed, `gate ${gate.gate} failed: measured ${gate.measured} against ${gate.direction} ${gate.threshold} ${gate.unit}`)
  }
  assert.equal(report.passed, true)
  assert.equal(report.calibration.sections['compute-mix'].workDigest, report.calibration.workDigest)
  for (const pair of PERF_CALIBRATION_PAIRS) {
    const outcome = report.workloads[pair.workload]
    const gate = report.gates.find(candidate => candidate.gate === pair.gate)
    assert.ok(gate)
    assert.equal(gate.kind, 'calibrated-ratio')
    assert.equal(gate.measured, outcome.calibratedMedian)
    assert.equal(gate.numerator, outcome.median)
    assert.equal(gate.denominator, medianOf([...outcome.paired].map(value => value.probe).sort((a, b) => a - b)))
    for (const [index, paired] of outcome.paired.entries()) {
      assert.equal(paired.ratio, paired.target / paired.probe)
      assert.equal(report.calibration.readings.find(reading => reading.workload === pair.workload && reading.repetition === index)?.unitsPerSecond, paired.probe)
    }
    t.diagnostic(`${gate.gate}: ${gate.measured} ${gate.direction} ${gate.threshold} ${gate.unit}; numerator=${gate.numerator}; denominator=${gate.denominator}; absolute=${gate.absoluteAdvisory}`)
  }
  assert.equal(report.passed, true)
  assert.equal(report.telemetryDegraded, false, 'the frozen workload stays inside the sampler capacity')
  assert.ok(report.cancelQuiescenceMs > 0, 'the cancel leg measured a real settlement span')
  assert.ok(report.flushWaitMs >= 0, 'the flush barrier was measured')
  assert.ok(report.renderDeriveMs >= 0, 'the display derivation was measured')
  assert.ok(report.heapGrowthBytes >= 0)
  // Every segment the checklist names appears in the segmented summaries.
  const segments = new Set(Object.values(report.workloads).flatMap(outcome => outcome.sampler.segments.map(entry => entry.segment)))
  for (const segment of ['context', 'mcp', 'compute', 'commit', 'flush', 'render', 'scan']) {
    assert.ok(segments.has(segment), `segment ${segment} is observed in the segmented summaries`)
  }
  // The cumulative spend is visible per plane.
  for (const plane of ['sessionBytes', 'metaBytes', 'projectionDeltaBytes', 'displayBytes', 'scanRows', 'steps']) {
    assert.ok(report.spend[plane] > 0, `the run's ${plane} spend is recorded`)
  }
})

test('second gate run: the same gates pass and the workload aggregates repeat identically', async () => {
  assert.equal(runs.length, 1, 'the runs execute in declaration order')
  const first = runs[0]
  const second = await runPerfBenchmark(wired.ports, {
    workload: PERF_WORKLOAD_FIXTURE,
    thresholds: PERF_RECORDED_THRESHOLDS,
    budgets: PERF_DEPLOYMENT_BUDGETS,
  })
  runs.push(second)
  assert.equal(second.passed, true, 'the second run must pass every gate too')
  assert.ok(second.workloads['locate-visibility'].paired.length === PERF_WORKLOAD_FIXTURE.repetitions)
  assert.ok(second.workloads['parse-register'].paired.length === PERF_WORKLOAD_FIXTURE.repetitions)
  assert.ok(second.workloads['spatial-op'].paired.length === PERF_WORKLOAD_FIXTURE.repetitions)
  for (const workloadId of Object.keys(first.workloads)) {
    assert.equal(
      second.workloads[workloadId].aggregateDigest,
      first.workloads[workloadId].aggregateDigest,
      `${workloadId}: the deterministic aggregate must repeat identically across runs`,
    )
  }
})

test('probe scaling is compensated, while a fixed extreme probe and a tenfold floor expose regressions', async () => {
  const scaled = factor => spec => runPerfCalibrationProbe(spec).map(reading => ({
    ...reading,
    unitsPerSecond: reading.unitsPerSecond / factor,
    batchRates: reading.batchRates.map(rate => rate / factor),
  }))
  const compensated = await runPerfBenchmark(wired.ports, { calibration: scaled(4) })
  assert.equal(compensated.gates.slice(0, 3).every(gate => gate.passed), true)
  for (const [index, reading] of compensated.advisory.entries()) {
    const reference = runs[1].advisory[index].measured
    assert.ok(reading.measured >= reference / 2 && reading.measured <= reference * 2, `${reading.gate}: probe scaling must not alter the absolute target materially`)
  }

  const fixed = spec => runPerfCalibrationProbe(spec).map(reading => ({
    ...reading,
    unitsPerSecond: 1e9,
    batchRates: reading.batchRates.map(() => 1e9),
    workDigest: PERF_CALIBRATION_WORK_DIGEST,
  }))
  const fixedProbe = await runPerfBenchmark(wired.ports, { calibration: fixed })
  assert.equal(fixedProbe.gates.slice(0, 3).every(gate => !gate.passed), true)
  assert.equal(fixedProbe.gates.slice(3).every(gate => gate.passed), true)

  const tenfold = {
    ...PERF_RECORDED_THRESHOLDS,
    minLocateFoldsPerProbeUnit: PERF_RECORDED_THRESHOLDS.minLocateFoldsPerProbeUnit * 10,
    minParseFeaturesPerProbeUnit: PERF_RECORDED_THRESHOLDS.minParseFeaturesPerProbeUnit * 10,
    minSpatialOpsPerProbeUnit: PERF_RECORDED_THRESHOLDS.minSpatialOpsPerProbeUnit * 10,
  }
  const thresholdRegression = await runPerfBenchmark(wired.ports, { thresholds: tenfold })
  assert.equal(thresholdRegression.gates.slice(0, 3).every(gate => !gate.passed), true)
  assert.equal(thresholdRegression.gates.slice(3).every(gate => gate.passed), true)
})

test('the trend renderer and baseline comparator report stability honestly', () => {
  assert.equal(runs.length, 2, 'both gate runs have completed')
  const [first, second] = runs
  const trend = renderTrendReport([first, second])
  assert.match(trend.at(-1), /identical across runs/, 'two clean runs render the stability verdict')
  assert.match(trend[1], /floor|ceiling/, 'each gate line names its direction')
  // A same-host rerun is comparable and produces no regressions when both pass.
  const comparison = compareWithBaseline(second, first)
  assert.equal(comparison.comparable, true)
  assert.deepEqual(comparison.regressions, [], 'two passing runs contain no regressions')
  // A report from a different workload seed is NOT comparable — re-record first.
  const foreign = { ...first, workload: { ...first.workload, seed: first.workload.seed + 1 } }
  assert.equal(compareWithBaseline(second, foreign).comparable, false)
})

test('the report survives a JSON round-trip (the versioned report artifact is plain JSON)', () => {
  const parsed = JSON.parse(JSON.stringify(runs[1]))
  assert.equal(parsed.methodVersion, runs[1].methodVersion)
  assert.equal(parsed.passed, runs[1].passed)
  assert.equal(Object.keys(parsed.workloads).length, 5)
  assert.ok(Array.isArray(parsed.gates) && parsed.gates.length >= 10)
})
