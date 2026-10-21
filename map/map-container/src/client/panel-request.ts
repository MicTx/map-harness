/**
 * Panel write channel, protocol half: the `[map-panel v1]` request
 * vocabulary (four ops mirroring the `layer_set_state`/`layer_set_style`/
 * `map_remove_layer`/`data_export` tool parameters one-to-one), its bounded
 * serializer/parser, and the pending book — the advisory local record of
 * submitted-but-unobserved requests (design: panel state changes re-enter
 * through the session queue as user input; the projection stays the single
 * authoritative map state and the panel never pre-stages one).
 *
 * Pure module: no ArcGIS imports, plain data in and out, deterministic under
 * `node --test`. The parsing discipline mirrors `gesture.ts`: foreign text is
 * a quiet `not-panel` miss, unknown versions report explicitly, and the byte
 * cap is enforced before anything is parsed.
 *
 * @module @map-harness/map-container/client/panel-request
 */
import { z } from 'zod'
import { resolveSymbolPreset } from '@map-harness/map-layers'

/** Wire version of the panel request text; the first text line carries it. */
export const PANEL_TEXT_VERSION = 1

/** First-line marker identifying a panel request batch and its wire version. */
export const PANEL_TEXT_MARKER = `[map-panel v${PANEL_TEXT_VERSION}]`

/** Serialized request text byte cap; oversized batches are refused, never truncated. */
export const PANEL_MAX_REQUEST_BYTES = 2048

/** Requests per text; one click is one request, group toggles stay single batches. */
export const PANEL_MAX_REQUESTS_PER_TEXT = 32

/** `set-state` entries per request; aligns with `layer_set_state` and the 32-layer wire cap. */
export const PANEL_MAX_STATE_ENTRIES = 32

/** How long a booked request stays pending before expiring unobserved (ms). */
export const PANEL_PENDING_TTL_MS = 120_000

/** Pending book capacity; overflow drops the oldest entries and counts them. */
export const PANEL_PENDING_CAPACITY = 32

/** The export formats `data_export` produces; the panel vocabulary accepts exactly these. */
export type PanelExportFormat = 'geojson' | 'csv' | 'kml' | 'shapefile'

/** One `set-state` target: a layer id plus at least one presentation field. */
export interface PanelStateEntry {
  /** The wire layer id the entry addresses. */
  readonly id: string
  /** Target visibility. */
  readonly visible?: boolean | undefined
  /** Target opacity in `[0, 1]`. */
  readonly opacity?: number | undefined
  /** Target display group name, 1..64 characters. */
  readonly group?: string | undefined
}

/** One panel request; `op` and parameters mirror the tool call the model transcribes it into. */
export type PanelRequest =
  | { readonly id: string; readonly op: 'set-state'; readonly states: readonly PanelStateEntry[] }
  | { readonly id: string; readonly op: 'set-style'; readonly layer: string; readonly preset: string }
  | { readonly id: string; readonly op: 'remove'; readonly layer: string }
  | { readonly id: string; readonly op: 'export'; readonly layer: string; readonly format: PanelExportFormat }

/** One serialized request batch as it crosses into the session queue. */
export interface PanelRequestMessage {
  readonly version: typeof PANEL_TEXT_VERSION
  readonly sessionId: string
  readonly occurrenceKey: string
  /** The wire revision observed at submit time; advisory — the model may pass it as `expected_revision` or ignore it. */
  readonly revision: number
  readonly requests: readonly PanelRequest[]
  /** ISO timestamp of the batch. */
  readonly at: string
}

const stateEntrySchema = z.object({
  id: z.string().min(1),
  visible: z.boolean().optional(),
  opacity: z.number().min(0).max(1).optional(),
  group: z.string().min(1).max(64).optional(),
}).strict().superRefine((entry, ctx) => {
  if (entry.visible === undefined && entry.opacity === undefined && entry.group === undefined) {
    ctx.addIssue({ code: 'custom', path: ['states'], message: 'entry sets no field' })
  }
})

const layerRef = z.string().min(1)
const requestId = z.string().min(1)

