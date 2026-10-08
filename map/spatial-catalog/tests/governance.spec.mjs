/**
 * Governance gates: the authorization contract (subjects, sensitivity
 * lattice, minimum-privilege derivation), the ACL decision matrix, the
 * monotonic grant lifecycle with explicit revoke/tombstone states, the
 * append-only audit trail, publish-time grants, cache authorization-domain
 * isolation, revocation races, semantic-binding governance, session-object
 * lineage, and the v3 store migration backfill. Failures are closed: a
 * missing grant denies without disclosing existence, and every refusal text
 * carries the copy-limit note instead of an erasure promise.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '../../../packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../packages/session/session-projection/lib/index.js'
import * as catalogPlugin from '../src/plugin.ts'
import {
  AUTHORIZATION_LATTICE,
  bindResource,
  COPY_LIMIT_NOTE,
  decide,
  deriveAuthorization,
  DOMAIN_LOCAL,
  DOMAIN_SENSITIVE,
  GOVERNANCE_CONTRACT_VERSION,
  GovernanceError,
  HOST_SUBJECT,
  openCatalogStore,
  publishArtifact,
  readArtifactBytes,
  readGrant,
  readResourceBytes,
  registerResource,
  registerSemanticDefinition,
  resolveResource,
  transitionGrant,
} from '../src/index.ts'
import { trackedTmpDir } from '../../spatial-storage/tests/support.mjs'

/**
 * Mount the real plugin (service + projection) over one temp store so the
 * service-level gates exercise the exact face the tools resolve.
 */
async function governanceRig(label, pluginConfig = {}) {
  const dir = trackedTmpDir(`governance-${label}`)
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

const SENSITIVE_POINTS = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'clinic', geometry: { type: 'Point', coordinates: [1, 1] }, properties: { kind: 'clinic' } },
    { type: 'Feature', id: 'school', geometry: { type: 'Point', coordinates: [2, 2] }, properties: { kind: 'school' } },
  ],
}

/** Register the sensitive two-point fixture under one name. */
function registerSensitive(store, name, sessionId = 's-gov', callSeq = 3) {
  return registerResource(store.db, store.root, {
    name,
    bytes: Buffer.from(JSON.stringify(SENSITIVE_POINTS)),
    sourceLabel: `workspace/${name}.geojson`,
    nativeCrs: 'EPSG:4326',
    enforceWgs84Range: true,
    authorization: DOMAIN_LOCAL,
    sessionId,
    sourceCallSeq: callSeq,
  })
}

test('the governance contract pins its version, lattice order, and copy-limit copy', () => {
  assert.equal(GOVERNANCE_CONTRACT_VERSION, 'spatial-governance@1')
  assert.ok(AUTHORIZATION_LATTICE[DOMAIN_LOCAL] < AUTHORIZATION_LATTICE[DOMAIN_SENSITIVE])
  assert.match(COPY_LIMIT_NOTE, /not remotely recalled or erased/)
  assert.equal(HOST_SUBJECT.kind, 'host')
})

test('derivation is minimum-privilege: never widens and refuses unranked mixed inputs', () => {
  assert.equal(deriveAuthorization([DOMAIN_LOCAL, DOMAIN_LOCAL]), DOMAIN_LOCAL)
  assert.equal(deriveAuthorization([DOMAIN_LOCAL, DOMAIN_SENSITIVE]), DOMAIN_SENSITIVE)
  assert.equal(deriveAuthorization([DOMAIN_SENSITIVE, DOMAIN_LOCAL, DOMAIN_SENSITIVE]), DOMAIN_SENSITIVE)
  // A single custom domain derives as itself — no ordering decision is made.
  assert.equal(deriveAuthorization(['team-b']), 'team-b')
  assert.throws(() => deriveAuthorization([]), error => error instanceof GovernanceError && error.code === 'GOVERNANCE_DOMAIN_UNKNOWN')
  assert.throws(
    () => deriveAuthorization(['local', 'top-secret']),
    error => error instanceof GovernanceError && error.code === 'GOVERNANCE_DOMAIN_UNKNOWN',
  )
})

