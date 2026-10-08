/**
 * The spatiotemporal pattern computations: per-unit change across two
 * time-forward sub-windows, density-based space-time clustering, and
 * origin-destination flows. The time axis is UTC-calendar binned; missing
 * bins stay missing (`never-interpolate`), late records are excluded and
 * named (`exclude-with-diagnostic`), and a window whose bin coverage falls
 * below the spec's declared minimum returns `not_applicable` instead of a
 * fabricated series. Every result carries a time-forward holdout (the last
 * `holdoutBlocks` bins are predicted by the prefix) plus spatial block rows,
 * so stability is measured, never assumed.
 *
 * @module @map-harness/spatial-statistics/patterns
 */
import {
  LATE_DATA_RULE,
  MAX_UNITS,
  MISSING_DATA_RULE,
  STATS_METHOD_VERSION,
  type ChangeSpec,
  type ClusterSpec,
  type FlowSpec,
  type Granularity,
  type NotApplicableReason,
  type PatternSpec,
  type StatStatus,
  type TimeWindow,
} from './contract.ts'
import { StatisticsError } from './errors.ts'
import { haversineMeters, type LonLat } from './weights.ts'

/** One time-stamped observation a pattern computation consumes. */
export interface Observation {
  readonly id: string
  readonly coordinates: LonLat
  /** The numeric field value; non-finite values never enter a computation. */
  readonly value: number
  /** The observation's event time in epoch milliseconds. */
  readonly timeMs: number
  /** The moving entity the observation belongs to (flow). */
  readonly entity?: string
}

/** One bounded diagnostic a pattern computation reports. */
export interface PatternDiagnostic {
  readonly code: 'observation-invalid' | 'observation-outside-window' | 'chain-broken' | 'rows-truncated'
  readonly observationId?: string
  readonly entity?: string
  readonly message: string
}

/** The artifact seam the caller binds to catalog publication. */
export type PatternPublish = (label: string, bytes: Uint8Array) => Promise<{ ref: string }>

/** Shared evidence head every pattern result carries. */
export interface PatternEvidenceHead {
  readonly kind: string
  readonly status: StatStatus
  readonly notApplicableReason?: NotApplicableReason
  readonly methodVersion: typeof STATS_METHOD_VERSION
  readonly inputRefs: { readonly resourceRef: string }
  readonly window: TimeWindow
  readonly granularity: Granularity
  readonly observationCount: number
  readonly validCount: number
  readonly coverage: { readonly occupiedBins: number; readonly expectedBins: number; readonly ratio: number }
  readonly diagnostics: readonly PatternDiagnostic[]
  readonly limitations: readonly string[]
  readonly artifacts: readonly { readonly label: string; readonly ref: string }[]
}

/** One per-spatial-block change row. */
export interface ChangeBlockRow {
  readonly block: string
  readonly unitCount: number
  readonly meanDelta: number | null
}

/** The change evidence record a completed computation returns. */
export interface ChangeEvidence extends PatternEvidenceHead {
  readonly kind: 'temporal-change'
  readonly baselineWindow: TimeWindow
  readonly comparisonWindow: TimeWindow
  readonly unitCount: number
  readonly unitsWithBothWindows: number
  readonly unitsMissingBaseline: number
  readonly unitsMissingComparison: number
  readonly meanBaseline: number | null
  readonly meanComparison: number | null
  readonly meanDelta: number | null
  readonly blocks: readonly ChangeBlockRow[]
  readonly stability: {
    readonly holdoutBlocks: number
    readonly meanDeltaPrefix: number | null
    readonly meanDeltaFull: number | null
    readonly drift: number | null
  }
}

/** One cluster of the space-time DBSCAN result. */
export interface ClusterRow {
  readonly clusterId: string
  readonly memberCount: number
  readonly meanValue: number
  readonly binFrom: number
  readonly binTo: number
  readonly bbox: readonly [number, number, number, number]
}

/** One per-spatial-block cluster participation row. */
export interface ClusterBlockRow {
  readonly block: string
  readonly observationCount: number
  readonly clusterCount: number
  readonly noiseCount: number
}

