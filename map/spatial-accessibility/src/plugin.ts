/**
 * Node-half Cordis plugin (host plane): opens the durable accessibility run
 * store, registers the `spatialAccessibility` projection, and provides the
 * run service the `run_submit`/`run_get`/`run_cancel` tools resolve. The
 * store root is a required, validated config field. The network source is a
 * validated Config choice with exactly six configured ids — the controlled
 * lattice (default) and the Amap, Tianditu, Mapbox, Baidu, and Tencent adapters (each opt-in
 * through its provider id plus the credential environment variable its
 * `apiKeyEnv`/`accessTokenEnv` names). Each vendor block may also set an
 * optional `baseUrl` (TLS or mirror root); omission keeps the vendor protocol
 * constant. Any other provider id, a vendor choice without a resolvable
 * credential, or a `baseUrl` that is not an `http(s)` root without a trailing
 * slash, query, or userinfo, fails loud at load; nothing silently degrades to
 * another source. The credential value is resolved once from the environment,
 * held in memory only, and never enters config defaults, logs, error text,
 * network refs, or a `baseUrl`. Disposal waits for real worker quiescence
 * before the store closes.
 */
import { resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ACCESSIBILITY_METHOD_VERSION, type AccessibilitySpec } from './contract.ts'
import { AccessibilityError } from './errors.ts'
import { CONTROLLED_NETWORK_ID, createControlledNetworkProvider, type NetworkProvider } from './network.ts'
import { AMAP_NETWORK_ID, DEFAULT_AMAP_API_KEY_ENV, createAmapNetworkProvider } from './amap.ts'
import { DEFAULT_TIANDITU_API_KEY_ENV, TIANDITU_NETWORK_ID, createTiandituNetworkProvider } from './tianditu.ts'
import { DEFAULT_MAPBOX_ACCESS_TOKEN_ENV, MAPBOX_NETWORK_ID, createMapboxNetworkProvider } from './mapbox.ts'
import { BAIDU_NETWORK_ID, DEFAULT_BAIDU_API_KEY_ENV, createBaiduNetworkProvider } from './baidu.ts'
import { DEFAULT_TENCENT_API_KEY_ENV, TENCENT_NETWORK_ID, createTencentNetworkProvider } from './tencent.ts'
import { evaluateComparison } from './compare.ts'
import { computeCoverage } from './metrics.ts'
import { spatialAccessibilityProjectionDefinition } from './projection.ts'
import { AccessibilityRunService, openRunStore, type RunCompute } from './runs.ts'
import { SPATIAL_ACCESSIBILITY_SERVICE, type RunInputData, type RunSubmitSpecInput, type SpatialAccessibilityService } from './service.ts'

/** The network source ids this deployment configures; anything else fails loud at load. */
export const CONFIGURED_NETWORK_IDS: readonly string[] = [CONTROLLED_NETWORK_ID, AMAP_NETWORK_ID, TIANDITU_NETWORK_ID, MAPBOX_NETWORK_ID, BAIDU_NETWORK_ID, TENCENT_NETWORK_ID]

/**
 * Vendor root override: a non-empty `http://` or `https://` root with no
 * trailing slash, query, fragment, or userinfo. The negative lookahead rejects
 * `user:pass@` before the host; credentials enter only through the env reference.
 */
