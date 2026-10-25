/**
 * The five frozen workloads, each replayable end-to-end against the real
 * production planes through narrow ports:
 *
 * - `locate-visibility` — fold real add/hide/show map mutations through the
 *   accepted-call ladder and read the display derivation (the interaction
 *   path the design names first).
 * - `parse-register` — admit and publish the frozen GeoJSON fixture through
 *   the catalog's transactional registration ladder.
 * - `spatial-op` — one buffer + area computation per repeat, with the codec
 *   segment measured beside it.
 * - `recovery-replay` — cold-replay a recorded session's events into an
 *   identical projection state (the cache-miss recovery path).
 * - `two-point-chain` — the audit's P0b chain: register the two-point
 *   resource, resolve, read, select the SECOND point, buffer it, publish the
 *   artifact, fold the identified layer, flush, derive the display.
 *
 * Every workload runs under the budget ledger: each final operation's spend
 * is admitted BEFORE the fold/publish commits, so an over-budget mutation
 * refuses with the previous state untouched. Every workload returns a
 * deterministic aggregate (identical across runs — the gate spec pins its
 * digest) and keeps run-specific identifiers (published refs) in a separate
 * non-pinned identity record.
 *
 * The ports keep this module decoupled from the hosting packages: the tests
 * and the diagnostic command wire the real session projection, catalog
 * store, and worker plane; the workloads only orchestrate, measure, and
 * check.
 *
 * @module @map-harness/spatial-perf/workloads
 */
import { area as turfArea, buffer as turfBuffer } from '@turf/turf'
import type { PerfBudgetLedger } from './budgets.ts'
import { perfDigestOf, type PerfWorkload, type PerfWorkloadId } from './contract.ts'
import type { PerfFixtures } from './fixtures.ts'
import type { PerfSampler, PerfSummary } from './instrument.ts'

/** The session projection port: the accepted-call ladder and its read faces. */
export interface PerfSessionPort {
  /**
   * Validate one candidate mutation against the accepted projection state
   * and build its durable meta record (the tool plane's pre-commit half).
   * The port injects the protocol identity fields (call seq, target
   * revision).
   * @param change - the pure candidate change (plain JSON).
   * @param callSeq - the accepted `tool/call` seq the candidate belongs to.
   * @returns the prepared meta with its serialized size and target revision.
   * @throws when the candidate violates the container's capacity or payload bounds.
   */
  prepareMutation(change: unknown, callSeq: number): { readonly meta: unknown; readonly metaBytes: number; readonly targetRevision: number }
  /**
   * Append one accepted `tool/call` (the step the agent loop performs before
   * dispatch).
   * @param callId - the call id.
   * @param name - the tool name.
   * @param argsText - the serialized arguments envelope.
   * @returns the accepted call event's seq.
   */
  beginCall(callId: string, name: string, argsText: string): Promise<{ readonly seq: number }>
  /**
   * Append one successful `tool/result` carrying the meta (the fold + durable
   * append is the serial commit segment).
   * @param callSeq - the accepted call's seq (the citation).
   * @param callId - the call id.
   * @param meta - the durable meta record.
   */
  settleResult(callSeq: number, callId: string, meta: unknown): Promise<void>
  /**
   * Settle one call as the structured failure it became: the error result
   * carries no map-change meta, so the fold consumes the pending entry and
   * the accepted map stands exactly as it was.
   * @param callSeq - the accepted call's seq (the citation).
   * @param callId - the call id.
   */
  settleError(callSeq: number, callId: string): Promise<void>
  /** The accepted projection state (plain JSON). */
  acceptedState(): unknown
  /** The derived client-visible display view (wire face). */
  displayView(): unknown
  /**
   * The cold projection replay: fold the session's recorded events from zero
   * through the production projection definition (cache-miss recovery).
   */
  coldReplay(): unknown
  /** The durability checkpoint barrier. */
  flush(): Promise<boolean>
}

