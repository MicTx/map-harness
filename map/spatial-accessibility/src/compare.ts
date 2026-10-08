/**
 * Fixed-candidate comparison: the status-quo baseline and the user-given
 * candidate options re-evaluated on identical input versions (same population
 * ref, network version, and method version), with cost/feasibility screening,
 * explicit weights, a weight-perturbation sensitivity pass, and a
 * deterministic fixed-revision map/report export. The comparison never
 * claims a global optimum — it answers "which of these given options scores
 * better under the submitted weights". A comparison computed against an older
 * goal revision cannot override the current projection.
 *
 * @module @map-harness/spatial-accessibility/compare
 */
import {
  type AccessibilitySpec,
  type CandidateOption,
  type ComparisonWeights,
} from './contract.ts'
import { sha256Hex } from './contract.ts'
import { AccessibilityError } from './errors.ts'
import {
  computeCoverage,
  type CoverageComputeInput,
  type FacilityPoint,
  type PopulationUnit,
} from './metrics.ts'
import type { RunCheckpoints } from './runs.ts'

/**
 * The equity metric: the mean coverage share across communities with
 * population — an option can win coverage while losing communities that
 * another option serves.
 */
function meanCommunityShare(communities: readonly { readonly community: string; readonly covered: number; readonly population: number }[]): number {
  if (communities.length === 0) return 1
  const total = communities.reduce((sum, row) => sum + (row.population === 0 ? 1 : row.covered / row.population), 0)
  return total / communities.length
}

/** One evaluated option (the baseline or one candidate). */
export interface OptionEvaluation {
  readonly optionId: string
  readonly label: string
  readonly feasible: boolean
  /** Named infeasibility reason (`cost-over-budget`); absent when feasible. */
  readonly infeasibleReason?: string
  readonly coveredPopulation: number
  readonly uncoveredPopulation: number
  readonly coverageRatio: number
  /** Mean community coverage share (the equity metric the score consumes). */
  readonly communityEquityShare: number
  readonly cost: number
  /** The weight-composed score; present only for feasible options. */
  readonly score?: number
  /** The option's own coverage evidence (input versions are shared across options). */
  readonly evidence: unknown
}

/** The full comparison outcome of one run. */
export interface ComparisonOutcome {
  readonly kind: 'candidate-comparison'
  readonly baseline: OptionEvaluation
  readonly candidates: readonly OptionEvaluation[]
  /** Feasible options by descending score; the baseline competes equally. */
  readonly ranking: readonly string[]
  /** Every option was computed against exactly these input versions. */
  readonly inputVersions: { readonly populationRef: string; readonly networkRef: string; readonly methodVersion: string }
  readonly weights: ComparisonWeights
  /** The sensitivity pass: swapped coverage/equity weights, ranking stability. */
  readonly sensitivity: { readonly perturbedWeights: ComparisonWeights; readonly rankingBefore: readonly string[]; readonly rankingAfter: readonly string[]; readonly rankingStable: boolean }
  /** The goal revision the comparison belongs to. */
  readonly goalRevision: number
  /** sha256 over the canonical comparison core — the fixed export revision. */
  readonly comparisonDigest: string
}

/** The projection input for one comparison. */
export interface ComparisonInput {
  readonly spec: AccessibilitySpec
  readonly population: readonly PopulationUnit[]
  readonly facilities: readonly FacilityPoint[]
  /** The base compute input minus the candidate facilities (provider, publish seam). */
  readonly provider?: CoverageComputeInput['provider']
  readonly publishArtifact?: CoverageComputeInput['publishArtifact']
}

/** Compose one option's score from the submitted weights (normalized inside the formula). */
function scoreOf(weights: ComparisonWeights, coverage: number, equity: number, cost: number): number {
  return weights.coverage * coverage + weights.equity * equity - weights.cost * cost
}

/** Sort feasible option ids by descending score. */
function rankOptions(options: readonly OptionEvaluation[]): string[] {
  return options
    .filter(option => option.feasible)
    .sort((a, b) => (b.score ?? Number.NEGATIVE_INFINITY) - (a.score ?? Number.NEGATIVE_INFINITY))
    .map(option => option.optionId)
}

/** Verify one candidate option's internal feasibility before computing. */
function candidateInfeasibility(candidate: CandidateOption, costBudget: number | undefined): string | undefined {
  if (costBudget !== undefined && candidate.cost > costBudget) return 'cost-over-budget'
  const ids = new Set<string>()
  for (const facility of candidate.addFacilities) {
    if (ids.has(facility.id)) return 'duplicate-facility-id'
    ids.add(facility.id)
    if (facility.capacity !== undefined && facility.capacity <= 0) return 'non-positive-capacity'
  }
  return undefined
}

