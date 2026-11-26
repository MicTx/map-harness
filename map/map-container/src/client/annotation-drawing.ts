/**
 * Injected Sketch drawing host shared by the browser occurrence and tests.
 * @module @map-harness/map-container/client/annotation-drawing
 */
import { isValidAnnotationGeometry, type AnnotationGeometry } from '@map-harness/map-layers'

/** The four first-version annotation drawing tools. */
export type AnnotationDrawKind = 'point' | 'line' | 'polygon' | 'rectangle'

/** Public drawing lifecycle; editing joins in the UI task over the same host. */
export interface AnnotationDrawingState {
  readonly status: 'idle' | 'drawing' | 'editing' | 'submitting'
  readonly kind: AnnotationDrawKind | null
  readonly lastError: 'geometry-invalid' | 'submit-failed' | null
}

/** Minimal structural face of ArcGIS `SketchViewModel` used by the host. */
export interface SketchViewModelFace {
  create(tool: 'point' | 'polyline' | 'polygon' | 'rectangle', options?: { readonly mode?: 'click' }): Promise<void>
  update(graphic: unknown, options?: { readonly tool?: 'move' | 'reshape' | 'transform' }): Promise<void>
  cancel(): void
  on(type: 'create', listener: (event: { readonly state: 'start' | 'active' | 'complete' | 'cancel'; readonly graphic?: { readonly geometry?: unknown } }) => void): { remove(): void }
  on(type: 'update', listener: (event: { readonly state: 'active' | 'start' | 'complete' | 'cancel'; readonly graphics?: readonly { readonly geometry?: unknown }[] }) => void): { remove(): void }
}

/** Minimal structural face of the temporary ArcGIS graphics layer. */
export interface DrawingLayerFace {
  add?(graphic: unknown): void
  removeAll(): void
  destroy(): void
}

/** Host-owned dependencies; ArcGIS constructors and projection are injected. */
export interface AnnotationDrawingHostOptions<TView, TLayer extends DrawingLayerFace> {
  readonly viewOf: () => TView | undefined
  readonly modeOf: () => 'map' | 'scene'
  readonly createLayer: () => TLayer
  readonly createSketch: (view: TView, layer: TLayer) => SketchViewModelFace
  readonly projectGeometry: (geometry: unknown) => Promise<unknown>
  readonly submit: (geometry: AnnotationGeometry, kind: AnnotationDrawKind) => Promise<void>
  readonly submitUpdate: (featureId: string, geometry: AnnotationGeometry, expectedUpdatedAt: string) => Promise<void>
  readonly onState?: (state: AnnotationDrawingState) => void
}

/** Convert a projected ArcGIS geometry value to the annotation contract. */
export function annotationGeometryOf(geometry: unknown): AnnotationGeometry | undefined {
  if (typeof geometry !== 'object' || geometry === null) return undefined
  const value = geometry as { type?: unknown; x?: unknown; y?: unknown; paths?: unknown; rings?: unknown }
  if (value.type === 'point' && typeof value.x === 'number' && typeof value.y === 'number') {
    return { type: 'Point', coordinates: [value.x, value.y] }
  }
  if (value.type === 'polyline' && Array.isArray(value.paths) && value.paths.length === 1) {
    return { type: 'LineString', coordinates: value.paths[0] as [number, number][] }
  }
  if (value.type === 'polygon' && Array.isArray(value.rings) && value.rings.length === 1) {
    return { type: 'Polygon', coordinates: value.rings as [number, number][][] }
  }
  return undefined
}

/**
 * Create one occurrence-owned drawing host. The host never mutates durable
 * state; `submit` receives only a validated WGS84 geometry.
 * @param options - injected view, SDK, projection, and submission faces.
 * @returns the drawing controller.
 */
