/**
 * Host presenter for every spatial tool over the shared card dictionary in
 * `@map-harness/map-container` (the Web Client rows read the same entries).
 * The dictionary is re-typed here as `Record<SpatialToolName, …>`, so a new
 * catalog tool without an entry fails to compile; {@link withPresentation}
 * also refuses an unlisted tool at registration. The model-facing
 * `output.render` is unchanged.
 * @module @map-harness/map-tools/presentation
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolCallView, ToolDefinition, ToolResult, ToolResultView } from '@deepseek-ai/dsh-tools'
import {
  TOOL_CARD_DICTIONARY, cardLinesOf, cardTitleOf, errorLinesOf, parseJsonText,
  type CardLine, type PresentationEntry,
} from '@map-harness/map-container'
import type { SpatialToolName } from '../spatial-catalog.ts'

export { MAX_CARD_LINES } from '@map-harness/map-container'
/** Per-tool card entry type of the shared dictionary. */
export type { PresentationEntry } from '@map-harness/map-container'

/** The card entry of every spatial tool (compile-time complete over the catalog). */
export const PRESENTATION_DICTIONARY: Readonly<Record<SpatialToolName, PresentationEntry>> = TOOL_CARD_DICTIONARY

function contentOf(lines: readonly CardLine[]): ContentBlock[] | undefined {
  if (lines.length === 0) return undefined
  return [{ type: 'text', text: lines.map(l => `- ${l.label}：${l.text}`).join('\n') }]
}

function textOf(result: ToolResult): string {
  return result.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('\n')
}

/**
 * Build the pending card of one call.
 * @param entry - the tool's dictionary entry.
 * @param args - raw call arguments.
 * @returns a generic card titled `action · subject`.
 */
export function presentCallOf(entry: PresentationEntry, args: unknown): ToolCallView {
  const content = contentOf(cardLinesOf(entry.args, args))
  return { card: 'generic', title: cardTitleOf(entry, args), kind: entry.kind, ...(content === undefined ? {} : { content }) }
}

/**
 * Build the completed card of one call.
 * @param entry - the tool's dictionary entry.
 * @param args - raw call arguments.
 * @param result - the normalized tool result.
 * @returns a generic card with a success or failure title and summary lines.
 */
export function presentResultOf(entry: PresentationEntry, args: unknown, result: ToolResult): ToolResultView {
  const head = cardTitleOf(entry, args)
  const text = textOf(result)
  const content = contentOf(result.isError ? errorLinesOf(text) : cardLinesOf(entry.result, parseJsonText(text.trim())))
  return { card: 'generic', title: result.isError ? `${head}（失败）` : head, ...(content === undefined ? {} : { content }) }
}

/**
 * Attach dictionary cards to one tool definition.
 * @param tool - a spatial tool definition.
 * @returns a copy carrying `presentCall`/`presentResult`.
 * @throws {Error} when the tool has no dictionary entry, so an unlisted tool fails at registration.
 */
export function withPresentation(tool: ToolDefinition): ToolDefinition {
  const entry = Object.hasOwn(PRESENTATION_DICTIONARY, tool.name) ? PRESENTATION_DICTIONARY[tool.name as SpatialToolName] : undefined
  if (entry === undefined) {
    throw new Error(`map tool "${tool.name}" has no presentation dictionary entry; add one in map/map-container/src/tool-cards`)
  }
  return {
    ...tool,
    presentCall: args => presentCallOf(entry, args),
    presentResult: (args, result) => presentResultOf(entry, args, result),
  }
}
