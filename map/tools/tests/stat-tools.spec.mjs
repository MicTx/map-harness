/**
 * P2 stat-tool integration fixtures over the REAL catalog service and
 * projection plus the real statistics package: register a resource → the
 * accepted `tool/call` pairing → stats_zonal/stats_autocorrelation/
 * stats_hotspot/pattern_change/pattern_cluster/pattern_flow with numeric
 * answers carried through to model content; the not_applicable status
 * vocabulary; the artifact publication through the paired call; the durable
 * `spatial-stat` meta decoding through the same codec the projection
 * consumes; and the loud refusals (invalid specs, nested dispatch).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { catalogRegister } from '../src/catalog-tools.ts'
import {
  statsZonal,
  statsAutocorrelation,
  statsHotspot,
  patternChange,
  patternCluster,
  patternFlow,
} from '../src/stat-tools.ts'
import { decodeSpatialStatMeta, STAT_META_KIND } from '../src/stat-meta.ts'
import { STATS_METHOD_VERSION } from '../../spatial-statistics/src/contract.ts'

/** A 3x3 observation grid: top row high, bottom row low (a north-south gradient). */
function gridCollection() {
  const values = [[10, 10, 10], [5, 5, 5], [1, 1, 1]]
  const features = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      features.push({
        type: 'Feature',
        id: `u${row}${col}`,
        geometry: { type: 'Point', coordinates: [116 + col * 0.01, 39 + row * 0.01] },
        properties: { value: values[row][col], zone: row < 1 ? 'north' : row < 2 ? 'middle' : 'south' },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** A ten-day observation track set: two entities moving between two cells. */
function trackCollection() {
  const day = d => `2026-06-${String(d).padStart(2, '0')}T00:00:00Z`
  const obs = (id, lon, lat, d, value, entity) => ({
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { value, time: day(d), device: entity },
  })
  return {
    type: 'FeatureCollection',
    features: [
      obs('t1', 116, 39, 1, 10, 'e1'), obs('t2', 116.01, 39.01, 2, 12, 'e1'),
      obs('t3', 116, 39, 1, 10, 'e2'), obs('t4', 116.01, 39.01, 2, 14, 'e2'),
      obs('t5', 116.02, 39.02, 6, 20, 'e1'), obs('t6', 116.03, 39.03, 7, 22, 'e1'),
      obs('t7', 116.04, 39.04, 8, 21, 'e2'), obs('t8', 116.05, 39.05, 9, 25, 'e2'),
    ],
  }
}

async function statRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `map-stat-${label}-`))
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: join(dir, 'catalog') })
  return {
    dir,
    rig,
    async register(name, collection, sessionId = 'stat') {
      const path = join(dir, `${name}.geojson`)
      writeFileSync(path, JSON.stringify(collection))
      const session = rig.session(sessionId)
      rig.call(session, `reg-${name}`, 'catalog_register', { path, name })
      return catalogRegister.execute({ path, name }, rig.exec(session, { callId: `reg-${name}` }))
    },
    async dispose() {
      await rig.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('stats_zonal computes the analytic zone means and carries the durable spatial-stat meta', async () => {
  const rig = await statRig('zonal')
  try {
    const { resource } = await rig.register('units', gridCollection())
    const session = rig.rig.session('stat')
    rig.rig.call(session, 'sz-1', 'stats_zonal', { goal_revision: 1, resource_ref: resource.ref, field: 'value', zone_field: 'zone' })
    const result = await statsZonal.execute(
      { goal_revision: 1, resource_ref: resource.ref, field: 'value', zone_field: 'zone' },
      rig.rig.exec(session, { callId: 'sz-1' }),
    )
    assert.equal(result.status, 'succeeded')
    const north = result.zones.find(row => row.zone === 'north')
    const south = result.zones.find(row => row.zone === 'south')
    assert.equal(north.mean, 10)
    assert.equal(south.mean, 1)
    assert.equal(result.method_version, STATS_METHOD_VERSION)
    assert.ok(result.artifact_refs.length >= 1, 'the full zone table publishes as an artifact')
    assert.match(result.artifact_refs[0], /^art-/)

    const meta = decodeSpatialStatMeta(statsZonal.output.presentationMeta({}, result))
    assert.equal(meta.status, 'ok')
    assert.equal(meta.meta.kind, STAT_META_KIND)
    assert.equal(meta.meta.tool, 'stats_zonal')
    assert.equal(meta.meta.headline.metric, 'zone_count')
    assert.equal(meta.meta.headline.value, 3)
    assert.equal(meta.meta.resourceRef, resource.ref)
    assert.ok(meta.meta.specDigest.length, 64)
    // The model text strips the durable meta record.
    const rendered = statsZonal.output.render({}, result)
    assert.equal(rendered[0].text.includes('"meta"'), false)
  } finally {
    await rig.dispose()
  }
})

test('stats_autocorrelation and stats_hotspot reproduce the seeded package answers', async () => {
  const rig = await statRig('weighted')
  try {
    const { resource } = await rig.register('units', gridCollection())
    const session = rig.rig.session('stat')
    const args = { goal_revision: 1, resource_ref: resource.ref, field: 'value', band_meters: 1500, permutations: 199, seed: 20260924, multiple_testing: 'fdr-bh' }
    rig.rig.call(session, 'sa-1', 'stats_autocorrelation', args)
    const moran = await statsAutocorrelation.execute(args, rig.rig.exec(session, { callId: 'sa-1' }))
    assert.equal(moran.status, 'succeeded')
    assert.ok(moran.moran_i > 0.3, `the grid gradient has positive I (got ${moran.moran_i})`)
    assert.equal(moran.permutation.seed, 20260924)
    assert.equal(moran.local.length, 9)
    assert.ok(moran.artifact_refs.length >= 1)
    const moranMeta = decodeSpatialStatMeta(statsAutocorrelation.output.presentationMeta({}, moran))
    assert.equal(moranMeta.meta.headline.metric, 'moran_i')

    rig.rig.call(session, 'sh-1', 'stats_hotspot', { ...args, multiple_testing: 'none' })
    const hot = await statsHotspot.execute({ ...args, multiple_testing: 'none' }, rig.rig.exec(session, { callId: 'sh-1' }))
    const topId = hot.rows[0].unitId ?? hot.rows[0].unit_id
    assert.ok(['u00', 'u01', 'u02'].includes(topId), `a north-row unit ranks first (got ${topId})`)
    const hotMeta = decodeSpatialStatMeta(statsHotspot.output.presentationMeta({}, hot))
    assert.equal(hotMeta.meta.headline.metric, 'max_gi_star_z')
  } finally {
    await rig.dispose()
  }
})

test('the pattern tools report coverage, stability, and broken chains from the frozen track table', async () => {
  const rig = await statRig('patterns')
  try {
    const { resource } = await rig.register('tracks', trackCollection())
    const session = rig.rig.session('stat')

    const changeArgs = {
      goal_revision: 1, resource_ref: resource.ref, field: 'value', time_field: 'time',
      observation_from: '2026-06-01T00:00:00Z', observation_to: '2026-06-11T00:00:00Z',
      baseline_from: '2026-06-01T00:00:00Z', baseline_to: '2026-06-06T00:00:00Z',
      comparison_from: '2026-06-06T00:00:00Z', comparison_to: '2026-06-11T00:00:00Z',
      block_meters: 50_000, min_coverage: 0.3, unit_field: 'device',
    }
    rig.rig.call(session, 'pc-1', 'pattern_change', changeArgs)
    const change = await patternChange.execute(changeArgs, rig.rig.exec(session, { callId: 'pc-1' }))
    assert.equal(change.status, 'succeeded')
    assert.equal(change.units_with_both_windows, 2, 'both devices observe both windows')
    assert.ok(Math.abs(change.mean_delta - 10.5) < 1e-9, `mean of (20−10, 25−14) = 10.5 (got ${change.mean_delta})`)

    const clusterArgs = {
      goal_revision: 1, resource_ref: resource.ref, field: 'value', time_field: 'time',
      observation_from: '2026-06-01T00:00:00Z', observation_to: '2026-06-11T00:00:00Z',
      eps_meters: 500, eps_bins: 1, min_pts: 2, block_meters: 50_000, min_coverage: 0.3,
    }
    rig.rig.call(session, 'pcl-1', 'pattern_cluster', clusterArgs)
    const cluster = await patternCluster.execute(clusterArgs, rig.rig.exec(session, { callId: 'pcl-1' }))
    assert.equal(cluster.status, 'succeeded')
    assert.ok(cluster.clusters.length >= 1)

    const flowArgs = {
      goal_revision: 1, resource_ref: resource.ref, time_field: 'time', entity_field: 'device',
      observation_from: '2026-06-01T00:00:00Z', observation_to: '2026-06-11T00:00:00Z',
      cell_meters: 800, min_coverage: 0.3,
    }
    rig.rig.call(session, 'pf-1', 'pattern_flow', flowArgs)
    const flow = await patternFlow.execute(flowArgs, rig.rig.exec(session, { callId: 'pf-1' }))
    assert.equal(flow.status, 'succeeded')
    assert.equal(flow.entity_count, 2)
    const moved = flow.flows.find(row => row.flow === 'r0c0->r1c1')
    assert.ok(moved, `the analytic move flow exists (got ${JSON.stringify(flow.flows)})`)
    assert.equal(moved.transitionCount ?? moved.transition_count, 2)
  } finally {
    await rig.dispose()
  }
})

test('invalid specs are refused with every issue and not_applicable is an honest status', async () => {
  const rig = await statRig('refusals')
  try {
    const { resource } = await rig.register('units', gridCollection())
    const session = rig.rig.session('stat')

    // A time-forward violation: the comparison window overlaps the baseline.
    const bad = {
      goal_revision: 1, resource_ref: resource.ref, field: 'value', time_field: 'time',
      observation_from: '2026-06-01T00:00:00Z', observation_to: '2026-06-11T00:00:00Z',
      baseline_from: '2026-06-01T00:00:00Z', baseline_to: '2026-06-06T00:00:00Z',
      comparison_from: '2026-06-05T00:00:00Z', comparison_to: '2026-06-11T00:00:00Z',
      block_meters: 1000, min_coverage: 0.3,
    }
    rig.rig.call(session, 'bad-1', 'pattern_change', bad)
    await assert.rejects(
      () => patternChange.execute(bad, rig.rig.exec(session, { callId: 'bad-1' })),
      (error) => error instanceof Error && error.message.includes('window-order'),
      'overlapping sub-windows fail loud at the boundary',
    )

    // A structurally valid spec over a constant field: not_applicable, no p-value.
    const constant = {
      type: 'FeatureCollection',
      features: gridCollection().features.map((feature, index) => ({ ...feature, properties: { ...feature.properties, value: 7 }, id: `c${index}` })),
    }
    const { resource: constResource } = await rig.register('constant', constant, 'stat')
    const moranArgs = { goal_revision: 1, resource_ref: constResource.ref, field: 'value', band_meters: 1500, permutations: 199 }
    rig.rig.call(session, 'const-1', 'stats_autocorrelation', moranArgs)
    const refused = await statsAutocorrelation.execute(moranArgs, rig.rig.exec(session, { callId: 'const-1' }))
    assert.equal(refused.status, 'not_applicable')
    assert.equal(refused.not_applicable_reason, 'constant-field')
    assert.equal(refused.moran_i, null)
    assert.deepEqual(refused.artifact_refs, [], 'an inapplicable run publishes no artifact')
    const refusedMeta = decodeSpatialStatMeta(statsAutocorrelation.output.presentationMeta({}, refused))
    assert.equal(refusedMeta.meta.notApplicableReason, 'constant-field')
    void resource
  } finally {
    await rig.dispose()
  }
})
