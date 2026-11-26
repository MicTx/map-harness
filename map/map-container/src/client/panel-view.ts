/**
 * The layer panel's pure derivation faces: per-layer faces (type badge,
 * legend chip, reference) and the bounded attribute table. Colors resolve
 * through the same functions as map graphics; `featureIdOf` supplies row ids.
 *
 * Pure module: no ArcGIS imports, plain data in and out, deterministic under
 * `node --test`.
 *
 * @module @map-harness/map-container/client/panel-view
 */
import { MAX_ATTRIBUTE_ROWS, classifyValue, featureIdOf, legendOf, measureValueOf } from '@map-harness/spatial-viz/browser'
import { symbolVersionOf, type SingleSymbolStyle, type SymbolStyle } from '@map-harness/map-layers'
import type { MapContainerWire } from './state.ts'
import type { GeoJsonFeatureCollection } from '../registry.ts'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { featureColorOf, heatmapStopsOf, overrideTableOf, rgbaOf, singleSymbolOf, type GeometryFamily } from './layer-colors.ts'

/** One wire layer as the panel consumes it (the runtime wire carries `featureCount`; the shared type omits it). */
type WireLayer = MapContainerWire['layers'][number] & { readonly featureCount?: unknown }

/** One protected user annotation as the panel consumes it. */
export interface PanelAnnotationFace {
  readonly id: string
  readonly name: string
  readonly description: string | null
  readonly geometryType: 'point' | 'line' | 'polygon'
  readonly updatedAt: string
  readonly color: string
}

/** The layer families the panel badges; derivation order is presentation, then data. */
export type PanelBadge = 'point' | 'line' | 'polygon' | 'heatmap' | 'imagery' | 'thematic' | 'data'

/** Attribute columns the panel table shows; further keys report as overflow. */
export const PANEL_MAX_ATTRIBUTE_COLUMNS = 12

/** Attribute rows one panel table page shows (the workbench page size). */
export const PANEL_ATTRIBUTE_PAGE_SIZE = 8

/** Characters one attribute cell keeps before truncating with an ellipsis. */
export const PANEL_ATTRIBUTE_CELL_CHARS = 48

/** A legend row names one effective color and the features or class it represents. */
export type PanelLegendRow =
  | { readonly kind: 'symbol'; readonly geometry: GeometryFamily; readonly color: string }
  | { readonly kind: 'class'; readonly geometry: GeometryFamily; readonly index: number; readonly from: number; readonly to: number; readonly inclusive: boolean; readonly color: string }
  | { readonly kind: 'missing' | 'underflow' | 'overflow'; readonly geometry: GeometryFamily; readonly color: string }
  | { readonly kind: 'feature'; readonly id: string; readonly color: string }
  | { readonly kind: 'heatmap'; readonly index: number; readonly color: string }

/** Distinct swatch colors and the labeled legend in display order. */
export interface PanelLegendChip {
  readonly colors: readonly string[]
  readonly rows: readonly PanelLegendRow[]
}

/** One layer's panel face: identity, grouping, state, reference, and legend chip. */
export interface PanelLayerFace {
  readonly id: string
  readonly name: string
  readonly group: string | null
  readonly badge: PanelBadge
  readonly visible: boolean
  readonly opacity: number
  readonly featureCount: number
  /** The exact catalog ref (`resourceRef` preferred) when the layer carries one. */
  readonly ref: string | null
  readonly chip: PanelLegendChip | null
  readonly symbol: SymbolStyle | undefined
  readonly style: import('@map-harness/spatial-viz/browser').StyleSpec | undefined
}

/** One flat row: an ordinary layer or one reviewable candidate from its aggregate layer. */
export type PanelRowFace =
  | { readonly kind: 'layer'; readonly layer: PanelLayerFace }
  | { readonly kind: 'proposal'; readonly proposal: PanelProposalFace }
  | { readonly kind: 'change'; readonly change: PanelChangeFace }

