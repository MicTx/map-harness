/**
 * The P3 spatial-decision tools: `attribution_association`,
 * `attribution_explain`, `attribution_effect`, `forecast_validate`,
 * `forecast_fit`, `forecast_predict`, `scenario_compare`, and
 * `location_allocate`. Every tool consumes exact catalog resource versions
 * (never a mutable path), resolves the raw arguments into a fully-specified
 * versioned spec — every default is written into the resolved spec before
 * validation — and runs the `@map-harness/spatial-decision` computations.
 * Successful runs publish their full tables (fitted model, diagnostics,
 * allocation) as immutable catalog artifacts through the accepted-call
 * pairing, keep only bounded summaries in model content, and carry the
 * durable `spatial-decision` meta. Attribution labels never upgrade beyond
 * their evidence conditions; `not_applicable`/`unknown` are honest statuses,
 * never errors.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  DECISION_METHOD_VERSION,
  DEFAULT_HOLDOUT_STEPS,
  DEFAULT_INTERVAL_LEVEL,
  MAX_FACTORS,
  MAX_SITES,
  decisionSpecDigestOf,
  validateAssociationSpec,
  validateEffectSpec,
  validateExplainSpec,
  validateForecastPredictSpec,
  validateForecastSpec,
  validateLocationAllocateSpec,
  validateScenarioCompareSpec,
  type AssociationSpec,
  type DecisionIssue,
  type DecisionSpec,
  type EffectSpec,
  type ExplainSpec,
  type ForecastPredictSpec,
  type ForecastSpec,
  type IntervalLevel,
  type LocationAllocateSpec,
  type ScenarioCompareSpec,
} from '@map-harness/spatial-decision'
import {
  allocateLocations,
  compareScenarios,
  computeAssociation,
  computeEffect,
  computeExplain,
  computeForecastFit,
  computeForecastPredict,
  computeForecastValidation,
  type AllocateDemandRow,
  type AnalysisRow,
  type DecisionPublish,
  type DecisionStatus,
  type FittedForecastModel,
  type ForecastRow,
} from '@map-harness/spatial-decision'
import { MAX_REGISTER_BYTES, admitCollection, type PendingPublishCall, type SessionSpatialCatalog } from '@map-harness/spatial-catalog'
import { catalogServiceOf, requirePendingPublish, sessionOf } from './catalog-tools.ts'
import { buildSpatialDecisionMeta, type DecisionToolName, type SpatialDecisionHeadline } from './decision-meta.ts'
import { SpatialError } from './spatial-errors.ts'
import { renderJson } from './output.ts'

/** The bounded read cap for one resolved resource (same budget as registration). */
const MAX_DECISION_RESOURCE_BYTES = MAX_REGISTER_BYTES

/** Render helper shared by the decision-model tools: model text omits the durable meta. */
function renderDecisionJson(value: JsonValue): ReturnType<typeof renderJson> {
  const { meta: _meta, ...rest } = value as Record<string, unknown>
  return renderJson(rest)
}

/** Presentation-meta projector for the decision-model family. */
function decisionPresentationMeta(value: JsonValue): JsonValue | null {
  return (value as { meta?: JsonValue }).meta ?? null
}

/** Reject a raw spec input with every structural issue named. */
function requireValidSpec(issues: readonly DecisionIssue[]): void {
  if (issues.length > 0) {
    throw new SpatialError('INVALID_ARGUMENT', `spec rejected: ${issues.map(issue => `${issue.field} (${issue.code})`).join('; ')}`)
  }
}

/** One resolved execution context the decision-model tools publish through. */
interface DecisionModelContext {
  readonly session: ReturnType<typeof sessionOf>
  readonly catalog: SessionSpatialCatalog
  readonly pending: PendingPublishCall
}

/**
 * Resolve the accepted publish pairing every decision-model tool needs: the
 * trusted `sourceCallSeq` its artifact publications cite. Nested dispatch
 * cannot publish and fails loud here.
 */
function decisionModelContextOf(exec: ToolRunContext, name: DecisionToolName): DecisionModelContext {
  const session = sessionOf(exec)
  const catalog = catalogServiceOf(exec)
  const pending = requirePendingPublish(exec, catalog, session as Parameters<typeof requirePendingPublish>[2], name)
  return { session, catalog, pending }
}

/** The artifact seam one computation publishes its full tables through. Authorization inherits the minimum of the consumed resource versions (artifact refs arrive pre-authorized). */
function publishSeam(context: DecisionModelContext, inputRefs: readonly string[], algorithm: string): DecisionPublish {
  return async (label, bytes) => {
    const resourceRefs = inputRefs.filter(ref => ref.startsWith('res-'))
    const authorizations = await Promise.all(resourceRefs.map(ref => context.catalog.resolve({ ref, authorization: context.catalog.deploymentDomain() }).then(resolved => resolved.resource.authorization)))
    const published = await context.catalog.publishArtifact({
      bytes,
      inputRefs: [...inputRefs],
      method: { algorithm, units: 'statistic', parameters: { label } },
      analysisCrs: 'EPSG:4326',
      sessionId: context.session.id,
      sourceCallSeq: context.pending.callSeq,
      inputAuthorizations: authorizations.length > 0 ? authorizations : [context.catalog.deploymentDomain()],
    })
    return { ref: published.artifact.ref }
  }
}

/** One Point feature's numeric properties as an analysis value record. */
function valuesOf(properties: Record<string, unknown> | undefined, fields: readonly string[]): Record<string, number | undefined> {
  const values: Record<string, number | undefined> = {}
  for (const field of fields) {
    const raw = properties?.[field]
    values[field] = typeof raw === 'number' ? raw : undefined
  }
  return values
}

