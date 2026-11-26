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
 * another source. The credential value is resolved for each run submission,
 * held in memory for that run only, and never enters config defaults, logs,
 * error text, network refs, or a `baseUrl`. Disposal waits for real worker quiescence
 * before the store closes.
 */
import { resolve as resolvePath } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, isCredentialRefName, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { ACCESSIBILITY_METHOD_VERSION, type AccessibilitySpec } from './contract.ts'
import { AccessibilityError } from './errors.ts'
import { CONTROLLED_NETWORK_ID, createControlledNetworkProvider, type NetworkProvider } from './network.ts'
import { AMAP_NETWORK_ID, DEFAULT_AMAP_API_KEY_ENV, createAmapNetworkProvider } from './amap.ts'
import { DEFAULT_TIANDITU_API_KEY_ENV, TIANDITU_NETWORK_ID, createTiandituNetworkProvider } from './tianditu.ts'
import { DEFAULT_TIANDITU_SDK_KEY_ENV, TIANDITU_SDK_NETWORK_ID, createTiandituSdkProvider } from './tianditu-sdk.ts'
import { DEFAULT_MAPBOX_ACCESS_TOKEN_ENV, MAPBOX_NETWORK_ID, createMapboxNetworkProvider } from './mapbox.ts'
import { BAIDU_NETWORK_ID, DEFAULT_BAIDU_API_KEY_ENV, createBaiduNetworkProvider } from './baidu.ts'
import { DEFAULT_TENCENT_API_KEY_ENV, TENCENT_NETWORK_ID, createTencentNetworkProvider } from './tencent.ts'
import { evaluateComparison } from './compare.ts'
import { computeCoverage } from './metrics.ts'
import { spatialAccessibilityProjectionDefinition } from './projection.ts'
import { AccessibilityRunService, openRunStore, type RunCompute } from './runs.ts'
import { SPATIAL_ACCESSIBILITY_SERVICE, type RunInputData, type RunSubmitSpecInput, type SpatialAccessibilityService } from './service.ts'
import {
  LBS_KEYRING_SERVICE, vendorForRef,
  type LbsKeyringConsumerFace,
} from '@map-harness/lbs-keyring/contract'

