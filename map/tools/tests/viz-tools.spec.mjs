/**
 * P3-visualization tool integration fixtures over the REAL catalog service
 * and projection plus the real spatial-viz package: register a resource →
 * `viz_create_style` computes real breaks from the frozen bytes and publishes
 * the style record through the paired call → `map_add_layer` loads a layer →
 * `viz_classify` styles it from its own rendered data and the `set-style`
 * map-change folds through the standard commit protocol → `viz_compare`
 * freezes two layers onto one unified domain. Rejections (invented manual
 * breaks without a source, unknown layers, constant fields, non-numeric
 * fields, a second layer compared with itself) refuse loudly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { catalogRegister } from '../src/catalog-tools.ts'
import { mapAddLayer } from '../src/map-tools.ts'
import { vizAggregate, vizCreateStyle, vizClassify, vizCompare } from '../src/viz-tools.ts'
import { decodeVizStyleMeta, VIZ_META_KIND } from '../src/viz-meta.ts'
import { VIZ_METHOD_VERSION } from '../../spatial-viz/src/index.ts'

/** A scored grid with explicit gaps: some features miss the score, one misses the time. */
function scoredCollection() {
  const raw = [
    ['a1', 116.0, 39.0, 2, '2026-01-01T06:00:00Z'],
    ['a2', 116.01, 39.0, 4, '2026-01-01T12:00:00Z'],
    ['a3', 116.02, 39.0, 6, '2026-01-02T06:00:00Z'],
    ['b1', 116.0, 39.01, 9, '2026-01-02T12:00:00Z'],
    ['b2', 116.01, 39.01, 12, '2026-01-02T18:00:00Z'],
    ['b3', 116.02, 39.01, null, '2026-01-03T06:00:00Z'],
    ['c1', 116.0, 39.02, 20, '2026-01-03T12:00:00Z'],
    ['c2', 116.01, 39.02, 26, null],
  ]
  return {
    type: 'FeatureCollection',
    features: raw.map(([id, lon, lat, score, time]) => ({
      type: 'Feature',
      id,
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: { score, time, population: 100 },
    })),
  }
}

