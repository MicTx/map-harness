/**
 * Pure continuous map-use math: parse one `map_use` action, map output-image
 * pixels through the observation's affine georeference, compute pan and
 * anchored-zoom camera targets, and convert display coordinates back to
 * WGS84. No SDK, canvas, or session imports; the host and browser share it.
 * @module @map-harness/map-container/map-use
 */
import {
  MAX_INTERACTION_FIELD_CHARS,
  MAX_INTERACTION_FIELDS,
  type MapInteractionField,
  type MapInteractionHit,
  type MapUseAction,
  type MapUseActionName,
} from './interaction-protocol.ts'
import type { MapObservationRecord } from './observation-protocol.ts'
import { scaleFromZoom, zoomFromScale } from './view-policy.ts'

/** Web Mercator earth radius (EPSG:3857). */
const MERCATOR_RADIUS = 6_378_137

/** Web Mercator latitude limit. */
const MERCATOR_MAX_LAT = 85.051_128_779_806_6

/** Maximum absolute pan vector the tool accepts, in output-image pixels. */
export const MAX_MAP_USE_PAN_PX = 4_096

/** Maximum absolute zoom delta the tool accepts. */
export const MAX_MAP_USE_ZOOM_DELTA = 4

/** Why one action cannot be computed from its observation. */
export type MapUseMathRefusal =
  | 'unsupported-georeference'
  | 'invalid-argument'
  | 'outside-map'
  | 'world-wrap'

/** One computed camera candidate in the existing map-view record shape. */
export interface MapUseViewTarget {
  readonly center: readonly [number, number]
  readonly zoom: number
  readonly wkid: number
  readonly scale: number
  readonly rotation: number
}

/** The affine coefficients `[a,b,c,d,e,f]`. */
type Affine = readonly [number, number, number, number, number, number]

/** Read the observation's usable 2D affine transform, or name why it is absent. */
export function affineOfObservation(record: MapObservationRecord): { readonly affine: Affine; readonly zoom: number } | MapUseMathRefusal {
  const georeference = record.georeference
  if (record.camera === null || record.camera.mode !== 'map') return 'unsupported-georeference'
  if (georeference.kind !== 'affine-2d') return 'unsupported-georeference'
  if (!Number.isFinite(record.camera.scale) || record.camera.scale <= 0) return 'unsupported-georeference'
  if (georeference.wkid !== record.camera.wkid) return 'unsupported-georeference'
  return { affine: georeference.coefficients, zoom: zoomFromScale(record.camera.scale) }
}

/** Evaluate one affine at an output-image pixel. */
export function displayPointOf(affine: Affine, u: number, v: number): readonly [number, number] {
  return [affine[0] * u + affine[1] * v + affine[2], affine[3] * u + affine[4] * v + affine[5]]
}

/** Whether one output-image pixel lies inside the observation's map-content rectangle. */
export function imagePointInMapContent(record: MapObservationRecord, u: number, v: number): boolean {
  const rect = record.mapContentRect
  return Number.isFinite(u) && Number.isFinite(v)
    && u >= rect.x && u < rect.x + rect.width && v >= rect.y && v < rect.y + rect.height
}

/** Convert one output-image pixel to the live view's CSS pixel space. */
export function cssPointOf(record: MapObservationRecord, u: number, v: number): readonly [number, number] | MapUseMathRefusal {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return 'invalid-argument'
  if (!imagePointInMapContent(record, u, v)) return 'outside-map'
  const rect = record.mapContentRect
  const css = record.cssViewSize
  return [
    (u - rect.x) * (css.width / rect.width),
    (v - rect.y) * (css.height / rect.height),
  ]
}

/** Convert one display coordinate to WGS84 for the supported geographic/Web-Mercator WKIDs. */
export function wgs84OfDisplayPoint(point: readonly [number, number], wkid: number): readonly [number, number] | MapUseMathRefusal {
  const [x, y] = point
  if (!Number.isFinite(x) || !Number.isFinite(y)) return 'invalid-argument'
  if (wkid === 4326) {
    return x >= -180 - 1e-7 && x <= 180 + 1e-7 && y >= -90 - 1e-7 && y <= 90 + 1e-7
      ? [Math.max(-180, Math.min(180, x)), Math.max(-90, Math.min(90, y))]
      : 'world-wrap'
  }
  if (wkid !== 3857 && wkid !== 102100 && wkid !== 102113) return 'unsupported-georeference'
  const radius = MERCATOR_RADIUS
  if (Math.abs(x) > Math.PI * radius || Math.abs(y) > Math.PI * radius) return 'world-wrap'
  const lon = (x / radius) * (180 / Math.PI)
  const lat = (2 * Math.atan(Math.exp(y / radius)) - Math.PI / 2) * (180 / Math.PI)
  if (!Number.isFinite(lon) || !Number.isFinite(lat)
    || lon < -180 - 1e-7 || lon > 180 + 1e-7 || Math.abs(lat) > MERCATOR_MAX_LAT + 1e-7) return 'world-wrap'
  return [Math.max(-180, Math.min(180, lon)), Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat))]
}

