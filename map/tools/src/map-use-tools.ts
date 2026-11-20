/**
 * `map_use`: one bounded continuous map action bound to one accepted visual
 * observation. Pan and zoom produce ordinary `set-view` candidates from the
 * observation's frozen affine plane; click asks the live browser for a
 * read-only SDK `hitTest`; finish ends continuous use. Configured per-turn
 * limits are checked before client work; the default is unlimited.
 * @module @map-harness/map-tools/map-use-tools
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  MAP_INTERACTION_SERVICE,
  affineOfObservation,
  cssPointOf,
  displayPointOf,
  mapUseBudgetRefusalOf,
  mapUseBudgetSnapshotOf,
  panTargetOf,
  parseMapUseArguments,
  wgs84OfDisplayPoint,
  zoomTargetOf,
  type MapContainerService,
  type MapInteractionService,
  type MapInteractionWaitOutcome,
  type MapObservationRecord,
  type MapUseBudget,
  type MapUseReceipt,
  type MapSourceService,
  interactionHitOf,
} from '@map-harness/map-container'
import { featureIdOf } from '@map-harness/spatial-viz'
import { z } from 'zod'
import { sessionOf } from './catalog-tools.ts'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'
import { renderJson, round6 } from './output.ts'
import { buildMapChangeMeta, validateMapChangeCandidate } from '@map-harness/map-container'
import { admitCameraChange, assertAutomatedMapUseAllowed } from './basemap-admission.ts'

/** The resolved budget/config face the map-container plugin publishes. */
interface InteractionConfigFace {
  readonly budget: MapUseBudget
}

/** The observation error mapping shared by tool and card copy. */
function refusalMessage(refusal: ReturnType<typeof mapUseBudgetRefusalOf>): string {
  switch (refusal) {
    case 'actions': return 'the configured per-turn map action limit is exhausted'
    case 'observations': return 'the configured per-turn map observation limit is exhausted'
    case 'elapsed': return 'the configured continuous map-use time limit is exhausted'
    case null: return ''
  }
}

/** Verify the current rendered sources before and after the client fence. */
function assertCurrentSources(exec: ToolRunContext, state: ReturnType<MapContainerService['stateOf']>): void {
  assertAutomatedMapUseAllowed(state, serviceOf<MapSourceService>(exec, 'mapSourceService'))
}

/** Map one math refusal to the authored error vocabulary. */
function mathError(refusal: string): never {
  if (refusal === 'outside-map') {
    throw new SpatialError('INVALID_ARGUMENT', 'The requested pixel is outside the captured map content (the attribution footer is not clickable).')
  }
  if (refusal === 'world-wrap') {
    throw new SpatialError('INVALID_ARGUMENT', 'The action would cross the supported world boundary; choose a smaller step.')
  }
  if (refusal === 'unsupported-georeference') {
    throw new SpatialError('UNSUPPORTED_GEOREFERENCE', 'Continuous map use requires a 2D affine-2d observation; switch to 2D and observe again.')
  }
  throw new SpatialError('INVALID_ARGUMENT', 'The map action parameters are invalid.')
}

