/**
 * `@map-harness/spatial-perf` — the spatial performance capacity and
 * benchmark gate library. Pure library, no host row: its consumers are the
 * package's own gate lane (`node map/bin/test.mjs`), the diagnostic command
 * (`pnpm --filter @map-harness/spatial-perf run bench`), and the threshold
 * re-recording workflow.
 *
 * @module @map-harness/spatial-perf
 */
export * from './contract.ts'
export * from './fixtures.ts'
export * from './instrument.ts'
export * from './budgets.ts'
export * from './workloads.ts'
export * from './report.ts'
export * from './calibration.ts'
export * from './run-benchmark.ts'
