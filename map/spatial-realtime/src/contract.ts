/**
 * The realtime stream contract (`spatial-realtime@1`): the fully-specified,
 * versioned binding a stream workbench carries — the three clocks it never
 * conflates (event time from the source domain, ingest time assigned at
 * admission, process time assigned per advance), event-id deduplication for
 * at-least-once sources, the watermark and tumbling-window policy with
 * bounded late-event revisions, and the intake bounds that keep memory and
 * per-advance work finite.
 *
 * The contract is deliberate about what it refuses: a workbench without an
 * explicit window size or allowed lateness never opens, because watermark
 * semantics decide when a window's aggregate becomes a conclusion; a scenario
 * beyond the wire bounds refuses instead of being silently truncated.
 * Validation accepts the raw JSON-shaped input the tool layer forwards and
 * returns typed issues instead of throwing, so a rejected spec lists every
 * reason rather than the first.
 *
 * @module @map-harness/spatial-realtime/contract
 */
import { createHash } from 'node:crypto'

/**
 * The method identity this package computes; a spec citing another version is
 * refused. The version pins every rule this package ships: the watermark
 * `maxEventTime − allowedLateness`, tumbling windows keyed on absolute event
 * time, first-seen event-id deduplication, late events revising a closed
 * window as a new append-only revision (never mutating the old one), and the
 * bounded intake/backpressure/quota policy.
 */
export const REALTIME_METHOD_VERSION = 'spatial-realtime@1'

/** Tumbling window size bounds, milliseconds. */
export const MIN_WINDOW_SIZE_MS = 1
export const MAX_WINDOW_SIZE_MS = 86_400_000 * 366

/** Allowed-lateness bound, milliseconds (0 = an event-time-ordered source). */
export const MAX_ALLOWED_LATENESS_MS = MAX_WINDOW_SIZE_MS

/** Deduplication window (distinct event ids retained) bounds. */
export const MIN_DEDUP_CAPACITY = 1
export const MAX_DEDUP_CAPACITY = 65_536

/** Intake buffer (admitted, unprocessed events) bounds. */
export const MIN_BUFFER_CAPACITY = 1
export const MAX_BUFFER_CAPACITY = 65_536

/** Processing quota per advance (the slow-consumer bound) bounds. */
export const MIN_QUOTA_PER_ADVANCE = 1
export const MAX_QUOTA_PER_ADVANCE = 65_536

/** Open-window state bound: windows opened but not yet closed by the watermark. */
export const MIN_MAX_OPEN_WINDOWS = 1
export const MAX_MAX_OPEN_WINDOWS = 4_096

/** Per-window revision-ledger bound (v1 plus bounded late revisions). */
export const MIN_REVISIONS_PER_WINDOW = 1
export const MAX_REVISIONS_PER_WINDOW = 64

/** Scenario wire bounds: one scenario carries at most this many batches… */
export const MAX_SCENARIO_BATCHES = 256
/** …and one batch at most this many wire events. */
export const MAX_SCENARIO_BATCH_EVENTS = 256

/** Gap windows materialized per advance; a larger gap span stays pending for later advances. */
export const MAX_GAP_WINDOWS_PER_ADVANCE = 1_024

/** One wire event as the source releases it. Event time is source-domain time; ingest/process time are assigned by the runtime. */
export interface StreamEvent {
  /** Source-assigned unique id; the dedup key for at-least-once delivery. */
  readonly eventId: string
  /** Event time, milliseconds since the epoch, in the source's domain clock. */
  readonly eventTimeMs: number
  /** WGS84 longitude the event observation was taken at. */
  readonly lon: number
  /** WGS84 latitude the event observation was taken at. */
  readonly lat: number
  /** The numeric measure this stream aggregates. */
  readonly value: number
}

/** One controlled-source batch: the wire events released in one advance step, in wire order. */
export interface StreamScenarioBatch {
  /**
   * When true the source is disconnected for this batch: no wire event is
   * released, the batch is counted as offline, and the next batch models the
   * reconnect (at-least-once redelivery shows up as duplicate ids).
   */
  readonly offline?: boolean
  /** Wire-order events; duplicates and out-of-order arrival are modeled here. */
  readonly events: readonly StreamEvent[]
}

