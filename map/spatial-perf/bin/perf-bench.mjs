#!/usr/bin/env node
/**
 * The spatial-perf diagnostic benchmark command: wires the real production
 * planes (session projection rig, transactional catalog store, spatial-scale
 * worker) into the benchmark ports, runs the frozen workload under the
 * recorded thresholds, prints the segmented report plus the trend against
 * previously captured reports, and optionally writes the JSON report.
 *
 * This is the DIAGNOSTIC lane; the CI gate is the package's
 * `tests/benchmark-gate.spec.mjs` suite (run by `node map/bin/test.mjs`).
 * Both run plain Node (`--experimental-strip-types`), never tsx.
 *
 * Usage:
 *   pnpm --filter @map-harness/spatial-perf run bench [--json <out.json>]
 *       [--baseline <report.json> ...]
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { perfPortsOf } from '../tests/perf-rig.mjs'
import { PERF_DEPLOYMENT_BUDGETS, PERF_RECORDED_THRESHOLDS, PERF_WORKLOAD_FIXTURE, renderPerfIssues, validatePerfBudgets } from '../src/contract.ts'
import { compareWithBaseline, renderTrendReport } from '../src/report.ts'
import { runPerfBenchmark } from '../src/run-benchmark.ts'

/** Parse `--json <path>` / `--baseline <path>` (repeatable) from argv. */
function parseArgs(argv) {
  const options = { json: null, baselines: [] }
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--json') {
      options.json = argv[index + 1] ?? null
      index += 1
    } else if (argv[index] === '--baseline') {
      const path = argv[index + 1]
      if (path === undefined) throw new Error('--baseline requires a report path')
      options.baselines.push(path)
      index += 1
    } else {
      throw new Error(`unknown argument "${argv[index]}"; supported: --json <path>, --baseline <path>`)
    }
  }
  return options
}

function readBaseline(path) {
  if (!existsSync(path)) throw new Error(`baseline not found: ${path}`)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`baseline is not valid JSON: ${path}`)
  }
  if (parsed === null || typeof parsed !== 'object'
    || parsed.environment === null || typeof parsed.environment !== 'object'
    || !Array.isArray(parsed.gates)
    || parsed.methodVersion === undefined
    || parsed.workloads === null || typeof parsed.workloads !== 'object') {
    throw new Error(`baseline has invalid report structure: ${path}`)
  }
  return parsed
}

const options = parseArgs(process.argv.slice(2))
let baselineReports
try {
  baselineReports = options.baselines.map(readBaseline)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`baseline error: ${message}\n`)
  process.exit(2)
}
const scratch = mkdtempSync(join(tmpdir(), 'perf-bench-diagnostic-'))
const wired = await perfPortsOf(scratch)
try {
  const budgets = { ...PERF_DEPLOYMENT_BUDGETS }
  const budgetIssues = validatePerfBudgets(budgets)
  if (budgetIssues.length > 0) throw new Error(`deployment budgets invalid: ${renderPerfIssues(budgetIssues)}`)
  const report = await runPerfBenchmark(wired.ports, {
    workload: PERF_WORKLOAD_FIXTURE,
    thresholds: PERF_RECORDED_THRESHOLDS,
    budgets,
  })

  process.stdout.write(`spatial-perf benchmark — ${report.methodVersion}\n`)
  process.stdout.write(`environment: ${report.environment.platform} ${report.environment.arch}, node ${report.environment.nodeVersion}, ${report.environment.cpuCount} cpus, git ${report.environment.gitRef ?? 'n/a'}\n`)
  process.stdout.write(`arcgis: ${report.environment.arcgisApiVersion}\nmodel: ${report.environment.modelId}\n`)
  for (const workload of Object.values(report.workloads)) {
    process.stdout.write(`\n${workload.workload} (${workload.unit}): median ${workload.median}, values [${workload.values.join(', ')}], spread ${workload.spreadRatio}×\n`)
    for (const segment of workload.sampler.segments) {
      process.stdout.write(`  ${segment.segment}/${segment.outcome}: n=${segment.count} total=${segment.totalMs}ms max=${segment.maxMs}ms p50=${segment.p50Ms}ms p95=${segment.p95Ms}ms\n`)
    }
    process.stdout.write(`  aggregate ${JSON.stringify(workload.aggregate)}\n  digest ${workload.aggregateDigest.slice(0, 16)}…\n`)
  }
  process.stdout.write('\ncalibration:\n')
  for (const [section, reading] of Object.entries(report.calibration.sections)) {
    process.stdout.write(`  ${section}: ${reading.units} units/${reading.batches} batches, median ${reading.medianUnitsPerSecond} units/s, spread ${reading.readingSpreadRatio}×, digest ${reading.workDigest.slice(0, 16)}…\n`)
  }
  process.stdout.write(`\ncancel→quiescence ${report.cancelQuiescenceMs}ms, flush barrier ${report.flushWaitMs}ms, display derive ${report.renderDeriveMs}ms, heap growth ${(report.heapGrowthBytes / 1048576).toFixed(1)}MiB\n`)
  process.stdout.write(`cumulative spend: ${JSON.stringify(report.spend)}\n`)
  if (report.telemetryDegraded) process.stdout.write('telemetry DEGRADED: samples were dropped past the capacity\n')

  process.stdout.write('\ngates:\n')
  for (const gate of report.gates) {
    const detail = gate.kind === 'calibrated-ratio'
      ? ` (numerator ${gate.numerator}, denominator ${gate.denominator}, advisory ${gate.absoluteAdvisory})`
      : ''
    process.stdout.write(`  ${gate.passed ? 'pass' : 'FAIL'}  ${gate.gate}: ${gate.measured} ${gate.direction} ${gate.threshold} ${gate.unit}${detail}\n`)
  }
  process.stdout.write('\nadvisory throughput (reference only):\n')
  for (const reading of report.advisory) {
    process.stdout.write(`  ${reading.gate}: ${reading.measured} ${reading.unit} (${reading.position}; historical ${reading.reference.low}–${reading.reference.high}, retired floor ${reading.reference.retiredFloor})\n`)
  }

  const baselines = baselineReports
  if (baselines.length > 0) {
    const baseline = baselines.at(-1)
    const comparison = compareWithBaseline(report, baseline)
    process.stdout.write('\ntrend (baseline → current):\n')
    if (comparison.comparable) {
      for (const line of renderTrendReport([baseline, report])) process.stdout.write(`  ${line}\n`)
      for (const line of comparison.lines) process.stdout.write(`  ${line}\n`)
      for (const regression of comparison.regressions) process.stdout.write(`  regression: ${regression}\n`)
      if (comparison.regressions.length === 0) process.stdout.write('  no regressions\n')
    } else {
      for (const line of comparison.lines) process.stdout.write(`  ${line}\n`)
    }
  }

  process.stdout.write(`\nverdict: ${report.passed ? 'PASS' : 'FAIL'}\n`)

  if (options.json !== null) {
    writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`)
    process.stdout.write(`\nreport written to ${options.json}\n`)
  }
  process.exitCode = report.passed ? 0 : 1
} finally {
  await wired.dispose()
  rmSync(scratch, { recursive: true, force: true })
}
