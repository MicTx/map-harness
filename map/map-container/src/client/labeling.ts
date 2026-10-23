/**
 * Automatic labeling with collision avoidance, as a pure screen-space
 * placement step. The occurrence projects each labelable feature to screen
 * pixels, this module chooses at most one non-overlapping position per
 * feature (labels never overlap each other, point markers, or the viewport
 * edge), and the occurrence draws the winners as text graphics.
 *
 * Placement is greedy by priority: earlier candidates (higher layers, then
 * feature order) claim space first, and each point tries the Mapbox
 * `text-variable-anchor` order (top, right, bottom, left) before it is
 * dropped. Lines and polygons label at their anchor centre only.
 *
 * @module @map-harness/map-container/client/labeling
 */

/** Property names a layer labels by when its symbol names no field (first present wins). */
export const LABEL_FIELD_CANDIDATES: readonly string[] = ['name', 'Name', 'NAME', '名称', 'title', 'label', 'title_zh', 'name_zh']

/** Label font size in pixels. */
export const LABEL_FONT_PX = 10.5

/** Label CSS font stack: Microsoft YaHei first, then common CJK system faces. */
export const LABEL_FONT_FAMILY = '"Microsoft YaHei", "微软雅黑", "PingFang SC", "Noto Sans SC", sans-serif'

/** Approximate glyph advance as a fraction of the font size (CJK glyphs count double). */
const LATIN_ADVANCE = 0.6
const WIDE_ADVANCE = 1.05

/** Padding kept between any two placed boxes, in pixels. */
export const LABEL_PADDING_PX = 3

/** Gap between a marker edge and its label, in pixels. */
const MARKER_GAP_PX = 4

/** Longest label text drawn; longer values are truncated with an ellipsis. */
export const MAX_LABEL_CHARS = 24

/** Most labels drawn in one placement pass. */
export const MAX_PLACED_LABELS = 400

/** One labelable feature already projected to screen pixels. */
export interface LabelCandidate {
  readonly key: string
  readonly text: string
  readonly kind: 'point' | 'line' | 'polygon'
  /** Screen anchor in pixels (feature point, line midpoint, polygon centroid). */
  readonly x: number
  readonly y: number
  /** Marker diameter for points (the obstacle and the anchor offset). */
  readonly markerPx: number
  /** Text color: the layer's main color, so a label reads as its layer. */
  readonly color: string
}

/** One placed label: the box centre in screen pixels and its text. */
export interface PlacedLabel {
  readonly key: string
  readonly text: string
  readonly x: number
  readonly y: number
  readonly anchor: 'top' | 'right' | 'bottom' | 'left' | 'center'
  readonly color: string
}

/** One axis-aligned screen box. */
interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/**
 * Read one feature's label text: the named field, else the first candidate
 * field present. Only finite numbers and non-empty strings label; the text is
 * whitespace-collapsed and truncated.
 * @param properties - the feature properties.
 * @param field - the symbol's declared label field, when any.
 * @returns the display text, or `null` when the feature has nothing to label.
 */
export function labelTextOf(properties: Record<string, unknown> | null | undefined, field: string | undefined): string | null {
  if (properties === null || properties === undefined) return null
  const fields = field === undefined ? LABEL_FIELD_CANDIDATES : [field]
  for (const name of fields) {
    if (!Object.hasOwn(properties, name)) continue
    const value = properties[name]
    let text: string | null = null
    if (typeof value === 'string') text = value.replace(/\s+/gu, ' ').trim()
    else if (typeof value === 'number' && Number.isFinite(value)) text = String(value)
    if (text === null || text.length === 0) continue
    const chars = [...text]
    return chars.length > MAX_LABEL_CHARS ? `${chars.slice(0, MAX_LABEL_CHARS - 1).join('')}…` : text
  }
  return null
}

/**
 * Estimate one label's rendered width in pixels.
 * @param text - the display text.
 * @returns the width estimate.
 */
export function labelWidthOf(text: string): number {
  let width = 0
  for (const char of text) width += (char.codePointAt(0) ?? 0) > 0x2e7f ? WIDE_ADVANCE : LATIN_ADVANCE
  return width * LABEL_FONT_PX
}

