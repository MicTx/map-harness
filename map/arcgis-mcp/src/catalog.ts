import type { ToolDefinition, ToolExecution, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  geoArea,
  geoBuffer,
  geoDistance,
  geoIntersect,
  mapAddLayer,
  mapGetState,
  mapRemoveLayer,
  mapSetMode,
  mapSetView,
  catalogRegister,
  catalogResolve,
  mapSave,
  decisionUpdate,
  runSubmit,
  runGet,
  runCancel,
  statsZonal,
  statsAutocorrelation,
  statsHotspot,
  patternChange,
  patternCluster,
  patternFlow,
  attributionAssociation,
  attributionExplain,
  attributionEffect,
  forecastValidate,
  forecastFit,
  forecastPredict,
  scenarioCompare,
  locationAllocate,
  vizAggregate,
  vizCreateStyle,
  vizClassify,
  vizCompare,
  mapApplyPatch,
  mapUndo,
  terrainAddLayer,
  geoLineOfSight,
  terrainViewshed,
  streamOpen,
  streamAdvance,
  streamPause,
  streamResume,
  streamMaterialize,
  scaleIngest,
  scaleRead,
  scaleScan,
} from '@map-harness/map-tools'
import { McpServer, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server'
import { z } from 'zod'

const runSubmitInput = z.object({
  goal_revision: z.number().int().nonnegative().describe('Current goal revision this run belongs to (from the injected spatial snapshot).'),
  population_ref: z.string().describe('Exact population resource ref, `res-…@vN`.'),
  population_field: z.string().describe('Numeric property holding each unit\'s population.'),
  facility_refs: z.array(z.string()).min(1).describe('Exact facility resource refs, `res-…@vN`.'),
  travel_mode: z.enum(['walk', 'bike', 'drive']).describe('Network mode the impedance prices.'),
  max_minutes: z.number().positive().max(240).describe('Service-area budget in network minutes.'),
  time_slices: z.array(z.enum(['morning-peak', 'midday', 'evening-peak', 'night'])).min(1).describe('Time slices to evaluate.'),
  study_area: z.array(z.number()).length(4).describe('[west, south, east, north] result region.'),
  retrieval_extent: z.array(z.number()).length(4).describe('[west, south, east, north]; contains the study area.'),
  support_extent: z.array(z.number()).length(4).describe('[west, south, east, north]; contains the retrieval extent.'),
  observation_from: z.string().describe('Observation window start (ISO-8601 with offset).'),
  observation_to: z.string().describe('Observation window end, exclusive.'),
  training_from: z.string().optional().describe('Historical lookback start; must end at or before the observation start.'),
  training_to: z.string().optional().describe('Historical lookback end.'),
  entrances: z.array(z.object({ facility: z.string(), lon: z.number(), lat: z.number() }).strict()).optional().describe('Network access points; facilities without one are excluded and named.'),
  capacities: z.record(z.string(), z.number()).optional().describe('Facility id → maximum population served (hard cap).'),
  barriers: z.array(z.object({
    from: z.tuple([z.number(), z.number()]),
    to: z.tuple([z.number(), z.number()]),
    kind: z.enum(['blocked', 'delay']),
    delay_minutes: z.number().positive().optional(),
  }).strict()).optional().describe('Network obstructions.'),
  candidates: z.array(z.object({
    id: z.string(),
    label: z.string(),
    facilities: z.array(z.object({
      id: z.string(),
      lon: z.number(),
      lat: z.number(),
      capacity: z.number().nonnegative().optional(),
      entrance: z.tuple([z.number(), z.number()]).optional(),
    }).strict()).min(1),
    cost: z.number().nonnegative(),
  }).strict()).max(8).optional().describe('The given candidate options to compare (no global optimum).'),
  weights: z.object({ coverage: z.number().nonnegative(), equity: z.number().nonnegative(), cost: z.number().nonnegative() }).strict().optional().describe('Comparison weights; required with candidates.'),
  cost_budget: z.number().nonnegative().optional().describe('Total candidate cost budget.'),
  retry_of: z.number().int().nonnegative().optional().describe('Seq of this session\'s original run_submit `tool/call`: returns the already-submitted run and never resubmits.'),
}).strict()

const runIdInput = z.object({
  run_id: z.string().describe('The run_id run_submit returned.'),
}).strict()

/** The versioned resource + numeric field head every stats_* tool consumes. */
const statHeadInput = {
  goal_revision: z.number().int().nonnegative().describe('Goal revision this statistic belongs to.'),
  resource_ref: z.string().describe('Exact resource ref, `res-…@vN`.'),
  field: z.string().describe('Numeric property the statistic consumes.'),
}

/** The weight/standardization/permutation/testing block the weighted tools share. */
const weightedInput = {
  band_meters: z.number().positive().describe('Distance-band neighbor threshold in meters (great-circle).'),
  standardization: z.enum(['row', 'binary']).optional().describe('Weight standardization; row is the recorded default.'),
  permutations: z.number().int().min(9).max(999).optional().describe('Permutation redraws; 199 is the recorded default.'),
  seed: z.number().int().nonnegative().optional().describe('Deterministic permutation seed; 20260924 is the recorded default.'),
  multiple_testing: z.enum(['none', 'bonferroni', 'fdr-bh']).optional().describe('Local p-value correction; fdr-bh is the recorded default.'),
}

/** The window/coverage/holdout block the pattern tools share. */
const patternWindowInput = {
  observation_from: z.string().describe('Observation window start (ISO-8601 with offset).'),
  observation_to: z.string().describe('Observation window end, exclusive.'),
  granularity: z.enum(['day', 'week', 'month']).optional().describe('UTC calendar bin; day is the recorded default.'),
  min_coverage: z.number().gt(0).max(1).optional().describe('Occupied-bin fraction the window must reach; 0.6 is the recorded default.'),
  holdout_blocks: z.number().int().min(0).max(64).optional().describe('Last k bins held out for the stability check; 1 is the recorded default.'),
}

const statsZonalInput = z.object({
  ...statHeadInput,
  zone_field: z.string().optional().describe('Property whose distinct values form the zones.'),
  denominator_field: z.string().optional().describe('Positive denominator property enabling weighted mean and sum-rate.'),
}).strict()

const statsAutocorrelationInput = z.object({
  ...statHeadInput,
  ...weightedInput,
}).strict()

const statsHotspotInput = z.object({
  ...statHeadInput,
  ...weightedInput,
}).strict()

const patternChangeInput = z.object({
  ...statHeadInput,
  time_field: z.string().describe('Property holding each observation\'s ISO event time.'),
  baseline_from: z.string().describe('Baseline window start (ISO), inside the observation window.'),
  baseline_to: z.string().describe('Baseline window end, exclusive.'),
  comparison_from: z.string().describe('Comparison window start; at or after the baseline end (time-forward).'),
  comparison_to: z.string().describe('Comparison window end, exclusive.'),
  block_meters: z.number().positive().describe('Spatial block size in meters for the per-block delta rows.'),
  unit_field: z.string().optional().describe('Property grouping observations into one unit across time; absent means each feature is its own unit.'),
  ...patternWindowInput,
}).strict()

const patternClusterInput = z.object({
  ...statHeadInput,
  time_field: z.string().describe('Property holding each observation\'s ISO event time.'),
  eps_meters: z.number().positive().describe('Spatial radius in meters (great-circle).'),
  eps_bins: z.number().int().min(0).max(4096).describe('Temporal radius in granularity bins.'),
  min_pts: z.number().int().min(2).max(256).describe('Core-point threshold (neighbors including self).'),
  block_meters: z.number().positive().describe('Spatial block size in meters for the participation rows.'),
  ...patternWindowInput,
}).strict()

const patternFlowInput = z.object({
  goal_revision: z.number().int().nonnegative().describe('Goal revision this statistic belongs to.'),
  resource_ref: z.string().describe('Exact resource ref, `res-…@vN`.'),
  time_field: z.string().describe('Property holding each observation\'s ISO event time.'),
  entity_field: z.string().describe('Property identifying the moving entity.'),
  cell_meters: z.number().positive().describe('Flow grid cell size in meters.'),
  max_gap_bins: z.number().int().min(0).max(4096).optional().describe('Chain gaps above this many bins break the transition; 1 is the recorded default.'),
  top_k: z.number().int().min(1).max(256).optional().describe('Flows in the reported top table; 16 is the recorded default.'),
  ...patternWindowInput,
}).strict()

const vizStyleHeadInput = {
  field: z.string().min(1).describe('Numeric property to classify.'),
  unit: z.string().min(1).describe('Unit the legend labels.'),
  measure: z.enum(['total', 'rate', 'density']).optional().describe('total is the recorded default; rate/density classify the ratio over denominator_field.'),
  series_identity: z.enum(['observed', 'forecast', 'scenario']).optional().describe('observed is the recorded default; the legend declares the identity so a forecast layer is never mistaken for an observed one.'),
  denominator_field: z.string().optional().describe('Positive denominator property; required for rate/density, forbidden for total.'),
  classification: z.enum(['quantile', 'equal-interval', 'manual']).optional().describe('quantile is the recorded default.'),
  class_count: z.number().int().min(2).max(12).optional().describe('Classes in [2, 12]; 5 is the recorded default. Tied data collapses honestly to fewer.'),
  breaks: z.array(z.number()).min(1).max(11).optional().describe('Manual strictly increasing class boundaries (classification=manual only).'),
  breaks_source_ref: z.string().optional().describe('Exact res-…@vN / art-…@vN the manual breaks came from; required for manual, forbidden otherwise.'),
  encoding: z.enum(['fill', 'size']).optional().describe('fill is the recorded default; size point encoding needs measure=total.'),
  time_field: z.string().optional().describe('With timezone/time_from/time_to: the temporal binding the workbench timeline uses.'),
  timezone: z.string().optional().describe('IANA zone the timeline renders in.'),
  granularity: z.enum(['hour', 'day', 'week', 'month']).optional().describe('day is the recorded default.'),
  time_from: z.string().optional().describe('Half-open timeline window start, ISO.'),
  time_to: z.string().optional().describe('Half-open timeline window end, exclusive.'),
}

const vizCreateStyleInput = z.object({
  resource_ref: z.string().describe('Exact resource ref, `res-…@vN`, the values classify from.'),
  ...vizStyleHeadInput,
}).strict()

const vizAggregateInput = z.object({
  resource_ref: z.string().describe('Exact resource ref, `res-…@vN`, the features aggregate from.'),
  layer_id: z.string().min(1).describe('The aggregate layer id to add (map_get_state lists taken ids).'),
  layer_name: z.string().optional().describe('Display name; defaults to the layer id.'),
  cell_size: z.number().positive().describe('Grid cell edge in degrees (positive, e.g. 0.5 or 0.05).'),
  measure: z.enum(['count', 'sum']).optional().describe('count (default) or sum — sum needs value_field.'),
  value_field: z.string().optional().describe('Numeric property summed per cell (required for measure=sum).'),
  unit: z.string().min(1).describe('Unit the legend labels for the cell measure.'),
  max_cells: z.number().int().min(1).max(20000).optional().describe('Cell cap; 20000 is the recorded limit. Coarser grid on refusal.'),
}).strict()

const vizClassifyInput = z.object({
  layer_id: z.string().min(1).describe('The layer id to restyle (map_get_state lists them).'),
  ...vizStyleHeadInput,
}).strict()

const operationId = z.string().regex(/^[A-Za-z0-9_.:-]+$/).max(64).describe('Client operation id for idempotency; repeating it replays the first outcome.')



const mapApplyPatchInput = z.object({
  patch: z.unknown().describe('Ordered conditional ops, 1..8: upsert-layer{layer:{id,name,data,sourceCrs,opacity,visible,digest?},expect?} | remove-layer{layerId,expect?:{digest}} | reorder-layers{layerIds,expect?:{order}} | set-view{view,expect?:{viewDigest}} | set-mode{mode,expect?:{mode}} | set-style{entries:[{layerId,style|null,expect?}]} | set-aoi{aoi|null,expect?:{aoiDigest}}. expect names what you read: {digest,absent,order,viewDigest,mode,aoiDigest}. One failing op refuses the whole patch with a per-op diff.'),
  expected_revision: z.number().int().nonnegative().describe('The map revision this patch was prepared against (map_get_state).'),
  operation_id: operationId.optional(),
  writer_id: z.string().max(64).optional().describe('Registered writer to commit as; defaults to this session\'s own writer.'),
}).strict()

const mapUndoInput = z.object({
  undo_of: z.number().int().positive().optional().describe('Operation index to undo (map_get_state history); default walks the newest still-live operation.'),
  expected_revision: z.number().int().nonnegative().optional().describe('Refuse unless the map is still at this revision.'),
  operation_id: operationId.optional(),
  writer_id: z.string().max(64).optional().describe('Registered writer to commit as; defaults to this session\'s own writer.'),
}).strict()

/** Shared terrain vertical metadata: required, never defaulted. */
const verticalInput = {
  vertical_datum: z.string().describe('Named vertical datum of the surface elevations, e.g. EGM96, NAVD88, ellipsoid-WGS84.'),
  vertical_units: z.string().describe('Vertical unit; "m" is the supported unit.'),
  vertical_epoch: z.string().describe('Datum epoch or realization, e.g. "2010.00"; the literal "none" for datum-less ellipsoidal heights.'),
  elevation_field: z.string().optional().describe('Numeric property holding each grid point\'s elevation; "elevation" is the recorded default.'),
}

const terrainAddLayerInput = z.object({
  ref: z.string().describe('Exact surface resource ref, `res-…@vN` (a registered point grid).'),
  ...verticalInput,
  name: z.string().optional().describe('Human-readable layer name; defaults to the surface ref.'),
  layer_id: z.string().optional().describe('Stable layer id; re-adding an id replaces the layer.'),
}).strict()

const viewshedInput = z.object({
  surface_ref: z.string().describe('Exact surface resource ref, `res-…@vN` (registered point grid).'),
  ...verticalInput,
  observer: z.tuple([z.number(), z.number()]).describe('WGS84 [lon, lat] of the observer.'),
  observer_height_m: z.number().optional().describe('Observer height above the terrain; 0 is the recorded default.'),
  observer_elevation_m: z.number().optional().describe('Absolute observer elevation override.'),
  radius_m: z.number().positive().describe('Area radius in meters, up to 20000 (the viewshed bound).'),
  max_targets: z.number().int().min(1).max(512).optional().describe('Lattice target bound; 512 is the recorded default. Nearest targets answer first.'),
  sampling_interval_m: z.number().positive().optional().describe('Per-sightline sample spacing in meters; 25 is the recorded default.'),
  surface_sigma_m: z.number().nonnegative().describe('Surface elevation one-sigma in meters; the per-target indeterminate band derives from it.'),
  curvature: z.enum(['corrected', 'none']).optional().describe('corrected (recorded default) or none.'),
  refraction_k: z.number().min(0).max(0.999).optional().describe('Refraction coefficient with curvature=corrected; 0.13 is the recorded default.'),
  buildings_ref: z.string().optional().describe('Optional building-footprint resource ref.'),
  height_field: z.string().optional().describe('Building height property with buildings_ref.'),
  layer_id: z.string().optional().describe('Terrain-preview layer id to check against; refuses when its revision differs from the computed one.'),
}).strict()

const lineOfSightInput = z.object({
  surface_ref: z.string().describe('Exact surface resource ref, `res-…@vN` (registered point grid).'),
  ...verticalInput,
  observer: z.tuple([z.number(), z.number()]).describe('WGS84 [lon, lat] of the observer.'),
  observer_height_m: z.number().optional().describe('Observer height above the terrain; 0 is the recorded default.'),
  observer_elevation_m: z.number().optional().describe('Absolute observer elevation override.'),
  target: z.tuple([z.number(), z.number()]).describe('WGS84 [lon, lat] of the target.'),
  target_height_m: z.number().optional().describe('Target height above the terrain; 0 is the recorded default.'),
  target_elevation_m: z.number().optional().describe('Absolute target elevation override.'),
  sampling_interval_m: z.number().positive().optional().describe('Sample spacing in meters; 25 is the recorded default.'),
  max_samples: z.number().int().min(2).max(65536).optional().describe('Sample-count bound; 4096 is the recorded default. Exceeding it refuses instead of coarsening.'),
  surface_sigma_m: z.number().nonnegative().describe('Surface elevation one-sigma in meters; the clearance uncertainty derives from it.'),
  endpoint_sigma_m: z.number().nonnegative().optional().describe('Endpoint elevation one-sigma for both endpoints; 0 is the recorded default.'),
  curvature: z.enum(['corrected', 'none']).optional().describe('corrected (recorded default; drop (1−k)·d²/2R) or none.'),
  refraction_k: z.number().min(0).max(0.999).optional().describe('Refraction coefficient with curvature=corrected; 0.13 is the recorded default.'),
  buildings_ref: z.string().optional().describe('Optional building-footprint resource ref (Polygons with a height property).'),
  height_field: z.string().optional().describe('Building height property; "height" is the recorded default.'),
  building_base: z.enum(['terrain', 'absolute']).optional().describe('terrain (recorded default) or absolute (needs base_field).'),
  base_field: z.string().optional().describe('Absolute base-elevation property with building_base=absolute.'),
  voxels_ref: z.string().optional().describe('Optional occupied-voxel resource ref (Points at cell centers with a z property).'),
  z_field: z.string().optional().describe('Voxel center-elevation property; "z" is the recorded default.'),
  voxel_cell_m: z.number().positive().optional().describe('Cubic cell edge in meters (required with voxels_ref).'),
  control_points: z.array(z.object({ id: z.string(), lon: z.number(), lat: z.number(), elevation_m: z.number() }).strict()).min(1).optional()
    .describe('Surveyed points the surface must match before computing.'),
  control_tolerance_m: z.number().positive().optional().describe('Control-point match tolerance in meters (required with control_points).'),
  layer_id: z.string().optional().describe('Terrain-preview layer id to check against; refuses when its revision differs from the computed one.'),
}).strict()

const streamOpenInput = z.object({
  scenario_ref: z.string().describe('Registered scenario resource ref, `res-…@vN`.'),
  stream_id: z.string().describe('Stable workbench id; becomes the layer id. Re-opening one id replaces the workbench.'),
  name: z.string().optional().describe('Human-readable layer name; defaults to the stream id.'),
  window_ms: z.number().positive().describe('Tumbling window size in milliseconds.'),
  lateness_ms: z.number().nonnegative().describe('Allowed lateness in milliseconds; the watermark trails max event time by this much.'),
  dedup_capacity: z.number().int().min(1).optional().describe('Distinct event ids the dedup window retains; 1024 is the recorded default.'),
  buffer_capacity: z.number().int().min(1).optional().describe('Intake buffer bound; 256 is the recorded default. A full buffer holds the source back.'),
  max_events_per_advance: z.number().int().min(1).optional().describe('Processing quota per advance; 512 is the recorded default.'),
  max_open_windows: z.number().int().min(1).optional().describe('Open-window state bound; 64 is the recorded default.'),
  max_revisions_per_window: z.number().int().min(1).optional().describe('Late-revision ledger bound per window; 8 is the recorded default.'),
}).strict()

const streamAdvanceInput = z.object({
  stream_id: z.string().describe('The workbench to advance.'),
  steps: z.number().int().min(1).max(256).optional().describe('Batches to advance; 1 is the recorded default, 256 the cap.'),
}).strict()

const streamIdInput = z.object({
  stream_id: z.string().describe('The workbench to operate on.'),
}).strict()

const scaleIngestInput = z.object({
  source_ref: z.string().describe('Registered resource ref to copy, `res-…@vN`.'),
  resource_id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'resource_id must match [a-z0-9][a-z0-9-]{0,63}').describe('Stable scale resource id.'),
  chunk_rows: z.number().int().min(1).max(65536).optional().describe('Rows per chunk; 2048 is the recorded budget.'),
  time_field: z.string().optional().describe('Property holding each feature\'s ISO event time; its observed range is recorded.'),
}).strict()

