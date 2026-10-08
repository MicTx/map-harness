/**
 * The P1 accessibility method contract: the versioned `AccessibilitySpec`
 * (study area, retrieval extent, analysis support extent, observation and
 * training windows, travel mode, impedance, time slices, barriers, entrances,
 * capacity, boundary rule, and optional candidate options), its structural
 * validation at the input boundary, the canonical request digest, and the
 * straight-line exploration marker that can never pass as network evidence.
 * Validation accepts the raw JSON-shaped input the tool layer forwards and
 * returns typed issues instead of throwing, so a rejected input lists every
 * reason rather than the first.
 *
 * @module @map-harness/spatial-accessibility/contract
 */
import { createHash } from 'node:crypto'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/** One durable accessibility run identity. */
export type RunId = Branded<'spatial.run-id'>

/** One submit operation identity derived from the owning session call. */
export type RunOperationRef = Branded<'spatial.run-operation-ref'>

/** Mint a fresh run id for one submitted spec. */
export function newRunId(): RunId {
  return brandString<RunId>(`run-${crypto.randomUUID()}`)
}

/** Derive one run submit operation's identity from its owning session call. */
export function runOperationRefOf(sessionId: string, sourceCallSeq: number): RunOperationRef {
  return brandString<RunOperationRef>(`op-${sha256Hex(`run:${sessionId}:${sourceCallSeq}`).slice(0, 24)}`)
}

/** sha256 hex of one string (shared digest helper for specs and networks). */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** WGS84 bounding box `[west, south, east, north]`. */
export type ExtentBox = readonly [number, number, number, number]

/** WGS84 lon/lat coordinate pair. */
export type LonLat = readonly [number, number]

/**
 * The result-statistics region: coverage numbers are reported for units
 * inside this area only. The map viewport never implies it.
 */
export interface StudyArea {
  readonly bbox: ExtentBox
}

/**
 * The data-collection region. Versioned resources are read against this
 * extent; data outside it is not fetched at all.
 */
export interface RetrievalExtent {
  readonly bbox: ExtentBox
}

/**
 * The analysis support region: the network connection, edge-effect, and
 * out-of-area service allowance the method needs. Facilities outside the
 * study area but inside this extent still serve study-area population;
 * facilities outside this extent are excluded with a diagnostic.
 */
export interface AnalysisSupportExtent {
  readonly bbox: ExtentBox
}

/**
 * Half-open observation window `[from, to)` in ISO-8601 with offset; the
 * population denominator must describe this window.
 */
export interface ObservationWindow {
  readonly from: string
  readonly to: string
}

/**
 * Half-open historical training/lookback window `[from, to)` that must end at
 * or before the observation window starts; lookback data never leaks forward.
 */
export interface TrainingWindow {
  readonly from: string
  readonly to: string
}

/** The travel modes the network method distinguishes; geometry buffers serve none of them. */
export type TravelMode = 'walk' | 'bike' | 'drive'

/** The fixed time slices the controlled provider prices; protocol constants, not configuration. */
export const TIME_SLICE_IDS = ['morning-peak', 'midday', 'evening-peak', 'night'] as const

/** One time-slice identity. */
export type TimeSliceId = typeof TIME_SLICE_IDS[number]

/**
 * Per-mode impedance: the maximum one-way network minutes a service area
 * covers before slice factors apply. Walk evidence requires walk-mode
 * impedance over a road network — a straight-line buffer is never a substitute.
 */
export interface Impedance {
  readonly travelMode: TravelMode
  readonly maxMinutes: number
}

/** One network obstruction: a blocked segment or a crossing delay in minutes. */
export interface BarrierSegment {
  readonly from: LonLat
  readonly to: LonLat
  readonly kind: 'blocked' | 'delay'
  /** Required for `delay`, forbidden for `blocked`; minutes added to crossing edges. */
  readonly delayMinutes?: number
}

/** One facility entrance: the network access point a facility serves from. */
export interface EntrancePoint {
  readonly facilityId: string
  readonly coordinates: LonLat
}

/** Facility capacity rule: per-facility served-population caps, assigned nearest-first. */
export interface CapacityRule {
  /** Facility id → maximum population it may serve per run; missing ids are uncapped. */
  readonly perFacility: Readonly<Record<string, number>>
  /** The assignment rule when several reachable facilities compete; fixed. */
  readonly assignment: 'nearest-first'
}

