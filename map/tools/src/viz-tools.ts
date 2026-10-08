/**
 * The visualization workbench tools: `viz_create_style`, `viz_classify`, and
 * `viz_compare`. Every tool resolves its classification from actual data —
 * `viz_create_style` from one exact catalog resource version (publishing the
 * style record as an artifact), `viz_classify` and `viz_compare` from the
 * accepted projection's own display copy — so no break value is ever
 * invented. `viz_classify`/`viz_compare` are map mutations: they return model
 * content plus one versioned `map-change` meta carrying the `set-style`
 * change, which folds under the same commit protocol as every other
 * mutation. Manual breaks must cite an exact statistic source ref.
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
  buildStyle,
  checkStyleInputs,
  computeBreaks,
  countClasses,
  createFeatureCollectionScanner,
  createGridAggregator,
  legendOf,
  measureValueOf,
  unifyDomains,
  validateStyleSpec,
  VIZ_METHOD_VERSION,
  type BuiltStyle,
  type GridAggregateParams,
  type TimeBinding,
  type WorkbenchFeature,
} from '@map-harness/spatial-viz'
import { MAX_REGISTER_BYTES, admitCollection, parseCatalogRef } from '@map-harness/spatial-catalog'
import { catalogServiceOf, requirePendingPublish, sessionOf } from './catalog-tools.ts'
import { buildVizStyleMeta } from './viz-meta.ts'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'
import { renderJson } from './output.ts'

/** The bounded read cap for one resolved resource (same budget as registration). */
const MAX_VIZ_RESOURCE_BYTES = MAX_REGISTER_BYTES
/** The aggregate display layer's cell ceiling; coarser grids on refusal. */
const MAX_VIZ_AGGREGATE_CELLS = 20000
/** The streaming trigger: resources above this size classify with bounded memory. */
const MAX_VIZ_INMEMORY_BYTES = 8 * 1024 * 1024
/** The streaming path's ceiling; classification beyond it is a later provider channel. */
const MAX_VIZ_STREAM_BYTES = 512 * 1024 * 1024
/** Stream chunk size fed to the incremental scanner. */
const VIZ_STREAM_CHUNK_BYTES = 256 * 1024

/** Render helper shared by the viz tools: model text omits the durable meta. */
function renderVizJson(value: JsonValue): ReturnType<typeof renderJson> {
  const { meta: _meta, ...rest } = value as Record<string, unknown>
  return renderJson(rest)
}

/** Presentation-meta projector for the viz family. */
function vizPresentationMeta(value: JsonValue): JsonValue | null {
  return (value as { meta?: JsonValue }).meta ?? null
}

/** The accepted projection read face (host-plane service, same pattern as the map tools). */
function mapServiceOf(exec: ToolRunContext): MapContainerService {
  const map = serviceOf<MapContainerService>(exec, 'map')
  if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map container service is unavailable in this process')
  return map
}

/**
 * Resolve the accepted `tool/call` the viz mutation pairs with — the same
 * rule the map mutations follow, so a style folds only from a native direct
 * call that the session log already accepted.
 */
function requirePendingVizMutation(
  exec: ToolRunContext,
  service: MapContainerService,
  session: NonNullable<ToolRunContext['agent']>['session'],
  name: 'viz_classify' | 'viz_compare',
): MapPendingCall {
  if (exec.parent !== undefined) {
    throw new SpatialError('INVALID_ARGUMENT', 'viz tools support native model-direct calls only; nested dispatch cannot change the map')
  }
  exec.signal.throwIfAborted()
  const pending = service.pendingCallOf(session, exec.callId)
  if (pending === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'viz mutation requires its accepted tool/call in the session log before execution')
  }
  if (pending.name !== name) {
    throw new SpatialError('INVALID_ARGUMENT', `session call ${exec.callId} is paired with tool ${pending.name}, not ${name}`)
  }
  return pending
}

/** The resolved style inputs the raw tool arguments always fully determine. */
interface ResolvedStyleInputs {
  readonly field: string
  readonly unit: string
  readonly measure: 'total' | 'rate' | 'density'
  readonly seriesIdentity: 'observed' | 'forecast' | 'scenario'
  readonly denominatorField?: string
  readonly encoding: 'fill' | 'size'
  readonly classification: 'quantile' | 'equal-interval' | 'manual'
  readonly classCount: number
  readonly manualBreaks?: readonly number[]
  readonly breaksSourceRef?: string
  readonly timeBinding?: TimeBinding
}

