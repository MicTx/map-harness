/**
 * P1 run-tool integration fixtures over the REAL accessibility service and
 * projection plus the real catalog: register → run_submit (durable identity,
 * estimate, pairing) → run_get to a terminal state → run_cancel → the
 * retryOf refusal path. Meta decodes through the same codec the projection
 * consumes; every handler runs against the rig the other specs use.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import * as spatialAccessibilityPlugin from '../../spatial-accessibility/src/plugin.ts'
import { catalogRegister } from '../src/catalog-tools.ts'
import { runSubmit, runGet, runCancel } from '../src/run-tools.ts'
import { decodeAccessibilityRunMeta } from '../src/run-meta.ts'
import { AccessibilityError } from '../../spatial-accessibility/src/index.ts'

/** Three population units on a small walk grid, one far outside the budget. */
const POPULATION = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'u1', geometry: { type: 'Point', coordinates: [116.0, 39.5] }, properties: { population: 100, community: 'A' } },
    { type: 'Feature', id: 'u2', geometry: { type: 'Point', coordinates: [116.005, 39.5] }, properties: { population: 50, community: 'A' } },
    { type: 'Feature', id: 'u3', geometry: { type: 'Point', coordinates: [116.02, 39.5] }, properties: { population: 200, community: 'B' } },
  ],
}

/** One facility with its entrance right on the network. */
const FACILITIES = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'fac-1', geometry: { type: 'Point', coordinates: [116.0, 39.5] }, properties: { capacity: 1000 } },
  ],
}

