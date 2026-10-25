/**
 * The label overlay: placed labels drawn as absolutely positioned HTML text
 * over the map canvas. ArcGIS 2D text symbols only draw fonts hosted as glyph
 * PBFs, so CSS text is the one way labels use the system font stack
 * (Microsoft YaHei first). The overlay never takes pointer events: hover and
 * gestures reach the map beneath it.
 * @module @map-harness/map-container/client/label-overlay
 */
import { LABEL_FONT_FAMILY, LABEL_FONT_PX, type PlacedLabel } from './labeling.ts'

/** Crisp white outline around label text (no blur), readable on imagery and light basemaps. */
const LABEL_STROKE_WIDTH_PX = 3

/** Solid opaque white, never translucent. */
const LABEL_STROKE_COLOR = '#ffffff'

/** Fade-in time of a label that was not drawn before (MapLibre's default `fadeDuration`). */
const LABEL_FADE_MS = 300

/** One mounted label overlay. */
export interface LabelOverlay {
  /** Replace the drawn labels; an empty list clears the overlay. */
  render(labels: readonly PlacedLabel[]): void
  /** Hide the drawn labels while the map is being operated, show them again when it settles. */
  setSuspended(suspended: boolean): void
  /** The labels currently drawn. */
  readonly labels: readonly PlacedLabel[]
  /** Remove the overlay element. */
  dispose(): void
}

/**
 * Mount one overlay into the map holder.
 * @param holder - the element the map view is mounted into.
 * @returns the overlay; a holder without a document only records labels.
 */
export function createLabelOverlay(holder: HTMLDivElement): LabelOverlay {
  const document = holder.ownerDocument ?? undefined
  let root: HTMLDivElement | undefined
  let drawn: readonly PlacedLabel[] = []
  let byKey = new Map<string, HTMLElement>()
  let hidden = false
  return {
    setSuspended(suspended) {
      hidden = suspended
      if (root !== undefined) root.style.visibility = hidden ? 'hidden' : 'visible'
    },
    render(labels) {
      drawn = labels
      if (document === undefined) return
      if (root === undefined) {
        root = document.createElement('div')
        root.setAttribute('data-map-labels', '')
        root.setAttribute('aria-hidden', 'true')
        root.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:0'
        holder.appendChild(root)
      }
      root.style.visibility = hidden ? 'hidden' : 'visible'
      const previous = byKey
      byKey = new Map()
      const items = labels.map(label => {
        const kept = previous.get(label.key)
        if (kept !== undefined && kept.textContent === label.text) {
          kept.style.transform = `translate3d(${label.x}px,${label.y}px,0) translate(-50%,-50%)`
          kept.style.color = label.color
          byKey.set(label.key, kept)
          return kept
        }
        const item = document.createElement('div')
        item.textContent = label.text
        item.style.cssText = [
          'position:absolute',
          'left:0',
          'top:0',
          'will-change:transform',
          `transform:translate3d(${label.x}px,${label.y}px,0) translate(-50%,-50%)`,
          'white-space:nowrap',
          `font:${LABEL_FONT_PX}px/1.2 ${LABEL_FONT_FAMILY}`,
          `color:${label.color}`,
          'font-weight:500',
          `-webkit-text-stroke:${LABEL_STROKE_WIDTH_PX}px ${LABEL_STROKE_COLOR}`,
          'paint-order:stroke fill',
          'stroke-linejoin:round',
          'text-shadow:none',
          'opacity:0',
          `transition:opacity ${LABEL_FADE_MS}ms ease-out`,
        ].join(';')
        // A label that was not on screen fades in; the next frame lets the transition start from opacity 0.
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { item.style.opacity = '1' })
        else item.style.opacity = '1'
        byKey.set(label.key, item)
        return item
      })
      root.replaceChildren(...items)
    },
    get labels() { return drawn },
    dispose() {
      root?.remove()
      root = undefined
      drawn = []
      byKey = new Map()
    },
  }
}