const scaleReadInput = z.object({
  resource_ref: z.string().describe('Scale version ref, `scl-…@<digest12>`.'),
  kind: z.enum(['range', 'tile', 'query']).describe('Read kind.'),
  from_chunk: z.number().int().nonnegative().optional().describe('range: first chunk index (0-based).'),
  chunks: z.number().int().min(1).optional().describe('range: chunk count to read.'),
  z: z.number().int().min(0).max(22).optional().describe('tile: grid zoom (2^z cells over the version extent).'),
  x: z.number().int().nonnegative().optional().describe('tile: grid column.'),
  y: z.number().int().nonnegative().optional().describe('tile: grid row from south.'),
  field: z.string().optional().describe('query: numeric property to compare.'),
  op: z.enum(['>', '>=', '<', '<=', '==', '!=']).optional().describe('query: comparison operator.'),
  value: z.number().optional().describe('query: comparison value.'),
}).strict()

const scaleScanInput = z.object({
  resource_ref: z.string().describe('Scale version ref, `scl-…@<digest12>`.'),
  field: z.string().describe('Numeric property to compare.'),
  op: z.enum(['>', '>=', '<', '<=', '==', '!=']).describe('Comparison operator.'),
  value: z.number().describe('Comparison value.'),
  retry_of: z.number().int().nonnegative().optional().describe('Seq of this session\'s original scale_scan `tool/call`: returns the already-published artifact and never recomputes.'),
}).strict()

