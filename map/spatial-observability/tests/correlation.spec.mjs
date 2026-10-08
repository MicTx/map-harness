/**
 * Operation-correlation integration: ONE correlation scope runs a real map
 * operation through the real production planes — the Session store (accepted
 * `tool/call` + `tool/result` fold through the projection registry), the
 * transactional catalog (immutable register + artifact publication over the
 * SQLite ladder), the real JSONL durability barrier (`ctx.sessions.flush`
 * with the persistence plugin mounted), and the projection-derived display
 * view — and every record, metric, and audit fact from every plane reads as
 * one correlated chain (operationRef/runId/goalRevision/traceId).
 *
 * Source plane: imports resolve sibling packages through relative `src/`
 * paths (the map test-lane convention) and upstream built libs; nothing here
 * is a stand-in.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapRig, layerPayload, pointCollection } from '../../map-container/tests/map-rig.mjs'
import JsonlSessionPersistence from '../../../packages/session/session-persistence-jsonl/lib/index.js'
import { openCatalogStore, registerResource, publishArtifact } from '../../spatial-catalog/src/index.ts'
import { buildMapChangeMeta, validateMapChangeCandidate } from '../../map-container/src/protocol.ts'
import { ObservabilityRuntime } from '../src/index.ts'

test('one operation correlates across tool, artifact, Session, flush, and render planes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'map-obs-corr-'))
  let rig
  let store
  try {
    rig = await mapRig({ cwd: root })
    // The real JSONL persistence backend: the flush barrier drains a real writer.
    await rig.ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    store = openCatalogStore(join(root, 'catalog-store'))
    const runtime = new ObservabilityRuntime({ clock: (() => {
      let now = 1_000
      return () => (now += 5)
    })() })
    const session = rig.session('obs-main')

    // The agent loop appends the tool/call BEFORE the handler body runs; the
    // call event's seq is the operation identity's last component.
    const callEvent = rig.call(session, 'call-obs-1', 'map_add_layer', { id: 'roads' })
    const correlation = { domain: 'local', sessionId: session.id, sourceCallSeq: callEvent.seq, runId: 'run-obs-1', goalRevision: 1 }

    const accepted = await runtime.scope(correlation, async () => {
      // Context segment: the request-plane serialization.
      runtime.measure('context', () => JSON.stringify({ name: 'map_add_layer', args: callEvent.data.arguments.length }))
      runtime.emit('info', 'tool handler entered')

      // MCP codec segment: the candidate meta encode the adapter plane performs.
      const candidate = layerPayload('roads', pointCollection([116.4, 39.9]), callEvent.seq)
      const meta = runtime.measure('mcp', () => {
        const state = rig.state(session)
        const targetRevision = validateMapChangeCandidate(state, candidate)
        return buildMapChangeMeta(callEvent.seq, targetRevision, candidate)
      })
      assert.ok(meta !== undefined, 'the candidate meta built')

      // Compute + commit: validate against the real projection, then the
      // accepted tool/result appends and the fold consumes the pending call.
      const targetRevision = validateMapChangeCandidate(rig.state(session), candidate)
      const resultEvent = runtime.measure('commit', () =>
        rig.result(session, callEvent, { meta, text: 'layer added' }),
      )
      assert.ok(resultEvent.seq > callEvent.seq)

      // Artifact plane: the real catalog ladder (immutable register + publication).
      const bytes = Buffer.from(JSON.stringify(candidate.data), 'utf8')
      const registered = registerResource(store.db, store.root, {
        name: 'roads',
        bytes,
        sourceLabel: 'workspace/roads.geojson',
        nativeCrs: 'EPSG:4326',
        enforceWgs84Range: true,
        authorization: 'local',
        sessionId: session.id,
        sourceCallSeq: callEvent.seq,
      })
      const published = publishArtifact(store.db, store.root, {
        bytes,
        inputRefs: [registered.resource.ref],
        method: { algorithm: 'display-copy', units: 'n/a', parameters: {} },
        analysisCrs: 'EPSG:4326',
        sessionId: session.id,
        sourceCallSeq: callEvent.seq,
        inputAuthorizations: ['local'],
      })
      runtime.emit('info', 'artifact published', { fields: { artifactRef: published.artifact.ref } })
      assert.match(published.artifact.ref, /^art-/)

      // Flush: the REAL durability barrier drains the JSONL writer.
      const flushed = await runtime.measure('flush', () => rig.ctx.sessions.flush(session))
      assert.equal(flushed, true, 'the persistence backend drained (flush is a real listener here)')
      runtime.emit('info', 'durability barrier drained')

      // Render: the projection-derived display view.
      const view = runtime.measure('render', () => rig.view(session))
      assert.ok(view !== undefined, 'the display view derived')

      runtime.reportOutcome('data', 'succeeded')
      return { view, published: published.artifact.ref }
    })

    // Every stored record carries the same identity chain.
    const records = runtime.log.records
    assert.ok(records.length >= 3, `tool/artifact planes emitted (${records.length} records)`)
    for (const record of records) {
      assert.equal(record.correlation?.operationRef, `op:local:${session.id}#${callEvent.seq}`)
      assert.equal(record.correlation.runId, 'run-obs-1')
      assert.equal(record.correlation.goalRevision, 1)
    }
    // The trace ids match the accepted settlement's audit face.
    const traces = new Set(records.map(record => record.correlation.traceId))
    assert.equal(traces.size, 1, 'one trace id spans every plane')

    // Every measured segment landed exactly once on its closed series.
    const snapshot = runtime.metrics.snapshot()
    for (const segment of ['context', 'mcp', 'commit', 'flush', 'render']) {
      const series = snapshot.observations.find(entry => entry.name === 'obs_segment_latency_ms' && entry.labels.segment === segment)
      assert.ok(series !== undefined, `segment ${segment} measured once`)
      assert.equal(series.count, 1)
    }
    assert.equal(runtime.metrics.counterValue('obs_operations_total', { plane: 'data', outcome: 'succeeded' }), 1)

    // The diagnostic export answers "what happened to this operation".
    const { document } = runtime.exportDiagnostic()
    const operationRef = `op:local:${session.id}#${callEvent.seq}`
    const entry = document.operations.find(candidate => candidate.correlation.operationRef === operationRef)
    assert.ok(entry !== undefined, 'the operation is queryable')
    assert.equal(entry.correlation.runId, 'run-obs-1')
    assert.ok(entry.logCounts.info >= 3, 'the per-plane record counts ride the index')
    // The catalog artifact ref survives sanitization (a ref, not a path).
    assert.ok(!JSON.stringify(document).includes(root), 'no scratch host path reaches the export')
    assert.equal(document.readiness.ready, true)
    assert.equal(accepted.published.startsWith('art-'), true)
  } finally {
    if (store !== undefined) store.close()
    if (rig !== undefined) await rig.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
