/**
 * The constrained scenario computations: `compare` (rank the caller's given
 * candidate schemes against the implicit status-quo zero point under explicit
 * coverage/equity/cost weights, keep every infeasible candidate with its
 * named reasons, and sweep the weight set for rank stability) and `allocate`
 * (open candidate sites under a budget by the documented greedy marginal-
 * objective rule with capacity-aware nearest-site assignment; `global` adds a
 * bounded exact search over the declared affordable sites). The weights are
 * explicit value inputs: an absent weight block selects one recorded default
 * scenario that the output flags `defaultScenario: true`. Comparison still
 * ranks only given candidates, while allocation names whether it used the
 * greedy rule or the declared-domain global search.
 *
 * @module @map-harness/spatial-decision/optimize
 */
import { haversineMeters, type LonLat } from '@map-harness/spatial-statistics'
import {
  DEFAULT_SCENARIO_WEIGHTS,
  MAX_COMBINATION_NODES,
  MAX_ANALYSIS_ROWS,
  SENSITIVITY_MULTIPLIERS,
  type AllocateSite,
  type LocationAllocateSpec,
  type ScenarioCandidate,
  type ScenarioCompareSpec,
  type ScenarioWeights,
} from './contract.ts'
import { DecisionError } from './errors.ts'
import { isFiniteNumber } from './linalg.ts'
import type { DecisionPublish } from './attribution.ts'

/** One ranked candidate row of a comparison. */
export interface ScenarioRankRow {
  readonly id: string
  readonly feasible: boolean
  readonly infeasibleReasons: readonly string[]
  readonly coverageShare: number
  readonly worstGroupShare: number | null
  readonly costNorm: number
  readonly objective: number
  readonly beatsStatusQuo: boolean
  /** Rank among the feasible candidates (1 = best); `null` for infeasible rows. */
  readonly rank: number | null
}

/** One sensitivity scenario: the perturbed weights and the top candidate they select. */
export interface ScenarioSensitivityRow {
  readonly label: string
  readonly weights: ScenarioWeights
  readonly topId: string | null
}

/** The comparison evidence. */
export interface ScenarioCompareEvidence {
  readonly status: 'succeeded' | 'not_applicable' | 'unknown'
  readonly notApplicableReason?: string | undefined
  readonly limitations: readonly string[]
  readonly artifacts: readonly { label: string; ref: string }[]
  readonly rows: readonly ScenarioRankRow[]
  readonly topId: string | null
  /** True when the resolved weights are the recorded default scenario, not caller-declared values. */
  readonly defaultScenario: boolean
  readonly sensitivity: readonly ScenarioSensitivityRow[]
  readonly rankStable: boolean
}

/** One allocation site row of an allocation result. */
export interface AllocateSiteRow {
  readonly id: string
  readonly opened: boolean
  readonly assignedDemand: number
  readonly cost: number
}

/** One equity group's coverage row. */
export interface AllocateGroupRow {
  readonly group: string
  readonly demand: number
  readonly covered: number
  readonly share: number
}

/** The allocation evidence. */
export interface LocationAllocateEvidence {
  readonly status: 'succeeded' | 'partial' | 'not_applicable' | 'unknown'
  readonly notApplicableReason?: string | undefined
  readonly limitations: readonly string[]
  readonly artifacts: readonly { label: string; ref: string }[]
  readonly accounting: { used: number; droppedByReason: Readonly<Record<string, number>> }
  readonly sites: readonly AllocateSiteRow[]
  readonly groups: readonly AllocateGroupRow[]
  readonly totalDemand: number
  readonly coveredDemand: number
  readonly uncoveredRows: number
  readonly capacityShortfall: number
  readonly objective: number
  readonly defaultScenario: boolean
  readonly sensitivity: readonly ScenarioSensitivityRow[]
  readonly rankStable: boolean
  readonly mode: 'greedy' | 'global'
  /** The selected site IDs in deterministic order. */
  readonly openedSiteIds: readonly string[]
  /** Greedy objective retained as a comparison even for the global mode. */
  readonly greedyObjective: number
  /** `objective - greedyObjective`; zero for greedy mode. */
  readonly objectiveDeltaVsGreedy: number
  readonly enumeration: {
    readonly domain: 'declared-affordable-sites'
    readonly candidateCount: number
    readonly totalSubsets: number
    readonly evaluatedSubsets: number
    readonly maxSubsets: number
  }
}

