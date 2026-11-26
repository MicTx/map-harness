import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { redactSessionSnapshotIds } from '../src/identity.ts'
import { collapsePackedPayloads, normalizeSessionSnapshots } from '../src/normalize.ts'

const parentId = '11111111-1111-4111-8111-111111111111'
const childId = '22222222-2222-4222-8222-222222222222'
const messageId = '33333333-3333-4333-8333-333333333333'
const approvalId = '44444444-4444-4444-8444-444444444444'
const runId = '55555555-5555-4555-8555-555555555555'
const otherId = '66666666-6666-4666-8666-666666666666'
const proseUuid = '77777777-7777-4777-8777-777777777777'

describe('session snapshot identity redaction', () => {
  it('preserves feedback versions and target relationships without redacting unrelated prose', () => {
    const source = [
      { type: 'session', id: parentId },
      { type: 'assistant/message', data: { message: { id: messageId, role: 'assistant', content: [], source: {} } } },
      { type: 'feedback/message-put', data: { sessionId: parentId, item: { messageId, version: approvalId, note: proseUuid } } },
      { type: 'feedback/message-put', data: { sessionId: parentId, item: { messageId, version: runId } } },
      { type: 'feedback/message-delete', data: { sessionId: parentId, messageId } },
      { type: 'example', data: { version: proseUuid } },
    ].map(record => JSON.stringify(record)).join('\n')
    const [output] = redactSessionSnapshotIds([source])
    expect(output).toContain('"version":"{{id:1}}"')
    expect(output).toContain('"version":"{{id:2}}"')
    expect(output?.match(/"messageId":"{{message:1}}"/g)).toHaveLength(3)
    expect(output).toContain(proseUuid)
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('preserves typed relationships across parent and child logs', () => {
    const parent = [
      JSON.stringify({ type: 'session', id: parentId, createdAt: 1, cwd: '/tmp/work' }),
      JSON.stringify({
        type: 'agent/inbox/spliced',
        data: {
          inserted: [{
            role: 'user',
            content: [{ type: 'text', text: `keep unrelated ${proseUuid}; session ${childId}` }],
            source: { kind: 'user' },
            id: messageId,
          }],
        },
      }),
      JSON.stringify({ type: 'approval/asked', data: { id: approvalId } }),
      JSON.stringify({ type: 'tool-workflow/run-start', data: { runId } }),
      JSON.stringify({ type: 'example', data: { requestId: otherId, echoed: otherId } }),
      '',
    ].join('\n')
    const child = [
      JSON.stringify({ type: 'session', id: childId, parentSession: parentId, createdAt: 2, cwd: '/tmp/work' }),
      JSON.stringify({
        type: 'user/message',
        data: {
          role: 'user', content: [], source: { kind: 'user' }, id: messageId,
        },
      }),
      '',
    ].join('\n')

    const redacted = redactSessionSnapshotIds([parent, child])
    expect(redacted[0]).toContain('"id":"{{session:1}}"')
    expect(redacted[1]).toContain('"id":"{{session:2}}"')
    expect(redacted[1]).toContain('"parentSession":"{{session:1}}"')
    expect(redacted.join('\n').match(/\{\{message:1\}\}/g)).toHaveLength(2)
    expect(redacted[0]).toContain('"id":"{{approval:1}}"')
    expect(redacted[0]).toContain('"runId":"{{workflow:1}}"')
    expect(redacted[0]).toContain('"requestId":"{{id:1}}"')
    expect(redacted[0]).toContain('"echoed":"{{id:1}}"')
    expect(redacted[0]).toContain(proseUuid)
    expect(redacted[0]).toContain('session {{session:2}}')
    expect(redactSessionSnapshotIds(redacted)).toEqual(redacted)
  })

  it('classifies semantic text plus command, RPC, and retry identity fields', () => {
    const semanticMessage = '88888888-8888-4888-8888-888888888888'
    const anonymousUser = '99999999-9999-4999-8999-999999999999'
    const retryId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const source = [
      JSON.stringify({ type: 'not-a-session', data: { value: 'plain' } }),
      JSON.stringify({
        type: 'example',
        data: {
          commandId: 'command-7',
          rpcId: 'rpc-9',
          retryId,
          requestId: 'stable-readable-id',
          text: `Retain this as message ${semanticMessage}. Anonymous user: ${anonymousUser}`,
        },
      }),
    ].join('\n')

    const [redacted] = redactSessionSnapshotIds([source])
    expect(redacted).toContain('"commandId":"{{command:1}}"')
    expect(redacted).toContain('"rpcId":"{{rpc:1}}"')
    expect(redacted).toContain('"retryId":"{{retry:1}}"')
    expect(redacted).toContain('as message {{message:1}}')
    expect(redacted).toContain('Anonymous user: {{id:1}}')
    expect(redacted).toContain('"requestId":"stable-readable-id"')
    expect(redacted?.endsWith('\n')).toBe(false)
  })

  it('keeps a canonical token first seen through a generic id key', () => {
    const canonical = '{{message:7}}'
    const nextMessage = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const source = [
      JSON.stringify({ type: 'example', data: { requestId: canonical } }),
      JSON.stringify({
        type: 'user/message',
        data: { role: 'user', content: [], source: { kind: 'user' }, id: canonical },
      }),
      JSON.stringify({
        type: 'user/message',
        data: { role: 'user', content: [], source: { kind: 'user' }, id: nextMessage },
      }),
      '',
    ].join('\n')

    const [redacted] = redactSessionSnapshotIds([source])
    expect(redacted?.match(/\{\{message:7\}\}/g)).toHaveLength(2)
    expect(redacted).toContain('"id":"{{message:8}}"')
    expect(redacted).not.toContain('{{id:')
  })
})

describe('map transcript identities', () => {
  const artifact = `art-${otherId}@v1`
  const readAt = '2026-10-12T01:02:03.000Z'
  const snapshotText = 'spatial-context/snapshot v1 kind=baseline goal=1 digest=0123456789abcdef\n预算: steps 2/64, meta 100/524288 B, context 2345/262144 B, scan 3/100000 features, elapsed 91/1800000 ms'
  const logOf = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  const resultOf = (tool: string, text: string) => [
    { type: 'tool/call', data: { callId: 'call-1', name: tool } },
    { type: 'tool/result', data: { message: { toolCallId: 'call-1', content: [{ type: 'text', text }] } } },
  ]

  it('claims opaque catalog and run identities from map JSON and preserves metrics', () => {
    const source = logOf([
      { type: 'session', id: parentId },
      ...resultOf('catalog_resolve', JSON.stringify({ readPoint: { readId: approvalId, readAt }, artifact: { ref: artifact }, coveredPopulation: 200, nested: [{ readId: approvalId }, null, 4] })),
      { type: 'tool/call', data: { callId: 'call-2', name: 'run_submit' } },
      { type: 'tool/result', data: { message: { toolCallId: 'call-2', content: [{ type: 'text', text: JSON.stringify({ run_id: `run-${runId}`, operation_ref: 'op-0123456789abcdef01234567', request_digest: 'a'.repeat(64) }) }] } } },
      { type: 'tool/call', data: { callId: 'call-3', name: 'map_add_layer', arguments: JSON.stringify({ ref: artifact }) } },
    ])
    const [output] = redactSessionSnapshotIds([source])
    expect(output).not.toContain(otherId)
    expect(output).not.toContain(approvalId)
    expect(output).not.toContain(readAt)
    expect(output).not.toContain(runId)
    expect(output).not.toContain('op-0123456789abcdef01234567')
    expect(output).toContain('coveredPopulation\\\":200')
    expect(output).toContain('a'.repeat(64))
    expect(output).toContain('{{workflow:1}}')
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it.each([
    { kind: 'plugin:@map-harness/spatial-context' },
    { kind: 'spatial-context', plugin: '@map-harness/spatial-context' },
  ])('normalizes clocks only in an identified context message: %j', (source) => {
    const input = logOf([{ type: 'user/message', data: {
      role: 'user', source: { ...source, metadata: null, sections: [{ name: 'spatial-context', text: snapshotText }] },
      content: [{ type: 'text', text: snapshotText }],
    } }])
    const [output] = redactSessionSnapshotIds([input])
    expect(output?.match(/\{\{digest:1\}\}/g)).toHaveLength(2)
    expect(output?.match(/context \{\{contextBytes\}\}/g)).toHaveLength(2)
    expect(output?.match(/elapsed \{\{elapsed\}\}/g)).toHaveLength(2)
    expect(output).toContain('steps 2/64, meta 100/524288 B')
    expect(output).toContain('scan 3/100000 features')
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('normalizes clocks when the step budget is unlimited', () => {
    const unlimited = snapshotText.replace('steps 2/64', 'steps 2/不限')
    const input = logOf([{ type: 'user/message', data: {
      role: 'user', source: { kind: 'spatial-context', plugin: '@map-harness/spatial-context', metadata: null, sections: [{ name: 'spatial-context', text: unlimited }] },
      content: [{ type: 'text', text: unlimited }],
    } }])
    const [output] = redactSessionSnapshotIds([input])
    expect(output?.match(/elapsed \{\{elapsed\}\}/g)).toHaveLength(2)
    expect(output).toContain('steps 2/不限, meta 100/524288 B')
  })

  it('leaves lookalike user prose and unrelated tool output unchanged', () => {
    const json = JSON.stringify({ readId: approvalId, readAt, artifact: { ref: artifact } })
    const source = logOf([
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: snapshotText }] } },
      ...resultOf('read_file', json),
      ...resultOf('catalog_resolve', 'Error: malformed response'),
      { type: 'tool/result', data: { message: { toolCallId: 'call-1', content: [null, { type: 'image' }, { type: 'text', text: 42 }] } } },
    ])
    expect(redactSessionSnapshotIds([source])).toEqual([source])
  })

  it('keeps an unknown streamed observation distinct from canonical settled arguments', () => {
    const observationId = `obs-${otherId}`
    const argumentsText = JSON.stringify({ action: 'pan', observation_id: observationId, dx_px: 60, dy_px: 40 })
    const settled = argumentsText.replace(observationId, '{{id:7}}')
    const source = logOf([
      ...resultOf('map_observe', JSON.stringify({ observation_id: '{{id:7}}', revision: 1 })),
      { type: 'assistant/message', data: {
        message: { role: 'assistant', content: [{ type: 'tool-call', id: 'pan', name: 'map_use', arguments: settled }] },
        stream: [{ type: 'tool-call-chunks', id: 'pan', args: [argumentsText.slice(0, 51), argumentsText.slice(51)] }],
      } },
    ])
    const [output] = redactSessionSnapshotIds([collapsePackedPayloads(source)])
    expect(output).not.toContain(otherId)
    expect(output?.match(/\{\{id:7\}\}/g)).toHaveLength(2)
    expect(output?.match(/\{\{id:8\}\}/g)).toHaveLength(1)
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('does not assign an unknown observation a canonical token used later in the log', () => {
    const id = `obs-${otherId}`
    const source = logOf([
      ...resultOf('map_observe', JSON.stringify({ observation_id: '{{id:7}}' })),
      { type: 'assistant/message', data: {
        message: { role: 'assistant', content: [{ type: 'tool-call', id: 'pan', name: 'map_use',
          arguments: JSON.stringify({ observation_id: '{{id:7}}' }) }] },
        stream: [{ type: 'tool-call-chunks', id: 'pan', args: [JSON.stringify({ observation_id: id })] }],
      } },
      ...resultOf('map_observe', JSON.stringify({ observation_id: '{{id:8}}' })),
    ])
    const [output] = redactSessionSnapshotIds([source])
    expect(output?.match(/\{\{id:7\}\}/g)).toHaveLength(2)
    expect(output?.match(/\{\{id:8\}\}/g)).toHaveLength(1)
    expect(output?.match(/\{\{id:9\}\}/g)).toHaveLength(1)
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it.each([
    { observed: `obs-${otherId}`, streamed: `obs-${runId}`, prior: undefined },
    { observed: `obs-${otherId}`, streamed: `obs-${runId}`, prior: `obs-${runId}` },
    { observed: '{{id:7}}', streamed: '{{id:6}}', prior: '{{id:6}}' },
    { observed: '{{id:7}}', streamed: '{{id:8}}', prior: undefined },
  ])('retains a streamed observation mismatch: %j', ({ observed, streamed, prior }) => {
    const sourceOf = (streamId: string) => logOf([
      ...(prior === undefined ? [] : resultOf('map_observe', JSON.stringify({ observation_id: prior }))),
      ...resultOf('map_observe', JSON.stringify({ observation_id: observed })),
      { type: 'assistant/message', data: {
        message: { role: 'assistant', content: [{ type: 'tool-call', id: 'pan', name: 'map_use',
          arguments: JSON.stringify({ observation_id: observed }) }] },
        stream: [{ type: 'tool-call-chunks', id: 'pan', args: [JSON.stringify({ observation_id: streamId })] }],
      } },
    ])
    const expected = redactSessionSnapshotIds([sourceOf(observed)])
    const actual = redactSessionSnapshotIds([sourceOf(streamed)])
    expect(actual).not.toEqual(expected)
    expect(redactSessionSnapshotIds(actual)).toEqual(actual)
  })

  it('claims streamed run identities by value without reassigning known ones', () => {
    const rawRun = `run-${runId}`
    const knownRun = `run-${otherId}`
    const source = logOf([
      ...resultOf('run_get', JSON.stringify({ run_id: knownRun })),
      { type: 'assistant/message', data: {
        message: { content: [{ type: 'tool-call', id: 'get', name: 'run_get',
          arguments: JSON.stringify({ run_id: '{{workflow:7}}' }) }] },
        stream: [{ type: 'tool-call-chunks', id: 'get', args: [JSON.stringify({
          run_id: rawRun, nested: [{ run_id: rawRun }, { run_id: '{{workflow:7}}' }, null, 4, true],
          known: { run_id: knownRun }, text: 'plain',
        })] }],
      } },
    ])
    const [output] = redactSessionSnapshotIds([source])
    expect(output).not.toContain(runId)
    expect(output).not.toContain(otherId)
    // The unknown raw run id keeps its own token instead of inheriting the settled one.
    expect(output?.match(/\{\{workflow:8\}\}/g)).toHaveLength(2)
    expect(output?.match(/\{\{workflow:7\}\}/g)).toHaveLength(2)
    expect(output?.match(/\{\{workflow:1\}\}/g)).toHaveLength(2)
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('claims streamed observation identities without a settled message or call id', () => {
    const source = logOf([{ type: 'assistant/message', data: {
      stream: [{ type: 'tool-call-chunks', args: [JSON.stringify({ observation_id: `obs-${otherId}` })] }],
    } }])
    const [output] = redactSessionSnapshotIds([source])
    expect(output).not.toContain(otherId)
    expect(output).toContain('{{id:1}}')
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('preserves a packed observation mismatch through full committed fixture comparison', () => {
    const fixture = readFileSync(new URL('../../../../snapshots/web/map-use-session/session.v4.jsonl', import.meta.url), 'utf8')
    let mutations = 0
    const changed = fixture.split('\n').map((line) => {
      if (line.trim() === '') return line
      const record = JSON.parse(line) as SessionEvent
      if (record.type !== 'assistant/message') return line
      const pan = record.data.message.content.find(block => block.type === 'tool-call' && block.name === 'map_use'
        && (JSON.parse(block.arguments) as { action: string }).action === 'pan')
      if (pan?.type !== 'tool-call') return line
      const { observation_id: observation } = JSON.parse(pan.arguments) as { observation_id: string }
      const stream = record.data.stream.map((member) => {
        if (member.type !== 'tool-call-chunks' || member.id !== pan.id || !member.args.join('').includes(observation)) return member
        mutations += 1
        return { ...member, args: [member.args.join('').replace(observation, `obs-${proseUuid}`),
          ...member.args.slice(1).map(() => '')] }
      })
      return JSON.stringify({ ...record, data: { ...record.data, stream } })
    }).join('\n')
    expect(mutations).toBe(1)
    const context = { sessionIds: [], cwd: '/unused' }
    expect(normalizeSessionSnapshots([changed], context)).not.toEqual(normalizeSessionSnapshots([fixture], context))
  })

  it('redacts a split observation identity in recorded stream pieces without collapsing their count', () => {
    const id = `obs-${otherId}`
    const argumentsText = JSON.stringify({ action: 'pan', observation_id: id, dx_px: 60 })
    const pieces = [argumentsText.slice(0, 40), argumentsText.slice(40, 50), argumentsText.slice(50)]
    const source = logOf([
      ...resultOf('map_observe', JSON.stringify({ observation_id: id, revision: 1 })),
      { type: 'assistant/message', data: {
        message: { role: 'assistant', content: [{ type: 'tool-call', id: 'pan', name: 'map_use', arguments: argumentsText }] },
        stream: [{ type: 'tool-call-chunks', id: 'pan', dt: [9, 3], args: pieces }],
      } },
    ])
    const [output] = redactSessionSnapshotIds([source])
    expect(output).not.toContain(otherId)
    const rows = output!.trim().split('\n').map(line => JSON.parse(line) as SessionEvent)
    const record = rows[2]
    if (record?.type !== 'assistant/message') throw new Error('missing streamed assistant message')
    const stream = record.data.stream[0]
    if (stream?.type !== 'tool-call-chunks') throw new Error('missing packed tool arguments')
    expect(stream.args).toHaveLength(3)
    expect(stream.dt).toEqual([9, 3])
    expect(JSON.parse(stream.args.join(''))).toEqual({ action: 'pan', observation_id: '{{id:1}}', dx_px: 60 })
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('claims observation and view identities from paired map JSON', () => {
    const source = logOf(resultOf('map_observe', JSON.stringify({
      observation_id: `obs-${otherId}`, view_id: approvalId, revision: 2,
    })))
    const [output] = redactSessionSnapshotIds([source])
    expect(output).not.toContain(otherId)
    expect(output).not.toContain(approvalId)
    expect(output).toContain('observation_id\\\":\\\"{{id:1}}')
    expect(output).toContain('view_id\\\":\\\"{{id:2}}')
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  const observationRows = (capturedAt: string, expiresAtMs: number, elapsedMs: number, elapsedLimitMs = 60_000) => [
    { type: 'tool/call', data: { callId: 'observe', name: 'map_observe' } },
    { type: 'tool/result', data: {
      message: { toolCallId: 'observe', content: [{ type: 'text', text: JSON.stringify({
        observation_id: `obs-${otherId}`, view_id: approvalId, revision: 2,
      }) }] },
      meta: { kind: 'map-observation', record: {
        observationId: `obs-${otherId}`, viewId: approvalId, capturedAt,
        mapRevision: 2, generation: 1, cameraEpoch: 3, gestureEpoch: 4,
        camera: { center: [10, 20], zoom: 4 },
      } },
    } },
    { type: 'tool/call', data: { callId: 'pan', name: 'map_use' } },
    { type: 'tool/result', data: {
      message: { toolCallId: 'pan', content: [{ type: 'text', text: JSON.stringify({
        action: 'pan', observation_id: `obs-${otherId}`, source_revision: 2, candidate_revision: 3,
        budget: { actionsUsed: 1, actionsRemaining: 19, observationsUsed: 1, observationsRemaining: 19,
          elapsedMs, elapsedRemainingMs: Math.max(0, elapsedLimitMs - elapsedMs) },
      }) }] },
      meta: { kind: 'map-use', record: {
        observationId: `obs-${otherId}`, viewId: approvalId, expiresAtMs,
        controlEpoch: 5, targetRevision: 2,
      } },
    } },
  ]

  it('normalizes only map receipt clocks and still redacts identities in budget-bearing text', () => {
    const first = logOf(observationRows(readAt, 1700, 100))
    const second = logOf(observationRows('2026-10-13T01:02:03.000Z', 2900, 200))
    const [output] = redactSessionSnapshotIds([first])
    expect(redactSessionSnapshotIds([second])).toEqual([output])
    expect(output).not.toContain(otherId)
    expect(output).not.toContain(readAt)
    expect(output).toContain('"capturedAt":"{{clock}}"')
    expect(output).toContain('"expiresAtMs":0')
    expect(output).toContain('elapsedMs\\\":0')
    expect(output).toContain('elapsedRemainingMs\\\":60000')
    expect(output).toContain('"cameraEpoch":3,"gestureEpoch":4')
    expect(output).toContain('actionsRemaining\\\":19')
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('normalizes elapsed time for a paired unlimited map-use budget without changing its limits', () => {
    const sourceOf = (elapsedMs: number) => logOf([
      { type: 'tool/call', data: { callId: 'pan', name: 'map_use' } },
      { type: 'tool/result', data: {
        message: { toolCallId: 'pan', content: [{ type: 'text', text: JSON.stringify({
          action: 'pan', budget: { actionsUsed: 1, actionsRemaining: null, observationsUsed: 1,
            observationsRemaining: null, elapsedMs, elapsedRemainingMs: null },
        }) }] },
        meta: { kind: 'map-use', record: { expiresAtMs: 2000 } },
      } },
    ])
    const first = redactSessionSnapshotIds([sourceOf(100)])
    expect(redactSessionSnapshotIds([sourceOf(450)])).toEqual(first)
    expect(first[0]).toContain('elapsedMs\\\":0')
    expect(first[0]).toContain('elapsedRemainingMs\\\":null')
    expect(first[0]).toContain('actionsUsed\\\":1')
    expect(redactSessionSnapshotIds(first)).toEqual(first)
    const changed = sourceOf(100).replace('actionsUsed\\\":1', 'actionsUsed\\\":2')
    expect(redactSessionSnapshotIds([changed])).not.toEqual(first)
  })

  it('preserves elapsed budget limits through redaction and full comparison', () => {
    const header = { type: 'session', id: parentId }
    const original = logOf([header, ...observationRows(readAt, 1700, 1000, 120_000)])
    const changed = logOf([header, ...observationRows(readAt, 1700, 1000, 240_000)])
    const originalRedacted = redactSessionSnapshotIds([original])
    const changedRedacted = redactSessionSnapshotIds([changed])
    expect(originalRedacted[0]).toContain('elapsedRemainingMs\\\":120000')
    expect(changedRedacted[0]).toContain('elapsedRemainingMs\\\":240000')
    expect(changedRedacted).not.toEqual(originalRedacted)
    expect(redactSessionSnapshotIds(changedRedacted)).toEqual(changedRedacted)
    const context = { sessionIds: [], cwd: '/unused' }
    expect(normalizeSessionSnapshots([changed], context)).not.toEqual(normalizeSessionSnapshots([original], context))
  })

  it.each([
    { elapsedMs: 60_000, elapsedRemainingMs: 0 },
    { elapsedMs: 60_001, elapsedRemainingMs: 0 },
    { elapsedMs: 0, elapsedRemainingMs: 0 },
    { elapsedMs: 1, elapsedRemainingMs: -1 },
    { elapsedMs: -1, elapsedRemainingMs: 1 },
    { elapsedMs: 1, elapsedRemainingMs: '119999' },
    { elapsedMs: '1', elapsedRemainingMs: 119_999 },
    { elapsedMs: 1 },
    { elapsedRemainingMs: 119_999 },
    { elapsedMs: 1e308, elapsedRemainingMs: 1e308 },
    { elapsedMs: -1, elapsedRemainingMs: null },
    { elapsedMs: '1', elapsedRemainingMs: null },
  ])('preserves exhausted or invalid elapsed budget evidence: %j', (budget) => {
    const source = logOf([
      { type: 'tool/call', data: { callId: 'pan', name: 'map_use' } },
      { type: 'tool/result', data: {
        message: { toolCallId: 'pan', content: [{ type: 'text', text: JSON.stringify({ action: 'pan', budget }) }] },
        meta: { kind: 'map-use' },
      } },
    ])
    expect(redactSessionSnapshotIds([source])).toEqual([source])
  })

  it.each([
    ['"mapRevision":2', '"mapRevision":3'],
    ['"cameraEpoch":3', '"cameraEpoch":4'],
    ['"gestureEpoch":4', '"gestureEpoch":5'],
    ['"controlEpoch":5', '"controlEpoch":6'],
    ['"targetRevision":2', '"targetRevision":3'],
    ['"center":[10,20]', '"center":[11,20]'],
    ['actionsRemaining\\\":19', 'actionsRemaining\\\":18'],
  ])('retains comparison evidence for %s', (before, after) => {
    const original = logOf(observationRows(readAt, 1700, 100))
    const changed = original.replace(before, after)
    expect(changed).not.toBe(original)
    expect(redactSessionSnapshotIds([changed])).not.toEqual(redactSessionSnapshotIds([original]))
  })

  it('preserves lookalike clocks outside paired map receipts', () => {
    const payload = { capturedAt: readAt, expiresAtMs: 1234, budget: { elapsedMs: 12, elapsedRemainingMs: 88 },
      cameraEpoch: 7, gestureEpoch: 8 }
    const source = logOf([
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: JSON.stringify(payload) }] } },
      { type: 'example', data: payload },
      ...resultOf('read_file', JSON.stringify(payload)),
      ...resultOf('map_use', JSON.stringify(payload)),
      { type: 'tool/result', data: {
        message: { toolCallId: 'unpaired', content: [{ type: 'text', text: JSON.stringify(payload) }] },
        meta: { kind: 'map-use', record: payload },
      } },
      { type: 'tool/call', data: { callId: 'error', name: 'map_use' } },
      { type: 'tool/result', data: {
        message: { toolCallId: 'error', content: [{ type: 'text', text: 'Error: elapsedMs is not available' }] },
        meta: { kind: 'map-use', record: { expiresAtMs: -1 } },
      } },
    ])
    expect(redactSessionSnapshotIds([source])).toEqual([source])
  })

  it.each(['tool result', 'streamed arguments'])('propagates non-syntax failures while parsing %s', (target) => {
    const original = JSON.parse
    const inner = '{"parseFailure":true}'
    const source = logOf(target === 'tool result' ? resultOf('catalog_resolve', inner) : [
      { type: 'assistant/message', data: { message: { content: [] },
        stream: [{ type: 'tool-call-chunks', id: 'parse', args: [inner] }] } },
    ])
    const failure = new Error('decoder unavailable')
    const spy = vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => {
      if (text === inner) throw failure
      const decoded: unknown = original(text, reviver)
      return decoded
    })
    try {
      expect(() => redactSessionSnapshotIds([source])).toThrow(failure)
    } finally {
      spy.mockRestore()
    }
    expect(JSON.parse).toBe(original)
  })
})

describe('workflow run identities', () => {
  const logOf = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
  const submission = (runId: string) => [
    { type: 'tool/call', data: { callId: 'submit', name: 'run_submit' } },
    { type: 'tool/result', data: { message: { toolCallId: 'submit', content: [{ type: 'text', text: JSON.stringify({ run_id: runId }) }] } } },
  ]
  const getCall = (settled: string, streamed: string) => ({
    type: 'assistant/message',
    data: {
      message: { role: 'assistant', content: [{ type: 'tool-call', id: 'get', name: 'run_get', arguments: settled }] },
      stream: [{ type: 'tool-call-chunks', id: 'get', args: [streamed] }],
    },
  })

  it('does not alias an unknown streamed run id to a settled canonical token', () => {
    const settled = JSON.stringify({ run_id: '{{workflow:1}}' })
    const streamed = JSON.stringify({ run_id: `run-${otherId}` })
    const source = logOf([getCall(settled, streamed)])
    const [output] = redactSessionSnapshotIds([source])
    expect(output?.match(/\{\{workflow:1\}\}/g)).toHaveLength(1)
    expect(output?.match(/\{\{workflow:2\}\}/g)).toHaveLength(1)
    expect(output).not.toContain(otherId)
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })

  it('retains a streamed run id that differs from an already claimed run', () => {
    const settled = JSON.stringify({ run_id: `run-${runId}` })
    const consistent = logOf([...submission(`run-${runId}`), getCall(settled, settled)])
    const mismatched = logOf([...submission(`run-${runId}`), getCall(settled, JSON.stringify({ run_id: `run-${otherId}` }))])
    const expected = redactSessionSnapshotIds([consistent])
    const actual = redactSessionSnapshotIds([mismatched])
    expect(expected[0]).not.toContain(runId)
    expect(actual).not.toEqual(expected)
    expect(redactSessionSnapshotIds(actual)).toEqual(actual)
  })

  it('replaces a run id that crosses packed piece boundaries without changing their count', () => {
    const runIdValue = `run-${runId}`
    const argumentsText = JSON.stringify({ run_id: runIdValue })
    const source = logOf([
      ...submission(runIdValue),
      {
        type: 'assistant/message',
        data: {
          message: { role: 'assistant', content: [{ type: 'tool-call', id: 'get', name: 'run_get', arguments: argumentsText }] },
          stream: [{ type: 'tool-call-chunks', id: 'get', dt: [4, 6],
            args: [argumentsText.slice(0, 20), argumentsText.slice(20, 30), argumentsText.slice(30)] }],
        },
      },
    ])
    const [output] = redactSessionSnapshotIds([source])
    expect(output).not.toContain(runId)
    const rows = output!.trim().split('\n').map(line => JSON.parse(line) as SessionEvent)
    const record = rows[2]
    if (record?.type !== 'assistant/message') throw new Error('missing streamed assistant message')
    const stream = record.data.stream[0]
    if (stream?.type !== 'tool-call-chunks') throw new Error('missing packed tool arguments')
    expect(stream.args).toHaveLength(3)
    expect(stream.dt).toEqual([4, 6])
    expect(JSON.parse(stream.args.join(''))).toEqual({ run_id: '{{workflow:1}}' })
    expect(redactSessionSnapshotIds([output!])).toEqual([output])
  })
})
