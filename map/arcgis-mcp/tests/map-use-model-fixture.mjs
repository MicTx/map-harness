/**
 * Lead-authored local provider script for continuous map use. It proves the
 * real tool/observation/SDK chain, not model visual quality. Observation ids
 * are read from the preceding tool results; takeover and finish requests are
 * gated so the browser test can act between model steps.
 */
export const MAP_USE_ALLOW_PATCH = ''

/** The same source/capture policy the visual-markup lane needs. */
export const MAP_MARKUP_ALLOW_PATCH = MAP_USE_ALLOW_PATCH

export const MAP_USE_USER_REQUEST = 'Observe the coverage layer, pan, observe, zoom, observe, click it, then stop.'

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

/** The latest observation id present in the model transcript. */
function latestObservationId(messages) {
  const matches = [...JSON.stringify(messages).matchAll(/obs-[0-9a-f-]{36}/gu)]
  const id = matches.at(-1)?.[0]
  if (id === undefined) throw new Error('The map-use script found no observation id in the transcript')
  return id
}

/** The width/height of the latest observation image in the transcript. */
function imageSize(messages) {
  for (const message of [...messages].reverse()) {
    for (const result of [...(message.content ?? [])].reverse()) {
      if (result.type !== 'tool_result') continue
      for (const block of result.content ?? []) {
        if (block.type !== 'text') continue
        try {
          const parsed = JSON.parse(block.text)
          if (parsed.observation_id && parsed.map_content_rect) return parsed.map_content_rect
        } catch (notJson) { void notJson }
      }
    }
  }
  throw new Error('The observation did not expose its map-content dimensions')
}

const steps = [
  () => ({ id: 'use-add', name: 'map_add_layer', input: { path: 'coverage.geojson', layer_id: 'coverage', name: 'Coverage' } }),
  () => ({ id: 'use-obs-1', name: 'map_observe', input: { timeout_ms: 30_000, expected_revision: 1 } }),
  messages => ({ id: 'use-pan', name: 'map_use', input: { action: 'pan', observation_id: latestObservationId(messages), dx_px: 120, dy_px: 0 } }),
  () => ({ id: 'use-obs-2', name: 'map_observe', input: { timeout_ms: 30_000, expected_revision: 2 } }),
  messages => ({ id: 'use-zoom', name: 'map_use', input: { action: 'zoom', observation_id: latestObservationId(messages), delta_zoom: 1 } }),
  () => ({ id: 'use-obs-3', name: 'map_observe', input: { timeout_ms: 30_000, expected_revision: 3 } }),
  messages => ({ id: 'use-pan-2', name: 'map_use', input: { action: 'pan', observation_id: latestObservationId(messages), dx_px: -60, dy_px: 30 } }),
  () => ({ id: 'use-obs-4', name: 'map_observe', input: { timeout_ms: 30_000, expected_revision: 4 } }),
  messages => ({ id: 'use-zoom-2', name: 'map_use', input: { action: 'zoom', observation_id: latestObservationId(messages), delta_zoom: -0.5 } }),
  () => ({ id: 'use-obs-5', name: 'map_observe', input: { timeout_ms: 30_000, expected_revision: 5 } }),
  messages => {
    const { width, height } = imageSize(messages)
    return {
      id: 'use-click',
      name: 'map_use',
      input: { action: 'click', observation_id: latestObservationId(messages), x_px: Math.round(width / 2), y_px: Math.round(height * 0.45) },
    }
  },
  messages => ({ id: 'use-takeover', name: 'map_use', input: { action: 'pan', observation_id: latestObservationId(messages), dx_px: 10, dy_px: 0 } }),
  () => ({ id: 'use-observe-stopped', name: 'map_observe', input: {} }),
  () => ({ id: 'use-finish', name: 'map_use', input: { action: 'finish' } }),
]

/**
 * Create the local provider handler plus the takeover/finish gates.
 * @param options - the shared composition response helpers and optional replay script.
 * @returns the fixture state used by the browser test.
 */