/** The controlled scenario a workbench replays deterministically. */
export interface StreamScenario {
  readonly batches: readonly StreamScenarioBatch[]
}

/** The fully-resolved, versioned stream workbench input. Every default the tool applies is written here. */
export interface StreamSpec {
  readonly methodVersion: typeof REALTIME_METHOD_VERSION
  /** Tumbling window size, milliseconds. */
  readonly windowSizeMs: number
  /** Allowed lateness, milliseconds; the watermark trails max event time by this much. */
  readonly allowedLatenessMs: number
  /** Distinct event ids the dedup window retains (FIFO eviction at capacity). */
  readonly dedupCapacity: number
  /** Admitted-but-unprocessed events the intake buffer holds; beyond it the source is held back. */
  readonly bufferCapacity: number
  /** Events processed per advance; the slow-consumer quota that turns surplus into backpressure. */
  readonly maxEventsPerAdvance: number
  /** Open-window states retained; beyond it a new window key refuses the advance loudly. */
  readonly maxOpenWindows: number
  /** Revisions retained per window (initial close plus bounded late revisions). */
  readonly maxRevisionsPerWindow: number
}

/** One structural spec or scenario issue: which field, a stable code, and why. */
export interface StreamIssue {
  readonly field: string
  readonly code: StreamIssueCode
  readonly message: string
}

/**
 * The additive totals several advance summaries accumulate into — the
 * bounded rollup one tool call reports after advancing multiple steps.
 */
export interface AdvanceTotals {
  readonly advancedBatches: number
  readonly admitted: number
  readonly processed: number
  readonly duplicatesDropped: number
  readonly tooLateDropped: number
  readonly heldByBackpressure: number
  readonly offlineBatches: number
  readonly windowsClosed: number
  readonly windowsRevised: number
  readonly gapsClosed: number
  readonly evictedClosedWindows: number
}

/** The stable validation codes a StreamSpec or scenario rejection carries. */
export type StreamIssueCode =
  | 'method-version'
  | 'spec-required'
  | 'window-size-bound'
  | 'lateness-bound'
  | 'dedup-capacity-bound'
  | 'buffer-capacity-bound'
  | 'quota-bound'
  | 'open-windows-bound'
  | 'revisions-bound'
  | 'scenario-required'
  | 'scenario-batches-bound'
  | 'scenario-batch-events-bound'
  | 'event-invalid'

/**
 * Validate one raw StreamSpec-shaped value and return every structural issue.
 * A spec with zero issues is fully determined: no runtime default is applied
 * after this boundary.
 * @param spec - the raw spec value.
 * @returns the issue list; empty means the spec may run.
 */
export function validateStreamSpec(spec: unknown): StreamIssue[] {
  const issues: StreamIssue[] = []
  const record = spec as Partial<StreamSpec> | null
  if (typeof record !== 'object' || record === null) {
    return [{ field: 'spec', code: 'spec-required', message: 'the stream spec must be an object' }]
  }
  if (record.methodVersion !== REALTIME_METHOD_VERSION) {
    issues.push({ field: 'methodVersion', code: 'method-version', message: `spec must cite method version ${REALTIME_METHOD_VERSION}` })
  }
  boundCheck(issues, 'windowSizeMs', record.windowSizeMs, MIN_WINDOW_SIZE_MS, MAX_WINDOW_SIZE_MS, 'window-size-bound')
  boundCheck(issues, 'allowedLatenessMs', record.allowedLatenessMs, 0, MAX_ALLOWED_LATENESS_MS, 'lateness-bound')
  boundCheck(issues, 'dedupCapacity', record.dedupCapacity, MIN_DEDUP_CAPACITY, MAX_DEDUP_CAPACITY, 'dedup-capacity-bound')
  boundCheck(issues, 'bufferCapacity', record.bufferCapacity, MIN_BUFFER_CAPACITY, MAX_BUFFER_CAPACITY, 'buffer-capacity-bound')
  boundCheck(issues, 'maxEventsPerAdvance', record.maxEventsPerAdvance, MIN_QUOTA_PER_ADVANCE, MAX_QUOTA_PER_ADVANCE, 'quota-bound')
  boundCheck(issues, 'maxOpenWindows', record.maxOpenWindows, MIN_MAX_OPEN_WINDOWS, MAX_MAX_OPEN_WINDOWS, 'open-windows-bound')
  boundCheck(issues, 'maxRevisionsPerWindow', record.maxRevisionsPerWindow, MIN_REVISIONS_PER_WINDOW, MAX_REVISIONS_PER_WINDOW, 'revisions-bound')
  return issues
}

