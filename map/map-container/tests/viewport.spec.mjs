/**
 * Live viewport registry and route: a settled camera report replaces the
 * previous one per session, invalid bodies refuse with zero residue.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMapViewportService, serveViewportReport } from '../src/viewport.ts'

const viewport = { center: [116.4, 39.9], zoom: 11, extent: [116.3, 39.85, 116.5, 39.95], wkid: 4326, mode: 'map', at: '2026-10-21T08:00:00.000Z' }

function post(body) {
  return new Request('http://host/api/map/viewport', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) })
}

test('a valid report replaces the session viewport', async () => {
  const service = createMapViewportService()
  const first = await serveViewportReport(post({ sessionId: 's1', viewport }), service)
  assert.equal(first.status, 200)
  await serveViewportReport(post({ sessionId: 's1', viewport: { ...viewport, zoom: 14 } }), service)
  assert.equal(service.viewportOf('s1').zoom, 14)
  assert.equal(service.viewportOf('s2'), undefined)
})

test('invalid reports refuse and leave the registry unchanged', async () => {
  const service = createMapViewportService()
  for (const body of ['not json', { sessionId: 's1' }, { sessionId: 'a b', viewport }, { sessionId: 's1', viewport: { ...viewport, zoom: Number.NaN } }, { sessionId: 's1', viewport, extra: 1 }]) {
    const response = await serveViewportReport(post(body), service)
    assert.equal(response.status, 400)
  }
  assert.equal(service.viewportOf('s1'), undefined)
})

test('the registry stays bounded', () => {
  const service = createMapViewportService()
  for (let at = 0; at < 300; at += 1) service.report(`s${at}`, viewport)
  assert.equal(service.viewportOf('s0'), undefined, 'the oldest session is evicted')
  assert.ok(service.viewportOf('s299'))
})
