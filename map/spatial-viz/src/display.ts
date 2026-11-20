/** Per-feature display helpers for a host-resolved style; no classification-break construction. */
import type { StyleSpec } from './contract.ts'

/** The outcome of classifying one value: a class index, or the named special class. */
export type ClassifiedValue = number | 'missing' | 'underflow' | 'overflow'

/**
 * Classify one value against one style. Classes are half-open `[b_k, b_{k+1})`
 * with the last class ending at `domain.max` inclusive; values below
 * `domain.min` are underflow, values above `domain.max` are overflow, and
 * non-finite values are missing.
 * @param style - the validated style to classify against.
 * @param value - the already measured value; rate/density styles use the ratio.
 * @returns the class index, or the named special class.
 */
export function classifyValue(style: StyleSpec, value: number): ClassifiedValue {
  if (!Number.isFinite(value)) return 'missing'
  if (value < style.domain.min) return 'underflow'
  if (value > style.domain.max) return 'overflow'
  for (let at = 0; at < style.breaks.length; at += 1) {
    if (value < (style.breaks[at] as number)) return at
  }
  return style.breaks.length
}

/**
 * Measure one feature's display value. Rate/density styles divide by the
 * denominator; a missing, non-finite, or non-positive denominator is missing.
 * @param properties - feature properties.
 * @param style - the style naming the numerator, measure, and denominator.
 * @returns the measured value, or `NaN` when missing.
 */
export function measureValueOf(properties: Record<string, unknown> | null | undefined, style: Pick<StyleSpec, 'field' | 'measure' | 'denominatorField'>): number {
  const raw = properties?.[style.field]
  const numerator = typeof raw === 'number' ? raw : Number.NaN
  if (style.measure === 'total' || style.denominatorField === undefined) return numerator
  const denominatorRaw = properties?.[style.denominatorField]
  const denominator = typeof denominatorRaw === 'number' ? denominatorRaw : Number.NaN
  if (!Number.isFinite(denominator) || denominator <= 0) return Number.NaN
  return numerator / denominator
}

/** The minimum graduated point diameter in pixels. */
export const SIZE_MIN_PX = 8

/** The maximum graduated point diameter in pixels. */
export const SIZE_MAX_PX = 20

/**
 * Render a class as a graduated point size; special classes clamp to an extreme.
 * @param classIndex - the class index.
 * @param classCount - the total class count.
 * @returns the point diameter in pixels.
 */
export function sizeForClass(classIndex: number, classCount: number): number {
  if (classCount <= 1) return SIZE_MIN_PX
  const clamped = Math.min(Math.max(classIndex, 0), classCount - 1)
  return Math.round(SIZE_MIN_PX + ((SIZE_MAX_PX - SIZE_MIN_PX) * clamped) / (classCount - 1))
}
