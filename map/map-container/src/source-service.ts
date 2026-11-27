/**
 * Activation-owned native source materialization and bounded resource service.
 * It retains no session selection state and exposes no transport record as a DTO.
 * @module @map-harness/map-container/source-service
 */
import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { brandString } from '@deepseek-ai/dsh-brand'
import { assertNever, deepFreeze } from '@deepseek-ai/dsh-util-values'
import { BasemapSourceId, sourceCompatibleWithView, type BasemapSource } from '@map-harness/map-layers'
import { admitSourceImage } from './source-image.ts'
import { SourceCatalogError } from './source-error.ts'
import { sourceImageEtag, sourceImageScopeKey, nativeSourceFingerprint } from './source-scope.ts'
import { createSourceCache, type SourceCache } from './source-cache.ts'
import { createSourceCachePolicy, type SourceCachePolicy } from './source-cache-policy.ts'
import { createSourceNetwork, type SourceNetwork, type SourceNetworkDependencies, type SourceNetworkResponse } from './source-network.ts'
import { metadataRequest, compileSourceResource, type SourceImagePlan, type SourceResourceView } from './source-resource.ts'
import { parseMapServerMetadata } from './source-mapserver.ts'
import { parseWmtsMetadata } from './source-wmts.ts'
import {
  PUBLIC_SOURCE_PRESETS,
  type NativeSourceEpoch,
  type PublicSourcePresetId,
  type SourceImageMime,
  type SourceRuntimeEpoch,
} from './source-render-protocol.ts'
import type {
  ControlledSourceRuntimeBinding,
  MapSourceService,
  PublicSourceRuntimeBinding,
  SourceResourceResult,
  SourceRuntimeBinding,
  SourceTransportHealth,
} from './source-service-protocol.ts'
import { canonicalMapSource, type ResolvedMapSource, type MapSourceCatalog } from './sources.ts'
import type { SourceNetworkRequest } from './source-network.ts'
import { createWaybackService, waybackReleaseOf, WAYBACK_ENDPOINT, WAYBACK_SOURCE_ID, type WaybackCoverage, type WaybackServiceReader, type WaybackViewport } from './wayback.ts'
import { parseWaybackCapabilities } from './wayback-capabilities.ts'
import { verifyWaybackRelease, type WaybackReleaseVerificationRequest } from './wayback-release-verification.ts'
import { viewEngineKey } from './view-policy.ts'
import type { MapViewRecord } from './registry.ts'

interface QueueOperation {
  readonly task: (signal: AbortSignal) => Promise<unknown>
  readonly controller: AbortController
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
  readonly timer: ReturnType<typeof setTimeout>
  readonly callerSignal?: AbortSignal
  readonly detachCaller: () => void
  running: boolean
  settled: boolean
}

type QueueSettlement =
  | { readonly kind: 'resolve'; readonly value: unknown }
  | { readonly kind: 'reject'; readonly error: unknown }

interface CachedImage {
  readonly body: Buffer
  readonly contentType: SourceImageMime
  readonly etag: string
  readonly policy: SourceCachePolicy
}

const UNKNOWN_HEALTH: SourceTransportHealth = Object.freeze({ kind: 'unknown' })

function cancelled(reason: 'deadline' | 'caller' | 'dispose'): SourceCatalogError {
  return new SourceCatalogError(reason === 'deadline' ? 'SOURCE_TIMEOUT' : 'SOURCE_CANCELLED')
}

type ResolvedNativeSource = ControlledSourceRuntimeBinding['native']

/** Inject an owned network for deterministic source-service tests. */
export interface MapSourceServiceDependencies extends SourceNetworkDependencies {
  readonly network?: SourceNetwork
}

function copyResolved(source: ResolvedMapSource): ResolvedMapSource {
  return Object.freeze({
    ...source,
    source: source.source,
    ...(source.wmts === undefined ? {} : { wmts: Object.freeze({ ...source.wmts }) }),
    ...(source.credential === undefined ? {} : { credential: Object.freeze({ ...source.credential }) }),
  })
}

function publicPreset(source: BasemapSource): PublicSourcePresetId | undefined {
  if (source.id === 'esri-world-imagery'
    || source.id === 'esri-world-boundaries-places'
    || source.id === 'osm-standard') return source.id as PublicSourcePresetId
  return undefined
}