/** Read the bounded Point-row table one attribution computation consumes. `markFields` carry the raw treatment/period/unit marks. */
async function readAnalysisRows(catalog: SessionSpatialCatalog, resourceRef: string, fields: readonly string[], markFields: readonly string[] = []): Promise<AnalysisRow[]> {
  const { bytes } = await catalog.readResourceBytes(resourceRef, catalog.deploymentDomain(), MAX_DECISION_RESOURCE_BYTES)
  const admitted = admitCollection(bytes, { enforceWgs84Range: true })
  const rows: AnalysisRow[] = []
  for (const [index, feature] of admitted.collection.features.entries()) {
    const entry = feature as { id?: unknown; geometry?: { type?: string; coordinates?: unknown } | null; properties?: Record<string, unknown> }
    if (entry.geometry?.type !== 'Point') continue
    const coordinates = entry.geometry.coordinates as unknown
    if (!Array.isArray(coordinates) || typeof coordinates[0] !== 'number' || typeof coordinates[1] !== 'number') continue
    const marks: Record<string, unknown> = {}
    for (const field of markFields) marks[field] = entry.properties?.[field]
    rows.push({
      id: typeof entry.id === 'string' ? entry.id : `row-${index + 1}`,
      coordinates: [coordinates[0] as number, coordinates[1] as number],
      values: valuesOf(entry.properties, fields),
      ...(markFields.length > 0 ? { marks } : {}),
    })
  }
  if (rows.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', `resource ${resourceRef} carries no Point features for the analysis rows`)
  }
  return rows
}

/** Read the bounded time-stamped row table one forecast computation consumes. */
async function readForecastRows(catalog: SessionSpatialCatalog, resourceRef: string, timeField: string, fields: readonly string[]): Promise<ForecastRow[]> {
  const { bytes } = await catalog.readResourceBytes(resourceRef, catalog.deploymentDomain(), MAX_DECISION_RESOURCE_BYTES)
  const admitted = admitCollection(bytes, { enforceWgs84Range: true })
  const rows: ForecastRow[] = []
  for (const [index, feature] of admitted.collection.features.entries()) {
    const entry = feature as { id?: unknown; geometry?: { type?: string; coordinates?: unknown } | null; properties?: Record<string, unknown> }
    if (entry.geometry?.type !== 'Point') continue
    const coordinates = entry.geometry.coordinates as unknown
    if (!Array.isArray(coordinates) || typeof coordinates[0] !== 'number' || typeof coordinates[1] !== 'number') continue
    const rawTime = entry.properties?.[timeField]
    const timeMs = typeof rawTime === 'string' ? new Date(rawTime).getTime() : Number.NaN
    rows.push({
      id: typeof entry.id === 'string' ? entry.id : `obs-${index + 1}`,
      coordinates: [coordinates[0] as number, coordinates[1] as number],
      timeMs,
      values: valuesOf(entry.properties, fields),
    })
  }
  if (rows.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', `resource ${resourceRef} carries no Point rows for the forecast window`)
  }
  return rows
}

/** Read the bounded demand-point table one allocation consumes. */
async function readDemandRows(catalog: SessionSpatialCatalog, resourceRef: string, demandField: string, groupField: string | undefined): Promise<AllocateDemandRow[]> {
  const { bytes } = await catalog.readResourceBytes(resourceRef, catalog.deploymentDomain(), MAX_DECISION_RESOURCE_BYTES)
  const admitted = admitCollection(bytes, { enforceWgs84Range: true })
  const rows: AllocateDemandRow[] = []
  for (const [index, feature] of admitted.collection.features.entries()) {
    const entry = feature as { id?: unknown; geometry?: { type?: string; coordinates?: unknown } | null; properties?: Record<string, unknown> }
    if (entry.geometry?.type !== 'Point') continue
    const coordinates = entry.geometry.coordinates as unknown
    if (!Array.isArray(coordinates) || typeof coordinates[0] !== 'number' || typeof coordinates[1] !== 'number') continue
    const rawDemand = entry.properties?.[demandField]
    const rawGroup = groupField === undefined ? undefined : entry.properties?.[groupField]
    rows.push({
      id: typeof entry.id === 'string' ? entry.id : `demand-${index + 1}`,
      coordinates: [coordinates[0] as number, coordinates[1] as number],
      demand: typeof rawDemand === 'number' ? rawDemand : Number.NaN,
      group: typeof rawGroup === 'string' ? rawGroup : 'all',
    })
  }
  if (rows.length === 0) {
    throw new SpatialError('INVALID_ARGUMENT', `resource ${resourceRef} carries no Point demand rows`)
  }
  return rows
}

/** Common spec head parsing for every attribution/forecast tool. */
function specHead(args: Record<string, unknown>): { goalRevision: number; resourceRef: string } {
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

/** Parse the factor-field list argument. */
function factorFieldsOf(args: Record<string, unknown>): string[] {
  const fields = args.factor_fields
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > MAX_FACTORS || fields.some(field => typeof field !== 'string' || field.length === 0)) {
    throw new SpatialError('INVALID_ARGUMENT', `factor_fields must hold 1–${MAX_FACTORS} field names`)
  }
  return fields as string[]
}

/** Parse one interval level, writing the recorded default when absent. */
function intervalLevelOf(value: unknown): IntervalLevel {
  if (value === undefined) return DEFAULT_INTERVAL_LEVEL
  if (value === 0.8 || value === 0.9 || value === 0.95) return value
  throw new SpatialError('INVALID_ARGUMENT', 'interval_level must be 0.8, 0.9, or 0.95')
}

/** Parse the feature list argument of the forecast tools. */
function forecastFeaturesOf(args: Record<string, unknown>): { field: string; availability: 'known-at-origin' | 'concurrent' }[] {
  const features = args.features
  if (features === undefined) return []
  if (!Array.isArray(features) || features.length > 8) {
    throw new SpatialError('INVALID_ARGUMENT', 'features must hold at most 8 entries')
  }
  return features.map((feature, index) => {
    const entry = feature as { field?: unknown; availability?: unknown }
    if (typeof entry?.field !== 'string' || entry.field.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', `features[${index}].field must be a field name`)
    }
    if (entry.availability !== 'known-at-origin' && entry.availability !== 'concurrent') {
      throw new SpatialError('INVALID_ARGUMENT', `features[${index}].availability must be known-at-origin or concurrent`)
    }
    return { field: entry.field, availability: entry.availability }
  })
}

