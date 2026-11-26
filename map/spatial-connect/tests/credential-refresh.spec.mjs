/** Runtime credential resolution: a key stored after plugin activation reaches the next search. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import * as connectPlugin from '../src/plugin.ts'

async function server(t, keys) {
  const http = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    keys.push(url.searchParams.get('tk'))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: '0', location: { lon: 116.4, lat: 39.9 } }))
  })
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    http.closeAllConnections()
    await new Promise(resolve => http.close(resolve))
  })
  return `http://127.0.0.1:${http.address().port}`
}

test('a key stored after activation reaches the same live search service', async t => {
  const keys = []
  const baseUrl = await server(t, keys)
  const stored = new Map()
  const ctx = new Context()
  const disposeCredentials = ctx.reflect.provide('credentials', {
    resolve: async (ref) => {
      const value = stored.get(ref)
      return value === undefined ? undefined : { value }
    },
  })
  t.after(async () => { await ctx.fiber.dispose(); disposeCredentials() })
  await ctx.plugin(connectPlugin, { tianditu: { apiKeyEnv: 'TIANDITU_API_KEY', baseUrl } })
  const search = ctx.get('spatialSearch')
  assert.ok(search !== undefined)

  await assert.rejects(search.search({ kind: 'geocode', query: '北京' }), /SEARCH_NOT_CONFIGURED/)
  assert.deepEqual(keys, [])

  stored.set('TIANDITU_API_KEY', 'configured-after-boot')
  await search.search({ kind: 'geocode', query: '北京' })
  stored.set('TIANDITU_API_KEY', 'rotated-in-session')
  await search.search({ kind: 'geocode', query: '北京' })
  assert.deepEqual(keys, ['configured-after-boot', 'rotated-in-session'])

  stored.delete('TIANDITU_API_KEY')
  await assert.rejects(search.search({ kind: 'geocode', query: '北京' }), /SEARCH_NOT_CONFIGURED/)
  assert.deepEqual(keys, ['configured-after-boot', 'rotated-in-session'])
})