const requestSchema = z.discriminatedUnion('op', [
  z.object({
    id: requestId,
    op: z.literal('set-state'),
    states: z.array(stateEntrySchema).min(1).max(PANEL_MAX_STATE_ENTRIES),
  }).strict().superRefine((request, ctx) => {
    const seen = new Set<string>()
    for (const entry of request.states) {
      if (seen.has(entry.id)) {
        ctx.addIssue({ code: 'custom', path: ['states'], message: `duplicate states entry for layer "${entry.id}"` })
        break
      }
      seen.add(entry.id)
    }
  }),
  z.object({
    id: requestId,
    op: z.literal('set-style'),
    layer: layerRef,
    preset: z.string().min(1).superRefine((preset, ctx) => {
      if (resolveSymbolPreset(preset) === undefined) {
        ctx.addIssue({ code: 'custom', path: ['preset'], message: `unknown preset "${preset}"` })
      }
    }),
  }).strict(),
  z.object({
    id: requestId,
    op: z.literal('remove'),
    layer: layerRef,
  }).strict(),
  z.object({
    id: requestId,
    op: z.literal('export'),
    layer: layerRef,
    format: z.enum(['geojson', 'csv', 'kml', 'shapefile']),
  }).strict(),
])

const messageSchema = z.object({
  version: z.literal(PANEL_TEXT_VERSION),
  sessionId: z.string().min(1),
  occurrenceKey: z.string().min(1),
  revision: z.number().int().nonnegative(),
  requests: z.array(requestSchema).min(1).max(PANEL_MAX_REQUESTS_PER_TEXT),
  at: z.string().datetime(),
}).readonly()

/** Why a text is not a well-formed panel request; `not-panel` is a quiet miss. */
export type PanelParseReason = 'not-panel' | 'unknown-version' | 'invalid-payload' | 'oversized'

/** Discriminated parse outcome for one candidate message text. */
export type PanelParseResult =
  | { readonly ok: true; readonly message: PanelRequestMessage }
  | { readonly ok: false; readonly reason: PanelParseReason }

/** UTF-8 byte length of one string. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Serialize one request batch into its bounded wire text (marker line + one
 * compact JSON line). The request entries keep full field names so the text
 * is self-describing to the model; only the envelope uses short keys.
 * @param message - the batch to serialize.
 * @returns the text, or the stable refusal reason (`invalid` vocabulary, `oversized` byte cap).
 */
export function serializePanelRequestText(message: PanelRequestMessage): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: 'invalid' | 'oversized' } {
  const payload = messageSchema.safeParse(message)
  if (!payload.success) return { ok: false, reason: 'invalid' }
  const body = JSON.stringify({
    s: message.sessionId,
    o: message.occurrenceKey,
    rev: message.revision,
    r: message.requests,
    at: message.at,
  })
  const text = `${PANEL_TEXT_MARKER}\n${body}`
  if (byteLength(text) > PANEL_MAX_REQUEST_BYTES) return { ok: false, reason: 'oversized' }
  return { ok: true, text }
}

/**
 * Parse one message text into a request batch. Foreign text is a quiet
 * `not-panel` — ordinary user messages must never be treated as failures.
 * @param text - the candidate message text.
 * @param maxBytes - byte cap applied to the candidate before parsing.
 * @returns the parsed batch or the stable refusal reason.
 */
export function parsePanelRequestText(text: string, maxBytes = PANEL_MAX_REQUEST_BYTES): PanelParseResult {
  if (byteLength(text) > maxBytes) return { ok: false, reason: 'oversized' }
  // Version detection comes before the exact-marker prefix check so unknown
  // versions report as `unknown-version`, not a quiet foreign-text miss.
  if (!text.startsWith('[map-panel v')) return { ok: false, reason: 'not-panel' }
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0) return { ok: false, reason: 'invalid-payload' }
  const marker = text.slice(0, firstLineEnd)
  if (marker !== PANEL_TEXT_MARKER) {
    const versionMatch = /^\[map-panel v(\d+)\]$/.exec(marker)
    return { ok: false, reason: versionMatch && versionMatch[1] !== String(PANEL_TEXT_VERSION) ? 'unknown-version' : 'invalid-payload' }
  }
  let body: unknown
  try {
    body = JSON.parse(text.slice(firstLineEnd + 1))
  } catch {
    return { ok: false, reason: 'invalid-payload' }
  }
  const decoded = decodeWire(body)
  const parsed = messageSchema.safeParse(decoded)
  if (!parsed.success) return { ok: false, reason: 'invalid-payload' }
  return { ok: true, message: parsed.data }
}

