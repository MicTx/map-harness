/**
 * The map tab's body: one ArcGIS view per session-bound container plus the
 * visualization workbench panel (legend, timeline, chart, attribute table,
 * fixed-revision export).
 *
 * Zero-key mode is the only mode this round: the `Map` is constructed without
 * a `basemap` and without `ground`, so no Esri-hosted service is ever
 * requested. Container state arrives through the `mapContainer` session
 * projection (the durable tool-result fold); this component mounts the view
 * and applies each converged snapshot idempotently.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { MapContainerState } from '../registry.ts'
import type { MapContainerWire } from './state.ts'
import type { MapOccurrence } from './face.ts'
import type { GestureSubmit } from './gesture-submit.ts'
import { gestureSubmitMode } from './gesture.ts'
import { wireToState } from './state.ts'
import { Workbench } from './Workbench.tsx'

/** Standard sidebar owner share; state comes from the projection kit. */
export type MapTabBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'mapContainer'> & {
  /** Session-queue submission path for settled gesture observations; absent disables the channel. */
  readonly gestureSubmit?: GestureSubmit
}

/**
 * Render the session's map container: the ArcGIS view mounted into a div owned
 * by this component, following the container's converged state, and the
 * workbench panel over the styled layers.
 * @param props - sidebar occurrence plus the projection and locale kits.
 * @returns the map surface.
 */
export function MapTabBody({ useTabInfo, useProjection, useSession, sessionId, t, gestureSubmit }: MapTabBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const holder = useRef<HTMLDivElement | null>(null)
  const wire = useProjection('mapContainer')
  // The occurrence reads the state through a ref so its dynamic-import
  // closure always applies the latest converged snapshot, never the first
  // render's wire value (the same pattern MapViewBody uses).
  const wireRef = useRef<MapContainerWire | undefined>(wire)
  wireRef.current = wire
  const gestureSubmitRef = useRef<GestureSubmit | undefined>(gestureSubmit)
  gestureSubmitRef.current = gestureSubmit
  // The steering gate reads the live running state at settle time, not at
  // occurrence creation; `undefined` (unknown) gates closed.
  const runningRef = useRef(false)
  runningRef.current = useSession(snapshot => snapshot.running) === true

  const occurrenceRef = useRef<MapOccurrence | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadState, setLoadState] = useState<{ readonly kind: 'loading' } | { readonly kind: 'ready' } | { readonly kind: 'error' }>({ kind: 'loading' })
  const stateOf = (): MapContainerState | undefined => wireToState(wireRef.current)

  useEffect(() => {
    let cancelled = false
    setLoadState({ kind: 'loading' })

    // Lazy: `@arcgis/core` is heavy; first tab open pays for it, plugin load does not.
    void import('./occurrence.ts').then(({ createMapOccurrence }) => {
      const occurrence = createMapOccurrence(stateOf, sessionId, tab.id, {
        onGestureObservation: (text, observation) => {
          const submit = gestureSubmitRef.current
          const mode = gestureSubmitMode(observation.kind, runningRef.current)
          if (submit === undefined || mode === null) return
          void submit(sessionId, text, mode).catch(() => {
            // Advisory input: a lost race (e.g. the turn ended between the
            // running check and the prompt) holds; it is never a map error.
          })
        },
      })
      if (cancelled) {
        occurrence.dispose()
        return
      }
      occurrenceRef.current = occurrence
      if (holder.current !== null) occurrence.mount(holder.current)
      setLoadState({ kind: 'ready' })
    }).catch(() => {
      if (cancelled) return
      setLoadState({ kind: 'error' })
    })

    return () => {
      cancelled = true
      occurrenceRef.current?.dispose()
      occurrenceRef.current = null
    }
  }, [loadAttempt, sessionId, tab.id])

  useEffect(() => {
    const occurrence = occurrenceRef.current
    if (occurrence === null) return
    occurrence.refresh(stateOf())
  }, [wire])

  const occurrenceOf = (): MapOccurrence | null => occurrenceRef.current

  // ── explicit gesture observation (independent of the styled-layer workbench) ──
  const [gestureStatus, setGestureStatus] = useState<string | null>(null)
  const sendGestureObservation = (): void => {
    const outcome = occurrenceOf()?.submitGestureObservation() ?? 'no-view'
    setGestureStatus(outcome === 'emitted' ? t('workbench.gesture.sent') : t('workbench.gesture.noView'))
  }

  return (
    <section data-map-container="" style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      <div ref={holder} style={{ position: 'absolute', inset: 0 }} />
      {loadState.kind === 'loading' && <p data-map-state="loading" role="status" aria-live="polite">{t('view.loading')}</p>}
      {loadState.kind === 'error' && (
        <p data-map-state="error" role="alert">
          {t('view.loadError')}
          <button type="button" onClick={() => setLoadAttempt(value => value + 1)}>{t('view.retry')}</button>
        </p>
      )}
      {wire !== undefined && (
        <Workbench wire={wire} occurrence={occurrenceOf} t={t} />
      )}
      <section data-gesture-submit="" aria-label={t('workbench.gesture.send')} style={{ position: 'absolute', left: 8, bottom: 8, zIndex: 2 }}>
        <button type="button" data-gesture-submit-button="" aria-label={t('workbench.gesture.send')} onClick={sendGestureObservation}>
          {t('workbench.gesture.send')}
        </button>
        {gestureStatus !== null && (
          <p role="status" data-gesture-submit-status="" style={{ margin: '2px 0 0' }}>{gestureStatus}</p>
        )}
      </section>
    </section>
  )
}
