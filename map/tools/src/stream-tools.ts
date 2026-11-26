/**
 * The stream workbench tools: `stream_open` binds one exact, authorized
 * scenario resource version into a pull-based realtime workbench and folds
 * its realtime layer; `stream_advance` drives the controlled source forward
 * (bounded steps, bounded per-advance work) and folds the updated window
 * projection; `stream_pause`/`stream_resume` gate the source; and
 * `stream_materialize` fixes the settled window set as an immutable,
 * digest-pinned catalog artifact that cites the scenario version it was
 * computed from.
 *
 * Every call is one model wake: the runtime exposes no per-event channel, so
 * the model sees one bounded summary per advance no matter how many wire
 * events moved. The workbench state is the folded layer record itself — the
 * bounded checkpoint rides the map projection, so replaying the session log
 * rebuilds the stream exactly; no store beyond the log exists.
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  type GeoJsonFeatureCollection,
  type MapContainerService,
  type MapPendingCall,
  type MapProjectedLayer,
  buildMapChangeMeta,
  validateMapChangeCandidate,
} from '@map-harness/map-container'
import {
  REALTIME_METHOD_VERSION,
  StreamRuntime,
  buildMaterializedExport,
  decodeCheckpoint,
  encodeCheckpoint,
  parseScenarioCollection,
  resumeCheckpoint,
  validateStreamSpec,
  type AdvanceTotals,
  type MaterializationRecord,
  type StreamCheckpoint,
  type StreamIssue,
  type StreamScenario,
  type StreamSpec,
  addAdvanceTotals,
  emptyAdvanceTotals,
} from '@map-harness/spatial-realtime'
import { MAX_REGISTER_BYTES, admitCollection, parseCatalogRef } from '@map-harness/spatial-catalog'
import { catalogServiceOf, requirePendingPublish, sessionOf } from './catalog-tools.ts'
import { displayDigestOf, legendOf } from './display.ts'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'
import { bboxOf, round6, renderJson } from './output.ts'

/** The bounded read cap for one scenario resource (same budget as registration). */
const MAX_SCENARIO_RESOURCE_BYTES = MAX_REGISTER_BYTES

/** The bounded display window cap: at most this many window points ride the layer. */
export const MAX_STREAM_DISPLAY_WINDOWS = 1_024

/** Upper bound on steps one `stream_advance` call may run. */
export const MAX_STREAM_STEPS = 256

/** Recorded defaults the resolver writes into every spec (explicit at this seam, never hidden inside the runtime). */
export const STREAM_RECORDED_DEFAULTS = {
  dedupCapacity: 1_024,
  bufferCapacity: 256,
  maxEventsPerAdvance: 512,
  maxOpenWindows: 64,
  maxRevisionsPerWindow: 8,
} as const

/** The stream tool names that mutate the map through the fold. */
export const STREAM_MUTATION_TOOLS = ['stream_open', 'stream_advance', 'stream_pause', 'stream_resume', 'stream_materialize'] as const

/** The accepted projection read face (host-plane service). */
function mapServiceOf(exec: ToolRunContext): MapContainerService {
  const map = serviceOf<MapContainerService>(exec, 'map')
  if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map container service is unavailable in this process')
  return map
}

/**
 * Resolve the accepted `tool/call` this stream mutation pairs with — the same
 * rule every map mutation follows, so a workbench fold only happens from a
 * native direct call the session log already accepted.
 */
function requirePendingStreamMutation(
  exec: ToolRunContext,
  service: MapContainerService,
  session: NonNullable<ToolRunContext['agent']>['session'],
  name: typeof STREAM_MUTATION_TOOLS[number],
): MapPendingCall {
  if (exec.parent !== undefined) {
    throw new SpatialError('INVALID_ARGUMENT', `${name} supports native model-direct calls only; nested dispatch cannot drive the map`)
  }
  exec.signal.throwIfAborted()
  const pending = service.pendingCallOf(session, exec.callId)
  if (pending === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', `${name} requires its accepted tool/call in the session log before execution`)
  }
  if (pending.name !== name) {
    throw new SpatialError('INVALID_ARGUMENT', `session call ${exec.callId} is paired with tool ${pending.name}, not ${name}`)
  }
  return pending
}

/** Resolve one required nonempty string argument. */
function requireString(args: Record<string, unknown>, name: string, reason: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', `${name} is required: ${reason}`)
  }
  return value
}

