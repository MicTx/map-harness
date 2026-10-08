/**
 * The benchmark report plane: the environment record every report carries,
 * the gate evaluation against recorded thresholds, the run-to-run stability
 * projection, and the trend/baseline comparison the diagnostic command
 * prints. A gate miss fails the benchmark loudly; a different host re-records
 * before comparing.
 *
 * @module @map-harness/spatial-perf/report
 */
import { execSync } from 'node:child_process'
import os from 'node:os'
import {
  PERF_METHOD_VERSION,
  PERF_THRESHOLD_ENVIRONMENT,
  type PerfAdvisoryBand,
  type PerfCalibrationSection,
  type PerfEstimatedCost,
  type PerfHardBudgets,
  type PerfWorkload,
} from './contract.ts'
import type { PerfSpend } from './budgets.ts'
import type { PerfWorkloadId } from './workloads.ts'

/** The environment one report was measured on (the re-recording contract). */
export interface PerfEnvironment {
  readonly platform: string
  readonly arch: string
  readonly nodeVersion: string
  readonly cpuModel: string
  readonly cpuCount: number
  readonly totalMemoryBytes: number
  /** ISO timestamp of the run. */
  readonly recordedAt: string
  /** The git ref the run measured (when resolvable). */
  readonly gitRef: string | null
  /**
   * The ArcGIS JS API version — a browser deployment input this keyless Node
   * benchmark plane never loads; recorded as a declaration, not a measurement.
   */
  readonly arcgisApiVersion: string
  /**
   * The model id — a provider deployment input never exercised keyless;
   * recorded as a declaration, not a measurement.
   */
  readonly modelId: string
}

/** One evaluated gate. */
export interface PerfBenchmarkGate {
  readonly gate: string
  readonly measured: number
  readonly threshold: number
  readonly direction: '>=' | '<='
  readonly unit: string
  readonly passed: boolean
  readonly kind: 'calibrated-ratio' | 'absolute'
  readonly numerator: number | null
  readonly denominator: number | null
  readonly probeSection: PerfCalibrationSection | null
  readonly absoluteAdvisory: number | null
}

/** One target/probe pair from one workload repetition. */
export interface PerfCalibrationPair {
  readonly target: number
  readonly probe: number
  readonly ratio: number
}

/** The calibration evidence recorded alongside a benchmark report. */
export interface PerfCalibrationReport {
  readonly workDigest: string
  readonly sections: Readonly<Record<PerfCalibrationSection, {
    readonly units: number
    readonly batches: number
    readonly medianUnitsPerSecond: number
    readonly readingSpreadRatio: number
    readonly workDigest: string
  }>>
  readonly readings: readonly { readonly workload: PerfWorkloadId; readonly repetition: number; readonly unitsPerSecond: number }[]
}

/** One absolute throughput observation retained for diagnostics, never gating. */
export interface PerfAdvisoryReading {
  readonly gate: string
  readonly measured: number
  readonly unit: string
  readonly reference: PerfAdvisoryBand
  readonly position: 'at-or-above-reference' | 'below-reference' | 'below-retired-floor'
}

/** One workload's reported outcome. */
export interface PerfWorkloadOutcome {
  readonly workload: PerfWorkloadId
  /** The primary metric's unit (for example `folds/s`, `features/s`, `ms`). */
  readonly unit: string
  /** Per-repetition primary measurements. */
  readonly values: readonly number[]
  /** The median repetition measurement (what the gate evaluates). */
  readonly median: number
  /** Paired probe observations for a calibrated ratio workload. */
  readonly paired: readonly PerfCalibrationPair[]
  /** The package median statistic of paired ratios, or null for absolute workloads. */
  readonly calibratedMedian: number | null
  /** max/min spread across repetitions (1 for single-pass workloads). */
  readonly spreadRatio: number
  /** The deterministic aggregate; identical across runs. */
  readonly aggregate: unknown
  /** sha256 of the canonical aggregate — the cross-run identity pin. */
  readonly aggregateDigest: string
  /** The segmented sampler summary for this workload. */
  readonly sampler: import('./instrument.ts').PerfSummary
}