/** One prepared demand point the allocation consumes. */
export interface AllocateDemandRow {
  readonly id: string
  readonly coordinates: LonLat
  readonly demand: number
  readonly group: string
}

/** Normalize one weight vector by its sum (the contract guarantees sum > 0). */
function normalizedWeights(weights: ScenarioWeights): ScenarioWeights {
  const sum = weights.coverage + weights.equity + weights.cost
  return { coverage: weights.coverage / sum, equity: weights.equity / sum, cost: weights.cost / sum }
}

/** The fixed sensitivity scenario labels the sweep evaluates. */
const SENSITIVITY_KEYS = ['coverage', 'equity', 'cost'] as const

/** The candidate feasibility checks with their named reasons. */
function candidateFeasibility(
  candidate: ScenarioCandidate,
  demandOf: ReadonlyMap<string, number>,
  budget: number | undefined,
): { feasible: boolean; reasons: string[] } {
  const reasons: string[] = []
  let servedTotal = 0
  for (const [groupId, amount] of Object.entries(candidate.servedByGroup)) {
    const demand = demandOf.get(groupId)
    if (demand === undefined) {
      reasons.push(`unknown-group:${groupId}`)
      continue
    }
    if (amount > demand) reasons.push(`overpromise:${groupId}`)
    servedTotal += Math.max(0, Math.min(amount, demand))
  }
  if (candidate.capacity !== undefined && servedTotal > candidate.capacity) reasons.push('capacity-exceeded')
  if (budget !== undefined && candidate.cost > budget) reasons.push('over-budget')
  return { feasible: reasons.length === 0, reasons }
}

/** The objective of one candidate under normalized weights (the status quo is exactly 0). */
function objectiveOf(
  coverageShare: number,
  worstGroupShare: number | null,
  costNorm: number,
  weights: ScenarioWeights,
): number {
  return weights.coverage * coverageShare
    + weights.equity * (worstGroupShare ?? 0)
    - weights.cost * costNorm
}

/**
 * Rank the given candidates against the status quo. Every candidate stays in
 * the output; infeasible ones carry their named reasons and no rank. The
 * table is bounded (≤ 16 candidates), so `publish` may be `null`: the result
 * then carries no artifact and the full table stays model-visible.
 * @param spec - the validated comparison spec.
 * @param publish - the artifact seam, or `null` to publish nothing.
 * @returns the comparison evidence.
 */
