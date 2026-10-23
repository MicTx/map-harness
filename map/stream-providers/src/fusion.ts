/**
 * Deterministic multi-source fusion: bind 2..8 declared sources behind one
 * fused event-time horizon and release what the horizon admits, oldest
 * first.
 *
 * The horizon is the load-bearing rule. A live source that has delivered
 * at least one event is conclusive up to its maximum received event time —
 * times beyond it may still arrive as late data. The horizon is the minimum
 * over all conclusive sources, so a lagging source holds the fused
 * conclusion back instead of letting a fast source burn the workbench's
 * late-revision budget — the same discipline the runtime applies inside one
 * stream, applied across sources. A cleanly ended source can never deliver
 * again, so it is complete (a watermark of +∞: it never holds the horizon
 * back, but its own backlog still releases under it). Paused and offline
 * (failed) sources are inconclusive — their coverage is unknown — so they
 * neither advance nor hold the horizon; a stalled feed degrades to the
 * remaining feeds instead of freezing the fusion.
 *
 * Namespacing is the dedup seam: every released id is
 * `<sourceId>::<eventId>` (source ids carry no colons, so the mapping is
 * injective), and re-reading one source re-emits the same namespaced id —
 * at-least-once redelivery across rounds is absorbed by the workbench's
 * existing first-seen dedup with no fusion-side dedup state.
 *
 * Backpressure is honest in both directions: a source whose pending queue
 * is full is not read that round (its parked wire read is the holding
 * ground), and the read that does happen is bounded by the queue's
 * remaining capacity. Release order is total and replay-stable:
 * (eventTimeMs, source declaration order, arrival index within the source).
 *
 * @module @map-harness/stream-providers/fusion
 */
import { MAX_SCENARIO_BATCH_EVENTS, type StreamEvent, type StreamScenarioBatch } from '@map-harness/spatial-realtime'
import {
  DEFAULT_EVENTS_PER_RELEASE,
  DEFAULT_PENDING_CAPACITY,
  type StreamFusionSpec,
  type StreamReadOutcome,
} from './contract.ts'
import type { SourceReaderOptions, SourceRoundReport, ReaderState } from './sse.ts'
import { streamCredentialFailure, StreamProvidersError } from './errors.ts'

/** The face both source families expose to the engine. */
export interface FusionReader {
  /** Run one bounded read round. */
  readRound(options?: SourceReaderOptions): Promise<SourceRoundReport>
  /** Tear the channel down. */
  close(): Promise<void>
  /** The reader's terminal state. */
  readonly state: ReaderState
}

/** One source the engine binds. */
export interface FusionSourceInput {
  /** The declared source id (no colons — namespacing depends on it). */
  readonly sourceId: string
  /** The source's reader; the engine owns its lifecycle from here. */
  readonly reader: FusionReader
}

/** The states a bound source holds between rounds. */
export type FusionSourceState = 'live' | 'held' | 'paused' | 'ended' | 'offline'

/** One bound source's report in a fusion round. */
export interface FusionSourceReport {
  readonly sourceId: string
  readonly state: FusionSourceState
  /** The closed outcome value of this round's read (`streaming` on a quiet or uneventful round). */
  readonly lastOutcome: StreamReadOutcome
  /** Sanitized detail when this round's read failed. */
  readonly detail: string | undefined
  readonly pendingLength: number
  /** Total events received from the wire since the fusion opened. */
  readonly received: number
  /** Total valid-JSON payloads the source rejected as bad event shapes. */
  readonly rejected: number
  /** Total events released into fused batches. */
  readonly released: number
  /** Rounds the source was skipped because its queue was full or it was paused. */
  readonly heldRounds: number
  /** Rounds the source's read failed (offline). */
  readonly failedRounds: number
}

/** The report one fusion advance produces. */
export interface FusionAdvanceReport {
  readonly fusionId: string
  /** The fused event-time horizon this round computed; null when no source bounds it (nothing conclusive, or every conclusive source already ended). */
  readonly horizonMs: number | null
  /** Released events in fused order, namespaced. */
  readonly releasedEvents: readonly StreamEvent[]
  /** The released events chunked into batches the runtime's live seam accepts (≤ its wire batch bound). */
  readonly batches: readonly StreamScenarioBatch[]
  /** True when every bound source failed its read this round and nothing was released. */
  readonly offlineRound: boolean
  readonly perSource: readonly FusionSourceReport[]
}

/** One namespaced pending entry with its stable sort keys. */
interface PendingEntry {
  readonly event: StreamEvent
  readonly declarationIndex: number
  readonly arrivalIndex: number
}