/** Mount the full rig: map projection + catalog + accessibility run store. */
async function runRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `map-run-${label}-`))
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: join(dir, 'catalog') })
  await rig.ctx.plugin(spatialAccessibilityPlugin, { root: join(dir, 'runs') })
  return {
    dir,
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

/** Register the fixture resources and return their refs. */
async function registerFixtures(rig, sessionId = 'run') {
  const session = rig.rig.session(sessionId)
  const populationPath = rig.write('population.geojson', POPULATION)
  rig.rig.call(session, 'c-pop', 'catalog_register', { path: populationPath, name: 'population' })
  const population = await catalogRegister.execute({ path: populationPath, name: 'population' }, rig.rig.exec(session, { callId: 'c-pop' }))
  const facilitiesPath = rig.write('facilities.geojson', FACILITIES)
  rig.rig.call(session, 'c-fac', 'catalog_register', { path: facilitiesPath, name: 'facilities' })
  const facilities = await catalogRegister.execute({ path: facilitiesPath, name: 'facilities' }, rig.rig.exec(session, { callId: 'c-fac' }))
  return { session, populationRef: population.resource.ref, facilityRef: facilities.resource.ref }
}

/** The run_submit arguments for the fixture grid. */
function submitArgs(registrations) {
  return {
    goal_revision: 1,
    population_ref: registrations.populationRef,
    population_field: 'population',
    facility_refs: [registrations.facilityRef],
    travel_mode: 'walk',
    max_minutes: 10,
    time_slices: ['midday'],
    study_area: [115.98, 39.48, 116.03, 39.52],
    retrieval_extent: [115.97, 39.47, 116.04, 39.53],
    support_extent: [115.96, 39.46, 116.05, 39.54],
    observation_from: '2026-06-01T00:00:00Z',
    observation_to: '2026-06-30T00:00:00Z',
    entrances: [{ facility: 'fac-1', lon: 116.0, lat: 39.5 }],
    capacities: { 'fac-1': 1000 },
  }
}

test('run_submit resolves the exact versions, submits durably, and run_get settles the real numbers', async () => {
  const rig = await runRig('submit-get')
  try {
    const session = rig.rig.session('run')
    const registrations = await registerFixtures(rig, 'run')
    rig.rig.call(session, 'r-1', 'run_submit', submitArgs(registrations))
    const submitted = await runSubmit.execute(submitArgs(registrations), rig.rig.exec(session, { callId: 'r-1' }))
    assert.equal(submitted.status, 'submitted')
    assert.match(submitted.run_id, /^run-[0-9a-f-]+$/)
    assert.match(submitted.operation_ref, /^op-[0-9a-f]{24}$/)
    assert.equal(submitted.request_digest.length, 64)
    assert.ok(submitted.estimate.latticeNodesUpperBound > 0)
    // The durable meta decodes and names the run identity.
    const meta = decodeAccessibilityRunMeta(runSubmit.output.presentationMeta({}, submitted))
    assert.equal(meta.status, 'ok')
    assert.equal(meta.meta.kind, 'accessibility-run')
    assert.equal(meta.meta.tool, 'run_submit')
    assert.equal(meta.meta.runId, submitted.run_id)

    // The model text strips the meta.
    const rendered = runSubmit.output.render({}, submitted)
    assert.equal(rendered[0].text.includes('accessibility-run'), false)

    // Poll to the terminal state through the real store.
    const exec = rig.rig.exec(session, { callId: 'r-2' })
    let record = null
    for (let attempt = 0; attempt < 200; attempt++) {
      rig.rig.call(session, `r-get-${attempt}`, 'run_get', { run_id: submitted.run_id })
      record = await runGet.execute({ run_id: submitted.run_id }, exec)
      if (['succeeded', 'partial', 'failed', 'cancelled'].includes(record.status)) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(record.status, 'succeeded')
    assert.equal(record.metrics.populationDenominator, 350)
    assert.equal(record.metrics.coveredPopulation, 150, 'the two near units are within the 10-minute walk shed')
    assert.equal(record.metrics.outcome, 'complete')
    const getMeta = decodeAccessibilityRunMeta(runGet.output.presentationMeta({}, record))
    assert.equal(getMeta.meta.tool, 'run_get')
    assert.equal(getMeta.meta.metrics.coveredPopulation, 150)
  } finally {
    await rig.dispose()
  }
})

test('retry_of returns the original submission; an unpublished retry is refused loudly', async () => {
  const rig = await runRig('retry')
  try {
    const session = rig.rig.session('run')
    const registrations = await registerFixtures(rig, 'run')
    const originalCall = rig.rig.call(session, 'r-1', 'run_submit', submitArgs(registrations))
    const submitted = await runSubmit.execute(submitArgs(registrations), rig.rig.exec(session, { callId: 'r-1' }))

    await assert.rejects(
      () => runSubmit.execute({ ...submitArgs(registrations), retry_of: 9999 }, rig.rig.exec(session, { callId: 'r-9' })),
      (error) => error instanceof Error && error.message.includes('OPERATION_NOT_PUBLISHED'),
      'a retry without a submitted original is refused, never resubmitted',
    )

    // The original call's seq comes from the accepted tool/call: the same
    // arguments retried through the original identity return the run.
    rig.rig.call(session, 'r-10', 'run_submit', { ...submitArgs(registrations), retry_of: originalCall.seq })
    const retried = await runSubmit.execute({ ...submitArgs(registrations), retry_of: originalCall.seq }, rig.rig.exec(session, { callId: 'r-10' }))
    assert.equal(retried.deduplicated, true)
    assert.equal(retried.run_id, submitted.run_id)
  } finally {
    await rig.dispose()
  }
})

test('invalid extents fail loud at the boundary and a cancel request is accepted', async () => {
  const rig = await runRig('invalid-cancel')
  try {
    const session = rig.rig.session('run2')
    const registrations = await registerFixtures(rig, 'run2')
    const bad = submitArgs(registrations)
    bad.support_extent = [115.9, 39.4, 115.95, 39.45]
    rig.rig.call(session, 'r-bad', 'run_submit', bad)
    await assert.rejects(
      () => runSubmit.execute(bad, rig.rig.exec(session, { callId: 'r-bad' })),
      (error) => error instanceof AccessibilityError && error.code === 'ACCESS_INVALID_INPUT' && error.message.includes('extent-nesting'),
    )

    rig.rig.call(session, 'r-1', 'run_submit', submitArgs(registrations))
    const submitted = await runSubmit.execute(submitArgs(registrations), rig.rig.exec(session, { callId: 'r-1' }))
    rig.rig.call(session, 'r-cancel', 'run_cancel', { run_id: submitted.run_id })
    const cancelled = await runCancel.execute({ run_id: submitted.run_id }, rig.rig.exec(session, { callId: 'r-cancel' }))
    assert.ok(['succeeded', 'cancelled', 'cancelRequested'].includes(cancelled.status), `the cancel returns the service adjudication (got ${cancelled.status})`)
    rig.rig.call(session, 'r-cancel-2', 'run_cancel', { run_id: 'run-missing' })
    await assert.rejects(
      () => runCancel.execute({ run_id: 'run-missing' }, rig.rig.exec(session, { callId: 'r-cancel-2' })),
      (error) => error instanceof AccessibilityError && error.code === 'ACCESS_NOT_FOUND',
    )
  } finally {
    await rig.dispose()
  }
})

/**
 * Session session-36e92064 sent every json argument as a JSON string. The
 * fixture keeps that encoding and uses the local grid's refs so the submit
 * can actually resolve.
 * @param {ReturnType<typeof submitArgs>} parsed - the already-parsed arguments.
 * @returns {Record<string, unknown>}
 */
function stringEncodedArgs(parsed) {
  const encoded = { ...parsed }
  for (const name of ['facility_refs', 'time_slices', 'study_area', 'retrieval_extent', 'support_extent', 'entrances', 'capacities']) {
    encoded[name] = JSON.stringify(parsed[name])
  }
  return encoded
}

test('run_submit accepts the session-36e92064 string encoding of every json argument', async () => {
  const rig = await runRig('string-submit')
  try {
    const session = rig.rig.session('run-string')
    const registrations = await registerFixtures(rig, 'run-string')
    const parsed = submitArgs(registrations)
    const encoded = stringEncodedArgs(parsed)
    assert.equal(typeof encoded.facility_refs, 'string', 'the fixture must reproduce the string encoding')
    rig.rig.call(session, 'r-string', 'run_submit', encoded)
    const submitted = await runSubmit.execute(encoded, rig.rig.exec(session, { callId: 'r-string' }))
    assert.equal(submitted.status, 'submitted')
    assert.match(submitted.run_id, /^run-/)

    const withComparison = {
      ...encoded,
      candidates: JSON.stringify([{
        id: 'opt-a',
        label: 'near',
        facilities: [{ id: 'extra', lon: 116.001, lat: 39.5, capacity: 100 }],
        cost: 10,
      }]),
      weights: JSON.stringify({ coverage: 1, equity: 0, cost: 0 }),
    }
    rig.rig.call(session, 'r-string-compare', 'run_submit', withComparison)
    const compared = await runSubmit.execute(withComparison, rig.rig.exec(session, { callId: 'r-string-compare' }))
    assert.equal(compared.status, 'submitted', 'string-encoded candidates and weights submit')
  } finally {
    await rig.dispose()
  }
})

test('run_submit names the parameter when a json argument string is not JSON', async () => {
  const rig = await runRig('malformed-submit')
  try {
    const session = rig.rig.session('run-bad-json')
    const registrations = await registerFixtures(rig, 'run-bad-json')
    const malformed = { ...submitArgs(registrations), facility_refs: '[not json' }
    rig.rig.call(session, 'r-bad-json', 'run_submit', malformed)
    await assert.rejects(
      () => runSubmit.execute(malformed, rig.rig.exec(session, { callId: 'r-bad-json' })),
      (error) => error instanceof Error
        && error.message.startsWith('INVALID_ARGUMENT: facility_refs is a string that is not valid JSON')
        && error.message.includes('[not json'),
    )

    const huge = { ...submitArgs(registrations), time_slices: `[${'x'.repeat(400)}` }
    rig.rig.call(session, 'r-huge', 'run_submit', huge)
    await assert.rejects(
      () => runSubmit.execute(huge, rig.rig.exec(session, { callId: 'r-huge' })),
      (error) => error instanceof Error
        && error.message.startsWith('INVALID_ARGUMENT: time_slices is a string that is not valid JSON')
        && error.message.includes('401 characters')
        && !error.message.includes('xxxx'),
      'a long rejected string is counted, not echoed',
    )

    const wrongShape = { ...submitArgs(registrations), study_area: JSON.stringify([1, 2]) }
    rig.rig.call(session, 'r-shape', 'run_submit', wrongShape)
    await assert.rejects(
      () => runSubmit.execute(wrongShape, rig.rig.exec(session, { callId: 'r-shape' })),
      (error) => error instanceof Error && error.message === 'INVALID_ARGUMENT: study_area must be [west, south, east, north] finite numbers',
      'JSON that parses but has the wrong shape keeps the existing refusal',
    )
  } finally {
    await rig.dispose()
  }
})

/**
 * Session run-b0fce40d bound entrances to properties.id while every feature.id
 * was null. Two clinic resources, each a Point with no top-level id.
 * @param {string} propertyId
 * @param {number} lon
 */
function clinicCollection(propertyId, lon) {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      id: null,
      geometry: { type: 'Point', coordinates: [lon, 39.5] },
      properties: { id: propertyId, capacity: 1000 },
    }],
  }
}

