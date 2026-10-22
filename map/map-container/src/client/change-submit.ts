/**
 * Client half of the user map change path: posts one change to
 * `POST /api/map/change` and reports the outcome. The host applies the
 * change before it responds, so a success means the projection wire is
 * already on its way; the panel never pre-stages state.
 */

/** The change vocabulary the panel writes directly; mirrors the host record. */
export type PanelChange =
  | { readonly op: 'set-layer-state'; readonly states: readonly { readonly layerId: string; readonly visible?: boolean; readonly opacity?: number; readonly group?: string | null }[] }
  | { readonly op: 'reorder-layers'; readonly layerIds: readonly string[] }
  | { readonly op: 'remove-layer'; readonly layerId: string }
  | { readonly op: 'set-symbol-preset'; readonly layerId: string; readonly preset: string }

/** One change outcome: applied, or a refusal code the panel maps to copy. */
export type PanelChangeOutcome =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly code: string }

/** Submit one change against the revision the user saw. */
export type PanelChangeSubmit = (input: {
  readonly sessionId: string
  readonly revision: number
  readonly summary: string
  readonly change: PanelChange
}) => Promise<PanelChangeOutcome>

let operationSeq = 0

/**
 * The default submitter over the page's same-origin fetch.
 * @param fetchImpl - the fetch to call, read at submit time; tests inject a double.
 * @returns the submitter.
 */
export function createPanelChangeSubmit(fetchImpl?: typeof fetch): PanelChangeSubmit {
  return async ({ sessionId, revision, summary, change }) => {
    operationSeq += 1
    const operationId = `user-${Date.now().toString(36)}-${operationSeq.toString(36)}`
    try {
      const response = await (fetchImpl ?? globalThis.fetch)('/api/map/change', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, summary, record: { operationId, targetRevision: revision, change } }),
      })
      const payload = await response.json().catch(() => null) as { ok?: unknown; revision?: unknown; code?: unknown } | null
      if (payload?.ok === true && typeof payload.revision === 'number') return { ok: true, revision: payload.revision }
      return { ok: false, code: typeof payload?.code === 'string' ? payload.code : `http-${response.status}` }
    } catch {
      // A network failure leaves the map unchanged.
      return { ok: false, code: 'network' }
    }
  }
}
