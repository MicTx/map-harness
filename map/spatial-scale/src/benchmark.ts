/**
 * The fixed-workload benchmark: on a fresh store it ingests exactly the
 * frozen {@link SCALE_WORKLOAD_FIXTURE}, then measures what the spec's
 * success criteria name — ingest and scan throughput, coordinating-process
 * memory growth, concurrency under the job slots, and crash recovery — and
 * checks every measurement against the recorded thresholds. A threshold
 * miss fails the run loudly: the recorded gates are measured results on a
 * fixed environment, and a regression is a regression even when the data
 * still comes out right.
 *
 * Determinism: the workload is generated from a fixed seed, so every run
 * scans identical bytes and every run's aggregates must be identical — only
 * the wall-clock and memory numbers vary within their bands.
 *
 * @module @map-harness/spatial-scale/benchmark
 */
import { join } from 'node:path'
import {
  SCALE_METHOD_VERSION,
  SCALE_RECORDED_THRESHOLDS,
  SCALE_WORKLOAD_FIXTURE,
  validateScaleWorkload,
  renderScaleIssues,
  type ScaleBudgets,
  type ScaleJobRequest,
  type ScaleThresholds,
  type ScaleWorkload,
} from './contract.ts'
import { jobChunksOf, openScaleStore, workloadFeatures, type ScaleObjectStore } from './store.ts'
import { ScaleJobRunner } from './worker.ts'

/** One measured gate outcome. */
export interface ScaleBenchmarkGate {
  readonly gate: string
  readonly measured: number
  readonly threshold: number
  /** True when the measurement satisfies the gate's direction. */
  readonly passed: boolean
  readonly unit: string
}

/** One full benchmark report: measurements, gates, and the fixed identity. */
export interface ScaleBenchmarkReport {
  readonly workload: ScaleWorkload
  readonly thresholds: ScaleThresholds
  readonly environmentNote: string
  readonly ingestRowsPerSecond: number
  readonly ingestBytes: number
  readonly scanRowsPerSecond: number
  readonly scanHeapGrowthBytes: number
  readonly concurrencyWallMs: number
  readonly serialScanWallMs: number
  readonly concurrencyWallRatio: number
  readonly recoveryResumeMs: number
  /** Every run's aggregate must be identical; this is the shared count. */
  readonly matchedCount: number
  /** The shared matched sum over every run (identical within float tolerance). */
  readonly matchedSum: number
  readonly gates: readonly ScaleBenchmarkGate[]
  readonly passed: boolean
}

/**
 * Run the full benchmark over one fresh store root.
 * @param root - a fresh store root (the benchmark ingests into it).
 * @param budgets - the budgets the jobs run under (slots ≥ workload.concurrency).
 * @param options - an explicit workload/thresholds override (defaults are
 *   the frozen fixture and its recorded thresholds).
 * @returns the report.
 * @throws when the workload is invalid or any gate fails.
 */