/** Expand the short envelope keys back into the message record; request entries pass through unchanged. */
function decodeWire(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return body
  const wire = body as Record<string, unknown>
  return {
    version: PANEL_TEXT_VERSION,
    sessionId: wire.s,
    occurrenceKey: wire.o,
    revision: wire.rev,
    requests: wire.r,
    at: wire.at,
  }
}

/** The presentation fields a pending `set-state` entry can track. */
export type PendingField = 'visible' | 'opacity' | 'group'

/** Booked request identity shared by every pending entry kind. */
export interface PendingEntryBase {
  /** The client request id of the batch that booked the entry. */
  readonly requestId: string
  /** The wire layer id the entry watches. */
  readonly layerId: string
  /** Epoch milliseconds the entry was booked (latest-wins refreshes it). */
  readonly recordedAt: number
}

/** One pending `set-state` target: a single layer field and its expected value. */
export interface PendingStateEntry extends PendingEntryBase {
  readonly kind: 'set-state'
  readonly field: PendingField
  readonly value: boolean | number | string
}

/** One pending `set-style` target: the symbol version the preset expands to locally. */
export interface PendingStyleEntry extends PendingEntryBase {
  readonly kind: 'set-style'
  readonly expectedSymbolVersion: string
}

/** One pending `remove` target: settles when the layer leaves the wire. */
export interface PendingRemoveEntry extends PendingEntryBase {
  readonly kind: 'remove'
}

/** One booked, not-yet-observed request target. */
export type PendingEntry = PendingStateEntry | PendingStyleEntry | PendingRemoveEntry

/** The advisory pending book: entries plus the count dropped by the capacity bound. */
export interface PendingBook {
  readonly entries: readonly PendingEntry[]
  /** Entries dropped by the capacity bound, a cumulative counter. */
  readonly droppedOverflow: number
}

/** The wire slice the pending book matches against; the real wire's layers satisfy it structurally. */
export interface PendingWireLayer {
  readonly id: string
  readonly visible: boolean
  readonly opacity: number
  readonly group?: string | undefined
  readonly symbol?: { readonly symbolVersion: string } | undefined
}

/** A wire value the book settles against: just the layers. */
export interface PendingWire {
  readonly layers: readonly PendingWireLayer[]
}

/** The expiry outcome: the surviving book plus the entries that expired unobserved. */
export interface PendingExpiry {
  readonly book: PendingBook
  readonly expired: readonly PendingEntry[]
}

/** A fresh empty book. */
export function emptyPendingBook(): PendingBook {
  return { entries: [], droppedOverflow: 0 }
}

/** The entries one `set-state` request books, flattened to per-field targets in declaration order. */
function stateTargetsOf(request: Extract<PanelRequest, { op: 'set-state' }>): PendingStateEntry[] {
  const targets: PendingStateEntry[] = []
  for (const state of request.states) {
    if (state.visible !== undefined) targets.push({ requestId: request.id, layerId: state.id, kind: 'set-state', field: 'visible', value: state.visible, recordedAt: 0 })
    if (state.opacity !== undefined) targets.push({ requestId: request.id, layerId: state.id, kind: 'set-state', field: 'opacity', value: state.opacity, recordedAt: 0 })
    if (state.group !== undefined) targets.push({ requestId: request.id, layerId: state.id, kind: 'set-state', field: 'group', value: state.group, recordedAt: 0 })
  }
  return targets
}

/**
 * Book one request's targets. `set-state` supersedes the pending entry of
 * the same layer and field (latest-wins: the book tracks the newest target,
 * superseded queue messages stay in the session log untouched); `set-style`
 * supersedes the same layer's pending style; export requests book nothing
 * (their product ref lands in the conversation). Overflow beyond the
 * capacity drops the oldest entries and counts them.
 * @param book - the book to extend.
 * @param request - the request whose targets to book.
 * @param now - epoch milliseconds the entry is recorded at.
 * @returns the updated book.
 */