export async function compareScenarios(
  spec: ScenarioCompareSpec,
  publish: DecisionPublish | null,
): Promise<ScenarioCompareEvidence> {
  const demandOf = new Map(spec.groups.map(group => [group.id, group.demand]))
  const totalDemand = spec.groups.reduce((s, group) => s + group.demand, 0)
  const limitations = [
    'the ranking orders the given candidates only; it is not a global optimum over possible schemes',
    'weights are explicit value inputs; a different weight set can rank differently and the sensitivity table shows the sweep',
    'the status quo is the implicit zero point: a candidate only beats it when its weighted benefit exceeds its weighted cost',
  ]
  const artifacts: { label: string; ref: string }[] = []
  if (totalDemand <= 0) {
    return {
      status: 'not_applicable',
      notApplicableReason: 'no-valid-observations',
      limitations,
      artifacts,
      rows: [],
      topId: null,
      defaultScenario: spec.weights === undefined,
      sensitivity: [],
      rankStable: true,
    }
  }
  const defaultScenario = spec.weights === undefined
  const baseWeights = normalizedWeights(spec.weights ?? DEFAULT_SCENARIO_WEIGHTS)
  const maxCost = Math.max(...spec.candidates.map(candidate => candidate.cost), 0)
  const evaluated = spec.candidates.map(candidate => {
    const { feasible, reasons } = candidateFeasibility(candidate, demandOf, spec.budget)
    let covered = 0
    let worst: number | null = null
    for (const group of spec.groups) {
      const served = Math.max(0, Math.min(candidate.servedByGroup[group.id] ?? 0, group.demand))
      covered += served
      if (group.demand > 0) {
        const share = served / group.demand
        worst = worst === null ? share : Math.min(worst, share)
      }
    }
    const coverageShare = covered / totalDemand
    const costNorm = spec.budget !== undefined ? candidate.cost / spec.budget : maxCost > 0 ? candidate.cost / maxCost : 0
    return {
      id: candidate.id,
      feasible,
      infeasibleReasons: reasons,
      coverageShare,
      worstGroupShare: worst,
      costNorm,
      objective: objectiveOf(coverageShare, worst, costNorm, baseWeights),
    }
  })
  const feasibleRanked = evaluated
    .filter(row => row.feasible)
    .sort((a, b) => b.objective - a.objective || (a.id < b.id ? -1 : 1))
  const rankOf = new Map(feasibleRanked.map((row, index) => [row.id, index + 1]))
  const rows: ScenarioRankRow[] = evaluated.map(row => ({
    ...row,
    beatsStatusQuo: row.feasible && row.objective > 0,
    rank: rankOf.get(row.id) ?? null,
  }))
  const topId = feasibleRanked[0]?.id ?? null
  // Sensitivity: halve and double each weight in turn, renormalize, re-rank.
  const sensitivity: ScenarioSensitivityRow[] = []
  for (const key of SENSITIVITY_KEYS) {
    for (const multiplier of SENSITIVITY_MULTIPLIERS) {
      const raw: ScenarioWeights = { ...baseWeights, [key]: baseWeights[key] * multiplier }
      const weights = normalizedWeights(raw)
      let top: string | null = null
      let best = Number.NEGATIVE_INFINITY
      for (const candidate of spec.candidates) {
        const { feasible } = candidateFeasibility(candidate, demandOf, spec.budget)
        if (!feasible) continue
        let covered = 0
        let worst: number | null = null
        for (const group of spec.groups) {
          const served = Math.max(0, Math.min(candidate.servedByGroup[group.id] ?? 0, group.demand))
          covered += served
          if (group.demand > 0) worst = worst === null ? served / group.demand : Math.min(worst, served / group.demand)
        }
        const coverageShare = covered / totalDemand
        const costNorm = spec.budget !== undefined ? candidate.cost / spec.budget : maxCost > 0 ? candidate.cost / maxCost : 0
        const objective = objectiveOf(coverageShare, worst, costNorm, weights)
        if (objective > best || (objective === best && top !== null && candidate.id < top)) {
          best = objective
          top = candidate.id
        }
      }
      sensitivity.push({ label: `${key}×${multiplier}`, weights, topId: top })
    }
  }
  const rankStable = sensitivity.every(row => row.topId === topId)
  if (publish !== null) {
    const table = { kind: 'scenario-compare', methodVersion: spec.methodVersion, rows, topId, sensitivity, rankStable }
    artifacts.push({ label: 'scenario-table', ref: (await publish('scenario-table', new TextEncoder().encode(JSON.stringify(table)))).ref })
  }
  return {
    status: 'succeeded',
    limitations,
    artifacts,
    rows,
    topId,
    defaultScenario,
    sensitivity,
    rankStable,
  }
}

/** The internal allocation state one greedy pass consumes. */
interface AllocatePass {
  readonly demandRows: readonly AllocateDemandRow[]
  readonly sites: readonly AllocateSite[]
  readonly affordable: readonly string[]
  readonly weights: ScenarioWeights
  readonly totalDemand: number
  readonly groupDemand: ReadonlyMap<string, number>
  readonly budget: number | undefined
  readonly radius: number
}

interface AllocationSearchResult {
  readonly openIds: Set<string>
  readonly state: ReturnType<typeof assignDemand>
  readonly objective: number
  readonly evaluatedSubsets: number
}

/** Assign demand rows to the open sites (nearest within radius, capacity-capped, largest demand first). */
function assignDemand(pass: AllocatePass, openIds: ReadonlySet<string>): {
  assignedBySite: Map<string, number>
  coveredByGroup: Map<string, number>
  uncovered: number
  coveredTotal: number
} {
  const remaining = new Map([...openIds].map(id => {
    const site = pass.sites.find(candidate => candidate.id === id)
    return [id, site?.capacity ?? Number.POSITIVE_INFINITY]
  }))
  const assignedBySite = new Map([...openIds].map(id => [id, 0]))
  const coveredByGroup = new Map<string, number>()
  let uncovered = 0
  let coveredTotal = 0
  const ordered = [...pass.demandRows].sort((a, b) => b.demand - a.demand || (a.id < b.id ? -1 : 1))
  for (const row of ordered) {
    const candidates = [...openIds]
      .map(id => {
        const site = pass.sites.find(candidate => candidate.id === id)
        return site === undefined ? null : { id, distance: haversineMeters(row.coordinates, [site.lon, site.lat]) }
      })
      .filter((entry): entry is { id: string; distance: number } => entry !== null && entry.distance <= pass.radius)
      .sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1))
    let placed = false
    for (const candidate of candidates) {
      const capacity = remaining.get(candidate.id) ?? 0
      if (capacity <= 0) continue
      const served = Math.min(row.demand, capacity)
      remaining.set(candidate.id, capacity - served)
      assignedBySite.set(candidate.id, (assignedBySite.get(candidate.id) ?? 0) + served)
      coveredByGroup.set(row.group, (coveredByGroup.get(row.group) ?? 0) + served)
      coveredTotal += served
      placed = served === row.demand
      break
    }
    if (!placed) uncovered++
  }
  return { assignedBySite, coveredByGroup, uncovered, coveredTotal }
}

