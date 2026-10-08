/** Gesture write channel: protocol, observer state machine, occurrence wiring. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import {
  captured,
  resetCaptured,
  fireViewEvent,
  fireWatch,
} from './arcgis-doubles.mjs'

class FakeDiv {}
if (globalThis.HTMLDivElement === undefined) globalThis.HTMLDivElement = FakeDiv

if (globalThis.HTMLDivElement === undefined) globalThis.HTMLDivElement = FakeDiv

const doublesUrl = new URL('./arcgis-doubles.mjs', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@arcgis/core/core/reactiveUtils.js') return { url: doublesUrl, shortCircuit: true }
    const exportBySpecifier = {
      '@arcgis/core/views/MapView.js': 'FakeMapView',
      '@arcgis/core/views/SceneView.js': 'FakeSceneView',
      '@arcgis/core/Map.js': 'FakeMap',
      '@arcgis/core/layers/WebTileLayer.js': 'FakeTileLayer',
      '@arcgis/core/layers/MapImageLayer.js': 'FakeMapImageLayer',
      '@arcgis/core/layers/GraphicsLayer.js': 'FakeGraphicsLayer',
      '@arcgis/core/Graphic.js': 'FakeGraphic',
      '@arcgis/core/geometry/Point.js': 'FakePoint',
      '@arcgis/core/geometry/Polyline.js': 'FakePolyline',
      '@arcgis/core/geometry/Polygon.js': 'FakePolygon',
      '@arcgis/core/geometry/Extent.js': 'FakeExtent',
      '@arcgis/core/geometry/SpatialReference.js': 'FakeSpatialReference',
      '@arcgis/core/symbols/SimpleMarkerSymbol.js': 'FakeSimpleMarkerSymbol',
      '@arcgis/core/symbols/SimpleLineSymbol.js': 'FakeSimpleLineSymbol',
      '@arcgis/core/symbols/SimpleFillSymbol.js': 'FakeSimpleFillSymbol',
    }
    const name = exportBySpecifier[specifier]
    if (name === undefined) return nextResolve(specifier, context)
    const source = `export { ${name} as default } from ${JSON.stringify(doublesUrl)}`
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true }
  },
})

const gesture = await import('../src/client/gesture.ts')
const { createMapOccurrence } = await import('../src/client/occurrence.ts')
void hook

/** Deterministic clock: timers fire only via advance(). */
function manualClock(start = 1_000_000) {
  let now = start
  let seq = 0
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(handler, ms) {
      const id = `t${seq += 1}`
      timers.set(id, { handler, at: now + ms })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.handler()
        }
      }
    },
    pending: () => timers.size,
  }
}

const SNAPSHOT = {
  center: [116.123456789, 39.987654321],
  zoom: 9.5,
  extent: [115.1, 39.1, 117.1, 40.1],
  wkid: 4326,
  mode: 'map',
}

function emittedOf(clock, observer, extra = {}) {
  const emitted = []
  const observerRef = observer ?? gesture.createGestureObserver({
    sessionId: 's1', occurrenceKey: 'view:map', generationOf: () => 3,
    emit: (text, observation) => emitted.push({ text, observation }),
    clock, ...extra,
  })
  return { emitted, observer: observerRef }
}

test('observation text round-trips through the versioned marker', () => {
  const observation = {
    ...SNAPSHOT, version: gesture.GESTURE_TEXT_VERSION,
    sessionId: 's1', occurrenceKey: 'view:map', generation: 3, kind: 'stable',
    at: '2026-10-07T02:00:00.000Z',
  }
  const serialized = gesture.serializeObservationText(observation)
  assert.equal(serialized.ok, true)
  assert.ok(serialized.text.startsWith('[map-gesture v1]\n'))
  const parsed = gesture.parseObservationText(serialized.text)
  assert.equal(parsed.ok, true)
  assert.deepEqual(
    { ...parsed.observation, at: parsed.observation.at },
    { ...observation, center: [116.123457, 39.987654] },
  )
})

test('foreign text parses as a quiet not-gesture, never an error', () => {
  assert.equal(gesture.parseObservationText('你好，帮我分析这个区域').reason, 'not-gesture')
})

