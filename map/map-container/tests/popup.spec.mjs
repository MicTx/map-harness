/**
 * Feature card fixtures: fields derive from the clicked graphic's attributes
 * in order, the internal id stays hidden, the list is bounded with an
 * omitted count, the title comes from the label field, and long values
 * truncate before reaching a graphic.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_POPUP_FIELDS, MAX_POPUP_VALUE_CHARS, inspectionOf, popupValueOf } from '../src/client/popup.ts'

const identity = { layerId: 'hospitals', layerName: 'Hospitals', featureId: 'f-1' }

test('fields keep attribute order, hide the internal id, and render scalars as text', () => {
  const card = inspectionOf(identity, { name: 'A', beds: 10, ratio: 0.1 + 0.2, open: true, note: null, __fid: 'f-1' }, 'name')
  assert.deepEqual(card.fields, [
    { name: 'name', value: 'A' },
    { name: 'beds', value: '10' },
    { name: 'ratio', value: '0.3' },
    { name: 'open', value: 'true' },
    { name: 'note', value: '—' },
  ])
  assert.equal(card.title, 'A')
  assert.equal(card.omitted, 0)
  assert.equal(card.layerName, 'Hospitals')
})

test('without a usable label field the title is null (the card shows the layer name)', () => {
  assert.equal(inspectionOf(identity, { a: 1 }, null).title, null)
  assert.equal(inspectionOf(identity, { name: '' }, 'name').title, null)
  assert.equal(inspectionOf(identity, { code: 7 }, 'code').title, '7')
})

test('the field list is bounded and counts what it omits', () => {
  const wide = Object.fromEntries(Array.from({ length: 60 }, (_, at) => [`f${at}`, at]))
  const card = inspectionOf(identity, wide, null)
  assert.equal(card.fields.length, MAX_POPUP_FIELDS)
  assert.equal(card.omitted, 60 - MAX_POPUP_FIELDS)
  assert.deepEqual(inspectionOf(identity, { __fid: 'x' }, null).fields, [])
})

test('long string values truncate by code point', () => {
  assert.equal(popupValueOf('short'), 'short')
  const long = popupValueOf('长'.repeat(1000))
  assert.equal([...long].length, MAX_POPUP_VALUE_CHARS)
  assert.ok(long.endsWith('…'))
})
