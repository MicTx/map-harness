/**
 * Serial commit engine behavior: the expectedRevision CAS and the acceptance
 * run in one segment; conflicts return explainable per-op diffs; deletes of
 * already-deleted layers never auto-replay; duplicate patches replay their
 * first outcome; and the undo target checks distinguish matched,
 * already-undone, and changed records.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkUndoTarget, commitPatch, withLedgerEntry } from '../src/engine.ts'
import { renderConflictDiff } from '../src/diff.ts'

function doc(overrides = {}) {
  return {
    revision: 3,
    layers: [
      { id: 'point', digest: 'sha-point-v1' },
      { id: 'roads', digest: 'sha-roads' },
    ],
    view: { center: [0, 0], zoom: 0, wkid: 4326 },
    mode: 'map',
    aoiDigest: null,
    ...overrides,
  }
}

function layerInput(id, digest) {
  return {
    id,
    name: id,
    digest,
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    data: { type: 'FeatureCollection', features: [] },
  }
}

test('the expectedRevision CAS refuses a stale base with the current document face', () => {
  const current = doc({ revision: 5, layers: [{ id: 'later', digest: 'sha-later' }] })
  const result = commitPatch(current, {
    expectedRevision: 3,
    ops: [{ kind: 'set-mode', mode: 'scene' }],
  }, { baseDocument: doc() })
  assert.equal(result.status, 'conflict')
  assert.equal(result.code, 'stale_revision')
  assert.equal(result.diff.currentRevision, 5)
  assert.match(result.diff.summary, /layers removed: point, roads/)
  assert.match(result.diff.summary, /layers added: later/)
  const text = renderConflictDiff(result.diff)
  assert.match(text, /stale base/)
  assert.match(text, /layer later @sha-later/)
})

test('a stale same-layer update conflicts on the digest expectation, never overwrites', () => {
  // The writer rebased its expectedRevision to the current one after an
  // earlier conflict but kept the layer digest from its older read.
  const current = doc({ revision: 4, layers: [{ id: 'point', digest: 'sha-point-v2' }, { id: 'roads', digest: 'sha-roads' }] })
  const result = commitPatch(current, {
    expectedRevision: 4,
    ops: [{ kind: 'upsert-layer', layer: layerInput('point', 'sha-point-v9'), expect: { digest: 'sha-point-v1' } }],
  })
  assert.equal(result.status, 'conflict')
  assert.equal(result.code, 'layer_digest_conflict')
  assert.deepEqual(result.diff.entries[0], {
    index: 0,
    kind: 'upsert-layer',
    code: 'layer_digest_conflict',
    detail: 'expected layer point at digest sha-point-v1, but its content changed',
  })
})

test('a delete against an already-deleted layer conflicts and is not replayed', () => {
  const current = doc({ revision: 4, layers: [{ id: 'point', digest: 'sha-point-v1' }] })
  const result = commitPatch(current, {
    expectedRevision: 4,
    ops: [{ kind: 'remove-layer', layerId: 'roads' }],
  })
  assert.equal(result.status, 'conflict')
  assert.equal(result.code, 'layer_missing')
  assert.match(result.diff.entries[0].detail, /already gone; the delete is not replayed/)
})

test('a delete whose layer changed since conflicts on the digest guard', () => {
  const current = doc({ layers: [{ id: 'point', digest: 'sha-point-v1' }, { id: 'roads', digest: 'sha-roads-v2' }] })
  const result = commitPatch(current, {
    expectedRevision: current.revision,
    ops: [{ kind: 'remove-layer', layerId: 'roads', expect: { digest: 'sha-roads' } }],
  })
  assert.equal(result.status, 'conflict')
  assert.equal(result.code, 'layer_digest_conflict')
})

test('an upsert with expect.absent refuses when another writer created the layer first', () => {
  const current = doc({ layers: [{ id: 'point', digest: 'sha-point-v1' }, { id: 'roads', digest: 'sha-roads' }, { id: 'aoi-mask', digest: 'sha-mask' }] })
  const result = commitPatch(current, {
    expectedRevision: current.revision,
    ops: [{ kind: 'upsert-layer', layer: layerInput('aoi-mask', 'sha-mask-mine'), expect: { absent: true } }],
  })
  assert.equal(result.status, 'conflict')
  assert.equal(result.code, 'layer_present')
})

test('reorder names exactly the current set and honors the prior-order expectation', () => {
  const reversed = {
    expectedRevision: 3,
    ops: [{ kind: 'reorder-layers', layerIds: ['roads', 'point'], expect: { order: ['point', 'roads'] } }],
  }
  const accepted = commitPatch(doc(), reversed)
  assert.equal(accepted.status, 'accepted')
  assert.deepEqual(accepted.document.layers.map(layer => layer.id), ['roads', 'point'])
  assert.equal(accepted.revision, 4)

  // The order moved on (another writer reordered first): the prior-order
  // expectation refuses.
  const drifted = doc({ layers: [{ id: 'roads', digest: 'sha-roads' }, { id: 'point', digest: 'sha-point-v1' }] })
  const conflict = commitPatch(drifted, reversed)
  assert.equal(conflict.status, 'conflict')
  assert.equal(conflict.code, 'order_conflict')
})

test('acceptance applies every op all-or-nothing and bumps one revision per patch', () => {
  const result = commitPatch(doc(), {
    expectedRevision: 3,
    ops: [
      { kind: 'remove-layer', layerId: 'roads' },
      { kind: 'upsert-layer', layer: layerInput('aoi-mask', 'sha-mask') },
      { kind: 'set-view', view: { center: [116.4, 39.9], zoom: 9, wkid: 4326 } },
      { kind: 'set-aoi', aoi: { name: 'study', ring: [[0, 0], [1, 0], [1, 1], [0, 0]] } },
    ],
  })
  assert.equal(result.status, 'accepted')
  assert.equal(result.revision, 4, 'the whole patch is one serial commit segment')
  assert.deepEqual(result.document.layers.map(layer => layer.id), ['point', 'aoi-mask'])
  assert.equal(result.document.aoiDigest, JSON.stringify({ name: 'study', ring: [[0, 0], [1, 0], [1, 1], [0, 0]] }))
})

test('one failing op refuses the whole patch — no partial application', () => {
  const result = commitPatch(doc(), {
    expectedRevision: 3,
    ops: [
      { kind: 'set-mode', mode: 'scene' },
      { kind: 'remove-layer', layerId: 'missing-layer' },
    ],
  })
  assert.equal(result.status, 'conflict')
  assert.deepEqual(result.diff.currentLayers, doc().layers, 'the document face is unchanged')
  assert.deepEqual(result.diff.entries, [{
    index: 1,
    kind: 'remove-layer',
    code: 'layer_missing',
    detail: 'layer missing-layer is already gone; the delete is not replayed',
  }])
})

test('a repeated operation id replays the recorded outcome instead of applying twice', () => {
  const document = doc()
  const patch = { operationId: 'op-42', expectedRevision: 3, ops: [{ kind: 'set-mode', mode: 'scene' }] }
  let ledger = []
  const first = commitPatch(document, patch, { ledger })
  assert.equal(first.status, 'accepted')
  ledger = withLedgerEntry(ledger, { operationId: 'op-42', status: 'accepted', revision: first.revision })
  const replay = commitPatch(document, patch, { ledger: new Map(ledger.map(row => [row.operationId, row])) })
  assert.deepEqual(replay, { status: 'duplicate', outcome: { operationId: 'op-42', status: 'accepted', revision: 4 } })
  const recordedConflict = new Map([['op-42', { operationId: 'op-42', status: 'conflict', code: 'layer_missing' }]])
  const replayedConflict = commitPatch(document, { ...patch, ops: [{ kind: 'set-mode', mode: 'map' }] }, { ledger: recordedConflict })
  assert.equal(replayedConflict.status, 'duplicate')
  assert.equal(replayedConflict.outcome.code, 'layer_missing')
})

test('the ledger stays bounded, dropping the oldest outcome first', () => {
  let ledger = []
  for (let index = 0; index < 200; index += 1) {
    ledger = withLedgerEntry(ledger, { operationId: `op-${index}`, status: 'accepted', revision: index })
  }
  assert.equal(ledger.length <= 128, true)
  assert.equal(ledger[0].operationId, 'op-72')
  assert.equal(ledger[ledger.length - 1].operationId, 'op-199')
})

test('the concurrent barrier: writer B commits between B-read and B-write, B conflicts and re-decides', () => {
  const base = doc()
  // Writer B prepares a patch against revision 3.
  const writerB = { expectedRevision: 3, ops: [{ kind: 'set-view', view: { center: [1, 1], zoom: 2, wkid: 4326 } }] }
  // Writer A wins the segment first.
  const writerA = commitPatch(base, { expectedRevision: 3, ops: [{ kind: 'set-mode', mode: 'scene' }] })
  assert.equal(writerA.status, 'accepted')
  const afterA = writerA.document
  // Writer B's prepared patch now hits the serial segment: refused with a diff.
  const refused = commitPatch(afterA, writerB, { baseDocument: base })
  assert.equal(refused.status, 'conflict')
  assert.equal(refused.code, 'stale_revision')
  // B re-reads and re-decides explicitly with a digest/view guard.
  const reDecided = {
    expectedRevision: afterA.revision,
    ops: [{ kind: 'set-view', view: { center: [1, 1], zoom: 2, wkid: 4326 }, expect: { viewDigest: JSON.stringify(afterA.view) } }],
  }
  const accepted = commitPatch(afterA, reDecided)
  assert.equal(accepted.status, 'accepted')
  assert.deepEqual(accepted.document.view, { center: [1, 1], zoom: 2, wkid: 4326 })
})

test('undo verdicts: matched, already-undone, and changed for layer, view, and aoi records', () => {
  const document = doc()

  // Undoing an add while the layer is still present: matched.
  const addUndo = [{ kind: 'remove-layer', layerId: 'point' }]
  assert.deepEqual(
    checkUndoTarget(document, { layers: [{ id: 'point', digest: 'sha-point-v1' }] }, addUndo),
    { verdict: 'matched' },
  )
  // Someone rewrote the layer since: changed.
  assert.deepEqual(
    checkUndoTarget(doc({ layers: [{ id: 'point', digest: 'sha-point-v2' }, { id: 'roads', digest: 'sha-roads' }] }), { layers: [{ id: 'point', digest: 'sha-point-v1' }] }, addUndo).verdict,
    'changed',
  )
  // The layer is gone: the add is already undone.
  assert.deepEqual(
    checkUndoTarget(doc({ layers: [{ id: 'roads', digest: 'sha-roads' }] }), { layers: [{ id: 'point', digest: 'sha-point-v1' }] }, addUndo),
    { verdict: 'already-undone' },
  )

  // Undoing a remove while the id is still absent: matched.
  const removeUndo = [{ kind: 'upsert-layer', layer: layerInput('mask', 'sha-mask') }]
  assert.deepEqual(
    checkUndoTarget(document, { absentIds: ['mask'] }, removeUndo),
    { verdict: 'matched' },
  )
  // Someone re-added the same content: already-undone.
  const reAdded = doc({ layers: [{ id: 'point', digest: 'sha-point-v1' }, { id: 'roads', digest: 'sha-roads' }, { id: 'mask', digest: 'sha-mask' }] })
  assert.deepEqual(checkUndoTarget(reAdded, { absentIds: ['mask'] }, removeUndo), { verdict: 'already-undone' })
  // Someone re-added DIFFERENT content: changed.
  const reAddedOther = doc({ layers: [{ id: 'point', digest: 'sha-point-v1' }, { id: 'roads', digest: 'sha-roads' }, { id: 'mask', digest: 'sha-mask-v2' }] })
  assert.equal(checkUndoTarget(reAddedOther, { absentIds: ['mask'] }, removeUndo).verdict, 'changed')

  // Undoing a view change: matched while the recorded post view is live.
  const viewUndo = [{ kind: 'set-view', view: { center: [0, 0], zoom: 0, wkid: 4326 } }]
  const post = { view: { center: [1, 1], zoom: 3, wkid: 4326 } }
  assert.deepEqual(checkUndoTarget(doc({ view: { center: [1, 1], zoom: 3, wkid: 4326 } }), post, viewUndo), { verdict: 'matched' })
  assert.deepEqual(
    checkUndoTarget(doc({ view: { center: [1, 1], zoom: 3, wkid: 4326 } }), post, viewUndo).verdict,
    'matched',
  )
  // The view was moved back already (someone applied the inverse): already-undone.
  assert.deepEqual(checkUndoTarget(doc(), post, viewUndo), { verdict: 'already-undone' })
  // The view moved somewhere ELSE entirely: changed.
  assert.equal(
    checkUndoTarget(doc({ view: { center: [9, 9], zoom: 1, wkid: 4326 } }), post, viewUndo).verdict,
    'changed',
  )

  // AOI: matched / already-undone / changed.
  const aoiUndo = [{ kind: 'set-aoi', aoi: null }]
  const aoiDigest = JSON.stringify({ name: 'study', ring: [[0, 0], [1, 0], [1, 1]] })
  assert.deepEqual(checkUndoTarget(doc({ aoiDigest }), { aoiDigest }, aoiUndo), { verdict: 'matched' })
  assert.deepEqual(checkUndoTarget(doc(), { aoiDigest }, aoiUndo), { verdict: 'already-undone' })
  assert.equal(checkUndoTarget(doc({ aoiDigest: 'other' }), { aoiDigest }, aoiUndo).verdict, 'changed')
})

test('a multi-step undo chain stays consistent through the record post-states', () => {
  // rev3 base -> rev4: writer sets view V1 -> rev5: writer sets view V2.
  const rev4 = commitPatch(doc(), { expectedRevision: 3, ops: [{ kind: 'set-view', view: { center: [1, 1], zoom: 4, wkid: 4326 } }] })
  assert.equal(rev4.status, 'accepted')
  const rev5 = commitPatch(rev4.document, { expectedRevision: 4, ops: [{ kind: 'set-view', view: { center: [2, 2], zoom: 5, wkid: 4326 } }] })
  assert.equal(rev5.status, 'accepted')
  const viewAt = rev => ({ center: rev === 4 ? [1, 1] : [2, 2], zoom: rev === 4 ? 4 : 5, wkid: 4326 })

  // Undo the newest op first: its post (V2) is live, inverse (V1) differs.
  const undoSecond = checkUndoTarget(rev5.document, { view: viewAt(5) }, [{ kind: 'set-view', view: viewAt(4) }])
  assert.deepEqual(undoSecond, { verdict: 'matched' })
  // After applying that undo (document back at V1), undoing the first op is matched too.
  const afterFirstUndo = rev4.document
  const undoFirst = checkUndoTarget(afterFirstUndo, { view: viewAt(4) }, [{ kind: 'set-view', view: { center: [0, 0], zoom: 0, wkid: 4326 } }])
  assert.deepEqual(undoFirst, { verdict: 'matched' })
})