test('unknown marker versions and malformed payloads refuse with stable reasons', () => {
  assert.equal(gesture.parseObservationText('[map-gesture v9]\n{}').reason, 'unknown-version')
  assert.equal(gesture.parseObservationText('[map-gesture v1]\nnot-json').reason, 'invalid-payload')
  assert.equal(gesture.parseObservationText('[map-gesture v1]').reason, 'invalid-payload')
  assert.equal(gesture.parseObservationText(`[map-gesture v1]\n${'x'.repeat(gesture.GESTURE_MAX_OBSERVATION_BYTES + 1)}`).reason, 'oversized')
})

test('oversized and invalid observations refuse at serialization', () => {
  const oversized = {
    ...SNAPSHOT, version: gesture.GESTURE_TEXT_VERSION,
    sessionId: 's'.repeat(gesture.GESTURE_MAX_OBSERVATION_BYTES), occurrenceKey: 'o',
    generation: 0, kind: 'stable', at: '2026-10-07T02:00:00.000Z',
  }
  assert.equal(gesture.serializeObservationText(oversized).reason, 'oversized')
  const invalid = { ...SNAPSHOT, version: gesture.GESTURE_TEXT_VERSION, sessionId: '', occurrenceKey: 'o', generation: -1, kind: 'other', at: 'nope' }
  assert.equal(gesture.serializeObservationText(invalid).reason, 'invalid')
})

test('submission policy: stable steers only a running turn; explicit always queues', () => {
  assert.equal(gesture.gestureSubmitMode('stable', true), 'steer')
  assert.equal(gesture.gestureSubmitMode('stable', false), null)
  assert.equal(gesture.gestureSubmitMode('explicit', false), 'queue')
  assert.equal(gesture.gestureSubmitMode('explicit', true), 'queue')
})

test('camera changes without an open interaction window never form drafts', () => {
  const clock = manualClock()
  const { emitted, observer } = emittedOf(clock)
  observer.cameraChanged(SNAPSHOT)
  clock.advance(gesture.GESTURE_SETTLE_MS + 1)
  assert.equal(emitted.length, 0)
  assert.equal(observer.metrics.draftsFormed, 0)
})

test('interaction window + settle produce one bounded stable observation', () => {
  const clock = manualClock()
  const { emitted, observer } = emittedOf(clock)
  observer.interaction()
  observer.cameraChanged(SNAPSHOT)
  clock.advance(100)
  observer.cameraChanged({ ...SNAPSHOT, zoom: 9.6 })
  assert.equal(observer.metrics.draftsFormed, 1, 'one gesture sequence forms one draft')
  clock.advance(gesture.GESTURE_SETTLE_MS + 1)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].observation.kind, 'stable')
  assert.equal(emitted[0].observation.generation, 3)
  assert.equal(emitted[0].observation.zoom, 9.6)
  const parsed = gesture.parseObservationText(emitted[0].text)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.observation.sessionId, 's1')
  assert.equal(observer.metrics.stableEmitted, 1)
})

test('programmatic camera writes are never attributed to the user', () => {
  const clock = manualClock()
  const { emitted, observer } = emittedOf(clock)
  observer.interaction()
  observer.programmatic()
  observer.cameraChanged(SNAPSHOT)
  clock.advance(gesture.GESTURE_SETTLE_MS + 1)
  assert.equal(emitted.length, 0)
  // After the pulse expires a fresh gesture attributions again.
  clock.advance(gesture.GESTURE_PROGRAMMATIC_PULSE_MS)
  observer.interaction()
  observer.cameraChanged(SNAPSHOT)
  clock.advance(gesture.GESTURE_SETTLE_MS + 1)
  assert.equal(emitted.length, 1)
})

test('rate cap holds the latest settle and emits it after the interval', () => {
  const clock = manualClock()
  const { emitted, observer } = emittedOf(clock)
  observer.interaction()
  observer.cameraChanged(SNAPSHOT)
  clock.advance(gesture.GESTURE_SETTLE_MS + 1)
  assert.equal(emitted.length, 1)
  const second = { ...SNAPSHOT, zoom: 11 }
  observer.interaction()
  observer.cameraChanged(second)
  clock.advance(gesture.GESTURE_SETTLE_MS + 1)
  assert.equal(emitted.length, 1)
  assert.equal(observer.metrics.deferredByRate, 1)
  clock.advance(gesture.GESTURE_STEER_MIN_INTERVAL_MS - gesture.GESTURE_SETTLE_MS - 1)
  assert.equal(emitted.length, 2)
  assert.equal(emitted[1].observation.zoom, 11)
})

