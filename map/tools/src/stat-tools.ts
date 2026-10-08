/**
 * The P2 spatial-statistics tools: `stats_zonal`, `stats_autocorrelation`,
 * `stats_hotspot`, `pattern_change`, `pattern_cluster`, and `pattern_flow`.
 * Every tool consumes one exact catalog resource version (never a mutable
 * path), resolves the raw arguments into a fully-specified versioned spec —
 * every default is written into the resolved spec before validation — and
 * runs the `@map-harness/spatial-statistics` computations over the frozen
 * bytes. Successful runs publish their full per-unit tables as immutable
 * catalog artifacts through the accepted-call pairing, keep only bounded
 * summaries in model content, and carry the durable `spatial-stat` meta.
 * Applicability refusals (`not_applicable`/`unknown`) are honest result
 * statuses, never errors.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  DEFAULT_HOLDOUT_BLOCKS,
  DEFAULT_MAX_GAP_BINS,
  DEFAULT_MIN_COVERAGE,
  DEFAULT_MULTIPLE_TESTING,
  DEFAULT_PERMUTATION_SEED,
  DEFAULT_PERMUTATIONS,
  STATS_METHOD_VERSION,
  statSpecDigestOf,
  validateAutocorrelationSpec,
  validateChangeSpec,
  validateClusterSpec,
  validateFlowSpec,
  validateHotspotSpec,
  validateZonalSpec,
  type AutocorrelationSpec,
  type ChangeSpec,
  type ClusterSpec,
  type FlowSpec,
  type HotspotSpec,
  type PatternSpec,
  type StatIssue,
  type StatSpec,
  type TimeWindow,
  type ZonalSpec,
} from '@map-harness/spatial-statistics'
import {
  computeAutocorrelation,
  computeChange,
  computeCluster,
  computeFlow,
  computeHotspot,
  computeZonal,
  type Observation,
  type PatternPublish,
  type StatPublish,
  type StatStatus,
  type StatUnit,
} from '@map-harness/spatial-statistics'
import { MAX_REGISTER_BYTES, type PendingPublishCall, type SessionSpatialCatalog } from '@map-harness/spatial-catalog'
import { admitCollection } from '@map-harness/spatial-catalog'
import { catalogServiceOf, requirePendingPublish, sessionOf } from './catalog-tools.ts'
import { buildSpatialStatMeta, type SpatialStatHeadline, type StatToolName } from './stat-meta.ts'
import { SpatialError } from './spatial-errors.ts'
import { renderJson } from './output.ts'

/** The bounded read cap for one resolved resource (same budget as registration). */
const MAX_STAT_RESOURCE_BYTES = MAX_REGISTER_BYTES

/** Render helper shared by the stat tools: model text omits the durable meta. */
function renderStatJson(value: JsonValue): ReturnType<typeof renderJson> {
  const { meta: _meta, ...rest } = value as Record<string, unknown>
  return renderJson(rest)
}

/** Presentation-meta projector for the stat family. */
function statPresentationMeta(value: JsonValue): JsonValue | null {
  return (value as { meta?: JsonValue }).meta ?? null
}

/** Reject a raw spec input with every structural issue named. */
function requireValidSpec(issues: readonly StatIssue[]): void {
  if (issues.length > 0) {
    throw new SpatialError('INVALID_ARGUMENT', `spec rejected: ${issues.map(issue => `${issue.field} (${issue.code})`).join('; ')}`)
  }
}

/** One resolved execution context the stat tools publish through. */
interface StatContext {
  readonly session: ReturnType<typeof sessionOf>
  readonly catalog: SessionSpatialCatalog
  readonly pending: PendingPublishCall
}

/**
 * Resolve the accepted publish pairing every stat tool needs: the trusted
 * `sourceCallSeq` its artifact publications cite. Nested dispatch cannot
 * publish and fails loud here.
 */
