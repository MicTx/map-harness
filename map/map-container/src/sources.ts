/**
 * Host-owned deployment source catalog. Public descriptors never contain
 * endpoints or credential references; this module performs no network I/O.
 * @module @map-harness/map-container/sources
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  BasemapSourceId,
  basemapPairCompatible,
  canonicalSourceWkid,
  createBasemapSelection,
  ESRI_WORLD_REFERENCE_ATTRIBUTION,
  isValidSourceDate,
  parseBasemapSource,
  type BasemapCatalogPage,
  type BasemapSelection,
  type BasemapSource,
  type SourceFailureCode,
  type SourcePermission,
  type SourceProvider,
  type SourceRelease,
  type SourceRole,
  type SourceAdapter,
  type SourceParseResult,
} from '@map-harness/map-layers'
import { sourceHostAllowed } from './source-address.ts'
import { SourceCatalogError } from './source-error.ts'
import {
  resolveSourceNetworkConfig,
  type ResolvedSourceNetworkConfig,
  type SourceNetworkConfig,
} from './source-network-config.ts'
import { PUBLIC_SOURCE_PRESETS, SOURCE_NATIVE_QUERY_FIELDS } from './source-render-protocol.ts'
import { createWaybackService, waybackDescriptor, waybackReleaseOf, WAYBACK_SOURCE_ID, type WaybackService } from './wayback.ts'
import { ESRI_WORLD_IMAGERY_ATTRIBUTION } from '@map-harness/map-layers'

export { SourceCatalogError, type SourceCatalogFailureCode } from './source-error.ts'

/** The public catalog ids in stable order. */
export const BASEMAP_PRESET_IDS = [
  'esri-world-imagery',
  'esri-world-boundaries-places',
  'osm-standard',
  'tianditu-img-w',
  'tianditu-vec-w',
  'tianditu-cia-w',
  'tianditu-cva-w',
  'amap-imagery-labels',
  'esri-wayback',
] as const

/** Identifier of a configured basemap preset. */
export type BasemapPresetId = typeof BASEMAP_PRESET_IDS[number]

/** Per-preset deployment overrides; endpoints remain fixed by the preset. */
export interface BasemapPresetConfig {
  readonly enabled?: boolean
  readonly credentialRef?: string
  readonly screenshot?: SourcePermission
  readonly automatedMapUse?: SourcePermission
}

/** A named environment-variable binding; the value itself is never a DTO. */
export type SourceCredentialBinding =
  | { readonly type: 'query'; readonly parameter: string; readonly env: string }
  | { readonly type: 'bearer'; readonly env: string }

/** Custom source configuration, retained only in the host-resolved record. */
export interface CustomBasemapSourceConfig {
  readonly id: string
  readonly title: string
  readonly role: SourceRole
  readonly adapter: SourceAdapter
  readonly endpoint: string
  readonly attribution: string
  readonly nativeWkid: number
  readonly supportsDynamicExport?: boolean
  readonly supportedModes: readonly ('map' | 'scene')[]
  readonly minZoom: number
  readonly maxZoom: number
  readonly compatibleBasemapIds: readonly string[]
  readonly release?: Partial<SourceRelease>
  readonly credentialRef?: string
  readonly screenshot?: SourcePermission
  readonly automatedMapUse?: SourcePermission
  readonly allowPrivateNetwork?: boolean
  readonly allowHttp?: boolean
  readonly wmts?: {
    readonly layer: string
    readonly tileMatrixSet: string
    readonly style?: string
    readonly format?: string
  }
}

/** Deployment settings for the source catalog; no setting starts a request. */
export interface MapSourceConfig {
  readonly allowChanges?: boolean
  readonly presets?: Partial<Record<BasemapPresetId, BasemapPresetConfig>>
  readonly credentials?: Readonly<Record<string, SourceCredentialBinding>>
  readonly custom?: readonly CustomBasemapSourceConfig[]
  readonly maxSources?: number
  readonly maxCatalogBytes?: number
  readonly defaultPageSize?: number
  readonly maxPageSize?: number
  readonly proxy?: SourceNetworkConfig
}

/** Host-only source record. Never serialize this value to model or browser data. */
export interface ResolvedMapSource {
  readonly source: BasemapSource
  readonly endpoint: string
  readonly allowPrivateNetwork: boolean
  readonly allowHttp: boolean
  readonly wmts?: CustomBasemapSourceConfig['wmts']
  readonly waybackRelease?: number
  readonly credential?: {
    readonly type: 'query' | 'bearer'
    readonly parameter?: string
    readonly value: string
  }
}

interface CatalogLimits {
  readonly allowChanges: boolean
  readonly maxSources: number
  readonly maxCatalogBytes: number
  readonly defaultPageSize: number
  readonly maxPageSize: number
}

interface InternalSource {
  readonly source: BasemapSource
  readonly endpoint: string
  readonly credentialRef?: string
  readonly binding?: SourceCredentialBinding
  readonly credentialValue?: string
  readonly wmts?: CustomBasemapSourceConfig['wmts']
  readonly allowPrivateNetwork: boolean
  readonly allowHttp: boolean
}

interface NormalizedConfig {
  readonly limits: CatalogLimits
  readonly presets: Readonly<Record<string, BasemapPresetConfig>>
  readonly credentials: Readonly<Record<string, SourceCredentialBinding>>
  readonly custom: readonly CustomBasemapSourceConfig[]
  readonly networkConfig: ResolvedSourceNetworkConfig
}

const permissionValues: readonly SourcePermission[] = ['allowed', 'denied', 'unverified']
const providerValues: readonly SourceProvider[] = ['esri', 'osm', 'tianditu', 'amap', 'custom']
const modeValues = ['map', 'scene'] as const
const defaultRelease: SourceRelease = Object.freeze({ version: null, publishedAt: null, acquiredAt: null })

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed)
  return Object.keys(value).every(key => set.has(key))
}

function sourceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
    // oxlint-disable-next-line no-control-regex -- Deployment text must reject control bytes.
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function safeInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value)
}

function invalidConfig(): never {
  throw new SourceCatalogError('SOURCE_CONFIG_INVALID')
}