const vizCompareInput = z.object({
  layer_a: z.string().min(1).describe('First layer id.'),
  layer_b: z.string().min(1).describe('Second layer id; must differ from layer_a.'),
  field: z.string().min(1).describe('Numeric property to classify on both layers.'),
  unit: z.string().min(1).describe('Shared unit the legends label.'),
  measure: z.enum(['total', 'rate', 'density']).optional().describe('total is the recorded default; rate/density classify the ratio over denominator_field.'),
  series_identity: z.enum(['observed', 'forecast', 'scenario']).optional().describe('observed is the recorded default; the legend declares the identity.'),
  denominator_field: z.string().optional().describe('Shared positive denominator property; required for rate/density.'),
  classification: z.enum(['quantile', 'equal-interval']).optional().describe('quantile is the recorded default; manual breaks have no unified-domain semantics.'),
  class_count: z.number().int().min(2).max(12).optional().describe('Classes in [2, 12]; 5 is the recorded default.'),
  encoding: z.enum(['fill', 'size']).optional().describe('fill is the recorded default; size point encoding needs measure=total.'),
  time_field: z.string().optional().describe('With timezone/time_from/time_to: shared timeline binding for both layers.'),
  timezone: z.string().optional().describe('IANA zone the timeline renders in.'),
  granularity: z.enum(['hour', 'day', 'week', 'month']).optional().describe('day is the recorded default.'),
  time_from: z.string().optional().describe('Half-open timeline window start, ISO.'),
  time_to: z.string().optional().describe('Half-open timeline window end, exclusive.'),
}).strict()

