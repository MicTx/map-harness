/**
 * Keyless loopback completions relay fixture. A real `node:http` listener on
 * 127.0.0.1 (ephemeral port, reported on stdout as `READY <port>`) playing
 * an OpenAI-compatible streaming chat endpoint; behavior is steered by argv
 * flags so one binary covers every completions lane:
 *
 * - default: answer `text/event-stream` and stream `--events <n>` NDJSON
 *   relay event lines, each split across `--split <n>` token-delta chunks,
 *   then `data: [DONE]` and end
 * - `--token <value>`: answer 401 with a JSON error unless the bearer matches
 * - `--no-done`: end after the events without `[DONE]` (the clean stream-end lane)
 * - `--bad-json-chunk`: one SSE data payload that is not JSON (stream-violated lane)
 * - `--error-chunk`: one chunk carrying an `error` object (stream-violated lane)
 * - `--reject-lines`: one relay line that is not JSON, then a valid line
 * - `--status <n>` / `--content-type <value>` / `--stall-open`: the shared refusal lanes
 * - `--report <path>`: write a sanitized summary of the received request there,
 *   so tests can assert what the relay actually sent
 */
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const flags = process.argv.slice(2)
const flagValue = (name) => {
  const index = flags.indexOf(name)
  return index !== -1 ? flags[index + 1] : undefined
}
const eventCount = Number.parseInt(flagValue('--events') ?? '3', 10)
const splitCount = Number.parseInt(flagValue('--split') ?? '3', 10)
const requiredToken = flagValue('--token')
const reportPath = flagValue('--report')

const server = createServer((request, response) => {
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    if (requiredToken !== undefined && request.headers.authorization !== `Bearer ${requiredToken}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Authentication Fails (no valid credential)' } }))
      return
    }
    const status = flagValue('--status')
    if (status !== undefined) {
      response.writeHead(Number.parseInt(status, 10), { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: `declined with ${status}` } }))
      return
    }
    if (reportPath !== undefined) {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = { parse: 'failed' }
      }
      const messages = Array.isArray(body.messages) ? body.messages : []
      writeFileSync(reportPath, JSON.stringify({
        model: body.model,
        stream: body.stream,
        maxTokens: body.max_tokens,
        messageCount: messages.length,
        systemRole: messages.some(message => typeof message === 'object' && message !== null && message.role === 'system'),
        systemHead: typeof messages[0] === 'object' && messages[0] !== null ? String(messages[0].content).slice(0, 600) : '',
      }))
    }
    if (flags.includes('--stall-open')) {
      // Deliberately never answer: the client's open deadline must expire.
      return
    }
    response.writeHead(200, { 'content-type': flagValue('--content-type') ?? 'text/event-stream' })
    const sendChunk = (delta) => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta }, index: 0 }] })}\n\n`)
    }
    if (flags.includes('--bad-json-chunk')) {
      response.write('data: {not json at all\n\n')
      response.end()
      return
    }
    if (flags.includes('--error-chunk')) {
      response.write(`data: ${JSON.stringify({ error: { message: 'relay refused: quota exhausted' } })}\n\n`)
      response.end()
      return
    }
    for (let index = 0; index < eventCount; index += 1) {
      const line = `${JSON.stringify({ eventId: `relay-${String(index)}`, eventTimeMs: 2000 + index * 1000, lon: -0.12 + index * 0.01, lat: 51.5, value: index + 1 })}\n`
      if (flags.includes('--reject-lines') && index === 0) {
        sendChunk('this line is not JSON\n')
        continue
      }
      const pieceSize = Math.ceil(line.length / splitCount)
      for (let start = 0; start < line.length; start += pieceSize) {
        sendChunk(line.slice(start, start + pieceSize))
      }
    }
    if (flags.includes('--reject-lines')) {
      sendChunk(JSON.stringify({ eventId: 'valid-after-bad', eventTimeMs: 9000, lon: 0, lat: 0, value: 1 }))
      sendChunk('\n')
    }
    if (!flags.includes('--no-done')) {
      response.write('data: [DONE]\n\n')
    }
    response.end()
  })
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  process.stdout.write(`READY ${String(port)}\n`)
})
