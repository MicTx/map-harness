/**
 * The pull-based stream runtime: a deterministic state machine over one
 * controlled scenario. Each {@link StreamRuntime.advance} admits at most one
 * scenario batch into a bounded intake buffer (the backpressure point — a
 * full buffer holds the source back instead of growing), processes up to the
 * quota (the slow-consumer bound), maintains the event-time watermark
 * `maxEventTime − allowedLateness`, applies first-seen event-id dedup
 * (at-least-once redelivery), and closes tumbling windows whose end the
 * watermark passed — closing a window appends revision 1; a later, late
 * event appends a NEW revision and never mutates the old one.
 *
 * There is no per-event callback and no background thread: the only output
 * of an advance is one bounded summary, so a consumer (the model, the map)
 * is woken once per advance, never per event. Wall-clock time never enters
 * the state machine — event, ingest, and process times are caller-supplied,
 * which keeps every run and every test deterministic.
 *
 * @module @map-harness/spatial-realtime/runtime
 */
import {
  MAX_GAP_WINDOWS_PER_ADVANCE,
  MAX_SCENARIO_BATCH_EVENTS,
  REALTIME_METHOD_VERSION,
  eventProblem,
  windowRevisionDigestOf,
  type AdvanceTotals,
  type StreamEvent,
  type StreamIssue,
  type StreamScenario,
  type StreamScenarioBatch,
  type StreamSpec,
  type WindowAggregate,
  type WindowRevision,
  type WindowState,
  type WindowStatus,
} from './contract.ts'
import { validateStreamScenario, validateStreamSpec } from './contract.ts'

/** Retained closed windows per live state (oldest evicted when exceeded); bounded retention, session log keeps the history. */
export const MAX_RETAINED_CLOSED_WINDOWS = 64

/** Materialization entries (export digest → published artifact ref) retained per workbench. */
export const MAX_MATERIALIZED_ENTRIES = 64

/** Why one runtime operation refused. */
export type StreamRuntimeCode =
  | 'spec-invalid'
  | 'scenario-invalid'
  | 'checkpoint-invalid'
  | 'scenario-append-invalid'

/** One runtime construction or resume failure with a stable code. */
export class StreamRuntimeError extends Error {
  /** Machine-readable refusal code. */
  readonly code: StreamRuntimeCode
  constructor(code: StreamRuntimeCode, message: string) {
    super(`${code}: ${message}`)
    this.code = code
  }
}

/** The bounded summary of one advance — the only thing an advance reports, so no consumer wakes per event. */
export interface AdvanceSummary {
  /** Scenario batches consumed by this advance (offline batches included). */
  readonly advancedBatches: number
  /** Events admitted into the intake buffer (duplicates dropped at admission do not count). */
  readonly admitted: number
  /** Events applied into window aggregates. */
  readonly processed: number
  /** Re-delivered event ids dropped by dedup. */
  readonly duplicatesDropped: number
  /** Events later than the bounded revision ledger retains; dropped and counted, never silently ignored. */
  readonly tooLateDropped: number
  /** Events the full intake buffer refused; they remain at the source for a later advance. */
  readonly heldByBackpressure: number
  /** Batches whose source was disconnected (no wire events released). */
  readonly offlineBatches: number
  /** Whether the per-advance processing quota truncated this advance (surplus stays buffered). */
  readonly rateLimited: boolean
  /** Whether the open-window bound stopped processing mid-advance (the event stays buffered). */
  readonly openWindowBoundReached: boolean
  /** Windows the watermark closed this advance. */
  readonly windowsClosed: number
  /** Windows a late event revised this advance. */
  readonly windowsRevised: number
  /** Data-gap windows materialized as `empty` this advance. */
  readonly gapsClosed: number
  /** Gap windows still pending materialization (the per-advance gap cap held some back). */
  readonly pendingGapWindows: number
  /** Live windows evicted by the bounded closed-window retention this advance. */
  readonly evictedClosedWindows: number
  /** Watermark after the advance, milliseconds; `null` before the first admitted event. */
  readonly watermarkMs: number | null
  /** Whether the workbench is paused (nothing was admitted or processed). */
  readonly paused: boolean
}

