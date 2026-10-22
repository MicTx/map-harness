/**
 * The label overlay: placed labels drawn as absolutely positioned HTML text
 * over the map canvas. ArcGIS 2D text symbols only draw fonts hosted as glyph
 * PBFs, so CSS text is the one way labels use the system font stack
 * (Microsoft YaHei first). The overlay never takes pointer events: hover and
 * gestures reach the map beneath it.
 * @module @map-harness/map-container/client/label-overlay
 */
import { LABEL_FONT_FAMILY, LABEL_FONT_PX, type PlacedLabel } from './labeling.ts'

/** Halo drawn around label text (white, readable on imagery and light basemaps). */
const LABEL_HALO_SHADOW = '0 0 2px #fff, 0 0 2px #fff, 0 0 3px rgba(255, 255, 255, 0.95)'

/** One mounted label overlay. */
export interface LabelOverlay {
  /** Replace the drawn labels; an empty list clears the overlay. */
  render(labels: readonly PlacedLabel[]): void
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
  return {
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
      const items = labels.map(label => {
        const item = document.createElement('div')
        item.textContent = label.text
        item.style.cssText = [
          'position:absolute',
          `left:${label.x}px`,
          `top:${label.y}px`,
          'transform:translate(-50%,-50%)',
          'white-space:nowrap',
          `font:${LABEL_FONT_PX}px/1.2 ${LABEL_FONT_FAMILY}`,
          `color:${label.color}`,
          `text-shadow:${LABEL_HALO_SHADOW}`,
        ].join(';')
        return item
      })
      root.replaceChildren(...items)
    },
    get labels() { return drawn },
    dispose() {
      root?.remove()
      root = undefined
      drawn = []
    },
  }
}