/** The catalog port: the transactional registration/resolution/publication ladder. */
export interface PerfCatalogPort {
  /**
   * Validate one candidate payload structurally (the admission walk).
   * @param bytes - the exact payload bytes.
   * @returns the admitted feature and coordinate counts.
   */
  admit(bytes: Uint8Array): { readonly featureCount: number; readonly coordinateCount: number }
  /**
   * Copy, validate, digest, and publish one immutable resource version in one
   * transaction.
   */
  register(input: { readonly name: string; readonly bytes: Uint8Array; readonly sessionId: string; readonly callSeq: number }): { readonly ref: string; readonly featureCount: number }
  /**
   * Resolve one exact ref into its frozen bundle and feature identities.
   */
  resolve(ref: string): { readonly featureRefs: readonly { readonly featureIndex: number; readonly featureRef: string }[] }
  /** Read one version's stored bytes after authorization and digest verification. */
  readBytes(ref: string): Uint8Array
  /** Stage, validate, and publish one immutable analysis artifact. */
  publishArtifact(input: { readonly bytes: Uint8Array; readonly inputRefs: readonly string[]; readonly sessionId: string; readonly callSeq: number }): { readonly ref: string }
}

/** The worker-cancel port: one paced scan whose cancellation settles to quiescence. */
export interface PerfCancelPort {
  /**
   * Submit a paced scan, wait for its first progress point, cancel, and wait
   * for the real settlement (child exit, no staged residue). The `wait`
   * parameter measures exactly the cancel-request → quiescence span.
   */
  pacedScanAndCancel(wait: <T>(until: Promise<T>) => Promise<T>): Promise<{
    /** The worker protocol's final status (must be the cancelled outcome). */
    readonly status: string
    /** Progress chunks completed before the cancel landed. */
    readonly chunksDoneBeforeCancel: number
    /** Whether the runner's staging area is empty after settlement. */
    readonly stagingClean: boolean
  }>
}

/** Everything one benchmark run drives. */
export interface PerfPorts {
  /** The session the locate/visibility and two-point-chain workloads fold. */
  readonly main: PerfSessionPort
  /** A fresh session the recovery workload builds and replays. */
  readonly recovery: PerfSessionPort
  readonly catalog: PerfCatalogPort
  readonly cancel: PerfCancelPort
}

/** One workload's raw outcome before the report assembles it. */
export interface PerfWorkloadRaw {
  readonly workload: PerfWorkloadId
  /** The per-repetition primary measurements (one entry per repetition). */
  readonly values: readonly number[]
  /** The deterministic aggregate — identical across runs; the report pins its digest. */
  readonly aggregate: unknown
  /** Run-specific identifiers (published refs); never digest-pinned. */
  readonly identity?: Readonly<Record<string, unknown>>
  /** The sampler's segmented records for this workload. */
  readonly summary: PerfSummary
}

/** The closed workload identifier union reused by workload consumers. */
export type { PerfWorkloadId } from './contract.ts'

/**
 * Run one repetition of the locate/visibility workload: fold every layer
 * once (add), then hide it, then show it — all through the real accepted-call
 * ladder — and derive the display view.
 */