/** An all-zero totals accumulator over advance summaries. */
export function emptyAdvanceTotals(): AdvanceTotals {
  return {
    advancedBatches: 0,
    admitted: 0,
    processed: 0,
    duplicatesDropped: 0,
    tooLateDropped: 0,
    heldByBackpressure: 0,
    offlineBatches: 0,
    windowsClosed: 0,
    windowsRevised: 0,
    gapsClosed: 0,
    evictedClosedWindows: 0,
  }
}

/** Accumulate one advance summary into totals (counters sum; flags OR). */
export function addAdvanceTotals(totals: AdvanceTotals, summary: AdvanceSummary): AdvanceTotals {
  return {
    advancedBatches: totals.advancedBatches + summary.advancedBatches,
    admitted: totals.admitted + summary.admitted,
    processed: totals.processed + summary.processed,
    duplicatesDropped: totals.duplicatesDropped + summary.duplicatesDropped,
    tooLateDropped: totals.tooLateDropped + summary.tooLateDropped,
    heldByBackpressure: totals.heldByBackpressure + summary.heldByBackpressure,
    offlineBatches: totals.offlineBatches + summary.offlineBatches,
    windowsClosed: totals.windowsClosed + summary.windowsClosed,
    windowsRevised: totals.windowsRevised + summary.windowsRevised,
    gapsClosed: totals.gapsClosed + summary.gapsClosed,
    evictedClosedWindows: totals.evictedClosedWindows + summary.evictedClosedWindows,
  }
}

/** One admitted-but-unprocessed event with the ingest time admission stamped. */
interface BufferedEvent {
  readonly event: StreamEvent
  readonly ingestMs: number
}

/** The mutable window state behind the exported {@link WindowState} face. */
interface MutableWindow {
  readonly startMs: number
  readonly endMs: number
  status: WindowStatus
  readonly revisions: { revision: number; digest: string; aggregate: WindowAggregate }[]
}

/** One recorded materialization: the export digest and the artifact ref it published as. */
export interface MaterializationRecord {
  /** The export digest that was published. */
  readonly exportDigest: string
  /** The immutable artifact ref (`art-…@vN`) the export published as. */
  readonly artifactRef: string
  /** Process time the publication was recorded at. */
  readonly processMs: number
}

/** The bounded status face of one workbench (checkpoint-external facts only). */
export interface StreamStatus {
  readonly methodVersion: typeof REALTIME_METHOD_VERSION
  readonly paused: boolean
  /** Index of the next scenario batch to admit. */
  readonly batchCursor: number
  /** Whether every scenario batch has been consumed. */
  readonly sourceExhausted: boolean
  readonly watermarkMs: number | null
  readonly maxEventTimeMs: number | null
  readonly lastIngestTimeMs: number | null
  readonly lastProcessTimeMs: number | null
  /** Process time minus max event time, milliseconds — the visible lag the watermark policy implies. */
  readonly lagMs: number | null
  /** Events currently held in the intake buffer. */
  readonly bufferLength: number
  /** Event ids currently inside the dedup window. */
  readonly dedupLength: number
  readonly openWindows: number
  readonly closedWindows: number
  readonly revisedWindows: number
  readonly gapWindows: number
  /** Live windows evicted by bounded retention since the workbench opened. */
  readonly evictedClosedWindows: number
  readonly admitted: number
  readonly processed: number
  readonly duplicatesDropped: number
  readonly tooLateDropped: number
  readonly heldByBackpressure: number
  readonly offlineBatches: number
  readonly pendingGapWindows: number
  /** Materializations recorded so far (live entries; evicted ones are not counted here). */
  readonly materializedCount: number
}

/**
 * The pull-based stream state machine over one controlled scenario.
 * Construct with {@link StreamRuntime.open} or restore with
 * {@link StreamRuntime.resume}; every operation is synchronous and
 * deterministic given the caller-supplied times.
 */
export class StreamRuntime {
  private readonly specValue: StreamSpec
  private scenario: StreamScenario
  private batchCursor: number
  private admittedInBatch: number
  private paused: boolean
  private readonly buffer: BufferedEvent[]
  private readonly dedupIds: string[]
  private readonly dedupSet: Set<string>
  private readonly windows: Map<string, MutableWindow>
  private gapFrontierMs: number | null
  private maxEventTimeMs: number | null
  private lastIngestMs: number | null
  private lastProcessMs: number | null
  private evictedClosed: number
  private readonly counters: { admitted: number; processed: number; duplicatesDropped: number; tooLateDropped: number; heldByBackpressure: number; offlineBatches: number }
  private readonly materialized: MaterializationRecord[]