/** Resolve one finite number argument with an optional recorded default. */
function requireNumber(args: Record<string, unknown>, name: string, fallback?: number): number {
  const value = args[name]
  if (value === undefined) {
    if (fallback === undefined) throw new SpatialError('INVALID_ARGUMENT', `${name} is required`)
    return fallback
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new SpatialError('INVALID_ARGUMENT', `${name} must be a finite number`)
  }
  return value
}

/** Reject one issue list with every defect named. */
function requireClean(what: string, issues: readonly StreamIssue[]): void {
  if (issues.length > 0) {
    throw new SpatialError('INVALID_ARGUMENT', `${what} rejected: ${issues.map(issue => `${issue.field} (${issue.code}) ${issue.message}`).join('; ')}`)
  }
}

/** Render helper shared by the stream tools: model text omits the durable meta. */
function renderStreamJson(value: JsonValue): ReturnType<typeof renderJson> {
  const { meta: _meta, ...rest } = value as Record<string, unknown>
  return renderJson(rest)
}

/** Presentation-meta projector for the stream family. */
function streamPresentationMeta(value: JsonValue): JsonValue | null {
  return (value as { meta?: JsonValue }).meta ?? null
}

/** Load the stream-workbench layer one call drives, refusing anything else. */
function loadStreamLayer(service: MapContainerService, session: NonNullable<ToolRunContext['agent']>['session'], streamId: string): MapProjectedLayer {
  const layer = service.stateOf(session).layers.find(candidate => candidate.id === streamId)
  if (layer === undefined) {
    throw new SpatialError('INVALID_ARGUMENT', `unknown stream ${streamId}; stream_open lists the workbenches as layers`)
  }
  if (layer.stream === undefined) {
    throw new SpatialError('INVALID_ARGUMENT', `layer ${streamId} is not a stream workbench; stream_open opens one`)
  }
  return layer
}

/** Decode one folded checkpoint into a live runtime, naming every refusal. */
function resumeOrThrow(checkpoint: unknown): StreamRuntime {
  const decoded = decodeCheckpoint(checkpoint)
  if (decoded.status === 'refused') {
    throw new SpatialError('STREAM_STATE_CONFLICT', `stream checkpoint refused (${decoded.code}); the workbench state cannot resume`)
  }
  return resumeCheckpoint(decoded.checkpoint)
}

/** Render one checkpoint into a folded layer record, enforcing the encode bound. */
function checkpointOf(runtime: StreamRuntime): StreamCheckpoint {
  try {
    return encodeCheckpoint(runtime)
  } catch (error) {
    throw new SpatialError('RESOURCE_TOO_LARGE', error instanceof Error ? error.message : 'the workbench state exceeds the checkpoint bound')
  }
}

/** The bounded status content every stream tool reports beside its answer. */
function statusContent(runtime: StreamRuntime): JsonValue {
  const status = runtime.status()
  return {
    paused: status.paused,
    watermark_ms: status.watermarkMs,
    max_event_time_ms: status.maxEventTimeMs,
    last_ingest_time_ms: status.lastIngestTimeMs,
    last_process_time_ms: status.lastProcessTimeMs,
    lag_ms: status.lagMs,
    source_exhausted: status.sourceExhausted,
    batch_cursor: status.batchCursor,
    buffer_length: status.bufferLength,
    dedup_length: status.dedupLength,
    open_windows: status.openWindows,
    closed_windows: status.closedWindows,
    revised_windows: status.revisedWindows,
    gap_windows: status.gapWindows,
    admitted: status.admitted,
    processed: status.processed,
    duplicates_dropped: status.duplicatesDropped,
    too_late_dropped: status.tooLateDropped,
    held_by_backpressure: status.heldByBackpressure,
    offline_batches: status.offlineBatches,
    pending_gap_windows: status.pendingGapWindows,
  }
}

/** Build the derived realtime display copy: one Point per live non-empty window. */
function displayCollectionOf(runtime: StreamRuntime): { collection: GeoJsonFeatureCollection; pointCount: number } {
  const points = runtime.displayFeatures(MAX_STREAM_DISPLAY_WINDOWS)
  const collection: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features: points.map(point => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: point.coordinates },
      properties: point.properties,
    })),
  }
  return { collection, pointCount: points.length }
}

