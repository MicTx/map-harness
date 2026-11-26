/**
 * Capture-transaction and georeference math fixtures: the exact affine
 * formula from three toMap corner samples, the four independent control
 * points, the world-bound gates, the composite canvas seam, frozen-identity
 * invalidation, and the no-evidence paths (stale, unreadable camera,
 * refused context).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveGeoreference, fitAffineCoefficients, affineForward, maxCssResidual } from '../src/client/capture-math.ts'
import { cancelObservation, captureViewOf, compositeCapture, runCaptureTransaction, runCaptureWithUpdatingRetry, observationSources, waitForCaptureFrame } from '../src/client/observation-capture.ts'
import { createMapSourceCatalog } from '../src/sources.ts'
import { waybackDescriptor } from '../src/wayback.ts'

/** Linear map-plane: world = css scaled by s around origin (a known analytic transform). */
const scaledView = (scale, { width = 800, height = 600, wkid = 3857, shotW = 1600, shotH = 1200 } = {}) => ({
  destroyed: false,
  width, height,
  padding: { top: 0, right: 0, bottom: 0, left: 0 },
  rotation: 0,
  scale,
  zoom: 10,
  center: { x: 500, y: -300 },
  extent: { xmin: 500 - width * scale / 2, ymin: -300 - height * scale / 2, xmax: 500 + width * scale / 2, ymax: -300 + height * scale / 2 },
  spatialReference: { wkid },
  takeScreenshotCalls: [],
  takeScreenshot(options) {
    this.takeScreenshotCalls.push(options)
    return Promise.resolve({ dataUrl: 'data:image/png;base64,AAAA', width: shotW, height: shotH })
  },
  toMap(point) { return { x: point.x * scale + 100, y: -point.y * scale + 50 } },
})

const decodeImage = () => Promise.resolve({ width: 1600, height: 1200, source: {} })
const operation = () => ({ signal: new AbortController().signal, expiresAtMs: Date.now() + 5_000 })

const identity = () => ({
  viewId: 'v1', generation: 0, mapRevision: 2, cameraEpoch: 0, gestureEpoch: 0,
  sourceDigest: 'd', renderedRevision: 2, layersHealthy: true,
  cameraSignature: 'camera-0', layoutSignature: 'layout-0', paintSignature: 'paint-0',
})

const fakeCanvasDom = () => {
  const previous = { document: globalThis.document }
  const canvases = []
  globalThis.document = {
    createElement: () => {
      const text = []
      const context = {
        drawImage() {}, fillRect() {},
        fillText: value => text.push(value),
        strokeText() {},
        measureText: value => ({ width: Array.from(value).length * 6 }),
        set font(v) {}, set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set textAlign(v) {}, set textBaseline(v) {},
      }
      const canvas = { width: 0, height: 0, context, text, getContext: () => context, toDataURL: () => 'data:image/png;base64,COMPOSITE' }
      canvases.push(canvas)
      return canvas
    },
  }
  const restore = () => { globalThis.document = previous.document }
  restore.canvases = canvases
  return restore
}

test('affine coefficients follow the exact formula for image pixels', () => {
  // scale=2 world units per css px, offset (100,50), y flipped. Image is 2x css (DPR 2).
  const css = 800 / 1600 // css per image px = 0.5
  const p0 = { css: [0, 0], world: [100, 50] }
  const p1 = { css: [800, 0], world: [800 * 2 + 100, 50] }
  const p2 = { css: [0, 600], world: [100, -600 * 2 + 50] }
  const c = fitAffineCoefficients(p0, p1, p2, 1600, 1200)
  assert.deepEqual(c, [1, 0, 100, 0, -1, 50])
  assert.deepEqual(affineForward(c, 1600, 0), [1700, 50])
  assert.deepEqual(affineForward(c, 0, 1200), [100, -1150])
})