const VENDOR_BASE_URL = z.string().pattern(/^https?:\/\/(?![^/?#]*@)[^/?#\s]+$/)

/** Plugin config for the run store location and the network source. */
export interface AccessibilityPluginConfig {
  /** Store root directory holding the run database. Required. */
  root: string
  /** Network source id: the controlled lattice (default) or one of five vendor adapters. */
  provider?: string
  /** Amap adapter options; the credential is an environment-variable reference, never a value. */
  amap?: {
    /** Environment-variable name holding the API key; defaults to `AMAP_API_KEY`. */
    apiKeyEnv?: string
    /** Sampling-lattice spacing in degrees (service-area resolution and vendor-call volume). */
    spacingDeg?: number
    /** Per-request transport timeout in milliseconds (1000–60000). */
    timeoutMs?: number
    /** TLS or mirror root; omission keeps `https://restapi.amap.com`. */
    baseUrl?: string
  }
  /** Tianditu adapter options; the credential is an environment-variable reference, never a value. */
  tianditu?: {
    /** Environment-variable name holding the API key (`tk`); defaults to `TIANDITU_API_KEY`. */
    apiKeyEnv?: string
    /** Per-request transport timeout in milliseconds (1000–60000). */
    timeoutMs?: number
    /** TLS or mirror root; omission keeps the vendor `http://` protocol constant. */
    baseUrl?: string
  }
  /** Mapbox adapter options; the credential is an environment-variable reference, never a value. */
  mapbox?: {
    /** Environment-variable name holding the access token; defaults to `MAPBOX_ACCESS_TOKEN`. */
    accessTokenEnv?: string
    /** Per-request transport timeout in milliseconds (1000–60000). */
    timeoutMs?: number
    /** TLS or mirror root; omission keeps `https://api.mapbox.com`. */
    baseUrl?: string
  }
  /** Baidu adapter options; the credential is an environment-variable reference. */
  baidu?: {
    apiKeyEnv?: string
    spacingDeg?: number
    timeoutMs?: number
    baseUrl?: string
  }
  /** Tencent adapter options; the credential is an environment-variable reference. */
  tencent?: {
    apiKeyEnv?: string
    spacingDeg?: number
    timeoutMs?: number
    baseUrl?: string
  }
}

/** Loader config schema; validation failures fail the plugin at load. */
export const Config: z<AccessibilityPluginConfig> = z.object({
  root: z.string().required(),
  provider: z.string(),
  amap: z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_AMAP_API_KEY_ENV),
    spacingDeg: z.number().min(0.00001).max(1),
    timeoutMs: z.number().min(1000).max(60000),
    baseUrl: VENDOR_BASE_URL,
  }),
  tianditu: z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_TIANDITU_API_KEY_ENV),
    timeoutMs: z.number().min(1000).max(60000),
    baseUrl: VENDOR_BASE_URL,
  }),
  mapbox: z.object({
    accessTokenEnv: z.string().role('credential-ref').default(DEFAULT_MAPBOX_ACCESS_TOKEN_ENV),
    timeoutMs: z.number().min(1000).max(60000),
    baseUrl: VENDOR_BASE_URL,
  }),
  baidu: z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_BAIDU_API_KEY_ENV),
    spacingDeg: z.number().min(0.00001).max(1),
    timeoutMs: z.number().min(1000).max(60000),
    baseUrl: VENDOR_BASE_URL,
  }),
  tencent: z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_TENCENT_API_KEY_ENV),
    spacingDeg: z.number().min(0.00001).max(1),
    timeoutMs: z.number().min(1000).max(60000),
    baseUrl: VENDOR_BASE_URL,
  }),
})

/** The resolved network source one deployment run computes against. */
export type NetworkSourcePlan =
  | { readonly kind: 'controlled' }
  | {
    readonly kind: 'amap'
    /** The resolved key value; held in memory only — never logged, stored, or embedded in refs. */
    readonly apiKey: string
    /** The environment-variable name the key was resolved through (diagnostics may carry the name, never the value). */
    readonly apiKeyEnv: string
    readonly spacingDeg: number | undefined
    readonly timeoutMs: number | undefined
    /** Configured TLS or mirror root; undefined keeps the vendor protocol constant. */
    readonly baseUrl: string | undefined
  }
  | {
    readonly kind: 'tianditu'
    /** The resolved key value; held in memory only — never logged, stored, or embedded in refs. */
    readonly apiKey: string
    /** The environment-variable name the key was resolved through (diagnostics may carry the name, never the value). */
    readonly apiKeyEnv: string
    readonly timeoutMs: number | undefined
    /** Configured TLS or mirror root; undefined keeps the vendor protocol constant. */
    readonly baseUrl: string | undefined
  }
  | {
    readonly kind: 'mapbox'
    /** The resolved token value; held in memory only — never logged, stored, or embedded in refs. */
    readonly accessToken: string
    /** The environment-variable name the token was resolved through (diagnostics may carry the name, never the value). */
    readonly accessTokenEnv: string
    readonly timeoutMs: number | undefined
    /** Configured TLS or mirror root; undefined keeps the vendor protocol constant. */
    readonly baseUrl: string | undefined
  }
  | {
    readonly kind: 'baidu'
    readonly apiKey: string
    readonly apiKeyEnv: string
    readonly spacingDeg: number | undefined
    readonly timeoutMs: number | undefined
    readonly baseUrl: string | undefined
  }
  | {
    readonly kind: 'tencent'
    readonly apiKey: string
    readonly apiKeyEnv: string
    readonly spacingDeg: number | undefined
    readonly timeoutMs: number | undefined
    readonly baseUrl: string | undefined
  }

