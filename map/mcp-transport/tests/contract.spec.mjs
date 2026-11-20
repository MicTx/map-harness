/**
 * Contract gates: the closed outcome vocabulary and the validation functions
 * both connection kinds and the deployment Config share — id shapes, command
 * and argv bounds, env-reference shape, URL shape, timeout bounds, and the
 * detail bound that keeps diagnostics short.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TIMEOUT_MS,
  MAX_ARGS,
  MAX_CONNECTIONS,
  MAX_ENV_REFS,
  MAX_TIMEOUT_MS,
  MCP_EXCHANGE_OUTCOMES,
  MCP_TRANSPORT_VERSION,
  MIN_TIMEOUT_MS,
  boundDetail,
  connectionIdProblem,
  httpSpecProblem,
  stdioSpecProblem,
} from '../src/contract.ts'

const VALID_STDIO = { id: 'local-tools', kind: 'stdio', command: 'node', args: ['server.mjs'], envRefs: { MCP_EXTRA: 'MCP_EXTRA_VALUE' } }
const VALID_HTTP = { id: 'remote-tools', kind: 'http', url: 'https://mcp.example.org/mcp' }

test('the contract is versioned and the outcome vocabulary is closed', () => {
  assert.equal(MCP_TRANSPORT_VERSION, 'mcp-transport@1')
  assert.deepEqual(MCP_EXCHANGE_OUTCOMES, [
    'connected', 'unreachable', 'auth-rejected', 'handshake-failed',
    'protocol-version-unsupported', 'tool-list-refused', 'server-error',
    'protocol-violated', 'timeout', 'aborted', 'transport-closed',
  ])
})

test('connection ids must be kebab-case and short', () => {
  assert.equal(connectionIdProblem('local-tools'), undefined)
  assert.equal(connectionIdProblem('a'), undefined)
  assert.equal(connectionIdProblem('a'.repeat(64)), undefined)
  assert.ok(connectionIdProblem('') !== undefined)
  assert.ok(connectionIdProblem('UpperCase') !== undefined)
  assert.ok(connectionIdProblem('1starts-with-digit') !== undefined)
  assert.ok(connectionIdProblem('has_underscore') !== undefined)
  assert.ok(connectionIdProblem('has space') !== undefined)
  assert.ok(connectionIdProblem('a'.repeat(65)) !== undefined)
})

test('stdio specs validate command, args, envRefs, cwd, and timeout bounds', () => {
  assert.equal(stdioSpecProblem(VALID_STDIO), undefined)
  assert.equal(stdioSpecProblem({ ...VALID_STDIO, args: undefined, envRefs: undefined, timeoutMs: undefined }), undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, command: '' }) !== undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, command: 'x'.repeat(513) }) !== undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, command: 'node\n--eval' }) !== undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, args: Array.from({ length: MAX_ARGS + 1 }, (_, i) => `--flag-${String(i)}`) }) !== undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, args: ['x'.repeat(513)] }) !== undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, envRefs: Object.fromEntries(Array.from({ length: MAX_ENV_REFS + 1 }, (_, i) => [`REF_${String(i)}`, `SRC_${String(i)}`])) }) !== undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, envRefs: { 'has space': 'OK_NAME' } }) !== undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, envRefs: { CHILD_NAME: 'not a name!' } }) !== undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, cwd: 'relative/path' }) !== undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, timeoutMs: MIN_TIMEOUT_MS - 1 }) !== undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, timeoutMs: MAX_TIMEOUT_MS + 1 }) !== undefined)
  assert.ok(stdioSpecProblem({ ...VALID_STDIO, timeoutMs: 1500.5 }) !== undefined)
  assert.equal(stdioSpecProblem({ ...VALID_STDIO, cwd: '/srv/mcp', timeoutMs: MIN_TIMEOUT_MS }), undefined)
})

test('http specs validate URL scheme, host, userinfo, fragment, and tokenEnv', () => {
  assert.equal(httpSpecProblem(VALID_HTTP), undefined)
  assert.equal(httpSpecProblem({ id: 'x', kind: 'http', url: 'http://127.0.0.1:8787/mcp?q=1', tokenEnv: 'MCP_TOKEN' }), undefined)
  assert.ok(httpSpecProblem({ ...VALID_HTTP, url: 'ftp://mcp.example.org' }) !== undefined)
  assert.ok(httpSpecProblem({ ...VALID_HTTP, url: 'mcp.example.org/mcp' }) !== undefined)
  assert.ok(httpSpecProblem({ ...VALID_HTTP, url: 'https://user:pass@mcp.example.org/mcp' }) !== undefined)
  assert.ok(httpSpecProblem({ ...VALID_HTTP, url: 'https://mcp.example.org/mcp#frag' }) !== undefined)
  assert.ok(httpSpecProblem({ ...VALID_HTTP, url: 'https://mcp.example.org/mcp?q=1', tokenEnv: 'MCP_TOKEN' }) === undefined)
  assert.ok(httpSpecProblem({ ...VALID_HTTP, tokenEnv: 'not a name' }) !== undefined)
  assert.ok(httpSpecProblem({ ...VALID_HTTP, timeoutMs: 999 }) !== undefined)
})

test('the default deadline sits inside the bounds and the connection count is bounded', () => {
  assert.ok(MIN_TIMEOUT_MS <= DEFAULT_TIMEOUT_MS && DEFAULT_TIMEOUT_MS <= MAX_TIMEOUT_MS)
  assert.ok(MAX_ARGS > 0 && MAX_ENV_REFS > 0 && MAX_CONNECTIONS > 0)
})

test('detail lines are bounded', () => {
  assert.equal(boundDetail('short'), 'short')
  const long = 'x'.repeat(600)
  const bounded = boundDetail(long)
  assert.equal(bounded.length, 512)
  assert.ok(bounded.endsWith('…'))
})
