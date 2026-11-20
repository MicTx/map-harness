/** Scenario-owned replay bindings for live map observations. */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { GenerateOptions, RequestMessage, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { deriveReplayScript, type ReplayEntry, type ReplayOverridePatch } from '@deepseek-ai/dsh-llm-replay'

/** One recorded observation a scenario `map_use` cited. */
export interface RecordedObservation {
  /** The `map_observe` tool call whose result carried this observation. */
  readonly observationCallId: ToolCallId
  /** Map revision the recording reported with the observation. */
  readonly revision: number
}

/** A `map_use` call that must keep its recorded observation binding. */
export type MapUseRequestPlan = ReadonlyMap<ToolCallId, RecordedObservation>

/** One streamed entry's map_use calls, in recorded order. */
interface RecordedMapUseStream {
  readonly at: number
  readonly entry: ReplayEntry & { kind: 'chunks' }
  readonly calls: readonly { readonly call: ToolCallBlock; readonly observation: RecordedObservation }[]
}

interface Observation {
  readonly id: string
  readonly revision: number
  readonly callId: ToolCallId
}

const LIVE_OBSERVATION_ID = /^obs-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Read the observation one `map_observe` result carries, or the reason it carries none. */
function observationOf(event: SessionEvent & { type: 'tool/result' }): Observation | undefined {
  if (event.data.message.isError) return undefined
  const text = event.data.message.content.find(block => block.type === 'text')
  const payload: unknown = text?.type === 'text' ? JSON.parse(text.text) : undefined
  if (!isRecord(payload) || typeof payload.observation_id !== 'string'
    || typeof payload.revision !== 'number' || !Number.isSafeInteger(payload.revision) || payload.revision < 0) {
    throw new Error('map-use-session: observation result lacks its identity or revision')
  }
  return { id: payload.observation_id, revision: payload.revision, callId: ToolCallId(event.data.message.toolCallId) }
}

/**
 * Walk the recorded map_use streams, pairing each call with the observation it cited.
 * Shared by the override generator and the request-binding plan so both read one walk.
 * @param events - complete recorded Session events, in durable order.
 * @returns one entry per recorded model stream that contains a map_use call.
 * @throws when a call cites a missing, consumed or different observation, or a stream is incomplete.
 */
function* walkRecordedMapUseStreams(events: readonly SessionEvent[]): Generator<RecordedMapUseStream> {
  const script = deriveReplayScript([...events])
  const tools = new Map<string, string>()
  let latest: Observation | undefined
  let at = 0
  for (const event of events) {
    if (event.type === 'tool/call') tools.set(event.data.callId, event.data.name)
    if (event.type === 'tool/result' && tools.get(event.data.message.toolCallId) === 'map_observe') {
      latest = undefined
      if (!event.data.message.isError) latest = observationOf(event)
    }
    if (event.type === 'compaction/summary' && event.data.llmStreamCall === true) at += 1
    if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') continue
    const index = at++
    const entry = script[index]
    if (entry?.kind !== 'chunks') throw new Error(`map-use-session: missing recorded stream ${index}`)
    const calls: { call: ToolCallBlock; observation: RecordedObservation }[] = []
    for (const chunk of entry.chunks) {
      if (chunk.type !== 'block-end' || chunk.block.type !== 'tool-call' || chunk.block.name !== 'map_use') continue
      const call = chunk.block
      const payload: unknown = JSON.parse(call.arguments)
      if (!isRecord(payload) || typeof payload.observation_id !== 'string'
        || latest === undefined || payload.observation_id !== latest.id) {
        throw new Error(`map-use-session: ${call.id} cites a missing, consumed or different observation`)
      }
      calls.push({ call, observation: { observationCallId: latest.callId, revision: latest.revision } })
      latest = undefined
    }
    if (calls.length > 0) yield { at: index, entry, calls }
  }
}

/**
 * Bind each recorded map_use call to the preceding live observation at the recorded revision.
 * Packed delta fragmentation and non-tool chunks retain their recorded order. Recording calls this
 * after fixture normalization; keyless runs read the sidecar without rewriting either file.
 * @param events - complete recorded Session events, in durable order.
 * @returns positional replacements for the map_use streams only.
 * @throws when an action cites a missing, consumed or different observation, or a stream is incomplete.
 */
export function mapUseReplayOverride(events: readonly SessionEvent[]): { patches: ReplayOverridePatch[] } {
  const patches: ReplayOverridePatch[] = []
  for (const { at, entry, calls } of walkRecordedMapUseStreams(events)) {
    const boundByCall = new Map<string, string>()
    for (const { call, observation } of calls) {
      // The revision anchor excludes action receipts and earlier observations in the request history.
      const binding = `{{fromRequest:"observation_id":"(obs-[0-9a-f-]+)"[^\\n]*?"revision":${observation.revision},}}`
      const bound = call.arguments.replace(/("observation_id"\s*:\s*")[^"]*(")/,
        (_match, left: string, right: string) => left + binding + right)
      boundByCall.set(call.id, bound)
    }
    const emitted = new Set<string>()
    patches.push({ at, entry: {
      kind: 'chunks',
      chunks: entry.chunks.map((chunk) => {
        if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
          const bound = boundByCall.get(chunk.block.id)
          return bound === undefined ? chunk : { ...chunk, block: { ...chunk.block, arguments: bound } }
        }
        if (chunk.type !== 'tool-call-delta') return chunk
        const bound = boundByCall.get(chunk.id)
        if (bound === undefined || chunk.argumentsDelta === '') return chunk
        const argumentsDelta = emitted.has(chunk.id) ? '' : bound
        emitted.add(chunk.id)
        return { ...chunk, argumentsDelta }
      }),
    } })
  }
  return { patches }
}

/**
 * Derive the observation each recorded map_use call must keep citing.
 * Only calls that recorded an `observation_id` enter the plan; a recorded `finish`
 * without one stays unplanned and is skipped by the verifier.
 * @param events - complete recorded Session events, in durable order.
 * @returns the recorded map_use call id to observation binding.
 * @throws when the recording itself cites a missing, consumed or different observation.
 */
export function deriveMapUseRequestPlan(events: readonly SessionEvent[]): MapUseRequestPlan {
  const plan = new Map<ToolCallId, RecordedObservation>()
  for (const { calls } of walkRecordedMapUseStreams(events)) {
    for (const { call, observation } of calls) plan.set(ToolCallId(call.id), observation)
  }
  return plan
}

/** The strict-source observation a request's tool history resolves to. */
interface StrictObservation {
  readonly callId: ToolCallId
  readonly id: string
  readonly revision: number
}

/**
 * Resolve the one observation the request may legally bind, from call/result pairing only.
 * Never falls back to scanning arbitrary request text: a value that only appears as
 * free-form text is not evidence that the map produced it.
 * @param messages - the live request messages.
 * @returns the latest `map_observe` call id and the identity its settled result reported.
 * @throws when the history is ambiguous, out of order, failed, or has no settled observation.
 */
function strictLatestObservation(messages: GenerateOptions['messages']): StrictObservation {
  const callIds = new Set<string>()
  let observeIndex = -1
  let observeId: ToolCallId | undefined
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type !== 'tool-call') continue
      if (callIds.has(block.id)) throw new Error(`map-use-session: tool call id ${block.id} appears twice in the request`)
      callIds.add(block.id)
      if (block.name !== 'map_observe') continue
      observeIndex = index
      observeId = block.id
    }
  }
  if (observeId === undefined) throw new Error('map-use-session: the request has no map_observe call to bind')
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'assistant' || index <= observeIndex) continue
    for (const block of message.content) {
      if (block.type === 'tool-call' && block.name === 'map_use') {
        throw new Error(`map-use-session: ${block.id} already continued the observed turn`)
      }
    }
  }
  const candidates = messages.filter((message): message is Extract<RequestMessage, { role: 'tool' }> =>
    message.role === 'tool' && (message.toolCallId === observeId || message.source.callId === observeId))
  if (candidates.length !== 1) {
    throw new Error(`map-use-session: expected one result for ${observeId}, found ${candidates.length}`)
  }
  const result = candidates[0]!
  if (result.toolCallId !== observeId || result.source.callId !== observeId) {
    throw new Error(`map-use-session: the result for ${observeId} is bound to another call`)
  }
  if (messages.indexOf(result) <= observeIndex) {
    throw new Error(`map-use-session: ${observeId} settled before its call appeared`)
  }
  if (result.isError === true) throw new Error(`map-use-session: ${observeId} failed`)
  const payloads: Record<string, unknown>[] = []
  for (const block of result.content) {
    if (block.type !== 'text') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(block.text)
    } catch {
      continue
    }
    if (isRecord(parsed) && Object.hasOwn(parsed, 'observation_id')) payloads.push(parsed)
  }
  if (payloads.length !== 1) {
    throw new Error(`map-use-session: ${observeId} reported ${payloads.length} observations`)
  }
  const payload = payloads[0]!
  const id = payload['observation_id']
  const revision = payload['revision']
  if (typeof id !== 'string' || !LIVE_OBSERVATION_ID.test(id)) {
    throw new Error(`map-use-session: ${observeId} reported a malformed observation id`)
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`map-use-session: ${observeId} reported a malformed revision`)
  }
  return { callId: observeId, id, revision }
}

