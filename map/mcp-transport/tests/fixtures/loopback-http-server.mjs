/**
 * Keyless loopback streamable-HTTP MCP server fixture. Started as a real
 * `node:http` listener on 127.0.0.1 (ephemeral port, reported on stdout as
 * `READY <port>`) by `tests/http.spec.mjs` and `tests/live.spec.mjs`;
 * behavior is steered by argv flags so one binary covers every http lane:
 *
 * SDK lanes (a real `McpServer` over `WebStandardStreamableHTTPServerTransport`):
 * - default: one `echo` tool; stateless mode with JSON responses
 * - `--tools`: also registers `add` and `hang` (never settles; the
 *   cancellation lane)
 * - `--token <value>`: requires `Authorization: Bearer <value>` and answers
 *   401 otherwise (the auth-rejected lane)
 *
 * Raw lanes (deliberately non-SDK responders):
 * - `--bad-initialize`: answers POST with a structurally invalid initialize
 *   result (the protocol-violated lane)
 */
import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/server'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server'
import { z } from 'zod'

const flags = process.argv.slice(2)
const tokenIndex = flags.indexOf('--token')
const requiredToken = tokenIndex !== -1 ? flags[tokenIndex + 1] : undefined

const httpServer = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) {
    chunks.push(chunk)
  }
  const body = Buffer.concat(chunks).toString('utf8')
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(serverPort ?? 0)}`)
  const webRequest = new Request(url, {
    method: request.method,
    headers: Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(',') : (value ?? '')])),
    ...(body === '' ? {} : { body }),
  })
  if (requiredToken !== undefined && webRequest.headers.get('authorization') !== `Bearer ${requiredToken}`) {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'missing or invalid bearer token' }, id: null }))
    return
  }
  if (flags.includes('--bad-initialize')) {
    let requestId = 1
    try {
      const parsed = JSON.parse(body)
      if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) requestId = parsed.id
    } catch { /* keep the fallback id */ }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { protocolVersion: 42, capabilities: {}, serverInfo: {} } }))
    return
  }
  const webResponse = await transport.handleRequest(webRequest)
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers.entries()))
  const bytes = new Uint8Array(await webResponse.arrayBuffer())
  response.end(bytes)
})

let serverPort
const server = new McpServer({ name: 'loopback-http', version: '2.3.4' })
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
  ...(requiredToken === undefined ? {} : { enableJsonResponse: true }),
})

server.registerTool('echo', {
  description: 'returns its argument as text',
  inputSchema: { value: z.string() },
}, async ({ value }) => ({
  content: [{ type: 'text', text: value }],
}))

if (flags.includes('--tools')) {
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
}

await server.connect(transport)
httpServer.listen(0, '127.0.0.1', () => {
  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    process.exit(1)
  }
  serverPort = address.port
  process.stdout.write(`READY ${String(serverPort)}\n`)
})

process.on('SIGTERM', () => {
  httpServer.close()
  process.exit(0)
})