function normalizeConfig(value: unknown, env: Readonly<Record<string, string | undefined>>): NormalizedConfig {
  if (value === undefined) value = {}
  if (!record(value) || !exactKeys(value, [
    'allowChanges', 'presets', 'credentials', 'custom', 'maxSources',
    'maxCatalogBytes', 'defaultPageSize', 'maxPageSize', 'proxy',
  ])) invalidConfig()
  if (value.allowChanges !== undefined && typeof value.allowChanges !== 'boolean') invalidConfig()
  const networkConfig = resolveSourceNetworkConfig(value.proxy, env)

  const maxSources = value.maxSources === undefined ? 64 : value.maxSources
  const maxCatalogBytes = value.maxCatalogBytes === undefined ? 131_072 : value.maxCatalogBytes
  const defaultPageSize = value.defaultPageSize === undefined ? 16 : value.defaultPageSize
  const maxPageSize = value.maxPageSize === undefined ? 32 : value.maxPageSize
  if (!safeInteger(maxSources, 1, 256)
    || !safeInteger(maxCatalogBytes, 1, 1_048_576)
    || !safeInteger(maxPageSize, 1, 64)
    || !safeInteger(defaultPageSize, 1, maxPageSize)) invalidConfig()

  const presets: Record<string, BasemapPresetConfig> = {}
  if (value.presets !== undefined) {
    if (!record(value.presets)) invalidConfig()
    for (const [id, item] of Object.entries(value.presets)) {
      if (!(BASEMAP_PRESET_IDS as readonly string[]).includes(id) || !record(item)
        || !exactKeys(item, ['enabled', 'credentialRef', 'screenshot', 'automatedMapUse'])
        || (item.enabled !== undefined && typeof item.enabled !== 'boolean')
        || (item.credentialRef !== undefined && !validName(item.credentialRef))
        || (item.screenshot !== undefined && !permissionValues.includes(item.screenshot as SourcePermission))
        || (item.automatedMapUse !== undefined && !permissionValues.includes(item.automatedMapUse as SourcePermission))) {
        invalidConfig()
      }
      presets[id] = { ...item } as BasemapPresetConfig
    }
  }
  if (presets[WAYBACK_SOURCE_ID]?.credentialRef !== undefined) invalidConfig()

  const credentials: Record<string, SourceCredentialBinding> = {}
  if (value.credentials !== undefined) {
    if (!record(value.credentials)) invalidConfig()
    for (const [name, binding] of Object.entries(value.credentials)) {
      if (!validName(name) || !record(binding)) invalidConfig()
      if (binding.type === 'query') {
        if (!exactKeys(binding, ['type', 'parameter', 'env'])
          || !boundedText(binding.parameter, 64)
          || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(binding.parameter)
          || typeof binding.env !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(binding.env)) invalidConfig()
        credentials[name] = { type: 'query', parameter: binding.parameter, env: binding.env }
      } else if (binding.type === 'bearer') {
        if (!exactKeys(binding, ['type', 'env'])
          || typeof binding.env !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(binding.env)) invalidConfig()
        credentials[name] = { type: 'bearer', env: binding.env }
      } else invalidConfig()
    }
  }
  for (const settings of Object.values(presets)) {
    if (settings.credentialRef !== undefined && credentials[settings.credentialRef] === undefined) invalidConfig()
  }

  if (value.custom !== undefined && !Array.isArray(value.custom)) invalidConfig()
  const custom = Array.isArray(value.custom) ? value.custom : []
  if (custom.length + BASEMAP_PRESET_IDS.length > maxSources) throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
  const parsedCustom = custom.map(item => {
    if (!record(item)) invalidConfig()
    return parseCustomConfig(item)
  })
  if (new Set(parsedCustom.map(item => item.id)).size !== parsedCustom.length) invalidConfig()
  for (const item of parsedCustom) {
    if (item.credentialRef !== undefined && credentials[item.credentialRef] === undefined) invalidConfig()
  }
  return {
    limits: {
      allowChanges: value.allowChanges ?? true,
      maxSources,
      maxCatalogBytes,
      defaultPageSize,
      maxPageSize,
    },
    presets,
    credentials,
    custom: parsedCustom,
    networkConfig,
  }
}

function isPublicOsmHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return host === 'tile.openstreetmap.org' || host.endsWith('.tile.openstreetmap.org')
}

function credentialQueryKey(rawKey: string): boolean {
  let key = rawKey
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const decoded = decodeURIComponent(key)
      if (decoded === key) break
      key = decoded
    } catch (error) {
      // Malformed escaping cannot be a safe static query parameter name.
      if (error instanceof URIError) return true
      throw error
    }
  }
  if (/%[a-f0-9]{2}/i.test(key)) return true
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return normalized === 'tk' || /(?:key|token|auth|secret|credential|password)/.test(normalized)
}

function validateEndpoint(value: unknown, allowPrivateNetwork: boolean, allowHttp: boolean, adapter: SourceAdapter): string {
  if (!boundedText(value, 2048) || value.includes('#')) invalidConfig()
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(value)
  const authorityText = authority?.[1]
  if (authorityText === undefined || authorityText.includes('@')) invalidConfig()
  const tokenMatches = value.match(/\{[xyz]\}/g) ?? []
  if (adapter === 'xyz') {
    if (authorityText.includes('{') || tokenMatches.length !== 3
      || !['{x}', '{y}', '{z}'].every(token => tokenMatches.filter(item => item === token).length === 1)
      || /[{}]/.test(value.replace(/\{[xyz]\}/g, ''))) invalidConfig()
  } else if (tokenMatches.length > 0 || /[{}]/.test(value)) invalidConfig()
  let url: URL
  try {
    url = new URL(value.replace(/\{[xyz]\}/g, '1'))
  } catch (error) {
    // Contain only URL syntax failures; programming faults must remain visible.
    if (error instanceof TypeError) return invalidConfig()
    throw error
  }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttp))
    || (url.username !== '' || url.password !== '')
    || !sourceHostAllowed(url.hostname, allowPrivateNetwork)
    || (adapter === 'xyz' && /\/(?:mapserver|imageserver|vectortileserver)\/tile(?:\/|$)/i.test(url.pathname))
    || [...url.searchParams.keys()].some(credentialQueryKey)) {
    invalidConfig()
  }
  if (adapter === 'arcgis-mapserver' && !/\/MapServer\/?$/i.test(url.pathname)) invalidConfig()
  if (adapter !== 'xyz' && [...url.searchParams.keys()].some(key => SOURCE_NATIVE_QUERY_FIELDS[adapter].includes(key.toLowerCase()))) invalidConfig()
  return value
}