/** Clamp one zoom value into the map-view record's accepted range. */
function clampZoom(value: number): number {
  return Math.min(24, Math.max(0, value))
}

/**
 * Compute the camera target for a pan. Positive `dxPx/dyPx` follow a pointer
 * drag, so the camera centre moves opposite the world-space image delta.
 */
export function panTargetOf(
  record: MapObservationRecord,
  dxPx: number,
  dyPx: number,
): MapUseViewTarget | MapUseMathRefusal {
  if (!Number.isFinite(dxPx) || !Number.isFinite(dyPx) || (dxPx === 0 && dyPx === 0)) return 'invalid-argument'
  if (Math.abs(dxPx) > MAX_MAP_USE_PAN_PX || Math.abs(dyPx) > MAX_MAP_USE_PAN_PX) return 'invalid-argument'
  const usable = affineOfObservation(record)
  if (typeof usable === 'string') return usable
  const { affine, zoom } = usable
  const camera = record.camera
  if (camera === null) return 'unsupported-georeference'
  const delta = displayPointOf(affine, dxPx, dyPx)
  const origin = displayPointOf(affine, 0, 0)
  const world: readonly [number, number] = [
    camera.center[0] - (delta[0] - origin[0]),
    camera.center[1] - (delta[1] - origin[1]),
  ]
  const center = wgs84OfDisplayPoint(world, camera.wkid)
  if (typeof center === 'string') return center
  const rect = record.mapContentRect
  for (const pixel of [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]] as const) {
    const corner = displayPointOf(affine, pixel[0] - dxPx, pixel[1] - dyPx)
    if (typeof wgs84OfDisplayPoint(corner, camera.wkid) === 'string') return 'world-wrap'
  }
  return { center, zoom, wkid: camera.wkid, scale: camera.scale, rotation: camera.rotation }
}

/**
 * Compute the camera target for an anchored zoom. The anchor's world point
 * stays fixed; positive `deltaZoom` zooms in.
 */
export function zoomTargetOf(
  record: MapObservationRecord,
  deltaZoom: number,
  anchor?: readonly [number, number],
): MapUseViewTarget | MapUseMathRefusal {
  if (!Number.isFinite(deltaZoom) || deltaZoom === 0 || Math.abs(deltaZoom) > MAX_MAP_USE_ZOOM_DELTA) return 'invalid-argument'
  const usable = affineOfObservation(record)
  if (typeof usable === 'string') return usable
  const { affine, zoom } = usable
  const camera = record.camera
  if (camera === null) return 'unsupported-georeference'
  const rect = record.mapContentRect
  const anchorPixel = anchor ?? [rect.x + rect.width / 2, rect.y + rect.height / 2] as const
  if (!imagePointInMapContent(record, anchorPixel[0], anchorPixel[1])) return 'outside-map'
  const appliedZoom = clampZoom(zoom + deltaZoom)
  if (appliedZoom === zoom) return 'invalid-argument'
  const factor = 2 ** (appliedZoom - zoom)
  if (!Number.isFinite(factor) || factor <= 0) return 'invalid-argument'
  const anchorWorld = displayPointOf(affine, anchorPixel[0], anchorPixel[1])
  const world: readonly [number, number] = [
    anchorWorld[0] + (camera.center[0] - anchorWorld[0]) / factor,
    anchorWorld[1] + (camera.center[1] - anchorWorld[1]) / factor,
  ]
  const center = wgs84OfDisplayPoint(world, camera.wkid)
  if (typeof center === 'string') return center
  for (const pixel of [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]] as const) {
    const corner = displayPointOf(affine, pixel[0], pixel[1])
    if (typeof wgs84OfDisplayPoint([
      anchorWorld[0] + (corner[0] - anchorWorld[0]) / factor,
      anchorWorld[1] + (corner[1] - anchorWorld[1]) / factor,
    ], camera.wkid) === 'string') return 'world-wrap'
  }
  return { center, zoom: appliedZoom, wkid: camera.wkid, scale: scaleFromZoom(appliedZoom), rotation: camera.rotation }
}

