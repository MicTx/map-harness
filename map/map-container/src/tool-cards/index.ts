/**
 * Face-neutral map tool card dictionary shared by the Host presenter
 * (`@map-harness/map-tools`) and the Web Client keyed tool rows: per tool, a
 * Chinese action phrase, an icon category, and the argument/result fields a
 * card lists, plus pure line builders over raw arguments and result text.
 * @module @map-harness/map-container/tool-cards
 */
import { ANALYSIS_ENTRIES } from './dictionary-analysis.ts'
import { MAP_ENTRIES } from './dictionary-map.ts'
import type { CardField, PresentationEntry } from './entry.ts'

/** Card field, per-tool entry, and icon category types of the dictionary. */
export type { CardField, PresentationEntry, ToolCardKind } from './entry.ts'

/** Most argument or result lines one card lists. */
export const MAX_CARD_LINES = 5

/** Longest error reason a failed card shows. */
export const MAX_ERROR_CHARS = 160

/** Every map tool's card entry; keys are the wire tool names. */
export const TOOL_CARD_DICTIONARY = Object.freeze({ ...MAP_ENTRIES, ...ANALYSIS_ENTRIES })

/** One wire tool name the dictionary describes. */
export type ToolCardName = keyof typeof TOOL_CARD_DICTIONARY

/** One labeled card line. */
export interface CardLine {
  /** Display label. */
  readonly label: string
  /** Formatted value. */
  readonly text: string
}

/**
 * Look up a tool's entry.
 * @param name - wire tool name.
 * @returns the entry, or `undefined` for a tool outside the dictionary.
 */
export function toolCardEntryOf(name: string): PresentationEntry | undefined {
  return Object.hasOwn(TOOL_CARD_DICTIONARY, name) ? TOOL_CARD_DICTIONARY[name as ToolCardName] : undefined
}

function readPath(source: unknown, key: string): unknown {
  let current = source
  for (const part of key.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

/**
 * Format the fields that apply, in order, at most {@link MAX_CARD_LINES}.
 * @param fields - the entry's argument or result fields.
 * @param source - parsed arguments or result value.
 * @returns the lines; paired fields sharing a label keep the first that formats.
 */
export function cardLinesOf(fields: readonly CardField[], source: unknown): CardLine[] {
  const lines: CardLine[] = []
  const seen = new Set<string>()
  for (const f of fields) {
    if (lines.length >= MAX_CARD_LINES) break
    let text: string | undefined
    try {
      text = f.format(readPath(source, f.key))
    } catch (formatError) {
      // A formatter defect omits the line rather than breaking a card.
      void formatError
      text = undefined
    }
    if (text === undefined || seen.has(f.label)) continue
    seen.add(f.label)
    lines.push({ label: f.label, text })
  }
  return lines
}

/**
 * Parse raw JSON text, tolerating streaming prefixes and model prose.
 * @param text - raw argument or result text.
 * @returns the parsed value, or `undefined`.
 */
export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (parseError) {
    // Partial streaming arguments and non-JSON results have no fields to read.
    void parseError
    return undefined
  }
}

/**
 * Build a card title.
 * @param entry - the tool's entry.
 * @param args - parsed arguments.
 * @returns `action · subject`, or the action alone when no argument formats.
 */
export function cardTitleOf(entry: PresentationEntry, args: unknown): string {
  const subject = cardLinesOf(entry.args, args)[0]?.text
  return subject === undefined ? entry.action : `${entry.action} · ${subject}`
}

/**
 * Split a failed result's first line into a stable code and a bounded reason.
 * @param text - the failed result text (`CODE: message` for spatial errors).
 * @returns error lines labeled 错误码 / 原因.
 */
export function errorLinesOf(text: string): CardLine[] {
  const first = text.trim().split('\n')[0] ?? ''
  const match = /^([A-Z][A-Z0-9_]+):\s*(.*)$/.exec(first)
  const reason = (match?.[2] ?? first).trim()
  const lines: CardLine[] = []
  if (match?.[1] !== undefined) lines.push({ label: '错误码', text: match[1] })
  if (reason !== '') {
    lines.push({ label: '原因', text: reason.length > MAX_ERROR_CHARS ? `${reason.slice(0, MAX_ERROR_CHARS - 1)}…` : reason })
  }
  return lines
}
