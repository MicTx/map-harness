/** Versioned visualization intent, independent of renderer and persisted StyleSpec. @module */
import { isTimestamp, isTimezone, type TimeBinding, type VizIssue, type VizMeasure } from './contract.ts'

/** Version of the method catalog and recommendation vocabulary. */
export const VISUALIZATION_SCHEMA_VERSION = 1

/** Stable method identities; an identity does not imply runtime support. */
export const VISUALIZATION_TYPES = [
  'single-symbol', 'unique-value', 'choropleth', 'graduated-color', 'graduated-symbol', 'proportional-symbol',
  'dot-density', 'bivariate', 'cartogram', 'heatmap', 'kernel-density', 'grid', 'hexbin',
  'h3', 'point-cluster', 'contour', 'isoband', 'raster', 'hillshade', 'terrain', 'slope',
  'viewshed', 'line-of-sight', 'network-accessibility', 'flow-summary', 'flow-map', 'od-arc', 'trajectory',
  'animated-trips', 'time-animation', 'temporal-change', 'space-time-cube', 'small-multiples',
  'swipe', 'comparison', 'hotspot', 'local-autocorrelation', 'space-time-cluster',
  'extrusion', 'point-cloud', 'volume', 'vector-field', 'uncertainty', 'forecast', 'realtime',
] as const

/** One catalog method identity. */
export type VisualizationType = typeof VISUALIZATION_TYPES[number]

/** Questions the deterministic router distinguishes, not substring matches. */
export const VISUALIZATION_SCENARIOS = [
  'locate', 'category', 'magnitude', 'density', 'aggregation', 'compare', 'change', 'flow',
  'trajectory', 'hotspot', 'autocorrelation', 'cluster', 'accessibility', 'terrain',
  'visibility', 'surface', 'forecast', 'realtime', 'uncertainty',
] as const

/** One user-selected analysis question. */
export type VisualizationScenario = typeof VISUALIZATION_SCENARIOS[number]

/** Geometry families a method accepts. */
export type VisualizationGeometry = 'point' | 'line' | 'polygon' | 'raster' | 'mesh' | 'unknown'

/** Renderer-independent intent; validation does not certify the underlying data. */
export interface VisualizationSpec {
  readonly schemaVersion: typeof VISUALIZATION_SCHEMA_VERSION
  readonly type: VisualizationType
  readonly field?: string
  readonly unit?: string
  readonly measure?: VizMeasure
  readonly denominatorField?: string
  readonly timeBinding?: TimeBinding
}

const textSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '\\S' } as const
const offsetTimestampPattern = '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)$'
const timestampSchema = { ...textSchema, format: 'date-time', pattern: offsetTimestampPattern } as const

/** Structural JSON Schema; validateVisualizationSpec additionally checks calendar dates, timezone and window order. */
export const VISUALIZATION_SPEC_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'Spatial visualization intent',
  description: 'Structural validation only. Consumers must also run validateVisualizationSpec for real calendar dates, IANA timezones and increasing windows.',
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'type'],
  properties: {
    schemaVersion: { const: VISUALIZATION_SCHEMA_VERSION },
    type: { type: 'string', enum: VISUALIZATION_TYPES },
    field: textSchema,
    unit: textSchema,
    measure: { type: 'string', enum: ['total', 'rate', 'density'] },
    denominatorField: textSchema,
    timeBinding: {
      type: 'object', additionalProperties: false,
      required: ['timeField', 'timezone', 'granularity', 'window'],
      properties: {
        timeField: textSchema, timezone: textSchema,
        granularity: { type: 'string', enum: ['hour', 'day', 'week', 'month'] },
        window: {
          type: 'object', additionalProperties: false, required: ['from', 'to'],
          properties: { from: timestampSchema, to: timestampSchema },
        },
      },
    },
  },
  allOf: [{
    if: { properties: { measure: { enum: ['rate', 'density'] } }, required: ['measure'] },
    then: { required: ['field', 'unit', 'denominatorField'] },
    else: { not: { required: ['denominatorField'] } },
  }],
} as const

/**
 * Validate one raw visualization intent, including temporal and denominator semantics.
 * @param value - untrusted parsed JSON.
 * @returns all named structural and semantic issues; empty means valid intent.
 */
export function validateVisualizationSpec(value: unknown): readonly VizIssue[] {
  if (!isRecord(value)) return [{ field: '', code: 'expected-object' }]
  const issues: VizIssue[] = []
  const allowed = Object.keys(VISUALIZATION_SPEC_SCHEMA.properties)
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push({ field: key, code: 'unknown-field' })
  }
  if (value.schemaVersion !== VISUALIZATION_SCHEMA_VERSION) issues.push({ field: 'schemaVersion', code: 'unknown-schema-version' })
  if (!VISUALIZATION_TYPES.some(type => type === value.type)) issues.push({ field: 'type', code: 'unknown-method' })
  for (const key of ['field', 'unit', 'denominatorField']) {
    if (value[key] !== undefined && !boundedText(value[key])) issues.push({ field: key, code: 'invalid-text' })
  }
  if (value.measure !== undefined && !['total', 'rate', 'density'].some(measure => measure === value.measure)) {
    issues.push({ field: 'measure', code: 'unknown-measure' })
  }
  if (value.measure === 'rate' || value.measure === 'density') {
    for (const key of ['field', 'unit', 'denominatorField']) {
      if (!boundedText(value[key])) issues.push({ field: key, code: 'required-for-ratio' })
    }
  } else if (value.denominatorField !== undefined) {
    issues.push({ field: 'denominatorField', code: 'unexpected-denominator' })
  }
  if (value.timeBinding !== undefined && !validTimeBinding(value.timeBinding)) issues.push({ field: 'timeBinding', code: 'invalid-time-binding' })
  return issues
}

/**
 * Check an explicit timezone, calendar bin and increasing half-open window.
 * @param value - untrusted time-binding record.
 * @returns whether all required fields and semantic constraints hold.
 */
export function validTimeBinding(value: unknown): value is TimeBinding {
  if (!isRecord(value) || !isRecord(value.window)) return false
  return onlyKeys(value, ['timeField', 'timezone', 'granularity', 'window'])
    && onlyKeys(value.window, ['from', 'to'])
    && boundedText(value.timeField) && boundedText(value.timezone) && isTimezone(value.timezone)
    && ['hour', 'day', 'week', 'month'].some(granularity => granularity === value.granularity)
    && typeof value.window.from === 'string' && typeof value.window.to === 'string'
    && isVisualizationTimestamp(value.window.from) && isVisualizationTimestamp(value.window.to)
    && Date.parse(value.window.from) < Date.parse(value.window.to)
}

/**
 * Accept ISO date-times with explicit offsets and real calendar dates.
 * @param value - one observed timestamp or window endpoint.
 * @returns whether the timestamp is unambiguous and parseable.
 */
export function isVisualizationTimestamp(value: string): boolean {
  if (!new RegExp(offsetTimestampPattern, 'u').test(value) || !isTimestamp(value)) return false
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(5, 7))
  const day = Number(value.slice(8, 10))
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day <= (days[month - 1] ?? 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key))
}
