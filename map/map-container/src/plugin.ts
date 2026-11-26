/**
 * Node-half Cordis plugin: registers the `mapContainer` session projection —
 * the authoritative map state — and provides `ctx.map` as the projection's
 * read face for the map tools. The browser half ships through
 * `exports["./client"]`.
 */
import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { z } from 'zod'
import type { CredentialProvider, CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LBS_KEYRING_SERVICE, vendorForRef,
  type LbsKeyringConsumerFace,
} from '@map-harness/lbs-keyring/contract'
import { BasemapSourceId, sourceCompatibleWithView, type BasemapSelection } from '@map-harness/map-layers'
import { MAP_CONTAINER_SERVICE, type MapContainerService } from './service.ts'
import { mapContainerProjectionDefinition } from './projection.ts'
import { DEFAULT_OBSERVATION_LIMITS, MAP_OBSERVATION_SERVICE, MAX_OBSERVATION_PENDING, createMapObservationService, registerObservationRoute, type MapObservationLimits } from './observation.ts'
import { DEFAULT_INTERACTION_LIMITS, MAP_INTERACTION_SERVICE, MAX_INTERACTION_LIMIT_BOUND, createMapInteractionService, registerInteractionRoute, type MapInteractionLimits } from './interaction.ts'
import { resolveMapUseBudget, type MapUseBudget } from './interaction-protocol.ts'
import { registerArtifactRoute, type ArtifactCatalog } from './artifact-route.ts'
import { registerChangeRoute } from './change-route.ts'
import { MAP_VIEWPORT_SERVICE, createMapViewportService, registerViewportRoute, type MapViewportService } from './viewport.ts'
import { createMapSourceCatalog, type MapSourceConfig } from './sources.ts'
import { createMapSourceService } from './source-service.ts'
import { registerMapSourceRoutes } from './source-route.ts'
import { SourceCatalogError, type SourceCatalogFailureCode } from './source-error.ts'
import { viewEngineKey } from './view-policy.ts'
import { createWaybackService, WAYBACK_SOURCE_ID, type WaybackService } from './wayback.ts'
import { WaybackOfficialTransport } from './wayback-transport.ts'
import type { WaybackComparison } from './wayback-comparison.ts'

/** Credential-reference grammar mirrored from `@deepseek-ai/dsh-credentials` (value helpers stay inlined here so the compiled SEA core requires no ESM package at load). */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** @returns whether a raw string could name a credential reference at all. */
function isCredentialRefName(value: string): boolean {
  return CREDENTIAL_REF_PATTERN.test(value)
}

/** @returns the same string branded as a {@link CredentialRef}; throws on an invalid name. */
function credentialRef(value: string): CredentialRef {
  if (!isCredentialRefName(value)) {
    throw new TypeError(`credential ref "${value}" must match ${String(CREDENTIAL_REF_PATTERN)}`)
  }
  return value as CredentialRef
}

/** The capture-policy deployment setting for visual observation. */
export type ObservationCapturePolicy = 'allow' | 'deny' | 'unverified'

/** Deployment-varying plugin config; observation policy and bounds resolve at load. */
export interface MapPluginConfig {
  /** Deployment source catalog settings; validated at host activation. */
  readonly sources?: MapSourceConfig
  readonly observation?: {
    /** Source-policy metadata; observation does not use it to grant or deny capture. */
    readonly capturePolicy?: ObservationCapturePolicy
    readonly maxBytes?: number
    readonly maxPixels?: number
    readonly maxDimension?: number
    readonly maxPending?: number
    readonly maxEarlyClaims?: number
    /** Optional deployment-authorized image route for text-only Sessions. */
    readonly vision?: {
      readonly provider: string
      readonly model: string
    }
  }
  readonly interaction?: {
    /** Optional maximum `map_use` attempts per trusted turn; absent means unlimited. */
    readonly maxActions?: number
    /** Optional maximum `map_observe` attempts per trusted turn; absent means unlimited. */
    readonly maxObservations?: number
    /** Optional per-turn wall-clock limit in milliseconds; absent means unlimited. */
    readonly maxElapsedMs?: number
    readonly maxPending?: number
    readonly maxEarlyClaims?: number
  }
  readonly wayback?: {
    readonly cacheTtlMs?: number
    readonly localCacheMaxEntries?: number
    readonly maxConcurrentRequests?: number
    readonly requestTimeoutMs?: number
  }
}

