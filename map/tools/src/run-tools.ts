/**
 * The P1 run tools: `run_submit` (ordinary MCP long-job submission with a
 * durable runId/operationRef and a cost estimate), `run_get` (state query
 * that never re-executes), and `run_cancel` (a request the worker/provider
 * adjudicates). Submit pairs with its accepted `tool/call` through the
 * `spatialAccessibility` projection — the trusted `sourceCallSeq` the
 * operationRef cites — and resolves the population/facility resources from
 * their exact catalog versions before anything runs, so the worker never
 * re-reads a mutable path. The retry path returns an already-submitted run by
 * its original operation identity; a missing record is a loud
 * OPERATION_NOT_PUBLISHED refusal, never a resubmission.
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  runOperationRefOf,
  type CapacityRule,
  type BarrierSegment,
  type CandidateOption,
  type ComparisonWeights,
  type EntrancePoint,
  type SpatialAccessibilityService,
  type TimeSliceId,
  type TravelMode,
} from '@map-harness/spatial-accessibility'
import { admitCollection, MAX_REGISTER_BYTES, type SessionSpatialCatalog } from '@map-harness/spatial-catalog'
import { buildAccessibilityRunMeta, type AccessibilityRunMetrics } from './run-meta.ts'
import { renderJson } from './output.ts'
import { catalogServiceOf, sessionOf } from './catalog-tools.ts'
import { decodeJsonParam } from './json-param.ts'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'

/** The bounded read cap per resolved resource (population or facilities). */
const MAX_RUN_RESOURCE_BYTES = MAX_REGISTER_BYTES

/** Render helper shared by the run tools: model text omits the durable meta. */
function renderRunJson(value: JsonValue): ReturnType<typeof renderJson> {
  const { meta: _meta, ...rest } = value as Record<string, unknown>
  return renderJson(rest)
}

/** Resolve the accessibility run service from the tool's execution context. */
export function accessibilityServiceOf(exec: ToolRunContext): SpatialAccessibilityService {
  const service = serviceOf<SpatialAccessibilityService>(exec, 'spatialAccessibility')
  if (service === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'accessibility run service is unavailable in this process')
  }
  return service
}

/** Resolve the paired run_submit `tool/call`; without it no honest operationRef exists. */
function requirePendingRunSubmit(exec: ToolRunContext, service: SpatialAccessibilityService, session: ReturnType<typeof sessionOf>): { callId: string; callSeq: number } {
  if (exec.parent !== undefined) {
    throw new Error('run_submit supports native model-direct calls only; nested dispatch cannot submit runs')
  }
  exec.signal.throwIfAborted()
  const pending = service.pendingRunCallOf(session, exec.callId)
  if (pending === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'run_submit requires its accepted tool/call in the session log before execution')
  }
  return { callId: pending.callId, callSeq: pending.callSeq }
}

/** Parse a WGS84 bbox argument `[west, south, east, north]`. */
function parseBbox(value: unknown, field: string): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || value.some(entry => typeof entry !== 'number' || !Number.isFinite(entry))) {
    throw new SpatialError('INVALID_ARGUMENT', `${field} must be [west, south, east, north] finite numbers`)
  }
  return value as [number, number, number, number]
}

/** Parse a bounded string array argument. */
function parseStringArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new SpatialError('INVALID_ARGUMENT', `${field} must be a non-empty array of at most ${max} strings`)
  }
  return value.map(entry => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', `each ${field} entry must be a non-empty string`)
    }
    return entry
  })
}

/** Parse the bounded entrance list. */
function parseEntrances(value: unknown): EntrancePoint[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 2048) {
    throw new SpatialError('INVALID_ARGUMENT', 'entrances must be an array of at most 2048 entries')
  }
  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null) throw new SpatialError('INVALID_ARGUMENT', 'each entrance must be { facility, lon, lat }')
    const { facility, lon, lat } = entry as { facility?: unknown; lon?: unknown; lat?: unknown }
    if (typeof facility !== 'string' || facility.length === 0 || typeof lon !== 'number' || typeof lat !== 'number') {
      throw new SpatialError('INVALID_ARGUMENT', 'each entrance needs a facility id and numeric lon/lat')
    }
    return { facilityId: facility, coordinates: [lon, lat] }
  })
}

