/**
 * The conversation-view body: one ArcGIS view per session-bound container.
 *
 * Same occurrence core as the right-Sidebar tab. The conversation view is
 * unmounted when another view is selected, so this body disposes the engine
 * instance on unmount and rebuilds on the next visit. Container state still
 * arrives through the `mapContainer` projection.
 *
 * A `viewRequest` for a known layer waits until the occurrence is mounted
 * before `focusLayer` + `completeViewRequest`. Unknown layers complete
 * immediately so a stale focus cannot stick on the Conversation store.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { MAP_VIEW_OCCURRENCE_KEY } from './definition.ts'
import type { MapOccurrence } from './face.ts'
import type { GestureSubmit } from './gesture-submit.ts'
import { gestureSubmitMode } from './gesture.ts'
import { wireToState } from './state.ts'
import { mapViewRequestAction } from './view-request.ts'

/** Conversation-view props plus the gesture write channel's submission path. */
export type MapViewBodyProps = ConvViewProps & PropsLocale<'mapContainer'> & {
  /** Session-queue submission path for settled gesture observations; absent disables the channel. */
  readonly gestureSubmit?: GestureSubmit
}

/**
 * Render the session's map container inside the conversation view area.
 * @param props - conversation view owner plus the projection kit.
 * @returns the map surface.
 */
export function MapViewBody({
  useProjection, useSession, sessionId, viewRequest, completeViewRequest,
  t, gestureSubmit,
}: MapViewBodyProps): ReactNode {
  const holder = useRef<HTMLDivElement | null>(null)
  const occurrenceRef = useRef<MapOccurrence | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [loadState, setLoadState] = useState<{ readonly kind: 'loading' } | { readonly kind: 'ready' } | { readonly kind: 'error' }>({ kind: 'loading' })
  const wire = useProjection('mapContainer')
  const wireRef = useRef(wire)
  wireRef.current = wire
  const viewRequestRef = useRef(viewRequest)
  viewRequestRef.current = viewRequest
  const completeRef = useRef(completeViewRequest)
  completeRef.current = completeViewRequest
  const gestureSubmitRef = useRef<GestureSubmit | undefined>(gestureSubmit)
  gestureSubmitRef.current = gestureSubmit
  // Same steering gate as the sidebar tab: stable rests submit only while a
  // turn is running; unknown running state gates closed.
  const runningRef = useRef(false)
  runningRef.current = useSession(snapshot => snapshot.running) === true

  const bindHolder = useCallback((element: HTMLDivElement | null): void => {
    holder.current = element
    occurrenceRef.current?.mount(element ?? undefined)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoadState({ kind: 'loading' })
    void import('./occurrence.ts').then(({ createMapOccurrence }) => {
      const occurrence = createMapOccurrence(
        () => wireToState(wireRef.current),
        sessionId,
        MAP_VIEW_OCCURRENCE_KEY,
        {
          onGestureObservation: (text, observation) => {
            const submit = gestureSubmitRef.current
            const mode = gestureSubmitMode(observation.kind, runningRef.current)
            if (submit === undefined || mode === null) return
            void submit(sessionId, text, mode).catch(() => {
              // Advisory input: a lost race holds; it is never a map error.
            })
          },
        },
      )
      if (cancelled) {
        occurrence.dispose()
        return
      }
      occurrenceRef.current = occurrence
      occurrence.mount(holder.current ?? undefined)
      setLoadState({ kind: 'ready' })
      const action = mapViewRequestAction(viewRequestRef.current, wireRef.current?.layers, true)
      if (action.kind === 'complete') {
        if (action.focus && action.layerId !== null) occurrence.focusLayer(action.layerId)
        completeRef.current()
      }
    }).catch(() => {
      if (cancelled) return
      setLoadState({ kind: 'error' })
    })
    return () => {
      cancelled = true
      occurrenceRef.current?.dispose()
      occurrenceRef.current = null
    }
  }, [loadAttempt, sessionId])

  useEffect(() => {
    occurrenceRef.current?.refresh(wireToState(wire))
  }, [wire])

  useEffect(() => {
    const action = mapViewRequestAction(viewRequest, wire?.layers, occurrenceRef.current !== null)
    if (action.kind === 'ignore' || action.kind === 'defer') return
    if (action.focus && action.layerId !== null) occurrenceRef.current?.focusLayer(action.layerId)
    completeViewRequest()
  }, [viewRequest, wire, completeViewRequest])

  return (
    <section
      data-map-container=""
      data-map-view=""
      style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}
    >
      <div ref={bindHolder} style={{ position: 'absolute', inset: 0 }} />
      {loadState.kind === 'loading' && <p data-map-state="loading" role="status" aria-live="polite">{t('view.loading')}</p>}
      {loadState.kind === 'error' && (
        <p data-map-state="error" role="alert">
          {t('view.loadError')}
          <button type="button" onClick={() => setLoadAttempt(value => value + 1)}>{t('view.retry')}</button>
        </p>
      )}
    </section>
  )
}