function statContextOf(exec: ToolRunContext, name: StatToolName): StatContext {
  const session = sessionOf(exec)
  const catalog = catalogServiceOf(exec)
  const pending = requirePendingPublish(exec, catalog, session as Parameters<typeof requirePendingPublish>[2], name)
  return { session, catalog, pending }
}

/** One observation unit as read from a Point feature. */
function unitOfFeature(entry: {
  id?: unknown
  geometry?: { type?: string; coordinates?: unknown } | null
  properties?: Record<string, unknown>
}, index: number, field: string, zoneField?: string, denominatorField?: string): StatUnit | null {
  if (entry.geometry?.type !== 'Point') return null
  const coordinates = entry.geometry.coordinates as unknown
  if (!Array.isArray(coordinates) || typeof coordinates[0] !== 'number' || typeof coordinates[1] !== 'number') return null
  const raw = entry.properties?.[field]
  const zone = zoneField === undefined ? undefined : entry.properties?.[zoneField]
  const denominator = denominatorField === undefined ? undefined : entry.properties?.[denominatorField]
  return {
    id: typeof entry.id === 'string' ? entry.id : `unit-${index + 1}`,
    coordinates: [coordinates[0] as number, coordinates[1] as number],
    value: typeof raw === 'number' ? raw : Number.NaN,
    ...(typeof denominator === 'number' ? { denominator } : {}),
    ...(typeof zone === 'string' ? { zone } : {}),
  }
}

/** Read the bounded unit table one zonal/weighted statistic consumes. */
async function readStatUnits(
  catalog: SessionSpatialCatalog,
  resourceRef: string,
  field: string,
  zoneField?: string,
  denominatorField?: string,
): Promise<StatUnit[]> {
  const { bytes } = await catalog.readResourceBytes(resourceRef, catalog.deploymentDomain(), MAX_STAT_RESOURCE_BYTES)
  const admitted = admitCollection(bytes, { enforceWgs84Range: true })
  const units: StatUnit[] = []
  for (const [index, feature] of admitted.collection.features.entries()) {
    const unit = unitOfFeature(feature as Parameters<typeof unitOfFeature>[0], index, field, zoneField, denominatorField)
    if (unit !== null) units.push(unit)
  }
  if (units.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', `resource ${resourceRef} carries no Point features for the observation units`)
  }
  return units
}

/** Read the bounded observation table one pattern computation consumes. */
async function readObservations(catalog: SessionSpatialCatalog, resourceRef: string, field: string | undefined, timeField: string, entityField?: string): Promise<Observation[]> {
  const { bytes } = await catalog.readResourceBytes(resourceRef, catalog.deploymentDomain(), MAX_STAT_RESOURCE_BYTES)
  const admitted = admitCollection(bytes, { enforceWgs84Range: true })
  const observations: Observation[] = []
  for (const [index, feature] of admitted.collection.features.entries()) {
    const entry = feature as Parameters<typeof unitOfFeature>[0]
    if (entry.geometry?.type !== 'Point') continue
    const coordinates = entry.geometry.coordinates as unknown
    if (!Array.isArray(coordinates) || typeof coordinates[0] !== 'number' || typeof coordinates[1] !== 'number') continue
    const rawTime = entry.properties?.[timeField]
    const timeMs = typeof rawTime === 'string' ? new Date(rawTime).getTime() : Number.NaN
    const rawValue = field === undefined ? 0 : entry.properties?.[field]
    const entityRaw = entityField === undefined ? undefined : entry.properties?.[entityField]
    observations.push({
      id: typeof entry.id === 'string' ? entry.id : `obs-${index + 1}`,
      coordinates: [coordinates[0] as number, coordinates[1] as number],
      value: typeof rawValue === 'number' ? rawValue : Number.NaN,
      timeMs,
      ...(typeof entityRaw === 'string' ? { entity: entityRaw } : {}),
    })
  }
  if (observations.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', `resource ${resourceRef} carries no Point observations for the pattern window`)
  }
  return observations
}

