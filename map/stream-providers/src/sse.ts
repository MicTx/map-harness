/**
 * The `sse` source family: a standard Server-Sent-Events endpoint read as a
 * real stream. Each dispatched SSE data payload is one wire event object (or
 * an array of them) in the {@link WireEvent} shape; valid-JSON payloads that
 * fail the event shape are counted per-source rejections (data quality,
 * visible, never silent), while framing violations — oversized lines,
 * non-UTF-8 bytes, truncated frames — close the channel with the
 * `stream-violated` outcome.
 *
 * The reader opens lazily at its first read round (the credential reference
 * resolves at that execution round, not at load) and reopens after every
 * failed round — at-least-once redelivery is the source contract the fused
 * dedup namespace upstream absorbs. A cleanly ended stream (`source-closed`)
 * is terminal for the reader; reopening it is an explicit operator action.
 *
 * Round state is scoped to the reader, not the round: the framing parser
 * (with its partial frame) and its sink survive round boundaries, so a
 * budget-full round that stopped mid-buffer drains the leftover bytes on
 * the next round before touching the wire again.
 *
 * @module @map-harness/stream-providers/sse
 */
import {
  DEFAULT_EVENTS_PER_FETCH,
  DEFAULT_LINE_BYTES,
  DEFAULT_TIMEOUT_MS,
  type SseSourceSpec,
} from './contract.ts'
import { StreamChannel, SseFrameParser, StreamFrameViolation, parseWirePayload, type ChannelFailure, type WireEvent } from './reader.ts'

/** What one bounded read round reported for one source. */
export interface SourceRoundReport {
  /** The channel is open and readable after this round. */
  readonly live: boolean
  /** Wire events the round collected, in wire order. */
  readonly events: readonly WireEvent[]
  /** Valid-JSON payloads that failed the event shape this round. */
  readonly rejected: number
  /** The source's readable side ended cleanly this round. */
  readonly ended: boolean
  /** The channel died or was violated this round; the next round reopens. */
  readonly failure?: ChannelFailure
}

/** The terminal states a reader holds between rounds. */
export type ReaderState = 'unopened' | 'live' | 'ended' | 'failed'

/** Options one source reader honors. */
export interface SourceReaderOptions {
  /** Caller cancellation threaded to every open exchange and read round. */
  readonly signal?: AbortSignal
  /** Per-round deadline override; the spec default applies when omitted. */
  readonly timeoutMs?: number
  /** Per-round event-budget override; the spec default applies when omitted. The fusion engine passes the source's remaining pending capacity. */
  readonly maxEventsPerFetch?: number
}

/**
 * One SSE endpoint reader. Holds one channel and one framing parser across
 * rounds; owns no state beyond the wire — namespacing, pending queues, and
 * the fused horizon are the fusion engine's.
 */
export class SseSourceReader {
  private channel: StreamChannel | undefined
  private parser: SseFrameParser | undefined
  private stateValue: ReaderState = 'unopened'
  private lastFailure: ChannelFailure | undefined
  private roundEvents: WireEvent[] = []
  private roundRejected = 0

  private readonly specValue: SseSourceSpec
  private readonly resolveCredential: () => string | undefined

  constructor(spec: SseSourceSpec, resolveCredential: () => string | undefined) {
    this.specValue = spec
    this.resolveCredential = resolveCredential
  }

  /** The reader's terminal state; `live` names an open channel. */
  get state(): ReaderState {
    return this.stateValue
  }

  /** The last failure a round carried, sanitized; present in state `failed`. */
  get failure(): ChannelFailure | undefined {
    return this.lastFailure
  }

