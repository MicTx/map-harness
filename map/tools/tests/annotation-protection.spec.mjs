import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import * as spatialCollabPlugin from '../../spatial-collab/src/plugin.ts'
import { MAP_USER_CHANGE_SOURCE, userChangeNoticeText } from '../../map-container/src/user-change.ts'
import { USER_ANNOTATION_LAYER_ID } from '../../map-container/src/protocol.ts'
import { commitPatch } from '../../spatial-collab/src/engine.ts'
import { dataExport } from '../src/data-tools.ts'
import { mapDraw, mapGetState, mapRemoveLayer } from '../src/map-tools.ts'
import { SYMBOL_PRESETS } from '../../layers/src/index.ts'
import { mapUndo } from '../src/collab-tools.ts'
import { mapEditAnnotation } from '../src/annotation-tools.ts'

const at = '2026-11-04T00:00:00.000Z'
const featureId = 'ann-0123456789abcdef01234567'

async function chainRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `annotation-protection-${label}-`))
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCollabPlugin)
  await rig.ctx.plugin(spatialCatalogPlugin, { root: join(dir, 'store') })
  return {
    dir,
    rig,
    catalog: rig.ctx.get('spatialCatalog').forSession(rig.session(label).id),
    async dispose() {
      await rig.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

function insertAnnotation(session, revision) {
  const record = {
    operationId: 'annotation-create-test',
    targetRevision: revision,
    sessionId: session.id,
    at,
    featureId,
    change: { op: 'annotation-create', geometry: { type: 'Point', coordinates: [116.4, 39.9] }, name: 'Protected site' },
  }
  const message = {
    id: 'annotation-message',
    role: 'user',
    content: [{ type: 'text', text: userChangeNoticeText('创建标记', record) }],
    source: { kind: MAP_USER_CHANGE_SOURCE, form: 'notice', summary: '创建标记' },
  }
  return session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [message] })
}

test('model draw, remove, presentation, and collab patch paths cannot edit user annotations', async tContext => {
  const chain = await chainRig('writes')
  try {
    const session = chain.rig.session('writes')
    insertAnnotation(session, 0)
    const state = chain.rig.state(session)
    assert.equal(state.layers[0].role, 'user-annotation')

    chain.rig.call(session, 'draw-protected', 'map_draw', {})
    await assert.rejects(
      mapDraw.execute({
        kind: 'point',
        coordinates: [[116, 39]],
        layer_id: USER_ANNOTATION_LAYER_ID,
        name: 'forged',
      }, chain.rig.exec(session, { callId: 'draw-protected' })),
      error => error instanceof Error && error.code === 'annotation-protected',
    )

    chain.rig.call(session, 'remove-protected', 'map_remove_layer', {})
    await assert.rejects(
      mapRemoveLayer.execute({ layer_id: USER_ANNOTATION_LAYER_ID }, chain.rig.exec(session, { callId: 'remove-protected' })),
      error => error instanceof Error && error.code === 'annotation-protected',
    )

    chain.rig.call(session, 'undo-protected', 'map_undo', {})
    await assert.rejects(
      mapUndo.execute({ undo_of: 1 }, chain.rig.exec(session, { callId: 'undo-protected' })),
      /user annotations change only through the confirmed user-annotation undo path/,
    )

    const document = {
      revision: 1,
      layers: [{ id: USER_ANNOTATION_LAYER_ID, digest: 'protected' }, { id: 'business', digest: 'business-v1' }],
      view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 },
      mode: 'map',
      basemapDigest: null,
      protectedLayerIds: [USER_ANNOTATION_LAYER_ID],
      aoiDigest: null,
    }
    const layer = { id: USER_ANNOTATION_LAYER_ID, name: 'forged', digest: 'forged', sourceCrs: 'EPSG:4326', opacity: 1, visible: true, data: { type: 'FeatureCollection', features: [] } }
    const cases = [
      [{ kind: 'upsert-layer', layer }],
      [{ kind: 'update-layer', layerId: USER_ANNOTATION_LAYER_ID, visible: false }],
      [{ kind: 'remove-layer', layerId: USER_ANNOTATION_LAYER_ID }],
      [{ kind: 'reorder-layers', layerIds: [USER_ANNOTATION_LAYER_ID, 'business'] }],
      [{ kind: 'set-style', entries: [{ layerId: USER_ANNOTATION_LAYER_ID, style: null }] }],
    ]
    for (const ops of cases) {
      const result = commitPatch(document, { expectedRevision: 1, ops })
      assert.equal(result.status, 'conflict')
      assert.equal(result.code, 'layer_protected')
      assert.equal(result.diff.entries[0].code, 'layer_protected')
    }
    assert.equal(chain.rig.state(session).layers.length, 1)
  } finally {
    await chain.dispose()
  }
})