/** Loader config schema; an absent plugin config takes the defaults, and nonsensical values fail the plugin at load rather than clamp. */
export const Config = z.object({
  sources: z.unknown().optional(),
  observation: z.object({
    capturePolicy: z.union([z.literal('allow'), z.literal('deny'), z.literal('unverified')]).optional(),
    maxBytes: z.number().int().positive().optional(),
    maxPixels: z.number().int().positive().optional(),
    maxDimension: z.number().int().positive().optional(),
    maxPending: z.number().int().positive().max(MAX_OBSERVATION_PENDING).optional(),
    maxEarlyClaims: z.number().int().positive().max(MAX_OBSERVATION_PENDING).optional(),
    vision: z.object({
      provider: z.string().min(1).max(128),
      model: z.string().min(1).max(128),
    }).strict().optional(),
  }).optional(),
  interaction: z.object({
    maxActions: z.number().int().positive().optional(),
    maxObservations: z.number().int().positive().optional(),
    maxElapsedMs: z.number().int().positive().optional(),
    maxPending: z.number().int().positive().max(MAX_INTERACTION_LIMIT_BOUND).optional(),
    maxEarlyClaims: z.number().int().positive().max(MAX_INTERACTION_LIMIT_BOUND).optional(),
  }).optional(),
  wayback: z.object({
    cacheTtlMs: z.number().int().positive().max(86_400_000).optional(),
    localCacheMaxEntries: z.number().int().positive().max(256).optional(),
    maxConcurrentRequests: z.number().int().positive().max(16).optional(),
    requestTimeoutMs: z.number().int().positive().max(120_000).optional(),
  }).optional(),
}).optional()

/** The observation slice resolved from {@link MapPluginConfig}. */
export interface ResolvedObservationConfig extends MapObservationLimits {
  readonly capturePolicy: ObservationCapturePolicy
  readonly vision?: { readonly provider: string; readonly model: string }
}

/** The continuous map-use slice resolved from {@link MapPluginConfig}. */
export interface ResolvedInteractionConfig extends MapInteractionLimits {
  readonly budget: MapUseBudget
}

/**
 * Resolve and validate the observation config slice.
 * @param config - the raw plugin config, or `undefined` for defaults.
 * @returns the resolved config.
 * @throws on nonsensical limits (non-positive or non-integer).
 */
export function resolveObservationConfig(config: MapPluginConfig | undefined): ResolvedObservationConfig {
  const raw = config?.observation ?? {}
  const read = (value: number | undefined, fallback: number, bound?: number): number => {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved <= 0 || (bound !== undefined && resolved > bound)) {
      throw new Error(`map-container observation limit ${resolved} is not a positive integer${bound === undefined ? '' : ` within [1, ${bound}]`}`)
    }
    return resolved
  }
  const vision = raw.vision === undefined ? undefined : z.object({
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
  }).strict().parse(raw.vision)
  const policy = raw.capturePolicy ?? 'unverified'
  if (policy !== 'allow' && policy !== 'deny' && policy !== 'unverified') {
    throw new Error(`unknown observation capturePolicy ${String(raw.capturePolicy)}`)
  }
  return {
    capturePolicy: policy,
    ...(vision === undefined ? {} : { vision }),
    maxBytes: read(raw.maxBytes, DEFAULT_OBSERVATION_LIMITS.maxBytes),
    maxPixels: read(raw.maxPixels, DEFAULT_OBSERVATION_LIMITS.maxPixels),
    maxDimension: read(raw.maxDimension, DEFAULT_OBSERVATION_LIMITS.maxDimension),
    maxPending: read(raw.maxPending, DEFAULT_OBSERVATION_LIMITS.maxPending, MAX_OBSERVATION_PENDING),
    maxEarlyClaims: read(raw.maxEarlyClaims, DEFAULT_OBSERVATION_LIMITS.maxEarlyClaims, MAX_OBSERVATION_PENDING),
  }
}