function parseCustomConfig(value: Record<string, unknown>): CustomBasemapSourceConfig {
  const allowed = [
    'id', 'title', 'role', 'adapter', 'endpoint', 'attribution', 'nativeWkid',
    'supportsDynamicExport', 'supportedModes', 'minZoom', 'maxZoom',
    'compatibleBasemapIds', 'release', 'credentialRef', 'screenshot',
    'automatedMapUse', 'allowPrivateNetwork', 'allowHttp', 'wmts',
  ]
  if (!exactKeys(value, allowed)
    || !sourceId(value.id) || (BASEMAP_PRESET_IDS as readonly string[]).includes(value.id)
    || !boundedText(value.title, 96)
    || (value.role !== 'basemap' && value.role !== 'labels')
    || (value.adapter !== 'arcgis-mapserver' && value.adapter !== 'xyz' && value.adapter !== 'wmts')
    || !boundedText(value.attribution, 1024)
    || !safeInteger(value.nativeWkid, 1, Number.MAX_SAFE_INTEGER)
    || (value.supportsDynamicExport !== undefined && typeof value.supportsDynamicExport !== 'boolean')
    || !Array.isArray(value.supportedModes) || value.supportedModes.length < 1 || value.supportedModes.length > 2
    || value.supportedModes.some(mode => !modeValues.includes(mode as 'map' | 'scene'))
    || new Set(value.supportedModes).size !== value.supportedModes.length
    || typeof value.minZoom !== 'number' || !Number.isFinite(value.minZoom)
    || typeof value.maxZoom !== 'number' || !Number.isFinite(value.maxZoom)
    || value.minZoom < 0 || value.maxZoom > 30 || value.minZoom > value.maxZoom
    || !Array.isArray(value.compatibleBasemapIds) || value.compatibleBasemapIds.length > 64
    || value.compatibleBasemapIds.some(id => !sourceId(id))
    || new Set(value.compatibleBasemapIds).size !== value.compatibleBasemapIds.length
    || (value.role === 'basemap' && value.compatibleBasemapIds.length !== 0)
    || (value.role === 'labels' && value.compatibleBasemapIds.length === 0)
    || (value.credentialRef !== undefined && !validName(value.credentialRef))
    || (value.screenshot !== undefined && !permissionValues.includes(value.screenshot as SourcePermission))
    || (value.automatedMapUse !== undefined && !permissionValues.includes(value.automatedMapUse as SourcePermission))
    || (value.allowPrivateNetwork !== undefined && typeof value.allowPrivateNetwork !== 'boolean')
    || (value.allowHttp !== undefined && typeof value.allowHttp !== 'boolean')) invalidConfig()
  const adapter = value.adapter as SourceAdapter
  if (adapter === 'xyz' && canonicalSourceWkid(value.nativeWkid) !== 3857) invalidConfig()
  const allowPrivateNetwork = value.allowPrivateNetwork === true
  const allowHttp = value.allowHttp === true
  const endpoint = validateEndpoint(value.endpoint, allowPrivateNetwork, allowHttp, adapter)
  if ((value.supportsDynamicExport === true && adapter !== 'arcgis-mapserver')
    || (adapter === 'wmts' && !record(value.wmts))
    || (adapter !== 'wmts' && value.wmts !== undefined)) invalidConfig()
  let wmts: CustomBasemapSourceConfig['wmts']
  if (adapter === 'wmts') {
    const raw = value.wmts as Record<string, unknown>
    if (!exactKeys(raw, ['layer', 'tileMatrixSet', 'style', 'format'])
      || !boundedText(raw.layer, 128) || !boundedText(raw.tileMatrixSet, 128)
      || (raw.style !== undefined && !boundedText(raw.style, 128))
      || (raw.format !== undefined && !boundedText(raw.format, 128))) invalidConfig()
    wmts = {
      layer: raw.layer,
      tileMatrixSet: raw.tileMatrixSet,
      ...(raw.style === undefined ? {} : { style: raw.style as string }),
      ...(raw.format === undefined ? {} : { format: raw.format as string }),
    }
  }
  const host = new URL(endpoint.replace(/\{[xyz]\}/g, '1')).hostname
  if (isPublicOsmHost(host) && value.automatedMapUse === 'allowed') invalidConfig()
  const release = value.release === undefined ? defaultRelease : value.release
  if (!record(release) || !exactKeys(release, ['version', 'publishedAt', 'acquiredAt'])
    || (release.version !== undefined && release.version !== null && !boundedText(release.version, 96))) invalidConfig()
  if ((release.version !== undefined && release.version !== null && typeof release.version !== 'string')
    || (release.publishedAt !== undefined && release.publishedAt !== null && typeof release.publishedAt !== 'string')
    || (release.acquiredAt !== undefined && release.acquiredAt !== null && typeof release.acquiredAt !== 'string')) invalidConfig()
  const normalizedRelease: SourceRelease = {
    version: typeof release.version === 'string' ? release.version : null,
    publishedAt: typeof release.publishedAt === 'string' ? release.publishedAt : null,
    acquiredAt: typeof release.acquiredAt === 'string' ? release.acquiredAt : null,
  }
  if ((normalizedRelease.version !== null && !boundedText(normalizedRelease.version, 96))
    || !isValidSourceDate(normalizedRelease.publishedAt)
    || !isValidSourceDate(normalizedRelease.acquiredAt)) invalidConfig()
  return {
    id: value.id,
    title: value.title,
    role: value.role,
    adapter,
    endpoint,
    attribution: value.attribution,
    nativeWkid: value.nativeWkid,
    supportsDynamicExport: value.supportsDynamicExport === true,
    supportedModes: [...value.supportedModes] as ('map' | 'scene')[],
    minZoom: value.minZoom,
    maxZoom: value.maxZoom,
    compatibleBasemapIds: [...value.compatibleBasemapIds] as string[],
    release: normalizedRelease,
    ...(value.credentialRef === undefined ? {} : { credentialRef: value.credentialRef as string }),
    ...(value.screenshot === undefined ? {} : { screenshot: value.screenshot as SourcePermission }),
    ...(value.automatedMapUse === undefined ? {} : { automatedMapUse: value.automatedMapUse as SourcePermission }),
    allowPrivateNetwork,
    allowHttp,
    ...(wmts === undefined ? {} : { wmts }),
  }
}

const OSM_ATTRIBUTION = '© OpenStreetMap contributors'
const TIANDITU_ATTRIBUTION = '天地图'

interface PresetSpec {
  readonly id: BasemapPresetId
  readonly title: string
  readonly provider: Exclude<SourceProvider, 'custom'>
  readonly role: SourceRole
  readonly adapter: SourceAdapter
  readonly endpoint: string
  readonly attribution: string
  readonly compatibleBasemapIds: readonly BasemapPresetId[]
  readonly defaultAutomatedMapUse: SourcePermission
  readonly defaultScreenshot: SourcePermission
  readonly credentialRef?: string
  readonly wmts?: NonNullable<CustomBasemapSourceConfig['wmts']>
  readonly tileAdjustment?: { readonly kind: 'gcj02'; readonly version: 1 }
}