/** Reject a raw spec input with every structural issue named. */
function requireCleanInputs(issues: readonly { field: string; code: string }[]): void {
  if (issues.length > 0) {
    throw new SpatialError('INVALID_ARGUMENT', `style rejected: ${issues.map(issue => `${issue.field} (${issue.code})`).join('; ')}`)
  }
}

/** Resolve the shared style arguments; every default is written here, never hidden downstream. */
function resolveStyleInputs(args: Record<string, unknown>): ResolvedStyleInputs {
  const field = args.field
  const unit = args.unit
  if (typeof field !== 'string' || field.length === 0) throw new SpatialError('INVALID_ARGUMENT', 'field is required')
  if (typeof unit !== 'string' || unit.length === 0) throw new SpatialError('INVALID_ARGUMENT', 'unit is required')
  const measure = (args.measure ?? 'total') as 'total' | 'rate' | 'density'
  const seriesIdentity = (args.series_identity ?? 'observed') as 'observed' | 'forecast' | 'scenario'
  const denominatorField = args.denominator_field
  const encoding = (args.encoding ?? 'fill') as 'fill' | 'size'
  const classification = (args.classification ?? 'quantile') as 'quantile' | 'equal-interval' | 'manual'
  const classCount = (args.class_count ?? 5) as number
  const manualBreaks = args.breaks as readonly number[] | undefined
  const breaksSourceRef = args.breaks_source_ref as string | undefined
  requireCleanInputs(checkStyleInputs({
    measure,
    seriesIdentity,
    encoding,
    classification,
    ...(denominatorField === undefined ? {} : { denominatorField }),
  }))
  if (!Number.isInteger(classCount) || classCount < 2 || classCount > 12) {
    throw new SpatialError('INVALID_ARGUMENT', 'class_count must be an integer in [2, 12]')
  }
  if (classification === 'manual') {
    if (!Array.isArray(manualBreaks) || manualBreaks.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'manual classification requires the breaks array')
    }
    if (typeof breaksSourceRef !== 'string' || breaksSourceRef.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'manual breaks require breaks_source_ref — the exact statistic ref the breaks came from')
    }
    for (let at = 1; at < manualBreaks.length; at += 1) {
      if (!Number.isFinite(manualBreaks[at]) || (manualBreaks[at] as number) <= (manualBreaks[at - 1] as number)) {
        throw new SpatialError('INVALID_ARGUMENT', 'breaks must be finite and strictly increasing')
      }
    }
  }
  if (classification !== 'manual' && breaksSourceRef !== undefined) {
    throw new SpatialError('INVALID_ARGUMENT', 'breaks_source_ref applies to manual classification only; computed breaks cite the data itself')
  }
  return {
    field,
    unit,
    measure,
    seriesIdentity,
    ...(typeof denominatorField === 'string' ? { denominatorField } : {}),
    encoding,
    classification,
    classCount,
    ...(classification === 'manual'
      ? { manualBreaks: manualBreaks as readonly number[], breaksSourceRef: breaksSourceRef as string }
      : {}),
    ...timeBindingOf(args),
  }
}

/** The optional time-binding block: all-or-nothing, validated together. */
function timeBindingOf(args: Record<string, unknown>): { timeBinding?: TimeBinding } {
  const { time_field: timeField, timezone, granularity, time_from: from, time_to: to } = args
  if (timeField === undefined && timezone === undefined && granularity === undefined && from === undefined && to === undefined) {
    return {}
  }
  if (typeof timeField !== 'string' || timeField.length === 0
    || typeof timezone !== 'string' || timezone.length === 0
    || typeof from !== 'string' || typeof to !== 'string') {
    throw new SpatialError('INVALID_ARGUMENT', 'a time binding needs time_field, timezone, time_from, and time_to together')
  }
  const binding: TimeBinding = {
    timeField,
    timezone,
    granularity: (granularity ?? 'day') as TimeBinding['granularity'],
    window: { from, to },
  }
  const parsed = validateStyleSpec({
    methodVersion: VIZ_METHOD_VERSION,
    field: 'x', unit: 'x', measure: 'total', encoding: 'fill',
    classification: 'quantile', breaks: [1], domain: { min: 0, max: 2 },
    palette: ['#111111', '#222222'],
    missingColor: '#bdbdbd', overflowColor: '#616161', missingLabel: 'no data',
    styleVersion: 'sty-000000000000@v1',
    timeBinding: binding,
  })
  requireCleanInputs(parsed.filter(issue => issue.field.startsWith('timeBinding')))
  return { timeBinding: binding }
}

