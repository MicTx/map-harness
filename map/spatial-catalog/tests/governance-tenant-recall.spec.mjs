/**
 * The tenant and recall plane of the governance contract successor
 * (`spatial-governance@2`): tenant isolation denies without disclosing
 * existence, the single-tenant default keeps `@1` behavior byte-for-byte,
 * copy registration is idempotent and bounded, `recallCopies` records per
 * object and tenant scope and audits every covered copy, recalled copies
 * are refused by name on their next use with the no-erasure boundary
 * sentence, and unregistered copies stay out of reach. Cross-tenant
 * authorization and the open-time foreign-row refusal are covered against
 * the real plugin service.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '../../../packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../packages/session/session-projection/lib/index.js'
import * as catalogPlugin from '../src/plugin.ts'
import {
  decide,
  DOMAIN_LOCAL,
  GOVERNANCE_CONTRACT_VERSION_V2,
  GOVERNANCE_COPY_CHANNELS,
  GovernanceError,
  HOST_SUBJECT,
  listAudit,
  MAX_OBJECT_COPIES,
  openCatalogStore,
  readGrant,
  RECALL_NOTE,
  recalledDetail,
  registerResource,
  resolveResource,
  TENANT_DEFAULT,
  TENANT_ID_PATTERN,
  transitionGrant,
} from '../src/index.ts'
import { trackedTmpDir } from '../../spatial-storage/tests/support.mjs'

/** Mount the real plugin (service + projection) over one temp root. */
async function tenantRig(label, pluginConfig = {}) {
  const dir = trackedTmpDir(`tenant-recall-${label}`)
  const ctx = new Context()
  const sessionFiber = await ctx.plugin(SessionStore)
  const registryFiber = await ctx.plugin(SessionProjectionRegistry)
  const catalogFiber = await ctx.plugin(catalogPlugin, { root: dir.path, ...pluginConfig })
  return {
    ctx,
    catalog: ctx.get('spatialCatalog'),
    dir,
    async dispose() {
      await catalogFiber.dispose()
      await registryFiber.dispose()
      await sessionFiber.dispose()
      await ctx.fiber.dispose()
      dir.dispose()
    },
  }
}

const POINTS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'clinic', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { kind: 'clinic' } },
  ],
}

/** Register the one-point fixture under one session's own library. */
function registerFixture(view, sessionId, name, callSeq) {
  return view.register({
    name,
    bytes: Buffer.from(JSON.stringify(POINTS)),
    sourceLabel: `workspace/${name}.geojson`,
    nativeCrs: 'EPSG:4326',
    enforceWgs84Range: true,
    authorization: DOMAIN_LOCAL,
    sessionId,
    sourceCallSeq: callSeq,
  })
}

test('the successor contract pins its version, tenant syntax, and recall copy', () => {
  assert.equal(GOVERNANCE_CONTRACT_VERSION_V2, 'spatial-governance@2')
  assert.equal(TENANT_DEFAULT, 'default')
  assert.deepEqual(GOVERNANCE_COPY_CHANNELS, ['context', 'display', 'export', 'fork'])
  assert.equal(MAX_OBJECT_COPIES, 1024)
  assert.match(RECALL_NOTE, /refuses future use/)
  assert.match(RECALL_NOTE, /never registered remain out of reach/)
  assert.match(RECALL_NOTE, /no existing copy is erased/)
  // The refusal detail carries the boundary sentence, never an erasure promise.
  assert.equal(recalledDetail('res-a@v1'), `res-a@v1 has had its copies recalled and is refused for future use; ${RECALL_NOTE}`)
  for (const valid of ['a', 'acme', 't2', 'x-0', 'a-', 'a'.repeat(64)]) {
    assert.equal(TENANT_ID_PATTERN.test(valid), true, `"${valid}" is valid tenant syntax`)
  }
  for (const invalid of ['', 'A', '-a', '_a', 'a b', 'a'.repeat(65), 'a.b']) {
    assert.equal(TENANT_ID_PATTERN.test(invalid), false, `"${invalid}" is invalid tenant syntax`)
  }
})