/** Assemble the folded stream layer record from one live runtime. */
function streamLayerOf(input: {
  runtime: StreamRuntime
  streamId: string
  name: string
  scenarioRef: string
  scenarioRevision: string
  sourceCallSeq: number
  mode: 'realtime' | 'materialized'
  revision: number
  materialized: readonly MaterializationRecord[]
}): MapProjectedLayer {
  const { runtime, streamId, name, scenarioRef, scenarioRevision, sourceCallSeq, mode, revision, materialized } = input
  const spec = runtime.spec
  const status = runtime.status()
  const { collection } = displayCollectionOf(runtime)
  const stream = {
    streamId,
    scenarioRef,
    scenarioRevision,
    mode,
    methodVersion: REALTIME_METHOD_VERSION,
    windowSizeMs: spec.windowSizeMs,
    allowedLatenessMs: spec.allowedLatenessMs,
    watermarkMs: status.watermarkMs,
    lagMs: status.lagMs,
    paused: status.paused,
    revision,
    closedWindows: status.closedWindows + status.revisedWindows,
    gapWindows: status.gapWindows,
    lateRevisions: status.revisedWindows,
    duplicatesDropped: status.duplicatesDropped,
    offlineBatches: status.offlineBatches,
    checkpoint: checkpointOf(runtime),
    ...(mode === 'materialized'
      ? { materialized: materialized.map(record => ({ exportDigest: record.exportDigest, artifactRef: record.artifactRef })) }
      : {}),
  }
  return {
    id: streamId,
    name,
    data: collection,
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    sourceCallSeq,
    displayDigest: displayDigestOf(collection),
    resourceRef: scenarioRef,
    legend: legendOf(name),
    stream,
  }
}

/**
 * `stream_open`: bind one exact scenario resource version into a new
 * realtime workbench and fold its layer. The scenario is a registered
 * FeatureCollection of wire events (batched, ordered, duplicates and
 * out-of-order arrival included, offline batches for the disconnect); the
 * binding cites the resource ref plus content digest, so every later status,
 * revision, and artifact names the exact source version it replays.
 */