/** Validate one numeric field against an inclusive bound, recording one issue per violation. */
function boundCheck(
  issues: StreamIssue[],
  field: string,
  value: number | undefined,
  min: number,
  max: number,
  code: StreamIssueCode,
): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    issues.push({ field, code, message: `${field} must be a finite number in [${min}, ${max}]` })
  }
}

/**
 * The canonical wire fixtures every stream suite replays: batch 1 carries an
 * at-least-once duplicate, batch 2 arrives out of event-time order, batch 3
 * delivers an event into an already-closed window, batch 4 is the
 * disconnect (an offline source releases nothing; the next batch models the
 * reconnect). The event times line up with the 10 s window / 5 s lateness
 * spec the tests resolve, so the same fixture drives the contract, runtime,
 * checkpoint, and tool suites.
 */
export const WINDOW_EVENT_FIXTURES: readonly StreamScenarioBatch[] = [
  {
    events: [
      { eventId: 'evt-a-1', eventTimeMs: 1_000, lon: 116.4, lat: 39.9, value: 3 },
      { eventId: 'evt-a-1', eventTimeMs: 1_000, lon: 116.4, lat: 39.9, value: 3 },
    ],
  },
  {
    events: [
      { eventId: 'evt-b-2', eventTimeMs: 25_000, lon: 116.41, lat: 39.91, value: 4 },
      { eventId: 'evt-b-1', eventTimeMs: 11_000, lon: 116.4, lat: 39.9, value: 5 },
    ],
  },
  {
    events: [
      { eventId: 'evt-late-1', eventTimeMs: 11_500, lon: 116.42, lat: 39.92, value: 7 },
    ],
  },
  {
    offline: true,
    events: [],
  },
] as const

/**
 * Parse one scenario GeoJSON FeatureCollection — the versioned resource form
 * a controlled source binds — into a {@link StreamScenario}. Each event is a
 * Point feature whose properties carry `batch` (nonnegative index), `event_id`,
 * `event_time_ms`, and `value`; the Point coordinates are the WGS84 lon/lat.
 * A batch whose features carry `offline: true` (those features carry no event
 * fields) is the disconnected source; batch order is the numeric batch index
 * and wire order inside a batch is feature order.
 * @param collection - the raw FeatureCollection value.
 * @returns the parsed scenario, or the issue list naming every defect.
 */
