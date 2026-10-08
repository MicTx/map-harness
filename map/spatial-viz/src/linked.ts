/**
 * The linked-view vocabulary: the histogram bins aligned to one style's own
 * breaks, the shared {@link SelectionFilter} that gives chart brush, table
 * highlight, map highlight, and export one identity (`sel-…`), the feature
 * selection over that filter, the bounded attribute rows the table renders,
 * and the fixed-revision export manifest.
 *
 * One filter identity spans every linked surface: brushing the histogram and
 * paging the table cannot disagree with the map highlight or the export,
 * because all four derive from the same `SelectionFilter` value and its
 * digest. A filter carries the style version, the data identity, and the
 * pinned time frame — the revisions the checklist binds.
 *
 * @module @map-harness/spatial-viz/linked
 */
import { vizDigestOf, type ExportFailure, type ExportLayerBinding, type ExportManifest, type LegendSpec, type SelectionFilter, type StyleSpec, type TimeBinding, type VizGranularity } from './contract.ts'
import { classifyValue, measureValueOf, type ClassifiedValue } from './classify.ts'
import { formatFrameLabel, type TimelineFrame } from './timeline.ts'

/** One histogram bin: a class bucket, or the missing/underflow/overflow bucket. */
export interface HistogramBin {
  readonly kind: 'class' | 'missing' | 'underflow' | 'overflow'
  readonly classIndex?: number
  readonly color: string
  readonly from?: number
  readonly to?: number
  readonly toInclusive?: boolean
  readonly count: number
}

/**
 * Build the histogram of one value set on one legend's own bins — the chart
 * and the legend share one domain by construction, never by re-binning.
 * @param legend - the legend derived from the styled layer.
 * @param style - the style the values classify against.
 * @param values - the measured values.
 * @returns the bins in legend order (classes, underflow, overflow, missing).
 */
export function histogramOf(legend: LegendSpec, style: StyleSpec, values: readonly number[]): HistogramBin[] {
  const bins: HistogramBin[] = []
  const counts = new Map<ClassifiedValue, number>()
  for (const value of values) {
    const classified = classifyValue(style, value)
    counts.set(classified, (counts.get(classified) ?? 0) + 1)
  }
  for (const row of legend.rows) {
    if (row.kind === 'class') {
      bins.push({
        kind: 'class',
        classIndex: row.classIndex,
        color: row.color,
        from: row.from,
        to: row.to,
        toInclusive: row.toInclusive,
        count: counts.get(row.classIndex) ?? 0,
      })
    } else {
      bins.push({ kind: row.kind, color: row.color, count: counts.get(row.kind) ?? 0 })
    }
  }
  return bins
}

/** The data identity for one layer: its catalog ref, or `display:<digest>` when added from a path. */
export function dataRefOf(layer: { readonly resourceRef?: string; readonly artifactRef?: string; readonly displayDigest?: string }): string | null {
  if (layer.resourceRef !== undefined) return layer.resourceRef
  if (layer.artifactRef !== undefined) return layer.artifactRef
  if (layer.displayDigest !== undefined) return `display:${layer.displayDigest}`
  return null
}

/** The inputs one shared selection is built from. */
export interface SelectionInput {
  readonly style: StyleSpec | null
  readonly dataRef: string
  /** The pinned axis frame; the index is part of the selection identity. */
  readonly frame: (TimelineFrame & { readonly index: number }) | null
  readonly brush: { readonly min: number; readonly max: number } | null
}

/**
 * Build the one shared selection: style version, data identity, pinned frame,
 * and brush — every linked surface renders from this value.
 * @param input - the current style, data identity, frame, and brush.
 * @returns the selection filter.
 */
export function selectionFilterOf(input: SelectionInput): SelectionFilter {
  return {
    methodVersion: 'spatial-viz@1',
    styleVersion: input.style?.styleVersion ?? null,
    dataRef: input.dataRef,
    frame: input.frame === null
      ? null
      : { index: input.frame.index, fromMs: input.frame.startMs, toMs: input.frame.endMs },
    brush: input.brush === null ? null : { min: input.brush.min, max: input.brush.max },
  }
}

/**
 * The stable revision digest of one selection (`sel-<12 hex>`). Two surfaces
 * agree they show the same selection exactly when their digests match.
 * @param filter - the selection to pin.
 * @returns the revision string.
 */
export function filterRevisionOf(filter: SelectionFilter): string {
  return `sel-${vizDigestOf(filter)}`
}

/** The id the table and the map highlight address one feature by: its GeoJSON `id`, else its stable position. */
export function featureIdOf(feature: { readonly id?: unknown }, index: number): string {
  if (typeof feature.id === 'string' && feature.id.length > 0) return feature.id
  if (typeof feature.id === 'number') return `f-${feature.id}`
  return `f-${index + 1}`
}