async function runLocateVisibilityOnce(
  port: PerfSessionPort,
  sampler: PerfSampler,
  ledger: PerfBudgetLedger,
  workload: PerfWorkload,
  fixtures: PerfFixtures,
  repetition: number,
  onRepetition?: (repetition: number) => void,
): Promise<{ readonly foldsPerSecond: number }> {
  onRepetition?.(repetition)
  const rep = `r${repetition}`
  const repStart = process.hrtime.bigint()
  for (const [index, collection] of fixtures.locateLayers.entries()) {
    // One stable id per layer: re-adds replace, so repetitions never grow
    // past the container's layer capacity and every fold applies for real.
    const layerId = `locate-${index}`
    for (const visible of [true, false, true]) {
      const callId = `${layerId}-${rep}-${visible ? 'show' : 'hide'}`
      const argsText = sampler.sample('context', { workload: 'locate-visibility', stage: 'envelope', unit: 'ms' }, () =>
        JSON.stringify({ layerId, visible, features: collection.features.length }),
      )
      const call = await port.beginCall(callId, 'map_add_layer', argsText)
      const change = {
        op: 'add-layer',
        layer: {
          id: layerId,
          name: `locate ${index}`,
          data: collection,
          sourceCrs: 'EPSG:4326',
          opacity: 1,
          visible,
        },
      }
      const prepared = sampler.sample('compute', { workload: 'locate-visibility', stage: 'prepare', unit: 'ms' }, () =>
        port.prepareMutation(change, call.seq),
      )
      const dataBytes = sampler.bytesOf(collection)
      // Pre-commit admission: a spend that would cross a cumulative limit
      // refuses BEFORE the fold. The pending call settles as the structured
      // failure it became (no map-change meta), and the accepted map stands.
      try {
        ledger.admitOrThrow({
          sessionBytes: sampler.bytesOf(argsText) + prepared.metaBytes,
          metaBytes: prepared.metaBytes,
          projectionDeltaBytes: dataBytes,
          displayBytes: dataBytes,
          steps: 1,
        })
      } catch (error) {
        await port.settleError(call.seq, callId)
        throw error
      }
      await sampler.sampleAsync('commit', { workload: 'locate-visibility', stage: 'fold', unit: 'ms' }, () =>
        port.settleResult(call.seq, callId, prepared.meta),
      )
    }
  }
  sampler.sample('render', { workload: 'locate-visibility', stage: 'display', unit: 'ms' }, () => port.displayView())
  const repMs = Number(process.hrtime.bigint() - repStart) / 1e6
  const folds = workload.locateLayerCount * 3
  return { foldsPerSecond: round3((folds / repMs) * 1000) }
}

/** The locate/visibility workload's deterministic aggregate shape. */
export interface LocateAggregate {
  readonly folds: number
  /** How many revisions the run's folds advanced (run-independent identity). */
  readonly foldedRevisionDelta: number
  readonly layerCount: number
  readonly allVisible: boolean
}

/**
 * Run every repetition of the locate/visibility workload and check the final
 * state (every layer present, visible, folded through the real ladder).
 */
export async function runLocateVisibilityWorkload(
  port: PerfSessionPort,
  sampler: PerfSampler,
  ledger: PerfBudgetLedger,
  workload: PerfWorkload,
  fixtures: PerfFixtures,
  onRepetition?: (repetition: number) => void,
): Promise<PerfWorkloadRaw> {
  const startingRevision = (port.acceptedState() as { revision: number }).revision
  const values: number[] = []
  for (let repetition = 0; repetition < workload.repetitions; repetition++) {
    const once = await runLocateVisibilityOnce(port, sampler, ledger, workload, fixtures, repetition, onRepetition)
    values.push(once.foldsPerSecond)
  }
  const state = port.acceptedState() as { revision: number; layers: readonly { id: string; visible: boolean }[] }
  const layers = state.layers.filter(layer => layer.id.startsWith('locate-'))
  if (layers.length !== workload.locateLayerCount) {
    throw new Error(`locate workload: expected ${workload.locateLayerCount} folded layers, found ${layers.length}`)
  }
  if (!layers.every(layer => layer.visible)) {
    throw new Error('locate workload: a layer did not end visible — the show fold did not apply')
  }
  const folds = workload.repetitions * workload.locateLayerCount * 3
  const foldedRevisionDelta = state.revision - startingRevision
  if (foldedRevisionDelta !== folds) {
    throw new Error(`locate workload: ${folds} folds advanced the revision by ${foldedRevisionDelta} — a fold was refused or duplicated`)
  }
  const aggregate: LocateAggregate = {
    folds,
    foldedRevisionDelta,
    layerCount: layers.length,
    allVisible: true,
  }
  return { workload: 'locate-visibility', values, aggregate, summary: sampler.summary() }
}

