/**
 * Isolated official Wayback CJS runtime. Only validated parent transport is used.
 * @module @map-harness/map-container/wayback-worker
 */
import { parentPort } from 'node:worker_threads'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { getMetadata, getWaybackItems, lat2tile, long2tile } from '@esri/wayback-core'
import { getReleasesWithLocalChanges } from '@esri/wayback-core/dist/change-detector/changeDetector.js'

if (parentPort === null) throw new Error('Wayback worker requires a parent port')
const port = parentPort
let sequence = 0
const requests = new Map<number, { owner: number; resolve: (value: Response) => void; reject: (error: Error) => void }>()
const ownership = new AsyncLocalStorage<number>()
const controllers = new Map<number, AbortController>()
const requestsByOwner = new Map<number, number>()
/** Start the worker protocol once within a worker thread. */
export const waybackWorkerEntry = 'wayback-worker'

globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const id = ++sequence
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const owner = ownership.getStore()
  if (owner === undefined) return Promise.reject(new Error('Wayback request has no owner'))
  if (controllers.get(owner)?.signal.aborted !== false || init?.signal?.aborted === true) {
    return Promise.reject(new Error('Wayback request cancelled'))
  }
  const count = (requestsByOwner.get(owner) ?? 0) + 1
  // One official catalog read plus one tilemap and one image per release.
  if (count > 1 + 2 * 256) return Promise.reject(new Error('Wayback request limit exceeded'))
  requestsByOwner.set(owner, count)
  const promise = new Promise<Response>((resolve, reject) => requests.set(id, { owner, resolve, reject }))
  port.postMessage({ kind: 'fetch', id, owner, url, method: init?.method ?? 'GET' })
  return promise
}

port.on('message', (message: {
  kind: string
  id: number
  operation?: string
  point?: { longitude: number; latitude: number }
  zoom?: number
  releaseNumber?: number
  expected?: { itemId: string; metadataLayerUrl: string }
  status?: number
  headers?: [string, string][]
  body?: string
  error?: string
}) => {
  if (message.kind === 'abort') {
    controllers.get(message.id)?.abort()
    for (const [id, request] of requests) {
      if (request.owner !== message.id) continue
      requests.delete(id)
      request.reject(new Error('Wayback request cancelled'))
    }
    return
  }
  if (message.kind === 'response') {
    const request = requests.get(message.id)
    requests.delete(message.id)
    if (request === undefined) return
    if (message.error !== undefined) {
      // The parent sends one stable source code. Keep diagnostics useful
      // without echoing arbitrary text that could carry upstream detail.
      const code = /^SOURCE_[A-Z_]{1,40}$/u.test(message.error) ? message.error : 'SOURCE_UNAVAILABLE'
      request.reject(new Error(`Wayback source request failed: ${code}`))
    }
    else request.resolve(new Response(message.body === undefined ? null : Buffer.from(message.body, 'base64'), {
      status: message.status ?? 200,
      headers: message.headers ?? [],
    }))
    return
  }
  if (message.kind !== 'call') return
  const controller = new AbortController()
  controllers.set(message.id, controller)
  const signal = controller.signal
  const work = ownership.run(message.id, () => message.operation === 'list' ? getWaybackItems()
    : message.operation === 'local' ? uniqueLocalChanges(message.point!, message.zoom!, signal)
      : message.operation === 'metadata' ? readMetadata(message.point!, message.zoom!, message.releaseNumber!, signal, message.expected)
        : Promise.reject(new Error('unknown Wayback operation')))
  void work.then(value => {
    controllers.delete(message.id)
    requestsByOwner.delete(message.id)
    port.postMessage({ kind: 'result', id: message.id, value })
  }, (error: unknown) => {
    controllers.delete(message.id)
    requestsByOwner.delete(message.id)
    port.postMessage({
      kind: 'result', id: message.id, error: 'official Wayback operation failed',
      ...(error instanceof WorkerOperationError ? { code: error.code } : {}),
    })
  })
})

/** A refused operation whose identity must survive the worker boundary. */
class WorkerOperationError extends Error {
  constructor(message: string, readonly code: 'SOURCE_CHANGED' | 'SOURCE_UNAVAILABLE') {
    super(message)
  }
}

/**
 * Read metadata only while the live config still identifies the verified item.
 * The official reader resolves the metadata layer from its own config, so the
 * pre-check must run against the same cached generation it will query.
 * @param expected - identity accepted by the host catalog; omitted by tests.
 */
async function readMetadata(
  point: { longitude: number; latitude: number },
  zoom: number,
  releaseNumber: number,
  signal: AbortSignal,
  expected?: { itemId: string; metadataLayerUrl: string },
) {
  if (expected !== undefined) {
    const items = await getWaybackItems()
    const item = items.find(candidate => candidate.releaseNum === releaseNumber)
    if (item === undefined || item.itemID !== expected.itemId || item.metadataLayerUrl !== expected.metadataLayerUrl) {
      throw new WorkerOperationError('Wayback metadata identity changed', 'SOURCE_CHANGED')
    }
  }
  return getMetadata(point, zoom, releaseNumber, { signal })
}

async function uniqueLocalChanges(point: { longitude: number; latitude: number }, zoom: number, signal: AbortSignal) {
  const level = Math.round(zoom)
  const longitude = Math.max(-180, Math.min(180, point.longitude))
  const latitude = Math.max(-85.0511287798066, Math.min(85.0511287798066, point.latitude))
  const width = 2 ** level
  const officialCol = Math.max(0, Math.min(width - 1, long2tile(longitude, level)))
  const officialRow = Math.max(0, Math.min(width - 1, lat2tile(latitude, level)))
  const candidates = await getReleasesWithLocalChanges({ column: officialCol, row: officialRow, level })
  const items = await getWaybackItems()
  const byId = new Map(items.map(item => [item.releaseNum, item]))
  const ordered = candidates.map(candidate => {
    const item = byId.get(candidate.releaseNumber)
    if (item === undefined) throw new WorkerOperationError('Wayback local release is missing from the catalog', 'SOURCE_CHANGED')
    return item
  }).sort((left, right) => left.releaseDateLabel.localeCompare(right.releaseDateLabel) || left.releaseNum - right.releaseNum)
  const unique: { item: (typeof ordered)[number]; digest: string }[] = []
  for (const candidate of ordered) {
    if (signal.aborted) throw new Error('Wayback operation cancelled')
    const url = candidate.itemURL.replace('{level}', String(level)).replace('{row}', String(officialRow)).replace('{col}', String(officialCol))
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error('Wayback comparison tile unavailable')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length === 0) throw new Error('Wayback comparison tile empty')
    // Compare normalized pixels so equivalent imagery with different PNG/JPEG
    // encodings or metadata does not create a false comparison pair.
    const pixels = await sharp(bytes, { limitInputPixels: 256 * 256, failOn: 'warning' })
      .toColourspace('srgb').ensureAlpha().raw().toBuffer()
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] === 0) pixels.fill(0, offset, offset + 3)
    }
    const digest = createHash('sha256').update(pixels).digest('hex')
    // The first appearance preserves the early endpoint. Other repeated frames
    // move to their newest occurrence so the recent endpoint remains current.
    const index = unique.findIndex(entry => entry.digest === digest)
    if (index === 0) continue
    if (index !== -1) unique.splice(index, 1)
    unique.push({ item: candidate, digest })
  }
  return unique.map(entry => entry.item)
}
