/**
 * Loopback Tianditu-wire fixture server for the layer-workbench composition
 * lane. Speaks the `/v2/search` contract `resolveSearchConfig` expects
 * (`type=query`, `tk`, `postStr`) with a switchable response mode: paged
 * success payloads, a rate-limited refusal, and an empty result set. The
 * composition test points the map-web composition's `spatial-connect`
 * baseUrl at this server via a cordis patch (the configuration face the
 * online-discovery spec proved reachable) and asserts the fixture actually
 * received the requests. Test-only; serves synthetic responses.
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const fixturesDir = fileURLToPath(new URL('.', import.meta.url))

/** Fixture payloads keyed by mode; loaded lazily from ./poi/. */
const responseOf = mode => JSON.parse(readFileSync(join(fixturesDir, 'poi', `${mode}.json`), 'utf8'))

/**
 * Start the fixture server on an ephemeral loopback port.
 * @param {object} [options] - `mode` (default 'page-1') and `onRequest` for
 *   per-request observation (the test asserts arrivals through it).
 * @returns {Promise<{server: import('node:http').Server, port: number, setMode: (mode: string) => void, requests: Array<{url: string, postStr: string}>}>}
 */
export async function startPoiFixtureServer(options = {}) {
  let mode = options.mode ?? 'page-1'
  const requests = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture')
    if (!url.pathname.startsWith('/v2/search')) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false }))
      return
    }
    const postStr = url.searchParams.get('postStr') ?? ''
    requests.push({ url: request.url ?? '', postStr })
    if (url.searchParams.get('type') !== 'query' || url.searchParams.get('tk') == null) {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false }))
      return
    }
    const payload = responseOf(mode)
    if (payload.httpStatus !== undefined && payload.httpStatus !== 200) {
      response.writeHead(payload.httpStatus, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload.body))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(payload.body))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('POI fixture server has no TCP address')
  return {
    server,
    port: address.port,
    setMode: next => { mode = next },
    requests,
  }
}
