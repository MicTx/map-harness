import { deriveReplayScript } from '../../../packages/test-support/llm-replay/lib/index.js'

function structuredResultOf(content, key) {
  const matches = []
  for (const block of content ?? []) {
    if (block.type !== 'text') continue
    let value
    try { value = JSON.parse(block.text) } catch (notJson) { void notJson; continue }
    if (value !== null && typeof value === 'object' && Object.hasOwn(value, key)) matches.push(value)
  }
  if (matches.length !== 1) throw new Error(`Expected one structured ${key} result`)
  return matches[0]
}

function observationOf(content) {
  const observation = structuredResultOf(content, 'observation_id')
  if (typeof observation.observation_id !== 'string' || !/^obs-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(observation.observation_id)
    || !Number.isSafeInteger(observation.revision) || observation.revision < 0
    || typeof observation.view_id !== 'string' || observation.view_id.length === 0) {
    throw new Error('Invalid observation identity or revision')
  }
  return observation
}

function resultFor(events, start, end, call, turn, step) {
  const window = events.slice(start + 1, end)
  const calls = window.filter(event => event.type === 'tool/call' && event.data.callId === call.id)
  const results = window.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === call.id)
  if (calls.length !== 1 || results.length !== 1 || window.indexOf(calls[0]) >= window.indexOf(results[0])
    || calls[0].data.name !== call.name || calls[0].data.arguments !== call.arguments
    || calls[0].data.turn !== turn || calls[0].data.step !== step
    || results[0].data.turn !== turn || results[0].data.step !== step
    || results[0].data.message.role !== 'tool' || results[0].data.message.source?.kind !== 'tool'
    || results[0].data.message.source.callId !== call.id) {
    throw new Error(`Missing or mismatched tool call/result: ${call.id}`)
  }
  return results[0].data.message
}

/**
 * Derive a replay from one complete, persisted map-use turn.
 * @param events - parsed native Session events containing every tool call and result.
 * @returns replay entries with current-observation bindings; rejects incomplete or mismatched evidence.
 */
export function deriveMapUseReplay(events) {
  const endings = events.filter(event => event.type === 'turn/end')
  if (endings.length !== 1 || endings[0].data.reason.kind !== 'completed') {
    throw new Error('The recorded Session must contain one completed turn')
  }
  const endingIndex = events.indexOf(endings[0])
  const assistants = events.flatMap((event, index) => event.type === 'assistant/message' ? [{ event, index }] : [])
  const streams = deriveReplayScript(events)
  if (assistants.length === 0 || streams.length !== assistants.length || assistants.at(-1).index >= endingIndex) {
    throw new Error('The recorded Session must contain complete assistant streams')
  }
  let latest
  let consumed = false
  let observationCount = 0
  let actionCount = 0
  const callIds = new Set()
  const observationIds = new Set()
  const replay = assistants.map(({ event, index }, ordinal) => {
    if (event.data.turn !== endings[0].data.turn) throw new Error('Assistant stream belongs to another turn')
    const entry = streams[ordinal]
    if (entry.kind !== 'chunks') throw new Error('The recorded stream is not complete')
    const blocks = entry.chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
    const calls = blocks.filter(block => block.type === 'tool-call')
    const messageCalls = event.data.message.content.filter(block => block.type === 'tool-call')
    if (JSON.stringify(calls) !== JSON.stringify(messageCalls) || calls.length > 1) {
      throw new Error('Assistant stream does not match its settled tool calls')
    }
    const next = assistants[ordinal + 1]?.index ?? endingIndex
    let binding
    if (calls.length === 1) {
      const call = calls[0]
      if (callIds.has(call.id)) throw new Error('Call identity was reused')
      callIds.add(call.id)
      const result = resultFor(events, index, next, call, event.data.turn, event.data.step)
      const input = JSON.parse(call.arguments)
      if (call.name === 'map_observe') {
        if (result.isError) latest = undefined
        else {
          const observation = observationOf(result.content)
          if (observationIds.has(observation.observation_id)) throw new Error('Observation identity was reused')
          observationIds.add(observation.observation_id)
          latest = { callId: call.id, id: observation.observation_id, revision: observation.revision }
          observationCount += 1
        }
        consumed = false
      } else if (call.name === 'map_use' && input.action !== 'finish') {
        if (latest === undefined || input.observation_id !== latest.id) throw new Error('Map action cites a missing or stale observation')
        if (consumed && !(result.isError && result.content.length === 1
          && result.content[0].type === 'text' && result.content[0].text.startsWith('Error: USER_INTERRUPTED:'))) {
          throw new Error('Map action reuses a consumed observation')
        }
        binding = { ...latest }
        if (!result.isError) {
          const outcome = structuredResultOf(result.content, 'action')
          if (outcome.action !== input.action || outcome.observation_id !== latest.id
            || (input.action === 'click' ? outcome.revision : outcome.source_revision) !== latest.revision) {
            throw new Error('Map action result does not match its observation')
          }
          consumed = true
          actionCount += 1
        }
      }
    } else if (ordinal !== assistants.length - 1) {
      throw new Error('A non-final assistant stream contains no tool call')
    }
    return { entry, binding }
  })
  if (events.filter(event => event.type === 'tool/call').length !== callIds.size
    || events.filter(event => event.type === 'tool/result').length !== callIds.size) {
    throw new Error('The recorded Session contains unpaired tool events')
  }
  if (observationCount === 0 || actionCount === 0 || replay.at(-1).entry.chunks.some(chunk =>
    chunk.type === 'block-end' && chunk.block.type === 'tool-call')) {
    throw new Error('The recorded Session lacks a complete observation/action/final response')
  }
  return replay
}

/**
 * Bind an action only to the matching observation result in the current request.
 * @param replayEntry - derived stream and its recorded observation call identity.
 * @param messages - current provider request, including native tool uses and results.
 * @returns tool calls with the live observation id and final text; rejects invalid bindings.
 */
export function resolveMapUseReplayEntry(replayEntry, messages) {
  const blocks = replayEntry.entry.chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
  const calls = blocks.filter(block => block.type === 'tool-call').map(call => ({
    id: call.id, name: call.name, input: JSON.parse(call.arguments),
  }))
  const binding = replayEntry.binding
  if (binding !== undefined) {
    const content = messages.flatMap(message => Array.isArray(message.content)
      ? message.content.map(block => ({ role: message.role, block })) : [])
    const observations = content.filter(item => item.block.type === 'tool_use' && item.block.name === 'map_observe')
    const matchingCalls = observations.filter(item => item.block.id === binding.callId)
    const matchingResults = content.filter(item => item.block.type === 'tool_result' && item.block.tool_use_id === binding.callId)
    if (matchingCalls.length !== 1 || observations.at(-1) !== matchingCalls[0] || matchingResults.length !== 1
      || matchingCalls[0].role !== 'assistant' || matchingResults[0].role !== 'user'
      || content.indexOf(matchingCalls[0]) >= content.indexOf(matchingResults[0]) || matchingResults[0].block.is_error) {
      throw new Error('The current request has a missing, stale, or mismatched observation')
    }
    const observation = observationOf(matchingResults[0].block.content)
    if (observation.revision !== binding.revision) throw new Error('The current observation has a different revision')
    calls[0].input.observation_id = observation.observation_id
  }
  return { calls, text: blocks.filter(block => block.type === 'text').map(block => block.text).join('\n') }
}
