/**
 * Browser half of continuous map use: claim/submit/cancel one interaction
 * fence, compare the live view against a frozen observation, and build the
 * bounded SDK hit facts a click may return. Network calls are same-origin and
 * bounded by the request's own deadline; no SDK action happens before the
 * fence admits it.
 * @module @map-harness/map-container/client/map-use-client
 */
import type {
  MapInteractionDeclineCode,
  MapInteractionField,
  MapInteractionHit,
  MapInteractionOutcome,
} from '../interaction-protocol.ts'
import type { MapObservationRecord, ObservationCamera } from '../observation-protocol.ts'

/** The live-view identity compared with one observation. */
export interface LiveMapUseFence {
  readonly viewId: string
  readonly generation: number
  readonly mapRevision: number
  readonly cameraEpoch: number
  readonly gestureEpoch: number
  readonly mode: 'map' | 'scene'
  readonly width: number
  readonly height: number
  readonly padding: readonly [number, number, number, number]
  readonly camera: ObservationCamera | null
}

/** Compare two finite numbers with a relative tolerance. */
function near(left: number, right: number): boolean {
  return left === right || Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right))
}

/** Compare one live camera with the observation's recorded camera. */
export function cameraMatchesObservation(actual: ObservationCamera | null, expected: ObservationCamera | null): boolean {
  if (actual === null || expected === null) return actual === expected
  return actual.mode === expected.mode
    && actual.wkid === expected.wkid
    && near(actual.scale, expected.scale)
    && near(actual.rotation, expected.rotation)
    && (actual.zoom === null || expected.zoom === null ? actual.zoom === expected.zoom : near(actual.zoom, expected.zoom))
    && actual.center.every((value, index) => near(value, expected.center[index] as number))
    && actual.extent.every((value, index) => near(value, expected.extent[index] as number))
    && actual.padding.every((value, index) => near(value, expected.padding[index] as number))
}

/**
 * Decide why the live view no longer matches the observation. Gesture epoch
 * changes are user takeover; camera-epoch-only changes are programmatic or
 * foreign camera moves and report a stale observation instead.
 */
export function fenceRefusalOf(
  observation: MapObservationRecord,
  live: LiveMapUseFence,
): MapInteractionDeclineCode | null {
  if (live.mode !== 'map') return 'unsupported'
  if (live.mapRevision !== observation.mapRevision) return 'stale'
  if (live.viewId !== observation.viewId || live.generation !== observation.generation) return 'stale'
  if (live.gestureEpoch !== observation.gestureEpoch) return 'user-interrupted'
  if (live.cameraEpoch !== observation.cameraEpoch) return 'stale'
  if (Math.round(live.width) !== observation.cssViewSize.width
    || Math.round(live.height) !== observation.cssViewSize.height) return 'stale'
  const expectedPadding = observation.camera?.padding ?? [0, 0, 0, 0]
  if (!live.padding.every((value, index) => near(value, expectedPadding[index] as number))) return 'stale'
  if (!cameraMatchesObservation(live.camera, observation.camera)) return 'stale'
  return null
}

/** Post one terminal interaction action without extending its deadline. */
async function postTerminal(body: unknown, expiresAtMs: number): Promise<Response | undefined> {
  const remaining = expiresAtMs - Date.now()
  if (remaining <= 0) return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('map use deadline expired', 'TimeoutError')), remaining)
  try {
    return await fetch('/api/map/use', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Claim one interaction fence. */
export async function claimMapUse(
  identity: { readonly sessionId: string; readonly callId: string; readonly requestSeq: number; readonly expiresAtMs: number },
  signal: AbortSignal,
): Promise<{ readonly status: 'claimed'; readonly token: string } | { readonly status: 'full' | 'conflict' | 'timeout' | 'cancelled' | 'unavailable' }> {
  try {
    const response = await fetch('/api/map/use', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'claim', ...identity }),
      signal,
    })
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return { status: 'unavailable' }
    const result = body as { status?: unknown; token?: unknown }
    if (result.status === 'claimed' && typeof result.token === 'string') return { status: 'claimed', token: result.token }
    if (result.status === 'full' || result.status === 'conflict' || result.status === 'timeout' || result.status === 'cancelled') {
      return { status: result.status }
    }
    return { status: 'unavailable' }
  } catch {
    return signal.aborted ? { status: 'cancelled' } : { status: 'unavailable' }
  }
}

/** Submit one validated outcome for a claimed fence. */
export async function submitMapUse(
  identity: { readonly sessionId: string; readonly callId: string; readonly requestSeq: number; readonly token: string },
  outcome: MapInteractionOutcome,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch('/api/map/use', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'result', ...identity, outcome }),
      signal,
    })
    return response.ok
  } catch {
    return false
  }
}

/** Decline one claimed fence with an authored reason. */
export async function declineMapUse(
  identity: { readonly sessionId: string; readonly callId: string; readonly requestSeq: number },
  token: string,
  code: MapInteractionDeclineCode,
  expiresAtMs: number,
): Promise<boolean> {
  const response = await postTerminal({
    action: 'result', ...identity, token, outcome: { status: 'declined', code },
  }, expiresAtMs)
  return response?.ok === true
}

/** Cancel a claimed fence after an unexpected local failure. */
export async function cancelMapUse(
  identity: { readonly sessionId: string; readonly callId: string; readonly requestSeq: number },
  token: string,
  expiresAtMs: number,
): Promise<boolean> {
  const response = await postTerminal({ action: 'cancel', ...identity, token }, expiresAtMs)
  return response?.ok === true
}

/** Persist a user takeover for the exact trusted turn. */
export async function stopMapUseTurn(sessionId: string, turnStartSeq: number): Promise<boolean> {
  const response = await postTerminal({ action: 'stop', sessionId, turnStartSeq }, Date.now() + 5000)
  return response?.ok === true
}

/** Re-export the hit/field vocabulary for the occurrence's map-building code. */
export type { MapInteractionField, MapInteractionHit }