/** Parse the scenario weights argument; absence selects the recorded default scenario. */
function scenarioWeightsOf(args: Record<string, unknown>): { coverage: number; equity: number; cost: number } | undefined {
  const raw = args.weights
  if (raw === undefined) return undefined
  const weights = raw as { coverage?: unknown; equity?: unknown; cost?: unknown }
  for (const key of ['coverage', 'equity', 'cost'] as const) {
    if (typeof weights[key] !== 'number' || !Number.isFinite(weights[key]) || (weights[key] as number) < 0) {
      throw new SpatialError('INVALID_ARGUMENT', `weights.${key} must be a finite non-negative number`)
    }
  }
  return { coverage: weights.coverage as number, equity: weights.equity as number, cost: weights.cost as number }
}

/** Assemble one tool result: bounded summary + durable meta from one evidence. */
function decisionResult(options: {
  readonly tool: DecisionToolName
  readonly status: DecisionStatus
  readonly notApplicableReason?: string | undefined
  readonly claimLevel?: string | null
  readonly spec: DecisionSpec
  readonly headline: SpatialDecisionHeadline
  readonly limitations: readonly string[]
  readonly artifacts: readonly { label: string; ref: string }[]
  readonly summary: Record<string, unknown>
}): JsonValue {
  const { tool, status, notApplicableReason, claimLevel, spec, headline, limitations, artifacts, summary } = options
  const meta = buildSpatialDecisionMeta({
    tool,
    status,
    claimLevel: claimLevel ?? null,
    methodVersion: DECISION_METHOD_VERSION,
    resourceRef: 'resourceRef' in spec && typeof spec.resourceRef === 'string' ? spec.resourceRef : null,
    field: 'outcomeField' in spec && typeof spec.outcomeField === 'string' ? spec.outcomeField
      : 'demandField' in spec && typeof spec.demandField === 'string' ? spec.demandField : null,
    goalRevision: spec.goalRevision,
    specDigest: decisionSpecDigestOf(spec),
    headline,
    notApplicableReason: notApplicableReason ?? null,
    artifactRefs: artifacts.map(artifact => artifact.ref),
    limitations,
  })
  return {
    ...summary,
    status,
    ...(notApplicableReason === undefined ? {} : { not_applicable_reason: notApplicableReason }),
    ...(claimLevel === undefined ? {} : { claim_level: claimLevel }),
    method_version: DECISION_METHOD_VERSION,
    spec_digest: decisionSpecDigestOf(spec),
    artifact_refs: artifacts.map(artifact => artifact.ref),
    limitations,
    meta,
  } as unknown as JsonValue
}

/** The evidence head every attribution result projects into the shared result shape. */
function attributionHead(evidence: { status: string; notApplicableReason?: string | undefined; limitations: readonly string[]; artifacts: readonly { label: string; ref: string }[] }): {
  status: DecisionStatus
  notApplicableReason: string | undefined
  limitations: readonly string[]
  artifacts: readonly { label: string; ref: string }[]
} {
  return {
    status: evidence.status as DecisionStatus,
    notApplicableReason: evidence.notApplicableReason,
    limitations: evidence.limitations,
    artifacts: evidence.artifacts,
  }
}

/**
 * `attribution_association`: per-factor correlation with a seeded permutation
 * test. The claim level is fixed at `association`.
 */
export const attributionAssociation = defineTool({
  name: 'attribution_association',
  description:
    'Measure the association of one outcome field with candidate factor fields over one registered resource '
    + 'version: per-factor Pearson and Spearman correlations with seeded permutation p-values. The claim level '
    + 'is always `association` — these are correlations, never causal effects — and constant outcomes or thin '
    + 'tables are honest not_applicable results. Publishes the full factor table as an artifact.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this analysis belongs to.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the Point analysis rows.' },
    outcome_field: { type: 'string', required: true, description: 'Numeric outcome property.' },
    factor_fields: { type: 'array', required: true, items: { type: 'string' }, description: '1–8 candidate factor property names.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderDecisionJson(value),
    presentationMeta: (_args, value) => decisionPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { outcome_field: outcomeField } = args as Record<string, unknown>
    const head = specHead(args)
    const factorFields = factorFieldsOf(args)
    const spec: AssociationSpec = {
      ...head,
      outcomeField: typeof outcomeField === 'string' ? outcomeField : '',
      factorFields,
      methodVersion: DECISION_METHOD_VERSION,
    }
    requireValidSpec(validateAssociationSpec(spec))
    const context = decisionModelContextOf(exec, 'attribution_association')
    const rows = await readAnalysisRows(context.catalog, spec.resourceRef, [spec.outcomeField, ...factorFields])
    exec.signal.throwIfAborted()
    const evidence = await computeAssociation(rows, spec, publishSeam(context, [spec.resourceRef], 'attribution-association'))
    const peak = evidence.factors.reduce((max, factor) => Math.max(max, Math.abs(factor.pearson ?? 0)), 0)
    return decisionResult({
      tool: 'attribution_association',
      ...attributionHead(evidence),
      claimLevel: evidence.claimLevel,
      spec,
      headline: { metric: 'max_abs_pearson', value: evidence.factors.length > 0 ? peak : null },
      summary: { factors: evidence.factors, rows_used: evidence.accounting.used, dropped: evidence.accounting.droppedByReason },
    })
  },
})

/**
 * `attribution_explain`: standardized OLS contribution shares with VIF
 * collinearity diagnostics. The claim level is fixed at `model-explanation`.
 */
