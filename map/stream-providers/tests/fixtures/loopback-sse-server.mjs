/**
 * Keyless loopback SSE source fixture. A real `node:http` listener on
 * 127.0.0.1 (ephemeral port, reported on stdout as `READY <port>`) serving
 * `text/event-stream`; behavior is steered by argv flags so one binary
 * covers every sse lane:
 *
 * - default: emit `--events <n>` valid wire events as one SSE frame each
 *   (arrays of events with `--array`), then keep the stream open and quiet
 * - `--interval <ms>`: emit one event every interval instead of a burst
 * - `--end`: end the response after the events (the clean `source-closed` lane)
 * - `--stall-open`: accept the socket but never answer (the open-timeout lane)
 * - `--reject-mix`: first payload is valid JSON with a bad event shape, then valid events
 * - `--big-line`: one data line over the default 64 KiB cap (the stream-violated lane)
 * - `--bad-utf8`: one data line carrying invalid UTF-8 bytes
 * - `--token <value>`: answer 401 unless `Authorization: Bearer <value>` is present
 * - `--status <n>`: answer a bare HTTP error status
 * - `--content-type <value>`: answer 200 with the wrong content type
 */
import { createServer } from 'node:http'

const flags = process.argv.slice(2)
const flagValue = (name) => {
  const index = flags.indexOf(name)
  return index !== -1 ? flags[index + 1] : undefined
}
const eventCount = Number.parseInt(flagValue("--events") ?? "4", 10)
const intervalMs = Number.parseInt(flagValue("--interval") ?? "0", 10)
const requiredToken = flagValue('--token')

const server = createServer((request, response) => {
  if (requiredToken !== undefined && request.headers.authorization !== `Bearer ${requiredToken}`) {
    response.writeHead(401, { 'content-type': 'text/plain' })
    response.end('missing or invalid bearer token')
    return
  }
  const status = flagValue('--status')
  if (status !== undefined) {
    response.writeHead(Number.parseInt(status, 10), { 'content-type': 'text/plain' })
    response.end(`declined with ${status}`)
    return
  }
  if (flags.includes('--stall-open')) {
    // Deliberately never write anything: the client's open deadline must expire.
    return
  }
  const contentType = flagValue('--content-type') ?? 'text/event-stream'
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-cache' })

  const event = (index) => ({ eventId: `evt-${String(index)}`, eventTimeMs: 1000 * index, lon: 116.4 + index * 0.01, lat: 39.9 + index * 0.01, value: index + 1 })
  const eventLine = (index) => JSON.stringify(event(index))

  if (flags.includes('--big-line')) {
    response.write(`data: ${'x'.repeat(200 * 1024)}\n\n`)
    response.end()
    return
  }
  if (flags.includes('--bad-utf8')) {
    response.write(Buffer.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20])) // "data: "
    response.write(Buffer.from([0xff, 0xfe, 0x0a, 0x0a])) // invalid UTF-8 line, then frame dispatch
    response.end()
    return
  }

  let emitted = 0
  const emitOne = () => {
    if (flags.includes('--reject-mix') && !mixedRejected) {
      // The shape-reject payload is extra: it never consumes an event slot.
      mixedRejected = true
      response.write(`data: ${JSON.stringify({ eventId: 'bad-shape', eventTimeMs: 'not-a-number' })}\n\n`)
      return
    }
    if (flags.includes('--array')) {
      response.write(`data: ${JSON.stringify([event(emitted), event(emitted + 1)])}\n\n`)
      emitted += 2
    } else {
      response.write(`data: ${eventLine(emitted)}\n\n`)
      emitted += 1
    }
  }

  let mixedRejected = false
  if (intervalMs > 0) {
    const timer = setInterval(() => {
      if (emitted >= eventCount) {
        clearInterval(timer)
        if (flags.includes('--end')) response.end()
        return
      }
      emitOne()
    }, intervalMs)
    request.on('close', () => clearInterval(timer))
    return
  }

  while (emitted < eventCount) emitOne()
  if (flags.includes('--end')) {
    response.end()
    return
  }
  // Burst lanes stay open and quiet until the client tears down.
  request.on('close', () => undefined)
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  process.stdout.write(`READY ${String(port)}\n`)
})
