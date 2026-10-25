/**
 * Keyless loopback stdio MCP server fixture. Spawned as a real child process
 * by `tests/stdio.spec.mjs`; behavior is steered by argv flags so one binary
 * covers every stdio lane:
 *
 * SDK lanes (a real `McpServer` over `StdioServerTransport`):
 * - default: one `echo` tool (returns its argument as text)
 * - `--tools`: also registers `add`, `hang` (never settles; the
 *   cancellation lane), and `crash` (exits the child; the transport-closed
 *   lane)
 * - `--env-report`: registers `env_report`, answering with the child's
 *   environment subset (the envRefs propagation lane)
 *
 * Raw JSON-RPC line lanes (deliberately non-SDK responders):
 * - `--bad-initialize`: answers `initialize` with a structurally invalid
 *   result (the protocol-violated lane)
 * - `--reject-protocol-version`: answers `initialize` with an unsupported
 *   `protocolVersion` (the protocol-version-unsupported lane)
 * - `--refuse-tool-list`: completes `initialize` but answers every later
 *   request, including `tools/list`, with a JSON-RPC error (the
 *   tool-list-refused lane)
 * - `--garbage`: writes non-JSON bytes to stdout forever (the timeout lane)
 */
import { McpServer } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const flags = new Set(process.argv.slice(2))

if (flags.has('--garbage')) {
  const timer = setInterval(() => {
    process.stdout.write('not json-rpc at all\n')
  }, 50)
  process.on('exit', () => clearInterval(timer))
} else if (flags.has('--bad-initialize') || flags.has('--reject-protocol-version') || flags.has('--refuse-tool-list')) {
  const protocolVersion = flags.has('--reject-protocol-version') ? '1999-01-01' : '2025-11-25'
  process.stdin.setEncoding('utf8')
  let buffer = ''
  process.stdin.on('data', chunk => {
    buffer += chunk
    let newline
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim() === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof message !== 'object' || message === null || !('method' in message)) continue
      const request = message
      if (request.method === 'initialize' && request.id !== undefined) {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: flags.has('--bad-initialize')
            ? { protocolVersion: 42, capabilities: {}, serverInfo: {} }
            : { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'raw-loopback', version: '0.0.1' } },
        })}\n`)
      } else if (request.method !== 'notifications/initialized' && request.id !== undefined) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `${request.method} is administratively refused` } })}\n`)
      }
    }
  })
} else {
  const server = new McpServer({ name: 'loopback-stdio', version: '1.2.3' })

  if (flags.has('--env-report')) {
    server.registerTool('env_report', {
      description: 'reports the resolved child environment subset',
      inputSchema: { prefix: z.string() },
    }, async ({ prefix }) => ({
      content: [{ type: 'text', text: JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith(prefix)))) }],
    }))
  } else {
    server.registerTool('echo', {
      description: 'returns its argument as text',
      inputSchema: { value: z.string() },
    }, async ({ value }) => ({
      content: [{ type: 'text', text: value }],
    }))
  }

  if (flags.has('--tools')) {
    server.registerTool('add', {
      description: 'adds two integers',
      inputSchema: { a: z.number().int(), b: z.number().int() },
    }, async ({ a, b }) => ({
      content: [{ type: 'text', text: String(a + b) }],
    }))
    server.registerTool('hang', {
      description: 'never settles; the cancellation lane',
      inputSchema: {},
    }, async () => await new Promise(() => {}))
    server.registerTool('crash', {
      description: 'exits the child process',
      inputSchema: {},
    }, async () => {
      process.exit(86)
    })
  }

  await server.connect(new StdioServerTransport())
}