/**
 * The fixed boundary semantics of the method: out-of-study facilities inside
 * the support extent are retained; anything outside the support extent is
 * excluded with a diagnostic. Protocol constants, not configuration.
 */
export const BOUNDARY_RULE = {
  outsideStudyWithinSupport: 'retain',
  outsideSupport: 'exclude-with-diagnostic',
} as const

/** One user-given candidate facility added by a comparison option. */
export interface CandidateFacility {
  readonly id: string
  readonly coordinates: LonLat
  readonly capacity?: number
  readonly entrance?: LonLat
}

/** One user-given candidate option: added facilities plus its cost. */
export interface CandidateOption {
  readonly id: string
  readonly label: string
  readonly addFacilities: readonly CandidateFacility[]
  readonly cost: number
}

/** Comparison weights over coverage, equity, and cost; all zero is invalid. */
export interface ComparisonWeights {
  readonly coverage: number
  readonly equity: number
  readonly cost: number
}

/**
 * The versioned accessibility method input. Every field is plain JSON so the
 * spec round-trips through the durable run store unchanged.
 */
export interface AccessibilitySpec {
  /** Goal revision the spec was written against; stale runs never override a newer goal. */
  readonly goalRevision: number
  readonly studyArea: StudyArea
  readonly retrievalExtent: RetrievalExtent
  readonly analysisSupportExtent: AnalysisSupportExtent
  readonly observationWindow: ObservationWindow
  readonly trainingWindow?: TrainingWindow
  readonly impedance: Impedance
  readonly timeSlices: readonly TimeSliceId[]
  readonly barriers?: readonly BarrierSegment[]
  readonly entrances?: readonly EntrancePoint[]
  readonly capacity?: CapacityRule
  /** Exact population resource ref (`res-…@vN`); the denominator's immutable version. */
  readonly populationRef: string
  /** Population property name inside the resource schema. */
  readonly populationField: string
  /** Exact facility resource refs (`res-…@vN`), each resolved at submit time. */
  readonly facilityRefs: readonly string[]
  /** Road-network version identity the provider reported (recorded in evidence). */
  readonly networkRef: string
  /** User-given candidate options to compare against the status-quo baseline; at most {@link MAX_CANDIDATES}. */
  readonly candidates?: readonly CandidateOption[]
  /** Comparison weights; required when candidates are present. */
  readonly weights?: ComparisonWeights
  /** Total cost budget the candidate options must fit. */
  readonly costBudget?: number
  /** Method version the run was computed with. */
  readonly methodVersion: string
}

/** The method identity this package computes; a spec citing another version is refused. */
export const ACCESSIBILITY_METHOD_VERSION = 'p1-network-coverage@1'

/** Maximum user-given candidate options per comparison run. */
export const MAX_CANDIDATES = 8

/** Maximum network minutes one service area may cover. */
export const MAX_IMPEDANCE_MINUTES = 240

/** The structured validation issue codes the contract reports. */
export type SpecIssueCode =
  | 'spec-invalid'
  | 'bbox-invalid'
  | 'extent-nesting'
  | 'window-invalid'
  | 'training-window-invalid'
  | 'mode-unknown'
  | 'missing-impedance'
  | 'impedance-invalid'
  | 'slice-unknown'
  | 'barrier-invalid'
  | 'entrance-invalid'
  | 'capacity-invalid'
  | 'population-missing'
  | 'facility-missing'
  | 'ref-invalid'
  | 'candidate-invalid'
  | 'weights-invalid'
  | 'budget-invalid'
  | 'method-version-invalid'
  | 'goal-revision-invalid'

/** One structured reason an accessibility spec input was rejected. */
export interface SpecIssue {
  readonly code: SpecIssueCode
  readonly field: string
  readonly message: string
}

/** The catalog ref grammar the versioned inputs must satisfy (`res-…@vN`). */
const RESOURCE_REF_PATTERN = /^res-[A-Za-z0-9-]+@v[1-9][0-9]*$/