/**
 * Run the parse/register workload: admit the frozen fixture (compute), then
 * publish it through the transactional registration ladder (commit), then
 * read the stored bytes back (scan).
 */
export async function runParseRegisterWorkload(
  catalog: PerfCatalogPort,
  sampler: PerfSampler,
  ledger: PerfBudgetLedger,
  workload: PerfWorkload,
  fixtures: PerfFixtures,
  sessionId: string,
  firstCallSeq: number,
  onRepetition?: (repetition: number) => void,
): Promise<PerfWorkloadRaw> {
  const values: number[] = []
  let coordinateSum = 0
  for (let repetition = 0; repetition < workload.repetitions; repetition++) {
    onRepetition?.(repetition)
    const admitted = sampler.sample('compute', { workload: 'parse-register', stage: 'admit', unit: 'ms' }, () =>
      catalog.admit(fixtures.parse.bytes),
    )
    if (admitted.featureCount !== workload.parseFeatureCount) {
      throw new Error(`parse fixture admitted ${admitted.featureCount} features, expected ${workload.parseFeatureCount}`)
    }
    coordinateSum += admitted.coordinateCount
    // The scan-rows spend is known from the admission walk, so the budget
    // check runs BEFORE the transactional publish — never as a rollback.
    ledger.admitOrThrow({ scanRows: admitted.featureCount, steps: 1 })
    const registerStart = process.hrtime.bigint()
    const registered = await sampler.sampleAsync('commit', { workload: 'parse-register', stage: 'publish', unit: 'ms' }, () =>
      Promise.resolve(catalog.register({
        name: `perf-parse-r${repetition}`,
        bytes: fixtures.parse.bytes,
        sessionId,
        callSeq: firstCallSeq + repetition,
      })),
    )
    const registerMs = Number(process.hrtime.bigint() - registerStart) / 1e6
    const stored = sampler.sample('scan', { workload: 'parse-register', stage: 'read-back', unit: 'ms' }, () =>
      catalog.readBytes(registered.ref),
    )
    if (stored.byteLength !== fixtures.parse.bytes.byteLength) {
      throw new Error('parse fixture read-back length differs from the registered bytes')
    }
    values.push(round3((admitted.featureCount / registerMs) * 1000))
  }
  return {
    workload: 'parse-register',
    values,
    aggregate: { featureCount: workload.parseFeatureCount, repetitions: workload.repetitions, coordinateSum },
    summary: sampler.summary(),
  }
}

/**
 * Run the spatial-op workload: per repetition, codec-encode the operation
 * request, run `spatialOpRepeats` buffer+area computations, codec-decode the
 * result shape.
 */
export async function runSpatialOpWorkload(
  sampler: PerfSampler,
  ledger: PerfBudgetLedger,
  workload: PerfWorkload,
  fixtures: PerfFixtures,
  bufferKilometers: number,
  onRepetition?: (repetition: number) => void,
): Promise<PerfWorkloadRaw> {
  const values: number[] = []
  let areaSum = 0
  for (let repetition = 0; repetition < workload.repetitions; repetition++) {
    onRepetition?.(repetition)
    const request = sampler.sample('mcp', { workload: 'spatial-op', stage: 'encode', unit: 'ms' }, () =>
      JSON.stringify({ distance: bufferKilometers, units: 'kilometers' }),
    )
    const parsed = JSON.parse(request) as { distance: number }
    const computeStart = process.hrtime.bigint()
    for (let op = 0; op < workload.spatialOpRepeats; op++) {
      const areaKm2 = sampler.sample('compute', { workload: 'spatial-op', stage: 'buffer-area', unit: 'ms' }, () => {
        const buffered = turfBuffer(fixtures.spatialOp.polygon as unknown as Parameters<typeof turfBuffer>[0], parsed.distance, { units: 'kilometers' })
        if (buffered === undefined || buffered === null) throw new Error('buffer produced no feature')
        return round6(turfArea(buffered as Parameters<typeof turfArea>[0]) / 1e6)
      })
      areaSum += areaKm2
    }
    const computeMs = Number(process.hrtime.bigint() - computeStart) / 1e6
    sampler.sample('mcp', { workload: 'spatial-op', stage: 'decode', unit: 'ms' }, () =>
      JSON.parse(JSON.stringify({ status: 'succeeded', repetition, areaSumKm2: round6(areaSum) })),
    )
    ledger.admitOrThrow({ timeMs: round3(computeMs), steps: workload.spatialOpRepeats })
    values.push(round3((workload.spatialOpRepeats / computeMs) * 1000))
  }
  return {
    workload: 'spatial-op',
    values,
    aggregate: { ops: workload.repetitions * workload.spatialOpRepeats, areaSum: round6(areaSum) },
    summary: sampler.summary(),
  }
}