test('independent control points validate below one CSS pixel; outliers refuse', () => {
  const scale = 2
  const sample = (x, y) => ({ css: [x, y], world: [x * scale + 100, -y * scale + 50] })
  const p0 = sample(0, 0), p1 = sample(800, 0), p2 = sample(0, 600)
  const controls = [sample(800, 600), sample(400, 300), sample(200, 450), sample(600, 150)]
  const geo = deriveGeoreference('map', 3857, p0, p1, p2, controls, 800, 600, 1600, 1200)
  assert.equal(geo.kind, 'affine-2d')
  assert.ok(geo.maxResidualCssPx <= 1)
  // A shifted control point breaks the affine: residual exceeds one CSS px.
  const broken = [controls[0], controls[1], controls[2], { css: [600, 150], world: [600 * scale + 100 + 300, -150 * scale + 50] }]
  const refused = deriveGeoreference('map', 3857, p0, p1, p2, broken, 800, 600, 1600, 1200)
  assert.equal(refused.kind, 'none')
  assert.equal(refused.reason, 'excessive-residual')
})

test('georeference gates: scene, unsupported wkid, non-finite, world wrap', () => {
  const s = (x, y) => ({ css: [x, y], world: [x * 2 + 100, -y * 2 + 50] })
  const p0 = s(0, 0), p1 = s(800, 0), p2 = s(0, 600)
  const controls = [s(800, 600), s(400, 300), s(200, 450), s(600, 150)]
  assert.equal(deriveGeoreference('scene', 3857, p0, p1, p2, controls, 800, 600, 1600, 1200).reason, 'not-2d')
  assert.equal(deriveGeoreference('map', 4490, p0, p1, p2, controls, 800, 600, 1600, 1200).reason, 'unsupported-projection')
  const bad = [{ css: [800, 600], world: [NaN, 0] }, ...controls.slice(1)]
  assert.equal(deriveGeoreference('map', 3857, p0, p1, p2, bad, 800, 600, 1600, 1200).reason, 'non-finite-samples')
  // Geographic wrap: a control beyond +/-180 degrees refuses as world-wrap.
  const wrapped = [{ css: [800, 600], world: [200, 0] }, controls[1], controls[2], controls[3]]
  assert.equal(deriveGeoreference('map', 4326, p0, p1, p2, wrapped, 800, 600, 1600, 1200).reason, 'world-wrap')
})

test('a successful transaction composites, records rects, and carries affine evidence', async () => {
  const restore = fakeCanvasDom()
  try {
    const view = scaledView(2)
    const frozen = identity()
    const product = await runCaptureTransaction(view, 'map', () => frozen, frozen, [{ key: 'k', text: 'label', x: 10, y: 20, color: '#fff' }], 'Source: Esri', decodeImage, operation())
    assert.equal('refusal' in product, false)
    assert.equal(product.pngBase64, 'COMPOSITE')
    assert.deepEqual(product.imageSize, { width: 1600, height: 1240 })
    assert.deepEqual(product.mapContentRect, { x: 0, y: 0, width: 1600, height: 1200 })
    assert.deepEqual(product.cssViewSize, { width: 800, height: 600 })
    assert.equal(product.georeference.kind, 'affine-2d')
    assert.equal(product.camera.wkid, 3857)
    assert.deepEqual(view.takeScreenshotCalls, [{ format: 'png', ignorePadding: true, width: 800, height: 600 }])
  } finally { restore() }
})