/** Parse the bounded capacity map. */
function parseCapacities(value: unknown): CapacityRule | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SpatialError('INVALID_ARGUMENT', 'capacities must be an object of facility id → non-negative number')
  }
  const perFacility: Record<string, number> = {}
  for (const [facilityId, cap] of Object.entries(value)) {
    if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) {
      throw new SpatialError('INVALID_ARGUMENT', `capacities.${facilityId} must be a non-negative number`)
    }
    perFacility[facilityId] = cap
  }
  return { perFacility, assignment: 'nearest-first' }
}

/** Parse the bounded barrier list. */
function parseBarriers(value: unknown): BarrierSegment[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 1024) {
    throw new SpatialError('INVALID_ARGUMENT', 'barriers must be an array of at most 1024 entries')
  }
  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null) throw new SpatialError('INVALID_ARGUMENT', 'each barrier must be { from, to, kind, delay_minutes? }')
    const { from, to, kind, delay_minutes: delayMinutes } = entry as Record<string, unknown>
    if (!Array.isArray(from) || !Array.isArray(to)) throw new SpatialError('INVALID_ARGUMENT', 'barrier from/to must be [lon, lat] pairs')
    if (kind !== 'blocked' && kind !== 'delay') throw new SpatialError('INVALID_ARGUMENT', 'barrier kind must be blocked or delay')
    if (kind === 'blocked' && delayMinutes !== undefined) throw new SpatialError('INVALID_ARGUMENT', 'a blocked barrier takes no delay_minutes')
    if (kind === 'delay' && (typeof delayMinutes !== 'number' || delayMinutes <= 0)) {
      throw new SpatialError('INVALID_ARGUMENT', 'a delay barrier requires positive delay_minutes')
    }
    const barrier: BarrierSegment = {
      from: [from[0] as number, from[1] as number],
      to: [to[0] as number, to[1] as number],
      kind,
    }
    if (delayMinutes !== undefined) {
      return { ...barrier, delayMinutes: delayMinutes as number }
    }
    return barrier
  })
}

/** Parse the bounded candidate list. */
function parseCandidates(value: unknown): CandidateOption[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) {
    throw new SpatialError('INVALID_ARGUMENT', 'candidates must be an array of at most 8 options')
  }
  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null) throw new SpatialError('INVALID_ARGUMENT', 'each candidate must be { id, label, facilities, cost }')
    const { id, label, facilities, cost } = entry as Record<string, unknown>
    if (typeof id !== 'string' || id.length === 0 || typeof label !== 'string' || label.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'each candidate needs non-empty id and label')
    }
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'candidate cost must be a non-negative number')
    }
    if (!Array.isArray(facilities) || facilities.length === 0 || facilities.length > 64) {
      throw new SpatialError('INVALID_ARGUMENT', 'each candidate adds one to 64 facilities')
    }
    const addFacilities = facilities.map(facility => {
      if (typeof facility !== 'object' || facility === null) throw new SpatialError('INVALID_ARGUMENT', 'each candidate facility must be { id, lon, lat, capacity?, entrance? }')
      const { id: facilityId, lon, lat, capacity, entrance } = facility as Record<string, unknown>
      if (typeof facilityId !== 'string' || facilityId.length === 0 || typeof lon !== 'number' || typeof lat !== 'number') {
        throw new SpatialError('INVALID_ARGUMENT', 'each candidate facility needs an id and coordinates')
      }
      if (capacity !== undefined && (typeof capacity !== 'number' || capacity < 0)) {
        throw new SpatialError('INVALID_ARGUMENT', 'candidate facility capacity must be non-negative')
      }
      return {
        id: facilityId,
        coordinates: [lon, lat] as [number, number],
        ...(capacity === undefined ? {} : { capacity }),
        ...(Array.isArray(entrance) ? { entrance: entrance as [number, number] } : {}),
      }
    })
    return { id, label, addFacilities, cost } satisfies CandidateOption
  })
}

