/**
 * Governance entry fixtures over the REAL tool handlers and catalog service:
 * after one registered version is revoked through the Host governance plane,
 * every model- and SDK-facing entry refuses — catalog_resolve (candidate
 * entry), map_add_layer `ref` (map display entry), geo_buffer `ref`
 * (pre-execute, publishing nothing), map_save (export receipt carries the
 * copy-limit note), and catalog_register `retry_of` (the resumed-retry
 * entry). The publish domain is deployment-owned: a model-supplied domain
 * argument refuses loudly. Restoring the grant reopens every entry.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import * as spatialCatalogPlugin from '../../spatial-catalog/src/plugin.ts'
import { HOST_SUBJECT } from '../../spatial-catalog/src/index.ts'
import { catalogRegister, catalogResolve, mapSave } from '../src/catalog-tools.ts'
import { mapAddLayer } from '../src/map-tools.ts'
import { geoBuffer } from '../src/geo-tools.ts'
import { decodeCatalogResultMeta } from '../src/catalog-meta.ts'

const TWO_POINTS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'alpha', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'first' } },
    { type: 'Feature', id: 'beta', geometry: { type: 'Point', coordinates: [10, 0] }, properties: { name: 'second' } },
  ],
}

/** Mount the full rig: map projection + real spatial catalog over a temp store. */
async function chainRig(label) {
  const dir = mkdtempSync(join(tmpdir(), `map-governance-${label}-`))
  const storeRoot = join(dir, 'store')
  const rig = await mapRig({ cwd: dir })
  await rig.ctx.plugin(spatialCatalogPlugin, { root: storeRoot })
  return {
    dir,
    storeRoot,
    rig,
    catalog: rig.ctx.get('spatialCatalog'),
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

/** Register the fixture; returns the result and the accepted call seq (retry_of cites it). */
async function registerPoints(chain, session, name = 'points') {
  const call = chain.rig.call(session, `g-${name}`, 'catalog_register', { path: 'points.geojson', name })
  const registered = await catalogRegister.execute({ path: 'points.geojson', name }, chain.rig.exec(session, { callId: `g-${name}` }))
  chain.rig.result(session, call, { text: 'ok' })
  assert.equal(registered.status, 'succeeded')
  return { registered, regSeq: call.seq }
}

test('revocation blocks the resolve and display entries; restore reopens them', async () => {
  const chain = await chainRig('entries')
  try {
    const session = chain.rig.session('entries')
    chain.write('points.geojson', TWO_POINTS)
    const { registered, regSeq } = await registerPoints(chain, session)

    await chain.catalog.forSession(session.id).setObjectState({
      subject: HOST_SUBJECT, objectKind: 'resource', ref: registered.resource.ref, state: 'revoked',
    })

    // Candidate entry: catalog_resolve refuses with the governance code and
    // the copy-limit note — no erasure promise, no silent empty result.
    chain.rig.call(session, 'g-res1', 'catalog_resolve', { resource: registered.resource.ref })
    await assert.rejects(
      () => catalogResolve.execute({ resource: registered.resource.ref }, chain.rig.exec(session, { callId: 'g-res1' })),
      error => error.code === 'GOVERNANCE_REVOKED' && error.message.includes('not remotely recalled or erased'),
    )

    // Display entry: map_add_layer over the revoked ref refuses before any
    // display copy is assembled.
    chain.rig.call(session, 'g-add1', 'map_add_layer', { ref: registered.resource.ref, layer_id: 'points' })
    await assert.rejects(
      () => mapAddLayer.execute({ ref: registered.resource.ref, layer_id: 'points' }, chain.rig.exec(session, { callId: 'g-add1' })),
      /GOVERNANCE_REVOKED/,
    )
    assert.equal(chain.rig.state(session).layers.length, 0, 'no layer folds from the refused add')

    // Resume/retry entry: retry_of returns the published ref but its byte
    // read re-checks the grant, so the resumed retry refuses too.
    chain.rig.call(session, 'g-retry', 'catalog_register', { path: 'points.geojson', retry_of: regSeq })
    await assert.rejects(
      () => catalogRegister.execute({ path: 'points.geojson', retry_of: regSeq }, chain.rig.exec(session, { callId: 'g-retry' })),
      /GOVERNANCE_REVOKED/,
    )

    await chain.catalog.forSession(session.id).setObjectState({
      subject: HOST_SUBJECT, objectKind: 'resource', ref: registered.resource.ref, state: 'granted',
    })
    const resolved = await catalogResolve.execute(
      { resource: registered.resource.ref },
      chain.rig.exec(session, { callId: 'g-res2' }),
    )
    assert.equal(resolved.status, 'succeeded')
  } finally {
    await chain.dispose()
  }
})

test('revocation blocks the execute entry before any computation or publication', async () => {
  const chain = await chainRig('execute')
  try {
    const session = chain.rig.session('execute')
    chain.write('points.geojson', TWO_POINTS)
    const { registered } = await registerPoints(chain, session)
    const betaRef = registered.feature_refs.find(entry => entry.original_id === 'beta').feature_ref

    await chain.catalog.forSession(session.id).setObjectState({
      subject: HOST_SUBJECT, objectKind: 'resource', ref: registered.resource.ref, state: 'revoked',
    })

    chain.rig.call(session, 'g-buf', 'geo_buffer', { ref: { resource: registered.resource.ref, feature: betaRef }, distance_m: 1000 })
    await assert.rejects(
      () => geoBuffer.execute(
        { ref: { resource: registered.resource.ref, feature: betaRef }, distance_m: 1000 },
        chain.rig.exec(session, { callId: 'g-buf' }),
      ),
      /GOVERNANCE_REVOKED/,
    )
    const artifacts = await chain.catalog.forSession(session.id).auditTrail({ objectKind: 'artifact' })
    assert.equal(artifacts.filter(record => record.operation === 'publish').length, 0, 'the refused execution publishes nothing')
  } finally {
    await chain.dispose()
  }
})

test('map_save reports the governed stage failure with the copy-limit note instead of confirming', async () => {
  const chain = await chainRig('save')
  try {
    const session = chain.rig.session('save')
    chain.write('points.geojson', TWO_POINTS)
    const { registered } = await registerPoints(chain, session)
    const addCall = chain.rig.call(session, 'g-add', 'map_add_layer', { ref: registered.resource.ref, layer_id: 'points' })
    const added = await mapAddLayer.execute(
      { ref: registered.resource.ref, layer_id: 'points' },
      chain.rig.exec(session, { callId: 'g-add' }),
    )
    chain.rig.result(session, addCall, { meta: added.meta })
    assert.equal(added.layer.id, 'points')

    await chain.catalog.forSession(session.id).setObjectState({
      subject: HOST_SUBJECT, objectKind: 'resource', ref: registered.resource.ref, state: 'tombstoned',
    })

    const sessionsDouble = { flush: async () => true }
    const base = chain.rig.exec(session, { callId: 'g-save' })
    const exec = {
      ...base,
      agent: { ...base.agent, ctx: { get: name => (name === 'sessions' ? sessionsDouble : base.agent.ctx.get(name)) } },
    }
    const receipt = await mapSave.execute({}, exec)
    assert.equal(receipt.saved, false, 'the save never confirms a tombstoned citation')
    assert.match(receipt.reason, /tombstoned/)
    assert.match(receipt.reason, /not remotely recalled or erased/)
    assert.equal(receipt.session_flush, 'not-performed', 'the flush stage never runs after the governed stage fails')
  } finally {
    await chain.dispose()
  }
})

test('the publish domain is deployment-owned: a model-supplied domain refuses loudly', async () => {
  const chain = await chainRig('domain')
  try {
    const session = chain.rig.session('domain')
    const path = chain.write('points.geojson', TWO_POINTS)
    chain.rig.call(session, 'g-dom', 'catalog_register', { path, name: 'points', authorization: 'rogue' })
    await assert.rejects(
      () => catalogRegister.execute({ path, name: 'points', authorization: 'rogue' }, chain.rig.exec(session, { callId: 'g-dom' })),
      /INVALID_ARGUMENT.*not this deployment's domain/,
    )
    // The deployment domain itself is accepted (omitted means the same),
    // and the durable meta records that domain on the published version.
    const okCall = chain.rig.call(session, 'g-dom2', 'catalog_register', { path, name: 'points' })
    const registered = await catalogRegister.execute({ path, name: 'points' }, chain.rig.exec(session, { callId: 'g-dom2' }))
    chain.rig.result(session, okCall, { text: 'ok' })
    assert.equal(registered.status, 'succeeded')
    const meta = decodeCatalogResultMeta(catalogRegister.output.presentationMeta({}, registered))
    assert.equal(meta.resources[0].authorization, chain.catalog.deploymentDomain())
  } finally {
    await chain.dispose()
  }
})

test('governed entries leave a queryable audit trail attributed to the host subject', async () => {
  const chain = await chainRig('audit')
  try {
    const session = chain.rig.session('audit')
    chain.write('points.geojson', TWO_POINTS)
    const { registered } = await registerPoints(chain, session)
    await catalogResolve.execute({ resource: registered.resource.ref }, chain.rig.exec(session, { callId: 'g-res' }))
    await chain.catalog.forSession(session.id).setObjectState({
      subject: HOST_SUBJECT, objectKind: 'resource', ref: registered.resource.ref, state: 'revoked',
    })
    chain.rig.call(session, 'g-res2', 'catalog_resolve', { resource: registered.resource.ref })
    await assert.rejects(
      () => catalogResolve.execute({ resource: registered.resource.ref }, chain.rig.exec(session, { callId: 'g-res2' })),
      /GOVERNANCE_REVOKED/,
    )
    const trail = await chain.catalog.forSession(session.id).auditTrail({ ref: registered.resource.ref })
    const facts = trail.map(record => `${record.operation}:${record.decision}`)
    assert.ok(facts.includes('publish:allowed'), 'the publication admission is audited')
    assert.ok(facts.includes('resolve:allowed'), 'the allowed resolution is audited')
    assert.ok(facts.includes('revoke:allowed'), 'the revocation transition is audited')
    assert.ok(facts.includes('resolve:denied'), 'the refused resolution is audited')
    for (const record of trail) {
      assert.equal(record.subjectId, HOST_SUBJECT.subjectId, 'every audit fact names its subject')
      assert.equal(record.domain, 'local')
      assert.ok(record.auditId.length > 0)
    }
  } finally {
    await chain.dispose()
  }
})

test('a recall refuses every governed entry by name while a cross-tenant denial stays non-disclosing', async () => {
  const chain = await chainRig('recall')
  try {
    const session = chain.rig.session('recall')
    chain.write('points.geojson', TWO_POINTS)
    const { registered, regSeq } = await registerPoints(chain, session)
    const view = chain.catalog.forSession(session.id)
    const ref = registered.resource.ref

    // Context entry: a resolution registers the context copy under the session id.
    await catalogResolve.execute({ resource: ref }, chain.rig.exec(session, { callId: 'g-res0' }))

    // Display entry: the layer add registers the display copy under the layer id.
    const addCall = chain.rig.call(session, 'g-add', 'map_add_layer', { ref, layer_id: 'points' })
    const added = await mapAddLayer.execute({ ref, layer_id: 'points' }, chain.rig.exec(session, { callId: 'g-add' }))
    chain.rig.result(session, addCall, { meta: added.meta })
    assert.equal(added.layer.id, 'points')

    // Export entry: a successful save registers the export copy under the checkpoint.
    const sessionsDouble = { flush: async () => true }
    const base = chain.rig.exec(session, { callId: 'g-save' })
    const exec = {
      ...base,
      agent: { ...base.agent, ctx: { get: name => (name === 'sessions' ? sessionsDouble : base.agent.ctx.get(name)) } },
    }
    const receipt = await mapSave.execute({}, exec)
    assert.equal(receipt.saved, true)
    const holders = (await view.copyTrail({ ref })).map(copy => `${copy.channel}:${copy.holder}`)
    assert.ok(holders.some(holder => holder.startsWith('context:')), 'resolve registered the context copy')
    assert.ok(holders.includes('display:points'), 'the layer add registered the display copy under the layer id')
    assert.ok(holders.includes(`export:checkpoint:${receipt.durable_through_seq}`), 'the save registered the export copy under the checkpoint')

    // The host plane recalls the object: every registered copy is covered.
    const result = await chain.catalog.recallCopies({
      subject: HOST_SUBJECT,
      scope: { kind: 'object', objectKind: 'resource', ref },
      origin: 'host governance console',
    })
    assert.equal(result.recalledCopies, 3, 'context, display, and export copies are all covered')

    // Candidate entry: named refusal with the recall boundary sentence.
    chain.rig.call(session, 'g-res3', 'catalog_resolve', { resource: ref })
    await assert.rejects(
      () => catalogResolve.execute({ resource: ref }, chain.rig.exec(session, { callId: 'g-res3' })),
      error => error.code === 'GOVERNANCE_RECALLED' && error.message.includes('refuses future use') && error.message.includes('no existing copy is erased'),
    )
    // Display entry: the same named refusal, before any display copy is assembled.
    chain.rig.call(session, 'g-add2', 'map_add_layer', { ref, layer_id: 'points-2' })
    await assert.rejects(
      () => mapAddLayer.execute({ ref, layer_id: 'points-2' }, chain.rig.exec(session, { callId: 'g-add2' })),
      /GOVERNANCE_RECALLED/,
    )
    // Execute entry: the refusal lands before any computation or publication.
    const betaRef = registered.feature_refs.find(entry => entry.original_id === 'beta').feature_ref
    chain.rig.call(session, 'g-buf2', 'geo_buffer', { ref: { resource: ref, feature: betaRef }, distance_m: 1000 })
    await assert.rejects(
      () => geoBuffer.execute({ ref: { resource: ref, feature: betaRef }, distance_m: 1000 }, chain.rig.exec(session, { callId: 'g-buf2' })),
      /GOVERNANCE_RECALLED/,
    )
    // Retry entry: the resumed retry re-reads the bytes and refuses the same way.
    chain.rig.call(session, 'g-retry2', 'catalog_register', { path: 'points.geojson', retry_of: regSeq })
    await assert.rejects(
      () => catalogRegister.execute({ path: 'points.geojson', retry_of: regSeq }, chain.rig.exec(session, { callId: 'g-retry2' })),
      /GOVERNANCE_RECALLED/,
    )
    // Export receipt: the recall is reported with the recall boundary sentence,
    // never with the copy-limit note that promises no recall.
    const receipt2 = await mapSave.execute({}, exec)
    assert.equal(receipt2.saved, false, 'the save never confirms a recalled citation')
    assert.match(receipt2.reason, /recalled/)
    assert.match(receipt2.reason, /no existing copy is erased/)
    assert.doesNotMatch(receipt2.reason, /not remotely recalled or erased/)
    assert.equal(receipt2.session_flush, 'not-performed')

    // Independent distinguishability: a cross-tenant authorization denial is
    // non-disclosing (GOVERNANCE_DENIED, no ref named), while the recall
    // refusal names the object — the two negative classes never blur.
    const decision = await view.authorize({ subject: HOST_SUBJECT, operation: 'read', objectKind: 'resource', ref, tenant: 'beta' })
    assert.equal(decision.decision, 'denied')
    assert.equal(decision.reasonCode, 'GOVERNANCE_DENIED')
  } finally {
    await chain.dispose()
  }
})