/** The artifact seam one computation publishes its full tables through. */
function publishSeam(context: StatContext, spec: StatSpec | PatternSpec, algorithm: string): StatPublish | PatternPublish {
  return async (label, bytes) => {
    const resolved = await context.catalog.resolve({ ref: spec.resourceRef, authorization: context.catalog.deploymentDomain() })
    const published = await context.catalog.publishArtifact({
      bytes,
      inputRefs: [spec.resourceRef],
      method: { algorithm, units: 'statistic', parameters: { label } },
      analysisCrs: 'EPSG:4326',
      sessionId: context.session.id,
      sourceCallSeq: context.pending.callSeq,
      inputAuthorizations: [resolved.resource.authorization],
    })
    return { ref: published.artifact.ref }
  }
}

/** Parse one optional ISO window argument pair into the half-open window. */
function parseWindow(from: unknown, to: unknown, label: string): TimeWindow {
  if (typeof from !== 'string' || typeof to !== 'string') {
    throw new SpatialError('INVALID_ARGUMENT', `${label}_from and ${label}_to are required ISO timestamps`)
  }
  return { from, to }
}

/** Assemble one tool result: bounded summary + durable meta from one evidence. */
function statResult(options: {
  readonly tool: StatToolName
  readonly evidence: { status: StatStatus; notApplicableReason?: string | undefined; limitations: readonly string[]; artifacts: readonly { label: string; ref: string }[] }
  readonly spec: StatSpec | PatternSpec
  readonly headline: SpatialStatHeadline
  readonly summary: Record<string, unknown>
}): JsonValue {
  const { tool, evidence, spec, headline, summary } = options
  const meta = buildSpatialStatMeta({
    tool,
    status: evidence.status,
    methodVersion: STATS_METHOD_VERSION,
    resourceRef: spec.resourceRef,
    field: 'field' in spec && typeof spec.field === 'string' ? spec.field : null,
    goalRevision: spec.goalRevision,
    specDigest: statSpecDigestOf(spec),
    headline,
    notApplicableReason: evidence.notApplicableReason ?? null,
    artifactRefs: evidence.artifacts.map(artifact => artifact.ref),
    limitations: evidence.limitations,
  })
  return {
    ...summary,
    status: evidence.status,
    ...(evidence.notApplicableReason === undefined ? {} : { not_applicable_reason: evidence.notApplicableReason }),
    method_version: STATS_METHOD_VERSION,
    spec_digest: statSpecDigestOf(spec),
    artifact_refs: evidence.artifacts.map(artifact => artifact.ref),
    limitations: evidence.limitations,
    meta,
  } as unknown as JsonValue
}

/**
 * `stats_zonal`: summarize one versioned field per zone (or over the whole
 * area), with the optional rate denominator and weighted mean declared and
 * recorded per row.
 */
