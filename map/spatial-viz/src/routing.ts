/** Deterministic method selection from explicit questions and measured data facts. @module */
import type { TimeBinding, VizMeasure } from './contract.ts'
import { visualizationOf, type VisualizationMethod } from './catalog.ts'
import { validTimeBinding, VISUALIZATION_SCHEMA_VERSION, type VisualizationScenario, type VisualizationType } from './schema.ts'
import type { VisualizationDataProfile, VisualizationFieldProfile } from './profile.ts'

/** Data and question facts supplied by the owning tool, never inferred from field names. */
export interface VisualizationRouteRequest {
  readonly scenario: VisualizationScenario
  readonly preferredType?: VisualizationType
  readonly profile: VisualizationDataProfile | null
  readonly field?: string
  readonly unit?: string
  readonly measure: VizMeasure
  readonly denominatorField?: string
  readonly entityField?: string
  readonly timeBinding?: TimeBinding
  readonly hasResourceRef: boolean
  readonly hasClassification?: boolean
  readonly hasSurface?: boolean
  readonly hasRasterTiles?: boolean
  readonly mode: 'map' | 'scene'
  readonly comparisonProfile?: VisualizationDataProfile
}

/** A recommendation is method selection only; analysis remains a separate tool execution. */
export interface VisualizationRecommendation {
  readonly schemaVersion: typeof VISUALIZATION_SCHEMA_VERSION
  readonly scenario: VisualizationScenario
  readonly status: 'recommended' | 'needs-data' | 'unsupported'
  readonly primary: VisualizationMethod
  readonly alternatives: readonly VisualizationType[]
  readonly gaps: readonly string[]
  readonly preconditions: readonly string[]
  readonly nextTools: readonly string[]
  readonly warnings: readonly string[]
  readonly analysisExecuted: false
}

const DEFAULT_METHODS: Readonly<Record<VisualizationScenario, VisualizationType>> = {
  locate: 'single-symbol', category: 'unique-value', magnitude: 'graduated-symbol', density: 'heatmap',
  aggregation: 'grid', compare: 'comparison', change: 'temporal-change', flow: 'flow-summary',
  trajectory: 'trajectory', hotspot: 'hotspot', autocorrelation: 'local-autocorrelation',
  cluster: 'space-time-cluster', accessibility: 'network-accessibility', terrain: 'terrain',
  visibility: 'viewshed', surface: 'contour', forecast: 'forecast', realtime: 'realtime', uncertainty: 'uncertainty',
}

/**
 * Choose one method without executing analysis or changing the map.
 * @param request - explicit question, current display facts and field bindings.
 * @returns selected method, unmet conditions and ordered tools; unsupported methods have no tools.
 */
export function routeVisualization(request: VisualizationRouteRequest): VisualizationRecommendation {
  const type = request.preferredType ?? defaultTypeOf(request)
  const primary = visualizationOf(type)
  if (primary === undefined) throw new Error(`unknown visualization type ${type}`)
  const gaps = dataGaps(request, primary)
  const warnings = dataWarnings(request, primary)
  return {
    schemaVersion: VISUALIZATION_SCHEMA_VERSION,
    scenario: request.scenario,
    status: primary.support === 'unsupported' ? 'unsupported' : gaps.length > 0 ? 'needs-data' : 'recommended',
    primary,
    alternatives: primary.alternatives,
    gaps,
    preconditions: primary.preconditions,
    nextTools: primary.support === 'unsupported' ? [] : primary.tools,
    warnings: [...primary.limitations, ...warnings, 'Recommendation only; no analysis, significance test or map mutation has run.'],
    analysisExecuted: false,
  }
}

function defaultTypeOf(request: VisualizationRouteRequest): VisualizationType {
  if (request.scenario === 'surface' && request.hasRasterTiles) return 'raster'
  if (request.scenario === 'magnitude' && request.measure !== 'total') {
    return request.profile?.geometry.length === 1 && request.profile.geometry[0] === 'polygon' ? 'choropleth' : 'graduated-color'
  }
  return DEFAULT_METHODS[request.scenario]
}