/**
 * Read one credential from the environment, failing loud when it is missing
 * or empty. The failure names the variable and states the refusal to fall
 * back; it never carries the value.
 * @param providerId - the configured network source being resolved.
 * @param envName - the environment-variable name.
 * @param env - the environment lookup.
 * @returns the non-empty credential value.
 */
function requireCredential(providerId: string, envName: string, env: Readonly<Record<string, string | undefined>>): string {
  const value = env[envName]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', `provider "${providerId}" requires the credential environment variable ${envName} to be set and non-empty at load; refusing to start without it or to fall back silently to "${CONTROLLED_NETWORK_ID}"`)
  }
  return value
}

/**
 * Resolve and validate the configured network source. The controlled lattice
 * is the default; each vendor id resolves its credential from the named
 * environment variable at load and fails loud when the variable is missing or
 * empty — the run never falls back to another source silently.
 * @param config - validated plugin config.
 * @param env - environment lookup; the process environment by default.
 * @returns the network source plan the plugin computes against.
 * @throws {AccessibilityError} `ACCESS_INVALID_INPUT` for an unconfigured
 *   provider id or a vendor source without a resolvable credential.
 */
export function resolveNetworkSource(config: AccessibilityPluginConfig, env: Readonly<Record<string, string | undefined>> = process.env): NetworkSourcePlan {
  const provider = config.provider ?? CONTROLLED_NETWORK_ID
  if (provider === CONTROLLED_NETWORK_ID) return { kind: 'controlled' }
  if (provider === AMAP_NETWORK_ID) {
    const apiKeyEnv = config.amap?.apiKeyEnv ?? DEFAULT_AMAP_API_KEY_ENV
    return { kind: 'amap', apiKey: requireCredential(provider, apiKeyEnv, env), apiKeyEnv, spacingDeg: config.amap?.spacingDeg, timeoutMs: config.amap?.timeoutMs, baseUrl: config.amap?.baseUrl }
  }
  if (provider === TIANDITU_NETWORK_ID) {
    const apiKeyEnv = config.tianditu?.apiKeyEnv ?? DEFAULT_TIANDITU_API_KEY_ENV
    return { kind: 'tianditu', apiKey: requireCredential(provider, apiKeyEnv, env), apiKeyEnv, timeoutMs: config.tianditu?.timeoutMs, baseUrl: config.tianditu?.baseUrl }
  }
  if (provider === MAPBOX_NETWORK_ID) {
    const accessTokenEnv = config.mapbox?.accessTokenEnv ?? DEFAULT_MAPBOX_ACCESS_TOKEN_ENV
    return { kind: 'mapbox', accessToken: requireCredential(provider, accessTokenEnv, env), accessTokenEnv, timeoutMs: config.mapbox?.timeoutMs, baseUrl: config.mapbox?.baseUrl }
  }
  if (provider === BAIDU_NETWORK_ID) {
    const apiKeyEnv = config.baidu?.apiKeyEnv ?? DEFAULT_BAIDU_API_KEY_ENV
    return { kind: 'baidu', apiKey: requireCredential(provider, apiKeyEnv, env), apiKeyEnv, spacingDeg: config.baidu?.spacingDeg, timeoutMs: config.baidu?.timeoutMs, baseUrl: config.baidu?.baseUrl }
  }
  if (provider === TENCENT_NETWORK_ID) {
    const apiKeyEnv = config.tencent?.apiKeyEnv ?? DEFAULT_TENCENT_API_KEY_ENV
    return { kind: 'tencent', apiKey: requireCredential(provider, apiKeyEnv, env), apiKeyEnv, spacingDeg: config.tencent?.spacingDeg, timeoutMs: config.tencent?.timeoutMs, baseUrl: config.tencent?.baseUrl }
  }
  throw new AccessibilityError('ACCESS_INVALID_INPUT', `provider "${config.provider}" is not configured in this deployment; the configured network sources are ${CONFIGURED_NETWORK_IDS.map(id => `"${id}"`).join(', ')}`)
}

/** Function-plugin name under the Loader. */
export const name = '@map-harness/spatial-accessibility'

/** Required host services: the session-projection registry this unit joins. */
export const inject: string[] = ['sessionProjections']

