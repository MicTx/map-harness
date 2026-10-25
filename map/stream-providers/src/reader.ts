/**
 * The shared real-stream reader core: one HTTP(S) streaming channel opened
 * over `fetch`, read in bounded rounds, and framed as SSE. Both source
 * families ride this core — an `sse` source interprets each data payload as
 * wire events directly, a `completions` relay interprets it as one OpenAI
 * streaming chunk and assembles token deltas into NDJSON event lines.
 *
 * The round discipline is the contract: every round is bounded by a
 * wall-clock deadline and the parser's event budget, and a round that
 * expires with the wire quiet *parks* its in-flight read instead of
 * aborting it — the next round resumes that exact read, so a quiet stream
 * is held open, never killed. Teardown (`close`) is the only thing that
 * aborts, and it settles the parked read first.
 *
 * Mid-stream channel death maps to the `unreachable` outcome family (the
 * channel could not be — or ceased to be — established); framing and
 * payload-protocol violations map to `stream-violated`. Credential material
 * never reaches this module's diagnostics.
 *
 * @module @map-harness/stream-providers/reader
 */
import { eventProblem } from '@map-harness/spatial-realtime'
import { boundDetail, type StreamReadOutcome } from './contract.ts'

/** Marker the open-timeout abort carries, so a timeout never masquerades as a caller abort. */
class OpenTimeout extends Error {
  constructor() {
    super('open deadline expired')
    this.name = 'OpenTimeout'
  }
}

/** The failure outcomes an open or a read round can carry (never `streaming`/`source-closed`). */
export type ChannelOutcome = Exclude<StreamReadOutcome, 'streaming' | 'source-closed'>

/** One classified channel failure. */
export interface ChannelFailure {
  readonly outcome: ChannelOutcome
  readonly detail: string
}

/** Options one channel open honors. */
export interface OpenChannelOptions {
  /** Endpoint URL (already validated by the contract). */
  readonly url: string
  /** Request headers; the caller owns Authorization. */
  readonly headers: Readonly<Record<string, string>>
  /** Wall-clock deadline for the open exchange. */
  readonly timeoutMs: number
  /** Caller cancellation; an already-aborted signal yields the `aborted` outcome. */
  readonly signal?: AbortSignal
  /** The `Content-Type` prefix the endpoint must answer with. */
  readonly expectedContentType: string
  /** Request body, when the family POSTs. */
  readonly body?: string
}

/** The bounded result of one read round. */
export interface RoundResult {
  /** The channel's readable side completed cleanly. */
  readonly ended: boolean
  /** The round deadline expired with the wire quiet; the parked read survives. */
  readonly timedOut: boolean
  /** The channel died or was violated this round; it is closed and will not reopen itself. */
  readonly failure?: ChannelFailure
}

/** Sleep for the given milliseconds; the caller races it against real work. */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

/** One open streaming channel: a body reader with a parked-read round loop and quiescent teardown. */
export class StreamChannel {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly abort: AbortController
  private readonly response: Response
  private inFlight: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
  private closed = false

  private constructor(response: Response, reader: ReadableStreamDefaultReader<Uint8Array>, abort: AbortController) {
    this.response = response
    this.reader = reader
    this.abort = abort
  }

