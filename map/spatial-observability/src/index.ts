/**
 * `@map-harness/spatial-observability` — the spatial observability and
 * operations library. Pure library, no host row: its consumers are the
 * map-owned surfaces that adopt the correlation scope (tools, providers, the
 * catalog, run services, the render plane), the package's own gate lane
 * (`node map/bin/test.mjs`), and the runbook's diagnostic export workflow.
 *
 * @module @map-harness/spatial-observability
 */
export * from './contract.ts'
export * from './sanitize.ts'
export * from './log.ts'
export * from './metrics.ts'
export * from './health.ts'
export * from './faults.ts'
export * from './export.ts'
export * from './runtime.ts'