  /** Run one bounded read round: open (or reopen) as needed, then read up to the round budget. */
  async readRound(options?: SourceReaderOptions): Promise<SourceRoundReport> {
    if (this.stateValue === 'ended') {
      return { live: false, events: [], rejected: 0, ended: true }
    }
    if (this.stateValue !== 'live') {
      const opened = await this.open(options)
      if (!opened.ok) {
        this.stateValue = 'failed'
        this.lastFailure = opened.failure
        return { live: false, events: [], rejected: 0, ended: false, failure: opened.failure }
      }
      this.stateValue = 'live'
      this.lastFailure = undefined
    }
    const budget = options?.maxEventsPerFetch ?? this.specValue.maxEventsPerFetch ?? DEFAULT_EVENTS_PER_FETCH
    const maxLineBytes = this.specValue.maxLineBytes ?? DEFAULT_LINE_BYTES
    this.roundEvents = []
    this.roundRejected = 0
    const parser = this.parser ??= new SseFrameParser(maxLineBytes, {
      onData: payload => {
        const parsed = parseWirePayload(payload)
        if (!parsed.ok) {
          if (parsed.kind === 'shape') this.roundRejected += 1
          else throw new StreamFrameViolation(parsed.problem)
        } else {
          this.roundEvents.push(...parsed.events)
        }
        return this.roundEvents.length >= budget
      },
    })
    // A previous round that stopped mid-buffer leaves parsed-but-undispatched
    // bytes behind; drain them before asking the wire for more.
    if (parser.resume()) {
      return { live: true, events: this.roundEvents, rejected: this.roundRejected, ended: false }
    }
    const timeoutMs = options?.timeoutMs ?? this.specValue.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let round: Awaited<ReturnType<StreamChannel['readRound']>>
    try {
      round = await this.channel!.readRound(timeoutMs, chunk => parser.feed(chunk))
    } catch (error) {
      // A framing violation surfaced inside feed(): the channel is dead by contract.
      await this.closeChannel()
      this.stateValue = 'failed'
      const failure: ChannelFailure = error instanceof StreamFrameViolation
        ? { outcome: 'stream-violated', detail: bounded(error) }
        : { outcome: 'unreachable', detail: bounded(error) }
      this.lastFailure = failure
      return { live: false, events: this.roundEvents, rejected: this.roundRejected, ended: false, failure }
    }
    if (round.failure !== undefined) {
      await this.closeChannel()
      this.stateValue = 'failed'
      this.lastFailure = round.failure
      return { live: false, events: this.roundEvents, rejected: this.roundRejected, ended: false, failure: round.failure }
    }
    if (round.ended) {
      try {
        parser.finish()
      } catch (error) {
        await this.closeChannel()
        this.stateValue = 'failed'
        const failure: ChannelFailure = { outcome: 'stream-violated', detail: bounded(error) }
        this.lastFailure = failure
        return { live: false, events: this.roundEvents, rejected: this.roundRejected, ended: false, failure }
      }
      await this.closeChannel()
      this.stateValue = 'ended'
      this.lastFailure = undefined
      return { live: false, events: this.roundEvents, rejected: this.roundRejected, ended: true }
    }
    return { live: true, events: this.roundEvents, rejected: this.roundRejected, ended: false }
  }

  /** Tear the channel down; the reader returns to `unopened` (a later round reopens the endpoint). */
  async close(): Promise<void> {
    await this.closeChannel()
    this.parser = undefined
    if (this.stateValue !== 'ended') this.stateValue = 'unopened'
  }

  /** Open (or reopen) the endpoint; the credential reference resolves at this execution round. */
  private async open(options?: SourceReaderOptions): Promise<{ ok: true } | { ok: false; failure: ChannelFailure }> {
    await this.closeChannel()
    const headers: Record<string, string> = { accept: 'text/event-stream' }
    const credential = this.resolveCredential()
    if (credential !== undefined) headers.authorization = `Bearer ${credential}`
    const timeoutMs = options?.timeoutMs ?? this.specValue.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const opened = await StreamChannel.open({
      url: this.specValue.url,
      headers,
      timeoutMs,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      expectedContentType: 'text/event-stream',
    })
    if (opened.ok) {
      this.channel = opened.channel
      this.parser = undefined
    }
    return opened.ok ? { ok: true } : { ok: false, failure: opened.failure }
  }

  private async closeChannel(): Promise<void> {
    const channel = this.channel
    this.channel = undefined
    if (channel !== undefined) await channel.close()
  }
}

/** Render one caught error as a bounded reason. */
function bounded(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const first = message.split('\n', 1)[0] ?? 'unknown error'
  const pathless = first.replace(/(?:[A-Za-z]:[\\/]|\/)[^ \t]*/g, '<path>')
  return pathless.length > 160 ? `${pathless.slice(0, 159)}…` : pathless
}