  /** Whether teardown already closed this channel. */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * Open one SSE-framed channel: fetch with a bounded deadline, classify
   * every refusal to the outcome vocabulary, and require the expected
   * streaming content type.
   */
  static async open(options: OpenChannelOptions): Promise<{ ok: true; channel: StreamChannel } | { ok: false; failure: ChannelFailure }> {
    if (options.signal?.aborted) {
      return { ok: false, failure: { outcome: 'aborted', detail: 'the caller aborted before the channel opened' } }
    }
    const timeout = new AbortController()
    const timer = setTimeout(() => timeout.abort(new OpenTimeout()), options.timeoutMs)
    const forwardAbort = (): void => {
      if (options.signal?.aborted) timeout.abort(options.signal.reason)
    }
    options.signal?.addEventListener('abort', forwardAbort, { once: true })
    let response: Response
    try {
      response = await fetch(options.url, {
        method: options.body === undefined ? 'GET' : 'POST',
        headers: options.headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal: timeout.signal,
        redirect: 'error',
      })
    } catch (error) {
      if (options.signal?.aborted) {
        return { ok: false, failure: { outcome: 'aborted', detail: 'the caller aborted the open exchange' } }
      }
      if (timeout.signal.reason instanceof OpenTimeout) {
        return { ok: false, failure: { outcome: 'timeout', detail: `the endpoint did not answer within ${String(options.timeoutMs)} ms` } }
      }
      return { ok: false, failure: { outcome: 'unreachable', detail: boundDetail(describe(error)) } }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', forwardAbort)
    }
    if (response.status === 401 || response.status === 403) {
      await discardBody(response)
      return { ok: false, failure: { outcome: 'auth-rejected', detail: `the endpoint answered ${String(response.status)} for the presented credential` } }
    }
    if (!response.ok) {
      await discardBody(response)
      return { ok: false, failure: { outcome: 'http-error', detail: `the endpoint answered HTTP ${String(response.status)} ${response.statusText}`.trim() } }
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (!contentType.toLowerCase().startsWith(options.expectedContentType.toLowerCase())) {
      await discardBody(response)
      return { ok: false, failure: { outcome: 'content-type-violated', detail: `the endpoint answered content-type "${contentType.slice(0, 64)}", expected ${options.expectedContentType}` } }
    }
    if (response.body === null) {
      return { ok: false, failure: { outcome: 'stream-violated', detail: 'the endpoint answered 2xx with no response body' } }
    }
    return { ok: true, channel: new StreamChannel(response, response.body.getReader(), timeout) }
  }

  /**
   * Run one bounded read round: consume chunks until the parser's budget is
   * full (`onChunk` returns true), the round deadline expires (the in-flight
   * read is parked, not aborted), or the stream ends or dies.
   * @param timeoutMs - the whole-round wall-clock budget.
   * @param onChunk - one raw chunk; returns true when the round's event budget is full.
   */
  async readRound(timeoutMs: number, onChunk: (chunk: Uint8Array) => boolean): Promise<RoundResult> {
    if (this.closed) {
      return { ended: true, timedOut: false }
    }
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (this.inFlight === undefined) this.inFlight = this.reader.read()
      const remaining = deadline - Date.now()
      let settled: ReadableStreamReadResult<Uint8Array> | undefined
      try {
        const winner = await Promise.race([
          this.inFlight.then(read => ({ read })),
          sleep(Math.max(remaining, 1)).then(() => 'quiet' as const),
        ])
        if (winner === 'quiet') {
          if (Date.now() >= deadline) {
            return { ended: false, timedOut: true }
          }
          continue
        }
        settled = winner.read
      } catch (error) {
        this.inFlight = undefined
        this.closed = true
        if (this.abort.signal.aborted) {
          return { ended: true, timedOut: false }
        }
        return { ended: true, timedOut: false, failure: { outcome: 'unreachable', detail: boundDetail(describe(error)) } }
      }
      this.inFlight = undefined
      if (settled.done) {
        this.closed = true
        return { ended: true, timedOut: false }
      }
      if (onChunk(settled.value)) {
        return { ended: false, timedOut: false }
      }
    }
  }

  /**
   * Tear the channel down quiescently: cancel the body reader (which
   * settles any parked read), then abort the fetch so no socket outlives
   * the source. Safe to call more than once.
   */
  async close(): Promise<void> {
    if (this.abort.signal.aborted) return
    this.abort.abort(new Error('channel teardown'))
    const parked = this.inFlight
    this.inFlight = undefined
    try {
      await this.reader.cancel()
    } catch {
      // A reader that already errored refuses cancel; the abort below still owns the socket.
    }
    if (parked !== undefined) {
      try {
        await parked
      } catch {
        // The parked read rejects on teardown by design; it is settled now.
      }
    }
    this.closed = true
    void this.response
  }
}

/** Drain and discard one refused response's body so the socket is released. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // A body that already errored cannot be cancelled; nothing is leaked by trying.
  }
}

/** Render one caught error as a bounded reason (no paths, no credential material). */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const first = message.split('\n', 1)[0] ?? 'unknown error'
  const pathless = first.replace(/(?:[A-Za-z]:[\\/]|\/)[^ \t]*/g, '<path>')
  return pathless.length > 160 ? `${pathless.slice(0, 159)}…` : pathless
}

/** One parsed wire event in the shape the spatial-realtime runtime consumes. */
export interface WireEvent {
  readonly eventId: string
  readonly eventTimeMs: number
  readonly lon: number
  readonly lat: number
  readonly value: number
}

/** The result of interpreting one SSE data payload as wire events. */
export type PayloadParse =
  | { ok: true; events: WireEvent[] }
  | { ok: false; kind: 'shape'; problem: string }
  | { ok: false; kind: 'json'; problem: string }

/**
 * Parse one SSE data payload as wire events: a single event object or an
 * array of event objects. A payload that is valid JSON but fails the event
 * shape is a *data-quality* miss (`shape`, counted by the source); a payload
 * that is not JSON at all is a framing miss (`json`, a stream violation for
 * the completions family, where SSE data must always be a protocol chunk).
 */
