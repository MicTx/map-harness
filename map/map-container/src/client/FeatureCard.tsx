/**
 * The feature attribute card: a floating panel that shows one hovered
 * feature's fields as plain text and follows its projected geometry.
 * The card measures itself, observes the map overlay's floating surfaces,
 * and keeps a bounded placement inside the map container.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FeatureInspectionFrame, FeatureScreenRect } from './feature-card-anchor.ts'
import { placeFeatureCard, type FeatureCardPlacement } from './feature-card-placement.ts'

/** Card props: the open inspection and anchor, the close action, and the locale. */
export interface FeatureCardProps {
  readonly inspection: FeatureInspectionFrame
  readonly onClose: () => void
  readonly t: TranslateNS<'mapContainer'>
}

/** Visible map floating surfaces the card must stay clear of. */
const FLOATING_OBSTACLE_SELECTOR = [
  '[data-map-panel]',
  '[data-map-panel-toggle]',
  '[data-map-workbench]',
  '[data-map-use-status]',
  '[data-map-state]',
  '[data-map-source-error]',
  '[data-map-canvas] .esri-view-attribution',
  '[data-map-canvas] .esri-ui .esri-component',
].join(', ')

function localRect(rect: DOMRect, origin: DOMRect): FeatureScreenRect {
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    right: rect.right - origin.left,
    bottom: rect.bottom - origin.top,
  }
}

function visibleRect(element: Element, overlayRect: DOMRect): FeatureScreenRect | null {
  const style = globalThis.getComputedStyle?.(element)
  if (style?.display === 'none' || style?.visibility === 'hidden') return null
  const rect = element.getBoundingClientRect()
  if (!(rect.width > 0 && rect.height > 0)) return null
  return localRect(rect, overlayRect)
}

function placementKey(placement: FeatureCardPlacement): string {
  return [placement.left, placement.top, placement.width, placement.height, placement.side, placement.overlap, placement.constrained].join(':')
}

/**
 * Render one feature's attribute card around its projected screen anchor.
 * @param props - the inspection frame, close action, and locale.
 * @returns the card element.
 */
export function FeatureCard({ inspection, onClose, t }: FeatureCardProps): ReactNode {
  const cardRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape' && !event.defaultPrevented) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const card = cardRef.current
    const overlay = card?.parentElement
    const map = card?.closest('[data-map-container]')
    if (card === null || overlay === null || overlay === undefined || map === undefined || map === null) return
    let frame: number | null = null
    let lastKey: string | null = null
    let resizeObserver: ResizeObserver | undefined
    let mutationObserver: MutationObserver | undefined
    const apply = (): void => {
      const overlayRect = overlay.getBoundingClientRect()
      const mapRect = map.getBoundingClientRect()
      // toScreen is canvas-relative; the canvas is inset to the map container.
      const anchor: FeatureScreenRect = {
        left: mapRect.left + inspection.anchor.left - overlayRect.left,
        top: mapRect.top + inspection.anchor.top - overlayRect.top,
        right: mapRect.left + inspection.anchor.right - overlayRect.left,
        bottom: mapRect.top + inspection.anchor.bottom - overlayRect.top,
      }
      card.style.width = ''
      card.style.height = ''
      const cardRect = card.getBoundingClientRect()
      const obstacles = [...map.querySelectorAll(FLOATING_OBSTACLE_SELECTOR)]
        .filter(element => element !== card && !card.contains(element))
        .map(element => visibleRect(element, overlayRect))
        .filter((rect): rect is FeatureScreenRect => rect !== null)
      const placement = placeFeatureCard({
        anchor,
        card: { width: cardRect.width || card.offsetWidth || 300, height: cardRect.height || card.offsetHeight || 160 },
        viewport: { width: overlayRect.width || mapRect.width, height: overlayRect.height || mapRect.height },
        obstacles,
      })
      if (placement === null) {
        card.style.visibility = 'hidden'
        return
      }
      const key = placementKey(placement)
      if (key === lastKey) {
        card.style.width = `${placement.width}px`
        card.style.height = `${placement.height}px`
        card.style.visibility = 'visible'
        return
      }
      lastKey = key
      card.style.left = `${placement.left}px`
      card.style.top = `${placement.top}px`
      card.style.width = `${placement.width}px`
      card.style.height = `${placement.height}px`
      card.style.visibility = 'visible'
      card.dataset.mapFeatureSide = placement.side
      card.dataset.mapFeatureConstrained = placement.constrained ? 'true' : 'false'
      card.dataset.mapFeatureOverlap = String(placement.overlap)
    }
    const schedule = (): void => {
      if (frame !== null) return
      frame = globalThis.requestAnimationFrame(() => {
        frame = null
        apply()
      })
    }
    apply()
    if (typeof globalThis.ResizeObserver === 'function') {
      resizeObserver = new globalThis.ResizeObserver(schedule)
      resizeObserver.observe(card)
      resizeObserver.observe(overlay)
      for (const element of map.querySelectorAll(FLOATING_OBSTACLE_SELECTOR)) resizeObserver.observe(element)
    }
    if (typeof globalThis.MutationObserver === 'function') {
      mutationObserver = new globalThis.MutationObserver(records => {
        if (records.some(record => record.target === card || card.contains(record.target))) return
        schedule()
      })
      mutationObserver.observe(map, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'open'] })
    }
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== null) globalThis.cancelAnimationFrame(frame)
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [inspection.anchor.left, inspection.anchor.top, inspection.anchor.right, inspection.anchor.bottom])

  const heading = inspection.title ?? inspection.layerName
  return (
    <section ref={cardRef} data-map-feature-card="" role="dialog" aria-label={t('feature.card', { name: heading })}>
      <header data-map-feature-card-head="">
        <div>
          <h3>{heading}</h3>
          {inspection.title !== null && <p>{inspection.layerName}</p>}
        </div>
        <Button data-map-panel-icon="" aria-label={t('feature.close')} title={t('feature.close')} onClick={onClose}>×</Button>
      </header>
      {inspection.fields.length === 0
        ? <p data-map-feature-card-empty="">{t('feature.empty')}</p>
        : (
            <dl>
              {inspection.fields.map(field => (
                <div key={field.name}>
                  <dt title={field.name}>{field.name}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          )}
      {inspection.omitted > 0 && <p data-map-feature-card-more="">{t('feature.omitted', { n: String(inspection.omitted) })}</p>}
    </section>
  )
}