/** The layer's first feature geometry type, when its data carries one. */
function firstGeometryOf(layer: WireLayer): string | null {
  const data = layer.data as { features?: { geometry?: { type?: unknown } | null }[] } | null
  const geometry = data?.features?.[0]?.geometry
  return typeof geometry?.type === 'string' ? geometry.type : null
}

/**
 * Derive one layer's type badge: imagery and heatmap presentations first,
 * then a classification style, then the symbol blocks, then the data's own
 * geometry, with `data` as the fallback.
 * @param layer - the wire layer.
 * @returns the badge.
 */
export function panelBadgeOf(layer: WireLayer): PanelBadge {
  if (layer.imagery !== undefined) return 'imagery'
  if (layer.symbol?.presentation === 'heatmap') return 'heatmap'
  if (layer.style !== undefined) return 'thematic'
  if (layer.symbol !== undefined && layer.symbol.semantic === undefined) {
    if (layer.symbol.point !== undefined) return 'point'
    if (layer.symbol.line !== undefined) return 'line'
    if (layer.symbol.fill !== undefined) return 'polygon'
  }
  const geometry = firstGeometryOf(layer)
  if (geometry === 'Point') return 'point'
  if (geometry === 'LineString') return 'line'
  if (geometry === 'Polygon') return 'polygon'
  return 'data'
}

/** Derive the complete unselected legend with symbol and layer opacity applied. */
export function panelChipOf(layer: WireLayer): PanelLegendChip | null {
  if (layer.imagery !== undefined) return null
  if (layer.symbol?.presentation === 'heatmap') {
    const colors = heatmapStopsOf(layer.symbol.heatmap.ramp).map((color, index) => rgbaOf(color, index === 0 ? 0 : layer.opacity))
    return { colors, rows: colors.map((color, index) => ({ kind: 'heatmap', index, color })) }
  }
  const features = (layer.data as GeoJsonFeatureCollection | null | undefined)?.features ?? []
  const symbol = singleSymbolOf(layer)
  const style = layer.style ?? null
  const overrides = overrideTableOf(layer.overrides)
  const geometries = new Set<GeometryFamily>()
  const baseGeometries = new Set<GeometryFamily>()
  const featureColors = new Set<string>()
  const featureRows: PanelLegendRow[] = []
  const resolved = (geometry: GeometryFamily, classified: number | 'missing' | 'underflow' | 'overflow', override?: import('./layer-colors.ts').OverridePatch): string => {
    const color = featureColorOf(geometry, style, classified, symbol, layer.symbol !== undefined, override, layer.legend?.symbol.color)
    return rgbaOf(color.color, color.opacity * layer.opacity)
  }
  features.forEach((feature, index) => {
    const type = feature.geometry?.type
    if (type !== 'Point' && type !== 'LineString' && type !== 'Polygon') return
    geometries.add(type)
    const id = overrides.size === 0 ? undefined : featureIdOf(feature, index)
    const override = id === undefined ? undefined : overrides.get(id)
    if (id === undefined || override === undefined || (override.color === undefined && override.opacity === undefined)) {
      baseGeometries.add(type)
      return
    }
    const classified = style === null ? 'missing' : classifyValue(style, measureValueOf(feature.properties, style))
    const color = resolved(type, classified, override)
    featureColors.add(color)
    featureRows.push({ kind: 'feature', id, color })
  })
  if (geometries.size === 0 && features.length > 0) return { colors: [], rows: [] }
  if (geometries.size === 0) {
    if (symbol?.point !== undefined) geometries.add('Point')
    if (symbol?.line !== undefined) geometries.add('LineString')
    if (symbol?.fill !== undefined) geometries.add('Polygon')
    if (geometries.size === 0) geometries.add('Point')
    for (const geometry of geometries) baseGeometries.add(geometry)
  }
  const rows: PanelLegendRow[] = []
  const baseColors = new Set<string>()
  const classes = style === null ? undefined : legendOf(style).rows
  for (const geometry of geometries) {
    if (style === null) {
      const color = resolved(geometry, 'missing')
      if (baseGeometries.has(geometry)) baseColors.add(color)
      rows.push({ kind: 'symbol', geometry, color })
    }
    else for (const row of classes ?? []) {
      const classified = row.kind === 'class' ? row.classIndex : row.kind
      const color = resolved(geometry, classified)
      if (baseGeometries.has(geometry)) baseColors.add(color)
      if (row.kind === 'class') rows.push({ kind: 'class', geometry, index: row.classIndex, from: row.from, to: row.to, inclusive: row.toInclusive, color })
      else rows.push({ kind: row.kind, geometry, color })
    }
  }
  return { colors: [...new Set([...baseColors, ...featureColors])], rows: [...rows, ...featureRows] }
}