/** Register one named GeoJSON resource and return its exact ref. */
async function registerNamed(rig, session, callId, name, value) {
  const path = rig.write(`${name}.geojson`, value)
  rig.rig.call(session, callId, 'catalog_register', { path, name })
  const registered = await catalogRegister.execute({ path, name }, rig.rig.exec(session, { callId }))
  return registered.resource.ref
}

/** Poll run_get until the run reaches a terminal status. */
async function settleRun(rig, session, runId) {
  const exec = rig.rig.exec(session, { callId: 'r-get' })
  let record = null
  for (let attempt = 0; attempt < 200; attempt++) {
    rig.rig.call(session, `r-get-${attempt}`, 'run_get', { run_id: runId })
    record = await runGet.execute({ run_id: runId }, exec)
    if (['succeeded', 'partial', 'failed', 'cancelled', 'outcomeUnknown'].includes(record.status)) return record
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return record
}

test('properties.id binds entrances and run_get names the excluded facility', async () => {
  const rig = await runRig('properties-id')
  try {
    const session = rig.rig.session('run-b0fce40d')
    const populationRef = await registerNamed(rig, session, 'c-pop', 'population', POPULATION)
    const clinicA = await registerNamed(rig, session, 'c-a', 'clinic-a', clinicCollection('clinic-a', 116.0))
    const clinicB = await registerNamed(rig, session, 'c-b', 'clinic-b', clinicCollection('clinic-b', 116.02))
    const args = {
      ...submitArgs({ populationRef, facilityRef: clinicA }),
      facility_refs: [clinicA, clinicB],
      entrances: [{ facility: 'clinic-a', lon: 116.0, lat: 39.5 }],
      capacities: { 'clinic-a': 1000 },
    }
    rig.rig.call(session, 'r-props', 'run_submit', args)
    const submitted = await runSubmit.execute(args, rig.rig.exec(session, { callId: 'r-props' }))
    assert.equal(submitted.status, 'submitted')
    const settled = await settleRun(rig, session, submitted.run_id)
    assert.equal(settled.status, 'partial')
    assert.equal(settled.metrics.populationDenominator, 350)
    assert.equal(settled.metrics.coveredPopulation, 150, 'clinic-a matched properties.id and covered the two near units')
    const missing = settled.diagnostics.find(line => line.startsWith('entrance-missing:'))
    assert.equal(missing, 'entrance-missing: facilityId=clinic-b the facility carries no entrance and cannot join the network')
    assert.equal(settled.diagnostics.some(line => line.includes('facility-1')), false)
    const rendered = runGet.output.render({}, settled)
    assert.equal(rendered[0].text.includes('entrance-missing: facilityId=clinic-b'), true, 'the named exclusion reaches the model text, not only the raw result')
  } finally {
    await rig.dispose()
  }
})

test('a repeated string properties.id inside one population resource is refused by name', async () => {
  const rig = await runRig('unit-properties-id')
  try {
    const session = rig.rig.session('run-units')
    const units = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', id: null, geometry: { type: 'Point', coordinates: [116.0, 39.5] }, properties: { id: 'unit-a', population: 100 } },
        { type: 'Feature', id: null, geometry: { type: 'Point', coordinates: [116.005, 39.5] }, properties: { id: 'unit-a', population: 40 } },
      ],
    }
    const populationRef = await registerNamed(rig, session, 'c-pop', 'population', units)
    const facilityRef = await registerNamed(rig, session, 'c-fac', 'facilities', FACILITIES)
    const args = submitArgs({ populationRef, facilityRef })
    rig.rig.call(session, 'r-units', 'run_submit', args)
    await assert.rejects(
      () => runSubmit.execute(args, rig.rig.exec(session, { callId: 'r-units' })),
      (error) => error instanceof Error
        && error.message === `INVALID_ARGUMENT: id unit-a is claimed by ${populationRef}`,
      'properties.id is the identity, so a repeated string id cannot silently become unit-1/unit-2',
    )
  } finally {
    await rig.dispose()
  }
})