/** The measured values one feature collection classifies; missing values stay NaN for the class counts. */
function measuredValuesOf(data: GeoJsonFeatureCollection, inputs: Pick<ResolvedStyleInputs, 'field' | 'measure' | 'denominatorField'>): number[] {
  const features: readonly WorkbenchFeature[] = data.features
  const values: number[] = []
  let finite = 0
  for (const feature of features) {
    const measured = measureValueOf(feature.properties ?? null, inputs)
    values.push(measured)
    if (Number.isFinite(measured)) finite += 1
  }
  if (finite === 0) {
    throw new SpatialError('INVALID_ARGUMENT', `field ${inputs.field} carries no numeric values to classify`)
  }
  return values
}

/** Assemble and validate one style from resolved inputs and frozen values. */
function styleFromValues(inputs: ResolvedStyleInputs, values: readonly number[]): BuiltStyle {
  const finite = values.filter(value => Number.isFinite(value))
  const domain = { min: Math.min(...finite), max: Math.max(...finite) }
  let breaks: readonly number[]
  if (inputs.classification === 'manual') {
    breaks = inputs.manualBreaks as readonly number[]
  } else {
    breaks = computeBreaks(values, inputs.classification, inputs.classCount).breaks
  }
  if (breaks.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', 'constant field carries no classification: every value is identical')
  }
  const style = buildStyle({
    field: inputs.field,
    unit: inputs.unit,
    measure: inputs.measure,
    seriesIdentity: inputs.seriesIdentity,
    ...(inputs.denominatorField === undefined ? {} : { denominatorField: inputs.denominatorField }),
    encoding: inputs.encoding,
    classification: inputs.classification,
    breaks,
    domain,
    ...(inputs.timeBinding === undefined ? {} : { timeBinding: inputs.timeBinding }),
    ...(inputs.breaksSourceRef === undefined ? {} : { breaksSourceRef: inputs.breaksSourceRef }),
  })
  requireCleanInputs(validateStyleSpec(style))
  return style
}

/** The fixed display limitations every classified layer reports. */
const VIZ_LIMITATIONS = [
  'Breaks are display classes computed from the rendered data version; they are not a statistical test.',
  'The legend, attribute table, chart, and export render the same style version and data identity.',
] as const

/** Verify a time binding names at least one parsable feature time. */
function requireSomeTime(data: GeoJsonFeatureCollection, binding: TimeBinding): void {
  for (const feature of data.features) {
    const raw = feature.properties?.[binding.timeField]
    if (typeof raw === 'string' && Number.isFinite(Date.parse(raw))) return
  }
  throw new SpatialError('INVALID_ARGUMENT', `time field ${binding.timeField} carries no parsable timestamps in this layer`)
}

/** The bounded style summary every viz tool reports beside its result. */
function styleSummary(style: BuiltStyle, counts: ReturnType<typeof countClasses>): Record<string, unknown> {
  return {
    style_version: style.styleVersion,
    method_version: VIZ_METHOD_VERSION,
    field: style.field,
    unit: style.unit,
    measure: style.measure,
    series_identity: style.seriesIdentity,
    ...(style.denominatorField === undefined ? {} : { denominator_field: style.denominatorField }),
    encoding: style.encoding,
    classification: style.classification,
    ...(style.breaksSourceRef === undefined ? {} : { breaks_source_ref: style.breaksSourceRef }),
    ...(style.unifiedDomain === undefined ? {} : { unified_domain: style.unifiedDomain }),
    domain: style.domain,
    breaks: style.breaks,
    class_counts: counts.counts,
    missing_count: counts.missing,
    overflow_count: counts.overflow,
    underflow_count: counts.underflow,
    legend_rows: legendOf(style).rows.map(row => row.kind === 'class'
      ? { kind: row.kind, from: row.from, to: row.to, to_inclusive: row.toInclusive }
      : { kind: row.kind }),
    ...(style.timeBinding === undefined ? {} : { time_binding: style.timeBinding }),
  }
}

/** Read the accepted projection's layer, refusing unknown ids by name. */
function requireLayer(service: MapContainerService, session: NonNullable<ToolRunContext['agent']>['session'], layerId: string): MapProjectedLayer {
  const layer = service.stateOf(session).layers.find(candidate => candidate.id === layerId)
  if (layer === undefined) {
    throw new SpatialError('INVALID_ARGUMENT', `unknown layer ${layerId}; map_get_state lists the loaded layers`)
  }
  return layer
}

/**
 * `viz_create_style`: compute a classification from one exact catalog
 * resource version and publish the style record as an artifact. Breaks come
 * from the frozen bytes; manual breaks must cite their statistic source.
 */