/** Settled tool calls of one scripted entry, in stream order. */
function settledToolCalls(entry: ReplayEntry): ToolCallBlock[] {
  if (entry.kind !== 'chunks') return []
  const calls: ToolCallBlock[] = []
  for (const chunk of entry.chunks) {
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') calls.push(chunk.block)
  }
  return calls
}

/** Concatenate the argument deltas a stream emitted for one block index. */
function streamedArguments(entry: ReplayEntry, index: number): string {
  if (entry.kind !== 'chunks') return ''
  let argumentsDelta = ''
  for (const chunk of entry.chunks) {
    if (chunk.type === 'tool-call-delta' && chunk.index === index) argumentsDelta += chunk.argumentsDelta
  }
  return argumentsDelta
}

/** Block index of the settled `map_use` call with this id, or -1. */
function settledIndex(entry: ReplayEntry, callId: string): number {
  if (entry.kind !== 'chunks') return -1
  for (const chunk of entry.chunks) {
    if (chunk.type === 'block-end' && chunk.block.type === 'tool-call' && chunk.block.id === callId) return chunk.index
  }
  return -1
}

/**
 * Reject a resolved scripted entry whose `map_use` bindings do not match the plan.
 * Pure: it neither mutates its input nor records coverage; the caller owns any
 * "every planned call was seen" accounting.
 * @param plan - recorded map_use call id to observation binding.
 * @param input - the selected entry, its resolved form, and the live request messages.
 * @returns the planned map_use call ids this entry verified, in stream order.
 * @throws when the stream changed shape, a binding is missing or stale, or a call is unplanned.
 */
