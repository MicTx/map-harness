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
import type { SymbolStyle } from '@map-harness/map-layers'
import {
  MapChangeValidationError,
  validateMapChangeCandidate,
  type MapChange,
  type MapProjectionState,
} from './protocol.ts'

/** Message source kind of a user map change notice. */
export const MAP_USER_CHANGE_SOURCE = 'map-user-change'

/** Text marker separating the summary from the change JSON. */
export const MAP_USER_CHANGE_MARKER = '[map-user-change v1]'

/** Upper bound on one serialized change notice, in UTF-8 bytes. */
export const MAX_USER_CHANGE_BYTES = 16 * 1024

/** Most layers one user change may address. */
const MAX_USER_CHANGE_ENTRIES = 32

/**
 * The change vocabulary the panel may write directly. Data additions,
 * styles from free JSON, view, AOI, and export stay with the model tools.
 */
export type MapUserChange =
  | { readonly op: 'set-layer-state'; readonly states: readonly { readonly layerId: string; readonly visible?: boolean; readonly opacity?: number; readonly group?: string | null }[] }
  | { readonly op: 'reorder-layers'; readonly layerIds: readonly string[] }
  | { readonly op: 'remove-layer'; readonly layerId: string }
  | { readonly op: 'set-symbol-preset'; readonly layerId: string; readonly preset: string }

/** One durable user change: the operation identity, the target revision, and the change. */
export interface MapUserChangeRecord {
  readonly operationId: string
  readonly targetRevision: number
  readonly change: MapUserChange
}

const layerId = z.string().min(1).max(128)

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
])

const userChangeRecordSchema = z.object({
  operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/u),
  targetRevision: z.number().int().nonnegative(),
  change: userChangeSchema,
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
export type UserChangeRefusal = 'invalid-change' | 'stale-revision' | 'layer-unknown' | 'preset-unknown' | 'oversized'

/**
 * Lower one user change into the projection change vocabulary.
 * @param change - the validated user change.
 * @param resolvePreset - preset id to symbol resolver.
 * @returns the projection change, or the refusal code.
 */
export function lowerUserChange(change: MapUserChange, resolvePreset: PresetResolver): MapChange | 'preset-unknown' {
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
export function admitUserChange(state: MapProjectionState, record: MapUserChangeRecord, resolvePreset: PresetResolver): { readonly ok: true; readonly change: MapChange } | { readonly ok: false; readonly code: UserChangeRefusal } {
  if (record.targetRevision !== state.revision) return { ok: false, code: 'stale-revision' }
  const lowered = lowerUserChange(record.change, resolvePreset)
  if (lowered === 'preset-unknown') return { ok: false, code: 'preset-unknown' }
  const ids = new Set(state.layers.map(layer => layer.id))
  const named = record.change.op === 'set-layer-state'
    ? record.change.states.map(entry => entry.layerId)
    : record.change.op === 'reorder-layers' ? record.change.layerIds : [record.change.layerId]
  if (named.some(id => !ids.has(id))) return { ok: false, code: 'layer-unknown' }
  try {
    validateMapChangeCandidate(state, lowered)
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
  const text = `${summary}\n${MAP_USER_CHANGE_MARKER}\n${JSON.stringify(record)}`
  return new TextEncoder().encode(text).byteLength > MAX_USER_CHANGE_BYTES ? undefined : text
}

/**
 * Read the record back from one notice text.
 * @param text - the notice text block.
 * @returns the record, or `undefined` when the text carries none.
 */
export function userChangeOfNoticeText(text: string): MapUserChangeRecord | undefined {
  const at = text.indexOf(`\n${MAP_USER_CHANGE_MARKER}\n`)
  if (at === -1) return undefined
  try {
    return parseUserChangeRecord(JSON.parse(text.slice(at + MAP_USER_CHANGE_MARKER.length + 2)))
  } catch {
    // A notice whose JSON does not parse carries no change.
    return undefined
  }
}
