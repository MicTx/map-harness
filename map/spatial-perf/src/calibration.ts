/**
 * The deterministic, map-independent calibration probe used by spatial-perf@2.
 * Probe work is deliberately outside product code and performs only built-in
 * CPU and bounded in-memory operations.
 *
 * @module @map-harness/spatial-perf/calibration
 */
import {
  PERF_CALIBRATION_SECTIONS,
  PERF_CALIBRATION_SPEC,
  PERF_CALIBRATION_WORK_DIGEST,
  perfDigestOf,
  type PerfCalibrationSection,
  type PerfCalibrationSectionSpec,
} from './contract.ts'
import { medianOf } from './report.ts'

/** One completed calibration section reading. */
export interface PerfCalibrationProbeReading {
  readonly section: PerfCalibrationSection
  readonly units: number
  readonly batchRates: readonly number[]
  readonly unitsPerSecond: number
  readonly batchSpreadRatio: number
  readonly workDigest: string
}

/** The injectable calibration runner used by the benchmark and its tests. */
export type PerfCalibrationRunner = (
  spec: readonly PerfCalibrationSectionSpec[],
) => readonly PerfCalibrationProbeReading[]

/**
 * Convert one batch duration to units per second and reject unusable
 * denominators before they can enter a ratio gate.
 * @param batchUnits - The number of completed units in the batch.
 * @param batchNanoseconds - The batch wall-clock duration.
 * @returns The batch throughput in units per second.
 * @throws If the duration or resulting throughput is non-positive or non-finite.
 */
export function perfCalibrationRateOf(batchUnits: number, batchNanoseconds: bigint): number {
  if (batchNanoseconds <= 0n) {
    throw new Error(`calibration batch duration must be positive; received ${batchNanoseconds}ns`)
  }
  const seconds = Number(batchNanoseconds) / 1e9
  const rate = batchUnits / seconds
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`calibration batch rate must be finite and positive; received ${rate}`)
  }
  return rate
}

/**
 * Run all frozen calibration sections once. The default specification is
 * immutable; a changed specification produces a digest mismatch error.
 * @param spec - The section specifications to execute.
 * @returns One reading per requested section.
 * @throws If a section is not part of the closed vocabulary or its work digest changes.
 */
export function runPerfCalibrationProbe(
  spec: readonly PerfCalibrationSectionSpec[] = PERF_CALIBRATION_SPEC,
): readonly PerfCalibrationProbeReading[] {
  return spec.map(calibrateSection)
}

/**
 * Execute one calibration section and assemble its batch statistics.
 * @param spec - The frozen section specification.
 * @returns The deterministic work identity and measured batch rates.
 * @throws If the section specification is not the frozen calibration work.
 */
export function calibrateSection(spec: PerfCalibrationSectionSpec): PerfCalibrationProbeReading {
  if (!PERF_CALIBRATION_SECTIONS.includes(spec.section)) {
    throw new Error(`unknown calibration section: ${String(spec.section)}`)
  }
  if (!Number.isInteger(spec.batchUnits) || spec.batchUnits <= 0 || !Number.isInteger(spec.batches) || spec.batches <= 0) {
    throw new Error(`invalid calibration specification for ${spec.section}: batchUnits and batches must be positive integers`)
  }

  const batchRates: number[] = []
  let totalSink = 0
  const sortFirst: number[] = []
  let units = 0
  for (let batch = 0; batch < spec.batches; batch++) {
    const started = process.hrtime.bigint()
    const result = runComputeMix(spec.batchUnits)
    const elapsed = process.hrtime.bigint() - started
    batchRates.push(perfCalibrationRateOf(spec.batchUnits, elapsed))
    totalSink += result.sink
    sortFirst.push(...result.sortFirst)
    units += spec.batchUnits
  }

  const workDigest = perfDigestOf({
    section: spec.section,
    units,
    sink: Math.round(totalSink * 1e6),
    sortFirstDigest: perfDigestOf(sortFirst),
  })
  if (workDigest !== PERF_CALIBRATION_WORK_DIGEST) {
    throw new Error(
      `calibration work no longer matches the pinned digest: generated ${workDigest}, pinned ${PERF_CALIBRATION_WORK_DIGEST}`,
    )
  }

  const minimum = Math.min(...batchRates)
  const maximum = Math.max(...batchRates)
  return {
    section: spec.section,
    units,
    batchRates,
    unitsPerSecond: medianOf([...batchRates].sort((left, right) => left - right)),
    batchSpreadRatio: maximum / minimum,
    workDigest,
  }
}

interface ComputeMixResult {
  readonly sink: number
  readonly sortFirst: readonly number[]
}

/** Execute the frozen compute-mix unit loop without reading a clock. */
function runComputeMix(units: number): ComputeMixResult {
  const entries = new Map<string, number>()
  const sortInput = Object.freeze(Array.from({ length: 256 }, (_, index) => ((index * 2654435761) % 1000) / 1000))
  const sortFirst: number[] = []
  let sink = 0
  for (let index = 0; index < units; index++) {
    const record = {
      index,
      id: `p-${index % 8192}`,
      value: ((index * 2654435761) % 1000) / 1000,
      tag: 'compute-mix',
    }
    const parsed = JSON.parse(JSON.stringify(record)) as typeof record
    entries.set(parsed.id, parsed.value)
    if (entries.size > 4096) {
      const oldest = entries.keys().next().value
      if (typeof oldest === 'string') entries.delete(oldest)
    }
    sink += parsed.index + parsed.value + entries.size
    if (index % 256 === 0) {
      const sorted = [...sortInput].sort((left, right) => left - right)
      sink += sorted[0] ?? 0
      sortFirst.push(sorted[0] ?? 0)
    }
  }
  return { sink, sortFirst }
}