/** Parse the comparison weights. */
function parseWeights(value: unknown): ComparisonWeights | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) throw new SpatialError('INVALID_ARGUMENT', 'weights must be { coverage, equity, cost }')
  const { coverage, equity, cost } = value as Record<string, unknown>
  const values = [coverage, equity, cost]
  if (!values.every(weight => typeof weight === 'number' && Number.isFinite(weight) && weight >= 0) || !values.some(weight => (weight as number) > 0)) {
    throw new SpatialError('INVALID_ARGUMENT', 'weights must be non-negative numbers with at least one positive')
  }
  return { coverage: coverage as number, equity: equity as number, cost: cost as number }
}

/** Parse the time-slice ids against the fixed protocol vocabulary. */
function parseTimeSlices(value: unknown): TimeSliceId[] {
  const slices = parseStringArray(value, 'time_slices', 4) as TimeSliceId[]
  const known: readonly string[] = ['morning-peak', 'midday', 'evening-peak', 'night']
  for (const slice of slices) {
    if (!known.includes(slice)) {
      throw new SpatialError('INVALID_ARGUMENT', `time_slices entries must be one of ${known.join(', ')}`)
    }
  }
  return slices
}

/** One GeoJSON feature the identity resolver reads. */
interface FeatureEntry {
  readonly geometry?: { readonly type?: string; readonly coordinates?: unknown }
  readonly properties?: Record<string, unknown>
  readonly id?: unknown
}

/**
 * Feature identity for entrances/capacities binding.
 * Order: GeoJSON `feature.id`, then a string `properties.id`, else a positional
 * fallback whose counter is unique across every resource already resolved.
 * An explicit id claimed by two resources is a data error: the caller names
 * the id and both refs and never renames either side.
 */
function resolveFeatureId(
  entry: FeatureEntry,
  claimed: Map<string, string>,
  resourceRef: string,
  prefix: 'facility' | 'unit',
  positional: { count: number },
): string {
  const featureId = typeof entry.id === 'string' ? entry.id : undefined
  const propertyId = typeof entry.properties?.['id'] === 'string' ? entry.properties['id'] : undefined
  const explicit = featureId ?? propertyId
  if (explicit !== undefined) {
    const owner = claimed.get(explicit)
    if (owner !== undefined) {
      const resources = owner === resourceRef ? resourceRef : `${owner} and ${resourceRef}`
      throw new SpatialError('INVALID_ARGUMENT', `id ${explicit} is claimed by ${resources}`)
    }
    claimed.set(explicit, resourceRef)
    return explicit
  }
  positional.count += 1
  return `${prefix}-${positional.count}`
}

/** Point features of one resolved resource, in collection order. */
function pointFeaturesOf(bytes: Uint8Array): FeatureEntry[] {
  const admitted = admitCollection(bytes, { enforceWgs84Range: true })
  const points: FeatureEntry[] = []
  for (const feature of admitted.collection.features) {
    const entry = feature as FeatureEntry
    if (entry.geometry?.type !== 'Point') continue
    const coordinates = entry.geometry.coordinates
    if (!Array.isArray(coordinates) || typeof coordinates[0] !== 'number' || typeof coordinates[1] !== 'number') continue
    points.push(entry)
  }
  return points
}