const presetSpecs: readonly PresetSpec[] = [
  {
    id: 'esri-world-imagery', title: 'Esri World Imagery', provider: 'esri', role: 'basemap',
    adapter: PUBLIC_SOURCE_PRESETS['esri-world-imagery'].adapter,
    endpoint: PUBLIC_SOURCE_PRESETS['esri-world-imagery'].url,
    attribution: ESRI_WORLD_IMAGERY_ATTRIBUTION, compatibleBasemapIds: [], defaultAutomatedMapUse: 'unverified',
    defaultScreenshot: 'unverified',
  },
  {
    id: 'esri-world-boundaries-places', title: 'Esri World Boundaries and Places', provider: 'esri', role: 'labels',
    adapter: PUBLIC_SOURCE_PRESETS['esri-world-boundaries-places'].adapter,
    endpoint: PUBLIC_SOURCE_PRESETS['esri-world-boundaries-places'].url,
    attribution: ESRI_WORLD_REFERENCE_ATTRIBUTION, compatibleBasemapIds: ['esri-world-imagery'],
    defaultAutomatedMapUse: 'unverified', defaultScreenshot: 'unverified',
  },
  {
    id: 'osm-standard', title: 'OpenStreetMap Standard', provider: 'osm', role: 'basemap',
    adapter: PUBLIC_SOURCE_PRESETS['osm-standard'].adapter,
    endpoint: PUBLIC_SOURCE_PRESETS['osm-standard'].url, attribution: OSM_ATTRIBUTION,
    compatibleBasemapIds: [], defaultAutomatedMapUse: 'denied', defaultScreenshot: 'denied',
  },
  {
    id: 'tianditu-img-w', title: 'Tianditu Imagery', provider: 'tianditu', role: 'basemap', adapter: 'wmts',
    endpoint: 'https://t0.tianditu.gov.cn/img_w/wmts', attribution: TIANDITU_ATTRIBUTION,
    compatibleBasemapIds: [], defaultAutomatedMapUse: 'unverified', defaultScreenshot: 'unverified',
    credentialRef: 'tianditu', wmts: { layer: 'img', tileMatrixSet: 'w', style: 'default', format: 'tiles' },
  },
  {
    id: 'tianditu-vec-w', title: 'Tianditu Vector', provider: 'tianditu', role: 'basemap', adapter: 'wmts',
    endpoint: 'https://t0.tianditu.gov.cn/vec_w/wmts', attribution: TIANDITU_ATTRIBUTION,
    compatibleBasemapIds: [], defaultAutomatedMapUse: 'unverified', defaultScreenshot: 'unverified',
    credentialRef: 'tianditu', wmts: { layer: 'vec', tileMatrixSet: 'w', style: 'default', format: 'tiles' },
  },
  {
    id: 'tianditu-cia-w', title: 'Tianditu Image Labels', provider: 'tianditu', role: 'labels', adapter: 'wmts',
    endpoint: 'https://t0.tianditu.gov.cn/cia_w/wmts', attribution: TIANDITU_ATTRIBUTION,
    compatibleBasemapIds: ['esri-world-imagery', 'esri-wayback', 'tianditu-img-w'], defaultAutomatedMapUse: 'unverified',
    defaultScreenshot: 'unverified', credentialRef: 'tianditu', wmts: { layer: 'cia', tileMatrixSet: 'w', style: 'default', format: 'tiles' },
  },
  {
    id: 'tianditu-cva-w', title: 'Tianditu Vector Labels', provider: 'tianditu', role: 'labels', adapter: 'wmts',
    endpoint: 'https://t0.tianditu.gov.cn/cva_w/wmts', attribution: TIANDITU_ATTRIBUTION,
    compatibleBasemapIds: ['tianditu-vec-w'], defaultAutomatedMapUse: 'unverified',
    defaultScreenshot: 'unverified', credentialRef: 'tianditu', wmts: { layer: 'cva', tileMatrixSet: 'w', style: 'default', format: 'tiles' },
  },
  {
    id: 'amap-imagery-labels', title: 'AMap Imagery Labels', provider: 'amap', role: 'labels', adapter: 'xyz',
    endpoint: 'https://wprd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    attribution: '© 高德地图', compatibleBasemapIds: ['esri-world-imagery', 'esri-wayback'],
    defaultAutomatedMapUse: 'unverified', defaultScreenshot: 'unverified',
    tileAdjustment: { kind: 'gcj02', version: 1 },
  },
]