/** ISO-8601 timestamp with an explicit offset or `Z`. */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/** Narrow one JSON value to a string-keyed object. */
function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one extent box; returns the issue or `undefined`. */
function checkBbox(value: unknown, field: string): SpecIssue | undefined {
  if (!Array.isArray(value) || value.length !== 4 || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    return { code: 'bbox-invalid', field, message: 'bbox must be [west, south, east, north] finite numbers' }
  }
  // The length and element guards above fix all four positions.
  const west = value[0] as number
  const south = value[1] as number
  const east = value[2] as number
  const north = value[3] as number
  if (west < -180 || west > 180 || east < -180 || east > 180 || south < -90 || south > 90 || north < -90 || north > 90) {
    return { code: 'bbox-invalid', field, message: 'bbox coordinates out of the WGS84 range' }
  }
  if (west >= east || south >= north) {
    return { code: 'bbox-invalid', field, message: 'bbox must satisfy west < east and south < north' }
  }
  return undefined
}

/** Check `inner` box containment in `outer`. */
function containsBbox(outer: readonly unknown[], inner: readonly unknown[]): boolean {
  return (outer[0] as number) <= (inner[0] as number)
    && (outer[1] as number) <= (inner[1] as number)
    && (outer[2] as number) >= (inner[2] as number)
    && (outer[3] as number) >= (inner[3] as number)
}

/** Validate one lon/lat coordinate pair. */
function checkLonLat(value: unknown, field: string, code: SpecIssueCode): SpecIssue | undefined {
  if (!Array.isArray(value) || value.length !== 2
    || typeof value[0] !== 'number' || !Number.isFinite(value[0])
    || typeof value[1] !== 'number' || !Number.isFinite(value[1])
    || (value[0] as number) < -180 || (value[0] as number) > 180
    || (value[1] as number) < -90 || (value[1] as number) > 90) {
    return { code, field, message: 'expected a WGS84 [longitude, latitude] pair' }
  }
  return undefined
}

/**
 * Validate the raw accessibility spec input and return every structural
 * issue. The empty array means the input is a well-formed spec; resource
 * availability, network coverage, and applicability are runtime concerns the
 * run layer reports separately.
 * @param input - the untrusted spec value (for example raw tool arguments).
 * @returns the issues; empty when the input is structurally valid.
 */
