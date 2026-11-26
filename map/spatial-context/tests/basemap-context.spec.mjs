import test from 'node:test'
import assert from 'node:assert/strict'
import { composeSnapshot } from '../src/snapshot.ts'
import { FRAME_SPATIAL_TOOL_NAMES, initialSpatialContextState } from '../src/protocol.ts'
import { DEFAULT_BUDGET_CONFIG } from '../src/budget.ts'

test('spatial context exposes the basemap tools and renders the selected source identity', () => {
  assert.equal(FRAME_SPATIAL_TOOL_NAMES.includes('map_set_basemap'), true)
  assert.equal(FRAME_SPATIAL_TOOL_NAMES.includes('map_list_basemaps'), true)
  assert.equal(FRAME_SPATIAL_TOOL_NAMES.includes('map_compare_views'), true)
  assert.equal(FRAME_SPATIAL_TOOL_NAMES.includes('map_mark_changes'), true)
  const frame = initialSpatialContextState()
  frame.goal = {
    questionId: 'q-0',
    goalRevision: 1,
    question: '定位社区',
    sourceSeq: 0,
    sourceKind: 'user-message',
    acceptedAt: 1_000,
  }
  const composed = composeSnapshot({
    frame,
    mapRevision: 3,
    mapLayerCount: 0,
    mapLayers: [],
    mapView: { center: [116.4, 39.9], zoom: 9, wkid: 4326 },
    mapEnvironment: {
      mode: 'scene',
      basemap: 'Esri World Imagery + Esri World Boundaries and Places',
    },
    mapAoi: null,
    budget: DEFAULT_BUDGET_CONFIG,
    nowMs: 2_000,
  }, [])
  assert.ok(composed)
  assert.ok(composed.text.includes('地图环境: 3D 场景, 底图=Esri World Imagery + Esri World Boundaries and Places'))
  assert.ok(composed.text.includes('视觉变化候选: 无（map_mark_changes 的两图候选未经用户确认，不当作已确认变化）'))
})
