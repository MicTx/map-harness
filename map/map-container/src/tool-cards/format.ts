/**
 * Pure value formatters for map tool cards: coordinates, distances, areas,
 * durations, and refs rendered as short Chinese display strings. Every
 * formatter returns `undefined` for an absent or malformed value so a card
 * summary omits the field instead of printing raw JSON.
 * @module @map-harness/map-container/tool-cards/format
 */

/** Longest string a card summary shows before truncating with an ellipsis. */
export const MAX_TEXT_CHARS = 40

/**
 * Narrow one argument value to a non-empty string.
 * @param value - raw argument value.
 * @returns the trimmed string, or `undefined` when absent or empty.
 */
export function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  return trimmed.length > MAX_TEXT_CHARS ? `${trimmed.slice(0, MAX_TEXT_CHARS - 1)}…` : trimmed
}

/**
 * Narrow one argument value to a finite number.
 * @param value - raw argument value.
 * @returns the number, or `undefined` when absent or non-finite.
 */
export function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Format a number with at most `digits` fractional digits and thousands grouping.
 * @param value - the finite number.
 * @param digits - maximum fractional digits.
 * @returns the grouped decimal string.
 */
export function decimal(value: number, digits = 2): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}

/**
 * Format a WGS84 `[lon, lat]` pair.
 * @param value - raw argument value.
 * @returns `120.153°E, 30.287°N`, or `undefined` when not a numeric pair.
 */
export function lonLatOf(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  const lon = numberOf(value[0])
  const lat = numberOf(value[1])
  if (lon === undefined || lat === undefined) return undefined
  const ew = lon < 0 ? 'W' : 'E'
  const ns = lat < 0 ? 'S' : 'N'
  return `${Math.abs(lon).toFixed(3)}°${ew}, ${Math.abs(lat).toFixed(3)}°${ns}`
}

/**
 * Format a `[minLon, minLat, maxLon, maxLat]` box as its two corners.
 * @param value - raw argument value.
 * @returns the corner pair, or `undefined` when not four numbers.
 */
export function bboxOf(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined
  const sw = lonLatOf([value[0], value[1]])
  const ne = lonLatOf([value[2], value[3]])
  return sw !== undefined && ne !== undefined ? `${sw} 至 ${ne}` : undefined
}

/**
 * Format a length in meters, switching to kilometers at 1000 m.
 * @param value - raw meter value.
 * @returns `850 米` / `1.25 公里`, or `undefined`.
 */
export function metersOf(value: unknown): string | undefined {
  const m = numberOf(value)
  if (m === undefined) return undefined
  return Math.abs(m) >= 1000 ? `${decimal(m / 1000)} 公里` : `${decimal(m, 1)} 米`
}

/**
 * Format an area in square meters, switching to km² at 1,000,000 m².
 * @param value - raw square-meter value.
 * @returns `3,200 平方米` / `1.5 平方公里`, or `undefined`.
 */
export function squareMetersOf(value: unknown): string | undefined {
  const m2 = numberOf(value)
  if (m2 === undefined) return undefined
  return Math.abs(m2) >= 1_000_000 ? `${decimal(m2 / 1_000_000)} 平方公里` : `${decimal(m2, 0)} 平方米`
}

/**
 * Format a count with a measure word.
 * @param value - raw count.
 * @param unit - the measure word (e.g. `个要素`).
 * @returns `128 个要素`, or `undefined`.
 */
export function countOf(value: unknown, unit: string): string | undefined {
  const n = numberOf(value)
  return n === undefined ? undefined : `${decimal(n, 0)} ${unit}`
}

/**
 * Format the number of items in an array argument.
 * @param value - raw argument value.
 * @param unit - the measure word.
 * @returns the count string, or `undefined` when not a non-empty array.
 */
export function lengthOf(value: unknown, unit: string): string | undefined {
  return Array.isArray(value) && value.length > 0 ? countOf(value.length, unit) : undefined
}

/**
 * Format a list of field names.
 * @param value - raw argument value.
 * @returns `a、b、c`（at most three, then `等 N 个`), or `undefined`.
 */
export function fieldListOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const names = value.filter((v): v is string => typeof v === 'string' && v !== '')
  if (names.length === 0) return undefined
  const head = names.slice(0, 3).join('、')
  return names.length > 3 ? `${head} 等 ${names.length} 个` : head
}

/**
 * Format a workspace path as its basename.
 * @param value - raw path argument.
 * @returns the last path segment, or `undefined`.
 */
export function fileOf(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return undefined
  return textOf(text.split(/[\\/]/).filter(Boolean).pop())
}

/**
 * Format an identity-like value (ref, id, revision) without truncating its tail.
 * @param value - raw argument value.
 * @returns the id, with the middle elided past {@link MAX_TEXT_CHARS}, or `undefined`.
 */
export function idOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const id = value.trim()
  if (id.length <= MAX_TEXT_CHARS) return id
  const keep = Math.floor((MAX_TEXT_CHARS - 1) / 2)
  return `${id.slice(0, keep)}…${id.slice(-keep)}`
}

/**
 * Format a millisecond duration.
 * @param value - raw milliseconds.
 * @returns `500 毫秒` / `2.5 秒`, or `undefined`.
 */
export function millisOf(value: unknown): string | undefined {
  const ms = numberOf(value)
  if (ms === undefined) return undefined
  return ms >= 1000 ? `${decimal(ms / 1000, 1)} 秒` : `${decimal(ms, 0)} 毫秒`
}

/**
 * Map an enumerated argument through a label table.
 * @param value - raw argument value.
 * @param labels - display label per accepted value.
 * @returns the label, the raw text when unlisted, or `undefined`.
 */
export function enumOf(value: unknown, labels: Readonly<Record<string, string>>): string | undefined {
  const text = textOf(value)
  if (text === undefined) return undefined
  return labels[text] ?? text
}

/**
 * Format a boolean flag.
 * @param value - raw argument value.
 * @returns `是` / `否`, or `undefined`.
 */
export function yesNoOf(value: unknown): string | undefined {
  return typeof value === 'boolean' ? (value ? '是' : '否') : undefined
}

/**
 * Format a length given in kilometers.
 * @param value - raw kilometer value.
 * @returns the {@link metersOf} rendering, or `undefined`.
 */
export function kilometersOf(value: unknown): string | undefined {
  const km = numberOf(value)
  return km === undefined ? undefined : metersOf(km * 1000)
}
