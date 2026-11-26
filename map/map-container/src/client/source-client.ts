/**
 * Browser reads for the session-bound map source render protocol.
 * @module @map-harness/map-container/client/source-client
 */
import {
  MAP_SOURCE_RENDER_ROUTE,
  parseMapSourceRenderDescriptor,
  type MapSourceRenderDescriptor,
} from '../source-render-protocol.ts'
import {
  parseBasemapSource,
  type BasemapCatalogPage,
  type BasemapSource,
  type SourceProvider,
} from '@map-harness/map-layers'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The exact map catalog read failed or returned an invalid public page. */
    'map-source/read-failed': Record<string, never>
  }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Bounded public basemap catalog page for one Session. */
    'map-source': BasemapCatalogPage
  }
}

/**
 * Read one explicit selection's public render recipe from the exact host route.
 * @param sessionId - owning Session identity.
 * @param signal - caller cancellation.
 * @returns the parsed descriptor; HTTP and decode failures reject.
 */
export async function loadMapSourceDescriptor(
  sessionId: string,
  signal: AbortSignal,
): Promise<MapSourceRenderDescriptor> {
  const query = new URLSearchParams({ sessionId })
  const response = await fetch(`${MAP_SOURCE_RENDER_ROUTE}?${query.toString()}`, {
    signal,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`map source render request failed with HTTP ${response.status}`)
  const parsed = parseMapSourceRenderDescriptor(await response.json())
  if (!parsed.ok) throw new Error(`map source render descriptor was refused with ${parsed.code}`)
  return parsed.value
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) return undefined
  return value as Record<string, unknown>
}

function parseCatalogPage(value: unknown): BasemapCatalogPage | undefined {
  const record = exactObject(value, ['schemaVersion', 'catalogVersion', 'canChange', 'context', 'sources', 'nextCursor'])
  const providers = ['esri', 'osm', 'tianditu', 'amap', 'custom']
  if (record === undefined || record.schemaVersion !== 1 || typeof record.catalogVersion !== 'string'
    || !/^[a-f0-9]{64}$/u.test(record.catalogVersion)
    || typeof record.canChange !== 'boolean' || !Array.isArray(record.sources) || record.sources.length > 64
    || (typeof record.nextCursor !== 'string' && record.nextCursor !== null)) return undefined
  const context = exactObject(record.context, ['provider', 'at', 'zoom'])
  if (context === undefined) return undefined
  const provider = context.provider === null || typeof context.provider === 'string' ? context.provider : undefined
  const at = context.at === null ? null : exactObject(context.at, ['lon', 'lat'])
  if (provider === undefined || at === undefined || (provider !== null && !providers.includes(provider))) return undefined
  const zoom = context.zoom
  if (at !== null && (typeof at.lon !== 'number' || !Number.isFinite(at.lon)
    || typeof at.lat !== 'number' || !Number.isFinite(at.lat) || at.lon < -180 || at.lon > 180
    || at.lat < -90 || at.lat > 90)) return undefined
  if ((at === null) !== (zoom === null)) return undefined
  if (zoom !== null && (typeof zoom !== 'number' || !Number.isFinite(zoom) || zoom < 0 || zoom > 30)) return undefined
  if (typeof record.nextCursor === 'string' && (record.nextCursor.length > 256
    || !/^[A-Za-z0-9_-]+$/u.test(record.nextCursor))) return undefined
  const sources: BasemapSource[] = []
  for (const item of record.sources) {
    const parsed = parseBasemapSource(item)
    if (!parsed.ok) return undefined
    sources.push(parsed.value)
  }
  return Object.freeze({
    schemaVersion: 1,
    catalogVersion: record.catalogVersion,
    canChange: record.canChange,
    context: Object.freeze({
      provider: provider as SourceProvider | null,
      at: at === null ? null : Object.freeze({ lon: at.lon as number, lat: at.lat as number }),
      zoom: context.zoom as number | null,
    }),
    sources: Object.freeze(sources),
    nextCursor: record.nextCursor,
  })
}

/** Read and strictly decode one catalog page. */
async function fetchCatalogPage(address: string, signal: AbortSignal): Promise<BasemapCatalogPage> {
  const resource = new URL(address)
  const sessionId = decodeURIComponent(resource.pathname.replace(/^\//u, ''))
  const query = new URLSearchParams({
    sessionId,
    ...Object.fromEntries([...resource.searchParams].filter(([key]) => key !== 'sessionId')),
  })
  const response = await fetch(`/api/map/sources/catalog?${query.toString()}`, {
    signal,
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new Error(`map catalog request failed with HTTP ${response.status}`)
  const page = parseCatalogPage(await response.json())
  if (page === undefined) throw new Error('map catalog page failed strict decoding')
  return page
}

/** Create the one `map-source` provider owned by the browser plugin. */
export function mapSourceResourceProvider(retryDelayMs = 1_000): ResourceProvider<'map-source'> {
  return {
    protocol: 'map-source',
    async *open(address, { signal }): AsyncIterable<RemoteResult<BasemapCatalogPage>> {
      for (;;) {
        try {
          yield { ok: true, value: await fetchCatalogPage(address, signal) }
          return
        } catch (error) {
          if (signal.aborted) return
          yield {
            ok: false,
            error: new RemoteError('map-source/read-failed', 'The basemap catalog is unavailable.', {}, { cause: error }),
          }
        }
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, retryDelayMs)
            const abort = (): void => {
              clearTimeout(timer)
              reject(signal.reason)
            }
            signal.addEventListener('abort', abort, { once: true })
            if (signal.aborted) abort()
          })
        } catch {
          if (signal.aborted) return
          throw new Error('map source retry wait failed')
        }
        if (signal.aborted) return
      }
    },
  }
}