/**
 * Derive the panel faces of every wire layer, in layer order.
 * @param wire - the current `mapContainer` wire value.
 * @returns one face per layer.
 */
export function panelFacesOf(wire: MapContainerWire): readonly PanelLayerFace[] {
  return wire.layers.filter(raw => raw.role !== 'user-annotation' && raw.role !== 'visual-proposal' && raw.role !== 'visual-change').map(raw => {
    const layer: WireLayer = raw
    return {
      id: layer.id,
      name: layer.name,
      group: layer.group ?? null,
      badge: panelBadgeOf(layer),
      visible: layer.visible,
      opacity: layer.opacity,
      featureCount: typeof layer.featureCount === 'number' ? layer.featureCount : (layer.data as { features?: unknown[] } | null)?.features?.length ?? 0,
      ref: layer.resourceRef ?? layer.artifactRef ?? null,
      chip: panelChipOf(layer),
      symbol: layer.symbol,
      style: layer.style,
    }
  })
}

/**
 * Recolor every geometry block of one single-symbol style while retaining shape, dimensions, outlines, and opacity.
 * @param symbol - the current complete symbol.
 * @param color - a validated six-digit CSS hex color.
 * @returns a complete symbol with a freshly derived version.
 */
export function panelSymbolWithColor(symbol: SingleSymbolStyle, color: string): SingleSymbolStyle {
  const draft = {
    ...symbol,
    ...(symbol.point === undefined ? {} : { point: { ...symbol.point, color } }),
    ...(symbol.line === undefined ? {} : { line: { ...symbol.line, color } }),
    ...(symbol.fill === undefined ? {} : { fill: { ...symbol.fill, color } }),
  }
  return { ...draft, symbolVersion: symbolVersionOf(draft) }
}

/** Read a layer's base color from its first rendered geometry family. */
export function panelSymbolColorOf(layer: PanelLayerFace, symbol: SingleSymbolStyle): string | undefined {
  const geometry = layer.chip?.rows.find(row => 'geometry' in row)
  const block = geometry?.geometry === 'LineString' ? symbol.line
    : geometry?.geometry === 'Polygon' ? symbol.fill
      : geometry?.geometry === 'Point' ? symbol.point
        : undefined
  return block?.color ?? symbol.point?.color ?? symbol.line?.color ?? symbol.fill?.color
}

/** One visual candidate as the panel consumes it. */
export interface PanelProposalFace {
  readonly id: string
  readonly name: string
  readonly note: string
  readonly confidence: string
  readonly status: string
  readonly purpose: string
  readonly sourceObservationId: string
  readonly sourceAttachment: ImageAttachmentRef | null
  readonly humanEdited: boolean
}

/** One two-image visual-change candidate as the panel consumes it. */
export interface PanelChangeFace {
  readonly id: string
  readonly comparisonId: string
  readonly name: string
  readonly note: string
  readonly kind: string
  readonly confidence: string
  readonly status: string
  readonly beforeAttachment: ImageAttachmentRef | null
  readonly afterAttachment: ImageAttachmentRef | null
  readonly humanEdited: boolean
}

/** Build one exact attachment reference from one persisted observation evidence record. */
function changeAttachmentOf(record: import('../observation-protocol.ts').MapObservationRecord | undefined): ImageAttachmentRef | null {
  if (record === undefined) return null
  return {
    attachmentId: record.attachment.attachmentId as AttachmentId,
    mediaType: record.attachment.mediaType,
    bytes: record.attachment.bytes,
    width: record.attachment.width,
    height: record.attachment.height,
    ...(record.attachment.name === undefined ? {} : { name: record.attachment.name }),
  }
}