test('a stale screenshot retries after updating settles without changing capture identity', async () => {
  const frozen = { ...identity(), renderUpdateEpoch: 0, updating: false }
  let live = frozen
  let captures = 0
  let frames = 0
  let settled = false
  const previousFrame = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  globalThis.requestAnimationFrame = callback => {
    frames += 1
    if (frames === 1) {
      live = { ...live, renderUpdateEpoch: 2, updating: false }
      settled = true
    }
    queueMicrotask(() => callback(frames))
    return frames
  }
  try {
    const result = await runCaptureWithUpdatingRetry(
      frozen,
      () => live,
      () => true,
      () => live.updating === false && settled,
      async retryIdentity => {
        captures += 1
        if (captures === 1) {
          live = { ...live, renderUpdateEpoch: 1, updating: true }
          return { refusal: 'stale' }
        }
        assert.equal(retryIdentity.renderUpdateEpoch, 2)
        assert.equal(retryIdentity.updating, false)
        return { pngBase64: 'accepted', imageSize: { width: 1, height: 1 }, mapContentRect: { x: 0, y: 0, width: 1, height: 1 }, cssViewSize: { width: 1, height: 1 }, camera: null, georeference: { kind: 'none', reason: 'unreadable-camera' } }
      },
      operation(),
    )
    assert.equal('refusal' in result, false)
    assert.equal(captures, 2)
    assert.equal(frames, 3, 'the transition frame is followed by two stable frames')
  } finally {
    if (previousFrame === undefined) delete globalThis.requestAnimationFrame
    else Object.defineProperty(globalThis, 'requestAnimationFrame', previousFrame)
  }
})

test('updating retry refuses when any stable capture identity changes', async t => {
  for (const [field, change] of [
    ['view', live => ({ ...live, viewId: 'view-1' })],
    ['generation', live => ({ ...live, generation: live.generation + 1 })],
    ['revision', live => ({ ...live, mapRevision: 1 })],
    ['camera epoch', live => ({ ...live, cameraEpoch: live.cameraEpoch + 1 })],
    ['gesture epoch', live => ({ ...live, gestureEpoch: live.gestureEpoch + 1 })],
    ['source', live => ({ ...live, sourceDigest: 'source-1' })],
    ['rendered revision', live => ({ ...live, renderedRevision: 1 })],
    ['render health', live => ({ ...live, layersHealthy: false })],
    ['camera', live => ({ ...live, cameraSignature: 'camera-1' })],
    ['layout', live => ({ ...live, layoutSignature: 'layout-1' })],
    ['paint health', live => ({ ...live, paintSignature: 'paint-1' })],
  ]) {
    await t.test(field, async () => {
      const frozen = { ...identity(), renderUpdateEpoch: 0, updating: false }
      let live = frozen
      let captures = 0
      const result = await runCaptureWithUpdatingRetry(
        frozen,
        () => live,
        () => true,
        () => false,
        async () => {
          captures += 1
          live = { ...change(live), renderUpdateEpoch: 1, updating: true }
          return { refusal: 'stale' }
        },
        operation(),
      )
      assert.deepEqual(result, { refusal: 'stale' })
      assert.equal(captures, 1)
    })
  }
})

test('updating that remains active through the deadline never retries a screenshot', async () => {
  const frozen = { ...identity(), renderUpdateEpoch: 0, updating: false }
  const live = { ...frozen, renderUpdateEpoch: 1, updating: true }
  let captures = 0
  await assert.rejects(runCaptureWithUpdatingRetry(
    frozen,
    () => live,
    () => true,
    () => false,
    async () => {
      captures += 1
      return { refusal: 'stale' }
    },
    { signal: new AbortController().signal, expiresAtMs: Date.now() + 40 },
  ), { name: 'TimeoutError' })
  assert.equal(captures, 1)
})

test('updating does not hide a stable identity change witnessed inside a capture stage', async () => {
  const frozen = { ...identity(), renderUpdateEpoch: 0, updating: false }
  let live = frozen
  let captures = 0
  const result = await runCaptureWithUpdatingRetry(frozen, () => live, () => true, () => true, async (_frozen, readIdentity) => {
    captures += 1
    live = { ...frozen, paintSignature: 'suspended', renderUpdateEpoch: 1, updating: true }
    readIdentity()
    live = { ...frozen, renderUpdateEpoch: 2 }
    return { refusal: 'stale' }
  }, operation())
  assert.deepEqual(result, { refusal: 'stale' })
  assert.equal(captures, 1)
})