export const attributionExplain = defineTool({
  name: 'attribution_explain',
  description:
    'Explain one outcome field with a linear model over candidate factor fields: standardized contribution '
    + 'shares, R², and variance-inflation collinearity flags. The shares explain the fitted model under its '
    + 'declared factors — the claim level stays `model-explanation`, and omitted factors or collinearity can '
    + 'change them. Same-source artifacts and exploratory factor choices are never independent confirmatory '
    + 'evidence. Publishes the full table as an artifact.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this analysis belongs to.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the Point analysis rows.' },
    outcome_field: { type: 'string', required: true, description: 'Numeric outcome property.' },
    factor_fields: { type: 'array', required: true, items: { type: 'string' }, description: '1–8 candidate factor property names.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderDecisionJson(value),
    presentationMeta: (_args, value) => decisionPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { outcome_field: outcomeField } = args as Record<string, unknown>
    const head = specHead(args)
    const factorFields = factorFieldsOf(args)
    const spec: ExplainSpec = {
      ...head,
      outcomeField: typeof outcomeField === 'string' ? outcomeField : '',
      factorFields,
      methodVersion: DECISION_METHOD_VERSION,
    }
    requireValidSpec(validateExplainSpec(spec))
    const context = decisionModelContextOf(exec, 'attribution_explain')
    const rows = await readAnalysisRows(context.catalog, spec.resourceRef, [spec.outcomeField, ...factorFields])
    exec.signal.throwIfAborted()
    const evidence = await computeExplain(rows, spec, publishSeam(context, [spec.resourceRef], 'attribution-explain'))
    return decisionResult({
      tool: 'attribution_explain',
      ...attributionHead(evidence),
      claimLevel: evidence.claimLevel,
      spec,
      headline: { metric: 'r_squared', value: evidence.status === 'succeeded' ? evidence.rSquared : null },
      summary: {
        contributions: evidence.contributions,
        vif: evidence.vif,
        r_squared: evidence.rSquared,
        adjusted_r_squared: evidence.adjustedRSquared,
        residual_sigma: evidence.residualSigma,
        rows_used: evidence.accounting.used,
        dropped: evidence.accounting.droppedByReason,
      },
    })
  },
})

/**
 * `attribution_effect`: the controlled effect estimate with identification
 * design, diagnostics, interval, and honest claim levels.
 */
export const attributionEffect = defineTool({
  name: 'attribution_effect',
  description:
    'Estimate one treatment\'s effect on an outcome under an explicit identification design '
    + '(covariate-adjustment or two-period difference-in-differences) with balance, overlap, and interference '
    + 'diagnostics and a t interval. The claim level reaches `causal` only when a design is declared and every '
    + 'diagnostic passes; otherwise the same numbers are reported at the `association` level with named '
    + 'downgrade reasons. Unmeasured confounding is never excluded by these diagnostics alone. Publishes the '
    + 'diagnostics table as an artifact.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this analysis belongs to.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the analysis rows (panel rows for difference-in-differences).' },
    outcome_field: { type: 'string', required: true, description: 'Numeric outcome property.' },
    factor_fields: { type: 'array', required: true, items: { type: 'string' }, description: '1–8 control/covariate property names.' },
    treatment_field: { type: 'string', required: true, description: 'Binary treatment property.' },
    treated_value: { oneOf: [{ type: 'boolean' }, { type: 'number' }, { type: 'string' }], required: true, description: 'Row value marking the treated group.' },
    design: { type: 'string', description: 'covariate-adjustment or difference-in-differences. Absent: the estimate reports at the association level with a named downgrade reason.' },
    period_field: { type: 'string', description: 'Pre/post property (difference-in-differences).' },
    pre_value: { oneOf: [{ type: 'boolean' }, { type: 'number' }, { type: 'string' }], description: 'Row value marking the pre period.' },
    post_value: { oneOf: [{ type: 'boolean' }, { type: 'number' }, { type: 'string' }], description: 'Row value marking the post period.' },
    unit_field: { type: 'string', description: 'Property grouping panel rows into one unit (difference-in-differences).' },
    interference_band_meters: { type: 'number', description: 'Interference band: controls with treated neighbors inside it trigger the spillover downgrade. Declaring it is required for the causal level.' },
    interval_level: { type: 'number', description: 'Interval level 0.8, 0.9 (default), or 0.95; recorded in the spec.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderDecisionJson(value),
    presentationMeta: (_args, value) => decisionPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const {
      outcome_field: outcomeField, treatment_field: treatmentField, treated_value: treatedValue,
      design, period_field: periodField, pre_value: preValue, post_value: postValue, unit_field: unitField,
      interference_band_meters: interferenceBandMeters,
    } = args as Record<string, unknown>
    const head = specHead(args)
    const factorFields = factorFieldsOf(args)
    if (treatedValue === undefined) throw new SpatialError('INVALID_ARGUMENT', 'treated_value marks which row value counts as treated')
    const spec: EffectSpec = {
      ...head,
      outcomeField: typeof outcomeField === 'string' ? outcomeField : '',
      factorFields,
      treatmentField: typeof treatmentField === 'string' ? treatmentField : '',
      treatedValue: treatedValue as boolean | number | string,
      ...(design === undefined ? {} : { design: design as 'covariate-adjustment' | 'difference-in-differences' }),
      ...(periodField === undefined ? {} : { periodField: periodField as string }),
      ...(preValue === undefined ? {} : { preValue: preValue as boolean | number | string }),
      ...(postValue === undefined ? {} : { postValue: postValue as boolean | number | string }),
      ...(unitField === undefined ? {} : { unitField: unitField as string }),
      ...(interferenceBandMeters === undefined ? {} : { interferenceBandMeters: interferenceBandMeters as number }),
      intervalLevel: intervalLevelOf(args.interval_level),
      methodVersion: DECISION_METHOD_VERSION,
    }
    requireValidSpec(validateEffectSpec(spec))
    const context = decisionModelContextOf(exec, 'attribution_effect')
    const rows = await readAnalysisRows(
      context.catalog,
      spec.resourceRef,
      [spec.outcomeField, ...factorFields],
      [spec.treatmentField, ...(spec.periodField !== undefined ? [spec.periodField] : []), ...(spec.unitField !== undefined ? [spec.unitField] : [])],
    )
    exec.signal.throwIfAborted()
    const evidence = await computeEffect(rows, spec, publishSeam(context, [spec.resourceRef], 'attribution-effect'))
    return decisionResult({
      tool: 'attribution_effect',
      ...attributionHead(evidence),
      claimLevel: evidence.claimLevel,
      spec,
      headline: { metric: 'effect_estimate', value: evidence.interval?.estimate ?? null },
      summary: {
        design: evidence.design,
        downgrade_reasons: evidence.downgradeReasons,
        interval: evidence.interval,
        diagnostics: evidence.diagnostics,
        interference: evidence.interference,
        assumptions: evidence.assumptions,
        treated_rows: evidence.treatedRows,
        control_rows: evidence.controlRows,
        did: evidence.did === null ? null : {
          units_used: evidence.did.unitsUsed,
          units_dropped: evidence.did.unitsDropped,
          treated_delta_mean: evidence.did.treatedDeltaMean,
          control_delta_mean: evidence.did.controlDeltaMean,
        },
        rows_used: evidence.accounting.used,
        dropped: evidence.accounting.droppedByReason,
      },
    })
  },
})

