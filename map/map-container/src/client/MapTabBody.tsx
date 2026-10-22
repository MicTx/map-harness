/** The Session's retained ArcGIS canvas and workbench, driven by its durable mapContainer projection. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MapContainerState } from '../registry.ts'
import type { MapContainerWire } from './state.ts'
import type { MapOccurrence } from './face.ts'
import type { PanelSubmit } from './gesture-submit.ts'
import { submitViewport, type ViewportSubmit } from './viewport-submit.ts'
import type { PanelChangeSubmit } from './change-submit.ts'
import { wireToState } from './state.ts'
import { Workbench } from './Workbench.tsx'
import { LayerPanel } from './LayerPanel.tsx'
import { installMapTheme } from './map-theme.ts'
import { mountMapOccurrence } from './occurrence-lifecycle.ts'
import { FeatureCard } from './FeatureCard.tsx'
import type { FeatureInspection } from './popup.ts'

/** Standard sidebar owner share; state comes from the projection kit. */
export type MapTabBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'mapContainer'> & {
  /** Reports one settled camera as implicit context; defaults to the same-origin viewport route. */
  readonly viewportSubmit?: ViewportSubmit
  /** Session-queue submission path for panel state-change requests (always queued); absent disables the entry. */
  readonly panelSubmit?: PanelSubmit
  readonly changeSubmit?: PanelChangeSubmit
}

/**
 * Render the session's map container: the ArcGIS view mounted into a div owned
 * by this component, following the container's converged state, and the
 * workbench panel over the styled layers.
 * @param props - sidebar occurrence plus the projection and locale kits.
 * @returns the map surface.
 */
export function MapTabBody({ useTabInfo, useProjection, sessionId, t, viewportSubmit, panelSubmit, changeSubmit }: MapTabBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const holder = useRef<HTMLDivElement | null>(null)
  const wire = useProjection('mapContainer')
  // SDK loading may outlast several projection updates.
  const wireRef = useRef<MapContainerWire | undefined>(wire)
  wireRef.current = wire

  const occurrenceRef = useRef<MapOccurrence | null>(null)
  const [inspection, setInspection] = useState<FeatureInspection | null>(null)
  const inspectedRef = useRef<FeatureInspection | null>(null)
  /** Show one hovered feature, moving the highlight off any previously inspected layer. */
  const inspect = (next: FeatureInspection | null): void => {
    const previous = inspectedRef.current
    if (previous !== null && previous.layerId !== next?.layerId) occurrenceRef.current?.setHighlight(previous.layerId, new Set())
    inspectedRef.current = next
    setInspection(next)
  }
  const closeInspection = (): void => { inspect(null) }
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadState, setLoadState] = useState<{ readonly kind: 'loading' } | { readonly kind: 'ready' } | { readonly kind: 'error' }>({ kind: 'loading' })
  const stateOf = (): MapContainerState | undefined => wireToState(wireRef.current)

  useEffect(() => {
    if (holder.current === null) return
    setLoadState({ kind: 'loading' })
    const dispose = mountMapOccurrence({
      load: () => import('./occurrence.ts'), getState: stateOf,
      sessionId, occurrenceKey: tab.id, holder: holder.current,
      options: {
        onInspect: inspect,
        onViewport: snapshot => {
          void (viewportSubmit ?? submitViewport)(sessionId, snapshot)
        },
      },
      onReady: occurrence => {
        occurrenceRef.current = occurrence
        setLoadState({ kind: 'ready' })
      },
      onError: () => { setLoadState({ kind: 'error' }) },
    })
    return () => {
      dispose()
      occurrenceRef.current = null
    }
  }, [loadAttempt, sessionId, tab.id])

  useEffect(() => {
    const occurrence = occurrenceRef.current
    if (occurrence === null) return
    occurrence.refresh(stateOf())
  }, [wire])

  const occurrenceOf = (): MapOccurrence | null => occurrenceRef.current

  useEffect(() => installMapTheme(), [])

  return (
    <section data-map-container="" data-map-session={sessionId} data-map-tab={tab.id} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div ref={holder} style={{ position: 'absolute', inset: 0 }} />
      {loadState.kind === 'loading' && <p data-map-state="loading" role="status" aria-live="polite">{t('view.loading')}</p>}
      {loadState.kind === 'error' && (
        <p data-map-state="error" role="alert">
          {t('view.loadError')}
          <button type="button" onClick={() => setLoadAttempt(value => value + 1)}>{t('view.retry')}</button>
        </p>
      )}
      {wire !== undefined && (
        <>
          <LayerPanel wire={wire} sessionId={sessionId} occurrenceKey={tab.id} occurrence={occurrenceOf} t={t} panelSubmit={panelSubmit} changeSubmit={changeSubmit} />
          <Workbench wire={wire} occurrence={occurrenceOf} t={t} />
          {inspection !== null && <FeatureCard inspection={inspection} onClose={closeInspection} t={t} />}
        </>
      )}
    </section>
  )
}
