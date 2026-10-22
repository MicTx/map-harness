/**
 * Browser gesture write channel, protocol half: versioned observation schema,
 * bounded serializer/parser, and the interaction-window/settle/rate-limit
 * state machine that turns high-frequency camera drafts into bounded
 * observations (design §11.1/§11.2 — gestures enter the session queue as user
 * input, never the authoritative map state).
 *
 * Pure module: no ArcGIS imports, plain data in and out, injectable clock and
 * timers so the state machine is deterministic under `node --test`.
 * @module @map-harness/map-container/client/gesture
 */
import { z } from 'zod'

/** Wire version of the observation text; the first text line carries it. */
export const GESTURE_TEXT_VERSION = 1

/** First-line marker identifying an observation and its wire version. */
export const GESTURE_TEXT_MARKER = `[map-gesture v${GESTURE_TEXT_VERSION}]`

/** A user interaction keeps the attribution window open this long (ms). */
export const GESTURE_INTERACTION_WINDOW_MS = 1200

/** Camera rest period (ms) that settles a draft into a stable observation. */
export const GESTURE_SETTLE_MS = 900

/** Occurrence-driven camera writes mute gesture attribution for this long (ms). */
export const GESTURE_PROGRAMMATIC_PULSE_MS = 1500

/** Minimum interval (ms) between stable submissions; excess settles wait as latest-wins. */
export const GESTURE_STEER_MIN_INTERVAL_MS = 8000

/** Serialized observation text byte cap; oversized observations are refused, never truncated. */
export const GESTURE_MAX_OBSERVATION_BYTES = 768

/** Decimal places kept on coordinates; display convention, not precision claims. */
const COORD_DECIMALS = 6

/** Rounded camera fix as plain numbers (no ArcGIS geometry types cross this module). */
export interface GestureCameraSnapshot {
  /** View center `[x, y]` in the display WKID — self-describing with `wkid`, no conversion in this module. */
  readonly center: readonly [number, number]
  /** Web-Mercator zoom convention the map tools use (derived from scale when the view reports one). */
  readonly zoom: number
  /** View extent as `[minX, minY, maxX, maxY]` in the display WKID. */
  readonly extent: readonly [number, number, number, number]
  /** Display WKID of the extent coordinates. */
  readonly wkid: number
  /** Which ArcGIS engine the snapshot came from. */
  readonly mode: 'map' | 'scene'
}

const cameraSnapshotSchema = z.object({
  center: z.tuple([z.number(), z.number()]),
  zoom: z.number(),
  extent: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  wkid: z.number().int(),
  mode: z.enum(['map', 'scene']),
})

/** One bounded gesture observation as it crosses into the session queue. */
export interface GestureObservation extends GestureCameraSnapshot {
  readonly version: typeof GESTURE_TEXT_VERSION
  readonly sessionId: string
  readonly occurrenceKey: string
  /** Container generation the observing view belongs to. */
  readonly generation: number
  /** `stable` = camera rest after user gestures; `explicit` = user's explicit submit. */
  readonly kind: 'stable' | 'explicit'
  /** ISO timestamp of the observation. */
  readonly at: string
}

const observationSchema = cameraSnapshotSchema.extend({
  version: z.literal(GESTURE_TEXT_VERSION),
  sessionId: z.string().min(1),
  occurrenceKey: z.string().min(1),
  generation: z.number().int().nonnegative(),
  kind: z.enum(['stable', 'explicit']),
  at: z.string().datetime(),
}).readonly()

/** Why a text is not a well-formed observation; `not-gesture` is a quiet miss. */
export type GestureParseReason = 'not-gesture' | 'unknown-version' | 'invalid-payload' | 'oversized'

/** Discriminated parse outcome for one candidate message text. */
export type GestureParseResult =
  | { readonly ok: true; readonly observation: GestureObservation }
  | { readonly ok: false; readonly reason: GestureParseReason }

/** Round one coordinate to the display convention; non-finite values fail validation downstream. */
function round6(value: number): number {
  return Number.parseFloat(value.toFixed(COORD_DECIMALS))
}

function roundedSnapshot(snapshot: GestureCameraSnapshot): GestureCameraSnapshot {
  return {
    center: [round6(snapshot.center[0]), round6(snapshot.center[1])] as const,
    zoom: round6(snapshot.zoom),
    extent: [
      round6(snapshot.extent[0]), round6(snapshot.extent[1]),
      round6(snapshot.extent[2]), round6(snapshot.extent[3]),
    ] as const,
    wkid: snapshot.wkid,
    mode: snapshot.mode,
  }
}

/** UTF-8 byte length of one string. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Serialize one observation into its bounded wire text (marker line + one
 * compact JSON line). Coordinates are rounded to the display convention.
 * @param observation - the settled observation.
 * @returns the text, or the stable refusal reason (`invalid` schema, `oversized` byte cap).
 */