const decisionModelHeadInput = {
  goal_revision: z.number().int().nonnegative().describe('Goal revision this analysis belongs to.'),
}

const factorFieldsInput = z.array(z.string().min(1)).min(1).max(8)
  .describe('1–8 candidate factor/control property names.')

const treatedValueInput = z.union([z.boolean(), z.number(), z.string()])
  .describe('Row value marking the treated group (or the pre/post period).')

const forecastFeatureInput = z.object({
  field: z.string().min(1),
  availability: z.enum(['known-at-origin', 'concurrent']),
}).strict()

const scenarioWeightsInput = z.object({
  coverage: z.number().nonnegative(),
  equity: z.number().nonnegative(),
  cost: z.number().nonnegative(),
}).strict()

const attributionAssociationInput = z.object({
  ...decisionModelHeadInput,
  resource_ref: z.string().describe('Exact resource ref, `res-…@vN`.'),
  outcome_field: z.string().describe('Numeric outcome property.'),
  factor_fields: factorFieldsInput,
}).strict()

const attributionEffectInput = z.object({
  ...decisionModelHeadInput,
  resource_ref: z.string().describe('Exact resource ref, `res-…@vN`.'),
  outcome_field: z.string().describe('Numeric outcome property.'),
  factor_fields: factorFieldsInput,
  treatment_field: z.string().describe('Binary treatment property.'),
  treated_value: treatedValueInput,
  design: z.enum(['covariate-adjustment', 'difference-in-differences']).optional()
    .describe('Absent: the estimate reports at the association level with a named downgrade reason.'),
  period_field: z.string().optional().describe('Pre/post property (difference-in-differences).'),
  pre_value: treatedValueInput.optional(),
  post_value: treatedValueInput.optional(),
  unit_field: z.string().optional().describe('Panel unit property (difference-in-differences).'),
  interference_band_meters: z.number().positive().optional()
    .describe('Controls with treated neighbors inside the band trigger the spillover downgrade.'),
  interval_level: z.union([z.literal(0.8), z.literal(0.9), z.literal(0.95)]).optional(),
}).strict()