/**
 * Host plugin body: open the run store, register the run-submit pairing
 * projection, and provide the service for the process lifetime.
 * @param ctx - the host root context receiving the service.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: AccessibilityPluginConfig): void {
  const source = resolveNetworkSource(config)
  const store = openRunStore(resolvePath(config.root))
  const runService = new AccessibilityRunService(store)

  const service: SpatialAccessibilityService = {
    runs: runService,
    async submit(input) {
      const spec: AccessibilitySpec = {
        ...input.spec,
        networkRef: networkRefFor(input.spec),
        methodVersion: ACCESSIBILITY_METHOD_VERSION,
      } as AccessibilitySpec
      const compute = buildCompute(spec, input.data)
      return runService.submit({
        operationRef: input.operationRef,
        spec,
        buildCompute: () => compute,
      })
    },
    get(runId) {
      return runService.get(runId)
    },
    cancel(runId) {
      return runService.cancel(runId)
    },
    lookupByOperationRef(operationRef) {
      return runService.byOperationRef(operationRef)
    },
    pendingRunCallOf(session, callId) {
      const state = ctx.sessionProjections.stateOf(session, 'spatialAccessibility')
      if (state === undefined) {
        throw new Error('spatialAccessibility projection is not registered in this process')
      }
      return state.pendingCalls.find(pending => pending.callId === callId)
    },
    quiesce() {
      return runService.quiesce()
    },
  }

  ctx.effect(() => ctx.sessionProjections.register(spatialAccessibilityProjectionDefinition), '@map-harness/spatial-accessibility: projection')
  ctx.effect(() => {
    const unprovide = ctx.reflect.provide(SPATIAL_ACCESSIBILITY_SERVICE, service)
    return () => {
      void unprovide()
    }
  }, '@map-harness/spatial-accessibility: service')
  ctx.effect(() => {
    return async () => {
      // Real quiescence first: no worker may still publish after the store closes.
      await runService.quiesce()
      store.close()
    }
  }, '@map-harness/spatial-accessibility: store')

  /** The network version identity for one spec under the configured source. */
  function networkRefFor(spec: RunSubmitSpecInput): string {
    return providerFor(spec).networkRef
  }

  /** Build the configured provider for one spec's support extent. */
  function providerFor(spec: RunSubmitSpecInput | AccessibilitySpec): NetworkProvider {
    if (source.kind === 'amap') {
      return createAmapNetworkProvider({
        apiKey: source.apiKey,
        apiKeyEnv: source.apiKeyEnv,
        bbox: spec.analysisSupportExtent.bbox,
        ...(source.spacingDeg === undefined ? {} : { spacingDeg: source.spacingDeg }),
        ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
        ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
      })
    }
    if (source.kind === 'tianditu') {
      return createTiandituNetworkProvider({
        apiKey: source.apiKey,
        apiKeyEnv: source.apiKeyEnv,
        bbox: spec.analysisSupportExtent.bbox,
        ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
        ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
      })
    }
    if (source.kind === 'mapbox') {
      return createMapboxNetworkProvider({
        accessToken: source.accessToken,
        accessTokenEnv: source.accessTokenEnv,
        bbox: spec.analysisSupportExtent.bbox,
        ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
        ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
      })
    }
    if (source.kind === 'baidu') {
      return createBaiduNetworkProvider({
        apiKey: source.apiKey,
        apiKeyEnv: source.apiKeyEnv,
        bbox: spec.analysisSupportExtent.bbox,
        ...(source.spacingDeg === undefined ? {} : { spacingDeg: source.spacingDeg }),
        ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
        ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
      })
    }
    if (source.kind === 'tencent') {
      return createTencentNetworkProvider({
        apiKey: source.apiKey,
        apiKeyEnv: source.apiKeyEnv,
        bbox: spec.analysisSupportExtent.bbox,
        ...(source.spacingDeg === undefined ? {} : { spacingDeg: source.spacingDeg }),
        ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
        ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
      })
    }
    return createControlledNetworkProvider({ bbox: spec.analysisSupportExtent.bbox })
  }

  /** Bind the coverage computation (plus the candidate comparison inside the run) to one submit's data. */
  function buildCompute(spec: AccessibilitySpec, data: RunInputData): RunCompute {
    return async (checkpoints) => {
      const provider = providerFor(spec)
      const result = await computeCoverage(checkpoints, {
        spec,
        provider,
        population: data.population,
        facilities: data.facilities,
      })
      if ((spec.candidates?.length ?? 0) === 0) {
        return { outcome: result.outcome, result: { kind: 'coverage', evidence: result.evidence } }
      }
      const comparison = await evaluateComparison(checkpoints, {
        spec,
        population: data.population,
        facilities: data.facilities,
        provider,
      })
      return {
        outcome: result.outcome,
        result: { kind: 'coverage+comparison', evidence: result.evidence, comparison },
      }
    }
  }
}