/** The forecast window argument pair. */
function forecastWindowOf(args: Record<string, unknown>): { from: string; to: string } {
  const from = args.training_from
  const to = args.training_to
  if (typeof from !== 'string' || typeof to !== 'string') {
    throw new SpatialError('INVALID_ARGUMENT', 'training_from and training_to are required ISO timestamps (training_to is the training cutoff)')
  }
  return { from, to }
}

/** The shared resolution of the forecast validate/fit spec. */
function forecastSpecOf(args: Record<string, unknown>): ForecastSpec {
  const { outcome_field: outcomeField, time_field: timeField } = args as Record<string, unknown>
  const head = specHead(args)
  const granularity = args.granularity === undefined ? 'day' : args.granularity
  if (granularity !== 'day' && granularity !== 'week' && granularity !== 'month') {
    throw new SpatialError('INVALID_ARGUMENT', 'granularity must be day, week, or month')
  }
  const baseline = args.baseline === undefined ? 'naive' : args.baseline
  if (baseline !== 'naive' && baseline !== 'mean') {
    throw new SpatialError('INVALID_ARGUMENT', 'baseline must be naive or mean')
  }
  const modelFamily = args.model_family === undefined ? 'linear' : args.model_family
  if (modelFamily !== 'linear' && modelFamily !== 'threshold' && modelFamily !== 'quadratic-ridge') {
    throw new SpatialError('INVALID_ARGUMENT', 'model_family must be linear, threshold, or quadratic-ridge')
  }
  const holdoutSteps = args.holdout_steps === undefined ? DEFAULT_HOLDOUT_STEPS : args.holdout_steps
  const blockMeters = args.block_meters
  if (typeof blockMeters !== 'number' || !Number.isFinite(blockMeters) || blockMeters <= 0) {
    throw new SpatialError('INVALID_ARGUMENT', 'block_meters must be a positive number (the spatial validation grid)')
  }
  const spec: ForecastSpec = {
    ...head,
    outcomeField: typeof outcomeField === 'string' ? outcomeField : '',
    timeField: typeof timeField === 'string' ? timeField : '',
    features: forecastFeaturesOf(args),
    window: forecastWindowOf(args),
    granularity,
    baseline,
    modelFamily,
    holdoutSteps: typeof holdoutSteps === 'number' ? holdoutSteps : Number.NaN,
    blockMeters,
    intervalLevel: intervalLevelOf(args.interval_level),
    methodVersion: DECISION_METHOD_VERSION,
  }
  requireValidSpec(validateForecastSpec(spec))
  return spec
}

/**
 * `forecast_validate`: the time-forward holdout against the declared
 * baseline, with spatial-block rows and empirical interval coverage.
 */
export const forecastValidate = defineTool({
  name: 'forecast_validate',
  description:
    'Validate a forecast honestly: fit through the training cutoff, evaluate on the last `holdout_steps` time '
    + 'bins (time-forward by construction), and compare against the declared simple baseline. Concurrent '
    + 'features are refused — their holdout values would not have existed at the cutoff, which is leakage. '
    + 'Reports MAE/RMSE for the model and the baseline, skill, empirical interval coverage, and per-spatial-'
    + 'block validation rows. Publishes the per-row table as an artifact.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this analysis belongs to.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the historical Point rows.' },
    outcome_field: { type: 'string', required: true, description: 'Numeric outcome property.' },
    time_field: { type: 'string', required: true, description: 'Property holding each row\'s ISO event time.' },
    features: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', required: true },
          availability: { type: 'string', enum: ['known-at-origin', 'concurrent'], required: true },
        },
        additionalProperties: false,
      },
      description: 'Up to 8 { field, availability } entries; availability is known-at-origin or concurrent (concurrent is refused here).',
    },
    training_from: { type: 'string', required: true, description: 'Training window start (ISO).' },
    training_to: { type: 'string', required: true, description: 'Training cutoff (ISO, exclusive): rows at or after it never enter the fit.' },
    block_meters: { type: 'number', required: true, description: 'Spatial block size in meters for the per-block validation rows.' },
    granularity: { type: 'string', description: 'day (default), week, or month — the UTC bin.' },
    baseline: { type: 'string', description: 'naive (default, last training bin) or mean — the comparison baseline.' },
    model_family: { type: 'string', enum: ['linear', 'threshold', 'quadratic-ridge'], description: 'linear (default), threshold (single feature split), or quadratic-ridge (explicit squares with fixed ridge penalty).' },
    holdout_steps: { type: 'number', description: 'Last k bins held out (1–64, default 4).' },
    interval_level: { type: 'number', description: 'Interval level 0.8, 0.9 (default), or 0.95.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderDecisionJson(value),
    presentationMeta: (_args, value) => decisionPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const spec = forecastSpecOf(args)
    const context = decisionModelContextOf(exec, 'forecast_validate')
    const rows = await readForecastRows(context.catalog, spec.resourceRef, spec.timeField, [spec.outcomeField, ...spec.features.map(feature => feature.field)])
    exec.signal.throwIfAborted()
    const evidence = await computeForecastValidation(rows, spec, publishSeam(context, [spec.resourceRef], 'forecast-validation'))
    return decisionResult({
      tool: 'forecast_validate',
      status: evidence.status,
      notApplicableReason: evidence.notApplicableReason,
      limitations: evidence.limitations,
      artifacts: evidence.artifacts,
      spec,
      headline: { metric: 'skill', value: evidence.skill },
      summary: {
        train_rows: evidence.trainRows,
        holdout_rows: evidence.holdoutRows,
        holdout_bins: evidence.holdoutBins,
        model: evidence.model,
        baseline: evidence.baseline,
        model_family: evidence.modelFamily,
        skill: evidence.skill,
        interval_coverage: evidence.intervalCoverage,
        blocks: evidence.blocks.slice(0, 16),
        late_rows: evidence.lateRows,
        dropped: evidence.accounting.droppedByReason,
      },
    })
  },
})

