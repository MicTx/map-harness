/**
 * Keyed `tool.call.toolview` row for every map tool: a one-line title from the
 * shared card dictionary (`action · subject`) with a state tone, expanding to
 * labeled argument and result lines and the raw output. It reads only the
 * durable call slice, so live streaming and replay render identically.
 */
import { useState, type KeyboardEvent, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { CardLine } from '../tool-cards/index.ts'
import { toolCardEntryOf } from '../tool-cards/index.ts'
import { toolCardModelOf, type ToolCardSlice, type ToolCardState } from './tool-card-model.ts'

/** Props the keyed slot hands a tool view (the subset this row reads). */
export interface MapToolCardProps {
  readonly toolName: string
  readonly phase: 'preparing' | 'start' | 'result'
  readonly block: ToolCallBlock
  readonly inspect?: (() => void) | undefined
  readonly t: TranslateNS<'mapContainer'>
}

/** Glyph per dictionary kind; decorative, the title carries the meaning. */
const KIND_GLYPHS: Readonly<Record<string, string>> = {
  read: '◎', search: '⌕', edit: '✎', delete: '⊖', move: '↔', execute: '▸', fetch: '⇅', other: '◇',
}

function sliceOf(phase: MapToolCardProps['phase'], block: ToolCallBlock): ToolCardSlice {
  if (phase === 'preparing' || !('kind' in block) && !('argsRaw' in block)) return { phase: 'preparing' }
  if (!('kind' in block)) return { phase: 'start', argsRaw: block.argsRaw }
  const text = block.content.flatMap(item => (item.type === 'text' ? [item.text] : [])).join('\n')
  return {
    phase: 'result',
    argsRaw: block.call?.argsRaw ?? null,
    text: text === '' && block.error !== undefined ? `${block.error.code}: ${block.error.reason ?? block.error.name}` : text,
    isError: block.isError,
    interrupted: block.error?.code === 'interrupted',
  }
}

function stateLabel(state: ToolCardState, t: MapToolCardProps['t']): string | null {
  switch (state) {
    case 'preparing':
    case 'running': return t('card.running')
    case 'error': return t('card.failed')
    case 'stopped': return t('card.stopped')
    case 'ok': return null
  }
}

function Lines({ heading, lines }: { readonly heading: string; readonly lines: readonly CardLine[] }): ReactNode {
  if (lines.length === 0) return null
  return (
    <section data-map-tool-card-section="" aria-label={heading}>
      <h4>{heading}</h4>
      <dl>
        {lines.map(line => (
          <div key={line.label}>
            <dt>{line.label}</dt>
            <dd>{line.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/**
 * Render one map tool call.
 * @param props - keyed toolview payload plus the map locale seat.
 * @returns the row, or `null` for a tool outside the dictionary (the slot falls back to the generic row).
 */
export function MapToolCard({ toolName, phase, block, inspect, t }: MapToolCardProps): ReactNode {
  const [open, setOpen] = useState(false)
  const entry = toolCardEntryOf(toolName)
  if (entry === undefined) return null
  const model = toolCardModelOf(entry, sliceOf(phase, block))
  if (model.state === 'preparing') {
    return (
      <div data-map-tool-card="" data-state="preparing" data-kind={entry.kind}>
        <div data-map-tool-card-row="">
          <span data-map-tool-card-icon="" aria-hidden="true">{KIND_GLYPHS[entry.kind]}</span>
          <span data-map-tool-card-title="">{t('card.preparing')}</span>
        </div>
      </div>
    )
  }
  const expandable = model.args.length > 0 || model.result.length > 0 || model.raw !== null
  const label = stateLabel(model.state, t)
  const errorReason = model.state === 'error' ? model.result.at(-1)?.text : undefined
  const toggle = (): void => { if (expandable) setOpen(value => !value) }
  const onKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggle()
  }
  return (
    <div data-map-tool-card="" data-state={model.state} data-kind={entry.kind} data-tool={toolName}>
      <div
        data-map-tool-card-row=""
        {...(expandable ? { role: 'button', tabIndex: 0, 'aria-expanded': open, onClick: toggle, onKeyDown: onKey } : {})}
      >
        <span data-map-tool-card-icon="" aria-hidden="true">{open ? '▾' : KIND_GLYPHS[entry.kind]}</span>
        <span data-map-tool-card-title="" title={toolName}>{model.title}</span>
        {label !== null && <span data-map-tool-card-state="">{label}</span>}
        {!open && errorReason !== undefined && <span data-map-tool-card-error="">{errorReason}</span>}
      </div>
      {open && (
        <div data-map-tool-card-body="">
          <Lines heading={t('card.args')} lines={model.args} />
          <Lines heading={t('card.result')} lines={model.result} />
          {model.raw !== null && (
            <details data-map-tool-card-raw="">
              <summary>{t('card.raw')}</summary>
              <pre>{model.raw}</pre>
            </details>
          )}
          {inspect !== undefined && (
            <button type="button" data-map-tool-card-inspect="" onClick={inspect}>{t('card.inspect')}</button>
          )}
        </div>
      )}
    </div>
  )
}