function epoch<Value extends SourceRuntimeEpoch | NativeSourceEpoch>(): Value {
  return brandString<Value>(randomUUID())
}

function encodedNativeBytes(
  source: BasemapSource,
  runtimeEpoch: SourceRuntimeEpoch,
  nativeEpoch: NativeSourceEpoch,
  native: ResolvedNativeSource,
): number {
  const semantic = JSON.stringify({
    adapter: native.adapter,
    metadata: native.adapter === 'xyz' ? null : native.metadata,
    sourceId: source.id,
    configDigest: source.configDigest,
    runtimeEpoch,
    nativeEpoch,
  })
  return Buffer.byteLength(semantic, 'utf8')
}

function isTiandituHost(endpoint: string): boolean {
  const hostname = new URL(endpoint).hostname.toLowerCase().replace(/\.$/, '')
  return hostname === 'tianditu.gov.cn' || hostname.endsWith('.tianditu.gov.cn')
}

function hasControlledCredentials(source: ResolvedMapSource): boolean {
  return source.credential !== undefined
}

/**
 * Create one service activation with its own queue, native definitions,
 * transport health and bounded representation cache.
 * @param catalog - immutable deployment catalog and resolved network limits.
 * @param dependencies - optional operation-local resolver factory.
 * @param wayback - plugin-owned catalog and evidence reader, shared across source activations.
 * @returns source operations isolated to this activation.
 */