/** The network source ids this deployment configures; anything else fails loud at load. */
export const CONFIGURED_NETWORK_IDS: readonly string[] = [CONTROLLED_NETWORK_ID, AMAP_NETWORK_ID, TIANDITU_NETWORK_ID, TIANDITU_SDK_NETWORK_ID, MAPBOX_NETWORK_ID, BAIDU_NETWORK_ID, TENCENT_NETWORK_ID]

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
  /** Test-only vendor transport; production uses the vendor adapter's declared transport. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  /** Test-only browser seam for the SDK vendor adapter; production uses Playwright. */
  sdkBridge?: import('./tianditu-sdk.ts').SdkBrowserBridge
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
    /** Service-area lattice spacing in degrees (0.00001–1); construction refuses lattices above the node ceiling. */
    spacingDeg?: number
    /** Per-request transport timeout in milliseconds (1000–60000). */
    timeoutMs?: number
    /** TLS or mirror root; omission keeps the vendor `http://` protocol constant. */
    baseUrl?: string
  }
  /** Tianditu SDK adapter options; the credential is an environment-variable reference, never a value. */
  tiandituSdk?: {
    /** Environment-variable name holding the browser-end key; defaults to `TIANDITU_SDK_KEY`. */
    apiKeyEnv?: string
    /** Per-drive wall budget in milliseconds (1000–120000). */
    timeoutMs?: number
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
  fetchImpl: z.any(),
  sdkBridge: z.any(),
  amap: z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_AMAP_API_KEY_ENV),
    spacingDeg: z.number().min(0.00001).max(1),
    timeoutMs: z.number().min(1000).max(60000),
    baseUrl: VENDOR_BASE_URL,
  }),
  tianditu: z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_TIANDITU_API_KEY_ENV),
    spacingDeg: z.number().min(0.00001).max(1),
    timeoutMs: z.number().min(1000).max(60000),
    baseUrl: VENDOR_BASE_URL,
  }),
  tiandituSdk: z.object({
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_TIANDITU_SDK_KEY_ENV),
    timeoutMs: z.number().min(1000).max(120000),
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
    readonly spacingDeg: number | undefined
    readonly timeoutMs: number | undefined
    /** Configured TLS or mirror root; undefined keeps the vendor protocol constant. */
    readonly baseUrl: string | undefined
  }
  | {
    readonly kind: 'tianditu-sdk'
    /** The resolved browser-end key value; held in memory only — never logged, stored, or embedded in refs. */
    readonly apiKey: string
    /** The environment-variable name the key was resolved through (diagnostics may carry the name, never the value). */
    readonly apiKeyEnv: string
    readonly timeoutMs: number | undefined
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
  | {
    /**
     * A vendor provider was configured but its credential reference resolved
     * to nothing at load. The plugin still mounts so run submissions answer a
     * clear "credential not configured" failure instead of failing the load;
     * the provider id and reference name carry diagnostics, never a value.
     */
    readonly kind: 'unavailable'
    readonly providerId: string
    readonly apiKeyEnv: string
  }

/**
 * Read one credential, returning undefined when absent so the caller can
 * degrade to the `unavailable` plan rather than failing the load.
 * @param envName - the environment-variable name.
 * @param env - the environment lookup.
 * @returns the non-empty credential value, or undefined.
 */
function readCredential(envName: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
  const value = env[envName]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Synthesize the environment `resolveNetworkSource` reads: every env name the
 * chosen provider's credential reference declares resolves through the
 * credentials seam first, so a key stored through a configuration surface
 * wins; unset references fall through to the ambient layer.
 * @param config - validated plugin config.
 * @param env - the ambient environment the seam overlays.
 * @param credentials - optional credential seam.
 * @returns the env view the source resolution reads.
 */
export async function resolveCredentialEnv(
  config: AccessibilityPluginConfig,
  env: Readonly<Record<string, string | undefined>>,
  credentials: CredentialProvider | undefined,
  keyring?: LbsKeyringConsumerFace | undefined,
): Promise<Readonly<Record<string, string | undefined>>> {
  if (credentials === undefined && keyring === undefined) return env
  const names = new Set<string>()
  const provider = config.provider ?? CONTROLLED_NETWORK_ID
  if (provider === AMAP_NETWORK_ID) names.add(config.amap?.apiKeyEnv ?? DEFAULT_AMAP_API_KEY_ENV)
  if (provider === TIANDITU_NETWORK_ID) names.add(config.tianditu?.apiKeyEnv ?? DEFAULT_TIANDITU_API_KEY_ENV)
  if (provider === TIANDITU_SDK_NETWORK_ID) names.add(config.tiandituSdk?.apiKeyEnv ?? DEFAULT_TIANDITU_SDK_KEY_ENV)
  if (provider === MAPBOX_NETWORK_ID) names.add(config.mapbox?.accessTokenEnv ?? DEFAULT_MAPBOX_ACCESS_TOKEN_ENV)
  if (provider === BAIDU_NETWORK_ID) names.add(config.baidu?.apiKeyEnv ?? DEFAULT_BAIDU_API_KEY_ENV)
  if (provider === TENCENT_NETWORK_ID) names.add(config.tencent?.apiKeyEnv ?? DEFAULT_TENCENT_API_KEY_ENV)
  if (names.size === 0) return env
  const overlay: Record<string, string | undefined> = { ...env }
  for (const name of names) {
    if (!isCredentialRefName(name)) continue
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
 * Resolve and validate the configured network source. The controlled lattice
 * is the default; each vendor id resolves its credential from the named
 * environment reference at load — the credentials seam first, so a key stored
 * through a configuration surface takes precedence, then the ambient
 * environment. A vendor whose reference resolves to nothing degrades to the
 * `unavailable` plan so the run still mounts and reports a clear
 * credential-not-configured failure at submit, never a silent fallback.
 * @param config - validated plugin config.
 * @param env - environment lookup; the process environment by default.
 * @returns the network source plan the plugin computes against.
 * @throws {AccessibilityError} `ACCESS_INVALID_INPUT` for an unconfigured
 *   provider id.
 */
export function resolveNetworkSource(
  config: AccessibilityPluginConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): NetworkSourcePlan {
  const provider = config.provider ?? CONTROLLED_NETWORK_ID
  if (provider === CONTROLLED_NETWORK_ID) return { kind: 'controlled' }
  if (provider === AMAP_NETWORK_ID) {
    const apiKeyEnv = config.amap?.apiKeyEnv ?? DEFAULT_AMAP_API_KEY_ENV
    const apiKey = readCredential(apiKeyEnv, env)
    return apiKey === undefined
      ? { kind: 'unavailable', providerId: provider, apiKeyEnv }
      : { kind: 'amap', apiKey, apiKeyEnv, spacingDeg: config.amap?.spacingDeg, timeoutMs: config.amap?.timeoutMs, baseUrl: config.amap?.baseUrl }
  }
  if (provider === TIANDITU_NETWORK_ID) {
    const apiKeyEnv = config.tianditu?.apiKeyEnv ?? DEFAULT_TIANDITU_API_KEY_ENV
    const apiKey = readCredential(apiKeyEnv, env)
    return apiKey === undefined
      ? { kind: 'unavailable', providerId: provider, apiKeyEnv }
      : { kind: 'tianditu', apiKey, apiKeyEnv, spacingDeg: config.tianditu?.spacingDeg, timeoutMs: config.tianditu?.timeoutMs, baseUrl: config.tianditu?.baseUrl }
  }
  if (provider === TIANDITU_SDK_NETWORK_ID) {
    const apiKeyEnv = config.tiandituSdk?.apiKeyEnv ?? DEFAULT_TIANDITU_SDK_KEY_ENV
    const apiKey = readCredential(apiKeyEnv, env)
    return apiKey === undefined
      ? { kind: 'unavailable', providerId: provider, apiKeyEnv }
      : { kind: 'tianditu-sdk', apiKey, apiKeyEnv, timeoutMs: config.tiandituSdk?.timeoutMs }
  }
  if (provider === MAPBOX_NETWORK_ID) {
    const accessTokenEnv = config.mapbox?.accessTokenEnv ?? DEFAULT_MAPBOX_ACCESS_TOKEN_ENV
    const accessToken = readCredential(accessTokenEnv, env)
    return accessToken === undefined
      ? { kind: 'unavailable', providerId: provider, apiKeyEnv: accessTokenEnv }
      : { kind: 'mapbox', accessToken, accessTokenEnv, timeoutMs: config.mapbox?.timeoutMs, baseUrl: config.mapbox?.baseUrl }
  }
  if (provider === BAIDU_NETWORK_ID) {
    const apiKeyEnv = config.baidu?.apiKeyEnv ?? DEFAULT_BAIDU_API_KEY_ENV
    const apiKey = readCredential(apiKeyEnv, env)
    return apiKey === undefined
      ? { kind: 'unavailable', providerId: provider, apiKeyEnv }
      : { kind: 'baidu', apiKey, apiKeyEnv, spacingDeg: config.baidu?.spacingDeg, timeoutMs: config.baidu?.timeoutMs, baseUrl: config.baidu?.baseUrl }
  }
  if (provider === TENCENT_NETWORK_ID) {
    const apiKeyEnv = config.tencent?.apiKeyEnv ?? DEFAULT_TENCENT_API_KEY_ENV
    const apiKey = readCredential(apiKeyEnv, env)
    return apiKey === undefined
      ? { kind: 'unavailable', providerId: provider, apiKeyEnv }
      : { kind: 'tencent', apiKey, apiKeyEnv, spacingDeg: config.tencent?.spacingDeg, timeoutMs: config.tencent?.timeoutMs, baseUrl: config.tencent?.baseUrl }
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
export async function apply(ctx: Context, config: AccessibilityPluginConfig): Promise<void> {
  const credentials = ctx.get('credentials', false)
  const keyring: LbsKeyringConsumerFace | undefined = ctx.get(LBS_KEYRING_SERVICE, false)
  const currentSource = async (): Promise<NetworkSourcePlan> => resolveNetworkSource(
    config,
    await resolveCredentialEnv(config, process.env, credentials, keyring),
  )
  const projection = await ctx.sessionProjections.register(spatialAccessibilityProjectionDefinition)
  const store = openRunStore(resolvePath(config.root))
  const runService = new AccessibilityRunService(store)

  const service: SpatialAccessibilityService = {
    runs: runService,
    async submit(input) {
      const source = await currentSource()
      const networkRef = networkRefFor(input.spec, source)
      const spec: AccessibilitySpec = {
        ...input.spec,
        networkRef,
        methodVersion: ACCESSIBILITY_METHOD_VERSION,
      } as AccessibilitySpec
      const compute = buildCompute(spec, input.data, source)
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
      const state = projection.stateOf(session)
      return state.pendingCalls.find(pending => pending.callId === callId)
    },
    quiesce() {
      return runService.quiesce()
    },
  }

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
  function networkRefFor(spec: RunSubmitSpecInput, source: NetworkSourcePlan): string {
    return providerFor(spec, source).networkRef
  }

  /** Build the configured provider for one spec's support extent. */
  function providerFor(spec: RunSubmitSpecInput | AccessibilitySpec, source: NetworkSourcePlan): NetworkProvider {
    if (source.kind === 'unavailable') {
      throw new AccessibilityError('ACCESS_INVALID_INPUT', `provider "${source.providerId}" is configured but its credential reference ${source.apiKeyEnv} resolved to no key; store it through the credentials seam or set it in the environment`)
    }
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
        ...(source.spacingDeg === undefined ? {} : { spacingDeg: source.spacingDeg }),
        ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
        ...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
        ...(config.fetchImpl === undefined ? {} : { fetchImpl: config.fetchImpl }),
      })
    }
    if (source.kind === 'tianditu-sdk') {
      return createTiandituSdkProvider({
        apiKey: source.apiKey,
        apiKeyEnv: source.apiKeyEnv,
        bbox: spec.analysisSupportExtent.bbox,
        ...(source.timeoutMs === undefined ? {} : { timeoutMs: source.timeoutMs }),
        ...(config.sdkBridge === undefined ? {} : { bridge: config.sdkBridge }),
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
  function buildCompute(spec: AccessibilitySpec, data: RunInputData, source: NetworkSourcePlan): RunCompute {
    return async (checkpoints) => {
      const provider = providerFor(spec, source)
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