export function parseScenarioCollection(
  collection: unknown,
): { status: 'ok'; scenario: StreamScenario } | { status: 'refused'; issues: StreamIssue[] } {
  const issues: StreamIssue[] = []
  if (typeof collection !== 'object' || collection === null
    || (collection as { type?: unknown }).type !== 'FeatureCollection'
    || !Array.isArray((collection as { features?: unknown }).features)) {
    return { status: 'refused', issues: [{ field: 'collection', code: 'scenario-required', message: 'a scenario resource is a GeoJSON FeatureCollection' }] }
  }
  const features = (collection as { features: unknown[] }).features
  if (features.length === 0) {
    return { status: 'refused', issues: [{ field: 'collection.features', code: 'scenario-required', message: 'a scenario resource carries at least one feature' }] }
  }
  const batches = new Map<number, StreamScenarioBatch>()
  const offlineBatches = new Set<number>()
  for (const [index, feature] of features.entries()) {
    const record = feature as {
      geometry?: { type?: unknown; coordinates?: unknown } | null
      properties?: Record<string, unknown> | null
    }
    const properties = record.properties
    if (typeof properties !== 'object' || properties === null
      || !Number.isInteger(properties.batch) || (properties.batch as number) < 0) {
      issues.push({ field: `features[${index}].properties.batch`, code: 'event-invalid', message: 'every feature carries a nonnegative integer batch index' })
      break
    }
    const batch = properties.batch as number
    if (properties.offline === true) {
      offlineBatches.add(batch)
      continue
    }
    const geometry = record.geometry
    if (typeof geometry !== 'object' || geometry === null || geometry.type !== 'Point'
      || !Array.isArray(geometry.coordinates)) {
      issues.push({ field: `features[${index}].geometry`, code: 'event-invalid', message: 'an event feature is a Point carrying [lon, lat]' })
      break
    }
    const [lon, lat] = geometry.coordinates as unknown[]
    const event: StreamEvent = {
      eventId: typeof properties.event_id === 'string' ? properties.event_id : '',
      eventTimeMs: typeof properties.event_time_ms === 'number' ? properties.event_time_ms : Number.NaN,
      lon: typeof lon === 'number' ? lon : Number.NaN,
      lat: typeof lat === 'number' ? lat : Number.NaN,
      value: typeof properties.value === 'number' ? properties.value : Number.NaN,
    }
    const problem = eventProblem(event)
    if (problem !== null) {
      issues.push({ field: `features[${index}]`, code: 'event-invalid', message: problem })
      break
    }
    const existing = batches.get(batch)
    if (existing === undefined) batches.set(batch, { events: [event] })
    else (existing.events as StreamEvent[]).push(event)
  }
  if (issues.length > 0) return { status: 'refused', issues }
  // An offline-only batch (no event features) still counts as a batch.
  const ordered = [...new Set([...batches.keys(), ...offlineBatches])].sort((left, right) => left - right)
  if (ordered.length === 0) {
    return { status: 'refused', issues: [{ field: 'collection.features', code: 'scenario-required', message: 'a scenario resource carries at least one event or offline batch' }] }
  }
  // Contiguous batch indices 0..n-1: a skipped index is a source sequencing
  // defect, not an implicit gap — refuse it loudly.
  for (const [position, batch] of ordered.entries()) {
    if (batch !== position) {
      return { status: 'refused', issues: [{ field: `features.batch`, code: 'scenario-required', message: `batch indices must be contiguous from 0; index ${position} is missing` }] }
    }
  }
  const scenario: StreamScenario = {
    batches: ordered.map(batch => {
      if (batches.has(batch)) {
        const parsed = batches.get(batch) as StreamScenarioBatch
        return offlineBatches.has(batch) ? { offline: true, events: parsed.events } : parsed
      }
      return { offline: true, events: [] }
    }),
  }
  const wireIssues = validateStreamScenario(scenario)
  if (wireIssues.length > 0) return { status: 'refused', issues: wireIssues }
  return { status: 'ok', scenario }
}

/**
 * Validate one raw StreamScenario-shaped value. The scenario is wire input:
 * every event is checked field by field, and the wire bounds (batch count,
 * batch size) refuse oversized inputs instead of truncating them.
 * @param scenario - the raw scenario value.
 * @returns the issue list; empty means the scenario may run.
 */