export async function runScaleBenchmark(
  root: string,
  budgets: ScaleBudgets,
  options: { workload?: ScaleWorkload; thresholds?: ScaleThresholds } = {},
): Promise<ScaleBenchmarkReport> {
  const workload = options.workload ?? SCALE_WORKLOAD_FIXTURE
  const thresholds = options.thresholds ?? SCALE_RECORDED_THRESHOLDS
  const workloadIssues = validateScaleWorkload(workload)
  if (workloadIssues.length > 0) {
    throw new Error(`benchmark workload rejected: ${renderScaleIssues(workloadIssues)}`)
  }
  if (budgets.jobSlots < workload.concurrency) {
    throw new Error(`benchmark needs jobSlots ≥ ${workload.concurrency} for its concurrency leg`)
  }

  const store: ScaleObjectStore = openScaleStore(root)
  const features = workloadFeatures(workload)

  // 1. Ingest leg: throughput over the deterministic bytes.
  const ingestStart = process.hrtime.bigint()
  const version = store.ingest({
    resourceId: 'bench',
    sourceRef: 'res-bench@v1',
    sourceDigest: 'b'.repeat(64),
    nativeCrs: 'EPSG:4326',
    authorization: 'local',
    chunkRows: workload.chunkRows,
    features,
  })
  const ingestMs = Number(process.hrtime.bigint() - ingestStart) / 1e6
  const ingestRowsPerSecond = Math.round(workload.rows / (ingestMs / 1000))
  const resolved = store.readVersion(version.ref, 'local')
  const chunks = jobChunksOf(store, resolved)

  // The store's own staging area already exists (openScaleStore creates it);
  // benchmark job directories stage there and are removed after each job.
  const runner = new ScaleJobRunner(join(root, 'staging'), budgets)
  try {
    const request: ScaleJobRequest = {
      methodVersion: SCALE_METHOD_VERSION,
      manifestPath: `${resolved.dir}/manifest.json`,
      chunks,
      predicate: workload.predicate,
      sampleRows: budgets.scanSampleRows,
    }

    // 2. Scan leg: full-version scan latency and coordinating-process heap growth.
    globalThis.gc?.()
    const heapBefore = process.memoryUsage().heapUsed
    const scanStart = process.hrtime.bigint()
    const scanOutcome = await runner.run(request)
    const scanMs = Number(process.hrtime.bigint() - scanStart) / 1e6
    const scanHeapGrowthBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore)
    if (scanOutcome.status !== 'succeeded') {
      throw new Error(`benchmark scan leg failed: ${JSON.stringify(scanOutcome)}`)
    }
    const scanRowsPerSecond = Math.round(workload.rows / (scanMs / 1000))

    // 3. Concurrency leg: workload.concurrency parallel scans over the slots.
    const concurrencyStart = process.hrtime.bigint()
    const parallel = await Promise.all(Array.from({ length: workload.concurrency }, () => runner.run(request)))
    const concurrencyWallMs = Number(process.hrtime.bigint() - concurrencyStart) / 1e6
    for (const outcome of parallel) {
      if (outcome.status !== 'succeeded') {
        throw new Error(`benchmark concurrency leg failed: ${JSON.stringify(outcome)}`)
      }
    }

    // 4. Recovery leg: crash after the fixture's checkpoint, then resume the
    // remaining chunks — the resumed fold must equal the whole fold.
    const recoveryStart = process.hrtime.bigint()
    const crashed = await runner.run({ ...request, fault: { kind: 'crash' as const, afterChunks: workload.recoveryAfterChunks } })
    if (crashed.status !== 'failed' || crashed.code !== 'worker-crash') {
      throw new Error('benchmark recovery leg: the injected crash did not crash')
    }
    const cursor = crashed.progress[crashed.progress.length - 1]
    if (cursor === undefined) {
      throw new Error('benchmark recovery leg: the crash left no progress cursor')
    }
    const resumed = await runner.run({ ...request, chunks: chunks.slice(cursor.chunksDone) })
    const recoveryResumeMs = Number(process.hrtime.bigint() - recoveryStart) / 1e6
    if (resumed.status !== 'succeeded') {
      throw new Error(`benchmark recovery leg failed: ${JSON.stringify(resumed)}`)
    }
    if (cursor.matches + resumed.result.aggregate.count !== scanOutcome.result.aggregate.count) {
      throw new Error('benchmark recovery leg: the resumed fold differs from the uninterrupted fold')
    }

    const matchedCount = scanOutcome.result.aggregate.count
    const matchedSum = scanOutcome.result.aggregate.sum
    const serialScanWallMs = scanMs

    const gates: ScaleBenchmarkGate[] = [
      gate('ingest throughput', ingestRowsPerSecond, thresholds.minIngestRowsPerSecond, '>=', 'rows/s'),
      gate('scan throughput', scanRowsPerSecond, thresholds.minScanRowsPerSecond, '>=', 'rows/s'),
      gate('scan heap growth', scanHeapGrowthBytes, thresholds.maxScanHeapGrowthBytes, '<=', 'bytes'),
      gate('concurrency wall ratio', round3(concurrencyWallMs / serialScanWallMs), thresholds.maxConcurrencyWallRatio, '<=', '× serial'),
      gate('recovery resume', recoveryResumeMs, thresholds.maxRecoveryResumeMs, '<=', 'ms'),
    ]
    const passed = gates.every(entry => entry.passed)
    return {
      workload,
      thresholds,
      environmentNote: 'measured on the recording host; re-record before comparing on different hardware',
      ingestRowsPerSecond,
      ingestBytes: version.manifest.totalBytes,
      scanRowsPerSecond,
      scanHeapGrowthBytes,
      concurrencyWallMs: Math.round(concurrencyWallMs),
      serialScanWallMs: Math.round(serialScanWallMs),
      concurrencyWallRatio: round3(concurrencyWallMs / serialScanWallMs),
      recoveryResumeMs: Math.round(recoveryResumeMs),
      matchedCount,
      matchedSum,
      gates,
      passed,
    }
  } finally {
    await runner.dispose()
  }
}

/** One gate outcome from a measurement, threshold, and direction. */
function gate(name: string, measured: number, threshold: number, direction: '>=' | '<=', unit: string): ScaleBenchmarkGate {
  return {
    gate: name,
    measured,
    threshold,
    passed: direction === '>=' ? measured >= threshold : measured <= threshold,
    unit,
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}