/** The weighted objective of one allocation state. */
function allocateObjective(pass: AllocatePass, state: ReturnType<typeof assignDemand>): number {
  const coverageShare = pass.totalDemand > 0 ? state.coveredTotal / pass.totalDemand : 0
  let worst: number | null = null
  for (const [group, demand] of pass.groupDemand) {
    if (demand <= 0) continue
    const share = (state.coveredByGroup.get(group) ?? 0) / demand
    worst = worst === null ? share : Math.min(worst, share)
  }
  let openedCost = 0
  for (const id of state.assignedBySite.keys()) {
    const site = pass.sites.find(candidate => candidate.id === id)
    openedCost += site?.cost ?? 0
  }
  const costNorm = pass.budget !== undefined
    ? pass.budget === 0 ? (openedCost === 0 ? 0 : 1) : openedCost / pass.budget
    : 1
  return objectiveOf(coverageShare, worst, costNorm, pass.weights)
}

/** Compare two opened-site sets by their sorted, stable ID representation. */
function openedKey(ids: ReadonlySet<string>): string {
  return [...ids].sort().join('+')
}

/** Enumerate every budget-feasible subset in deterministic ID order. */
function globalOpen(pass: AllocatePass): AllocationSearchResult {
  const ordered = [...pass.affordable].sort()
  let bestIds = new Set<string>()
  let bestState = assignDemand(pass, bestIds)
  let bestObjective = allocateObjective(pass, bestState)
  let evaluatedSubsets = 0
  const visit = (index: number, openIds: Set<string>, openCost: number): void => {
    if (index === ordered.length) {
      evaluatedSubsets++
      const state = assignDemand(pass, openIds)
      const objective = allocateObjective(pass, state)
      const key = openedKey(openIds)
      const bestKey = openedKey(bestIds)
      if (objective > bestObjective + 1e-15 || (Math.abs(objective - bestObjective) <= 1e-15 && key < bestKey)) {
        bestIds = new Set(openIds)
        bestState = state
        bestObjective = objective
      }
      return
    }
    // Excluding a site is always explored first, so the empty set is the deterministic tie baseline.
    visit(index + 1, openIds, openCost)
    const id = ordered[index]
    if (id === undefined) return
    const site = pass.sites.find(candidate => candidate.id === id)
    if (site === undefined) return
    if (pass.budget !== undefined && openCost + site.cost > pass.budget) return
    const next = new Set(openIds)
    next.add(id)
    visit(index + 1, next, openCost + site.cost)
  }
  visit(0, new Set(), 0)
  return { openIds: bestIds, state: bestState, objective: bestObjective, evaluatedSubsets }
}

/**
 * Open sites greedily under the budget to maximize the documented weighted
 * objective, with capacity-aware nearest-site assignment. The rule is
 * deterministic (ties break on site id) and is not a global optimum — every
 * result says so.
 * @param rows - the prepared demand rows.
 * @param spec - the validated allocation spec.
 * @param publish - the artifact seam the allocation table publishes through.
 * @returns the allocation evidence.
 */
