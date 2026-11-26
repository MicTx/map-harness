/** `map_refine_aoi`: replace a pixel-rectangle AOI candidate with real building footprints from the configured source. */
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { buildMapChangeMeta, validateMapChangeCandidate, type GeoJsonFeatureCollection, type MapContainerService, type MapPendingCall, type MapProjectedLayer } from '@map-harness/map-container'
import type { Footprint, FootprintResult, SpatialFootprintsService } from '@map-harness/spatial-connect/src/footprints-contract.ts'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'
import { sessionOf } from './catalog-tools.ts'
import { bboxOf, renderJson } from './output.ts'

const EARTH_RADIUS_M = 6371008.8

/** Relationship of one footprint to the rectangle it refines; `selection` reports both the rule and each result. */
interface Selection {
  readonly id: string
  readonly containsCentroid: boolean
  /** Intersection area of the footprint's bbox with the candidate's bbox, over the footprint's bbox (0..1). */
  readonly overlapRatio: number
}

function bboxOfRing(coordinates: readonly (readonly [number, number])[]): [number, number, number, number] {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const [lon, lat] of coordinates) {
    if (lon < west) west = lon
    if (lat < south) south = lat
    if (lon > east) east = lon
    if (lat > north) north = lat
  }
  return [west, south, east, north]
}

function bboxArea(bbox: readonly [number, number, number, number]): number {
  const [west, south, east, north] = bbox
  return Math.max(0, east - west) * Math.max(0, north - south)
}

function intersection(a: readonly [number, number, number, number], b: readonly [number, number, number, number]): [number, number, number, number] {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
}

/**
 * Rank footprints against the candidate bbox: contains-centroid first, then overlap ratio. Every footprint is
 * returned; nothing is merged or dropped, because the choice of what the facility *is* belongs to the person.
 */
export function selectFootprints(page: FootprintResult, candidate: readonly [number, number, number, number]): Selection[] {
  const centroid: [number, number] = [(candidate[0] + candidate[2]) / 2, (candidate[1] + candidate[3]) / 2]
  const rows = page.data.features.map((footprint): Selection => {
    const ring = footprint.geometry.coordinates[0] ?? []
    const box = bboxOfRing(ring)
    const containsCentroid = centroid[0] >= box[0] && centroid[0] <= box[2] && centroid[1] >= box[1] && centroid[1] <= box[3]
    const area = bboxArea(box)
    const overlap = area === 0 ? 0 : bboxArea(intersection(box, candidate)) / area
    return { id: footprint.properties.id, containsCentroid, overlapRatio: Number.parseFloat(overlap.toFixed(4)) }
  })
  return rows.sort((left, right) => Number(right.containsCentroid) - Number(left.containsCentroid) || right.overlapRatio - left.overlapRatio)
}

/** Square metres of a lon/lat bbox at its mid-latitude; an approximation for ranking and display only. */
export function bboxAreaM2(bbox: readonly [number, number, number, number]): number {
  const [west, south, east, north] = bbox
  const rad = Math.PI / 180
  return (east - west) * rad * EARTH_RADIUS_M * Math.cos((south + north) / 2 * rad) * (north - south) * rad * EARTH_RADIUS_M
}

function layerBbox(layer: MapProjectedLayer): [number, number, number, number] | undefined {
  const box = layer.data === undefined ? null : bboxOf(layer.data)
  return box === null ? undefined : box
}

function footprintsOf(exec: ToolRunContext): SpatialFootprintsService {
  return serviceOf<SpatialFootprintsService>(exec, 'spatialFootprints')
    ?? (() => { throw new SpatialError('REFINE_SOURCE_UNAVAILABLE', 'No building-footprint source is composed; declare spatial-connect footprints.') })()
}

