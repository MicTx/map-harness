/**
 * Terrain tool integration fixtures over the REAL catalog service and
 * projection plus the real `spatial-terrain` package: register a DEM grid →
 * `terrain_add_layer` loads a bounded preview bound to the exact version
 * (vertical metadata required, never defaulted) → `geo_line_of_sight`
 * computes real visibility answers over the same version, publishes the
 * sample table through the paired call, and refuses stale, unauthorized,
 * or metadata-less runs. The analytic expectations come from the independent
 * line-of-sight fixtures in `spatial-terrain/tests/los.spec.mjs`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { catalogRegister } from '../src/catalog-tools.ts'
import { terrainAddLayer, geoLineOfSight, terrainViewshed } from '../src/terrain-tools.ts'
import { decodeTerrainLosMeta, TERRAIN_META_KIND } from '../src/terrain-meta.ts'

const M = 180 / (6_371_000 * Math.PI) // one meter in degrees at the equator

/** A 2 km × 400 m flat DEM grid (100 m lattice, elevation 0) with one optional ridge. */
function demCollection({ ridgeHeight = 0 } = {}) {
  const features = []
  for (let lat = -2; lat <= 2; lat++) {
    for (let lon = 0; lon <= 20; lon++) {
      const d = lon * 100
      const z = ridgeHeight > 0 && d >= 400 && d <= 600 ? ridgeHeight : 0
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [d * M, lat * 100 * M] },
        properties: { elevation: z },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** A small building-footprint resource crossing the sightline at 200–300 m. */
function buildingCollection(height) {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [[[200 * M, -30 * M], [300 * M, -30 * M], [300 * M, 30 * M], [200 * M, 30 * M]]] },
      properties: { height },
    }],
  }
}