const WAYBACK_CATALOG_DESCRIPTOR = Object.freeze({
  schemaVersion: 1 as const,
  id: BasemapSourceId('esri-wayback'),
  title: 'World Imagery Wayback',
  provider: 'esri' as const,
  role: 'basemap' as const,
  adapter: 'wmts' as const,
  configDigest: sha256({ sourceId: WAYBACK_SOURCE_ID, catalog: true }),
  nativeWkid: 3857,
  supportsDynamicExport: false,
  supportedModes: ['map'] as const,
  minZoom: 0,
  maxZoom: 23,
  compatibleBasemapIds: [],
  attribution: ESRI_WORLD_IMAGERY_ATTRIBUTION,
  release: defaultRelease,
  screenshot: 'allowed' as const,
  automatedMapUse: 'allowed' as const,
  availability: { kind: 'configured' as const },
  tileAdjustment: null,
})

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (record(value)) {
    const keys = Object.keys(value).filter(key => value[key] !== undefined).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('unsupported source identity value')
  return serialized
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function permission(value: SourcePermission | undefined, fallback: SourcePermission): SourcePermission {
  return value ?? fallback
}

function effectiveScreenshot(
  sourceGrant: SourcePermission,
  observationPolicy: 'allow' | 'deny' | 'unverified',
): SourcePermission {
  if (sourceGrant === 'denied' || observationPolicy === 'deny') return 'denied'
  if (sourceGrant === 'allowed' && observationPolicy === 'allow') return 'allowed'
  return 'unverified'
}

function envCredential(
  reference: string | undefined,
  credentials: Readonly<Record<string, SourceCredentialBinding>>,
  env: Readonly<Record<string, string | undefined>>,
): { binding?: SourceCredentialBinding; value?: string } {
  if (reference === undefined) return {}
  const binding = credentials[reference]
  if (binding === undefined) return {}
  const value = env[binding.env]
  if (typeof value === 'string' && (value.length > 8_192 || /[\r\n]/.test(value))) invalidConfig()
  return { binding, ...(typeof value === 'string' && value.length > 0 ? { value } : {}) }
}

function validateCredentialParameter(binding: SourceCredentialBinding | undefined, adapter: SourceAdapter, endpoint: string): void {
  if (binding === undefined || binding.type === 'bearer') return
  const parameter = binding.parameter.toLowerCase()
  const url = new URL(endpoint.replace(/\{[xyz]\}/g, '1'))
  if (SOURCE_NATIVE_QUERY_FIELDS[adapter].includes(parameter) || [...url.searchParams.keys()].some(key => key.toLowerCase() === parameter)) invalidConfig()
}

function publicSource(
  data: Omit<BasemapSource, 'schemaVersion' | 'configDigest'>,
  configIdentity: unknown,
): BasemapSource {
  const base = { schemaVersion: 1 as const, ...data, configDigest: sha256(configIdentity) }
  const parsed = parseBasemapSource(base)
  if (!parsed.ok) invalidConfig()
  return parsed.value
}

function disabledAvailability(enabled: boolean, credentialMissing: boolean): BasemapSource['availability'] {
  if (!enabled) return { kind: 'unavailable', reason: 'disabled' }
  if (credentialMissing) return { kind: 'unavailable', reason: 'missing-credential' }
  return { kind: 'configured' }
}

function freezeSource(source: BasemapSource): BasemapSource {
  const normalized: BasemapSource = { ...source, tileAdjustment: source.tileAdjustment ?? null }
  Object.freeze(source.supportedModes)
  Object.freeze(source.compatibleBasemapIds)
  Object.freeze(source.release)
  Object.freeze(source.availability)
  if (source.tileAdjustment !== null && source.tileAdjustment !== undefined) Object.freeze(source.tileAdjustment)
  return Object.freeze(normalized)
}

function buildCatalogSource(
  data: Omit<BasemapSource, 'schemaVersion' | 'configDigest'>,
  identity: unknown,
  internal: Omit<InternalSource, 'source'>,
): InternalSource {
  const source = freezeSource(publicSource(data, identity))
  return Object.freeze({ source, ...internal })
}

function buildPreset(
  spec: PresetSpec,
  config: NormalizedConfig,
  observationPolicy: 'allow' | 'deny' | 'unverified',
  env: Readonly<Record<string, string | undefined>>,
): InternalSource {
  const settings = config.presets[spec.id] ?? {}
  const credentialRef = settings.credentialRef ?? spec.credentialRef
  const credential = envCredential(credentialRef, config.credentials, env)
  validateCredentialParameter(credential.binding, spec.adapter, spec.endpoint)
  if (spec.provider === 'osm' && credentialRef !== undefined) invalidConfig()
  if (spec.provider === 'tianditu' && credential.binding !== undefined
    && (credential.binding.type !== 'query' || credential.binding.parameter !== 'tk')) invalidConfig()
  const enabled = settings.enabled ?? true
  const missingCredential = credentialRef !== undefined && credential.value === undefined
  const inheritedGrant: SourcePermission = observationPolicy === 'allow'
    ? 'allowed'
    : observationPolicy === 'deny' ? 'denied' : 'unverified'
  const grant = settings.screenshot
    ?? (spec.id === 'esri-world-imagery' ? inheritedGrant : spec.defaultScreenshot)
  const screenshot = effectiveScreenshot(grant, observationPolicy)
  const automatedMapUse = permission(settings.automatedMapUse, spec.defaultAutomatedMapUse)
  const availability = disabledAvailability(enabled, missingCredential)
  const data: Omit<BasemapSource, 'schemaVersion' | 'configDigest'> = {
    id: BasemapSourceId(spec.id),
    title: spec.title,
    provider: spec.provider,
    role: spec.role,
    adapter: spec.adapter,
    nativeWkid: 3857,
    supportsDynamicExport: spec.adapter === 'arcgis-mapserver',
    supportedModes: spec.provider === 'esri' ? ['map', 'scene'] : ['map'],
    minZoom: spec.provider === 'tianditu' ? 1 : 0,
    maxZoom: spec.id === 'osm-standard' ? 19 : spec.provider === 'tianditu' ? 18 : 23,
    compatibleBasemapIds: spec.compatibleBasemapIds.map(BasemapSourceId),
    attribution: spec.attribution,
    release: defaultRelease,
    screenshot,
    automatedMapUse,
    availability,
    ...(spec.tileAdjustment === undefined ? {} : { tileAdjustment: spec.tileAdjustment }),
  }
  if (spec.provider === 'osm' && automatedMapUse === 'allowed') invalidConfig()
  const identity = {
    id: spec.id, title: spec.title, provider: spec.provider, role: spec.role, adapter: spec.adapter,
    endpoint: spec.endpoint, wmts: spec.wmts, attribution: spec.attribution, nativeWkid: 3857,
    supportedModes: data.supportedModes, minZoom: data.minZoom, maxZoom: data.maxZoom,
    compatibleBasemapIds: spec.compatibleBasemapIds, screenshot, automatedMapUse, availability,
    tileAdjustment: spec.tileAdjustment ?? null,
    credentialRef, binding: credential.binding, allowPrivateNetwork: false, allowHttp: false,
  }
  return buildCatalogSource(data, identity, {
    endpoint: spec.endpoint,
    ...(credentialRef === undefined ? {} : { credentialRef }),
    ...(credential.binding === undefined ? {} : { binding: credential.binding }),
    ...(credential.value === undefined ? {} : { credentialValue: credential.value }),
    ...(spec.wmts === undefined ? {} : { wmts: spec.wmts }),
    allowPrivateNetwork: false,
    allowHttp: false,
  })
}

function buildCustom(
  config: CustomBasemapSourceConfig,
  configCredentials: Readonly<Record<string, SourceCredentialBinding>>,
  env: Readonly<Record<string, string | undefined>>,
  observationPolicy: 'allow' | 'deny' | 'unverified',
): InternalSource {
  const credential = envCredential(config.credentialRef, configCredentials, env)
  validateCredentialParameter(credential.binding, config.adapter, config.endpoint)
  const availability = disabledAvailability(true, config.credentialRef !== undefined && credential.value === undefined)
  const screenshot = effectiveScreenshot(config.screenshot ?? 'unverified', observationPolicy)
  const automatedMapUse = config.automatedMapUse ?? 'unverified'
  const host = new URL(config.endpoint.replace(/\{[xyz]\}/g, '1')).hostname
  if (isPublicOsmHost(host) && automatedMapUse === 'allowed') invalidConfig()
  const release: SourceRelease = {
    version: config.release?.version ?? null,
    publishedAt: config.release?.publishedAt ?? null,
    acquiredAt: config.release?.acquiredAt ?? null,
  }
  const data: Omit<BasemapSource, 'schemaVersion' | 'configDigest'> = {
    id: BasemapSourceId(config.id),
    title: config.title,
    provider: 'custom',
    role: config.role,
    adapter: config.adapter,
    nativeWkid: config.nativeWkid,
    supportsDynamicExport: config.supportsDynamicExport === true,
    supportedModes: [...config.supportedModes],
    minZoom: config.minZoom,
    maxZoom: config.maxZoom,
    compatibleBasemapIds: config.compatibleBasemapIds.map(BasemapSourceId),
    attribution: config.attribution,
    release,
    screenshot,
    automatedMapUse,
    availability,
  }
  return buildCatalogSource(data, {
    ...config, screenshot, automatedMapUse, availability, binding: credential.binding,
  }, {
    endpoint: config.endpoint,
    ...(config.credentialRef === undefined ? {} : { credentialRef: config.credentialRef }),
    ...(credential.binding === undefined ? {} : { binding: credential.binding }),
    ...(credential.value === undefined ? {} : { credentialValue: credential.value }),
    ...(config.wmts === undefined ? {} : { wmts: config.wmts }),
    allowPrivateNetwork: config.allowPrivateNetwork === true,
    allowHttp: config.allowHttp === true,
  })
}

function badSourceSelection<T>(code: SourceFailureCode): SourceParseResult<T> {
  return { ok: false, code }
}

/**
 * Decode one complete persisted source, then verify it against the catalog's
 * exact descriptor. The parser supplies defaults for optional fields absent
 * from older current-schema records without admitting changed source facts.
 * @param catalog - deployment-owned source descriptors.
 * @param source - complete decoded source record.
 * @returns the deployment-owned descriptor.
 */
export function canonicalMapSource(
  catalog: Pick<MapSourceCatalog, 'descriptorOf' | 'verifyCachedWaybackSource' | 'verifyWaybackPolicy'>,
  source: BasemapSource,
): BasemapSource {
  const parsed = parseBasemapSource(source)
  if (!parsed.ok) throw new SourceCatalogError(parsed.code)
  if (parsed.value.id === WAYBACK_SOURCE_ID) {
    try {
      catalog.verifyCachedWaybackSource(parsed.value)
    } catch (error) {
      if (!(error instanceof SourceCatalogError) || error.code !== 'SOURCE_UNAVAILABLE') throw error
      catalog.verifyWaybackPolicy(parsed.value)
    }
    return parsed.value
  }
  const descriptor = catalog.descriptorOf(parsed.value.id)
  if (!isDeepStrictEqual(descriptor, parsed.value)) throw new SourceCatalogError('SOURCE_CHANGED')
  return descriptor
}

/**
 * Resolve the selected or default render sources against the current catalog.
 * @param catalog - deployment-owned source descriptors.
 * @param current - accepted selection, or null for the default Esri and AMap pair.
 * @returns the exact current basemap and label selection.
 * @throws {SourceCatalogError} when the selection is invalid or has changed.
 */
export function resolveMapSourceSelection(
  catalog: Pick<MapSourceCatalog, 'descriptorOf' | 'verifyCachedWaybackSource' | 'verifyWaybackPolicy'>,
  current: BasemapSelection | null,
): BasemapSelection {
  const source = canonicalMapSource(catalog, current?.basemap ?? catalog.descriptorOf(BasemapSourceId('esri-world-imagery')))
  const labels = current === null
    ? canonicalMapSource(catalog, catalog.descriptorOf(BasemapSourceId('amap-imagery-labels')))
    : current.labels === null ? null : canonicalMapSource(catalog, current.labels)
  const selection = createBasemapSelection(source, labels)
  if (!selection.ok) throw new SourceCatalogError(selection.code)
  return selection.value
}

/** Query accepted by the bounded catalog page reader. */
export interface BasemapCatalogQuery {
  readonly provider?: SourceProvider
  readonly cursor?: string
  readonly pageSize?: number
  readonly at?: { readonly lon: number; readonly lat: number }
  readonly zoom?: number
}

/** The configuration-only host catalog interface; it performs no network I/O. */
export interface MapSourceCatalog {
  /** Digest of the current public catalog configuration. */
  readonly catalogVersion: string
  /** Already-resolved host transport limits. */
  readonly networkConfig: ResolvedSourceNetworkConfig
  /**
   * Read the immutable public descriptor, including unavailable sources.
   * @param sourceId - already-validated source id.
   * @returns the frozen descriptor; throws SOURCE_NOT_FOUND for an absent id.
   */
  descriptorOf(sourceId: BasemapSourceId): BasemapSource
  /**
   * Read one bounded page; malformed, stale and oversized requests throw safe errors.
   * @param query - optional provider, location/zoom and continuation context.
   * @returns immutable public records, never endpoints or credentials.
   */
  list(query?: BasemapCatalogQuery): BasemapCatalogPage
  /**
   * Resolve a complete selection without owning current session state.
   * @param sourceId - base id in this deployment.
   * @param labelSourceId - labels id; omission and null both mean labels off.
   * @returns a compatible selection or typed semantic/write-lock refusal.
   */
  selection(sourceId: string, labelSourceId?: string | null): SourceParseResult<BasemapSelection>
  /** Validate a persisted fixed Wayback release against the official catalog. */
  waybackSelection(source: BasemapSource, signal?: AbortSignal): Promise<BasemapSource>
  /** Validate fixed source fields and deployment permissions without I/O. */
  verifyWaybackPolicy(source: BasemapSource): void
  /** Verify a source against the current cached official release and policy. */
  verifyCachedWaybackSource(source: BasemapSource): void
  /** Verify a persisted release for reading, regardless of the write lock. */
  verifyWaybackSource(source: BasemapSource, signal?: AbortSignal): Promise<BasemapSource>
  /** Resolve an official release with the deployment's current permissions. */
  waybackDescriptor(releaseId: number, signal?: AbortSignal): Promise<BasemapSource>
  /**
   * Resolve host-only transport data; never expose the result across a wire boundary.
   * @param sourceId - configured id.
   * @param expectedDigest - exact public configuration digest the caller accepted.
   * @returns private transport data; throws for unknown, changed or unavailable sources.
   */
  resolvedSource(sourceId: string, expectedDigest: string): ResolvedMapSource
}

function cursorOf(catalogVersion: string, queryDigest: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, c: catalogVersion, q: queryDigest, o: offset }), 'utf8').toString('base64url')
}