export function serializeObservationText(observation: GestureObservation): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: 'invalid' | 'oversized' } {
  const payload = observationSchema.safeParse(observation)
  if (!payload.success) return { ok: false, reason: 'invalid' }
  const rounded = roundedSnapshot(observation)
  const body = JSON.stringify({
    s: observation.sessionId,
    o: observation.occurrenceKey,
    g: observation.generation,
    k: observation.kind,
    c: rounded.center,
    z: rounded.zoom,
    e: rounded.extent,
    w: rounded.wkid,
    m: rounded.mode,
    t: observation.at,
  })
  const text = `${GESTURE_TEXT_MARKER}\n${body}`
  if (byteLength(text) > GESTURE_MAX_OBSERVATION_BYTES) return { ok: false, reason: 'oversized' }
  return { ok: true, text }
}

/**
 * Parse one message text into an observation. Foreign text is a quiet
 * `not-gesture` — ordinary user messages must never be treated as failures.
 * @param text - the candidate message text.
 * @param maxBytes - byte cap applied to the candidate before parsing.
 * @returns the parsed observation or the stable refusal reason.
 */
export function parseObservationText(text: string, maxBytes = GESTURE_MAX_OBSERVATION_BYTES): GestureParseResult {
  if (byteLength(text) > maxBytes) return { ok: false, reason: 'oversized' }
  // Version detection comes before the exact-marker prefix check so unknown
  // versions report as `unknown-version`, not a quiet foreign-text miss.
  if (!text.startsWith('[map-gesture v')) return { ok: false, reason: 'not-gesture' }
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0) return { ok: false, reason: 'invalid-payload' }
  const marker = text.slice(0, firstLineEnd)
  if (marker !== GESTURE_TEXT_MARKER) {
    const versionMatch = /^\[map-gesture v(\d+)\]$/.exec(marker)
    return { ok: false, reason: versionMatch && versionMatch[1] !== String(GESTURE_TEXT_VERSION) ? 'unknown-version' : 'invalid-payload' }
  }
  let body: unknown
  try {
    body = JSON.parse(text.slice(firstLineEnd + 1))
  } catch {
    return { ok: false, reason: 'invalid-payload' }
  }
  const decoded = decodeWire(body)
  const parsed = observationSchema.safeParse(decoded)
  if (!parsed.success) return { ok: false, reason: 'invalid-payload' }
  return { ok: true, observation: parsed.data }
}

/** Expand the short wire keys back into the observation record. */
function decodeWire(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body
  const wire = body as Record<string, unknown>
  return {
    version: GESTURE_TEXT_VERSION,
    sessionId: wire.s,
    occurrenceKey: wire.o,
    generation: wire.g,
    kind: wire.k,
    center: wire.c,
    zoom: wire.z,
    extent: wire.e,
    wkid: wire.w,
    mode: wire.m,
    at: wire.t,
  }
}

/** Observer emission sink; `text` is the bounded wire form, ready for the session queue. */
export type GestureEmit = (text: string, observation: GestureObservation) => void

/** Clock and timer seam so the state machine is deterministic in tests. */
export interface GestureClock {
  readonly now: () => number
  readonly setTimeout: (handler: () => void, ms: number) => unknown
  readonly clearTimeout: (handle: unknown) => void
}

/** Real-browser clock; tests inject deterministic doubles. */
export const realGestureClock: GestureClock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Submission policy: stable rests steer only a running turn (without one the
 * camera stays local context — a queued message would start a request by
 * itself); explicit submits always queue (the user asked for it).
 * @param kind - observation kind from the observer.
 * @param running - whether the session has a running turn.
 * @returns the prompt mode, or `null` when the observation must not enter the queue.
 */
export function gestureSubmitMode(kind: 'stable' | 'explicit', running: boolean): 'steer' | 'queue' | null {
  if (kind === 'explicit') return 'queue'
  return running ? 'steer' : null
}

/** Observer counters the occurrence publishes onto its test handle. */
export interface GestureMetrics {
  draftsFormed: number
  stableEmitted: number
  deferredByRate: number
  explicitEmitted: number
  refusedOversized: number
  /** Last emitted wire text, for handle assertions. */
  lastText: string | null
}

function emptyMetrics(): GestureMetrics {
  return { draftsFormed: 0, stableEmitted: 0, deferredByRate: 0, explicitEmitted: 0, refusedOversized: 0, lastText: null }
}

/** Fresh zero counters, for faces that must report metrics without a live view. */
export function emptyGestureMetrics(): GestureMetrics {
  return emptyMetrics()
}

/** Constructor inputs of one view's gesture observer. */
export interface GestureObserverOptions {
  readonly sessionId: string
  readonly occurrenceKey: string
  /** Live container generation reader; views rebuild under WKID/mode switches. */
  readonly generationOf: () => number
  /** Emission sink; called synchronously with the bounded wire text. */
  readonly emit: GestureEmit
  readonly clock?: GestureClock
}