/** Translate a source failure into the tool's stable refusals; the original candidate is never touched on any of them. */
function refuseSource(error: unknown): never {
  if (error instanceof Error && 'code' in error) {
    const code = (error as { code?: string }).code
    if (code === 'FOOTPRINTS_NOT_CONFIGURED') throw new SpatialError('REFINE_SOURCE_UNAVAILABLE', 'No building-footprint source is configured; the candidate is unchanged.')
    if (code === 'FOOTPRINTS_TIMEOUT' || code === 'FOOTPRINTS_UNAVAILABLE' || code === 'FOOTPRINTS_RATE_LIMITED' || code === 'FOOTPRINTS_TOO_LARGE') {
      throw new SpatialError('REFINE_SOURCE_UNAVAILABLE', `The footprint source did not answer (${code.toLowerCase().replace('footprints_', '')}); the candidate is unchanged.`)
    }
    if (code === 'FOOTPRINTS_SOURCE_INVALID') throw new SpatialError('REFINE_SOURCE_INVALID', 'The footprint source refused the query (HTTP 4xx); check the declared endpoint.')
    if (code === 'FOOTPRINTS_INVALID_INPUT') throw new SpatialError('INVALID_ARGUMENT', 'The refinement window is invalid: a bbox of at most 0.05° per side that does not wrap.')
  }
  throw error
}

/** Resolve the accepted `tool/call` this execution pairs with; without it there is no honest `sourceCallSeq`. */
function requirePendingRefine(exec: ToolRunContext, service: MapContainerService, session: ReturnType<typeof sessionOf>): MapPendingCall {
  if (exec.parent !== undefined) throw new Error('map_refine_aoi supports native model-direct calls only')
  exec.signal.throwIfAborted()
  const pending = service.pendingCallOf(session, exec.callId)
  if (pending === undefined) throw new Error('map_refine_aoi requires its accepted tool/call in the session log before execution')
  if (pending.name !== 'map_refine_aoi') throw new Error(`session call ${exec.callId} is paired with tool ${pending.name}, not map_refine_aoi`)
  return pending
}