/** The minimal feature face the selection and the table consume. */
export type WorkbenchFeature = {
  readonly id?: unknown
  readonly properties?: Record<string, unknown> | null
}

/**
 * Select the features one filter matches: the brush tests the style's
 * measured value (half-open, last bound inclusive), the frame tests the time
 * binding's field, and a missing value or time matches neither. Brush and
 * frame are conjunctive — one filter, one predicate, everywhere.
 * @param features - the layer's features in layer order.
 * @param filter - the shared selection.
 * @param style - the style the brush measures against (nullable when no style exists).
 * @param binding - the time binding the frame tests against (nullable when the layer is not temporal).
 * @returns the matching feature ids.
 */
export function selectFeatureIds(
  features: readonly WorkbenchFeature[],
  filter: SelectionFilter,
  style: StyleSpec | null,
  binding: TimeBinding | null,
): string[] {
  const ids: string[] = []
  for (const [index, feature] of features.entries()) {
    if (filter.brush !== null) {
      if (style === null) continue
      const measured = measureValueOf(feature.properties, style)
      if (!Number.isFinite(measured)) continue
      if (measured < filter.brush.min) continue
      // Half-open `[min, max)`, inclusive only at the domain's top — the same
      // bound semantics the legend's top class row carries.
      const upperInclusive = filter.brush.max === style.domain.max
      if (!(measured < filter.brush.max || (upperInclusive && measured === filter.brush.max))) continue
    }
    if (filter.frame !== null) {
      if (binding === null) continue
      const raw = feature.properties?.[binding.timeField]
      const timeMs = typeof raw === 'string' ? Date.parse(raw) : Number.NaN
      if (!Number.isFinite(timeMs) || timeMs < filter.frame.fromMs || timeMs >= filter.frame.toMs) continue
    }
    ids.push(featureIdOf(feature, index))
  }
  return ids
}

/** The bounded attribute row one table page renders. */
export interface AttributeRow {
  readonly id: string
  readonly values: readonly (string | number | null)[]
}

/** Upper bound on attribute rows one table derives; a larger layer names the truncation. */
export const MAX_ATTRIBUTE_ROWS = 5000

/**
 * Derive the attribute rows one table renders: one row per feature with the
 * requested property values (missing as `null`), bounded at
 * {@link MAX_ATTRIBUTE_ROWS} with an honest truncation count.
 * @param features - the layer's features in layer order.
 * @param fields - the property names the table shows, in column order.
 * @returns the rows and how many features the bound dropped.
 */
export function attributeRowsOf(features: readonly WorkbenchFeature[], fields: readonly string[]): { rows: AttributeRow[]; truncated: number } {
  const rows: AttributeRow[] = []
  let truncated = 0
  for (const [index, feature] of features.entries()) {
    if (rows.length >= MAX_ATTRIBUTE_ROWS) {
      truncated += 1
      continue
    }
    rows.push({
      id: featureIdOf(feature, index),
      values: fields.map(field => {
        const raw = feature.properties?.[field]
        if (raw === undefined || raw === null) return null
        if (typeof raw === 'number' || typeof raw === 'string') return raw
        return String(raw)
      }),
    })
  }
  return { rows, truncated }
}

/** The inputs the fixed-revision export manifest freezes. */
export interface ExportInput {
  readonly mapRevision: number
  readonly frame: (TimelineFrame & { readonly index: number; readonly timezone: string; readonly granularity: VizGranularity }) | null
  readonly filterRevision: string | null
  readonly layers: readonly ExportLayerBinding[]
  readonly failures: readonly ExportFailure[]
}

/**
 * Freeze the export manifest: the map revision, the pinned time frame (with
 * its zone and label), the shared filter revision, and each layer's fixed
 * style/data identity. Every binding is copied — later edits cannot reach
 * into a manifest that already left.
 * @param input - the revisions to freeze and the failures the caller already observed.
 * @returns the manifest.
 */
export function exportManifestOf(input: ExportInput): ExportManifest {
  return {
    methodVersion: 'spatial-viz@1',
    mapRevision: input.mapRevision,
    frame: input.frame === null
      ? null
      : {
        index: input.frame.index,
        fromMs: input.frame.startMs,
        toMs: input.frame.endMs,
        timezone: input.frame.timezone,
        granularity: input.frame.granularity,
        label: formatFrameLabel(input.frame, input.frame.timezone, input.frame.granularity),
      },
    filterRevision: input.filterRevision,
    layers: input.layers.map(layer => ({ ...layer })),
    failures: input.failures.map(failure => ({ ...failure })),
  }
}

/**
 * The manifest digest the export status shows: one short identity a reader
 * can compare across exports of the same fixed revisions.
 * @param manifest - the manifest to digest.
 * @returns 12 hex characters.
 */
export function manifestDigestOf(manifest: ExportManifest): string {
  return vizDigestOf(manifest)
}
