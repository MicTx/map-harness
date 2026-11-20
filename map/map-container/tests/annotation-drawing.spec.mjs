import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  annotationGeometryOf,
  createAnnotationDrawingHost,
} from '../src/client/annotation-drawing.ts'
class FakeDiv {}
if (globalThis.HTMLDivElement === undefined) globalThis.HTMLDivElement = FakeDiv

const flush = () => new Promise(resolve => setImmediate(resolve))

function layer() {
  return {
    removed: [],
    destroyed: false,
    removeAll() { this.removed.push('all') },
    destroy() { this.destroyed = true },
  }
}

function sketch() {
  return {
    listeners: new Map(),
    createCalls: [],
    updateCalls: [],
    cancels: 0,
    on(name, listener) {
      const list = this.listeners.get(name) ?? []
      list.push(listener)
      this.listeners.set(name, list)
      return { remove: () => this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== listener)) }
    },
    async create(tool, options) { this.createCalls.push({ tool, ...options }) },
    async update(graphic, options) { this.updateCalls.push({ graphic, ...options }) },
    cancel() {
      this.cancels += 1
      for (const listener of this.listeners.get('create') ?? []) listener({ state: 'cancel' })
    },
    complete(geometry) {
      for (const listener of this.listeners.get('create') ?? []) listener({ state: 'complete', graphic: { geometry } })
    },
    completeUpdate(geometry) {
      for (const listener of this.listeners.get('update') ?? []) listener({ state: 'complete', graphics: [{ geometry }] })
    },
  }
}

function host({ project = async geometry => geometry, submit = async () => {}, submitUpdate = async () => {}, mode = 'map', rejectCreate = false } = {}) {
  const states = []
  const submitted = []
  const layers = []
  const sketches = []
  const controller = createAnnotationDrawingHost({
    viewOf: () => ({ id: 'view' }),
    modeOf: () => mode,
    createLayer: () => {
      const created = layer()
      layers.push(created)
      return created
    },
    createSketch: (_view, createdLayer) => {
      const created = sketch()
      if (rejectCreate) created.create = async () => { throw new Error('sdk rejected') }
      sketches.push({ model: created, layer: createdLayer })
      return created
    },
    projectGeometry: project,
    submit: async (geometry, kind) => {
      submitted.push({ geometry, kind })
      await submit(geometry, kind)
    },
    submitUpdate: async (featureId, geometry, expectedUpdatedAt) => {
      submitted.push({ geometry, featureId, expectedUpdatedAt })
      await submitUpdate(featureId, geometry, expectedUpdatedAt)
    },
    onState: next => states.push(next),
  })
  return { controller, states, submitted, layers, sketches }
}

test('projected ArcGIS geometry converts to all four annotation geometry families', () => {
  assert.deepEqual(annotationGeometryOf({ type: 'point', x: 1, y: 2 }), { type: 'Point', coordinates: [1, 2] })
  assert.deepEqual(annotationGeometryOf({ type: 'polyline', paths: [[[1, 2], [3, 4]]] }), {
    type: 'LineString',
    coordinates: [[1, 2], [3, 4]],
  })
  assert.deepEqual(annotationGeometryOf({ type: 'polygon', rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }), {
    type: 'Polygon',
    coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]],
  })
  assert.equal(annotationGeometryOf({ type: 'mesh' }), undefined)
})

test('the host submits completed drafts and clears temporary graphics', async () => {
  const rig = host()
  assert.equal(await rig.controller.start('point'), 'started')
  assert.deepEqual(rig.controller.state, { status: 'drawing', kind: 'point', lastError: null })
  assert.deepEqual(rig.sketches[0].model.createCalls, [{ tool: 'point', mode: 'click' }])
  rig.sketches[0].model.complete({ type: 'point', x: 116, y: 39 })
  await flush()
  assert.deepEqual(rig.submitted, [{ geometry: { type: 'Point', coordinates: [116, 39] }, kind: 'point' }])
  assert.deepEqual(rig.controller.state, { status: 'idle', kind: null, lastError: null })
  assert.equal(rig.layers[0].destroyed, true)
})

