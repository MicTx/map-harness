/** The OSM Overpass footprint provider: bounded query, bounded retries, strict decode. */
import { FootprintError, resolveFootprintRequest, type Footprint, type FootprintRequest, type FootprintResult, type FootprintsSpec, type SpatialFootprintsService } from './footprints-contract.ts'

export { FootprintError, resolveFootprintRequest, resolveFootprintsConfig } from './footprints-contract.ts'
export type { Footprint, FootprintRequest, FootprintResult, FootprintsConfig, FootprintsSpec, SpatialFootprintsService } from './footprints-contract.ts'

const USER_AGENT = 'map-harness-refine/0.1 (+https://github.com/)'

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/**
 * The Overpass QL statement: closed ways with a building tag inside the window, with full geometry.
 * Relations are requested by tags only; a multipolygon cannot be rebuilt from `out geom` member order reliably
 * and is reported as a limitation instead of guessed.
 * @param request - validated request.
 * @returns the `data=` form body.
 */
export function overpassQuery(request: FootprintRequest, serverTimeoutSeconds = 25): string {
  const [west, south, east, north] = request.bbox
  const serverTimeout = Math.min(60, Math.max(5, Math.floor(serverTimeoutSeconds)))
  const filter = request.building === undefined ? '["building"]' : `["building"="${request.building.replace(/[\\"]/g, '')}"]`
  return `[out:json][timeout:${serverTimeout}];way${filter}(${south},${west},${north},${east});out geom ${request.limit};`
}

/**
 * Decode one Overpass element into a footprint. A way whose geometry is not a closed ring of ≥4 points is skipped,
 * never coerced.
 * @param element - one Overpass `elements[]` entry.
 * @returns a footprint, or undefined when the element carries no usable ring.
 */
export function decodeFootprint(element: unknown): Footprint | undefined {
  const record = object(element)
  if (record.type !== 'way') return undefined
  const geometry = Array.isArray(record.geometry) ? record.geometry : []
  const ring = geometry.map(point => {
    const p = object(point)
    return typeof p.lon === 'number' && typeof p.lat === 'number' ? [p.lon, p.lat] as [number, number] : undefined
  })
  if (ring.length < 4 || ring.some(point => point === undefined)) return undefined
  const points = ring as [number, number][]
  const first = points[0]!
  const last = points[points.length - 1]!
  if (first[0] !== last[0] || first[1] !== last[1]) return undefined
  if (points.some(([lon, lat]) => Math.abs(lon) > 180 || Math.abs(lat) > 90)) return undefined
  const tags = object(record.tags)
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [points] },
    properties: {
      id: `osm/way/${String(record.id)}`,
      name: string(tags.name),
      building: string(tags.building),
      levels: positiveNumber(tags['building:levels']),
      height: positiveNumber(tags.height),
    },
  }
}

/**
 * Decode an Overpass JSON body into a bounded page.
 * @param raw - parsed response JSON.
 * @param request - the request that produced it.
 * @param spec - resolved source configuration.
 * @returns a validated footprint page.
 */
export function decodeFootprints(raw: unknown, request: FootprintRequest, spec: FootprintsSpec): FootprintResult {
  const body = object(raw)
  if (body.remark !== undefined && typeof body.remark === 'string' && /error|runtime|timeout/i.test(body.remark)) {
    throw new FootprintError('FOOTPRINTS_RESPONSE_INVALID', 'footprint source reported a query error')
  }
  const elements = Array.isArray(body.elements) ? body.elements : []
  const features: Footprint[] = []
  for (const element of elements) {
    const footprint = decodeFootprint(element)
    if (footprint !== undefined) features.push(footprint)
  }
  const limitations = ['Multipolygon relations are not rebuilt; only closed ways with a building tag are returned.']
  if (elements.length > features.length) limitations.push(`${elements.length - features.length} element(s) had no closed way geometry and were skipped.`)
  return {
    provider: 'osm-overpass',
    nativeCrs: 'EPSG:4326',
    request,
    retrievedAt: new Date().toISOString(),
    licence: spec.licence,
    attribution: spec.attribution,
    data: { type: 'FeatureCollection', features },
    total: features.length,
    truncated: elements.length >= request.limit,
    limitations,
  }
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) throw new FootprintError('FOOTPRINTS_RESPONSE_INVALID', 'empty footprint source response body')
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel()
    throw new FootprintError('FOOTPRINTS_TOO_LARGE', 'footprint source response exceeds the configured byte limit')
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
        throw new FootprintError('FOOTPRINTS_TOO_LARGE', 'footprint source response exceeds the configured byte limit')
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) {
    void error
    throw new FootprintError('FOOTPRINTS_RESPONSE_INVALID', 'footprint source response is not valid JSON')
  }
}