/**
 * Derive bounded visual-change rows from projection records and their pair's
 * persisted observations. Reviewed evidence remains available to inspect.
 * @param wire - current projection wire.
 * @returns change rows in persisted order.
 */
export function panelChangesOf(wire: MapContainerWire): readonly PanelChangeFace[] {
  const history = wire.observationHistory ?? []
  return (wire.visualChanges ?? []).map(change => ({
    id: change.changeId,
    comparisonId: change.comparisonId,
    name: change.category,
    note: change.note,
    kind: change.kind,
    confidence: change.confidence,
    status: change.status,
    beforeAttachment: changeAttachmentOf(history.find(record => record.observationId === change.beforeObservationId)),
    afterAttachment: changeAttachmentOf(history.find(record => record.observationId === change.afterObservationId)),
    humanEdited: change.humanEdited,
  }))
}

/** Combine ordinary layers and candidate records into one searchable top-first list. */
export function panelRowsOf(wire: MapContainerWire, faces = panelFacesOf(wire)): readonly PanelRowFace[] {
  const layers = [...faces].reverse().map(layer => ({ kind: 'layer' as const, layer }))
  const proposals = panelProposalsOf(wire).map(proposal => ({ kind: 'proposal' as const, proposal }))
  const changes = panelChangesOf(wire).map(change => ({ kind: 'change' as const, change }))
  return [...proposals, ...changes, ...layers]
}

/**
 * Derive the bounded candidate rows from projection records, never from the
 * rendered candidate layer. Reviewed evidence remains available to inspect.
 * @param wire - current projection wire.
 * @returns proposal rows in persisted order.
 */
export function panelProposalsOf(wire: MapContainerWire): readonly PanelProposalFace[] {
  return (wire.visualProposals ?? []).map(proposal => ({
    id: proposal.proposalId,
    name: proposal.category,
    note: proposal.note,
    confidence: proposal.confidence,
    status: proposal.status,
    purpose: proposal.purpose,
    sourceObservationId: proposal.observationId,
    sourceAttachment: {
      attachmentId: proposal.observationAttachment.attachmentId as AttachmentId,
      mediaType: proposal.observationAttachment.mediaType,
      bytes: proposal.observationAttachment.bytes,
      width: proposal.observationAttachment.width,
      height: proposal.observationAttachment.height,
      ...(proposal.observationAttachment.name === undefined ? {} : { name: proposal.observationAttachment.name }),
    },
    humanEdited: proposal.humanEdited,
  }))
}

/** Derive the stable annotation rows from the protected layer only. */
export function panelAnnotationsOf(wire: MapContainerWire): readonly PanelAnnotationFace[] {
  const layer = wire.layers.find(raw => raw.role === 'user-annotation')
  if (layer === undefined) return []
  const collection = layer.data as GeoJsonFeatureCollection | undefined
  const symbol = singleSymbolOf(layer)
  const overrides = overrideTableOf(layer.overrides)
  return (collection?.features ?? []).flatMap(feature => {
    if (typeof feature.id !== 'string') return []
    const geometryType = feature.geometry?.type === 'Point' ? 'point'
      : feature.geometry?.type === 'LineString' ? 'line'
        : feature.geometry?.type === 'Polygon' ? 'polygon' : null
    if (geometryType === null) return []
    const properties = feature.properties
    if (typeof properties !== 'object' || properties === null) return []
    const geometry = feature.geometry?.type
    if (geometry !== 'Point' && geometry !== 'LineString' && geometry !== 'Polygon') return []
    const style = layer.style ?? null
    const classified = style === null ? 'missing' : classifyValue(style, measureValueOf(properties, style))
    const resolved = featureColorOf(geometry, style, classified, symbol, layer.symbol !== undefined, overrides.get(feature.id), layer.legend?.symbol.color)
    return [{
      id: feature.id,
      name: typeof properties.name === 'string' ? properties.name : feature.id,
      description: typeof properties.description === 'string' ? properties.description : null,
      geometryType,
      updatedAt: typeof properties.dshUpdatedAt === 'string' ? properties.dshUpdatedAt : '',
      color: rgbaOf(resolved.color, resolved.opacity * layer.opacity),
    }]
  })
}