  private constructor(
    specValue: StreamSpec,
    scenario: StreamScenario,
    batchCursor: number,
    admittedInBatch: number,
    paused: boolean,
    buffer: BufferedEvent[],
    dedupIds: string[],
    dedupSet: Set<string>,
    windows: Map<string, MutableWindow>,
    gapFrontierMs: number | null,
    maxEventTimeMs: number | null,
    lastIngestMs: number | null,
    lastProcessMs: number | null,
    evictedClosed: number,
    counters: { admitted: number; processed: number; duplicatesDropped: number; tooLateDropped: number; heldByBackpressure: number; offlineBatches: number },
    materialized: MaterializationRecord[],
  ) {
    this.specValue = specValue
    this.scenario = scenario
    this.batchCursor = batchCursor
    this.admittedInBatch = admittedInBatch
    this.paused = paused
    this.buffer = buffer
    this.dedupIds = dedupIds
    this.dedupSet = dedupSet
    this.windows = windows
    this.gapFrontierMs = gapFrontierMs
    this.maxEventTimeMs = maxEventTimeMs
    this.lastIngestMs = lastIngestMs
    this.lastProcessMs = lastProcessMs
    this.evictedClosed = evictedClosed
    this.counters = counters
    this.materialized = materialized
  }

  /**
   * Open one workbench over a validated spec and scenario.
   * @param spec - the fully-resolved spec (validate first; an invalid spec refuses).
   * @param scenario - the controlled scenario (validate first).
   * @throws {StreamRuntimeError} with `spec-invalid`/`scenario-invalid` when validation fails.
   */
  static open(spec: StreamSpec, scenario: StreamScenario): StreamRuntime {
    const specIssues = validateStreamSpec(spec)
    if (specIssues.length > 0) {
      throw new StreamRuntimeError('spec-invalid', `stream spec rejected: ${renderIssues(specIssues)}`)
    }
    const scenarioIssues = validateStreamScenario(scenario)
    if (scenarioIssues.length > 0) {
      throw new StreamRuntimeError('scenario-invalid', `stream scenario rejected: ${renderIssues(scenarioIssues)}`)
    }
    return new StreamRuntime(spec, scenario, 0, 0, false, [], [], new Set(), new Map(), null, null, null, null, 0,
      { admitted: 0, processed: 0, duplicatesDropped: 0, tooLateDropped: 0, heldByBackpressure: 0, offlineBatches: 0 }, [])
  }

  /** The resolved spec this workbench runs under. */
  get spec(): StreamSpec {
    return this.specValue
  }

  /**
   * Rebuild one runtime from raw restored state — the checkpoint plane's
   * resume path. Callers validate first (`decodeCheckpoint`); this
   * constructor trusts its input the way the fold trusts a decoded record.
   * @param spec - the restored spec.
   * @param scenario - the restored scenario.
   * @param state - the restored mutable state.
   * @returns the restored runtime.
   */
  static restore(
    spec: StreamSpec,
    scenario: StreamScenario,
    state: {
      batchIndex: number
      admittedInBatch: number
      paused: boolean
      buffer: BufferedEvent[]
      dedupIds: string[]
      windows: Array<{ startMs: number; endMs: number; status: WindowStatus; revisions: Array<{ revision: number; digest: string; aggregate: WindowAggregate }> }>
      gapFrontierMs: number | null
      maxEventTimeMs: number | null
      lastIngestMs: number | null
      lastProcessMs: number | null
      evictedClosed: number
      counters: { admitted: number; processed: number; duplicatesDropped: number; tooLateDropped: number; heldByBackpressure: number; offlineBatches: number }
      materialized: MaterializationRecord[]
    },
  ): StreamRuntime {
    const runtime = new StreamRuntime(spec, scenario, state.batchIndex, state.admittedInBatch, state.paused,
      [...state.buffer], [], new Set(), new Map(), state.gapFrontierMs, state.maxEventTimeMs, state.lastIngestMs,
      state.lastProcessMs, state.evictedClosed, { ...state.counters }, [...state.materialized])
    for (const id of state.dedupIds) {
      runtime.dedupIds.push(id)
      runtime.dedupSet.add(id)
    }
    for (const window of state.windows) {
      runtime.windows.set(String(window.startMs), {
        startMs: window.startMs,
        endMs: window.endMs,
        status: window.status,
        revisions: window.revisions.map(entry => ({ ...entry, aggregate: { ...entry.aggregate } })),
      })
    }
    return runtime
  }