export const streamOpen = defineTool({
  name: 'stream_open',
  description:
    'Open a realtime stream workbench over one registered scenario resource (res-…@vN). The scenario is a '
    + 'FeatureCollection of wire events grouped by `batch` (properties: event_id, event_time_ms, value; Point '
    + 'coordinates are WGS84 lon/lat; a feature with offline:true marks its batch as source-disconnected). Requires '
    + 'an explicit tumbling window_ms and allowed lateness_ms — the watermark trails the max event time by that '
    + 'much, and windows close when it passes their end. The workbench is pull-based: nothing runs between calls. '
    + 'Advance it with stream_advance; fix its conclusions with stream_materialize.',
  parameters: {
    scenario_ref: { type: 'string', required: true, description: 'Registered scenario resource ref, `res-…@vN`.' },
    stream_id: { type: 'string', required: true, description: 'Stable workbench id; becomes the layer id. Re-opening one id replaces the workbench.' },
    name: { type: 'string', description: 'Human-readable layer name; defaults to the stream id.' },
    window_ms: { type: 'number', required: true, description: 'Tumbling window size in milliseconds.' },
    lateness_ms: { type: 'number', required: true, description: 'Allowed lateness in milliseconds; the watermark trails max event time by this much.' },
    dedup_capacity: { type: 'number', description: 'Distinct event ids the dedup window retains; 1024 is the recorded default.' },
    buffer_capacity: { type: 'number', description: 'Intake buffer bound; 256 is the recorded default. A full buffer holds the source back.' },
    max_events_per_advance: { type: 'number', description: 'Processing quota per advance; 512 is the recorded default. The slow-consumer bound.' },
    max_open_windows: { type: 'number', description: 'Open-window state bound; 64 is the recorded default.' },
    max_revisions_per_window: { type: 'number', description: 'Late-revision ledger bound per window; 8 is the recorded default.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderStreamJson(value),
    presentationMeta: (_args, value) => streamPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const raw = args as Record<string, unknown>
    const scenarioRef = requireString(raw, 'scenario_ref', 'bind one exact scenario version res-…@vN')
    const parsedRef = parseCatalogRef(scenarioRef)
    if (parsedRef.kind !== 'resource') {
      throw new SpatialError('INVALID_ARGUMENT', 'the stream source binds a registered scenario resource (res-…@vN); artifacts are not scenario sources')
    }
    const streamId = requireString(raw, 'stream_id', 'the workbench needs a stable id')
    if (streamId.length > 128) {
      throw new SpatialError('INVALID_ARGUMENT', 'stream_id must be at most 128 characters')
    }
    const windowMs = requireNumber(raw, 'window_ms')
    const latenessMs = requireNumber(raw, 'lateness_ms')
    const spec: StreamSpec = {
      methodVersion: REALTIME_METHOD_VERSION,
      windowSizeMs: windowMs,
      allowedLatenessMs: latenessMs,
      dedupCapacity: requireNumber(raw, 'dedup_capacity', STREAM_RECORDED_DEFAULTS.dedupCapacity),
      bufferCapacity: requireNumber(raw, 'buffer_capacity', STREAM_RECORDED_DEFAULTS.bufferCapacity),
      maxEventsPerAdvance: requireNumber(raw, 'max_events_per_advance', STREAM_RECORDED_DEFAULTS.maxEventsPerAdvance),
      maxOpenWindows: requireNumber(raw, 'max_open_windows', STREAM_RECORDED_DEFAULTS.maxOpenWindows),
      maxRevisionsPerWindow: requireNumber(raw, 'max_revisions_per_window', STREAM_RECORDED_DEFAULTS.maxRevisionsPerWindow),
    }
    requireClean('stream spec', validateStreamSpec(spec))

    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingStreamMutation(exec, service, session, 'stream_open')
    const catalog = catalogServiceOf(exec)
    const { resource, bytes } = await catalog.readResourceBytes(scenarioRef, catalog.deploymentDomain(), MAX_SCENARIO_RESOURCE_BYTES)
    const admitted = admitCollection(bytes, { enforceWgs84Range: true })
    const parsedScenario = parseScenarioCollection(admitted.collection)
    if (parsedScenario.status === 'refused') {
      throw new SpatialError('INVALID_ARGUMENT', `scenario resource rejected: ${parsedScenario.issues.map(issue => `${issue.field} (${issue.code}) ${issue.message}`).join('; ')}`)
    }
    const scenario: StreamScenario = parsedScenario.scenario
    exec.signal.throwIfAborted()
    const runtime = StreamRuntime.open(spec, scenario)
    const name = raw.name === undefined ? `stream ${streamId}` : raw.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'name must be a nonempty string when given')
    }
    const layer = streamLayerOf({
      runtime,
      streamId,
      name,
      scenarioRef,
      scenarioRevision: resource.contentDigest,
      sourceCallSeq: pending.callSeq,
      mode: 'realtime',
      revision: 0,
      materialized: [],
    })
    const state = service.stateOf(session)
    const change = { op: 'add-layer', layer } as const
    const targetRevision = validateMapChangeCandidate(state, change)
    const replacing = state.layers.some(existing => existing.id === layer.id)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    const { collection } = displayCollectionOf(runtime)
    return {
      stream_id: streamId,
      scenario: { ref: scenarioRef, revision: resource.contentDigest, batches: scenario.batches.length },
      window: { size_ms: spec.windowSizeMs, allowed_lateness_ms: spec.allowedLatenessMs },
      mode: 'realtime',
      revision: 0,
      status: statusContent(runtime),
      layer: { id: layer.id, name: layer.name, feature_count: collection.features.length },
      bbox: bboxOf(collection) ?? null,
      total_layers: replacing ? state.layers.length : state.layers.length + 1,
      limitations: [
        'the source is the controlled scenario resource you bound; real providers are a separate release',
        'the workbench is pull-based: it moves only when stream_advance runs, and one call is one bounded wake — never per event',
        'the realtime layer is derived state; only stream_materialize fixes a version a report may cite',
      ],
      meta,
    }
  },
})