/**
 * Run the recovery workload on its own session: fold `recoveryMutations`
 * accepted set-view mutations, flush to the durability barrier, then
 * cold-replay the recorded events and require the identical projection
 * state.
 */
export async function runRecoveryWorkload(
  port: PerfSessionPort,
  sampler: PerfSampler,
  ledger: PerfBudgetLedger,
  workload: PerfWorkload,
): Promise<PerfWorkloadRaw> {
  for (let index = 0; index < workload.recoveryMutations; index++) {
    const callId = `recovery-${index}`
    const view = { center: [round6(index * 0.5 - 5), round6(index * 0.25 - 2)], zoom: index % 8, wkid: 4326 }
    const argsText = JSON.stringify({ view })
    const call = await port.beginCall(callId, 'map_set_view', argsText)
    const prepared = port.prepareMutation({ op: 'set-view', view }, call.seq)
    ledger.admitOrThrow({ sessionBytes: sampler.bytesOf(argsText) + prepared.metaBytes, metaBytes: prepared.metaBytes, steps: 1 })
    await port.settleResult(call.seq, callId, prepared.meta)
  }
  const flushed = await sampler.wait('flush', { workload: 'recovery-replay', stage: 'barrier', unit: 'ms' }, port.flush())
  if (!flushed) throw new Error('recovery workload: the durability checkpoint had no listener')
  const liveState = port.acceptedState()
  const replayStart = process.hrtime.bigint()
  const replayed = sampler.sample('compute', { workload: 'recovery-replay', stage: 'cold-replay', unit: 'ms' }, () =>
    port.coldReplay(),
  )
  const replayMs = Number(process.hrtime.bigint() - replayStart) / 1e6
  if (JSON.stringify(replayed) !== JSON.stringify(liveState)) {
    throw new Error('recovery workload: the cold replay differs from the live projection state')
  }
  return {
    workload: 'recovery-replay',
    values: [round3(replayMs)],
    aggregate: { mutations: workload.recoveryMutations },
    summary: sampler.summary(),
  }
}

/** The two-point chain's deterministic aggregate shape. */
export interface ChainAggregate {
  readonly selectedFeatureIndex: number
  readonly bufferedAreaKm2: number
  readonly bufferLonMin: number
  /** How many revisions the chain's fold advanced (run-independent identity). */
  readonly foldedRevisionDelta: number
}

/**
 * Run the two-point chain (the audit's required P0b scenario): register the
 * two-point resource, resolve and read it back, select feature index 1 (the
 * SECOND point — selecting the first fails this workload's assertions),
 * buffer it, publish the artifact, fold the identified layer, flush, and
 * derive the display view.
 */