test('a grant under another tenant denies exactly like a missing grant', () => {
  const grantedTenantA = { tenant: 'acme', objectKind: 'resource', ref: 'res-a@v1', domain: DOMAIN_LOCAL, state: 'granted', grantVersion: 2, updatedAt: '2026-10-07T00:00:00.000Z' }
  const requestTenantA = { subject: HOST_SUBJECT, operation: 'read', objectKind: 'resource', ref: 'res-a@v1', domain: DOMAIN_LOCAL, tenant: 'acme' }
  const requestTenantB = { ...requestTenantA, tenant: 'beta' }
  const requestDefault = { subject: HOST_SUBJECT, operation: 'read', objectKind: 'resource', ref: 'res-a@v1', domain: DOMAIN_LOCAL }
  // The owning tenant allows.
  assert.deepEqual(decide(requestTenantA, grantedTenantA), { decision: 'allowed', reasonCode: 'GOVERNANCE_ALLOWED', grantVersion: 2 })
  // A foreign tenant and a tenant-less request both read the row as
  // missing — the reason code is the non-disclosing denial, identical to an
  // unknown ref, so cross-tenant probing learns nothing.
  assert.deepEqual(decide(requestTenantB, grantedTenantA), { decision: 'denied', reasonCode: 'GOVERNANCE_DENIED', grantVersion: null })
  assert.deepEqual(decide(requestDefault, grantedTenantA), { decision: 'denied', reasonCode: 'GOVERNANCE_DENIED', grantVersion: null })
  // And the tenant-less grant reads as missing for a named tenant.
  const grantless = { objectKind: 'resource', ref: 'res-a@v1', domain: DOMAIN_LOCAL, state: 'granted', grantVersion: 2, updatedAt: '2026-10-07T00:00:00.000Z' }
  assert.equal(decide({ ...requestTenantA, tenant: TENANT_DEFAULT }, grantless).reasonCode, 'GOVERNANCE_ALLOWED')
  assert.equal(decide(requestTenantA, grantless).reasonCode, 'GOVERNANCE_DENIED')
})