  /**
   * The narrow internal face the checkpoint plane reads to encode state.
   * Deliberately not part of the public runtime API: only `encodeCheckpoint`
   * consumes it.
   * @returns the internal state face.
   */
  expose(): {
    readonly spec: StreamSpec
    readonly scenario: StreamScenario
    readonly cursor: { readonly batchIndex: number; readonly admittedInBatch: number }
    readonly paused: boolean
    readonly buffer: readonly BufferedEvent[]
    readonly dedupIds: readonly string[]
    readonly windowStates: () => WindowState[]
    readonly gapFrontierMs: number | null
    readonly maxEventTimeMs: number | null
    readonly lastIngestMs: number | null
    readonly lastProcessMs: number | null
    readonly evictedClosed: number
    readonly counters: { admitted: number; processed: number; duplicatesDropped: number; tooLateDropped: number; heldByBackpressure: number; offlineBatches: number }
    readonly materialized: readonly MaterializationRecord[]
  } {
    return {
      spec: this.specValue,
      scenario: this.scenario,
      cursor: { batchIndex: this.batchCursor, admittedInBatch: this.admittedInBatch },
      paused: this.paused,
      buffer: this.buffer,
      dedupIds: this.dedupIds,
      windowStates: () => this.windowStates(),
      gapFrontierMs: this.gapFrontierMs,
      maxEventTimeMs: this.maxEventTimeMs,
      lastIngestMs: this.lastIngestMs,
      lastProcessMs: this.lastProcessMs,
      evictedClosed: this.evictedClosed,
      counters: this.counters,
      materialized: this.materialized,
    }
  }

  /** Whether the source is paused (advances admit and process nothing). */
  get isPaused(): boolean {
    return this.paused
  }

  /**
   * Pause the source: subsequent advances change nothing until resume. The
   * intake buffer and window state are preserved exactly.
   */
  pause(): void {
    this.paused = true
  }

  /** Resume a paused source. */
  resume(): void {
    this.paused = false
  }

  /** The materialization records retained live (oldest may have been evicted). */
  get materializations(): readonly MaterializationRecord[] {
    return this.materialized
  }

  /**
   * Record one published materialization (export digest → artifact ref).
   * The ledger is bounded; beyond {@link MAX_MATERIALIZED_ENTRIES} the oldest
   * entry is evicted (its digest equality check ages out with it).
   * @param record - the publication to record.
   */
  recordMaterialization(record: MaterializationRecord): void {
    if (this.materialized.length >= MAX_MATERIALIZED_ENTRIES) this.materialized.shift()
    this.materialized.push(record)
  }

  /**
   * Advance one step: admit the current scenario batch (bounded by the intake
   * buffer — a full buffer holds the source back), then process up to the
   * quota, then close windows the watermark passed and materialize bounded
   * data gaps. A paused workbench changes nothing.
   * @param processMs - the process time to stamp this advance with (caller-supplied; never wall clock).
   * @returns the bounded summary of what changed.
   */
  advance(processMs: number): AdvanceSummary {
    if (!Number.isFinite(processMs)) {
      throw new StreamRuntimeError('spec-invalid', 'processMs must be a finite number')
    }
    if (this.paused) {
      return this.blankSummary()
    }
    let advancedBatches = 0
    let admitted = 0
    let duplicatesDropped = 0
    let heldByBackpressure = 0
    let offlineBatches = 0

    // Admit phase: one scenario batch per advance, in wire order.
    const batch = this.scenario.batches[this.batchCursor]
    if (batch !== undefined) {
      advancedBatches = 1
      if (batch.offline === true) {
        // Disconnected source: nothing is released; the next batch models the reconnect.
        offlineBatches = 1
        this.batchCursor += 1
        this.admittedInBatch = 0
        this.counters.offlineBatches += 1
      } else {
        const outcome = this.admitEvents(batch.events, this.admittedInBatch, processMs)
        admitted = outcome.admitted
        duplicatesDropped = outcome.duplicatesDropped
        heldByBackpressure = outcome.heldByBackpressure
        this.admittedInBatch += outcome.consumed
        if (this.admittedInBatch >= batch.events.length) {
          this.batchCursor += 1
          this.admittedInBatch = 0
        }
      }
    }
    return this.finishAdvance(processMs, advancedBatches, admitted, duplicatesDropped, heldByBackpressure, offlineBatches)
  }

