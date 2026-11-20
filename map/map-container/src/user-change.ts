/**
 * User map changes: the browser's direct write path. The layer panel posts a
 * bounded change; the host route validates it against the accepted state and
 * delivers it as one `map-user-change` notice into the agent inbox without
 * waking the model. The `mapContainer` fold applies the notice when the
 * inbox insertion commits, so the map updates immediately, and the same
 * message later reaches the model when a turn claims it. The notice text is
 * both the model-facing account and the fold input: a summary line followed
 * by the marker and the change JSON.
 */
import { z } from 'zod'
import { parseBasemapSelection, parseBasemapSource, validateSymbolStyle, type BasemapSelection, type SymbolStyle } from '@map-harness/map-layers'
import { isWaybackComparison, type WaybackComparison } from './wayback-comparison.ts'
import {
  MapChangeValidationError,
  USER_ANNOTATION_LAYER_ID,
  VISUAL_PROPOSAL_LAYER_ID,
  validateAnnotationGeometry,
  validateMapChangeCandidate,
  settleUserChange,
  withWaybackComparison,
  type AnnotationGeometry,
  type AnnotationUserChange,
  type VisualProposalUserChange,
  type VisualChangeUserChange,
  type MapChange,
  type MapProjectionState,
  type ImageryDisplayState,
} from './protocol.ts'
import { waybackReleaseOf } from './wayback.ts'
import type { MapViewRecord } from './registry.ts'

/** Message source kind of a user map change notice. */
export const MAP_USER_CHANGE_SOURCE = 'map-user-change'

/** Current text marker separating the summary from the full-scope change JSON. */
export const MAP_USER_CHANGE_MARKER = '[map-user-change v5]'
/** Current notice marker carrying the v7 imagery display change vocabulary. */
export const MAP_USER_CHANGE_MARKER_V7 = '[map-user-change v7 imagery]'
/** Notice marker carrying the durable settled-camera view record. */
export const MAP_USER_CHANGE_MARKER_V8 = '[map-user-change v8 view]'

/** Current marker for the versioned visual-change decision vocabulary. */
export const MAP_VISUAL_CHANGE_USER_MARKER = '[map-user-change v6 visual-change]'

/** Historical markers; v3 records may carry annotation operations and v4 may carry the prepared Wayback pair. */
const MAP_USER_CHANGE_MARKER_V2 = '[map-user-change v2]'
const MAP_USER_CHANGE_MARKER_V1 = '[map-user-change v1]'
const MAP_USER_CHANGE_MARKER_V3 = '[map-user-change v3]'
const MAP_USER_CHANGE_MARKER_V4 = '[map-user-change v4]'

/** Upper bound on one serialized change notice, in UTF-8 bytes. */
export const MAX_USER_CHANGE_BYTES = 16 * 1024

/** Most layers one user change may address. */
const MAX_USER_CHANGE_ENTRIES = 32

/**
 * The change vocabulary the panel and the settled-camera channel may write
 * directly. Data additions, styles from free JSON, AOI, and export stay with
 * the model tools; `set-view` carries a settled display camera so the final
 * view survives session switching and reload.
 */
export type MapUserChange =
  | { readonly op: 'set-layer-state'; readonly states: readonly { readonly layerId: string; readonly visible?: boolean; readonly opacity?: number; readonly group?: string | null }[] }
  | { readonly op: 'reorder-layers'; readonly layerIds: readonly string[] }
  | { readonly op: 'remove-layer'; readonly layerId: string }
  | { readonly op: 'set-symbol-preset'; readonly layerId: string; readonly preset: string }
  | { readonly op: 'set-symbol-style'; readonly layerId: string; readonly symbol: SymbolStyle }
  | { readonly op: 'set-basemap'; readonly selection: BasemapSelection }
  | { readonly op: 'set-imagery-display'; readonly display: ImageryDisplayState }
  | { readonly op: 'set-wayback-comparison'; readonly pair: WaybackComparison }
  | { readonly op: 'set-view'; readonly view: MapViewRecord }
  | AnnotationUserChange
  | VisualProposalUserChange
  | VisualChangeUserChange

/** A lowered change the map projection can settle, including annotation-only vocabulary. */
export type MapProjectionUserChange = MapChange | AnnotationUserChange | VisualProposalUserChange | VisualChangeUserChange