export function validateStreamScenario(scenario: unknown): StreamIssue[] {
  const issues: StreamIssue[] = []
  if (typeof scenario !== 'object' || scenario === null || !Array.isArray((scenario as StreamScenario).batches)) {
    return [{ field: 'scenario', code: 'scenario-required', message: 'a scenario with a batches array is required' }]
  }
  const { batches } = scenario as StreamScenario
  if (batches.length < 1 || batches.length > MAX_SCENARIO_BATCHES) {
    issues.push({ field: 'scenario.batches', code: 'scenario-batches-bound', message: `a scenario carries 1..${MAX_SCENARIO_BATCHES} batches` })
    return issues
  }
  for (const [index, batch] of batches.entries()) {
    if (typeof batch !== 'object' || batch === null || !Array.isArray(batch.events)) {
      issues.push({ field: `scenario.batches[${index}]`, code: 'scenario-required', message: 'each batch is an object with an events array' })
      return issues
    }
    if (batch.events.length > MAX_SCENARIO_BATCH_EVENTS) {
      issues.push({
        field: `scenario.batches[${index}].events`,
        code: 'scenario-batch-events-bound',
        message: `each batch carries at most ${MAX_SCENARIO_BATCH_EVENTS} events`,
      })
      return issues
    }
    for (const [at, event] of batch.events.entries()) {
      const problem = eventProblem(event)
      if (problem !== null) {
        issues.push({ field: `scenario.batches[${index}].events[${at}]`, code: 'event-invalid', message: problem })
        break
      }
    }
    if (issues.length > 0) break
  }
  return issues
}

/** One human-readable reason a wire event is invalid, or `null` when it is well-formed. */
export function eventProblem(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) return 'an event must be an object'
  const candidate = event as Partial<StreamEvent>
  if (typeof candidate.eventId !== 'string' || candidate.eventId.length === 0 || candidate.eventId.length > 128) {
    return 'eventId must be a nonempty string of at most 128 characters'
  }
  if (typeof candidate.eventTimeMs !== 'number' || !Number.isFinite(candidate.eventTimeMs)) {
    return 'eventTimeMs must be a finite number'
  }
  if (typeof candidate.lon !== 'number' || !Number.isFinite(candidate.lon) || candidate.lon < -180 || candidate.lon > 180
    || typeof candidate.lat !== 'number' || !Number.isFinite(candidate.lat) || candidate.lat < -90 || candidate.lat > 90) {
    return 'lon/lat must be finite WGS84 coordinates'
  }
  if (typeof candidate.value !== 'number' || !Number.isFinite(candidate.value)) {
    return 'value must be a finite number'
  }
  return null
}

/** The per-window aggregate one window carries; `mean` values are exact sums divided by count. */
export interface WindowAggregate {
  readonly count: number
  readonly sum: number
  readonly min: number
  readonly max: number
  readonly mean: number
  /** Mean WGS84 longitude of the window's events (the display anchor). */
  readonly meanLon: number
  /** Mean WGS84 latitude of the window's events (the display anchor). */
  readonly meanLat: number
}

/** The window lifecycle statuses. `empty` is a materialized data gap — never interpolated. */
export type WindowStatus = 'open' | 'closed' | 'revised' | 'empty'

/** One immutable revision of one window: appended by the watermark close or a late event, never mutated. */
export interface WindowRevision {
  /** 1-based revision number within the window. */
  readonly revision: number
  /** Content digest pinning exactly this revision's aggregate (the export/report identity). */
  readonly digest: string
  readonly aggregate: WindowAggregate
}

/** One window's bounded state: identity, lifecycle status, and the append-only revision ledger. */
export interface WindowState {
  /** Window start, milliseconds; the window key with `endMs` (tumbling: `endMs = startMs + windowSizeMs`). */
  readonly startMs: number
  readonly endMs: number
  readonly status: WindowStatus
  /** Append-only revisions; the last entry is the window's current conclusion. */
  readonly revisions: readonly WindowRevision[]
}

/**
 * The canonical digest of one window revision — the identity artifacts and
 * exports cite, so two materializations of the same window content are
 * recognizable and a changed aggregate is a different, equally honest revision.
 * @param startMs - window start, milliseconds.
 * @param endMs - window end, milliseconds.
 * @param revision - 1-based revision number within the window.
 * @param aggregate - the revision's aggregate.
 * @returns a sha256 hex digest of the canonical form.
 */
export function windowRevisionDigestOf(startMs: number, endMs: number, revision: number, aggregate: WindowAggregate): string {
  return createHash('sha256')
    .update(JSON.stringify({ startMs, endMs, revision, aggregate }), 'utf8')
    .digest('hex')
}
