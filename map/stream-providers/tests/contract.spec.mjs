/**
 * Contract gates: the closed read-outcome vocabulary and the validation
 * functions both source kinds and the deployment Config share — id shapes,
 * endpoint URL shape, by-name credential-reference grammar, source and
 * fusion budget bounds, read-round bounds, and the detail bound that keeps
 * diagnostics short.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CREDENTIAL_STORE,
  DEFAULT_TIMEOUT_MS,
  FUSION_MAX_SOURCES,
  FUSION_MIN_SOURCES,
  MAX_LINE_BYTES,
  MAX_PENDING_CAPACITY,
  MAX_SOURCES,
  MAX_TIMEOUT_MS,
  MIN_LINE_BYTES,
  MIN_TIMEOUT_MS,
  STREAM_PROVIDERS_VERSION,
  STREAM_READ_OUTCOMES,
  boundDetail,
  completionsSpecProblem,
  credentialRefProblem,
  fusionSpecProblem,
  sseSpecProblem,
  streamIdProblem,
} from '../src/contract.ts'

const VALID_SSE = { id: 'traffic-feed', kind: 'sse', url: 'https://feeds.example.org/traffic' }
const VALID_COMPLETIONS = { id: 'fleet-relay', kind: 'completions', url: 'https://api.example.org/v1/chat/completions', model: 'deepseek-flash', credentialRef: 'cc-switch:DeepSeek' }
const DECLARED = new Set(['traffic-feed', 'fleet-relay', 'weather-feed'])

test('the contract is versioned and the outcome vocabulary is closed', () => {
  assert.equal(STREAM_PROVIDERS_VERSION, 'stream-providers@1')
  assert.deepEqual(STREAM_READ_OUTCOMES, [
    'streaming', 'unreachable', 'auth-rejected', 'http-error',
    'content-type-violated', 'stream-violated', 'timeout', 'aborted',
    'source-closed',
  ])
  assert.equal(CREDENTIAL_STORE, 'cc-switch')
})

test('source ids must be kebab-case and short', () => {
  assert.equal(streamIdProblem('traffic-feed'), undefined)
  assert.equal(streamIdProblem('a'), undefined)
  assert.equal(streamIdProblem('a'.repeat(64)), undefined)
  assert.ok(streamIdProblem('') !== undefined)
  assert.ok(streamIdProblem('UpperCase') !== undefined)
  assert.ok(streamIdProblem('1starts-with-digit') !== undefined)
  assert.ok(streamIdProblem('has_underscore') !== undefined)
  assert.ok(streamIdProblem('has space') !== undefined)
  assert.ok(streamIdProblem('a'.repeat(65)) !== undefined)
})

test('credential references name the cc-switch store and a bounded provider name', () => {
  assert.equal(credentialRefProblem('cc-switch:DeepSeek'), undefined)
  assert.equal(credentialRefProblem(`cc-switch:${'名'.repeat(128)}`), undefined)
  assert.ok(credentialRefProblem('') !== undefined)
  assert.ok(credentialRefProblem('DeepSeek') !== undefined, 'a bare name without its store is refused')
  assert.ok(credentialRefProblem('env:DEEPSEEK_KEY') !== undefined, 'the env store is not this plane\'s grammar')
  assert.ok(credentialRefProblem('cc-switch:') !== undefined)
  assert.ok(credentialRefProblem(`cc-switch:${'x'.repeat(129)}`) !== undefined)
  assert.ok(credentialRefProblem('cc-switch:two:colons') !== undefined)
  assert.ok(credentialRefProblem('cc-switch: padded ') !== undefined)
  assert.ok(credentialRefProblem('cc-switch:has\ttab') !== undefined)
})

test('sse specs validate url, credential reference, and read-round bounds', () => {
  assert.equal(sseSpecProblem(VALID_SSE), undefined)
  assert.equal(sseSpecProblem({ ...VALID_SSE, credentialRef: 'cc-switch:DeepSeek', timeoutMs: 5000, maxEventsPerFetch: 64, maxLineBytes: 8192 }), undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, url: 'ftp://feeds.example.org/x' }) !== undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, url: 'https://user:pass@feeds.example.org/x' }) !== undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, url: 'https://feeds.example.org/x#frag' }) !== undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, url: 'not-a-url' }) !== undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, credentialRef: 'env:TOKEN' }) !== undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, timeoutMs: MIN_TIMEOUT_MS - 1 }) !== undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, timeoutMs: MAX_TIMEOUT_MS + 1 }) !== undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, timeoutMs: 1500.5 }) !== undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, maxEventsPerFetch: 0 }) !== undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, maxEventsPerFetch: 1025 }) !== undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, maxLineBytes: MIN_LINE_BYTES - 1 }) !== undefined)
  assert.ok(sseSpecProblem({ ...VALID_SSE, maxLineBytes: MAX_LINE_BYTES + 1 }) !== undefined)
})

test('completions specs require a model, a credential reference, and bounded relay knobs', () => {
  assert.equal(completionsSpecProblem(VALID_COMPLETIONS), undefined)
  assert.equal(completionsSpecProblem({ ...VALID_COMPLETIONS, prompt: 'city traffic in Haidian', eventTimeBaseMs: 1_700_000_000_000, maxTokens: 2048 }), undefined)
  assert.ok(completionsSpecProblem({ ...VALID_COMPLETIONS, model: '' }) !== undefined)
  assert.ok(completionsSpecProblem({ ...VALID_COMPLETIONS, model: 'x'.repeat(129) }) !== undefined)
  assert.ok(completionsSpecProblem({ ...VALID_COMPLETIONS, model: 'bad\nmodel' }) !== undefined)
  assert.ok(completionsSpecProblem({ ...VALID_COMPLETIONS, credentialRef: undefined }) !== undefined, 'a keyless relay is refused')
  assert.ok(completionsSpecProblem({ ...VALID_COMPLETIONS, prompt: 'x'.repeat(2049) }) !== undefined)
  assert.ok(completionsSpecProblem({ ...VALID_COMPLETIONS, eventTimeBaseMs: -1 }) !== undefined)
  assert.ok(completionsSpecProblem({ ...VALID_COMPLETIONS, eventTimeBaseMs: Number.NaN }) !== undefined)
  assert.ok(completionsSpecProblem({ ...VALID_COMPLETIONS, maxTokens: 255 }) !== undefined)
  assert.ok(completionsSpecProblem({ ...VALID_COMPLETIONS, maxTokens: 8193 }) !== undefined)
  assert.ok(completionsSpecProblem({ ...VALID_COMPLETIONS, url: 'https://api.example.org/v1/chat/completions#x' }) !== undefined)
})

test('fusions bind declared sources within the bounded window', () => {
  assert.equal(fusionSpecProblem({ id: 'city-fusion', sources: ['traffic-feed', 'fleet-relay'] }, DECLARED), undefined)
  assert.equal(fusionSpecProblem({ id: 'city-fusion', sources: ['traffic-feed', 'fleet-relay', 'weather-feed'], pendingCapacity: 512, maxEventsPerRelease: 256 }, DECLARED), undefined)
  assert.ok(fusionSpecProblem({ id: 'city-fusion', sources: ['traffic-feed'] }, DECLARED) !== undefined, `fewer than ${String(FUSION_MIN_SOURCES)} sources is no fusion`)
  const nine = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
  assert.ok(fusionSpecProblem({ id: 'city-fusion', sources: nine }, DECLARED) !== undefined)
  assert.ok(fusionSpecProblem({ id: 'city-fusion', sources: ['traffic-feed', 'ghost-feed'] }, DECLARED) !== undefined, 'a fusion may only bind declared sources')
  assert.ok(fusionSpecProblem({ id: 'city-fusion', sources: ['traffic-feed', 'traffic-feed'] }, DECLARED) !== undefined)
  assert.ok(fusionSpecProblem({ id: 'city-fusion', sources: ['traffic-feed', 'fleet-relay'], pendingCapacity: 0 }, DECLARED) !== undefined)
  assert.ok(fusionSpecProblem({ id: 'city-fusion', sources: ['traffic-feed', 'fleet-relay'], pendingCapacity: MAX_PENDING_CAPACITY + 1 }, DECLARED) !== undefined)
  assert.ok(fusionSpecProblem({ id: 'city-fusion', sources: ['traffic-feed', 'fleet-relay'], maxEventsPerRelease: 0 }, DECLARED) !== undefined)
})

test('the source budget bound is exported and the detail bound truncates', () => {
  assert.equal(MAX_SOURCES, 16)
  assert.equal(FUSION_MIN_SOURCES, 2)
  assert.equal(FUSION_MAX_SOURCES, 8)
  assert.equal(DEFAULT_TIMEOUT_MS, 10_000)
  const long = 'x'.repeat(600)
  const bounded = boundDetail(long)
  assert.ok(bounded.length <= 512 && bounded.endsWith('…'))
  assert.equal(boundDetail('short'), 'short')
})
