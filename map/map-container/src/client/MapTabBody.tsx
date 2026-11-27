/** The Session's retained ArcGIS canvas, left panel rail, and workbench, driven by its durable mapContainer projection. */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserStorage } from '@deepseek-ai/dsh-client-store'
import type { WaybackCatalogOwner } from './wayback-catalog.ts'
import type { MapContainerState, MapViewRecord } from '../registry.ts'
import type { MapContainerWire } from './state.ts'
import type { MapOccurrence, MapImageUrl } from './face.ts'
import type { PanelSubmit } from './gesture-submit.ts'
import { submitViewport, type ViewportSubmit } from './viewport-submit.ts'
import type { PanelChangeSubmit } from './change-submit.ts'
import { annotationOperationOf, type PendingAnnotationOperation } from './annotation-pending.ts'
import { wireToState } from './state.ts'
import { UnifiedMapPanel } from './LayerPanel.tsx'
import { installMapTheme } from './map-theme.ts'
import { mountMapOccurrence } from './occurrence-lifecycle.ts'
import { loadMapSourceDescriptor } from './source-client.ts'
import { FeatureCard } from './FeatureCard.tsx'
import type { FeatureInspectionFrame } from './feature-card-anchor.ts'
import { MapUseStatus } from './MapUseStatus.tsx'
import { MapboxControls } from './mapbox-controls.tsx'

/** Standard sidebar owner share; state comes from the projection kit. */
export type MapTabBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'mapContainer'> & {
  /** Reports one settled camera as implicit context; defaults to the same-origin viewport route. */
  readonly viewportSubmit?: ViewportSubmit
  /** Session-queue submission path for panel state-change requests (always queued); absent disables the entry. */
  readonly panelSubmit?: PanelSubmit
  readonly changeSubmit?: PanelChangeSubmit
  /** Session-authorized durable image resolver for visual-proposal source previews. */
  readonly imageUrl?: MapImageUrl
  /** Instance-scoped browser persistence supplied by the client composition. */
  readonly browserStorage?: BrowserStorage
  /** Plugin-owned Wayback release catalog, handed to the panel only after the map is mounted. */
  readonly waybackCatalog?: WaybackCatalogOwner
}

/**
 * Render the session's map container: the ArcGIS view mounted into a div owned
 * by this component, following the container's converged state and the unified
 * map panel card over the canvas. Narrow maps start with the same card
 * collapsed and reserve a right-hand strip for navigation controls.
 * @param props - sidebar occurrence plus the projection and locale kits.
 * @returns the map surface.
 */