/** One durable user change: the operation identity, the target revision, and the change. */
export interface MapUserChangeRecord {
  readonly operationId: string
  readonly targetRevision: number
  readonly change: MapUserChange
  readonly sessionId?: string
  readonly at?: string
  readonly featureId?: string
}

const layerId = z.string().min(1).max(128)
const annotationText = z.string().max(512).refine(value => !/[\u0000-\u001f\u007f-\u009f]/u.test(value))
const annotationName = annotationText.trim().min(1).max(96)
const annotationDescription = annotationText.max(512)
const annotationGeometry = z.custom<AnnotationGeometry>(value => {
  try {
    validateAnnotationGeometry(value as AnnotationGeometry)
    return true
  } catch {
    return false
  }
})
const annotationSymbol = z.custom<SymbolStyle>(value => validateSymbolStyle(value).length === 0)
const annotationFeatureId = z.string().regex(/^ann-[0-9a-f]{24}$/u)
const viewRecord = z.object({
  center: z.tuple([z.number(), z.number()]),
  zoom: z.number(),
  wkid: z.number().int(),
  scale: z.number().finite().positive().optional(),
  rotation: z.number().finite().optional(),
}).strict()
const imageryDisplay = z.custom<ImageryDisplayState>(value => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const keys = ['labelsVisible', 'recentVisible', 'recentOpacity', 'earlyVisible', 'earlySource']
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) return false
  if (typeof record.labelsVisible !== 'boolean' || typeof record.recentVisible !== 'boolean'
    || typeof record.earlyVisible !== 'boolean' || typeof record.recentOpacity !== 'number'
    || !Number.isFinite(record.recentOpacity) || record.recentOpacity < 0 || record.recentOpacity > 1) return false
  if (record.earlySource !== null) {
    const parsed = parseBasemapSource(record.earlySource)
    if (!parsed.ok || parsed.value.role !== 'basemap' || waybackReleaseOf(parsed.value) === null) return false
  }
  return !record.earlyVisible || record.earlySource !== null
})

const userChangeSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('set-layer-state'),
    states: z.array(z.object({
      layerId,
      visible: z.boolean().optional(),
      opacity: z.number().min(0).max(1).optional(),
      group: z.string().trim().min(1).max(64).nullable().optional(),
    }).strict()).min(1).max(MAX_USER_CHANGE_ENTRIES),
  }).strict(),
  z.object({ op: z.literal('reorder-layers'), layerIds: z.array(layerId).min(1).max(MAX_USER_CHANGE_ENTRIES) }).strict(),
  z.object({ op: z.literal('remove-layer'), layerId }).strict(),
  z.object({ op: z.literal('set-symbol-preset'), layerId, preset: z.string().min(1).max(128) }).strict(),
  z.object({ op: z.literal('set-symbol-style'), layerId, symbol: annotationSymbol }).strict(),
  z.object({
    op: z.literal('set-basemap'),
    selection: z.custom<BasemapSelection>(value => parseBasemapSelection(value).ok),
  }).strict(),
  z.object({
    op: z.literal('set-imagery-display'),
    display: imageryDisplay,
  }).strict(),
  z.object({
    op: z.literal('set-wayback-comparison'),
    pair: z.custom<WaybackComparison>(isWaybackComparison),
  }).strict(),
  z.object({
    op: z.literal('set-view'),
    view: viewRecord,
  }).strict(),
  z.object({
    op: z.literal('annotation-create'),
    geometry: annotationGeometry,
    name: annotationName,
    description: annotationDescription.optional(),
    symbol: annotationSymbol.optional(),
  }).strict(),
  z.object({
    op: z.literal('annotation-update'),
    featureId: annotationFeatureId,
    expectedUpdatedAt: z.string().datetime(),
    geometry: annotationGeometry.optional(),
    name: annotationName.optional(),
    description: annotationDescription.optional(),
    symbol: annotationSymbol.nullable().optional(),
  }).strict().refine(value => value.geometry !== undefined || value.name !== undefined
    || Object.hasOwn(value, 'description') || Object.hasOwn(value, 'symbol'), {
      message: 'annotation-update needs one mutable field',
    }),
  z.object({
    op: z.literal('annotation-delete'),
    featureIds: z.array(annotationFeatureId).min(1).max(64),
  }).strict().refine(value => new Set(value.featureIds).size === value.featureIds.length, {
    message: 'annotation-delete feature ids must be unique',
  }),
  z.object({
    op: z.literal('annotation-undo'),
    operationId: z.string().min(1).max(96),
  }).strict(),
  z.object({
    op: z.literal('visual-proposal-accept'),
    proposalId: z.string().regex(/^vprop-[0-9a-f]{24}$/u),
    expectedRevision: z.number().int().nonnegative(),
    name: annotationName.optional(),
    description: annotationDescription.optional(),
    geometry: annotationGeometry.optional(),
  }).strict(),
  z.object({
    op: z.literal('visual-proposal-reject'),
    proposalId: z.string().regex(/^vprop-[0-9a-f]{24}$/u),
    expectedRevision: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    op: z.literal('visual-change-accept'),
    changeId: z.string().regex(/^vchange-[0-9a-f]{24}$/u),
    expectedRevision: z.number().int().nonnegative(),
    name: annotationName.optional(),
    description: annotationDescription.optional(),
    geometry: annotationGeometry.optional(),
  }).strict(),
  z.object({
    op: z.literal('visual-change-reject'),
    changeId: z.string().regex(/^vchange-[0-9a-f]{24}$/u),
    expectedRevision: z.number().int().nonnegative(),
  }).strict(),
])

