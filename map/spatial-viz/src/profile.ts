/** Read-only field summaries over already-admitted display data. @module */
import { isVisualizationTimestamp, type VisualizationGeometry } from './schema.ts'

/** Minimal read face accepted from the map projection; coordinates are not revalidated here. */
export interface VisualizationFeature {
  readonly geometry?: { readonly type: string } | null
  readonly properties?: Readonly<Record<string, unknown>> | null
}

/** Exact counts for one selected field; absent and null values are not present. */
export interface VisualizationFieldProfile {
  readonly name: string
  readonly present: number
  readonly numeric: number
  readonly positive: number
  readonly nonnegative: number
  readonly timestamps: number
  /** Nonempty string identities accepted by the movement-analysis tools. */
  readonly identities: number
  /** Distinct scalar values, capped at two: enough to detect constant numeric fields. */
  readonly distinct: number
  readonly numericDistinct: number
  /** Valid timestamps inside the requested half-open window, when one was supplied. */
  readonly inWindow?: number
}

/** Data facts the router consumes; derived without coercion or missing-value imputation. */
export interface VisualizationDataProfile {
  /** Applies to field distinct/numericDistinct counts and ratio.distinct. */
  readonly distinctCountSemantics: string
  readonly featureCount: number
  readonly geometry: readonly VisualizationGeometry[]
  readonly fields: readonly VisualizationFieldProfile[]
  readonly ratio?: { readonly field: string; readonly denominatorField: string; readonly valid: number; readonly distinct: number }
}

/** Optional joint-value and observation-window checks for a recommendation. */
export interface VisualizationProfileOptions {
  readonly field?: string
  readonly denominatorField?: string
  readonly window?: { readonly from: string; readonly to: string }
}

/**
 * Summarize selected fields of already-admitted features without mutating them.
 * @param features - accepted display features, not arbitrary imported GeoJSON.
 * @param fields - selected field names; duplicate names are summarized once.
 * @param options - joint ratio fields and optional half-open observation window.
 * @returns counts over all rows; distinct values saturate at two.
 */
export function profileVisualizationData(
  features: readonly VisualizationFeature[],
  fields: readonly string[],
  options: VisualizationProfileOptions = {},
): VisualizationDataProfile {
  const ratio = options.field === undefined || options.denominatorField === undefined
    ? undefined : ratioOf(features, options.field, options.denominatorField)
  return {
    distinctCountSemantics: 'distinct, numericDistinct and ratio.distinct are capped at 2: 0 and 1 are exact; 2 means at least 2 distinct values, not an exact count.',
    featureCount: features.length,
    geometry: [...new Set(features.map(feature => geometryOf(feature.geometry?.type)))].sort(),
    fields: [...new Set(fields)].map(name => fieldProfileOf(features, name, options.window)),
    ...(ratio === undefined ? {} : { ratio }),
  }
}

function geometryOf(type: string | undefined): VisualizationGeometry {
  switch (type) {
    case 'Point': case 'MultiPoint': return 'point'
    case 'LineString': case 'MultiLineString': return 'line'
    case 'Polygon': case 'MultiPolygon': return 'polygon'
    default: return 'unknown'
  }
}

function fieldProfileOf(
  features: readonly VisualizationFeature[], name: string, window: VisualizationProfileOptions['window'],
): VisualizationFieldProfile {
  let present = 0
  let numeric = 0
  let positive = 0
  let nonnegative = 0
  let timestamps = 0
  let identities = 0
  let inWindow = 0
  const distinct = new Set<unknown>()
  const numericValues = new Set<number>()
  for (const feature of features) {
    const properties = feature.properties
    const value = properties !== undefined && properties !== null && Object.hasOwn(properties, name) ? properties[name] : undefined
    if (value === undefined || value === null) continue
    present += 1
    if (typeof value === 'number' && Number.isFinite(value)) {
      numeric += 1
      if (value > 0) positive += 1
      if (value >= 0) nonnegative += 1
      if (numericValues.size < 2) numericValues.add(value)
    }
    if (typeof value === 'string' && value.trim().length > 0) identities += 1
    if (typeof value === 'string' && isVisualizationTimestamp(value)) {
      timestamps += 1
      if (window !== undefined && Date.parse(value) >= Date.parse(window.from) && Date.parse(value) < Date.parse(window.to)) inWindow += 1
    }
    if (distinct.size < 2 && ['string', 'number', 'boolean'].includes(typeof value)) distinct.add(value)
  }
  return {
    name, present, numeric, positive, nonnegative, timestamps, identities, distinct: distinct.size, numericDistinct: numericValues.size,
    ...(window === undefined ? {} : { inWindow }),
  }
}

function valueOf(feature: VisualizationFeature, name: string): unknown {
  return feature.properties !== undefined && feature.properties !== null && Object.hasOwn(feature.properties, name)
    ? feature.properties[name] : undefined
}

function ratioOf(features: readonly VisualizationFeature[], field: string, denominatorField: string): NonNullable<VisualizationDataProfile['ratio']> {
  let valid = 0
  const values = new Set<number>()
  for (const feature of features) {
    const numerator = valueOf(feature, field)
    const denominator = valueOf(feature, denominatorField)
    if (typeof numerator !== 'number' || !Number.isFinite(numerator)
      || typeof denominator !== 'number' || !Number.isFinite(denominator) || denominator <= 0) continue
    const ratio = numerator / denominator
    if (!Number.isFinite(ratio)) continue
    valid += 1
    if (values.size < 2) values.add(ratio)
  }
  return { field, denominatorField, valid, distinct: values.size }
}
