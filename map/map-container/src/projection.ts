/**
 * The `mapContainer` session projection: a pure synchronous fold of
 * `tool/call` and `tool/result` events for the map tools into the container
 * state the browser tab renders — and, since P0a, the single authoritative
 * map state of the process.
 *
 * The session log is the durable source of truth: a mutation's successful
 * `tool/result` carries the versioned `map-change` meta (`tool/result.meta`),
 * and the fold pairs it with the `tool/call` that seeded the pending entry.
 * Only successful, paired, first-settled results apply; everything else
 * leaves the map unchanged (see {@link settleMapResult}). The persisted state
 * is plain JSON (ordered arrays, never `Map`/`Set`) so the projection cache
 * can checkpoint it; `stateVersion` 3 discards the pre-P0a Map-based cache
 * rows, which refold from the raw log. Pre-P0a flat metas decode through the
 * dedicated legacy path so old logs replay unchanged.
 *
 * @module @map-harness/map-container/projection
 */
import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { StyleSpec } from '@map-harness/spatial-viz'
import type { MapLayerStream, MapLayerTerrain } from './registry.ts'
import { isSupportedDisplayWkid } from '@map-harness/spatial-catalog'
import {
  MAP_MUTATION_TOOL_NAMES,
  MAP_PROJECTION_STATE_VERSION,
  MAX_MAP_DIAGNOSTICS,
  MAX_PENDING_MAP_CALLS,
  initialMapProjectionState,
  mapProjectionStateSchema,
  settleMapResult,
  type MapDiagnostic,
  type MapMutationName,
  type MapPendingCall,
  type MapProjectionState,
} from './protocol.ts'

/** One folded layer: the durable projection of a successful `map_add_layer` result's metadata. */
export interface ProjectedLayer {
  readonly id: string
  readonly name: string
  readonly featureCount: number
  readonly sourceCrs: string
  readonly visible: boolean
  readonly opacity: number
  /** The GeoJSON the browser renders; WGS84 lon/lat per the coordinate exchange format. */
  readonly data: unknown
  /** The rendered-identity digest (P0b), when the tool supplied one. */
  readonly displayDigest?: string
  /** Exact artifact ref (P0b), when the layer renders a published artifact. */
  readonly artifactRef?: string
  /** Exact resource ref (P0b), when the layer renders catalog data. */
  readonly resourceRef?: string
  /** Minimal single-symbol legend (P0b), when the layer carries one. */
  readonly legend?: { title: string; symbol: { color: string; outline: string } }
  /** The classification style (P3 visualization), when `viz_classify`/`viz_compare` styled the layer. */
  readonly style?: StyleSpec
  /** The terrain identity (terrain preview), when the layer is bound to one surface version. */
  readonly terrain?: MapLayerTerrain
  /** The realtime stream identity (stream workbench), when the layer drives one. */
  readonly stream?: MapLayerStream
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    mapContainer: MapProjectionState
  }
  interface SessionProjectionMap {
    /** The client-visible container view (each layer carries its WGS84 GeoJSON for rendering). */
    mapContainer: {
      layers: ProjectedLayer[]
      view: { center: [number, number]; zoom: number; wkid: number }
      mode: 'map' | 'scene'
      aoi: { name?: string; ring: [number, number][] } | null
      revision: number
      operations: { index: number; operationId: string | null; undoOf: number | null; writerId: string | null; revision: number; summary: string }[]
    }
  }
}

const MUTATION_NAMES: readonly string[] = MAP_MUTATION_TOOL_NAMES

/** How many operation summaries the wire exposes to the browser history face. */
const WIRE_OPERATION_SUMMARIES = 12

const wireSchema = z.object({
  layers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    featureCount: z.number().int().nonnegative(),
    sourceCrs: z.string(),
    visible: z.boolean(),
    opacity: z.number(),
    data: z.unknown(),
    displayDigest: z.string().optional(),
    artifactRef: z.string().optional(),
    resourceRef: z.string().optional(),
    legend: z.object({
      title: z.string(),
      symbol: z.object({ color: z.string(), outline: z.string() }).strict(),
    }).strict().optional(),
    style: z.unknown().optional(),
    terrain: z.object({
      surfaceRef: z.string(),
      revision: z.string(),
      verticalDatum: z.string(),
      verticalUnits: z.string(),
      epoch: z.string(),
      elevationField: z.string(),
      gridColumns: z.number().int().positive(),
      gridRows: z.number().int().positive(),
      sourcePointCount: z.number().int().positive(),
    }).strict().optional(),
    stream: z.unknown().optional(),
  })).max(32),
  view: z.object({
    center: z.tuple([z.number(), z.number()]),
    zoom: z.number(),
    wkid: z.number().int().check((value) => {
      if (!isSupportedDisplayWkid(value.value)) value.issues.push({ code: 'custom', message: `unsupported display WKID ${value.value}`, input: value.value, path: [] })
    }),
  }),
  mode: z.union([z.literal('map'), z.literal('scene')]),
  aoi: z.object({
    name: z.string().optional(),
    ring: z.array(z.tuple([z.number(), z.number()])),
  }).nullable(),
  revision: z.number().int().nonnegative(),
  operations: z.array(z.object({
    index: z.number().int().nonnegative(),
    operationId: z.string().nullable(),
    undoOf: z.number().int().nonnegative().nullable(),
    writerId: z.string().nullable(),
    revision: z.number().int().nonnegative(),
    summary: z.string(),
  })).max(12),
})