/** Map one client fence outcome to a named tool failure. */
function outcomeError(outcome: Exclude<MapInteractionWaitOutcome, { status: 'validated' | 'hits' }>): never {
  switch (outcome.status) {
    case 'timeout': throw new SpatialError('NO_VIEW', 'No live map claimed this action before its deadline; open the session map and retry.')
    case 'cancelled': throw new SpatialError('CANCELLED', 'The map action was cancelled before it settled.')
    case 'stale': throw new SpatialError('STALE_OBSERVATION', 'The map or observation identity changed; observe the current view again.')
    case 'full': throw new SpatialError('MAP_BUDGET_EXCEEDED', 'The concurrent map-action limit is reached; wait for the current action to finish.')
    case 'declined':
      switch (outcome.code) {
        case 'no-view': throw new SpatialError('NO_VIEW', 'Open this session\'s map before using it.')
        case 'not-ready': throw new SpatialError('NOT_READY', 'The map is not fully rendered; wait for the map or resolve its layer error.')
        case 'stale': throw new SpatialError('STALE_OBSERVATION', 'The map or observation identity changed; observe the current view again.')
        case 'user-interrupted': throw new SpatialError('USER_INTERRUPTED', 'The user took control of the map; wait for the user to ask again.')
        case 'edit-in-progress': throw new SpatialError('EDIT_IN_PROGRESS', 'A drawing or editing interaction owns the map; finish or cancel it first.')
        case 'unsupported': throw new SpatialError('UNSUPPORTED_GEOREFERENCE', 'Continuous map use is unavailable for this view; request a new 2D observation.')
        case 'outside-map': throw new SpatialError('INVALID_ARGUMENT', 'The requested pixel is outside the captured map content.')
        case 'render-failed': throw new SpatialError('RENDER_FAILED', 'The map could not finish rendering; stop and resolve the map error.')
      }
  }
}

/** Build the `set-view` meta for one computed camera target. */
function cameraMeta(
  exec: ToolRunContext,
  service: MapContainerService,
  target: { readonly center: readonly [number, number]; readonly zoom: number; readonly wkid: number; readonly scale: number; readonly rotation: number },
): JsonValue {
  const session = sessionOf(exec)
  const pending = service.pendingCallOf(session, exec.callId)
  if (pending === undefined || pending.name !== 'map_use') {
    throw new Error('map_use requires its accepted tool/call in the session log before execution')
  }
  const state = service.stateOf(session)
  const view = {
    center: [target.center[0], target.center[1]] as [number, number],
    zoom: target.zoom,
    wkid: target.wkid,
    scale: target.scale,
    rotation: target.rotation,
  }
  const change = { op: 'set-view', view } as const
  admitCameraChange(state, change, serviceOf<MapSourceService>(exec, 'mapSourceService'))
  const targetRevision = validateMapChangeCandidate(state, change)
  return JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change))) as JsonValue
}

/** Whether the observation is still the session's current, un-superseded evidence. */
function currentObservation(
  state: ReturnType<MapContainerService['stateOf']>,
  observationId: string,
): MapObservationRecord {
  const observation = state.latestObservation
  if (observation === null || observation.observationId !== observationId || observation.mapRevision !== state.revision) {
    throw new SpatialError('STALE_OBSERVATION', 'The cited observation is not the current map view; observe it again.')
  }
  return observation
}