/**
 * `forecast_fit`: fit through the training cutoff and publish the model
 * record `forecast_predict` consumes.
 */
export const forecastFit = defineTool({
  name: 'forecast_fit',
  description:
    'Fit the selected linear, threshold, or quadratic-ridge model through the declared training cutoff and publish it as a versioned '
    + 'model artifact (the ref forecast_predict consumes). In-sample R² is reported but is not predictive skill — '
    + 'run forecast_validate against the baseline first. Models using concurrent features record them, and '
    + 'forecast_predict will refuse such models.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this analysis belongs to.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the historical Point rows.' },
    outcome_field: { type: 'string', required: true, description: 'Numeric outcome property.' },
    time_field: { type: 'string', required: true, description: 'Property holding each row\'s ISO event time.' },
    features: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', required: true },
          availability: { type: 'string', enum: ['known-at-origin', 'concurrent'], required: true },
        },
        additionalProperties: false,
      },
      description: 'Up to 8 { field, availability } entries.',
    },
    training_from: { type: 'string', required: true, description: 'Training window start (ISO).' },
    training_to: { type: 'string', required: true, description: 'Training cutoff (ISO, exclusive).' },
    block_meters: { type: 'number', required: true, description: 'Spatial block size in meters (kept identical to forecast_validate).' },
    granularity: { type: 'string', description: 'day (default), week, or month.' },
    baseline: { type: 'string', description: 'naive (default) or mean — the baseline the model reports against.' },
    model_family: { type: 'string', enum: ['linear', 'threshold', 'quadratic-ridge'], description: 'linear (default), threshold (single feature split), or quadratic-ridge (explicit squares with fixed ridge penalty).' },
    interval_level: { type: 'number', description: 'Interval level 0.8, 0.9 (default), or 0.95.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderDecisionJson(value),
    presentationMeta: (_args, value) => decisionPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const spec = forecastSpecOf(args)
    const context = decisionModelContextOf(exec, 'forecast_fit')
    const rows = await readForecastRows(context.catalog, spec.resourceRef, spec.timeField, [spec.outcomeField, ...spec.features.map(feature => feature.field)])
    exec.signal.throwIfAborted()
    const evidence = await computeForecastFit(rows, spec, decisionSpecDigestOf(spec), publishSeam(context, [spec.resourceRef], 'forecast-model'))
    return decisionResult({
      tool: 'forecast_fit',
      status: evidence.status,
      limitations: evidence.limitations,
      artifacts: evidence.artifacts,
      spec,
      headline: { metric: 'r_squared_in_sample', value: evidence.rSquared },
      summary: {
        train_rows: evidence.trainRows,
        r_squared: evidence.rSquared,
        adjusted_r_squared: evidence.adjustedRSquared,
        residual_sigma: evidence.residualSigma,
        model_family: evidence.modelFamily,
        coefficients: evidence.coefficients,
        model_ref: evidence.artifacts.find(artifact => artifact.label === 'forecast-model')?.ref ?? null,
        dropped: evidence.accounting.droppedByReason,
      },
    })
  },
})

/**
 * `forecast_predict`: per-row predictions with intervals, baselines,
 * out-of-domain flags, and drift detection from a published model artifact.
 */
