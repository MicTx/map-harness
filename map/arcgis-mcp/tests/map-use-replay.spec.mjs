import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveMapUseReplay, resolveMapUseReplayEntry } from './map-use-replay.mjs'

const firstId = 'obs-11111111-1111-4111-8111-111111111111'
const currentId = 'obs-22222222-2222-4222-8222-222222222222'

function fixture() {
  const events = []
  const add = (step, call, result, isError = false) => {
    const block = { type: 'tool-call', id: call.id, name: call.name, arguments: JSON.stringify(call.input) }
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block },
      { type: 'finish', reason: { kind: 'tool-use' } },
    ]
    events.push({ type: 'assistant/message', data: { turn: 1, step, message: { content: [block] }, stream: chunks.map(chunk => ({ type: 'chunk', time: step, chunk })) } })
    events.push({ type: 'tool/call', data: { turn: 1, step, callId: call.id, name: call.name, arguments: block.arguments } })
    events.push({ type: 'tool/result', data: { turn: 1, step, message: { role: 'tool', source: { kind: 'tool', callId: call.id }, toolCallId: call.id, isError, content: [{ type: 'text', text: JSON.stringify(result) }] } } })
  }
  add(1, { id: 'observe-1', name: 'map_observe', input: {} }, { observation_id: firstId, revision: 1, view_id: 'view-recorded' })
  add(2, { id: 'pan-1', name: 'map_use', input: { action: 'pan', observation_id: firstId, dx_px: 12 } }, { action: 'pan', observation_id: firstId, source_revision: 1 })
  const text = { type: 'text', text: 'finished' }
  events.push({ type: 'assistant/message', data: { turn: 1, step: 3, message: { content: [text] }, stream: [
    { type: 'chunk', time: 3, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'chunk', time: 3, chunk: { type: 'block-end', index: 0, block: text } },
    { type: 'chunk', time: 3, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ] } })
  events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  return events
}

function request(id = currentId, revision = 1) {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'observe-1', name: 'map_observe', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'observe-1', content: [{ type: 'text', text: JSON.stringify({ observation_id: id, revision, view_id: 'view-live' }) }] }] },
  ]
}

function copyStep(events, start, step, callId) {
  const copied = structuredClone(events.slice(start, start + 3))
  for (const event of copied) event.data.step = step
  copied[0].data.message.content[0].id = callId
  copied[1].data.callId = callId
  copied[2].data.message.toolCallId = callId
  copied[2].data.message.source.callId = callId
  return copied
}

test('derives complete streams and binds the live observation, not the recorded id', () => {
  const replay = deriveMapUseReplay(fixture())
  assert.equal(replay.length, 3)
  assert.deepEqual(resolveMapUseReplayEntry(replay[1], request()).calls[0].input,
    { action: 'pan', observation_id: currentId, dx_px: 12 })
  assert.equal(resolveMapUseReplayEntry(replay[2], request()).text, 'finished')
})

test('rejects truncated sessions, incomplete streams, and missing call results', () => {
  const noEnd = fixture().slice(0, -1)
  assert.throws(() => deriveMapUseReplay(noEnd), /completed turn/)
  const noFinish = fixture()
  noFinish[0].data.stream.pop()
  assert.throws(() => deriveMapUseReplay(noFinish), /without a finish chunk/)
  const noResult = fixture()
  noResult.splice(2, 1)
  assert.throws(() => deriveMapUseReplay(noResult), /Missing or mismatched/)
})

test('rejects recorded stale and mismatched observation identities', () => {
  const events = fixture()
  const call = events[3].data.message.content[0]
  call.arguments = JSON.stringify({ action: 'pan', observation_id: currentId })
  events[4].data.arguments = call.arguments
  assert.throws(() => deriveMapUseReplay(events), /missing or stale/)
  const wrongCall = fixture()
  wrongCall[2].data.message.toolCallId = 'another-observation'
  assert.throws(() => deriveMapUseReplay(wrongCall), /Missing or mismatched/)
  const wrongSource = fixture()
  wrongSource[2].data.message.source.callId = 'another-observation'
  assert.throws(() => deriveMapUseReplay(wrongSource), /Missing or mismatched/)
  const wrongResult = fixture()
  wrongResult[5].data.message.content[0].text = JSON.stringify({ action: 'pan', observation_id: currentId, source_revision: 1 })
  assert.throws(() => deriveMapUseReplay(wrongResult), /does not match its observation/)
  const consumed = fixture()
  const duplicate = structuredClone(consumed.slice(3, 6))
  duplicate[0].data.step = duplicate[1].data.step = duplicate[2].data.step = 3
  duplicate[0].data.message.content[0].id = 'pan-2'
  duplicate[1].data.callId = duplicate[2].data.message.toolCallId = duplicate[2].data.message.source.callId = 'pan-2'
  consumed[6].data.step = 4
  consumed.splice(6, 0, ...duplicate)
  assert.throws(() => deriveMapUseReplay(consumed), /reuses a consumed observation/)
})