  /**
   * Advance one step over one live batch — the real-source seam
   * `stream-providers` fusion feeds. The batch bypasses the scenario
   * entirely: its events take the same admission path (dedup, intake-buffer
   * backpressure), the same process quota, and the same close/gap phases as
   * a scenario batch, while the scenario cursor and replay state stay
   * untouched — a checkpoint still carries the scenario it saw, and live
   * events survive in the buffer/dedup faces it already serializes. Events
   * the full intake buffer refuses are counted `heldByBackpressure` and
   * dropped from the runtime; the caller's pending queue is the holding
   * ground, so it re-releases them on a later round.
   * @param processMs - the process time to stamp this advance with (caller-supplied; never wall clock).
   * @param batch - one live batch (`offline: true` models a disconnected source round).
   * @returns the bounded summary of what changed.
   * @throws {StreamRuntimeError} with `spec-invalid` on a non-finite process time or `scenario-append-invalid` on a malformed batch (state unchanged).
   */
  advanceLive(processMs: number, batch: StreamScenarioBatch): AdvanceSummary {
    if (!Number.isFinite(processMs)) {
      throw new StreamRuntimeError('spec-invalid', 'processMs must be a finite number')
    }
    const problems: string[] = []
    if (typeof batch !== 'object' || batch === null || !Array.isArray(batch.events)) {
      problems.push('advanceLive requires one batch object with an events array')
    } else {
      if (batch.events.length > MAX_SCENARIO_BATCH_EVENTS) {
        problems.push(`the live batch carries ${String(batch.events.length)} events; the batch bound is ${String(MAX_SCENARIO_BATCH_EVENTS)}`)
      }
      for (const [at, event] of batch.events.entries()) {
        const problem = eventProblem(event)
        if (problem !== null) problems.push(`events[${String(at)}]: ${problem}`)
      }
    }
    if (problems.length > 0) {
      throw new StreamRuntimeError('scenario-append-invalid', problems.join('; '))
    }
    if (this.paused) {
      return this.blankSummary()
    }
    if (batch.offline === true) {
      this.counters.offlineBatches += 1
      return this.finishAdvance(processMs, 1, 0, 0, 0, 1)
    }
    const outcome = this.admitEvents(batch.events, 0, processMs)
    return this.finishAdvance(processMs, 1, outcome.admitted, outcome.duplicatesDropped, outcome.heldByBackpressure, 0)
  }

  /**
   * The shared admit path: examine `events` from `start`, pushing past the
   * dedup window into the intake buffer until the buffer is full. The
   * scenario cursor bookkeeping stays with the caller; only counters and
   * buffer/dedup/windows bookkeeping inside change here.
   */
  private admitEvents(events: readonly StreamEvent[], start: number, processMs: number): { admitted: number; duplicatesDropped: number; heldByBackpressure: number; consumed: number } {
    let admitted = 0
    let duplicatesDropped = 0
    let heldByBackpressure = 0
    let index = start
    while (index < events.length) {
      if (this.buffer.length >= this.specValue.bufferCapacity) {
        heldByBackpressure = events.length - index
        this.counters.heldByBackpressure += heldByBackpressure
        break
      }
      const event = events[index] as StreamEvent
      index += 1
      if (this.dedupSet.has(event.eventId)) {
        duplicatesDropped += 1
        this.counters.duplicatesDropped += 1
        continue
      }
      if (this.dedupIds.length >= this.specValue.dedupCapacity) {
        const evicted = this.dedupIds.shift() as string
        this.dedupSet.delete(evicted)
      }
      this.dedupIds.push(event.eventId)
      this.dedupSet.add(event.eventId)
      this.buffer.push({ event, ingestMs: processMs })
      admitted += 1
      this.counters.admitted += 1
      this.maxEventTimeMs = this.maxEventTimeMs === null || event.eventTimeMs > this.maxEventTimeMs
        ? event.eventTimeMs
        : this.maxEventTimeMs
      this.lastIngestMs = processMs
      if (this.gapFrontierMs === null) {
        this.gapFrontierMs = windowStartOf(event.eventTimeMs, this.specValue.windowSizeMs)
      }
    }
    return { admitted, duplicatesDropped, heldByBackpressure, consumed: index - start }
  }