export const vizCreateStyle = defineTool({
  name: 'viz_create_style',
  description:
    'Compute a classification style (StyleSpec + LegendSpec) from one registered resource version: quantile or '
    + 'equal-interval breaks computed from the actual field values, or manual breaks that must cite the exact '
    + 'statistic ref they came from. Rates and densities classify the ratio over a denominator field. Publishes '
    + 'the style record as an artifact viz_classify can cite, and reports the real breaks, class counts, and '
    + 'missing counts — never invented ranges.',
  parameters: {
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) the values classify from.' },
    field: { type: 'string', required: true, description: 'Numeric property to classify.' },
    unit: { type: 'string', required: true, description: 'Unit the legend labels.' },
    measure: { type: 'string', description: 'total (default), rate, or density — rates/densities classify the ratio over denominator_field.' },
    series_identity: { type: 'string', description: 'observed (default), forecast, or scenario — the identity the legend declares so a forecast layer is never mistaken for an observed one.' },
    denominator_field: { type: 'string', description: 'Positive denominator property; required for rate/density, forbidden for total.' },
    classification: { type: 'string', description: 'quantile (default), equal-interval, or manual.' },
    class_count: { type: 'number', description: 'Classes in [2, 12]; 5 is the recorded default. Tied data collapses honestly to fewer.' },
    breaks: { type: 'array', description: 'Manual class boundaries (with classification=manual); strictly increasing numbers.', items: { type: 'number' } },
    breaks_source_ref: { type: 'string', description: 'Exact res-…@vN / art-…@vN the manual breaks came from; required for manual.' },
    encoding: { type: 'string', description: 'fill (default) or size — size point encoding needs measure=total.' },
    time_field: { type: 'string', description: 'With timezone/time_from/time_to: the temporal binding the workbench timeline uses.' },
    timezone: { type: 'string', description: 'IANA zone the timeline renders in (with time_field).' },
    granularity: { type: 'string', description: 'hour, day (default), week, or month (with time_field).' },
    time_from: { type: 'string', description: 'Half-open timeline window start, ISO (with time_field).' },
    time_to: { type: 'string', description: 'Half-open timeline window end, exclusive (with time_field).' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderVizJson(value),
    presentationMeta: (_args, value) => vizPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { resource_ref: resourceRef } = args as Record<string, unknown>
    if (typeof resourceRef !== 'string' || resourceRef.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'resource_ref must be an exact resource ref res-…@vN')
    }
    parseCatalogRef(resourceRef)
    const inputs = resolveStyleInputs(args)
    const session = sessionOf(exec)
    const catalog = catalogServiceOf(exec)
    const pending = requirePendingPublish(exec, catalog, session as Parameters<typeof requirePendingPublish>[2], 'viz_create_style')
    const resolved = await catalog.resolve({ ref: resourceRef, authorization: catalog.deploymentDomain() })
    // Oversized versions stream through the incremental scanner (exact, one
    // feature at a time, bounded memory); registered-cap versions keep the
    // original in-memory path byte for byte.
    let values: number[]
    if (resolved.resource.byteCount > MAX_VIZ_INMEMORY_BYTES) {
      if (resolved.resource.byteCount > MAX_VIZ_STREAM_BYTES) {
        throw new SpatialError('INVALID_ARGUMENT', `resource ${resourceRef} (${String(resolved.resource.byteCount)} bytes) exceeds the ${String(MAX_VIZ_STREAM_BYTES)} byte streaming classification limit`)
      }
      values = []
      let finite = 0
      let timeValid = false
      const scanner = createFeatureCollectionScanner({ maxBytes: MAX_VIZ_STREAM_BYTES }, feature => {
        const measured = measureValueOf((feature.properties as Record<string, unknown> | null | undefined) ?? null, inputs)
        values.push(measured)
        if (Number.isFinite(measured)) finite += 1
        if (inputs.timeBinding !== undefined && !timeValid) {
          const raw = (feature.properties as Record<string, unknown> | null | undefined)?.[inputs.timeBinding.timeField]
          if (typeof raw === 'string' && Number.isFinite(Date.parse(raw))) timeValid = true
        }
      })
      await catalog.readResourceChunks(resourceRef, catalog.deploymentDomain(), { maxBytes: MAX_VIZ_STREAM_BYTES, chunkBytes: VIZ_STREAM_CHUNK_BYTES }, chunk => scanner.push(chunk))
      scanner.end()
      exec.signal.throwIfAborted()
      if (finite === 0) {
        throw new SpatialError('INVALID_ARGUMENT', `field ${inputs.field} carries no numeric values to classify`)
      }
      if (inputs.timeBinding !== undefined && !timeValid) {
        throw new SpatialError('INVALID_ARGUMENT', `time field ${inputs.timeBinding.timeField} carries no parsable timestamps in this layer`)
      }
    } else {
      const { bytes } = await catalog.readResourceBytes(resourceRef, catalog.deploymentDomain(), MAX_VIZ_RESOURCE_BYTES)
      const admitted = admitCollection(bytes, { enforceWgs84Range: true })
      const collection = admitted.collection as GeoJsonFeatureCollection
      values = measuredValuesOf(collection, inputs)
      exec.signal.throwIfAborted()
      const styleDraft = styleFromValues(inputs, values)
      if (styleDraft.timeBinding !== undefined) requireSomeTime(collection, styleDraft.timeBinding)
    }
    const style = styleFromValues(inputs, values)
    const counts = countClasses(style, values)
    const styleBytes = new TextEncoder().encode(JSON.stringify({ style, legend: legendOf(style) }))
    const published = await catalog.publishArtifact({
      bytes: styleBytes,
      inputRefs: [resourceRef],
      method: { algorithm: 'viz-classification', units: 'style', parameters: { styleVersion: style.styleVersion } },
      analysisCrs: 'EPSG:4326',
      sessionId: session.id,
      sourceCallSeq: pending.callSeq,
      inputAuthorizations: [resolved.resource.authorization],
    })
    const meta = buildVizStyleMeta({
      tool: 'viz_create_style',
      styleVersion: style.styleVersion,
      dataRef: resourceRef,
      field: style.field,
      unit: style.unit,
      measure: style.measure,
      breaks: style.breaks,
      breaksSourceRef: style.breaksSourceRef ?? null,
      artifactRefs: [published.artifact.ref],
      limitations: VIZ_LIMITATIONS,
    })
    return {
      resource_ref: resourceRef,
      value_count: values.filter(Number.isFinite).length,
      ...styleSummary(style, counts),
      artifact_ref: published.artifact.ref,
      limitations: VIZ_LIMITATIONS,
      meta,
    } as unknown as JsonValue
  },
})

