/** Read-only method discovery and recommendation over accepted session map data. @module */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { MapContainerService, MapProjectedLayer } from '@map-harness/map-container'
import {
  VISUALIZATION_CATALOG, VISUALIZATION_SCENARIOS, VISUALIZATION_TYPES,
  profileVisualizationData, routeVisualization, validTimeBinding,
  type VisualizationDataProfile,
} from '@map-harness/spatial-viz'
import { z } from 'zod'
import { catalogServiceOf, sessionOf } from './catalog-tools.ts'
import { COPY_LIMIT_NOTE, GovernanceError } from '@map-harness/spatial-catalog'
import { renderJson } from './output.ts'
import { serviceOf } from './service-context.ts'
import { SpatialError } from './spatial-errors.ts'

const nameInput = z.string().trim().min(1).max(128)
const timeInput = z.object({
  timeField: nameInput.describe('Property containing ISO timestamps with offsets.'),
  timezone: nameInput.describe('IANA timezone; statistical bins require UTC.'),
  granularity: z.enum(['hour', 'day', 'week', 'month']).describe('Time bin; statistical analysis supports day, week or month.'),
  window: z.object({
    from: nameInput.describe('Inclusive ISO timestamp with offset.'),
    to: nameInput.describe('Exclusive ISO timestamp with offset, later than from.'),
  }).strict().describe('Half-open observation window [from,to).'),
}).strict()

/** Shared direct/MCP argument validation; data profiles cannot be supplied by the caller. */
export const vizRecommendInput = z.object({
  scenario: z.enum(VISUALIZATION_SCENARIOS).describe('Question: locate, category, magnitude, density, aggregation, compare, change, flow, trajectory, hotspot, autocorrelation, cluster, accessibility, terrain, visibility, surface, forecast, realtime, uncertainty.'),
  type: z.enum(VISUALIZATION_TYPES).optional().describe('Optional exact catalog type to check; an unsupported or incompatible type is never silently replaced.'),
  layer_id: nameInput.optional().describe('Loaded layer id. Omit to discover methods and unmet data requirements.'),
  comparison_layer_id: nameInput.optional().describe('Second distinct loaded layer for compare, using the same field, unit and measure.'),
  field: nameInput.optional().describe('Numeric property; for density, an optional nonnegative weight property.'),
  unit: nameInput.optional().describe('Explicit value or ratio unit; required for numeric classification and analysis.'),
  measure: z.enum(['total', 'rate', 'density']).optional().describe('total (default), or field/denominator_field for rate/density; never inferred from a field name.'),
  denominator_field: nameInput.optional().describe('Positive denominator property for rate/density. Not accepted with total.'),
  entity_field: nameInput.optional().describe('Entity identity property for observed point transitions.'),
  time_binding: timeInput.optional().describe('Time field, timezone, granularity and nested window:{from,to}; ISO offsets define [from,to). Statistical bins use UTC.'),
}).strict()

/** Structural JSON Schema generated from the direct/MCP validator. */
export const VIZ_RECOMMEND_INPUT_SCHEMA = z.toJSONSchema(vizRecommendInput, { target: 'draft-07' })

function descriptionOf(key: keyof z.infer<typeof vizRecommendInput>, input: z.ZodType = vizRecommendInput.shape[key]): string {
  const description = input.description
  if (description === undefined) throw new Error(`missing viz_recommend parameter description: ${key}`)
  return description
}

function profileOf(layer: MapProjectedLayer | undefined, args: z.infer<typeof vizRecommendInput>): VisualizationDataProfile | null {
  if (layer === undefined) return null
  if (layer.imagery !== undefined) return { ...profileVisualizationData([], []), geometry: ['raster'] }
  if (layer.data === undefined) return null
  const fields = [args.field, args.denominator_field, args.entity_field, args.time_binding?.timeField]
    .filter((field): field is string => field !== undefined)
  return profileVisualizationData(layer.data.features, fields, {
    ...(args.field === undefined ? {} : { field: args.field }),
    ...(args.denominator_field === undefined ? {} : { denominatorField: args.denominator_field }),
    ...(args.time_binding === undefined ? {} : { window: args.time_binding.window }),
  })
}

