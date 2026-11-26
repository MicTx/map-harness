/** `map_refine_aoi`: real footprints replace a rectangle candidate, ranked and attributed; empty and failed sources keep the candidate. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mapRig, layerPayload } from '../../map-container/tests/map-rig.mjs'
import { createSpatialFootprints, resolveFootprintsConfig } from '../../spatial-connect/src/footprints.ts'
import { mapRefineAoi, selectFootprints } from '../src/refine-tools.ts'
import { mapDraw } from '../src/map-tools.ts'
import { SPATIAL_TOOL_CATALOG, spatialToolOf } from '../src/spatial-catalog.ts'
import { mapChangeAllowedForTool, MAP_META_KIND } from '../../map-container/src/protocol.ts'

const WANDA = [87.51386, 43.83936, 87.51558, 43.84073]

function way(id, name, west, south, east, north, tags = {}) {
  return { type: 'way', id, tags: { building: 'retail', name, ...tags }, geometry: [
    { lon: west, lat: south }, { lon: east, lat: south }, { lon: east, lat: north }, { lon: west, lat: north }, { lon: west, lat: south },
  ] }
}

async function overpass(t, handler) {
  const hits = []
  const http = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => { hits.push(new URLSearchParams(body).get('data')); handler(hits.length, response, hits.at(-1)) })
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(async () => { http.closeAllConnections(); await new Promise(resolve => http.close(resolve)) })
  return { baseUrl: `http://127.0.0.1:${http.address().port}`, hits }
}

const json = (response, status, payload) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)) }

async function rigWithSource(t, handler, config = {}) {
  const source = await overpass(t, handler)
  const rig = await mapRig()
  const service = createSpatialFootprints(resolveFootprintsConfig({ baseUrl: source.baseUrl, ...config }))
  const dispose = rig.ctx.reflect.provide('spatialFootprints', service)
  t.after(async () => { dispose(); await service.close(); await rig.dispose() })
  return { rig, source }
}

/** Add the rectangle candidate the way the model did: a map_draw polygon layer. */
async function addRectangle(rig, session, bbox = WANDA, id = 'wanda-mall-building') {
  const [w, s, e, n] = bbox
  const ring = [[w, s], [e, s], [e, n], [w, n], [w, s]]
  const data = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { id, confidence: 'likely' } }] }
  const drawRectCall = rig.call(session, 'draw-rect', 'map_draw', { coordinates: ring })
  const drawn = await mapDraw.execute({ kind: 'polygon', coordinates: ring, layer_id: id, name: '万达广场购物中心主体(待确认)' }, rig.exec(session, { callId: 'draw-rect' }))
  assert.ok(drawn.layer, 'the rectangle layer was added')
  rig.result(session, drawRectCall, { meta: drawn.meta })
  assert.ok(rig.state(session).layers.some(entry => entry.id === id), 'the rectangle is committed before refinement')
  void data
  return drawn
}

test('map_refine_aoi is in the fixed catalog with the six registration pieces', () => {
  assert.ok(SPATIAL_TOOL_CATALOG.some(row => row.name === 'map_refine_aoi'))
  const identity = spatialToolOf('map_refine_aoi')
  assert.equal(identity.family, 'map-mutation')
  assert.equal(identity.owner, '@map-harness/map-tools')
  assert.equal(identity.provider, '@map-harness/arcgis-mcp')
  assert.equal(mapChangeAllowedForTool('map_refine_aoi', { op: 'add-layer', layer: { id: 'x' } }), true)
  assert.equal(mapChangeAllowedForTool('map_refine_aoi', { op: 'patch', patches: [] }), false, 'the refine tool never owns a patch')
})

