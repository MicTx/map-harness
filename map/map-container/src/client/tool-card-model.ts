/**
 * Pure row model for one map tool call in the conversation, derived from the
 * durable call slice (raw arguments, result content, error flag) and the
 * shared card dictionary. Replays reproduce it from the session log alone.
 * @module @map-harness/map-container/client/tool-card-model
 */
import { cardLinesOf, cardTitleOf, errorLinesOf, parseJsonText, type CardLine, type PresentationEntry } from '../tool-cards/index.ts'

/** Row lifecycle. */
export type ToolCardState = 'preparing' | 'running' | 'ok' | 'error' | 'stopped'

/** The fields of a call slice the model reads. */
export type ToolCardSlice =
  | { readonly phase: 'preparing' }
  | { readonly phase: 'start'; readonly argsRaw: string }
  | {
    readonly phase: 'result'
    readonly argsRaw: string | null
    readonly text: string
    readonly isError: boolean
    readonly interrupted: boolean
  }

/** Rendered row facts. */
export interface ToolCardModel {
  readonly state: ToolCardState
  /** `action · subject`. */
  readonly title: string
  /** Argument lines (the subject line included). */
  readonly args: readonly CardLine[]
  /** Result or error lines; empty before the result. */
  readonly result: readonly CardLine[]
  /** Raw result text for the disclosure, or `null`. */
  readonly raw: string | null
}

/**
 * Derive the row model.
 * @param entry - the tool's dictionary entry.
 * @param slice - the call slice.
 * @returns the model.
 */
export function toolCardModelOf(entry: PresentationEntry, slice: ToolCardSlice): ToolCardModel {
  if (slice.phase === 'preparing') return { state: 'preparing', title: entry.action, args: [], result: [], raw: null }
  const parsedArgs = slice.argsRaw === null ? undefined : parseJsonText(slice.argsRaw)
  const title = cardTitleOf(entry, parsedArgs)
  const args = cardLinesOf(entry.args, parsedArgs)
  if (slice.phase === 'start') return { state: 'running', title, args, result: [], raw: null }
  const state: ToolCardState = slice.interrupted ? 'stopped' : slice.isError ? 'error' : 'ok'
  const text = slice.text.trim()
  const result = state === 'error' ? errorLinesOf(text) : cardLinesOf(entry.result, parseJsonText(text))
  return { state, title, args, result, raw: text === '' ? null : text }
}