/**
 * Resolve and validate the continuous map-use config slice.
 * @param config - the raw plugin config, or `undefined` for defaults.
 * @returns the resolved budget and registry bounds.
 * @throws on nonsensical limits.
 */
export function resolveInteractionConfig(config: MapPluginConfig | undefined): ResolvedInteractionConfig {
  const raw = config?.interaction ?? {}
  const read = (value: number | undefined, fallback: number, bound?: number): number => {
    const resolved = value ?? fallback
    if (!Number.isSafeInteger(resolved) || resolved <= 0 || (bound !== undefined && resolved > bound)) {
      throw new Error(`map-container interaction limit ${resolved} is not a positive integer${bound === undefined ? '' : ` within [1, ${bound}]`}`)
    }
    return resolved
  }
  return {
    maxPending: read(raw.maxPending, DEFAULT_INTERACTION_LIMITS.maxPending, MAX_INTERACTION_LIMIT_BOUND),
    maxEarlyClaims: read(raw.maxEarlyClaims, DEFAULT_INTERACTION_LIMITS.maxEarlyClaims, MAX_INTERACTION_LIMIT_BOUND),
    budget: resolveMapUseBudget(raw),
  }
}

/** Function-plugin name under the Loader. */
export const name = '@map-harness/map-container'

/** Required host services: the projection registry this unit registers on and reads through. */
export const inject: string[] = ['sessionProjections']

/**
 * Bind the live-viewport and local-evidence checks a persisted comparison
 * needs before the Session records it: the reported camera must still sit at
 * the queried point and zoom, and the official local changes for that point
 * must keep the submitted early/recent releases as its endpoints.
 * @param viewport - the live viewport registry the panel reports into.
 * @param wayback - the host Wayback service that owns local evidence.
 * @returns the route-time admission check, or a refusal code.
 */
export function admitWaybackComparison(
  viewport: Pick<MapViewportService, 'viewportOf'>,
  wayback: Pick<WaybackService, 'localChanges'>,
): (sessionId: string, pair: WaybackComparison, signal: AbortSignal) => Promise<SourceCatalogFailureCode | undefined> {
  return async (sessionId, pair, signal) => {
    try {
      const current = viewport.viewportOf(sessionId)
      if (current === undefined || current.mode !== 'map') return 'SOURCE_CHANGED'
      const [centerX, centerY] = current.center
      const center = current.wkid === 4326 ? { lon: centerX, lat: centerY }
        : [3857, 102100, 102113].includes(current.wkid) ? {
            lon: centerX / 6_378_137 * 180 / Math.PI,
            lat: (2 * Math.atan(Math.exp(centerY / 6_378_137)) - Math.PI / 2) * 180 / Math.PI,
          } : undefined
      if (center === undefined || Math.abs(center.lon - pair.point.lon) > 0.000_01
        || Math.abs(center.lat - pair.point.lat) > 0.000_01 || Math.abs(current.zoom - pair.zoom) > 0.000_01) return 'SOURCE_CHANGED'
      const local = await wayback.localChanges(pair.point, pair.zoom, signal)
      if (viewport.viewportOf(sessionId) !== current) return 'SOURCE_CHANGED'
      if (local.length < 2 || String(local[0]?.releaseId) !== pair.early.release.version
        || String(local.at(-1)?.releaseId) !== pair.recent.release.version) return 'SOURCE_CHANGED'
      return undefined
    } catch (error) {
      if (error instanceof SourceCatalogError) return error.code
      return 'SOURCE_UNAVAILABLE'
    }
  }
}

/**
 * Environment-reference names the source catalog resolves: each configured
 * credential binding's `env` field, plus every preset's `credentialRef` (which
 * names a binding and therefore contributes that binding's env). A changed
 * reference refreshes the catalog.
 * @param sources - the deployment source config.
 * @returns the deduplicated env-name set.
 */