/** One bound source's mutable engine state. */
interface BoundSource {
  readonly sourceId: string
  readonly declarationIndex: number
  readonly reader: FusionReader
  paused: boolean
  readonly pending: PendingEntry[]
  /** Events a round delivered past the queue's capacity; drains into pending first, never dropped. */
  readonly overflow: PendingEntry[]
  readonly pendingCapacity: number
  received: number
  rejected: number
  released: number
  heldRounds: number
  failedRounds: number
  lastOutcome: StreamReadOutcome
  lastDetail: string | undefined
  maxReceivedEventTimeMs: number | null
  arrivalCounter: number
}

/**
 * One fusion engine over bound source readers. Constructed by the service
 * face (which resolves credentials and owns the readers' construction);
 * pull-only — {@link advance} is the only method that touches the wire, and
 * a round's wall time is bounded by one read deadline per source read this
 * round.
 */
export class StreamFusionEngine {
  private readonly spec: StreamFusionSpec
  private readonly sources: BoundSource[]
  private closed = false

  constructor(spec: StreamFusionSpec, inputs: readonly FusionSourceInput[]) {
    this.spec = spec
    this.sources = inputs.map((input, index) => ({
      sourceId: input.sourceId,
      declarationIndex: index,
      reader: input.reader,
      paused: false,
      pending: [],
      overflow: [],
      pendingCapacity: spec.pendingCapacity ?? DEFAULT_PENDING_CAPACITY,
      received: 0,
      rejected: 0,
      released: 0,
      heldRounds: 0,
      failedRounds: 0,
      lastOutcome: 'streaming',
      lastDetail: undefined,
      maxReceivedEventTimeMs: null,
      arrivalCounter: 0,
    }))
  }

  /** Pause one bound source: its wire goes unread and its queue frozen until resumed. */
  pauseSource(sourceId: string): void {
    const source = this.sourceOf(sourceId)
    source.paused = true
  }

  /** Resume one paused source; the next round reads it again. */
  resumeSource(sourceId: string): void {
    const source = this.sourceOf(sourceId)
    source.paused = false
  }

  /** The current per-source report faces, in declaration order. */
  report(): readonly FusionSourceReport[] {
    return this.sources.map(source => this.reportOf(source))
  }

  /**
   * Run one fusion round: read every readable source within its budget,
   * recompute the horizon over the conclusive sources, and release what the
   * horizon admits — oldest first, bounded by the release budget — chunked
   * into runtime-acceptable batches. A round where every source failed and
   * nothing was released reports `offlineRound` so the caller can feed the
   * workbench its disconnected-source model.
   * @param options - per-round overrides threaded to every source read.
   */
  async advance(options?: SourceReaderOptions): Promise<FusionAdvanceReport> {
    if (this.closed) {
      throw new Error('the fusion is closed')
    }
    let anyFailed = false
    for (const source of this.sources) {
      const terminal = source.reader.state === 'ended'
      if (source.paused) {
        source.heldRounds += 1
        continue
      }
      if (terminal) {
        continue
      }
      drainOverflow(source)
      if (source.pending.length >= source.pendingCapacity) {
        // The queue is the backpressure face: the wire stays unread and the
        // parked read holds the source's place.
        source.heldRounds += 1
        continue
      }
      const remaining = source.pendingCapacity - source.pending.length
      let round: SourceRoundReport
      try {
        round = await source.reader.readRound({
          ...(options ?? {}),
          // The queue's remaining capacity always binds the round's read.
          maxEventsPerFetch: options?.maxEventsPerFetch !== undefined ? Math.min(options.maxEventsPerFetch, remaining) : remaining,
        })
      } catch (error) {
        if (error instanceof StreamProvidersError) {
          // A credential refusal at this execution round is an answer about
          // the source: the round records it, the fusion keeps running.
          const failure = streamCredentialFailure(error)
          source.failedRounds += 1
          source.lastOutcome = failure.outcome
          source.lastDetail = failure.detail
          continue
        }
        throw error
      }
      source.received += round.events.length
      source.rejected += round.rejected
      if (round.failure !== undefined) {
        source.failedRounds += 1
        source.lastOutcome = round.failure.outcome
        source.lastDetail = round.failure.detail
        anyFailed = true
        continue
      }
      source.lastDetail = undefined
      if (round.ended) {
        source.lastOutcome = 'source-closed'
      } else {
        source.lastOutcome = 'streaming'
      }
      for (const event of round.events) {
        const entry: PendingEntry = {
          event: { ...event, eventId: `${source.sourceId}::${event.eventId}` },
          declarationIndex: source.declarationIndex,
          arrivalIndex: source.arrivalCounter,
        }
        source.arrivalCounter += 1
        // The wire read was bounded by the remaining capacity, so a reader
        // honoring its budget never reaches the overflow carrier; one that
        // overshoots still loses nothing — the surplus drains before the
        // source is read again.
        if (source.pending.length < source.pendingCapacity) {
          source.pending.push(entry)
        } else {
          source.overflow.push(entry)
        }
        if (source.maxReceivedEventTimeMs === null || event.eventTimeMs > source.maxReceivedEventTimeMs) {
          source.maxReceivedEventTimeMs = event.eventTimeMs
        }
      }
    }

    const horizon = this.horizonBoundMs()
    const released: PendingEntry[] = []
    if (horizon !== null) {
      // A finite horizon gates release; +∞ (every conclusive source ended)
      // admits everything within the release budget.
      const candidates = this.sources
        .filter(source => !source.paused)
        .flatMap(source => [...source.pending, ...source.overflow])
      candidates.sort((left, right) =>
        left.event.eventTimeMs - right.event.eventTimeMs
        || left.declarationIndex - right.declarationIndex
        || left.arrivalIndex - right.arrivalIndex)
      const budget = this.spec.maxEventsPerRelease ?? DEFAULT_EVENTS_PER_RELEASE
      for (const candidate of candidates) {
        if (candidate.event.eventTimeMs > horizon) break
        if (released.length >= budget) break
        released.push(candidate)
      }
      const releasedSet = new Set(released)
      for (const source of this.sources) {
        if (source.paused) continue
        const keptPending = source.pending.filter(entry => !releasedSet.has(entry))
        const keptOverflow = source.overflow.filter(entry => !releasedSet.has(entry))
        source.released += (source.pending.length - keptPending.length) + (source.overflow.length - keptOverflow.length)
        source.pending.length = 0
        source.pending.push(...keptPending)
        source.overflow.length = 0
        source.overflow.push(...keptOverflow)
        drainOverflow(source)
      }
    }

    const releasedEvents = released.map(entry => entry.event)
    const batches: StreamScenarioBatch[] = []
    for (let at = 0; at < releasedEvents.length; at += MAX_SCENARIO_BATCH_EVENTS) {
      batches.push({ events: [...releasedEvents.slice(at, at + MAX_SCENARIO_BATCH_EVENTS)] })
    }
    const offlineRound = releasedEvents.length === 0
      && anyFailed
      && this.sources.every(source => source.paused || source.reader.state === 'failed')
    return {
      fusionId: this.spec.id,
      horizonMs: Number.isFinite(horizon ?? Number.NaN) ? horizon : null,
      releasedEvents,
      batches,
      offlineRound,
      perSource: this.sources.map(source => this.reportOf(source)),
    }
  }