function dataGaps(request: VisualizationRouteRequest, method: VisualizationMethod): readonly string[] {
  const gaps: string[] = []
  if (!method.scenarios.includes(request.scenario)) gaps.push('method-does-not-answer-scenario')
  if (method.support === 'unsupported') return gaps
  const profile = request.profile
  if (profile === null || (profile.featureCount === 0 && !request.hasRasterTiles)) return [...gaps, 'loaded-data']
  if (profile.geometry.length === 0 || profile.geometry.some(geometry => !method.geometry.includes(geometry))) gaps.push('incompatible-geometry')
  if (method.id === 'graduated-symbol' && !allPoints(profile)) gaps.push('point-geometry-for-total-symbols')
  if (method.id === 'choropleth' && request.measure === 'total') gaps.push('normalization-for-area-comparison')
  if (method.requirements.includes('total') && request.measure !== 'total') gaps.push('total-measure-required')
  if (method.requirements.includes('numeric')) checkNumeric(request, profile, gaps)
  if (method.support === 'analysis' && request.measure !== 'total') gaps.push('analysis-requires-explicit-ratio-resource')
  if (method.requirements.includes('weight') && request.field !== undefined) {
    const field = fieldOf(profile, request.field)
    if (field === undefined || field.nonnegative !== profile.featureCount) gaps.push('finite-nonnegative-weight-on-every-feature')
  }
  if (method.requirements.includes('time')) checkTime(request, profile, gaps, method.support === 'analysis')
  if (method.requirements.includes('entity')) {
    const field = fieldOf(profile, request.entityField)
    if (field === undefined || field.identities !== profile.featureCount) gaps.push('entity-string-on-every-observation')
  }
  if (method.requirements.includes('resource') && !request.hasResourceRef) gaps.push('versioned-resource-ref')
  if (method.requirements.includes('surface') && !request.hasSurface) gaps.push('versioned-surface-with-datum-and-units')
  if (method.requirements.includes('tiles') && !request.hasRasterTiles) gaps.push('key-free-xyz-imagery')
  if (method.requirements.includes('2d') && request.mode !== 'map') gaps.push('2d-map-mode')
  if (method.requirements.includes('unclassified') && request.hasClassification) gaps.push('heatmap-conflicts-with-classification')
  if (method.requirements.includes('eight') && (fieldOf(profile, request.field)?.numeric ?? 0) < 8) gaps.push('at-least-eight-numeric-point-observations')
  if (method.requirements.includes('network')) gaps.push('network-provider-population-and-facility-inputs-not-verified')
  if (method.requirements.includes('stream')) gaps.push('stream-scenario-and-event-source-not-verified')
  if (method.requirements.includes('compare')) checkComparison(request, gaps)
  return [...new Set(gaps)]
}

function fieldOf(profile: VisualizationDataProfile, name: string | undefined): VisualizationFieldProfile | undefined {
  return name === undefined ? undefined : profile.fields.find(field => field.name === name)
}

function allPoints(profile: VisualizationDataProfile): boolean {
  return profile.geometry.length === 1 && profile.geometry[0] === 'point'
}

function checkNumeric(request: VisualizationRouteRequest, profile: VisualizationDataProfile, gaps: string[]): void {
  const field = fieldOf(profile, request.field)
  if (!request.unit?.trim()) gaps.push('explicit-value-unit')
  if (field === undefined || field.numeric === 0) gaps.push('numeric-field')
  if (request.measure === 'total') {
    if (request.denominatorField !== undefined) gaps.push('unexpected-denominator')
    if (field !== undefined && field.numericDistinct < 2) gaps.push('nonconstant-numeric-field')
    return
  }
  const denominator = fieldOf(profile, request.denominatorField)
  if (denominator === undefined || denominator.positive === 0) gaps.push('positive-denominator-field')
  const ratio = profile.ratio
  if (ratio === undefined || ratio.field !== request.field || ratio.denominatorField !== request.denominatorField
    || ratio.valid === 0 || ratio.distinct < 2) gaps.push('nonconstant-joint-ratio-values')
}

function checkTime(request: VisualizationRouteRequest, profile: VisualizationDataProfile, gaps: string[], statistical: boolean): void {
  if (!validTimeBinding(request.timeBinding)) {
    gaps.push('explicit-time-binding')
    return
  }
  const field = fieldOf(profile, request.timeBinding.timeField)
  if (field === undefined || field.timestamps === 0) gaps.push('parseable-timestamps')
  if ((field?.inWindow ?? 0) === 0) gaps.push('observations-inside-time-window')
  if (request.scenario !== 'realtime' && field !== undefined && field.timestamps !== profile.featureCount) gaps.push('valid-time-on-every-observation')
  if (statistical && request.timeBinding.timezone !== 'UTC') gaps.push('utc-statistical-bins')
  if (statistical && request.timeBinding.granularity === 'hour') gaps.push('day-week-month-statistical-granularity')
}

function checkComparison(request: VisualizationRouteRequest, gaps: string[]): void {
  const other = request.comparisonProfile
  if (other === undefined) {
    gaps.push('second-distinct-loaded-layer')
    return
  }
  if (request.profile !== null && other.geometry.join(',') !== request.profile.geometry.join(',')) gaps.push('matching-comparison-geometry')
  checkNumeric(request, other, gaps)
  if (request.timeBinding !== undefined) checkTime(request, other, gaps, false)
}

function dataWarnings(request: VisualizationRouteRequest, method: VisualizationMethod): readonly string[] {
  const warnings: string[] = []
  const profile = request.profile
  if (profile === null) return warnings
  const field = fieldOf(profile, request.field)
  if (method.requirements.includes('numeric') && field !== undefined && field.numeric < profile.featureCount) {
    warnings.push(`${profile.featureCount - field.numeric} rows have missing/non-numeric values; they are missing, not zero.`)
  }
  if (request.measure !== 'total' && profile.ratio !== undefined && profile.ratio.valid < profile.featureCount) {
    warnings.push(`${profile.featureCount - profile.ratio.valid} rows have invalid numerator/denominator pairs; ratios remain missing.`)
  }
  return warnings
}