  /** The shared process/close/summary phase both advance paths end in. */
  private finishAdvance(processMs: number, advancedBatches: number, admitted: number, duplicatesDropped: number, heldByBackpressure: number, offlineBatches: number): AdvanceSummary {
    // Process phase: bounded by the quota — the slow-consumer bound.
    const watermark = this.watermarkMs
    let processed = 0
    let windowsRevised = 0
    let tooLateDropped = 0
    let openWindowBoundReached = false
    while (this.buffer.length > 0 && processed < this.specValue.maxEventsPerAdvance) {
      const buffered = this.buffer[0] as BufferedEvent
      const outcome = this.applyEvent(buffered.event, watermark)
      if (outcome === 'open-window-bound') {
        openWindowBoundReached = true
        break
      }
      this.buffer.shift()
      if (outcome === 'revised') windowsRevised += 1
      if (outcome === 'too-late') tooLateDropped += 1
      processed += 1
    }
    this.counters.processed += processed
    this.counters.tooLateDropped += tooLateDropped
    const rateLimited = processed === this.specValue.maxEventsPerAdvance && this.buffer.length > 0

    // Close phase: windows the watermark passed, then bounded gap materialization.
    const closing = this.closeWindows()
    const gaps = this.materializeGaps()
    this.lastProcessMs = advancedBatches > 0 || processed > 0 || closing.closed > 0 || gaps.gaps > 0
      ? processMs
      : this.lastProcessMs

    return {
      advancedBatches,
      admitted,
      processed,
      duplicatesDropped,
      tooLateDropped,
      heldByBackpressure,
      offlineBatches,
      rateLimited,
      openWindowBoundReached,
      windowsClosed: closing.closed,
      windowsRevised,
      gapsClosed: gaps.gaps,
      pendingGapWindows: gaps.pending,
      evictedClosedWindows: closing.evicted,
      watermarkMs: this.watermarkMs,
      paused: false,
    }
  }

  /** The current bounded status face. */
  status(): StreamStatus {
    let open = 0
    let closed = 0
    let revised = 0
    let gap = 0
    for (const window of this.windows.values()) {
      if (window.status === 'open') open += 1
      else if (window.status === 'revised') revised += 1
      else if (window.status === 'empty') gap += 1
      else closed += 1
    }
    return {
      methodVersion: REALTIME_METHOD_VERSION,
      paused: this.paused,
      batchCursor: this.batchCursor,
      sourceExhausted: this.batchCursor >= this.scenario.batches.length,
      watermarkMs: this.watermarkMs,
      maxEventTimeMs: this.maxEventTimeMs,
      lastIngestTimeMs: this.lastIngestMs,
      lastProcessTimeMs: this.lastProcessMs,
      lagMs: this.maxEventTimeMs === null || this.lastProcessMs === null ? null : this.lastProcessMs - this.maxEventTimeMs,
      bufferLength: this.buffer.length,
      dedupLength: this.dedupIds.length,
      openWindows: open,
      closedWindows: closed,
      revisedWindows: revised,
      gapWindows: gap,
      evictedClosedWindows: this.evictedClosed,
      admitted: this.counters.admitted,
      processed: this.counters.processed,
      duplicatesDropped: this.counters.duplicatesDropped,
      tooLateDropped: this.counters.tooLateDropped,
      heldByBackpressure: this.counters.heldByBackpressure,
      offlineBatches: this.counters.offlineBatches,
      pendingGapWindows: this.pendingGapCount(),
      materializedCount: this.materialized.length,
    }
  }

  /** The live window states in start-time order (bounded by retention). */
  windowStates(): WindowState[] {
    return [...this.windows.values()]
      .sort((left, right) => left.startMs - right.startMs)
      .map(window => ({
        startMs: window.startMs,
        endMs: window.endMs,
        status: window.status,
        revisions: window.revisions.map(entry => ({ ...entry, aggregate: { ...entry.aggregate } })),
      }))
  }

