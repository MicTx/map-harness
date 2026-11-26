/**
 * Mapbox GL JS-compatible controls over one map instance. DOM structure,
 * geometry, and icons mirror the official `mapbox-gl@3` stylesheet; the
 * occurrence owns every camera write so the controls never stage map state.
 * @module @map-harness/map-container/client/mapbox-controls
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MapControlState, MapOccurrence } from './face.ts'

/** Props for the Mapbox-compatible control groups. */
export interface MapboxControlsProps {
  /** Resolves the live occurrence; a missing occurrence disables camera writes. */
  readonly occurrence: () => MapOccurrence | null
  readonly t: TranslateNS<'mapContainer'>
}

/** Camera polling interval; matches the occurrence's other live read loops. */
const POLL_MS = 250

/**
 * Render NavigationControl, FullscreenControl, ScaleControl, and the compact
 * AttributionControl at their official corners, above the SDK's attribution footer.
 * @param props - occurrence resolver and locale dictionary.
 * @returns the four control groups over the map instance.
 */
export function MapboxControls({ occurrence, t }: MapboxControlsProps): ReactNode {
  const root = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<MapControlState | null>(null)
  const [attributionOpen, setAttributionOpen] = useState(false)
  const [attributionText, setAttributionText] = useState('')
  const [fullscreen, setFullscreen] = useState(false)

  useEffect(() => {
    const read = (): void => { setState(occurrence()?.mapControlState() ?? null) }
    read()
    const timer = globalThis.setInterval(read, POLL_MS)
    return () => globalThis.clearInterval(timer)
  }, [occurrence])

  useEffect(() => {
    const icon = root.current?.querySelector<HTMLElement>('[data-mapbox-ctrl-compass] > [data-mapbox-ctrl-icon]')
    icon?.style.setProperty('--mapbox-compass-rotation', `${-(state?.rotation ?? 0)}deg`)
  }, [state])

  useEffect(() => {
    const controls = root.current
    const canvas = controls?.closest('[data-map-container]')?.querySelector('[data-map-canvas]')
    const overlay = controls?.parentElement
    if (controls === null || canvas == null) return
    let attribution: Element | null = null
    const measure = (): void => {
      const height = attribution?.getBoundingClientRect().height ?? 0
      if (height > 0) controls.style.setProperty('--map-attribution-height', `${Math.ceil(height)}px`)
      else controls.style.removeProperty('--map-attribution-height')
      if (height > 0) overlay?.style.setProperty('--map-attribution-height', `${Math.ceil(height)}px`)
      else overlay?.style.removeProperty('--map-attribution-height')
    }
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    const refresh = (changes?: MutationRecord[]): void => {
      if (attribution === null || !canvas.contains(attribution)) {
        resize?.disconnect()
        attribution = canvas.querySelector('.esri-view-attribution')
        if (attribution !== null) resize?.observe(attribution)
        measure()
      } else if (changes !== undefined && !changes.some(change => attribution?.contains(change.target))) {
        return
      }
      setAttributionText(attribution?.textContent?.trim() ?? '')
    }
    refresh()
    const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(refresh)
    observer?.observe(canvas, { childList: true, subtree: true, characterData: true })
    return () => {
      observer?.disconnect()
      resize?.disconnect()
      controls.style.removeProperty('--map-attribution-height')
      overlay?.style.removeProperty('--map-attribution-height')
    }
  }, [])

  useEffect(() => {
    const doc = globalThis.document
    if (doc === undefined) return
    const read = (): void => { setFullscreen(Boolean(doc.fullscreenElement)) }
    doc.addEventListener('fullscreenchange', read)
    return () => doc.removeEventListener('fullscreenchange', read)
  }, [])

  const camera = (write: (target: MapOccurrence) => void): void => {
    const target = occurrence()
    if (target === null) return
    write(target)
    setState(target.mapControlState())
  }

  const toggleFullscreen = (): void => {
    const container = root.current?.closest<HTMLElement>('[data-map-container]')
    if (container === null || container === undefined) return
    const doc = globalThis.document
    if (doc?.fullscreenElement === container) void doc.exitFullscreen?.()
    else void container.requestFullscreen?.()
  }

  return (
    <div ref={root} data-mapbox-controls="">
      <div data-mapbox-ctrl-top-right="">
        <div data-mapbox-ctrl="" data-mapbox-ctrl-group="" data-mapbox-ctrl-navigation="">
          <button type="button" data-mapbox-ctrl-zoom-in="" aria-label={t('control.zoomIn')} title={t('control.zoomIn')} onClick={() => camera(target => { target.zoomBy(1) })}>
            <span data-mapbox-ctrl-icon="" aria-hidden="true" />
          </button>
          <button type="button" data-mapbox-ctrl-zoom-out="" aria-label={t('control.zoomOut')} title={t('control.zoomOut')} onClick={() => camera(target => { target.zoomBy(-1) })}>
            <span data-mapbox-ctrl-icon="" aria-hidden="true" />
          </button>
          <button type="button" data-mapbox-ctrl-compass="" aria-label={t('control.compass')} title={t('control.compass')} onClick={() => camera(target => { target.resetBearing() })}>
            <span data-mapbox-ctrl-icon="" aria-hidden="true" />
          </button>
        </div>
        <div data-mapbox-ctrl="" data-mapbox-ctrl-group="">
          <button type="button" data-mapbox-ctrl-fullscreen="" aria-label={t('control.fullscreen')} title={t('control.fullscreen')} aria-pressed={fullscreen} onClick={toggleFullscreen}>
            <span data-mapbox-ctrl-icon="" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div data-mapbox-ctrl-bottom-left="">
        <div data-mapbox-ctrl="" data-mapbox-ctrl-scale="" role="status" aria-label={t('control.scale')} style={{ width: '100px' }}>
          {state?.scaleLabel ?? ''}
        </div>
      </div>
      <div data-mapbox-ctrl-bottom-right="">
        <div
          data-mapbox-ctrl="" data-mapbox-ctrl-attrib="" data-mapbox-compact=""
          data-mapbox-compact-show={attributionOpen ? '' : undefined}
        >
          <span data-mapbox-ctrl-attrib-inner="">{attributionText}</span>
          <button
            type="button" data-mapbox-ctrl-attrib-button="" aria-label={t('control.attribution')}
            title={t('control.attribution')} aria-expanded={attributionOpen}
            onClick={() => setAttributionOpen(open => !open)}
          />
        </div>
      </div>
    </div>
  )
}