/**
 * Create the footprint service. Each call runs at most `maxRetries + 1` attempts; only transport
 * failures and 5xx are retried, never 4xx, and never past the per-attempt deadline.
 * @param spec - resolved source, or a resolver called per request.
 * @returns the host service.
 */
export function createSpatialFootprints(
  spec: FootprintsSpec | (() => FootprintsSpec | undefined) | undefined,
): SpatialFootprintsService {
  const shutdown = new AbortController()
  const active = new Set<Promise<FootprintResult>>()
  let closed = false
  async function attempt(config: FootprintsSpec, request: FootprintRequest, signal: AbortSignal | undefined): Promise<FootprintResult> {
    const deadline = AbortSignal.timeout(config.timeoutMs)
    const combined = AbortSignal.any([shutdown.signal, deadline, ...(signal === undefined ? [] : [signal])])
    combined.throwIfAborted()
    const response = await fetch(config.baseUrl, {
      method: 'POST',
      signal: combined,
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ data: overpassQuery(request, config.timeoutMs / 1000) }).toString(),
    })
    if (!response.ok) {
      await response.body?.cancel()
      // 429 and 5xx are transport-level and retried; a 4xx is the deployment's answer and is final.
      const code = response.status === 429 ? 'FOOTPRINTS_RATE_LIMITED' : response.status >= 500 ? 'FOOTPRINTS_UNAVAILABLE' : 'FOOTPRINTS_SOURCE_INVALID'
      throw new FootprintError(code, `footprint source answered HTTP ${response.status}`)
    }
    const raw = await readJson(response, config.maxResponseBytes)
    combined.throwIfAborted()
    return decodeFootprints(raw, request, config)
  }
  async function execute(config: FootprintsSpec, request: FootprintRequest, signal: AbortSignal | undefined): Promise<FootprintResult> {
    let lastError: unknown
    for (let tries = 0; tries <= config.maxRetries; tries++) {
      try {
        return await attempt(config, request, signal)
      } catch (error) {
        if (signal?.aborted || shutdown.signal.aborted) throw new FootprintError('FOOTPRINTS_CANCELLED', 'footprint retrieval was cancelled')
        if (error instanceof FootprintError && (error.code === 'FOOTPRINTS_RATE_LIMITED' || error.code === 'FOOTPRINTS_UNAVAILABLE')) {
          lastError = error
          if (tries < config.maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 250 * 2 ** tries))
            continue
          }
        }
        throw error
      }
    }
    throw lastError instanceof FootprintError ? lastError : new FootprintError('FOOTPRINTS_UNAVAILABLE', 'footprint source transport failed; no result was published')
  }
  return {
    async footprints(input, signal) {
      if (closed) throw new FootprintError('FOOTPRINTS_DISPOSED', 'footprint retrieval is closed')
      const config = typeof spec === 'function' ? spec() : spec
      if (config === undefined) throw new FootprintError('FOOTPRINTS_NOT_CONFIGURED', 'no footprint source is configured')
      const request = resolveFootprintRequest(input)
      if (active.size >= config.maxConcurrent) throw new FootprintError('FOOTPRINTS_RATE_LIMITED', 'footprint retrieval concurrency limit reached')
      const work = execute(config, request, signal)
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
