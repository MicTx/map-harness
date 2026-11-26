/**
 * Client half of the implicit viewport channel: posts each settled camera to
 * `POST /api/map/viewport` so the next model request sees what the user
 * sees. A failed post only leaves the previous camera in place.
 * @module @map-harness/map-container/client/viewport-submit
 */
import type { GestureCameraSnapshot } from './gesture.ts'

/** Report one settled camera for one session. */
export type ViewportSubmit = (sessionId: string, snapshot: GestureCameraSnapshot, signal?: AbortSignal) => Promise<void>

/** Round one coordinate to the display convention. */
function round6(value: number): number {
  return Number.parseFloat(value.toFixed(6))
}

/**
 * The default reporter over the page's same-origin fetch.
 * @param sessionId - the session whose map settled.
 * @param snapshot - the settled camera.
 */
export const submitViewport: ViewportSubmit = async (sessionId, snapshot, signal) => {
  const viewport = {
    center: [round6(snapshot.center[0]), round6(snapshot.center[1])],
    zoom: round6(snapshot.zoom),
    extent: snapshot.extent.map(round6),
    wkid: snapshot.wkid,
    mode: snapshot.mode,
    at: new Date().toISOString(),
  }
  try {
    const response = await globalThis.fetch('/api/map/viewport', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, viewport }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) throw new Error(`viewport report failed with HTTP ${response.status}`)
  } catch (error) {
    // Context is advisory: a network failure keeps the last reported camera.
    if (signal !== undefined) throw error
  }
}
