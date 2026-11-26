/** Continuous map-use status and stop control over the live map. */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MapInteractionWire } from '../interaction-protocol.ts'

/** Props for the status strip. */
export interface MapUseStatusProps {
  readonly interaction: MapInteractionWire
  readonly onStop: () => void
  readonly t: TranslateNS<'mapContainer'>
}

/**
 * Render the current turn's action/observation counts and the one stop
 * entrance. Returns `null` before the first map action, so ordinary map use
 * carries no extra chrome.
 */
export function MapUseStatus({ interaction, onStop, t }: MapUseStatusProps): ReactNode {
  if (!interaction.open || (interaction.actions === 0 && interaction.observations === 0)) return null
  const action = interaction.stopped != null ? t('use.stopped') : interaction.request === null
    ? null
    : interaction.request.action === 'pan' ? t('use.action.pan')
      : interaction.request.action === 'zoom' ? t('use.action.zoom')
        : t('use.action.click')
  return (
    <div data-map-use-status="" role="status">
      <span>{t('use.active', { actions: String(interaction.actions), observations: String(interaction.observations) })}</span>
      {action !== null && <span data-map-use-action="">{action}</span>}
      <button type="button" onClick={onStop} disabled={interaction.stopped != null}>{t('use.stop')}</button>
    </div>
  )
}