export function MapTabBody({ useTabInfo, useProjection, useResource, sessionId, t, viewportSubmit, panelSubmit, changeSubmit, imageUrl, browserStorage, waybackCatalog }: MapTabBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const holder = useRef<HTMLDivElement | null>(null)
  const wire = useProjection('mapContainer')
  const interaction = wire?.interaction
  const [controlError, setControlError] = useState(false)
  const [sourceFailure, setSourceFailure] = useState<'error' | 'retrying' | null>(null)
  const [compactPanels, setCompactPanels] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const panelTouched = useRef(false)
  // SDK loading may outlast several projection updates.
  const wireRef = useRef<MapContainerWire | undefined>(wire)
  wireRef.current = wire

  const occurrenceRef = useRef<MapOccurrence | null>(null)
  const changeSubmitRef = useRef(changeSubmit)
  changeSubmitRef.current = changeSubmit
  const annotationCreateOperationRef = useRef<PendingAnnotationOperation | null>(null)
  const annotationUpdateOperationRef = useRef<PendingAnnotationOperation | null>(null)
  const [inspection, setInspection] = useState<FeatureInspectionFrame | null>(null)
  const inspectedRef = useRef<FeatureInspectionFrame | null>(null)
  /** Show one hovered feature, moving the highlight off any previously inspected layer. */
  const inspect = (next: FeatureInspectionFrame | null): void => {
    const previous = inspectedRef.current
    if (previous !== null && previous.layerId !== next?.layerId) occurrenceRef.current?.setHighlight(previous.layerId, new Set(), 'inspection')
    inspectedRef.current = next
    setInspection(next)
  }
  const closeInspection = (): void => {
    const occurrence = occurrenceRef.current
    if (occurrence !== null) occurrence.dismissInspection()
    else inspect(null)
  }
  const submitAnnotationCreate = (geometry: import('../protocol.ts').AnnotationGeometry, kind: 'point' | 'line' | 'polygon' | 'rectangle'): Promise<void> => {
    const submit = changeSubmitRef.current
    if (submit === undefined) return Promise.resolve()
    const revision = wireRef.current?.revision ?? 0
    const change = { op: 'annotation-create', geometry, name: t('panel.annotation.defaultName') } as const
    annotationCreateOperationRef.current = annotationOperationOf(
      annotationCreateOperationRef.current,
      revision,
      change,
      () => globalThis.crypto.randomUUID(),
    )
    const operationId = annotationCreateOperationRef.current.operationId
    return submit({
      sessionId,
      revision,
      summary: t('panel.annotation.summary.create', { kind: t(`panel.annotation.kind.${kind}` as const) }),
      change,
      operationId,
    }).then(outcome => {
      if (outcome.ok) annotationCreateOperationRef.current = null
      else throw new Error(outcome.code)
    })
  }
  const submitAnnotationUpdate = (featureId: string, geometry: import('../protocol.ts').AnnotationGeometry, expectedUpdatedAt: string): Promise<void> => {
    const submit = changeSubmitRef.current
    if (submit === undefined) return Promise.resolve()
    const revision = wireRef.current?.revision ?? 0
    const change = { op: 'annotation-update', featureId, expectedUpdatedAt, geometry } as const
    annotationUpdateOperationRef.current = annotationOperationOf(
      annotationUpdateOperationRef.current,
      revision,
      change,
      () => globalThis.crypto.randomUUID(),
    )
    const operationId = annotationUpdateOperationRef.current.operationId
    return submit({
      sessionId,
      revision,
      summary: t('panel.annotation.summary.update', { id: featureId }),
      change,
      operationId,
    }).then(outcome => {
      if (outcome.ok) annotationUpdateOperationRef.current = null
      else throw new Error(outcome.code)
    })
  }
  /** Persist one settled camera as the final map view; a failed write leaves the live camera untouched. */
  const submitUserCamera = (view: MapViewRecord): void => {
    const submit = changeSubmitRef.current
    if (submit === undefined) return
    void submit({
      sessionId,
      revision: wireRef.current?.revision ?? 0,
      summary: t('panel.summary.camera'),
      change: { op: 'set-view', view },
    })
  }
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [liveViewport, setLiveViewport] = useState<import('./gesture.ts').GestureCameraSnapshot | null>(null)
  const viewportController = useRef<AbortController | null>(null)
  const [loadState, setLoadState] = useState<{ readonly kind: 'loading' } | { readonly kind: 'ready' } | { readonly kind: 'error' }>({ kind: 'loading' })
  const stateOf = (): MapContainerState | undefined => wireToState(wireRef.current)

  useEffect(() => {
    const timer = globalThis.setInterval(() => {
      setSourceFailure(occurrenceRef.current?.sourceFailure() ?? null)
    }, 250)
    return () => globalThis.clearInterval(timer)
  }, [loadAttempt, sessionId, tab.id])

  useEffect(() => {
    const occurrence = occurrenceRef.current
    const request = interaction?.request
    if (occurrence === null || request === undefined || request === null) return
    void occurrence.runMapUse(request, wireRef.current?.latestObservation ?? null)
  }, [interaction?.request?.requestSeq, wire?.latestObservation?.observationId, loadState.kind])

  useEffect(() => {
    if (holder.current === null) return
    setLoadState({ kind: 'loading' })
    const dispose = mountMapOccurrence({
      load: () => import('./occurrence.ts'), getState: stateOf,
      sessionId, occurrenceKey: tab.id, holder: holder.current,
      options: {
        ...(browserStorage === undefined ? {} : { browserStorage }),
        loadRenderDescriptor: loadMapSourceDescriptor,
        onInspect: inspect,
        onControlError: () => setControlError(true),
        onAnnotationCreate: submitAnnotationCreate,
        onAnnotationUpdate: submitAnnotationUpdate,
        onUserCamera: submitUserCamera,
        labelClusterCopy: count => ({
          text: t('view.clusterBadge', { n: String(count) }),
          title: t('view.clusterZoom', { n: String(count) }),
        }),
        onViewport: snapshot => {
          viewportController.current?.abort()
          const controller = new AbortController()
          viewportController.current = controller
          setLiveViewport(null)
          void (viewportSubmit ?? submitViewport)(sessionId, snapshot, controller.signal).then(() => {
            if (!controller.signal.aborted) setLiveViewport(snapshot)
          }, () => {
            if (!controller.signal.aborted) setLiveViewport(null)
          })
        },
      },
      onReady: occurrence => {
        occurrenceRef.current = occurrence
        setLoadState({ kind: 'ready' })
      },
      onError: () => { setLoadState({ kind: 'error' }) },
    })
    return () => {
      viewportController.current?.abort()
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
  useEffect(() => {
    const element = holder.current?.parentElement
    if (element === null || element === undefined) return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? element.clientWidth
      const compact = width < 590
      // Only the presentation follows the width: the card the user chose stays
      // open across any resize, wide or narrow. Until the user touches it, a
      // wide container expands the card and a narrow one keeps its title bar.
      setCompactPanels(compact)
      if (!panelTouched.current) setPanelOpen(!compact)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [loadAttempt, sessionId, tab.id])

  const panel = (
    <UnifiedMapPanel
      key={sessionId}
      wire={wire!} sessionId={sessionId} occurrenceKey={tab.id} occurrence={occurrenceOf} t={t} useResource={useResource}
      panelSubmit={panelSubmit} changeSubmit={changeSubmit} imageUrl={imageUrl} liveViewport={liveViewport}
      {...(waybackCatalog === undefined ? {} : { waybackCatalog })}
      open={panelOpen}
      onOpenChange={(open: boolean) => { panelTouched.current = true; setPanelOpen(open) }}
    />
  )
  return (
    <section data-map-container="" data-map-session={sessionId} data-map-tab={tab.id}>
      <div ref={holder} data-map-canvas="" />
      {loadState.kind === 'loading' && <p data-map-state="loading" role="status" aria-live="polite">{t('view.loading')}</p>}
      {loadState.kind === 'error' && (
        <p data-map-state="error" role="alert">
          {t('view.loadError')}
          <button type="button" onClick={() => setLoadAttempt(value => value + 1)}>{t('view.retry')}</button>
        </p>
      )}
      {wire !== undefined && (
        <>
          {interaction !== undefined && (
            <MapUseStatus
              interaction={interaction}
              onStop={() => { if (interaction.turnStartSeq !== null) occurrenceOf()?.stopMapUse(interaction.turnStartSeq) }}
              t={t}
            />
          )}
          {controlError && <p data-map-state="error" role="alert">{t('use.stopFailed')}</p>}
          {sourceFailure !== null && (
            <div data-map-source-error="" role="alert">
              <span>{t(sourceFailure === 'error' ? 'view.sourceError' : 'view.sourceRetrying')}</span>
              <button type="button" onClick={() => occurrenceOf()?.retrySource()}>{t('view.retry')}</button>
            </div>
          )}
          <div data-map-rail={compactPanels ? undefined : 'wide'} data-map-overlay-content="">
            <div data-map-panel-lane="">{panel}</div>
            <MapboxControls occurrence={occurrenceOf} t={t} />
            {inspection !== null && <FeatureCard inspection={inspection} onClose={closeInspection} t={t} />}
          </div>
        </>
      )}
    </section>
  )
}