/** `map_use`: one continuous action over the session's live map. */
export const mapUse = defineTool({
  name: 'map_use',
  description:
    'Perform exactly one continuous map action against the current visual observation: '
    + 'pan by output-image pixels, zoom around an optional pixel anchor, click a pixel for a read-only SDK hit test, or finish. '
    + 'Cite the latest observation_id for pan/zoom/click. Camera actions return a candidate, not a rendering confirmation; '
    + 'source_revision is the observed version; candidate_revision is only the proposed next version. After a camera action, call map_observe without expected_revision to observe the latest accepted state. '
    + 'User gestures, drawing, and the stop control take priority. Observe again after a stale view.',
  parameters: {
    action: {
      type: 'string',
      required: true,
      description: 'Exactly one action. pan accepts only observation_id/dx_px/dy_px; zoom accepts only observation_id/delta_zoom/anchor_x_px/anchor_y_px; click accepts only observation_id/x_px/y_px; finish accepts only observation_id/reason. Omit every other field.',
    },
    observation_id: {
      type: 'string',
      description: 'The latest map_observe observation id; required for pan/zoom/click.',
    },
    dx_px: { type: 'number', description: 'Pan vector X in output-image pixels; positive moves map content right.' },
    dy_px: { type: 'number', description: 'Pan vector Y in output-image pixels; positive moves map content down.' },
    delta_zoom: { type: 'number', description: 'Zoom delta in levels; positive zooms in, at most ±4 per action.' },
    anchor_x_px: { type: 'number', description: 'Optional zoom anchor X in output-image pixels; defaults to the map-content centre.' },
    anchor_y_px: { type: 'number', description: 'Optional zoom anchor Y in output-image pixels; defaults to the map-content centre.' },
    x_px: { type: 'number', description: 'Click X in output-image pixels, inside the map content (not the attribution footer).' },
    y_px: { type: 'number', description: 'Click Y in output-image pixels, inside the map content (not the attribution footer).' },
    reason: { type: 'string', description: 'Optional short reason for finish only. Omit this field for pan, zoom, and click.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest as JsonValue)
    },
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    if (exec.parent !== undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'map_use requires its accepted native tool call in this session.')
    }
    const action = parseMapUseArguments(JSON.stringify(args))
    if (action === null) {
      throw new SpatialError('INVALID_ARGUMENT', 'map_use requires exactly one valid action and only that action\'s fields; reason is allowed only for finish.')
    }
    const session = sessionOf(exec)
    const service = serviceOf<MapContainerService>(exec, 'map')
    if (service === undefined) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_use requires the map container service.')
    }
    const config = serviceOf<InteractionConfigFace>(exec, 'mapInteractionConfig')
    if (config === undefined) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_use requires the map interaction configuration.')
    }
    const accepted = service.pendingCallOf(session, exec.callId)
    if (accepted === undefined || accepted.name !== 'map_use') {
      throw new SpatialError('INVALID_ARGUMENT', 'map_use requires its accepted tool/call in the session log before execution.')
    }
    const interactionState = service.interactionOf(session)
    if (action.action !== 'finish' && interactionState.stopped !== null) {
      throw new SpatialError(interactionState.stopped === 'user-interrupted' ? 'USER_INTERRUPTED' : 'MAP_USE_STOPPED', 'Map use has stopped for this turn; wait for a new user request.')
    }
    const request = interactionState.request
    if (!interactionState.open || request === null || request.callId !== exec.callId
      || JSON.stringify(parseMapUseArguments(request.arguments)) !== JSON.stringify(action)) {
      throw new SpatialError('INVALID_ARGUMENT', 'map_use requires its current accepted call and unchanged arguments.')
    }
    const now = Date.now()
    const budget = mapUseBudgetSnapshotOf(interactionState, config.budget, now)
    const receipt = (view: MapUseReceipt['view'], hits: MapUseReceipt['hits'] = []): MapUseReceipt => ({
      callId: exec.callId, sourceCallSeq: accepted.callSeq,
      turnStartSeq: request.turnStartSeq, controlEpoch: request.controlEpoch,
      observationId: action.observationId ?? '', action: action.action,
      targetRevision: service.stateOf(session).revision,
      expiresAtMs: Math.min(request.expiresAtMs, config.budget.maxElapsedMs === null
        ? Number.POSITIVE_INFINITY : interactionState.startedAt + config.budget.maxElapsedMs),
      viewId: service.stateOf(session).latestObservation?.viewId ?? '', view, hits,
    })
    const metaOf = (record: MapUseReceipt) => ({ kind: 'map-use', schemaVersion: 1, record })
    if (action.action === 'finish') {
      return z.json().parse({
        action: 'finish',
        action_id: exec.callId,
        turn: interactionState.turn,
        finished: true,
        ...(action.reason === undefined ? {} : { reason: action.reason }),
        budget,
        must_observe: false,
        meta: metaOf(receipt(null)),
      })
    }
    if (interactionState.stopped !== null) {
      throw new SpatialError(interactionState.stopped === 'user-interrupted' ? 'USER_INTERRUPTED' : 'MAP_USE_STOPPED', 'Map use has stopped for this turn; wait for a new user request.')
    }
    if (!interactionState.open) {
      throw new SpatialError('INVALID_ARGUMENT', 'map_use requires an open turn with its accepted tool call.')
    }
    const refusal = mapUseBudgetRefusalOf(interactionState, config.budget, now)
    if (refusal !== null) {
      throw new SpatialError('MAP_BUDGET_EXCEEDED', `The ${refusal} budget is exhausted: ${refusalMessage(refusal)}.`)
    }
    const state = service.stateOf(session)
    if (state.mode !== 'map') {
      throw new SpatialError('UNSUPPORTED_GEOREFERENCE', 'Continuous map use is available only in the 2D map; switch back to 2D and observe again.')
    }
    const observation = currentObservation(state, action.observationId)
    if (interactionState.usedObservationId === observation.observationId) {
      throw new SpatialError('STALE_OBSERVATION', 'This observation already authorized an action; observe the current view again.')
    }
    if (observation.camera === null || observation.georeference.kind !== 'affine-2d') {
      throw new SpatialError('UNSUPPORTED_GEOREFERENCE', 'The current observation has no usable 2D affine georeference; switch to 2D and observe again.')
    }
    assertCurrentSources(exec, state)
    const usable = affineOfObservation(observation)
    if (typeof usable === 'string') mathError(usable)
    let target: ReturnType<typeof panTargetOf> | undefined
    let clickWorld: readonly [number, number] | undefined
    if (action.action === 'pan') {
      target = panTargetOf(observation, action.dxPx, action.dyPx)
      if (typeof target === 'string') mathError(target)
    } else if (action.action === 'zoom') {
      const anchor = action.anchorXPx === undefined || action.anchorYPx === undefined
        ? undefined
        : [action.anchorXPx, action.anchorYPx] as const
      target = zoomTargetOf(observation, action.deltaZoom, anchor)
      if (typeof target === 'string') mathError(target)
    } else {
      const css = cssPointOf(observation, action.xPx, action.yPx)
      if (typeof css === 'string') mathError(css)
      const display = displayPointOf(usable.affine, action.xPx, action.yPx)
      const world = wgs84OfDisplayPoint(display, observation.camera.wkid)
      if (typeof world === 'string') mathError(world)
      clickWorld = world
    }
    if (request === null || request.callId !== exec.callId || request.observationId !== action.observationId) {
      throw new SpatialError('STALE_OBSERVATION', 'The accepted map-use request no longer matches this observation; observe again.')
    }
    const interaction = serviceOf<MapInteractionService>(exec, MAP_INTERACTION_SERVICE)
    if (interaction === undefined) {
      throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'The map interaction service is unavailable; no action was taken.')
    }
    const identity = { sessionId: session.id, callId: exec.callId, requestSeq: request.requestSeq }
    const expiresAtMs = Math.min(request.expiresAtMs, config.budget.maxElapsedMs === null
      ? Number.POSITIVE_INFINITY : interactionState.startedAt + config.budget.maxElapsedMs)
    const assertCurrent = (): void => {
      if (exec.signal.aborted) throw new SpatialError('CANCELLED', 'The map action was cancelled.')
      const live = service.interactionOf(session)
      if (live.stopped !== null) throw new SpatialError(live.stopped === 'user-interrupted' ? 'USER_INTERRUPTED' : 'MAP_USE_STOPPED', 'Map use has stopped for this turn.')
      if (Date.now() >= expiresAtMs || mapUseBudgetRefusalOf(live, config.budget, Date.now()) !== null) throw new SpatialError('MAP_BUDGET_EXCEEDED', 'The map action deadline has elapsed or its clock moved backwards.')
      if (!live.open || live.turnStartSeq !== request.turnStartSeq || live.controlEpoch !== request.controlEpoch
        || live.request?.requestSeq !== request.requestSeq) throw new SpatialError('STALE_OBSERVATION', 'The action owner changed.')
      currentObservation(service.stateOf(session), action.observationId)
      assertCurrentSources(exec, service.stateOf(session))
    }
    let outcome: MapInteractionWaitOutcome
    try {
      assertCurrent()
      outcome = await interaction.waitFor({
        ...identity,
        expiresAtMs,
        signal: exec.signal,
        readCurrent: () => {
          try { assertCurrent(); return true }
          catch (invalidOwner) { void invalidOwner; return false }
        },
      })
    } finally {
      interaction.cancel(identity)
    }
    assertCurrent()
    if (outcome.status === 'declined' || outcome.status === 'timeout' || outcome.status === 'cancelled'
      || outcome.status === 'stale' || outcome.status === 'full') {
      outcomeError(outcome)
    }
    // Re-read after the client fence: another writer may have moved the map.
    const settledState = service.stateOf(session)
    currentObservation(settledState, action.observationId)
    if (action.action === 'click') {
      if (outcome.status !== 'hits') {
        throw new SpatialError('CAPTURE_FAILED', 'The click fence returned no hit result; retry after the map is ready.')
      }
      if (clickWorld === undefined) throw new SpatialError('INVALID_ARGUMENT', 'The click point has no WGS84 coordinate.')
      const agreed = Math.abs(outcome.world[0] - clickWorld[0]) <= 1e-6
        && Math.abs(outcome.world[1] - clickWorld[1]) <= 1e-6
      if (!agreed) {
        throw new SpatialError('STALE_OBSERVATION', 'The click coordinate disagreed with the cited observation; observe again.')
      }
      const hits = outcome.hits.map(hit => {
        const layer = settledState.layers.find(candidate => candidate.id === hit.layerId && candidate.visible && candidate.opacity > 0)
        const feature = layer?.data?.features?.find((candidate, index) => featureIdOf(candidate, index) === hit.featureId)
        if (layer === undefined || feature === undefined) throw new SpatialError('STALE_OBSERVATION', 'The clicked feature is not in the current displayed layer.')
        const properties = feature.properties ?? {}
        return interactionHitOf({ layerId: layer.id, layerName: layer.name, featureId: hit.featureId }, properties,
          layer.symbol?.presentation === 'single' ? layer.symbol.label?.field ?? 'name' : 'name')
      })
      return z.json().parse({
        action: 'click',
        action_id: exec.callId,
        turn: interactionState.turn,
        observation_id: action.observationId,
        revision: observation.mapRevision,
        world: [round6(clickWorld[0]), round6(clickWorld[1])],
        hits: hits.map(hit => ({
          layer_id: hit.layerId,
          layer_name: hit.layerName,
          feature_id: hit.featureId,
          title: hit.title,
          fields: hit.fields.map(field => ({ name: field.name, value: field.value })),
          omitted: hit.omitted,
        })),
        hit: hits.length > 0,
        budget: mapUseBudgetSnapshotOf(interactionState, config.budget, Date.now()),
        must_observe: true,
        meta: metaOf(receipt(null, hits)),
      })
    }
    if (target === undefined || typeof target === 'string') {
      throw new SpatialError('INVALID_ARGUMENT', 'The camera target is unavailable.')
    }
    if (outcome.status !== 'validated') {
      throw new SpatialError('CAPTURE_FAILED', 'The camera fence returned no validation; retry after the map is ready.')
    }
    cameraMeta(exec, service, target)
    const meta = metaOf(receipt({ ...target, center: [target.center[0], target.center[1]] }))
    return z.json().parse({
      action: action.action,
      action_id: exec.callId,
      turn: interactionState.turn,
      status: 'candidate',
      rendered: false,
      observation_id: action.observationId,
      center: [target.center[0], target.center[1]],
      zoom: target.zoom,
      wkid: target.wkid,
      source_revision: observation.mapRevision,
      candidate_revision: observation.mapRevision + 1,
      budget: mapUseBudgetSnapshotOf(interactionState, config.budget, Date.now()),
      must_observe: true,
      meta,
    })
  },
})
