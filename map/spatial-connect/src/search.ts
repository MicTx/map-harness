/** Tianditu REST retrieval with bounded transport and explicit result semantics. */
import {
  SearchError, resolveSearchRequest,
  type SearchFeature, type SpatialSearchRequest, type SpatialSearchResult,
  type SpatialSearchService, type SpatialSearchSpec,
} from './search-contract.ts'
export { SearchError, resolveSearchConfig, resolveSearchRequest } from './search-contract.ts'
export type { SpatialSearchConfig, SpatialSearchSpec, SpatialSearchService, SpatialSearchResult, SpatialSearchRequest, SearchFeature } from './search-contract.ts'

/** Reject malformed vendor objects without echoing response text. */
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SearchError('SEARCH_RESPONSE_INVALID', 'expected a vendor object')
  return value as Record<string, unknown>
}

function number(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) throw new SearchError('SEARCH_RESPONSE_INVALID', 'missing numeric vendor field')
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new SearchError('SEARCH_RESPONSE_INVALID', 'non-finite vendor number')
  return parsed
}

function coordinate(value: unknown): [number, number] {
  const parts = typeof value === 'string' ? value.split(',') : value
  if (!Array.isArray(parts) || parts.length !== 2) throw new SearchError('SEARCH_RESPONSE_INVALID', 'missing lon,lat pair')
  const lon = number(parts[0]), lat = number(parts[1])
  if (lon < -180 || lon > 180 || lat < -90 || lat > 90) throw new SearchError('SEARCH_RESPONSE_INVALID', 'vendor coordinate outside the geographic domain')
  return [lon, lat]
}

function assertNever(_value: never): never {
  throw new SearchError('SEARCH_INVALID_INPUT', 'unsupported spatial search request')
}

function totalOf(value: unknown): number {
  const total = number(value)
  if (!Number.isSafeInteger(total) || total < 0) throw new SearchError('SEARCH_RESPONSE_INVALID', 'invalid vendor result count')
  return total
}

function vendorStatus(body: Record<string, unknown>): void {
  const status = body.status
  const code = body.returncode ?? body.code ?? (typeof status === 'object' && status !== null ? object(status).infocode : status)
  if (code === undefined || ['0', '100', '200', '1000', '10000'].includes(String(code))) return
  const category = ['401', '403', '1003', '1004', '1005', '1006', '1008', '301012', '308011'].includes(String(code))
    ? 'SEARCH_AUTH_DENIED' : String(code) === '429' ? 'SEARCH_RATE_LIMITED' : 'SEARCH_UNAVAILABLE'
  throw new SearchError(category, 'the spatial data provider refused the request')
}

/** Read and decode at most the configured number of bytes, including streamed bodies. */
async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) throw new SearchError('SEARCH_RESPONSE_INVALID', 'empty vendor response body')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel()
    throw new SearchError('SEARCH_TOO_LARGE', 'vendor response exceeds the configured byte limit')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new SearchError('SEARCH_TOO_LARGE', 'vendor response exceeds the configured byte limit')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) {
    void error
    throw new SearchError('SEARCH_RESPONSE_INVALID', 'vendor response is not valid JSON')
  }
}

function requestUrl(spec: SpatialSearchSpec, request: SpatialSearchRequest): URL {
  let path: string
  let body: Record<string, string | number>
  switch (request.kind) {
    case 'geocode': path = '/geocoder'; body = { keyWord: request.query }; break
    case 'reverse': path = '/geocoder'; body = { lon: request.point[0], lat: request.point[1], ver: 1 }; break
    case 'district':
      path = '/administrative'
      body = { searchWord: request.query, searchType: /^\d+$/.test(request.query) ? '2' : '1', needSubInfo: 'false', needAll: 'false', needPolygon: String(request.boundary), needPre: 'true' }
      break
    case 'search':
      path = '/v2/search'
      body = { keyWord: request.query, queryType: request.bbox === undefined ? 4 : 2, start: request.offset, count: request.limit, level: request.level, show: '2' }
      if (request.bbox !== undefined) body.mapBound = request.bbox.join(',')
      if (request.region !== undefined) body.specify = request.region
      break
    default: return assertNever(request)
  }
  const url = new URL(path, spec.baseUrl)
  url.searchParams.set('tk', spec.apiKey)
  url.searchParams.set(request.kind === 'geocode' ? 'ds' : 'postStr', JSON.stringify(body))
  if (request.kind === 'reverse') url.searchParams.set('type', 'geocode')
  if (request.kind === 'search') url.searchParams.set('type', 'query')
  return url
}

