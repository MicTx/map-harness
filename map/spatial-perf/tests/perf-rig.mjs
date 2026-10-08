/**
 * The benchmark rig: wires the REAL production planes into the spatial-perf
 * ports — the session store + projection registry + map-container plugin
 * (the same rig the mutation specs use), the transactional catalog store,
 * and the spatial-scale worker plane. Nothing here is a stand-in: folds run
 * through the registry, publishes run the SQLite transaction ladder, and the
 * cancel leg spawns a real paced child process.
 *
 * Source plane only: imports resolve sibling packages through relative
 * `src/` paths (the map test-lane convention), never built artifacts.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import { createToolResultMessage } from '../../../packages/llm/llm/lib/index.js'
import JsonlSessionPersistence from '../../../packages/session/session-persistence-jsonl/lib/index.js'
import {
  admitCollection,
  openCatalogStore,
  publishArtifact,
  readResourceBytes,
  registerResource,
  resolveResource,
} from '../../spatial-catalog/src/index.ts'
import { jobChunksOf, openScaleStore, workloadFeatures } from '../../spatial-scale/src/store.ts'
import { ScaleJobRunner } from '../../spatial-scale/src/worker.ts'
import { SCALE_METHOD_VERSION } from '../../spatial-scale/src/contract.ts'
import { buildMapChangeMeta, validateMapChangeCandidate } from '../../map-container/src/protocol.ts'

const MAX_READ_BYTES = 32 * 1024 * 1024

/** Inject the protocol's call identity into every add-layer candidate (copy, never mutate). */
function withCallIdentity(change, callSeq) {
  const cloned = JSON.parse(JSON.stringify(change))
  const inject = (candidate) => {
    if (candidate.op === 'add-layer') candidate.layer.sourceCallSeq = callSeq
    if (candidate.op === 'patch') for (const nested of candidate.changes) inject(nested)
  }
  inject(cloned)
  return cloned
}

