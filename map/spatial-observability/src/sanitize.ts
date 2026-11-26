/**
 * The visible sanitization plane: credentials, user data, geometry payloads,
 * and arbitrary filesystem paths never pass into logs, metric labels, or the
 * diagnostic export. Every replacement is *visible* — the returned record
 * lists what was redacted, so a suppression is never silent.
 *
 * Rules:
 *
 * - **Credential-bearing keys** (`token`, `secret`, `credential`, `password`,
 *   `apiKey`, `authorization`, `cookie`, … matched case-insensitively by
 *   fragment) replace their value with `[redacted:<key>]`.
 * - **Geometry payloads** (`geometry`, `coordinates`, `features`, `geom`,
 *   `raster` keys with object/array values) replace with
 *   `{ obsRedacted: 'geometry' }` — summaries and counts may pass, full
 *   geometry may not.
 * - **Absolute filesystem paths** (POSIX `/…` and Windows `X:\…` string
 *   values) replace with `<path>`; logs carry references, never host paths.
 * - **Size and depth bounds**: objects deeper than the limit and arrays over
 *   the item cap truncate with a visible marker instead of silently shrinking
 *   or growing without bound.
 *
 * @module @map-harness/spatial-observability/sanitize
 */

/** Maximum object depth the sanitizer walks; deeper values collapse to a marker. */
export const SANITIZE_MAX_DEPTH = 6

/** Maximum array items the sanitizer keeps; the rest collapse to a marker. */
export const SANITIZE_MAX_ITEMS = 32

/** Credential key fragments (case-insensitive substring match on key names). */
export const OBS_SENSITIVE_KEY_FRAGMENTS = [
  'token',
  'secret',
  'credential',
  'password',
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'privatekey',
  'private_key',
] as const

/** Keys whose object/array values are geometry payloads. */
export const OBS_GEOMETRY_KEYS = ['geometry', 'coordinates', 'features', 'geom', 'raster'] as const

/** The placeholder an absolute filesystem path collapses to. */
export const PATH_PLACEHOLDER = '<path>'

/** POSIX absolute path (`/…`, at least two segments so `/` alone stays untouched). */
const POSIX_PATH_PATTERN = /^\/[^\s/]+(?:\/[^\s/]+)+\/?$/

/** Windows drive path (`X:\…` or `X:/…` with at least one separator). */
const WINDOWS_PATH_PATTERN = /^[A-Za-z]:[\\/][^\s]+(?:[\\/][^\s]+)*$/

/** One sanitization result: the safe value plus the visible redaction list. */
export interface SanitizeResult {
  /** The sanitized value (safe for logs, labels' neighborhood, and exports). */
  readonly value: unknown
  /** One human-readable entry per redaction/truncation, in walk order. */
  readonly redactions: readonly string[]
}

/**
 * Sanitize one value for the observability plane.
 * @param value - the raw caller value (any JSON-ish shape; cycles are handled).
 * @param options - `maxDepth` (default {@link SANITIZE_MAX_DEPTH}) and `maxItems` (default {@link SANITIZE_MAX_ITEMS}).
 * @returns the sanitized value with its visible redaction list.
 */
export function sanitizeValue(
  value: unknown,
  options: { maxDepth?: number; maxItems?: number } = {},
): SanitizeResult {
  const maxDepth = options.maxDepth ?? SANITIZE_MAX_DEPTH
  const maxItems = options.maxItems ?? SANITIZE_MAX_ITEMS
  const redactions: string[] = []
  const sanitized = walk(value, 0, '', redactions, maxDepth, maxItems, new Map())
  return { value: sanitized, redactions }
}

/**
 * Sanitize one record (object of caller fields) for a log record or export.
 * @param fields - the raw fields record.
 * @param options - forwarded to {@link sanitizeValue}.
 * @returns the sanitized fields record with its visible redaction list.
 */
export function sanitizeRecord(
  fields: Record<string, unknown>,
  options: { maxDepth?: number; maxItems?: number } = {},
): { fields: Record<string, unknown>; redactions: readonly string[] } {
  const result = sanitizeValue(fields, options)
  return { fields: result.value as Record<string, unknown>, redactions: result.redactions }
}

function walk(
  value: unknown,
  depth: number,
  key: string,
  redactions: string[],
  maxDepth: number,
  maxItems: number,
  seen: Map<object, unknown>,
): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && key !== '' && isSensitiveKey(key)) {
      redactions.push(`key "${key}" redacted (credential-bearing)`)
      return `[redacted:${key}]`
    }
    if (typeof value === 'string' && isFilesystemPath(value)) {
      redactions.push(`string at "${key || '<root>'}" redacted (filesystem path)`)
      return PATH_PLACEHOLDER
    }
    return value
  }
  const seenHit = seen.get(value)
  if (seenHit !== undefined) return seenHit
  if (depth >= maxDepth) {
    redactions.push(`value at "${key || '<root>'}" truncated (depth > ${maxDepth})`)
    return '[truncated:depth]'
  }
  if (key !== '' && isGeometryKey(key) && (Array.isArray(value) || isPlainObject(value))) {
    redactions.push(`key "${key}" redacted (geometry payload)`)
    const marker: Record<string, unknown> = { obsRedacted: 'geometry' }
    seen.set(value, marker)
    return marker
  }
  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    const kept = value.slice(0, maxItems)
    if (value.length > maxItems) redactions.push(`array at "${key || '<root>'}" truncated to ${maxItems} of ${value.length} items`)
    for (const [index, entry] of kept.entries()) {
      out.push(walk(entry, depth + 1, key === '' ? String(index) : `${key}[${index}]`, redactions, maxDepth, maxItems, seen))
    }
    return out
  }
  if (!isPlainObject(value)) return '[unserializable]'
  const out: Record<string, unknown> = {}
  seen.set(value, out)
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (isSensitiveKey(entryKey)) {
      redactions.push(`key "${entryKey}" redacted (credential-bearing)`)
      out[entryKey] = `[redacted:${entryKey}]`
      continue
    }
    out[entryKey] = walk(entryValue, depth + 1, entryKey, redactions, maxDepth, maxItems, seen)
  }
  return out
}

function isSensitiveKey(key: string): boolean {
  const folded = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return (OBS_SENSITIVE_KEY_FRAGMENTS as readonly string[]).some(fragment =>
    folded.includes(fragment.replace(/[^a-z0-9]/g, '')),
  )
}

function isGeometryKey(key: string): boolean {
  const folded = key.toLowerCase()
  return (OBS_GEOMETRY_KEYS as readonly string[]).includes(folded)
}

function isFilesystemPath(value: string): boolean {
  return POSIX_PATH_PATTERN.test(value) || WINDOWS_PATH_PATTERN.test(value)
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto = Object.getPrototypeOf(value) as object | null
  return proto === Object.prototype || proto === null
}
