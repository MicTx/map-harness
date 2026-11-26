import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type AssistantMessage,
  type ToolCallBlock,
  type ToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import { parseSessionLog, resolveScriptedEntry, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import {
  assertMapUseRequestBinding,
  createMapUseRequestVerifier,
  deriveMapUseRequestPlan,
  mapUseReplayOverride,
} from './map-use-session-replay.ts'

const observeCallId = ToolCallId('observe')
const panCallId = ToolCallId('pan')
const finishCallId = ToolCallId('finish')
const foreignCallId = ToolCallId('foreign')
const recordedId = '{{id:1}}'
const liveId = 'obs-11111111-1111-4111-8111-111111111111'
const newerId = 'obs-22222222-2222-4222-8222-222222222222'

const COMMITTED_FIXTURE = new URL('../../../snapshots/web/map-use-session/session.v4.jsonl', import.meta.url)
const COMMITTED_OVERRIDE = new URL('../../../snapshots/web/map-use-session/replay.override.json', import.meta.url)

function fixture(observationId = recordedId, observationError: false | string | object = false) {
  const session = Session.create(SessionId('map-use-replay-unit'))
  session.append('tool/call', { turn: 1, step: 1, callId: observeCallId, name: 'map_observe', arguments: '{}' })
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
    callId: observeCallId, isError: observationError !== false,
    content: [{ type: 'text', text: observationError !== false
      ? (typeof observationError === 'string' ? observationError : JSON.stringify(observationError))
      : JSON.stringify({ observation_id: observationId, revision: 2, view_id: 'view' }) }],
  }) }, { surfaceOp: 'append' })
  const call: ToolCallBlock = { type: 'tool-call', id: panCallId, name: 'map_use',
    arguments: JSON.stringify({ action: 'pan', observation_id: recordedId, dx_px: 60, dy_px: 40 }) }
  session.append('assistant/message', { turn: 1, step: 2,
    message: createAssistantMessage({ content: [call], source: { provider: 'mock', model: 'mock' } }),
    stream: [
      { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
      { type: 'reasoning-chunks', time0: 0, dt: [], index: 0, texts: ['use the current observation'] },
      { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'use the current observation' } } },
      { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
      { type: 'tool-call-chunks', time0: 0, dt: [], index: 1, id: panCallId, name: 'map_use', args: [''] },
      { type: 'tool-call-chunks', time0: 0, dt: [0], index: 1, id: panCallId, args: [call.arguments.slice(0, 28), call.arguments.slice(28)] },
      { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 1, block: call } },
      { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
    ],
  }, { surfaceOp: 'append' })
  return session.snapshotEvents()
}

function request(observations: { id: string; revision: number }[]) {
  return observations.map(({ id, revision }) => createToolResultMessage({
    callId: observeCallId, isError: false,
    content: [{ type: 'text', text: JSON.stringify({ observation_id: id, image_size: { width: 600, height: 400 }, revision, view_id: 'live-view' }) }],
  }))
}

/** The legal request shape: one map_observe call paired with its single settled result. */
function liveRequest(
  observationId = liveId,
  revision = 2,
  extras: { callId?: typeof observeCallId; isError?: boolean; sourceCallId?: string } = {},
): [AssistantMessage, ToolResultMessage] {
  const callId = extras.callId ?? observeCallId
  const call = createAssistantMessage({
    content: [{ type: 'tool-call', id: callId, name: 'map_observe', arguments: '{}' }],
    source: { provider: 'mock', model: 'mock' },
  })
  const result = createToolResultMessage({
    callId, isError: extras.isError ?? false,
    content: [{ type: 'text', text: JSON.stringify({ observation_id: observationId, revision, view_id: 'live-view' }) }],
  })
  if (extras.sourceCallId !== undefined) {
    return [call, { ...result, source: { kind: 'tool' as const, callId: ToolCallId(extras.sourceCallId) } }]
  }
  return [call, result]
}

