/**
 * `map_observe`: version-bound visual observation of the session's map. The
 * tool requests one client-captured screenshot of the CURRENT map revision,
 * waits a bounded window for the client occurrence to submit it, and saves
 * the PNG as a durable attachment the result carries as an image block — so
 * only a vision-capable model receives pixels, gated before submission. The
 * capture is depersonalized map rendering, never a measurement: pixel
 * inference never substitutes a geo_* number.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { MAP_OBSERVATION_SERVICE, type MapObservationOutcome, type MapObservationService } from '@map-harness/map-container'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'
import { renderJson } from './output.ts'

/** Default capture window; the client gets this long to render and submit. */
export const DEFAULT_OBSERVE_TIMEOUT_MS = 20_000

/** The minimal llm service face the vision gate reads. */
interface LlmModelFace {
  listModels(provider: string): Promise<readonly { id: string; inputModalities?: readonly string[] }[]>
}

/** The minimal attachment-store face the capture persists through. */
interface AttachmentFace {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: 'image/png'; name?: string }[]): Promise<readonly {
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }[]>
}

/*
 * Read the session's latest request model (provider + model) from the log.
 * The synchronous-read deprecation (Agent Note 2026-09-09) has no sanctioned
 * successor for model-identity verification yet, and the vision gate must
 * fail closed on real facts; this single bounded backward scan is the
 * narrowest honest source. Migrate when a sanctioned model-facts surface
 * lands.
 */
function lastRequestModelOf(exec: ToolRunContext): { provider: string; model: string } | undefined {
  const session = exec.agent?.session as {
    snapshotEvents?(from?: number, to?: number): readonly { type: string; data: { header?: { config?: { provider?: string; model?: string } } } }[]
  } | undefined
  if (session?.snapshotEvents === undefined) return undefined
  const events = session.snapshotEvents()
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at]
    if (event?.type !== 'request/header') continue
    const provider = event.data.header?.config?.provider
    const model = event.data.header?.config?.model
    if (typeof provider === 'string' && typeof model === 'string') return { provider, model }
  }
  return undefined
}

/**
 * Whether the session's current model accepts image input. Absent model
 * facts or an unreadable catalog refuse the observation (fail closed): a
 * text-only model must never receive pixels.
 */
async function modelAcceptsImages(exec: ToolRunContext): Promise<boolean> {
  const current = lastRequestModelOf(exec)
  if (current === undefined) return false
  const llm = serviceOf<LlmModelFace>(exec, 'llm')
  if (llm === undefined) return false
  try {
    const models = await llm.listModels(current.provider)
    const model = models.find(entry => entry.id === current.model)
    return model?.inputModalities?.includes('image') === true
  } catch {
    return false
  }
}

/** `map_observe`: capture the session's map at the current revision for visual inspection. */
export const mapObserve = defineTool({
  name: 'map_observe',
  description:
    'Capture a screenshot of this session\'s map at its CURRENT revision and return it as an image for visual '
    + 'inspection. Requires a mounted map client (an open map occurrence) and a vision-capable model; both are '
    + 'checked before the capture is submitted. The image binds to the exact map revision — pixel reading is '
    + 'observation, never measurement: geometry and values come from the geo_*/stats_* tools. `timeout_ms` bounds '
    + 'the client capture window (default 20000, max 60000).',
  parameters: {
    timeout_ms: { type: 'number', description: 'Capture window in milliseconds [1000, 60000]; default 20000.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const rest = value as Record<string, unknown>
      const text = renderJson({ ...rest, image: undefined } as never)
      const attachment = rest.image as { attachmentId: string; mediaType: string; bytes: number; width: number; height: number } | undefined
      if (attachment === undefined) return text
      return [
        ...text,
        { type: 'image' as const, attachment } as never,
      ]
    },
    presentationMeta: () => null,
  },
  async execute(args, exec) {
    exec.signal.throwIfAborted()
    const { timeout_ms: timeoutMsArg } = args as { timeout_ms?: number }
    const timeoutMs = timeoutMsArg === undefined ? DEFAULT_OBSERVE_TIMEOUT_MS
      : typeof timeoutMsArg === 'number' && Number.isFinite(timeoutMsArg) ? Math.min(60_000, Math.max(1_000, timeoutMsArg))
        : undefined
    if (timeoutMs === undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'timeout_ms must be a number in [1000, 60000]')
    }
    const session = exec.agent?.session
    if (session === undefined || typeof session.id !== 'string') {
      throw new Error('map_observe requires an agent session caller')
    }
    const callId = exec.callId
    if (typeof callId !== 'string') {
      throw new Error('map_observe requires its paired tool/call identity')
    }
    const observation = serviceOf<MapObservationService>(exec, MAP_OBSERVATION_SERVICE)
    if (observation === undefined) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_observe requires the mapObservation service; this deployment has no map container mounted')
    }
    const map = serviceOf<{ stateOf(session: unknown): { revision: number; layers: readonly unknown[] } }>(exec, 'map')
    if (map === undefined) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_observe requires the map container service')
    }
    const state = map.stateOf(session)
    if (state.layers.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'the session map carries no layers; there is nothing to observe')
    }
    // Vision gate, fail closed: no verified image-capable model, no capture.
    const acceptsImages = await modelAcceptsImages(exec)
    exec.signal.throwIfAborted()
    if (!acceptsImages) {
      throw new SpatialError('INVALID_ARGUMENT', 'map_observe requires a vision-capable model; the session\'s current model does not accept image input')
    }
    const outcome: MapObservationOutcome = await observation.waitFor(session.id, callId, state.revision, timeoutMs, exec.signal)
    if (outcome.status === 'cancelled') {
      throw new SpatialError('CALL_CANCELED', 'map_observe was cancelled before the client submitted a capture')
    }
    if (outcome.status === 'timeout') {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', `no map client submitted a capture of revision ${state.revision} within ${timeoutMs} ms; the map occurrence may be closed`)
    }
    const attachments = serviceOf<AttachmentFace>(exec, 'attachments')
    if (attachments === undefined) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_observe requires the attachment service to persist the capture')
    }
    const [saved] = await attachments.saveImages([{ data: outcome.png, mediaType: 'image/png', name: `map-r${state.revision}.png` }])
    if (saved === undefined) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'the capture failed attachment admission')
    }
    const value: Record<string, unknown> = {
      revision: outcome.revision,
      view_id: outcome.viewId,
      image: {
        attachmentId: saved.attachmentId,
        mediaType: saved.mediaType,
        bytes: saved.bytes,
        width: saved.width,
        height: saved.height,
        ...(saved.name === undefined ? {} : { name: saved.name }),
      },
      note: '像素观察绑定 revision；图形判断不能替代 geo_*/stats_* 的数值测量',
      limitations: [
        'the image depicts exactly the cited revision on the cited view',
        'pixel reading is observation, never measurement; use the analysis tools for values',
      ],
    }
    return value as unknown as JsonValue
  },
})
