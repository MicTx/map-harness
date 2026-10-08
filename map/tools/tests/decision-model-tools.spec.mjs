/**
 * P3 decision-model tool integration fixtures over the REAL catalog service
 * and projection plus the real spatial-decision package: register a resource
 * → the accepted `tool/call` pairing → attribution/forecast/scenario tools
 * with numeric answers carried through to model content; the honest claim
 * levels and not_applicable/unknown statuses; the artifact publication and
 * the fit→predict artifact round trip; the durable `spatial-decision` meta
 * decoding through the same codec the projection consumes; and the loud
 * refusals (invalid specs, missing publish pairing).
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
  attributionAssociation,
  attributionExplain,
  attributionEffect,
  forecastValidate,
  forecastFit,
  forecastPredict,
  scenarioCompare,
  locationAllocate,
} from '../src/decision-model-tools.ts'
import { decodeSpatialDecisionMeta, DECISION_MODEL_META_KIND } from '../src/decision-meta.ts'
import { DECISION_METHOD_VERSION } from '../../spatial-decision/src/contract.ts'

/** An association/explanation table: outcome = 2·transit exactly, income a second cycling field. */
function analysisCollection() {
  const features = []
  for (let index = 0; index < 16; index++) {
    features.push({
      type: 'Feature',
      id: `r${index}`,
      geometry: { type: 'Point', coordinates: [116 + index * 0.01, 39] },
      properties: { outcome: 2 * index, transit: index, income: index % 3 },
    })
  }
  return { type: 'FeatureCollection', features }
}

/** A balanced effect table: outcome = 10 + 5·treated + 3·income with income identically distributed across groups. */
function effectCollection() {
  const features = []
  for (let index = 0; index < 16; index++) {
    const treated = index % 2 === 0
    const income = Math.floor(index / 2) % 2
    features.push({
      type: 'Feature',
      id: `r${index}`,
      geometry: { type: 'Point', coordinates: [116 + index * 0.01, 39] },
      properties: { outcome: 10 + 5 * (treated ? 1 : 0) + 3 * income, income, policy: treated },
    })
  }
  return { type: 'FeatureCollection', features }
}