/** Build one request against the Host subject. */
function requestOf(ref, operation = 'read', domain = DOMAIN_LOCAL) {
  return { subject: HOST_SUBJECT, operation, objectKind: 'resource', ref, domain }
}

test('the decision matrix: granted allows; missing, revoked, and tombstoned deny distinctly', () => {
  const granted = { objectKind: 'resource', ref: 'res-a@v1', domain: DOMAIN_LOCAL, state: 'granted', grantVersion: 2, updatedAt: '2026-09-25T00:00:00.000Z' }
  const revoked = { ...granted, state: 'revoked' }
  const tombstoned = { ...granted, state: 'tombstoned' }
  assert.deepEqual(decide(requestOf('res-a@v1'), granted), { decision: 'allowed', reasonCode: 'GOVERNANCE_ALLOWED', grantVersion: 2 })
  assert.deepEqual(decide(requestOf('res-a@v1'), undefined).decision, 'denied')
  assert.equal(decide(requestOf('res-a@v1'), undefined).reasonCode, 'GOVERNANCE_DENIED')
  assert.equal(decide(requestOf('res-a@v1'), revoked).reasonCode, 'GOVERNANCE_REVOKED')
  assert.equal(decide(requestOf('res-a@v1'), tombstoned).reasonCode, 'GOVERNANCE_TOMBSTONED')
  // A subjectless request denies closed even against a granted row.
  const subjectless = { ...requestOf('res-a@v1'), subject: { subjectId: '', kind: 'host' } }
  assert.equal(decide(subjectless, granted).reasonCode, 'GOVERNANCE_SUBJECT_REQUIRED')
})

