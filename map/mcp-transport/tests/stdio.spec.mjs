/**
 * Keyless stdio contract lanes: every exchange the client face promises over
 * a real cross-process stdio child, proven against the loopback fixture in
 * `tests/fixtures/loopback-stdio-server.mjs`. The connected lane proves the
 * full protocol path (initialize handshake, server identity, tools/list,
 * tools/call); the remaining lanes pin each closed outcome to its real
 * trigger, plus deadline discipline, caller cancellation, quiescent close
 * with child-exit confirmation, and the envRefs propagation contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openRemoteMcp, verifyRemoteMcp, McpExchangeError } from '../src/client.ts'

const FIXTURE = new URL('./fixtures/loopback-stdio-server.mjs', import.meta.url).pathname

function stdioSpec(flags, extra = {}) {
  return {
    id: 'fixture',
    kind: 'stdio',
    command: process.execPath,
    args: [FIXTURE, ...flags],
    ...extra,
  }
}

async function outcomeOf(action) {
  try {
    await action()
  } catch (error) {
    assert.ok(error instanceof McpExchangeError, `expected McpExchangeError, got ${String(error)}`)
    return error.outcome
  }
  assert.fail('expected the exchange to fail')
}

test('stdio connected lane: handshake, identity, discovery, and dispatch', async () => {
  const connection = await openRemoteMcp(stdioSpec([]), {})
  try {
    assert.equal(connection.serverName(), 'loopback-stdio')
    assert.equal(connection.serverVersion(), '1.2.3')
    assert.ok(connection.protocolVersion() !== undefined)
    assert.ok(connection.childPid() !== null)
    const tools = await connection.discoverTools()
    assert.deepEqual(tools.map(tool => tool.name), ['echo'])
    assert.equal(tools[0].description, 'returns its argument as text')
    const result = await connection.callTool('echo', { value: 'hello stdio' })
    assert.equal(result.isError, undefined)
    assert.deepEqual(result.content, [{ type: 'text', text: 'hello stdio' }])
  } finally {
    await connection.close()
  }
})

test('stdio close confirms the child exited and later exchanges report transport-closed', async () => {
  const connection = await openRemoteMcp(stdioSpec([]), {})
  const pid = connection.childPid()
  assert.ok(pid !== null)
  await connection.close()
  await connection.close()
  assert.throws(() => process.kill(pid, 0), undefined, 'child must be gone after close')
  assert.equal(await outcomeOf(() => connection.callTool('echo', { value: 'x' })), 'transport-closed')
})

test('stdio verification reports the connected outcome with handshake facts', async () => {
  const report = await verifyRemoteMcp(stdioSpec(['--tools'], { id: 'verify-target' }), {})
  assert.equal(report.id, 'verify-target')
  assert.equal(report.kind, 'stdio')
  assert.equal(report.outcome, 'connected')
  assert.equal(report.serverName, 'loopback-stdio')
  assert.equal(report.serverVersion, '1.2.3')
  assert.ok(report.protocolVersion !== undefined)
  assert.equal(report.toolCount, 4)
  assert.ok(report.durationMs >= 0)
  assert.ok(!report.detail.includes(FIXTURE))
})

test('stdio envRefs propagate resolved values into the child environment', async () => {
  const spec = stdioSpec(['--env-report'], {
    id: 'env-lane',
    envRefs: { MCP_TEST_SECRET: 'MCP_TEST_SECRET_SOURCE' },
  })
  const connection = await openRemoteMcp(spec, { env: { MCP_TEST_SECRET: 'resolved-value-4711' } })
  try {
    const result = await connection.callTool('env_report', { prefix: 'MCP_TEST_' })
    const reported = JSON.parse(result.content[0].text)
    assert.equal(reported.MCP_TEST_SECRET, 'resolved-value-4711')
  } finally {
    await connection.close()
  }
})

test('stdio unreachable lane: a missing command reports unreachable', async () => {
  const outcome = await outcomeOf(() => openRemoteMcp({ id: 'gone', kind: 'stdio', command: 'definitely-not-a-real-command-xq' }, {}))
  assert.equal(outcome, 'unreachable')
})

test('stdio timeout lane: a garbage child exceeds the deadline and reports timeout', async () => {
  const outcome = await outcomeOf(() => openRemoteMcp(stdioSpec(['--garbage'], { timeoutMs: 1000 }), {}))
  assert.equal(outcome, 'timeout')
})

test('stdio protocol-violated lane: an invalid initialize result is rejected', async () => {
  const outcome = await outcomeOf(() => openRemoteMcp(stdioSpec(['--bad-initialize']), {}))
  assert.equal(outcome, 'protocol-violated')
})

test('stdio protocol-version-unsupported lane: an old protocolVersion is refused', async () => {
  const outcome = await outcomeOf(() => openRemoteMcp(stdioSpec(['--reject-protocol-version']), {}))
  assert.equal(outcome, 'protocol-version-unsupported')
})

test('stdio tool-list-refused lane: a JSON-RPC error on tools/list is refused', async () => {
  const connection = await openRemoteMcp(stdioSpec(['--refuse-tool-list']), {})
  try {
    assert.equal(connection.serverName(), 'raw-loopback')
    const outcome = await outcomeOf(() => connection.discoverTools())
    assert.equal(outcome, 'tool-list-refused')
  } finally {
    await connection.close()
  }
})

test('stdio transport-closed lane: a child exiting mid-call reports transport-closed', async () => {
  const connection = await openRemoteMcp(stdioSpec(['--tools']), {})
  const pid = connection.childPid()
  assert.ok(pid !== null)
  try {
    const outcome = await outcomeOf(() => connection.callTool('crash', {}))
    assert.equal(outcome, 'transport-closed')
  } finally {
    await connection.close()
  }
  assert.throws(() => process.kill(pid, 0), undefined, 'crashed child must be reaped')
})

test('stdio aborted lane: cancelling a hanging call reports aborted, then closes cleanly', async () => {
  const connection = await openRemoteMcp(stdioSpec(['--tools']), {})
  const controller = new AbortController()
  const hang = connection.callTool('hang', {}, { signal: controller.signal })
  const scheduled = hang.catch(error => error)
  await new Promise(resolve => setTimeout(resolve, 150))
  controller.abort()
  const error = await scheduled
  assert.ok(error instanceof McpExchangeError)
  assert.equal(error.outcome, 'aborted')
  const outcome = await outcomeOf(() => connection.callTool('hang', {}, { signal: AbortSignal.abort() }))
  assert.equal(outcome, 'aborted')
  await connection.close()
  const pid = connection.childPid()
  assert.ok(pid !== null)
  assert.throws(() => process.kill(pid, 0), undefined, 'hung child must not survive close')
})

test('stdio server-error content resolves as a result, not an exchange failure', async () => {
  const connection = await openRemoteMcp(stdioSpec([]), {})
  try {
    const result = await connection.callTool('echo', { value: 42 })
    assert.equal(result.isError, true)
  } finally {
    await connection.close()
  }
})