/** A panel table: 8 districts × pre/post, treated districts move +10, controls +2. */
function panelCollection() {
  const features = []
  for (let unit = 0; unit < 8; unit++) {
    const treated = unit % 2 === 0
    for (const period of ['pre', 'post']) {
      features.push({
        type: 'Feature',
        id: `d${unit}-${period}`,
        geometry: { type: 'Point', coordinates: [116 + unit * 0.01, 39] },
        properties: {
          y: 100 + unit + (period === 'post' ? (treated ? 10 : 2) : 0),
          policy: treated,
          period,
          district: `d${unit}`,
          income: unit % 3,
        },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** A daily history: outcome = 10 + 2·day with a pulse feature, 30 days, two units. */
function historyCollection() {
  const features = []
  for (let day = 0; day < 30; day++) {
    for (const unit of ['u0', 'u1']) {
      features.push({
        type: 'Feature',
        id: `${unit}-${day}`,
        geometry: { type: 'Point', coordinates: [116 + (unit === 'u1' ? 0.01 : 0), 39] },
        properties: { demand: 10 + 2 * day, pulse: day % 2, ts: `2026-01-${String(day + 1).padStart(2, '0')}T00:00:00Z` },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

/** Demand points in two groups near two sites. */
function demandCollection() {
  const point = (id, lon, demand, group) => ({
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [lon, 39] },
    properties: { demand, group },
  })
  return {
    type: 'FeatureCollection',
    features: [
      point('d1', 116.0, 10, 'g1'),
      point('d2', 116.005, 10, 'g1'),
      point('d3', 116.04, 10, 'g2'),
      point('d4', 116.045, 10, 'g2'),
    ],
  }
}

async function decisionRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `map-decision-${label}-`))
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: join(dir, 'catalog') })
  return {
    dir,
    rig,
    async register(name, collection, sessionId = 'decision') {
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

test('attribution tools report associations and contributions with non-causal claim levels and durable meta', async () => {
  const rig = await decisionRig('attribution')
  try {
    const { resource } = await rig.register('units', analysisCollection())
    const session = rig.rig.session('decision')

    rig.rig.call(session, 'aa-1', 'attribution_association', { goal_revision: 1, resource_ref: resource.ref, outcome_field: 'outcome', factor_fields: ['transit', 'income'] })
    const association = await attributionAssociation.execute(
      { goal_revision: 1, resource_ref: resource.ref, outcome_field: 'outcome', factor_fields: ['transit', 'income'] },
      rig.rig.exec(session, { callId: 'aa-1' }),
    )
    assert.equal(association.status, 'succeeded')
    assert.equal(association.claim_level, 'association', 'association never upgrades its label')
    const transit = association.factors.find(factor => factor.field === 'transit')
    assert.ok(Math.abs((transit?.pearson ?? 0) - 1) < 1e-12, 'the exact trend correlates at 1 (got ' + String(transit?.pearson) + ')')
    assert.ok(association.artifact_refs[0].startsWith('art-'))
    const associationMeta = decodeSpatialDecisionMeta(attributionAssociation.output.presentationMeta({}, association))
    assert.equal(associationMeta.status, 'ok')
    assert.equal(associationMeta.meta.kind, DECISION_MODEL_META_KIND)
    assert.equal(associationMeta.meta.tool, 'attribution_association')
    assert.equal(associationMeta.meta.claimLevel, 'association')
    assert.equal(associationMeta.meta.methodVersion, DECISION_METHOD_VERSION)
    assert.equal(associationMeta.meta.headline.metric, 'max_abs_pearson')
    assert.equal(associationMeta.meta.resourceRef, resource.ref)
    assert.ok(associationMeta.meta.specDigest.length === 64)
    const rendered = attributionAssociation.output.render({}, association)
    assert.equal(rendered[0].text.includes('"meta"'), false, 'durable meta stays out of model content')

    rig.rig.call(session, 'ax-1', 'attribution_explain', { goal_revision: 1, resource_ref: resource.ref, outcome_field: 'outcome', factor_fields: ['transit', 'income'] })
    const explain = await attributionExplain.execute(
      { goal_revision: 1, resource_ref: resource.ref, outcome_field: 'outcome', factor_fields: ['transit', 'income'] },
      rig.rig.exec(session, { callId: 'ax-1' }),
    )
    assert.equal(explain.claim_level, 'model-explanation', 'explanation never upgrades its label')
    assert.ok(explain.r_squared > 0.99)
    const explainMeta = decodeSpatialDecisionMeta(attributionExplain.output.presentationMeta({}, explain))
    assert.equal(explainMeta.meta.claimLevel, 'model-explanation')
    assert.equal(explainMeta.meta.headline.metric, 'r_squared')
  } finally {
    await rig.dispose()
  }
})

test('attribution_effect reaches causal only with a passing design and downgrades honestly otherwise', async () => {
  const rig = await decisionRig('effect')
  try {
    const { resource } = await rig.register('effect-units', effectCollection())
    const session = rig.rig.session('decision')
    const base = { goal_revision: 1, resource_ref: resource.ref, outcome_field: 'outcome', factor_fields: ['income'], treatment_field: 'policy', treated_value: true }

    // No declared design: the same estimate reports at the association level.
    rig.rig.call(session, 'ae-plain', 'attribution_effect', base)
    const plain = await attributionEffect.execute(base, rig.rig.exec(session, { callId: 'ae-plain' }))
    assert.equal(plain.claim_level, 'association')
    assert.deepEqual(plain.downgrade_reasons, ['no-identification-design', 'interference-not-assessed'])
    assert.ok(typeof plain.interval.estimate === 'number')

    // Declared design with a wide interference band: diagnostics pass → causal.
    // Band 500 m: rows sit ~0.9 km apart, so no control row has any treated neighbor.
    const designed = { ...base, design: 'covariate-adjustment', interference_band_meters: 500 }
    rig.rig.call(session, 'ae-1', 'attribution_effect', designed)
    const causal = await attributionEffect.execute(designed, rig.rig.exec(session, { callId: 'ae-1' }))
    assert.equal(causal.claim_level, 'causal', JSON.stringify(causal.downgrade_reasons))
    assert.ok(Math.abs(causal.interval.estimate - 5) < 1e-6, `effect 5 (got ${causal.interval.estimate})`)
    assert.ok(causal.assumptions.length >= 3, 'the causal level states its assumptions')

    // The unmeasured-confounding limitation is always present, even at causal.
    assert.ok(causal.limitations.some(line => line.includes('unmeasured confounding')))

    // The DiD panel recovers the hand-computed delta 8 through the tool.
    const { resource: panelResource } = await rig.register('panel', panelCollection(), 'decision')
    const did = {
      goal_revision: 1, resource_ref: panelResource.ref, outcome_field: 'y', factor_fields: ['income'],
      treatment_field: 'policy', treated_value: true, design: 'difference-in-differences',
      period_field: 'period', pre_value: 'pre', post_value: 'post', unit_field: 'district',
      interference_band_meters: 1000,
    }
    rig.rig.call(session, 'ae-did', 'attribution_effect', did)
    const didResult = await attributionEffect.execute(did, rig.rig.exec(session, { callId: 'ae-did' }))
    assert.equal(didResult.design, 'difference-in-differences')
    assert.ok(Math.abs(didResult.interval.estimate - 8) < 1e-9, `DiD 8 (got ${didResult.interval.estimate})`)
    assert.equal(didResult.did.units_used, 8)

    // All-treated tables are honest unknowns.
    const uniformCollection = {
      type: 'FeatureCollection',
      features: effectCollection().features.map(feature => ({ ...feature, properties: { ...feature.properties, policy: true } })),
    }
    const { resource: uniform } = await rig.register('uniform', uniformCollection, 'decision')
    const uniformArgs = { ...base, resource_ref: uniform.ref, design: 'covariate-adjustment', interference_band_meters: 1000 }
    rig.rig.call(session, 'ae-uniform', 'attribution_effect', uniformArgs)
    const unknown = await attributionEffect.execute(uniformArgs, rig.rig.exec(session, { callId: 'ae-uniform' }))
    assert.equal(unknown.status, 'not_applicable')
    assert.equal(unknown.not_applicable_reason, 'no-treatment-variation')
    assert.equal(unknown.claim_level, 'unknown')
  } finally {
    await rig.dispose()
  }
})

test('forecast fit → predict round-trips the model artifact; validation beats the naive baseline', async () => {
  const rig = await decisionRig('forecast')
  try {
    const { resource } = await rig.register('history', historyCollection())
    const session = rig.rig.session('decision')
    const validateArgs = {
      goal_revision: 1, resource_ref: resource.ref, outcome_field: 'demand', time_field: 'ts',
      features: [{ field: 'pulse', availability: 'known-at-origin' }],
      training_from: '2026-01-01T00:00:00Z', training_to: '2026-01-26T00:00:00Z',
      block_meters: 100_000, holdout_steps: 4,
    }
    rig.rig.call(session, 'fv-1', 'forecast_validate', validateArgs)
    const validation = await forecastValidate.execute(validateArgs, rig.rig.exec(session, { callId: 'fv-1' }))
    assert.equal(validation.status, 'succeeded')
    assert.ok(validation.model.mae < 1e-9, 'the exact trend validates with zero error')
    assert.ok(validation.baseline.mae > 1, `naive baseline misses (got ${validation.baseline.mae})`)
    assert.ok(Math.abs(validation.skill - 1) < 1e-9)

    const fitArgs = {
      goal_revision: 1, resource_ref: resource.ref, outcome_field: 'demand', time_field: 'ts',
      features: [{ field: 'pulse', availability: 'known-at-origin' }],
      training_from: '2026-01-01T00:00:00Z', training_to: '2026-01-31T00:00:00Z',
      block_meters: 100_000,
    }
    rig.rig.call(session, 'ff-1', 'forecast_fit', fitArgs)
    const fit = await forecastFit.execute(fitArgs, rig.rig.exec(session, { callId: 'ff-1' }))
    assert.equal(fit.status, 'succeeded')
    const modelRef = fit.model_ref
    assert.ok(modelRef && modelRef.startsWith('art-'), 'the fitted model publishes as an artifact')

    const nonlinearFitArgs = { ...fitArgs, model_family: 'quadratic-ridge' }
    rig.rig.call(session, 'ff-q', 'forecast_fit', nonlinearFitArgs)
    const nonlinearFit = await forecastFit.execute(nonlinearFitArgs, rig.rig.exec(session, { callId: 'ff-q' }))
    assert.equal(nonlinearFit.status, 'succeeded')
    assert.equal(nonlinearFit.model_family, 'quadratic-ridge')

    // A prediction-origin table missing the model's feature fails loud (every row dropped).
    const bareCollection = {
      type: 'FeatureCollection',
      features: ['bare'].map(id => ({
        type: 'Feature',
        id,
        geometry: { type: 'Point', coordinates: [116, 39] },
        properties: {},
      })),
    }
    const { resource: bare } = await rig.register('bare-origin', bareCollection, 'decision')
    const withoutFeature = { goal_revision: 1, model_ref: modelRef, resource_ref: bare.ref }
    rig.rig.call(session, 'fp-1', 'forecast_predict', withoutFeature)
    await assert.rejects(
      () => forecastPredict.execute(withoutFeature, rig.rig.exec(session, { callId: 'fp-1' })),
      (error) => error instanceof Error && error.message.includes('DECISION_STATE'),
      'a prediction table without the model features fails loud',
    )

    const futureCollection = {
      type: 'FeatureCollection',
      features: ['a', 'b'].map((id, index) => ({
        type: 'Feature',
        id,
        geometry: { type: 'Point', coordinates: [116 + index * 0.01, 39] },
        properties: { pulse: index },
      })),
    }
    const { resource: origin } = await rig.register('origin', futureCollection, 'decision')
    const withRows = { goal_revision: 1, model_ref: modelRef, resource_ref: origin.ref, horizon_steps: 3 }
    rig.rig.call(session, 'fp-2', 'forecast_predict', withRows)
    const prediction = await forecastPredict.execute(withRows, rig.rig.exec(session, { callId: 'fp-2' }))
    assert.equal(prediction.status, 'succeeded')
    assert.equal(prediction.row_count, 2)
    const first = prediction.rows[0]
    // Cutoff Jan 31 admits days 0–29; +3 bins → day 32: 10 + 64 + ~0·pulse = 74.
    assert.ok(Math.abs(first.predicted - 74) < 1e-6, `analytic continuation (got ${first.predicted})`)
    // Rows a/b were never observed: the naive baseline falls back to the training mean 39.
    assert.ok(Math.abs(first.baseline - 39) < 1e-9, `baseline falls back to the training mean (got ${first.baseline})`)
    const meta = decodeSpatialDecisionMeta(forecastPredict.output.presentationMeta({}, prediction))
    assert.equal(meta.meta.tool, 'forecast_predict')
    assert.ok(meta.meta.artifactRefs.length >= 1)
  } finally {
    await rig.dispose()
  }
})

test('scenario_compare keeps infeasible candidates named; allocation reports the honest partial state', async () => {
  const rig = await decisionRig('scenario')
  try {
    const session = rig.rig.session('decision')
    const compareArgs = {
      goal_revision: 1,
      groups: [{ id: 'north', demand: 100 }, { id: 'south', demand: 100 }],
      candidates: [
        { id: 'X', cost: 50, served: [{ group: 'north', amount: 100 }] },
        { id: 'Y', cost: 50, served: [{ group: 'north', amount: 50 }, { group: 'south', amount: 50 }] },
        { id: 'Z', cost: 200, served: [{ group: 'north', amount: 100 }, { group: 'south', amount: 100 }] },
      ],
      budget: 100,
    }
    rig.rig.call(session, 'sc-1', 'scenario_compare', compareArgs)
    const comparison = await scenarioCompare.execute(compareArgs, rig.rig.exec(session, { callId: 'sc-1' }))
    assert.equal(comparison.status, 'succeeded')
    assert.equal(comparison.default_scenario, true, 'absent weights select the flagged default scenario')
    assert.equal(comparison.top_id, 'Y')
    const z = comparison.rows.find(row => row.id === 'Z')
    assert.deepEqual(z.infeasible_reasons, ['over-budget'])
    assert.equal(z.rank, null)
    const compareMeta = decodeSpatialDecisionMeta(scenarioCompare.output.presentationMeta({}, comparison))
    assert.equal(compareMeta.meta.resourceRef, null, 'the inline scenario carries no resource ref')

    const { resource } = await rig.register('demand', demandCollection())
    const allocateArgs = {
      goal_revision: 1, resource_ref: resource.ref, demand_field: 'demand', group_field: 'group',
      sites: [
        { id: 's1', lon: 116.0, lat: 39.0, capacity: 15, cost: 5 },
        { id: 's2', lon: 116.04, lat: 39.0, capacity: 15, cost: 5 },
      ],
      coverage_radius_meters: 2000, budget: 20,
    }
    rig.rig.call(session, 'la-1', 'location_allocate', allocateArgs)
    const allocation = await locationAllocate.execute(allocateArgs, rig.rig.exec(session, { callId: 'la-1' }))
    assert.equal(allocation.status, 'partial', 'capacity shortfall keeps the honest partial status')
    assert.equal(allocation.capacity_shortfall, 10)
    assert.equal(allocation.uncovered_rows, 2)
    assert.equal(allocation.covered_demand, 30)
    const allocationMeta = decodeSpatialDecisionMeta(locationAllocate.output.presentationMeta({}, allocation))
    assert.equal(allocationMeta.meta.status, 'partial')
    assert.equal(allocationMeta.meta.headline.metric, 'covered_share')
    assert.ok(allocationMeta.meta.limitations.some(line => line.includes('no global-optimality guarantee')))

    const globalArgs = { ...allocateArgs, mode: 'global' }
    rig.rig.call(session, 'la-global', 'location_allocate', globalArgs)
    const globalAllocation = await locationAllocate.execute(globalArgs, rig.rig.exec(session, { callId: 'la-global' }))
    assert.equal(globalAllocation.mode, 'global')
    assert.equal(globalAllocation.enumeration.domain, 'declared-affordable-sites')
    assert.equal(globalAllocation.enumeration.totalSubsets, 4)
    assert.equal(globalAllocation.opened_site_ids.length, 2)
  } finally {
    await rig.dispose()
  }
})

test('invalid specs and missing publish pairing fail loud with stable codes', async () => {
  const rig = await decisionRig('refusals')
  try {
    const { resource } = await rig.register('units', analysisCollection())
    const session = rig.rig.session('decision')

    // A structurally invalid spec lists every issue.
    const bad = { goal_revision: 1, resource_ref: resource.ref, outcome_field: 'outcome', factor_fields: 'transit' }
    rig.rig.call(session, 'bad-1', 'attribution_association', bad)
    await assert.rejects(
      () => attributionAssociation.execute(bad, rig.rig.exec(session, { callId: 'bad-1' })),
      (error) => error instanceof Error && error.message.includes('factor_fields'),
    )

    // A concurrent feature in forecast_validate is a leakage refusal with the stable code.
    const concurrent = {
      goal_revision: 1, resource_ref: resource.ref, outcome_field: 'outcome', time_field: 'ts',
      features: [{ field: 'income', availability: 'concurrent' }],
      training_from: '2026-01-01T00:00:00Z', training_to: '2026-01-26T00:00:00Z', block_meters: 1000,
    }
    rig.rig.call(session, 'bad-2', 'forecast_validate', concurrent)
    await assert.rejects(
      () => forecastValidate.execute(concurrent, rig.rig.exec(session, { callId: 'bad-2' })),
      (error) => error instanceof Error && error.message.includes('DECISION_INVALID_INPUT'),
    )

    // Without the accepted publish pairing (no prior tool/call), a decision tool refuses to publish.
    const unpaired = { goal_revision: 1, resource_ref: resource.ref, outcome_field: 'outcome', factor_fields: ['transit'] }
    await assert.rejects(
      () => attributionAssociation.execute(unpaired, rig.rig.exec(session, { callId: 'unlogged-call' })),
      (error) => error instanceof Error && error.message.includes('accepted tool/call'),
    )
  } finally {
    await rig.dispose()
  }
})
