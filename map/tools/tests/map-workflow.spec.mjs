/**
 * Natural-language map-action workflow fixtures (task-map-actions): place
 * resolution through the online provider, canonical fit derivation, direct
 * point/line/polygon drawing, and the refusal paths — unknown places,
 * empty/invalid geometries, degenerate fits, concurrent revision conflicts,
 * cancellation, and idempotent replay — all through the real P0a commit
 * protocol (accepted `tool/call` + successful `tool/result` meta folds).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createSpatialSearch, resolveSearchConfig } from '../../spatial-connect/src/search.ts'
import * as collabPlugin from '../../spatial-collab/src/plugin.ts'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import { mapLocate, mapFitView, mapDraw, mapGetState, mapSetView } from '../src/map-tools.ts'
import { mapApplyPatch } from '../src/collab-tools.ts'

async function geocoder(t, handler) {
  const server = createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const service = createSpatialSearch(resolveSearchConfig(
    { apiKeyEnv: 'WORKFLOW_SEARCH_KEY', baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 2000 },
    { WORKFLOW_SEARCH_KEY: 'workflow-search-key' },
  ))
  t.after(async () => { await service.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  return service
}

function json(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

test('map_locate resolves a known place through the provider and reports unknown places without fabricating coordinates', async t => {
  let reads = 0
  const service = await geocoder(t, (request, response) => {
    const url = new URL(request.url, 'http://fixture')
    reads += 1
    assert.equal(url.searchParams.get('tk'), 'workflow-search-key')
    if (url.pathname === '/geocoder') {
      assert.equal(JSON.parse(url.searchParams.get('ds')).keyWord, '北京市天安门')
      return json(response, { status: '0', location: { lon: 116.397455, lat: 39.908722 } })
    }
    assert.equal(url.pathname, '/v2/search')
    const args = JSON.parse(url.searchParams.get('postStr'))
    assert.equal(args.keyWord, '不存在的地名xyz')
    assert.equal(args.mapBound, '116,39,117,40')
    return json(response, { status: { infocode: 1000 }, count: '0', pois: [] })
  })
  const rig = await mapRig()
  t.after(async () => rig.dispose())
  rig.ctx.effect(() => rig.ctx.reflect.provide('spatialSearch', service))
  const session = rig.session('locate')

  const found = await mapLocate.execute({ query: '北京市天安门' }, rig.exec(session, { callId: 'locate-1' }))
  assert.equal(found.provider, 'tianditu')
  assert.equal(found.found, 1)
  assert.deepEqual(found.candidates[0].point, [116.397455, 39.908722])
  assert.equal(found.candidates[0].name, '北京市天安门')
  assert.equal(found.crs, 'EPSG:4490')
  assert.ok(found.limitations.some(line => line.includes('one candidate')), 'the single-candidate limitation reaches the model')
  assert.ok(!JSON.stringify(found).includes('workflow-search-key'))

  const missing = await mapLocate.execute({ query: '不存在的地名xyz', bbox: [116, 39, 117, 40] }, rig.exec(session, { callId: 'locate-2' }))
  assert.equal(missing.found, 0)
  assert.deepEqual(missing.candidates, [])
  assert.ok(missing.note.includes('map_fit_view'), 'the zero-candidate note names an honest alternative')
  assert.equal(reads, 2, 'each locate is exactly one provider read')

  await assert.rejects(
    mapLocate.execute({ query: '' }, rig.exec(session, { callId: 'locate-3' })),
    /INVALID_ARGUMENT.*1..256/,
    'a malformed query refuses before any provider involvement',
  )
  const bare = await mapRig()
  t.after(async () => bare.dispose())
  await assert.rejects(
    mapLocate.execute({ query: '不在服务中的地名' }, bare.exec(bare.session('no-provider'), { callId: 'locate-4' })),
    /SPATIAL_SERVICE_UNAVAILABLE/,
    'a host without the provider refuses instead of guessing coordinates',
  )
})

test('map_fit_view derives the canonical view from a bbox with hand-checked numbers and folds only through an accepted result', async t => {
  const rig = await mapRig()
  t.after(async () => rig.dispose())
  const session = rig.session('fit')

  // Independent hand derivation (documented contract): Web-Mercator projected
  // meters per pixel at zoom z is 40075016.686/(256·2^z) over a canonical
  // 1024×768 viewport with 15% padding on every side.
  // [116,39,117,40]: spanX=111319.5m → zoomW=9.98; spanY=146010m → zoomH=9.17; zoom=⌊9.17⌋=9.
  // [116.39,39.90,116.41,39.92]: spanX=2226.4m → 15.62; spanY=2902.5m → 14.82; zoom=14.
  const initialZoom = rig.state(session).view.zoom
  const wideCall = rig.call(session, 'fit-wide', 'map_fit_view', { bbox: [116, 39, 117, 40] })
  const wideView = await mapFitView.execute({ bbox: [116, 39, 117, 40] }, rig.exec(session, { callId: 'fit-wide' }))
  assert.deepEqual([wideView.center, wideView.zoom], [[116.5, 39.5], 9])
  assert.equal(wideView.meta.change.op, 'set-view')
  assert.equal(wideView.meta.sourceCallSeq, wideCall.seq)
  assert.equal(rig.state(session).view.zoom, initialZoom, 'the handler itself must not move the map')

  rig.result(session, wideCall, { meta: wideView.meta })
  assert.deepEqual(rig.state(session).view.center, [116.5, 39.5])
  assert.equal(rig.state(session).view.zoom, 9)
  assert.equal(rig.state(session).revision, 1)

  const tightCall = rig.call(session, 'fit-tight', 'map_fit_view', { bbox: [116.39, 39.9, 116.41, 39.92] })
  const tightView = await mapFitView.execute({ bbox: [116.39, 39.9, 116.41, 39.92] }, rig.exec(session, { callId: 'fit-tight' }))
  assert.deepEqual([tightView.center, tightView.zoom], [[116.4, 39.91], 14])
  // A failed result never folds its candidate.
  rig.result(session, tightCall, { isError: true, text: 'Error: cancelled' })
  assert.equal(rig.state(session).view.zoom, 9, 'a failed result folds nothing')
})

test('map_fit_view fits a layer extent and the study AOI, and refuses unknown or degenerate sources', async t => {
  const rig = await mapRig()
  t.after(async () => rig.dispose())
  await rig.ctx.plugin(collabPlugin)
  const session = rig.session('fit-sources')

  const drawCall = rig.call(session, 'draw-1', 'map_draw', {})
  const drawn = await mapDraw.execute({ kind: 'polygon', coordinates: [[116.1, 39.8], [116.4, 39.8], [116.4, 40.0], [116.1, 40.0]], layer_id: 'study-site', name: '研究区' }, rig.exec(session, { callId: 'draw-1' }))
  rig.result(session, drawCall, { meta: drawn.meta })
  assert.equal(rig.state(session).layers.length, 1)

  const layerCall = rig.call(session, 'fit-layer', 'map_fit_view', { layer_id: 'study-site' })
  const layerFit = await mapFitView.execute({ layer_id: 'study-site' }, rig.exec(session, { callId: 'fit-layer' }))
  assert.deepEqual(layerFit.source, { kind: 'layer', layer_id: 'study-site', bbox: [116.1, 39.8, 116.4, 40] })

  const refusals = [
    ['x1', { layer_id: 'missing' }, /INVALID_ARGUMENT.*missing/, 'an unknown layer id names the miss'],
    ['x2', { aoi: true }, /INVALID_ARGUMENT.*no study AOI/, 'fitting an unset AOI refuses'],
    ['x3', { bbox: [116, 39, 116, 40] }, /INVALID_ARGUMENT.*degenerate/, 'a zero-width bbox is degenerate'],
    ['x4', { bbox: [116, 39, 117, 40], layer_id: 'study-site' }, /INVALID_ARGUMENT.*exactly one/, 'two sources refuse'],
    ['x5', {}, /INVALID_ARGUMENT.*exactly one/, 'no source refuses'],
  ]
  for (const [callId, args, pattern, note] of refusals) {
    rig.call(session, callId, 'map_fit_view', args)
    await assert.rejects(mapFitView.execute(args, rig.exec(session, { callId })), pattern, note)
  }

  const aoiCall = rig.call(session, 'aoi-1', 'map_apply_patch', {})
  const aoiPatch = await mapApplyPatch.execute({
    patch: [{ kind: 'set-aoi', aoi: { name: '核心区', ring: [[116.2, 39.85], [116.3, 39.85], [116.3, 39.95], [116.2, 39.95]] } }],
    expected_revision: 1,
  }, rig.exec(session, { callId: 'aoi-1' }))
  assert.equal(aoiPatch.status, 'proposed')
  rig.result(session, aoiCall, { meta: aoiPatch.meta })
  const aoiFitCall = rig.call(session, 'fit-aoi', 'map_fit_view', { aoi: true })
  const aoiFit = await mapFitView.execute({ aoi: true }, rig.exec(session, { callId: 'fit-aoi' }))
  assert.deepEqual(aoiFit.source, { kind: 'aoi', bbox: [116.2, 39.85, 116.3, 39.95] })
})

test('map_draw proposes point, line, and polygon layers through the add-layer channel', async t => {
  const rig = await mapRig()
  t.after(async () => rig.dispose())
  const session = rig.session('draw')

  const ring = [[116.1, 39.8], [116.4, 39.8], [116.4, 40.0], [116.1, 40.0]]
  const polyCall = rig.call(session, 'draw-poly', 'map_draw', {})
  const polygon = await mapDraw.execute({ kind: 'polygon', coordinates: ring, layer_id: 'site', name: '研究区' }, rig.exec(session, { callId: 'draw-poly' }))
  assert.equal(polygon.layer.featureCount, 1)
  assert.deepEqual(polygon.bbox, [116.1, 39.8, 116.4, 40])
  assert.equal(polygon.meta.change.op, 'add-layer')
  // The drawn ring closes automatically (first ≠ last here): a valid closed polygon.
  assert.equal(polygon.meta.change.layer.data.features[0].geometry.coordinates[0].length, 5)
  rig.result(session, polyCall, { meta: polygon.meta })
  assert.equal(rig.state(session).layers.length, 1)

  const lineCall = rig.call(session, 'draw-line', 'map_draw', {})
  const line = await mapDraw.execute({ kind: 'line', coordinates: [[116.1, 39.8], [116.4, 40.0]], layer_id: 'route' }, rig.exec(session, { callId: 'draw-line' }))
  rig.result(session, lineCall, { meta: line.meta })
  const pointCall = rig.call(session, 'draw-point', 'map_draw', {})
  const point = await mapDraw.execute({ kind: 'point', coordinates: [[116.25, 39.9]], layer_id: 'poi', label: '入口' }, rig.exec(session, { callId: 'draw-point' }))
  rig.result(session, pointCall, { meta: point.meta })
  const state = await mapGetState.execute({}, rig.exec(session, { callId: 'state-1' }))
  assert.deepEqual(state.layers.map(layer => [layer.id, layer.featureCount]), [['site', 1], ['route', 1], ['poi', 1]])
  assert.equal(state.revision, 3)

  // Redrawing the same layer id replaces content through the same channel (one new revision, still one layer).
  const redrawCall = rig.call(session, 'draw-point-2', 'map_draw', {})
  const redraw = await mapDraw.execute({ kind: 'point', coordinates: [[116.3, 39.95]], layer_id: 'poi' }, rig.exec(session, { callId: 'draw-point-2' }))
  rig.result(session, redrawCall, { meta: redraw.meta })
  const after = await mapGetState.execute({}, rig.exec(session, { callId: 'state-2' }))
  assert.equal(after.layers.length, 3)
  assert.equal(after.revision, 4)
})

test('map_draw refuses empty, malformed, out-of-range, oversized, unpaired, and aborted draws without map changes', async t => {
  const rig = await mapRig()
  t.after(async () => rig.dispose())
  const session = rig.session('draw-negative')

  const invalid = [
    [{ kind: 'point', coordinates: [[116.4, 39.9], [116.5, 39.9]] }, /exactly one coordinate pair/],
    [{ kind: 'line', coordinates: [[116.4, 39.9]] }, /at least 2/],
    [{ kind: 'polygon', coordinates: [[116.1, 39.8], [116.4, 40.0]] }, /at least 3/],
    [{ kind: 'polygon', coordinates: [] }, /non-empty array/],
    [{ kind: 'point', coordinates: [[200, 39.9]] }, /outside WGS84/],
    [{ kind: 'point', coordinates: [[116.4, 91]] }, /outside WGS84/],
    [{ kind: 'point', coordinates: '116.4,39.9' }, /non-empty array/],
    [{ kind: 'circle', coordinates: [[116.4, 39.9]] }, /kind must be/],
    [{ kind: 'point', coordinates: Array.from({ length: 1025 }, () => [116.4, 39.9]) }, /at most 1024/],
  ]
  for (const [index, [args, pattern]] of invalid.entries()) {
    const callId = `bad-${index}`
    rig.call(session, callId, 'map_draw', args)
    await assert.rejects(mapDraw.execute(args, rig.exec(session, { callId })), pattern, `draw must refuse ${JSON.stringify(args).slice(0, 60)}`)
  }

  const controller = new AbortController()
  controller.abort()
  rig.call(session, 'draw-abort', 'map_draw', {})
  await assert.rejects(
    mapDraw.execute({ kind: 'point', coordinates: [[116.4, 39.9]] }, rig.exec(session, { callId: 'draw-abort', signal: controller.signal })),
    /AbortError|abort/i,
    'an aborted execution refuses before proposing',
  )
  await assert.rejects(
    mapDraw.execute({ kind: 'point', coordinates: [[116.4, 39.9]] }, rig.exec(session, {})),
    /accepted tool\/call/,
    'a draw without its paired accepted call never executes',
  )
  assert.deepEqual(rig.state(session).layers, [], 'no refusal path changed the map')
})

test('a natural locate → move → draw → patch workflow replays idempotently and conflicts on a stale revision', async t => {
  const rig = await mapRig()
  t.after(async () => rig.dispose())
  await rig.ctx.plugin(collabPlugin)
  const session = rig.session('flow')

  // 已知位置定位后移动视窗
  const moveCall = rig.call(session, 'move-1', 'map_set_view', { center: [116.397, 39.909], zoom: 12 })
  const move = await mapSetView.execute({ center: [116.397, 39.909], zoom: 12 }, rig.exec(session, { callId: 'move-1' }))
  rig.result(session, moveCall, { meta: move.meta })
  assert.equal(rig.state(session).revision, 1)

  // AOI 打标走 map_apply_patch 通道；重复 operation_id 只重放首次结果
  const patchCall = rig.call(session, 'patch-1', 'map_apply_patch', {})
  const first = await mapApplyPatch.execute({
    patch: [{ kind: 'set-aoi', aoi: { ring: [[116.3, 39.85], [116.5, 39.85], [116.5, 39.95], [116.3, 39.95]] } }],
    expected_revision: 1,
    operation_id: 'flow-aoi',
  }, rig.exec(session, { callId: 'patch-1' }))
  assert.equal(first.status, 'proposed')
  rig.result(session, patchCall, { meta: first.meta })
  assert.equal(rig.state(session).revision, 2)

  const replayCall = rig.call(session, 'patch-2', 'map_apply_patch', {})
  const replay = await mapApplyPatch.execute({
    patch: [{ kind: 'set-aoi', aoi: null }],
    expected_revision: 2,
    operation_id: 'flow-aoi',
  }, rig.exec(session, { callId: 'patch-2' }))
  assert.equal(replay.status, 'duplicate')
  assert.equal(replay.meta, null)
  rig.result(session, replayCall, { text: 'ok' })
  assert.notEqual(rig.state(session).aoi, null, 'the replayed operation id applies nothing')

  // 过期 expected_revision 冲突：不折叠、不改动，报告当前修订
  const staleCall = rig.call(session, 'patch-stale', 'map_apply_patch', {})
  const stale = await mapApplyPatch.execute({
    patch: [{ kind: 'set-view', view: { center: [2.35, 48.85], zoom: 6, wkid: 4326 } }],
    expected_revision: 1,
  }, rig.exec(session, { callId: 'patch-stale' }))
  assert.equal(stale.status, 'conflict')
  assert.equal(stale.current_revision, 2)
  rig.result(session, staleCall, { meta: stale.meta })
  assert.deepEqual(rig.state(session).view.center, [116.397, 39.909], 'a conflicted patch changes nothing')
  assert.equal(rig.state(session).revision, 2)
})