export async function allocateLocations(
  rows: readonly AllocateDemandRow[],
  spec: LocationAllocateSpec,
  publish: DecisionPublish,
): Promise<LocationAllocateEvidence> {
  if (rows.length > MAX_ANALYSIS_ROWS) {
    throw new DecisionError('DECISION_INVALID_INPUT', `the demand table exceeds the ${MAX_ANALYSIS_ROWS}-row budget`)
  }
  const dropped: Record<string, number> = {}
  const demandRows: AllocateDemandRow[] = []
  for (const [index, row] of rows.entries()) {
    if (!isFiniteNumber(row.demand) || row.demand < 0) {
      dropped['invalid-demand'] = (dropped['invalid-demand'] ?? 0) + 1
      continue
    }
    demandRows.push({ ...row, id: row.id || `demand-${index + 1}` })
  }
  const totalDemand = demandRows.reduce((s, row) => s + row.demand, 0)
  const defaultScenario = spec.weights === undefined
  const weights = normalizedWeights(spec.weights ?? DEFAULT_SCENARIO_WEIGHTS)
  const groupDemand = new Map<string, number>()
  for (const row of demandRows) groupDemand.set(row.group, (groupDemand.get(row.group) ?? 0) + row.demand)
  const affordable = spec.sites
    .filter(site => spec.budget === undefined || site.cost <= spec.budget)
    .map(site => site.id)
    .sort()
  const infeasibleSites = spec.sites
    .filter(site => spec.budget !== undefined && site.cost > spec.budget)
    .map(site => site.id)
  const mode = spec.mode ?? 'greedy'
  const limitations = [
    mode === 'global'
      ? 'the global result is optimal only over the declared affordable site set and the stated budget; it is not a continuous or mixed-integer optimum'
      : 'the greedy opening rule has no global-optimality guarantee; it is one deterministic search order over the declared sites',
    'weights are explicit value inputs; the sensitivity table shows how the opened set changes under the weight sweep',
    'coverage uses great-circle distance to the declared radius; it is not network travel coverage',
  ]
  const artifacts: { label: string; ref: string }[] = []
  const accounting = { used: demandRows.length, droppedByReason: dropped }
  if (totalDemand <= 0 || affordable.length === 0) {
    return {
      status: 'not_applicable',
      notApplicableReason: affordable.length === 0 ? 'no-feasible-candidate' : 'no-valid-observations',
      limitations,
      artifacts,
      accounting,
      sites: spec.sites.map(site => ({ id: site.id, opened: false, assignedDemand: 0, cost: site.cost })),
      groups: [],
      totalDemand,
      coveredDemand: 0,
      uncoveredRows: 0,
      capacityShortfall: 0,
      objective: 0,
      defaultScenario,
      sensitivity: [],
      rankStable: true,
      mode,
      openedSiteIds: [],
      greedyObjective: 0,
      objectiveDeltaVsGreedy: 0,
      enumeration: {
        domain: 'declared-affordable-sites',
        candidateCount: affordable.length,
        totalSubsets: affordable.length > 0 ? 2 ** affordable.length : 1,
        evaluatedSubsets: 0,
        maxSubsets: MAX_COMBINATION_NODES,
      },
    }
  }
  const totalSubsets = 2 ** affordable.length
  if (mode === 'global' && totalSubsets > MAX_COMBINATION_NODES) {
    return {
      status: 'not_applicable',
      notApplicableReason: 'combination-domain-too-large',
      limitations: [
        ...limitations,
        `the global search domain has ${totalSubsets} subsets, above the ${MAX_COMBINATION_NODES}-subset limit; use mode=greedy or partition the declared candidates`,
        ...(infeasibleSites.length > 0 ? [`sites above the budget stay closed and named: ${infeasibleSites.join(', ')}`] : []),
      ],
      artifacts,
      accounting,
      sites: spec.sites.map(site => ({ id: site.id, opened: false, assignedDemand: 0, cost: site.cost })),
      groups: [],
      totalDemand,
      coveredDemand: 0,
      uncoveredRows: 0,
      capacityShortfall: 0,
      objective: 0,
      defaultScenario,
      sensitivity: [],
      rankStable: true,
      mode,
      openedSiteIds: [],
      greedyObjective: 0,
      objectiveDeltaVsGreedy: 0,
      enumeration: {
        domain: 'declared-affordable-sites',
        candidateCount: affordable.length,
        totalSubsets,
        evaluatedSubsets: 0,
        maxSubsets: MAX_COMBINATION_NODES,
      },
    }
  }
  const pass: AllocatePass = {
    demandRows,
    sites: spec.sites,
    affordable,
    weights,
    totalDemand,
    groupDemand,
    budget: spec.budget,
    radius: spec.coverageRadiusMeters,
  }
  // Always compute the greedy baseline so global results can show the exact delta.
  const greedyIds = greedyOpen(pass)
  const greedyState = assignDemand(pass, greedyIds)
  const greedyObjective = allocateObjective(pass, greedyState)
  const search = mode === 'global'
    ? globalOpen(pass)
    : { openIds: greedyIds, state: greedyState, objective: greedyObjective, evaluatedSubsets: 0 }
  const openIds = search.openIds
  const currentState = search.state
  const currentObjective = search.objective
  const capacityOfOpen = [...openIds].reduce((s, id) => s + (spec.sites.find(candidate => candidate.id === id)?.capacity ?? 0), 0)
  const capacityShortfall = Math.max(0, totalDemand - capacityOfOpen)
  const groups: AllocateGroupRow[] = [...groupDemand.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([group, demand]) => ({
      group,
      demand,
      covered: currentState.coveredByGroup.get(group) ?? 0,
      share: demand > 0 ? (currentState.coveredByGroup.get(group) ?? 0) / demand : 0,
    }))
  const siteRows: AllocateSiteRow[] = spec.sites.map(site => ({
    id: site.id,
    opened: openIds.has(site.id),
    assignedDemand: currentState.assignedBySite.get(site.id) ?? 0,
    cost: site.cost,
  }))
  // Sensitivity: rerun the selected search under each perturbed weight vector.
  const sensitivity: ScenarioSensitivityRow[] = []
  for (const key of SENSITIVITY_KEYS) {
    for (const multiplier of SENSITIVITY_MULTIPLIERS) {
      const raw: ScenarioWeights = { ...weights, [key]: weights[key] * multiplier }
      const sweepPass: AllocatePass = { ...pass, weights: normalizedWeights(raw) }
      const sweepOpen = mode === 'global' ? globalOpen(sweepPass).openIds : greedyOpen(sweepPass)
      sensitivity.push({ label: `${key}×${multiplier}`, weights: normalizedWeights(raw), topId: [...sweepOpen].sort().join('+') || null })
    }
  }
  const baseSet = [...openIds].sort().join('+')
  const rankStable = sensitivity.every(row => row.topId === baseSet)
  const enumeration = {
    domain: 'declared-affordable-sites' as const,
    candidateCount: affordable.length,
    totalSubsets,
    evaluatedSubsets: search.evaluatedSubsets,
    maxSubsets: MAX_COMBINATION_NODES,
  }
  const openedSiteIds = [...openIds].sort()
  const table = {
    kind: 'location-allocate',
    methodVersion: spec.methodVersion,
    mode,
    sites: siteRows,
    groups,
    sensitivity,
    rankStable,
    enumeration,
    greedyObjective,
    objectiveDeltaVsGreedy: currentObjective - greedyObjective,
  }
  artifacts.push({ label: 'allocation-table', ref: (await publish('allocation-table', new TextEncoder().encode(JSON.stringify(table)))).ref })
  return {
    status: capacityShortfall > 0 || currentState.uncovered > 0 ? 'partial' : 'succeeded',
    limitations: infeasibleSites.length > 0
      ? [...limitations, `sites above the budget stay closed and named: ${infeasibleSites.join(', ')}`]
      : limitations,
    artifacts,
    accounting,
    sites: siteRows,
    groups,
    totalDemand,
    coveredDemand: currentState.coveredTotal,
    uncoveredRows: currentState.uncovered,
    capacityShortfall,
    objective: currentObjective,
    defaultScenario,
    sensitivity,
    rankStable,
    mode,
    openedSiteIds,
    greedyObjective,
    objectiveDeltaVsGreedy: currentObjective - greedyObjective,
    enumeration,
  }
}