test('published objects carry an explicit granted ACL row; same-state writes are no-ops', async () => {
  const dir = trackedTmpDir('governance-publish-grant')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const { resource } = registerSensitive(store, 'clinics')
      const grant = readGrant(store.db, 'resource', resource.ref, DOMAIN_LOCAL)
      assert.equal(grant.state, 'granted')
      assert.equal(grant.grantVersion, 1)
      // The publishing session object is granted too.
      assert.equal(readGrant(store.db, 'session', 's-gov', DOMAIN_LOCAL)?.state, 'granted')

      const same = transitionGrant(store.db, 'resource', resource.ref, DOMAIN_LOCAL, 'granted')
      assert.equal(same.grantVersion, 1, 'a same-state write keeps the version')
      assert.equal(readGrant(store.db, 'resource', 'res-doesnotexist@v1', DOMAIN_LOCAL), undefined)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('revoke bumps the grant version and blocks resolve and byte reads; restore reopens access', async () => {
  const dir = trackedTmpDir('governance-revoke-race')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const { resource } = registerSensitive(store, 'clinics')
      assert.equal(resolveResource(store.db, { ref: resource.ref, authorization: DOMAIN_LOCAL }).resource.ref, resource.ref)

      const revoked = transitionGrant(store.db, 'resource', resource.ref, DOMAIN_LOCAL, 'revoked')
      assert.equal(revoked.grantVersion, 2, 'the state transition bumps the grant version')
      assert.throws(
        () => resolveResource(store.db, { ref: resource.ref, authorization: DOMAIN_LOCAL }),
        /GOVERNANCE_REVOKED/,
      )
      assert.throws(
        () => readResourceBytes(store.db, store.root, resource.ref, DOMAIN_LOCAL, 1 << 20),
        /GOVERNANCE_REVOKED/,
      )
      // Revocation is not an erasure: the bytes and their catalog row remain.
      const row = store.db.prepare('SELECT state FROM catalog_resources WHERE resource_id = ?').get(`${resource.resourceId}-v${resource.version}`)
      assert.equal(row.state, 'available', 'the catalog lifecycle row is untouched by the ACL transition')
      assert.match(readGrant(store.db, 'resource', resource.ref, DOMAIN_LOCAL).state, /revoked/)

      const restored = transitionGrant(store.db, 'resource', resource.ref, DOMAIN_LOCAL, 'granted')
      assert.equal(restored.grantVersion, 3, 'restore bumps the version again')
      assert.equal(resolveResource(store.db, { ref: resource.ref, authorization: DOMAIN_LOCAL }).resource.ref, resource.ref)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('tombstone is distinct from revoke and both refusal texts carry the copy-limit note', async () => {
  const dir = trackedTmpDir('governance-tombstone')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const { resource } = registerSensitive(store, 'clinics')
      transitionGrant(store.db, 'resource', resource.ref, DOMAIN_LOCAL, 'tombstoned')
      assert.throws(
        () => resolveResource(store.db, { ref: resource.ref, authorization: DOMAIN_LOCAL }),
        error => error instanceof GovernanceError
          && error.code === 'GOVERNANCE_TOMBSTONED'
          && error.message.includes(COPY_LIMIT_NOTE),
      )
      assert.doesNotMatch(String(readGrant(store.db, 'resource', resource.ref, DOMAIN_LOCAL).state), /granted/)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('a missing grant denies without disclosing existence; a foreign domain stays CATALOG_NOT_FOUND', async () => {
  const dir = trackedTmpDir('governance-non-disclosure')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const { resource } = registerSensitive(store, 'clinics')
      // Remove the grant: the resolution now denies like an unknown ref.
      store.db.prepare('DELETE FROM governance_acl WHERE object_kind = ? AND ref = ?').run('resource', resource.ref)
      let missing
      try {
        resolveResource(store.db, { ref: resource.ref, authorization: DOMAIN_LOCAL })
      } catch (error) {
        missing = error
      }
      assert.match(missing.message, /is not available to this reader/, 'a missing grant reads as non-disclosure')
      assert.equal(missing.code, 'GOVERNANCE_DENIED')
      // A reader from another domain never sees the object at all.
      assert.throws(
        () => resolveResource(store.db, { ref: resource.ref, authorization: DOMAIN_SENSITIVE }),
        /CATALOG_NOT_FOUND/,
      )
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('artifact grants freeze the derived minimum-privilege domain', async () => {
  const dir = trackedTmpDir('governance-artifact-grant')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const { resource } = registerSensitive(store, 'clinics')
      const published = publishArtifact(store.db, store.root, {
        bytes: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [] })),
        inputRefs: [resource.ref],
        method: { algorithm: 'test-buffer', units: 'meters', parameters: { radius: 10 } },
        analysisCrs: 'EPSG:4326',
        sessionId: 's-gov',
        sourceCallSeq: 9,
        inputAuthorizations: [resource.authorization],
      })
      assert.equal(published.artifact.authorization, DOMAIN_LOCAL)
      assert.equal(readGrant(store.db, 'artifact', published.artifact.ref, DOMAIN_LOCAL)?.state, 'granted')
      assert.equal(readArtifactBytes(store.db, store.root, published.artifact.ref, DOMAIN_LOCAL).artifact.ref, published.artifact.ref)
      // Widening is refused: a mixed list with an unranked domain fails the
      // publication instead of guessing strictness.
      assert.throws(
        () => publishArtifact(store.db, store.root, {
          bytes: Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [] })),
          inputRefs: [resource.ref],
          method: { algorithm: 'test-buffer', units: 'meters', parameters: { radius: 10 } },
          analysisCrs: 'EPSG:4326',
          sessionId: 's-gov',
          sourceCallSeq: 10,
          inputAuthorizations: [DOMAIN_LOCAL, 'unranked'],
        }),
        error => error instanceof GovernanceError && error.code === 'GOVERNANCE_DOMAIN_UNKNOWN',
      )
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('semantic bindings are governed objects: revoking the definition refuses resolutions that need it', async () => {
  const dir = trackedTmpDir('governance-semantic')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const { resource } = registerSensitive(store, 'clinics')
      registerSemanticDefinition(store.db, {
        definitionId: 'clinic-count', canonicalName: 'Clinic count', definition: 'Number of clinics',
        applicability: 'clinics', sourceRef: 'source:clinic', reviewStatus: 'reviewed', authorization: DOMAIN_LOCAL, sessionId: 's-gov',
      })
      bindResource(store.db, resource.ref, { definitionId: 'clinic-count', definitionVersion: 1, mappingVersion: 1, transformVersion: 'identity' })
      const granted = resolveResource(store.db, { ref: resource.ref, authorization: DOMAIN_LOCAL })
      assert.deepEqual(granted.bundle.semanticDefinition, { definitionId: 'clinic-count', version: 1 })
      const semanticRef = `def-clinic-count@v1`
      assert.equal(readGrant(store.db, 'semantic', semanticRef, DOMAIN_LOCAL)?.state, 'granted')

      transitionGrant(store.db, 'semantic', semanticRef, DOMAIN_LOCAL, 'revoked')
      assert.throws(
        () => resolveResource(store.db, { ref: resource.ref, authorization: DOMAIN_LOCAL }),
        error => error instanceof GovernanceError
          && error.code === 'GOVERNANCE_REVOKED'
          && error.message.includes('semantic definition def-clinic-count@v1')
          && error.message.includes(COPY_LIMIT_NOTE),
      )
      // The resource without any binding still resolves: the refusal is
      // scoped to the governed definition, not a blanket lockout.
      store.db.prepare('DELETE FROM semantic_bindings WHERE resource_id = ?').run(`${resource.resourceId}-v${resource.version}`)
      const unbound = resolveResource(store.db, { ref: resource.ref, authorization: DOMAIN_LOCAL })
      assert.equal(unbound.bundle.semanticDefinition, null)
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})

test('the audit trail records publish, revoke, and denial facts with subject, version, and grant', async () => {
  const rig = await governanceRig('audit')
  try {
    const catalog = rig.catalog.forSession('s-audit')
    const registered = await catalog.register({
      name: 'clinics',
      bytes: Buffer.from(JSON.stringify(SENSITIVE_POINTS)),
      sourceLabel: 'workspace/clinics.geojson',
      nativeCrs: 'EPSG:4326',
      enforceWgs84Range: true,
      authorization: DOMAIN_LOCAL,
      sessionId: 's-audit',
      sourceCallSeq: 3,
    })
    await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref: registered.resource.ref, state: 'revoked' })
    await assert.rejects(
      () => catalog.resolve({ ref: registered.resource.ref, authorization: DOMAIN_LOCAL }),
      /GOVERNANCE_REVOKED/,
    )

    const trail = await catalog.auditTrail()
    const facts = trail.map(record => `${record.operation}:${record.decision}:${record.reasonCode}`)
    assert.ok(facts.includes('publish:allowed:GOVERNANCE_ALLOWED'), `the publication is audited as an admission (got ${JSON.stringify(facts)})`)
    assert.ok(facts.includes('revoke:allowed:GOVERNANCE_ALLOWED'), 'the transition itself is audited')
    const denial = trail.find(record => record.operation === 'resolve' && record.decision === 'denied')
    assert.ok(denial, 'the denied resolution is audited')
    assert.equal(denial.reasonCode, 'GOVERNANCE_REVOKED')
    assert.equal(denial.subjectId, HOST_SUBJECT.subjectId)
    assert.equal(denial.sessionId, null)
    assert.equal(denial.ref, registered.resource.ref)
    assert.equal(denial.resourceVersion, 1)
    assert.equal(denial.domain, DOMAIN_LOCAL)
    assert.equal(denial.grantVersion, 2, 'the denial records the grant version it was refused under')
    const filtered = await catalog.auditTrail({ ref: registered.resource.ref, sessionId: 's-audit', limit: 1 })
    assert.equal(filtered.length, 1)
    assert.equal(filtered[0].ref, registered.resource.ref)
  } finally {
    await rig.dispose()
  }
})

test('authorize() returns decisions without throwing and audits both outcomes', async () => {
  const rig = await governanceRig('authorize')
  try {
    const catalog = rig.catalog.forSession('s-authz')
    const registered = await catalog.register({
      name: 'clinics',
      bytes: Buffer.from(JSON.stringify(SENSITIVE_POINTS)),
      sourceLabel: 'workspace/clinics.geojson',
      nativeCrs: 'EPSG:4326',
      enforceWgs84Range: true,
      authorization: DOMAIN_LOCAL,
      sessionId: 's-authz',
      sourceCallSeq: 4,
    })
    const allowed = await catalog.authorize({
      subject: HOST_SUBJECT, operation: 'export', objectKind: 'resource', ref: registered.resource.ref, sessionId: 's-authz',
    })
    assert.deepEqual(allowed, { decision: 'allowed', reasonCode: 'GOVERNANCE_ALLOWED', grantVersion: 1 })
    // A subject from a model parameter is not a subject: denial is loud.
    const denied = await catalog.authorize({
      subject: { subjectId: '', kind: 'host' }, operation: 'read', objectKind: 'resource', ref: registered.resource.ref,
    })
    assert.equal(denied.reasonCode, 'GOVERNANCE_SUBJECT_REQUIRED')
    assert.equal(denied.decision, 'denied')
    const unknown = await catalog.authorize({
      subject: HOST_SUBJECT, operation: 'open', objectKind: 'session', ref: 'never-seen-session',
    })
    assert.equal(unknown.reasonCode, 'GOVERNANCE_DENIED', 'an ungoverned session object denies closed')
    const trail = await catalog.auditTrail({ ref: 'never-seen-session' })
    assert.equal(trail.length, 1)
    assert.equal(trail[0].operation, 'open')
  } finally {
    await rig.dispose()
  }
})

test('session objects: fork copies the parent grant; a revoked parent yields a revoked child', async () => {
  const rig = await governanceRig('fork')
  try {
    const { catalog } = rig
    const parent = catalog.forSession('s-parent')
    await parent.register({
      name: 'clinics',
      bytes: Buffer.from(JSON.stringify(SENSITIVE_POINTS)),
      sourceLabel: 'workspace/clinics.geojson',
      nativeCrs: 'EPSG:4326',
      enforceWgs84Range: true,
      authorization: DOMAIN_LOCAL,
      sessionId: 's-parent',
      sourceCallSeq: 5,
    })
    const child = await catalog.forkSession('s-parent', 's-child')
    assert.equal(child.state, 'granted')
    const lineage = await catalog.forSession('s-child').auditTrail({ objectKind: 'session', ref: 's-child' })
    assert.equal(lineage[0].operation, 'fork')

    // The parent session object's grant lives in the parent's own library.
    await parent.setObjectState({ subject: HOST_SUBJECT, objectKind: 'session', ref: 's-parent', state: 'revoked' })
    const revokedChild = await catalog.forkSession('s-parent', 's-child-2')
    assert.equal(revokedChild.state, 'revoked', 'the child never inherits an execution permission the parent lost')
    const open = await catalog.forSession('s-child-2').authorize({ subject: HOST_SUBJECT, operation: 'resume', objectKind: 'session', ref: 's-child-2' })
    assert.equal(open.decision, 'denied')
    // Forking from an ungoverned session refuses without disclosing it.
    await assert.rejects(
      () => catalog.forkSession('s-never', 's-child-3'),
      /GOVERNANCE_DENIED/,
    )
  } finally {
    await rig.dispose()
  }
})

test('refStateOf gates model-context reads and audits non-available states', async () => {
  const rig = await governanceRig('refstate')
  try {
    const catalog = rig.catalog.forSession('s-ctx')
    const registered = await catalog.register({
      name: 'clinics',
      bytes: Buffer.from(JSON.stringify(SENSITIVE_POINTS)),
      sourceLabel: 'workspace/clinics.geojson',
      nativeCrs: 'EPSG:4326',
      enforceWgs84Range: true,
      authorization: DOMAIN_LOCAL,
      sessionId: 's-ctx',
      sourceCallSeq: 6,
    })
    assert.equal(await catalog.refStateOf(registered.resource.ref), 'available')
    assert.equal(await catalog.refStateOf('res-doesnotexist@v9'), 'unknown', 'an unknown ref reads as unknown without disclosure')
    await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref: registered.resource.ref, state: 'tombstoned' })
    assert.equal(await catalog.refStateOf(registered.resource.ref), 'tombstoned')
    const denial = (await catalog.auditTrail({ ref: registered.resource.ref, limit: 1 }))[0]
    assert.equal(denial.operation, 'context')
    assert.equal(denial.reasonCode, 'GOVERNANCE_TOMBSTONED')
  } finally {
    await rig.dispose()
  }
})

