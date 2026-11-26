/** Durable before/after image previews for one two-image change candidate. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PanelChangeFace } from './panel-view.ts'
import type { MapImageUrl } from './face.ts'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

/** One bounded attachment preview entry and its session-authorized URL. */
function EvidencePreview({ attachment, label, sessionId, imageUrl, t }: {
  readonly attachment: ImageAttachmentRef | null
  readonly label: string
  readonly sessionId: string
  readonly imageUrl: MapImageUrl | undefined
  readonly t: TranslateNS<'mapContainer'>
}): ReactNode {
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
    <span data-map-panel-change-evidence="">
      <Button size="sm" variant="outline" type="button" data-map-panel-change-source="" aria-expanded={open} onClick={view}>{label}</Button>
      {failed && <small role="alert">{t('panel.proposal.sourceFailed')}</small>}
      {open && (
        <div data-map-panel-change-preview="">
          {source === null && !failed
            ? <small role="status">{t('panel.proposal.sourceLoading')}</small>
            : source !== null && <img src={source} alt={label} />}
        </div>
      )}
    </span>
  )
}

/** Both original observations behind one two-image change candidate. */
export function ChangeSource({ change, sessionId, imageUrl, t }: {
  readonly change: PanelChangeFace
  readonly sessionId: string
  readonly imageUrl: MapImageUrl | undefined
  readonly t: TranslateNS<'mapContainer'>
}): ReactNode {
  return (
    <span data-map-panel-change-sources="">
      <EvidencePreview attachment={change.beforeAttachment} label={t('panel.change.before')} sessionId={sessionId} imageUrl={imageUrl} t={t} />
      <EvidencePreview attachment={change.afterAttachment} label={t('panel.change.after')} sessionId={sessionId} imageUrl={imageUrl} t={t} />
    </span>
  )
}