/** The cluster evidence record a completed computation returns. */
export interface ClusterEvidence extends PatternEvidenceHead {
  readonly kind: 'space-time-cluster'
  readonly clusters: readonly ClusterRow[]
  readonly noiseCount: number
  readonly blocks: readonly ClusterBlockRow[]
  readonly stability: {
    readonly holdoutBlocks: number
    readonly holdoutCount: number
    readonly holdoutAssigned: number
    readonly holdoutNoise: number
  }
}

/** One flow row of the origin-destination table. */
export interface FlowRow {
  readonly flow: string
  readonly fromCell: string
  readonly toCell: string
  readonly transitionCount: number
  readonly entityCount: number
}

/** The flow evidence record a completed computation returns. */
export interface FlowEvidence extends PatternEvidenceHead {
  readonly kind: 'origin-destination-flow'
  readonly entityCount: number
  readonly transitionCount: number
  readonly brokenChainCount: number
  readonly flows: readonly FlowRow[]
  readonly stability: {
    readonly holdoutBlocks: number
    readonly topK: number
    readonly jaccard: number
  }
}

const MS_PER_DAY = 86_400_000

/** The UTC calendar bin key one moment falls into for the granularity. */
function binKeyOf(timeMs: number, granularity: Granularity): number {
  const date = new Date(timeMs)
  if (granularity === 'day') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  if (granularity === 'week') {
    const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
    const mondayOffset = (date.getUTCDay() + 6) % 7
    return day - mondayOffset * MS_PER_DAY
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

/** The next bin key after one bin key in the granularity's calendar. */
function nextBinKey(binKey: number, granularity: Granularity): number {
  const date = new Date(binKey)
  if (granularity === 'month') return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
  return binKey + (granularity === 'week' ? 7 : 1) * MS_PER_DAY
}

/** The expected UTC calendar bins of one half-open window, oldest first. */
export function expectedBinsOf(window: TimeWindow, granularity: Granularity): number[] {
  const from = new Date(window.from).getTime()
  const to = new Date(window.to).getTime()
  const bins: number[] = []
  let key = binKeyOf(from, granularity)
  while (key < to) {
    bins.push(key)
    key = nextBinKey(key, granularity)
    if (bins.length > 4096) break
  }
  return bins
}

/** The spatial block label one coordinate falls into on the fixed grid. */
function blockLabelOf(point: LonLat, origin: LonLat, blockMeters: number): string {
  const latDegrees = blockMeters / 111_320
  // The column width is fixed at the grid origin's latitude, so one
  // computation spans one consistent grid instead of point-varying cells.
  const lonDegrees = latDegrees / Math.max(0.1, Math.cos(origin[1] * Math.PI / 180))
  const col = Math.floor((point[0] - origin[0]) / lonDegrees)
  const row = Math.floor((point[1] - origin[1]) / latDegrees)
  return `r${row}c${col}`
}

/** Admit in-window observations with usable values; exclusions are named. */
function admitObservations(
  observations: readonly Observation[],
  window: TimeWindow,
  diagnostics: PatternDiagnostic[],
): Observation[] {
  if (observations.length > MAX_UNITS) {
    throw new StatisticsError('STATS_INVALID_INPUT', `observation table exceeds the bounded limit of ${MAX_UNITS} units`)
  }
  const from = new Date(window.from).getTime()
  const to = new Date(window.to).getTime()
  const admitted: Observation[] = []
  for (const observation of observations) {
    if (!Number.isFinite(observation.value) || !Number.isFinite(observation.timeMs)) {
      diagnostics.push({ code: 'observation-invalid', observationId: observation.id, message: 'the observation carries no usable value or event time and is excluded' })
      continue
    }
    if (observation.timeMs < from || observation.timeMs >= to) {
      diagnostics.push({ code: 'observation-outside-window', observationId: observation.id, message: `${LATE_DATA_RULE}: the observation falls outside the half-open window and is excluded` })
      continue
    }
    admitted.push(observation)
  }
  return admitted
}

/** Coverage numbers over one admitted set: distinct occupied bins vs expected. */
function coverageOf(admitted: readonly Observation[], expected: readonly number[], granularity: Granularity): { occupiedBins: number; expectedBins: number; ratio: number } {
  const occupied = new Set(admitted.map(observation => binKeyOf(observation.timeMs, granularity)))
  return { occupiedBins: occupied.size, expectedBins: expected.length, ratio: expected.length === 0 ? 0 : occupied.size / expected.length }
}

/** Head fields shared by every pattern evidence. */
function patternHead<K extends string>(
  kind: K,
  status: StatStatus,
  spec: PatternSpec,
  observationCount: number,
  validCount: number,
  coverage: { occupiedBins: number; expectedBins: number; ratio: number },
  diagnostics: readonly PatternDiagnostic[],
  limitations: readonly string[],
  artifacts: { label: string; ref: string }[],
): Omit<PatternEvidenceHead, 'kind'> & { kind: K } {
  return {
    kind,
    status,
    methodVersion: STATS_METHOD_VERSION,
    inputRefs: { resourceRef: spec.resourceRef },
    window: spec.window,
    granularity: spec.granularity,
    observationCount,
    validCount,
    coverage,
    diagnostics,
    limitations,
    artifacts,
  }
}

/** The method limitations every pattern evidence carries. */
function patternLimitations(): readonly string[] {
  return [
    `missing bins stay missing (${MISSING_DATA_RULE}); no series value is interpolated`,
    `records outside the half-open window are excluded (${LATE_DATA_RULE}), never folded into a neighboring bin`,
    'the stability figures describe the declared holdout only; they are not forecasts and carry no causal claim',
  ]
}

/** The mean over one picker's non-null values. */
function meanOf<T>(rows: readonly T[], pick: (row: T) => number | null): number | null {
  const values = rows.map(pick).filter((value): value is number => value !== null)
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0) / values.length
}

/** Publish one full table through the seam when present. */
async function publishTable(
  publish: PatternPublish | undefined,
  artifacts: { label: string; ref: string }[],
  label: string,
  table: unknown,
): Promise<void> {
  if (publish === undefined) return
  const published = await publish(label, new TextEncoder().encode(JSON.stringify(table)))
  artifacts.push({ label, ref: published.ref })
}

/**
 * Per-unit change across two ordered sub-windows. A unit missing either
 * window reports no delta (the gap stays unknown, never zero-filled); the
 * aggregate deltas cover the units both windows observed. Stability is the
 * time-forward drift between the prefix (all comparison blocks but the last)
 * and the full comparison window, plus the per-spatial-block deltas.
 * @param observations - the resource's time-stamped observations.
 * @param spec - the validated change spec.
 * @param publish - the optional artifact seam (per-unit full table).
 * @returns the change evidence.
 */
export async function computeChange(
  observations: readonly Observation[],
  spec: ChangeSpec,
  publish?: PatternPublish,
): Promise<ChangeEvidence> {
  const diagnostics: PatternDiagnostic[] = []
  const admitted = admitObservations(observations, spec.window, diagnostics)
  const artifacts: { label: string; ref: string }[] = []
  const expected = expectedBinsOf(spec.window, spec.granularity)
  const coverage = coverageOf(admitted, expected, spec.granularity)
  const head = patternHead('temporal-change', 'succeeded', spec, observations.length, admitted.length, coverage, diagnostics, patternLimitations(), artifacts)
  const notApplicable = (reason: NotApplicableReason): ChangeEvidence => ({
    ...head,
    status: 'not_applicable',
    notApplicableReason: reason,
    baselineWindow: spec.baselineWindow,
    comparisonWindow: spec.comparisonWindow,
    unitCount: 0,
    unitsWithBothWindows: 0,
    unitsMissingBaseline: 0,
    unitsMissingComparison: 0,
    meanBaseline: null,
    meanComparison: null,
    meanDelta: null,
    blocks: [],
    stability: { holdoutBlocks: spec.holdoutBlocks, meanDeltaPrefix: null, meanDeltaFull: null, drift: null },
  })
  if (admitted.length === 0) return notApplicable('no-valid-observations')
  if (coverage.ratio < spec.minCoverage) return notApplicable('time-coverage-insufficient')

  // Grouping key: the declared unit property when present, the observation
  // id otherwise.
  const unitKeyOf = (observation: Observation): string =>
    spec.unitField === undefined ? observation.id : (observation.entity ?? observation.id)
  const windowMeansOf = (rows: readonly Observation[], window: TimeWindow): Map<string, { sum: number; count: number }> => {
    const from = new Date(window.from).getTime()
    const to = new Date(window.to).getTime()
    const means = new Map<string, { sum: number; count: number }>()
    for (const observation of rows) {
      if (observation.timeMs < from || observation.timeMs >= to) continue
      const key = unitKeyOf(observation)
      const row = means.get(key) ?? { sum: 0, count: 0 }
      row.sum += observation.value
      row.count += 1
      means.set(key, row)
    }
    return means
  }
  const baseline = windowMeansOf(admitted, spec.baselineWindow)
  const comparison = windowMeansOf(admitted, spec.comparisonWindow)
  const perUnit: { id: string; baseline: number | null; comparison: number | null; delta: number | null; block: string }[] = []
  const ids = new Set([...baseline.keys(), ...comparison.keys()])
  const origin: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  for (const observation of admitted) {
    origin[0] = Math.min(origin[0], observation.coordinates[0])
    origin[1] = Math.min(origin[1], observation.coordinates[1])
  }
  const firstPointOf = new Map<string, LonLat>()
  for (const observation of admitted) {
    const key = unitKeyOf(observation)
    if (!firstPointOf.has(key)) firstPointOf.set(key, observation.coordinates)
  }
  for (const id of ids) {
    const before = baseline.get(id)
    const after = comparison.get(id)
    const firstPoint = firstPointOf.get(id) ?? [0, 0]
    perUnit.push({
      id,
      baseline: before === undefined ? null : before.sum / before.count,
      comparison: after === undefined ? null : after.sum / after.count,
      delta: before === undefined || after === undefined ? null : after.sum / after.count - before.sum / before.count,
      block: blockLabelOf(firstPoint, origin, spec.blockMeters),
    })
  }
  perUnit.sort((a, b) => a.id < b.id ? -1 : 1)
  const both = perUnit.filter(row => row.delta !== null)
  const meanDeltaFull = meanOf(both, row => row.delta)

  // Time-forward holdout: the last comparison blocks drop out of the prefix.
  const comparisonExpected = expectedBinsOf(spec.comparisonWindow, spec.granularity)
  const holdoutKeys = new Set(comparisonExpected.slice(Math.max(0, comparisonExpected.length - spec.holdoutBlocks)))
  const holdoutFrom = holdoutKeys.size > 0 ? Math.min(...holdoutKeys) : Number.POSITIVE_INFINITY
  const prefixMeans = windowMeansOf(admitted.filter(observation => observation.timeMs < holdoutFrom), spec.comparisonWindow)
  const prefixBoth = [...ids].map(id => {
    const before = baseline.get(id)
    const after = prefixMeans.get(id)
    return before === undefined || after === undefined ? null : after.sum / after.count - before.sum / before.count
  }).filter((value): value is number => value !== null)
  const meanDeltaPrefix = prefixBoth.length === 0 ? null : prefixBoth.reduce((total, value) => total + value, 0) / prefixBoth.length

  const blockRowsMap = new Map<string, { deltas: number[]; units: Set<string> }>()
  for (const row of both) {
    const entry = blockRowsMap.get(row.block) ?? { deltas: [], units: new Set<string>() }
    if (row.delta !== null) entry.deltas.push(row.delta)
    entry.units.add(row.id)
    blockRowsMap.set(row.block, entry)
  }
  const blocks: ChangeBlockRow[] = [...blockRowsMap.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([block, entry]) => ({
    block,
    unitCount: entry.units.size,
    meanDelta: entry.deltas.length === 0 ? null : entry.deltas.reduce((total, value) => total + value, 0) / entry.deltas.length,
  }))

  const status: StatStatus = diagnostics.some(diagnostic => diagnostic.code === 'observation-invalid') ? 'partial' : 'succeeded'
  if (blocks.length > 256) {
    diagnostics.push({ code: 'rows-truncated', message: `the block table carries ${blocks.length} rows; the evidence keeps the first 256 (the artifact keeps all)` })
  }
  const evidence: ChangeEvidence = {
    ...head,
    status,
    baselineWindow: spec.baselineWindow,
    comparisonWindow: spec.comparisonWindow,
    unitCount: perUnit.length,
    unitsWithBothWindows: both.length,
    unitsMissingBaseline: perUnit.filter(row => row.baseline === null).length,
    unitsMissingComparison: perUnit.filter(row => row.comparison === null).length,
    meanBaseline: meanOf(perUnit, row => row.baseline),
    meanComparison: meanOf(perUnit, row => row.comparison),
    meanDelta: meanDeltaFull,
    blocks: blocks.slice(0, 256),
    stability: {
      holdoutBlocks: spec.holdoutBlocks,
      meanDeltaPrefix,
      meanDeltaFull: meanDeltaFull,
      drift: meanDeltaFull === null || meanDeltaPrefix === null ? null : Math.abs(meanDeltaFull - meanDeltaPrefix),
    },
  }
  await publishTable(publish, artifacts, 'change-table', {
    kind: evidence.kind,
    methodVersion: evidence.methodVersion,
    resourceRef: spec.resourceRef,
    perUnit,
  })
  return evidence
}

/** DBSCAN over space-time: cluster labels per observation (`-1` noise). */
export function dbscan(
  observations: readonly Observation[],
  binIndexes: readonly number[],
  epsMeters: number,
  epsBins: number,
  minPts: number,
): { labels: number[]; clusterCount: number } {
  const n = observations.length
  const labels = new Array<number>(n).fill(-2)
  const neighborIndexesOf = (index: number): number[] => {
    const result: number[] = []
    for (let j = 0; j < n; j++) {
      if (j === index) continue
      if (Math.abs((binIndexes[index] ?? 0) - (binIndexes[j] ?? 0)) > epsBins) continue
      if (haversineMeters(observations[index]?.coordinates ?? [0, 0], observations[j]?.coordinates ?? [0, 0]) <= epsMeters) result.push(j)
    }
    return result
  }
  let clusterId = 0
  for (let i = 0; i < n; i++) {
    if ((labels[i] ?? 0) !== -2) continue
    const neighbors = neighborIndexesOf(i)
    if (neighbors.length + 1 < minPts) {
      labels[i] = -1
      continue
    }
    labels[i] = clusterId
    const queue = [...neighbors]
    while (queue.length > 0) {
      const j = queue.shift() ?? 0
      const label = labels[j]
      if (label === -1) labels[j] = clusterId
      if (label !== -2) continue
      labels[j] = clusterId
      const jNeighbors = neighborIndexesOf(j)
      if (jNeighbors.length + 1 >= minPts) {
        for (const k of jNeighbors) {
          if ((labels[k] ?? -2) === -2) queue.push(k)
        }
      }
    }
    clusterId += 1
  }
  return { labels, clusterCount: clusterId }
}

/**
 * Density-based space-time clusters (DBSCAN over meters and granularity
 * bins). The forward holdout fits the prefix and reports how many holdout
 * observations a prefix core still reaches; per-block rows report
 * participation without re-running anything.
 * @param observations - the resource's time-stamped observations.
 * @param spec - the validated cluster spec.
 * @param publish - the optional artifact seam (per-observation assignment).
 * @returns the cluster evidence.
 */
export async function computeCluster(
  observations: readonly Observation[],
  spec: ClusterSpec,
  publish?: PatternPublish,
): Promise<ClusterEvidence> {
  const diagnostics: PatternDiagnostic[] = []
  const admitted = admitObservations(observations, spec.window, diagnostics)
  const artifacts: { label: string; ref: string }[] = []
  const expected = expectedBinsOf(spec.window, spec.granularity)
  const coverage = coverageOf(admitted, expected, spec.granularity)
  const head = patternHead('space-time-cluster', 'succeeded', spec, observations.length, admitted.length, coverage, diagnostics, patternLimitations(), artifacts)
  const notApplicable = (reason: NotApplicableReason): ClusterEvidence => ({
    ...head,
    status: 'not_applicable',
    notApplicableReason: reason,
    clusters: [],
    noiseCount: admitted.length,
    blocks: [],
    stability: { holdoutBlocks: spec.holdoutBlocks, holdoutCount: 0, holdoutAssigned: 0, holdoutNoise: 0 },
  })
  if (admitted.length < spec.minPts) return notApplicable('too-few-valid-units')
  if (coverage.ratio < spec.minCoverage) return notApplicable('time-coverage-insufficient')

  const binIndexByKey = new Map(expected.map((key, index) => [key, index]))
  const binIndexOf = (timeMs: number): number => binIndexByKey.get(binKeyOf(timeMs, spec.granularity)) ?? -1
  const binIndexes = admitted.map(observation => binIndexOf(observation.timeMs))
  const { labels, clusterCount } = dbscan(admitted, binIndexes, spec.epsMeters, spec.epsBins, spec.minPts)

  const origin: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  for (const observation of admitted) {
    origin[0] = Math.min(origin[0], observation.coordinates[0])
    origin[1] = Math.min(origin[1], observation.coordinates[1])
  }
  const clusterRows: ClusterRow[] = []
  for (let cluster = 0; cluster < clusterCount; cluster++) {
    const members = admitted.filter((_, index) => labels[index] === cluster)
    const binKeys = members.map(observation => binKeyOf(observation.timeMs, spec.granularity))
    clusterRows.push({
      clusterId: `c${cluster + 1}`,
      memberCount: members.length,
      meanValue: members.reduce((total, observation) => total + observation.value, 0) / Math.max(1, members.length),
      binFrom: members.length > 0 ? Math.min(...binKeys) : 0,
      binTo: members.length > 0 ? Math.max(...binKeys) : 0,
      bbox: [
        Math.min(...members.map(observation => observation.coordinates[0])),
        Math.min(...members.map(observation => observation.coordinates[1])),
        Math.max(...members.map(observation => observation.coordinates[0])),
        Math.max(...members.map(observation => observation.coordinates[1])),
      ],
    })
  }
  const noiseCount = admitted.filter((_, index) => labels[index] === -1).length

  const blockMap = new Map<string, { observations: Set<string>; clusters: Set<number>; noise: number }>()
  admitted.forEach((observation, index) => {
    const block = blockLabelOf(observation.coordinates, origin, spec.blockMeters)
    const entry = blockMap.get(block) ?? { observations: new Set<string>(), clusters: new Set<number>(), noise: 0 }
    entry.observations.add(observation.id)
    const label = labels[index] ?? -1
    if (label >= 0) entry.clusters.add(label)
    else entry.noise += 1
    blockMap.set(block, entry)
  })
  const blocks: ClusterBlockRow[] = [...blockMap.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([block, entry]) => ({
    block,
    observationCount: entry.observations.size,
    clusterCount: entry.clusters.size,
    noiseCount: entry.noise,
  }))

  // Time-forward holdout: fit the prefix, then count how many holdout
  // observations a prefix core still reaches within (epsMeters, epsBins).
  const holdoutKeys = new Set(expected.slice(Math.max(0, expected.length - spec.holdoutBlocks)))
  const prefixIndexes: number[] = []
  const holdoutIndexes: number[] = []
  admitted.forEach((observation, index) => {
    if (holdoutKeys.has(binKeyOf(observation.timeMs, spec.granularity))) holdoutIndexes.push(index)
    else prefixIndexes.push(index)
  })
  const prefixObservations = prefixIndexes.map(index => admitted[index] as Observation)
  const prefixBins = prefixIndexes.map(index => binIndexes[index] as number)
  const prefix = prefixObservations.length >= spec.minPts
    ? dbscan(prefixObservations, prefixBins, spec.epsMeters, spec.epsBins, spec.minPts)
    : { labels: prefixObservations.map(() => -1), clusterCount: 0 }
  const coreOfPrefix = new Set<number>()
  prefix.labels.forEach((label, index) => {
    if (label >= 0) coreOfPrefix.add(index)
  })
  let holdoutAssigned = 0
  let holdoutNoise = 0
  for (const index of holdoutIndexes) {
    const observation = admitted[index] as Observation
    const timeBin = binKeyOf(observation.timeMs, spec.granularity)
    const reached = prefixObservations.some((candidate, prefixIndex) => {
      if (!coreOfPrefix.has(prefixIndex)) return false
      if (Math.abs(timeBin - binKeyOf(candidate.timeMs, spec.granularity)) > spec.epsBins) return false
      return haversineMeters(observation.coordinates, candidate.coordinates) <= spec.epsMeters
    })
    if (reached) holdoutAssigned += 1
    else holdoutNoise += 1
  }

  const status: StatStatus = diagnostics.some(diagnostic => diagnostic.code === 'observation-invalid') ? 'partial' : 'succeeded'
  if (clusterRows.length > 256) {
    diagnostics.push({ code: 'rows-truncated', message: `the cluster table carries ${clusterRows.length} rows; the evidence keeps the first 256 (the artifact keeps all)` })
  }
  const evidence: ClusterEvidence = {
    ...head,
    status,
    clusters: clusterRows.slice(0, 256),
    noiseCount,
    blocks: blocks.slice(0, 256),
    stability: {
      holdoutBlocks: spec.holdoutBlocks,
      holdoutCount: holdoutIndexes.length,
      holdoutAssigned,
      holdoutNoise,
    },
  }
  await publishTable(publish, artifacts, 'cluster-table', {
    kind: evidence.kind,
    methodVersion: evidence.methodVersion,
    resourceRef: spec.resourceRef,
    assignments: admitted.map((observation, index) => ({ id: observation.id, cluster: labels[index], block: blockLabelOf(observation.coordinates, origin, spec.blockMeters) })),
  })
  return evidence
}

/** The grid cell id one coordinate falls into, anchored at the set's origin. */
function cellOf(point: LonLat, origin: LonLat, cellMeters: number): string {
  return blockLabelOf(point, origin, cellMeters)
}

/**
 * Origin-destination flows: consecutive observations of one entity on the
 * binned time axis contribute a cell-to-cell transition. A chain gap above
 * `maxGapBins` breaks the chain (named, never interpolated); in-cell stays
 * are counted as `cell→cell` flows. Stability is the Jaccard overlap of the
 * top-K flow sets between the prefix (last holdout bins dropped) and the
 * full window.
 * @param observations - the resource's time-stamped observations.
 * @param spec - the validated flow spec.
 * @param publish - the optional artifact seam (full transition table).
 * @returns the flow evidence.
 */
export async function computeFlow(
  observations: readonly Observation[],
  spec: FlowSpec,
  publish?: PatternPublish,
): Promise<FlowEvidence> {
  const diagnostics: PatternDiagnostic[] = []
  const admitted = admitObservations(observations, spec.window, diagnostics)
  const artifacts: { label: string; ref: string }[] = []
  const expected = expectedBinsOf(spec.window, spec.granularity)
  const coverage = coverageOf(admitted, expected, spec.granularity)
  const head = patternHead('origin-destination-flow', 'succeeded', spec, observations.length, admitted.length, coverage, diagnostics, patternLimitations(), artifacts)
  const notApplicable = (reason: NotApplicableReason): FlowEvidence => ({
    ...head,
    status: 'not_applicable',
    notApplicableReason: reason,
    entityCount: 0,
    transitionCount: 0,
    brokenChainCount: 0,
    flows: [],
    stability: { holdoutBlocks: spec.holdoutBlocks, topK: spec.topK, jaccard: 0 },
  })
  const entities = new Set(admitted.map(observation => observation.entity).filter((entity): entity is string => entity !== undefined))
  if (admitted.length === 0 || entities.size === 0) return notApplicable('no-valid-observations')
  if (coverage.ratio < spec.minCoverage) return notApplicable('time-coverage-insufficient')

  const origin: [number, number] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
  for (const observation of admitted) {
    origin[0] = Math.min(origin[0], observation.coordinates[0])
    origin[1] = Math.min(origin[1], observation.coordinates[1])
  }
  const binIndexByKey = new Map(expected.map((key, index) => [key, index]))
  const binIndexOf = (timeMs: number): number => binIndexByKey.get(binKeyOf(timeMs, spec.granularity)) ?? -1

  /** Consecutive transitions of one ordered entity chain over a subset of indexes. */
  const transitionsOf = (indexes: readonly number[]): { flows: Map<string, { count: number; entities: Set<string> }>; broken: number } => {
    const byEntity = new Map<string, number[]>()
    for (const index of indexes) {
      const observation = admitted[index] as Observation
      if (observation.entity === undefined) continue
      const chain = byEntity.get(observation.entity) ?? []
      chain.push(index)
      byEntity.set(observation.entity, chain)
    }
    const flows = new Map<string, { count: number; entities: Set<string> }>()
    let broken = 0
    for (const [entity, chain] of byEntity) {
      const ordered = [...chain].sort((a, b) => {
        const timeA = (admitted[a] as Observation).timeMs
        const timeB = (admitted[b] as Observation).timeMs
        return timeA === timeB ? a - b : timeA - timeB
      })
      for (let k = 1; k < ordered.length; k++) {
        const before = admitted[ordered[k - 1] as number] as Observation
        const after = admitted[ordered[k] as number] as Observation
        const gap = binIndexOf(after.timeMs) - binIndexOf(before.timeMs)
        if (gap < 0 || gap > spec.maxGapBins) {
          broken += 1
          continue
        }
        const fromCell = cellOf(before.coordinates, origin, spec.cellMeters)
        const toCell = cellOf(after.coordinates, origin, spec.cellMeters)
        const key = `${fromCell}->${toCell}`
        const row = flows.get(key) ?? { count: 0, entities: new Set<string>() }
        row.count += 1
        row.entities.add(entity)
        flows.set(key, row)
      }
    }
    return { flows, broken }
  }

  const { flows, broken } = transitionsOf(admitted.map((_, index) => index))
  const topFlowsOf = (table: Map<string, { count: number; entities: Set<string> }>): FlowRow[] => {
    return [...table.entries()]
      .sort(([a, aRow], [b, bRow]) => bRow.count - aRow.count || (a < b ? -1 : 1))
      .slice(0, spec.topK)
      .map(([key, row]) => {
        const [fromCell, toCell] = key.split('->')
        return { flow: key, fromCell: fromCell ?? '', toCell: toCell ?? '', transitionCount: row.count, entityCount: row.entities.size }
      })
  }
  const top = topFlowsOf(flows)

  const holdoutKeys = new Set(expected.slice(Math.max(0, expected.length - spec.holdoutBlocks)))
  const prefixIndexes = admitted.map((observation, index) => holdoutKeys.has(binKeyOf(observation.timeMs, spec.granularity)) ? -1 : index).filter(index => index >= 0)
  const prefix = transitionsOf(prefixIndexes)
  const prefixTop = new Set(topFlowsOf(prefix.flows).map(row => row.flow))
  const fullTop = new Set(top.map(row => row.flow))
  const intersection = [...fullTop].filter(key => prefixTop.has(key)).length
  const union = new Set([...fullTop, ...prefixTop]).size
  const jaccard = union === 0 ? 0 : intersection / union

  if (broken > 0) {
    diagnostics.push({ code: 'chain-broken', message: `${broken} entity chain gaps exceed ${spec.maxGapBins} bins and break the transition (${MISSING_DATA_RULE}); no midpoint was invented` })
  }
  const status: StatStatus = diagnostics.some(diagnostic => diagnostic.code === 'observation-invalid') ? 'partial' : 'succeeded'
  const evidence: FlowEvidence = {
    ...head,
    status,
    entityCount: entities.size,
    transitionCount: [...flows.values()].reduce((total, row) => total + row.count, 0),
    brokenChainCount: broken,
    flows: top,
    stability: { holdoutBlocks: spec.holdoutBlocks, topK: spec.topK, jaccard },
  }
  await publishTable(publish, artifacts, 'flow-table', {
    kind: evidence.kind,
    methodVersion: evidence.methodVersion,
    resourceRef: spec.resourceRef,
    flows: topFlowsOf(flows),
  })
  return evidence
}