export function validateAccessibilitySpec(input: unknown): readonly SpecIssue[] {
  const issues: SpecIssue[] = []
  if (!isRecord(input)) {
    return [{ code: 'spec-invalid', field: 'spec', message: 'spec must be an object' }]
  }
  const spec = input as { readonly [key: string]: unknown }

  // Goal revision and method version.
  if (typeof spec.goalRevision !== 'number' || !Number.isInteger(spec.goalRevision) || spec.goalRevision < 0) {
    issues.push({ code: 'goal-revision-invalid', field: 'goalRevision', message: 'goalRevision must be a non-negative integer' })
  }
  if (spec.methodVersion !== ACCESSIBILITY_METHOD_VERSION) {
    issues.push({ code: 'method-version-invalid', field: 'methodVersion', message: `methodVersion must be "${ACCESSIBILITY_METHOD_VERSION}"` })
  }

  // Extent boxes and their fixed nesting: study ⊆ retrieval ⊆ support.
  const extents: [string, unknown][] = [
    ['studyArea.bbox', isRecord(spec.studyArea) ? (spec.studyArea as { bbox?: unknown }).bbox : undefined],
    ['retrievalExtent.bbox', isRecord(spec.retrievalExtent) ? (spec.retrievalExtent as { bbox?: unknown }).bbox : undefined],
    ['analysisSupportExtent.bbox', isRecord(spec.analysisSupportExtent) ? (spec.analysisSupportExtent as { bbox?: unknown }).bbox : undefined],
  ]
  for (const [field, value] of extents) {
    const issue = checkBbox(value, field)
    if (issue !== undefined) issues.push(issue)
  }
  const [study, retrieval, support] = extents.map(([, value]) => value as readonly unknown[] | undefined)
  if (study !== undefined && retrieval !== undefined && !containsBbox(retrieval, study)) {
    issues.push({ code: 'extent-nesting', field: 'retrievalExtent', message: 'the retrieval extent must contain the study area' })
  }
  if (retrieval !== undefined && support !== undefined && !containsBbox(support, retrieval)) {
    issues.push({ code: 'extent-nesting', field: 'analysisSupportExtent', message: 'the analysis support extent must contain the retrieval extent' })
  }

  // Time windows: half-open, ordered; training ends before observation starts.
  const observation = isRecord(spec.observationWindow) ? spec.observationWindow as { from?: unknown; to?: unknown } : undefined
  if (observation === undefined
    || typeof observation.from !== 'string' || !ISO_TIMESTAMP_PATTERN.test(observation.from)
    || typeof observation.to !== 'string' || !ISO_TIMESTAMP_PATTERN.test(observation.to)
    || !(new Date(observation.from).getTime() < new Date(observation.to).getTime())) {
    issues.push({ code: 'window-invalid', field: 'observationWindow', message: 'observationWindow must be an ISO [from, to) pair with from < to' })
  } else if (spec.trainingWindow !== undefined) {
    const training = spec.trainingWindow as { from?: unknown; to?: unknown }
    if (!isRecord(training)
      || typeof training.from !== 'string' || !ISO_TIMESTAMP_PATTERN.test(training.from)
      || typeof training.to !== 'string' || !ISO_TIMESTAMP_PATTERN.test(training.to)
      || !(new Date(training.to).getTime() <= new Date(observation.from).getTime())) {
      issues.push({ code: 'training-window-invalid', field: 'trainingWindow', message: 'trainingWindow must end at or before the observation window starts' })
    }
  }

  // Impedance: present, mode known, minutes bounded.
  const impedance = isRecord(spec.impedance) ? spec.impedance as { travelMode?: unknown; maxMinutes?: unknown } : undefined
  if (impedance === undefined) {
    issues.push({ code: 'missing-impedance', field: 'impedance', message: 'the method requires explicit impedance (travelMode + maxMinutes)' })
  } else {
    if (typeof impedance.travelMode !== 'string' || !['walk', 'bike', 'drive'].includes(impedance.travelMode)) {
      issues.push({ code: 'mode-unknown', field: 'impedance.travelMode', message: 'travelMode must be walk, bike, or drive' })
    }
    if (typeof impedance.maxMinutes !== 'number' || !Number.isFinite(impedance.maxMinutes)
      || impedance.maxMinutes <= 0 || impedance.maxMinutes > MAX_IMPEDANCE_MINUTES) {
      issues.push({ code: 'impedance-invalid', field: 'impedance.maxMinutes', message: `maxMinutes must be a positive number up to ${MAX_IMPEDANCE_MINUTES}` })
    }
  }

  // Time slices: non-empty, known ids.
  if (!Array.isArray(spec.timeSlices) || spec.timeSlices.length === 0
    || !spec.timeSlices.every(slice => typeof slice === 'string' && (TIME_SLICE_IDS as readonly string[]).includes(slice))) {
    issues.push({ code: 'slice-unknown', field: 'timeSlices', message: `timeSlices must be a non-empty subset of ${TIME_SLICE_IDS.join(', ')}` })
  }

  // Barriers: blocked carries no delay; delay carries positive minutes.
  if (spec.barriers !== undefined) {
    if (!Array.isArray(spec.barriers)) {
      issues.push({ code: 'barrier-invalid', field: 'barriers', message: 'barriers must be an array' })
    } else {
      for (const [index, barrier] of spec.barriers.entries()) {
        const entry = barrier as { from?: unknown; to?: unknown; kind?: unknown; delayMinutes?: unknown }
        const field = `barriers[${index}]`
        if (!isRecord(barrier)) {
          issues.push({ code: 'barrier-invalid', field, message: 'each barrier must be an object' })
          continue
        }
        const endpoints = checkLonLat(entry.from, `${field}.from`, 'barrier-invalid') ?? checkLonLat(entry.to, `${field}.to`, 'barrier-invalid')
        if (endpoints !== undefined) issues.push(endpoints)
        if (entry.kind !== 'blocked' && entry.kind !== 'delay') {
          issues.push({ code: 'barrier-invalid', field: `${field}.kind`, message: 'kind must be blocked or delay' })
        } else if (entry.kind === 'blocked' && entry.delayMinutes !== undefined) {
          issues.push({ code: 'barrier-invalid', field: `${field}.delayMinutes`, message: 'a blocked barrier takes no delayMinutes' })
        } else if (entry.kind === 'delay' && (typeof entry.delayMinutes !== 'number' || !Number.isFinite(entry.delayMinutes) || entry.delayMinutes <= 0)) {
          issues.push({ code: 'barrier-invalid', field: `${field}.delayMinutes`, message: 'a delay barrier requires positive delayMinutes' })
        }
      }
    }
  }

  // Entrances: facility id + coordinates.
  if (spec.entrances !== undefined) {
    if (!Array.isArray(spec.entrances)) {
      issues.push({ code: 'entrance-invalid', field: 'entrances', message: 'entrances must be an array' })
    } else {
      for (const [index, entrance] of spec.entrances.entries()) {
        const entry = entrance as { facilityId?: unknown; coordinates?: unknown }
        const field = `entrances[${index}]`
        if (!isRecord(entrance) || typeof entry.facilityId !== 'string' || entry.facilityId.length === 0) {
          issues.push({ code: 'entrance-invalid', field: `${field}.facilityId`, message: 'each entrance needs a non-empty facilityId' })
          continue
        }
        const coordinates = checkLonLat(entry.coordinates, `${field}.coordinates`, 'entrance-invalid')
        if (coordinates !== undefined) issues.push(coordinates)
      }
    }
  }

  // Capacity: per-facility non-negative caps.
  if (spec.capacity !== undefined) {
    const capacity = spec.capacity as { perFacility?: unknown; assignment?: unknown }
    if (!isRecord(capacity) || !isRecord(capacity.perFacility) || capacity.assignment !== 'nearest-first') {
      issues.push({ code: 'capacity-invalid', field: 'capacity', message: 'capacity must carry perFacility caps and the nearest-first assignment rule' })
    } else {
      for (const [facilityId, cap] of Object.entries(capacity.perFacility)) {
        if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) {
          issues.push({ code: 'capacity-invalid', field: `capacity.perFacility.${facilityId}`, message: 'each capacity must be a non-negative finite number' })
        }
      }
    }
  }

  // Versioned refs.
  if (typeof spec.populationRef !== 'string' || !RESOURCE_REF_PATTERN.test(spec.populationRef)) {
    issues.push({ code: 'ref-invalid', field: 'populationRef', message: 'populationRef must be an exact resource ref res-…@vN' })
  }
  if (typeof spec.populationField !== 'string' || spec.populationField.length === 0) {
    issues.push({ code: 'population-missing', field: 'populationField', message: 'populationField names the denominator property' })
  }
  if (!Array.isArray(spec.facilityRefs) || spec.facilityRefs.length === 0
    || !spec.facilityRefs.every(ref => typeof ref === 'string' && RESOURCE_REF_PATTERN.test(ref))) {
    issues.push({ code: 'facility-missing', field: 'facilityRefs', message: 'facilityRefs must list at least one exact resource ref res-…@vN' })
  }

  // Candidates, weights, and budget.
  if (spec.candidates !== undefined) {
    if (!Array.isArray(spec.candidates)) {
      issues.push({ code: 'candidate-invalid', field: 'candidates', message: 'candidates must be an array' })
    } else {
      if (spec.candidates.length > MAX_CANDIDATES) {
        issues.push({ code: 'candidate-invalid', field: 'candidates', message: `at most ${MAX_CANDIDATES} candidate options are comparable` })
      }
      const seen = new Set<string>()
      for (const [index, candidate] of spec.candidates.entries()) {
        const entry = candidate as { id?: unknown; label?: unknown; addFacilities?: unknown; cost?: unknown }
        const field = `candidates[${index}]`
        if (!isRecord(candidate) || typeof entry.id !== 'string' || entry.id.length === 0 || seen.has(entry.id)) {
          issues.push({ code: 'candidate-invalid', field: `${field}.id`, message: 'candidate ids must be non-empty and unique' })
          continue
        }
        seen.add(entry.id)
        if (typeof entry.label !== 'string' || entry.label.length === 0) {
          issues.push({ code: 'candidate-invalid', field: `${field}.label`, message: 'each candidate needs a label' })
        }
        if (!Array.isArray(entry.addFacilities) || entry.addFacilities.length === 0) {
          issues.push({ code: 'candidate-invalid', field: `${field}.addFacilities`, message: 'each candidate adds at least one facility' })
        } else {
          for (const [facilityIndex, facility] of entry.addFacilities.entries()) {
            const facilityEntry = facility as { id?: unknown; coordinates?: unknown; capacity?: unknown; entrance?: unknown }
            const facilityField = `${field}.addFacilities[${facilityIndex}]`
            if (!isRecord(facility) || typeof facilityEntry.id !== 'string' || facilityEntry.id.length === 0) {
              issues.push({ code: 'candidate-invalid', field: `${facilityField}.id`, message: 'each candidate facility needs a non-empty id' })
              continue
            }
            const coordinates = checkLonLat(facilityEntry.coordinates, `${facilityField}.coordinates`, 'candidate-invalid')
            if (coordinates !== undefined) issues.push(coordinates)
            if (facilityEntry.capacity !== undefined && (typeof facilityEntry.capacity !== 'number' || !Number.isFinite(facilityEntry.capacity) || facilityEntry.capacity < 0)) {
              issues.push({ code: 'candidate-invalid', field: `${facilityField}.capacity`, message: 'candidate capacity must be a non-negative number' })
            }
            if (facilityEntry.entrance !== undefined) {
              const entrance = checkLonLat(facilityEntry.entrance, `${facilityField}.entrance`, 'candidate-invalid')
              if (entrance !== undefined) issues.push(entrance)
            }
          }
        }
        if (typeof entry.cost !== 'number' || !Number.isFinite(entry.cost) || entry.cost < 0) {
          issues.push({ code: 'candidate-invalid', field: `${field}.cost`, message: 'candidate cost must be a non-negative finite number' })
        }
      }
      if (spec.weights === undefined) {
        issues.push({ code: 'weights-invalid', field: 'weights', message: 'comparing candidates requires explicit weights' })
      } else {
        const weights = spec.weights as { coverage?: unknown; equity?: unknown; cost?: unknown }
        const values = [weights.coverage, weights.equity, weights.cost]
        if (!values.every(weight => typeof weight === 'number' && Number.isFinite(weight) && weight >= 0) || !values.some(weight => (weight as number) > 0)) {
          issues.push({ code: 'weights-invalid', field: 'weights', message: 'weights must be non-negative finite numbers with at least one positive' })
        }
      }
    }
  }
  if (spec.costBudget !== undefined && (typeof spec.costBudget !== 'number' || !Number.isFinite(spec.costBudget) || spec.costBudget < 0)) {
    issues.push({ code: 'budget-invalid', field: 'costBudget', message: 'costBudget must be a non-negative finite number' })
  }
  if (spec.networkRef !== undefined && (typeof spec.networkRef !== 'string' || spec.networkRef.length === 0)) {
    issues.push({ code: 'ref-invalid', field: 'networkRef', message: 'networkRef must be the provider network version identity' })
  }

  return issues
}