export function createMapSourceService(
  catalog: MapSourceCatalog,
  dependencies: MapSourceServiceDependencies = {},
  wayback: WaybackServiceReader = createWaybackService(),
): MapSourceService {
  const runtimeEpoch = brandString<SourceRuntimeEpoch>(randomUUID())
  const network = dependencies.network ?? createSourceNetwork(catalog.networkConfig, dependencies)
  const definitions = new Map<string, SourceRuntimeBinding>()
  const definitionKey = (source: BasemapSource): string => source.id === WAYBACK_SOURCE_ID
    ? `${source.id}:${source.configDigest}` : source.id
  const waybackDefinitionKeys: string[] = []
  const health = new Map<BasemapSourceId, SourceTransportHealth>()
  const imageCache: SourceCache<CachedImage> | undefined =
    catalog.networkConfig.cacheMaxBytes === 0 && catalog.networkConfig.cacheMaxEntries === 0
      ? undefined
      : createSourceCache(catalog.networkConfig.cacheMaxEntries, catalog.networkConfig.cacheMaxBytes)
  const queued: QueueOperation[] = []
  const running = new Set<QueueOperation>()
  const waybackReads = new AbortController()
  const waybackSignal = (signal?: AbortSignal): AbortSignal => signal === undefined
    ? waybackReads.signal : AbortSignal.any([waybackReads.signal, signal])
  let disposed = false

  const settle = (operation: QueueOperation, result: QueueSettlement): void => {
    if (operation.settled) return
    operation.settled = true
    clearTimeout(operation.timer)
    operation.detachCaller()
    if (result.kind === 'reject') operation.reject(result.error)
    else operation.resolve(result.value)
  }

  const abortOperation = (operation: QueueOperation, reason: 'deadline' | 'caller' | 'dispose'): void => {
    if (!operation.controller.signal.aborted) operation.controller.abort(reason)
    settle(operation, { kind: 'reject', error: cancelled(reason) })
    if (!operation.running) {
      const index = queued.indexOf(operation)
      if (index >= 0) queued.splice(index, 1)
      pump()
    }
  }

  const pump = (): void => {
    while (!disposed && running.size < catalog.networkConfig.maxConcurrentRequests) {
      const operation = queued.shift()
      if (operation === undefined) return
      if (operation.settled) continue
      operation.running = true
      running.add(operation)
      void operation.task(operation.controller.signal).then(
        value => {
          if (operation.controller.signal.aborted) {
            settle(operation, { kind: 'reject', error: cancelled(operation.controller.signal.reason === 'deadline' ? 'deadline' : 'caller') })
          } else settle(operation, { kind: 'resolve', value })
        },
        error => {
          if (operation.controller.signal.aborted) {
            settle(operation, { kind: 'reject', error: cancelled(operation.controller.signal.reason === 'deadline' ? 'deadline' : 'caller') })
          } else {
            settle(operation, { kind: 'reject', error })
          }
        },
      ).finally(() => {
        running.delete(operation)
        pump()
      })
    }
  }

  const runOwned = <Value>(signal: AbortSignal | undefined, task: (ownedSignal: AbortSignal) => Promise<Value>, budgetMs = catalog.networkConfig.requestTimeoutMs): Promise<Value> => {
    if (disposed) return Promise.reject(new SourceCatalogError('SOURCE_CANCELLED'))
    if (signal?.aborted) return Promise.reject(new SourceCatalogError('SOURCE_CANCELLED'))
    if (running.size >= catalog.networkConfig.maxConcurrentRequests
      && queued.length >= catalog.networkConfig.maxQueuedRequests) {
      return Promise.reject(new SourceCatalogError('SOURCE_LIMIT_EXCEEDED'))
    }
    const controller = new AbortController()
    let resolveCaller!: (value: Value) => void
    let rejectCaller!: (error: unknown) => void
    const result = new Promise<Value>((resolve, reject) => {
      resolveCaller = resolve
      rejectCaller = reject
    })
    let operation: QueueOperation
    const onCallerAbort = (): void => abortOperation(operation, 'caller')
    const timer = setTimeout(() => abortOperation(operation, 'deadline'), budgetMs)
    operation = {
      task,
      controller,
      resolve: value => resolveCaller(value as Value),
      reject: rejectCaller,
      timer,
      ...(signal === undefined ? {} : { callerSignal: signal }),
      detachCaller: () => signal?.removeEventListener('abort', onCallerAbort),
      running: false,
      settled: false,
    }
    signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (signal?.aborted) onCallerAbort()
    else {
      queued.push(operation)
      pump()
    }
    return result
  }

  const ensureActive = (signal?: AbortSignal): void => {
    if (disposed) throw new SourceCatalogError('SOURCE_CANCELLED')
    if (signal?.aborted) throw cancelled(signal.reason === 'deadline' ? 'deadline' : 'caller')
  }

  const resolveVerified = (source: BasemapSource): ResolvedMapSource => {
    if (disposed) throw new SourceCatalogError('SOURCE_CANCELLED')
    if (source.id === WAYBACK_SOURCE_ID) throw new SourceCatalogError('SOURCE_CHANGED')
    const resolved = catalog.resolvedSource(source.id, source.configDigest)
    if (!isDeepStrictEqual(canonicalMapSource(catalog, source), resolved.source)) throw new SourceCatalogError('SOURCE_CHANGED')
    return copyResolved(resolved)
  }

  const recordHealth = (sourceId: BasemapSourceId, status: SourceTransportHealth): void => {
    if (!disposed) health.set(sourceId, Object.freeze(status))
  }

  const expectedError = (error: unknown): error is SourceCatalogError => error instanceof SourceCatalogError
  const transportHealthError = (error: unknown): error is SourceCatalogError => expectedError(error)
    && !['SOURCE_CANCELLED', 'SOURCE_TIMEOUT', 'SOURCE_CHANGED', 'SOURCE_NOT_FOUND', 'SOURCE_NOT_CONFIGURED', 'SOURCE_READ_ONLY', 'SOURCE_POLICY_DENIED']
      .includes(error.code)

  const networkRead = async (
    input: SourceNetworkRequest,
    signal: AbortSignal,
  ): Promise<{ readonly response: SourceNetworkResponse; readonly startedAt: number }> => {
    ensureActive(signal)
    const startedAt = Date.now()
    const response = await network.request({ ...input, signal })
    ensureActive(signal)
    return { response, startedAt }
  }

  /**
   * Refuse official Wayback reads while the deployment disables the preset,
   * before any catalog, local, or metadata request can reach the network.
   */
  const assertWaybackEnabled = (): void => {
    if (catalog.descriptorOf(BasemapSourceId(WAYBACK_SOURCE_ID)).availability.kind === 'unavailable') {
      throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    }
  }

  const prepare = (input: BasemapSource, signal?: AbortSignal): Promise<SourceRuntimeBinding> => {
    if (input.id === WAYBACK_SOURCE_ID) return prepareWayback(input, signal)
    let resolved: ResolvedMapSource
    try {
      resolved = resolveVerified(input)
    } catch (error) {
      return Promise.reject(error)
    }
    return runOwned(signal, async ownedSignal => {
      ensureActive(ownedSignal)
      const source = resolved.source
      const existing = definitions.get(definitionKey(source))
      if (existing !== undefined) return existing

      const presetId = publicPreset(source)
      const preset = presetId === undefined ? undefined : PUBLIC_SOURCE_PRESETS[presetId]
      if (presetId !== undefined && preset !== undefined && preset.adapter === source.adapter
        && preset.url === resolved.endpoint && !hasControlledCredentials(resolved)) {
        const binding: PublicSourceRuntimeBinding = deepFreeze({
          transport: 'public-preset',
          runtimeEpoch,
          nativeEpoch: epoch<NativeSourceEpoch>(),
          source,
          presetId,
        })
        ensureActive(ownedSignal)
        definitions.set(definitionKey(source), binding)
        return binding
      }

      if (source.provider === 'tianditu' || isTiandituHost(resolved.endpoint)) {
        throw new SourceCatalogError('SOURCE_UNAVAILABLE')
      }

      let native: ResolvedNativeSource
      let actualMetadata = false
      try {
        switch (source.adapter) {
          case 'xyz':
            native = deepFreeze({ adapter: 'xyz', resolved })
            break
          case 'arcgis-mapserver':
          {
            const request = metadataRequest(resolved)
            if (request === null) throw new Error('native metadata adapter has no metadata request')
            actualMetadata = true
            const response = await networkRead({
              source: resolved,
              url: request.url,
              payload: request.payload,
            }, ownedSignal)
            if (response.response.status !== 200) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
            const metadata = deepFreeze(parseMapServerMetadata(source, response.response.body))
            native = deepFreeze({ adapter: 'arcgis-mapserver', resolved, metadata })
            break
          }
          case 'wmts': {
            const request = metadataRequest(resolved)
            if (request === null) throw new Error('native metadata adapter has no metadata request')
            if (resolved.wmts === undefined) throw new Error('resolved WMTS source has no configured selection')
            actualMetadata = true
            const response = await networkRead({
              source: resolved,
              url: request.url,
              payload: request.payload,
            }, ownedSignal)
            if (response.response.status !== 200) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
            const metadata = deepFreeze(parseWmtsMetadata(source, resolved.wmts, response.response.body))
            native = deepFreeze({ adapter: 'wmts', resolved, metadata })
            break
          }
          default:
            assertNever(source.adapter)
        }
        ensureActive(ownedSignal)
        if (actualMetadata) recordHealth(source.id, { kind: 'reachable' })
      } catch (error) {
        if (actualMetadata && !ownedSignal.aborted && !disposed && transportHealthError(error)) {
          recordHealth(source.id, { kind: 'failed', code: error.code })
        }
        throw error
      }

      ensureActive(ownedSignal)
      const current = definitions.get(definitionKey(source))
      if (current?.transport === 'controlled'
        && nativeSourceFingerprint(current.native) === nativeSourceFingerprint(native)) {
        return current
      }
      const nativeEpoch = epoch<NativeSourceEpoch>()
      if (encodedNativeBytes(source, runtimeEpoch, nativeEpoch, native) > catalog.networkConfig.maxMetadataBytes) {
        throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
      }
      const binding: ControlledSourceRuntimeBinding = deepFreeze({
        transport: 'controlled',
        runtimeEpoch,
        nativeEpoch,
        source,
        native,
      })
      ensureActive(ownedSignal)
      definitions.set(definitionKey(source), binding)
      return binding
    })
  }

  const prepareWayback = async (input: BasemapSource, signal?: AbortSignal): Promise<SourceRuntimeBinding> => {
    assertWaybackEnabled()
    const canonical = canonicalMapSource(catalog, input)
    const releaseId = waybackReleaseOf(input)
    if (releaseId === null) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    try {
      catalog.resolvedWaybackRelease(canonical)
    } catch (error) {
      if (!(error instanceof SourceCatalogError) || error.code !== 'SOURCE_UNAVAILABLE') throw error
      await wayback.waitForCatalog(waybackSignal(signal))
    }
    ensureActive(signal)
    const source = await catalog.verifyWaybackSource(canonical, signal)
    const release = catalog.resolvedWaybackRelease(source)
    return runOwned(signal, async ownedSignal => {
      ensureActive(ownedSignal)
      const existing = definitions.get(definitionKey(source))
      if (existing !== undefined) return existing
      const resolved: ResolvedMapSource = {
        source, endpoint: WAYBACK_ENDPOINT, allowPrivateNetwork: false, allowHttp: false,
        waybackRelease: releaseId,
      }
      let native: ResolvedNativeSource
      try {
        const response = await networkRead({
          source: resolved,
          url: new URL(`${WAYBACK_ENDPOINT}?SERVICE=WMTS&VERSION=1.0.0&REQUEST=GetCapabilities`),
          payload: 'xml',
        }, ownedSignal)
        if (response.response.status !== 200) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
        const metadata = parseWaybackCapabilities(response.response.body, release.releaseId, release.layerIdentifier)
        native = deepFreeze({ adapter: 'wmts', resolved, metadata })
        recordHealth(source.id, { kind: 'reachable' })
      } catch (error) {
        if (error instanceof SourceCatalogError && !['SOURCE_CANCELLED', 'SOURCE_TIMEOUT', 'SOURCE_CHANGED'].includes(error.code)) {
          recordHealth(source.id, { kind: 'failed', code: error.code })
        }
        throw error
      }
      ensureActive(ownedSignal)
      const current = definitions.get(definitionKey(source))
      if (current?.transport === 'controlled' && nativeSourceFingerprint(current.native) === nativeSourceFingerprint(native)) return current
      const nativeEpoch = epoch<NativeSourceEpoch>()
      if (encodedNativeBytes(source, runtimeEpoch, nativeEpoch, native) > catalog.networkConfig.maxMetadataBytes) {
        throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
      }
      const binding: ControlledSourceRuntimeBinding = deepFreeze({ transport: 'controlled', runtimeEpoch, nativeEpoch, source, native })
      const key = definitionKey(source)
      if (waybackDefinitionKeys.length >= 256) {
        const oldest = waybackDefinitionKeys.shift()
        if (oldest !== undefined) definitions.delete(oldest)
      }
      definitions.set(key, binding)
      waybackDefinitionKeys.push(key)
      return binding
    })
  }

  const admitWaybackRelease = async (
    hint: WaybackReleaseVerificationRequest,
    { mode, view }: { readonly mode: 'map' | 'scene'; readonly view: MapViewRecord },
    signal?: AbortSignal,
  ): Promise<BasemapSource> => {
    ensureActive(signal)
    assertWaybackEnabled()
    if (!catalog.list({ pageSize: 1 }).canChange) throw new SourceCatalogError('SOURCE_READ_ONLY')
    const expected = catalog.describeWaybackRelease({ ...hint, title: `World Imagery (Wayback ${hint.publishedAt})`, acquiredAt: null })
    if (!sourceCompatibleWithView(expected, { mode, wkid: viewEngineKey(view.wkid), zoom: view.zoom })) {
      throw new SourceCatalogError('SOURCE_COMBINATION_UNSUPPORTED')
    }
    try {
      return await catalog.verifyWaybackSource(expected, signal)
    } catch (error) {
      if (!(error instanceof SourceCatalogError) || !['SOURCE_NOT_FOUND', 'SOURCE_UNAVAILABLE'].includes(error.code)) throw error
    }
    const remember = wayback.rememberVerifiedRelease
    if (remember === undefined) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    return runOwned(signal, async ownedSignal => {
      const verified = await verifyWaybackRelease(hint, network, ownedSignal)
      ensureActive(ownedSignal)
      const descriptor = catalog.describeWaybackRelease(verified.release)
      remember(verified.release, descriptor.configDigest)
      return descriptor
    }, wayback.requestTimeoutMs)
  }

  const waybackResource = async (
    input: BasemapSource,
    nativeEpoch: NativeSourceEpoch,
    view: SourceResourceView,
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<SourceResourceResult> => {
    const source = input
    const found = definitions.get(definitionKey(source))
    if (found === undefined || found.nativeEpoch !== nativeEpoch || found.transport !== 'controlled') throw new SourceCatalogError('SOURCE_CHANGED')
    const binding = found
    if (!isDeepStrictEqual(binding.source, source)) throw new SourceCatalogError('SOURCE_CHANGED')
    return runOwned(signal, async ownedSignal => {
      ensureActive(ownedSignal)
      if (!isCurrentBinding(source, binding, nativeEpoch)) throw new SourceCatalogError('SOURCE_CHANGED')
      const plan = compileSourceResource(binding.native, Object.freeze({ wkid: view.wkid }), new URLSearchParams(query))
      if (plan.kind === 'metadata') {
        if (binding.native.adapter !== 'wmts') throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
        return { kind: 'wmts-metadata', metadata: binding.native.metadata, source }
      }
      return readImage(source, binding, nativeEpoch, plan, ownedSignal, () => {})
    })
  }

  const isCurrentBinding = (source: BasemapSource, binding: ControlledSourceRuntimeBinding, expectedEpoch: NativeSourceEpoch): boolean =>
    !disposed && definitions.get(definitionKey(source)) === binding && binding.nativeEpoch === expectedEpoch

  const imageResult = (entry: CachedImage): SourceResourceResult => ({
    kind: 'image',
    body: Buffer.from(entry.body),
    contentType: entry.contentType,
    etag: entry.etag,
    cacheControl: entry.policy.browserCacheControl(),
  })

  const imageValueBytes = (entry: CachedImage): number => entry.body.byteLength + entry.policy.bytes
    + Buffer.byteLength(JSON.stringify({ contentType: entry.contentType, etag: entry.etag }), 'utf8')

  const admittedImage = async (
    source: BasemapSource,
    binding: ControlledSourceRuntimeBinding,
    expectedEpoch: NativeSourceEpoch,
    plan: SourceImagePlan,
    key: string,
    response: SourceNetworkResponse,
    requestStartedAt: number,
    signal: AbortSignal,
  ): Promise<SourceResourceResult> => {
    const contentType = await admitSourceImage(response.body, response.contentType, plan)
    ensureActive(signal)
    if (!isCurrentBinding(source, binding, expectedEpoch)) throw new SourceCatalogError('SOURCE_CHANGED')
    const body = Buffer.from(response.body)
    const entry: CachedImage = Object.freeze({
      body,
      contentType,
      etag: sourceImageEtag(key, body),
      policy: createSourceCachePolicy(plan.url, response.cache, requestStartedAt),
    })
    if (entry.policy.storable) imageCache?.set(key, entry, imageValueBytes(entry))
    else imageCache?.delete(key)
    recordHealth(source.id, { kind: 'reachable' })
    return imageResult(entry)
  }

  const readImage = async (
    source: BasemapSource,
    binding: ControlledSourceRuntimeBinding,
    expectedEpoch: NativeSourceEpoch,
    plan: SourceImagePlan,
    signal: AbortSignal,
    transportStarted: () => void,
  ): Promise<SourceResourceResult> => {
    const key = sourceImageScopeKey(runtimeEpoch, expectedEpoch, source, plan)
    const prior = imageCache?.get(key)
    if (prior?.policy.isFresh()) {
      ensureActive(signal)
      if (!isCurrentBinding(source, binding, expectedEpoch)) throw new SourceCatalogError('SOURCE_CHANGED')
      return imageResult(prior)
    }
    const validators = prior?.policy.validators()
    const conditional = validators !== undefined && (validators.etag !== null || validators.lastModified !== null)
      ? validators
      : undefined
    transportStarted()
    const initial = await networkRead({
      source: binding.native.resolved,
      url: plan.url,
      payload: 'image',
      ...(conditional === undefined ? {} : { validators: conditional }),
    }, signal)
    if (!isCurrentBinding(source, binding, expectedEpoch)) throw new SourceCatalogError('SOURCE_CHANGED')
    if (initial.response.status === 200) {
      return admittedImage(source, binding, expectedEpoch, plan, key, initial.response, initial.startedAt, signal)
    }
    if (conditional === undefined || prior === undefined) throw new SourceCatalogError('SOURCE_UNAVAILABLE')

    const current = imageCache?.get(key)
    if (current !== undefined && current !== prior && current.policy.isFresh()) {
      ensureActive(signal)
      if (!isCurrentBinding(source, binding, expectedEpoch)) throw new SourceCatalogError('SOURCE_CHANGED')
      return imageResult(current)
    }
    if (current === prior) {
      const policy = prior.policy.revalidated(initial.response.cache, initial.startedAt)
      if (policy !== null) {
        ensureActive(signal)
        if (!isCurrentBinding(source, binding, expectedEpoch)) throw new SourceCatalogError('SOURCE_CHANGED')
        const entry: CachedImage = Object.freeze({ ...prior, policy })
        if (policy.storable) imageCache?.set(key, entry, imageValueBytes(entry))
        else imageCache?.delete(key)
        recordHealth(source.id, { kind: 'reachable' })
        return imageResult(entry)
      }
    }

    // A mismatched/evicted validator gets one unconditional read only.
    transportStarted()
    const retry = await networkRead({ source: binding.native.resolved, url: plan.url, payload: 'image' }, signal)
    if (!isCurrentBinding(source, binding, expectedEpoch)) throw new SourceCatalogError('SOURCE_CHANGED')
    if (retry.response.status !== 200) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    return admittedImage(source, binding, expectedEpoch, plan, key, retry.response, retry.startedAt, signal)
  }

  const resource = (
    input: BasemapSource,
    nativeEpoch: NativeSourceEpoch,
    view: SourceResourceView,
    query: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<SourceResourceResult> => {
    if (input.id === WAYBACK_SOURCE_ID) return waybackResource(input, nativeEpoch, view, query, signal)
    let resolved: ResolvedMapSource
    try {
      resolved = resolveVerified(input)
    } catch (error) {
      return Promise.reject(error)
    }
    const source = resolved.source
    const ownedView = Object.freeze({ wkid: view.wkid })
    const ownedQuery = new URLSearchParams(query)
    const found = definitions.get(definitionKey(source))
    if (found === undefined || found.nativeEpoch !== nativeEpoch) {
      return Promise.reject(new SourceCatalogError('SOURCE_CHANGED'))
    }
    if (found.transport !== 'controlled') return Promise.reject(new SourceCatalogError('SOURCE_RESOURCE_DENIED'))
    const binding = found

    return runOwned(signal, async ownedSignal => {
      ensureActive(ownedSignal)
      if (!isCurrentBinding(source, binding, nativeEpoch)) throw new SourceCatalogError('SOURCE_CHANGED')
      const plan = compileSourceResource(binding.native, ownedView, ownedQuery)
      let transportStarted = false
      try {
        const planKind = plan.kind
        switch (planKind) {
          case 'metadata': {
            const adapter = binding.native.adapter
            switch (adapter) {
              case 'arcgis-mapserver': {
                ensureActive(ownedSignal)
                if (!isCurrentBinding(source, binding, nativeEpoch)) throw new SourceCatalogError('SOURCE_CHANGED')
                return { kind: 'arcgis-metadata', metadata: binding.native.metadata.service }
              }
              case 'wmts': {
                ensureActive(ownedSignal)
                if (!isCurrentBinding(source, binding, nativeEpoch)) throw new SourceCatalogError('SOURCE_CHANGED')
                return { kind: 'wmts-metadata', metadata: binding.native.metadata, source }
              }
              case 'xyz':
                throw new Error('XYZ native source cannot produce a metadata plan')
              default:
                return assertNever(adapter)
            }
          }
          case 'image':
            return await readImage(source, binding, nativeEpoch, plan, ownedSignal, () => { transportStarted = true })
          default:
            return assertNever(planKind)
        }
      } catch (error) {
        if (transportStarted && !ownedSignal.aborted && !disposed && transportHealthError(error)) {
          recordHealth(source.id, { kind: 'failed', code: error.code })
        }
        throw error
      }
    })
  }

  const healthOf = (sourceId: BasemapSourceId): SourceTransportHealth =>
    disposed ? UNKNOWN_HEALTH : health.get(sourceId) ?? UNKNOWN_HEALTH

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    waybackReads.abort()
    for (const operation of [...queued, ...running]) abortOperation(operation, 'dispose')
    network.dispose()
    definitions.clear()
    waybackDefinitionKeys.length = 0
    imageCache?.clear()
    health.clear()
  }

  return Object.freeze({
    catalog,
    runtimeEpoch,
    waybackRequestTimeoutMs: wayback.requestTimeoutMs,
    verifySource(source: BasemapSource) {
      if (source.id !== WAYBACK_SOURCE_ID) {
        resolveVerified(source)
        return
      }
      catalog.verifyCachedWaybackSource(source)
    },
    prepare,
    waybackRelease: async (releaseId: number, signal?: AbortSignal): Promise<BasemapSource> => {
      ensureActive(signal)
      return catalog.waybackDescriptor(releaseId, signal)
    },
    admitWaybackRelease,
    waybackCatalog: async (query: { readonly cursor?: string; readonly pageSize?: number } = {}, signal?: AbortSignal): Promise<unknown> => {
      ensureActive(signal)
      assertWaybackEnabled()
      const pageSize = query.pageSize ?? 20
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
      const releases = wayback.listReleases(signal)
      const catalogDigest = createHash('sha256').update(JSON.stringify(releases.map(item => [item.releaseId, item.itemId, item.publishedAt, item.layerIdentifier]))).digest('hex')
      let cursor = 0
      if (query.cursor !== undefined) {
        if (query.cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
        const encoded = Buffer.from(query.cursor, 'base64url')
        if (encoded.toString('base64url') !== query.cursor) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
        let decoded: unknown
        try {
          decoded = JSON.parse(encoded.toString('utf8'))
        } catch (error) {
          if (error instanceof SyntaxError) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
          throw error
        }
        if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
        const value = decoded as { digest?: unknown; offset?: unknown }
        if (Object.keys(value).length !== 2 || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)
          || typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 1) {
          throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
        }
        if (value.digest !== catalogDigest) throw new SourceCatalogError('SOURCE_CHANGED')
        cursor = value.offset
      }
      if (cursor >= releases.length) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
      const selected = releases.slice(cursor, cursor + pageSize)
      return {
        schemaVersion: 1,
        releases: await Promise.all(selected.map(async release => ({ ...release, descriptor: await catalog.waybackDescriptor(release.releaseId, signal) }))),
        nextCursor: cursor + selected.length < releases.length
          ? Buffer.from(JSON.stringify({ digest: catalogDigest, offset: cursor + selected.length })).toString('base64url') : null,
      }
    },
    waybackLocal: async (point: { readonly lon: number; readonly lat: number }, zoom: number, signal?: AbortSignal): Promise<unknown> => {
      assertWaybackEnabled()
      // Direct callers skip the route-level request timer, so the whole local
      // evidence operation (catalog, local changes, two metadata reads) must
      // share one owned budget instead of each internal read resetting it. The
      // deployment's Wayback budget, not the unrelated resource timeout, owns
      // that total.
      return runOwned(signal, async ownedSignal => {
        const releases = await wayback.localChanges(point, zoom, ownedSignal)
        const evidence = releases.map(item => ({ ...item, metadataStatus: 'not-queried' as 'known' | 'unknown' | 'unavailable' | 'not-queried' }))
        for (const index of new Set([0, releases.length - 1])) {
          const item = releases[index]
          if (item === undefined) continue
          try {
            const local = await wayback.metadataAt(point, zoom, item.releaseId, ownedSignal)
            evidence[index] = local === null
              ? { ...item, metadataStatus: 'unknown' }
              : { ...local, metadataStatus: local.acquiredAt === null ? 'unknown' : 'known' }
          } catch (error) {
            if (ownedSignal.aborted) throw error
            if (!(error instanceof SourceCatalogError) || !['SOURCE_UNAVAILABLE', 'SOURCE_TIMEOUT'].includes(error.code)) throw error
            evidence[index] = { ...item, metadataStatus: 'unavailable' }
          }
        }
        return { schemaVersion: 1, point, zoom, coverage: 'sampled', releases: evidence }
      }, wayback.requestTimeoutMs)
    },
    waybackMetadata: async (point: { readonly lon: number; readonly lat: number }, zoom: number, releaseId: number, signal?: AbortSignal): Promise<unknown> => {
      assertWaybackEnabled()
      return wayback.metadataAt(point, zoom, releaseId, waybackSignal(signal))
    },
    waybackCoverage: async (
      viewport: WaybackViewport,
      zoom: number,
      releaseId: number,
      signal?: AbortSignal,
    ): Promise<WaybackCoverage> => {
      assertWaybackEnabled()
      return wayback.coverage(viewport, zoom, releaseId, waybackSignal(signal))
    },
    resource,
    healthOf,
    dispose,
  })
}
