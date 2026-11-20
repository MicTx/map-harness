/**
 * Shared V7 fixture: two accepted Wayback observations in one session, real
 * saved PNG bytes, and the host faces the MCP tools/call handler resolves.
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import { mapRig } from '../../map-container/tests/map-rig.mjs'
import { waybackDescriptor } from '../../map-container/src/wayback.ts'
import { parseBasemapSelection } from '../../layers/src/basemap.ts'
import {
  buildMapChangeMeta,
  buildMapObservationMeta,
  expectedObservationSources,
  observationCompositionOf,
} from '../../map-container/src/index.ts'

const sha = value => createHash('sha256').update(value).digest('hex')
const realPng = async (red, green, blue) => await sharp({
  create: { width: 8, height: 4, channels: 3, background: { r: red, g: green, b: blue } },
}).png().toBuffer()
const camera = {
  center: [104.9, 36.4], extent: [100, 32, 109.8, 40.8], wkid: 4326,
  scale: 50000, zoom: 6, rotation: 0, mode: 'map', padding: [0, 0, 0, 0],
}
const georeference = {
  kind: 'affine-2d', coefficients: [0.01, 0, 100, 0, -0.01, 40.8], wkid: 4326, maxResidualCssPx: 0,
}
const composition = observationCompositionOf([])

const release = (releaseId, publishedAt) => {
  const descriptor = waybackDescriptor({
    releaseId, itemId: `${releaseId}`.padEnd(32, '0'),
    title: `World Imagery (Wayback ${publishedAt.slice(0, 10)})`,
    publishedAt, layerIdentifier: `WB_${releaseId}_R01`, acquiredAt: null,
  })
  const parsed = parseBasemapSelection({ schemaVersion: 1, basemap: descriptor, labels: null })
  if (!parsed.ok) throw new Error('fixture Wayback selection must parse')
  return parsed.value
}

const attachment = (id, bytes) => ({
  attachmentId: id, mediaType: 'image/png', bytes: bytes.length,
  width: 800, height: 600, sha256: sha(bytes),
})

function observation(id, selection, bytes) {
  return {
    observationId: id, callId: id, requestSeq: 3, mapRevision: 0,
    viewId: 'view-1', generation: 1, cameraEpoch: 0, gestureEpoch: 0,
    attachment: attachment(`att-${id}`, bytes),
    capturedAt: '2026-11-10T00:00:00.000Z',
    imageSize: { width: 800, height: 600 },
    mapContentRect: { x: 0, y: 0, width: 800, height: 600 },
    cssViewSize: { width: 800, height: 600 },
    camera, georeference,
    sources: expectedObservationSources([], selection).sources,
    basemap: selection,
    includedOverlays: ['attribution'], limitations: [],
    composition,
  }
}

/**
 * Build a rig whose two observation records and attachment bytes are real
 * enough for the production comparison handler to verify both images.
 * @param {(rig: object) => void} [mutate] - optional post-build mutation.
 * @returns the rig, session, stored PNG bytes, and comparison arguments.
 */
export async function visualChangeMcpPair(mutate = () => {}) {
  const beforePng = await realPng(15, 20, 25)
  const afterPng = await realPng(80, 30, 20)
  const beforeSelection = release(10, '2014-02-20T00:00:00.000Z')
  const afterSelection = release(32246, '2026-01-26T00:00:00.000Z')
  const before = observation('obs-before', beforeSelection, beforePng)
  const after = observation('obs-after', afterSelection, afterPng)
  const rig = await mapRig({ mapConfig: {
    observation: { capturePolicy: 'allow' },
    sources: { presets: { 'esri-world-imagery': { automatedMapUse: 'allowed' }, 'esri-wayback': { automatedMapUse: 'allowed' } } },
  } })
  const session = rig.session('visual-change-mcp-pair')
  for (const [record, selection] of [[before, beforeSelection], [after, afterSelection]]) {
    const basemapCall = rig.call(session, `basemap-${record.callId}`, 'map_set_basemap', { source_id: 'esri-wayback' })
    rig.result(session, basemapCall, { meta: buildMapChangeMeta(basemapCall.seq, rig.state(session).revision, { op: 'set-basemap', selection }) })
    const call = rig.call(session, record.callId, 'map_observe', {})
    const request = rig.state(session).observationRequest
    rig.result(session, call, { meta: buildMapObservationMeta({ ...record, requestSeq: request.requestSeq, mapRevision: request.revision }) })
  }
  const stored = new Map([
    [before.attachment.attachmentId, beforePng],
    [after.attachment.attachmentId, afterPng],
  ])
  const sourceService = rig.ctx.get('mapSourceService')
  const sourceFace = {
    ...sourceService,
    verifySource() {},
    catalog: { ...sourceService.catalog, verifySource() {}, verifyWaybackPolicy() {}, verifyCachedWaybackSource() {} },
  }
  const faceCtx = {
    get: name => name === 'mapSourceService' ? sourceFace : rig.ctx.get(name),
  }
  rig.ctx.effect(() => rig.ctx.reflect.provide('attachments', {
    async readImage(ref, signal) {
      signal?.throwIfAborted()
      const data = stored.get(ref.attachmentId)
      if (data === undefined) throw new Error('missing attachment')
      return { ref, data: new Uint8Array(data) }
    },
  }))
  const pair = {
    rig,
    session,
    stored,
    faceCtx,
    args: {
      before_observation_id: before.observationId,
      after_observation_id: after.observationId,
    },
    expectedUris: [
      `attachment://${before.attachment.attachmentId}`,
      `attachment://${after.attachment.attachmentId}`,
    ],
  }
  mutate(pair)
  return pair
}

/** Add the verified source/model faces required by the production handler. */
export function visualChangeExecution(pair, callId) {
  const execution = pair.rig.exec(pair.session, { callId })
  return {
    ...execution,
    agent: {
      ...execution.agent,
      ctx: pair.faceCtx,
      model: { current: () => ({ provider: 'fixture-provider', model: 'vision-model' }) },
    },
  }
}