export const statsZonal = defineTool({
  name: 'stats_zonal',
  description:
    'Summarize a numeric field of one registered resource version per zone attribute (or over the whole area): '
    + 'count, valid/missing, sum, mean, min/max, population dispersion, and — with a denominator field — the '
    + 'weighted mean and the sum-rate. Reads the frozen catalog version, publishes the full zone table as an '
    + 'artifact, and reports limitations beside every aggregate. Zero valid units is an honest not_applicable.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this statistic belongs to (diagnostic bookkeeping).' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the observation units.' },
    field: { type: 'string', required: true, description: 'Numeric property to summarize.' },
    zone_field: { type: 'string', description: 'Property whose distinct values form the zones; the feature property name "zone" is used when absent.' },
    denominator_field: { type: 'string', description: 'Positive denominator property enabling the weighted mean and the sum-rate; the feature property name "denominator" is used when absent.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderStatJson(value),
    presentationMeta: (_args, value) => statPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { goal_revision: goalRevision, resource_ref: resourceRef, field, zone_field: zoneField, denominator_field: denominatorField } = args as Record<string, unknown>
    if (typeof goalRevision !== 'number' || !Number.isInteger(goalRevision) || goalRevision < 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'goal_revision must be a non-negative integer')
    }
    // The unit table reads zone/denominator properties under fixed names; the
    // optional arguments name those properties explicitly in the spec.
    const spec: ZonalSpec = {
      goalRevision,
      resourceRef: typeof resourceRef === 'string' ? resourceRef : '',
      field: typeof field === 'string' ? field : '',
      ...(typeof zoneField === 'string' ? { zoneField } : {}),
      ...(typeof denominatorField === 'string' ? { denominatorField } : {}),
      methodVersion: STATS_METHOD_VERSION,
    }
    requireValidSpec(validateZonalSpec(spec))
    const context = statContextOf(exec, 'stats_zonal')
    const units = await readStatUnits(context.catalog, spec.resourceRef, spec.field, spec.zoneField, spec.denominatorField)
    exec.signal.throwIfAborted()
    const evidence = await computeZonal(units, spec, publishSeam(context, spec, 'zonal-summary') as StatPublish)
    return statResult({
      tool: 'stats_zonal',
      evidence,
      spec,
      headline: { metric: 'zone_count', value: evidence.zones.length },
      summary: { zones: evidence.zones.slice(0, 16), unit_count: evidence.unitCount, valid_count: evidence.validCount },
    })
  },
})

/** The weighted-argument block shared by autocorrelation and hotspot. */
function weightedSpecParts(args: Record<string, unknown>) {
  const { band_meters: bandMeters, standardization, permutations, seed, multiple_testing: multipleTesting } = args
  if (typeof bandMeters !== 'number' || !Number.isFinite(bandMeters) || bandMeters <= 0) {
    throw new SpatialError('INVALID_ARGUMENT', 'band_meters must be a positive number')
  }
  return {
    weights: { kind: 'distance-band', bandMeters } as const,
    // Every default is written into the resolved spec, never hidden in the computation.
    standardization: standardization === undefined ? 'row' : standardization,
    permutations: permutations === undefined ? DEFAULT_PERMUTATIONS : permutations,
    seed: seed === undefined ? DEFAULT_PERMUTATION_SEED : seed,
    multipleTesting: multipleTesting === undefined ? DEFAULT_MULTIPLE_TESTING : multipleTesting,
  } as {
    weights: { kind: 'distance-band'; bandMeters: number }
    standardization: 'row' | 'binary'
    permutations: number
    seed: number
    multipleTesting: 'none' | 'bonferroni' | 'fdr-bh'
  }
}

/** The pattern-argument block shared by change, cluster, and flow. */
function patternSpecParts(args: Record<string, unknown>) {
  const { granularity, min_coverage: minCoverage, holdout_blocks: holdoutBlocks } = args
  return {
    granularity: granularity === undefined ? 'day' : granularity,
    minCoverage: minCoverage === undefined ? DEFAULT_MIN_COVERAGE : minCoverage,
    holdoutBlocks: holdoutBlocks === undefined ? DEFAULT_HOLDOUT_BLOCKS : holdoutBlocks,
  } as { granularity: 'day' | 'week' | 'month'; minCoverage: number; holdoutBlocks: number }
}

/** Common spec head parsing for every stat tool. */
function specHead(args: Record<string, unknown>) {
  const goalRevision = args.goal_revision
  if (typeof goalRevision !== 'number' || !Number.isInteger(goalRevision) || goalRevision < 0) {
    throw new SpatialError('INVALID_ARGUMENT', 'goal_revision must be a non-negative integer')
  }
  const resourceRef = args.resource_ref
  if (typeof resourceRef !== 'string' || resourceRef.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', 'resource_ref must be an exact resource ref res-…@vN')
  }
  return { goalRevision, resourceRef }
}

/**
 * `stats_autocorrelation`: global Moran's I plus the local LISA
 * decomposition under one seeded permutation test, with the declared band,
 * standardization, and multiple-testing policy recorded in the result.
 */
