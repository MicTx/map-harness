/**
 * `map_markup`: submit one bounded batch of visual candidates against the
 * current session's accepted map observation. The model supplies image-pixel
 * geometry; the host supplies identity, reads the persisted attachment,
 * projects every point through the frozen affine plane, and returns a
 * versioned durable meta record. The tool never calls a second model,
 * writes an annotation, or accepts a candidate on the user's behalf.
 * @module @map-harness/map-tools/markup-tools
 */
import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { AttachmentId, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  MAX_ACTIVE_VISUAL_PROPOSALS,
  MAX_VISUAL_PROPOSAL_ITEMS,
  VISUAL_PROPOSAL_ID_PREFIX,
  VISUAL_PROPOSAL_LIMITATIONS,
  buildVisualProposalMeta,
  parseVisualProposalItems,
  visualProposalGeometryOf,
  visualProposalPairingCode,
  type MapContainerService,
  type MapObservationRecord,
  type VisualProposalRecord,
} from '@map-harness/map-container'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'
import { sessionOf } from './catalog-tools.ts'
import { renderJson } from './output.ts'
import { assertAutomatedMapUseAllowed } from './basemap-admission.ts'

/** Argument schema for one candidate item, kept model-facing and bounded. */
const ITEM_DESCRIPTION =
  'One candidate: kind (sketch|target), category (<=512 UTF-8 bytes), note (<=512 UTF-8 bytes), '
  + 'confidence (uncertain|likely), and pixelGeometry as one flat object: '
  + '{type:"point",point:[x,y]}, {type:"polyline",points:[[x,y],…]}, {type:"polygon",points:[[x,y],…]}, '
  + 'or {type:"bbox",corners:[[x,y],[x,y],[x,y],[x,y]]}. Coordinates are output-image pixels inside the map content, not longitude/latitude; never nest pixelGeometry under a kind key.'

/** The exact model-facing tool description; tests pin it verbatim. */
export const MARKUP_DESCRIPTION =
  'Propose up to 100 visual sketch or target candidates from the latest map_observe image. '
  + 'Cite observation_id and supply bounded image-pixel geometry; the host verifies the saved image, projects each vertex through the cited capture, and returns candidate geometries in WGS84 with evidence and limits. '
  + 'Apply or dismiss a candidate with map_edit_annotation, or draw its geometry with map_draw or map_apply_patch. Confidence is a self-assessment, not a calibrated probability; an empty result is an honest analysis conclusion.'

/** Trusted current model identity from the agent execution context. */
interface ModelContextFace {
  current(): { provider: string; model: string } | undefined
}

/** One exact stored image, with its re-admitted bytes. */
interface StoredImage {
  readonly ref: ImageAttachmentRef
  readonly data: Uint8Array
}

/** Rebuild the durable attachment reference without accepting a model-supplied id. */
function attachmentRefOf(observation: MapObservationRecord): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(observation.attachment.attachmentId),
    mediaType: 'image/png',
    bytes: observation.attachment.bytes,
    width: observation.attachment.width,
    height: observation.attachment.height,
    ...(observation.attachment.name === undefined ? {} : { name: observation.attachment.name }),
  }
}

/** Map a geometry/math refusal to the authored stable error vocabulary. */
function refusalOf(refusal: string): never {
  if (refusal === 'outside-map') throw new SpatialError('INVALID_PROPOSAL', 'A candidate pixel lies outside the captured map content.')
  if (refusal === 'world-wrap') throw new SpatialError('UNSUPPORTED_GEOREFERENCE', 'The candidate crosses the supported world boundary; observe a smaller area.')
  if (refusal === 'unsupported-georeference') throw new SpatialError('UNSUPPORTED_GEOREFERENCE', 'The cited image has no safe 2D affine pixel positioning.')
  if (refusal === 'geometry-invalid') throw new SpatialError('INVALID_PROPOSAL', 'The candidate geometry is degenerate, self-intersecting, or not a closed ring.')
  throw new SpatialError('INVALID_PROPOSAL', 'Candidate pixel coordinates must be finite and inside the captured map content.')
}