/** Choose a method from actual session data; emit no mutation or analysis metadata. */
export const vizRecommend = defineTool({
  name: 'viz_recommend',
  description: 'Choose spatial/temporal visualization and analysis methods from the question and actual loaded data. Returns the method, support/output kind, data gaps, limitations and ordered next tools. Omit layer_id to discover methods. Recommendation only: does not run analysis or change the map. Heatmaps are descriptive, not hotspot significance.',
  parameters: {
    scenario: { type: 'string', enum: VISUALIZATION_SCENARIOS, required: true, description: descriptionOf('scenario') },
    type: { type: 'string', enum: VISUALIZATION_TYPES, description: descriptionOf('type') },
    layer_id: { type: 'string', description: descriptionOf('layer_id') },
    comparison_layer_id: { type: 'string', description: descriptionOf('comparison_layer_id') },
    field: { type: 'string', description: descriptionOf('field') },
    unit: { type: 'string', description: descriptionOf('unit') },
    measure: { type: 'string', enum: ['total', 'rate', 'density'], description: descriptionOf('measure') },
    denominator_field: { type: 'string', description: descriptionOf('denominator_field') },
    entity_field: { type: 'string', description: descriptionOf('entity_field') },
    time_binding: {
      type: 'object', additionalProperties: false, description: descriptionOf('time_binding'),
      properties: {
        timeField: { type: 'string', required: true, description: descriptionOf('time_binding', timeInput.shape.timeField) },
        timezone: { type: 'string', required: true, description: descriptionOf('time_binding', timeInput.shape.timezone) },
        granularity: { type: 'string', required: true, enum: timeInput.shape.granularity.options, description: descriptionOf('time_binding', timeInput.shape.granularity) },
        window: {
          type: 'object', required: true, additionalProperties: false, description: descriptionOf('time_binding', timeInput.shape.window),
          properties: {
            from: { type: 'string', required: true, description: descriptionOf('time_binding', timeInput.shape.window.shape.from) },
            to: { type: 'string', required: true, description: descriptionOf('time_binding', timeInput.shape.window.shape.to) },
          },
        },
      },
    },
  },
  output: { schema: { type: 'json' }, render: (_args, value) => renderJson(value) },
  isConcurrencySafe: () => true,
  async execute(raw, exec) {
    const parsed = vizRecommendInput.safeParse(raw)
    if (!parsed.success) throw new SpatialError('INVALID_ARGUMENT', 'invalid visualization request: ' + parsed.error.issues.map(issue => issue.path.join('.') + ' (' + issue.code + ')').join('; '))
    const args = parsed.data
    if (args.time_binding !== undefined && !validTimeBinding(args.time_binding)) throw new SpatialError('INVALID_ARGUMENT', 'invalid time_binding: supply an IANA timezone and increasing ISO window with offsets')
    if ((args.measure ?? 'total') === 'total' && args.denominator_field !== undefined) throw new SpatialError('INVALID_ARGUMENT', 'denominator_field is not accepted with total')
    const session = sessionOf(exec)
    exec.signal.throwIfAborted()
    const map = serviceOf<MapContainerService>(exec, 'map')
    if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map container service is unavailable')
    const state = map.stateOf(session)
    const layer = state.layers.find(entry => entry.id === args.layer_id)
    const comparison = args.comparison_layer_id === args.layer_id ? undefined
      : state.layers.find(entry => entry.id === args.comparison_layer_id)
    for (const entry of [layer, comparison]) {
      const ref = entry?.resourceRef ?? entry?.artifactRef
      if (ref === undefined) continue
      const availability = await catalogServiceOf(exec).refStateOf(ref)
      exec.signal.throwIfAborted()
      if (availability !== 'available') {
        const code = availability === 'recalled' ? 'GOVERNANCE_RECALLED'
          : availability === 'revoked' ? 'GOVERNANCE_REVOKED'
          : availability === 'tombstoned' ? 'GOVERNANCE_TOMBSTONED' : 'GOVERNANCE_DENIED'
        throw new GovernanceError(code, `visualization input is unavailable for future use; ${COPY_LIMIT_NOTE}`)
      }
    }
    const profile = profileOf(layer, args)
    const comparisonProfile = profileOf(comparison, args)
    const recommendation = routeVisualization({
      scenario: args.scenario, profile, measure: args.measure ?? 'total',
      hasResourceRef: layer?.resourceRef !== undefined,
      hasClassification: layer?.style !== undefined, hasSurface: layer?.terrain !== undefined,
      hasRasterTiles: layer?.imagery !== undefined, mode: state.mode,
      ...(args.type === undefined ? {} : { preferredType: args.type }),
      ...(args.field === undefined ? {} : { field: args.field }),
      ...(args.unit === undefined ? {} : { unit: args.unit }),
      ...(args.denominator_field === undefined ? {} : { denominatorField: args.denominator_field }),
      ...(args.entity_field === undefined ? {} : { entityField: args.entity_field }),
      ...(args.time_binding === undefined ? {} : { timeBinding: args.time_binding }),
      ...(comparisonProfile === null ? {} : { comparisonProfile }),
    })
    const result = {
      ...recommendation,
      source: { map_revision: state.revision, layer_id: layer?.id ?? null,
        resource_ref: layer?.resourceRef ?? null, artifact_ref: layer?.artifactRef ?? null,
        display_digest: layer?.displayDigest ?? null, comparison_layer_id: comparison?.id ?? null },
      data_profile: profile,
      methods: VISUALIZATION_CATALOG.filter(method => method.scenarios.includes(args.scenario))
        .map(method => ({ id: method.id, label: method.label, support: method.support, output: method.output })),
    }
    const serialized = JSON.stringify(result)
    if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) throw new SpatialError('RESOURCE_TOO_LARGE', 'visualization recommendation exceeds 16384 bytes')
    exec.signal.throwIfAborted()
    return JSON.parse(serialized) as JsonValue
  },
})