export async function runTwoPointChainWorkload(
  session: PerfSessionPort,
  catalog: PerfCatalogPort,
  sampler: PerfSampler,
  ledger: PerfBudgetLedger,
  fixtures: PerfFixtures,
  sessionId: string,
  callSeq: number,
  bufferKilometers: number,
): Promise<{ readonly wallMs: number; readonly aggregate: ChainAggregate; readonly artifactRef: string }> {
  const chainStart = process.hrtime.bigint()
  const startingRevision = (session.acceptedState() as { revision: number }).revision

  const admitted = sampler.sample('compute', { workload: 'two-point-chain', stage: 'admit', unit: 'ms' }, () =>
    catalog.admit(fixtures.twoPoint.bytes),
  )
  if (admitted.featureCount !== 2) throw new Error('two-point chain: the fixture must carry exactly two features')
  const registered = await sampler.sampleAsync('commit', { workload: 'two-point-chain', stage: 'register', unit: 'ms' }, () =>
    Promise.resolve(catalog.register({ name: 'perf-two-point', bytes: fixtures.twoPoint.bytes, sessionId, callSeq })),
  )
  const resolved = sampler.sample('scan', { workload: 'two-point-chain', stage: 'resolve', unit: 'ms' }, () =>
    catalog.resolve(registered.ref),
  )
  const stored = sampler.sample('scan', { workload: 'two-point-chain', stage: 'read-back', unit: 'ms' }, () =>
    catalog.readBytes(registered.ref),
  )
  // The audit's required selection: the SECOND feature, never the first.
  const selectedRef = resolved.featureRefs.find(ref => ref.featureIndex === 1)?.featureRef
  if (selectedRef === undefined) throw new Error('two-point chain: feature index 1 missing from the resolution')
  const collection = JSON.parse(Buffer.from(stored).toString('utf8')) as { features: { geometry: { coordinates: number[] } }[] }
  const second = collection.features[1]
  const secondLon = second?.geometry.coordinates[0]
  const secondLat = second?.geometry.coordinates[1]
  if (second === undefined || secondLon !== 10 || secondLat !== 0) {
    throw new Error('two-point chain: the second feature is not the [10, 0] point')
  }

  const requestText = JSON.stringify({ ref: `${registered.ref}+${selectedRef}`, distance: bufferKilometers })
  const parsed = JSON.parse(requestText) as { distance: number }
  const buffered = sampler.sample('compute', { workload: 'two-point-chain', stage: 'buffer', unit: 'ms' }, () => {
    const feature = turfBuffer(
      { type: 'Feature', geometry: { type: 'Point', coordinates: [secondLon, secondLat] }, properties: {} } as Parameters<typeof turfBuffer>[0],
      parsed.distance,
      { units: 'kilometers' },
    )
    if (feature === undefined || feature === null) throw new Error('two-point chain: buffer produced no feature')
    return feature
  })
  // turf 7's buffer may return the result wrapped in a FeatureCollection.
  const bufferedFeature = buffered.type === 'FeatureCollection' ? buffered.features[0] : buffered
  if (bufferedFeature === undefined || bufferedFeature === null) throw new Error('two-point chain: buffer produced no feature')
  const areaKm2 = round6(turfArea(bufferedFeature as Parameters<typeof turfArea>[0]) / 1e6)
  const polygonRing = (bufferedFeature.geometry as { coordinates: number[][][] }).coordinates[0]
  if (polygonRing === undefined) throw new Error('two-point chain: the buffered polygon has no outer ring')
  const bufferLonMin = round6(Math.min(...polygonRing.map(point => point[0] ?? Number.POSITIVE_INFINITY)))
  if (bufferLonMin < 9.9) {
    throw new Error('two-point chain: the buffered geometry does not sit on the second point — the first point was selected')
  }
  const artifactBytes = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [bufferedFeature] }), 'utf8')
  const published = await sampler.sampleAsync('commit', { workload: 'two-point-chain', stage: 'publish', unit: 'ms' }, () =>
    Promise.resolve(catalog.publishArtifact({
      bytes: artifactBytes,
      inputRefs: [`${registered.ref}+${selectedRef}`],
      sessionId,
      callSeq: callSeq + 1,
    })),
  )

  const displayCopy = { type: 'FeatureCollection', features: [bufferedFeature] }
  const dataBytes = sampler.bytesOf(displayCopy)
  const callId = 'two-point-chain-fold'
  const argsText = JSON.stringify({ layerId: 'two-point-chain', artifactRef: published.ref })
  const call = await sampler.sampleAsync('commit', { workload: 'two-point-chain', stage: 'accepted-call', unit: 'ms' }, () =>
    session.beginCall(callId, 'map_add_layer', argsText),
  )
  const layer = {
    id: 'two-point-chain',
    name: 'two-point chain',
    data: displayCopy,
    sourceCrs: 'EPSG:4326',
    opacity: 1,
    visible: true,
    resourceRef: registered.ref,
    artifactRef: published.ref,
    displayDigest: perfDigestOf(displayCopy),
  }
  const prepared = sampler.sample('compute', { workload: 'two-point-chain', stage: 'prepare', unit: 'ms' }, () =>
    session.prepareMutation({ op: 'add-layer', layer }, call.seq),
  )
  // Pre-commit admission over the whole chain's spend: the fold is the final
  // operation and refuses with the map unchanged when the chain crosses a
  // limit; the pending call settles as the structured failure first.
  try {
    ledger.admitOrThrow({
      sessionBytes: sampler.bytesOf(argsText) + prepared.metaBytes,
      metaBytes: prepared.metaBytes,
      projectionDeltaBytes: dataBytes,
      displayBytes: dataBytes,
      scanRows: admitted.featureCount,
      steps: 2,
    })
  } catch (error) {
    await session.settleError(call.seq, callId)
    throw error
  }
  await sampler.sampleAsync('commit', { workload: 'two-point-chain', stage: 'fold', unit: 'ms' }, () =>
    session.settleResult(call.seq, callId, prepared.meta),
  )
  const flushResult = await sampler.wait('flush', { workload: 'two-point-chain', stage: 'barrier', unit: 'ms' }, session.flush())
  if (!flushResult) throw new Error('two-point chain: the durability checkpoint had no listener')
  const view = sampler.sample('render', { workload: 'two-point-chain', stage: 'display', unit: 'ms' }, () => session.displayView())
  const wire = view as { layers: readonly { id: string; visible: boolean; artifactRef?: string }[] }
  const folded = wire.layers.find(candidate => candidate.id === 'two-point-chain')
  if (folded === undefined || !folded.visible || folded.artifactRef !== published.ref) {
    throw new Error('two-point chain: the identified layer did not fold visible with its artifact ref')
  }
  const state = session.acceptedState() as { revision: number }
  const foldedRevisionDelta = state.revision - startingRevision
  if (foldedRevisionDelta !== 1) {
    throw new Error(`two-point chain: the fold advanced the revision by ${foldedRevisionDelta}, expected exactly 1`)
  }
  const wallMs = Number(process.hrtime.bigint() - chainStart) / 1e6
  return {
    wallMs: round3(wallMs),
    aggregate: {
      selectedFeatureIndex: 1,
      bufferedAreaKm2: areaKm2,
      bufferLonMin,
      foldedRevisionDelta,
    },
    artifactRef: published.ref,
  }
}

/** Run one two-point chain pass and wrap it into the raw outcome shape. */
export async function runTwoPointChain(
  session: PerfSessionPort,
  catalog: PerfCatalogPort,
  sampler: PerfSampler,
  ledger: PerfBudgetLedger,
  workload: PerfWorkload,
  fixtures: PerfFixtures,
  sessionId: string,
  callSeq: number,
  bufferKilometers: number,
): Promise<PerfWorkloadRaw> {
  // Single-pass workload: the repetitions setting does not multiply the chain
  // (the catalog dedup returns the published versions on later passes).
  void workload
  const once = await runTwoPointChainWorkload(session, catalog, sampler, ledger, fixtures, sessionId, callSeq, bufferKilometers)
  return {
    workload: 'two-point-chain',
    values: [once.wallMs],
    aggregate: once.aggregate,
    identity: { artifactRef: once.artifactRef },
    summary: sampler.summary(),
  }
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6
}