/** The bulk visibility change one click produces; `null` when nothing differs. */
export interface PanelBulkStateChange {
  readonly op: 'set-layer-state'
  readonly states: readonly { readonly layerId: string; readonly visible: boolean }[]
}

/**
 * Derive the change a bulk show/hide click submits: only the layers that
 * differ from the target state, in panel order. `null` means the click would
 * be a no-op and must not spend a revision.
 * @param faces - the layers the panel lists.
 * @param visible - the target visibility.
 * @returns the change, or `null` when every layer already matches.
 */
export function panelBulkStateChange(faces: readonly PanelLayerFace[], visible: boolean): PanelBulkStateChange | null {
  const states = faces.filter(face => face.visible !== visible).map(face => ({ layerId: face.id, visible }))
  return states.length === 0 ? null : { op: 'set-layer-state', states }
}

/**
 * The removal order one clear click walks: the panel's own listing order, so
 * the user sees rows disappear top-down. Removal has no batch op, so each id
 * is one change submitted against the revision the previous one produced.
 * @param faces - the layers the panel lists.
 * @returns the layer ids in removal order.
 */
export function panelClearOrder(faces: readonly PanelLayerFace[]): readonly string[] {
  return faces.map(face => face.id)
}

/** One attribute row: the feature id plus its truncated cell values. */
export interface PanelAttributeRow {
  readonly id: string
  readonly cells: readonly string[]
}

/** The bounded attribute table one layer derives. */
export interface PanelAttributeFace {
  readonly columns: readonly string[]
  readonly rows: readonly PanelAttributeRow[]
  /** Property keys beyond the column bound. */
  readonly columnOverflow: number
  /** Features beyond the row bound. */
  readonly rowOverflow: number
  /** Whether the layer carries no renderable features (zero-feature or imagery). */
  readonly empty: boolean
}

/** Stringify one attribute value for display, truncated at the cell bound. */
function cellOf(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.length > PANEL_ATTRIBUTE_CELL_CHARS ? `${text.slice(0, PANEL_ATTRIBUTE_CELL_CHARS)}…` : text
}

/**
 * Derive one layer's bounded attribute table directly from its wire data —
 * the same GeoJSON the map renders, no export round-trip. Row ids are
 * `featureIdOf` (the selection's key), columns are the property keys of the
 * bounded rows in first-appearance order capped at
 * {@link PANEL_MAX_ATTRIBUTE_COLUMNS}, and values stringify with truncation.
 * @param layer - the wire layer.
 * @returns the bounded table face.
 */
export function panelAttributesOf(layer: WireLayer): PanelAttributeFace {
  const data = layer.data as { features?: { id?: unknown; properties?: Record<string, unknown> | null }[] } | null
  const all = data?.features ?? []
  const bounded = all.slice(0, MAX_ATTRIBUTE_ROWS)
  const columns: string[] = []
  for (const feature of bounded) {
    for (const key of Object.keys(feature.properties ?? {})) {
      if (!columns.includes(key)) columns.push(key)
    }
  }
  const columnOverflow = Math.max(columns.length - PANEL_MAX_ATTRIBUTE_COLUMNS, 0)
  const shown = columns.slice(0, PANEL_MAX_ATTRIBUTE_COLUMNS)
  const rows = bounded.map((feature, index) => ({
    id: featureIdOf(feature, index),
    cells: shown.map(column => cellOf(feature.properties?.[column])),
  }))
  return {
    columns: shown,
    rows,
    columnOverflow,
    rowOverflow: Math.max(all.length - MAX_ATTRIBUTE_ROWS, 0),
    empty: rows.length === 0,
  }
}