test('an agent updates, deletes, and undoes a user annotation with its own durable writer identity', async t => {
  const chain = await chainRig('agent-edits')
  t.after(async () => chain.dispose())
  const session = chain.rig.session('agent-edits')
  insertAnnotation(session, 0)
  const current = await mapGetState.execute({}, chain.rig.exec(session))
  assert.equal(current.annotations[0].id, featureId)
  assert.equal(current.annotations[0].properties.dshUpdatedAt, at)
  const update = {
    expected_revision: 1,
    change: { op: 'annotation-update', featureId, expectedUpdatedAt: at, name: 'Updated by agent' },
  }
  const updateCall = chain.rig.call(session, 'agent-update', 'map_edit_annotation', update)
  const proposed = await mapEditAnnotation.execute(update, chain.rig.exec(session, { callId: 'agent-update' }))
  assert.equal(chain.rig.state(session).revision, 1)
  chain.rig.result(session, updateCall, { meta: proposed.meta })
  let state = chain.rig.state(session)
  assert.equal(state.revision, 2)
  assert.equal(state.layers[0].data.features[0].properties.name, 'Updated by agent')
  assert.equal(state.layers[0].data.features[0].properties.dshAuthor, 'user')
  assert.equal(state.operations.at(-1).writerId, 'agent')
  assert.equal(state.operations.at(-1).callId, 'agent-update')

  const stale = { expected_revision: 2, change: { op: 'annotation-update', featureId, expectedUpdatedAt: at, name: 'Stale' } }
  chain.rig.call(session, 'stale-update', 'map_edit_annotation', stale)
  await assert.rejects(mapEditAnnotation.execute(stale, chain.rig.exec(session, { callId: 'stale-update' })), /stale-revision/)
  assert.equal(chain.rig.state(session).revision, 2)

  const mixedDelete = { expected_revision: 2, change: { op: 'annotation-delete', featureIds: [featureId, 'ann-aaaaaaaaaaaaaaaaaaaaaaaa'] } }
  chain.rig.call(session, 'mixed-delete', 'map_edit_annotation', mixedDelete)
  await assert.rejects(mapEditAnnotation.execute(mixedDelete, chain.rig.exec(session, { callId: 'mixed-delete' })), /annotation-unknown/)
  assert.equal(chain.rig.state(session).revision, 2)

  const deletion = { expected_revision: 2, change: { op: 'annotation-delete', featureIds: [featureId] } }
  const deleteCall = chain.rig.call(session, 'agent-delete', 'map_edit_annotation', deletion)
  const deleted = await mapEditAnnotation.execute(deletion, chain.rig.exec(session, { callId: 'agent-delete' }))
  chain.rig.result(session, deleteCall, { meta: deleted.meta })
  state = chain.rig.state(session)
  assert.equal(state.revision, 3)
  assert.equal(state.layers.some(layer => layer.id === USER_ANNOTATION_LAYER_ID), false)
  assert.equal(state.operations.at(-1).writerId, 'agent')

  const undo = { expected_revision: 3, change: { op: 'annotation-undo', operationId: deleted.operation_id } }
  const undoCall = chain.rig.call(session, 'agent-undo', 'map_edit_annotation', undo)
  const undone = await mapEditAnnotation.execute(undo, chain.rig.exec(session, { callId: 'agent-undo' }))
  chain.rig.result(session, undoCall, { meta: undone.meta })
  state = chain.rig.state(session)
  assert.equal(state.revision, 4)
  assert.equal(state.layers[0].data.features[0].properties.name, 'Updated by agent')
  assert.equal(state.layers[0].data.features[0].properties.dshAuthor, 'user')
  assert.equal(state.operations.at(-1).writerId, 'agent')
  const restored = chain.rig.ctx.sessionProjections.restore({}, session.snapshotEvents(), 0, session.header, session.inheritedEventCount)
  assert.deepEqual(restored.checkpoint.mapContainer.val, state)
})

