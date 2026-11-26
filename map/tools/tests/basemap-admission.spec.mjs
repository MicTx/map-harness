import test from 'node:test'
import assert from 'node:assert/strict'
import { createMapSourceCatalog } from '../../map-container/src/sources.ts'
import { initialMapProjectionState } from '../../map-container/src/protocol.ts'
import { admitCameraChange } from '../src/basemap-admission.ts'

const catalog = createMapSourceCatalog(undefined, 'allow', {})
const osm = catalog.selection('osm-standard').value
const service = { verifySource(source) { assert.equal(source.availability.kind, 'configured') } }

test('camera admission verifies the accepted selection and fails closed without the source service', () => {
  const state = { ...initialMapProjectionState(), basemap: osm }
  admitCameraChange(state, { op: 'set-view', view: { center: [1, 1], zoom: 2, wkid: 4326 } }, service)
  admitCameraChange(state, { op: 'set-view', view: { center: [1, 1], zoom: 2, wkid: 3857 } }, service)
  assert.throws(
    () => admitCameraChange(state, { op: 'set-view', view: { center: [1, 1], zoom: 2, wkid: 4547 } }, service),
    /SOURCE_COMBINATION_UNSUPPORTED/,
  )
  assert.throws(
    () => admitCameraChange(state, { op: 'set-mode', mode: 'scene' }, service),
    /SOURCE_COMBINATION_UNSUPPORTED/,
  )
  assert.throws(
    () => admitCameraChange(state, { op: 'set-view', view: { center: [1, 1], zoom: 2, wkid: 4326 } }, undefined),
    /SPATIAL_SERVICE_UNAVAILABLE/,
  )
})
