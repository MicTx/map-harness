/**
 * `@map-harness/spatial-scale` — the distributed-scale spatial data channel:
 * the versioned `spatial-scale@1` contract (immutable chunked resource
 * versions, bounded range/tile/query reads, deployment budgets, the frozen
 * benchmark workload with its recorded thresholds), the immutable chunked
 * object provider, the worker-process plane with backpressure,
 * cancel-to-quiescence, staged publication, and crash recovery, the
 * scan record rebuilt from session-cited parts, and the fixed-workload
 * benchmark. A pure library the scale tools consume — no host row.
 * @module @map-harness/spatial-scale
 */
export * from './contract.ts'
export * from './store.ts'
export * from './worker.ts'
export * from './scan-record.ts'
export * from './benchmark.ts'