test('selection ranks contains-centroid first, then overlap ratio, and returns every footprint', () => {
  const page = { data: { features: [
    { geometry: { type: 'Polygon', coordinates: [[[87.514, 43.8395], [87.5144, 43.8395], [87.5144, 43.8398], [87.514, 43.8398], [87.514, 43.8395]]] }, properties: { id: 'osm/way/2' } }, // outside-centre, partial overlap
    { geometry: { type: 'Polygon', coordinates: [[[87.5140, 43.8394], [87.5152, 43.8394], [87.5152, 43.8406], [87.5140, 43.8406], [87.5140, 43.8394]]] }, properties: { id: 'osm/way/1' } }, // contains the centre
  ] } }
  const rows = selectFootprints(page, WANDA)
  assert.deepEqual(rows.map(row => row.id), ['osm/way/1', 'osm/way/2'])
  assert.equal(rows[0].containsCentroid, true)
  assert.equal(rows[1].containsCentroid, false)
  assert.equal(rows[1].overlapRatio, 1, 'a footprint fully inside the candidate window overlaps it completely; it still ranks below the one holding the centre')
})

test('refining a rectangle candidate adds one footprint layer ranked and attributed, and reports the original as superseded', async t => {
  const { rig, source } = await rigWithSource(t, (_n, response) => json(response, 200, { elements: [
    way(1, '万达广场购物中心主体', 87.5140, 43.8394, 87.5152, 43.8406, { 'building:levels': '4' }),
    way(2, '万达金街', 87.5152, 43.8390, 87.5155, 43.8394),
  ] }))
  const session = rig.session()
  await addRectangle(rig, session)
  const refine1Call = rig.call(session, 'refine-1', 'map_refine_aoi', { candidate_id: 'wanda-mall-building' })
  const result = await mapRefineAoi.execute({ candidate_id: 'wanda-mall-building', confidence: 'likely' }, rig.exec(session, { callId: 'refine-1' }))
  rig.result(session, refine1Call, { meta: result.meta })
  assert.equal(result.layer.id, 'wanda-mall-building-refined')
  assert.equal(result.layer.feature_count, 2)
  assert.equal(result.refines, 'wanda-mall-building')
  assert.deepEqual(result.superseded, ['wanda-mall-building'])
  assert.equal(result.selection[0].id, 'osm/way/1')
  assert.equal(result.selection[0].contains_centroid, true)
  assert.equal(result.selection[0].rank, 1)
  assert.equal(result.source.provider, 'osm-overpass')
  assert.match(result.source.licence, /ODbL/u)
  assert.equal(result.confidence, 'likely')
  assert.equal(result.meta.change.op, 'add-layer')
  assert.equal(result.meta.kind, MAP_META_KIND, 'the refined layer rides the versioned map-change meta')
  assert.ok(result.limitations.length > 0, 'the source limitations travel with the result')
  assert.match(source.hits[0], /way\["building"\]\(43\.83936,87\.51386,43\.84073,87\.51558\)/u, 'the window is the candidate bbox')
  // the persisted layer carries provenance per feature so the UI can show it
  const state = rig.state(session)
  const layer = state.layers.find(entry => entry.id === 'wanda-mall-building-refined')
  assert.ok(layer, 'the refined layer is in the accepted state')
  assert.equal(layer.data.features[0].properties.licence, undefined, 'licence lives on the result/source, not duplicated per feature')
  assert.equal(layer.data.features[0].properties.containsCentroid, true)
  assert.equal(layer.data.features[0].properties.refines, 'wanda-mall-building', 'the replacement link is durable on the refined layer')
  const original = state.layers.find(entry => entry.id === 'wanda-mall-building')
  assert.ok(original, 'the original rectangle layer is kept')
  assert.equal(original.visible, true, 'and untouched: the person decides its fate in the layer panel')
})

test('an explicit bbox window works without a candidate and marks nothing superseded', async t => {
  const { rig } = await rigWithSource(t, (_n, response) => json(response, 200, { elements: [way(9, 'standalone', 87.514, 43.8395, 87.5144, 43.8398)] }))
  const session = rig.session()
  const refineBboxCall = rig.call(session, 'refine-bbox', 'map_refine_aoi', { bbox: WANDA })
  const result = await mapRefineAoi.execute({ bbox: WANDA }, rig.exec(session, { callId: 'refine-bbox' }))
  assert.equal(result.layer.id, 'aoi-refined')
  assert.equal(result.refines, null)
  assert.deepEqual(result.superseded, [])
  assert.equal(result.confidence, 'uncertain', 'the default confidence is the honest one')
})

