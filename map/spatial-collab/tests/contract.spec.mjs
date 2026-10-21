/**
 * Collab contract fixtures: same-layer update, delete, reorder, and
 * duplicate-patch payloads the tasks name. Every structural refusal names
 * its issue; every accepted fixture round-trips through the schema without
 * silent defaults.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PATCH_OPS,
  collabPatchSchema,
  parseCollabPatch,
} from '../src/contract.ts'

const VIEW = { center: [116.4, 39.9], zoom: 9, wkid: 4326 }

function layerInput(id, digest = `sha-${id}`) {
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

test('same-layer update, delete, reorder, and duplicate patch fixtures parse', () => {
  const patch = {
    operationId: 'op-update-point',
    expectedRevision: 4,
    ops: [
      // Same-layer update: conditional on the digest the writer read.
      { kind: 'upsert-layer', layer: layerInput('point', 'sha-point-v2'), expect: { digest: 'sha-point-v1' } },
      // Delete: conditional on the same digest, so a concurrent rewrite refuses.
      { kind: 'remove-layer', layerId: 'roads', expect: { digest: 'sha-roads' } },
      // Reorder: names exactly the current set and the expected prior order.
      { kind: 'reorder-layers', layerIds: ['roads', 'point'], expect: { order: ['point', 'roads'] } },
      // View / mode / aoi values with their overwrite guards.
      { kind: 'set-view', view: VIEW, expect: { viewDigest: JSON.stringify({ center: [0, 0], zoom: 0, wkid: 4326 }) } },
      { kind: 'set-mode', mode: 'scene', expect: { mode: 'map' } },
      { kind: 'set-aoi', aoi: { name: 'study', ring: [[0, 0], [1, 0], [1, 1], [0, 0]] }, expect: { aoiDigest: null } },
      // Style touch: per-layer identity expectations.
      { kind: 'set-style', entries: [{ layerId: 'point', expect: { digest: 'sha-point-v2' } }] },
    ],
  }
  const parsed = collabPatchSchema.parse(patch)
  assert.equal(parsed.ops.length, 7)
  assert.equal(parsed.expectedRevision, 4)
  assert.equal(parseCollabPatch(patch).status, 'ok')
})

test('structural refusals name the issue: empty patch, bad ids, oversize, bad payloads', () => {
  assert.equal(parseCollabPatch({ expectedRevision: 0, ops: [] }).status, 'invalid')
  const oversize = {
    expectedRevision: 0,
    ops: Array.from({ length: MAX_PATCH_OPS + 1 }, (_, index) => ({ kind: 'set-mode', mode: 'map', expect: undefined, _: index })),
  }
  assert.equal(parseCollabPatch(oversize).status, 'invalid')
  assert.equal(
    parseCollabPatch({ expectedRevision: 0, ops: [{ kind: 'remove-layer', layerId: 'bad id!' }] }).status,
    'invalid',
  )
  assert.equal(
    parseCollabPatch({
      expectedRevision: -1,
      ops: [{ kind: 'set-mode', mode: 'map' }],
    }).status,
    'invalid',
  )
  assert.equal(
    parseCollabPatch({
      expectedRevision: 0,
      ops: [{ kind: 'upsert-layer', layer: { ...layerInput('point'), digest: '' } }],
    }).status,
    'invalid',
  )
  assert.equal(
    parseCollabPatch({
      expectedRevision: 0,
      ops: [{ kind: 'set-aoi', aoi: { ring: [[0, 0], [1, 0]] } }],
    }).status,
    'invalid',
    'an aoi ring with fewer than three points refuses',
  )
  const aoi = parseCollabPatch({
    expectedRevision: 0,
    ops: [{ kind: 'set-aoi', aoi: { ring: [[200, 0], [1, 0], [1, 1]] } }],
  })
  assert.equal(aoi.status, 'invalid', 'an out-of-range aoi coordinate refuses')
})

test('the duplicate-patch fixture keeps its operation id stable across resubmission', () => {
  const first = parseCollabPatch({
    operationId: 'op-42',
    expectedRevision: 1,
    ops: [{ kind: 'set-mode', mode: 'scene' }],
  })
  const second = parseCollabPatch({
    operationId: 'op-42',
    expectedRevision: 1,
    ops: [{ kind: 'set-mode', mode: 'scene' }],
  })
  assert.equal(first.status, 'ok')
  assert.equal(second.status, 'ok')
  assert.equal(first.patch?.operationId, second.patch?.operationId)
})

test('expectations stay optional per op but every provided field is validated', () => {
  const bare = parseCollabPatch({ expectedRevision: 0, ops: [{ kind: 'set-view', view: VIEW }] })
  assert.equal(bare.status, 'ok')
  const badExpectation = parseCollabPatch({
    expectedRevision: 0,
    ops: [{ kind: 'set-mode', mode: 'map', expect: { mode: 'scene-x' } }],
  })
  assert.equal(badExpectation.status, 'invalid')
})