async function terrainRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `map-terrain-${label}-`))
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: join(dir, 'catalog') })
  let callCounter = 0
  const sessions = new Map()
  /** One stable Session per id: re-acquiring must not create a second session. */
  function sessionOf_(id) {
    if (!sessions.has(id)) sessions.set(id, rig.session(id))
    return sessions.get(id)
  }
  return {
    dir,
    rig,
    sessionOf: sessionOf_,
    async register(name, collection, sessionId = 'display') {
      const path = join(dir, `${name}.geojson`)
      writeFileSync(path, JSON.stringify(collection))
      const session = sessionOf_(sessionId)
      const callId = `reg-${name}-${callCounter += 1}`
      rig.call(session, callId, 'catalog_register', { path, name })
      const { resource } = await catalogRegister.execute({ path, name }, rig.exec(session, { callId }))
      return resource
    },
    /** Prepare an accepted tool/call and run a tool body against it; returns the result and the call seq. */
    async run(session, tool, args, callId = `t-${callCounter += 1}`) {
      const call = rig.call(session, callId, tool.name, args)
      const result = await tool.execute(args, rig.exec(session, { callId }))
      return { result, seq: call.seq }
    },
    async addTerrain(resourceRef, overrides = {}, layerId = 'dem-preview', sessionId = 'display') {
      const session = sessionOf_(sessionId)
      const callId = `add-${sessionId}-${layerId}-${callCounter += 1}`
      const args = {
        ref: resourceRef,
        vertical_datum: 'EGM96',
        vertical_units: 'm',
        vertical_epoch: 'none',
        layer_id: layerId,
        ...overrides,
      }
      const call = rig.call(session, callId, 'terrain_add_layer', args)
      const result = await terrainAddLayer.execute(args, rig.exec(session, { callId }))
      rig.result(session, call, { meta: result.meta })
      return result
    },
    async dispose() {
      await rig.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('terrain_add_layer folds a bounded preview bound to the exact version with its vertical metadata', async () => {
  const env = await terrainRig('add')
  try {
    const resource = await env.register('dem', demCollection())
    const result = await env.addTerrain(resource.ref)
    assert.equal(result.layer.id, 'dem-preview')
    assert.equal(result.terrain.surface_ref, resource.ref)
    assert.equal(result.terrain.revision, resource.contentDigest)
    assert.deepEqual(result.terrain.vertical, { datum: 'EGM96', units: 'm', epoch: 'none' })
    assert.equal(result.terrain.grid.source_point_count, 105)
    assert.equal(result.layer.point_count, 105, 'a 105-point grid fits under the display cap unchanged')
    assert.ok(result.limitations.some(text => text.includes('display-only')))

    // The accepted result folded: the projection state carries the terrain identity.
    const session = env.sessionOf('display')
    const layer = env.rig.state(session).layers.find(entry => entry.id === 'dem-preview')
    assert.ok(layer)
    assert.equal(layer.terrain.revision, resource.contentDigest)
    assert.equal(layer.terrain.gridRows, 5)
    assert.equal(layer.resourceRef, resource.ref)

    // Re-registering the name publishes v2; the same layer id re-binds to it.
    const v2 = await env.register('dem', demCollection({ ridgeHeight: 20 }))
    assert.notEqual(v2.ref, resource.ref)
    await env.addTerrain(v2.ref, {}, 'dem-preview')
    const replaced = env.rig.state(session).layers.find(entry => entry.id === 'dem-preview')
    assert.equal(replaced.terrain.revision, v2.contentDigest, 're-adding the id binds the new revision')
  } finally {
    await env.dispose()
  }
})

test('terrain_add_layer refuses missing or unsupported vertical metadata before any read', async () => {
  const env = await terrainRig('meta')
  try {
    const resource = await env.register('dem', demCollection())
    const session = env.rig.session('display')
    const noDatum = { ref: resource.ref, vertical_units: 'm', vertical_epoch: 'none' }
    env.rig.call(session, 'nd-1', 'terrain_add_layer', noDatum)
    await assert.rejects(terrainAddLayer.execute(noDatum, env.rig.exec(session, { callId: 'nd-1' })), /vertical_datum/)
    const badUnits = { ref: resource.ref, vertical_datum: 'EGM96', vertical_units: 'ft', vertical_epoch: 'none' }
    env.rig.call(session, 'nd-2', 'terrain_add_layer', badUnits)
    await assert.rejects(terrainAddLayer.execute(badUnits, env.rig.exec(session, { callId: 'nd-2' })), /vertical_units.*ft/)
    const artifactRef = resource.ref.replace('res-', 'art-')
    const withArtifact = { ref: artifactRef, vertical_datum: 'EGM96', vertical_units: 'm', vertical_epoch: 'none' }
    env.rig.call(session, 'nd-3', 'terrain_add_layer', withArtifact)
    await assert.rejects(terrainAddLayer.execute(withArtifact, env.rig.exec(session, { callId: 'nd-3' })), /resource/)
    assert.equal(env.rig.state(session).layers.length, 0, 'no refused preview ever folded')
  } finally {
    await env.dispose()
  }
})

test('geo_line_of_sight answers visible and blocked exactly over the registered grid', async () => {
  const env = await terrainRig('los')
  try {
    const session = env.rig.session('analysis')
    const flat = await env.register('dem-flat', demCollection(), 'analysis')
    const base = {
      surface_ref: flat.ref,
      vertical_datum: 'EGM96',
      vertical_units: 'm',
      vertical_epoch: 'none',
      surface_sigma_m: 0,
      sampling_interval_m: 50,
      curvature: 'none',
    }
    const clear = { ...base, observer: [0, 0], observer_height_m: 10, target: [1000 * M, 0] }
    const seen = await env.run(session, geoLineOfSight, clear)
    assert.equal(seen.result.status, 'visible')
    assert.equal(seen.result.first_obstruction, null)
    assert.ok(Math.abs(seen.result.horizontal_distance_m - 1000) < 1e-6)
    assert.ok(Math.abs(seen.result.slant_distance_m - Math.hypot(1000, 10)) < 1e-6, 'slant = sqrt(1000² + 10²) in the tangent plane')
    assert.equal(seen.result.distance_definition, 'local-tangent-plane')
    assert.equal(seen.result.sampling.sampleCount, 21)
    assert.match(seen.result.artifact_ref, /^art-/)

    const ridge = await env.register('dem-ridge', demCollection({ ridgeHeight: 20 }), 'analysis')
    const blocked = { ...base, surface_ref: ridge.ref, observer: [0, 0], observer_height_m: 10, target: [1000 * M, 0] }
    const answer = await env.run(session, geoLineOfSight, blocked, 't-blocked')
    assert.equal(answer.result.status, 'blocked')
    assert.equal(answer.result.first_obstruction.source, 'terrain')
    assert.equal(answer.result.first_obstruction.sample_index, 7, 'bilinear spreads the crest to 10 m by 350 m; ray 6.5 dips there first')
    assert.ok(Math.abs(answer.result.first_obstruction.distance_m - 350) < 1e-6)
    assert.ok(Math.abs(answer.result.first_obstruction.obstacle_elevation_m - 10) < 1e-6)

    // The durable meta rides the presentationMeta and decodes with the revision.
    const decoded = decodeTerrainLosMeta(geoLineOfSight.output.presentationMeta({}, answer.result))
    assert.equal(decoded.status, 'ok')
    assert.equal(decoded.meta.kind, TERRAIN_META_KIND)
    assert.equal(decoded.meta.surfaceRef, ridge.ref)
    assert.equal(decoded.meta.surfaceRevision, ridge.contentDigest)
    assert.deepEqual(decoded.meta.vertical, { datum: 'EGM96', units: 'm', epoch: 'none' })
    assert.equal(decoded.meta.headline.verdict, 'blocked')
    assert.equal(decoded.meta.headline.obstructionSource, 'terrain')
    const rendered = geoLineOfSight.output.render({}, answer.result)
    assert.equal(rendered[0].text.includes('"meta"'), false, 'model text omits the durable meta')
  } finally {
    await env.dispose()
  }
})

test('geo_line_of_sight refuses missing metadata, accuracy, and version conflicts with named codes', async () => {
  const env = await terrainRig('refuse')
  try {
    const session = env.sessionOf('analysis')
    const resource = await env.register('dem', demCollection(), 'analysis')
    const base = {
      surface_ref: resource.ref,
      vertical_datum: 'EGM96',
      vertical_units: 'm',
      vertical_epoch: 'none',
      surface_sigma_m: 0,
      observer: [0, 0],
      observer_height_m: 2,
      target: [500 * M, 0],
    }
    await env.run(session, geoLineOfSight, base)

    const noSigma = { ...base, surface_sigma_m: undefined }
    await env.run(session, geoLineOfSight, noSigma, 't-nosigma').then(
      () => assert.fail('a run without an accuracy budget must refuse'),
      error => assert.match(String(error), /surface_sigma_m/),
    )
    const noEpoch = { ...base, vertical_epoch: undefined }
    await env.run(session, geoLineOfSight, noEpoch, 't-noepoch').then(
      () => assert.fail('a run without an epoch must refuse'),
      error => assert.match(String(error), /vertical_epoch/),
    )
    const unversioned = { ...base, surface_ref: 'res-dem' }
    await env.run(session, geoLineOfSight, unversioned, 't-unv').then(
      () => assert.fail('an unversioned ref must refuse'),
      error => assert.match(String(error), /catalog ref/),
    )

    // A terrain preview folds into THIS session; a new version publishes and
    // the analysis against it now disagrees with the displayed revision.
    await env.addTerrain(resource.ref, {}, 'dem-view', 'analysis')
    const v2 = await env.register('dem', demCollection({ ridgeHeight: 9 }), 'analysis')
    const stale = { ...base, surface_ref: v2.ref, layer_id: 'dem-view' }
    await env.run(session, geoLineOfSight, stale, 't-stale').then(
      () => assert.fail('an analysis against a version other than the displayed one must refuse'),
      error => assert.match(String(error), /TERRAIN_VERSION_CONFLICT/),
    )
    // Pinning the analysis to the displayed version is fine.
    const pinned = { ...base, layer_id: 'dem-view' }
    const ok = await env.run(session, geoLineOfSight, pinned, 't-pinned')
    assert.equal(ok.result.status, 'visible')
    assert.equal(env.rig.state(session).layers.length, 1, 'the preview is the only layer; analysis never mutates the map')
  } finally {
    await env.dispose()
  }
})

test('building obstacles block the sightline through the versioned resource and publish nothing on refusal', async () => {
  const env = await terrainRig('bld')
  try {
    const session = env.sessionOf('analysis')
    const dem = await env.register('dem', demCollection(), 'analysis')
    const tall = await env.register('bld', buildingCollection(20), 'analysis')
    const low = await env.register('bld-low', buildingCollection(1), 'analysis')
    const catalog = env.rig.ctx.get('spatialCatalog').forSession(session.id)
    const base = {
      surface_ref: dem.ref,
      vertical_datum: 'EGM96',
      vertical_units: 'm',
      vertical_epoch: 'none',
      surface_sigma_m: 0,
      observer: [0, 0],
      observer_height_m: 2,
      target: [500 * M, 0],
      target_height_m: 2,
      buildings_ref: tall.ref,
    }
    const blocked = await env.run(session, geoLineOfSight, base)
    assert.equal(blocked.result.status, 'blocked')
    assert.equal(blocked.result.first_obstruction.source, 'building')
    assert.ok(Math.abs(blocked.result.first_obstruction.distance_m - 200) < 1e-6)
    assert.ok(await catalog.lookupPublication('artifact', blocked.seq), 'the successful run published through its paired call')

    const cleared = await env.run(session, geoLineOfSight, { ...base, buildings_ref: low.ref }, 't-low')
    assert.equal(cleared.result.status, 'visible')

    // A refused run leaves no published artifact behind.
    const bad = { ...base, buildings_ref: dem.ref }
    const badCall = await env.run(session, geoLineOfSight, bad, 't-bad').then(
      ({ seq }) => seq,
      error => {
        assert.match(String(error), /differ/)
        return env.rig.call(session, 't-bad-seq', 'geo_line_of_sight', bad).seq
      },
    )
    assert.equal(await catalog.lookupPublication('artifact', badCall), undefined)
  } finally {
    await env.dispose()
  }
})

test('control points gate the computation and cancellation publishes nothing', async () => {
  const env = await terrainRig('gate')
  try {
    const session = env.sessionOf('analysis')
    const resource = await env.register('dem', demCollection({ ridgeHeight: 3 }), 'analysis')
    const catalog = env.rig.ctx.get('spatialCatalog').forSession(session.id)
    const base = {
      surface_ref: resource.ref,
      vertical_datum: 'EGM96',
      vertical_units: 'm',
      vertical_epoch: 'none',
      surface_sigma_m: 0,
      observer: [0, 0],
      observer_height_m: 2,
      target: [500 * M, 0],
    }
    const mismatch = {
      ...base,
      control_points: [{ id: 'cp-1', lon: 500 * M, lat: 0, elevation_m: 30 }],
      control_tolerance_m: 1,
    }
    await env.run(session, geoLineOfSight, mismatch, 't-cp-bad').then(
      () => assert.fail('a failing control point must refuse'),
      error => assert.match(String(error), /cp-1/),
    )
    const matching = {
      ...base,
      observer_height_m: 5,
      control_points: [{ id: 'cp-1', lon: 500 * M, lat: 0, elevation_m: 3 }],
      control_tolerance_m: 0.5,
    }
    const ok = await env.run(session, geoLineOfSight, matching, 't-cp-ok')
    assert.equal(ok.result.status, 'visible', 'the certified surface answers; a 5 m eye clears the 3 m ridge')
    assert.ok(await catalog.lookupPublication('artifact', ok.seq))

    // Cancelled before execution: the signal throws and nothing publishes.
    const cancelled = { ...base }
    const cancelCall = env.rig.call(session, 't-cancel', 'geo_line_of_sight', cancelled)
    const controller = new AbortController()
    controller.abort()
    await geoLineOfSight.execute(cancelled, env.rig.exec(session, { callId: 't-cancel', signal: controller.signal })).then(
      () => assert.fail('an aborted call must refuse'),
      () => {},
    )
    assert.equal(await catalog.lookupPublication('artifact', cancelCall.seq), undefined, 'the cancelled call never published')
  } finally {
    await env.dispose()
  }
})

test('terrain_viewshed answers the area around the observer with honest tallies', async () => {
  const env = await terrainRig('viewshed')
  try {
    const session = env.rig.session('analysis')
    // A ridge across 400–600 m: targets past it are shaded, targets before it see.
    const ridge = await env.register('dem-ridge', demCollection({ ridgeHeight: 30 }), 'analysis')
    const args = {
      surface_ref: ridge.ref,
      vertical_datum: 'EGM96',
      vertical_units: 'm',
      vertical_epoch: 'none',
      surface_sigma_m: 0,
      sampling_interval_m: 50,
      curvature: 'none',
      observer: [0, 0],
      observer_height_m: 10,
      radius_m: 1000,
      max_targets: 200,
    }
    const seen = await env.run(session, terrainViewshed, args)
    assert.equal(seen.result.method_version, 'terrain-analysis@1' in {} ? seen.result.method_version : seen.result.method_version)
    assert.equal(seen.result.radius_m, 1000)
    assert.ok(seen.result.target_count >= 1 && seen.result.target_count <= 200)
    assert.ok(seen.result.tallies.visible > 0, 'the near field is visible')
    assert.ok(seen.result.tallies.blocked > 0, 'the ridge shades the far field')
    assert.match(seen.result.artifact_ref, /^art-/)

    // The durable meta rides the presentationMeta and decodes as a viewshed run.
    const decoded = decodeTerrainLosMeta(terrainViewshed.output.presentationMeta({}, seen.result))
    assert.equal(decoded.status, 'ok')
    assert.equal(decoded.meta.kind, TERRAIN_META_KIND)
    assert.equal(decoded.meta.tool, 'terrain_viewshed')
    assert.equal(decoded.meta.headline.verdict, 'viewshed')
    assert.equal(decoded.meta.surfaceRef, ridge.ref)
    assert.equal(decoded.meta.surfaceRevision, ridge.contentDigest)

    // The bounds refuse with named codes.
    await assert.rejects(
      env.run(session, terrainViewshed, { ...args, radius_m: 25000 }, 't-vr'),
      /radius-too-large/,
    )
    await assert.rejects(
      env.run(session, terrainViewshed, { ...args, radius_m: 1000, max_targets: 513 }, 't-vt'),
      /max_targets/,
    )

    // Layer version consistency inherits the sightline semantics: a preview
    // of the FLAT grid refuses a viewshed against the ridge version.
    const flat = await env.register('dem-flat', demCollection(), 'analysis')
    await env.addTerrain(flat.ref, {}, 'dem-preview', 'analysis')
    await assert.rejects(
      env.run(session, terrainViewshed, { ...args, layer_id: 'dem-preview' }, 't-vl'),
      error => error.code === 'TERRAIN_VERSION_CONFLICT' || /TERRAIN_VERSION_CONFLICT/.test(String(error.message ?? error)),
    )
  } finally {
    await env.dispose()
  }
})
