/**
 * Deployment configuration for source transport and its owning service cache.
 * Resolving settings performs no requests or service registration.
 * @module @map-harness/map-container/source-network-config
 */
import { SourceCatalogError } from './source-error.ts'

/** Who resolves the tunnel destination; `local` pins a vetted address into CONNECT. */
export type SourceOutboundTargetResolution = 'local' | 'proxy'

/**
 * Explicit outbound HTTP(S) proxy for source transport. Absent means direct
 * connections; ambient proxy environment variables are never consulted.
 */
export interface SourceOutboundProxyConfig {
  /** Environment variable name holding the proxy URL; the value never enters config. */
  readonly urlEnv: string
  /** Omission keeps local resolution and a pinned CONNECT authority. */
  readonly targetResolution?: SourceOutboundTargetResolution
}

/** Optional deployment bounds for source requests and retained service data. */
export interface SourceNetworkConfig {
  readonly requestTimeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxConcurrentRequests?: number
  readonly maxQueuedRequests?: number
  readonly maxMetadataBytes?: number
  readonly cacheMaxBytes?: number
  readonly cacheMaxEntries?: number
  readonly outboundProxy?: SourceOutboundProxyConfig
}

/** Host-only resolved proxy; the URL never carries credentials and is not serialized. */
export interface ResolvedOutboundProxy {
  readonly url: URL
  /** Ready `Proxy-Authorization` value, or `null` when the proxy URL has no userinfo. */
  readonly authorization: string | null
  readonly targetResolution: SourceOutboundTargetResolution
}

/** Fully resolved transport/cache bounds; constructors do not default again. */
export interface ResolvedSourceNetworkConfig {
  readonly requestTimeoutMs: number
  readonly maxResponseBytes: number
  readonly maxConcurrentRequests: number
  readonly maxQueuedRequests: number
  readonly maxMetadataBytes: number
  readonly cacheMaxBytes: number
  readonly cacheMaxEntries: number
  readonly outboundProxy: ResolvedOutboundProxy | null
}

/** Defaults for explicitly configurable transport and cache limits. */
export const DEFAULT_SOURCE_NETWORK_CONFIG: ResolvedSourceNetworkConfig = Object.freeze({
  requestTimeoutMs: 15_000,
  maxResponseBytes: 8_388_608,
  maxConcurrentRequests: 16,
  maxQueuedRequests: 64,
  maxMetadataBytes: 1_048_576,
  cacheMaxBytes: 33_554_432,
  cacheMaxEntries: 512,
  outboundProxy: null,
})

type NumericSetting = Exclude<keyof ResolvedSourceNetworkConfig, 'outboundProxy'>

const environmentName = /^[A-Z_][A-Z0-9_]*$/

function invalid(): never {
  throw new SourceCatalogError('SOURCE_CONFIG_INVALID')
}

function resolveOutboundProxy(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedOutboundProxy | null {
  if (value === undefined) return null
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid()
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => key !== 'urlEnv' && key !== 'targetResolution')
    || typeof raw.urlEnv !== 'string' || !environmentName.test(raw.urlEnv)
    // The standard child-environment scrub removes the DSH_ namespace, so
    // any other name would carry the proxy URL (including credentials) into
    // model subprocess environments.
    || !raw.urlEnv.toUpperCase().startsWith('DSH_')) invalid()
  const targetResolution = raw.targetResolution ?? 'local'
  if (targetResolution !== 'local' && targetResolution !== 'proxy') invalid()
  const configured = env[raw.urlEnv]
  if (typeof configured !== 'string' || configured.length === 0 || configured.length > 4_096) invalid()
  let url: URL
  let username: string
  let password: string
  try {
    url = new URL(configured)
    username = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
  } catch {
    // Malformed URLs and percent escapes are configuration failures, not transport failures.
    return invalid()
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') invalid()
  url.username = ''
  url.password = ''
  const authorization = username === '' && password === ''
    ? null
    : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
  return Object.freeze({ url: Object.freeze(url), authorization, targetResolution })
}

function bounded(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new SourceCatalogError('SOURCE_CONFIG_INVALID')
  }
  return value
}

function setting(raw: Record<string, unknown>, name: NumericSetting, minimum: number, maximum: number): number {
  return bounded(raw[name] === undefined ? DEFAULT_SOURCE_NETWORK_CONFIG[name] : raw[name], minimum, maximum)
}

/**
 * Resolve deployment transport settings before activation.
 * @param input - unknown config; omission uses defaults, unknown keys fail.
 * @param env - host environment used only to read the configured proxy URL.
 * @returns frozen coherent limits; throws a safe source configuration failure.
 */
export function resolveSourceNetworkConfig(
  input?: unknown,
  env: Readonly<Record<string, string | undefined>> = {},
): ResolvedSourceNetworkConfig {
  const value = input === undefined ? {} : input
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).some(key => !Object.hasOwn(DEFAULT_SOURCE_NETWORK_CONFIG, key))) {
    throw new SourceCatalogError('SOURCE_CONFIG_INVALID')
  }
  const raw: Record<string, unknown> = { ...value }
  const resolved: ResolvedSourceNetworkConfig = {
    requestTimeoutMs: setting(raw, 'requestTimeoutMs', 1, 120_000),
    maxResponseBytes: setting(raw, 'maxResponseBytes', 1, 33_554_432),
    maxConcurrentRequests: setting(raw, 'maxConcurrentRequests', 1, 64),
    maxQueuedRequests: setting(raw, 'maxQueuedRequests', 0, 256),
    maxMetadataBytes: setting(raw, 'maxMetadataBytes', 1, 8_388_608),
    cacheMaxBytes: setting(raw, 'cacheMaxBytes', 0, 134_217_728),
    cacheMaxEntries: setting(raw, 'cacheMaxEntries', 0, 2_048),
    outboundProxy: resolveOutboundProxy(raw.outboundProxy, env),
  }
  if (resolved.maxMetadataBytes > resolved.maxResponseBytes
    || (resolved.cacheMaxBytes === 0) !== (resolved.cacheMaxEntries === 0)) {
    throw new SourceCatalogError('SOURCE_CONFIG_INVALID')
  }
  return Object.freeze(resolved)
}
