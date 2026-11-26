import type { ImageryDisplayState } from './protocol.ts'

/**
 * Make a newly selected or enabled early layer visible beneath an untouched recent layer.
 * @param display - proposed display state, including the early-layer visibility.
 * @returns the proposed state with a fully opaque, visible recent layer blended at 50%.
 */
export function blendEarlyImagery(display: ImageryDisplayState): ImageryDisplayState {
  return display.earlyVisible && display.recentVisible && display.recentOpacity === 1
    ? { ...display, recentOpacity: 0.5 }
    : display
}
