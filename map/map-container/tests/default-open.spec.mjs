import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextDefaultOpenTarget } from '../src/client/default-open.ts'

test('a fresh session is the one-time default-open target', () => {
  assert.equal(nextDefaultOpenTarget(new Set(), 'session-a'), 'session-a')
})

test('a session the policy already handled is never reopened', () => {
  assert.equal(nextDefaultOpenTarget(new Set(['session-a']), 'session-a'), undefined)
})

test('an absent main binding and an empty key never trigger an open', () => {
  assert.equal(nextDefaultOpenTarget(new Set(), undefined), undefined)
  assert.equal(nextDefaultOpenTarget(new Set(), ''), undefined)
})

test('other handled sessions do not block a different fresh session', () => {
  assert.equal(nextDefaultOpenTarget(new Set(['session-a']), 'session-b'), 'session-b')
})
