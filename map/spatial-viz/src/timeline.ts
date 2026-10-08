/**
 * The deterministic time axis behind a temporal layer: calendar frame
 * enumeration at the binding's granularity in the binding's timezone, the
 * missing-frame marks (`occupied: false` — a gap stays a gap, never an
 * interpolated frame), local frame labels, and the pure play/pause/step state
 * machine the workbench drives.
 *
 * The axis state is plain data with no clock inside it: play advances one
 * frame per `axisAdvance` call from a driver the client owns, so playback
 * never touches a model channel and replays deterministically. A step
 * produces only axis state — no event, no message, no projection write.
 *
 * @module @map-harness/spatial-viz/timeline
 */
import type { TimeBinding, VizGranularity } from './contract.ts'

/** One calendar frame `[startMs, endMs)` with its occupancy mark. */
export interface TimelineFrame {
  readonly startMs: number
  readonly endMs: number
  /** False when no observation falls inside the frame — the 缺测 mark. */
  readonly occupied: boolean
}

/** Upper bound on frames one axis enumerates; a wider window is refused, not truncated. */
export const MAX_TIMELINE_FRAMES = 2000

/** Civil (wall-clock) fields in one IANA timezone. */
interface CivilTime {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
}

/** The named failures the frame enumeration raises instead of truncating or guessing. */
export type TimelineErrorCode = 'invalid-window' | 'unknown-timezone' | 'too-many-frames'

/** The error the frame enumeration raises with its stable code. */
export class TimelineError extends Error {
  readonly code: TimelineErrorCode
  constructor(code: TimelineErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

/** Read the civil wall-clock fields of one epoch in one timezone. */
function civilOf(epochMs: number, timezone: string): CivilTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(new Date(epochMs))
  const read = (type: string): number => {
    const part = parts.find(candidate => candidate.type === type)
    if (part === undefined) throw new TimelineError('unknown-timezone', `timezone ${timezone} produced no ${type} field`)
    return Number(part.value)
  }
  return { year: read('year'), month: read('month'), day: read('day'), hour: read('hour') }
}

/** The UTC epoch a civil wall-clock reading would have if the timezone were UTC. */
function civilAsUtcMs(civil: CivilTime): number {
  return Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour)
}

/** The timezone offset (ms) in effect at one epoch. */
function offsetMs(epochMs: number, timezone: string): number {
  return civilAsUtcMs(civilOf(epochMs, timezone)) - epochMs
}

/**
 * The UTC epoch of one civil wall-clock reading in one timezone. Two
 * correction passes converge except inside a DST fall-back fold, where the
 * earlier instant is returned — a documented tie-break, deterministic per
 * zone rules.
 * @param civil - the wall-clock reading.
 * @param timezone - the IANA zone the reading is in.
 * @returns the epoch milliseconds.
 */
function epochOfCivil(civil: CivilTime, timezone: string): number {
  const asUtc = civilAsUtcMs(civil)
  const firstGuess = asUtc - offsetMs(asUtc, timezone)
  return asUtc - offsetMs(firstGuess, timezone)
}

/** The weekday of one civil date, Monday = 0 … Sunday = 6. */
function weekdayOf(civil: CivilTime): number {
  return (new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay() + 6) % 7
}

/** The civil reading one granularity step after `civil` (calendar arithmetic, fixed-offset-free). */
function nextCivil(civil: CivilTime, granularity: VizGranularity): CivilTime {
  if (granularity === 'hour') {
    return civil.hour === 23
      ? { year: civil.year, month: civil.month, day: civil.day + 1, hour: 0 }
      : { ...civil, hour: civil.hour + 1 }
  }
  if (granularity === 'day') {
    return { year: civil.year, month: civil.month, day: civil.day + 1, hour: 0 }
  }
  if (granularity === 'week') {
    return { year: civil.year, month: civil.month, day: civil.day + 7, hour: 0 }
  }
  return civil.month === 12
    ? { year: civil.year + 1, month: 1, day: 1, hour: 0 }
    : { year: civil.year, month: civil.month + 1, day: 1, hour: 0 }
}

/**
 * Floor one civil reading to its granularity bin start: hour bins keep the
 * hour and drop minutes; day bins drop the hour; week bins floor to Monday;
 * month bins floor to the first.
 */
function floorCivil(civil: CivilTime, granularity: VizGranularity): CivilTime {
  if (granularity === 'hour') return civil
  if (granularity === 'month') return { year: civil.year, month: civil.month, day: 1, hour: 0 }
  if (granularity === 'week') {
    return { year: civil.year, month: civil.month, day: civil.day - weekdayOf(civil), hour: 0 }
  }
  return { ...civil, hour: 0 }
}

/**
 * Enumerate the calendar frames of one time binding over its half-open
 * window, in the binding's timezone, and mark each frame's occupancy against
 * the observed times. A frame with no observation stays in the axis as
 * `occupied: false` — the 缺测 mark; gaps are never filled.
 * @param binding - the validated time binding.
 * @param observedTimesMs - the epoch times observed (any order).
 * @returns the frames in ascending order.
 * @throws {TimelineError} `invalid-window` when the window does not parse or is empty,
 *   `unknown-timezone` when `Intl` cannot format the zone, `too-many-frames` beyond {@link MAX_TIMELINE_FRAMES}.
 */
