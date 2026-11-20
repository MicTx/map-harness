/**
 * Deterministic screen-space placement for the hovered feature card.
 *
 * The helper works in map-overlay pixels and knows only rectangles: the
 * occurrence supplies the projected feature anchor, the React layer measures
 * the card and visible floating surfaces, and this module chooses one bounded
 * position without DOM or framework dependencies.
 *
 * @module @map-harness/map-container/client/feature-card-placement
 */

/** One screen rectangle in map-overlay pixels. */
export interface FeatureScreenRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** The side of the feature anchor the card takes. */
export type FeatureCardSide = 'right' | 'left' | 'bottom' | 'top'

/** One measured card placement request. */
export interface FeatureCardPlacementInput {
  /** The projected feature rectangle. */
  readonly anchor: FeatureScreenRect
  /** The card's measured border-box size. */
  readonly card: { readonly width: number; readonly height: number }
  /** The map-overlay size. */
  readonly viewport: { readonly width: number; readonly height: number }
  /** Visible map floating surfaces to avoid. */
  readonly obstacles: readonly FeatureScreenRect[]
  /** Clear space between the anchor and card. Defaults to 8px. */
  readonly gap?: number
  /** Clear space between the card and the overlay edge. Defaults to 8px. */
  readonly margin?: number
}

/** One chosen card rectangle and the quality of its fit. */
export interface FeatureCardPlacement {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly side: FeatureCardSide
  /** Obstacle intersection area in square pixels; zero whenever a clean candidate fits. */
  readonly overlap: number
  /** Whether the full card size did not fit and the result was reduced or degraded. */
  readonly constrained: boolean
}

interface Candidate {
  readonly side: FeatureCardSide
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
  readonly constrained: boolean
}

const DEFAULT_GAP = 8
const DEFAULT_MARGIN = 8

function finiteRect(rect: FeatureScreenRect): boolean {
  return [rect.left, rect.top, rect.right, rect.bottom].every(Number.isFinite)
    && rect.right >= rect.left && rect.bottom >= rect.top
}

function intersectionArea(left: FeatureScreenRect, right: FeatureScreenRect): number {
  const width = Math.min(left.right, right.right) - Math.max(left.left, right.left)
  const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top)
  return width > 0 && height > 0 ? width * height : 0
}

function rectOf(left: number, top: number, width: number, height: number): FeatureScreenRect {
  return { left, top, right: left + width, bottom: top + height }
}

function inside(rect: FeatureScreenRect, bounds: FeatureScreenRect): boolean {
  return rect.left >= bounds.left && rect.top >= bounds.top && rect.right <= bounds.right && rect.bottom <= bounds.bottom
}

function candidateOverlaps(candidate: Candidate, anchor: FeatureScreenRect, obstacles: readonly FeatureScreenRect[]): number {
  const rect = rectOf(candidate.left, candidate.top, candidate.width, candidate.height)
  return obstacles.reduce((total, obstacle) => total + intersectionArea(rect, obstacle), intersectionArea(rect, anchor))
}

function crossPositions(anchor: FeatureScreenRect, size: number): number[] {
  return [(anchor.top + anchor.bottom - size) / 2, anchor.top, anchor.bottom - size]
}

function horizontalPositions(anchor: FeatureScreenRect, size: number): number[] {
  return [(anchor.left + anchor.right - size) / 2, anchor.left, anchor.right - size]
}

function candidatesOf(
  anchor: FeatureScreenRect,
  width: number,
  height: number,
  gap: number,
  safe: FeatureScreenRect,
  constrained: boolean,
): readonly Candidate[] {
  const candidates: Candidate[] = []
  const horizontalSides: readonly FeatureCardSide[] = ['right', 'left', 'bottom', 'top']
  for (const side of horizontalSides) {
    const horizontal = side === 'right' || side === 'left'
    const availableMain = side === 'right'
      ? safe.right - anchor.right - gap
      : side === 'left'
        ? anchor.left - gap - safe.left
        : side === 'bottom'
          ? safe.bottom - anchor.bottom - gap
          : anchor.top - gap - safe.top
    const availableCross = horizontal ? safe.bottom - safe.top : safe.right - safe.left
    const usedWidth = constrained && horizontal ? Math.min(width, Math.max(0, availableMain)) : width
    const usedHeight = constrained && horizontal ? Math.min(height, Math.max(0, availableCross)) : height
    const usedMainWidth = constrained && !horizontal ? Math.min(width, Math.max(0, availableCross)) : width
    const usedMainHeight = constrained && !horizontal ? Math.min(height, Math.max(0, availableMain)) : height
    const usedSizeWidth = horizontal ? usedWidth : usedMainWidth
    const usedSizeHeight = horizontal ? usedHeight : usedMainHeight
    const main = side === 'right'
      ? anchor.right + gap
      : side === 'left'
        ? anchor.left - gap - usedSizeWidth
        : side === 'bottom'
          ? anchor.bottom + gap
          : anchor.top - gap - usedSizeHeight
    const cross = horizontal
      ? crossPositions(anchor, usedSizeHeight)
      : horizontalPositions(anchor, usedSizeWidth)
    for (const crossValue of cross) {
      const left = horizontal ? main : crossValue
      const top = horizontal ? crossValue : main
      if (usedSizeWidth <= 0 || usedSizeHeight <= 0) continue
      candidates.push({ side, left, top, width: usedSizeWidth, height: usedSizeHeight, constrained })
    }
  }
  return candidates
}

