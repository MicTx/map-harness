/** Durable observation-image preview for one visual candidate. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PanelProposalFace } from './panel-view.ts'
import type { MapImageUrl } from './face.ts'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

/** One candidate's session-authorized source-image entry and preview. */
export function ProposalSource({ proposal, sessionId, imageUrl, t }: {
  readonly proposal: PanelProposalFace
  readonly sessionId: string
  readonly imageUrl: MapImageUrl | undefined
  readonly t: TranslateNS<'mapContainer'>
}): ReactNode {
  const attachment = proposal.sourceAttachment
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const request = useRef<AbortController | null>(null)

  useEffect(() => () => { request.current?.abort() }, [])
  useEffect(() => {
    request.current?.abort()
    setSource(null)
    setFailed(false)
    setOpen(false)
  }, [attachment?.attachmentId])

  if (attachment === null) return <small>{t('panel.proposal.sourceUnavailable')}</small>
  if (imageUrl === undefined) return <small role="alert">{t('panel.proposal.sourceFailed')}</small>
  const view = (): void => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (source !== null || request.current !== null) return
    const controller = new AbortController()
    request.current = controller
    void imageUrl(SessionId(sessionId), attachment).then(url => {
      if (!controller.signal.aborted) setSource(url)
    }, () => {
      if (!controller.signal.aborted) setFailed(true)
    }).finally(() => {
      if (request.current === controller) request.current = null
    })
  }
  return (
    <span data-map-panel-proposal-evidence="">
      <Button size="sm" variant="outline" type="button" data-map-panel-proposal-source="" aria-expanded={open} onClick={view}>
        {t('panel.proposal.viewSource')}
      </Button>
      {failed && <small role="alert">{t('panel.proposal.sourceFailed')}</small>}
      {open && (
        <div data-map-panel-proposal-preview="">
          {source === null && !failed
            ? <small role="status">{t('panel.proposal.sourceLoading')}</small>
            : source !== null && <img src={source} alt={t('panel.proposal.sourceAlt', { name: proposal.name })} />}
        </div>
      )}
    </span>
  )
}
