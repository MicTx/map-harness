import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountMapOccurrence } from '../src/client/occurrence-lifecycle.ts'

function rig() {
  const loaded = Promise.withResolvers()
  const calls = []
  let current = { revision: 1 }
  const occurrence = {
    mount: element => calls.push(['mount', element]),
    dispose: () => calls.push(['dispose']),
  }
  const options = {
    load: () => loaded.promise,
    getState: () => current,
    sessionId: 'session-a', occurrenceKey: 'map-a', holder: { id: 'holder-a' },
    onReady: result => calls.push(['ready', result]),
    onError: () => calls.push(['error']),
  }
  return {
    loaded, calls, options, occurrence,
    setState: value => { current = value },
    finish() { loaded.resolve({ createMapOccurrence: (getState, sessionId, occurrenceKey) => {
      calls.push(['create', sessionId, occurrenceKey, getState()]); return occurrence
    } }) },
  }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

test('unmounted pending imports never create or publish a stale session occurrence', async () => {
  const r = rig()
  const dispose = mountMapOccurrence(r.options)
  dispose(); dispose(); r.finish(); await flush()
  assert.deepEqual(r.calls, [])
})

test('loading reads the latest projection but keeps the captured session identity', async () => {
  const r = rig()
  const dispose = mountMapOccurrence(r.options)
  r.setState({ revision: 3 }); r.finish(); await flush()
  assert.deepEqual(r.calls, [
    ['create', 'session-a', 'map-a', { revision: 3 }],
    ['mount', { id: 'holder-a' }], ['ready', r.occurrence],
  ])
  dispose(); dispose()
  assert.deepEqual(r.calls.at(-1), ['dispose'])
  assert.equal(r.calls.filter(call => call[0] === 'dispose').length, 1)
})

test('a failed load reports only to its live owner and can be retried', async () => {
  const failed = rig()
  const release = mountMapOccurrence(failed.options)
  failed.loaded.reject(new Error('SDK unavailable')); await flush()
  assert.deepEqual(failed.calls, [['error']]); release()
  const retried = rig(); const dispose = mountMapOccurrence(retried.options)
  retried.finish(); await flush()
  assert.equal(retried.calls.at(-1)[0], 'ready'); dispose()
  const cancelled = rig(); const cancel = mountMapOccurrence(cancelled.options)
  cancel(); cancelled.loaded.reject(new Error('late rejection')); await flush()
  assert.deepEqual(cancelled.calls, [])
})

test('mount failure disposes the partially created occurrence', async () => {
  const r = rig()
  r.occurrence.mount = () => { throw new Error('mount failed') }
  const dispose = mountMapOccurrence(r.options)
  r.finish(); await flush(); dispose()
  assert.deepEqual(r.calls.map(call => call[0]), ['create', 'dispose', 'error'])
})
