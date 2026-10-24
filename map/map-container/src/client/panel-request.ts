/**
 * Panel queue channel, protocol half: the `[map-panel v1]` request
 * vocabulary (four ops mirroring the `layer_set_state`/`layer_set_style`/
 * `map_remove_layer`/`data_export` tool parameters one-to-one) and its
 * bounded serializer/parser. The panel queues only exports through it; the
 * other ops write directly through the user change route.
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