/**
 * Canonical JSON of one value: object keys sorted recursively so a digest is
 * independent of key order.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The canonical request digest of one spec: sha256 over the key-sorted JSON.
 * The same operationRef with a different digest is a conflict, never a new
 * operation; the digest is a consistency check, not the identity.
 * @param spec - the validated spec object.
 * @returns the hex digest.
 */
export function specDigestOf(spec: AccessibilitySpec): string {
  return sha256Hex(canonicalJson(spec))
}

/**
 * A straight-line (Euclidean) proximity exploration. Geometry buffers answer
 * "what is near" — never walk, bike, or drive accessibility. The type carries
 * the marker structurally: the `exploratory` literal is `true` and the
 * limitation text is mandatory, so a straight-line result cannot be shaped
 * into network evidence.
 */
export interface StraightLineExploration {
  readonly kind: 'exploratory-straight-line'
  readonly exploratory: true
  readonly originQuestion: string
  readonly limitations: readonly ['straight-line distance is geometric proximity only; it is not walk/bike/drive accessibility evidence']
}

/**
 * Build the explicit straight-line exploration record for an unresolved
 * proximity question. The original travel-mode question stays unresolved:
 * consuming this record as network evidence is refused.
 * @param originQuestion - the original question text the exploration defers.
 * @returns the marked exploration record.
 */
export function straightLineExploration(originQuestion: string): StraightLineExploration {
  return {
    kind: 'exploratory-straight-line',
    exploratory: true,
    originQuestion,
    limitations: ['straight-line distance is geometric proximity only; it is not walk/bike/drive accessibility evidence'],
  }
}

/**
 * Whether one analysis outcome may be cited as network accessibility
 * evidence. Straight-line explorations are refused, keeping the original
 * travel-mode question unresolved instead of silently re-answered.
 * @param outcome - a coverage outcome or a straight-line exploration.
 * @returns `false` for explorations; `true` for network coverage outcomes.
 */
export function usableAsNetworkEvidence(outcome: { readonly kind: string }): boolean {
  return outcome.kind !== 'exploratory-straight-line'
}
