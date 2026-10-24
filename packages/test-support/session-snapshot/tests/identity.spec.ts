import { describe, expect, it, vi } from 'vitest'
import { redactSessionSnapshotIds } from '../src/identity.ts'

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

  it('propagates non-syntax failures while parsing a tool result', () => {
    const original = JSON.parse
    const inner = '{"parseFailure":true}'
    const source = logOf(resultOf('catalog_resolve', inner))
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
