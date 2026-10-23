/**
 * Sanitization fixtures: credentials, geometry payloads, and filesystem
 * paths never reach the observability plane, and every suppression is
 * visible in the returned redaction list. Also covers the size/depth bounds
 * and the pass-through of safe data.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sanitizeValue,
  sanitizeRecord,
  SANITIZE_MAX_DEPTH,
  SANITIZE_MAX_ITEMS,
  PATH_PLACEHOLDER,
} from '../src/index.ts'

test('credential-bearing keys redact at any depth, visibly', () => {
  const result = sanitizeRecord({
    accessToken: 'sk-secret-value',
    nested: { API_KEY: 'abc123', deep: { authorization: 'Bearer xyz' } },
    note: 'the word token alone in prose is not a key',
  })
  assert.equal(result.fields.accessToken, '[redacted:accessToken]')
  assert.equal(result.fields.nested.API_KEY, '[redacted:API_KEY]')
  assert.equal(result.fields.nested.deep.authorization, '[redacted:authorization]')
  assert.equal(result.fields.note, 'the word token alone in prose is not a key', 'prose passes untouched')
  assert.ok(result.redactions.some(entry => entry.includes('accessToken')))
  assert.ok(result.redactions.some(entry => entry.includes('authorization')))
})

test('geometry payloads collapse to a visible marker; summaries and counts survive', () => {
  const result = sanitizeRecord({
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] },
    featureCount: 12,
    features: [{ id: 1 }, { id: 2 }],
    summary: { mean: 0.5 },
  })
  assert.deepEqual(result.fields.geometry, { obsRedacted: 'geometry' })
  assert.deepEqual(result.fields.features, { obsRedacted: 'geometry' })
  assert.equal(result.fields.featureCount, 12)
  assert.deepEqual(result.fields.summary, { mean: 0.5 })
  assert.ok(result.redactions.filter(entry => entry.includes('geometry payload')).length === 2)
})

test('absolute filesystem paths replace with the placeholder; relative refs and URLs survive', () => {
  const result = sanitizeValue({
    store: '/Users/example/secret-root/spatial-store/resources/r1.geojson',
    windowsPath: 'C:\\Users\\example\\secret.cfg',
    relative: 'resources/r1.geojson',
    url: 'https://example.com/tiles/1.png',
  })
  assert.equal(result.value.store, PATH_PLACEHOLDER)
  assert.equal(result.value.windowsPath, PATH_PLACEHOLDER)
  assert.equal(result.value.relative, 'resources/r1.geojson')
  assert.equal(result.value.url, 'https://example.com/tiles/1.png')
  assert.equal(result.redactions.length, 2)
})

test('depth and array bounds truncate with visible markers instead of unbounded growth', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } }
  const result = sanitizeValue(deep)
  assert.ok(JSON.stringify(result.value).includes('[truncated:depth]'))

  const bigArray = { rows: Array.from({ length: SANITIZE_MAX_ITEMS + 10 }, (_, index) => index) }
  const arrayResult = sanitizeValue(bigArray)
  assert.equal(arrayResult.value.rows.length, SANITIZE_MAX_ITEMS)
  assert.ok(arrayResult.redactions.some(entry => entry.includes(`truncated to ${SANITIZE_MAX_ITEMS}`)))
})

test('circular structures sanitize without hanging or throwing', () => {
  const node = { name: 'root' }
  node.self = node
  const result = sanitizeValue(node)
  assert.equal(result.value.name, 'root')
  assert.ok(result.value.self !== undefined, 'the cycle collapses to a stable reference')
})

test('safe payloads pass through byte-identical and redaction-free', () => {
  const safe = { plane: 'render', revision: 7, ok: true, tags: ['a', 'b'], nested: { ms: 1.5 } }
  const result = sanitizeValue(safe)
  assert.deepEqual(result.value, safe)
  assert.deepEqual(result.redactions, [])
})

test('bounds are overridable for larger allowed payloads', () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({ index }))
  const result = sanitizeValue({ rows }, { maxItems: 64, maxDepth: SANITIZE_MAX_DEPTH })
  assert.equal(result.value.rows.length, 50)
  assert.deepEqual(result.redactions, [])
})
