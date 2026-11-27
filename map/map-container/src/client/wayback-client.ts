/**
 * Strictly decoded same-origin Wayback release admission and point evidence reads.
 * @module @map-harness/map-container/client/wayback-client
 */
import { isValidSourceDate, parseBasemapSource, type BasemapSource } from '@map-harness/map-layers'
import type { WaybackCatalogRelease } from '../wayback-catalog-codec.ts'
import type { WaybackCoverage, WaybackSample, WaybackViewport } from '../wayback.ts'

/** Same-origin credentialed route that verifies one browser-selected release. */
export const MAP_WAYBACK_ADMIT_ROUTE = '/api/map/wayback/admit'

/** Why an admission did not produce a canonical source; fixed values only, never upstream text. */
export type WaybackAdmitFailure =
  | 'denied' /** Deployment policy or Session permission withholds this selection. */
  | 'changed' /** The release is absent from the admitted catalog or its identity changed. */
  | 'unavailable' /** The host could not verify the release now. */
  | 'invalid' /** The response is not the canonical descriptor of the requested release. */
  | 'network' /** The request itself failed. */
  | 'cancelled' /** The caller cancelled its own wait. */

/** Settled admission; it never rejects. */
export type WaybackAdmitResult =
  | { readonly ok: true; readonly source: BasemapSource }
  | { readonly ok: false; readonly reason: WaybackAdmitFailure }

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
  if (!response.ok) throw new Error(`Wayback request failed with HTTP ${response.status}`)
  return response.json()
}

const ADMIT_FAILURES: Readonly<Record<string, WaybackAdmitFailure>> = Object.freeze({
  SOURCE_RESOURCE_DENIED: 'denied', SOURCE_READ_ONLY: 'denied', SOURCE_POLICY_DENIED: 'denied',
  SOURCE_CHANGED: 'changed', SOURCE_NOT_FOUND: 'changed',
  SOURCE_UNAVAILABLE: 'unavailable', SOURCE_NOT_CONFIGURED: 'unavailable', SOURCE_CREDENTIAL_REJECTED: 'unavailable',
  SOURCE_TIMEOUT: 'unavailable', SOURCE_LIMIT_EXCEEDED: 'unavailable',
})

/**
 * Verify one browser-discovered release identity through the Session's credentialed route.
 * The descriptor is a host decision: only the identity sent is trusted from the browser.
 * @param sessionId - owning Session identity.
 * @param release - identity from the catalog owner's verified snapshot.
 * @param signal - caller cancellation.
 * @returns the canonical source, or a fixed failure reason; never rejects.
 */
export async function admitWaybackRelease(sessionId: string, release: WaybackCatalogRelease, signal: AbortSignal): Promise<WaybackAdmitResult> {
  const identity = { releaseId: release.releaseId, itemId: release.itemId, publishedAt: release.publishedAt, layerIdentifier: release.layerIdentifier }
  let response: Response
  try {
    response = await fetch(MAP_WAYBACK_ADMIT_ROUTE, {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ sessionId, release: identity }),
    })
  } catch {
    return { ok: false, reason: signal.aborted ? 'cancelled' : 'network' }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { ok?: unknown; code?: unknown } | null
    return { ok: false, reason: payload?.ok === false && typeof payload.code === 'string' ? ADMIT_FAILURES[payload.code] ?? 'unavailable' : 'unavailable' }
  }
  const parsed = parseBasemapSource(await response.json().catch(() => null))
  if (!parsed.ok || parsed.value.id !== 'esri-wayback' || parsed.value.release.version !== String(identity.releaseId)
    || parsed.value.release.publishedAt !== identity.publishedAt || parsed.value.title !== `World Imagery (Wayback ${identity.publishedAt})`) {
    return { ok: false, reason: 'invalid' }
  }
  return { ok: true, source: parsed.value }
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