export const statsAutocorrelation = defineTool({
  name: 'stats_autocorrelation',
  description:
    'Measure spatial association of one versioned field: global Moran\'s I with a seeded permutation p-value plus '
    + 'the local LISA high-high/low-low/high-low/low-high decomposition under the declared multiple-testing '
    + 'correction. Constant fields and too-few-unit tables are honest not_applicable results; correlations are '
    + 'never causal claims. Publishes the full per-unit table as an artifact.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this statistic belongs to.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the observation units.' },
    field: { type: 'string', required: true, description: 'Numeric property to test.' },
    band_meters: { type: 'number', required: true, description: 'Distance-band neighbor threshold in meters (great-circle).' },
    standardization: { type: 'string', description: 'row (default) or binary weight standardization; recorded in the spec.' },
    permutations: { type: 'number', description: 'Permutation redraws (9–999, default 199); recorded with the seed.' },
    seed: { type: 'number', description: 'Deterministic permutation seed (default 20260924); same seed reproduces every p-value.' },
    multiple_testing: { type: 'string', description: 'fdr-bh (default), bonferroni, or none — applied to the local p-values.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderStatJson(value),
    presentationMeta: (_args, value) => statPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { field } = args as Record<string, unknown>
    const head = specHead(args)
    const weighted = weightedSpecParts(args)
    const spec: AutocorrelationSpec = {
      ...head,
      field: typeof field === 'string' ? field : '',
      ...weighted,
      methodVersion: STATS_METHOD_VERSION,
    }
    requireValidSpec(validateAutocorrelationSpec(spec))
    const context = statContextOf(exec, 'stats_autocorrelation')
    const units = await readStatUnits(context.catalog, spec.resourceRef, spec.field)
    exec.signal.throwIfAborted()
    const evidence = await computeAutocorrelation(units, spec, publishSeam(context, spec, 'spatial-autocorrelation') as StatPublish)
    return statResult({
      tool: 'stats_autocorrelation',
      evidence,
      spec,
      headline: { metric: 'moran_i', value: evidence.moranI },
      summary: {
        moran_i: evidence.moranI,
        expected_i: evidence.expectedI,
        z_value: evidence.zValue,
        pseudo_p: evidence.pseudoP,
        permutation_sd: evidence.permutationSd,
        randomization_sd: evidence.randomizationSd,
        permutation: evidence.permutation,
        weights: evidence.weights,
        local: evidence.local.slice(0, 16),
      },
    })
  },
})

/**
 * `stats_hotspot`: Getis-Ord Gi* cold/hotspot classification under one
 * seeded permutation test with the declared multiple-testing correction.
 */
export const statsHotspot = defineTool({
  name: 'stats_hotspot',
  description:
    'Detect cold/hotspot concentrations of one versioned field with Getis-Ord Gi*: each unit\'s self-inclusive '
    + 'neighbor sum is tested by a seeded permutation, the declared correction applies to the local p-values, and '
    + 'the fixed 0.05 alpha labels hotspot/coldspot. Density and significance stay separate claims. Publishes the '
    + 'full per-unit table as an artifact.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this statistic belongs to.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the observation units.' },
    field: { type: 'string', required: true, description: 'Numeric property to test.' },
    band_meters: { type: 'number', required: true, description: 'Distance-band neighbor threshold in meters (great-circle).' },
    standardization: { type: 'string', description: 'row (default) or binary weight standardization; recorded in the spec.' },
    permutations: { type: 'number', description: 'Permutation redraws (9–999, default 199); recorded with the seed.' },
    seed: { type: 'number', description: 'Deterministic permutation seed (default 20260924).' },
    multiple_testing: { type: 'string', description: 'fdr-bh (default), bonferroni, or none — applied to the local p-values.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderStatJson(value),
    presentationMeta: (_args, value) => statPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { field } = args as Record<string, unknown>
    const head = specHead(args)
    const weighted = weightedSpecParts(args)
    const spec: HotspotSpec = {
      ...head,
      field: typeof field === 'string' ? field : '',
      ...weighted,
      methodVersion: STATS_METHOD_VERSION,
    }
    requireValidSpec(validateHotspotSpec(spec))
    const context = statContextOf(exec, 'stats_hotspot')
    const units = await readStatUnits(context.catalog, spec.resourceRef, spec.field)
    exec.signal.throwIfAborted()
    const evidence = await computeHotspot(units, spec, publishSeam(context, spec, 'hotspot') as StatPublish)
    return statResult({
      tool: 'stats_hotspot',
      evidence,
      spec,
      headline: { metric: 'max_gi_star_z', value: evidence.rows[0]?.giStarZ ?? null },
      summary: {
        permutation: evidence.permutation,
        weights: evidence.weights,
        rows: evidence.rows.slice(0, 16),
      },
    })
  },
})

