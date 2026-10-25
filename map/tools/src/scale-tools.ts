/**
 * The distributed-scale data channel tools: `scale_ingest` copies one
 * registered, authorized resource version into the immutable chunked scale
 * store (the GeoParquet-style object provider); `scale_read` runs one
 * bounded range/tile/query read and returns counts, aggregates, cursors,
 * and a capped sample — never raw bulk geometry; `scale_scan` runs the
 * predicate scan in a real worker process (bounded slots, cancel-to-
 * quiescence, digest-verified chunks) and publishes the fixed conclusion as
 * a catalog artifact citing the source resource, with the scan record
 * rebuilt from the parts the session log cites.
 *
 * Every byte moves under the deployment's authorization domain, every read
 * and job runs under the recorded budgets, and every model-visible summary
 * is bounded by construction: the large channel never leaks unbounded rows
 * into model JSON.
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  SCALE_BUDGETS,
  SCALE_METHOD_VERSION,
  SCALE_OPS,
  ScaleJobRunner,
  ScaleStoreError,
  type ScaleIngestResult,
  type ScaleJobOutcome,
  type ScaleJobRequest,
  type ScaleOp,
  type ScaleReadRequest,
  type ScaleReadResult,
  boundedSummaryOf,
  buildScanRecord,
  jobChunksOf,
  openScaleStore,
  renderScaleIssues,
  validateScaleRead,
} from '@map-harness/spatial-scale'
import {
  MAX_REGISTER_BYTES,
  admitCollection,
  type SessionSpatialCatalog,
} from '@map-harness/spatial-catalog'
import { buildSpatialScaleMeta } from './scale-meta.ts'
import { catalogServiceOf, requirePendingPublish, sessionOf } from './catalog-tools.ts'
import { SpatialError } from './spatial-errors.ts'
import { renderJson } from './output.ts'

/** The model-facing sample cap: at most this many rows ride one read result. */
export const MAX_SCALE_CONTENT_SAMPLE = 32

/** The ingest/read/scan tool names this file defines. */
export const SCALE_TOOL_NAMES = ['scale_ingest', 'scale_read', 'scale_scan'] as const

/** The scale store area under the catalog's store root. */
const SCALE_STORE_DIR = 'scale'

/** Reach the catalog service (host-plane service). */
function scaleCatalogOf(exec: ToolRunContext): SessionSpatialCatalog {
  return catalogServiceOf(exec)
}

/** Open the scale store over the deployment's store root. */
function scaleStoreOf(exec: ToolRunContext) {
  const catalog = scaleCatalogOf(exec)
  return openScaleStore(`${catalog.storeRoot()}/${SCALE_STORE_DIR}`)
}

/** The authorization domain every scale byte moves under (deployment-owned). */
function domainOf(exec: ToolRunContext): string {
  return scaleCatalogOf(exec).deploymentDomain()
}

/** Render helper shared by the scale tools: model text omits the durable meta. */
function renderScaleJson(value: JsonValue): ReturnType<typeof renderJson> {
  const { meta: _meta, ...rest } = value as Record<string, unknown>
  return renderJson(rest)
}

/** Presentation-meta projector for the scale family. */
function scalePresentationMeta(value: JsonValue): JsonValue | null {
  return (value as { meta?: JsonValue }).meta ?? null
}

/** Resolve one required nonempty string argument. */
function requireString(args: Record<string, unknown>, name: string, reason: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', `${name} is required: ${reason}`)
  }
  return value
}

/** Name every store refusal through the stable spatial error vocabulary. */
function mapStoreError<T>(run: () => T): T {
  try {
    return run()
  } catch (error: unknown) {
    if (error instanceof ScaleStoreError) {
      const code = error.code === 'SCALE_FORBIDDEN' ? 'WRITE_PERMISSION_DENIED'
        : error.code === 'SCALE_TOO_LARGE' ? 'RESOURCE_TOO_LARGE'
        : error.code === 'SCALE_IO' ? 'SPATIAL_SERVICE_UNAVAILABLE'
        : 'INVALID_ARGUMENT'
      throw new SpatialError(code, error.message)
    }
    throw error
  }
}

/** Map a worker outcome failure onto the stable spatial error vocabulary. */
function jobFailureOf(code: string, reason: string): never {
  const mapped = code === 'timeout' ? 'BUDGET_EXHAUSTED'
    : code === 'digest-mismatch' ? 'INVALID_GEOJSON'
    : code === 'spawn' ? 'SPATIAL_SERVICE_UNAVAILABLE'
    : 'INVALID_ARGUMENT'
  throw new SpatialError(mapped, `the scale scan failed (${code}): ${reason}`)
}