/**
 * The gesture state machine for one live view: interaction attribution
 * window, settle debounce, occurrence-driven programmatic mute, and the
 * latest-wins rate cap. One instance serves one view; dispose with the view.
 */
export interface GestureObserver {
  /** A user interaction arrived (pointer drag, wheel, key). Opens/extends the attribution window. */
  interaction(): void
  /** The occurrence is about to drive the camera itself; changes during the pulse are never gestures. */
  programmatic(): void
  /** The view camera changed; attributed only under an open window and outside a programmatic pulse. */
  cameraChanged(snapshot: GestureCameraSnapshot): void
  /** The user explicitly submitted the current view; bypasses window and rate cap. */
  explicit(snapshot: GestureCameraSnapshot): void
  /** Live metrics for the test handle. */
  readonly metrics: GestureMetrics
  /** Cancel timers; the view is going away. */
  dispose(): void
}

/**
 * Create the observer for one live view.
 * @param options - session/occurrence identity, generation reader, emission sink, optional clock.
 */
export function createGestureObserver(options: GestureObserverOptions): GestureObserver {
  const clock = options.clock ?? realGestureClock
  const sessionId = options.sessionId
  const occurrenceKey = options.occurrenceKey
  const generationOf = options.generationOf
  const metrics = emptyMetrics()

  let windowTimer: unknown = undefined
  let settleTimer: unknown = undefined
  let rateTimer: unknown = undefined
  let windowOpenUntil = 0
  let programmaticUntil = 0
  let draft: GestureCameraSnapshot | undefined
  let lastStableAt = 0
  let disposed = false

  function clearTimer(handle: unknown): void {
    if (handle !== undefined) clock.clearTimeout(handle)
  }

  function build(kind: 'stable' | 'explicit', snapshot: GestureCameraSnapshot): GestureObservation {
    return {
      ...roundedSnapshot(snapshot),
      version: GESTURE_TEXT_VERSION,
      sessionId,
      occurrenceKey,
      generation: generationOf(),
      kind,
      at: new Date(clock.now()).toISOString(),
    }
  }

  function emitObservation(kind: 'stable' | 'explicit', snapshot: GestureCameraSnapshot): void {
    const observation = build(kind, snapshot)
    const serialized = serializeObservationText(observation)
    if (!serialized.ok) {
      metrics.refusedOversized += 1
      return
    }
    metrics.lastText = serialized.text
    if (kind === 'stable') {
      metrics.stableEmitted += 1
      lastStableAt = clock.now()
    } else {
      metrics.explicitEmitted += 1
    }
    options.emit(serialized.text, observation)
  }

  function settleDraft(): void {
    settleTimer = undefined
    if (disposed || draft === undefined) return
    const pending = draft
    draft = undefined
    const sinceLast = clock.now() - lastStableAt
    if (sinceLast >= GESTURE_STEER_MIN_INTERVAL_MS) {
      emitObservation('stable', pending)
      return
    }
    // Latest-wins: hold the newest settle for the remaining interval, then emit it.
    metrics.deferredByRate += 1
    clearTimer(rateTimer)
    rateTimer = clock.setTimeout(() => {
      rateTimer = undefined
      if (!disposed) emitObservation('stable', pending)
    }, GESTURE_STEER_MIN_INTERVAL_MS - sinceLast)
  }

  return {
    interaction() {
      if (disposed) return
      windowOpenUntil = clock.now() + GESTURE_INTERACTION_WINDOW_MS
      clearTimer(windowTimer)
      windowTimer = clock.setTimeout(() => {
        windowTimer = undefined
        windowOpenUntil = 0
      }, GESTURE_INTERACTION_WINDOW_MS)
    },
    programmatic() {
      if (disposed) return
      programmaticUntil = clock.now() + GESTURE_PROGRAMMATIC_PULSE_MS
    },
    cameraChanged(snapshot) {
      if (disposed) return
      const now = clock.now()
      if (now < programmaticUntil) return
      if (now >= windowOpenUntil) return
      // One gesture sequence forms one draft; later changes refresh it.
      if (draft === undefined) metrics.draftsFormed += 1
      draft = snapshot
      clearTimer(settleTimer)
      settleTimer = clock.setTimeout(settleDraft, GESTURE_SETTLE_MS)
    },
    explicit(snapshot) {
      if (disposed) return
      emitObservation('explicit', snapshot)
    },
    metrics,
    dispose() {
      disposed = true
      clearTimer(windowTimer)
      clearTimer(settleTimer)
      clearTimer(rateTimer)
      windowTimer = settleTimer = rateTimer = undefined
      draft = undefined
    },
  }
}