export function sourceCredentialRefs(sources: MapSourceConfig | undefined): Set<string> {
  const refs = new Set<string>()
  const bindings = sources?.credentials ?? {}
  for (const binding of Object.values(bindings)) {
    if (typeof binding.env === 'string' && isCredentialRefName(binding.env)) refs.add(binding.env)
  }
  for (const spec of Object.values(sources?.presets ?? {})) {
    const binding = typeof spec.credentialRef === 'string' ? bindings[spec.credentialRef] : undefined
    if (binding !== undefined && isCredentialRefName(binding.env)) refs.add(binding.env)
  }
  return refs
}

/**
 * Synthesize the read-only environment the catalog resolves credentials
 * against: every declared seam value shadows the ambient layer, unset refs
 * fall through so the launch environment and `.env` layers still apply.
 * @param sources - the deployment source config.
 * @param env - the ambient environment the seam overlays.
 * @param credentials - the optional credential seam.
 * @returns the env view `createMapSourceCatalog` reads.
 */
export async function resolveSourceCredentialEnv(
  sources: MapSourceConfig | undefined,
  env: Readonly<Record<string, string | undefined>>,
  credentials: CredentialProvider | undefined,
  keyring?: LbsKeyringConsumerFace | undefined,
): Promise<Readonly<Record<string, string | undefined>>> {
  if (credentials === undefined && keyring === undefined) return env
  const overlay: Record<string, string | undefined> = { ...env }
  for (const name of sourceCredentialRefs(sources)) {
    const vendorId = vendorForRef(name)
    if (keyring !== undefined && vendorId !== undefined) {
      const selection = await keyring.select(vendorId)
      if (selection !== undefined) {
        overlay[name] = selection.value
        continue
      }
    }
    if (credentials === undefined) continue
    const resolved = await credentials.resolve(credentialRef(name))
    if (resolved !== undefined) overlay[name] = resolved.value
  }
  return overlay
}

/**
 * Register the authoritative map projection and source services. Only hosts with a
 * Harness home start the enabled Wayback catalog sync.
 * @param ctx - the host root context receiving the service.
 * @param config - optional deployment settings; omission uses plugin defaults.
 * @returns when projection registration and service publication are ready.
 */
