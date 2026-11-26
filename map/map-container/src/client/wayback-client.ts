/**
 * Strictly decoded same-origin Wayback catalog and point evidence reads.
 * @module @map-harness/map-container/client/wayback-client
 */
import { isValidSourceDate, parseBasemapSource, type BasemapSource } from '@map-harness/map-layers'
import { WaybackCatalogPreparingError } from '../source-error.ts'
import type { WaybackCoverage, WaybackSample, WaybackViewport } from '../wayback.ts'

/** A published release with its independently observed acquisition date. */
export interface WaybackRelease {
  readonly releaseId: number
  readonly title: string
  readonly publishedAt: string
  readonly acquiredAt: string | null
  readonly provider: string | null
  readonly resolution: string | null
  readonly accuracy: string | null
  readonly metadataStatus?: 'known' | 'unknown' | 'unavailable' | 'not-queried'
}

/** Local samples never assert whole-extent coverage. */
export interface WaybackLocalPage {
  readonly coverage: 'sampled'
  readonly point: { readonly lon: number; readonly lat: number }
  readonly zoom: number
  readonly releases: readonly WaybackRelease[]
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid Wayback response')
  return value as Record<string, unknown>
}

function release(value: unknown): WaybackRelease {
  const record = object(value)
  if (!Number.isSafeInteger(record.releaseId) || (record.releaseId as number) <= 0
    || typeof record.title !== 'string' || typeof record.publishedAt !== 'string' || !isValidSourceDate(record.publishedAt)
    || !isValidSourceDate(record.acquiredAt) || record.title !== `World Imagery (Wayback ${record.publishedAt})`) throw new Error('invalid Wayback release')
  const optional = (input: unknown): string | null => {
    if (input === null || input === undefined) return null
    if (typeof input !== 'string') throw new Error('invalid Wayback evidence')
    return input
  }
  if (record.metadataStatus !== undefined
    && !['known', 'unknown', 'unavailable', 'not-queried'].includes(String(record.metadataStatus))) throw new Error('invalid Wayback metadata status')
  if (record.metadataStatus === 'known' && record.acquiredAt === null
    || record.metadataStatus !== undefined && record.metadataStatus !== 'known' && record.acquiredAt !== null) {
    throw new Error('invalid Wayback metadata status')
  }
  return {
    releaseId: record.releaseId as number,
    title: record.title,
    publishedAt: record.publishedAt,
    acquiredAt: record.acquiredAt as string | null,
    provider: optional(record.provider),
    resolution: optional(record.resolution),
    accuracy: optional(record.accuracy),
    ...(record.metadataStatus === undefined ? {} : { metadataStatus: record.metadataStatus as NonNullable<WaybackRelease['metadataStatus']> }),
  }
}

async function read(sessionId: string, parameters: URLSearchParams, signal: AbortSignal): Promise<unknown> {
  parameters.set('sessionId', sessionId)
  const response = await fetch(`/api/map/wayback?${parameters.toString()}`, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) {
    if (parameters.get('operation') === 'catalog' && response.status === 503
      && response.headers.get('retry-after') === String(WaybackCatalogPreparingError.retryAfterSeconds)) {
      throw new WaybackCatalogPreparingError()
    }
    throw new Error(`Wayback request failed with HTTP ${response.status}`)
  }
  return response.json()
}

/** Read the complete bounded local catalog, continuing through each page in order. */
export async function readWaybackReleases(sessionId: string, signal: AbortSignal): Promise<readonly { release: WaybackRelease; descriptor: BasemapSource }[]> {
  const result: { release: WaybackRelease; descriptor: BasemapSource }[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const parameters = new URLSearchParams({ operation: 'catalog', pageSize: '50' })
    if (cursor !== null) parameters.set('cursor', cursor)
    const payload = object(await read(sessionId, parameters, signal))
    if (!Array.isArray(payload.releases) || payload.releases.length > 50
      || payload.schemaVersion !== 1 || !(payload.nextCursor === null || typeof payload.nextCursor === 'string')) throw new Error('invalid Wayback catalog')
    const seenIds = new Set(result.map(item => item.release.releaseId))
    for (const item of payload.releases) {
      const record = object(item)
      const parsed = parseBasemapSource(record.descriptor)
      const entry = release(item)
      if (!parsed.ok || parsed.value.id !== 'esri-wayback' || parsed.value.release.version !== String(entry.releaseId)
        || parsed.value.title !== entry.title || parsed.value.release.publishedAt !== entry.publishedAt
        || parsed.value.release.acquiredAt !== null || seenIds.has(entry.releaseId)) {
        throw new Error('invalid Wayback source')
      }
      seenIds.add(entry.releaseId)
      result.push({ release: entry, descriptor: parsed.value })
    }
    if (result.length > 256) throw new Error('Wayback catalog exceeds limit')
    cursor = payload.nextCursor
    if (cursor !== null) {
      if (cursors.has(cursor)) throw new Error('invalid Wayback continuation')
      cursors.add(cursor)
    }
  } while (cursor !== null)
  if (result.length === 0) throw new Error('empty Wayback catalog')
  return result
}