/**
 * Evaluate the baseline plus every given candidate on identical input
 * versions and run the sensitivity pass. Options are the user's candidates —
 * the result never claims a global optimum.
 * @param checkpoints - the run's cancel checkpoints.
 * @param input - spec with candidates/weights/budget, population, facilities.
 * @returns the comparison outcome.
 * @throws {AccessibilityError} `ACCESS_INVALID_INPUT` when candidates are
 *   declared without weights.
 */
export async function evaluateComparison(checkpoints: RunCheckpoints, input: ComparisonInput): Promise<ComparisonOutcome> {
  const { spec } = input
  const candidates = spec.candidates ?? []
  if (candidates.length > 0 && spec.weights === undefined) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', 'comparing candidates requires explicit weights')
  }
  checkpoints.throwIfCancelled()

  /** Compute coverage for one facility table. */
  async function evaluate(facilities: readonly FacilityPoint[]): Promise<Awaited<ReturnType<typeof computeCoverage>>> {
    return computeCoverage(checkpoints, {
      spec,
      population: input.population,
      facilities,
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.publishArtifact === undefined ? {} : { publishArtifact: input.publishArtifact }),
    })
  }

  const baseResult = await evaluate(input.facilities)
  checkpoints.throwIfCancelled()
  const baselineEvidence = baseResult.evidence
  const baseline: OptionEvaluation = {
    optionId: 'baseline',
    label: 'status quo',
    feasible: true,
    coveredPopulation: baselineEvidence.coveredPopulation,
    uncoveredPopulation: baselineEvidence.uncoveredPopulation,
    coverageRatio: baselineEvidence.coverageRatio,
    communityEquityShare: meanCommunityShare(baselineEvidence.perCommunity),
    cost: 0,
    evidence: baselineEvidence,
  }

  const evaluations: OptionEvaluation[] = [baseline]
  for (const candidate of candidates) {
    checkpoints.throwIfCancelled()
    const infeasible = candidateInfeasibility(candidate, spec.costBudget)
    if (infeasible !== undefined) {
      // Infeasible candidates stay listed with their reason, never silently
      // dropped and never computed.
      evaluations.push({
        optionId: candidate.id,
        label: candidate.label,
        feasible: false,
        infeasibleReason: infeasible,
        coveredPopulation: 0,
        uncoveredPopulation: 0,
        coverageRatio: 0,
        communityEquityShare: 0,
        cost: candidate.cost,
        evidence: null,
      })
      continue
    }
    const added: FacilityPoint[] = candidate.addFacilities.map(facility => ({
      id: facility.id,
      coordinates: facility.coordinates,
      ...(facility.capacity === undefined ? {} : { capacity: facility.capacity }),
      ...(facility.entrance === undefined ? {} : { entrance: facility.entrance }),
    }))
    const result = await evaluate([...input.facilities, ...added])
    const evidence = result.evidence
    evaluations.push({
      optionId: candidate.id,
      label: candidate.label,
      feasible: true,
      coveredPopulation: evidence.coveredPopulation,
      uncoveredPopulation: evidence.uncoveredPopulation,
      coverageRatio: evidence.coverageRatio,
      communityEquityShare: meanCommunityShare(evidence.perCommunity),
      cost: candidate.cost,
      evidence,
    })
  }

  const weights = spec.weights ?? { coverage: 1, equity: 0, cost: 0 }
  for (const option of evaluations) {
    if (option.feasible) {
      (option as { score?: number }).score = scoreOf(weights, option.coverageRatio, option.communityEquityShare, option.cost)
    }
  }
  const ranking = rankOptions(evaluations)

  // Sensitivity: swap coverage and equity weights and re-rank. A ranking that
  // survives the perturbation is reported stable; one that flips is reported
  // unstable — never hidden behind a single-weight answer.
  const perturbedWeights: ComparisonWeights = { coverage: weights.equity, equity: weights.coverage, cost: weights.cost }
  for (const option of evaluations) {
    if (option.feasible) {
      (option as { score?: number }).score = scoreOf(perturbedWeights, option.coverageRatio, option.communityEquityShare, option.cost)
    }
  }
  const rankingAfter = rankOptions(evaluations)
  for (const option of evaluations) {
    if (option.feasible) {
      (option as { score?: number }).score = scoreOf(weights, option.coverageRatio, option.communityEquityShare, option.cost)
    }
  }

  const networkRef = baselineEvidence.inputRefs.networkRef
  const comparisonDigest = sha256Hex(JSON.stringify({
    goalRevision: spec.goalRevision,
    populationRef: spec.populationRef,
    facilityRefs: spec.facilityRefs,
    networkRef,
    methodVersion: baselineEvidence.methodVersion,
    weights,
    options: evaluations.map(option => ({
      id: option.optionId,
      feasible: option.feasible,
      infeasibleReason: option.infeasibleReason ?? null,
      covered: option.coveredPopulation,
      uncovered: option.uncoveredPopulation,
      equity: option.communityEquityShare,
      cost: option.cost,
    })),
    ranking,
  }))

  return {
    kind: 'candidate-comparison',
    baseline,
    candidates: evaluations.slice(1),
    ranking,
    inputVersions: {
      populationRef: spec.populationRef,
      networkRef,
      methodVersion: baselineEvidence.methodVersion,
    },
    weights,
    sensitivity: {
      perturbedWeights,
      rankingBefore: ranking,
      rankingAfter,
      rankingStable: JSON.stringify(ranking) === JSON.stringify(rankingAfter),
    },
    goalRevision: spec.goalRevision,
    comparisonDigest,
  }
}

