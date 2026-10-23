/**
 * The per-plane health plane. No single boolean hides a partial failure: each
 * of the six planes (`process`/`provider`/`catalog`/`run`/`data`/`render`)
 * carries its own status, detail, and last-transition time, and readiness is
 * the *derived* aggregate that names exactly which planes hold it back.
 *
 * - **Transitions are audited.** Every status change appends to a bounded
 *   transition history and to the runtime's audit log, so a flip from
 *   `ready` to `degraded` and back is queryable evidence, not lost state.
 * - **Same-status re-reports refresh the detail** without a new transition.
 * - **The registry never throws** on report/read paths — health is itself a
 *   telemetry surface; a bad detail string is truncated, not fatal.
 *
 * @module @map-harness/spatial-observability/health
 */
import {
  assertInVocabulary,
  MAX_HEALTH_DETAIL_CHARS,
  OBS_HEALTH_PLANES,
  OBS_HEALTH_STATUSES,
  type ObsErrorCode,
  type ObsHealthPlane,
  type ObsHealthStatus,
} from './contract.ts'

/** One plane's current health. */
export interface ObsPlaneHealth {
  readonly plane: ObsHealthPlane
  readonly status: ObsHealthStatus
  /** Short sanitized fact naming why (a code meaning, a lag measure, an operator note). */
  readonly detail: string
  /** Error code, when the status is explained by a closed code. */
  readonly code?: ObsErrorCode
  /** Clock milliseconds of the last status change. */
  readonly sinceMs: number
}

/** The derived readiness aggregate over all six planes. */
export interface ObsReadiness {
  /** True only when every plane reports `ready`. */
  readonly ready: boolean
  readonly planes: Readonly<Record<ObsHealthPlane, ObsPlaneHealth>>
  /** The planes currently holding readiness back, degraded first. */
  readonly heldBack: readonly ObsPlaneHealth[]
}

/** One recorded health transition. */
export interface ObsHealthTransition {
  readonly plane: ObsHealthPlane
  readonly from: ObsHealthStatus
  readonly to: ObsHealthStatus
  readonly detail: string
  readonly code?: ObsErrorCode
  readonly atMs: number
}

/** Callback for audited transitions (the runtime wires its audit log here). */
export type ObsTransitionListener = (transition: ObsHealthTransition) => void

/** One bounded per-plane health registry. */
export class ObsHealthRegistry {
  private readonly clock: () => number
  private readonly historyCapacity: number
  private readonly onTransition: ObsTransitionListener | undefined
  private readonly planes = new Map<ObsHealthPlane, ObsPlaneState>()
  private history: ObsHealthTransition[] = []

  /**
   * @param options - `clock` overrides `Date.now`; `historyCapacity` bounds the
   *   transition history (default 256); `onTransition` receives every change.
   */
  constructor(options: { clock?: () => number; historyCapacity?: number; onTransition?: ObsTransitionListener } = {}) {
    this.clock = options.clock ?? (() => Date.now())
    this.historyCapacity = options.historyCapacity ?? 256
    this.onTransition = options.onTransition
    for (const plane of OBS_HEALTH_PLANES) {
      this.planes.set(plane, { plane, status: 'ready', detail: 'initial', code: undefined, sinceMs: this.clock() })
    }
  }

  /**
   * Report one plane's health. Unknown statuses refuse loudly (a code bug);
   * over-long details truncate to the bounded length.
   * @param plane - the closed plane.
   * @param status - the closed status.
   * @param options - `detail` (short fact, default the status) and `code` (closed error code).
   * @returns the resulting plane health.
   */
  report(plane: ObsHealthPlane, status: ObsHealthStatus, options: { detail?: string; code?: ObsErrorCode } = {}): ObsPlaneHealth {
    assertInVocabulary(plane, OBS_HEALTH_PLANES, 'health plane')
    assertInVocabulary(status, OBS_HEALTH_STATUSES, 'health status')
    const detail = truncateDetail(options.detail ?? status)
    const current = this.planes.get(plane)!
    if (current.status === status) {
      // A same-status refresh rewrites detail and clears a stale code.
      const refreshed: ObsPlaneState = { ...current, detail, code: options.code }
      this.planes.set(plane, refreshed)
      return toPlaneHealth(refreshed)
    }
    const transition: ObsHealthTransition = {
      plane,
      from: current.status,
      to: status,
      detail,
      ...(options.code === undefined ? {} : { code: options.code }),
      atMs: this.clock(),
    }
    this.planes.set(plane, { plane, status, detail, code: options.code, sinceMs: transition.atMs })
    this.history.push(transition)
    if (this.history.length > this.historyCapacity) this.history.shift()
    this.onTransition?.(transition)
    return toPlaneHealth(this.planes.get(plane)!)
  }

  /** One plane's current health. */
  of(plane: ObsHealthPlane): ObsPlaneHealth {
    return toPlaneHealth(this.planes.get(plane)!)
  }

  /**
   * The derived readiness aggregate: `ready` only when all six planes are
   * `ready`; `heldBack` names the degraded and unavailable planes in that order.
   */
  readiness(): ObsReadiness {
    const planes = Object.fromEntries(
      OBS_HEALTH_PLANES.map(plane => [plane, this.of(plane)]),
    ) as Record<ObsHealthPlane, ObsPlaneHealth>
    const heldBack = OBS_HEALTH_PLANES
      .map(plane => planes[plane]!)
      .filter(health => health.status !== 'ready')
      .sort((a, b) => rank(a.status) - rank(b.status))
    return { ready: heldBack.length === 0, planes, heldBack }
  }

  /** The bounded transition history, oldest first. */
  transitions(): readonly ObsHealthTransition[] {
    return this.history
  }
}

/** Internal mutable plane state (the public face is the readonly ObsPlaneHealth). */
interface ObsPlaneState {
  readonly plane: ObsHealthPlane
  status: ObsHealthStatus
  detail: string
  /** Always present internally; `undefined` clears a stale code on refresh. */
  code: ObsErrorCode | undefined
  sinceMs: number
}

function rank(status: ObsHealthStatus): number {
  return status === 'unavailable' ? 0 : status === 'degraded' ? 1 : 2
}

function truncateDetail(detail: string): string {
  return detail.length > MAX_HEALTH_DETAIL_CHARS ? `${detail.slice(0, MAX_HEALTH_DETAIL_CHARS - 1)}…` : detail
}

function toPlaneHealth(value: ObsPlaneState): ObsPlaneHealth {
  return {
    plane: value.plane,
    status: value.status,
    detail: value.detail,
    ...(value.code === undefined ? {} : { code: value.code }),
    sinceMs: value.sinceMs,
  }
}