export function createMapUseModelFixture({ isTitleRequest, textResponse, toolResponse, stopAfter, emptyHit = false, unpinnedObservations = false, replayScript, resolveReplayEntry, prepareRotation = false }) {
  const requests = []
  const mainRequests = []
  let mainStep = 0
  let awaitingRotationTurn = prepareRotation
  const takeoverPending = Promise.withResolvers()
  const takeoverGate = Promise.withResolvers()
  const finishPending = Promise.withResolvers()
  const finishGate = Promise.withResolvers()
  const finalRequest = Promise.withResolvers()
  const refusalRequest = Promise.withResolvers()
  const gates = new Map([1, 2, 4, 6, 8, 10].map(index => [index, Promise.withResolvers()]))
  let anchor
  let failure

  async function serve(request, response) {
    const path = new URL(request.url, 'http://127.0.0.1').pathname
    if (request.method === 'GET' && path.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(models))
      return
    }
    if (request.method === 'POST' && path.endsWith('/files')) {
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
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(textResponse('continuous map use'))
      return
    }
    if (awaitingRotationTurn && mainStep === 1) {
      awaitingRotationTurn = false
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(textResponse('map ready for rotation'))
      return
    }
    const index = mainStep++
    mainRequests.push(parsed)
    if (stopAfter !== undefined && index >= stopAfter) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (index === stopAfter) {
        refusalRequest.resolve(parsed)
        response.end(toolResponse([{ id: 'budget-finish', name: 'map_use', input: { action: 'finish' } }]))
      } else {
        finalRequest.resolve(parsed)
        response.end(textResponse('map use budget noted'))
      }
      return
    }
    if (gates.has(index)) await gates.get(index).promise
    if (index === 11) {
      takeoverPending.resolve()
      await takeoverGate.promise
    }
    if (index === 12) {
      finishPending.resolve()
      await finishGate.promise
    }
    if (index === steps.length) finalRequest.resolve(parsed)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (replayScript !== undefined) {
      const entry = replayScript[index]
      if (entry === undefined) throw new Error('The map-use replay received an extra model request')
      const resolved = resolveReplayEntry(entry, parsed.messages)
      response.end(resolved.calls.length > 0 ? toolResponse(resolved.calls) : textResponse(resolved.text))
      return
    }
    if (index < steps.length) {
      const call = steps[index](parsed.messages)
      if (unpinnedObservations && call.name === 'map_observe') delete call.input.expected_revision
      if (call.id === 'use-zoom' && anchor !== undefined) {
        call.input.anchor_x_px = anchor.x
        call.input.anchor_y_px = anchor.y
      }
      if (call.id === 'use-click' && emptyHit) {
        call.input.x_px = 1
        call.input.y_px = 1
      }
      response.end(toolResponse([call]))
    } else response.end(textResponse('map use noted'))
  }

  return {
    requests,
    mainRequests,
    releaseStep: index => gates.get(index)?.resolve(),
    setAnchor: point => { anchor = point },
    releaseAll: () => { for (const gate of gates.values()) gate.resolve(); takeoverGate.resolve(); finishGate.resolve() },
    waitForTakeover: () => takeoverPending.promise,
    releaseTakeover: () => takeoverGate.resolve(),
    waitForFinish: () => finishPending.promise,
    releaseFinish: () => finishGate.resolve(),
    waitForFinalRequest: () => finalRequest.promise,
    waitForRefusal: () => refusalRequest.promise,
    assertReplayConsumed: () => {
      if (failure !== undefined) throw failure
      if (replayScript !== undefined && mainStep !== replayScript.length) throw new Error('The map-use replay was not fully consumed')
    },
    handler: (request, response) => {
      void serve(request, response).catch(error => {
        failure = error
        if (response.headersSent) response.destroy(error)
        else response.writeHead(500, { 'content-type': 'application/json' }).end('{"error":{"type":"fixture_failure"}}')
      })
    },
  }
}