const forecastValidateInput = z.object({
  ...decisionModelHeadInput,
  resource_ref: z.string().describe('Exact resource ref, `res-…@vN`.'),
  outcome_field: z.string().describe('Numeric outcome property.'),
  time_field: z.string().describe("Property holding each row's ISO event time."),
  features: z.array(forecastFeatureInput).max(8).optional(),
  training_from: z.string().describe('Training window start (ISO).'),
  training_to: z.string().describe('Training cutoff (ISO, exclusive).'),
  block_meters: z.number().positive().describe('Spatial block size in meters for the per-block validation rows.'),
  granularity: z.enum(['day', 'week', 'month']).optional().describe('day is the recorded default.'),
  baseline: z.enum(['naive', 'mean']).optional().describe('naive is the recorded default.'),
  model_family: z.enum(['linear', 'threshold', 'quadratic-ridge']).optional()
    .describe('linear is the recorded default; threshold and quadratic-ridge are the bounded nonlinear families.'),
  holdout_steps: z.number().int().min(1).max(64).optional().describe('Last k bins held out; 4 is the recorded default.'),
  interval_level: z.union([z.literal(0.8), z.literal(0.9), z.literal(0.95)]).optional(),
}).strict()

const forecastFitInput = forecastValidateInput.omit({ holdout_steps: true })

const forecastPredictInput = z.object({
  ...decisionModelHeadInput,
  model_ref: z.string().describe('Exact artifact ref, `art-…@vN`, from forecast_fit.'),
  resource_ref: z.string().describe('Exact resource ref of the prediction-origin rows, `res-…@vN`.'),
  horizon_steps: z.number().int().min(1).max(64).optional().describe('Forward steps in bins; 1 is the recorded default.'),
  interval_level: z.union([z.literal(0.8), z.literal(0.9), z.literal(0.95)]).optional(),
}).strict()

const scenarioCompareInput = z.object({
  ...decisionModelHeadInput,
  groups: z.array(z.object({ id: z.string(), demand: z.number() }).strict()).min(1).max(16)
    .describe('Demand groups; demand is the coverage weight.'),
  candidates: z.array(z.object({
    id: z.string(),
    cost: z.number().nonnegative(),
    capacity: z.number().nonnegative().optional(),
    served: z.array(z.object({ group: z.string(), amount: z.number() }).strict()).min(0)
      .describe('Served amounts as { group, amount } pairs.'),
  }).strict()).min(1).max(16).describe('The given candidate schemes (no global optimum).'),
  budget: z.number().nonnegative().optional().describe('Total-cost budget; candidates above it stay listed as infeasible.'),
  weights: scenarioWeightsInput.optional().describe('Absence selects the flagged default scenario.'),
}).strict()

const locationAllocateInput = z.object({
  ...decisionModelHeadInput,
  resource_ref: z.string().describe('Exact demand-point resource ref, `res-…@vN`.'),
  demand_field: z.string().describe('Numeric demand property.'),
  group_field: z.string().optional().describe('Equity-group property; rows without it form the group "all".'),
  sites: z.array(z.object({
    id: z.string(),
    lon: z.number(),
    lat: z.number(),
    capacity: z.number().nonnegative(),
    cost: z.number().nonnegative(),
  }).strict()).min(1).max(64).describe('Candidate sites; greedy is the default and global mode searches a bounded affordable-site domain.'),
  coverage_radius_meters: z.number().positive().describe('Cover radius in meters (great-circle).'),
  budget: z.number().nonnegative().optional().describe('Opening budget; sites above it stay closed and named.'),
  mode: z.enum(['greedy', 'global']).optional().describe('greedy is the recorded default; global exhaustively searches the bounded affordable-site domain.'),
  weights: scenarioWeightsInput.optional().describe('Absence selects the flagged default scenario.'),
}).strict()

/** Resolve the trusted ToolRuntime execution bound to one MCP request. */
export type ExecutionResolver = (context: ServerContext) => ToolExecution

/** The versioned single-feature selector shared by the geo tools' ref inputs. */
const featureRefInput = z.object({
  resource: z.string().describe('Exact resource ref, `res-…@vN`.'),
  feature: z.string().describe('Stable feature ref, `f-…`, from catalog_resolve; never defaults to the first feature.'),
}).strict().describe('Versioned single-feature input (mutually exclusive with path on the same end).')