/** `pattern_change`: per-unit change across two time-forward sub-windows. */
export const patternChange = defineTool({
  name: 'pattern_change',
  description:
    'Measure per-unit change between two ordered, non-overlapping sub-windows inside one observation window: '
    + 'comparison must start at or after baseline ends (time-forward). Units missing a window stay unknown — no '
    + 'zero-filling; sparse windows return not_applicable. Reports the forward-holdout drift and per-spatial-block '
    + 'deltas. Publishes the full per-unit table as an artifact.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this statistic belongs to.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the time-stamped observations.' },
    field: { type: 'string', required: true, description: 'Numeric property the change summarizes.' },
    time_field: { type: 'string', required: true, description: 'Property holding each observation\'s ISO event time.' },
    baseline_from: { type: 'string', required: true, description: 'Baseline window start (ISO, inside the observation window).' },
    baseline_to: { type: 'string', required: true, description: 'Baseline window end, exclusive.' },
    comparison_from: { type: 'string', required: true, description: 'Comparison window start; must be at or after the baseline end.' },
    comparison_to: { type: 'string', required: true, description: 'Comparison window end, exclusive.' },
    observation_from: { type: 'string', required: true, description: 'The containing observation window start.' },
    observation_to: { type: 'string', required: true, description: 'The containing observation window end, exclusive.' },
    block_meters: { type: 'number', required: true, description: 'Spatial block size in meters for the per-block delta rows.' },
    unit_field: { type: 'string', description: 'Property grouping observations into one unit across time (for example a device id); absent means each feature is its own unit.' },
    granularity: { type: 'string', description: 'day (default), week, or month — the UTC calendar bin.' },
    min_coverage: { type: 'number', description: 'Occupied-bin fraction the window must reach (default 0.6); below it the tool refuses.' },
    holdout_blocks: { type: 'number', description: 'Last k bins held out for the stability drift (default 1).' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderStatJson(value),
    presentationMeta: (_args, value) => statPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { field, time_field: timeField, baseline_from: baselineFrom, baseline_to: baselineTo, comparison_from: comparisonFrom, comparison_to: comparisonTo, observation_from: observationFrom, observation_to: observationTo, block_meters: blockMeters, unit_field: unitField } = args as Record<string, unknown>
    const head = specHead(args)
    const spec: ChangeSpec = {
      ...head,
      field: typeof field === 'string' ? field : '',
      eventTimeField: typeof timeField === 'string' ? timeField : '',
      window: parseWindow(observationFrom, observationTo, 'observation'),
      baselineWindow: parseWindow(baselineFrom, baselineTo, 'baseline'),
      comparisonWindow: parseWindow(comparisonFrom, comparisonTo, 'comparison'),
      blockMeters: typeof blockMeters === 'number' ? blockMeters : Number.NaN,
      ...(typeof unitField === 'string' ? { unitField } : {}),
      ...patternSpecParts(args),
      methodVersion: STATS_METHOD_VERSION,
    }
    requireValidSpec(validateChangeSpec(spec))
    const context = statContextOf(exec, 'pattern_change')
    const observations = await readObservations(context.catalog, spec.resourceRef, spec.field, spec.eventTimeField, spec.unitField)
    exec.signal.throwIfAborted()
    const evidence = await computeChange(observations, spec, publishSeam(context, spec, 'temporal-change') as PatternPublish)
    return statResult({
      tool: 'pattern_change',
      evidence,
      spec,
      headline: { metric: 'mean_delta', value: evidence.meanDelta },
      summary: {
        coverage: evidence.coverage,
        unit_count: evidence.unitCount,
        units_with_both_windows: evidence.unitsWithBothWindows,
        units_missing_baseline: evidence.unitsMissingBaseline,
        units_missing_comparison: evidence.unitsMissingComparison,
        mean_baseline: evidence.meanBaseline,
        mean_comparison: evidence.meanComparison,
        mean_delta: evidence.meanDelta,
        blocks: evidence.blocks.slice(0, 16),
        stability: evidence.stability,
      },
    })
  },
})

