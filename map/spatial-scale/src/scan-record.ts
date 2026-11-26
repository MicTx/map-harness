/**
 * The scan-record plane: one scale scan leaves a record that a restarted
 * session or a recomputation can rebuild from the parts the session log
 * already cites — the exact resource version, the request, the worker's
 * cursor trace, the published artifact, and the bounded display summary.
 * The record's digest pins exactly those parts, so a rebuild that sees
 * different parts refuses instead of silently claiming the same history.
 *
 * The model-facing summary is bounded by construction: counts, aggregates,
 * and cursors only — never row payloads beyond the display sample cap — so
 * a large channel cannot leak unbounded geometry into model JSON.
 *
 * @module @map-harness/spatial-scale/scan-record
 */
import {
  SCALE_METHOD_VERSION,
  manifestDigestOf,
  scaleDigestOf,
  scaleRefOf,
  type ScaleResourceManifest,
} from './contract.ts'

/** The maximum serialized bytes of one bounded model summary. */
export const MAX_SCALE_SUMMARY_BYTES = 8 * 1024

/** The maximum features one display copy derived from a scan carries. */
export const MAX_SCALE_DISPLAY_FEATURES = 512

/** The resource block: the exact version a scan cites. */
export interface ScaleScanRecordSource {
  readonly ref: string
  readonly contentDigest: string
  readonly manifestDigest: string
  readonly sourceRef: string
  readonly nativeCrs: string
  readonly chunks: number
  readonly totalBytes: number
  readonly authorization: string
}

/** The request block: the resolved read the run executed. */
export interface ScaleScanRecordRequest {
  readonly kind: 'query'
  readonly field: string
  readonly op: string
  readonly value: number
  readonly sampleRows: number
  readonly budgetsDigest: string
}

/** The job block: the worker's cursor trace (prefix cursor + resumed folds). */
export interface ScaleScanRecordJob {
  readonly status: 'succeeded' | 'cancelled'
  readonly chunksDone: number
  readonly rowsScanned: number
  readonly bytesScanned: number
  /** Progress-cursor checkpoints the run accumulated (crash/resume traces). */
  readonly checkpoints: readonly { readonly chunksDone: number; readonly rowsScanned: number }[]
}

/** The display block: the bounded copy a map layer would carry. */
export interface ScaleScanRecordDisplay {
  readonly featureCount: number
  /** Whether the matched set exceeded the display cap (the copy is then a sample, stated as one). */
  readonly truncated: boolean
  readonly digest: string
}

/** The full scan record one scan publishes beside its artifact. */
export interface ScaleScanRecord {
  readonly methodVersion: typeof SCALE_METHOD_VERSION
  readonly resource: ScaleScanRecordSource
  readonly request: ScaleScanRecordRequest
  readonly job: ScaleScanRecordJob
  readonly artifactRef: string
  readonly artifactDigest: string
  readonly display: ScaleScanRecordDisplay
}

/** The minimal parts a rebuild consumes (exactly what the session log cites). */
export interface ScaleScanRecordInputs {
  readonly manifest: ScaleResourceManifest
  readonly request: ScaleScanRecordRequest
  readonly job: ScaleScanRecordJob
  readonly artifactRef: string
  readonly artifactDigest: string
  readonly displayFeatureCount: number
  readonly displayTruncated: boolean
}

/**
 * Assemble one scan record from its parts and pin it with a digest.
 * @param inputs - the cited parts.
 * @returns the record plus its pinned digest.
 */
export function buildScanRecord(inputs: ScaleScanRecordInputs): { record: ScaleScanRecord; digest: string } {
  const resource: ScaleScanRecordSource = {
    ref: scaleRefOf(inputs.manifest.resourceId, inputs.manifest.contentDigest),
    contentDigest: inputs.manifest.contentDigest,
    manifestDigest: manifestDigestOf(inputs.manifest),
    sourceRef: inputs.manifest.sourceRef,
    nativeCrs: inputs.manifest.nativeCrs,
    chunks: inputs.manifest.chunks.length,
    totalBytes: inputs.manifest.totalBytes,
    authorization: inputs.manifest.authorization,
  }
  // The display digest pins the bounded copy's identity: the same scan
  // reproduces the same display, a different cursor or cap is a different one.
  const display: ScaleScanRecordDisplay = {
    featureCount: inputs.displayFeatureCount,
    truncated: inputs.displayTruncated,
    digest: scaleDigestOf({
      chunksDone: inputs.job.chunksDone,
      rowsScanned: inputs.job.rowsScanned,
      displayFeatureCount: inputs.displayFeatureCount,
    }),
  }
  const record: ScaleScanRecord = {
    methodVersion: SCALE_METHOD_VERSION,
    resource,
    request: inputs.request,
    job: inputs.job,
    artifactRef: inputs.artifactRef,
    artifactDigest: inputs.artifactDigest,
    display,
  }
  return { record, digest: scaleDigestOf(record) }
}

/**
 * Rebuild one scan record from re-read parts — the restart/recompute
 * path. The rebuilt record must digest identically to the pinned one; any
 * drifted part (a different manifest, a changed artifact, an edited
 * request) refuses with the mismatch instead of claiming the same history.
 * @param inputs - the re-read parts.
 * @param pinnedDigest - the digest the original record pinned.
 * @returns the rebuilt record and its digest.
 * @throws when the rebuilt digest differs from the pinned digest.
 */
export function rebuildScanRecord(inputs: ScaleScanRecordInputs, pinnedDigest: string): { record: ScaleScanRecord; digest: string } {
  const rebuilt = buildScanRecord(inputs)
  if (rebuilt.digest !== pinnedDigest) {
    throw new Error(`RECORD_MISMATCH: the rebuilt record digests ${rebuilt.digest.slice(0, 12)}, not the pinned ${pinnedDigest.slice(0, 12)}`)
  }
  return rebuilt
}

/**
 * Build the bounded model summary of one scan. Every field is a count,
 * aggregate, or cursor — the row payloads stay inside the artifact and the
 * display sample, never in the model channel. The serialized size is
 * capped; a violation is a programming error, not an operating point.
 * @param record - the scan record the summary summarizes.
 * @param aggregate - the scan's aggregate.
 * @param limitations - the honest limitation lines the tool appends.
 * @returns the bounded summary as plain JSON.
 * @throws when the summary exceeds the byte bound.
 */
export function boundedSummaryOf(
  record: ScaleScanRecord,
  aggregate: { count: number; sum: number; min: number; max: number },
  limitations: readonly string[],
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    method_version: record.methodVersion,
    resource: {
      ref: record.resource.ref,
      chunks: record.resource.chunks,
      total_bytes: record.resource.totalBytes,
      native_crs: record.resource.nativeCrs,
    },
    request: {
      kind: record.request.kind,
      field: record.request.field,
      op: record.request.op,
      value: record.request.value,
    },
    job: {
      status: record.job.status,
      chunks_done: record.job.chunksDone,
      rows_scanned: record.job.rowsScanned,
      bytes_scanned: record.job.bytesScanned,
      checkpoints: record.job.checkpoints.length,
    },
    aggregate,
    artifact: { ref: record.artifactRef, digest: record.artifactDigest.slice(0, 12) },
    display: {
      feature_count: record.display.featureCount,
      truncated: record.display.truncated,
    },
    limitations: [...limitations],
  }
  const serialized = JSON.stringify(summary)
  if (serialized.length > MAX_SCALE_SUMMARY_BYTES) {
    throw new Error(`RESOURCE_TOO_LARGE: the scan summary exceeds ${MAX_SCALE_SUMMARY_BYTES} bytes`)
  }
  return summary
}