/** One full benchmark report. */
export interface PerfBenchmarkReport {
  readonly methodVersion: typeof PERF_METHOD_VERSION
  readonly environment: PerfEnvironment
  readonly workload: PerfWorkload
  readonly budgets: PerfHardBudgets
  /** The cumulative spend the budget ledger admitted during the run. */
  readonly spend: Required<PerfSpend>
  readonly workloads: Readonly<Record<PerfWorkloadId, PerfWorkloadOutcome>>
  readonly calibration: PerfCalibrationReport
  readonly advisory: readonly PerfAdvisoryReading[]
  /** The measured cancel-request → worker-quiescence milliseconds. */
  readonly cancelQuiescenceMs: number
  /** The measured flush durability barrier milliseconds (recovery session). */
  readonly flushWaitMs: number
  /** The measured display-derivation milliseconds (two-point chain). */
  readonly renderDeriveMs: number
  /** Coordinating-process heap growth across the whole run, bytes. */
  readonly heapGrowthBytes: number
  /** Estimated (non-enforced) provider costs recorded during the run. */
  readonly estimatedCosts: readonly PerfEstimatedCost[]
  /** Whether the sampler dropped samples past its capacity. */
  readonly telemetryDegraded: boolean
  readonly gates: readonly PerfBenchmarkGate[]
  readonly passed: boolean
}

/**
 * Capture the running environment. Throws nothing: an unresolvable git ref
 * records `null` rather than fabricating one.
 */
export function capturePerfEnvironment(): PerfEnvironment {
  let gitRef: string | null = null
  try {
    gitRef = execSync('git rev-parse --short HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    // A report without a git ref still records its hardware/node identity.
  }
  const cpus = os.cpus()
  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    nodeVersion: process.version,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    recordedAt: new Date().toISOString(),
    gitRef,
    arcgisApiVersion: 'not loaded in the Node benchmark plane (browser deployment input)',
    modelId: 'not exercised keyless (recorded deployment input)',
  }
}

/** One gate evaluation from a measured value, a threshold, and a direction. */
export function evaluateGate(
  gate: string,
  measured: number,
  threshold: number,
  direction: '>=' | '<=',
  unit: string,
): PerfBenchmarkGate {
  return {
    gate,
    measured: round3(measured),
    threshold,
    direction,
    unit,
    passed: direction === '>=' ? measured >= threshold : measured <= threshold,
    kind: 'absolute',
    numerator: null,
    denominator: null,
    probeSection: null,
    absoluteAdvisory: null,
  }
}

/** Evaluate a throughput ratio without recomputing its paired median. */
export function evaluateRatioGate(
  gate: string,
  measured: number,
  numerator: number,
  denominator: number,
  floor: number,
  unit: string,
  section: PerfCalibrationSection,
): PerfBenchmarkGate {
  return {
    gate,
    measured: round3(measured),
    threshold: floor,
    direction: '>=',
    unit,
    passed: measured >= floor,
    kind: 'calibrated-ratio',
    numerator,
    denominator,
    probeSection: section,
    absoluteAdvisory: numerator,
  }
}

/** The gates' overall verdict. */
export function gatesPass(gates: readonly PerfBenchmarkGate[]): boolean {
  return gates.every(gate => gate.passed)
}

/** The stable identity fields two reports must share before comparing (different workloads are not comparable). */
export function comparableWith(current: PerfBenchmarkReport, baseline: PerfBenchmarkReport): boolean {
  return current.methodVersion === baseline.methodVersion
    && current.environment.arch === baseline.environment.arch
    && current.workload.seed === baseline.workload.seed
    && Object.keys(current.workloads).join(',') === Object.keys(baseline.workloads).join(',')
}

/**
 * Compare one run against a baseline run: per-gate deltas and any gate that
 * passed before and fails now (a regression). Uses only the report payloads;
 * thresholds come from each report's own gate evaluation.
 * @param current - the run under judgment.
 * @param baseline - the previously recorded run.
 * @returns the per-gate delta lines plus the regression verdict.
 */