test('rectangle maps to the polygon sketch tool and line maps to polyline', async () => {
  const rig = host()
  await rig.controller.start('rectangle')
  rig.sketches[0].model.complete({ type: 'polygon', rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })
  await flush()
  await rig.controller.start('line')
  rig.sketches[1].model.complete({ type: 'polyline', paths: [[[0, 0], [1, 1]]] })
  await flush()
  assert.deepEqual(rig.sketches.map(entry => entry.model.createCalls[0].tool), ['rectangle', 'polyline'])
  assert.deepEqual(rig.submitted.map(entry => entry.kind), ['rectangle', 'line'])
})

test('cancel and disposal remove drafts and reject late completion', async () => {
  const rig = host()
  await rig.controller.start('polygon')
  assert.equal(rig.controller.cancel(), true)
  assert.deepEqual(rig.controller.state, { status: 'idle', kind: null, lastError: null })
  assert.equal(rig.layers[0].destroyed, true)
  rig.sketches[0].model.complete({ type: 'polygon', rings: [[[0, 0], [1, 0], [1, 1], [0, 0]]] })
  await flush()
  assert.deepEqual(rig.submitted, [])

  await rig.controller.start('point')
  rig.controller.dispose()
  assert.equal(rig.layers[1].destroyed, true)
})

test('editing submits a completed update and cancels before a late projection resolves', async () => {
  let resolveProjection
  const rig = host({ project: () => new Promise(resolve => { resolveProjection = resolve }) })
  const graphic = { geometry: { type: 'point', x: 116, y: 39 } }
  assert.equal(await rig.controller.startEditing('ann-1', graphic, '2026-11-04T00:00:00.000Z'), 'started')
  assert.deepEqual(rig.sketches[0].model.updateCalls, [{ graphic, tool: 'reshape' }])
  rig.sketches[0].model.completeUpdate({ type: 'point', x: 116, y: 39 })
  await flush()
  assert.deepEqual(rig.submitted, [])
  assert.equal(rig.controller.cancel(), true)
  resolveProjection({ type: 'point', x: 116, y: 39 })
  await flush()
  assert.deepEqual(rig.submitted, [])
  assert.equal(rig.layers[0].destroyed, true)

  assert.equal(await rig.controller.startEditing('ann-1', graphic, '2026-11-04T00:00:00.000Z'), 'started')
  rig.sketches[1].model.completeUpdate({ type: 'point', x: 117, y: 40 })
  resolveProjection({ type: 'point', x: 117, y: 40 })
  await flush()
  assert.deepEqual(rig.submitted, [{
    geometry: { type: 'Point', coordinates: [117, 40] },
    featureId: 'ann-1',
    expectedUpdatedAt: '2026-11-04T00:00:00.000Z',
  }])
  assert.equal(rig.layers[1].destroyed, true)
})

test('an SDK create rejection releases the draft and returns the host to idle', async () => {
  const rig = host({ rejectCreate: true })
  await assert.rejects(() => rig.controller.start('point'), /sdk rejected/)
  assert.deepEqual(rig.controller.state, { status: 'idle', kind: null, lastError: null })
  assert.equal(rig.layers[0].destroyed, true)
  assert.equal(rig.controller.cancel(), false)
})

test('invalid projected geometry refuses without a submit', async () => {
  const rig = host()
  await rig.controller.start('point')
  rig.sketches[0].model.complete({ type: 'point', x: 181, y: 0 })
  await flush()
  assert.deepEqual(rig.submitted, [])
  assert.deepEqual(rig.controller.state, { status: 'idle', kind: null, lastError: 'geometry-invalid' })
})

test('a refused create reports submission failure instead of success', async () => {
  const rig = host({ submit: async () => { throw new Error('host refused') } })
  await rig.controller.start('point')
  rig.sketches[0].model.complete({ type: 'point', x: 116, y: 39 })
  await flush()
  assert.deepEqual(rig.submitted.map(({ kind }) => kind), ['point'])
  assert.deepEqual(rig.controller.state, { status: 'idle', kind: null, lastError: 'submit-failed' })
  assert.equal(rig.layers[0].destroyed, true)
})