export const forecastPredict = defineTool({
  name: 'forecast_predict',
  description:
    'Predict `horizon_steps` bins past a fitted model\'s training cutoff for the prediction-origin rows. Reads '
    + 'the published model artifact (method-version drift is refused), enforces feature availability (concurrent '
    + 'features are refused — future values are unknowable), compares against the baseline, and flags '
    + 'out-of-domain feature values and drifted feature means instead of extrapolating silently. Publishes the '
    + 'prediction table as an artifact.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this analysis belongs to.' },
    model_ref: { type: 'string', required: true, description: 'Exact artifact ref (art-…@vN) from forecast_fit.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the prediction-origin Point rows (feature values only).' },
    horizon_steps: { type: 'number', description: 'Forward steps in bins (1–64, default 1).' },
    interval_level: { type: 'number', description: 'Interval level 0.8, 0.9 (default), or 0.95.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderDecisionJson(value),
    presentationMeta: (_args, value) => decisionPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { model_ref: modelRef } = args as Record<string, unknown>
    const head = specHead(args)
    const horizonSteps = args.horizon_steps === undefined ? 1 : args.horizon_steps
    if (typeof modelRef !== 'string' || modelRef.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'model_ref must be an exact published artifact ref art-…@vN from forecast_fit')
    }
    const spec: ForecastPredictSpec = {
      goalRevision: head.goalRevision,
      modelRef,
      resourceRef: head.resourceRef,
      horizonSteps: typeof horizonSteps === 'number' ? horizonSteps : Number.NaN,
      intervalLevel: intervalLevelOf(args.interval_level),
      methodVersion: DECISION_METHOD_VERSION,
    }
    requireValidSpec(validateForecastPredictSpec(spec))
    const context = decisionModelContextOf(exec, 'forecast_predict')
    const { bytes } = await context.catalog.readArtifactBytes(spec.modelRef, context.catalog.deploymentDomain())
    let model: FittedForecastModel
    try {
      model = JSON.parse(new TextDecoder().decode(bytes)) as FittedForecastModel
    } catch (error: unknown) {
      throw new SpatialError('INVALID_ARGUMENT', `model artifact ${spec.modelRef} does not decode as a fitted forecast model (${String(error instanceof Error ? error.message : error)})`)
    }
    const featureNames = model.features?.map(feature => feature.field) ?? []
    const rows = await readForecastRows(context.catalog, spec.resourceRef, '__prediction_origin__', featureNames)
    exec.signal.throwIfAborted()
    const evidence = await computeForecastPredict(rows, model, spec, publishSeam(context, [spec.modelRef, spec.resourceRef], 'forecast-prediction'))
    return decisionResult({
      tool: 'forecast_predict',
      status: evidence.status,
      limitations: evidence.limitations,
      artifacts: evidence.artifacts,
      spec,
      headline: { metric: 'prediction_rows', value: evidence.rows.length },
      summary: {
        model_ref: evidence.modelRef,
        horizon_bins: evidence.horizonBins,
        rows: evidence.rows.slice(0, 16),
        row_count: evidence.rows.length,
        drifted_features: evidence.driftedFeatures,
        rows_out_of_domain: evidence.rowsOutOfDomain,
        model_family: evidence.modelFamily,
        dropped: evidence.accounting.droppedByReason,
      },
    })
  },
})

/**
 * `scenario_compare`: rank the given candidates against the status-quo zero
 * point under explicit weights, keep infeasible candidates named, sweep the
 * weights.
 */
export const scenarioCompare = defineTool({
  name: 'scenario_compare',
  description:
    'Compare the given candidate schemes (up to 16) against the status quo under explicit coverage/equity/cost '
    + 'weights. Every candidate stays in the output: infeasible ones keep their named reasons (overpromise, '
    + 'capacity-exceeded, over-budget) and no rank. Absent weights select one recorded default scenario that is '
    + 'flagged `default_scenario` — never the objective unique optimum. The sensitivity table re-ranks under the '
    + 'fixed weight sweep and reports whether the top candidate is stable. This ranks given candidates only; it '
    + 'is not a global optimum.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this analysis belongs to.' },
    groups: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          demand: { type: 'number', required: true },
        },
        additionalProperties: false,
      },
      description: '1–16 { id, demand } groups; demand is the coverage weight.',
    },
    candidates: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          cost: { type: 'number', required: true },
          capacity: { type: 'number' },
          served: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                group: { type: 'string', required: true },
                amount: { type: 'number', required: true },
              },
              additionalProperties: false,
            },
            required: true,
          },
        },
        additionalProperties: false,
      },
      description: '1–16 { id, cost, served, capacity? } schemes; served lists { group, amount } pairs.',
    },
    budget: { type: 'number', description: 'Total-cost budget; candidates above it stay listed as infeasible.' },
    weights: {
      type: 'object',
      properties: {
        coverage: { type: 'number', required: true },
        equity: { type: 'number', required: true },
        cost: { type: 'number', required: true },
      },
      additionalProperties: false,
      description: '{ coverage, equity, cost } value weights; absence selects the flagged default scenario.',
    },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderDecisionJson(value),
    presentationMeta: (_args, value) => decisionPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { groups, candidates, budget } = args as Record<string, unknown>
    const goalRevision = args.goal_revision
    if (typeof goalRevision !== 'number' || !Number.isInteger(goalRevision) || goalRevision < 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'goal_revision must be a non-negative integer')
    }
    if (!Array.isArray(groups) || groups.length === 0 || !Array.isArray(candidates) || candidates.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'groups and candidates must be non-empty arrays')
    }
    const weights = scenarioWeightsOf(args)
    const resolvedCandidates = (candidates as Array<Record<string, unknown>>).map(candidate => {
      const served = candidate.served
      if (!Array.isArray(served)) {
        throw new SpatialError('INVALID_ARGUMENT', `candidate ${String(candidate.id)} must list its served amounts as { group, amount } pairs`)
      }
      const servedByGroup: Record<string, number> = {}
      for (const entry of served as Array<Record<string, unknown>>) {
        servedByGroup[String(entry.group)] = entry.amount as number
      }
      return {
        id: String(candidate.id),
        servedByGroup,
        cost: candidate.cost as number,
        ...(candidate.capacity === undefined ? {} : { capacity: candidate.capacity as number }),
      }
    })
    const spec: ScenarioCompareSpec = {
      goalRevision,
      groups: groups as ScenarioCompareSpec['groups'],
      candidates: resolvedCandidates,
      ...(budget === undefined ? {} : { budget: budget as number }),
      ...(weights === undefined ? {} : { weights }),
      methodVersion: DECISION_METHOD_VERSION,
    }
    requireValidSpec(validateScenarioCompareSpec(spec))
    exec.signal.throwIfAborted()
    // scenario_compare consumes no resource version and publishes no artifact: the full
    // table is bounded (≤ 16 candidates) and already model-visible, so no publish
    // pairing applies and the catalog service is not consulted at all.
    const evidence = await compareScenarios(spec, null)
    const top = evidence.rows.find(row => row.id === evidence.topId)
    return decisionResult({
      tool: 'scenario_compare',
      status: evidence.status,
      notApplicableReason: evidence.notApplicableReason,
      limitations: evidence.limitations,
      artifacts: evidence.artifacts,
      spec,
      headline: { metric: 'top_objective', value: top?.objective ?? null },
      summary: {
        rows: evidence.rows.map(row => ({
          id: row.id,
          feasible: row.feasible,
          infeasible_reasons: row.infeasibleReasons,
          coverage_share: row.coverageShare,
          worst_group_share: row.worstGroupShare,
          cost_norm: row.costNorm,
          objective: row.objective,
          beats_status_quo: row.beatsStatusQuo,
          rank: row.rank,
        })),
        top_id: evidence.topId,
        default_scenario: evidence.defaultScenario,
        sensitivity: evidence.sensitivity,
        rank_stable: evidence.rankStable,
      },
    })
  },
})