test('service resolve serves repeat reads from the authorization-scoped cache and never after revocation', async () => {
  const rig = await governanceRig('cache')
  try {
    const catalog = rig.catalog.forSession('s-cache')
    const registered = await catalog.register({
      name: 'clinics',
      bytes: Buffer.from(JSON.stringify(SENSITIVE_POINTS)),
      sourceLabel: 'workspace/clinics.geojson',
      nativeCrs: 'EPSG:4326',
      enforceWgs84Range: true,
      authorization: DOMAIN_LOCAL,
      sessionId: 's-cache',
      sourceCallSeq: 7,
    })
    const first = await catalog.resolve({ ref: registered.resource.ref, authorization: DOMAIN_LOCAL })
    const second = await catalog.resolve({ ref: registered.resource.ref, authorization: DOMAIN_LOCAL })
    assert.equal(second.bundle.resourceRef, first.bundle.resourceRef)
    await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref: registered.resource.ref, state: 'revoked' })
    // The revocation race: the cached answer must not survive the grant bump.
    await assert.rejects(
      () => catalog.resolve({ ref: registered.resource.ref, authorization: DOMAIN_LOCAL }),
      /GOVERNANCE_REVOKED/,
    )
    await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref: registered.resource.ref, state: 'granted' })
    const refilled = await catalog.resolve({ ref: registered.resource.ref, authorization: DOMAIN_LOCAL })
    assert.equal(refilled.bundle.resourceRef, first.bundle.resourceRef, 'a restored grant refills the cache fresh')
  } finally {
    await rig.dispose()
  }
})

