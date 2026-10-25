/**
 * `@map-harness/spatial-statistics` — the P2 spatial statistics and
 * spatiotemporal patterns layer: the versioned StatisticSpec/PatternSpec
 * method contracts, zonal summaries, global/local Moran's I and Getis-Ord
 * Gi* under seeded permutation tests with multiple-testing corrections,
 * change/cluster/flow patterns with missing-data and time-forward-holdout
 * conventions, and the evidence-lineage/multi-scale/legend projections. The
 * model surface is the six ordinary MCP stat/pattern tools map-tools
 * registers; the computations stay a pure library over exact catalog
 * versions.
 *
 * @module @map-harness/spatial-statistics
 */
export {
  DEFAULT_HOLDOUT_BLOCKS,
  DEFAULT_MAX_GAP_BINS,
  DEFAULT_MIN_COVERAGE,
  DEFAULT_MULTIPLE_TESTING,
  DEFAULT_PERMUTATION_SEED,
  DEFAULT_PERMUTATIONS,
  GRANULARITIES,
  ISLAND_RULE,
  LATE_DATA_RULE,
  MAX_BAND_METERS,
  MAX_PERMUTATIONS,
  MAX_UNITS,
  MIN_PERMUTATIONS,
  MIN_WEIGHTED_UNITS,
  MISSING_DATA_RULE,
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
  type Granularity,
  type HotspotSpec,
  type MultipleTesting,
  type NotApplicableReason,
  type PatternSpec,
  type StatIssue,
  type StatIssueCode,
  type StatSpec,
  type StatStatus,
  type Standardization,
  type TimeWindow,
  type WeightSpec,
  type ZonalSpec,
} from './contract.ts'
export {
  StatisticsError,
  type StatisticsErrorCode,
} from './errors.ts'
export {
  mulberry32,
  shuffled,
  type RandomStream,
} from './rand.ts'
export {
  EARTH_RADIUS_METERS,
  buildWeightMatrix,
  haversineMeters,
  lagOf,
  type LonLat,
  type WeightEdge,
  type WeightMatrix,
} from './weights.ts'
export {
  MAX_EVIDENCE_ROWS,
  SIGNIFICANCE_ALPHA,
  computeAutocorrelation,
  computeHotspot,
  computeZonal,
  correctPValues,
  randomizationSdOf,
  type AutocorrelationEvidence,
  type HotspotEvidence,
  type HotspotRow,
  type LisaRow,
  type StatDiagnostic,
  type StatEvidenceHead,
  type StatPublish,
  type StatUnit,
  type ZonalEvidence,
  type ZonalRow,
} from './stats.ts'
export {
  computeChange,
  computeCluster,
  computeFlow,
  dbscan,
  expectedBinsOf,
  type ChangeBlockRow,
  type ChangeEvidence,
  type ClusterBlockRow,
  type ClusterEvidence,
  type ClusterRow,
  type FlowEvidence,
  type FlowRow,
  type Observation,
  type PatternDiagnostic,
  type PatternEvidenceHead,
  type PatternPublish,
} from './patterns.ts'
export {
  compareScales,
  groupEvidenceByLineage,
  legendDomainOf,
  type EvidenceLineageGroup,
  type EvidenceLineageRow,
  type LegendClassification,
  type LegendDomain,
  type LegendSource,
  type ScaleLadder,
  type ScaleLadderRow,
} from './evidence.ts'
