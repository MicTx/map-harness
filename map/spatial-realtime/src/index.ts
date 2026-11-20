/**
 * `@map-harness/spatial-realtime` — the realtime spatial stream library: the
 * versioned `spatial-realtime@1` binding (event time / ingest time /
 * process time kept apart, event-id dedup, watermark and tumbling windows,
 * bounded late-event revisions), the deterministic pull-based runtime over a
 * controlled scenario source (bounded intake backpressure, per-advance
 * quota, disconnect/reconnect, bounded retention), and the checkpoint plane
 * (bounded encode/resume, digest-pinned materialized exports that never
 * rewrite a published report).
 * A pure library the stream tools consume — no host row.
 * @module @map-harness/spatial-realtime
 */
export * from './contract.ts'
export * from './runtime.ts'
export * from './checkpoint.ts'