test('grant rows are tenant-keyed: state transitions bump per tenant without lockouts', () => {
  const dir = trackedTmpDir('tenant-grant-keying')
  try {
    const store = openCatalogStore(dir.path, { tenant: 'acme' })
    try {
      assert.equal(store.tenant, 'acme')
      transitionGrant(store.db, 'resource', 'res-a@v1', DOMAIN_LOCAL, 'granted', 'acme')
      transitionGrant(store.db, 'resource', 'res-a@v1', DOMAIN_LOCAL, 'granted', 'beta')
      const acme = readGrant(store.db, 'resource', 'res-a@v1', DOMAIN_LOCAL, 'acme')
      const beta = readGrant(store.db, 'resource', 'res-a@v1', DOMAIN_LOCAL, 'beta')
      assert.equal(acme.grantVersion, 1)
      assert.equal(beta.grantVersion, 1)
      // Revoking one tenant's row never touches the other's version.
      const revoked = transitionGrant(store.db, 'resource', 'res-a@v1', DOMAIN_LOCAL, 'revoked', 'acme')
      assert.equal(revoked.grantVersion, 2)
      assert.equal(readGrant(store.db, 'resource', 'res-a@v1', DOMAIN_LOCAL, 'beta')?.grantVersion, 1)
      assert.equal(readGrant(store.db, 'resource', 'res-a@v1', DOMAIN_LOCAL, 'acme')?.state, 'revoked')
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('an undeclared deployment stays single-tenant default and refuses foreign rows at open', async () => {
  const dir = trackedTmpDir('tenant-undeclared')
  try {
    // The @1 shape: no tenant argument, no config — everything lands under
    // the default tenant and reads back under it.
    const store = openCatalogStore(dir.path)
    try {
      const { resource } = registerResource(store.db, store.root, {
        name: 'clinics',
        bytes: Buffer.from(JSON.stringify(POINTS)),
        sourceLabel: 'workspace/clinics.geojson',
        nativeCrs: 'EPSG:4326',
        enforceWgs84Range: true,
        authorization: DOMAIN_LOCAL,
        sessionId: 's-one',
        sourceCallSeq: 1,
      })
      assert.equal(readGrant(store.db, 'resource', resource.ref, DOMAIN_LOCAL)?.tenant, 'default')
      assert.notEqual(readGrant(store.db, 'resource', resource.ref, DOMAIN_LOCAL), undefined)
      // A tenant-scoped read of the same store misses (no disclosure).
      assert.equal(readGrant(store.db, 'resource', resource.ref, DOMAIN_LOCAL, 'acme'), undefined)
    } finally {
      store.close()
    }
    // A store that already holds rows under another tenant fails loud at
    // open — a store is single-tenant for its whole life.
    const rig = await tenantRig('foreign-rows', { tenant: 'acme', root: join(dir.path, 'sessions-root') })
    try {
      const view = rig.catalog.forSession('s-acme')
      const { resource } = await registerFixture(view, 's-acme', 'foreign', 1)
      assert.ok(resource.ref.startsWith('res-'))
    } finally {
      await rig.dispose()
    }
    const foreignRoot = join(dir.path, 'sessions-root', 'sessions', 's-acme')
    assert.equal(existsSync(join(foreignRoot, 'store.db')), true)
    assert.throws(
      () => openCatalogStore(foreignRoot, { tenant: 'beta' }),
      error => error instanceof Error && error.code === 'CATALOG_IO' && /cannot serve tenant "beta"/.test(error.message),
    )
    // The owning tenant still opens it.
    const reopened = openCatalogStore(foreignRoot, { tenant: 'acme' })
    reopened.close()
  } finally {
    dir.dispose()
  }
})

test('config validation fails loud on malformed tenant declarations', async () => {
  const dir = trackedTmpDir('tenant-config-invalid')
  try {
    for (const bad of [
      { config: { tenant: 'ACME' }, detail: /tenant must match/ },
      { config: { tenant: '-x' }, detail: /tenant must match/ },
      { config: { tenants: ['acme', 'acme'] }, detail: /more than once/ },
      { config: { tenants: ['acme', 'Beta'] }, detail: /must match/ },
      { config: { tenant: 'beta', tenants: ['acme'] }, detail: /must be declared in tenants/ },
    ]) {
      const ctx = new Context()
      const sessionFiber = await ctx.plugin(SessionStore)
      const registryFiber = await ctx.plugin(SessionProjectionRegistry)
      await assert.rejects(
        async () => {
          await ctx.plugin(catalogPlugin, { root: dir.path, ...bad.config })
        },
        error => error instanceof Error && error.code === 'CATALOG_INVALID_INPUT' && bad.detail.test(error.message),
      )
      await registryFiber.dispose()
      await sessionFiber.dispose()
      await ctx.fiber.dispose()
    }
  } finally {
    dir.dispose()
  }
})

test('resolve registers a context copy; registration is idempotent and bounded per object', async () => {
  const rig = await tenantRig('copy-register', { tenant: 'acme' })
  try {
    const view = rig.catalog.forSession('s-copy')
    const { resource } = await registerFixture(view, 's-copy', 'sites', 1)
    await view.resolve({ ref: resource.ref, authorization: DOMAIN_LOCAL })
    let trail = await view.copyTrail({ ref: resource.ref })
    assert.deepEqual(
      trail.map(copy => ({ channel: copy.channel, holder: copy.holder, tenant: copy.tenant })),
      [{ channel: 'context', holder: 's-copy', tenant: 'acme' }],
    )
    // Repeated resolutions keep one row (idempotent per holder).
    await view.resolve({ ref: resource.ref, authorization: DOMAIN_LOCAL })
    await view.resolve({ ref: resource.ref, authorization: DOMAIN_LOCAL })
    trail = await view.copyTrail({ ref: resource.ref })
    assert.equal(trail.length, 1)
    // Distinct holders register distinct rows up to the protocol bound;
    // the first holder beyond it fails loud instead of dropping an address.
    for (let i = 0; i < MAX_OBJECT_COPIES - 1; i += 1) {
      await view.registerCopy({ objectKind: 'resource', ref: resource.ref, channel: 'display', holder: `layer-${i}` })
    }
    // The trail read itself is bounded; the protocol bound is proven by the
    // refusal below, not by counting past the read limit.
    assert.equal((await view.copyTrail({ ref: resource.ref, limit: 1000 })).length, 1000)
    await assert.rejects(
      () => view.registerCopy({ objectKind: 'resource', ref: resource.ref, channel: 'display', holder: 'layer-overflow' }),
      error => error instanceof GovernanceError && error.code === 'GOVERNANCE_INVALID_INPUT' && /refusing to drop one silently/.test(error.message),
    )
    // A copy registration over an object with no grant row is refused
    // closed, identically to an unknown ref.
    await assert.rejects(
      () => view.registerCopy({ objectKind: 'resource', ref: 'res-nobody@v1', channel: 'display', holder: 'layer-x' }),
      error => error instanceof GovernanceError && error.code === 'GOVERNANCE_DENIED',
    )
  } finally {
    await rig.dispose()
  }
})

test('an object-scope recall refuses every covered copy on next use, by name, with the boundary sentence', async () => {
  const rig = await tenantRig('recall-object')
  try {
    const view = rig.catalog.forSession('s-recall')
    const { resource } = await registerFixture(view, 's-recall', 'places', 1)
    await view.resolve({ ref: resource.ref, authorization: DOMAIN_LOCAL })
    await view.registerCopy({ objectKind: 'resource', ref: resource.ref, channel: 'display', holder: 'layer-7' })
    // Warm the retrieval cache, then recall: the cached resolution must not
    // outlive the recall (recall does not bump the grant version).
    await view.resolve({ ref: resource.ref, authorization: DOMAIN_LOCAL })
    const result = await rig.catalog.recallCopies({
      subject: HOST_SUBJECT,
      scope: { kind: 'object', objectKind: 'resource', ref: resource.ref },
      origin: 'host governance console',
    })
    assert.equal(result.recalledCopies, 2, 'the context copy and the display copy are both covered')
    assert.equal(result.scope.kind, 'object')
    // Every covered copy is audited as a recall denial.
    const audits = await view.auditTrail({ objectKind: 'resource', ref: resource.ref })
    const recallAudits = audits.filter(entry => entry.operation === 'recall')
    assert.equal(recallAudits.length, 2)
    assert.ok(recallAudits.every(entry => entry.decision === 'denied' && entry.reasonCode === 'GOVERNANCE_RECALLED' && entry.tenant === 'default'))
    // Next use refuses by name with the boundary sentence.
    await assert.rejects(
      () => view.resolve({ ref: resource.ref, authorization: DOMAIN_LOCAL }),
      error => error instanceof GovernanceError && error.code === 'GOVERNANCE_RECALLED'
        && error.message.includes(recalledDetail(resource.ref)),
    )
    await assert.rejects(
      () => view.readResourceBytes(resource.ref, DOMAIN_LOCAL, 1024 * 1024),
      error => error instanceof GovernanceError && error.code === 'GOVERNANCE_RECALLED',
    )
    assert.equal(await view.refStateOf(resource.ref), 'recalled')
    // Registering new copies for a recalled object is refused outright.
    await assert.rejects(
      () => view.registerCopy({ objectKind: 'resource', ref: resource.ref, channel: 'export', holder: 'checkpoint:1' }),
      error => error instanceof GovernanceError && error.code === 'GOVERNANCE_RECALLED',
    )
    // The recall trail records the event with its origin and shared id.
    const recalls = await view.recallTrail({ scope: 'object' })
    assert.equal(recalls.length, 1)
    assert.equal(recalls[0].recallId, result.recallId)
    assert.equal(recalls[0].origin, 'host governance console')
    assert.equal(recalls[0].ref, resource.ref)
    // A sibling object is untouched by the object-scope recall.
    const sibling = await registerFixture(view, 's-recall', 'neighbors', 2)
    assert.equal(await view.refStateOf(sibling.resource.ref), 'available')
  } finally {
    await rig.dispose()
  }
})

test('a tenant-scope recall covers every registered copy in every session library', async () => {
  const rig = await tenantRig('recall-tenant')
  try {
    const viewA = rig.catalog.forSession('s-a')
    const viewB = rig.catalog.forSession('s-b')
    const a = await registerFixture(viewA, 's-a', 'alpha', 1)
    const b = await registerFixture(viewB, 's-b', 'bravo', 1)
    await viewA.resolve({ ref: a.resource.ref, authorization: DOMAIN_LOCAL })
    await viewB.resolve({ ref: b.resource.ref, authorization: DOMAIN_LOCAL })
    const result = await rig.catalog.recallCopies({
      subject: HOST_SUBJECT,
      scope: { kind: 'tenant' },
      origin: 'tenant offboarding',
    })
    assert.equal(result.recalledCopies, 2)
    // Both libraries deny next use; the event row is present in each.
    await assert.rejects(
      () => viewA.resolve({ ref: a.resource.ref, authorization: DOMAIN_LOCAL }),
      error => error instanceof GovernanceError && error.code === 'GOVERNANCE_RECALLED',
    )
    await assert.rejects(
      () => viewB.readResourceBytes(b.resource.ref, DOMAIN_LOCAL, 1024 * 1024),
      error => error instanceof GovernanceError && error.code === 'GOVERNANCE_RECALLED',
    )
    assert.equal((await viewA.recallTrail()).length, 1)
    assert.equal((await viewB.recallTrail()).length, 1)
    // A fresh publication in the recalled tenant is still admitted (ACL
    // grants are untouched by recall) but its copies refuse on next use —
    // recall is append-only and forward-looking.
    const c = await registerFixture(viewA, 's-a', 'charlie', 2)
    assert.equal(await viewA.refStateOf(c.resource.ref), 'recalled')
  } finally {
    await rig.dispose()
  }
})

test('an object with no registered copies recalls with zero covered copies and still refuses future use', async () => {
  const rig = await tenantRig('recall-unregistered')
  try {
    const view = rig.catalog.forSession('s-none')
    const { resource } = await registerFixture(view, 's-none', 'quiet', 1)
    // No resolve, no display: the object has a grant but no copy addresses.
    const result = await rig.catalog.recallCopies({
      subject: HOST_SUBJECT,
      scope: { kind: 'object', objectKind: 'resource', ref: resource.ref },
      origin: 'host governance console',
    })
    assert.equal(result.recalledCopies, 0)
    const recallAudits = (await view.auditTrail({ objectKind: 'resource', ref: resource.ref }))
      .filter(entry => entry.operation === 'recall')
    assert.equal(recallAudits.length, 0, 'no covered copies, no per-copy audit rows')
    // The recall trail still proves the decision.
    assert.equal((await view.recallTrail({ ref: resource.ref })).length, 1)
    // And future use refuses — the never-registered copy stays out of reach.
    await assert.rejects(
      () => view.resolve({ ref: resource.ref, authorization: DOMAIN_LOCAL }),
      error => error instanceof GovernanceError && error.code === 'GOVERNANCE_RECALLED',
    )
    assert.equal((await view.copyTrail({ ref: resource.ref })).length, 0, 'the refused resolve registered nothing')
  } finally {
    await rig.dispose()
  }
})

test('a recalled parent session object refuses forks; a successful fork registers its copy', async () => {
  const rig = await tenantRig('recall-fork')
  try {
    const view = rig.catalog.forSession('s-parent')
    await registerFixture(view, 's-parent', 'lineage', 1)
    await rig.catalog.forkSession('s-parent', 's-child-1')
    // The fork registered as a copy of the parent session object.
    const trail = await view.copyTrail({ objectKind: 'session', ref: 's-parent' })
    assert.deepEqual(trail.map(copy => ({ channel: copy.channel, holder: copy.holder })), [{ channel: 'fork', holder: 's-child-1' }])
    await rig.catalog.recallCopies({
      subject: HOST_SUBJECT,
      scope: { kind: 'object', objectKind: 'session', ref: 's-parent' },
      origin: 'session offboarding',
    })
    // A second fork of the recalled parent refuses by name.
    await assert.rejects(
      () => rig.catalog.forkSession('s-parent', 's-child-2'),
      error => error instanceof GovernanceError && error.code === 'GOVERNANCE_RECALLED'
        && error.message.includes(recalledDetail('session s-parent')),
    )
  } finally {
    await rig.dispose()
  }
})

test('confirmDurability reports recalled objects and the audit carries the recall denial', async () => {
  const rig = await tenantRig('recall-durability')
  try {
    const view = rig.catalog.forSession('s-dur')
    const { resource } = await registerFixture(view, 's-dur', 'saved', 1)
    await view.resolve({ ref: resource.ref, authorization: DOMAIN_LOCAL })
    const before = await view.confirmDurability([resource.ref])
    assert.equal(before[0].status, 'ok')
    await rig.catalog.recallCopies({
      subject: HOST_SUBJECT,
      scope: { kind: 'object', objectKind: 'resource', ref: resource.ref },
      origin: 'host governance console',
    })
    const after = await view.confirmDurability([resource.ref])
    assert.equal(after[0].status, 'recalled')
    const audits = await view.auditTrail({ operation: 'save' })
    assert.ok(audits.some(entry => entry.reasonCode === 'GOVERNANCE_RECALLED'))
  } finally {
    await rig.dispose()
  }
})

test('authorize decides cross-tenant requests: foreign grants deny without disclosure, unknown tenants fail loud', async () => {
  const rig = await tenantRig('authorize-tenant', { tenant: 'acme', tenants: ['acme', 'beta'] })
  try {
    const view = rig.catalog.forSession('s-auth')
    const { resource } = await registerFixture(view, 's-auth', 'secret', 1)
    // Same-tenant authorization allows.
    const allowed = await view.authorize({
      subject: HOST_SUBJECT, operation: 'read', objectKind: 'resource', ref: resource.ref, tenant: 'acme',
    })
    assert.equal(allowed.decision, 'allowed')
    // A foreign tenant's grant row reads as missing — non-disclosing denial,
    // auditable, indistinguishable from an unknown ref.
    const foreign = await view.authorize({
      subject: HOST_SUBJECT, operation: 'read', objectKind: 'resource', ref: resource.ref, tenant: 'beta',
    })
    assert.equal(foreign.decision, 'denied')
    assert.equal(foreign.reasonCode, 'GOVERNANCE_DENIED')
    // An undeclared tenant id fails loud (misconfiguration, not denial).
    await assert.rejects(
      () => view.authorize({
        subject: HOST_SUBJECT, operation: 'read', objectKind: 'resource', ref: resource.ref, tenant: 'gamma',
      }),
      error => error instanceof GovernanceError && error.code === 'GOVERNANCE_INVALID_INPUT' && /not declared/.test(error.message),
    )
    // Malformed tenant syntax fails loud at the syntax gate.
    await assert.rejects(
      () => view.authorize({
        subject: HOST_SUBJECT, operation: 'read', objectKind: 'resource', ref: resource.ref, tenant: 'Not-Ok',
      }),
      error => error instanceof GovernanceError && error.code === 'GOVERNANCE_INVALID_INPUT' && /must match/.test(error.message),
    )
    // The audit trail records the foreign-tenant denial under that tenant —
    // readable on the host-plane repo surface of this session's library.
    const store = openCatalogStore(rig.dir.path + '/sessions/s-auth', { tenant: 'acme' })
    try {
      const betaRows = listAudit(store.db, { tenant: 'beta' })
      assert.ok(betaRows.length > 0)
      assert.ok(betaRows.every(entry => entry.tenant === 'beta'))
      assert.ok(betaRows.some(entry => entry.reasonCode === 'GOVERNANCE_DENIED'))
    } finally {
      store.close()
    }
  } finally {
    await rig.dispose()
  }
})

test('the audit trail stays tenant-scoped and bounded on the session view', async () => {
  const rig = await tenantRig('audit-tenant')
  try {
    const view = rig.catalog.forSession('s-audit')
    const { resource } = await registerFixture(view, 's-audit', 'audited', 1)
    await view.resolve({ ref: resource.ref, authorization: DOMAIN_LOCAL })
    const trails = await view.auditTrail()
    assert.ok(trails.length > 0)
    assert.ok(trails.every(entry => entry.tenant === 'default'))
    const bounded = await view.auditTrail({ limit: 1 })
    assert.equal(bounded.length, 1)
  } finally {
    await rig.dispose()
  }
})

test('resolveResource reads under the request tenant against repo-level rows', () => {
  const dir = trackedTmpDir('tenant-resolve-repo')
  try {
    const store = openCatalogStore(dir.path, { tenant: 'acme' })
    try {
      const published = registerResource(store.db, store.root, {
        name: 'tenant-data',
        bytes: Buffer.from(JSON.stringify(POINTS)),
        sourceLabel: 'workspace/tenant-data.geojson',
        nativeCrs: 'EPSG:4326',
        enforceWgs84Range: true,
        authorization: DOMAIN_LOCAL,
        sessionId: 's-tenant',
        sourceCallSeq: 1,
      }, { tenant: 'acme' })
      const underTenant = resolveResource(store.db, { ref: published.resource.ref, authorization: DOMAIN_LOCAL, tenant: 'acme' })
      assert.equal(underTenant.resource.ref, published.resource.ref)
      assert.throws(
        () => resolveResource(store.db, { ref: published.resource.ref, authorization: DOMAIN_LOCAL, tenant: 'beta' }),
        error => error instanceof GovernanceError && error.code === 'GOVERNANCE_DENIED',
      )
      // Absent tenant reads as default and misses the acme row closed.
      assert.throws(
        () => resolveResource(store.db, { ref: published.resource.ref, authorization: DOMAIN_LOCAL }),
        error => error instanceof GovernanceError && error.code === 'GOVERNANCE_DENIED',
      )
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})
