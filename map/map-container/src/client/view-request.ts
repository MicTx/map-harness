/**
 * Consume a Conversation `viewRequest` addressed at the map view.
 *
 * `openView('map', focus)` lands on this view once it is the active tab.
 * The focus identity is a layer id: a known layer is recorded so the body
 * can keep it visible and frame its bbox; an unknown id is still consumed
 * so a stale request cannot stick on the store.
 */
export interface MapViewRequest {
  readonly view: string
  readonly focus: string
}

/** Outcome of inspecting one `viewRequest` against the current layers. */
export interface MapViewRequestConsumption {
  /** Whether this view owns the request and must call `completeViewRequest`. */
  readonly consume: boolean
  /** The focus layer id when this view owns the request. */
  readonly layerId: string | null
  /** Whether that layer is present in the current projection. */
  readonly known: boolean
}

/**
 * What the map view body should do with one `viewRequest`.
 *
 * `ignore` — not ours. `defer` — the projection has not landed yet, or the
 * known layer's occurrence is not mounted; keep the request. `complete` —
 * acknowledge now; `focus` means call `focusLayer`.
 */
export type MapViewRequestAction =
  | { readonly kind: 'ignore' }
  | { readonly kind: 'defer'; readonly layerId: string }
  | { readonly kind: 'complete'; readonly layerId: string | null; readonly focus: boolean }

/**
 * Decide whether the map view should acknowledge a focus request.
 * @param request - the one-shot focus request from the Conversation store.
 * @param layers - current projected layers, or absent when the projection has not landed.
 * @returns consumption: foreign requests are left untouched; map requests always complete.
 */
export function consumeMapViewRequest(
  request: MapViewRequest | null | undefined,
  layers: ReadonlyArray<{ readonly id: string }> | undefined,
): MapViewRequestConsumption {
  if (request === null || request === undefined || request.view !== 'map') {
    return { consume: false, layerId: null, known: false }
  }
  const layerId = request.focus
  const known = layers !== undefined && layers.some(layer => layer.id === layerId)
  return { consume: true, layerId, known }
}

/**
 * Map a consumption onto ignore / defer / complete given occurrence readiness.
 * @param request - the one-shot focus request.
 * @param layers - current projected layers, or absent.
 * @param occurrenceReady - whether the ArcGIS occurrence is mounted.
 * @returns the body action.
 */
export function mapViewRequestAction(
  request: MapViewRequest | null | undefined,
  layers: ReadonlyArray<{ readonly id: string }> | undefined,
  occurrenceReady: boolean,
): MapViewRequestAction {
  const result = consumeMapViewRequest(request, layers)
  if (!result.consume) return { kind: 'ignore' }
  // An absent projection is still hydrating. Treating its focus as an unknown
  // layer would consume the request before the durable layer list arrives.
  if (layers === undefined) return { kind: 'defer', layerId: result.layerId ?? '' }
  if (!result.known || result.layerId === null) {
    return { kind: 'complete', layerId: result.layerId, focus: false }
  }
  if (!occurrenceReady) return { kind: 'defer', layerId: result.layerId }
  return { kind: 'complete', layerId: result.layerId, focus: true }
}
