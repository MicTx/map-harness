/**
 * Deterministic grid aggregation: bins feature coordinates into a fixed
 * lon/lat lattice (absolute floor-division indexing, so identical inputs
 * always produce identical cells) and measures per cell (`count`, or `sum`
 * over one numeric field), producing a bounded grid-polygon display layer.
 * The aggregate is a display representation — it declares its source ref,
 * cell size, and measure so no consumer can mistake it for analysis input
 * (design §10.4: computations must not misuse display aggregates).
 *
 * @module @map-harness/spatial-viz/aggregate
 */

/** The per-cell measures an aggregation supports. */
export type GridMeasure = 'count' | 'sum'

/** Aggregation parameters. */
export interface GridAggregateParams {
  /** Grid cell edge length in degrees (positive, finite). */
  readonly cellSizeDeg: number
  /** The per-cell measure. */
  readonly measure: GridMeasure
  /** The numeric field summed per cell (required for `sum`). */
  readonly field?: string
  /** Maximum cells the aggregate may produce; coarser grids on refusal. */
  readonly maxCells: number
}

/** One aggregated cell as a GeoJSON feature: the cell rectangle plus its measure. */
export interface GridCellFeature {
  readonly type: 'Feature'
  readonly geometry: {
    readonly type: 'Polygon'
    readonly coordinates: readonly [readonly [number, number][]]
  }
  readonly properties: {
    readonly cell_x: number
    readonly cell_y: number
    readonly count: number
    readonly sum: number | null
  }
}

/** The deterministic aggregate over one feature iterable. */
export interface GridAggregateResult {
  /** Cell rectangles in first-seen cell order. */
  readonly cells: readonly GridCellFeature[]
  /** Features binned into a cell. */
  readonly matched: number
  /** Features without a usable coordinate. */
  readonly skipped: number
}

/** The named refusals an aggregation can produce. */
export type GridAggregateError =
  | 'invalid-cell-size'
  | 'grid-cell-limit-exceeded'
  | 'sum-field-required'

/** Named aggregation failure. */
export class GridAggregateFailure extends Error {
  /** Machine-readable refusal code. */
  readonly code: GridAggregateError

  /**
   * @param code - the refusal code callers branch on.
   * @param message - operator-facing description.
   */
  constructor(code: GridAggregateError, message: string) {
    super(message)
    this.name = 'GridAggregateFailure'
    this.code = code
  }
}

/** Recurse nested coordinate arrays down to the first numeric pair. */
function flattenToPair(value: unknown): readonly [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined
  if (typeof value[0] === 'number' && typeof value[1] === 'number') return [value[0], value[1]]
  return flattenToPair(value[0])
}

/** First coordinate of any geometry type (Point position, line/polygon first vertex); undefined when absent. */
function firstCoordinate(feature: Record<string, unknown>): readonly [number, number] | undefined {
  const geometry = feature.geometry as { coordinates?: unknown } | null | undefined
  if (geometry === null || geometry === undefined) return undefined
  return flattenToPair(geometry.coordinates)
}

/**
 * Create one incremental aggregator for push-at-a-time feeding — the
 * streaming consumer's form: a single accumulator receives every feature so
 * huge resources aggregate with only the bounded cell map as state.
 * @param params - cell size, measure, optional sum field, and the cell cap.
 * @returns the push/result handle; `result()` may be called repeatedly and
 *   reflects the pushes so far.
 */
export function createGridAggregator(params: GridAggregateParams): {
  push: (feature: Record<string, unknown>) => void
  result: () => GridAggregateResult
} {
  if (!Number.isFinite(params.cellSizeDeg) || params.cellSizeDeg <= 0) {
    throw new GridAggregateFailure('invalid-cell-size', `cell_size must be a positive finite number of degrees, got ${String(params.cellSizeDeg)}`)
  }
  if (params.measure === 'sum' && (params.field === undefined || params.field.length === 0)) {
    throw new GridAggregateFailure('sum-field-required', 'measure "sum" requires the field to sum')
  }
  const cells = new Map<string, { ix: number; iy: number; count: number; sum: number }>()
  let matched = 0
  let skipped = 0
  const push = (feature: Record<string, unknown>): void => {
    const coordinate = firstCoordinate(feature)
    if (coordinate === undefined) {
      skipped += 1
      return
    }
    const ix = Math.floor(coordinate[0] / params.cellSizeDeg)
    const iy = Math.floor(coordinate[1] / params.cellSizeDeg)
    const key = `${ix}:${iy}`
    let cell = cells.get(key)
    if (cell === undefined) {
      if (cells.size >= params.maxCells) {
        throw new GridAggregateFailure(
          'grid-cell-limit-exceeded',
          `the data spans more than ${String(params.maxCells)} cells at cell size ${String(params.cellSizeDeg)}; use a coarser grid`,
        )
      }
      cell = { ix, iy, count: 0, sum: 0 }
      cells.set(key, cell)
    }
    cell.count += 1
    if (params.measure === 'sum') {
      const value = (feature.properties as Record<string, unknown> | null | undefined)?.[params.field as string]
      if (typeof value === 'number' && Number.isFinite(value)) cell.sum += value
    }
    matched += 1
  }
  const result = (): GridAggregateResult => {
    const out: GridCellFeature[] = Array.from(cells.values(), cell => {
      const x0 = cell.ix * params.cellSizeDeg
      const y0 = cell.iy * params.cellSizeDeg
      return {
        type: 'Feature' as const,
        geometry: {
          type: 'Polygon' as const,
          coordinates: [[[x0, y0], [x0 + params.cellSizeDeg, y0], [x0 + params.cellSizeDeg, y0 + params.cellSizeDeg], [x0, y0 + params.cellSizeDeg], [x0, y0]]],
        },
        properties: {
          cell_x: cell.ix,
          cell_y: cell.iy,
          count: cell.count,
          sum: params.measure === 'sum' ? cell.sum : null,
        },
      }
    })
    return { cells: out, matched, skipped }
  }
  return { push, result }
}

/**
 * Aggregate one feature iterable into the absolute lon/lat lattice. `count`
 * is geometric membership; `sum` accumulates the field's finite numeric
 * values (a feature with a missing value counts in `count` and adds nothing).
 * Cells emerge in first-seen order; identical inputs produce identical
 * output.
 * @param features - the feature objects to bin (e.g. from the stream scanner).
 * @param params - cell size, measure, optional sum field, and the cell cap.
 * @returns the aggregate cells and honest matched/skipped counts.
 * @throws {GridAggregateFailure} `invalid-cell-size` for non-positive or
 *   non-finite cell sizes; `sum-field-required` when `sum` lacks its field;
 *   `grid-cell-limit-exceeded` when the data spans more than `maxCells` cells.
 */
export function aggregateGridFeatures(
  features: Iterable<Record<string, unknown>>,
  params: GridAggregateParams,
): GridAggregateResult {
  const aggregator = createGridAggregator(params)
  for (const feature of features) {
    aggregator.push(feature)
  }
  return aggregator.result()
}
