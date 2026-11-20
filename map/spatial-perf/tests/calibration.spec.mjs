/** Calibration probe contract and deterministic work identity tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PERF_CALIBRATION_PAIRS,
  PERF_CALIBRATION_SECTIONS,
  PERF_CALIBRATION_SPEC,
  PERF_CALIBRATION_WORK_DIGEST,
  PERF_RECORDED_THRESHOLDS,
} from '../src/contract.ts'
import {
  calibrateSection,
  perfCalibrationRateOf,
  runPerfCalibrationProbe,
} from '../src/calibration.ts'
import { medianOf } from '../src/report.ts'

test('the frozen probe is deterministic and pinned', () => {
  const first = runPerfCalibrationProbe()
  const second = runPerfCalibrationProbe()
  assert.deepEqual(first.map(reading => reading.workDigest), [PERF_CALIBRATION_WORK_DIGEST])
  assert.deepEqual(second.map(reading => reading.workDigest), [PERF_CALIBRATION_WORK_DIGEST])
  assert.equal(first[0].section, 'compute-mix')
  assert.equal(first[0].units, 150_000)
  assert.equal(first[0].batchRates.length, 3)
  assert.equal(first[0].unitsPerSecond, medianOf([...first[0].batchRates].sort((a, b) => a - b)))
  assert.equal(first[0].batchSpreadRatio, Math.max(...first[0].batchRates) / Math.min(...first[0].batchRates))
})

test('the section vocabulary and frozen specification are closed', () => {
  assert.deepEqual(PERF_CALIBRATION_SECTIONS, ['compute-mix'])
  assert.deepEqual(PERF_CALIBRATION_SPEC, [{ section: 'compute-mix', batchUnits: 50_000, batches: 3 }])
  assert.throws(
    () => calibrateSection({ section: 'compute-mix', batchUnits: 50_001, batches: 3 }),
    /no longer matches the pinned digest/,
  )
  assert.throws(
    () => calibrateSection({ section: 'compute-mix', batchUnits: 50_000, batches: 2 }),
    /no longer matches the pinned digest/,
  )
})

test('the rate guard rejects invalid duration and throughput values', () => {
  assert.throws(() => perfCalibrationRateOf(50_000, 0n), /duration must be positive/)
  assert.throws(() => perfCalibrationRateOf(50_000, -1n), /duration must be positive/)
  assert.throws(() => perfCalibrationRateOf(Number.MAX_VALUE, 1n), /rate must be finite and positive/)
  assert.throws(() => perfCalibrationRateOf(1, 10n ** 400n), /rate must be finite and positive/)
})

test('the pairing table covers exactly the three ratio gates', () => {
  assert.deepEqual(
    PERF_CALIBRATION_PAIRS.map(pair => [pair.gate, pair.workload, pair.metric, pair.section, pair.floorField]),
    [
      ['locate folds throughput', 'locate-visibility', 'folds/s', 'compute-mix', 'minLocateFoldsPerProbeUnit'],
      ['parse/register throughput', 'parse-register', 'features/s', 'compute-mix', 'minParseFeaturesPerProbeUnit'],
      ['spatial-op throughput', 'spatial-op', 'ops/s', 'compute-mix', 'minSpatialOpsPerProbeUnit'],
    ],
  )
  for (const pair of PERF_CALIBRATION_PAIRS) {
    assert.ok(PERF_RECORDED_THRESHOLDS[pair.floorField] > 0)
  }
})