/**
 * `location_allocate`: capacity- and budget-constrained opening with nearest-
 * site assignment, equity groups, and weight sensitivity. The optional global
 * mode exhaustively searches a bounded declared candidate domain.
 */
export const locationAllocate = defineTool({
  name: 'location_allocate',
  description:
    'Allocate demand points to candidate sites under a budget and per-site capacity: the documented greedy rule '
    + 'opens sites by marginal weighted objective (coverage/equity/cost weights) with capacity-capped nearest-'
    + 'site assignment. Unaffordable sites stay closed and named; capacity shortfalls and uncovered rows keep '
    + 'the honest partial status; absent weights select the flagged default scenario. Optional global mode '
    + 'enumerates the bounded declared affordable-site domain and reports its greedy comparison. Publishes the allocation table as an artifact.',
  parameters: {
    goal_revision: { type: 'number', required: true, description: 'Goal revision this analysis belongs to.' },
    resource_ref: { type: 'string', required: true, description: 'Exact resource ref (res-…@vN) of the Point demand rows.' },
    demand_field: { type: 'string', required: true, description: 'Numeric demand property.' },
    group_field: { type: 'string', description: 'Property partitioning demand into equity groups; rows without it form the group "all".' },
    sites: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', required: true },
          lon: { type: 'number', required: true },
          lat: { type: 'number', required: true },
          capacity: { type: 'number', required: true },
          cost: { type: 'number', required: true },
        },
        additionalProperties: false,
      },
      description: `1–${MAX_SITES} { id, lon, lat, capacity, cost } candidate sites.`,
    },
    coverage_radius_meters: { type: 'number', required: true, description: 'Cover radius in meters (great-circle).' },
    budget: { type: 'number', description: 'Opening budget; sites above it stay closed and named.' },
    mode: { type: 'string', enum: ['greedy', 'global'], description: 'greedy (default) or global bounded exhaustive search over the declared affordable sites.' },
    weights: {
      type: 'object',
      properties: {
        coverage: { type: 'number', required: true },
        equity: { type: 'number', required: true },
        cost: { type: 'number', required: true },
      },
      additionalProperties: false,
      description: '{ coverage, equity, cost } value weights; absence selects the flagged default scenario.',
    },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderDecisionJson(value),
    presentationMeta: (_args, value) => decisionPresentationMeta(value),
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { demand_field: demandField, group_field: groupField, sites, coverage_radius_meters: coverageRadiusMeters, budget, mode: rawMode } = args as Record<string, unknown>
    const head = specHead(args)
    if (!Array.isArray(sites) || sites.length === 0 || sites.length > MAX_SITES) {
      throw new SpatialError('INVALID_ARGUMENT', `sites must hold 1–${MAX_SITES} candidate sites`)
    }
    if (typeof coverageRadiusMeters !== 'number' || !Number.isFinite(coverageRadiusMeters) || coverageRadiusMeters <= 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'coverage_radius_meters must be a positive number')
    }
    const weights = scenarioWeightsOf(args)
    const mode = rawMode === undefined ? 'greedy' : rawMode
    if (mode !== 'greedy' && mode !== 'global') {
      throw new SpatialError('INVALID_ARGUMENT', 'mode must be greedy or global')
    }
    const spec: LocationAllocateSpec = {
      ...head,
      demandField: typeof demandField === 'string' ? demandField : '',
      ...(groupField === undefined ? {} : { groupField: groupField as string }),
      sites: sites as LocationAllocateSpec['sites'],
      coverageRadiusMeters,
      ...(budget === undefined ? {} : { budget: budget as number }),
      ...(weights === undefined ? {} : { weights }),
      mode,
      methodVersion: DECISION_METHOD_VERSION,
    }
    requireValidSpec(validateLocationAllocateSpec(spec))
    const context = decisionModelContextOf(exec, 'location_allocate')
    const rows = await readDemandRows(context.catalog, spec.resourceRef, spec.demandField, spec.groupField)
    exec.signal.throwIfAborted()
    const evidence = await allocateLocations(rows, spec, publishSeam(context, [spec.resourceRef], 'location-allocation'))
    return decisionResult({
      tool: 'location_allocate',
      status: evidence.status,
      notApplicableReason: evidence.notApplicableReason,
      limitations: evidence.limitations,
      artifacts: evidence.artifacts,
      spec,
      headline: { metric: 'covered_share', value: evidence.totalDemand > 0 ? evidence.coveredDemand / evidence.totalDemand : null },
      summary: {
        sites: evidence.sites.slice(0, 16),
        site_count: evidence.sites.length,
        groups: evidence.groups.slice(0, 16),
        total_demand: evidence.totalDemand,
        covered_demand: evidence.coveredDemand,
        uncovered_rows: evidence.uncoveredRows,
        capacity_shortfall: evidence.capacityShortfall,
        objective: evidence.objective,
        default_scenario: evidence.defaultScenario,
        sensitivity: evidence.sensitivity,
        rank_stable: evidence.rankStable,
        mode: evidence.mode,
        opened_site_ids: evidence.openedSiteIds,
        greedy_objective: evidence.greedyObjective,
        objective_delta_vs_greedy: evidence.objectiveDeltaVsGreedy,
        enumeration: evidence.enumeration,
        dropped: evidence.accounting.droppedByReason,
      },
    })
  },
})