test('a replaced request cannot accept a successful screenshot', async () => {
  const frozen = { ...identity(), renderUpdateEpoch: 0, updating: false }
  let requestIsCurrent = true
  const result = await runCaptureWithUpdatingRetry(frozen, () => frozen, () => requestIsCurrent, () => true, async () => {
    requestIsCurrent = false
    return { pngBase64: 'discarded' }
  }, operation())
  assert.deepEqual(result, { refusal: 'stale' })
})

test('a capture deadline removes the queued animation frame without waiting for paint', async t => {
  const frames = new Set()
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const raf = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  const cancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame')
  globalThis.requestAnimationFrame = callback => { frames.add(callback); return callback }
  globalThis.cancelAnimationFrame = callback => { frames.delete(callback) }
  t.after(() => {
    if (raf === undefined) delete globalThis.requestAnimationFrame
    else Object.defineProperty(globalThis, 'requestAnimationFrame', raf)
    if (cancel === undefined) delete globalThis.cancelAnimationFrame
    else Object.defineProperty(globalThis, 'cancelAnimationFrame', cancel)
  })
  const result = waitForCaptureFrame({ ...operation(), expiresAtMs: Date.now() + 40 })
  assert.equal(frames.size, 1)
  t.mock.timers.tick(40)
  await assert.rejects(result, { name: 'TimeoutError' })
  assert.equal(frames.size, 0)
})

test('every frozen identity member invalidates blocked SDK and decode stages', async t => {
  const changes = [
    ['viewId', current => ({ ...current, viewId: 'view-replaced' })],
    ['generation', current => ({ ...current, generation: current.generation + 1 })],
    ['mapRevision', current => ({ ...current, mapRevision: current.mapRevision + 1 })],
    ['renderedRevision', current => ({ ...current, renderedRevision: current.renderedRevision + 1 })],
    ['sourceDigest', current => ({ ...current, sourceDigest: 'source-replaced' })],
    ['layersHealthy', current => ({ ...current, layersHealthy: false })],
    ['cameraEpoch', current => ({ ...current, cameraEpoch: current.cameraEpoch + 1 })],
    ['gestureEpoch', current => ({ ...current, gestureEpoch: current.gestureEpoch + 1 })],
    ['cameraSignature', current => ({ ...current, cameraSignature: 'camera-replaced' })],
    ['layoutSignature', current => ({ ...current, layoutSignature: 'layout-replaced' })],
    ['paintSignature', current => ({ ...current, paintSignature: 'paint-replaced' })],
  ]
  for (const [field, mutate] of changes) {
    for (const stage of ['sdk', 'decode']) {
      await t.test(`${field} changes while ${stage} is blocked`, { timeout: 5_000 }, async () => {
        const restore = fakeCanvasDom()
        const frozen = identity()
        let live = frozen
        let releaseStage
        let markStarted
        let decodeCalls = 0
        const started = new Promise(resolve => { markStarted = resolve })
        const view = scaledView(2)
        if (stage === 'sdk') {
          view.takeScreenshot = () => new Promise(resolve => {
            releaseStage = resolve
            markStarted()
          })
        } else {
          view.takeScreenshot = () => Promise.resolve({ dataUrl: 'data:image/png;base64,AAAA', width: 1600, height: 1200 })
        }
        try {
          const pending = runCaptureTransaction(
            view,
            'map',
            () => live,
            frozen,
            [],
            'Source: Esri',
            () => {
              decodeCalls += 1
              if (stage === 'sdk') return Promise.resolve({ width: 1600, height: 1200, source: {} })
              return new Promise(resolve => {
                releaseStage = resolve
                markStarted()
              })
            },
            operation(),
          )
          await started
          live = mutate(frozen)
          releaseStage({ dataUrl: 'data:image/png;base64,AAAA', width: 1600, height: 1200, source: {} })
          const result = await pending
          assert.equal('refusal' in result, true)
          assert.equal(result.refusal, 'stale')
          assert.equal(decodeCalls, stage === 'sdk' ? 0 : 1)
        } finally {
          releaseStage?.({ dataUrl: 'data:image/png;base64,AAAA', width: 1600, height: 1200, source: {} })
          restore()
        }
      })
    }
  }
})