export function recordRequest(book: PendingBook, request: PanelRequest, now: number): PendingBook {
  let incoming: PendingEntry[]
  if (request.op === 'set-state') {
    incoming = stateTargetsOf(request).map(target => ({ ...target, recordedAt: now }))
  } else if (request.op === 'set-style') {
    const expectedSymbolVersion = resolveSymbolPreset(request.preset)?.symbol.symbolVersion
    // The vocabulary rejected unknown presets at the serializer; a book that
    // sees one anyway (direct call) simply has nothing observable to track.
    if (expectedSymbolVersion === undefined) return book
    incoming = [{ requestId: request.id, layerId: request.layer, kind: 'set-style', expectedSymbolVersion, recordedAt: now }]
  } else if (request.op === 'remove') {
    incoming = [{ requestId: request.id, layerId: request.layer, kind: 'remove', recordedAt: now }]
  } else {
    return book
  }
  const superseded = new Set(
    incoming.map(entry => entry.kind === 'set-state'
      ? `${entry.layerId}\0set-state\0${entry.field}`
      : `${entry.layerId}\0${entry.kind}`),
  )
  const kept = book.entries.filter(entry => !superseded.has(pendingKeyOf(entry)))
  const trimmed: PendingEntry[] = []
  let dropped = book.droppedOverflow
  for (const entry of [...kept, ...incoming]) {
    trimmed.push(entry)
    while (trimmed.length > PANEL_PENDING_CAPACITY) {
      const droppedEntry = trimmed.shift()
      if (droppedEntry === undefined) break
      dropped += 1
    }
  }
  return { entries: trimmed, droppedOverflow: dropped }
}

/** The latest-wins key of one entry: layer plus kind (plus field for state entries). */
function pendingKeyOf(entry: PendingEntry): string {
  return entry.kind === 'set-state'
    ? `${entry.layerId}\0set-state\0${entry.field}`
    : `${entry.layerId}\0${entry.kind}`
}

/**
 * Settle the book against one wire: entries whose targets the wire has
 * reached leave the book (`set-state` per-field value match, `set-style`
 * symbol-version match, `remove` layer absence).
 * @param book - the book to settle.
 * @param wire - the current wire value.
 * @returns the settled book.
 */
export function settlePending(book: PendingBook, wire: PendingWire): PendingBook {
  const byId = new Map(wire.layers.map(layer => [layer.id, layer]))
  const entries = book.entries.filter(entry => {
    const layer = byId.get(entry.layerId)
    if (entry.kind === 'remove') return layer !== undefined
    if (layer === undefined) return true
    if (entry.kind === 'set-state') {
      const actual = entry.field === 'visible' ? layer.visible : entry.field === 'opacity' ? layer.opacity : layer.group
      return actual !== entry.value
    }
    return layer.symbol?.symbolVersion !== entry.expectedSymbolVersion
  })
  return { entries, droppedOverflow: book.droppedOverflow }
}

/**
 * Clear entries whose target layer has left the wire: `set-state` and
 * `set-style` entries for a missing layer can never be observed and leave
 * the book as moot (a pending `remove` is a success, settled by
 * {@link settlePending}, not a moot entry).
 * @param book - the book to clear.
 * @param wire - the current wire value.
 * @returns the cleared book.
 */
export function clearMootEntries(book: PendingBook, wire: PendingWire): PendingBook {
  const ids = new Set(wire.layers.map(layer => layer.id))
  const entries = book.entries.filter(entry => entry.kind === 'remove' || ids.has(entry.layerId))
  return { entries, droppedOverflow: book.droppedOverflow }
}

/**
 * Expire entries past the TTL: they expired unobserved and leave the book so
 * the row state returns to wire truth; the advisory notice is the caller's.
 * @param book - the book to expire.
 * @param now - the current epoch milliseconds.
 * @returns the surviving book and the expired entries.
 */
export function expirePending(book: PendingBook, now: number): PendingExpiry {
  const expired: PendingEntry[] = []
  const entries: PendingEntry[] = []
  for (const entry of book.entries) {
    if (now - entry.recordedAt >= PANEL_PENDING_TTL_MS) expired.push(entry)
    else entries.push(entry)
  }
  return { book: { entries, droppedOverflow: book.droppedOverflow }, expired }
}

/**
 * Whether any pending entry watches one layer — the row-level pending marker.
 * @param book - the book to inspect.
 * @param layerId - the wire layer id.
 * @returns whether the layer carries at least one pending entry.
 */
export function hasPendingFor(book: PendingBook, layerId: string): boolean {
  return book.entries.some(entry => entry.layerId === layerId)
}

/**
 * Sync the book against one wire change: moot entries for vanished layers
 * clear first, then achieved targets settle — the panel's only wire reaction,
 * never a resubmission.
 * @param book - the book to sync.
 * @param wire - the current wire value.
 * @returns the synced book.
 */
export function syncPendingBook(book: PendingBook, wire: PendingWire): PendingBook {
  return settlePending(clearMootEntries(book, wire), wire)
}