function argumentsOf(entry: ReplayEntry): string | undefined {
  if (entry.kind !== 'chunks') throw new Error('expected a chunk entry')
  const block = entry.chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
  return block?.type === 'block-end' && block.block.type === 'tool-call' ? block.block.arguments : undefined
}

/** A one-call streamed entry carrying the given settled arguments. */
function streamedEntry(id: ToolCallId, name: string, argumentsText: string, { split = false } = {}): ReplayEntry {
  const middle = Math.ceil(argumentsText.length / 2)
  const halves: string[] = split && argumentsText.length > 1
    ? [argumentsText.slice(0, middle), argumentsText.slice(middle)]
    : [argumentsText]
  const deltas = halves.map(argumentsDelta => ({ type: 'tool-call-delta' as const, index: 0, id, name, argumentsDelta }))
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      ...deltas,
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  }
}

const resolvedArguments = (id = liveId) =>
  JSON.stringify({ action: 'pan', observation_id: id, dx_px: 60, dy_px: 40 })

/** The real bound entry (committed placeholder shape) resolved to the live observation. */
function boundPair() {
  const entry = mapUseReplayOverride(fixture()).patches[0]!.entry
  const resolved = resolveScriptedEntry(entry, liveRequest())
  return { entry, resolved }
}

describe('map-use-session replay bindings', () => {
  it('binds packed and settled arguments to the recorded observation revision without changing other chunks', () => {
    const events = fixture()
    const original = JSON.stringify(events)
    const { patches } = mapUseReplayOverride(events)
    expect(patches).toHaveLength(1)
    const patch = patches[0]!
    expect(patch.at).toBe(0)
    const resolved = resolveScriptedEntry(patch.entry, request([
      { id: liveId, revision: 2 }, { id: newerId, revision: 3 },
    ]))
    const expected = JSON.stringify({ action: 'pan', observation_id: liveId, dx_px: 60, dy_px: 40 })
    expect(argumentsOf(resolved)).toBe(expected)
    if (resolved.kind !== 'chunks') throw new Error('expected a chunk entry')
    expect(resolved.chunks.flatMap(chunk => chunk.type === 'tool-call-delta' ? [chunk.argumentsDelta] : []).join('')).toBe(expected)
    expect(resolved.chunks[1]).toEqual({ type: 'reasoning-delta', index: 0, text: 'use the current observation' })
    expect(resolved.chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(JSON.stringify(events)).toBe(original)
  })

  it('keeps the generated override byte-identical to the committed sidecar', async () => {
    const events = parseSessionLog(await readFile(COMMITTED_FIXTURE, 'utf8'))
    const committed = await readFile(COMMITTED_OVERRIDE, 'utf8')
    expect(JSON.stringify(mapUseReplayOverride(events), null, 2) + '\n').toBe(committed)
  })

  it('derives the committed request plan for both recorded map_use calls', async () => {
    const events = parseSessionLog(await readFile(COMMITTED_FIXTURE, 'utf8'))
    const plan = deriveMapUseRequestPlan(events)
    expect(plan.size).toBe(2)
    for (const step of plan.values()) {
      expect(step.revision).toBeGreaterThanOrEqual(0)
      expect(typeof step.observationCallId).toBe('string')
    }
  })

  it('refuses a request without the recorded observation revision', () => {
    const patch = mapUseReplayOverride(fixture()).patches[0]!
    expect(() => resolveScriptedEntry(patch.entry, request([{ id: liveId, revision: 1 }]))).toThrow(/matched nothing/)
    expect(() => resolveScriptedEntry(patch.entry, [])).toThrow(/matched nothing/)
  })

  it('rejects recorded mismatched, absent, failed and consumed observations', () => {
    expect(() => mapUseReplayOverride(fixture('{{id:9}}'))).toThrow(/different observation/)
    expect(() => mapUseReplayOverride(fixture().slice(2))).toThrow(/missing/)
    expect(() => mapUseReplayOverride(fixture(recordedId, 'Error: STALE_OBSERVATION'))).toThrow(/missing/)
    const consumed = [...fixture()]
    const assistant = consumed.find(event => event.type === 'assistant/message')!
    consumed.push(assistant)
    expect(() => mapUseReplayOverride(consumed)).toThrow(/consumed/)
  })

  it('rejects malformed observation JSON and incomplete model streams', () => {
    expect(() => mapUseReplayOverride(fixture(recordedId, {}))).toThrow(/cites a missing/)
    const incomplete = fixture()
    const assistant = incomplete.find(event => event.type === 'assistant/message')
    if (assistant?.type !== 'assistant/message') throw new Error('missing fixture assistant')
    expect(() => mapUseReplayOverride(incomplete.map(event =>
      event === assistant ? { ...event, data: { ...assistant.data, stream: assistant.data.stream.slice(0, -1) } } : event),
    )).toThrow(/without a finish chunk/)
  })
})

describe('map-use request binding verification', () => {
  function assertWith(messages: Parameters<typeof assertMapUseRequestBinding>[1]['messages'], pair = boundPair()) {
    const plan = deriveMapUseRequestPlan(fixture())
    return () => assertMapUseRequestBinding(plan, { ...pair, messages })
  }

  it('verifies a legal pan binding and returns the planned call', () => {
    const pair = boundPair()
    expect(assertWith(liveRequest(), pair)()).toEqual([panCallId])
  })

  it('verifies a recorded finish that cites its observation', () => {
    const finishArgs = (id: string) => JSON.stringify({ action: 'finish', observation_id: id })
    const plan = deriveMapUseRequestPlan(fixture())
    const messages = liveRequest()
    const finishBinding = '{{fromRequest:"observation_id":"(obs-[0-9a-f-]+)"[^\\n]*?"revision":2,}}'
    const entry = streamedEntry(finishCallId, 'map_use', finishArgs(finishBinding))
    const resolved = streamedEntry(finishCallId, 'map_use', finishArgs(liveId))
    const extended = new Map(plan).set(finishCallId, { observationCallId: observeCallId, revision: 2 })
    expect(assertMapUseRequestBinding(extended, { entry, resolved, messages })).toEqual([finishCallId])
  })

  it('skips an unplanned finish that cites no observation', () => {
    const args = JSON.stringify({ action: 'finish' })
    const entry = streamedEntry(finishCallId, 'map_use', args)
    const resolved = streamedEntry(finishCallId, 'map_use', args)
    expect(assertWith(liveRequest(), { entry, resolved })()).toEqual([])
  })

  it('accepts deeply frozen inputs', () => {
    const freeze = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      Object.freeze(value)
      for (const item of Object.values(value)) freeze(item)
    }
    const pair = boundPair()
    const plan = deriveMapUseRequestPlan(fixture())
    const messages = liveRequest()
    freeze(plan)
    freeze(pair)
    freeze(messages)
    expect(() => assertMapUseRequestBinding(plan, { ...pair, messages })).not.toThrow()
  })

  function assertResolved(messages: Parameters<typeof assertMapUseRequestBinding>[1]['messages']) {
    const pair = boundPair()
    const resolved = resolveScriptedEntry(pair.entry, messages)
    const plan = deriveMapUseRequestPlan(fixture())
    return () => assertMapUseRequestBinding(plan, { entry: pair.entry, resolved, messages })
  }

  it.each([
    ['trailing user lookalike', () => assertResolved([...liveRequest(), createUserMessage({
      content: [{ type: 'text' as const, text: JSON.stringify({ observation_id: newerId, revision: 2, view_id: 'live-view' }) }],
      source: { kind: 'user' as const },
    })])],
    ['trailing unrelated tool result lookalike', () => assertResolved([...liveRequest(), createToolResultMessage({
      callId: foreignCallId, isError: false,
      content: [{ type: 'text', text: JSON.stringify({ observation_id: newerId, revision: 2, view_id: 'live-view' }) }],
    })])],
    ['duplicate results for the observe call', () => assertWith([...liveRequest(), createToolResultMessage({
      callId: observeCallId, isError: false,
      content: [{ type: 'text', text: JSON.stringify({ observation_id: liveId, revision: 2 }) }],
    })])],
    ['only a user lookalike and no observe call', () => assertWith([createUserMessage({
      content: [{ type: 'text' as const, text: JSON.stringify({ observation_id: newerId, revision: 2 }) }],
      source: { kind: 'user' as const },
    })])],
    ['failed observe result', () => assertWith(liveRequest(liveId, 2, { isError: true }))],
    ['missing observe result', () => assertWith([liveRequest()[0]])],
    ['a newer observe with the same revision', () => assertWith([
      ...liveRequest(),
      ...liveRequest(newerId, 2, { callId: ToolCallId('observe-newer') }),
    ])],
    ['result before its call', () => assertWith([liveRequest()[1], liveRequest()[0]])],
    ['source call id bound to another call', () => assertWith(liveRequest(liveId, 2, { sourceCallId: 'other' }))],
    ['two observation payloads in one result', () => assertWith([
      liveRequest()[0],
      createToolResultMessage({
        callId: observeCallId, isError: false,
        content: [
          { type: 'text', text: JSON.stringify({ observation_id: liveId, revision: 2 }) },
          { type: 'text', text: JSON.stringify({ observation_id: newerId, revision: 2 }) },
        ],
      }),
    ])],
    ['a map_use after the latest observe', () => assertWith([
      ...liveRequest(),
      createAssistantMessage({
        content: [{ type: 'tool-call', id: foreignCallId, name: 'map_use', arguments: '{}' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    ])],
    ['a finish-shaped map_use after the latest observe', () => assertWith([
      ...liveRequest(),
      createAssistantMessage({
        content: [{ type: 'tool-call', id: foreignCallId, name: 'map_use', arguments: JSON.stringify({ action: 'finish' }) }],
        source: { provider: 'mock', model: 'mock' },
      }),
    ])],
    ['revision that disagrees with the plan', () => assertWith(liveRequest(liveId, 3))],
  ])('rejects %s', (_name, run) => {
    expect(run()).toThrow(/map-use-session:/)
  })

  it('rejects a planned call whose template was already stripped', () => {
    const entry = streamedEntry(panCallId, 'map_use', resolvedArguments())
    const resolved = streamedEntry(panCallId, 'map_use', resolvedArguments())
    expect(assertWith(liveRequest(), { entry, resolved })).toThrow(/lost its recorded binding/)
  })

  it.each([
    ['an unplanned call citing an observation', () => assertWith(liveRequest(), {
      entry: streamedEntry(foreignCallId, 'map_use', JSON.stringify({ action: 'pan', observation_id: liveId, dx_px: 0, dy_px: 0 })),
      resolved: streamedEntry(foreignCallId, 'map_use', JSON.stringify({ action: 'pan', observation_id: liveId, dx_px: 0, dy_px: 0 })),
    })],
    ['an unplanned non-finish call', () => assertWith(liveRequest(), {
      entry: streamedEntry(foreignCallId, 'map_use', JSON.stringify({ action: 'zoom', scale: 2 })),
      resolved: streamedEntry(foreignCallId, 'map_use', JSON.stringify({ action: 'zoom', scale: 2 })),
    })],
    ['streamed arguments disagreeing with the settlement', () => {
      const entry: ReplayEntry = {
        kind: 'chunks',
        chunks: [
          { type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: 0, id: panCallId, name: 'map_use', argumentsDelta: '{"action":"pan"' },
          { type: 'block-end', index: 0, block: { type: 'tool-call', id: panCallId, name: 'map_use', arguments: resolvedArguments() } },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ],
      }
      return assertWith(liveRequest(), { entry, resolved: streamedEntry(panCallId, 'map_use', resolvedArguments()) })
    }],
    ['a resolved call that changed identity', () => assertWith(liveRequest(), {
      entry: boundPair().entry,
      resolved: streamedEntry(foreignCallId, 'map_use', resolvedArguments()),
    })],
    ['a resolved entry that kept the binding placeholder', () => {
      const pair = boundPair()
      return assertWith(liveRequest(), { entry: pair.entry, resolved: pair.entry })
    }],
    ['duplicate settled tool call ids in one entry', () => {
      const args = JSON.stringify({ action: 'finish' })
      const entry: ReplayEntry = {
        kind: 'chunks',
        chunks: [
          { type: 'block-start', index: 0, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: 0, id: panCallId, name: 'map_use', argumentsDelta: args },
          { type: 'block-end', index: 0, block: { type: 'tool-call', id: panCallId, name: 'map_use', arguments: args } },
          { type: 'block-start', index: 1, blockType: 'tool-call' },
          { type: 'tool-call-delta', index: 1, id: panCallId, name: 'map_use', argumentsDelta: args },
          { type: 'block-end', index: 1, block: { type: 'tool-call', id: panCallId, name: 'map_use', arguments: args } },
          { type: 'finish', reason: { kind: 'tool-calls' } },
        ],
      }
      return assertWith(liveRequest(), { entry, resolved: entry })
    }],
  ])('rejects %s', (_name, run) => {
    expect(run()).toThrow(/map-use-session:/)
  })

  it('rejects a request whose tool call ids repeat', () => {
    expect(assertWith([liveRequest()[0], liveRequest()[0], ...liveRequest().slice(1)])).toThrow(/appears twice/)
  })

  it('rejects resolved arguments that are not JSON or not an object', () => {
    const pair = boundPair()
    for (const bad of ['{not json', '42', '"text"', '[1]']) {
      expect(assertWith(liveRequest(), { entry: pair.entry, resolved: streamedEntry(panCallId, 'map_use', bad) }))
        .toThrow(/map-use-session:/)
    }
  })

  it('leaves entries without map_use calls alone', () => {
    const args = '{}'
    const pair = { entry: streamedEntry(foreignCallId, 'read_file', args), resolved: streamedEntry(foreignCallId, 'read_file', args) }
    expect(assertWith([], pair)()).toEqual([])
  })
})

describe('map-use request verifier coverage', () => {
  it('refuses a planned call verified twice and reports partial coverage', () => {
    const plan = deriveMapUseRequestPlan(fixture())
    const verifier = createMapUseRequestVerifier(plan)
    const messages = liveRequest()
    verifier.verifyResolvedEntry({ ...boundPair(), messages })
    expect(() => { verifier.verifyResolvedEntry({ ...boundPair(), messages }) }).toThrow(/verified twice/)
    expect(() => { verifier.assertComplete() }).toThrow(/verified twice/)
  })

  it('fails completeness when only part of the plan was verified', () => {
    const plan = deriveMapUseRequestPlan(fixture())
    const verifier = createMapUseRequestVerifier(new Map(plan).set(finishCallId, { observationCallId: observeCallId, revision: 2 }))
    verifier.verifyResolvedEntry({ ...boundPair(), messages: liveRequest() })
    expect(() => { verifier.assertComplete() }).toThrow(/never verified: finish/)
  })

  it('fails completeness when nothing was verified', () => {
    const verifier = createMapUseRequestVerifier(deriveMapUseRequestPlan(fixture()))
    expect(() => { verifier.assertComplete() }).toThrow(/never verified: pan/)
  })

  it('passes completeness after every planned call verified once', () => {
    const plan = deriveMapUseRequestPlan(fixture())
    const verifier = createMapUseRequestVerifier(plan)
    verifier.verifyResolvedEntry({ ...boundPair(), messages: liveRequest() })
    expect(() => { verifier.assertComplete() }).not.toThrow()
  })

  it('rethrows the first binding error instead of a coverage summary', () => {
    const verifier = createMapUseRequestVerifier(deriveMapUseRequestPlan(fixture()))
    const messages = liveRequest(liveId, 3)
    expect(() => { verifier.verifyResolvedEntry({ ...boundPair(), messages }) }).toThrow(/stale or foreign/)
    expect(() => { verifier.assertComplete() }).toThrow(/stale or foreign/)
  })
})
