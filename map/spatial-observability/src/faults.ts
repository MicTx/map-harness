/**
 * The deterministic fault-injection matrix. The failure points the tasks
 * name — flush, artifact publish, provider, worker, render — each arm with a
 * closed error code, a fixed failure count, and an audited record; when the
 * count exhausts (or an operator resets), the point disarms and the same
 * call site replays through to the real function. Inject → fail → replay →
 * recover is therefore a deterministic, auditable sequence, never a sleep
 * or a guess.
 *
 * Rules:
 *
 * - **Injection replaces the call exactly once.** An armed `hit` throws the
 *   coded {@link ObsFaultError} without invoking the real function; a
 *   disarmed `hit` invokes it and rethrows its original failure untouched.
 * - **Every injection is audit evidence.** Each hit appends to the bounded
 *   injection record and (via the listener) to the runtime's audit log; a
 *   `PROVIDER_RATE_LIMITED` injection additionally counts on the rate-limit
 *   metric series.
 * - **Codes stay on the closed matrix.** Each point has a default code; an
 *   override must still come from the closed error-code set.
 *
 * @module @map-harness/spatial-observability/faults
 */
import {
  assertInVocabulary,
  OBS_ERROR_CODE_LIST,
  OBS_FAULT_POINTS,
  OBS_FAULT_POINT_CODES,
  type ObsCorrelation,
  type ObsErrorCode,
  type ObsFaultPoint,
} from './contract.ts'

/** One recorded fault injection (bounded history; audit evidence). */
export interface ObsFaultInjection {
  /** Monotonic 1-based injection index within one matrix. */
  readonly seq: number
  readonly point: ObsFaultPoint
  readonly code: ObsErrorCode
  /** Remaining armed failures on the point *after* this injection. */
  readonly remaining: number
  readonly atMs: number
  /** The ambient correlation at injection time, when one was active. */
  readonly correlation?: ObsCorrelation
}

/** Listener for audited injections (the runtime wires its audit log here). */
export type ObsFaultListener = (injection: ObsFaultInjection) => void

/** The coded error an armed injection throws; call sites catch, classify, and recover. */
export class ObsFaultError extends Error {
  /** The closed error code this injection carries. */
  readonly code: ObsErrorCode
  /** The fault point that injected the failure. */
  readonly point: ObsFaultPoint
  /** Whether the point is still armed after this injection. */
  readonly stillArmed: boolean

  /** @internal built only by the fault matrix. */
  constructor(point: ObsFaultPoint, code: ObsErrorCode, message: string, stillArmed: boolean) {
    super(message)
    this.name = 'ObsFaultError'
    this.code = code
    this.point = point
    this.stillArmed = stillArmed
  }
}

/** One bounded fault-injection matrix over the closed points. */
export class ObsFaultMatrix {
  private readonly clock: () => number
  private readonly historyCapacity: number
  private readonly onInjection: ObsFaultListener | undefined
  private readonly armed = new Map<ObsFaultPoint, { remaining: number; code: ObsErrorCode; message?: string }>()
  private records: ObsFaultInjection[] = []
  private nextSeq = 1

  /**
   * @param options - `clock` overrides `Date.now`; `historyCapacity` bounds the
   *   injection record (default 256); `onInjection` receives every injection.
   */
  constructor(options: { clock?: () => number; historyCapacity?: number; onInjection?: ObsFaultListener } = {}) {
    this.clock = options.clock ?? (() => Date.now())
    this.historyCapacity = options.historyCapacity ?? 256
    this.onInjection = options.onInjection
  }

  /**
   * Arm one fault point.
   * @param point - the closed fault point.
   * @param options - `times` (how many failures inject before auto-disarm, default 1),
   *   `code` (closed override of the point's default code), `message` (short failure text).
   * @throws when the point is already armed or `times` is not a positive integer.
   */
  arm(point: ObsFaultPoint, options: { times?: number; code?: ObsErrorCode; message?: string } = {}): void {
    assertInVocabulary(point, OBS_FAULT_POINTS, 'fault point')
    if (options.code !== undefined) assertInVocabulary(options.code, OBS_ERROR_CODE_LIST, 'fault code')
    const times = options.times ?? 1
    if (!Number.isInteger(times) || times < 1) throw new Error(`fault times must be a positive integer, got ${String(times)}`)
    if (this.armed.has(point)) throw new Error(`fault point "${point}" is already armed; reset it first`)
    this.armed.set(point, {
      remaining: times,
      code: options.code ?? OBS_FAULT_POINT_CODES[point],
      ...(options.message === undefined ? {} : { message: options.message }),
    })
  }

  /** Whether the point is currently armed (would inject on the next hit). */
  isArmed(point: ObsFaultPoint): boolean {
    return this.armed.has(point)
  }

  /**
   * Route one call through its fault point. Armed → inject the coded failure
   * (the real function never runs). Disarmed → invoke the real function;
   * its own failure propagates untouched.
   * @param point - the closed fault point.
   * @param invoke - the real call.
   * @param options - `correlation` attaches the ambient scope to the audit record.
   * @returns the real call's result.
   * @throws {@link ObsFaultError} when armed; otherwise whatever `invoke` throws.
   */
  hit<T>(point: ObsFaultPoint, invoke: () => T, options: { correlation?: ObsCorrelation } = {}): T {
    assertInVocabulary(point, OBS_FAULT_POINTS, 'fault point')
    const armedState = this.armed.get(point)
    if (armedState === undefined) return invoke()
    const remaining = armedState.remaining - 1
    if (remaining <= 0) this.armed.delete(point)
    else armedState.remaining = remaining
    const injection: ObsFaultInjection = {
      seq: this.nextSeq++,
      point,
      code: armedState.code,
      remaining: Math.max(remaining, 0),
      atMs: this.clock(),
      ...(options.correlation === undefined ? {} : { correlation: options.correlation }),
    }
    this.records.push(injection)
    if (this.records.length > this.historyCapacity) this.records.shift()
    this.onInjection?.(injection)
    const message = armedState.message ?? `injected fault at "${point}" (${armedState.code})`
    throw new ObsFaultError(point, armedState.code, message, remaining > 0)
  }

  /** Operator-initiated disarm of one point (recovery without exhausting the count). */
  reset(point: ObsFaultPoint): void {
    this.armed.delete(point)
  }

  /** Operator-initiated disarm of every point. */
  resetAll(): void {
    this.armed.clear()
  }

  /** The bounded injection record, oldest first (audit evidence). */
  injections(): readonly ObsFaultInjection[] {
    return this.records
  }
}