async function vizRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `map-viz-${label}-`))
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: join(dir, 'catalog') })
  const styleArgs = { field: 'score', unit: '分', classification: 'quantile', class_count: 3 }
  return {
    dir,
    rig,
    styleArgs,
    async register(name, collection, sessionId = 'viz') {
      const path = join(dir, `${name}.geojson`)
      writeFileSync(path, JSON.stringify(collection))
      const session = rig.session(sessionId)
      rig.call(session, `reg-${name}`, 'catalog_register', { path, name })
      return catalogRegister.execute({ path, name }, rig.exec(session, { callId: `reg-${name}` }))
    },
    async addLayer(layerId, resourceRef, session) {
      const call = rig.call(session, `add-${layerId}`, 'map_add_layer', { ref: resourceRef, layer_id: layerId })
      const result = await mapAddLayer.execute({ ref: resourceRef, layer_id: layerId }, rig.exec(session, { callId: `add-${layerId}` }))
      // Accept the result: the authoritative projection folds the layer.
      rig.result(session, call, { meta: result.meta })
      return result
    },
    async dispose() {
      await rig.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('viz_create_style computes real breaks from the frozen resource and publishes the style record', async () => {
  const env = await vizRig('create')
  try {
    const { resource } = await env.register('grid', scoredCollection())
    const session = env.rig.session('viz')
    const call = env.rig.call(session, 'vs-1', 'viz_create_style', { resource_ref: resource.ref, ...env.styleArgs })
    const result = await vizCreateStyle.execute(
      { resource_ref: resource.ref, ...env.styleArgs },
      env.rig.exec(session, { callId: 'vs-1' }),
    )
    // The breaks are real: seven finite scores 2..26 split at the distinct-value ranks.
    assert.deepEqual(result.breaks, [5, 10.5])
    assert.equal(result.style_version, `sty-${result.style_version.slice(4, 16)}@v1`)
    assert.equal(result.method_version, VIZ_METHOD_VERSION)
    assert.equal(result.series_identity, 'observed', 'the styling tool writes the series identity explicitly')
    assert.equal(result.missing_count, 1, 'the null score stays a named missing value')
    assert.equal(result.value_count, 7)
    assert.match(result.artifact_ref, /^art-/)
    assert.deepEqual(result.legend_rows.slice(0, 3), [
      { kind: 'class', from: 2, to: 5, to_inclusive: false },
      { kind: 'class', from: 5, to: 10.5, to_inclusive: false },
      { kind: 'class', from: 10.5, to: 26, to_inclusive: true },
    ])
    assert.equal(result.limitations.some(text => text.includes('not a statistical test')), true)

    const decoded = decodeVizStyleMeta(vizCreateStyle.output.presentationMeta({}, result))
    assert.equal(decoded.status, 'ok')
    assert.equal(decoded.meta.kind, VIZ_META_KIND)
    assert.equal(decoded.meta.styleVersion, result.style_version)
    assert.equal(decoded.meta.dataRef, resource.ref)
    assert.deepEqual(decoded.meta.breaks, [5, 10.5])
    // The model text strips the durable meta record.
    const rendered = vizCreateStyle.output.render({}, result)
    assert.equal(rendered[0].text.includes('"meta"'), false)
    assert.equal(typeof call.seq, 'number', 'the accepted call pairs the publication')
  } finally {
    await env.dispose()
  }
})

test('rates classify the ratio; manual breaks cite their statistic source and refuse without one', async () => {
  const env = await vizRig('rate')
  try {
    const { resource } = await env.register('grid', scoredCollection())
    const session = env.rig.session('viz')
    const args = { resource_ref: resource.ref, field: 'score', unit: '人/hm²', measure: 'rate', denominator_field: 'population', class_count: 2 }
    env.rig.call(session, 'vr-1', 'viz_create_style', args)
    const result = await vizCreateStyle.execute(args, env.rig.exec(session, { callId: 'vr-1' }))
    // Ratios are score/100: 0.02..0.26.
    assert.equal(result.measure, 'rate')
    assert.equal(result.denominator_field, 'population')
    assert.equal(result.domain.max, 0.26)

    const manual = { ...args, classification: 'manual', breaks: [0.1] }
    env.rig.call(session, 'vr-2', 'viz_create_style', manual)
    await assert.rejects(
      vizCreateStyle.execute(manual, env.rig.exec(session, { callId: 'vr-2' })),
      /breaks_source_ref/,
      'manual breaks without their statistic source are invented ranges and refuse loudly',
    )

    const sourced = { ...manual, breaks_source_ref: `${resource.ref}` }
    env.rig.call(session, 'vr-3', 'viz_create_style', sourced)
    const cited = await vizCreateStyle.execute(sourced, env.rig.exec(session, { callId: 'vr-3' }))
    assert.deepEqual(cited.breaks, [0.1])
    assert.equal(cited.breaks_source_ref, resource.ref)
    assert.equal(cited.classification, 'manual')

    const totalWithDenominator = { resource_ref: resource.ref, field: 'score', unit: 'x', measure: 'total', denominator_field: 'population' }
    env.rig.call(session, 'vr-4', 'viz_create_style', totalWithDenominator)
    await assert.rejects(
      vizCreateStyle.execute(totalWithDenominator, env.rig.exec(session, { callId: 'vr-4' })),
      /denominator-unexpected/,
    )
  } finally {
    await env.dispose()
  }
})

test('viz_classify styles a loaded layer from its own data and the set-style change folds', async () => {
  const env = await vizRig('classify')
  try {
    const registered = await env.register('grid', scoredCollection())
    const session = env.rig.session('viz')
    const added = await env.addLayer('zones', registered.resource.ref, session)
    assert.equal(added.layer.id, 'zones')

    const args = { layer_id: 'zones', ...env.styleArgs, time_field: 'time', timezone: 'UTC', granularity: 'day', time_from: '2026-01-01T00:00:00Z', time_to: '2026-01-04T00:00:00Z' }
    const call = env.rig.call(session, 'vc-1', 'viz_classify', args)
    const result = await vizClassify.execute(args, env.rig.exec(session, { callId: 'vc-1' }))
    assert.equal(result.layers[0].layer_id, 'zones')
    const style = result.layers[0]
    assert.deepEqual(style.breaks, [5, 10.5])
    assert.equal(style.style_version, result.meta.change.styles[0].style.styleVersion)

    // The change rides the versioned map-change meta: v3, paired, target revision 1.
    assert.equal(result.meta.kind, 'map-change')
    assert.equal(result.meta.schemaVersion, 4)
    assert.equal(result.meta.sourceCallSeq, call.seq)
    assert.equal(result.meta.targetRevision, 1)
    assert.equal(result.meta.change.op, 'set-style')
    assert.equal(result.meta.change.styles[0].layerId, 'zones')

    // Accept the result: the projection folds the style onto the layer.
    env.rig.result(session, call, { meta: result.meta })
    const state = env.rig.state(session)
    assert.equal(state.revision, 2)
    const folded = state.layers.find(layer => layer.id === 'zones')
    assert.equal(folded.style.styleVersion, style.style_version)
    assert.deepEqual(folded.style.breaks, [5, 10.5])
    assert.equal(folded.style.timeBinding.timezone, 'UTC')
    // Layer, legend, and folded style share one version.
    assert.equal(style.style_version, folded.style.styleVersion)
  } finally {
    await env.dispose()
  }
})

test('viz_classify refuses unknown layers, constant fields, and missing time bindings loudly', async () => {
  const env = await vizRig('classify-bad')
  try {
    const registered = await env.register('grid', scoredCollection())
    const session = env.rig.session('viz')
    await env.addLayer('zones', registered.resource.ref, session)

    const ghost = { layer_id: 'ghost', ...env.styleArgs }
    env.rig.call(session, 'vc-g', 'viz_classify', ghost)
    await assert.rejects(
      vizClassify.execute(ghost, env.rig.exec(session, { callId: 'vc-g' })),
      /unknown layer ghost/,
    )

    const constant = { layer_id: 'zones', field: 'population', unit: '人', class_count: 3 }
    env.rig.call(session, 'vc-c', 'viz_classify', constant)
    await assert.rejects(
      vizClassify.execute(constant, env.rig.exec(session, { callId: 'vc-c' })),
      /constant field carries no classification/,
    )

    const timeless = { layer_id: 'zones', ...env.styleArgs, time_field: 'no_such_field', timezone: 'UTC', granularity: 'day', time_from: '2026-01-01T00:00:00Z', time_to: '2026-01-04T00:00:00Z' }
    env.rig.call(session, 'vc-t', 'viz_classify', timeless)
    await assert.rejects(
      vizClassify.execute(timeless, env.rig.exec(session, { callId: 'vc-t' })),
      /carries no parsable timestamps/,
    )
    // Nothing folded: the map is unchanged.
    assert.equal(env.rig.state(session).revision, 1)
  } finally {
    await env.dispose()
  }
})

test('viz_compare freezes two layers onto one shared classification domain', async () => {
  const env = await vizRig('compare')
  try {
    const registeredLeft = await env.register('left', scoredCollection(), 'viz')
    const registeredRight = await env.register('right', scoredCollection(), 'viz')
    const session = env.rig.session('viz')
    await env.addLayer('zones-a', registeredLeft.resource.ref, session)
    await env.addLayer('zones-b', registeredRight.resource.ref, session)
    const args = { layer_a: 'zones-a', layer_b: 'zones-b', ...env.styleArgs }
    const call = env.rig.call(session, 'vd-1', 'viz_compare', args)
    const result = await vizCompare.execute(args, env.rig.exec(session, { callId: 'vd-1' }))
    assert.equal(result.layers.length, 2)
    const [left, right] = result.layers
    assert.deepEqual(left.breaks, right.breaks, 'both layers share the unified breaks')
    assert.deepEqual(left.domain, right.domain)
    assert.equal(left.unified_domain, true)
    assert.equal(right.unified_domain, true)
    // Identical value sets classified on the shared domain carry identical styles,
    // so both layers wear the same version — determinism, not a collision.
    assert.equal(result.meta.change.op, 'set-style')
    assert.deepEqual(result.meta.change.styles.map(entry => entry.layerId), ['zones-a', 'zones-b'])

    env.rig.result(session, call, { meta: result.meta })
    const state = env.rig.state(session)
    const foldedA = state.layers.find(layer => layer.id === 'zones-a')
    const foldedB = state.layers.find(layer => layer.id === 'zones-b')
    assert.deepEqual(foldedA.style.breaks, foldedB.style.breaks)
    assert.equal(foldedA.style.unifiedDomain, true)

    const same = { ...args, layer_b: 'zones-a' }
    env.rig.call(session, 'vd-2', 'viz_compare', same)
    await assert.rejects(
      vizCompare.execute(same, env.rig.exec(session, { callId: 'vd-2' })),
      /must be different layers/,
    )
  } finally {
    await env.dispose()
  }
})

test('viz_aggregate adds a bounded grid layer that declares its display-aggregate identity', async () => {
  const env = await vizRig('aggregate')
  try {
    // A spread fixture: 0.2° spacing over a 0.05° grid gives nine cells with
    // distinct per-cell sums, so the honest classification has something to say.
    const spread = scoredCollection()
    spread.features = spread.features.map((feature, index) => ({
      ...feature,
      geometry: { type: 'Point', coordinates: [116 + (index % 3) * 0.2, 39 + Math.floor(index / 3) * 0.2] },
    }))
    const { resource } = await env.register('grid', spread)
    const session = env.rig.session('viz')
    await env.addLayer('ref-layer', resource.ref, session)
    const args = { resource_ref: resource.ref, layer_id: 'grid-agg', cell_size: 0.05, measure: 'sum', value_field: 'score', unit: '人' }
    const call = env.rig.call(session, 'va-1', 'viz_aggregate', args)
    const result = await vizAggregate.execute(args, env.rig.exec(session, { callId: 'va-1' }))
    assert.equal(result.identity, 'display-aggregate')
    assert.equal(result.source_ref, resource.ref)
    assert.match(result.artifact_ref, /^art-/)
    assert.equal(result.measure, 'sum')
    // 116.0/116.01/116.02 share one 0.05° column; 39.0/39.01/39.02 three rows.
    assert.equal(result.cell_count, 8, 'eight features land in eight distinct 0.05-degree cells')
    assert.equal(result.matched, 8)
    assert.equal(result.skipped, 0)

    // The add-layer change folds: the aggregate layer carries the same
    // honest classification machinery (quantile breaks over cell sums).
    env.rig.result(session, call, { meta: result.meta })
    await new Promise(resolve => setImmediate(resolve))
    const state = env.rig.state(session)
    const folded = state.layers.find(layer => layer.id === 'grid-agg')
    assert.ok(folded, 'the aggregate layer folds into the map')
    assert.equal(folded.style.field, 'sum')
    assert.ok(Array.isArray(folded.style.breaks))
    assert.equal(folded.data.features.length, result.cell_count)
    assert.equal(folded.data.features[0].geometry.type, 'Polygon')

    // Cell-count refusal: a 0.0001° grid over this spread exceeds the cap.
    const coarse = { ...args, layer_id: 'grid-agg-2', cell_size: 0.0001, max_cells: 4 }
    env.rig.call(session, 'va-2', 'viz_aggregate', coarse)
    await assert.rejects(
      vizAggregate.execute(coarse, env.rig.exec(session, { callId: 'va-2' })),
      /spans more than/,
    )

    // Sum without a field refuses loud.
    const missing = { ...args, layer_id: 'grid-agg-3', measure: 'sum' }
    delete missing.value_field
    env.rig.call(session, 'va-3', 'viz_aggregate', missing)
    await assert.rejects(
      vizAggregate.execute(missing, env.rig.exec(session, { callId: 'va-3' })),
      /value_field/,
    )
  } finally {
    await env.dispose()
  }
})