const addLayerInput = z.object({
  path: z.string().optional().describe('GeoJSON file path (legacy branch). Mutually exclusive with `ref`: give exactly one.'),
  ref: z.string().optional().describe('Exact catalog ref `res-…@vN` or published artifact ref `art-…@vN`. Mutually exclusive with `path`.'),
  name: z.string().optional().describe('Human-readable layer name; defaults to the file base name or ref.'),
  crs: z.string().optional().describe('Source CRS for `path` inputs; ignored with `ref` (the version records its CRS).'),
  layer_id: z.string().optional().describe('Stable layer id; re-adding the same id replaces the layer.'),
}).strict()

const removeLayerInput = z.object({
  layer_id: z.string().describe('Layer id previously returned by map_add_layer.'),
}).strict()

const setViewInput = z.object({
  center: z.tuple([z.number(), z.number()]).describe('WGS84 [longitude, latitude].'),
  zoom: z.number().optional().describe('Web-Mercator-style zoom in [0, 24].'),
  wkid: z.number().optional().describe('Display projection WKID; omission keeps the current projection.'),
}).strict()

const setModeInput = z.object({
  mode: z.enum(['map', 'scene']).describe('map selects 2D MapView; scene selects a 3D local SceneView.'),
}).strict()

const getStateInput = z.object({}).strict()

const geoBufferInput = z.object({
  path: z.string().optional().describe('GeoJSON file path (legacy branch; mutually exclusive with `ref`).'),
  crs: z.string().optional().describe('Source CRS for `path` inputs; defaults to WGS84.'),
  ref: featureRefInput.optional(),
  distance_m: z.number().optional().describe('Buffer distance in meters (positive grows, negative shrinks). Required unless `retry_of` is given.'),
  steps: z.number().optional().describe('Number of circle approximation steps per quarter (higher is smoother; 1–32).'),
  retry_of: z.number().optional().describe('Seq of this session\'s original geo_buffer `tool/call` to retry: returns the already-published artifact and never recomputes.'),
}).strict()

const geoAreaInput = z.object({
  path: z.string().optional().describe('GeoJSON file path (legacy branch; mutually exclusive with `ref`).'),
  feature_index: z.number().optional().describe('Zero-based feature index for `path` inputs; defaults to 0. Ignored with `ref`.'),
  crs: z.string().optional().describe('Source CRS for `path` inputs; defaults to WGS84.'),
  ref: featureRefInput.optional(),
}).strict()

const geoIntersectInput = z.object({
  path_a: z.string().optional().describe('First GeoJSON file path (mutually exclusive with `ref_a` on that end).'),
  path_b: z.string().optional().describe('Second GeoJSON file path (mutually exclusive with `ref_b` on that end).'),
  ref_a: featureRefInput.optional(),
  ref_b: featureRefInput.optional(),
  crs_a: z.string().optional().describe('Source CRS of file A; defaults to WGS84.'),
  crs_b: z.string().optional().describe('Source CRS of file B; defaults to WGS84.'),
}).strict()

const geoDistanceInput = z.object({
  path_a: z.string().optional().describe('First GeoJSON file path holding a Point feature (mutually exclusive with `ref_a`).'),
  path_b: z.string().optional().describe('Second GeoJSON file path holding a Point feature (mutually exclusive with `ref_b`).'),
  ref_a: featureRefInput.optional(),
  ref_b: featureRefInput.optional(),
  crs_a: z.string().optional().describe('Source CRS of file A; defaults to WGS84.'),
  crs_b: z.string().optional().describe('Source CRS of file B; defaults to WGS84.'),
}).strict()

const catalogRegisterInput = z.object({
  path: z.string().describe('GeoJSON file path relative to the current session workspace.'),
  crs: z.string().optional().describe('Source CRS such as EPSG:4547 or a +proj= string; defaults to WGS84.'),
  name: z.string().optional().describe('Stable resource name; re-registering one name publishes the next version.'),
  authorization: z.string().optional().describe('Authorization domain to publish under; defaults to the local domain.'),
  retry_of: z.number().optional().describe('Seq of this session\'s original catalog_register `tool/call` to retry: returns the already-published version and never re-reads the path.'),
}).strict()

const catalogResolveInput = z.object({
  resource: z.string().optional().describe('Exact resource ref, `res-…@vN`; mutually exclusive with `query`.'),
  query: z.string().optional().describe('Business-language query for semantic canonical names and aliases; mutually exclusive with `resource`.'),
  applicability: z.string().optional().describe('Optional applicability filter for semantic search.'),
  limit: z.number().int().min(1).max(32).optional().describe('Semantic candidate limit, from 1 to 32.'),
}).strict()

const mapSaveInput = z.object({
  map_revision: z.number().optional().describe('Expected current map revision; a mismatch refuses the save before any I/O.'),
}).strict()

const decisionUpdateInput = z.object({
  goal_revision: z.number().describe('Current goal revision the plan is written against (from the injected spatial snapshot).'),
  expected_plan_revision: z.number().describe('Plan revision you are editing against (0 when no plan exists yet).'),
  interpretation: z.string().optional().describe('Tentative interpretation of the goal; never promoted to user authority.'),
  methods: z.array(z.object({
    name: z.string(),
    rationale: z.string().optional(),
  }).strict()).optional().describe('Candidate methods for the plan.'),
  steps: z.array(z.string()).optional().describe('Planned steps.'),
  gaps: z.array(z.object({
    id: z.string(),
    description: z.string(),
    status: z.enum(['open', 'blocked', 'resolved']),
  }).strict()).optional().describe('Data/authorization gaps; repeated re-open of one id beyond the remediation limit is refused.'),
  evidence_refs: z.array(z.number()).optional().describe('Settled evidence seqs this plan cites.'),
}).strict()

