/**
 * Population-weighted network coverage: the server-side bounded computation a
 * run worker executes. Facilities snap to the network through their
 * entrances, serve within the impedance budget under the run's time slices
 * and barriers, and are capacity-capped; population units are assigned
 * nearest-first so every unit is counted exactly once (covered + uncovered =
 * denominator, always). Outcomes distinguish `complete`, `partial` (provider
 * reads interrupted), and `empty` (nothing to compute), refuse to run at all
 * when the network cannot price the requested mode, and publish coverage
 * artifacts through the caller's callback. A straight-line fallback lives in
 * the contract as a permanently marked exploration — never here.
 *
 * @module @map-harness/spatial-accessibility/metrics
 */
import {
  ACCESSIBILITY_METHOD_VERSION,
  BOUNDARY_RULE,
  type AccessibilitySpec,
  type LonLat,
} from './contract.ts'
import { AccessibilityError } from './errors.ts'
import { createControlledNetworkProvider, type NetworkProvider } from './network.ts'
import type { RunCheckpoints } from './runs.ts'

/** One population unit with its declared denominator. */
export interface PopulationUnit {
  readonly id: string
  readonly coordinates: LonLat
  /** The population this unit carries; must be a finite non-negative number. */
  readonly population: number
  /** Optional community label for the equity/difference aggregates. */
  readonly community?: string
}

/** One facility point as resolved from its versioned resource. */
export interface FacilityPoint {
  readonly id: string
  readonly coordinates: LonLat
  readonly capacity?: number
  readonly entrance?: LonLat
}

/** The input one coverage computation consumes. */
export interface CoverageComputeInput {
  readonly spec: AccessibilitySpec
  /** The provider serving the network; defaults to the controlled lattice over the support extent. */
  readonly provider?: NetworkProvider
  readonly population: readonly PopulationUnit[]
  readonly facilities: readonly FacilityPoint[]
  /** Artifact publication seam; the run layer binds the catalog publication here. */
  readonly publishArtifact?: (label: string, bytes: Uint8Array) => Promise<{ ref: string }>
}

/** One bounded diagnostic the computation reports. */
export interface CoverageDiagnostic {
  readonly code: 'entrance-missing' | 'entrance-off-network' | 'outside-support' | 'population-invalid' | 'facility-unreachable' | 'provider-read-partial'
  readonly facilityId?: string
  readonly unitId?: string
  readonly message: string
}

/** The coverage evidence record a completed run stores and publishes. */
export interface CoverageEvidence {
  readonly kind: 'network-coverage'
  readonly outcome: 'complete' | 'partial' | 'empty'
  readonly methodVersion: typeof ACCESSIBILITY_METHOD_VERSION
  /** Input identities the computation consumed (exact catalog + network versions). */
  readonly inputRefs: { readonly populationRef: string; readonly facilityRefs: readonly string[]; readonly networkRef: string }
  /** The declared denominator: which population, which window, which units counted. */
  readonly denominator: {
    readonly observationWindow: { readonly from: string; readonly to: string }
    readonly unitCount: number
    readonly totalPopulation: number
    readonly doubleCountingRule: 'assign-nearest-once'
    readonly invalidUnitCount: number
  }
  readonly coveredPopulation: number
  readonly uncoveredPopulation: number
  readonly coverageRatio: number
  readonly consumedFeatureCount: number
  /** Per-time-slice coverage; the overall figures use the worst slice. */
  readonly perSlice: readonly { readonly slice: string; readonly coveredPopulation: number; readonly coverageRatio: number }[]
  /** Per-community aggregates, bounded by the unit table. */
  readonly perCommunity: readonly { readonly community: string; readonly population: number; readonly covered: number }[]
  readonly diagnostics: readonly CoverageDiagnostic[]
  readonly limitations: readonly string[]
  readonly artifacts: readonly { readonly label: string; readonly ref: string }[]
}

/** Maximum units and facilities one bounded computation accepts. */
export const MAX_POPULATION_UNITS = 20_000
export const MAX_FACILITIES = 2_000

/** Truncate per-community rows so the evidence stays bounded. */
const MAX_COMMUNITY_ROWS = 256

/** Build the default controlled provider for one spec (deterministic network over the support extent). */
export function providerForSpec(spec: AccessibilitySpec): NetworkProvider {
  return createControlledNetworkProvider({ bbox: spec.analysisSupportExtent.bbox })
}