test('an agent styles and reorders user annotations, then safely undoes each operation', async t => {
  const chain = await chainRig('agent-presentation')
  t.after(async () => chain.dispose())
  const session = chain.rig.session('agent-presentation')
  insertAnnotation(session, 0)
  const layerArgs = { layer_id: 'business', name: 'Business', kind: 'point', coordinates: [[116, 39]] }
  const layerCall = chain.rig.call(session, 'business-layer', 'map_draw', layerArgs)
  const layer = await mapDraw.execute(layerArgs, chain.rig.exec(session, { callId: 'business-layer' }))
  chain.rig.result(session, layerCall, { meta: layer.meta })
  const commit = async (callId, change) => {
    const args = { expected_revision: chain.rig.state(session).revision, change }
    const call = chain.rig.call(session, callId, 'map_edit_annotation', args)
    const output = await mapEditAnnotation.execute(args, chain.rig.exec(session, { callId }))
    chain.rig.result(session, call, { meta: output.meta })
    return output
  }
  const { symbolVersion: _derived, ...symbolDraft } = SYMBOL_PRESETS[0].symbol
  const styled = await commit('agent-layer-style', { op: 'annotation-layer-style', symbol: symbolDraft })
  let state = chain.rig.state(session)
  assert.equal(state.layers.find(entry => entry.id === USER_ANNOTATION_LAYER_ID).symbol.symbolVersion, SYMBOL_PRESETS[0].symbol.symbolVersion)
  assert.equal(state.layers.find(entry => entry.id === USER_ANNOTATION_LAYER_ID).data.features[0].properties.dshAuthor, 'user')
  const reordered = await commit('agent-layer-order', { op: 'annotation-layer-order', layerIds: ['business', USER_ANNOTATION_LAYER_ID] })
  state = chain.rig.state(session)
  assert.deepEqual(state.layers.map(entry => entry.id), ['business', USER_ANNOTATION_LAYER_ID])
  await commit('undo-layer-order', { op: 'annotation-undo', operationId: reordered.operation_id })
  assert.deepEqual(chain.rig.state(session).layers.map(entry => entry.id), [USER_ANNOTATION_LAYER_ID, 'business'])
  await commit('undo-layer-style', { op: 'annotation-undo', operationId: styled.operation_id })
  state = chain.rig.state(session)
  assert.equal(state.layers.find(entry => entry.id === USER_ANNOTATION_LAYER_ID).symbol, undefined)
  assert.equal(state.operations.at(-1).writerId, 'agent')
  const styledAgain = await commit('agent-style-again', { op: 'annotation-layer-style', symbol: symbolDraft })
  const userUpdate = {
    operationId: 'user-change-after-style', targetRevision: state.revision + 1, sessionId: session.id,
    at: '2026-11-04T00:02:00.000Z', featureId,
    change: { op: 'annotation-update', featureId, expectedUpdatedAt: at, name: 'User updated' },
  }
  session.append('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{
    id: 'user-change-after-style-message', role: 'user',
    content: [{ type: 'text', text: userChangeNoticeText('update', userUpdate) }],
    source: { kind: MAP_USER_CHANGE_SOURCE, form: 'notice', summary: 'update' },
  }] })
  const undoArgs = { expected_revision: chain.rig.state(session).revision,
    change: { op: 'annotation-undo', operationId: styledAgain.operation_id } }
  chain.rig.call(session, 'agent-stale-style-undo', 'map_edit_annotation', undoArgs)
  await assert.rejects(mapEditAnnotation.execute(undoArgs, chain.rig.exec(session, { callId: 'agent-stale-style-undo' })), /stale-revision/)
  state = chain.rig.state(session)
  assert.equal(state.layers.find(entry => entry.id === USER_ANNOTATION_LAYER_ID).data.features[0].properties.name, 'User updated')
  const restored = chain.rig.ctx.sessionProjections.restore({}, session.snapshotEvents(), 0, session.header, session.inheritedEventCount)
  assert.deepEqual(restored.checkpoint.mapContainer.val, state)
})