test('an aborted screenshot ignores a late SDK result and never enters decode/composition', async () => {
  const restore = fakeCanvasDom()
  try {
    const view = scaledView(2)
    let releaseScreenshot
    let decodeCalls = 0
    view.takeScreenshot = () => new Promise(resolve => { releaseScreenshot = resolve })
    const controller = new AbortController()
    const expiresAtMs = Date.now() + 5_000
    const pending = runCaptureTransaction(view, 'map', identity, identity(), [], 'a', async () => {
      decodeCalls += 1
      return { width: 1600, height: 1200, source: {} }
    }, { signal: controller.signal, expiresAtMs })
    await Promise.resolve()
    controller.abort(new DOMException('map observation identity changed', 'AbortError'))
    const result = await pending
    assert.equal('refusal' in result, true)
    assert.equal(result.refusal, 'capture-failed')
    releaseScreenshot({ dataUrl: 'data:image/png;base64,AAAA', width: 1600, height: 1200 })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(decodeCalls, 0)
  } finally { restore() }
})

test('terminal cancellation bounds a blocked HTTP cleanup request by the original deadline', async () => {
  const previousFetch = globalThis.fetch
  let seenSignal
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    seenSignal = options.signal
    seenSignal.addEventListener('abort', () => reject(seenSignal.reason), { once: true })
  })
  try {
    const startedAt = Date.now()
    const result = await cancelObservation(
      { sessionId: 's', callId: 'c', requestSeq: 1 },
      'claim-token',
      startedAt + 30,
    )
    assert.equal(result, false)
    assert.equal(seenSignal.aborted, true)
    assert.ok(Date.now() - startedAt < 1_000)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('an unreadable camera still composes with georeference none + unreadable-camera', async () => {
  const restore = fakeCanvasDom()
  try {
    const view = scaledView(2)
    view.center = undefined
    const product = await runCaptureTransaction(view, 'map', identity, identity(), [], 'a', decodeImage, operation())
    assert.equal('refusal' in product, false)
    assert.equal(product.camera, null)
    assert.equal(product.georeference.kind, 'none')
    assert.equal(product.georeference.reason, 'unreadable-camera')
  } finally { restore() }
})

test('no canvas context is a hard refusal, never a silent uncomposited image', async () => {
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => null }) }
  try {
    const product = await runCaptureTransaction(scaledView(2), 'map', identity, identity(), [], 'a', decodeImage, operation())
    assert.equal('refusal' in product, true)
    assert.equal(product.refusal, 'no-context')
  } finally { delete globalThis.document }
})

test('captureViewOf reads the installed SDK Screenshot.data dimensions', async () => {
  const restore = fakeCanvasDom()
  try {
    const view = scaledView(2)
    let screenshotOptions
    view.takeScreenshot = async options => {
      screenshotOptions = options
      return ({
      dataUrl: 'data:image/png;base64,AAAA',
      data: { width: 1600, height: 1200, data: new Uint8ClampedArray(1600 * 1200 * 4) },
      })
    }
    const adapted = captureViewOf(view)
    const frozen = identity()
    const result = await runCaptureTransaction(adapted, 'map', () => frozen, frozen, [], 'Source: Esri', decodeImage, operation())
    assert.equal('refusal' in result, false, JSON.stringify(result))
    assert.deepEqual(result.imageSize, { width: 1600, height: 1240 })
    assert.deepEqual(result.mapContentRect, { x: 0, y: 0, width: 1600, height: 1200 })
    assert.deepEqual(screenshotOptions, { format: 'png', ignorePadding: true, width: 800, height: 600 })
  } finally { restore() }
})

