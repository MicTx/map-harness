/** Geometry for a map panel inside its available positioning area. */

/** Panel position and size in its positioning area. */
export interface PanelRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The edges moved by a resize gesture. */
export type ResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'

const MIN_WIDTH = 240
const MIN_HEIGHT = 180

/**
 * Keep the complete panel inside the available area.
 * @param rect - requested panel geometry.
 * @param bounds - available width and height.
 * @returns the constrained geometry.
 */
export function constrainPanel(rect: PanelRect, bounds: { readonly width: number; readonly height: number }): PanelRect {
  const width = Math.min(Math.max(Math.min(MIN_WIDTH, bounds.width), rect.width), bounds.width)
  const height = Math.min(Math.max(Math.min(MIN_HEIGHT, bounds.height), rect.height), bounds.height)
  return {
    x: Math.max(0, Math.min(rect.x, bounds.width - width)),
    y: Math.max(0, Math.min(rect.y, bounds.height - height)),
    width,
    height,
  }
}

/**
 * Resize the named edges while keeping their opposite edges fixed.
 * @param rect - current constrained geometry.
 * @param direction - edges controlled by the pointer.
 * @param dx - horizontal pointer displacement.
 * @param dy - vertical pointer displacement.
 * @param bounds - available width and height.
 * @returns the resized geometry.
 */
export function resizePanel(rect: PanelRect, direction: ResizeDirection, dx: number, dy: number, bounds: { readonly width: number; readonly height: number }): PanelRect {
  const minWidth = Math.min(MIN_WIDTH, bounds.width)
  const minHeight = Math.min(MIN_HEIGHT, bounds.height)
  const left = direction.includes('w') ? Math.max(0, Math.min(rect.x + rect.width - minWidth, rect.x + dx)) : rect.x
  const right = direction.includes('e') ? Math.min(bounds.width, Math.max(rect.x + minWidth, rect.x + rect.width + dx)) : rect.x + rect.width
  const top = direction.includes('n') ? Math.max(0, Math.min(rect.y + rect.height - minHeight, rect.y + dy)) : rect.y
  const bottom = direction.includes('s') ? Math.min(bounds.height, Math.max(rect.y + minHeight, rect.y + rect.height + dy)) : rect.y + rect.height
  return { x: left, y: top, width: right - left, height: bottom - top }
}
