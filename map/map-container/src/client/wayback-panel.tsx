/**
 * Fixed ArcGIS Wayback release selection from the official catalog.
 * @module @map-harness/map-container/client/wayback-panel
 */
import { useEffect, useState, type ReactNode } from 'react'
import type { BasemapSource } from '@map-harness/map-layers'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { readWaybackReleases, type WaybackRelease } from './wayback-client.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

/** Inputs for fixed historical source selection. */
export interface WaybackPanelProps {
  readonly sessionId: string
  readonly canWrite: boolean
  readonly current: BasemapSource | null
  readonly t: TranslateNS<'mapContainer'>
  readonly onSelect: (source: BasemapSource | null) => void
}

/** Render the paginated official Wayback release catalog as one direct selector. */
export function WaybackPanel({ sessionId, canWrite, current, t, onSelect }: WaybackPanelProps): ReactNode {
  const [catalog, setCatalog] = useState<readonly { release: WaybackRelease; descriptor: BasemapSource }[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setState('loading')
    void readWaybackReleases(sessionId, controller.signal).then(releases => {
      if (controller.signal.aborted) return
      setCatalog(releases)
      setState('ready')
    }).catch(() => {
      if (!controller.signal.aborted) setState('error')
    })
    return () => controller.abort()
  }, [sessionId, attempt])

  const currentReleaseId = current?.id === 'esri-wayback' ? current.release.version ?? '' : ''
  const byId = new Map(catalog.map(item => [String(item.release.releaseId), item]))
  return (
    <div data-map-wayback="">
      <small>{t('panel.imagery.earlyHint')}</small>
      <label>
        <span>{t('panel.wayback.release')}</span>
        <select
          data-map-wayback-release=""
          value={currentReleaseId}
          disabled={!canWrite || state === 'loading'}
          onChange={event => {
            const value = event.currentTarget.value
            if (value === '') {
              onSelect(null)
              return
            }
            const found = byId.get(value)
            if (found !== undefined) onSelect(found.descriptor)
          }}
        >
          <option value="">{t('panel.wayback.choose')}</option>
          {current !== null && currentReleaseId !== '' && !byId.has(currentReleaseId) && (
            <option value={currentReleaseId}>{current.title}</option>
          )}
          {catalog.map(({ release }) => (
            <option key={release.releaseId} value={release.releaseId}>{release.title}</option>
          ))}
        </select>
      </label>
      {current !== null && <small data-map-wayback-meta="">{t('panel.wayback.published', { date: current.release.publishedAt ?? t('panel.wayback.unknown') })}</small>}
      {state === 'loading' && <small>{t('panel.wayback.loading')}</small>}
      {state === 'error' && (
        <small role="alert">
          {t('panel.wayback.error')} <Button size="sm" variant="outline" type="button" onClick={() => setAttempt(value => value + 1)}>{t('panel.wayback.retry')}</Button>
        </small>
      )}
    </div>
  )
}