function decodeResult(raw: unknown, request: SpatialSearchRequest, spec: SpatialSearchSpec): SpatialSearchResult {
  const body = object(raw)
  vendorStatus(body)
  const clean = (value: unknown, fallback = ''): string => typeof value === 'string'
    ? value.replaceAll(spec.apiKey, '[redacted]').slice(0, 1024) : fallback
  const features: SearchFeature[] = []
  let total = 0
  let consumed = 0
  let coordinateCount = 0
  const limits = ['Coordinates use the provider\'s CGCS2000 geographic convention (EPSG:4490).', 'Provider records are observations, not independently verified ground truth.']
  const addPoint = (coordinates: [number, number], properties: Record<string, string>): void => {
    coordinateCount++
    if (coordinateCount > spec.maxCoordinates) throw new SearchError('SEARCH_TOO_LARGE', 'result exceeds the configured coordinate limit')
    features.push({ type: 'Feature', geometry: { type: 'Point', coordinates }, properties: { provider: 'tianditu', ...properties } })
  }
  switch (request.kind) {
    case 'geocode': {
      const location = object(body.location)
      addPoint(coordinate([location.lon, location.lat]), { name: request.query, geometry_role: 'geocode-candidate' })
      total = 1
      limits.push('A geocoder supplies one candidate; it does not establish that the place name is unique. Use an area-bound search to inspect alternatives.')
      break
    }
    case 'reverse': {
      const result = object(body.result)
      if (typeof result.formatted_address !== 'string') throw new SearchError('SEARCH_RESPONSE_INVALID', 'reverse geocoder omitted its address')
      addPoint(request.point, { name: clean(result.formatted_address), geometry_role: 'reverse-geocode-input' })
      total = 1
      break
    }
    case 'search': {
      total = totalOf(body.count)
      const rows = body.pois === undefined && total === 0 ? [] : body.pois
      if (!Array.isArray(rows)) throw new SearchError('SEARCH_RESPONSE_INVALID', 'provider returned suggestions or an unsupported result instead of POIs')
      if (rows.length > request.limit) throw new SearchError('SEARCH_TOO_LARGE', 'vendor returned more rows than requested')
      consumed = rows.length
      if (consumed > 0 && request.offset + consumed > total) throw new SearchError('SEARCH_RESPONSE_INVALID', 'vendor page exceeds its declared total')
      const seen = new Set<string>()
      for (const value of rows) {
        const row = object(value)
        const coords = coordinate(row.lonlat)
        if (typeof row.name !== 'string' || !row.name.trim()) throw new SearchError('SEARCH_RESPONSE_INVALID', 'POI name is missing')
        const properties = { name: clean(row.name), address: clean(row.address), geometry_role: 'poi' }
        const identity = JSON.stringify([coords, properties])
        if (seen.has(identity)) continue
        seen.add(identity)
        addPoint(coords, properties)
      }
      if (consumed === 0 && request.offset < total) throw new SearchError('SEARCH_RESPONSE_INVALID', 'provider pagination made no progress')
      break
    }
    case 'district': {
      if (!Array.isArray(body.data)) throw new SearchError('SEARCH_RESPONSE_INVALID', 'district response omitted its data array')
      if (body.data.length > 20) throw new SearchError('SEARCH_TOO_LARGE', 'district query is ambiguous; narrow the place name')
      total = body.data.length
      for (const value of body.data) {
        const row = object(value)
        if (typeof row.name !== 'string' || !row.name.trim()) throw new SearchError('SEARCH_RESPONSE_INVALID', 'district name is missing')
        const properties = { provider: 'tianditu', name: clean(row.name), code: clean(row.cityCode) }
        if (!request.boundary) {
          addPoint(coordinate(row.lonlat), { ...properties, geometry_role: 'district-center' })
          continue
        }
        if (typeof row.points !== 'string' || !row.points.trim()) throw new SearchError('SEARCH_RESPONSE_INVALID', 'district boundary coordinates are unavailable; a bounding box is not a boundary')
        const parts = row.points.split(';').filter(part => part.trim())
        if (coordinateCount + parts.length > spec.maxCoordinates) throw new SearchError('SEARCH_TOO_LARGE', 'district boundaries exceed the configured coordinate limit')
        const ring = parts.map(coordinate)
        if (new Set(ring.map(point => point.join(','))).size < 3) throw new SearchError('SEARCH_RESPONSE_INVALID', 'district boundary has fewer than three distinct vertices')
        const first = ring[0]
        const last = ring.at(-1)
        if (first === undefined || last === undefined) throw new SearchError('SEARCH_RESPONSE_INVALID', 'empty district boundary')
        if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first])
        coordinateCount += ring.length
        if (coordinateCount > spec.maxCoordinates) throw new SearchError('SEARCH_TOO_LARGE', 'closed district boundaries exceed the configured coordinate limit')
        features.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: { ...properties, geometry_role: 'administrative-boundary' } })
      }
      break
    }
    default: return assertNever(request)
  }
  const next = request.kind === 'search' ? request.offset + consumed : total
  const hasMore = request.kind === 'search' && next < total
  if (hasMore && next > 10000) throw new SearchError('SEARCH_TOO_LARGE', 'search pagination exceeds the supported offset; narrow the area')
  return { provider: 'tianditu', nativeCrs: 'EPSG:4490', request, retrievedAt: new Date().toISOString(), data: { type: 'FeatureCollection', features }, total, hasMore, nextOffset: hasMore ? next : null, limitations: limits }
}