  /** Tear every reader down; the fusion is spent afterwards. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.all(this.sources.map(async source => source.reader.close()))
  }

  /**
   * The fused horizon: the minimum coverage bound over conclusive sources.
   * A live (or held — queue fullness is backpressure, not a stall) source
   * with at least one received event is conclusive up to its maximum
   * received event time. An ended source is conclusive forever (+∞): it can
   * never deliver late data again. Paused, failed, and not-yet-delivering
   * sources are inconclusive and skipped. Returns null when no source
   * bounds the horizon — either nothing is conclusive, or every conclusive
   * source has ended, in which case release is unbounded.
   */
  private horizonBoundMs(): number | null {
    let bounded = false
    let sawFinite = false
    let horizon = Number.POSITIVE_INFINITY
    for (const source of this.sources) {
      if (source.paused || source.reader.state === 'failed') continue
      if (source.reader.state === 'ended') {
        bounded = true
        continue
      }
      if (source.maxReceivedEventTimeMs === null) continue
      bounded = true
      sawFinite = true
      if (source.maxReceivedEventTimeMs < horizon) {
        horizon = source.maxReceivedEventTimeMs
      }
    }
    if (!bounded) return null
    return sawFinite ? horizon : Number.POSITIVE_INFINITY
  }

  private sourceOf(sourceId: string): BoundSource {
    const source = this.sources.find(entry => entry.sourceId === sourceId)
    if (source === undefined) {
      throw new Error(`the fusion does not bind source "${sourceId}"`)
    }
    return source
  }

  private reportOf(source: BoundSource): FusionSourceReport {
    let state: FusionSourceState
    if (source.paused) {
      state = 'paused'
    } else if (source.reader.state === 'ended') {
      state = 'ended'
    } else if (source.reader.state === 'failed') {
      state = 'offline'
    } else if (source.pending.length >= source.pendingCapacity) {
      state = 'held'
    } else {
      state = 'live'
    }    return {
      sourceId: source.sourceId,
      state,
      lastOutcome: source.lastOutcome,
      detail: source.lastDetail,
      pendingLength: source.pending.length + source.overflow.length,
      received: source.received,
      rejected: source.rejected,
      released: source.released,
      heldRounds: source.heldRounds,
      failedRounds: source.failedRounds,
    }
  }
}

/** Move overflowed events back into the pending queue as release frees space. */
function drainOverflow(source: BoundSource): void {
  while (source.overflow.length > 0 && source.pending.length < source.pendingCapacity) {
    const entry = source.overflow.shift()
    if (entry === undefined) break
    source.pending.push(entry)
  }
}
