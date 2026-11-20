/**
 * The label overlay: placed labels drawn as absolutely positioned HTML text
 * over the map canvas. ArcGIS 2D text symbols only draw fonts hosted as glyph
 * PBFs, so CSS text is the one way labels use the system font stack
 * (Microsoft YaHei first). The overlay never takes pointer events: hover and
 * gestures reach the map beneath it.
 * @module @map-harness/map-container/client/label-overlay
 */
import { LABEL_FONT_FAMILY, LABEL_FONT_PX, LABEL_STROKE_COLOR, LABEL_STROKE_WIDTH_PX, type ClusterBadge, type PlacedLabel } from './labeling.ts'

/** Fade-in time of a label that was not drawn before (MapLibre's default `fadeDuration`). */
const LABEL_FADE_MS = 300

/** Localized badge copy of one cluster count. */
export interface ClusterCopy {
  /** The badge face, e.g. `+12`. */
  readonly text: string
  /** The accessible hover hint of the badge. */
  readonly title: string
}

/** Cluster badge hooks: localized copy plus the click-to-zoom callback. */
export interface LabelOverlayHooks {
  /** Localized "+N" face and hover hint of a badge. */
  readonly clusterCopy?: (count: number) => ClusterCopy
  /** Receives the badge the user clicked. */
  readonly onClusterClick?: (badge: ClusterBadge) => void
}

/** One mounted label overlay. */
export interface LabelOverlay {
  /** Replace the drawn labels and cluster badges; empty lists clear the overlay. */
  render(labels: readonly PlacedLabel[], clusters?: readonly ClusterBadge[]): void
  /** Hide the drawn content while the map is being operated, show it again when it settles. */
  setSuspended(suspended: boolean): void
  /** The labels currently drawn. */
  readonly labels: readonly PlacedLabel[]
  /** The cluster badges currently drawn. */
  readonly clusters: readonly ClusterBadge[]
  /** Remove the overlay element. */
  dispose(): void
}

/**
 * Mount one overlay into the map holder.
 * @param holder - the element the map view is mounted into.
 * @param hooks - localized cluster badge copy and its click callback.
 * @returns the overlay; a holder without a document only records labels and badges.
 */
export function createLabelOverlay(holder: HTMLDivElement, hooks: LabelOverlayHooks = {}): LabelOverlay {
  const document = holder.ownerDocument ?? undefined
  let root: HTMLDivElement | undefined
  let drawn: readonly PlacedLabel[] = []
  let drawnClusters: readonly ClusterBadge[] = []
  let byKey = new Map<string, HTMLElement>()
  let hidden = false
  return {
    setSuspended(suspended) {
      hidden = suspended
      if (root !== undefined) root.style.visibility = hidden ? 'hidden' : 'visible'
    },
    render(labels, clusters = []) {
      drawn = labels
      drawnClusters = clusters
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
      // Badges are the only hit-testable content: the overlay root and the
      // labels stay pointer-transparent so gestures reach the map beneath.
      const badges = clusters.map(badge => {
        const item = document.createElement('div')
        const copy = hooks.clusterCopy?.(badge.count) ?? { text: `+${badge.count}`, title: '' }
        item.textContent = copy.text
        item.setAttribute('data-map-label-cluster', '')
        if (copy.title !== '') {
          item.setAttribute('title', copy.title)
          item.setAttribute('aria-label', copy.title)
        }
        item.style.cssText = [
          'position:absolute',
          'left:0',
          'top:0',
          `transform:translate3d(${badge.x}px,${badge.y}px,0) translate(-50%,-50%)`,
          'pointer-events:auto',
          'cursor:pointer',
          'min-width:20px',
          'box-sizing:border-box',
          'padding:1px 6px',
          'border-radius:999px',
          'text-align:center',
          `font:${LABEL_FONT_PX}px/1.2 ${LABEL_FONT_FAMILY}`,
          'font-weight:600',
          `color:${LABEL_STROKE_COLOR}`,
          'background:var(--map-accent, #3370ff)',
          'border:0',
        ].join(';')
        item.onclick = () => { hooks.onClusterClick?.(badge) }
        return item
      })
      root.replaceChildren(...items, ...badges)
    },
    get labels() { return drawn },
    get clusters() { return drawnClusters },
    dispose() {
      root?.remove()
      root = undefined
      drawn = []
      drawnClusters = []
      byKey = new Map()
    },
  }
}