function cursorOffset(cursor: string, catalogVersion: string, queryDigest: string, length: number): number {
  if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  }
  const bytes = Buffer.from(cursor, 'base64url')
  if (bytes.toString('base64url') !== cursor) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    // Only malformed JSON is a cursor refusal; unexpected faults propagate.
    if (error instanceof SyntaxError) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    throw error
  }
  if (!record(parsed) || !exactKeys(parsed, ['v', 'c', 'q', 'o'])
    || !Object.hasOwn(parsed, 'v') || typeof parsed.c !== 'string'
    || !/^[a-f0-9]{64}$/.test(parsed.c) || typeof parsed.q !== 'string'
    || !/^[a-f0-9]{64}$/.test(parsed.q) || typeof parsed.o !== 'number'
    || !Number.isSafeInteger(parsed.o) || parsed.o < 0) {
    throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  }
  if (parsed.v !== 1) throw new SourceCatalogError('SOURCE_VERSION_UNSUPPORTED')
  if (parsed.c !== catalogVersion) throw new SourceCatalogError('SOURCE_CHANGED')
  if (parsed.q !== queryDigest || parsed.o >= length) {
    throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  }
  return parsed.o
}

function readQuery(value: unknown, limits: CatalogLimits): {
  readonly provider: SourceProvider | null
  readonly cursor: string | null
  readonly pageSize: number
  readonly at: { readonly lon: number; readonly lat: number } | null
  readonly zoom: number | null
} {
  if (value === undefined) value = {}
  if (!record(value) || !exactKeys(value, ['provider', 'cursor', 'pageSize', 'at', 'zoom'])) {
    throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  }
  if (value.provider !== undefined && !providerValues.includes(value.provider as SourceProvider)) {
    throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  }
  if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 256)) {
    throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  }
  const pageSize = value.pageSize ?? limits.defaultPageSize
  if (!safeInteger(pageSize, 1, limits.maxPageSize)) throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
  let at: { readonly lon: number; readonly lat: number } | null = null
  if (value.at !== undefined) {
    if (!record(value.at) || !exactKeys(value.at, ['lon', 'lat'])
      || typeof value.at.lon !== 'number' || !Number.isFinite(value.at.lon) || value.at.lon < -180 || value.at.lon > 180
      || typeof value.at.lat !== 'number' || !Number.isFinite(value.at.lat) || value.at.lat < -90 || value.at.lat > 90) {
      throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    }
    at = { lon: value.at.lon, lat: value.at.lat }
  }
  if ((value.at === undefined) !== (value.zoom === undefined)) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  if (value.zoom !== undefined && (typeof value.zoom !== 'number' || !Number.isFinite(value.zoom) || value.zoom < 0 || value.zoom > 30)) {
    throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
  }
  return {
    provider: (value.provider as SourceProvider | undefined) ?? null,
    cursor: (value.cursor as string | undefined) ?? null,
    pageSize,
    at,
    zoom: (value.zoom as number | undefined) ?? null,
  }
}

