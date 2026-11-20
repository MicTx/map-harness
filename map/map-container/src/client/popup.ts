/**
 * The feature attribute card derivation: a hovered graphic's attribute
 * record becomes a bounded, text-only field list. The internal feature id
 * stays hidden, the field count is capped so a wide attribute table cannot
 * flood the view, and string values are truncated before they reach a
 * graphic at all (`popupValueOf`). The card renders values as React text,
 * never HTML.
 *
 * @module @map-harness/map-container/client/popup
 */

/** Most attribute fields one card lists. */
export const MAX_POPUP_FIELDS = 24

/** Longest string attribute value carried into a graphic (and so into its card). */
export const MAX_POPUP_VALUE_CHARS = 256

/** The internal attribute keys the card never lists. */
const HIDDEN_FIELDS = new Set(['__fid'])

/** One hovered feature's card face. */
export interface FeatureInspection {
  readonly layerId: string
  readonly layerName: string
  readonly featureId: string
  /** The label-field value when one resolves, else `null` (the card falls back to the layer name). */
  readonly title: string | null
  readonly fields: readonly { readonly name: string; readonly value: string }[]
  /** Fields beyond {@link MAX_POPUP_FIELDS} that the card omits. */
  readonly omitted: number
}

/**
 * Truncate one string attribute for display.
 * @param value - the raw attribute string.
 * @returns the value, ellipsized past {@link MAX_POPUP_VALUE_CHARS} code points.
 */
export function popupValueOf(value: string): string {
  const chars = [...value]
  return chars.length > MAX_POPUP_VALUE_CHARS ? `${chars.slice(0, MAX_POPUP_VALUE_CHARS - 1).join('')}…` : value
}

/** Render one scalar attribute as display text (`null` shows as an em dash). */
function displayOf(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(10)))
  return String(value)
}

/**
 * Build one hovered feature's card from its graphic attributes.
 * @param identity - the layer id, layer name, and feature id.
 * @param attributes - the graphic attribute record (scalars only).
 * @param labelField - the field the layer labels by, when one resolves.
 * @returns the card face.
 */
export function inspectionOf(
  identity: { readonly layerId: string; readonly layerName: string; readonly featureId: string },
  attributes: Readonly<Record<string, unknown>>,
  labelField: string | null,
): FeatureInspection {
  const visible = Object.keys(attributes).filter(key => !HIDDEN_FIELDS.has(key))
  const fields = visible.slice(0, MAX_POPUP_FIELDS).map(name => ({ name, value: displayOf(attributes[name]) }))
  const titleValue = labelField === null ? undefined : attributes[labelField]
  return {
    ...identity,
    title: typeof titleValue === 'string' && titleValue.length > 0 ? titleValue : typeof titleValue === 'number' ? String(titleValue) : null,
    fields,
    omitted: Math.max(0, visible.length - MAX_POPUP_FIELDS),
  }
}