/** Read local releases and their independent metadata for a point and zoom. */
export async function readWaybackLocal(sessionId: string, point: { readonly lon: number; readonly lat: number }, zoom: number, signal: AbortSignal): Promise<WaybackLocalPage> {
  const payload = object(await read(sessionId, new URLSearchParams({ operation: 'local', lon: String(point.lon), lat: String(point.lat), zoom: String(zoom) }), signal))
  const returnedPoint = object(payload.point)
  if (payload.schemaVersion !== 1 || payload.coverage !== 'sampled' || !Array.isArray(payload.releases) || payload.releases.length > 256
    || returnedPoint.lon !== point.lon || returnedPoint.lat !== point.lat || payload.zoom !== zoom) throw new Error('invalid local Wayback response')
  const releases = payload.releases.map(release)
  if (new Set(releases.map(item => item.releaseId)).size !== releases.length
    || releases.some((item, index) => index > 0 && item.publishedAt < releases[index - 1]!.publishedAt)) {
    throw new Error('invalid local Wayback ordering')
  }
  return { coverage: 'sampled', point, zoom, releases }
}

/** Read acquisition evidence for one fixed release; absence remains null. */
export async function readWaybackMetadata(sessionId: string, point: { readonly lon: number; readonly lat: number }, zoom: number, releaseId: number, signal: AbortSignal): Promise<WaybackRelease | null> {
  const value = await read(sessionId, new URLSearchParams({ operation: 'metadata', lon: String(point.lon), lat: String(point.lat), zoom: String(zoom), releaseId: String(releaseId) }), signal)
  if (value === null) return null
  const record = object(value)
  const returnedPoint = object(record.point)
  const entry = release(value)
  if (entry.releaseId !== releaseId || returnedPoint.lon !== point.lon || returnedPoint.lat !== point.lat || record.zoom !== Math.round(zoom)) {
    throw new Error('invalid Wayback metadata')
  }
  return entry
}

/** Read center and corner acquisition samples for the active fixed release. */
export async function readWaybackCoverage(sessionId: string, viewport: WaybackViewport, zoom: number, releaseId: number, signal: AbortSignal): Promise<WaybackCoverage> {
  const [minX, minY, maxX, maxY] = viewport.extent
  const parameters = new URLSearchParams({
    operation: 'coverage', lon: String(viewport.center[0]), lat: String(viewport.center[1]), zoom: String(zoom), releaseId: String(releaseId),
    minX: String(minX), minY: String(minY), maxX: String(maxX), maxY: String(maxY), wkid: String(viewport.wkid),
  })
  const payload = object(await read(sessionId, parameters, signal))
  const reportedViewport = object(payload.viewport)
  if (payload.releaseId !== releaseId || payload.zoom !== Math.round(zoom)
    || reportedViewport.wkid !== viewport.wkid || !Array.isArray(reportedViewport.extent)
    || reportedViewport.extent.length !== viewport.extent.length
    || reportedViewport.extent.some((value, index) => value !== viewport.extent[index])
    || !['sampled', 'partial', 'unknown'].includes(String(payload.coverage))
    || !Array.isArray(payload.samples) || payload.samples.length !== 5) throw new Error('invalid Wayback coverage')
  const projectedPoints = [viewport.center, [minX, minY], [minX, maxY], [maxX, minY], [maxX, maxY]]
  const samples = payload.samples.map((value, index): WaybackSample => {
    const sample = object(value)
    const point = object(sample.point)
    if (typeof point.lon !== 'number' || !Number.isFinite(point.lon) || typeof point.lat !== 'number' || !Number.isFinite(point.lat)
      || !['known', 'unknown', 'missing', 'unavailable'].includes(String(sample.status))
      || !isValidSourceDate(sample.acquiredAt)
      || ![sample.provider, sample.resolution, sample.accuracy].every(value => value === null || typeof value === 'string')) {
      throw new Error('invalid Wayback coverage sample')
    }
    const projected = projectedPoints[index]!
    const expectedLon = viewport.wkid === 4326 ? projected[0]! : projected[0]! / 6_378_137 * 180 / Math.PI
    const expectedLat = viewport.wkid === 4326 ? projected[1]! : (2 * Math.atan(Math.exp(projected[1]! / 6_378_137)) - Math.PI / 2) * 180 / Math.PI
    if (![4326, 3857, 102100, 102113].includes(viewport.wkid) || point.lon !== expectedLon || point.lat !== expectedLat) {
      throw new Error('invalid Wayback coverage point')
    }
    const status = sample.status as WaybackSample['status']
    if ((status === 'known') !== (sample.acquiredAt !== null)
      || (status === 'missing' || status === 'unavailable') && [sample.provider, sample.resolution, sample.accuracy].some(value => value !== null)) {
      throw new Error('invalid Wayback coverage sample')
    }
    return {
      point: { lon: point.lon, lat: point.lat }, status, acquiredAt: sample.acquiredAt as string | null,
      provider: sample.provider as string | null, resolution: sample.resolution as string | null, accuracy: sample.accuracy as string | null,
    }
  })
  const statuses = new Set(samples.map(sample => sample.status))
  const knownDates = new Set(samples.flatMap(sample => sample.acquiredAt === null ? [] : [sample.acquiredAt]))
  // Mirror the host's derivation: the panel copy says "dates or metadata
  // differ", so same-day samples from different providers or resolutions are
  // partial, not agreement.
  const knownMetadata = new Set(samples.flatMap(sample => sample.status === 'known'
    ? [JSON.stringify([sample.provider, sample.resolution, sample.accuracy])] : []))
  const expected = (statuses.has('missing') && statuses.has('known')) || knownDates.size > 1 || knownMetadata.size > 1
    ? 'partial'
    : statuses.has('unknown') || statuses.has('unavailable') || statuses.has('missing') ? 'unknown' : 'sampled'
  if (payload.coverage !== expected) throw new Error('invalid Wayback coverage status')
  return { releaseId, viewport: { extent: viewport.extent, wkid: viewport.wkid }, zoom: Math.round(zoom), coverage: expected, samples }
}