export function compareWithBaseline(
  current: PerfBenchmarkReport,
  baseline: PerfBenchmarkReport,
): { readonly comparable: boolean; readonly regressions: readonly string[]; readonly lines: readonly string[] } {
  if (!comparableWith(current, baseline)) {
    return { comparable: false, regressions: [], lines: ['not comparable: method version, architecture, or workload differs — re-record first'] }
  }
  const regressions: string[] = []
  const lines: string[] = []
  for (const gate of current.gates) {
    const before = baseline.gates.find(candidate => candidate.gate === gate.gate)
    if (before === undefined) {
      lines.push(`${gate.gate}: no baseline gate`)
      continue
    }
    const delta = round3(gate.measured - before.measured)
    lines.push(`${gate.gate}: ${before.measured} → ${gate.measured} (${delta >= 0 ? '+' : ''}${delta} ${gate.unit})`)
    if (before.passed && !gate.passed) {
      regressions.push(`${gate.gate} regressed: ${before.measured} passed, ${gate.measured} fails the ${gate.direction} ${gate.threshold} threshold`)
    }
  }
  return { comparable: true, regressions, lines }
}

/**
 * Render the trend across several runs of the same workload: per-gate
 * measured values in run order plus the threshold and verdict — the
 * diagnostic command's human output.
 * @param reports - the runs in chronological order (oldest first).
 * @returns the rendered trend lines.
 */
export function renderTrendReport(reports: readonly PerfBenchmarkReport[]): readonly string[] {
  if (reports.length === 0) return ['no runs']
  const lines: string[] = []
  lines.push(`spatial-perf trend across ${reports.length} run(s) on ${reports[0]?.environment.arch} node ${reports[0]?.environment.nodeVersion}`)
  const gateNames = reports[0]?.gates.map(gate => gate.gate) ?? []
  for (const gateName of gateNames) {
    const values = reports.map(report => report.gates.find(gate => gate.gate === gateName))
    const measured = values.map(gate => (gate === undefined ? '—' : String(gate.measured)))
    const reference = values.find(gate => gate !== undefined)
    if (reference === undefined) continue
    const verdicts = values.map(gate => (gate === undefined ? '—' : gate.passed ? 'pass' : 'FAIL'))
    lines.push(
      `${reference.direction === '>=' ? 'floor' : 'ceiling'} ${gateName}: ${measured.join(' → ')} (threshold ${reference.direction} ${reference.threshold} ${reference.unit}; ${verdicts.join(', ')})`,
    )
  }
  const aggregates = reports.map(report => Object.values(report.workloads).map(outcome => outcome.aggregateDigest.slice(0, 12)).join(','))
  lines.push(`aggregate digests per run: ${aggregates.join(' | ')}`)
  const identical = aggregates.every(digest => digest === aggregates[0])
  lines.push(identical
    ? 'workload aggregates identical across runs — the frozen workload replayed exactly'
    : 'WORKLOAD AGGREGATES DIVERGED across runs — the workload is no longer deterministic')
  return lines
}

/** The environment note the recorded thresholds carry (kept beside the capture for re-recording runs). */
export const RECORDED_ENVIRONMENT_NOTE = PERF_THRESHOLD_ENVIRONMENT

/**
 * Return the package's recorded repetition statistic from an ascending list.
 * For odd lengths this intentionally averages the lower and upper selected
 * entries, preserving the existing benchmark method's historical semantics.
 * @param sorted - Values sorted in ascending order.
 * @returns The rounded package median statistic, or zero for an empty list.
 */
export function medianOf(sorted: readonly number[]): number {
  if (sorted.length === 0) return 0
  const middle = Math.floor((sorted.length - 1) / 2)
  const low = sorted[middle] ?? 0
  const high = sorted[Math.min(middle + 1, sorted.length - 1)] ?? low
  return round3((low + high) / 2)
}

function round3(value: number): number {
  if (value !== 0 && Math.abs(value) < 0.001) return Number(value.toPrecision(3))
  return Math.round(value * 1000) / 1000
}