export async function apply(ctx: Context, config?: MapPluginConfig): Promise<void> {
  const observationConfig = resolveObservationConfig(config)
  const interactionConfig = resolveInteractionConfig(config)
  const credentials = ctx.get('credentials', false)
  const keyring: LbsKeyringConsumerFace | undefined = ctx.get(LBS_KEYRING_SERVICE, false)

  const buildSourceServices = async (): Promise<{
    catalog: ReturnType<typeof createMapSourceCatalog>
    service: ReturnType<typeof createMapSourceService>
  }> => {
    const env = await resolveSourceCredentialEnv(config?.sources, process.env, credentials, keyring)
    const catalog = createMapSourceCatalog(config?.sources, observationConfig.capturePolicy, env, wayback)
    return { catalog, service: createMapSourceService(catalog, {}, wayback) }
  }

  let officialTransport: WaybackOfficialTransport | undefined
  let networkConfig: ReturnType<typeof createMapSourceCatalog>['networkConfig'] | undefined
  const wayback = createWaybackService({
    ...config?.wayback,
    // Coverage fans out five metadata reads; never exceed the source
    // transport's concurrency cap, or a serial deployment rejects four of them.
    sampleConcurrency: () => networkConfig?.maxConcurrentRequests ?? 1,
    coreFactory: () => {
      if (networkConfig === undefined) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
      officialTransport ??= new WaybackOfficialTransport(networkConfig, {
        ...(config?.wayback?.requestTimeoutMs === undefined ? {} : { operationTimeoutMs: config.wayback.requestTimeoutMs }),
      })
      return officialTransport
    },
    coreDispose: () => officialTransport?.dispose() ?? Promise.resolve(),
  })
  const initialSources = await buildSourceServices()
  let sourceCatalog = initialSources.catalog
  let sourceService = initialSources.service
  networkConfig = sourceCatalog.networkConfig
  let sourceRouteDispose: (() => Promise<void>) | undefined
  let disposingSources = false
  ctx.effect(() => async () => {
    disposingSources = true
    try {
      await sourceService.dispose()
    } finally {
      await wayback.dispose()
    }
  }, '@map-harness/map-container: source service and Wayback sync')
  const homePath: ((...segments: string[]) => string) | undefined = ctx.get('dshHomePath', false)
  if (homePath !== undefined && sourceCatalog.descriptorOf(BasemapSourceId(WAYBACK_SOURCE_ID)).availability.kind === 'configured') {
    wayback.startCatalogSync(homePath('cache', 'map', 'wayback-catalog.sqlite'), (stage, error) => {
      const code = error instanceof SourceCatalogError ? error.code
        : error instanceof Error && 'code' in error && typeof error.code === 'string' && /^[A-Z0-9_]+$/.test(error.code) ? error.code
          : error instanceof SyntaxError ? 'INVALID_JSON' : 'INVALID_CATALOG_STORE'
      process.stderr.write(`map-container: Wayback catalog ${stage} failed (${code})\n`)
    })
  }
  const disposeSourceServiceProvider = ctx.reflect.provide('mapSourceService', sourceService)
  ctx.effect(() => () => { void disposeSourceServiceProvider() }, '@map-harness/map-container: source service provider')

  /**
   * Rebuild the source catalog and its service when a referenced credential
   * changes, so a key stored through a configuration surface flips the source
   * from `missing-credential` to `configured` without a restart. The previous
   * activation's in-flight requests are cancelled once its routes are gone;
   * the next prepare/read lands on the rebuilt one.
   * @param ref - the reference the Host reports as changed.
   */
  const refreshSourcesForCredential = async (ref: CredentialRef): Promise<void> => {
    const declared = sourceCredentialRefs(config?.sources)
    const vendorId = vendorForRef(ref)
    const slotChanged = keyring !== undefined && vendorId !== undefined
      && [...declared].some(name => vendorForRef(name) === vendorId)
    if (!declared.has(ref) && !slotChanged) return
    try {
      const next = await buildSourceServices()
      if (disposingSources) {
        await next.service.dispose()
        return
      }
      if (sourceRouteDispose !== undefined) void sourceRouteDispose()
      let nextRoute: (() => Promise<void>) | undefined
      try {
        nextRoute = registerMapSourceRoutes(ctx, next.service)
      } catch (error: unknown) {
        void next.service.dispose()
        sourceRouteDispose = registerMapSourceRoutes(ctx, sourceService)
        throw error
      }
      const previous = sourceService
      sourceCatalog = next.catalog
      sourceService = next.service
      networkConfig = next.catalog.networkConfig
      sourceRouteDispose = nextRoute
      ctx.reflect.set('mapSourceService', sourceService)
      void previous.dispose()
    } catch (error: unknown) {
      ctx.logger.warn('map-container: credential refresh left the source catalog unchanged', error)
    }
  }
  ctx.effect(
    () => ctx.on('credentials/reference-updated', (ref: CredentialRef) => { void refreshSourcesForCredential(ref) }),
    '@map-harness/map-container: credential refresh',
  )
  const projection = await ctx.sessionProjections.register(mapContainerProjectionDefinition)
  const service: MapContainerService = {
    stateOf(session) {
      return projection.stateOf(session)
    },
    pendingCallOf(session, callId) {
      return service.stateOf(session).pendingCalls.find(pending => pending.callId === callId)
    },
    interactionOf(session) {
      return projection.stateOf(session).interaction
    },
  }
  const dispose = ctx.reflect.provide(MAP_CONTAINER_SERVICE, service)
  ctx.effect(() => () => { void dispose() }, '@map-harness/map-container: service')
  // Visual observation: the claim/submit registry resolved from the plugin
  // config, plus, when the host Connection is mounted, the client route.
  const observation = createMapObservationService(observationConfig)
  ctx.effect(() => () => observation.dispose(), '@map-harness/map-container: observation registry')
  const disposeObservation = ctx.reflect.provide(MAP_OBSERVATION_SERVICE, observation)
  if (observationConfig.vision !== undefined) {
    const route = observationConfig.vision
    const reserved = new Map<string, string>()
    const childGuards = new Set<() => void>()
    ctx.on('agent/created', ({ agent }) => {
      const parent = reserved.get(agent.id)
      if (parent === undefined) return
      if (agent.session.header.parentSession !== parent || agent.session.header.origin !== 'subagent') {
        throw new Error('map vision child does not match its reserved parent')
      }
      const tools = agent.ctx.get('tools')
      if (tools === undefined) throw new Error('map vision child requires a scoped tool guard')
      const removeGuard = agent.ctx.effect(() => tools.guard(() => 'Map visual analysis does not execute tools.'), 'map vision child tool guard')
      childGuards.add(removeGuard)
      agent.ctx.effect(() => () => { childGuards.delete(removeGuard) }, 'map vision child guard owner')
    })
    // The projection state is schema-validated on apply; absence (null/undefined) means no authorized route.
    const unprovide = ctx.reflect.provide('mapVisionAuthorization', {
      allowed(session: import('@deepseek-ai/dsh-session').Session, provider: string, model: string): boolean {
        const routes = ctx.sessionProjections.stateOf(session, 'subagentModelSelectionPolicy')
        return provider === route.provider && model === route.model
          && Array.isArray(routes) && routes.some(entry => entry.provider === provider && entry.model === model)
      },
      reserve(childId: string, parentId: string): () => void {
        if (reserved.has(childId)) throw new Error('duplicate map vision child')
        reserved.set(childId, parentId)
        return () => { reserved.delete(childId) }
      },
    })
    ctx.effect(() => () => {
      for (const removeGuard of childGuards) removeGuard()
      childGuards.clear()
      reserved.clear()
      void unprovide()
    }, '@map-harness/map-container: vision authorization')
  }
  ctx.effect(() => () => { void disposeObservation() }, '@map-harness/map-container: observation service')
  // Continuous map use: per-turn budget projection, fence registry, and route.
  const interaction = createMapInteractionService(interactionConfig)
  ctx.effect(() => () => interaction.dispose(), '@map-harness/map-container: interaction registry')
  const disposeInteraction = ctx.reflect.provide(MAP_INTERACTION_SERVICE, interaction)
  ctx.effect(() => () => { void disposeInteraction() }, '@map-harness/map-container: interaction service')
  const disposeInteractionConfig = ctx.reflect.provide('mapInteractionConfig', interactionConfig)
  ctx.effect(() => () => { void disposeInteractionConfig() }, '@map-harness/map-container: interaction config')
  const disposeObservationConfig = ctx.reflect.provide('mapObservationConfig', observationConfig)
  ctx.effect(() => () => { void disposeObservationConfig() }, '@map-harness/map-container: observation config')
  // The Connection service may mount or be REPLACED after this plugin (the
  // web host composes it late, and a replaced connection carries a fresh
  // route table). Re-register on every (re)mount: dispose the previous
  // registration first so exactly one live route exists at any time.
  let routeDispose = registerObservationRoute(ctx, observation, observationConfig)
  let interactionRouteDispose = registerInteractionRoute(ctx, interaction)
  // Live viewport: what the user currently sees, read into the next request's context.
  const viewport = createMapViewportService()
  const disposeViewport = ctx.reflect.provide(MAP_VIEWPORT_SERVICE, viewport)
  ctx.effect(() => () => { void disposeViewport() }, '@map-harness/map-container: viewport service')
  let viewportDispose = registerViewportRoute(ctx, viewport)
  // Artifact download: the catalog-backed GET route needs BOTH the Connection
  // (registered below) and the spatial catalog service; either may mount or be
  // replaced after this plugin, so re-register on both.
  const registerArtifact = (): (() => Promise<void>) | undefined => {
    const catalog = ctx.get('spatialCatalog', false) as ArtifactCatalog | undefined
    return catalog === undefined ? undefined : registerArtifactRoute(ctx, catalog)
  }
  let artifactDispose = registerArtifact()
  // User changes: the panel's direct write path; needs the Connection and the
  // session controller, either of which may mount after this plugin.
  const verifySourceSelection = async (
    state: ReturnType<MapContainerService['stateOf']>,
    selection: BasemapSelection,
    signal: AbortSignal,
  ): Promise<SourceCatalogFailureCode | undefined> => {
    if (!sourceCatalog.list({ pageSize: 1 }).canChange) return 'SOURCE_READ_ONLY'
    const resolved = sourceCatalog.selection(selection.basemap.id, selection.labels?.id ?? null)
    if (selection.basemap.id !== WAYBACK_SOURCE_ID) {
      if (!resolved.ok) return resolved.code
      if (!isDeepStrictEqual(resolved.value, selection)) return 'SOURCE_CHANGED'
    } else {
      try {
        await sourceCatalog.waybackSelection(selection.basemap, signal)
        if (selection.labels !== null) return 'SOURCE_COMBINATION_UNSUPPORTED'
      } catch (error) {
        if (error instanceof SourceCatalogError) return error.code
        return 'SOURCE_UNAVAILABLE'
      }
    }
    const view = {
      mode: state.mode,
      wkid: viewEngineKey(state.view.wkid),
      zoom: state.view.zoom,
    }
    for (const source of [selection.basemap, selection.labels]) {
      if (source !== null && !sourceCompatibleWithView(source, view)) return 'SOURCE_COMBINATION_UNSUPPORTED'
    }
    return undefined
  }
  const admitBasemap = async (
    state: ReturnType<MapContainerService['stateOf']>,
    selection: BasemapSelection,
    signal: AbortSignal,
  ): Promise<SourceCatalogFailureCode | undefined> => {
    const refusal = await verifySourceSelection(state, selection, signal)
    if (refusal !== undefined) return refusal
    try {
      await sourceService.prepare(selection.basemap, signal)
      if (selection.labels !== null) await sourceService.prepare(selection.labels, signal)
    } catch (error) {
      if (error instanceof SourceCatalogError) return error.code
      return 'SOURCE_UNAVAILABLE'
    }
    return undefined
  }
  const registerChange = (): (() => Promise<void>) | undefined => registerChangeRoute(
    ctx,
    session => service.stateOf(session),
    admitBasemap,
    admitWaybackComparison(viewport, wayback),
    (state, source, signal) => verifySourceSelection(state, { schemaVersion: 1, basemap: source, labels: null }, signal),
  )
  let changeDispose = registerChange()
  sourceRouteDispose = registerMapSourceRoutes(ctx, sourceService)
  const offListener = ctx.on('internal/service', (name: string, value: unknown) => {
    if (value === undefined) return
    if (name === 'connection') {
      if (routeDispose !== undefined) void routeDispose()
      routeDispose = registerObservationRoute(ctx, observation, observationConfig)
      if (interactionRouteDispose !== undefined) void interactionRouteDispose()
      interactionRouteDispose = registerInteractionRoute(ctx, interaction)
      if (viewportDispose !== undefined) void viewportDispose()
      viewportDispose = registerViewportRoute(ctx, viewport)
      if (artifactDispose !== undefined) void artifactDispose()
      artifactDispose = registerArtifact()
      if (changeDispose !== undefined) void changeDispose()
      changeDispose = registerChange()
      if (sourceRouteDispose !== undefined) void sourceRouteDispose()
      sourceRouteDispose = registerMapSourceRoutes(ctx, sourceService)
      return
    }
    if (name === 'sessionController') {
      if (changeDispose !== undefined) void changeDispose()
      changeDispose = registerChange()
      if (sourceRouteDispose !== undefined) void sourceRouteDispose()
      sourceRouteDispose = registerMapSourceRoutes(ctx, sourceService)
      return
    }
    if (name === 'spatialCatalog') {
      if (artifactDispose !== undefined) void artifactDispose()
      artifactDispose = registerArtifact()
    }
  })
  ctx.effect(() => async () => {
    offListener()
    if (routeDispose !== undefined) void routeDispose()
    if (interactionRouteDispose !== undefined) await interactionRouteDispose()
    if (viewportDispose !== undefined) void viewportDispose()
    if (artifactDispose !== undefined) void artifactDispose()
    if (changeDispose !== undefined) void changeDispose()
    if (sourceRouteDispose !== undefined) void sourceRouteDispose()
  }, '@map-harness/map-container: observation route')
}