test('attribution wraps at its full font size and refuses text it cannot fit', async () => {
  const restore = fakeCanvasDom()
  try {
    const shot = { dataUrl: 'data:image/png;base64,AAAA', width: 120, height: 80 }
    const decoded = async () => ({ width: 120, height: 80, source: {} })
    const wrapped = await compositeCapture(shot, { width: 120, height: 80 }, [], 'Source: One Two Three Four Five Six Seven Eight', decoded)
    assert.ok(wrapped)
    assert.deepEqual(wrapped.mapContentRect, { x: 0, y: 0, width: 120, height: 80 })
    assert.ok(wrapped.imageSize.height > shot.height)
    const imageCanvas = restore.canvases.at(-1)
    assert.ok(imageCanvas.text.length > 1, 'the footer wraps into multiple rows')
    assert.equal(await compositeCapture(shot, { width: 120, height: 80 }, [], 'x'.repeat(513), decoded), null)
    assert.equal(
      await compositeCapture({ ...shot, width: 1 }, { width: 1, height: 80 }, [], 'A', async () => ({ width: 1, height: 80, source: {} })),
      null,
    )
  } finally { restore() }
})

test('visible imagery overlays are unverified; hidden and zero-opacity are free', () => {
  const layers = [
    { id: 'v1', visible: true, opacity: 1, displayDigest: 'abc' },
    { id: 'img-hidden', visible: false, opacity: 1, imagery: { kind: 'tile' } },
    { id: 'img-off', visible: true, opacity: 0, imagery: { kind: 'tile' } },
    { id: 'img-live', visible: true, opacity: 1, imagery: { kind: 'tile' } },
  ]
  const { sources, hasUnverified } = observationSources(layers)
  assert.equal(hasUnverified, true)
  assert.equal(sources.length, 3)
  assert.equal(sources[0].id, 'esri-world-imagery')
  assert.equal(sources[0].policy, 'fixed')
  assert.equal(sources[1].id, 'v1')
  assert.equal(sources[1].policy, 'approved')
  assert.equal(sources[2].id, 'img-live')
  assert.equal(sources[2].policy, 'unverified')
  const clear = observationSources(layers.slice(0, 3))
  assert.equal(clear.hasUnverified, false)
})

test('explicitly disabled labels and invisible sources are omitted from capture evidence', () => {
  const catalog = createMapSourceCatalog(undefined, 'allow', {})
  const labels = catalog.descriptorOf('amap-imagery-labels')
  const selection = catalog.selection('esri-world-imagery', null).value
  const display = { labelsVisible: true, recentVisible: true, recentOpacity: 0, earlyVisible: false, earlySource: null }
  const result = observationSources([], selection, display, labels)
  assert.deepEqual(result.sources, [])
  assert.equal(result.hasUnverified, false)
})

test('two-period imagery sources include the fixed early release and visible default labels', () => {
  const catalog = createMapSourceCatalog(undefined, 'allow', {})
  const labels = catalog.descriptorOf('amap-imagery-labels')
  const early = waybackDescriptor({
    releaseId: 10,
    itemId: '903f0abe9c3b452dafe1ca5b8dd858b9',
    title: 'World Imagery (Wayback 2014-02-20)',
    publishedAt: '2014-02-20',
    layerIdentifier: 'WB_2014_R01',
    acquiredAt: null,
  })
  const { sources, hasUnverified } = observationSources(
    [{ id: 'business', visible: true, opacity: 1, displayDigest: 'abc' }],
    null,
    {
      labelsVisible: true,
      recentVisible: true,
      recentOpacity: 0.45,
      earlyVisible: true,
      earlySource: early,
    },
    labels,
  )
  assert.deepEqual(sources.map(source => source.id), ['esri-wayback', 'esri-world-imagery', 'amap-imagery-labels', 'business'])
  assert.equal(sources[0].kind, 'overlay')
  assert.equal(sources[0].version, '10')
  assert.equal(sources[2].attribution, '© 高德地图')
  assert.equal(hasUnverified, true, 'the default AMap labels retain their unverified classification')
})