const userChangeRecordSchema = z.object({
  operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/u),
  targetRevision: z.number().int().nonnegative(),
  change: userChangeSchema,
  sessionId: z.string().min(1).max(128).optional(),
  at: z.string().datetime().optional(),
  featureId: annotationFeatureId.optional(),
}).strict()

/**
 * Parse one untrusted user change record.
 * @param value - the decoded JSON body or notice payload.
 * @returns the record, or `undefined` when it violates the vocabulary or bounds.
 */
export function parseUserChangeRecord(value: unknown): MapUserChangeRecord | undefined {
  const parsed = userChangeRecordSchema.safeParse(value)
  return parsed.success ? parsed.data as MapUserChangeRecord : undefined
}

/** Resolve a preset id into its symbol; injected so the protocol keeps no preset table. */
export type PresetResolver = (preset: string) => SymbolStyle | undefined

/** Refusal codes a user change can produce. */
export type UserChangeRefusal = 'invalid-change' | 'stale-revision' | 'layer-unknown' | 'preset-unknown' | 'oversized' | 'annotation-limit' | 'geometry-invalid' | 'annotation-unknown' | 'annotation-protected' | 'visual-proposal-unknown' | 'visual-change-unknown' | 'visual-proposal-protected'

/** Whether one change belongs to the user-owned visual-proposal decision vocabulary. */
function isVisualProposalChange(change: MapUserChange): change is VisualProposalUserChange {
  return change.op === 'visual-proposal-accept' || change.op === 'visual-proposal-reject'
}

/** Whether one change belongs to the user-owned visual-change decision vocabulary. */
function isVisualChangeDecision(change: MapUserChange): change is VisualChangeUserChange {
  return change.op === 'visual-change-accept' || change.op === 'visual-change-reject'
}

/**
 * Lower one user change into the projection change vocabulary.
 * @param change - the validated user change.
 * @param resolvePreset - preset id to symbol resolver.
 * @returns the projection change, or the refusal code.
 */
export function lowerUserChange(change: MapUserChange, resolvePreset: PresetResolver): MapProjectionUserChange | 'preset-unknown' {
  if (isVisualProposalChange(change) || isVisualChangeDecision(change) || change.op === 'annotation-create' || change.op === 'annotation-update'
    || change.op === 'annotation-delete' || change.op === 'annotation-undo') return change
  switch (change.op) {
    case 'set-layer-state':
      return { op: 'set-layer-state', states: change.states.map(entry => ({ ...entry })) }
    case 'reorder-layers':
      return { op: 'reorder-layers', layerIds: [...change.layerIds] }
    case 'remove-layer':
      return { op: 'remove-layer', layerId: change.layerId }
    case 'set-symbol-preset': {
      const symbol = resolvePreset(change.preset)
      if (symbol === undefined) return 'preset-unknown'
      return { op: 'set-symbol-style', entries: [{ layerId: change.layerId, symbol }] }
    }
    case 'set-symbol-style':
      return { op: 'set-symbol-style', entries: [{ layerId: change.layerId, symbol: change.symbol }] }
    case 'set-basemap':
      return { op: 'set-basemap', selection: change.selection }
    case 'set-imagery-display':
      return { op: 'set-imagery-display', display: change.display }
    case 'set-wayback-comparison':
      return 'preset-unknown'
    case 'set-view':
      return { op: 'set-view', view: change.view }
  }
}