/** Build the session projection port over one rig session. */
function sessionPortOf(rig, session) {
  let turn = 0
  const turnsByCallId = new Map()
  return {
    prepareMutation(change, callSeq) {
      const state = rig.state(session)
      const candidate = withCallIdentity(change, callSeq)
      const targetRevision = validateMapChangeCandidate(state, candidate)
      const meta = buildMapChangeMeta(callSeq, targetRevision, candidate)
      return { meta, metaBytes: Buffer.byteLength(JSON.stringify(meta), 'utf8'), targetRevision }
    },
    async beginCall(callId, name, argsText) {
      turn += 1
      turnsByCallId.set(callId, turn)
      const event = await session.append('tool/call', { turn, step: 1, callId, name, arguments: argsText })
      return { seq: event.seq }
    },
    async settleResult(callSeq, callId, meta) {
      const eventTurn = turnsByCallId.get(callId)
      if (eventTurn === undefined) throw new Error(`perf rig: settleResult for unknown call ${callId}`)
      await session.append('tool/result', {
        turn: eventTurn,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
        meta,
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    },
    async settleError(callSeq, callId) {
      const eventTurn = turnsByCallId.get(callId)
      if (eventTurn === undefined) throw new Error(`perf rig: settleError for unknown call ${callId}`)
      // The refusal's structured failure: no map-change meta, so the fold
      // consumes the pending entry and keeps the accepted map exactly as it was.
      await session.append('tool/result', {
        turn: eventTurn,
        step: 1,
        message: createToolResultMessage({
          callId,
          content: [{ type: 'text', text: 'Error: perf budget refused before commit' }],
          isError: true,
        }),
      }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    },
    acceptedState() {
      return rig.state(session)
    },
    displayView() {
      return rig.view(session)
    },
    coldReplay() {
      const registry = rig.ctx.sessionProjections
      const cold = registry.restore({}, session.snapshotEvents(), 0, session.header, session.inheritedEventCount)
      return cold.checkpoint.mapContainer.val
    },
    async flush() {
      return rig.ctx.sessions.flush(session)
    },
  }
}

/** Build the catalog port over one open catalog store (the local deployment domain). */
function catalogPortOf(store) {
  return {
    admit(bytes) {
      const admitted = admitCollection(bytes, { enforceWgs84Range: true })
      return { featureCount: admitted.featureCount, coordinateCount: admitted.coordinateCount }
    },
    register(input) {
      const result = registerResource(store.db, store.root, {
        name: input.name,
        bytes: input.bytes,
        sourceLabel: `workspace/${input.name}.geojson`,
        nativeCrs: 'EPSG:4326',
        enforceWgs84Range: true,
        authorization: 'local',
        sessionId: input.sessionId,
        sourceCallSeq: input.callSeq,
      })
      return { ref: result.resource.ref, featureCount: result.resource.featureCount }
    },
    resolve(ref) {
      const resolved = resolveResource(store.db, { ref, authorization: 'local' })
      return { featureRefs: resolved.featureRefs.map(entry => ({ featureIndex: entry.featureIndex, featureRef: entry.featureRef })) }
    },
    readBytes(ref) {
      return readResourceBytes(store.db, store.root, ref, 'local', MAX_READ_BYTES).bytes
    },
    publishArtifact(input) {
      const result = publishArtifact(store.db, store.root, {
        bytes: input.bytes,
        inputRefs: input.inputRefs,
        method: { algorithm: 'turf-buffer', units: 'm', parameters: { distance_m: 500 } },
        analysisCrs: 'EPSG:4326',
        sessionId: input.sessionId,
        sourceCallSeq: input.callSeq,
        inputAuthorizations: ['local'],
      })
      return { ref: result.artifact.ref }
    },
  }
}

/** The fixed small scale workload the cancel leg scans (paced child process). */
const CANCEL_WORKLOAD = {
  seed: 20260925,
  rows: 4_096,
  chunkRows: 512,
  lonSpan: 10,
  latSpan: 8,
  field: 'value',
  predicate: { field: 'value', op: '>=', value: 0.5 },
  concurrency: 1,
  recoveryAfterChunks: 0,
}

const CANCEL_BUDGETS = {
  chunkRows: 512,
  maxRowsPerRead: 4_096,
  maxBytesPerRead: 4 * 1024 * 1024,
  scanSampleRows: 16,
  jobSlots: 1,
  queueDepth: 2,
  jobTimeoutMs: 30_000,
}

/** Build the worker-cancel port over one scratch root (spawns a real paced child). */
async function cancelPortOf(root) {
  const scaleRoot = join(root, 'scale-store')
  const store = openScaleStore(scaleRoot)
  const version = store.ingest({
    resourceId: 'perf-cancel',
    sourceRef: 'res-perf-cancel@v1',
    sourceDigest: 'a'.repeat(64),
    nativeCrs: 'EPSG:4326',
    authorization: 'local',
    chunkRows: CANCEL_WORKLOAD.chunkRows,
    features: workloadFeatures(CANCEL_WORKLOAD),
  })
  const resolved = store.readVersion(version.ref, 'local')
  const chunks = jobChunksOf(store, resolved)
  const stagingDir = join(scaleRoot, 'staging')
  const runner = new ScaleJobRunner(stagingDir, CANCEL_BUDGETS)
  return {
    async pacedScanAndCancel(wait) {
      const controller = new AbortController()
      let chunksDoneBeforeCancel = 0
      let aborted = false
      const settlement = runner.run({
        methodVersion: SCALE_METHOD_VERSION,
        manifestPath: `${resolved.dir}/manifest.json`,
        chunks,
        predicate: CANCEL_WORKLOAD.predicate,
        sampleRows: CANCEL_BUDGETS.scanSampleRows,
        fault: { kind: 'pace', paceMs: 15 },
      }, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (!aborted && progress.chunksDone >= 1) {
            aborted = true
            chunksDoneBeforeCancel = progress.chunksDone
            controller.abort()
          }
        },
      })
      const outcome = await wait(settlement)
      if (outcome.status !== 'cancelled') {
        throw new Error(`perf rig: the paced cancel settled "${outcome.status}" instead of cancelled`)
      }
      const stagingClean = readdirSync(stagingDir).length === 0
      return { status: outcome.status, chunksDoneBeforeCancel, stagingClean }
    },
    async dispose() {
      await runner.dispose()
    },
  }
}

/**
 * Wire every benchmark port over real production planes rooted at one
 * scratch directory.
 * @param {string} root - scratch directory the stores live under (owned by the caller).
 * @returns the ports plus a disposer (runner quiescence, store close, rig dispose).
 */
export async function perfPortsOf(root) {
  const rig = await mapRig({ cwd: root })
  // The real JSONL persistence backend: sessions materialize on disk and the
  // durability checkpoint barrier (`ctx.sessions.flush`) has a real listener
  // to drain — the flush segment measures a real durability barrier, not a
  // no-op.
  await rig.ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
  const store = openCatalogStore(join(root, 'catalog-store'))
  const mainSession = rig.session('perf-main')
  const recoverySession = rig.session('perf-recovery')
  const cancel = await cancelPortOf(root)
  return {
    ports: {
      main: sessionPortOf(rig, mainSession),
      recovery: sessionPortOf(rig, recoverySession),
      catalog: catalogPortOf(store),
      cancel,
    },
    async dispose() {
      await cancel.dispose()
      store.close()
      await rig.dispose()
    },
  }
}
