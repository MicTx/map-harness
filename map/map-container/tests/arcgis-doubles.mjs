/** Shared ArcGIS constructor doubles for occurrence lifecycle tests. */

export const captured = {
  maps: [],
  tileLayers: [],
  mapImageLayers: [],
  mapViews: [],
  sceneViews: [],
  destroyed: [],
  destroyedMaps: [],
  renderWaits: [],
  viewEventHandles: [],
  watches: [],
}

export function resetCaptured() {
  captured.maps.length = 0
  captured.tileLayers.length = 0
  captured.mapImageLayers.length = 0
  captured.mapViews.length = 0
  captured.sceneViews.length = 0
  captured.destroyed.length = 0
  captured.destroyedMaps.length = 0
  captured.renderWaits.length = 0
  captured.viewEventHandles.length = 0
  captured.watches.length = 0
}

export class FakeMap {
  constructor() {
    this.layers = []
    this.basemap = undefined
    this.ground = undefined
    captured.maps.push(this)
  }
  add(layer) { this.layers.push(layer) }
  remove(layer) { this.layers = this.layers.filter(item => item !== layer) }
  destroy() { captured.destroyedMaps.push(this) }
}

export class FakeTileLayer {
  constructor(options) {
    Object.assign(this, options)
    captured.tileLayers.push(this)
  }
}

export class FakeMapImageLayer {
  constructor(options) {
    Object.assign(this, options)
    captured.mapImageLayers.push(this)
  }
}

export class FakeGraphicsLayer {
  constructor(options = {}) {
    this.title = options.title
    this.visible = true
    this.opacity = 1
    this.graphics = []
  }
  add(graphic) { this.graphics.push(graphic) }
  removeAll() { this.graphics = [] }
  destroy() {}
}

class FakeView {
  constructor(options, kind) {
    this.kind = kind
    this.container = options.container
    this.map = options.map
    this.ui = options.ui
    this.viewingMode = options.viewingMode
    this.spatialReference = options.spatialReference ?? { wkid: 3857 }
    this.center = undefined
    this.zoom = 0
    this.scale = 0
    this.destroyed = false
    this.updating = false
    this.suspended = false
    this.layerViews = new Map()
    this.pendingWhens = []
    this.eventHandlers = new Map()
    if (kind === 'map') captured.mapViews.push(this)
    else captured.sceneViews.push(this)
  }
  on(names, handler) {
    for (const name of names) {
      const list = this.eventHandlers.get(name) ?? []
      list.push(handler)
      this.eventHandlers.set(name, list)
    }
    const entry = { view: this, names: [...names], handler }
    captured.viewEventHandles.push(entry)
    let removed = false
    return { remove: () => { if (!removed) { removed = true; const i = captured.viewEventHandles.indexOf(entry); if (i >= 0) captured.viewEventHandles.splice(i, 1) } } }
  }
  when(callback) {
    this.pendingWhen = callback
    if (this.holdWhen) return new Promise((resolve, reject) => { this.pendingWhens.push({ callback, resolve, reject }) })
    return Promise.resolve().then(() => {
      if (this.destroyed) return
      callback?.()
    })
  }
  releaseWhens(error) {
    this.holdWhen = false
    for (const pending of this.pendingWhens.splice(0)) {
      if (error) pending.reject(error)
      else { pending.callback?.(); pending.resolve() }
    }
  }
  whenLayerView(graphics) {
    if (this.layerError === graphics.title) return Promise.reject(new Error('layer URL must not leak'))
    if (this.layerBarrier) return this.layerBarrier.promise
    if (!this.layerViews.has(graphics)) this.layerViews.set(graphics, { updating: false })
    return Promise.resolve(this.layerViews.get(graphics))
  }
  flushWhen() {
    const callback = this.pendingWhen
    this.pendingWhen = undefined
    if (callback === undefined || this.destroyed) return
    callback()
  }
  goTo() { return Promise.resolve() }
  destroy() {
    this.destroyed = true
    captured.destroyed.push(this)
  }
}

/** Deterministic Accessor observation double; tests explicitly change and flush updating/suspended. */
export function whenOnce(predicate, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const wait = { predicate, resolve, reject, signal, abort: undefined }
    wait.abort = () => {
      captured.renderWaits = captured.renderWaits.filter(item => item !== wait)
      reject(signal.reason)
    }
    signal?.addEventListener('abort', wait.abort, { once: true })
    captured.renderWaits.push(wait)
    flushRenderWaits()
  })
}

/** Property-watch double: captures getter-based watches; tests fire entries directly. */
export function watch(getter, callback) {
  const entry = { getter, callback }
  captured.watches.push(entry)
  return { remove: () => { const i = captured.watches.indexOf(entry); if (i >= 0) captured.watches.splice(i, 1) } }
}

/** Fire one captured view event (pointer-drag, mouse-wheel, ...). */
export function fireViewEvent(view, name) {
  for (const handler of view.eventHandlers.get(name) ?? []) handler()
}

/** Fire one captured watch entry (from `captured.watches`). */
export function fireWatch(entry) {
  entry.callback()
}

export function flushRenderWaits() {
  for (const wait of [...captured.renderWaits]) {
    if (!wait.predicate()) continue
    captured.renderWaits = captured.renderWaits.filter(item => item !== wait)
    wait.signal?.removeEventListener('abort', wait.abort)
    wait.resolve(true)
  }
}

export class FakeMapView extends FakeView {
  constructor(options) { super(options, 'map') }
}

export class FakeSceneView extends FakeView {
  constructor(options) { super(options, 'scene') }
}

export class FakePoint {
  constructor(options) { Object.assign(this, options) }
}

export class FakeGraphic {
  constructor(options) { Object.assign(this, options) }
}

export class FakePolyline {
  constructor(options) { Object.assign(this, options) }
}

export class FakePolygon {
  constructor(options) { Object.assign(this, options) }
}

export class FakeExtent {
  constructor(options) { Object.assign(this, options) }
}

export const FakeSpatialReference = {
  WGS84: { wkid: 4326 },
  fromJSON(json) { return { wkid: json.wkid } },
}

/** Marker-symbol double: captures the style payload the occurrence assigns. */
export class FakeSimpleMarkerSymbol {
  constructor(options) { Object.assign(this, options) }
}

/** Line-symbol double. */
export class FakeSimpleLineSymbol {
  constructor(options) { Object.assign(this, options) }
}

/** Fill-symbol double. */
export class FakeSimpleFillSymbol {
  constructor(options) { Object.assign(this, options) }
}