/** A cancelled scan settles only after the worker reached quiescence. */
function jobCancelled(): never {
  throw new SpatialError('CALL_CANCELED', 'the scale scan was cancelled and stopped at a chunk boundary; the worker reached quiescence before this call settled')
}

/**
 * `scale_ingest`: copy one registered resource version into the immutable
 * chunked scale store. The copy is content-addressed and idempotent —
 * re-ingesting identical bytes returns the existing version; changed bytes
 * are a new, equally readable version.
 */
export const scaleIngest = defineTool({
  name: 'scale_ingest',
  description:
    'Copy one registered resource version (res-…@vN from catalog_register) into the distributed-scale chunk '
    + 'store as an immutable, content-addressed version (scl-…@digest). The version is chunked into bounded row '
    + 'groups with per-chunk digests and bbox indexes, carries schema/CRS/time/authorization metadata, and is the '
    + 'only thing scale_read and scale_scan consume. Ingesting identical bytes again returns the existing version.',
  parameters: {
    source_ref: { type: 'string', required: true, description: 'Registered resource ref to copy, `res-…@vN`.' },
    resource_id: { type: 'string', required: true, description: 'Stable scale resource id, `[a-z0-9][a-z0-9-]{0,63}`.' },
    chunk_rows: { type: 'number', description: 'Rows per chunk; 2048 is the recorded budget.' },
    time_field: { type: 'string', description: 'Property holding each feature\'s ISO event time; its observed range is recorded.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderScaleJson(value),
    presentationMeta: (_args, value) => scalePresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const raw = args as Record<string, unknown>
    const sourceRef = requireString(raw, 'source_ref', 'name the registered resource to copy')
    const resourceId = requireString(raw, 'resource_id', 'the scale version needs a stable id')
    const chunkRows = typeof raw.chunk_rows === 'number' ? raw.chunk_rows : SCALE_BUDGETS.chunkRows
    const timeField = typeof raw.time_field === 'string' && raw.time_field.length > 0 ? raw.time_field : undefined

    const catalog = scaleCatalogOf(exec)
    const domain = catalog.deploymentDomain()
    const { resource, bytes } = await catalog.readResourceBytes(sourceRef, domain, MAX_REGISTER_BYTES)
    exec.signal.throwIfAborted()
    const admitted = admitCollection(bytes, { enforceWgs84Range: true })
    const store = scaleStoreOf(exec)
    const result: ScaleIngestResult = mapStoreError(() => store.ingest({
      resourceId,
      sourceRef,
      sourceDigest: resource.contentDigest,
      nativeCrs: resource.nativeCrs,
      authorization: domain,
      chunkRows,
      ...(timeField === undefined ? {} : { timeField }),
      features: admitted.collection.features,
    }))
    const limitations = [
      'the scale version is an immutable copy; re-ingesting changed source bytes publishes a new version',
    ]
    const meta = buildSpatialScaleMeta({
      tool: 'scale_ingest',
      methodVersion: SCALE_METHOD_VERSION,
      scaleRef: result.ref,
      sourceRef,
      manifestDigest: result.manifestDigest,
      artifactRef: null,
      recordDigest: null,
      authorization: domain,
      limitations,
    })
    return {
      scale_ref: result.ref,
      source: { ref: sourceRef, content_digest: resource.contentDigest },
      deduplicated: result.deduplicated,
      chunks: result.manifest.chunks.length,
      rows: result.manifest.schema.featureCount,
      total_bytes: result.manifest.totalBytes,
      schema: {
        fields: result.manifest.schema.fields.map(field => ({ name: field.name, type: field.type })),
        geometry_types: [...result.manifest.schema.geometryTypes],
      },
      native_crs: result.manifest.nativeCrs,
      time_range: result.manifest.timeRange,
      budgets: { chunk_rows: chunkRows },
      limitations,
      meta,
    }
  },
})

/**
 * `scale_read`: one bounded read against one exact scale version. `range`
 * verifies a consecutive chunk window and returns a resume cursor; `tile`
 * prunes whole chunks by bbox; `query` folds a predicate with a bounded
 * sample. The result names its counts and caps; bulk rows stay in the store.
 */
export const scaleRead = defineTool({
  name: 'scale_read',
  description:
    'Run one bounded read against a scale version (scl-…@digest). kind=range reads a consecutive chunk window '
    + '(from_chunk + chunks, capped by the row/byte budgets) and returns a resume cursor; kind=tile reads one '
    + 'extent-grid cell (z/x/y), pruning whole chunks by their bbox; kind=query folds a predicate (field, op, value) '
    + 'across the version. Returns counts, aggregates, cursors, and a capped sample — never the bulk rows.',
  parameters: {
    resource_ref: { type: 'string', required: true, description: 'Scale version ref, `scl-…@<digest12>`.' },
    kind: { type: 'string', required: true, description: 'Read kind: "range", "tile", or "query".' },
    from_chunk: { type: 'number', description: 'range: first chunk index (0-based).' },
    chunks: { type: 'number', description: 'range: chunk count to read.' },
    z: { type: 'number', description: 'tile: grid zoom (2^z cells over the version extent).' },
    x: { type: 'number', description: 'tile: grid column.' },
    y: { type: 'number', description: 'tile: grid row from south.' },
    field: { type: 'string', description: 'query: numeric property to compare.' },
    op: { type: 'string', description: 'query: one of > >= < <= == !=.' },
    value: { type: 'number', description: 'query: comparison value.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderScaleJson(value),
    presentationMeta: (_args, value) => scalePresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const raw = args as Record<string, unknown>
    const ref = requireString(raw, 'resource_ref', 'name the scale version to read')
    const kind = requireString(raw, 'kind', 'choose range, tile, or query')
    const read: ScaleReadRequest = kind === 'range'
      ? {
          kind: 'range',
          fromChunk: typeof raw.from_chunk === 'number' ? raw.from_chunk : 0,
          chunks: typeof raw.chunks === 'number' ? raw.chunks : 1,
        }
      : kind === 'tile'
        ? {
            kind: 'tile',
            z: typeof raw.z === 'number' ? raw.z : Number.NaN,
            x: typeof raw.x === 'number' ? raw.x : Number.NaN,
            y: typeof raw.y === 'number' ? raw.y : Number.NaN,
          }
        : {
            kind: 'query',
            field: typeof raw.field === 'string' ? raw.field : '',
            op: typeof raw.op === 'string' && (SCALE_OPS as readonly string[]).includes(raw.op) ? (raw.op as ScaleOp) : ('' as ScaleOp),
            value: typeof raw.value === 'number' ? raw.value : Number.NaN,
          }
    const issues = validateScaleRead(read)
    if (issues.length > 0) {
      throw new SpatialError('INVALID_ARGUMENT', `read rejected: ${renderScaleIssues(issues)}`)
    }
    const domain = domainOf(exec)
    const store = scaleStoreOf(exec)
    const result: ScaleReadResult = mapStoreError(() => store.read(ref, read, domain, SCALE_BUDGETS))
    const limitations = [
      'the sample is capped; bulk rows stay in the store and flow only through bounded reads and artifacts',
    ]
    const meta = buildSpatialScaleMeta({
      tool: 'scale_read',
      methodVersion: SCALE_METHOD_VERSION,
      scaleRef: ref,
      sourceRef: null,
      manifestDigest: null,
      artifactRef: null,
      recordDigest: null,
      authorization: domain,
      limitations,
    })
    const base = {
      scale_ref: ref,
      kind: result.kind,
      rows_scanned: result.rowsScanned,
      sample: result.sample.slice(0, MAX_SCALE_CONTENT_SAMPLE).map(row => ({ index: row.index, lon: row.lon, lat: row.lat, value: row.value })),
      limitations,
      meta,
    }
    if (result.kind === 'range') {
      return {
        ...base,
        chunks: result.chunks.map(chunk => ({ index: chunk.index, rows: chunk.rows, bytes: chunk.bytes, digest: chunk.digest.slice(0, 12) })),
        bytes_scanned: result.bytesScanned,
        cursor: { next_chunk: result.nextChunk, exhausted: result.exhausted },
      }
    }
    if (result.kind === 'tile') {
      return {
        ...base,
        tile: { z: result.z, x: result.x, y: result.y, bbox: [...result.bbox] },
        chunks_read: result.chunksRead,
        chunks_pruned: result.chunksPruned,
        matches: result.matches,
        sample_truncated: result.truncated,
      }
    }
    return {
      ...base,
      query: { field: result.field, op: result.op, value: result.value },
      chunks_read: result.chunksRead,
      matches: result.matches,
      aggregate: { count: result.aggregate.count, sum: result.aggregate.sum, min: result.aggregate.min, max: result.aggregate.max },
      sample_truncated: result.truncated,
    }
  },
})

/**
 * `scale_scan`: run the predicate scan in a real worker process and publish
 * the fixed conclusion as a catalog artifact. The worker verifies every
 * chunk digest, stops at chunk boundaries on cancellation (the runner
 * settles only after the process exits), and reports per-chunk progress
 * cursors; the publication cites the source resource and inherits its
 * authorization. Retry returns the already-published artifact, never a
 * recompute.
 */
export const scaleScan = defineTool({
  name: 'scale_scan',
  description:
    'Scan a scale version (scl-…@digest) with a predicate (field, op, value) in a dedicated worker process: '
    + 'every chunk is digest-verified before scanning, progress checkpoints accumulate, and a cancelled call stops '
    + 'the worker at a chunk boundary before settling. On success the fixed conclusion (aggregate + capped sample '
    + 'as GeoJSON) is published as an immutable catalog artifact citing the source resource. retry_of returns an '
    + 'already-published scan and never recomputes.',
  parameters: {
    resource_ref: { type: 'string', required: true, description: 'Scale version ref, `scl-…@<digest12>`.' },
    field: { type: 'string', required: true, description: 'Numeric property to compare.' },
    op: { type: 'string', required: true, description: 'One of > >= < <= == !=.' },
    value: { type: 'number', required: true, description: 'Comparison value.' },
    retry_of: { type: 'number', description: 'Seq of this session\'s original scale_scan `tool/call`: returns the already-published artifact and never recomputes.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderScaleJson(value),
    presentationMeta: (_args, value) => scalePresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const raw = args as Record<string, unknown>
    const ref = requireString(raw, 'resource_ref', 'name the scale version to scan')
    const retryOf = typeof raw.retry_of === 'number' ? raw.retry_of : undefined
    const session = sessionOf(exec) as unknown as Session
    const catalog = scaleCatalogOf(exec)
    const domain = domainOf(exec)
    const pending = requirePendingPublish(exec, catalog, session, 'scale_scan')

    if (retryOf !== undefined) {
      // retryOf returns the original publication as-is; a missing record is a
      // loud refusal, not a recompute.
      const publishedLookup = await catalog.lookupPublication('artifact', retryOf)
      if (publishedLookup === undefined) {
        throw new SpatialError('OPERATION_NOT_PUBLISHED', `call seq ${retryOf} has no published scan in this session`)
      }
      const { artifact } = await catalog.readArtifactBytes(publishedLookup.resultRef, domain)
      const meta = buildSpatialScaleMeta({
        tool: 'scale_scan',
        methodVersion: SCALE_METHOD_VERSION,
        scaleRef: ref,
        sourceRef: null,
        manifestDigest: null,
        artifactRef: artifact.ref,
        recordDigest: null,
        authorization: domain,
        limitations: ['returned from the original publication; the scan did not run again'],
      })
      return {
        status: 'succeeded',
        artifact_ref: artifact.ref,
        retry_of: retryOf,
        deduplicated: true,
        limitations: ['returned from the original publication; the scan did not run again'],
        meta,
      }
    }

    const field = requireString(raw, 'field', 'the scan needs a numeric property')
    const op = requireString(raw, 'op', 'the scan needs a comparison operator')
    if (typeof raw.value !== 'number' || !Number.isFinite(raw.value)) {
      throw new SpatialError('INVALID_ARGUMENT', 'value must be a finite number')
    }
    if (!(SCALE_OPS as readonly string[]).includes(op)) {
      throw new SpatialError('INVALID_ARGUMENT', `op must be one of ${SCALE_OPS.join(', ')}`)
    }
    const read: ScaleReadRequest = { kind: 'query', field, op: op as ScaleOp, value: raw.value }
    const issues = validateScaleRead(read)
    if (issues.length > 0) {
      throw new SpatialError('INVALID_ARGUMENT', `scan rejected: ${renderScaleIssues(issues)}`)
    }

    const store = scaleStoreOf(exec)
    const version = mapStoreError(() => store.readVersion(ref, domain))
    const request: ScaleJobRequest = {
      methodVersion: SCALE_METHOD_VERSION,
      manifestPath: `${version.dir}/manifest.json`,
      chunks: jobChunksOf(store, version),
      predicate: { field, op: op as ScaleOp, value: raw.value },
      sampleRows: SCALE_BUDGETS.scanSampleRows,
    }
    exec.signal.throwIfAborted()
    const runner = new ScaleJobRunner(`${catalog.storeRoot()}/${SCALE_STORE_DIR}/staging`, SCALE_BUDGETS)
    let outcome: ScaleJobOutcome
    try {
      outcome = await runner.run(request, { signal: exec.signal })
    } finally {
      // Disposal waits for real worker quiescence before the tool returns.
      await runner.dispose()
    }
    if (outcome.status === 'cancelled') jobCancelled()
    if (outcome.status === 'failed') jobFailureOf(outcome.code, outcome.reason)
    const scan = outcome.result

    // The durable artifact is the scan's fixed conclusion: the capped sample
    // as GeoJSON (null geometry where rows carry none) with the aggregate and
    // method identity recorded beside it.
    const features = scan.sample.map(row => ({
      type: 'Feature' as const,
      geometry: row.lon === null || row.lat === null ? null : { type: 'Point' as const, coordinates: [row.lon, row.lat] },
      properties: {
        feature_index: row.index,
        value: row.value,
        scan: `${field} ${op} ${String(raw.value)}`,
      },
    }))
    const artifactBytes = new TextEncoder().encode(JSON.stringify({
      type: 'FeatureCollection',
      features,
      scan: {
        methodVersion: SCALE_METHOD_VERSION,
        scaleRef: ref,
        rowsScanned: scan.rowsScanned,
        matches: scan.aggregate.count,
        truncated: scan.truncated,
      },
    }))
    exec.signal.throwIfAborted()
    const published = await catalog.publishArtifact({
      bytes: artifactBytes,
      inputRefs: [version.manifest.sourceRef],
      method: {
        algorithm: 'scale-scan',
        units: 'dimensionless',
        parameters: {
          methodVersion: SCALE_METHOD_VERSION,
          scaleRef: ref,
          manifestDigest: version.manifestDigest,
          field,
          op,
          value: String(raw.value),
          chunksDone: String(scan.chunksDone),
          rowsScanned: String(scan.rowsScanned),
        },
      },
      analysisCrs: version.manifest.nativeCrs,
      sessionId: session.id,
      sourceCallSeq: pending.callSeq,
      inputAuthorizations: [domain],
    })

    const { record: scanRecord, digest: scanRecordDigest } = buildScanRecord({
      manifest: version.manifest,
      request: {
        kind: 'query',
        field,
        op,
        value: raw.value,
        sampleRows: SCALE_BUDGETS.scanSampleRows,
        budgetsDigest: `${SCALE_BUDGETS.maxRowsPerRead}/${SCALE_BUDGETS.maxBytesPerRead}/${SCALE_BUDGETS.scanSampleRows}`,
      },
      job: {
        status: 'succeeded',
        chunksDone: scan.chunksDone,
        rowsScanned: scan.rowsScanned,
        bytesScanned: scan.bytesScanned,
        checkpoints: outcome.progress.map(progress => ({ chunksDone: progress.chunksDone, rowsScanned: progress.rowsScanned })),
      },
      artifactRef: published.artifact.ref,
      artifactDigest: published.artifact.contentDigest,
      displayFeatureCount: Math.min(scan.sample.length, 512),
      displayTruncated: scan.truncated,
    })
    const summary = boundedSummaryOf(scanRecord, scan.aggregate, [
      'the artifact holds the capped sample and the aggregate; the model channel never carries the bulk rows',
      'cancel stops the worker at a chunk boundary and settles only after the process exits',
    ])
    const meta = buildSpatialScaleMeta({
      tool: 'scale_scan',
      methodVersion: SCALE_METHOD_VERSION,
      scaleRef: ref,
      sourceRef: version.manifest.sourceRef,
      manifestDigest: version.manifestDigest,
      artifactRef: published.artifact.ref,
      recordDigest: scanRecordDigest,
      authorization: domain,
      limitations: [
        'the artifact holds the capped sample and the aggregate; the model channel never carries the bulk rows',
      ],
    })
    const content: Record<string, unknown> = {
      ...summary,
      record_digest: scanRecordDigest,
      deduplicated: published.deduplicated,
      meta,
    }
    return content as Record<string, unknown> & JsonValue
  },
})