test('positional fallback ids stay unique across resources that carry no id', async () => {
  const rig = await runRig('positional')
  try {
    const session = rig.rig.session('run-positional')
    const populationRef = await registerNamed(rig, session, 'c-pop', 'population', POPULATION)
    const bare = lon => ({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, 39.5] }, properties: { capacity: 1000 } }],
    })
    const left = await registerNamed(rig, session, 'c-left', 'left', bare(116.0))
    const right = await registerNamed(rig, session, 'c-right', 'right', bare(116.001))
    const args = {
      ...submitArgs({ populationRef, facilityRef: left }),
      facility_refs: [left, right],
      entrances: [
        { facility: 'facility-1', lon: 116.0, lat: 39.5 },
        { facility: 'facility-2', lon: 116.001, lat: 39.5 },
      ],
    }
    rig.rig.call(session, 'r-pos', 'run_submit', args)
    const submitted = await runSubmit.execute(args, rig.rig.exec(session, { callId: 'r-pos' }))
    const settled = await settleRun(rig, session, submitted.run_id)
    assert.equal(settled.status, 'succeeded')
    assert.equal(settled.metrics.coveredPopulation, 150)
    assert.equal(settled.diagnostics, undefined, 'both positional ids bound an entrance, so neither facility was excluded')
  } finally {
    await rig.dispose()
  }
})

test('an explicit id claimed by two resources is refused by name', async () => {
  const rig = await runRig('conflict')
  try {
    const session = rig.rig.session('run-conflict')
    const populationRef = await registerNamed(rig, session, 'c-pop', 'population', POPULATION)
    const left = await registerNamed(rig, session, 'c-left', 'left', clinicCollection('clinic-a', 116.0))
    const right = await registerNamed(rig, session, 'c-right', 'right', clinicCollection('clinic-a', 116.001))
    const args = {
      ...submitArgs({ populationRef, facilityRef: left }),
      facility_refs: [left, right],
      entrances: [{ facility: 'clinic-a', lon: 116.0, lat: 39.5 }],
    }
    rig.rig.call(session, 'r-conflict', 'run_submit', args)
    await assert.rejects(
      () => runSubmit.execute(args, rig.rig.exec(session, { callId: 'r-conflict' })),
      (error) => error instanceof Error
        && error.message === `INVALID_ARGUMENT: id clinic-a is claimed by ${left} and ${right}`,
      'the refusal names the conflicting id and both resource refs',
    )
  } finally {
    await rig.dispose()
  }
})