/** `map_refine_aoi`: fetch building footprints inside a candidate's bbox and propose them as the refined candidate. */
export const mapRefineAoi = defineTool({
  name: 'map_refine_aoi',
  description:
    'Refine a rectangle-approximated AOI candidate with real building footprints. Give the `candidate_id` of an existing '
    + 'candidate layer or an explicit WGS84 `bbox` (at most 0.05° per side). The tool asks the configured footprint source '
    + '(OSM Overpass by default) for buildings in the window and returns every closed footprint ranked by whether it '
    + 'contains the candidate\'s centre and by how much of it overlaps the candidate; it never merges footprints or claims '
    + 'a boundary. The result is one layer of real polygons carrying source, licence, attribution, selection and '
    + 'confidence; the original rectangle is kept and marked superseded. An empty answer is reported as '
    + 'REFINE_NO_FOOTPRINTS with the candidate unchanged — it is not a fallback to the rectangle. Confirmation stays yours.',
  parameters: {
    candidate_id: { type: 'string', description: 'Layer id of the rectangle candidate to refine; its bbox becomes the window.' },
    bbox: { type: 'array', description: 'Explicit [west, south, east, north] WGS84 window instead of a candidate layer; at most 0.05° per side.' },
    building: { type: 'string', description: 'Optional OSM building tag filter (for example `retail` or `commercial`); omitted returns every building.' },
    limit: { type: 'number', description: 'Maximum footprints to return (1-500, default 200).' },
    layer_id: { type: 'string', description: 'Id for the refined layer; defaults to `<candidate>-refined` or `aoi-refined`.' },
    name: { type: 'string', description: 'Display name for the refined layer.' },
    confidence: { type: 'string', description: 'Your confidence in the refinement as the facility boundary: likely | uncertain.' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => renderJson(value),
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    const { candidate_id: candidateId, bbox, building, limit, layer_id: layerId, name, confidence } = args as {
      candidate_id?: string
      bbox?: unknown
      // `args` is the schema's JsonValue view; the body validates every field itself.
      building?: string
      limit?: number
      layer_id?: string
      name?: string
      confidence?: string
    }
    if ((candidateId === undefined) === (bbox === undefined)) {
      throw new SpatialError('INVALID_ARGUMENT', 'Give exactly one of candidate_id or bbox.')
    }
    if (confidence !== undefined && confidence !== 'likely' && confidence !== 'uncertain') {
      throw new SpatialError('INVALID_ARGUMENT', 'confidence must be likely or uncertain.')
    }
    const session = sessionOf(exec)
    const map = serviceOf<MapContainerService>(exec, 'map')
    if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'the map container service is unavailable in this process')
    const state = map.stateOf(session)

    let window: [number, number, number, number]
    let refines: string | null = null
    if (candidateId !== undefined) {
      const layer = state.layers.find(entry => entry.id === candidateId)
      if (layer === undefined) throw new SpatialError('INVALID_ARGUMENT', `No layer with id ${candidateId} exists in this session.`)
      const box = layerBbox(layer)
      if (box === undefined) throw new SpatialError('INVALID_ARGUMENT', `Layer ${candidateId} carries no feature geometry to refine.`)
      window = box
      refines = candidateId
    } else {
      if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(value => typeof value === 'number' && Number.isFinite(value))) {
        throw new SpatialError('INVALID_ARGUMENT', 'bbox must be four finite numbers [west, south, east, north].')
      }
      window = bbox as [number, number, number, number]
    }

    exec.signal.throwIfAborted()
    let page: FootprintResult
    try {
      page = await footprintsOf(exec).footprints({ kind: 'footprints', bbox: window, ...(building === undefined ? {} : { building }), ...(limit === undefined ? {} : { limit }) }, exec.signal)
    } catch (error) {
      refuseSource(error)
    }
    exec.signal.throwIfAborted()
    if (page.data.features.length === 0) {
      throw new SpatialError('REFINE_NO_FOOTPRINTS', `The footprint source maps no building inside the window (${page.attribution}); the candidate is unchanged.`)
    }

    const selection = selectFootprints(page, window)
    const rankOf = new Map(selection.map((row, index) => [row.id, { ...row, rank: index + 1 }]))
    // The replacement link rides the refined layer itself (per feature), so it is durable without a second change:
    // one tool call carries one change, and the original rectangle is kept as drawn — not edited, not removed.
    const features: Footprint[] = page.data.features.map(footprint => ({
      ...footprint,
      properties: { ...footprint.properties, ...rankOf.get(footprint.properties.id), ...(refines === null ? {} : { refines }) },
    })) as Footprint[]

    const pending = requirePendingRefine(exec, map, session)
    const refinedId = layerId ?? `${refines ?? 'aoi'}-refined`
    const refined: MapProjectedLayer = {
      id: refinedId,
      name: name ?? `${refines ?? 'AOI'} (refined footprints)`,
      sourceCrs: 'EPSG:4326',
      opacity: 0.85,
      visible: true,
      sourceCallSeq: pending.callSeq,
      data: { type: 'FeatureCollection', features } as unknown as GeoJsonFeatureCollection,
    }
    const styledRefined = refined
    const change = { op: 'add-layer', layer: styledRefined } as const
    const targetRevision = validateMapChangeCandidate(state, change)
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))

    const result = {
      layer: { id: styledRefined.id, name: styledRefined.name, feature_count: features.length },
      refines: refines,
      superseded: refines === null ? [] : [refines],
      selection_rule: 'ranked by contains-candidate-centroid, then overlap ratio of the footprint with the candidate window; every footprint returned, none merged',
      selection: selection.map(row => ({ id: row.id, rank: rankOf.get(row.id)!.rank, contains_centroid: row.containsCentroid, overlap_ratio: row.overlapRatio })),
      source: { provider: page.provider, endpoint: 'configured footprint source', licence: page.licence, attribution: page.attribution, retrieved_at: page.retrievedAt },
      confidence: confidence ?? 'uncertain',
      limitations: page.limitations,
      note: 'Footprints are a candidate, not a confirmed boundary; accept or dismiss them in the layer panel.',
      meta,
    }
    // The output schema is json; the round-trip drops undefined-valued keys exactly as the wire would.
    return JSON.parse(JSON.stringify(result)) as JsonValue
  },
})