/** The bounded population units one resource version contributes. */
function resolvePopulation(catalog: SessionSpatialCatalog, ref: string, field: string) {
  return catalog.readResourceBytes(ref, 'local', MAX_RUN_RESOURCE_BYTES).then(({ resource, bytes }) => {
    const points = pointFeaturesOf(bytes)
    if (points.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', `population resource ${resource.ref} carries no Point features for the denominator`)
    }
    const claimed = new Map<string, string>()
    const positional = { count: 0 }
    const units = points.map(entry => {
      const raw = entry.properties?.[field]
      const community = entry.properties?.['community']
      const coordinates = entry.geometry?.coordinates as number[]
      return {
        id: resolveFeatureId(entry, claimed, resource.ref, 'unit', positional),
        coordinates: [coordinates[0]!, coordinates[1]!] as [number, number],
        population: typeof raw === 'number' ? raw : Number.NaN,
        ...(typeof community === 'string' ? { community } : {}),
      }
    })
    return { units, featureCount: resource.featureCount }
  }).catch((error: unknown) => {
    if (error instanceof SpatialError) throw error
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', `population resource ${ref} could not be resolved: ${String(error instanceof Error ? error.message : error)}`)
  })
}

/**
 * The bounded facility points the facility resource versions contribute.
 * Resources resolve in citation order so a positional fallback stays unique
 * across the whole set and an explicit-id conflict names a stable pair.
 */
async function resolveFacilities(catalog: SessionSpatialCatalog, refs: readonly string[]) {
  const claimed = new Map<string, string>()
  const positional = { count: 0 }
  const facilities = []
  for (const ref of refs) {
    const { resource, bytes } = await catalog.readResourceBytes(ref, 'local', MAX_RUN_RESOURCE_BYTES)
    const points = pointFeaturesOf(bytes)
    if (points.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', `facility resource ${resource.ref} carries no Point features`)
    }
    for (const entry of points) {
      const capacity = entry.properties?.['capacity']
      const coordinates = entry.geometry?.coordinates as number[]
      facilities.push({
        id: resolveFeatureId(entry, claimed, resource.ref, 'facility', positional),
        coordinates: [coordinates[0]!, coordinates[1]!] as [number, number],
        ...(typeof capacity === 'number' ? { capacity } : {}),
      })
    }
  }
  return facilities
}

/** Build the headline metrics block from one terminal run result. */
function metricsOfResult(result: unknown): AccessibilityRunMetrics | null {
  if (typeof result !== 'object' || result === null) return null
  const evidence = (result as { evidence?: { outcome?: unknown; denominator?: { totalPopulation?: unknown }; coveredPopulation?: unknown; uncoveredPopulation?: unknown; coverageRatio?: unknown } }).evidence
  if (typeof evidence !== 'object' || evidence === null) return null
  const outcome = (evidence as { outcome?: unknown }).outcome
  const denominator = (evidence as { denominator?: { totalPopulation?: unknown } }).denominator
  if (typeof outcome !== 'string' || typeof denominator?.totalPopulation !== 'number') return null
  return {
    outcome: (outcome as 'complete' | 'partial' | 'empty'),
    populationDenominator: denominator.totalPopulation,
    coveredPopulation: (evidence as { coveredPopulation?: number }).coveredPopulation ?? 0,
    uncoveredPopulation: (evidence as { uncoveredPopulation?: number }).uncoveredPopulation ?? 0,
    coverageRatio: (evidence as { coverageRatio?: number }).coverageRatio ?? 0,
  }
}

/** One computation diagnostic the model-facing summary may name. */
interface ComputationDiagnostic {
  readonly code: string
  readonly facilityId?: string
  readonly unitId?: string
  readonly message: string
}

/** Model-visible cap shared by run-level and computation diagnostics. */
const MAX_MODEL_DIAGNOSTICS = 16

/**
 * Merge run-level diagnostics with the computation's own named exclusions.
 * Computation entries keep their code vocabulary and name the facility or
 * unit they excluded; the combined list stops at the existing 16-entry cap.
 */