export function assertMapUseRequestBinding(
  plan: MapUseRequestPlan,
  input: { readonly entry: ReplayEntry; readonly resolved: ReplayEntry; readonly messages: GenerateOptions['messages'] },
): readonly ToolCallId[] {
  const before = settledToolCalls(input.entry)
  const after = settledToolCalls(input.resolved)
  if (before.length !== after.length
    || before.some((call, index) => call.id !== after[index]?.id || call.name !== after[index]?.name)) {
    throw new Error('map-use-session: resolution changed the settled tool calls')
  }
  const seen = new Set<string>()
  for (const call of before) {
    if (seen.has(call.id)) throw new Error(`map-use-session: ${call.id} settled twice in one entry`)
    seen.add(call.id)
  }
  const verified: ToolCallId[] = []
  for (const original of before) {
    if (original.name !== 'map_use') continue
    const index = settledIndex(input.entry, original.id)
    const settled = streamedArguments(input.entry, index)
    if (index < 0 || settled !== original.arguments) {
      throw new Error(`map-use-session: ${original.id} streamed arguments disagree with its settlement`)
    }
    const resolvedIndex = settledIndex(input.resolved, original.id)
    const resolved = after.find(call => call.id === original.id)
    if (resolved === undefined || resolvedIndex < 0) throw new Error(`map-use-session: ${original.id} lost its settlement`)
    if (streamedArguments(input.resolved, resolvedIndex) !== resolved.arguments) {
      throw new Error(`map-use-session: ${original.id} resolved arguments disagree with its stream`)
    }
    if (resolved.arguments.includes('{{fromRequest:')) {
      throw new Error(`map-use-session: ${original.id} kept an unresolved binding`)
    }
    const templated = original.arguments.includes('{{fromRequest:')
    let argumentsValue: unknown
    try {
      argumentsValue = JSON.parse(resolved.arguments)
    } catch {
      throw new Error(`map-use-session: ${original.id} resolved to invalid JSON`)
    }
    if (!isRecord(argumentsValue)) throw new Error(`map-use-session: ${original.id} resolved to a non-object`)
    const planned = plan.get(ToolCallId(original.id))
    if (planned === undefined) {
      // The protocol permits a finish that cites no observation; every other
      // unplanned call would silently replay without its source.
      if (templated || Object.hasOwn(argumentsValue, 'observation_id') || argumentsValue['action'] !== 'finish') {
        throw new Error(`map-use-session: ${original.id} is not in the recorded plan`)
      }
      continue
    }
    if (!templated) throw new Error(`map-use-session: ${original.id} lost its recorded binding`)
    const live = strictLatestObservation(input.messages)
    if (live.callId !== planned.observationCallId || live.revision !== planned.revision) {
      throw new Error(`map-use-session: ${original.id} cites a stale or foreign observation`)
    }
    if (argumentsValue['observation_id'] !== live.id) {
      throw new Error(`map-use-session: ${original.id} resolved to a foreign observation id`)
    }
    verified.push(ToolCallId(original.id))
  }
  return verified
}

