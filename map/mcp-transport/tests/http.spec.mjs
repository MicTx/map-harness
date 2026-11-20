/**
 * Keyless streamable-HTTP contract lanes: every exchange the client face
 * promises over a real remote HTTP endpoint, proven against the loopback
 * listener fixture in `tests/fixtures/loopback-http-server.mjs` (real
 * `node:http` server, ephemeral 127.0.0.1 port) plus two inline lanes — a
 * TCP listener that never answers (the timeout lane) and a released port
 * (the unreachable lane).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, createServer as createTcpServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { openRemoteMcp, verifyRemoteMcp, McpExchangeError } from '../src/client.ts'

const FIXTURE = new URL('./fixtures/loopback-http-server.mjs', import.meta.url).pathname

/** Start the loopback HTTP fixture and resolve once it reports its port. */
async function startHttpFixture(flags = []) {
  const child = spawn(process.execPath, [FIXTURE, ...flags], { stdio: ['ignore', 'pipe', 'inherit'] })
  let port
  const ready = new Promise((resolve, reject) => {
    let buffer = ''
    const onData = chunk => {
      buffer += chunk.toString('utf8')
      const match = /^READY (\d+)$/m.exec(buffer)
      if (match !== null) {
        child.stdout.off('data', onData)
        port = Number(match[1])
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.once('exit', code => reject(new Error(`fixture exited before READY (code ${String(code)})`)))
  })
  await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('fixture did not report READY within 5s')), 5000))])
  return {
    port,
    url: `http://127.0.0.1:${String(port)}/mcp`,
    async close() {
      child.kill('SIGTERM')
      await once(child, 'exit').catch(() => {})
    },
  }
}

/** Occupy an ephemeral port, then release it, to guarantee a refused port. */
async function releasedPort() {
  const server = createTcpServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  server.close()
  await once(server, 'close')
  return port
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

test('http connected lane: handshake, identity, discovery, and dispatch', async () => {
  const fixture = await startHttpFixture()
  try {
    const connection = await openRemoteMcp({ id: 'remote', kind: 'http', url: fixture.url }, {})
    assert.equal(connection.serverName(), 'loopback-http')
    assert.equal(connection.serverVersion(), '2.3.4')
    assert.ok(connection.protocolVersion() !== undefined)
    assert.equal(connection.childPid(), null)
    const tools = await connection.discoverTools()
    assert.deepEqual(tools.map(tool => tool.name), ['echo'])
    const result = await connection.callTool('echo', { value: 'hello http' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'hello http' }])
    await connection.close()
  } finally {
    await fixture.close()
  }
})

test('http auth-rejected lane: a wrong bearer token reports auth-rejected, the right one connects', async () => {
  const fixture = await startHttpFixture(['--token', 'fixture-secret-value'])
  try {
    const wrong = await verifyRemoteMcp({ id: 'auth-lane', kind: 'http', url: fixture.url }, { token: 'not-the-token' })
    assert.equal(wrong.outcome, 'auth-rejected')
    assert.ok(!wrong.detail.includes('fixture-secret-value'), 'detail must not echo the token value')
    const right = await verifyRemoteMcp({ id: 'auth-lane', kind: 'http', url: fixture.url }, { token: 'fixture-secret-value' })
    assert.equal(right.outcome, 'connected')
    assert.equal(right.toolCount, 1)
  } finally {
    await fixture.close()
  }
})

test('http unreachable lane: a refused port reports unreachable', async () => {
  const port = await releasedPort()
  const outcome = await outcomeOf(() => openRemoteMcp({ id: 'gone', kind: 'http', url: `http://127.0.0.1:${String(port)}/mcp` }, {}))
  assert.equal(outcome, 'unreachable')
})

test('http protocol-violated lane: an invalid initialize result is rejected', async () => {
  const fixture = await startHttpFixture(['--bad-initialize'])
  try {
    const outcome = await outcomeOf(() => openRemoteMcp({ id: 'bad', kind: 'http', url: fixture.url }, {}))
    assert.equal(outcome, 'protocol-violated')
  } finally {
    await fixture.close()
  }
})

test('http timeout lane: a silent TCP listener exceeds the deadline and reports timeout', async () => {
  const listener = createServer(socket => {
    socket.on('data', () => { /* accept and never answer */ })
  })
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const { port } = listener.address()
  try {
    const outcome = await outcomeOf(() => openRemoteMcp({ id: 'silent', kind: 'http', url: `http://127.0.0.1:${String(port)}/mcp`, timeoutMs: 1000 }, {}))
    assert.equal(outcome, 'timeout')
  } finally {
    listener.close()
    await once(listener, 'close')
  }
})

test('http aborted lane: cancelling a hanging call reports aborted, then closes cleanly', async () => {
  const fixture = await startHttpFixture(['--tools'])
  try {
    const connection = await openRemoteMcp({ id: 'hang-lane', kind: 'http', url: fixture.url }, {})
    const controller = new AbortController()
    const hang = connection.callTool('hang', {}, { signal: controller.signal })
    const scheduled = hang.catch(error => error)
    await new Promise(resolve => setTimeout(resolve, 150))
    controller.abort()
    const error = await scheduled
    assert.ok(error instanceof McpExchangeError)
    assert.equal(error.outcome, 'aborted')
    await connection.close()
  } finally {
    await fixture.close()
  }
})