export function framesOf(binding: TimeBinding, observedTimesMs: readonly number[]): TimelineFrame[] {
  if (typeof binding.timezone !== 'string' || binding.timezone.length === 0) {
    throw new TimelineError('unknown-timezone', 'the time binding carries no timezone')
  }
  const fromMs = Date.parse(binding.window.from)
  const toMs = Date.parse(binding.window.to)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new TimelineError('invalid-window', `window [${binding.window.from}, ${binding.window.to}) does not parse as a non-empty half-open range`)
  }
  let probe = new Date(fromMs)
  try {
    civilOf(probe.getTime(), binding.timezone)
  } catch (error) {
    if (error instanceof RangeError) throw new TimelineError('unknown-timezone', `Intl rejected the timezone ${binding.timezone}`)
    throw error
  }
  const first = epochOfCivil(floorCivil(civilOf(fromMs, binding.timezone), binding.granularity), binding.timezone)
  const sortedObserved = observedTimesMs.filter(ms => Number.isFinite(ms)).toSorted((a, b) => a - b)
  const frames: TimelineFrame[] = []
  let cursor = first
  let observedAt = 0
  while (cursor < toMs) {
    if (frames.length + 1 > MAX_TIMELINE_FRAMES) {
      throw new TimelineError('too-many-frames', `the window holds more than ${MAX_TIMELINE_FRAMES} ${binding.granularity} frames in ${binding.timezone}`)
    }
    const next = epochOfCivil(nextCivil(civilOf(cursor, binding.timezone), binding.granularity), binding.timezone)
    const end = Math.min(next, toMs)
    while (observedAt < sortedObserved.length && (sortedObserved[observedAt] as number) < cursor) observedAt += 1
    const occupied = observedAt < sortedObserved.length && (sortedObserved[observedAt] as number) < end
    frames.push({ startMs: cursor, endMs: end, occupied })
    cursor = next
  }
  return frames
}

/**
 * Format one frame's start as the local civil label: `YYYY-MM` for month
 * bins, `YYYY-MM-DD` for day/week bins, `YYYY-MM-DD HH:00` for hour bins.
 * @param frame - the frame to label.
 * @param timezone - the IANA zone to read the label in.
 * @param granularity - the bin size the label shows.
 * @returns the label text.
 */
export function formatFrameLabel(frame: TimelineFrame, timezone: string, granularity: VizGranularity): string {
  const civil = civilOf(frame.startMs, timezone)
  const date = `${String(civil.year).padStart(4, '0')}-${String(civil.month).padStart(2, '0')}-${String(civil.day).padStart(2, '0')}`
  if (granularity === 'month') return `${String(civil.year).padStart(4, '0')}-${String(civil.month).padStart(2, '0')}`
  if (granularity === 'hour') return `${date} ${String(civil.hour).padStart(2, '0')}:00`
  return date
}

/** The pure time-axis state: current frame, playing flag, visit history, and change count. */
export interface TimeAxisState {
  readonly frames: readonly TimelineFrame[]
  readonly index: number
  readonly playing: boolean
  /** Every frame index the axis showed, ascending, unique — the visit history. */
  readonly visited: readonly number[]
  /** How many times the shown frame changed; a pure counter, never a clock. */
  readonly changeCount: number
}

/**
 * Create one axis over the enumerated frames, showing frame `initialIndex`
 * (clamped) and recording it as visited.
 * @param frames - the frames from {@link framesOf}.
 * @param initialIndex - the frame to show first; out-of-range values clamp.
 * @returns the axis state, paused.
 */
export function createTimeAxis(frames: readonly TimelineFrame[], initialIndex = 0): TimeAxisState {
  const index = Math.min(Math.max(initialIndex, 0), Math.max(frames.length - 1, 0))
  return { frames, index, playing: false, visited: [index], changeCount: 0 }
}

/** Record a visit of `index`, keeping `visited` ascending and unique. */
function withVisit(state: TimeAxisState, index: number): TimeAxisState {
  const visited = state.visited.includes(index) ? state.visited : [...state.visited, index].toSorted((a, b) => a - b)
  return { ...state, index, visited, changeCount: state.changeCount + 1, playing: state.playing }
}

/**
 * Step the axis one frame (or `−1` back). Steps clamp at the ends; a clamped
 * step changes nothing, so repeated next at the end never mutates the state.
 * @param state - the current axis state.
 * @param delta - `1` forward or `−1` back.
 * @returns the next axis state.
 */
export function axisStep(state: TimeAxisState, delta: 1 | -1): TimeAxisState {
  const next = state.index + delta
  if (next < 0 || next >= state.frames.length) return state
  return withVisit(state, next)
}

/**
 * Jump the axis to one frame index; out-of-range indices clamp.
 * @param state - the current axis state.
 * @param index - the frame to show.
 * @returns the next axis state (the same object when already showing that frame).
 */
export function axisGoto(state: TimeAxisState, index: number): TimeAxisState {
  const clamped = Math.min(Math.max(Math.trunc(index), 0), Math.max(state.frames.length - 1, 0))
  if (clamped === state.index) return state
  return withVisit(state, clamped)
}

/** Start playback. `axisAdvance` drives the frames; nothing here schedules. */
export function axisPlay(state: TimeAxisState): TimeAxisState {
  if (state.frames.length === 0 || state.playing) return state
  return { ...state, playing: true }
}

/** Pause playback; the shown frame and history stay. */
export function axisPause(state: TimeAxisState): TimeAxisState {
  if (!state.playing) return state
  return { ...state, playing: false }
}

/**
 * Advance one frame under playback; at the last frame playback stops instead
 * of wrapping, so a replay of the same presses always ends paused on the
 * same frame.
 * @param state - the current axis state.
 * @returns the next axis state.
 */
export function axisAdvance(state: TimeAxisState): TimeAxisState {
  if (!state.playing) return state
  if (state.index >= state.frames.length - 1) return { ...state, playing: false }
  const next = withVisit(state, state.index + 1)
  return { ...next, playing: true }
}

/** The frame the axis currently shows, or `undefined` on an empty axis. */
export function currentFrame(state: TimeAxisState): TimelineFrame | undefined {
  return state.frames[state.index]
}