function modelDiagnostics(record: ReturnType<SpatialAccessibilityService['get']>, computation: readonly ComputationDiagnostic[]): string[] {
  const runLevel = record.diagnostics.map(entry => `${entry.code}: ${entry.message}`)
  const named = computation.map(entry => {
    const subject = entry.facilityId !== undefined
      ? ` facilityId=${entry.facilityId}`
      : entry.unitId !== undefined ? ` unitId=${entry.unitId}` : ''
    return `${entry.code}:${subject} ${entry.message}`
  })
  return [...runLevel, ...named].slice(0, MAX_MODEL_DIAGNOSTICS)
}

/** The model-facing summary of one run record. */
function runSummary(record: ReturnType<SpatialAccessibilityService['get']>, extra: { deduplicated?: boolean; retry_of?: number } = {}): Record<string, unknown> {
  const evidence = (record.result as { evidence?: { artifacts?: { ref: string }[]; limitations?: string[]; diagnostics?: ComputationDiagnostic[] } | null; comparison?: { comparisonDigest?: string } | null }) ?? {}
  const artifacts = evidence.evidence?.artifacts ?? []
  const comparisonDigest = evidence.comparison?.comparisonDigest ?? null
  const diagnostics = modelDiagnostics(record, evidence.evidence?.diagnostics ?? [])
  return {
    run_id: record.runId,
    operation_ref: record.operationRef,
    status: record.status,
    goal_revision: record.goalRevision,
    request_digest: record.requestDigest,
    ...(extra.deduplicated === true ? { deduplicated: true } : {}),
    ...(extra.retry_of !== undefined ? { retry_of: extra.retry_of } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
    metrics: metricsOfResult(record.result),
    artifact_refs: artifacts.map(artifact => artifact.ref),
    ...(comparisonDigest !== null ? { comparison_digest: comparisonDigest } : {}),
    limitations: evidence.evidence?.limitations ?? [
      'the run has not settled yet: query run_get until a terminal status (partial/succeeded/failed/cancelled/outcomeUnknown)',
    ],
  }
}

/**
 * `run_submit`: submit one accessibility run (coverage plus the optional
 * candidate comparison). The durable run row exists before the worker starts;
 * a lost submit response is recoverable by re-deriving the same operation —
 * the same identity with different parameters is a conflict.
 */
export const runSubmit = defineTool({
  name: 'run_submit',
  description:
    'Submit an accessibility analysis as a long-running job: population-weighted network coverage over the exact '
    + 'registered resource versions you cite, with optional candidate-option comparison. Returns a stable run_id and '
    + 'operation_ref immediately; the computation runs server-side with cancel checkpoints. Query progress with '
    + 'run_get (it never re-executes) and request cancellation with run_cancel. Crossing extents must nest '
    + 'study ⊆ retrieval ⊆ support; a walk/bike/drive target without a priced network fails as METHOD_NOT_APPLICABLE '
    + 'instead of falling back to a straight-line buffer.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Current goal revision this run belongs to; a finished run of an older revision never overrides a newer goal.' },
    population_ref: { type: 'string', required: true, description: 'Exact population resource ref (res-…@vN) from catalog_register.' },
    population_field: { type: 'string', required: true, description: 'Numeric property holding each unit\'s population (the denominator).' },
    facility_refs: { type: 'json', required: true, description: 'Array of exact facility resource refs (res-…@vN).' },
    travel_mode: { type: 'string', required: true, description: 'walk, bike, or drive — the network mode the impedance prices.' },
    max_minutes: { type: 'number', required: true, description: 'Service-area budget in network minutes (1–240).' },
    time_slices: { type: 'json', required: true, description: 'Array from morning-peak | midday | evening-peak | night.' },
    study_area: { type: 'json', required: true, description: '[west, south, east, north] — results are reported for units inside.' },
    retrieval_extent: { type: 'json', required: true, description: '[west, south, east, north] — contains the study area.' },
    support_extent: { type: 'json', required: true, description: '[west, south, east, north] — contains the retrieval extent; facilities inside still serve across the study boundary.' },
    observation_from: { type: 'string', required: true, description: 'Observation window start (ISO-8601 with offset).' },
    observation_to: { type: 'string', required: true, description: 'Observation window end, exclusive.' },
    training_from: { type: 'string', description: 'Historical lookback window start; must end at or before the observation start.' },
    training_to: { type: 'string', description: 'Historical lookback window end.' },
    entrances: { type: 'json', description: 'Array of { facility, lon, lat } network access points. facility matches feature.id, else a string properties.id. Facilities without any entrance are excluded and named in run_get diagnostics (code plus facilityId).' },
    capacities: { type: 'json', description: 'Object facility id → maximum population served (hard cap; overflow stays uncovered).' },
    barriers: { type: 'json', description: 'Array of { from: [lon, lat], to: [lon, lat], kind: blocked|delay, delay_minutes? }.' },
    candidates: { type: 'json', description: 'Array of up to 8 { id, label, facilities: [{ id, lon, lat, capacity?, entrance? }], cost } — only these given options are compared (no global optimum).' },
    weights: { type: 'json', description: '{ coverage, equity, cost } comparison weights; required with candidates.' },
    cost_budget: { type: 'number', description: 'Total candidate cost budget; over-budget options are reported infeasible.' },
    retry_of: { type: 'number', description: 'Seq of this session\'s original run_submit tool/call: returns the already-submitted run and never resubmits.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderRunJson(value),
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const {
      goal_revision: goalRevision,
      population_ref: populationRef,
      population_field: populationField,
      facility_refs: facilityRefs,
      travel_mode: travelMode,
      max_minutes: maxMinutes,
      time_slices: timeSlices,
      study_area: studyArea,
      retrieval_extent: retrievalExtent,
      support_extent: supportExtent,
      observation_from: observationFrom,
      observation_to: observationTo,
      training_from: trainingFrom,
      training_to: trainingTo,
      entrances,
      capacities,
      barriers,
      candidates,
      weights,
      cost_budget: costBudget,
      retry_of: retryOf,
    } = args as Record<string, unknown>
    const decodedFacilityRefs = decodeJsonParam(facilityRefs, 'facility_refs')
    const decodedTimeSlices = decodeJsonParam(timeSlices, 'time_slices')
    const decodedStudyArea = decodeJsonParam(studyArea, 'study_area')
    const decodedRetrievalExtent = decodeJsonParam(retrievalExtent, 'retrieval_extent')
    const decodedSupportExtent = decodeJsonParam(supportExtent, 'support_extent')
    const decodedEntrances = decodeJsonParam(entrances, 'entrances')
    const decodedCapacities = decodeJsonParam(capacities, 'capacities')
    const decodedBarriers = decodeJsonParam(barriers, 'barriers')
    const decodedCandidates = decodeJsonParam(candidates, 'candidates')
    const decodedWeights = decodeJsonParam(weights, 'weights')

    if (typeof goalRevision !== 'number' || !Number.isInteger(goalRevision) || goalRevision < 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'goal_revision must be a non-negative integer')
    }
    if (typeof populationRef !== 'string' || typeof populationField !== 'string' || populationField.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'population_ref and population_field are required strings')
    }
    if (Array.isArray(decodedFacilityRefs) === false) {
      throw new SpatialError('INVALID_ARGUMENT', 'facility_refs must be an array of resource refs')
    }
    if (typeof travelMode !== 'string' || !['walk', 'bike', 'drive'].includes(travelMode)) {
      throw new SpatialError('INVALID_ARGUMENT', 'travel_mode must be walk, bike, or drive')
    }
    if (typeof maxMinutes !== 'number' || !Number.isFinite(maxMinutes) || maxMinutes <= 0 || maxMinutes > 240) {
      throw new SpatialError('INVALID_ARGUMENT', 'max_minutes must be a positive number up to 240')
    }
    if (typeof observationFrom !== 'string' || typeof observationTo !== 'string') {
      throw new SpatialError('INVALID_ARGUMENT', 'observation_from and observation_to are required ISO timestamps')
    }

    const session = sessionOf(exec)
    const service = accessibilityServiceOf(exec)
    const catalog = catalogServiceOf(exec)

    // The retry path returns the original submission as-is — the original
    // operation identity, never a resubmission with re-resolved inputs.
    if (retryOf !== undefined) {
      if (typeof retryOf !== 'number' || !Number.isInteger(retryOf) || retryOf < 0) {
        throw new SpatialError('INVALID_ARGUMENT', 'retry_of must be a non-negative integer call seq')
      }
      const existing = service.lookupByOperationRef(runOperationRefOf(session.id, retryOf))
      if (existing === undefined) {
        throw new SpatialError('OPERATION_NOT_PUBLISHED', `call seq ${retryOf} has no submitted run in this session`)
      }
      const meta = buildAccessibilityRunMeta({
        tool: 'run_submit',
        runId: existing.runId,
        operationRef: existing.operationRef,
        status: existing.status,
        goalRevision: existing.goalRevision,
        requestDigest: existing.requestDigest,
        metrics: metricsOfResult(existing.result),
        artifactRefs: artifactRefsOf(existing.result),
        comparisonDigest: comparisonDigestOf(existing.result),
        limitations: ['returned from the original submission; inputs were not re-resolved'],
      })
      return { ...runSummary(existing, { deduplicated: true, retry_of: retryOf }), meta } as unknown as JsonValue
    }

    const pending = requirePendingRunSubmit(exec, service, session)
    const resolvedFacilityRefs = parseStringArray(decodedFacilityRefs, 'facility_refs', 16)
    const population = await resolvePopulation(catalog, populationRef, populationField)
    exec.signal.throwIfAborted()
    const facilities = await resolveFacilities(catalog, resolvedFacilityRefs)

    const spec = {
      goalRevision,
      studyArea: { bbox: parseBbox(decodedStudyArea, 'study_area') },
      retrievalExtent: { bbox: parseBbox(decodedRetrievalExtent, 'retrieval_extent') },
      analysisSupportExtent: { bbox: parseBbox(decodedSupportExtent, 'support_extent') },
      observationWindow: { from: observationFrom, to: observationTo },
      ...(typeof trainingFrom === 'string' && typeof trainingTo === 'string' ? { trainingWindow: { from: trainingFrom, to: trainingTo } } : {}),
      impedance: { travelMode: travelMode as TravelMode, maxMinutes },
      timeSlices: parseTimeSlices(decodedTimeSlices),
      ...(decodedBarriers !== undefined ? { barriers: parseBarriers(decodedBarriers) } : {}),
      ...(decodedEntrances !== undefined ? { entrances: parseEntrances(decodedEntrances) } : {}),
      ...(decodedCapacities !== undefined ? { capacity: parseCapacities(decodedCapacities) } : {}),
      populationRef,
      populationField,
      facilityRefs: resolvedFacilityRefs,
      ...(decodedCandidates !== undefined ? { candidates: parseCandidates(decodedCandidates) } : {}),
      ...(decodedWeights !== undefined ? { weights: parseWeights(decodedWeights) } : {}),
      ...(costBudget !== undefined && typeof costBudget === 'number' ? { costBudget } : {}),
    }
    const submitted = await service.submit({
      operationRef: runOperationRefOf(session.id, pending.callSeq),
      spec: spec as Parameters<SpatialAccessibilityService['submit']>[0]['spec'],
      data: { population: population.units, facilities },
    })
    const record = service.get(submitted.runId)
    const meta = buildAccessibilityRunMeta({
      tool: 'run_submit',
      runId: submitted.runId,
      operationRef: submitted.operationRef,
      status: submitted.status,
      goalRevision,
      requestDigest: submitted.requestDigest,
      metrics: metricsOfResult(record.result),
      artifactRefs: artifactRefsOf(record.result),
      comparisonDigest: comparisonDigestOf(record.result),
      limitations: [
        'the computation runs server-side; run_get reports the durable status without re-executing',
        'a timeout does not mean the run ended: query by run_id or operation_ref',
      ],
    })
    return {
      ...runSummary(record),
      status: 'submitted',
      estimate: submitted.estimate,
      deduplicated: submitted.deduplicated,
      meta,
    } as unknown as JsonValue
  },
})