/**
 * Create one bounded provider; the owner must await close during teardown.
 * @param spec - resolved deployment settings, or undefined for an unconfigured service.
 * @returns a service whose requests never accept arbitrary URLs or credential values.
 */
export function createSpatialSearch(spec: SpatialSearchSpec | undefined): SpatialSearchService {
  const shutdown = new AbortController()
  const active = new Set<Promise<SpatialSearchResult>>()
  let closed = false
  async function execute(config: SpatialSearchSpec, request: SpatialSearchRequest, signal?: AbortSignal): Promise<SpatialSearchResult> {
    const deadline = AbortSignal.timeout(config.timeoutMs)
    const combined = AbortSignal.any([shutdown.signal, deadline, ...(signal === undefined ? [] : [signal])])
    try {
      combined.throwIfAborted()
      const response = await fetch(requestUrl(config, request), { signal: combined, redirect: 'error', headers: { Accept: 'application/json' } })
      if (!response.ok) {
        await response.body?.cancel()
        throw new SearchError(response.status === 401 || response.status === 403 ? 'SEARCH_AUTH_DENIED' : response.status === 429 ? 'SEARCH_RATE_LIMITED' : 'SEARCH_UNAVAILABLE', `provider HTTP status ${response.status}`)
      }
      const raw = await readJson(response, config.maxResponseBytes)
      combined.throwIfAborted()
      return decodeResult(raw, request, config)
    } catch (error) {
      if (signal?.aborted || shutdown.signal.aborted) throw new SearchError('SEARCH_CANCELLED', 'search was cancelled')
      if (deadline.aborted) throw new SearchError('SEARCH_TIMEOUT', 'search deadline expired')
      if (error instanceof SearchError) throw error
      throw new SearchError('SEARCH_UNAVAILABLE', 'spatial search transport failed; no result was published')
    }
  }
  return {
    async search(input, signal) {
      if (closed) throw new SearchError('SEARCH_DISPOSED', 'spatial search is closed')
      if (spec === undefined) throw new SearchError('SEARCH_NOT_CONFIGURED', 'declare the Tianditu search credential in the spatial-connect configuration')
      const request = resolveSearchRequest(input)
      if (active.size >= spec.maxConcurrent) throw new SearchError('SEARCH_RATE_LIMITED', 'spatial search concurrency limit reached')
      const work = execute(spec, request, signal)
      active.add(work)
      try { return await work } finally { active.delete(work) }
    },
    async close() {
      closed = true
      shutdown.abort()
      await Promise.allSettled([...active])
    },
  }
}