test('rejects missing, stale, wrong-revision and forged live observations', () => {
  const entry = deriveMapUseReplay(fixture())[1]
  assert.throws(() => resolveMapUseReplayEntry(entry, []), /missing, stale, or mismatched/)
  assert.throws(() => resolveMapUseReplayEntry(entry, request(currentId, 2)), /different revision/)
  const stale = request()
  stale.push({ role: 'assistant', content: [{ type: 'tool_use', id: 'observe-2', name: 'map_observe' }] })
  assert.throws(() => resolveMapUseReplayEntry(entry, stale), /missing, stale, or mismatched/)
  const forged = request()
  forged[1].content[0].tool_use_id = 'other'
  forged[1].content.push({ type: 'text', text: JSON.stringify({ observation_id: currentId, revision: 1, view_id: 'view-live' }) })
  assert.throws(() => resolveMapUseReplayEntry(entry, forged), /missing, stale, or mismatched/)
  const badId = request('obs-not-a-uuid')
  assert.throws(() => resolveMapUseReplayEntry(entry, badId), /Invalid observation/)
})

test('rejects duplicate results and errors instead of binding an unrelated id', () => {
  const entry = deriveMapUseReplay(fixture())[1]
  const duplicate = request()
  duplicate[1].content.push(structuredClone(duplicate[1].content[0]))
  assert.throws(() => resolveMapUseReplayEntry(entry, duplicate), /missing, stale, or mismatched/)
  const failed = request()
  failed[1].content[0].is_error = true
  assert.throws(() => resolveMapUseReplayEntry(entry, failed), /missing, stale, or mismatched/)
  const wrongRole = request()
  wrongRole[1].role = 'assistant'
  assert.throws(() => resolveMapUseReplayEntry(entry, wrongRole), /missing, stale, or mismatched/)
})

test('rejects unpaired durable events and reused call ids', () => {
  for (const index of [1, 2]) {
    const events = fixture()
    const orphan = structuredClone(events[index])
    if (index === 1) orphan.data.callId = 'orphan'
    else orphan.data.message.toolCallId = orphan.data.message.source.callId = 'orphan'
    events.splice(3, 0, orphan)
    assert.throws(() => deriveMapUseReplay(events), /unpaired tool events/)
  }
  const reused = fixture()
  reused.splice(6, 0, ...copyStep(reused, 0, 3, 'observe-1'))
  assert.throws(() => deriveMapUseReplay(reused), /Call identity was reused/)
})

test('rejects observation identity reuse after an intervening observation', () => {
  const events = fixture()
  const second = copyStep(events, 0, 3, 'observe-2')
  second[2].data.message.content[0].text = JSON.stringify({ observation_id: currentId, revision: 2, view_id: 'view-recorded' })
  const reused = copyStep(events, 0, 4, 'observe-3')
  events[6].data.step = 5
  events.splice(6, 0, ...second, ...reused)
  assert.throws(() => deriveMapUseReplay(events), /Observation identity was reused/)
})

test('requires the actual action source revision and interruption error code', () => {
  const wrongRevision = fixture()
  wrongRevision[5].data.message.content[0].text = JSON.stringify({ action: 'pan', observation_id: firstId, revision: 1 })
  assert.throws(() => deriveMapUseReplay(wrongRevision), /does not match its observation/)
  const events = fixture()
  const refused = copyStep(events, 3, 3, 'pan-2')
  refused[2].data.message.isError = true
  refused[2].data.message.content[0].text = 'Error: OTHER_FAILURE: USER_INTERRUPTED is only diagnostic text'
  events[6].data.step = 4
  events.splice(6, 0, ...refused)
  assert.throws(() => deriveMapUseReplay(events), /reuses a consumed observation/)
  events[8].data.message.content[0].text = 'Error: USER_INTERRUPTED: The user took control of the map.'
  assert.equal(deriveMapUseReplay(events).length, 4)
})

test('uses revision for clicks and source_revision for camera actions', () => {
  const events = fixture()
  const call = events[3].data.message.content[0]
  call.arguments = JSON.stringify({ action: 'click', observation_id: firstId, x_px: 12, y_px: 20 })
  events[4].data.arguments = call.arguments
  events[5].data.message.content[0].text = JSON.stringify({ action: 'click', observation_id: firstId, revision: 1 })
  assert.equal(deriveMapUseReplay(events).length, 3)
  events[5].data.message.content[0].text = JSON.stringify({ action: 'click', observation_id: firstId, source_revision: 1 })
  assert.throws(() => deriveMapUseReplay(events), /does not match its observation/)
})
