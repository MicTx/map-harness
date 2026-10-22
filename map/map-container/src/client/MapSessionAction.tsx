/** Session-scoped navigation to the single map canvas beside the conversation. */
import { useEffect, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MapSessionBinding } from './default-open.ts'

/** Header props and the client plugin's map navigation owner. */
export type MapSessionActionProps = PropsRuntime<'conversation.session.header.utilities'> & PropsLocale<'mapContainer'> & {
  readonly binding: MapSessionBinding
}

/**
 * Reveal this Session's map without replacing its conversation or creating another canvas.
 * @param props - strict Session identity, navigation, and localized copy.
 * @returns the map navigation button.
 */
export function MapSessionAction({ sessionId, binding, useSession, t }: MapSessionActionProps): ReactNode {
  const blank = useSession(snapshot => snapshot.blank)
  useEffect(() => { if (!blank) binding.ensure(sessionId) }, [binding, sessionId, blank])
  return <button
    type="button"
    data-map-session-action={sessionId}
    aria-label={t('view.open')}
    title={t('view.open')}
    onClick={() => { binding.open(sessionId) }}
    style={{ color: 'inherit', background: 'transparent', border: 0, cursor: 'pointer', font: 'inherit' }}
  >{t('view.map')}</button>
}