/** `pattern_cluster`: density-based space-time clusters (DBSCAN). */
export const patternCluster = defineTool({
  name: 'pattern_cluster',
  description:
    'Cluster time-stamped observations in space and time (DBSCAN over meters and UTC calendar bins): neighbors '
    + 'share both the spatial radius and the temporal radius. Noise points are labeled, never forced into clusters; '
    + 'too few points or a sparse window is an honest not_applicable. The forward holdout reports how many holdout '
    + 'observations a prefix core still reaches. Publishes the full assignment table as an artifact.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this statistic belongs to.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the time-stamped observations.' },
    field: { type: 'string', required: true, description: 'Numeric property the cluster summaries average.' },
    time_field: { type: 'string', required: true, description: 'Property holding each observation\'s ISO event time.' },
    observation_from: { type: 'string', required: true, description: 'Observation window start (ISO).' },
    observation_to: { type: 'string', required: true, description: 'Observation window end, exclusive.' },
    eps_meters: { type: 'number', required: true, description: 'Spatial radius in meters (great-circle).' },
    eps_bins: { type: 'number', required: true, description: 'Temporal radius in granularity bins.' },
    min_pts: { type: 'number', required: true, description: 'Core-point threshold (neighbors including self).' },
    block_meters: { type: 'number', required: true, description: 'Spatial block size in meters for the participation rows.' },
    granularity: { type: 'string', description: 'day (default), week, or month.' },
    min_coverage: { type: 'number', description: 'Occupied-bin fraction the window must reach (default 0.6).' },
    holdout_blocks: { type: 'number', description: 'Last k bins held out for the forward-fit check (default 1).' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderStatJson(value),
    presentationMeta: (_args, value) => statPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { field, time_field: timeField, observation_from: observationFrom, observation_to: observationTo, eps_meters: epsMeters, eps_bins: epsBins, min_pts: minPts, block_meters: blockMeters } = args as Record<string, unknown>
    const head = specHead(args)
    const spec: ClusterSpec = {
      ...head,
      field: typeof field === 'string' ? field : '',
      eventTimeField: typeof timeField === 'string' ? timeField : '',
      window: parseWindow(observationFrom, observationTo, 'observation'),
      epsMeters: typeof epsMeters === 'number' ? epsMeters : Number.NaN,
      epsBins: typeof epsBins === 'number' ? epsBins : Number.NaN,
      minPts: typeof minPts === 'number' ? minPts : Number.NaN,
      blockMeters: typeof blockMeters === 'number' ? blockMeters : Number.NaN,
      ...patternSpecParts(args),
      methodVersion: STATS_METHOD_VERSION,
    }
    requireValidSpec(validateClusterSpec(spec))
    const context = statContextOf(exec, 'pattern_cluster')
    const observations = await readObservations(context.catalog, spec.resourceRef, spec.field, spec.eventTimeField)
    exec.signal.throwIfAborted()
    const evidence = await computeCluster(observations, spec, publishSeam(context, spec, 'space-time-cluster') as PatternPublish)
    return statResult({
      tool: 'pattern_cluster',
      evidence,
      spec,
      headline: { metric: 'cluster_count', value: evidence.clusters.length },
      summary: {
        coverage: evidence.coverage,
        clusters: evidence.clusters.slice(0, 16),
        noise_count: evidence.noiseCount,
        blocks: evidence.blocks.slice(0, 16),
        stability: evidence.stability,
      },
    })
  },
})