/** The shared body of the two map-mutating viz tools: style, validate, and emit the change. */
function classifyResult(options: {
  readonly exec: ToolRunContext
  readonly name: 'viz_classify' | 'viz_compare'
  readonly layers: readonly { readonly layer: MapProjectedLayer; readonly style: BuiltStyle }[]
}): JsonValue {
  const { exec, name, layers } = options
  const session = exec.agent?.session
  if (session === undefined || typeof session.id !== 'string') {
    throw new SpatialError('INVALID_ARGUMENT', 'viz tools require an agent session caller')
  }
  const service = mapServiceOf(exec)
  const pending = requirePendingVizMutation(exec, service, session, name)
  exec.signal.throwIfAborted()
  const state = service.stateOf(session)
  const change = {
    op: 'set-style' as const,
    styles: layers.map(({ layer, style }) => ({ layerId: layer.id, style })),
  }
  const targetRevision = validateMapChangeCandidate(state, change)
  const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
  const perLayer = layers.map(({ layer, style }) => {
    const values = measuredValuesOf(layer.data as GeoJsonFeatureCollection, style)
    return {
      layer_id: layer.id,
      ...styleSummary(style, countClasses(style, values)),
      rendered_value_count: values.filter(Number.isFinite).length,
    }
  })
  return {
    layers: perLayer,
    map_revision_target: targetRevision,
    limitations: VIZ_LIMITATIONS,
    meta,
  } as unknown as JsonValue
}

/**
 * `viz_classify`: classify one loaded layer from its own rendered data and
 * propose the `set-style` map change. The breaks compute from the accepted
 * projection's display copy, so legend and layer always share one version.
 */