/** Read the trusted model identity, refusing a missing or malformed execution context. */
function modelIdentityOf(exec: ToolRunContext): { provider: string; model: string } {
  const agent = exec.agent as (typeof exec.agent & { model?: ModelContextFace }) | undefined
  let current: { provider: string; model: string } | undefined
  try {
    current = agent?.model?.current()
  } catch {
    current = undefined
  }
  if (current === undefined || typeof current.provider !== 'string' || current.provider.length === 0 || current.provider.length > 128
    || typeof current.model !== 'string' || current.model.length === 0 || current.model.length > 128) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_markup requires a trusted current model identity.')
  }
  return { provider: current.provider, model: current.model }
}

/** Resolve the current session observation without a global cross-session index. */
function observationOf(state: ReturnType<MapContainerService['stateOf']>, observationId: string): MapObservationRecord {
  const observation = state.latestObservation
  if (observation === null || observation.observationId !== observationId) {
    throw new SpatialError('UNKNOWN_OBSERVATION', 'The cited observation is not this session\'s current accepted observation.')
  }
  if (observation.mapRevision !== state.revision || observation.georeference.kind !== 'affine-2d' || observation.camera?.mode !== 'map') {
    throw new SpatialError('STALE_OBSERVATION', 'The cited observation no longer locates pixels on the current 2D map.')
  }
  return observation
}

