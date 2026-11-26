import { test } from 'node:test'
import assert from 'node:assert/strict'
import { annotationOperationOf } from '../src/client/annotation-pending.ts'

const change = { op: 'annotation-create', geometry: { type: 'Point', coordinates: [1, 2] }, name: 'Site' }
const changed = { ...change, geometry: { type: 'Point', coordinates: [3, 4] } }

test('an ambiguous operation retries only the same payload at the same revision', () => {
  const first = annotationOperationOf(null, 7, change, () => 'same-id')
  assert.equal(annotationOperationOf(first, 7, change, () => 'new-id').operationId, 'same-id')
  assert.equal(annotationOperationOf(first, 8, change, () => 'new-id').operationId, 'new-id')
  assert.equal(annotationOperationOf(first, 7, changed, () => 'new-id').operationId, 'new-id')
})