test('agent annotation results reject forged pairing and stale revisions without mutating data', async t => {
  const chain = await chainRig('agent-pairing')
  t.after(async () => chain.dispose())
  const session = chain.rig.session('agent-pairing')
  insertAnnotation(session, 0)
  const args = { expected_revision: 1, change: { op: 'annotation-update', featureId, expectedUpdatedAt: at, name: 'Changed' } }
  const call = chain.rig.call(session, 'agent-pairing', 'map_edit_annotation', args)
  const result = await mapEditAnnotation.execute(args, chain.rig.exec(session, { callId: call.data.callId }))
  chain.rig.result(session, call, { meta: { ...result.meta, sourceCallSeq: result.meta.sourceCallSeq + 1 } })
  assert.equal(chain.rig.state(session).revision, 1)
  assert.equal(chain.rig.state(session).layers[0].data.features[0].properties.name, 'Protected site')
  assert.equal(chain.rig.state(session).diagnostics.at(-1).code, 'call-pairing')
  const stale = { ...args, expected_revision: 0 }
  chain.rig.call(session, 'agent-stale-revision', 'map_edit_annotation', stale)
  await assert.rejects(mapEditAnnotation.execute(stale, chain.rig.exec(session, { callId: 'agent-stale-revision' })), /STALE_OBSERVATION/)
})

test('annotation export freezes accepted GeoJSON with map-projection provenance', async tContext => {
  const chain = await chainRig('export')
  try {
    const session = chain.rig.session('export')
    insertAnnotation(session, 0)
    const revision = chain.rig.state(session).revision

    chain.rig.call(session, 'export-csv', 'data_export', {})
    await assert.rejects(
      dataExport.execute({ layer_id: USER_ANNOTATION_LAYER_ID, format: 'csv' }, chain.rig.exec(session, { callId: 'export-csv' })),
      /user annotations export only GeoJSON/,
    )

    chain.rig.call(session, 'export-map', 'data_export', {})
    const wholeMap = await dataExport.execute({ map: true, format: 'geojson' }, chain.rig.exec(session, { callId: 'export-map' }))
    assert.deepEqual(wholeMap.exported, [])
    assert.deepEqual(wholeMap.failed, [{
      layer_id: USER_ANNOTATION_LAYER_ID,
      reason: 'user annotations export only with layer_id=user-annotations and format=geojson',
    }])

    const call = chain.rig.call(session, 'export-annotations', 'data_export', {})
    const exported = await dataExport.execute(
      { layer_id: USER_ANNOTATION_LAYER_ID, format: 'geojson' },
      chain.rig.exec(session, { callId: 'export-annotations' }),
    )
    assert.equal(exported.status, 'succeeded')
    assert.deepEqual(exported.source, { kind: 'annotations', map_revision: revision, feature_count: 1 })
    assert.equal(exported.artifact.feature_count, 1)

    const { artifact, bytes } = await chain.catalog.readArtifactBytes(exported.artifact.ref, chain.catalog.deploymentDomain())
    assert.deepEqual(artifact.inputRefs, [])
    const decoded = JSON.parse(new TextDecoder().decode(bytes))
    assert.equal(decoded.type, 'FeatureCollection')
    assert.equal(decoded.features.length, 1)
    assert.equal(decoded.features[0].id, featureId)
    assert.equal(decoded.features[0].properties.name, 'Protected site')
    assert.equal(decoded.features[0].properties.dshAuthor, 'user')

    const otherCatalog = chain.rig.ctx.get('spatialCatalog').forSession(chain.rig.session('other').id)
    await assert.rejects(
      otherCatalog.readArtifactBytes(exported.artifact.ref, chain.catalog.deploymentDomain()),
      /CATALOG_NOT_FOUND/,
    )
  } finally {
    await chain.dispose()
  }
})