  /**
   * The bounded realtime display projection: one Point per live non-empty
   * window at its mean observation coordinate, carrying the window identity,
   * status, revision, and aggregate. Empty windows (data gaps) render no
   * feature — a gap stays unoccupied, never interpolated. The most recent
   * `maxWindows` windows by start time win when the live set exceeds the cap.
   * @param maxWindows - the display cap.
   * @returns plain GeoJSON Point features.
   */
  displayFeatures(maxWindows: number): Array<{
    type: 'Point'
    coordinates: [number, number]
    properties: Record<string, number | string>
  }> {
    const eligible = [...this.windows.values()]
      .filter(window => window.status !== 'empty')
      .sort((left, right) => left.startMs - right.startMs)
    const selected = eligible.length > maxWindows ? eligible.slice(eligible.length - maxWindows) : eligible
    return selected.map(window => {
      const current = window.revisions[window.revisions.length - 1] as WindowRevision
      return {
        type: 'Point' as const,
        coordinates: [round6(current.aggregate.meanLon), round6(current.aggregate.meanLat)],
        properties: {
          window_start_ms: window.startMs,
          window_end_ms: window.endMs,
          status: window.status,
          revision: current.revision,
          count: current.aggregate.count,
          mean: round6(current.aggregate.mean),
          min: round6(current.aggregate.min),
          max: round6(current.aggregate.max),
        },
      }
    })
  }

  // -- internals --

  /** Apply one buffered event against the current watermark. */
  private applyEvent(event: StreamEvent, watermark: number | null): 'open' | 'revised' | 'too-late' | 'open-window-bound' {
    const size = this.specValue.windowSizeMs
    const startMs = windowStartOf(event.eventTimeMs, size)
    const endMs = startMs + size
    const key = String(startMs)
    const existing = this.windows.get(key)
    if (existing !== undefined) {
      const current = existing.revisions[existing.revisions.length - 1] as { revision: number; digest: string; aggregate: WindowAggregate }
      if (existing.status === 'open') {
        current.aggregate = foldInto(current.aggregate, event)
        current.digest = windowRevisionDigestOf(startMs, endMs, current.revision, current.aggregate)
        return 'open'
      }
      // Closed/revised/empty: the event is late; append a NEW revision, never mutate the old one.
      if (existing.revisions.length >= this.specValue.maxRevisionsPerWindow) {
        return 'too-late'
      }
      existing.revisions.push({
        revision: current.revision + 1,
        digest: windowRevisionDigestOf(startMs, endMs, current.revision + 1, foldInto(current.aggregate, event)),
        aggregate: foldInto(current.aggregate, event),
      })
      existing.status = 'revised'
      return 'revised'
    }
    const late = watermark !== null && event.eventTimeMs < watermark
    if (late) {
      // The window closed before any state existed and no gap record retained it:
      // materialize the late arrival directly as the closed window's revision 1.
      const aggregate = foldInto(zeroAggregate(), event)
      this.windows.set(key, {
        startMs,
        endMs,
        status: 'closed',
        revisions: [{ revision: 1, digest: windowRevisionDigestOf(startMs, endMs, 1, aggregate), aggregate }],
      })
      return 'open'
    }
    if (this.openWindowCount() + 1 > this.specValue.maxOpenWindows) {
      return 'open-window-bound'
    }
    const aggregate = foldInto(zeroAggregate(), event)
    this.windows.set(key, {
      startMs,
      endMs,
      status: 'open',
      revisions: [{ revision: 1, digest: windowRevisionDigestOf(startMs, endMs, 1, aggregate), aggregate }],
    })
    return 'open'
  }

  /** Close every open window whose end the watermark passed; evict bounded retention overflow. */
  private closeWindows(): { closed: number; evicted: number } {
    const watermark = this.watermarkMs
    if (watermark === null) return { closed: 0, evicted: 0 }
    let closed = 0
    for (const window of this.windows.values()) {
      if (window.status === 'open' && window.endMs <= watermark) {
        window.status = 'closed'
        closed += 1
      }
    }
    let evicted = 0
    while (this.totalWindows() > this.specValue.maxOpenWindows + MAX_RETAINED_CLOSED_WINDOWS) {
      const oldestClosed = [...this.windows.values()]
        .filter(window => window.status !== 'open')
        .sort((left, right) => left.startMs - right.startMs)[0]
      if (oldestClosed === undefined) break
      this.windows.delete(String(oldestClosed.startMs))
      // The evicted range left retention: the gap frontier must move past it,
      // or the next advance would re-materialize the evicted keys as gaps.
      if (this.gapFrontierMs !== null) {
        this.gapFrontierMs = Math.max(this.gapFrontierMs, oldestClosed.endMs)
      }
      evicted += 1
      this.evictedClosed += 1
    }
    return { closed, evicted }
  }