/** Shared execution core of the resume-mutating calls: load, decode, check, transform, fold. */
async function withStreamRuntime(
  exec: ToolRunContext,
  tool: 'stream_advance' | 'stream_pause' | 'stream_resume' | 'stream_materialize',
  streamId: string,
  transform: (context: {
    runtime: StreamRuntime
    layer: MapProjectedLayer
    stream: NonNullable<MapProjectedLayer['stream']>
    sourceCallSeq: number
  }) => Promise<{ layer: MapProjectedLayer; content: Record<string, unknown> } | { contentOnly: Record<string, unknown> }>,
): Promise<Record<string, unknown> & JsonValue> {
  exec.signal.throwIfAborted()
  const session = sessionOf(exec)
  const service = mapServiceOf(exec)
  const pending = requirePendingStreamMutation(exec, service, session, tool)
  const layer = loadStreamLayer(service, session, streamId)
  const stream = layer.stream as NonNullable<MapProjectedLayer['stream']>
  const runtime = resumeOrThrow(stream.checkpoint)
  const outcome = await transform({ runtime, layer, stream, sourceCallSeq: pending.callSeq })
  if ('contentOnly' in outcome) return outcome.contentOnly as Record<string, unknown> & JsonValue
  const state = service.stateOf(session)
  const change = { op: 'add-layer', layer: outcome.layer } as const
  const targetRevision = validateMapChangeCandidate(state, change)
  const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
  return { ...outcome.content, meta } as Record<string, unknown> & JsonValue
}

/**
 * `stream_advance`: drive the controlled source forward by bounded steps.
 * One call is one bounded wake: the result carries the additive totals over
 * every step (duplicates, backpressure holds, closures, late revisions,
 * gaps), never per-event output.
 */