/** The standalone greedy pass the sensitivity sweep reruns. */
function greedyOpen(pass: AllocatePass): Set<string> {
  const affordable = pass.affordable.filter(id => {
    const site = pass.sites.find(candidate => candidate.id === id)
    return site !== undefined && (pass.budget === undefined || site.cost <= pass.budget)
  })
  const openIds = new Set<string>()
  let openCost = 0
  let currentObjective = allocateObjective(pass, assignDemand(pass, openIds))
  for (;;) {
    let bestId: string | null = null
    let bestObjective = currentObjective
    for (const id of affordable) {
      if (openIds.has(id)) continue
      const site = pass.sites.find(candidate => candidate.id === id)
      if (site === undefined) continue
      if (pass.budget !== undefined && openCost + site.cost > pass.budget) continue
      const nextOpen = new Set([...openIds, id])
      const nextObjective = allocateObjective(pass, assignDemand(pass, nextOpen))
      const better = nextObjective > bestObjective + 1e-15
      const tie = Math.abs(nextObjective - bestObjective) <= 1e-15 && bestId !== null && id < bestId
      if (better || tie) {
        bestId = id
        bestObjective = nextObjective
      }
    }
    if (bestId === null) break
    const site = pass.sites.find(candidate => candidate.id === bestId)
    openIds.add(bestId)
    openCost += site?.cost ?? 0
    currentObjective = bestObjective
  }
  return openIds
}