  /** Materialize data-gap windows between the frontier and the watermark, bounded per advance. */
  private materializeGaps(): { gaps: number; pending: number } {
    const watermark = this.watermarkMs
    if (watermark === null || this.gapFrontierMs === null) return { gaps: 0, pending: 0 }
    const size = this.specValue.windowSizeMs
    const frontierEnd = windowStartOf(watermark, size)
    let gaps = 0
    let cursor = this.gapFrontierMs
    while (cursor < frontierEnd && gaps < MAX_GAP_WINDOWS_PER_ADVANCE) {
      const key = String(cursor)
      if (!this.windows.has(key)) {
        const aggregate = zeroAggregate()
        this.windows.set(key, {
          startMs: cursor,
          endMs: cursor + size,
          status: 'empty',
          revisions: [{ revision: 1, digest: windowRevisionDigestOf(cursor, cursor + size, 1, aggregate), aggregate }],
        })
        gaps += 1
      }
      cursor += size
    }
    this.gapFrontierMs = cursor
    return { gaps, pending: cursor < frontierEnd ? countWindows(cursor, frontierEnd, size, this.windows) : 0 }
  }

  /** Count gap windows still pending between the frontier and the watermark. */
  private pendingGapCount(): number {
    const watermark = this.watermarkMs
    if (watermark === null || this.gapFrontierMs === null) return 0
    const frontierEnd = windowStartOf(watermark, this.specValue.windowSizeMs)
    return countWindows(this.gapFrontierMs, frontierEnd, this.specValue.windowSizeMs, this.windows)
  }

  private openWindowCount(): number {
    let count = 0
    for (const window of this.windows.values()) if (window.status === 'open') count += 1
    return count
  }

  private totalWindows(): number {
    return this.windows.size
  }

  private watermarkValue(): number | null {
    return this.maxEventTimeMs === null ? null : this.maxEventTimeMs - this.specValue.allowedLatenessMs
  }

  private get watermarkMs(): number | null {
    return this.watermarkValue()
  }

  private blankSummary(): AdvanceSummary {
    return {
      advancedBatches: 0,
      admitted: 0,
      processed: 0,
      duplicatesDropped: 0,
      tooLateDropped: 0,
      heldByBackpressure: 0,
      offlineBatches: 0,
      rateLimited: false,
      openWindowBoundReached: false,
      windowsClosed: 0,
      windowsRevised: 0,
      gapsClosed: 0,
      pendingGapWindows: this.pendingGapCount(),
      evictedClosedWindows: 0,
      watermarkMs: this.watermarkValue(),
      paused: true,
    }
  }
}

/** The tumbling window start containing one event time. */
function windowStartOf(eventTimeMs: number, sizeMs: number): number {
  return Math.floor(eventTimeMs / sizeMs) * sizeMs
}

/** The zero aggregate every window revision folds from. */
function zeroAggregate(): WindowAggregate {
  return { count: 0, sum: 0, min: 0, max: 0, mean: 0, meanLon: 0, meanLat: 0 }
}

/** Fold one event into an aggregate (running mean over count, min/max over values). */
function foldInto(aggregate: WindowAggregate, event: StreamEvent): WindowAggregate {
  const count = aggregate.count + 1
  const sum = aggregate.sum + event.value
  return {
    count,
    sum,
    min: aggregate.count === 0 ? event.value : Math.min(aggregate.min, event.value),
    max: aggregate.count === 0 ? event.value : Math.max(aggregate.max, event.value),
    mean: sum / count,
    meanLon: (aggregate.meanLon * aggregate.count + event.lon) / count,
    meanLat: (aggregate.meanLat * aggregate.count + event.lat) / count,
  }
}

/** Count unmaterialized gap keys in [from, to). */
function countWindows(from: number, to: number, size: number, windows: Map<string, MutableWindow>): number {
  let count = 0
  for (let at = from; at < to; at += size) {
    if (!windows.has(String(at))) count += 1
  }
  return count
}

/** Round display coordinates and aggregates to the shared six-decimal exchange precision. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Render one issue list the way every refusal message names its reasons. */
function renderIssues(issues: readonly StreamIssue[]): string {
  return issues.map(issue => `${issue.field} (${issue.code})`).join('; ')
}