export const vizClassify = defineTool({
  name: 'viz_classify',
  description:
    'Classify one loaded map layer by a numeric field: breaks are computed from the layer\'s own rendered data '
    + '(never invented), the legend derives from the same style version, and the map change folds through the '
    + 'standard commit protocol. Rates/densities classify the ratio over a denominator field. Optional time '
    + 'binding gives the layer a workbench timeline. Manual breaks require the exact statistic ref they came from.',
  parameters: {
    layer_id: { type: 'string', required: true, description: 'The layer id to restyle (map_get_state lists them).' },
    field: { type: 'string', required: true, description: 'Numeric property to classify.' },
    unit: { type: 'string', required: true, description: 'Unit the legend labels.' },
    measure: { type: 'string', description: 'total (default), rate, or density.' },
    series_identity: { type: 'string', description: 'observed (default), forecast, or scenario — the identity the legend declares.' },
    denominator_field: { type: 'string', description: 'Positive denominator property; required for rate/density.' },
    classification: { type: 'string', description: 'quantile (default), equal-interval, or manual.' },
    class_count: { type: 'number', description: 'Classes in [2, 12]; 5 is the recorded default.' },
    breaks: { type: 'array', description: 'Manual breaks (with classification=manual); strictly increasing numbers.', items: { type: 'number' } },
    breaks_source_ref: { type: 'string', description: 'Exact statistic ref the manual breaks came from; required for manual.' },
    encoding: { type: 'string', description: 'fill (default) or size — size point encoding needs measure=total.' },
    time_field: { type: 'string', description: 'With timezone/time_from/time_to: enables the layer timeline.' },
    timezone: { type: 'string', description: 'IANA zone the timeline renders in.' },
    granularity: { type: 'string', description: 'hour, day (default), week, or month.' },
    time_from: { type: 'string', description: 'Half-open timeline window start, ISO.' },
    time_to: { type: 'string', description: 'Half-open timeline window end, exclusive.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderVizJson(value),
    presentationMeta: (_args, value) => vizPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { layer_id: layerId } = args as Record<string, unknown>
    if (typeof layerId !== 'string' || layerId.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'layer_id is required')
    }
    const inputs = resolveStyleInputs(args)
    const session = exec.agent?.session
    if (session === undefined || typeof session.id !== 'string') {
      throw new SpatialError('INVALID_ARGUMENT', 'viz_classify requires an agent session caller')
    }
    const layer = requireLayer(mapServiceOf(exec), session, layerId)
    if (inputs.timeBinding !== undefined) requireSomeTime(layer.data, inputs.timeBinding)
    const values = measuredValuesOf(layer.data, inputs)
    const style = styleFromValues(inputs, values)
    return classifyResult({ exec, name: 'viz_classify', layers: [{ layer, style }] })
  },
})

/**
 * `viz_compare`: freeze two loaded layers onto one unified classification
 * domain — the breaks derive from the union of both value sets, so one color
 * always means the same value on both layers — and propose the two-entry
 * `set-style` change.
 */
export const vizCompare = defineTool({
  name: 'viz_compare',
  description:
    'Compare two loaded layers on one unified classification domain: breaks are computed from the union of both '
    + 'layers\' values, and both legends share them, so colors are directly comparable. Per-layer re-classification '
    + 'of a shared ramp is exactly what this refuses. Emits one map change restyling both layers.',
  parameters: {
    layer_a: { type: 'string', required: true, description: 'First layer id.' },
    layer_b: { type: 'string', required: true, description: 'Second layer id; must differ from layer_a.' },
    field: { type: 'string', required: true, description: 'Numeric property to classify on both layers.' },
    unit: { type: 'string', required: true, description: 'Shared unit the legends label.' },
    measure: { type: 'string', description: 'total (default), rate, or density.' },
    series_identity: { type: 'string', description: 'observed (default), forecast, or scenario — the identity both legends declare.' },
    denominator_field: { type: 'string', description: 'Shared positive denominator property; required for rate/density.' },
    classification: { type: 'string', description: 'quantile (default) or equal-interval; manual has no unified-domain semantics.' },
    class_count: { type: 'number', description: 'Classes in [2, 12]; 5 is the recorded default.' },
    encoding: { type: 'string', description: 'fill (default) or size — size point encoding needs measure=total.' },
    time_field: { type: 'string', description: 'With timezone/time_from/time_to: shared timeline binding for both layers.' },
    timezone: { type: 'string', description: 'IANA zone the timeline renders in.' },
    granularity: { type: 'string', description: 'hour, day (default), week, or month.' },
    time_from: { type: 'string', description: 'Half-open timeline window start, ISO.' },
    time_to: { type: 'string', description: 'Half-open timeline window end, exclusive.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderVizJson(value),
    presentationMeta: (_args, value) => vizPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { layer_a: layerA, layer_b: layerB } = args as Record<string, unknown>
    if (typeof layerA !== 'string' || layerA.length === 0 || typeof layerB !== 'string' || layerB.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'layer_a and layer_b are required')
    }
    if (layerA === layerB) {
      throw new SpatialError('INVALID_ARGUMENT', 'layer_a and layer_b must be different layers')
    }
    if (args.classification === 'manual') {
      throw new SpatialError('INVALID_ARGUMENT', 'manual breaks have no unified-domain semantics; compare computes from both layers')
    }
    const inputs = resolveStyleInputs(args)
    const session = exec.agent?.session
    if (session === undefined || typeof session.id !== 'string') {
      throw new SpatialError('INVALID_ARGUMENT', 'viz_compare requires an agent session caller')
    }
    const service = mapServiceOf(exec)
    const layerLeft = requireLayer(service, session, layerA)
    const layerRight = requireLayer(service, session, layerB)
    if (inputs.timeBinding !== undefined) {
      requireSomeTime(layerLeft.data, inputs.timeBinding)
      requireSomeTime(layerRight.data, inputs.timeBinding)
    }
    const left = { values: measuredValuesOf(layerLeft.data, inputs) }
    const right = { values: measuredValuesOf(layerRight.data, inputs) }
    const unified = unifyDomains({
      field: inputs.field,
      unit: inputs.unit,
      measure: inputs.measure,
      seriesIdentity: inputs.seriesIdentity,
      ...(inputs.denominatorField === undefined ? {} : { denominatorField: inputs.denominatorField }),
      encoding: inputs.encoding,
      values: left.values,
      ...(inputs.timeBinding === undefined ? {} : { timeBinding: inputs.timeBinding }),
    }, {
      field: inputs.field,
      unit: inputs.unit,
      measure: inputs.measure,
      seriesIdentity: inputs.seriesIdentity,
      ...(inputs.denominatorField === undefined ? {} : { denominatorField: inputs.denominatorField }),
      encoding: inputs.encoding,
      values: right.values,
      ...(inputs.timeBinding === undefined ? {} : { timeBinding: inputs.timeBinding }),
    }, inputs.classification === 'manual' ? 'quantile' : inputs.classification, inputs.classCount)
    requireCleanInputs(validateStyleSpec(unified.styleLeft))
    requireCleanInputs(validateStyleSpec(unified.styleRight))
    return classifyResult({
      exec,
      name: 'viz_compare',
      layers: [
        { layer: layerLeft, style: unified.styleLeft },
        { layer: layerRight, style: unified.styleRight },
      ],
    })
  },
})