/** Parse the raw `map_use` argument text into one validated action. */
export function parseMapUseArguments(raw: string): MapUseAction | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const fields = value as Record<string, unknown>
  const action = fields.action
  if (action !== 'pan' && action !== 'zoom' && action !== 'click' && action !== 'finish') return null
  const allowed: Record<MapUseActionName, readonly string[]> = {
    pan: ['action', 'observation_id', 'dx_px', 'dy_px'],
    zoom: ['action', 'observation_id', 'delta_zoom', 'anchor_x_px', 'anchor_y_px'],
    click: ['action', 'observation_id', 'x_px', 'y_px'],
    finish: ['action', 'observation_id', 'reason'],
  }
  if (!Object.keys(fields).every(key => allowed[action].includes(key))) return null
  const observationId = fields.observation_id
  if (action === 'finish') {
    if (observationId !== undefined && (typeof observationId !== 'string' || observationId.length === 0 || observationId.length > 256)) return null
    const reason = fields.reason
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 256)) return null
    return {
      action: 'finish',
      ...(typeof observationId === 'string' ? { observationId } : {}),
      ...(typeof reason === 'string' ? { reason } : {}),
    }
  }
  if (typeof observationId !== 'string' || observationId.length === 0 || observationId.length > 256) return null
  if (action === 'pan') {
    const dx = fields.dx_px
    const dy = fields.dy_px
    if (typeof dx !== 'number' || typeof dy !== 'number' || !Number.isFinite(dx) || !Number.isFinite(dy)) return null
    return { action, observationId, dxPx: dx, dyPx: dy }
  }
  if (action === 'zoom') {
    const delta = fields.delta_zoom
    if (typeof delta !== 'number' || !Number.isFinite(delta)) return null
    const ax = fields.anchor_x_px
    const ay = fields.anchor_y_px
    if ((ax === undefined) !== (ay === undefined)) return null
    if (ax !== undefined && (typeof ax !== 'number' || !Number.isFinite(ax) || typeof ay !== 'number' || !Number.isFinite(ay))) return null
    return {
      action,
      observationId,
      deltaZoom: delta,
      ...(typeof ax === 'number' && typeof ay === 'number' ? { anchorXPx: ax, anchorYPx: ay } : {}),
    }
  }
  const x = fields.x_px
  const y = fields.y_px
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null
  return { action, observationId, xPx: x, yPx: y }
}

/** Keys that never enter clicked-feature fields. */
const BLOCKED_FIELD_KEYS = new Set(['__fid', '__proto__', 'prototype', 'constructor'])

/** The displayable text of one scalar attribute, or `undefined` when it is not scalar. */
function fieldTextOf(value: unknown): string | undefined {
  if (value === null) return '—'
  if (typeof value === 'string') {
    if (value.length <= MAX_INTERACTION_FIELD_CHARS) return value
    let text = ''
    for (const character of value) {
      if (text.length + character.length >= MAX_INTERACTION_FIELD_CHARS) break
      text += character
    }
    return `${text}…`
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return undefined
}

/**
 * Build one bounded, whitelisted hit record from a raw SDK graphic attribute
 * record. Only scalar fields with bounded names enter; object/array values
 * and prototype keys never do.
 */
export function interactionHitOf(
  identity: { readonly layerId: string; readonly layerName: string; readonly featureId: string },
  attributes: Readonly<Record<string, unknown>>,
  labelField: string | null,
): MapInteractionHit {
  const visible = Object.keys(attributes).filter(key =>
    !BLOCKED_FIELD_KEYS.has(key)
    && key.length > 0 && key.length <= 64 && !/[\u0000-\u001f\u007f]/u.test(key)
    && fieldTextOf(attributes[key]) !== undefined)
  const fields: MapInteractionField[] = visible.slice(0, MAX_INTERACTION_FIELDS).map(name => ({
    name,
    value: fieldTextOf(attributes[name]) as string,
  }))
  const titleValue = labelField === null || !visible.includes(labelField) ? undefined : attributes[labelField]
  const titleText = fieldTextOf(titleValue)
  return {
    ...identity,
    title: titleText === undefined || titleText === '—' ? null : titleText,
    fields,
    omitted: Math.max(0, visible.length - MAX_INTERACTION_FIELDS),
  }
}