export function parseWirePayload(payload: string): PayloadParse {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch (error) {
    return { ok: false, kind: 'json', problem: `payload is not JSON (${describe(error)})` }
  }
  const candidates = Array.isArray(value) ? value : [value]
  const events: WireEvent[] = []
  for (const candidate of candidates) {
    const problem = eventProblem(candidate)
    if (problem !== null) {
      return { ok: false, kind: 'shape', problem }
    }
    events.push(candidate as WireEvent)
  }
  return { ok: true, events }
}

/** The sink one SSE framing parser feeds; returns true when the round's event budget is full. */
export interface FrameSink {
  /** One complete SSE data payload (multi-line data joined with `\n`). */
  onData(payload: string): boolean
}

/**
 * The SSE framing parser: bytes in, complete data payloads out. Lines split
 * on `\n` (with `\r` stripped) at the *byte* level so the line-byte cap is
 * exact and multi-byte UTF-8 never splits a character; comment lines (`:`)
 * and non-data fields (`event:`, `id:`, `retry:`) are ignored; a blank line
 * dispatches the accumulated frame. A partial line over the byte cap, a
 * non-UTF-8 line, or a truncated final frame violates the stream.
 */
export class SseFrameParser {
  private buffer = new Uint8Array(0)
  private readonly dataLines: string[] = []
  private frameBytes = 0
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true })

  private readonly maxLineBytes: number
  private readonly sink: FrameSink

  constructor(maxLineBytes: number, sink: FrameSink) {
    this.maxLineBytes = maxLineBytes
    this.sink = sink
  }

  /** Feed one chunk of bytes; returns true when the sink's event budget is full. */
  feed(chunk: Uint8Array): boolean {
    const merged = new Uint8Array(this.buffer.length + chunk.length)
    merged.set(this.buffer)
    merged.set(chunk, this.buffer.length)
    this.buffer = merged
    return this.process()
  }

  /** Continue processing buffered bytes without new wire input; a round whose budget stopped mid-buffer resumes here. */
  resume(): boolean {
    return this.process()
  }

  /** Split buffered bytes into lines and dispatch complete frames; returns true when the sink's budget is full. */
  private process(): boolean {
    let enough = false
    for (;;) {
      const newline = this.buffer.indexOf(0x0a)
      if (newline === -1) {
        if (this.buffer.length > this.maxLineBytes) {
          throw new StreamFrameViolation(`a stream line exceeded the ${String(this.maxLineBytes)}-byte cap`)
        }
        break
      }
      const rawLine = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      if (rawLine.length > this.maxLineBytes) {
        throw new StreamFrameViolation(`a stream line exceeded the ${String(this.maxLineBytes)}-byte cap`)
      }
      let line: string
      try {
        line = this.utf8.decode(withoutTrailingCr(rawLine))
      } catch {
        throw new StreamFrameViolation('a stream line is not valid UTF-8')
      }
      if (line === '') {
        if (this.dataLines.length > 0) {
          enough = this.sink.onData(this.dataLines.join('\n'))
          this.dataLines.length = 0
          this.frameBytes = 0
          if (enough) break
        }
        continue
      }
      if (line.startsWith(':')) continue
      const fieldSeparator = line.indexOf(':')
      const field = fieldSeparator === -1 ? line : line.slice(0, fieldSeparator)
      if (field !== 'data') continue
      const value = fieldSeparator === -1 ? '' : line.slice(fieldSeparator + 1)
      const data = value.startsWith(' ') ? value.slice(1) : value
      this.dataLines.push(data)
      this.frameBytes += data.length
      if (this.frameBytes > this.maxLineBytes) {
        throw new StreamFrameViolation(`an accumulated data frame exceeded the ${String(this.maxLineBytes)}-byte cap`)
      }
    }
    return enough
  }

  /** The readable side ended; a buffered partial frame without its dispatch line violates the stream. */
  finish(): void {
    if (this.buffer.length > 0 || this.dataLines.length > 0) {
      throw new StreamFrameViolation('the stream ended mid-frame (an unterminated line or undispatched data frame)')
    }
  }
}

/** Strip one trailing CR from a raw line (CRLF tolerance at the byte level). */
function withoutTrailingCr(line: Uint8Array): Uint8Array {
  if (line.length > 0 && line[line.length - 1] === 0x0d) return line.subarray(0, -1)
  return line
}

/** One framing or payload-protocol violation; the source maps it to `stream-violated`. */
export class StreamFrameViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamFrameViolation'
  }
}
