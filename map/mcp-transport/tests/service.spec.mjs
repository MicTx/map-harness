/**
 * Keyless service lanes: the deployment Config resolution (validation,
 * credential references, caps, id uniqueness) and the `mcpTransport`
 * service face (summaries, verification, cached opens, transient dispatch,
 * close semantics) over the real stdio fixture.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveMcpConnections, buildMcpTransportService } from '../src/plugin.ts'
import { McpTransportError } from '../src/errors.ts'

const FIXTURE = new URL('./fixtures/loopback-stdio-server.mjs', import.meta.url).pathname

function validConfig() {
  return {
    stdio: [
      { id: 'fixture-echo', command: process.execPath, args: [FIXTURE] },
      { id: 'fixture-tools', command: process.execPath, args: [FIXTURE, '--tools'] },
    ],
    http: [
      { id: 'public-remote', url: 'https://mcp.example.org/mcp' },
      { id: 'private-remote', url: 'https://secure.example.org/mcp', tokenEnv: 'MCP_TEST_TOKEN' },
    ],
  }
}

function envWithRefs() {
  return {
    ...process.env,
    MCP_TEST_TOKEN: 'token-value-for-tests',
    MCP_TEST_EXTRA: 'extra-value-for-tests',
  }
}

test('resolveMcpConnections builds the registry from both kinds and resolves credential references', () => {
  const registry = resolveMcpConnections(validConfig(), envWithRefs())
  assert.deepEqual([...registry.keys()], ['fixture-echo', 'fixture-tools', 'public-remote', 'private-remote'])
  const privateRemote = registry.get('private-remote')
  assert.equal(privateRemote.credentials.token, 'token-value-for-tests')
  const publicRemote = registry.get('public-remote')
  assert.deepEqual(publicRemote.credentials, {})
})

test('resolveMcpConnections resolves stdio envRefs into child-environment values', () => {
  const config = { stdio: [{ id: 'env-child', command: process.execPath, args: [FIXTURE], envRefs: { MCP_CHILD: 'MCP_TEST_EXTRA' } }] }
  const registry = resolveMcpConnections(config, envWithRefs())
  assert.deepEqual(registry.get('env-child').credentials, { env: { MCP_CHILD: 'extra-value-for-tests' } })
})

test('resolveMcpConnections fails loud on a missing credential reference', () => {
  const missingToken = { http: [{ id: 'private-remote', url: 'https://secure.example.org/mcp', tokenEnv: 'MCP_ABSENT_TOKEN' }] }
  assert.throws(() => resolveMcpConnections(missingToken, envWithRefs()), error =>
    error instanceof McpTransportError && error.code === 'MCP_TRANSPORT_CREDENTIAL_MISSING' && error.message.includes('MCP_ABSENT_TOKEN'))

  const missingRef = { stdio: [{ id: 'env-child', command: 'node', envRefs: { MCP_CHILD: 'MCP_ABSENT_REF' } }] }
  assert.throws(() => resolveMcpConnections(missingRef, envWithRefs()), error =>
    error instanceof McpTransportError && error.code === 'MCP_TRANSPORT_CREDENTIAL_MISSING' && error.message.includes('MCP_ABSENT_REF'))
})

test('resolveMcpConnections fails loud on invalid specs, duplicate ids, and over-cap declarations', () => {
  const badUrl = { http: [{ id: 'x', url: 'ftp://nope' }] }
  assert.throws(() => resolveMcpConnections(badUrl, envWithRefs()), error =>
    error instanceof McpTransportError && error.code === 'MCP_TRANSPORT_CONFIG_INVALID' && error.message.includes('url'))

  const badId = { stdio: [{ id: 'Not Kebab', command: 'node' }] }
  assert.throws(() => resolveMcpConnections(badId, envWithRefs()), error =>
    error instanceof McpTransportError && error.code === 'MCP_TRANSPORT_CONFIG_INVALID' && error.message.includes('id'))

  const duplicate = { http: [{ id: 'same', url: 'https://a.example.org' }, { id: 'same', url: 'https://b.example.org' }] }
  assert.throws(() => resolveMcpConnections(duplicate, envWithRefs()), error =>
    error instanceof McpTransportError && error.code === 'MCP_TRANSPORT_CONFIG_INVALID' && error.message.includes('more than once'))

  const over = { http: Array.from({ length: 17 }, (_, i) => ({ id: `conn-${String(i)}`, url: `https://m${String(i)}.example.org` })) }
  assert.throws(() => resolveMcpConnections(over, envWithRefs()), error =>
    error instanceof McpTransportError && error.code === 'MCP_TRANSPORT_CONFIG_INVALID' && error.message.includes('at most 16'))
})

test('the service names the declared connections with sanitized endpoint identities', () => {
  const registry = resolveMcpConnections(validConfig(), envWithRefs())
  const { service } = buildMcpTransportService(registry)
  const summaries = service.listConnections()
  assert.equal(summaries.length, 4)
  assert.deepEqual(summaries.map(summary => summary.id), ['fixture-echo', 'fixture-tools', 'public-remote', 'private-remote'])
  const stdio = summaries.find(summary => summary.id === 'fixture-echo')
  assert.ok(stdio.endpoint.includes(process.execPath))
  const tokenized = summaries.find(summary => summary.id === 'private-remote')
  assert.ok(tokenized.endpoint.includes('tokenEnv MCP_TEST_TOKEN'))
  assert.ok(!tokenized.endpoint.includes('token-value-for-tests'), 'summaries never carry credential values')
  assert.equal(service.specs.length, 4)
})

test('verifyConnection reports the connected outcome over a real child; unknown ids throw', async () => {
  const registry = resolveMcpConnections({ stdio: [{ id: 'fixture-echo', command: process.execPath, args: [FIXTURE] }] }, envWithRefs())
  const { service } = buildMcpTransportService(registry)
  const report = await service.verifyConnection('fixture-echo')
  assert.equal(report.outcome, 'connected')
  assert.equal(report.serverName, 'loopback-stdio')
  assert.equal(report.toolCount, 1)
  assert.equal(report.kind, 'stdio')

  await assert.rejects(() => service.verifyConnection('no-such-id'), error =>
    error instanceof McpTransportError && error.code === 'MCP_TRANSPORT_UNKNOWN_CONNECTION')
})

test('openConnection caches per id; callTool runs transient; closeConnection and closeAll settle', async () => {
  const registry = resolveMcpConnections({ stdio: [{ id: 'fixture-echo', command: process.execPath, args: [FIXTURE] }] }, envWithRefs())
  const { service, closeAll } = buildMcpTransportService(registry)

  const first = await service.openConnection('fixture-echo')
  const second = await service.openConnection('fixture-echo')
  assert.equal(first, second, 'openConnection must return the cached handle')
  const viaCache = await service.callTool('fixture-echo', 'echo', { value: 'cached' })
  assert.deepEqual(viaCache.content, [{ type: 'text', text: 'cached' }])

  assert.equal(await service.closeConnection('fixture-echo'), true)
  assert.equal(await service.closeConnection('fixture-echo'), false, 'a second close reports nothing was open')

  const transient = await service.callTool('fixture-echo', 'echo', { value: 'transient' })
  assert.deepEqual(transient.content, [{ type: 'text', text: 'transient' }])

  const cached = await service.openConnection('fixture-echo')
  await closeAll()
  assert.equal(await service.closeConnection('fixture-echo'), false, 'closeAll must close cached connections')
  const outcome = await cached.callTool('echo', { value: 'x' }).then(() => 'resolved', error => error.outcome)
  assert.equal(outcome, 'transport-closed')
})
