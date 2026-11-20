/**
 * `@map-harness/spatial-context` — the P0c spatial context loop: the
 * DecisionFrame domain (GoalContract / PlanState / EvidenceLedger with
 * source-authority separation), the authoritative `decisionFrame` session
 * projection, the bounded pre-step snapshot injection, the three method
 * cards, and the task budget ledger. The host face mounts through the
 * map-web profile patch; the agent face (`./agent`) mounts through the
 * map-analyst preset.
 *
 * @module @map-harness/spatial-context
 */
export {
  bounded,
  checkPlanUpdate,
  evidenceIdOf,
  isUserAuthoritySource,
  MAX_EVIDENCE_ENTRIES,
  MAX_FRAME_DIAGNOSTICS,
  MAX_GOAL_QUESTION_CHARS,
  MAX_INJECTION_RECORDS,
  MAX_PENDING_FRAME_CALLS,
  MAX_PLAN_HISTORY,
  MAX_PLAN_LIST_ENTRIES,
  MAX_RESOURCE_CANDIDATES,
  MAX_SEEN_TOOLS,
  questionIdOf,
  DECISION_FRAME_STATE_VERSION,
  type DecisionFrame,
  type EvidenceEntry,
  type EvidenceKind,
  type EvidenceStatus,
  type FrameDiagnostic,
  type FrameDiagnosticCode,
  type GoalContract,
  type GoalSourceKind,
  type InjectionRecord,
  type PlanGap,
  type PlanMethod,
  type PlanState,
  type PlanUpdateRefusal,
  type ResourceCandidate,
} from './frame.ts'
export {
  DECISION_META_KIND,
  DECISION_META_SCHEMA_VERSION,
  MAX_DECISION_META_BYTES,
  buildDecisionChangeMeta,
  decodeDecisionChangeMeta,
  decisionChangeMetaSchema,
  readAnalysisResult,
  readCatalogResult,
  readSaveReceipt,
  type AnalysisInputRead,
  type AnalysisMetricRead,
  type AnalysisResultRead,
  type CatalogResultRead,
  type CatalogResultResourceRead,
  type DecisionChangeMeta,
  type DecisionGapUpdate,
  type DecisionMethodUpdate,
  type DecisionPlanUpdate,
  type DecisionUpdateRefusalCode,
  type DecodedDecisionChangeMeta,
  type SaveReceiptRead,
} from './records.ts'
export {
  checkBudget,
  checkGapRetry,
  foldConsumption,
  foldContextBytes,
  foldGapRetry,
  foldStep,
  initialBudgetLedger,
  resolveBudgetConfig,
  BUDGET_CONFIG_BOUND,
  DEFAULT_BUDGET_CONFIG,
  type BudgetCharge,
  type BudgetConfig,
  type BudgetLedger,
  type BudgetRefusal,
  type BudgetRefusalCode,
} from './budget.ts'
export {
  METHOD_CARD_SET_VERSION,
  METHOD_CARDS,
  evaluateStops,
  selectCards,
  type MethodCard,
  type StopAdvisory,
} from './cards.ts'
export {
  SPATIAL_CONTEXT_PLUGIN_NAME,
  DECISION_FRAME_STATE_VERSION as SPATIAL_CONTEXT_STATE_VERSION,
  FRAME_SPATIAL_TOOL_NAMES,
  foldSpatialContextEvent,
  initialSpatialContextState,
  parseSnapshotHeader,
  settleFrameResult,
  spatialContextStateSchema,
  type FrameSpatialToolName,
  type PendingFrameCall,
  type SettleFrameResultInput,
  type SnapshotHeader,
  type SpatialContextState,
} from './protocol.ts'
export { spatialContextProjectionDefinition } from './projection.ts'
export {
  composeSnapshot,
  digestOf,
  isDuplicate,
  visibleInjectionsOf,
  MAX_SNAPSHOT_EVIDENCE,
  MAX_SNAPSHOT_RESOURCES,
  type ComposedSnapshot,
  type SnapshotInputs,
  type VisibleInjection,
} from './snapshot.ts'
export { name, apply, inject, Config, SPATIAL_CONTEXT_SERVICE, type SpatialContextPluginConfig, type SpatialContextService } from './plugin.ts'