/**
 * Create a deterministic host catalog from validated deployment settings.
 * Environment values are read once and never copied into public descriptors.
 * @param rawConfig - deployment settings for presets, credentials, and custom sources.
 * @param observationCapturePolicy - current global capture policy.
 * @param env - host environment used only to resolve named credential bindings and the explicit outbound proxy.
 * @returns immutable public catalog methods and host-only resolved source records.
 */
export function createMapSourceCatalog(
  rawConfig: MapSourceConfig | undefined,
  observationCapturePolicy: 'allow' | 'deny' | 'unverified',
  env: Readonly<Record<string, string | undefined>>,
  wayback: WaybackService = createWaybackService(),
): MapSourceCatalog {
  if (observationCapturePolicy !== 'allow' && observationCapturePolicy !== 'deny' && observationCapturePolicy !== 'unverified') {
    invalidConfig()
  }
  const config = normalizeConfig(rawConfig, env)
  const waybackSettings = config.presets[WAYBACK_SOURCE_ID] ?? {}
  const waybackBase = {
    ...WAYBACK_CATALOG_DESCRIPTOR,
    screenshot: effectiveScreenshot(waybackSettings.screenshot ?? 'unverified', observationCapturePolicy),
    automatedMapUse: waybackSettings.automatedMapUse ?? 'unverified',
    availability: disabledAvailability(waybackSettings.enabled ?? true, false),
  }
  const descriptorFor = (release: Parameters<typeof waybackDescriptor>[0]): BasemapSource => ({
    ...waybackDescriptor(release),
    screenshot: waybackBase.screenshot,
    automatedMapUse: waybackBase.automatedMapUse,
    availability: waybackBase.availability,
  })
  const internal: InternalSource[] = [
    ...presetSpecs.map(spec => buildPreset(spec, config, observationCapturePolicy, env)),
    ...config.custom.map(source => buildCustom(source, config.credentials, env, observationCapturePolicy)),
  ]
  if (new Set(internal.map(item => item.source.id)).size !== internal.length) invalidConfig()
  const byId = new Map(internal.map(item => [item.source.id as string, item]))
  for (const item of internal) {
    if (item.source.role !== 'labels') continue
    for (const baseId of item.source.compatibleBasemapIds) {
      if (baseId === WAYBACK_SOURCE_ID) continue
      const base = byId.get(baseId)
      if (base === undefined || base.source.role !== 'basemap'
        || !basemapPairCompatible(base.source, item.source)) invalidConfig()
    }
  }
  if (internal.length > config.limits.maxSources) throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
  const catalogVersion = sha256({
    limits: config.limits,
    sourceDigests: [...internal.map(item => item.source.configDigest), waybackBase.configDigest],
    waybackPolicy: {
      screenshot: waybackBase.screenshot,
      automatedMapUse: waybackBase.automatedMapUse,
      availability: waybackBase.availability,
    },
  })
  const descriptorOf = (sourceId: BasemapSourceId): BasemapSource => {
    if (sourceId === WAYBACK_SOURCE_ID) return waybackBase
    const item = byId.get(sourceId)
    if (item === undefined) throw new SourceCatalogError('SOURCE_NOT_FOUND')
    return item.source
  }
  const list = (query?: BasemapCatalogQuery): BasemapCatalogPage => {
    const parsedQuery = readQuery(query, config.limits)
    const filtered = [
      ...internal,
      ...(parsedQuery.provider === null || parsedQuery.provider === 'esri' ? [{ source: waybackBase }] : []),
    ]
      .filter(item => parsedQuery.provider === null || item.source.provider === parsedQuery.provider)
      .filter(item => parsedQuery.zoom === null
        || (item.source.minZoom <= parsedQuery.zoom && parsedQuery.zoom <= item.source.maxZoom))
    const context = Object.freeze({
      provider: parsedQuery.provider,
      at: parsedQuery.at === null ? null : Object.freeze({ ...parsedQuery.at }),
      zoom: parsedQuery.zoom,
    })
    const queryDigest = sha256(context)
    const offset = parsedQuery.cursor === null ? 0 : cursorOffset(parsedQuery.cursor, catalogVersion, queryDigest, filtered.length)
    let count = Math.min(parsedQuery.pageSize, filtered.length - offset)
    while (true) {
      const nextOffset = offset + count
      const nextCursor = nextOffset < filtered.length ? cursorOf(catalogVersion, queryDigest, nextOffset) : null
      const page: BasemapCatalogPage = Object.freeze({
        schemaVersion: 1,
        catalogVersion,
        canChange: config.limits.allowChanges,
        context,
        sources: Object.freeze(filtered.slice(offset, nextOffset).map(item => item.source)),
        nextCursor,
      })
      if (new TextEncoder().encode(JSON.stringify(page)).length <= config.limits.maxCatalogBytes) return page
      if (count <= 1) throw new SourceCatalogError('SOURCE_LIMIT_EXCEEDED')
      count -= 1
    }
  }

  const selection = (sourceIdValue: string, labelSourceIdValue?: string | null): SourceParseResult<BasemapSelection> => {
    if (!config.limits.allowChanges) return badSourceSelection('SOURCE_READ_ONLY')
    if (sourceIdValue === WAYBACK_SOURCE_ID) return badSourceSelection('SOURCE_NOT_FOUND')
    if (!sourceId(sourceIdValue) || (labelSourceIdValue != null && !sourceId(labelSourceIdValue))) {
      return badSourceSelection('SOURCE_RESOURCE_DENIED')
    }
    const basemap = byId.get(sourceIdValue)
    if (basemap === undefined) return badSourceSelection('SOURCE_NOT_FOUND')
    const labels = labelSourceIdValue == null ? null : byId.get(labelSourceIdValue)
    if (labelSourceIdValue != null && labels === undefined) return badSourceSelection('SOURCE_NOT_FOUND')
    if (basemap.source.availability.kind === 'unavailable') {
      return badSourceSelection(basemap.source.availability.reason === 'missing-credential' ? 'SOURCE_NOT_CONFIGURED' : 'SOURCE_UNAVAILABLE')
    }
    if (labels?.source.availability.kind === 'unavailable') {
      return badSourceSelection(labels.source.availability.reason === 'missing-credential' ? 'SOURCE_NOT_CONFIGURED' : 'SOURCE_UNAVAILABLE')
    }
    return createBasemapSelection(basemap.source, labels?.source ?? null)
  }

  const resolvedSource = (sourceIdValue: string, expectedDigest: string): ResolvedMapSource => {
    if (sourceIdValue === WAYBACK_SOURCE_ID) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    if (!sourceId(sourceIdValue)) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    const item = byId.get(sourceIdValue)
    if (item === undefined) throw new SourceCatalogError('SOURCE_NOT_FOUND')
    if (item.source.configDigest !== expectedDigest) throw new SourceCatalogError('SOURCE_CHANGED')
    if (item.source.availability.kind === 'unavailable') {
      throw new SourceCatalogError(item.source.availability.reason === 'missing-credential' ? 'SOURCE_NOT_CONFIGURED' : 'SOURCE_UNAVAILABLE')
    }
    const credential = item.binding === undefined || item.credentialValue === undefined ? undefined : {
      type: item.binding.type,
      ...(item.binding.type === 'query' ? { parameter: item.binding.parameter } : {}),
      value: item.credentialValue,
    }
    return Object.freeze({
      source: item.source,
      endpoint: item.endpoint,
      allowPrivateNetwork: item.allowPrivateNetwork,
      allowHttp: item.allowHttp,
      ...(item.wmts === undefined ? {} : { wmts: item.wmts }),
      ...(credential === undefined ? {} : { credential: Object.freeze(credential) }),
    })
  }

  const waybackDescriptorFor = async (releaseId: number, signal?: AbortSignal): Promise<BasemapSource> => {
    if (waybackBase.availability.kind === 'unavailable') throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    return descriptorFor(await wayback.release(releaseId, signal))
  }
  const verifyWaybackPolicy = (source: BasemapSource): void => {
    if (waybackBase.availability.kind === 'unavailable') throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    const releaseId = waybackReleaseOf(source)
    if (releaseId === null) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    const expected: BasemapSource = {
      ...waybackBase,
      configDigest: source.configDigest,
      title: source.title,
      release: source.release,
    }
    if (!/^[a-f0-9]{64}$/.test(source.configDigest) || !isValidSourceDate(source.release.publishedAt)
      || source.release.publishedAt === null || source.release.acquiredAt !== null
      || source.title !== `World Imagery (Wayback ${source.release.publishedAt})`
      || source.release.version !== String(releaseId) || !isDeepStrictEqual(source, expected)) {
      throw new SourceCatalogError('SOURCE_CHANGED')
    }
  }
  const verifyWaybackSource = async (source: BasemapSource, signal?: AbortSignal): Promise<BasemapSource> => {
    verifyWaybackPolicy(source)
    const releaseId = waybackReleaseOf(source)
    if (releaseId === null) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    const release = await wayback.release(releaseId, signal)
    const expected = descriptorFor(release)
    if (!isDeepStrictEqual(source, expected)) throw new SourceCatalogError('SOURCE_CHANGED')
    return expected
  }
  const verifyCachedWaybackSource = (source: BasemapSource): void => {
    verifyWaybackPolicy(source)
    const releaseId = waybackReleaseOf(source)
    if (releaseId === null) throw new SourceCatalogError('SOURCE_RESOURCE_DENIED')
    const release = wayback.cachedRelease(releaseId)
    if (release === undefined) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    if (!isDeepStrictEqual(source, descriptorFor(release))) throw new SourceCatalogError('SOURCE_CHANGED')
  }
  const waybackSelection = async (source: BasemapSource, signal?: AbortSignal): Promise<BasemapSource> => {
    if (!config.limits.allowChanges) throw new SourceCatalogError('SOURCE_READ_ONLY')
    return verifyWaybackSource(source, signal)
  }

  return Object.freeze({ catalogVersion, networkConfig: config.networkConfig, descriptorOf, list, selection, waybackSelection, verifyWaybackPolicy, verifyWaybackSource, verifyCachedWaybackSource, waybackDescriptor: waybackDescriptorFor, resolvedSource })
}
