/**
 * dsh-loaded HTTP fixture for the map-layer-workbench snapshot composition:
 * the Tianditu `/v2/search` wire answers from the committed synthetic POI
 * payloads, deterministically in both record and replay, so the scenario's
 * online-search leg never leaves the process and never needs a real vendor
 * key. The intercepted host is the composition's configured `baseUrl`; any
 * other host passes through untouched.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** The fixture host the composition's spatial-connect `baseUrl` names. */
export const FIXTURE_HOST = 'tianditu.layer-workbench.invalid'

/** The single fixture response the search leg records and replays. */
const PAGE = JSON.parse(readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'poi', 'page-1.json'), 'utf8'))

/** Install the process-local Tianditu search transport. */
export function apply(ctx) {
  const original = globalThis.fetch
  let requests = 0
  const transport = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== FIXTURE_HOST) return original(input, init)
    if (!url.pathname.startsWith('/v2/search')) {
      throw new Error('layer-workbench search fixture received an unexpected vendor endpoint')
    }
    if (++requests > 3) throw new Error('layer-workbench search fixture exceeded its three-request budget')
    init?.signal?.throwIfAborted()
    return new Response(JSON.stringify(PAGE.body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  ctx.effect(() => {
    globalThis.fetch = transport
    return () => {
      if (globalThis.fetch !== transport) throw new Error('layer-workbench search fixture lost transport ownership')
      globalThis.fetch = original
    }
  })
}
