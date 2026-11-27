/**
 * Fixed ArcGIS Wayback release selection from the plugin-owned catalog snapshot.
 * @module @map-harness/map-container/client/wayback-panel
 */
import { useEffect, useSyncExternalStore, type ReactNode } from 'react'
import type { BasemapSource } from '@map-harness/map-layers'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { WaybackCatalogRelease } from '../wayback-catalog-codec.ts'
import type { WaybackCatalogOwner, WaybackCatalogSnapshot } from './wayback-catalog.ts'
import type { WaybackAdmitFailure } from './wayback-client.ts'

/** Catalog presentation: `off` when deployment policy withholds Wayback, `ready` once any verified release is held. */
export type WaybackCatalogState = 'off' | 'loading' | 'ready' | 'error'

/** Derived catalog view; the list is never cleared by a refresh and nothing is selected automatically. */
export interface WaybackCatalogView {
  readonly state: WaybackCatalogState
  readonly releases: readonly WaybackCatalogRelease[]
  readonly refreshing: boolean
  /** Request a new catalog regardless of its age; the current list stays visible until one is verified. */
  readonly refresh: () => void
}

/** Inputs for fixed historical source selection. */
export interface WaybackPanelProps {
  readonly current: BasemapSource | null
  readonly catalog: WaybackCatalogView
  /** True while the catalog is read-only or any panel change, including a pending admission, is in flight. */
  readonly busy: boolean
  /** Release chosen by the user and awaiting admission; the selector shows it meanwhile. */
  readonly pendingReleaseId: number | null
  /** Why the latest admission was refused; shown inline and cleared by the next choice. */
  readonly failure: WaybackAdmitFailure | null
  readonly t: TranslateNS<'mapContainer'>
  readonly onSelect: (release: WaybackCatalogRelease) => void
  readonly onClear: () => void
}

const NO_SNAPSHOT: WaybackCatalogSnapshot = Object.freeze({
  phase: 'empty', releases: Object.freeze([]), fetchedAt: null, digest: null, refreshing: false, reason: null,
})
const noSubscription = (): (() => void) => () => {}
const noRefresh = (): void => {}

/**
 * Derive the catalog view from the plugin owner and warm it once while `enabled`.
 * Warming is never awaited: the view shows the last verified snapshot immediately.
 * @param owner - plugin-owned catalog owner; undefined when the map is not mounted or the host registered none.
 * @param enabled - deployment policy allows Wayback.
 * @returns the current catalog view.
 */
export function useWaybackCatalog(owner: WaybackCatalogOwner | undefined, enabled: boolean): WaybackCatalogView {
  const snapshot = useSyncExternalStore(owner?.subscribe ?? noSubscription, owner?.getSnapshot ?? (() => NO_SNAPSHOT))
  useEffect(() => {
    if (owner === undefined || !enabled) return
    const refreshWhenStale = (): void => { void owner.ensureFresh() }
    const refreshWhenVisible = (): void => {
      if (globalThis.document?.visibilityState === 'visible') refreshWhenStale()
    }
    refreshWhenStale()
    globalThis.addEventListener?.('online', refreshWhenStale)
    globalThis.document?.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      globalThis.removeEventListener?.('online', refreshWhenStale)
      globalThis.document?.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [owner, enabled])
  if (owner === undefined || !enabled) return { state: 'off', releases: NO_SNAPSHOT.releases, refreshing: false, refresh: noRefresh }
  return {
    state: snapshot.phase === 'ready' ? 'ready' : snapshot.reason === null ? 'loading' : 'error',
    releases: snapshot.releases,
    refreshing: snapshot.refreshing,
    refresh: () => { void owner.refresh() },
  }
}

/** Render the catalog as one selector; a release choice is admitted by the caller before it becomes a change. */
export function WaybackPanel({ current, catalog, busy, pendingReleaseId, failure, t, onSelect, onClear }: WaybackPanelProps): ReactNode {
  const currentReleaseId = current?.id === 'esri-wayback' ? current.release.version ?? '' : ''
  const shownReleaseId = pendingReleaseId === null ? currentReleaseId : String(pendingReleaseId)
  const byId = new Map(catalog.releases.map(release => [String(release.releaseId), release]))
  const selectable = catalog.state === 'ready' || (catalog.state !== 'off' && currentReleaseId !== '') || pendingReleaseId !== null
  return (
    <div data-map-wayback="">
      <small>{t('panel.imagery.earlyHint')}</small>
      <label>
        <span>{t('panel.wayback.release')}</span>
        <select
          data-map-wayback-release=""
          value={shownReleaseId}
          disabled={!selectable || busy}
          aria-busy={pendingReleaseId !== null}
          onChange={event => {
            const value = event.currentTarget.value
            if (value === '') {
              onClear()
              return
            }
            const found = byId.get(value)
            if (found !== undefined) onSelect(found)
          }}
        >
          <option value="">{t('panel.wayback.choose')}</option>
          {current !== null && currentReleaseId !== '' && !byId.has(currentReleaseId) && pendingReleaseId === null && (
            <option value={currentReleaseId}>{current.title}</option>
          )}
          {catalog.releases.map(release => (
            <option key={release.releaseId} value={release.releaseId}>{release.title}</option>
          ))}
        </select>
      </label>
      {current !== null && <small data-map-panel-source-title="">{current.title}</small>}
      {current !== null && <small data-map-wayback-meta="">{t('panel.wayback.published', { date: current.release.publishedAt ?? t('panel.wayback.unknown') })}</small>}
      {pendingReleaseId !== null && <small role="status">{t('panel.wayback.verifying')}</small>}
      {pendingReleaseId === null && catalog.state === 'loading' && <small role="status">{t('panel.wayback.loading')}</small>}
      {pendingReleaseId === null && catalog.state === 'off' && <small>{t('panel.wayback.disabled')}</small>}
      {pendingReleaseId === null && catalog.state === 'error' && (
        <small role="alert">
          {t('panel.wayback.error')} <Button size="sm" variant="outline" type="button" disabled={catalog.refreshing} onClick={catalog.refresh}>{t('panel.wayback.retry')}</Button>
        </small>
      )}
      {pendingReleaseId === null && failure !== null && (
        <small data-map-wayback-failure="" role="alert">
          {t(`panel.wayback.select.${failure}`)}
          {failure === 'changed' && <Button size="sm" variant="outline" type="button" disabled={catalog.refreshing} onClick={catalog.refresh}>{t('panel.wayback.retry')}</Button>}
        </small>
      )}
    </div>
  )
}