/** Artifact refs cited by one stored run result. */
function artifactRefsOf(result: unknown): string[] {
  const evidence = (result as { evidence?: { artifacts?: { ref: string }[] } | null })?.evidence
  return (evidence?.artifacts ?? []).map(artifact => artifact.ref)
}

/** The comparison digest of one stored run result, when the run compared candidates. */
function comparisonDigestOf(result: unknown): string | null {
  return (result as { comparison?: { comparisonDigest?: string } | null })?.comparison?.comparisonDigest ?? null
}

/**
 * `run_get`: read one run's durable state. The query never re-executes the
 * run and never wakes a worker; terminal runs carry their real outcome.
 */
export const runGet = defineTool({
  name: 'run_get',
  description:
    'Read one accessibility run\'s durable status by run_id: queued, running, cancelRequested, or a terminal '
    + 'partial/succeeded/failed/cancelled/outcomeUnknown with its metrics and artifact refs. The query never '
    + 're-executes the run; a timeout on the original submit does not mean the run ended — query it here.',
  parameters: {
    run_id: { type: 'string', required: true, description: 'The run_id run_submit returned.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderRunJson(value),
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { run_id: runId } = args as { run_id?: unknown }
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'run_id must be the run id run_submit returned')
    }
    const service = accessibilityServiceOf(exec)
    const record = service.get(runId)
    const meta = buildAccessibilityRunMeta({
      tool: 'run_get',
      runId: record.runId,
      operationRef: record.operationRef,
      status: record.status,
      goalRevision: record.goalRevision,
      requestDigest: record.requestDigest,
      metrics: metricsOfResult(record.result),
      artifactRefs: artifactRefsOf(record.result),
      comparisonDigest: comparisonDigestOf(record.result),
      limitations: ['run_get never re-executes; the durable state is the answer'],
    })
    return { ...runSummary(record), meta } as unknown as JsonValue
  },
})