export const streamAdvance = defineTool({
  name: 'stream_advance',
  description:
    'Advance a stream workbench by up to 256 scenario batches (one step admits the next batch into the bounded '
    + 'intake, processes up to the quota, closes windows the watermark passed, and materializes bounded data gaps). '
    + 'Returns one additive summary: admitted, processed, duplicates dropped, backpressure holds, windows closed, '
    + 'late revisions, gaps. The layer folds the updated window projection and the resumable checkpoint.',
  parameters: {
    stream_id: { type: 'string', required: true, description: 'The workbench to advance.' },
    steps: { type: 'number', description: 'Batches to advance; 1 is the recorded default, 256 the cap.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderStreamJson(value),
    presentationMeta: (_args, value) => streamPresentationMeta(value),
  },
  async execute(args, exec) {
    const raw = args as Record<string, unknown>
    const streamId = requireString(raw, 'stream_id', 'name the workbench to advance')
    const steps = requireNumber(raw, 'steps', 1)
    if (!Number.isInteger(steps) || steps < 1 || steps > MAX_STREAM_STEPS) {
      throw new SpatialError('INVALID_ARGUMENT', `steps must be an integer in [1, ${MAX_STREAM_STEPS}]`)
    }
    return withStreamRuntime(exec, 'stream_advance', streamId, async ({ runtime, layer, stream, sourceCallSeq }) => {
      if (runtime.isPaused) {
        throw new SpatialError('STREAM_STATE_CONFLICT', `stream ${streamId} is paused; stream_resume it before advancing`)
      }
      if (stream.mode === 'materialized') {
        throw new SpatialError('STREAM_STATE_CONFLICT', `stream ${streamId} is materialized; its conclusions are fixed — open a new workbench to continue`)
      }
      const status = runtime.status()
      if (status.sourceExhausted && status.bufferLength === 0 && status.pendingGapWindows === 0) {
        throw new SpatialError('STREAM_STATE_CONFLICT', `stream ${streamId} exhausted its scenario and intake; nothing to advance`)
      }
      let totals: AdvanceTotals = emptyAdvanceTotals()
      for (let step = 0; step < steps; step += 1) {
        if (runtime.status().sourceExhausted && runtime.status().bufferLength === 0) break
        totals = addAdvanceTotals(totals, runtime.advance(stream.checkpoint.lastProcessTimeMs === null ? 0 : stream.checkpoint.lastProcessTimeMs + step + 1))
      }
      const conclusions = totals.windowsClosed + totals.windowsRevised + totals.gapsClosed
      const revision = (stream.revision as number) + conclusions
      const nextLayer = streamLayerOf({
        runtime,
        streamId,
        name: layer.name,
        scenarioRef: stream.scenarioRef,
        scenarioRevision: stream.scenarioRevision,
        sourceCallSeq,
        mode: 'realtime',
        revision,
        materialized: [],
      })
      const { collection } = displayCollectionOf(runtime)
      return {
        layer: nextLayer,
        content: {
          stream_id: streamId,
          steps_run: totals.advancedBatches,
          totals: {
            admitted: totals.admitted,
            processed: totals.processed,
            duplicates_dropped: totals.duplicatesDropped,
            too_late_dropped: totals.tooLateDropped,
            held_by_backpressure: totals.heldByBackpressure,
            offline_batches: totals.offlineBatches,
            windows_closed: totals.windowsClosed,
            windows_revised: totals.windowsRevised,
            gaps_closed: totals.gapsClosed,
          },
          revision,
          status: statusContent(runtime),
          layer: { id: streamId, feature_count: collection.features.length },
          bbox: bboxOf(collection) ?? null,
          limitations: [
            'one call is one bounded wake; the per-event movement is inside the totals, never a per-event wake',
            'the realtime layer is derived state; conclusions become citable only through stream_materialize',
          ],
        },
      }
    })
  },
})

/** `stream_pause`: gate the controlled source; the workbench state freezes exactly. */
export const streamPause = defineTool({
  name: 'stream_pause',
  description:
    'Pause a stream workbench: subsequent stream_advance calls refuse until stream_resume. The intake buffer, '
    + 'windows, and checkpoint freeze exactly; the folded layer keeps carrying the stream status.',
  parameters: {
    stream_id: { type: 'string', required: true, description: 'The workbench to pause.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderStreamJson(value),
    presentationMeta: (_args, value) => streamPresentationMeta(value),
  },
  async execute(args, exec) {
    const streamId = requireString(args as Record<string, unknown>, 'stream_id', 'name the workbench to pause')
    return withStreamRuntime(exec, 'stream_pause', streamId, async ({ runtime, layer, stream, sourceCallSeq }) => {
      if (runtime.isPaused) {
        throw new SpatialError('STREAM_STATE_CONFLICT', `stream ${streamId} is already paused`)
      }
      if (stream.mode === 'materialized') {
        throw new SpatialError('STREAM_STATE_CONFLICT', `stream ${streamId} is materialized; its conclusions are fixed`)
      }
      runtime.pause()
      const nextLayer = streamLayerOf({
        runtime, streamId, name: layer.name,
        scenarioRef: stream.scenarioRef, scenarioRevision: stream.scenarioRevision,
        sourceCallSeq, mode: 'realtime', revision: stream.revision as number, materialized: [],
      })
      return {
        layer: nextLayer,
        content: { stream_id: streamId, paused: true, status: statusContent(runtime) },
      }
    })
  },
})

/** `stream_resume`: release a paused source at the frozen cursor. */
export const streamResume = defineTool({
  name: 'stream_resume',
  description: 'Resume a paused stream workbench: the source continues exactly at the frozen batch cursor and intake buffer.',
  parameters: {
    stream_id: { type: 'string', required: true, description: 'The workbench to resume.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderStreamJson(value),
    presentationMeta: (_args, value) => streamPresentationMeta(value),
  },
  async execute(args, exec) {
    const streamId = requireString(args as Record<string, unknown>, 'stream_id', 'name the workbench to resume')
    return withStreamRuntime(exec, 'stream_resume', streamId, async ({ runtime, layer, stream, sourceCallSeq }) => {
      if (!runtime.isPaused) {
        throw new SpatialError('STREAM_STATE_CONFLICT', `stream ${streamId} is not paused`)
      }
      if (stream.mode === 'materialized') {
        throw new SpatialError('STREAM_STATE_CONFLICT', `stream ${streamId} is materialized; its conclusions are fixed`)
      }
      runtime.resume()
      const nextLayer = streamLayerOf({
        runtime, streamId, name: layer.name,
        scenarioRef: stream.scenarioRef, scenarioRevision: stream.scenarioRevision,
        sourceCallSeq, mode: 'realtime', revision: stream.revision as number, materialized: [],
      })
      return {
        layer: nextLayer,
        content: { stream_id: streamId, paused: false, status: statusContent(runtime) },
      }
    })
  },
})

/**
 * `stream_materialize`: fix the settled window set as an immutable,
 * digest-pinned catalog artifact citing the bound scenario version, and flip
 * the layer to its final materialized state. The publication is idempotent:
 * re-materializing an unchanged state returns the already-published artifact
 * ref instead of minting a second one.
 */
export const streamMaterialize = defineTool({
  name: 'stream_materialize',
  description:
    'Materialize a stream workbench: export every settled window (closed, late-revised, and data-gap) at its '
    + 'current revision as one immutable catalog artifact, cite the scenario version it was computed from, and fix '
    + 'the layer as the final materialized state. Re-materializing an unchanged state returns the existing artifact '
    + 'ref — never a second publication. After materialization the workbench is closed: further advances refuse.',
  parameters: {
    stream_id: { type: 'string', required: true, description: 'The workbench to materialize.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderStreamJson(value),
    presentationMeta: (_args, value) => streamPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const streamId = requireString(args as Record<string, unknown>, 'stream_id', 'name the workbench to materialize')
    const session = sessionOf(exec)
    const catalog = catalogServiceOf(exec)
    requirePendingPublish(exec, catalog, session as Parameters<typeof requirePendingPublish>[2], 'stream_materialize')
    return withStreamRuntime(exec, 'stream_materialize', streamId, async ({ runtime, layer, stream, sourceCallSeq }) => {
      if (stream.mode === 'materialized') {
        throw new SpatialError('STREAM_STATE_CONFLICT', `stream ${streamId} is already materialized at ${String(stream.materialized?.map(pin => pin.artifactRef).join(', '))}`)
      }
      const processMs = stream.checkpoint.lastProcessTimeMs ?? 0
      const exportResult = buildMaterializedExport(runtime, processMs)
      if (exportResult.status === 'refused') {
        throw new SpatialError('INVALID_ARGUMENT', `stream_materialize refused (${exportResult.code}); advance until the watermark closes at least one window`)
      }
      const existing = runtime.materializations.find(record => record.exportDigest === exportResult.export.exportDigest)
      if (existing !== undefined) {
        return {
          contentOnly: {
            stream_id: streamId,
            already_materialized: true,
            export_digest: exportResult.export.exportDigest,
            artifact_ref: existing.artifactRef,
            windows: exportResult.export.windows.length,
            status: statusContent(runtime),
            limitations: ['the unchanged state was already published; the existing artifact ref is returned, never a second publication'],
          },
        }
      }
      // The durable artifact is the fixed window set as GeoJSON: one feature
      // per settled window at its pinned revision; data gaps carry null
      // geometry — visible as no-data, never interpolated.
      const features = exportResult.export.windows.map(window => ({
        type: 'Feature' as const,
        geometry: window.aggregate.count === 0 ? null : { type: 'Point' as const, coordinates: [round6(window.aggregate.meanLon), round6(window.aggregate.meanLat)] },
        properties: {
          window_start_ms: window.startMs,
          window_end_ms: window.endMs,
          status: window.status,
          revision: window.revision,
          digest: window.digest,
          count: window.aggregate.count,
          mean: round6(window.aggregate.mean),
          min: round6(window.aggregate.min),
          max: round6(window.aggregate.max),
          export_digest: exportResult.export.exportDigest,
        },
      }))
      const artifactBytes = new TextEncoder().encode(JSON.stringify({ type: 'FeatureCollection', features }))
      exec.signal.throwIfAborted()
      const published = await catalog.publishArtifact({
        bytes: artifactBytes,
        inputRefs: [stream.scenarioRef],
        method: { algorithm: 'stream-materialize', units: 'dimensionless', parameters: { methodVersion: REALTIME_METHOD_VERSION, windowSizeMs: stream.windowSizeMs, allowedLatenessMs: stream.allowedLatenessMs, exportDigest: exportResult.export.exportDigest } },
        analysisCrs: 'EPSG:4326',
        sessionId: session.id,
        sourceCallSeq,
        inputAuthorizations: [catalog.deploymentDomain()],
      })
      const record: MaterializationRecord = { exportDigest: exportResult.export.exportDigest, artifactRef: published.artifact.ref, processMs }
      runtime.recordMaterialization(record)
      const nextLayer = streamLayerOf({
        runtime, streamId, name: layer.name,
        scenarioRef: stream.scenarioRef, scenarioRevision: stream.scenarioRevision,
        sourceCallSeq, mode: 'materialized', revision: stream.revision as number, materialized: [...runtime.materializations],
      })
      return {
        layer: nextLayer,
        content: {
          stream_id: streamId,
          already_materialized: false,
          export_digest: record.exportDigest,
          artifact_ref: record.artifactRef,
          scenario: { ref: stream.scenarioRef, revision: stream.scenarioRevision },
          windows: exportResult.export.windows.length,
          status: statusContent(runtime),
          limitations: [
            'the artifact is immutable; a later revision of a window publishes a new artifact version instead of rewriting this one',
            'the workbench is closed after materialization: advances refuse, and the realtime/final distinction stays visible in the layer',
          ],
        },
      }
    })
  },
})