/** Scenario-local coverage counter for {@link assertMapUseRequestBinding}. */
export interface MapUseRequestVerifier {
  /** Verify one resolved entry and record the planned calls it covered. */
  verifyResolvedEntry(input: {
    readonly entry: ReplayEntry
    readonly resolved: ReplayEntry
    readonly messages: GenerateOptions['messages']
  }): void
  /** Throw unless every planned call was verified exactly once and nothing failed first. */
  assertComplete(): void
}

/**
 * Build a per-scenario verifier that counts planned-call coverage across streams.
 * Coverage state stays in this closure so it is never shared between scenarios.
 * @param plan - recorded map_use call id to observation binding.
 * @returns the hook-compatible verifier plus its end-of-scenario completeness check.
 */
export function createMapUseRequestVerifier(plan: MapUseRequestPlan): MapUseRequestVerifier {
  const seen = new Set<ToolCallId>()
  let firstError: Error | undefined
  return {
    verifyResolvedEntry(input): void {
      try {
        const verified = assertMapUseRequestBinding(plan, input)
        for (const id of verified) {
          if (seen.has(id)) throw new Error(`map-use-session: ${id} verified twice`)
        }
        for (const id of verified) seen.add(id)
      } catch (error) {
        firstError ??= error instanceof Error ? error : new Error(String(error))
        throw error
      }
    },
    assertComplete(): void {
      if (firstError !== undefined) throw firstError
      const missing = [...plan.keys()].filter(id => !seen.has(id))
      const unexpected = [...seen].filter(id => !plan.has(id))
      if (missing.length > 0 || unexpected.length > 0) {
        const detail = [
          ...missing.length === 0 ? [] : [`never verified: ${missing.join(', ')}`],
          ...unexpected.length === 0 ? [] : [`not planned: ${unexpected.join(', ')}`],
        ].join('; ')
        throw new Error(`map-use-session: incomplete binding coverage (${detail})`)
      }
    },
  }
}
