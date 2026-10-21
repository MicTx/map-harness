/**
 * Per-session library gates over the REAL plugin service: two conversations
 * mount over one root and each gets its own SQLite store — a ref published
 * by session A answers CATALOG_NOT_FOUND in session B exactly like an
 * unknown ref (no existence disclosure), concurrent multi-session use never
 * crosses libraries, the session view refuses inputs claiming another
 * session's identity, and an unusable session id fails loud. The audit
 * trail and retrieval cache stay per-library as well.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '../../../packages/core/session/lib/index.js'
import SessionProjectionRegistry from '../../../packages/session/session-projection/lib/index.js'
import * as catalogPlugin from '../src/plugin.ts'
import { trackedTmpDir } from '../../spatial-storage/tests/support.mjs'

/** Mount the real plugin (service + projection) over one temp root. */
async function rig(label, pluginConfig = {}) {
  const dir = trackedTmpDir(`session-isolation-${label}`)
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
    { type: 'Feature', id: 'alpha', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'first' } },
  ],
}

/** Register the one-point fixture in one conversation. */
function registerFixture(view, sessionId, callSeq = 3, name = `poi-${sessionId}`) {
  return view.register({
    name,
    bytes: Buffer.from(JSON.stringify(POINTS)),
    sourceLabel: `workspace/${name}.geojson`,
    nativeCrs: 'EPSG:4326',
    enforceWgs84Range: true,
    authorization: 'local',
    sessionId,
    sourceCallSeq: callSeq,
  })
}

test('each session owns an independent library; cross-session refs answer not-found', async () => {
  const harness = await rig('libraries')
  try {
    const a = harness.catalog.forSession('sess-a')
    const b = harness.catalog.forSession('sess-b')
    const registered = await registerFixture(a, 'sess-a')
    assert.match(registered.resource.ref, /^res-/, 'the ref identity is name-derived and conversation-unique by fixture')
    assert.equal((await a.resolve({ ref: registered.resource.ref, authorization: 'local' })).resource.ref, registered.resource.ref)
    await assert.rejects(
      () => b.resolve({ ref: registered.resource.ref, authorization: 'local' }),
      (error) => error instanceof Error && error.code === 'CATALOG_NOT_FOUND',
      'session B reads session A\'s ref as plain not-found, without disclosure',
    )
    // Two independent database files under the root's manifest directory.
    assert.equal(existsSync(join(harness.dir.path, 'sessions', 'sess-a', 'store.db')), true)
    assert.equal(existsSync(join(harness.dir.path, 'sessions', 'sess-b', 'store.db')), true)
    assert.equal(existsSync(join(harness.dir.path, 'store.db')), false, 'no shared root database exists')
    // The per-session store root answers through the view.
    assert.equal(a.storeRoot(), join(harness.dir.path, 'sessions', 'sess-a'))
  } finally {
    await harness.dispose()
  }
})

test('concurrent sessions open, register, and resolve without crossing libraries', async () => {
  const harness = await rig('concurrent')
  try {
    const ids = ['sess-c1', 'sess-c2', 'sess-c3', 'sess-c4', 'sess-c5']
    const registered = await Promise.all(ids.map(id => registerFixture(harness.catalog.forSession(id), id, 3)))
    const resolved = await Promise.all(registered.map((entry, index) =>
      harness.catalog.forSession(ids[index]).resolve({ ref: entry.resource.ref, authorization: 'local' })))
    assert.deepEqual(resolved.map(entry => entry.resource.ref), registered.map(entry => entry.resource.ref))
    // Every other session still answers not-found for each ref.
    for (let owner = 0; owner < ids.length; owner += 1) {
      for (let other = 0; other < ids.length; other += 1) {
        if (owner === other) continue
        await assert.rejects(
          () => harness.catalog.forSession(ids[other]).resolve({ ref: registered[owner].resource.ref, authorization: 'local' }),
          (error) => error instanceof Error && error.code === 'CATALOG_NOT_FOUND',
        )
      }
    }
  } finally {
    await harness.dispose()
  }
})

test('the view refuses to publish under another session\'s identity and unusable session ids', async () => {
  const harness = await rig('refuse')
  try {
    const a = harness.catalog.forSession('sess-a')
    await assert.rejects(
      () => registerFixture(a, 'sess-b'),
      (error) => error instanceof Error && error.code === 'CATALOG_INVALID_INPUT',
      'intent rows and staging ownership must land in the caller\'s own library',
    )
    for (const bad of ['', '..', 'a/b', 'x'.repeat(129)]) {
      assert.throws(
        () => harness.catalog.forSession(bad),
        (error) => error instanceof Error && error.code === 'CATALOG_INVALID_INPUT',
        `session id ${JSON.stringify(bad)} fails loud before any path is built`,
      )
    }
    // The refused publish left no library behind.
    assert.equal(existsSync(join(harness.dir.path, 'sessions', 'sess-b', 'store.db')), false)
  } finally {
    await harness.dispose()
  }
})

test('the audit trail and publish pairing stay per-library', async () => {
  const harness = await rig('audit')
  try {
    const a = harness.catalog.forSession('sess-a')
    const b = harness.catalog.forSession('sess-b')
    const registered = await registerFixture(a, 'sess-a', 7)
    const trailA = await a.auditTrail()
    assert.ok(trailA.some(record => record.operation === 'publish'), 'the owning library audits its publication')
    assert.equal((await b.auditTrail()).length, 0, 'a never-used library has no audit facts')
    assert.notEqual(await a.lookupPublication('register', 7), undefined)
    assert.equal(await b.lookupPublication('register', 7), undefined, 'the retry pairing never crosses libraries')
    void registered
  } finally {
    await harness.dispose()
  }
})

test('forkSession registers the child library and never widens resource visibility', async () => {
  const harness = await rig('fork')
  try {
    const parent = harness.catalog.forSession('sess-parent')
    const registered = await registerFixture(parent, 'sess-parent', 5)
    const child = await harness.catalog.forkSession('sess-parent', 'sess-child')
    assert.equal(child.state, 'granted')
    // The child library exists beside the parent's, each with its own bytes.
    assert.equal(existsSync(join(harness.dir.path, 'sessions', 'sess-child', 'store.db')), true)
    // Resource visibility is per-library even across a fork.
    await assert.rejects(
      () => harness.catalog.forSession('sess-child').resolve({ ref: registered.resource.ref, authorization: 'local' }),
      (error) => error instanceof Error && error.code === 'CATALOG_NOT_FOUND',
    )
    // A parent that never used the catalog has no session grant to inherit.
    await assert.rejects(
      () => harness.catalog.forkSession('sess-never', 'sess-child-2'),
      (error) => error instanceof Error && error.code === 'GOVERNANCE_DENIED',
    )
  } finally {
    await harness.dispose()
  }
})