/**
 * `run_cancel`: request cancellation of one run. The final state is the
 * service adjudication — the run either stops at a worker checkpoint
 * (cancelled) or finishes the work it had already completed (its real
 * outcome, with the request recorded).
 */
export const runCancel = defineTool({
  name: 'run_cancel',
  description:
    'Request cancellation of one accessibility run by run_id. This is a request, not a verdict: the worker either '
    + 'stops at its next checkpoint (cancelled) or completes the work already done (the real outcome with the cancel '
    + 'request recorded). Query run_get for the adjudicated terminal state.',
  parameters: {
    run_id: { type: 'string', required: true, description: 'The run_id run_submit returned.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderRunJson(value),
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { run_id: runId } = args as { run_id?: unknown }
    if (typeof runId !== 'string' || runId.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'run_id must be the run id run_submit returned')
    }
    const service = accessibilityServiceOf(exec)
    const record = service.cancel(runId)
    const meta = buildAccessibilityRunMeta({
      tool: 'run_cancel',
      runId: record.runId,
      operationRef: record.operationRef,
      status: record.status,
      goalRevision: record.goalRevision,
      requestDigest: record.requestDigest,
      metrics: metricsOfResult(record.result),
      artifactRefs: artifactRefsOf(record.result),
      comparisonDigest: comparisonDigestOf(record.result),
      limitations: ['cancellation is a request; the service terminal state adjudicates the outcome'],
    })
    return { ...runSummary(record), meta } as unknown as JsonValue
  },
})