/** `pattern_flow`: origin-destination flows between grid cells with chain gaps broken. */
export const patternFlow = defineTool({
  name: 'pattern_flow',
  description:
    'Extract origin-destination flows of moving entities over a fixed cell grid: consecutive observations of one '
    + 'entity contribute a cell-to-cell transition, in-cell stays count as flows, and a chain gap above max_gap_bins '
    + 'breaks the transition instead of being interpolated. Sparse windows are honest refusals. Stability is the '
    + 'top-K Jaccard between the prefix (holdout bins dropped) and the full window. Publishes the flow table as an artifact.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this statistic belongs to.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the time-stamped observations.' },
    time_field: { type: 'string', required: true, description: 'Property holding each observation\'s ISO event time.' },
    entity_field: { type: 'string', required: true, description: 'Property identifying the moving entity.' },
    observation_from: { type: 'string', required: true, description: 'Observation window start (ISO).' },
    observation_to: { type: 'string', required: true, description: 'Observation window end, exclusive.' },
    cell_meters: { type: 'number', required: true, description: 'Flow grid cell size in meters.' },
    granularity: { type: 'string', description: 'day (default), week, or month.' },
    min_coverage: { type: 'number', description: 'Occupied-bin fraction the window must reach (default 0.6).' },
    holdout_blocks: { type: 'number', description: 'Last k bins held out for the top-K jaccard (default 1).' },
    max_gap_bins: { type: 'number', description: 'Chain gaps above this many bins break the transition (default 1).' },
    top_k: { type: 'number', description: 'Flows in the reported top table (1–256, default 16).' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderStatJson(value),
    presentationMeta: (_args, value) => statPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { time_field: timeField, entity_field: entityField, observation_from: observationFrom, observation_to: observationTo, cell_meters: cellMeters } = args as Record<string, unknown>
    const head = specHead(args)
    const pattern = patternSpecParts(args)
    const spec: FlowSpec = {
      ...head,
      eventTimeField: typeof timeField === 'string' ? timeField : '',
      entityField: typeof entityField === 'string' ? entityField : '',
      window: parseWindow(observationFrom, observationTo, 'observation'),
      cellMeters: typeof cellMeters === 'number' ? cellMeters : Number.NaN,
      maxGapBins: args.max_gap_bins === undefined ? DEFAULT_MAX_GAP_BINS : args.max_gap_bins as number,
      topK: args.top_k === undefined ? 16 : args.top_k as number,
      ...pattern,
      methodVersion: STATS_METHOD_VERSION,
    }
    requireValidSpec(validateFlowSpec(spec))
    const context = statContextOf(exec, 'pattern_flow')
    const observations = await readObservations(context.catalog, spec.resourceRef, undefined, spec.eventTimeField, spec.entityField)
    exec.signal.throwIfAborted()
    const evidence = await computeFlow(observations, spec, publishSeam(context, spec, 'origin-destination-flow') as PatternPublish)
    return statResult({
      tool: 'pattern_flow',
      evidence,
      spec,
      headline: { metric: 'top_flow_count', value: evidence.flows[0]?.transitionCount ?? null },
      summary: {
        coverage: evidence.coverage,
        entity_count: evidence.entityCount,
        transition_count: evidence.transitionCount,
        broken_chain_count: evidence.brokenChainCount,
        flows: evidence.flows.slice(0, 16),
        stability: evidence.stability,
      },
    })
  },
})