test('explicit submission bypasses the window and the rate cap', () => {
  const clock = manualClock()
  const { emitted, observer } = emittedOf(clock)
  observer.explicit(SNAPSHOT)
  observer.explicit({ ...SNAPSHOT, zoom: 12 })
  assert.equal(emitted.length, 2)
  assert.equal(emitted[0].observation.kind, 'explicit')
  assert.equal(observer.metrics.explicitEmitted, 2)
})

test('dispose cancels pending settles and deferrals', () => {
  const clock = manualClock()
  const { emitted, observer } = emittedOf(clock)
  observer.interaction()
  observer.cameraChanged(SNAPSHOT)
  observer.dispose()
  clock.advance(gesture.GESTURE_SETTLE_MS + gesture.GESTURE_STEER_MIN_INTERVAL_MS + 10)
  assert.equal(emitted.length, 0)
})

// ── occurrence wiring ────────────────────────────────────────────────────────

function flush() {
  return new Promise(resolve => setImmediate(resolve))
}

function stateOf({ mode = 'map', wkid = 4326, center = [116.4, 39.9], zoom = 9, layers = [], revision = 0 } = {}) {
  return {
    mode,
    view: { center, zoom, wkid },
    layers: new Map(layers.map(layer => [layer.id, layer])),
    revision,
  }
}

test('user camera gestures on the live view reach the emission sink as bounded text', async () => {
  resetCaptured()
  const clock = manualClock()
  const emitted = []
  let current = stateOf()
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map', {
    onGestureObservation: (text, observation) => emitted.push({ text, observation }),
    gestureClock: clock,
  })
  occurrence.mount(new FakeDiv())
  await flush()
  const view = captured.mapViews[0]
  view.center = { x: 116.5, y: 39.5 }
  view.extent = { xmin: 115, ymin: 39, xmax: 118, ymax: 41 }
  view.zoom = 10
  view.spatialReference = { wkid: 3857 }
  // The mount-time camera sync is a programmatic write; let its pulse expire
  // before the user gesture so attribution is live.
  clock.advance(gesture.GESTURE_PROGRAMMATIC_PULSE_MS + 1)
  fireViewEvent(view, 'pointer-drag')
  fireWatch(captured.watches.at(-1))
  clock.advance(gesture.GESTURE_SETTLE_MS + 1)
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].observation.kind, 'stable')
  assert.deepEqual(emitted[0].observation.center, [116.5, 39.5])
  assert.equal(emitted[0].observation.wkid, 3857)
  const parsed = gesture.parseObservationText(emitted[0].text)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.observation.occurrenceKey, 'view:map')
  occurrence.dispose()
})

test('programmatic camera sync never produces a gesture observation', async () => {
  resetCaptured()
  const clock = manualClock()
  const emitted = []
  let current = stateOf()
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map', {
    onGestureObservation: (text, observation) => emitted.push({ text, observation }),
    gestureClock: clock,
  })
  occurrence.mount(new FakeDiv())
  await flush()
  const view = captured.mapViews[0]
  view.center = { x: 116.4, y: 39.9 }
  view.extent = { xmin: 115, ymin: 39, xmax: 118, ymax: 41 }
  view.zoom = 9
  // Authority-driven sync (map_set_view / focus): mutes attribution, then moves.
  current = stateOf({ zoom: 12, revision: 1 })
  occurrence.refresh(current)
  await flush()
  fireWatch(captured.watches.at(-1))
  clock.advance(gesture.GESTURE_SETTLE_MS + 1)
  assert.equal(emitted.length, 0)
  occurrence.dispose()
})

test('explicit submit emits the current camera and reports a missing view', async () => {
  resetCaptured()
  const clock = manualClock()
  const emitted = []
  let current = stateOf()
  const occurrence = createMapOccurrence(() => current, 's1', 'view:map', {
    onGestureObservation: (text, observation) => emitted.push({ text, observation }),
    gestureClock: clock,
  })
  assert.equal(occurrence.submitGestureObservation(), 'no-view')
  occurrence.mount(new FakeDiv())
  await flush()
  const view = captured.mapViews[0]
  view.center = { x: 116, y: 39 }
  view.extent = { xmin: 115, ymin: 39, xmax: 118, ymax: 41 }
  view.zoom = 9
  view.spatialReference = { wkid: 3857 }
  assert.equal(occurrence.submitGestureObservation(), 'emitted')
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].observation.kind, 'explicit')
  const metrics = occurrence.getGestureMetrics()
  assert.equal(metrics.explicitEmitted, 1)
  assert.ok(metrics.lastText.startsWith('[map-gesture v1]'))
  occurrence.dispose()
})