/**
 * Check one record against the accepted state: revision, then the shared
 * candidate validation every model change passes.
 * @param state - the accepted projection state.
 * @param record - the parsed record.
 * @param resolvePreset - preset id to symbol resolver.
 * @returns the lowered change, or the refusal code.
 */
export function admitUserChange(state: MapProjectionState, record: MapUserChangeRecord, resolvePreset: PresetResolver): { readonly ok: true; readonly change: MapProjectionUserChange } | { readonly ok: false; readonly code: UserChangeRefusal } {
  if (record.targetRevision !== state.revision) return { ok: false, code: 'stale-revision' }
  if (record.change.op === 'set-wayback-comparison') {
    if (withWaybackComparison(state, record.change.pair, record.operationId, Number.MAX_SAFE_INTEGER) === undefined) {
      return { ok: false, code: 'oversized' }
    }
    return { ok: true, change: { op: 'set-basemap', selection: state.basemap } }
  }
  const lowered = lowerUserChange(record.change, resolvePreset)
  if (lowered === 'preset-unknown') return { ok: false, code: 'preset-unknown' }
  if (isVisualProposalChange(lowered as MapUserChange) || isVisualChangeDecision(lowered as MapUserChange)) {
    const probed = settleUserChange(state, {
      seq: Number.MAX_SAFE_INTEGER,
      operationId: record.operationId,
      targetRevision: record.targetRevision,
      change: lowered,
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      ...(record.at === undefined ? {} : { at: record.at }),
      ...(record.featureId === undefined ? {} : { featureId: record.featureId }),
    })
    return probed.revision === state.revision
      ? { ok: false, code: probed.diagnostics.at(-1)?.code === 'stale-revision' ? 'stale-revision'
        : isVisualChangeDecision(lowered as MapUserChange) ? 'visual-change-unknown' : 'visual-proposal-unknown' }
      : { ok: true, change: lowered }
  }
  if (lowered.op === 'annotation-create' || lowered.op === 'annotation-update'
    || lowered.op === 'annotation-delete' || lowered.op === 'annotation-undo') {
    const probed = settleUserChange(state, {
      seq: Number.MAX_SAFE_INTEGER,
      operationId: record.operationId,
      targetRevision: record.targetRevision,
      change: lowered,
      ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
      ...(record.at === undefined ? {} : { at: record.at }),
      ...(record.featureId === undefined ? {} : { featureId: record.featureId }),
    })
    if (probed.revision === state.revision) {
      const code = probed.diagnostics.at(-1)?.code
      return {
        ok: false,
        code: code === 'annotation-limit' || code === 'geometry-invalid' || code === 'annotation-unknown'
          || code === 'annotation-protected' || code === 'stale-revision' ? code : 'invalid-change',
      }
    }
    return { ok: true, change: lowered }
  }
  const change = record.change
  const annotationLayerPresent = state.layers.some(layer => layer.id === USER_ANNOTATION_LAYER_ID)
  const ids = new Set(state.layers.filter(layer => layer.role !== 'user-annotation' && layer.role !== 'visual-proposal' && layer.role !== 'visual-change').map(layer => layer.id))
  const namedIds = change.op === 'set-layer-state'
      ? change.states.map(entry => entry.layerId)
      : change.op === 'reorder-layers' ? change.layerIds
          : change.op === 'set-basemap' || change.op === 'set-imagery-display' || change.op === 'set-view' || change.op === 'annotation-create' || change.op === 'annotation-update'
          || change.op === 'annotation-delete' || change.op === 'annotation-undo' || isVisualProposalChange(change) || isVisualChangeDecision(change) ? []
          : [change.layerId]
  if (namedIds.includes(USER_ANNOTATION_LAYER_ID)) return { ok: false, code: 'annotation-protected' }
  if (namedIds.includes(VISUAL_PROPOSAL_LAYER_ID)) return { ok: false, code: 'visual-proposal-protected' }
  if (namedIds.some(id => !ids.has(id))) return { ok: false, code: 'layer-unknown' }
  if (change.op === 'reorder-layers' && annotationLayerPresent && change.layerIds.includes(USER_ANNOTATION_LAYER_ID)) {
    return { ok: false, code: 'annotation-protected' }
  }
  try {
    validateMapChangeCandidate(state, lowered as MapChange)
  } catch (error) {
    if (error instanceof MapChangeValidationError) {
      return { ok: false, code: error.code === 'oversized-meta' ? 'oversized' : error.code === 'layer-unknown' || error.code === 'style-layer-unknown' ? 'layer-unknown' : 'invalid-change' }
    }
    throw error
  }
  return { ok: true, change: lowered }
}

