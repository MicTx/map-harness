/**
 * P0b data-chain integration fixtures over the REAL catalog service and
 * projection: register → resolve → ref-driven analysis → artifact publication
 * → versioned map layer → cross-storage save. Every handler runs against the
 * same rig the mutation specs use (accepted `tool/call` before the body, fold
 * through the accepted result), so the receipts and identities asserted here
 * are the ones the durable log carries. Fault injection separates file,
 * catalog, and session-flush failures.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { catalogRegister, catalogResolve, mapSave } from '../src/catalog-tools.ts'
import { mapAddLayer } from '../src/map-tools.ts'
import { geoBuffer, geoArea, geoDistance } from '../src/geo-tools.ts'
import { decodeCatalogResultMeta } from '../src/catalog-meta.ts'
import { decodeMapSaveReceiptMeta } from '../src/save-meta.ts'

const TWO_POINTS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'alpha', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'first' } },
    { type: 'Feature', id: 'beta', geometry: { type: 'Point', coordinates: [10, 0] }, properties: { name: 'second' } },
  ],
}

/** Mount the full rig: map projection + real spatial catalog over a temp store. */
async function chainRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `map-chain-${label}-`))
  const storeRoot = join(dir, 'store')
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: storeRoot })
  return {
    dir,
    storeRoot,
    rig,
    write: (name, value) => {
      writeFileSync(join(dir, name), JSON.stringify(value))
      return name
    },
    async dispose() {
      await rig.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** An exec whose `sessions` service is a caller-controlled double. */
function execWithSessions(chain, session, sessionsDouble, callId) {
  const base = chain.rig.exec(session, { callId })
  return {
    ...base,
    agent: {
      ...base.agent,
      ctx: {
        get: name => (name === 'sessions' ? sessionsDouble : base.agent.ctx.get(name)),
      },
    },
  }
}

test('register → resolve returns the frozen schema, both feature refs, and the bundle', async () => {
  const chain = await chainRig('resolve')
  try {
    const path = chain.write('points.geojson', TWO_POINTS)
    const session = chain.rig.session('resolve')
    chain.rig.call(session, 'c-reg', 'catalog_register', { path, name: 'points' })
    const registered = await catalogRegister.execute({ path, name: 'points' }, chain.rig.exec(session, { callId: 'c-reg' }))
    assert.equal(registered.status, 'succeeded')
    assert.equal(registered.resource.featureCount, 2)
    assert.match(registered.resource.ref, /^res-[a-f0-9]{24}@v1$/)
    assert.deepEqual(registered.feature_refs.map(entry => entry.feature_index), [0, 1])

    // The durable catalog-result meta strips from model text and decodes back.
    const rendered = catalogRegister.output.render({}, registered)
    assert.equal(rendered[0].text.includes('catalog-result'), false)
    const meta = decodeCatalogResultMeta(catalogRegister.output.presentationMeta({}, registered))
    assert.equal(meta.operation, 'register')
    assert.equal(meta.resources[0].ref, registered.resource.ref)

    chain.rig.call(session, 'c-res', 'catalog_resolve', { resource: registered.resource.ref })
    const resolved = await catalogResolve.execute({ resource: registered.resource.ref }, chain.rig.exec(session, { callId: 'c-res' }))
    assert.equal(resolved.status, 'succeeded')
    assert.deepEqual(resolved.schema.fields, [{ name: 'name', type: 'string' }])
    assert.equal(resolved.total_feature_refs, 2)
    assert.equal(resolved.bundle.resourceRef, registered.resource.ref)
    assert.equal(resolved.bundle.contentDigest, registered.resource.contentDigest)
    assert.equal(resolved.bundle.transformVersion, 'identity')
    assert.ok(resolved.bundle.catalogReadPoint.readAt)
    const resolveMeta = decodeCatalogResultMeta(catalogResolve.output.presentationMeta({}, resolved))
    assert.equal(resolveMeta.operation, 'resolve')
  } finally {
    await chain.dispose()
  }
})

test('catalog_resolve query returns governed semantic definitions without adding a tool', async () => {
  const chain = await chainRig('semantic-query')
  try {
    const session = chain.rig.session('semantic-query')
    const catalog = chain.rig.ctx.get('spatialCatalog').forSession(session.id)
    await catalog.registerSemanticDefinition({
      sessionId: session.id,
      definitionId: 'clinic-count',
      canonicalName: 'Clinic count',
      aliases: ['医疗点'],
      definition: { unit: 'count' },
      applicability: 'health facilities',
      sourceRef: 'doc:health',
      reviewStatus: 'reviewed',
      authorization: 'local',
    })
    const result = await catalogResolve.execute({ query: '医疗点' }, chain.rig.exec(session, { callId: 'semantic-query' }))
    assert.equal(result.status, 'succeeded')
    assert.equal(result.total, 1)
    assert.equal(result.semantic_definitions[0].definition.definitionId, 'clinic-count')
    assert.equal(result.semantic_definitions[0].definition.ref, 'def-clinic-count@v1')
  } finally {
    await chain.dispose()
  }
})

test('the ref-driven chain computes the SECOND point, publishes its artifact, and loads it into the map', async () => {
  const chain = await chainRig('second-point')
  try {
    const path = chain.write('points.geojson', TWO_POINTS)
    const session = chain.rig.session('chain')

    const regCall = chain.rig.call(session, 'c1', 'catalog_register', { path, name: 'points' })
    const registered = await catalogRegister.execute({ path, name: 'points' }, chain.rig.exec(session, { callId: 'c1' }))
    chain.rig.result(session, regCall, { text: 'ok' })
    const betaRef = registered.feature_refs.find(entry => entry.original_id === 'beta').feature_ref

    // Buffer the SECOND point: the reported bbox must wrap [10, 0], so a
    // first-feature leak (centered on [0, 0]) fails this fixture.
    const bufCall = chain.rig.call(session, 'c2', 'geo_buffer', { ref: { resource: registered.resource.ref, feature: betaRef }, distance_m: 1000 })
    const buffered = await geoBuffer.execute(
      { ref: { resource: registered.resource.ref, feature: betaRef }, distance_m: 1000 },
      chain.rig.exec(session, { callId: 'c2' }),
    )
    chain.rig.result(session, bufCall, { text: 'ok' })
    assert.equal(buffered.status, 'succeeded')
    assert.ok(buffered.bbox[0] > 8.9 && buffered.bbox[2] < 11.1, `the buffered footprint must wrap the second point (bbox ${buffered.bbox})`)
    assert.ok(buffered.bbox[0] > 0.9, 'the first point must never leak into the buffered footprint')
    assert.match(buffered.artifact.ref, /^art-[a-f0-9-]+@v1$/)
    assert.equal(buffered.resource_ref, registered.resource.ref)
    assert.equal(buffered.feature_ref, betaRef)
    const bufMeta = geoBuffer.output.presentationMeta({}, buffered)
    assert.equal(bufMeta.inputs[0].resourceRef, registered.resource.ref)
    assert.equal(bufMeta.inputs[0].featureRef, betaRef)
    assert.equal(bufMeta.schemaVersion, 2)

    // retryOf returns the ORIGINAL published artifact without recomputing,
    // and a retry of an unpublished call refuses loudly.
    const replayCall = chain.rig.call(session, 'c2b', 'geo_buffer', { retry_of: bufCall.seq })
    const replay = await geoBuffer.execute(
      { retry_of: bufCall.seq },
      chain.rig.exec(session, { callId: 'c2b' }),
    )
    chain.rig.result(session, replayCall, { text: 'ok' })
    assert.equal(replay.artifact.ref, buffered.artifact.ref)
    assert.equal(replay.artifact.deduplicated, true)
    assert.equal(replay.retry_of, bufCall.seq)
    assert.equal(replay.distance_m, 1000, 'the stored parameters answer the retry')

    chain.rig.call(session, 'c2c', 'geo_buffer', { retry_of: 9999 })
    await assert.rejects(
      geoBuffer.execute({ retry_of: 9999 }, chain.rig.exec(session, { callId: 'c2c' })),
      /CATALOG_OPERATION_NOT_PUBLISHED/,
    )

    // The published artifact loads as a versioned layer carrying its identity.
    const addCall = chain.rig.call(session, 'c3', 'map_add_layer', { ref: buffered.artifact.ref, layer_id: 'buffer' })
    const added = await mapAddLayer.execute({ ref: buffered.artifact.ref, layer_id: 'buffer' }, chain.rig.exec(session, { callId: 'c3' }))
    assert.equal(added.layer.id, 'buffer')
    assert.equal(added.layer.featureCount, 1)
    chain.rig.result(session, addCall, { meta: added.meta })
    const state = chain.rig.state(session)
    assert.equal(state.layers.length, 1)
    assert.equal(state.layers[0].artifactRef, buffered.artifact.ref)
    assert.equal(state.layers[0].resourceRef, undefined)
    assert.equal(state.layers[0].displayDigest.length, 64)
    assert.equal(state.layers[0].legend.title, buffered.artifact.ref, 'the default layer name (and legend) is the artifact ref')
    assert.equal(added.meta.schemaVersion, 4)
  } finally {
    await chain.dispose()
  }
})

test('path and ref are mutually exclusive and selector errors refuse loudly', async () => {
  const chain = await chainRig('mutex')
  try {
    const path = chain.write('points.geojson', TWO_POINTS)
    const session = chain.rig.session('mutex')
    const regCall = chain.rig.call(session, 'c1', 'catalog_register', { path, name: 'points' })
    const registered = await catalogRegister.execute({ path, name: 'points' }, chain.rig.exec(session, { callId: 'c1' }))
    chain.rig.result(session, regCall, { text: 'ok' })
    const betaRef = registered.feature_refs.find(entry => entry.original_id === 'beta').feature_ref

    await assert.rejects(
      geoArea.execute({ path, ref: { resource: registered.resource.ref, feature: betaRef } }, chain.rig.exec(session, { callId: 'x1' })),
      /INVALID_ARGUMENT.*mutually exclusive/,
    )
    await assert.rejects(
      geoArea.execute({}, chain.rig.exec(session, { callId: 'x2' })),
      /INVALID_ARGUMENT.*requires either/,
    )
    await assert.rejects(
      geoBuffer.execute(
        { path, ref: { resource: registered.resource.ref, feature: betaRef }, distance_m: 100 },
        chain.rig.exec(session, { callId: 'x3' }),
      ),
      /INVALID_ARGUMENT.*mutually exclusive/,
    )
    // A well-formed but wrong feature ref never falls back to the first feature.
    await assert.rejects(
      geoArea.execute(
        { ref: { resource: registered.resource.ref, feature: 'f-does-not-exist' } },
        chain.rig.exec(session, { callId: 'x4' }),
      ),
      /INVALID_ARGUMENT.*not part of/,
    )
    // An unknown resource refuses with the catalog code.
    await assert.rejects(
      geoArea.execute(
        { ref: { resource: 'res-000000000000000000000000@v1', feature: betaRef } },
        chain.rig.exec(session, { callId: 'x5' }),
      ),
      /CATALOG_NOT_FOUND/,
    )
  } finally {
    await chain.dispose()
  }
})

test('the legacy path branch keeps its semantics while the ref branch survives source overwrites', async () => {
  const chain = await chainRig('overwrite')
  try {
    const path = chain.write('points.geojson', TWO_POINTS)
    const session = chain.rig.session('overwrite')
    const regCall = chain.rig.call(session, 'c1', 'catalog_register', { path, name: 'points' })
    const registered = await catalogRegister.execute({ path, name: 'points' }, chain.rig.exec(session, { callId: 'c1' }))
    chain.rig.result(session, regCall, { text: 'ok' })
    const betaRef = registered.feature_refs.find(entry => entry.original_id === 'beta').feature_ref

    const distanceBefore = await geoDistance.execute(
      { ref_a: { resource: registered.resource.ref, feature: betaRef }, path_b: path },
      chain.rig.exec(session, { callId: 'c2' }),
    )
    assert.equal(distanceBefore.feature_ref_a, betaRef)
    assert.equal(distanceBefore.feature_index_b, 0, 'the path end keeps its legacy first-feature semantics')

    // Overwrite the SOURCE file; the registered version still computes the
    // original second-point distance.
    chain.write('points.geojson', {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', id: 'alpha', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'moved' } }],
    })
    const distanceAfter = await geoDistance.execute(
      { ref_a: { resource: registered.resource.ref, feature: betaRef }, path_b: path },
      chain.rig.exec(session, { callId: 'c3' }),
    )
    assert.equal(distanceAfter.distance_m, distanceBefore.distance_m, 'the versioned end is immune to the source overwrite')

    chain.rig.call(session, 'c4', 'catalog_register', { path, name: 'points' })
    const reregistered = await catalogRegister.execute({ path, name: 'points' }, chain.rig.exec(session, { callId: 'c4' }))
    assert.equal(reregistered.resource.version, 2, 'overwritten source bytes re-register as a new version')
  } finally {
    await chain.dispose()
  }
})

test('invalid CRS refuses registration before any durable state', async () => {
  const chain = await chainRig('crs')
  try {
    const path = chain.write('points.geojson', TWO_POINTS)
    const session = chain.rig.session('crs')
    chain.rig.call(session, 'c1', 'catalog_register', { path, crs: 'EPSG:999999' })
    await assert.rejects(
      catalogRegister.execute({ path, crs: 'EPSG:999999' }, chain.rig.exec(session, { callId: 'c1' })),
      /CRS_UNKNOWN/,
    )
    chain.rig.call(session, 'c2', 'catalog_register', { path, crs: 'NOT-A-CRS' })
    await assert.rejects(
      catalogRegister.execute({ path, crs: 'NOT-A-CRS' }, chain.rig.exec(session, { callId: 'c2' })),
      /CRS_UNKNOWN/,
    )
    // A projected tabled CRS registers and records its convention.
    chain.rig.call(session, 'c3', 'catalog_register', { path, crs: 'EPSG:4547', name: 'projected' })
    const projected = await catalogRegister.execute(
      { path, crs: 'EPSG:4547', name: 'projected' },
      chain.rig.exec(session, { callId: 'c3' }),
    )
    assert.equal(projected.resource.nativeCrs, 'EPSG:4547')
    assert.equal(projected.resource.coordinateConvention, 'projected-grid')
  } finally {
    await chain.dispose()
  }
})

test('unsupported geometries analyze but are refused at display admission', async () => {
  const chain = await chainRig('multipoint')
  try {
    const multi = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', id: 'mp', geometry: { type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] }, properties: {} }],
    }
    const path = chain.write('multi.geojson', multi)
    const session = chain.rig.session('multi')
    chain.rig.call(session, 'c1', 'catalog_register', { path, name: 'multi' })
    const registered = await catalogRegister.execute({ path, name: 'multi' }, chain.rig.exec(session, { callId: 'c1' }))
    assert.equal(registered.status, 'succeeded', 'Multi* data registers for analysis')

    chain.rig.call(session, 'c2', 'map_add_layer', { ref: registered.resource.ref })
    await assert.rejects(
      mapAddLayer.execute({ ref: registered.resource.ref }, chain.rig.exec(session, { callId: 'c2' })),
      /GEOMETRY_UNSUPPORTED/,
      'the versioned branch refuses Multi* before proposing a layer',
    )
    chain.rig.call(session, 'c3', 'map_add_layer', { path })
    await assert.rejects(
      mapAddLayer.execute({ path }, chain.rig.exec(session, { callId: 'c3' })),
      /GEOMETRY_UNSUPPORTED/,
      'the path branch is display-admitted too',
    )
  } finally {
    await chain.dispose()
  }
})

test('map_save fixes the accepted prefix, confirms artifacts, and reports stages independently', async () => {
  const chain = await chainRig('save')
  try {
    const path = chain.write('points.geojson', TWO_POINTS)
    const session = chain.rig.session('save')
    const regCall = chain.rig.call(session, 'c1', 'catalog_register', { path, name: 'points' })
    const registered = await catalogRegister.execute({ path, name: 'points' }, chain.rig.exec(session, { callId: 'c1' }))
    chain.rig.result(session, regCall, { text: 'ok' })
    const betaRef = registered.feature_refs.find(entry => entry.original_id === 'beta').feature_ref
    const bufCall = chain.rig.call(session, 'c2', 'geo_buffer', { ref: { resource: registered.resource.ref, feature: betaRef }, distance_m: 1000 })
    const buffered = await geoBuffer.execute(
      { ref: { resource: registered.resource.ref, feature: betaRef }, distance_m: 1000 },
      chain.rig.exec(session, { callId: 'c2' }),
    )
    chain.rig.result(session, bufCall, { text: 'ok' })
    const addCall = chain.rig.call(session, 'c3', 'map_add_layer', { ref: buffered.artifact.ref, layer_id: 'buffer' })
    const added = await mapAddLayer.execute({ ref: buffered.artifact.ref, layer_id: 'buffer' }, chain.rig.exec(session, { callId: 'c3' }))
    chain.rig.result(session, addCall, { meta: added.meta })
    const revision = chain.rig.state(session).revision

    // Happy path: the receipt covers the accepted prefix and the revision.
    const flushOk = { flush: async () => true }
    chain.rig.call(session, 'c4', 'map_save', {})
    const saved = await mapSave.execute({}, execWithSessions(chain, session, flushOk, 'c4'))
    assert.equal(saved.saved, true)
    assert.equal(saved.revision, revision)
    assert.ok(saved.durable_through_seq >= addCall.seq)
    assert.equal(saved.session_flush, 'confirmed')
    assert.equal(saved.artifact_stage, 'confirmed')
    assert.deepEqual(saved.confirmed_refs, [buffered.artifact.ref], 'the receipt confirms exactly the objects the layers cite')
    const receipt = decodeMapSaveReceiptMeta(mapSave.output.presentationMeta({}, saved))
    assert.equal(receipt.kind, 'map-save-receipt')
    assert.equal(receipt.revision, revision)
    assert.ok(receipt.durableThroughSeq < Number(session.seq), 'the receipt never covers the save result itself')

    // Session flush failure: artifact stage confirmed, save reported failed.
    chain.rig.call(session, 'c5', 'map_save', {})
    const flushFailure = await mapSave.execute({}, execWithSessions(chain, session, { flush: async () => { throw new Error('disk full') } }, 'c5'))
    assert.equal(flushFailure.saved, false)
    assert.equal(flushFailure.artifact_stage, 'confirmed')
    assert.equal(flushFailure.session_flush, 'failed')
    assert.match(flushFailure.reason, /disk full/)
    assert.equal(flushFailure.revision, revision, 'the accepted state is preserved and reported')

    // No persistence provider: flush with no participant refuses the receipt.
    chain.rig.call(session, 'c6', 'map_save', {})
    const noProvider = await mapSave.execute({}, execWithSessions(chain, session, { flush: async () => false }, 'c6'))
    assert.equal(noProvider.saved, false)
    assert.match(noProvider.reason, /no persistence provider/)

    // File failure LAST: deleting the artifact bytes fails the artifact stage
    // and the session flush is NOT performed.
    rmSync(join(chain.storeRoot, 'sessions', 'save', 'files'), { recursive: true, force: true })
    chain.rig.call(session, 'c7', 'map_save', {})
    const broken = await mapSave.execute({}, execWithSessions(chain, session, flushOk, 'c7'))
    assert.equal(broken.saved, false)
    assert.equal(broken.artifact_stage, 'failed')
    assert.equal(broken.session_flush, 'not-performed')
    assert.match(broken.reason, /missing-file|digest-mismatch/)
    assert.ok(broken.confirmed_refs.every(ref => ref.includes('missing-file') || ref.includes('digest-mismatch')))

    // Stale revision refuses before any I/O (still fails loud).
    await assert.rejects(
      mapSave.execute({ map_revision: revision + 5 }, execWithSessions(chain, session, flushOk, 'c8')),
      /INVALID_ARGUMENT.*does not match/,
    )
  } finally {
    await chain.dispose()
  }
})

test('map_add_layer with both path and ref refuses; the ref path layer carries catalog identity', async () => {
  const chain = await chainRig('identity')
  try {
    const path = chain.write('points.geojson', TWO_POINTS)
    const session = chain.rig.session('identity')
    const regCall = chain.rig.call(session, 'c1', 'catalog_register', { path, name: 'points' })
    const registered = await catalogRegister.execute({ path, name: 'points' }, chain.rig.exec(session, { callId: 'c1' }))
    chain.rig.result(session, regCall, { text: 'ok' })

    chain.rig.call(session, 'c2', 'map_add_layer', { path, ref: registered.resource.ref })
    await assert.rejects(
      mapAddLayer.execute({ path, ref: registered.resource.ref }, chain.rig.exec(session, { callId: 'c2' })),
      /INVALID_ARGUMENT.*mutually exclusive/,
    )
    chain.rig.call(session, 'c3', 'map_add_layer', {})
    await assert.rejects(
      mapAddLayer.execute({}, chain.rig.exec(session, { callId: 'c3' })),
      /INVALID_ARGUMENT.*requires either/,
    )

    // The resource layer carries resource identity, digest, and a legend; a
    // crs override with a ref is refused (the version records its CRS).
    const addCall = chain.rig.call(session, 'c4', 'map_add_layer', { ref: registered.resource.ref, layer_id: 'src' })
    const added = await mapAddLayer.execute({ ref: registered.resource.ref, layer_id: 'src' }, chain.rig.exec(session, { callId: 'c4' }))
    chain.rig.result(session, addCall, { meta: added.meta })
    const layer = chain.rig.state(session).layers.find(candidate => candidate.id === 'src')
    assert.equal(layer.resourceRef, registered.resource.ref)
    assert.equal(layer.legend.symbol.color, '#1f77b4')
    chain.rig.call(session, 'c5', 'map_add_layer', { ref: registered.resource.ref, crs: 'EPSG:4547' })
    await assert.rejects(
      mapAddLayer.execute({ ref: registered.resource.ref, crs: 'EPSG:4547' }, chain.rig.exec(session, { callId: 'c5' })),
      /INVALID_ARGUMENT.*crs applies to path/,
    )
  } finally {
    await chain.dispose()
  }
})

test('legacy layers keep folding beside versioned layers in one projection', async () => {
  const chain = await chainRig('mixed')
  try {
    const path = chain.write('points.geojson', TWO_POINTS)
    const session = chain.rig.session('mixed')
    const regCall = chain.rig.call(session, 'c1', 'catalog_register', { path, name: 'points' })
    const registered = await catalogRegister.execute({ path, name: 'points' }, chain.rig.exec(session, { callId: 'c1' }))
    chain.rig.result(session, regCall, { text: 'ok' })

    // Legacy path layer.
    const legacyCall = chain.rig.call(session, 'c2', 'map_add_layer', { path, layer_id: 'legacy' })
    const legacy = await mapAddLayer.execute({ path, layer_id: 'legacy' }, chain.rig.exec(session, { callId: 'c2' }))
    chain.rig.result(session, legacyCall, { meta: legacy.meta })
    // Versioned layer on top.
    const refCall = chain.rig.call(session, 'c3', 'map_add_layer', { ref: registered.resource.ref, layer_id: 'versioned' })
    const versioned = await mapAddLayer.execute({ ref: registered.resource.ref, layer_id: 'versioned' }, chain.rig.exec(session, { callId: 'c3' }))
    chain.rig.result(session, refCall, { meta: versioned.meta })

    const state = chain.rig.state(session)
    assert.deepEqual(state.layers.map(layer => layer.id), ['legacy', 'versioned'])
    assert.equal(state.layers[0].resourceRef, undefined, 'the legacy layer carries no fabricated catalog identity')
    assert.equal(state.layers[1].resourceRef, registered.resource.ref)
    assert.ok(state.layers[0].displayDigest.length > 0, 'both layers carry a display identity token')
    assert.equal(state.revision, 2)
  } finally {
    await chain.dispose()
  }
})