/**
 * Choose one bounded placement around a projected feature.
 * @param input - measured anchor, card size, viewport, and visible floating surfaces.
 * @returns the chosen rectangle, or `null` when any required measurement is invalid.
 */
export function placeFeatureCard(input: FeatureCardPlacementInput): FeatureCardPlacement | null {
  const { anchor, card, viewport, obstacles } = input
  const gap = input.gap ?? DEFAULT_GAP
  const margin = input.margin ?? DEFAULT_MARGIN
  if (!finiteRect(anchor) || !Number.isFinite(card.width) || !Number.isFinite(card.height)
    || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
    || !Number.isFinite(gap) || !Number.isFinite(margin)
    || card.width < 0 || card.height < 0 || viewport.width < 0 || viewport.height < 0
    || gap < 0 || margin < 0 || obstacles.some(obstacle => !finiteRect(obstacle))) return null
  const safe = rectOf(margin, margin, Math.max(0, viewport.width - margin * 2), Math.max(0, viewport.height - margin * 2))
  const fullWidth = Math.min(card.width, safe.right - safe.left)
  const fullHeight = Math.min(card.height, safe.bottom - safe.top)
  const clean = candidatesOf(anchor, fullWidth, fullHeight, gap, safe, false)
    .find(candidate => {
      const rect = rectOf(candidate.left, candidate.top, candidate.width, candidate.height)
      return inside(rect, safe) && candidateOverlaps(candidate, anchor, obstacles) === 0
    })
  if (clean !== undefined) {
    return { left: clean.left, top: clean.top, width: clean.width, height: clean.height, side: clean.side, overlap: 0, constrained: clean.width !== card.width || clean.height !== card.height }
  }
  const reduced = candidatesOf(anchor, fullWidth, fullHeight, gap, safe, true)
    .find(candidate => {
      const rect = rectOf(candidate.left, candidate.top, candidate.width, candidate.height)
      return candidate.width > 0 && candidate.height > 0 && inside(rect, safe) && candidateOverlaps(candidate, anchor, obstacles) === 0
    })
  if (reduced !== undefined) {
    return { left: reduced.left, top: reduced.top, width: reduced.width, height: reduced.height, side: reduced.side, overlap: 0, constrained: true }
  }
  const fallback = [...candidatesOf(anchor, fullWidth, fullHeight, gap, safe, true)]
    .map(candidate => {
      const raw = rectOf(candidate.left, candidate.top, candidate.width, candidate.height)
      const left = Math.max(safe.left, Math.min(candidate.left, safe.right - candidate.width))
      const top = Math.max(safe.top, Math.min(candidate.top, safe.bottom - candidate.height))
      const overflow = Math.max(0, safe.left - raw.left) + Math.max(0, safe.top - raw.top)
        + Math.max(0, raw.right - safe.right) + Math.max(0, raw.bottom - safe.bottom)
      const anchorCenterX = (anchor.left + anchor.right) / 2
      const anchorCenterY = (anchor.top + anchor.bottom) / 2
      const distance = Math.abs((left + candidate.width / 2) - anchorCenterX) + Math.abs((top + candidate.height / 2) - anchorCenterY)
      return {
        candidate: { ...candidate, left, top },
        score: candidateOverlaps({ ...candidate, left, top }, anchor, obstacles) + overflow * 10_000 + distance,
      }
    })
    .sort((left, right) => left.score - right.score)[0]
  if (fallback === undefined) return null
  const chosen = fallback.candidate
  return {
    left: chosen.left,
    top: chosen.top,
    width: chosen.width,
    height: chosen.height,
    side: chosen.side,
    overlap: candidateOverlaps(chosen, anchor, obstacles),
    constrained: true,
  }
}