/** The `mapContainer` projection unit registered on `ctx.sessionProjections`. */
export const mapContainerProjectionDefinition = {
  key: 'mapContainer',
  stateVersion: MAP_PROJECTION_STATE_VERSION,
  stateSchema: mapProjectionStateSchema,
  init: () => initialMapProjectionState(),
  apply: (state: MapProjectionState, event: SessionEvent): MapProjectionState => {
    if (event.type === 'tool/call') {
      const name = event.data.name
      if (!MUTATION_NAMES.includes(name)) return state
      const entry: MapPendingCall = { callId: event.data.callId, callSeq: event.seq, name: name as MapMutationName }
      if (state.pendingCalls.length + 1 > MAX_PENDING_MAP_CALLS) {
        // Damaged or adversarial logs must not grow pending calls without
        // bound: evict the oldest into a bounded diagnostic; its later result
        // finds no pending entry and settles as unpaired.
        const evicted = state.pendingCalls[0]
        const kept = state.pendingCalls.slice(1)
        const diagnostics: MapDiagnostic[] = evicted === undefined
          ? [...state.diagnostics]
          : [...state.diagnostics, { seq: evicted.callSeq, code: 'pending-overflow' }]
        return {
          ...state,
          pendingCalls: [...kept, entry],
          diagnostics: diagnostics.slice(-MAX_MAP_DIAGNOSTICS),
        }
      }
      return { ...state, pendingCalls: [...state.pendingCalls, entry] }
    }
    if (event.type !== 'tool/result') return state
    let callId: string | undefined = event.data.message.toolCallId
    let resultIsError = event.data.message.isError === true
    if (typeof callId !== 'string') {
      for (const candidate of event.data.message.content) {
        if (typeof candidate !== 'object' || candidate === null) continue
        const block = candidate as { type?: unknown; toolCallId?: unknown; isError?: unknown }
        if (block.type !== 'tool-result' || typeof block.toolCallId !== 'string') continue
        callId = block.toolCallId
        resultIsError = block.isError === true
        break
      }
    }
    if (typeof callId !== 'string') return state
    const index = state.pendingCalls.findIndex(pending => pending.callId === callId)
    if (index === -1) return state
    const pendingCalls = state.pendingCalls.filter((_, at) => at !== index)
    return settleMapResult({ ...state, pendingCalls }, {
      resultSeq: event.seq,
      pending: state.pendingCalls[index] as MapPendingCall,
      isError: resultIsError,
      meta: event.data.meta,
      citedCallSeq: event.sourceEventSeqs === undefined ? undefined : event.sourceEventSeqs[0],
      ...(event.sourceEventSeqs === undefined ? {} : { citedCallSeqs: event.sourceEventSeqs }),
    })
  },
  wire: {
    // The zod-inferred optional props read `T | undefined`; the wire type's
    // exactOptionalPropertyTypes face does not, so the schema is cast to the
    // declared view type (the runtime validation is unchanged).
    viewSchema: wireSchema as unknown as z.ZodType<{
      layers: ProjectedLayer[]
      view: { center: [number, number]; zoom: number; wkid: number }
      mode: 'map' | 'scene'
      aoi: { name?: string; ring: [number, number][] } | null
      revision: number
      operations: { index: number; operationId: string | null; undoOf: number | null; writerId: string | null; revision: number; summary: string }[]
    }>,
    view: (state: MapProjectionState) => ({
      layers: state.layers.map(layer => ({
        id: layer.id,
        name: layer.name,
        featureCount: (layer.data as { features?: unknown[] } | null)?.features?.length ?? 0,
        sourceCrs: layer.sourceCrs ?? 'EPSG:4326',
        visible: layer.visible,
        opacity: layer.opacity,
        data: layer.data,
        ...(layer.displayDigest === undefined ? {} : { displayDigest: layer.displayDigest }),
        ...(layer.artifactRef === undefined ? {} : { artifactRef: layer.artifactRef }),
        ...(layer.resourceRef === undefined ? {} : { resourceRef: layer.resourceRef }),
        ...(layer.legend === undefined ? {} : { legend: layer.legend }),
        ...(layer.style === undefined ? {} : { style: layer.style }),
        ...(layer.terrain === undefined ? {} : { terrain: layer.terrain }),
        ...(layer.stream === undefined ? {} : { stream: layer.stream }),
      })),
      view: { center: [state.view.center[0], state.view.center[1]], zoom: state.view.zoom, wkid: state.view.wkid },
      mode: state.mode,
      aoi: state.aoi === null
        ? null
        : {
            ...(state.aoi.name === undefined ? {} : { name: state.aoi.name }),
            ring: state.aoi.ring.map(point => [point[0], point[1]] as [number, number]),
          },
      revision: state.revision,
      operations: state.operations.slice(-WIRE_OPERATION_SUMMARIES).map(op => ({
        index: op.index,
        operationId: op.operationId,
        undoOf: op.undoOf,
        writerId: op.writerId,
        revision: op.revision,
        summary: op.summary,
      })),
    }),
  },
} satisfies ProjectionDefinition<'mapContainer'>