test('an empty source answer is REFINE_NO_FOOTPRINTS with the candidate untouched and no layer added', async t => {
  const { rig } = await rigWithSource(t, (_n, response) => json(response, 200, { elements: [] }))
  const session = rig.session()
  await addRectangle(rig, session)
  const before = rig.state(session).layers.length
  rig.call(session, 'refine-empty', 'map_refine_aoi', { candidate_id: 'wanda-mall-building' })
  await assert.rejects(mapRefineAoi.execute({ candidate_id: 'wanda-mall-building' }, rig.exec(session, { callId: 'refine-empty' })), /REFINE_NO_FOOTPRINTS/u)
  assert.equal(rig.state(session).layers.length, before)
})

test('a persistent source failure is REFINE_SOURCE_UNAVAILABLE; a 4xx is REFINE_SOURCE_INVALID; neither touches the map', async t => {
  const down = await rigWithSource(t, (_n, response) => json(response, 503, {}), { maxRetries: 0 })
  const s1 = down.rig.session()
  down.rig.call(s1, 'refine-down', 'map_refine_aoi', { bbox: WANDA })
  await assert.rejects(mapRefineAoi.execute({ bbox: WANDA }, down.rig.exec(s1, { callId: 'refine-down' })), /REFINE_SOURCE_UNAVAILABLE/u)
  assert.equal(down.rig.state(s1).layers.length, 0)

  const denied = await rigWithSource(t, (_n, response) => json(response, 403, {}))
  const s2 = denied.rig.session()
  denied.rig.call(s2, 'refine-denied', 'map_refine_aoi', { bbox: WANDA })
  await assert.rejects(mapRefineAoi.execute({ bbox: WANDA }, denied.rig.exec(s2, { callId: 'refine-denied' })), /REFINE_SOURCE_INVALID/u)
})

test('argument guards: exactly one of candidate_id/bbox, a known layer, a bounded window, a known confidence', async t => {
  const { rig } = await rigWithSource(t, (_n, response) => json(response, 200, { elements: [] }))
  const session = rig.session()
  rig.call(session, 'g1', 'map_refine_aoi', {})
  await assert.rejects(mapRefineAoi.execute({}, rig.exec(session, { callId: 'g1' })), /exactly one/u)
  rig.call(session, 'g2', 'map_refine_aoi', { candidate_id: 'nope' })
  await assert.rejects(mapRefineAoi.execute({ candidate_id: 'nope' }, rig.exec(session, { callId: 'g2' })), /No layer with id/u)
  rig.call(session, 'g3', 'map_refine_aoi', { bbox: [87, 43, 88, 44] })
  await assert.rejects(mapRefineAoi.execute({ bbox: [87, 43, 88, 44] }, rig.exec(session, { callId: 'g3' })), /INVALID_ARGUMENT/u)
  rig.call(session, 'g4', 'map_refine_aoi', { bbox: WANDA, confidence: 'sure' })
  await assert.rejects(mapRefineAoi.execute({ bbox: WANDA, confidence: 'sure' }, rig.exec(session, { callId: 'g4' })), /likely or uncertain/u)
  rig.call(session, 'g5', 'map_draw', { coordinates: [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]] })
  await mapDraw.execute({ kind: 'polygon', coordinates: [[1, 1], [2, 1], [2, 2], [1, 2], [1, 1]], layer_id: 'x' }, rig.exec(session, { callId: 'g5' }))
  rig.call(session, 'g6', 'map_refine_aoi', { candidate_id: 'x' })
  await assert.rejects(mapRefineAoi.execute({ candidate_id: 'x' }, rig.exec(session, { callId: 'g6' })), /INVALID_ARGUMENT/u, 'a 1° rectangle is outside the refinement window')
  void layerPayload
})