/**
 * Serialize one notice text: a model-readable summary line, then the marker
 * and the record JSON on its own line.
 * @param summary - the one-line account of the change, in the user's locale.
 * @param record - the admitted record.
 * @returns the notice text, or `undefined` beyond the byte bound.
 */
export function userChangeNoticeText(summary: string, record: MapUserChangeRecord): string | undefined {
  const marker = record.change.op === 'set-wayback-comparison' ? MAP_USER_CHANGE_MARKER_V4
    : record.change.op === 'set-imagery-display' ? MAP_USER_CHANGE_MARKER_V7
    : record.change.op === 'set-view' ? MAP_USER_CHANGE_MARKER_V8
    : isVisualChangeDecision(record.change) ? MAP_VISUAL_CHANGE_USER_MARKER
      : isVisualProposalChange(record.change) ? MAP_USER_CHANGE_MARKER
      : record.change.op === 'annotation-create' || record.change.op === 'annotation-update'
      || record.change.op === 'annotation-delete' || record.change.op === 'annotation-undo'
        ? MAP_USER_CHANGE_MARKER_V3
        : MAP_USER_CHANGE_MARKER_V2
  const text = `${summary}\n${marker}\n${JSON.stringify(record)}`
  return new TextEncoder().encode(text).byteLength > MAX_USER_CHANGE_BYTES ? undefined : text
}

/**
 * Read the record back from one notice text.
 * @param text - the notice text block.
 * @returns the record, or `undefined` when the text carries none.
 */
export function userChangeOfNoticeText(text: string): MapUserChangeRecord | undefined {
  const marker = [MAP_VISUAL_CHANGE_USER_MARKER, MAP_USER_CHANGE_MARKER_V7, MAP_USER_CHANGE_MARKER_V8, MAP_USER_CHANGE_MARKER, MAP_USER_CHANGE_MARKER_V4, MAP_USER_CHANGE_MARKER_V3, MAP_USER_CHANGE_MARKER_V2, MAP_USER_CHANGE_MARKER_V1]
    .find(candidate => text.includes(`\n${candidate}\n`))
  if (marker === undefined) return undefined
  const at = text.indexOf(`\n${marker}\n`)
  if (at === -1) return undefined
  try {
    const record = parseUserChangeRecord(JSON.parse(text.slice(at + marker.length + 2)))
    if (record === undefined) return undefined
    if (marker === MAP_USER_CHANGE_MARKER_V4 && record.change.op !== 'set-wayback-comparison') return undefined
    if (marker !== MAP_USER_CHANGE_MARKER_V4 && record.change.op === 'set-wayback-comparison') return undefined
    if (marker === MAP_USER_CHANGE_MARKER_V7 && record.change.op !== 'set-imagery-display') return undefined
    if (marker !== MAP_USER_CHANGE_MARKER_V7 && record.change.op === 'set-imagery-display') return undefined
    if (marker === MAP_USER_CHANGE_MARKER_V8 && record.change.op !== 'set-view') return undefined
    if (marker !== MAP_USER_CHANGE_MARKER_V8 && record.change.op === 'set-view') return undefined
    if (marker === MAP_VISUAL_CHANGE_USER_MARKER && !isVisualChangeDecision(record.change)) return undefined
    if (marker !== MAP_VISUAL_CHANGE_USER_MARKER && isVisualChangeDecision(record.change)) return undefined
    if (marker !== MAP_USER_CHANGE_MARKER && isVisualProposalChange(record.change)) return undefined
    if (marker !== MAP_USER_CHANGE_MARKER && marker !== MAP_USER_CHANGE_MARKER_V3 && record.change.op.startsWith('annotation-')) return undefined
    return record
  } catch {
    // A notice whose JSON does not parse carries no change.
    return undefined
  }
}
