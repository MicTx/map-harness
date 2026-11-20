/**
 * The `completions` source family: an OpenAI-compatible streaming chat
 * completions endpoint used as a real event relay. The fixed relay
 * instruction tells the model to stream newline-delimited JSON events in the
 * {@link WireEvent} shape; each SSE chunk's token delta is appended to a
 * line accumulator, and every complete line is parsed as one event (or an
 * array of events).
 *
 * The honest split between protocol and narration: an SSE framing violation,
 * a non-JSON chunk payload, or a chunk carrying an `error` object violates
 * the stream (`stream-violated`) — those are transport protocol. A completed
 * line that is not JSON or fails the event shape is a *narration* miss:
 * counted in the source's rejection counter, never fatal, because a model is
 * an imperfect relay by nature and the counters make every miss visible.
 * `data: [DONE]` (or a clean stream end) ends the source
 * (`source-closed`).
 *
 * The API key is resolved from the by-name credential reference at the
 * execution round that opens the channel, so a rotated cc-switch entry is
 * picked up on the next reopen; the value never leaves the reader's memory.
 * The line accumulator and the `[DONE]` marker survive round boundaries, so
 * a relay line split across rounds still completes.
 *
 * @module @map-harness/stream-providers/completions
 */
import {
  DEFAULT_EVENTS_PER_FETCH,
  DEFAULT_LINE_BYTES,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  type CompletionsSourceSpec,
} from './contract.ts'
import { StreamChannel, SseFrameParser, StreamFrameViolation, parseWirePayload, type ChannelFailure, type WireEvent } from './reader.ts'
import type { SourceReaderOptions, SourceRoundReport, ReaderState } from './sse.ts'

/** Default anchor for monotonically increasing relay event times. */
export const DEFAULT_EVENT_TIME_BASE_MS = 0

/**
 * The fixed relay instruction every completions source sends. Only the
 * deployment's seed topic and event-time base vary; the output contract
 * (one JSON object per line, exact field names, WGS84, finite values,
 * monotone times) is part of the protocol, not the prompt.
 */
export function completionsRelayInstruction(topic: string, eventTimeBaseMs: number): string {
  const subject = topic.trim().length > 0 ? topic : 'a moving geospatial scene of your choosing'
  return [
    'You are a live geospatial event relay. You emit a continuous stream of events as newline-delimited JSON: one JSON object per line, no prose, no markdown, no code fences, no explanations.',
    'Every line is exactly this shape: {"eventId":string,"eventTimeMs":number,"lon":number,"lat":number,"value":number}.',
    `eventTimeMs must be a monotonically increasing integer starting at ${String(Math.trunc(eventTimeBaseMs))} and advancing about 1000 per event.`,
    'lon/lat are finite WGS84 coordinates (lon in [-180,180], lat in [-90,90]) tracking the subject below; value is a finite number measuring it.',
    `Subject: ${subject}`,
    'Begin streaming events now, one per line, and keep going until the token budget ends.',
  ].join('\n')
}

/** One assembled streaming chunk the OpenAI-compatible wire carries. */
interface CompletionsChunk {
  readonly choices?: ReadonlyArray<{ readonly delta?: { readonly content?: unknown } }>
  readonly error?: { readonly message?: unknown }
}

/**
 * One completions relay reader. Same round discipline as the SSE family:
 * lazy open at the first round, reopen after failures (at-least-once), a
 * clean `[DONE]`/stream end is terminal.
 */
export class CompletionsSourceReader {
  private channel: StreamChannel | undefined
  private parser: SseFrameParser | undefined
  private stateValue: ReaderState = 'unopened'
  private lastFailure: ChannelFailure | undefined
  private roundEvents: WireEvent[] = []
  private roundRejected = 0
  private roundBudget = DEFAULT_EVENTS_PER_FETCH
  private done = false
  private lineBuffer = ''
  private lineBytes = 0

  private readonly specValue: CompletionsSourceSpec
  private readonly resolveCredential: () => string

