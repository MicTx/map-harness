/**
 * Lead-authored local provider script. It proves image transport and map
 * evidence, not visual understanding or analysis accuracy.
 */
export const OBSERVATION_ALLOW_PATCH = ''

export const OBSERVATION_USER_REQUEST = 'Observe the empty map, add points.geojson, center it at 116.4,39.9 zoom 10, then observe again.'

const models = {
  data: [{
    id: 'deepseek-flash',
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
    api_capabilities: {
      anthropic_messages: { system_prompt_update: 'in-history', tool_update: 'addition-only' },
    },
  }],
}

const steps = [
  [{ id: 'obs-base', name: 'map_observe', input: { timeout_ms: 30_000, expected_revision: 0 } }],
  [{ id: 'obs-add', name: 'map_add_layer', input: { path: 'points.geojson', layer_id: 'points' } }],
  [{ id: 'obs-view', name: 'map_set_view', input: { center: [116.4, 39.9], zoom: 10 } }],
  [{ id: 'obs-labelled', name: 'map_observe', input: { timeout_ms: 30_000, expected_revision: 2 } }],
]

/**
 * Return one fixture-owned HTTP handler and its raw requests.
 * releaseBase() lets the browser save the accepted revision-0 record before
 * the next scripted mutation. It must also be called in the test's finally.
 */
export function createObservationModelFixture({ isTitleRequest, textResponse, toolResponse, resolveScriptedEntry, replayScript }) {
  if (replayScript !== undefined && replayScript.length !== steps.length + 1) {
    throw new Error('The recorded observation replay must contain all five model responses.')
  }
  const requests = []
  const mainRequests = []
  const fileRequests = []
  const next = Promise.withResolvers()
  const finalRequest = Promise.withResolvers()
  let mainStep = 0

  async function serve(request, response) {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'GET' && path.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(models))
      return
    }
    if (request.method === 'POST' && path.endsWith('/files')) {
      fileRequests.push({ method: request.method, path })
      request.resume()
      response.writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { type: 'not_found', message: 'Local fixture uses inline image input.' } }))
      return
    }
    if (request.method !== 'POST' || !path.endsWith('/messages')) {
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"type":"not_found"}}')
      return
    }
    const chunks = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > 32 * 1024 * 1024) {
        response.writeHead(413).end()
        return
      }
      chunks.push(chunk)
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(parsed)
    if (isTitleRequest(parsed)) {
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(textResponse('map observation'))
      return
    }
    const index = mainStep++
    mainRequests.push(parsed)
    if (index === steps.length) finalRequest.resolve(parsed)
    if (index === 1) await next.promise
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (replayScript !== undefined) {
      const source = replayScript[index]
      if (source === undefined) throw new Error('The observation replay received an extra model request.')
      const entry = resolveScriptedEntry(source, parsed.messages)
      if (entry.kind !== 'chunks') throw new Error('The successful observation replay must contain response chunks.')
      const blocks = entry.chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block)
      const calls = blocks.filter(block => block.type === 'tool-call')
      response.end(calls.length > 0
        ? toolResponse(calls.map(call => ({ id: call.id, name: call.name, input: JSON.parse(call.arguments) })))
        : textResponse(blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')))
      return
    }
    response
      .end(index < steps.length ? toolResponse(steps[index]) : textResponse('observation noted'))
  }

  return {
    requests,
    mainRequests,
    fileRequests,
    releaseBase: () => next.resolve(),
    /** Wait for the request following both observations, without retaining an abort listener. */
    async waitForFinalRequest(signal) {
      signal.throwIfAborted()
      let onAbort
      try {
        const aborted = new Promise((_resolve, reject) => {
          onAbort = () => reject(signal.reason)
          signal.addEventListener('abort', onAbort, { once: true })
        })
        return await Promise.race([finalRequest.promise, aborted])
      } finally {
        if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
      }
    },
    handler: (request, response) => {
      void serve(request, response).catch(error => {
        if (response.headersSent) response.destroy(error)
        else response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"type":"fixture_failure"}}')
      })
    },
  }
}