/**
 * Compute population-weighted network coverage for one spec.
 * @param checkpoints - the run's cancel checkpoints; every phase ends in one.
 * @param input - spec, provider, population, facilities, and the artifact seam.
 * @returns the coverage evidence.
 * @throws {AccessibilityError} `METHOD_NOT_APPLICABLE` when the network does
 *   not price the requested travel mode; `ACCESS_INVALID_INPUT` when the unit
 *   or facility tables exceed the bounded limits.
 */
export async function computeCoverage(checkpoints: RunCheckpoints, input: CoverageComputeInput): Promise<{ readonly outcome: 'complete' | 'partial' | 'empty'; readonly evidence: CoverageEvidence }> {
  const { spec } = input
  if (input.population.length > MAX_POPULATION_UNITS) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', `population table exceeds the bounded limit of ${MAX_POPULATION_UNITS} units`)
  }
  if (input.facilities.length > MAX_FACILITIES) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', `facility table exceeds the bounded limit of ${MAX_FACILITIES} facilities`)
  }
  const provider = input.provider ?? providerForSpec(spec)

  checkpoints.throwIfCancelled()
  // Mode applicability first: without a priced network there is no coverage
  // answer at all — certainly not a buffer wearing its clothes.
  if (!provider.pricesMode(spec.impedance.travelMode)) {
    throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the network does not price mode ${spec.impedance.travelMode}; a walk/bike/drive target cannot be answered`)
  }

  const diagnostics: CoverageDiagnostic[] = []

  // Facility admission: entrance resolution, support-extent boundary rule,
  // and capacity (spec caps override resource capacities downward).
  const specEntrances = new Map((spec.entrances ?? []).map(entrance => [entrance.facilityId, entrance.coordinates]))
  const inSupport = (point: LonLat): boolean =>
    point[0] >= spec.analysisSupportExtent.bbox[0] && point[0] <= spec.analysisSupportExtent.bbox[2]
    && point[1] >= spec.analysisSupportExtent.bbox[1] && point[1] <= spec.analysisSupportExtent.bbox[3]
  const serving: {
    readonly id: string
    readonly servicePoint: LonLat
    readonly capacity: number
    insideStudy: boolean
  }[] = []
  for (const facility of input.facilities) {
    const entrance = facility.entrance ?? specEntrances.get(facility.id)
    if (entrance === undefined) {
      diagnostics.push({ code: 'entrance-missing', facilityId: facility.id, message: 'the facility carries no entrance and cannot join the network' })
      continue
    }
    if (!inSupport(entrance)) {
      diagnostics.push({ code: 'outside-support', facilityId: facility.id, message: 'the facility entrance lies outside the analysis support extent' })
      continue
    }
    const specCap = spec.capacity?.perFacility[facility.id]
    const capacity = Math.min(specCap ?? Number.POSITIVE_INFINITY, facility.capacity ?? Number.POSITIVE_INFINITY)
    serving.push({
      id: facility.id,
      servicePoint: entrance,
      capacity: Number.isFinite(capacity) ? capacity : Number.POSITIVE_INFINITY,
      insideStudy: pointInBbox(entrance, spec.studyArea.bbox),
    })
  }
  // The boundary rule is explicit in the evidence: retained out-of-study
  // facilities are the method's cross-boundary semantics, not a leak.
  const retainedOutsideStudy = serving.filter(facility => !facility.insideStudy).map(facility => facility.id)

  // Population admission: only valid units join the denominator.
  const units: { readonly id: string; readonly coordinates: LonLat; readonly population: number; readonly community: string | null }[] = []
  let invalidUnitCount = 0
  for (const unit of input.population) {
    if (!Number.isFinite(unit.population) || unit.population < 0) {
      invalidUnitCount += 1
      diagnostics.push({ code: 'population-invalid', unitId: unit.id, message: 'the unit carries no usable population and is excluded from the denominator' })
      continue
    }
    units.push({ id: unit.id, coordinates: unit.coordinates, population: unit.population, community: unit.community ?? null })
  }
  const totalPopulation = units.reduce((sum, unit) => sum + unit.population, 0)

  if (serving.length === 0) {
    checkpoints.throwIfCancelled()
    // Zero admissible facilities: an empty answer, or partial when the run
    // lost facilities to named admission diagnostics on the way.
    const outcome: 'empty' | 'partial' = diagnostics.length > 0 ? 'partial' : 'empty'
    const artifacts: { label: string; ref: string }[] = []
    const evidence: CoverageEvidence = {
      kind: 'network-coverage',
      outcome,
      methodVersion: ACCESSIBILITY_METHOD_VERSION,
      inputRefs: { populationRef: spec.populationRef, facilityRefs: [...spec.facilityRefs], networkRef: provider.networkRef },
      denominator: {
        observationWindow: { from: spec.observationWindow.from, to: spec.observationWindow.to },
        unitCount: units.length,
        totalPopulation,
        doubleCountingRule: 'assign-nearest-once',
        invalidUnitCount,
      },
      coveredPopulation: 0,
      uncoveredPopulation: totalPopulation,
      coverageRatio: 0,
      consumedFeatureCount: units.length + serving.length,
      perSlice: [],
      perCommunity: boundedCommunities(units, new Map()),
      diagnostics: withBoundaryNote(diagnostics, retainedOutsideStudy),
      limitations: limitationsFor(spec, true),
      artifacts,
    }
    await publishCoverageArtifact(input, evidence, artifacts, 'coverage-empty')
    return { outcome, evidence }
  }

  // Per-slice assignment: nearest reachable facility with remaining capacity.
  const perSlice: { slice: string; coveredPopulation: number; coverageRatio: number }[] = []
  let worst: { covered: Map<string, number>; coveredPopulation: number } | undefined
  let partialFromProvider = false
  for (const slice of spec.timeSlices) {
    checkpoints.throwIfCancelled()
    const effectiveBudget = spec.impedance.maxMinutes
    const areas = new Map<string, Map<string, number>>()
    const barriers = spec.barriers?.map(barrier => ({ from: barrier.from, to: barrier.to, kind: barrier.kind, ...(barrier.delayMinutes === undefined ? {} : { delayMinutes: barrier.delayMinutes }) }))
    for (const facility of serving) {
      try {
        const area = await provider.serviceArea(facility.servicePoint, effectiveBudget, {
          mode: spec.impedance.travelMode,
          slice,
          ...(barriers === undefined ? {} : { barriers }),
        })
        areas.set(facility.id, new Map(area.nodes.map(node => [node.id, node.minutes])))
      } catch (error: unknown) {
        if (error instanceof AccessibilityError && (error.code === 'RATE_LIMITED' || error.code === 'TEMPORARILY_UNAVAILABLE')) {
          partialFromProvider = true
          diagnostics.push({ code: 'provider-read-partial', facilityId: facility.id, message: `${error.code}: the service area for this facility is missing from the slice` })
          continue
        }
        throw error
      }
    }
    const assignment = assignUnits(checkpoints, units, serving, areas, provider)
    const coveredPopulation = units.reduce((sum, unit) => sum + (assignment.covered.get(unit.id) ?? 0), 0)
    perSlice.push({ slice, coveredPopulation, coverageRatio: totalPopulation === 0 ? 0 : coveredPopulation / totalPopulation })
    if (worst === undefined || coveredPopulation < worst.coveredPopulation) {
      worst = { covered: assignment.covered, coveredPopulation }
    }
  }

  checkpoints.throwIfCancelled()
  const coveredPopulation = worst?.coveredPopulation ?? 0
  const uncoveredPopulation = totalPopulation - coveredPopulation
  const outcome: 'complete' | 'partial' | 'empty' = units.length === 0
    ? 'empty'
    : partialFromProvider || diagnostics.length > 0 ? 'partial' : 'complete'
  const artifacts: { label: string; ref: string }[] = []
  const evidence: CoverageEvidence = {
    kind: 'network-coverage',
    outcome,
    methodVersion: ACCESSIBILITY_METHOD_VERSION,
    inputRefs: { populationRef: spec.populationRef, facilityRefs: [...spec.facilityRefs], networkRef: provider.networkRef },
    denominator: {
      observationWindow: { from: spec.observationWindow.from, to: spec.observationWindow.to },
      unitCount: units.length,
      totalPopulation,
      doubleCountingRule: 'assign-nearest-once',
      invalidUnitCount,
    },
    coveredPopulation,
    uncoveredPopulation,
    coverageRatio: totalPopulation === 0 ? 0 : coveredPopulation / totalPopulation,
    consumedFeatureCount: units.length + serving.length,
    perSlice,
    perCommunity: boundedCommunities(units, worst?.covered ?? new Map()),
    diagnostics: withBoundaryNote(diagnostics, retainedOutsideStudy),
    limitations: limitationsFor(spec, false),
    artifacts,
  }
  await publishCoverageArtifact(input, evidence, artifacts, 'coverage')
  return { outcome, evidence }
}

/** Whether one point lies inside a closed bbox. */
function pointInBbox(point: LonLat, bbox: readonly [number, number, number, number]): boolean {
  return point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3]
}

/** Assign every unit to its nearest reachable facility once; conservation is structural. */
function assignUnits(
  checkpoints: RunCheckpoints,
  units: readonly { id: string; coordinates: LonLat; population: number; community: string | null }[],
  serving: readonly { readonly id: string; readonly servicePoint: LonLat; readonly capacity: number }[],
  areas: ReadonlyMap<string, ReadonlyMap<string, number>>,
  provider: NetworkProvider,
): { covered: Map<string, number> } {
  const covered = new Map<string, number>()
  const remainingCapacity = new Map<string, number>(serving.map(facility => [facility.id, facility.capacity]))
  const unitSnaps = new Map<string, string>()
  for (const unit of units) {
    checkpoints.throwIfCancelled()
    unitSnaps.set(unit.id, provider.snapPoint(unit.coordinates).node.id)
  }
  for (const unit of units) {
    checkpoints.throwIfCancelled()
    if (unit.population === 0) continue
    const unitNode = unitSnaps.get(unit.id)
    if (unitNode === undefined) continue
    let best: { facilityId: string; minutes: number } | undefined
    for (const facility of serving) {
      const remaining = remainingCapacity.get(facility.id) ?? 0
      // Capacity is a hard cap: a unit the facility cannot fit stays
      // uncovered — no overbooking beyond the submitted rule.
      if (remaining < unit.population) continue
      const minutes = areas.get(facility.id)?.get(unitNode)
      if (minutes === undefined) continue
      if (best === undefined || minutes < best.minutes) best = { facilityId: facility.id, minutes }
    }
    if (best !== undefined) {
      remainingCapacity.set(best.facilityId, (remainingCapacity.get(best.facilityId) ?? 0) - unit.population)
      covered.set(unit.id, unit.population)
    }
  }
  return { covered }
}

/** Bounded per-community aggregation from one slice's covered set. */
function boundedCommunities(
  units: readonly { id: string; population: number; community: string | null }[],
  covered: ReadonlyMap<string, number>,
): { community: string; population: number; covered: number }[] {
  const rows = new Map<string, { community: string; population: number; covered: number }>()
  for (const unit of units) {
    const key = unit.community ?? '—'
    const row = rows.get(key) ?? { community: key, population: 0, covered: 0 }
    row.population += unit.population
    row.covered += covered.get(unit.id) ?? 0
    rows.set(key, row)
  }
  return [...rows.values()].slice(0, MAX_COMMUNITY_ROWS)
}

/** Record the boundary note beside the diagnostics when cross-boundary facilities served. */
function withBoundaryNote(diagnostics: readonly CoverageDiagnostic[], retainedOutsideStudy: readonly string[]): readonly CoverageDiagnostic[] {
  if (retainedOutsideStudy.length === 0) return diagnostics
  return [
    ...diagnostics,
    {
      code: 'outside-support' as const,
      message: `${BOUNDARY_RULE.outsideStudyWithinSupport}: out-of-study facilities retained inside the support extent (${retainedOutsideStudy.join(', ')})`,
    },
  ]
}

/** The method limitations every coverage evidence carries. */
function limitationsFor(spec: AccessibilitySpec, noFacilities: boolean): readonly string[] {
  const base = [
    `coverage is ${spec.impedance.travelMode} network impedance up to ${spec.impedance.maxMinutes} minutes; straight-line distance is never substituted`,
    'each population unit is assigned to exactly one facility (nearest-first); totals conserve by construction',
  ]
  if (noFacilities) base.push('no admissible facility remained after entrance and boundary admission')
  if (spec.capacity !== undefined) base.push('facility capacity is capped per the submitted capacity rule; overflow stays uncovered')
  return base
}

/** Publish one coverage artifact through the caller's seam when present. */
async function publishCoverageArtifact(
  input: CoverageComputeInput,
  evidence: CoverageEvidence,
  artifacts: { label: string; ref: string }[],
  label: string,
): Promise<void> {
  if (input.publishArtifact === undefined) return
  const featureCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          kind: evidence.kind,
          outcome: evidence.outcome,
          methodVersion: evidence.methodVersion,
          coveredPopulation: evidence.coveredPopulation,
          uncoveredPopulation: evidence.uncoveredPopulation,
          coverageRatio: evidence.coverageRatio,
          populationRef: evidence.inputRefs.populationRef,
          networkRef: evidence.inputRefs.networkRef,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [ringOf(input.spec.studyArea.bbox)],
        },
      },
    ],
  }
  const published = await input.publishArtifact(label, new TextEncoder().encode(JSON.stringify(featureCollection)))
  artifacts.push({ label, ref: published.ref })
}

/** A closed WGS84 ring for one bbox (study-area summary geometry). */
function ringOf(bbox: readonly [number, number, number, number]): LonLat[] {
  return [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[2], bbox[3]],
    [bbox[0], bbox[3]],
    [bbox[0], bbox[1]],
  ]
}