test('confirmDurability reports the governance state of revoked and tombstoned refs', async () => {
  const rig = await governanceRig('save')
  try {
    const catalog = rig.catalog.forSession('s-save')
    const registered = await catalog.register({
      name: 'clinics',
      bytes: Buffer.from(JSON.stringify(SENSITIVE_POINTS)),
      sourceLabel: 'workspace/clinics.geojson',
      nativeCrs: 'EPSG:4326',
      enforceWgs84Range: true,
      authorization: DOMAIN_LOCAL,
      sessionId: 's-save',
      sourceCallSeq: 8,
    })
    await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref: registered.resource.ref, state: 'tombstoned' })
    const statuses = await catalog.confirmDurability([registered.resource.ref])
    assert.deepEqual(statuses.map(entry => entry.status), ['tombstoned'])
    await catalog.setObjectState({ subject: HOST_SUBJECT, objectKind: 'resource', ref: registered.resource.ref, state: 'revoked' })
    const revoked = await catalog.confirmDurability([registered.resource.ref])
    assert.deepEqual(revoked.map(entry => entry.status), ['revoked'])
  } finally {
    await rig.dispose()
  }
})

test('grantOnPublish never resets an administrator-set state on idempotent republication', async () => {
  const dir = trackedTmpDir('governance-publish-idempotent')
  try {
    const store = openCatalogStore(dir.path)
    try {
      const first = registerSensitive(store, 'clinics', 's-gov', 11)
      transitionGrant(store.db, 'resource', first.resource.ref, DOMAIN_LOCAL, 'revoked')
      // The same operation replays (deduplicated) — the granted upsert must
      // not resurrect access the administrator revoked.
      const replay = registerSensitive(store, 'clinics', 's-gov', 11)
      assert.equal(replay.deduplicated, true)
      assert.equal(readGrant(store.db, 'resource', replay.resource.ref, DOMAIN_LOCAL).state, 'revoked')
    } finally {
      store.close()
    }
  } finally {
    dir.dispose()
  }
})