/** Verify current source identities and the actual persisted PNG bytes. */
async function assertObservationEvidence(
  exec: ToolRunContext,
  state: ReturnType<MapContainerService['stateOf']>,
  observation: MapObservationRecord,
): Promise<void> {
  assertAutomatedMapUseAllowed(state, serviceOf<import('@map-harness/map-container').MapSourceService>(exec, 'mapSourceService'))
  const attachments = serviceOf<Pick<AttachmentStore, 'readImage'>>(exec, 'attachments')
  if (attachments === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_markup requires the session attachment store.')
  let stored: StoredImage
  try {
    stored = await attachments.readImage(attachmentRefOf(observation), exec.signal) as StoredImage
  } catch (error) {
    if (exec.signal.aborted) throw new SpatialError('CANCELLED', 'The visual proposal was cancelled before its source image was verified.')
    throw new SpatialError('UNKNOWN_OBSERVATION', 'The cited observation image is missing or unreadable.', { cause: error })
  }
  const digest = createHash('sha256').update(stored.data).digest('hex')
  if (digest !== observation.attachment.sha256 || stored.data.byteLength !== observation.attachment.bytes
    || stored.ref.attachmentId !== observation.attachment.attachmentId) {
    throw new SpatialError('UNKNOWN_OBSERVATION', 'The cited observation image no longer matches its recorded digest.')
  }
}

/** Build host-owned candidate records after all validation has passed. */
function proposalsOf(
  input: { readonly observationId: string; readonly purpose: 'sketch' | 'target'; readonly items: readonly import('@map-harness/map-container').VisualProposalItem[] },
  observation: MapObservationRecord,
  identity: { readonly callId: string; readonly callSeq: number; readonly provider: string; readonly model: string },
): readonly VisualProposalRecord[] {
  const createdAt = new Date().toISOString()
  return input.items.map((item, index) => {
    const geometry = visualProposalGeometryOf(observation, item.pixelGeometry)
    if (typeof geometry === 'string') refusalOf(geometry)
    const proposalId = VISUAL_PROPOSAL_ID_PREFIX + createHash('sha256')
      .update(`${identity.callId}\n${identity.callSeq}\n${input.observationId}\n${index}\n${JSON.stringify(item)}`)
      .digest('hex').slice(0, 24)
    return {
      proposalId,
      observationId: input.observationId,
      observationAttachmentSha256: observation.attachment.sha256,
      observationAttachment: { ...observation.attachment },
      sourceCallId: identity.callId,
      sourceCallSeq: identity.callSeq,
      mapRevision: observation.mapRevision,
      modelProvider: identity.provider,
      modelName: identity.model,
      purpose: input.purpose,
      category: item.category,
      note: item.note,
      confidence: item.confidence,
      pixelGeometry: item.pixelGeometry,
      geometry,
      status: 'proposed',
      createdAt,
      reviewedAt: null,
      humanEdited: false,
      acceptedFeatureId: null,
    } satisfies VisualProposalRecord
  })
}

/** `map_markup`: one model batch of unconfirmed visual candidates. */
export const mapMarkup = defineTool({
  name: 'map_markup',
  description: MARKUP_DESCRIPTION,
  parameters: {
    observation_id: { type: 'string', required: true, description: 'The current session\'s latest map_observe observation id.' },
    purpose: { type: 'string', required: true, description: 'Either sketch (draft markup) or target (visual target candidate).' },
    items: { type: 'json', required: true, description: `An array of 0..${MAX_VISUAL_PROPOSAL_ITEMS} candidates. ${ITEM_DESCRIPTION}` },
    limitations: { type: 'string', description: 'Optional short reason when no target is visible; omit for normal candidates.' },
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
    if (exec.parent !== undefined) throw new SpatialError('INVALID_ARGUMENT', 'map_markup requires its accepted native tool call in this session.')
    const { observation_id: observationId, purpose, items, limitations } = args as {
      observation_id?: unknown; purpose?: unknown; items?: unknown; limitations?: unknown
    }
    if (typeof observationId !== 'string' || observationId.length === 0 || observationId.length > 256
      || (purpose !== 'sketch' && purpose !== 'target')
      || (limitations !== undefined && (typeof limitations !== 'string' || limitations.length > 512))) {
      throw new SpatialError('INVALID_PROPOSAL', 'map_markup requires observation_id, purpose, and bounded items.')
    }
    const parsed = parseVisualProposalItems(items)
    if (parsed === undefined || parsed.some(item => item.kind !== purpose)) {
      throw new SpatialError('INVALID_PROPOSAL', 'Every candidate must use one bounded geometry, kind matching purpose, and a non-probability self-assessment.')
    }
    const session = sessionOf(exec)
    const map = serviceOf<MapContainerService>(exec, 'map')
    if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map_markup requires the map container service.')
    const pending = map.pendingCallOf(session, exec.callId)
    if (pending === undefined || pending.name !== 'map_markup') {
      throw new SpatialError('INVALID_ARGUMENT', 'map_markup requires its accepted tool/call in the session log before execution.')
    }
    const state = map.stateOf(session)
    const observation = observationOf(state, observationId)
    if (state.visualProposals.filter(proposal => proposal.status === 'proposed').length + parsed.length > MAX_ACTIVE_VISUAL_PROPOSALS) {
      throw new SpatialError('PROPOSAL_LIMIT', 'The active visual proposal budget is full; review existing candidates first.')
    }
    const model = modelIdentityOf(exec)
    await assertObservationEvidence(exec, state, observation)
    exec.signal.throwIfAborted()
    const live = map.stateOf(session)
    if (observationOf(live, observationId) !== observation || live.revision !== state.revision) {
      throw new SpatialError('STALE_OBSERVATION', 'The map or observation changed during image verification.')
    }
    assertAutomatedMapUseAllowed(live, serviceOf<import('@map-harness/map-container').MapSourceService>(exec, 'mapSourceService'))
    const proposals = proposalsOf({ observationId, purpose, items: parsed }, observation, {
      callId: exec.callId, callSeq: pending.callSeq,
      provider: model.provider, model: model.model,
    })
    const meta = buildVisualProposalMeta({
      observationId, callId: exec.callId, sourceCallSeq: pending.callSeq,
      targetRevision: state.revision, purpose, modelProvider: model.provider, modelName: model.model,
      proposals,
      limitations: limitations === undefined ? VISUAL_PROPOSAL_LIMITATIONS : [...VISUAL_PROPOSAL_LIMITATIONS, limitations],
    })
    const pairing = visualProposalPairingCode(state, meta, exec.callId, pending.callSeq, state.visualProposals)
    if (pairing !== null) throw new SpatialError('STALE_OBSERVATION', `The candidate batch is no longer current (${pairing}).`)
    return z.json().parse({
      purpose,
      candidates: proposals.length,
      status: 'proposed',
      observation_id: observationId,
      source_revision: state.revision,
      candidate_ids: proposals.map(proposal => proposal.proposalId),
      proposals: proposals.map(proposal => ({
        id: proposal.proposalId,
        category: proposal.category,
        note: proposal.note,
        confidence: proposal.confidence,
        geometry: proposal.geometry,
      })),
      limitations: meta.record.limitations,
      must_confirm: false,
      meta: JSON.parse(JSON.stringify(meta)) as JsonValue,
    })
  },
})