/** Narrow one handler value to MCP structuredContent. */
function structuredResult(toolName: string, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${toolName} returned a non-object structured result`)
  }
  return value as Record<string, unknown>
}

/** Convert the MCP-bound execution to the current map handlers' run context. */
function toolRunContext(execution: ToolExecution): ToolRunContext {
  const unsupported = (operation: string): never => {
    throw new Error(`ArcGIS MCP map handlers do not support ${operation}`)
  }
  return {
    ...execution,
    deferContext: () => unsupported('deferred context'),
    concludeTurn: () => unsupported('turn conclusion'),
  }
}

/** Convert one direct map tool result into the MCP content vocabulary. */
async function executeMapTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  context: ServerContext,
  resolveExecution: ExecutionResolver,
): Promise<CallToolResult> {
  try {
    context.mcpReq.signal.throwIfAborted()
    const value = await tool.execute(args, toolRunContext(resolveExecution(context)))
    const structuredContent = structuredResult(tool.name, value)
    const rendered = tool.output.render(args, structuredContent as JsonValue)
    const content = rendered.map((block) => {
      if (block.type !== 'text') {
        throw new Error(`${tool.name} produced unsupported non-text model content`)
      }
      return { type: 'text' as const, text: block.text }
    })
    return { content, structuredContent }
  } catch (error: unknown) {
    if (context.mcpReq.signal.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    return { isError: true, content: [{ type: 'text', text: message }] }
  }
}

/**
 * Register the fixed forty-five-tool spatial catalog on one MCP server:
 * the five ArcGIS-backed `map_*` container tools, the four Turf-backed
 * `geo_*` analysis tools, the data-chain `catalog_register`/
 * `catalog_resolve`/`map_save`, the P0c `decision_update`, the P1
 * `run_submit`/`run_get`/`run_cancel`, the six P2 `stats_*`/`pattern_*`
 * tools, the eight P3 `attribution_*`/`forecast_*`/`scenario_*`/
 * `location_*` tools, the three visualization workbench tools, the two
 * collaboration tools (`map_apply_patch`/`map_undo`), the two terrain
 * tools (`terrain_add_layer`/`geo_line_of_sight`), the five stream
 * workbench tools (`stream_open`/`stream_advance`/`stream_pause`/
 * `stream_resume`/`stream_materialize`), and the three distributed-scale
 * tools (`scale_ingest`/`scale_read`/`scale_scan`), all dispatching to the
 * same exported handlers the direct compatibility path uses.
 * @param server - in-process MCP server receiving the registrations.
 * @param resolveExecution - trusted request metadata resolver.
 */
export function registerArcgisMapTools(server: McpServer, resolveExecution: ExecutionResolver): void {
  server.registerTool('map_add_layer', {
    description: mapAddLayer.description,
    inputSchema: addLayerInput,
  }, (args, context) => executeMapTool(mapAddLayer, args, context, resolveExecution))

  server.registerTool('map_remove_layer', {
    description: mapRemoveLayer.description,
    inputSchema: removeLayerInput,
  }, (args, context) => executeMapTool(mapRemoveLayer, args, context, resolveExecution))

  server.registerTool('map_set_view', {
    description: mapSetView.description,
    inputSchema: setViewInput,
  }, (args, context) => executeMapTool(mapSetView, args, context, resolveExecution))

  server.registerTool('map_set_mode', {
    description: mapSetMode.description,
    inputSchema: setModeInput,
  }, (args, context) => executeMapTool(mapSetMode, args, context, resolveExecution))

  server.registerTool('map_get_state', {
    description: mapGetState.description,
    inputSchema: getStateInput,
  }, (_args, context) => executeMapTool(mapGetState, {}, context, resolveExecution))

  server.registerTool('geo_buffer', {
    description: geoBuffer.description,
    inputSchema: geoBufferInput,
  }, (args, context) => executeMapTool(geoBuffer, args, context, resolveExecution))

  server.registerTool('geo_area', {
    description: geoArea.description,
    inputSchema: geoAreaInput,
  }, (args, context) => executeMapTool(geoArea, args, context, resolveExecution))

  server.registerTool('geo_intersect', {
    description: geoIntersect.description,
    inputSchema: geoIntersectInput,
  }, (args, context) => executeMapTool(geoIntersect, args, context, resolveExecution))

  server.registerTool('geo_distance', {
    description: geoDistance.description,
    inputSchema: geoDistanceInput,
  }, (args, context) => executeMapTool(geoDistance, args, context, resolveExecution))

  server.registerTool('catalog_register', {
    description: catalogRegister.description,
    inputSchema: catalogRegisterInput,
  }, (args, context) => executeMapTool(catalogRegister, args, context, resolveExecution))

  server.registerTool('catalog_resolve', {
    description: catalogResolve.description,
    inputSchema: catalogResolveInput,
  }, (args, context) => executeMapTool(catalogResolve, args, context, resolveExecution))

  server.registerTool('map_save', {
    description: mapSave.description,
    inputSchema: mapSaveInput,
  }, (args, context) => executeMapTool(mapSave, args, context, resolveExecution))

  server.registerTool('decision_update', {
    description: decisionUpdate.description,
    inputSchema: decisionUpdateInput,
  }, (args, context) => executeMapTool(decisionUpdate, args, context, resolveExecution))

  server.registerTool('run_submit', {
    description: runSubmit.description,
    inputSchema: runSubmitInput,
  }, (args, context) => executeMapTool(runSubmit, args, context, resolveExecution))

  server.registerTool('run_get', {
    description: runGet.description,
    inputSchema: runIdInput,
  }, (args, context) => executeMapTool(runGet, args, context, resolveExecution))

  server.registerTool('run_cancel', {
    description: runCancel.description,
    inputSchema: runIdInput,
  }, (args, context) => executeMapTool(runCancel, args, context, resolveExecution))

  server.registerTool('stats_zonal', {
    description: statsZonal.description,
    inputSchema: statsZonalInput,
  }, (args, context) => executeMapTool(statsZonal, args, context, resolveExecution))

  server.registerTool('stats_autocorrelation', {
    description: statsAutocorrelation.description,
    inputSchema: statsAutocorrelationInput,
  }, (args, context) => executeMapTool(statsAutocorrelation, args, context, resolveExecution))

  server.registerTool('stats_hotspot', {
    description: statsHotspot.description,
    inputSchema: statsHotspotInput,
  }, (args, context) => executeMapTool(statsHotspot, args, context, resolveExecution))

  server.registerTool('pattern_change', {
    description: patternChange.description,
    inputSchema: patternChangeInput,
  }, (args, context) => executeMapTool(patternChange, args, context, resolveExecution))

  server.registerTool('pattern_cluster', {
    description: patternCluster.description,
    inputSchema: patternClusterInput,
  }, (args, context) => executeMapTool(patternCluster, args, context, resolveExecution))

  server.registerTool('pattern_flow', {
    description: patternFlow.description,
    inputSchema: patternFlowInput,
  }, (args, context) => executeMapTool(patternFlow, args, context, resolveExecution))

  server.registerTool('attribution_association', {
    description: attributionAssociation.description,
    inputSchema: attributionAssociationInput,
  }, (args, context) => executeMapTool(attributionAssociation, args, context, resolveExecution))

  server.registerTool('attribution_explain', {
    description: attributionExplain.description,
    inputSchema: attributionAssociationInput,
  }, (args, context) => executeMapTool(attributionExplain, args, context, resolveExecution))

  server.registerTool('attribution_effect', {
    description: attributionEffect.description,
    inputSchema: attributionEffectInput,
  }, (args, context) => executeMapTool(attributionEffect, args, context, resolveExecution))

  server.registerTool('forecast_validate', {
    description: forecastValidate.description,
    inputSchema: forecastValidateInput,
  }, (args, context) => executeMapTool(forecastValidate, args, context, resolveExecution))

  server.registerTool('forecast_fit', {
    description: forecastFit.description,
    inputSchema: forecastFitInput,
  }, (args, context) => executeMapTool(forecastFit, args, context, resolveExecution))

  server.registerTool('forecast_predict', {
    description: forecastPredict.description,
    inputSchema: forecastPredictInput,
  }, (args, context) => executeMapTool(forecastPredict, args, context, resolveExecution))

  server.registerTool('scenario_compare', {
    description: scenarioCompare.description,
    inputSchema: scenarioCompareInput,
  }, (args, context) => executeMapTool(scenarioCompare, args, context, resolveExecution))

  server.registerTool('location_allocate', {
    description: locationAllocate.description,
    inputSchema: locationAllocateInput,
  }, (args, context) => executeMapTool(locationAllocate, args, context, resolveExecution))

  server.registerTool('viz_create_style', {
    description: vizCreateStyle.description,
    inputSchema: vizCreateStyleInput,
  }, (args, context) => executeMapTool(vizCreateStyle, args, context, resolveExecution))

  server.registerTool('viz_classify', {
    description: vizClassify.description,
    inputSchema: vizClassifyInput,
  }, (args, context) => executeMapTool(vizClassify, args, context, resolveExecution))

  server.registerTool('viz_compare', {
    description: vizCompare.description,
    inputSchema: vizCompareInput,
  }, (args, context) => executeMapTool(vizCompare, args, context, resolveExecution))

  server.registerTool('viz_aggregate', {
    description: vizAggregate.description,
    inputSchema: vizAggregateInput,
  }, (args, context) => executeMapTool(vizAggregate, args, context, resolveExecution))

  server.registerTool('map_apply_patch', {
    description: mapApplyPatch.description,
    inputSchema: mapApplyPatchInput,
  }, (args, context) => executeMapTool(mapApplyPatch, args, context, resolveExecution))

  server.registerTool('map_undo', {
    description: mapUndo.description,
    inputSchema: mapUndoInput,
  }, (args, context) => executeMapTool(mapUndo, args, context, resolveExecution))

  server.registerTool('terrain_add_layer', {
    description: terrainAddLayer.description,
    inputSchema: terrainAddLayerInput,
  }, (args, context) => executeMapTool(terrainAddLayer, args, context, resolveExecution))

  server.registerTool('geo_line_of_sight', {
    description: geoLineOfSight.description,
    inputSchema: lineOfSightInput,
  }, (args, context) => executeMapTool(geoLineOfSight, args, context, resolveExecution))

  server.registerTool('terrain_viewshed', {
    description: terrainViewshed.description,
    inputSchema: viewshedInput,
  }, (args, context) => executeMapTool(terrainViewshed, args, context, resolveExecution))

  server.registerTool('stream_open', {
    description: streamOpen.description,
    inputSchema: streamOpenInput,
  }, (args, context) => executeMapTool(streamOpen, args, context, resolveExecution))

  server.registerTool('stream_advance', {
    description: streamAdvance.description,
    inputSchema: streamAdvanceInput,
  }, (args, context) => executeMapTool(streamAdvance, args, context, resolveExecution))

  server.registerTool('stream_pause', {
    description: streamPause.description,
    inputSchema: streamIdInput,
  }, (args, context) => executeMapTool(streamPause, args, context, resolveExecution))

  server.registerTool('stream_resume', {
    description: streamResume.description,
    inputSchema: streamIdInput,
  }, (args, context) => executeMapTool(streamResume, args, context, resolveExecution))

  server.registerTool('stream_materialize', {
    description: streamMaterialize.description,
    inputSchema: streamIdInput,
  }, (args, context) => executeMapTool(streamMaterialize, args, context, resolveExecution))

  server.registerTool('scale_ingest', {
    description: scaleIngest.description,
    inputSchema: scaleIngestInput,
  }, (args, context) => executeMapTool(scaleIngest, args, context, resolveExecution))

  server.registerTool('scale_read', {
    description: scaleRead.description,
    inputSchema: scaleReadInput,
  }, (args, context) => executeMapTool(scaleRead, args, context, resolveExecution))

  server.registerTool('scale_scan', {
    description: scaleScan.description,
    inputSchema: scaleScanInput,
  }, (args, context) => executeMapTool(scaleScan, args, context, resolveExecution))
}