  constructor(spec: CompletionsSourceSpec, resolveCredential: () => string) {
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
    const budget = this.roundBudget = options?.maxEventsPerFetch ?? this.specValue.maxEventsPerFetch ?? DEFAULT_EVENTS_PER_FETCH
    const maxLineBytes = this.specValue.maxLineBytes ?? DEFAULT_LINE_BYTES
    this.roundEvents = []
    this.roundRejected = 0
    const parser = this.parser ??= new SseFrameParser(maxLineBytes, {
      onData: payload => {
        if (payload === '[DONE]') {
          this.done = true
          return true
        }
        let chunk: CompletionsChunk
        try {
          chunk = JSON.parse(payload) as CompletionsChunk
        } catch (error) {
          throw new StreamFrameViolation(`a completions chunk payload is not JSON (${bounded(error)})`)
        }
        if (chunk.error !== undefined) {
          const message = typeof chunk.error.message === 'string' ? bounded({ message: chunk.error.message }).slice(0, 160) : 'the endpoint reported a relay error'
          throw new StreamFrameViolation(`the endpoint reported a relay error: ${message}`)
        }
        const delta = chunk.choices?.[0]?.delta?.content
        if (typeof delta !== 'string' || delta.length === 0) {
          return this.roundEvents.length >= budget
        }
        this.lineBuffer += delta
        this.lineBytes += byteLength(delta)
        if (this.lineBytes > maxLineBytes) {
          throw new StreamFrameViolation(`an assembled relay line exceeded the ${String(maxLineBytes)}-byte cap`)
        }
        let newline = this.lineBuffer.indexOf('\n')
        while (newline !== -1) {
          const line = this.lineBuffer.slice(0, newline).replace(/\r$/, '')
          this.lineBuffer = this.lineBuffer.slice(newline + 1)
          if (this.consumeLine(line)) return true
          newline = this.lineBuffer.indexOf('\n')
        }
        return this.roundEvents.length >= budget
      },
    })
    // Drain bytes a budget-full round left mid-buffer before reading the wire.
    if (parser.resume()) {
      if (this.done) {
        await this.closeChannel()
        this.stateValue = 'ended'
        this.lastFailure = undefined
        return { live: false, events: this.roundEvents, rejected: this.roundRejected, ended: true }
      }
      return { live: true, events: this.roundEvents, rejected: this.roundRejected, ended: false }
    }
    const timeoutMs = options?.timeoutMs ?? this.specValue.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let round: Awaited<ReturnType<StreamChannel['readRound']>>
    try {
      round = await this.channel!.readRound(timeoutMs, chunk => parser.feed(chunk))
    } catch (error) {
      await this.closeChannel()
      this.stateValue = 'failed'
      const failure: ChannelFailure = error instanceof StreamFrameViolation
        ? { outcome: 'stream-violated', detail: bounded(error) }
        : { outcome: 'unreachable', detail: bounded(error) }
      this.lastFailure = failure
      return { live: false, events: this.roundEvents, rejected: this.roundRejected, ended: false, failure }
    }
    if (this.done) {
      await this.closeChannel()
      this.stateValue = 'ended'
      this.lastFailure = undefined
      return { live: false, events: this.roundEvents, rejected: this.roundRejected, ended: true }
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
        if (this.lineBuffer !== '') this.consumeLine(this.lineBuffer.replace(/\r$/, ''))
        this.lineBuffer = ''
        this.lineBytes = 0
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

  /** Tear the channel down; the reader returns to `unopened`. */
  async close(): Promise<void> {
    await this.closeChannel()
    this.parser = undefined
    if (this.stateValue !== 'ended') this.stateValue = 'unopened'
  }

  /** Consume one assembled relay line; returns true when the round budget is full. */
  private consumeLine(line: string): boolean {
    if (line === '') return this.roundEvents.length >= this.roundBudget
    const parsed = parseWirePayload(line)
    if (!parsed.ok) {
      // A narration miss: counted, visible, never fatal to the channel.
      this.roundRejected += 1
    } else {
      this.roundEvents.push(...parsed.events)
    }
    return this.roundEvents.length >= this.roundBudget
  }

  /** Open (or reopen) the relay; the API key resolves at this execution round. */
  private async open(options?: SourceReaderOptions): Promise<{ ok: true } | { ok: false; failure: ChannelFailure }> {
    await this.closeChannel()
    const credential = this.resolveCredential()
    const maxTokens = this.specValue.maxTokens ?? DEFAULT_MAX_TOKENS
    const base = this.specValue.eventTimeBaseMs ?? DEFAULT_EVENT_TIME_BASE_MS
    const body = JSON.stringify({
      model: this.specValue.model,
      stream: true,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: completionsRelayInstruction(this.specValue.prompt ?? '', base) },
      ],
    })
    const timeoutMs = options?.timeoutMs ?? this.specValue.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const opened = await StreamChannel.open({
      url: this.specValue.url,
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      timeoutMs,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      expectedContentType: 'text/event-stream',
      body,
    })
    if (opened.ok) {
      this.channel = opened.channel
      this.parser = undefined
      this.done = false
      this.lineBuffer = ''
      this.lineBytes = 0
    }
    return opened.ok ? { ok: true } : { ok: false, failure: opened.failure }
  }

  private async closeChannel(): Promise<void> {
    const channel = this.channel
    this.channel = undefined
    if (channel !== undefined) await channel.close()
  }
}

/** UTF-8 byte length of one string without materializing the encoding. */
function byteLength(text: string): number {
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else {
      bytes += 4
      index += 1
    }
  }
  return bytes
}

/** Render one caught error or thrown object as a bounded reason. */
function bounded(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string'
    ? (error as { message: string }).message
    : String(error)
  const first = message.split('\n', 1)[0] ?? 'unknown error'
  const pathless = first.replace(/(?:[A-Za-z]:[\\/]|\/)[^ \t]*/g, '<path>')
  return pathless.length > 160 ? `${pathless.slice(0, 159)}…` : pathless
}