/** Whether two boxes overlap (padding included). */
function overlaps(left: Box, right: Box): boolean {
  return left.left < right.right + LABEL_PADDING_PX && right.left < left.right + LABEL_PADDING_PX
    && left.top < right.bottom + LABEL_PADDING_PX && right.top < left.bottom + LABEL_PADDING_PX
}

/** The box of one label centred at `(x, y)`. */
function boxAt(x: number, y: number, width: number, height: number): Box {
  return { left: x - width / 2, top: y - height / 2, right: x + width / 2, bottom: y + height / 2 }
}

/** The candidate centres one feature may take, in preference order. */
function positionsOf(candidate: LabelCandidate, width: number, height: number): readonly { x: number; y: number; anchor: PlacedLabel['anchor'] }[] {
  if (candidate.kind !== 'point') return [{ x: candidate.x, y: candidate.y, anchor: 'center' }]
  const reach = candidate.markerPx / 2 + MARKER_GAP_PX
  return [
    { x: candidate.x, y: candidate.y - reach - height / 2, anchor: 'top' },
    { x: candidate.x + reach + width / 2, y: candidate.y, anchor: 'right' },
    { x: candidate.x, y: candidate.y + reach + height / 2, anchor: 'bottom' },
    { x: candidate.x - reach - width / 2, y: candidate.y, anchor: 'left' },
  ]
}

/**
 * Place labels greedily without collisions. Every point marker is an
 * obstacle before any label is placed, so labels never cover a symbol.
 * @param candidates - labelable features in priority order.
 * @param viewport - the view size in pixels; labels must fit entirely inside.
 * @returns the placed labels, in priority order.
 */
export function placeLabels(candidates: readonly LabelCandidate[], viewport: { readonly width: number; readonly height: number }): PlacedLabel[] {
  const height = LABEL_FONT_PX + 4
  const obstacles: Box[] = candidates
    .filter(candidate => candidate.kind === 'point')
    .map(candidate => boxAt(candidate.x, candidate.y, candidate.markerPx, candidate.markerPx))
  const placed: PlacedLabel[] = []
  const placedBoxes: Box[] = []
  for (const candidate of candidates) {
    if (placed.length >= MAX_PLACED_LABELS) break
    if (!Number.isFinite(candidate.x) || !Number.isFinite(candidate.y)) continue
    const width = labelWidthOf(candidate.text) + 4
    for (const position of positionsOf(candidate, width, height)) {
      const box = boxAt(position.x, position.y, width, height)
      if (box.left < 0 || box.top < 0 || box.right > viewport.width || box.bottom > viewport.height) continue
      if (placedBoxes.some(other => overlaps(box, other))) continue
      if (obstacles.some(other => overlaps(box, other))) continue
      placed.push({ key: candidate.key, text: candidate.text, x: position.x, y: position.y, anchor: position.anchor, color: candidate.color })
      placedBoxes.push(box)
      break
    }
  }
  return placed
}

/**
 * The label anchor of one GeoJSON geometry in lon/lat: the point itself, the
 * middle vertex of a line, or the vertex-average of a polygon's outer ring.
 * @param geometry - the feature geometry.
 * @returns the anchor and its kind, or `null` for unsupported geometry.
 */
export function labelAnchorOf(geometry: { type?: string; coordinates?: unknown } | null | undefined): { kind: LabelCandidate['kind']; lon: number; lat: number } | null {
  if (geometry === null || geometry === undefined) return null
  if (geometry.type === 'Point') {
    const [lon, lat] = geometry.coordinates as [number, number]
    return { kind: 'point', lon, lat }
  }
  if (geometry.type === 'LineString') {
    const path = geometry.coordinates as [number, number][]
    const mid = path[Math.floor(path.length / 2)]
    return mid === undefined ? null : { kind: 'line', lon: mid[0], lat: mid[1] }
  }
  if (geometry.type === 'Polygon') {
    const ring = (geometry.coordinates as [number, number][][])[0] ?? []
    const open = ring.length > 1 ? ring.slice(0, -1) : ring
    if (open.length === 0) return null
    const lon = open.reduce((total, vertex) => total + vertex[0], 0) / open.length
    const lat = open.reduce((total, vertex) => total + vertex[1], 0) / open.length
    return { kind: 'polygon', lon, lat }
  }
  return null
}