/**
 * `viz_aggregate`: bin one registered resource version into a deterministic
 * lon/lat grid and add the bounded aggregate as a display layer. The layer's
 * style classifies the per-cell measure with the same honest machinery as
 * every viz layer, and the result declares its display-aggregate identity
 * (source ref, cell size, measure) so it is never mistaken for analysis
 * input. Oversized resources stream through the incremental scanner and
 * accumulator; identical inputs produce identical layers.
 */
export const vizAggregate = defineTool({
  name: 'viz_aggregate',
  description:
    'Aggregate one registered resource version into a deterministic lon/lat grid and add it as a bounded display '
    + 'layer: per-cell count, or sum over one numeric field, classified honestly for the legend. The layer declares '
    + 'its display-aggregate identity (source ref, cell size, measure) — it is for seeing distribution, never for '
    + 'analysis math. Oversized resources stream feature by feature; identical inputs produce identical layers.',
  parameters: {
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) to aggregate.' },
    layer_id: { type: 'string', required: true, description: 'The aggregate layer id to add (map_get_state lists taken ids).' },
    layer_name: { type: 'string', description: 'Display name; defaults to the layer id.' },
    cell_size: { type: 'number', required: true, description: 'Grid cell edge in degrees (positive, e.g. 0.5 or 0.05).' },
    measure: { type: 'string', description: 'count (default) or sum — sum needs value_field.' },
    value_field: { type: 'string', description: 'Numeric property summed per cell (required for measure=sum).' },
    unit: { type: 'string', required: true, description: 'Unit the legend labels for the cell measure.' },
    max_cells: { type: 'number', description: 'Cell cap in [1, 20000]; 20000 is the recorded limit. Coarser grid on refusal.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderVizJson(value),
    presentationMeta: (_args, value) => vizPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const record = args as Record<string, unknown>
    const { resource_ref: resourceRef, layer_id: layerId } = record
    if (typeof resourceRef !== 'string' || resourceRef.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'resource_ref must be an exact resource ref res-…@vN')
    }
    if (typeof layerId !== 'string' || layerId.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'layer_id is required')
    }
    parseCatalogRef(resourceRef)
    const cellSize = record.cell_size
    if (typeof cellSize !== 'number' || !Number.isFinite(cellSize) || cellSize <= 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'cell_size must be a positive finite number of degrees')
    }
    const maxCells = typeof record.max_cells === 'number' ? record.max_cells : MAX_VIZ_AGGREGATE_CELLS
    if (!Number.isInteger(maxCells) || maxCells < 1 || maxCells > MAX_VIZ_AGGREGATE_CELLS) {
      throw new SpatialError('INVALID_ARGUMENT', `max_cells must be an integer in [1, ${String(MAX_VIZ_AGGREGATE_CELLS)}]`)
    }
    const measure = record.measure === undefined ? 'count' : record.measure
    if (measure !== 'count' && measure !== 'sum') {
      throw new SpatialError('INVALID_ARGUMENT', 'measure must be count or sum')
    }
    const field = typeof record.value_field === 'string' ? record.value_field : undefined
    if (measure === 'sum' && (field === undefined || field.length === 0)) {
      throw new SpatialError('INVALID_ARGUMENT', 'measure=sum requires value_field')
    }
    const unit = record.unit
    if (typeof unit !== 'string' || unit.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'unit is required')
    }

    const session = sessionOf(exec)
    const catalog = catalogServiceOf(exec)
    const pending = requirePendingPublish(exec, catalog, session as Parameters<typeof requirePendingPublish>[2], 'viz_aggregate')
    const resolved = await catalog.resolve({ ref: resourceRef, authorization: catalog.deploymentDomain() })

    const aggregateParams: GridAggregateParams = {
      cellSizeDeg: cellSize,
      measure,
      maxCells,
      ...(field === undefined ? {} : { field }),
    }
    const aggregator = createGridAggregator(aggregateParams)
    if (resolved.resource.byteCount > MAX_VIZ_INMEMORY_BYTES) {
      if (resolved.resource.byteCount > MAX_VIZ_STREAM_BYTES) {
        throw new SpatialError('INVALID_ARGUMENT', `resource ${resourceRef} (${String(resolved.resource.byteCount)} bytes) exceeds the ${String(MAX_VIZ_STREAM_BYTES)} byte streaming aggregation limit`)
      }
      const scanner = createFeatureCollectionScanner({ maxBytes: MAX_VIZ_STREAM_BYTES }, feature => aggregator.push(feature))
      await catalog.readResourceChunks(resourceRef, catalog.deploymentDomain(), { maxBytes: MAX_VIZ_STREAM_BYTES, chunkBytes: VIZ_STREAM_CHUNK_BYTES }, chunk => scanner.push(chunk))
      scanner.end()
    } else {
      const { bytes } = await catalog.readResourceBytes(resourceRef, catalog.deploymentDomain(), MAX_VIZ_RESOURCE_BYTES)
      const admitted = admitCollection(bytes, { enforceWgs84Range: true })
      const collection = admitted.collection as GeoJsonFeatureCollection
      for (const feature of collection.features) {
        aggregator.push(feature as unknown as Record<string, unknown>)
      }
    }
    exec.signal.throwIfAborted()
    const aggregate = aggregator.result()

    // The cell measure classifies with the standard machinery: total measure
    // over the count/sum property, so legend honesty is inherited, not re-invented.
    const styleField = measure === 'sum' ? 'sum' : 'count'
    const style = styleFromValues(resolveStyleInputs({
      field: styleField,
      unit,
      measure: 'total',
      classification: 'quantile',
      class_count: 5,
      series_identity: 'observed',
      encoding: 'fill',
    }), aggregate.cells.map(cell => styleField === 'sum' ? cell.properties.sum as number : cell.properties.count))

    const aggregateCollection: GeoJsonFeatureCollection = {
      type: 'FeatureCollection',
      features: aggregate.cells as unknown as GeoJsonFeatureCollection['features'],
    }
    const aggregateBytes = new TextEncoder().encode(JSON.stringify(aggregateCollection))
    const published = await catalog.publishArtifact({
      bytes: aggregateBytes,
      inputRefs: [resourceRef],
      method: {
        algorithm: 'viz-grid-aggregate',
        units: measure === 'sum' ? `sum(${field as string})` : 'count',
        parameters: { cellSizeDeg: cellSize, measure, maxCells },
      },
      analysisCrs: 'EPSG:4326',
      sessionId: session.id,
      sourceCallSeq: pending.callSeq,
      inputAuthorizations: [resolved.resource.authorization],
    })

    const layerNameRaw = record.layer_name
    const layer: MapProjectedLayer = {
      id: layerId,
      name: typeof layerNameRaw === 'string' && layerNameRaw.length > 0 ? layerNameRaw : layerId,
      data: aggregateCollection,
      sourceCrs: 'EPSG:4326',
      opacity: 1,
      visible: true,
      sourceCallSeq: pending.callSeq,
      style,
    }
    const service = mapServiceOf(exec)
    const state = service.stateOf(session)
    const change = { op: 'add-layer', layer } as const
    const targetRevision = validateMapChangeCandidate(state, change)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return {
      layer_id: layerId,
      artifact_ref: published.artifact.ref,
      source_ref: resourceRef,
      cell_size: cellSize,
      measure,
      cell_count: aggregate.cells.length,
      matched: aggregate.matched,
      skipped: aggregate.skipped,
      identity: 'display-aggregate',
      limitations: VIZ_LIMITATIONS,
      map_revision_target: targetRevision,
      meta,
    } as unknown as JsonValue
  },
})