/** The refusal reason when a stale comparison cannot override the current goal. */
export type ProjectionRefusal = 'goal-revision-stale'

/** The result of projecting one comparison against the current goal. */
export interface ProjectionResult {
  readonly applied: boolean
  readonly refusal?: ProjectionRefusal
  readonly projection?: ComparisonProjection
}

/** The fixed-revision map/report projection of one comparison. */
export interface ComparisonProjection {
  /** Fixed content revision: a re-export of the same outcome is byte-identical. */
  readonly contentRevision: string
  readonly goalRevision: number
  readonly comparisonDigest: string
  readonly ranking: readonly string[]
  /** Map delivery: one coverage summary layer per ranked option (bounded). */
  readonly mapLayers: readonly { readonly optionId: string; readonly name: string; readonly coverageRatio: number; readonly coveredPopulation: number }[]
  /** Report delivery: the fixed sections a report render consumes. */
  readonly report: {
    readonly title: string
    readonly baselineOptionId: 'baseline'
    readonly options: readonly { readonly optionId: string; readonly feasible: boolean; readonly infeasibleReason?: string; readonly coveredPopulation: number; readonly coverageRatio: number; readonly cost: number }[]
    readonly weights: ComparisonWeights
    readonly sensitivityStable: boolean
    readonly limitations: readonly string[]
  }
}

/**
 * Project one comparison onto the current goal. A comparison computed for an
 * older goal revision (a late-arriving old run) is refused — it can be
 * inspected, never applied over the newer goal.
 * @param outcome - the comparison to project.
 * @param currentGoalRevision - the goal revision currently in force.
 * @returns the applied projection or the named refusal.
 */
export function projectComparison(outcome: ComparisonOutcome, currentGoalRevision: number): ProjectionResult {
  if (outcome.goalRevision !== currentGoalRevision) {
    return { applied: false, refusal: 'goal-revision-stale' }
  }
  const projection: ComparisonProjection = {
    contentRevision: sha256Hex(JSON.stringify({
      digest: outcome.comparisonDigest,
      goalRevision: outcome.goalRevision,
      ranking: outcome.ranking,
    })).slice(0, 24),
    goalRevision: outcome.goalRevision,
    comparisonDigest: outcome.comparisonDigest,
    ranking: outcome.ranking,
    mapLayers: [outcome.baseline, ...outcome.candidates]
      .filter(option => option.feasible)
      .sort((a, b) => outcome.ranking.indexOf(a.optionId) - outcome.ranking.indexOf(b.optionId))
      .map(option => ({
        optionId: option.optionId,
        name: option.label,
        coverageRatio: option.coverageRatio,
        coveredPopulation: option.coveredPopulation,
      })),
    report: {
      title: '候选方案比较（给定方案，非全局最优）',
      baselineOptionId: 'baseline',
      options: [outcome.baseline, ...outcome.candidates].map(option => ({
        optionId: option.optionId,
        feasible: option.feasible,
        ...(option.infeasibleReason === undefined ? {} : { infeasibleReason: option.infeasibleReason }),
        coveredPopulation: option.coveredPopulation,
        coverageRatio: option.coverageRatio,
        cost: option.cost,
      })),
      weights: outcome.weights,
      sensitivityStable: outcome.sensitivity.rankingStable,
      limitations: [
        'the comparison covers only the submitted candidate options; it is not a global facility-location optimum',
        'weights are explicit submissions; a different weight choice can change the ranking (see sensitivity)',
      ],
    },
  }
  return { applied: true, projection }
}