export function createAnnotationDrawingHost<TView, TLayer extends DrawingLayerFace>(
  options: AnnotationDrawingHostOptions<TView, TLayer>,
): {
  readonly state: AnnotationDrawingState
  start(kind: AnnotationDrawKind): Promise<'started' | 'busy' | 'no-view' | 'scene-mode'>
  startEditing(featureId: string, graphic: unknown, expectedUpdatedAt: string): Promise<'started' | 'busy' | 'no-view' | 'scene-mode'>
  cancel(): boolean
  dispose(): void
} {
  let state: AnnotationDrawingState = { status: 'idle', kind: null, lastError: null }
  let layer: TLayer | undefined
  let sketch: SketchViewModelFace | undefined
  let removeCreate: { remove(): void } | undefined
  let removeUpdate: { remove(): void } | undefined
  let operation = 0
  const setState = (next: AnnotationDrawingState): void => {
    state = next
    options.onState?.(next)
  }
  const clear = (): void => {
    operation += 1
    removeCreate?.remove()
    removeCreate = undefined
    removeUpdate?.remove()
    removeUpdate = undefined
    sketch?.cancel()
    sketch = undefined
    layer?.removeAll()
    layer?.destroy()
    layer = undefined
    setState({ status: 'idle', kind: null, lastError: state.lastError })
  }
  return {
    get state() {
      return state
    },
    async start(kind) {
      if (state.status !== 'idle') return 'busy'
      const activeView = options.viewOf()
      if (activeView === undefined) return 'no-view'
      if (options.modeOf() !== 'map') return 'scene-mode'
      const activeLayer = options.createLayer()
      const activeSketch = options.createSketch(activeView, activeLayer)
      layer = activeLayer
      sketch = activeSketch
      const currentOperation = operation
      removeCreate = activeSketch.on('create', event => {
        if (event.state === 'cancel' || operation !== currentOperation) {
          if (event.state === 'cancel') clear()
          return
        }
        if (event.state !== 'complete') return
        const drawn = event.graphic?.geometry
        operation += 1
        removeCreate?.remove()
        removeCreate = undefined
        activeLayer.removeAll()
        setState({ status: 'submitting', kind, lastError: null })
        let reachedSubmit = false
        void options.projectGeometry(drawn)
          .then(projected => {
            if (operation !== currentOperation + 1) return
            const geometry = annotationGeometryOf(projected)
            if (geometry === undefined) throw new Error('geometry-invalid')
            if (!isValidAnnotationGeometry(geometry)) throw new Error('geometry-invalid')
            reachedSubmit = true
            return options.submit(geometry, kind)
          })
          .then(() => {
            if (operation !== currentOperation + 1) return
            activeLayer.destroy()
            if (layer === activeLayer) {
              layer = undefined
              sketch = undefined
            }
            setState({ status: 'idle', kind: null, lastError: null })
          })
          .catch(() => {
            if (operation !== currentOperation + 1) return
            activeLayer.destroy()
            if (layer === activeLayer) {
              layer = undefined
              sketch = undefined
            }
            setState({
              status: 'idle',
              kind: null,
              lastError: reachedSubmit ? 'submit-failed' : 'geometry-invalid',
            })
          })
      })
      setState({ status: 'drawing', kind, lastError: null })
      try {
        await activeSketch.create(kind === 'line' ? 'polyline' : kind, { mode: 'click' })
      } catch (error) {
        if (operation === currentOperation) {
          clear()
          throw error
        }
      }
      return 'started'
    },
    async startEditing(featureId, graphic, expectedUpdatedAt) {
      if (state.status !== 'idle') return 'busy'
      const activeView = options.viewOf()
      if (activeView === undefined) return 'no-view'
      if (options.modeOf() !== 'map') return 'scene-mode'
      const activeLayer = options.createLayer()
      const activeSketch = options.createSketch(activeView, activeLayer)
      layer = activeLayer
      sketch = activeSketch
      const currentOperation = operation
      activeLayer.add?.(graphic)
      removeUpdate = activeSketch.on('update', event => {
        if (event.state === 'cancel' || operation !== currentOperation) {
          if (event.state === 'cancel') clear()
          return
        }
        if (event.state !== 'complete') return
        const drawn = event.graphics?.[0]?.geometry
        operation += 1
        removeUpdate?.remove()
        removeUpdate = undefined
        activeLayer.removeAll()
        setState({ status: 'submitting', kind: null, lastError: null })
        let reachedSubmit = false
        void options.projectGeometry(drawn)
          .then(projected => {
            if (operation !== currentOperation + 1) return
            const geometry = annotationGeometryOf(projected)
            if (geometry === undefined) throw new Error('geometry-invalid')
            if (!isValidAnnotationGeometry(geometry)) throw new Error('geometry-invalid')
            reachedSubmit = true
            return options.submitUpdate(featureId, geometry, expectedUpdatedAt)
          })
          .then(() => {
            if (operation !== currentOperation + 1) return
            activeLayer.destroy()
            if (layer === activeLayer) {
              layer = undefined
              sketch = undefined
            }
            setState({ status: 'idle', kind: null, lastError: null })
          })
          .catch(() => {
            if (operation !== currentOperation + 1) return
            activeLayer.destroy()
            if (layer === activeLayer) {
              layer = undefined
              sketch = undefined
            }
            setState({ status: 'idle', kind: null, lastError: reachedSubmit ? 'submit-failed' : 'geometry-invalid' })
          })
      })
      setState({ status: 'editing', kind: null, lastError: null })
      try {
        await activeSketch.update(graphic, { tool: 'reshape' })
      } catch (error) {
        if (operation === currentOperation) {
          clear()
          throw error
        }
      }
      return 'started'
    },
    cancel() {
      if (state.status === 'idle') return false
      clear()
      return true
    },
    dispose() {
      if (state.status !== 'idle') clear()
      else {
        layer?.destroy()
        layer = undefined
      }
    },
  }
}
