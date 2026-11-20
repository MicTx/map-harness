/**
 * The controlled road-network/LBS provider: a deterministic in-process
 * lattice road network with per-mode speeds and time-slice factors, plus the
 * provider face (`networkVersion`, `snapPoint`, `serviceArea`, `route`,
 * `readPois`) the coverage computation consumes. Deterministic fault rules
 * inject the rate-limit, permission, unavailable, and abort paths the real
 * connector must surface; the provider is the only configured network source
 * of this deployment and an unknown network id fails loud. Cancellation lands
 * at real checkpoints inside the expansion/pagination loops — never as a
 * Promise timeout over synchronous work.
 *
 * @module @map-harness/spatial-accessibility/network
 */
import { AccessibilityError } from './errors.ts'
import { sha256Hex, type ExtentBox, type LonLat, type TimeSliceId, type TravelMode } from './contract.ts'

/** The only configured network provider id of this deployment. */
export const CONTROLLED_NETWORK_ID = 'controlled-lattice'

/** Per-mode free-flow speeds the lattice prices edges with (km/h). */
export const DEFAULT_MODE_SPEED_KMH: Readonly<Record<TravelMode, number>> = {
  walk: 4.5,
  bike: 12,
  drive: 30,
}

/** Per-slice congestion multipliers (>1 means slower, so smaller service areas). */
export const DEFAULT_SLICE_FACTOR: Readonly<Record<TimeSliceId, number>> = {
  'morning-peak': 1.2,
  midday: 1.0,
  'evening-peak': 1.25,
  night: 0.85,
}

/** The deterministic fault codes the provider can inject. */
export type ProviderFaultCode = 'RATE_LIMITED' | 'PERMISSION_DENIED' | 'TEMPORARILY_UNAVAILABLE'

/** One deterministic fault rule: the nth call (1-based) of `op` fails. */
export interface ProviderFaultRule {
  /** Which provider operation the rule counts. */
  readonly op: 'route' | 'pois' | 'serviceArea'
  /** 1-based ordinal of the failing call; with `repeat`, every nth call thereafter fails too. */
  readonly nth: number
  /** Repeat on every nth call instead of failing once. */
  readonly repeat?: boolean
  readonly code: ProviderFaultCode
  /** Seconds the caller should wait before retrying (`RATE_LIMITED` only). */
  readonly retryAfterSeconds?: number
}

/** Provider construction options. */
export interface NetworkProviderConfig {
  /** The lattice extent in WGS84; nodes tile this box. */
  readonly bbox: ExtentBox
  /** Grid spacing in degrees; bounded so a single lattice stays small. */
  readonly spacingDeg?: number
  /** Per-mode speeds in km/h; omission keeps the defaults. */
  readonly speedKmhPerMode?: Partial<Record<TravelMode, number>>
  /** Per-slice congestion multipliers; omission keeps the defaults. */
  readonly sliceFactor?: Partial<Record<TimeSliceId, number>>
  /** Deterministic fault injection for tests; production providers run clean. */
  readonly faults?: readonly ProviderFaultRule[]
  /** Expansion hook for deterministic cancellation tests; called between Dijkstra expansions. */
  readonly beforeExpand?: () => void
}

/** Maximum lattice spacing divisor: the grid never exceeds ~400×400 nodes. */
const MAX_LATTICE_NODES = 160_000

/** Minimum grid spacing in degrees (≈1 m) — below this a lattice is meaningless. */
const MIN_SPACING_DEG = 0.00001

/** One lattice node. */
export interface NetworkNode {
  readonly id: string
  readonly lon: number
  readonly lat: number
}

/** One paginated POI read page. */
export interface PoiPage {
  readonly items: readonly { readonly id: string; readonly coordinates: LonLat }[]
  readonly page: number
  readonly total: number
  readonly hasMore: boolean
}

/** The coverage state one completed POI collection reports. */
export type PoiCoverage = 'complete' | 'partial' | 'empty'

/** The result of one full paginated POI collection. */
export interface PoiCollection {
  readonly items: readonly { readonly id: string; readonly coordinates: LonLat }[]
  readonly pages: number
  readonly total: number
  readonly coverage: PoiCoverage
  /** When partial: the fault that stopped the collection. */
  readonly interruptedBy?: ProviderFaultCode
}

/** One network service area: the nodes reachable within the budget, with minutes. */
export interface ServiceArea {
  readonly origin: LonLat
  readonly budgetMinutes: number
  /** Reachable nodes with their network minutes from the origin. */
  readonly nodes: readonly { readonly id: string; readonly lon: number; readonly lat: number; readonly minutes: number }[]
}

/** The provider face the accessibility layer consumes. */
export interface NetworkProvider {
  /** The immutable network version identity (`<id>-<digest>@1`). */
  readonly networkRef: string
  /** The network id this provider serves; anything else fails loud at construction. */
  readonly networkId: string
  /**
   * Whether the network prices one travel mode; a mode without priced edges
   * makes any walk/bike/drive target `METHOD_NOT_APPLICABLE`.
   */
  pricesMode(mode: TravelMode): boolean
  /** Nearest lattice node to one point, with the snap distance in km. */
  snapPoint(point: LonLat): { readonly node: NetworkNode; readonly snapKm: number }
  /**
   * Compute the network service area around one origin within a minutes
   * budget under a mode and time slice, with barriers applied.
   * @throws {AccessibilityError} `METHOD_NOT_APPLICABLE` for a mode the
   *   network does not price; provider fault codes per the injected rules.
   */
  serviceArea(origin: LonLat, budgetMinutes: number, options: {
    readonly mode: TravelMode
    readonly slice: TimeSliceId
    readonly barriers?: readonly { readonly from: LonLat; readonly to: LonLat; readonly kind: 'blocked' | 'delay'; readonly delayMinutes?: number }[]
    readonly signal?: AbortSignal
  }): Promise<ServiceArea>
  /**
   * Route one origin→destination pair under a mode and time slice.
   * @throws {AccessibilityError} when no connected path exists or a fault fires.
   */
  route(origin: LonLat, destination: LonLat, options: {
    readonly mode: TravelMode
    readonly slice: TimeSliceId
    readonly barriers?: readonly { readonly from: LonLat; readonly to: LonLat; readonly kind: 'blocked' | 'delay'; readonly delayMinutes?: number }[]
    readonly signal?: AbortSignal
  }): Promise<{ readonly minutes: number; readonly distanceKm: number; readonly nodes: readonly string[] }>
  /**
   * Read one paginated page of the provider POI directory inside a bbox.
   * @throws {AccessibilityError} provider fault codes per the injected rules.
   */
  readPois(bbox: ExtentBox, options: { readonly page: number; readonly pageSize: number; readonly signal?: AbortSignal }): Promise<PoiPage>
}

/** Great-circle distance in km between two WGS84 points (equirectangular approximation over small spans). */
function distanceKm(a: LonLat, b: LonLat): number {
  const midLatRad = ((a[1] + b[1]) / 2) * Math.PI / 180
  const dLon = (b[0] - a[0]) * Math.PI / 180
  const dLat = (b[1] - a[1]) * Math.PI / 180
  const x = dLon * Math.cos(midLatRad)
  return Math.sqrt(x * x + dLat * dLat) * 6371
}

/** The deterministic lattice this provider serves. */
interface Lattice {
  readonly bbox: ExtentBox
  readonly cols: number
  readonly rows: number
  readonly spacingDeg: number
  readonly nodes: NetworkNode[]
  /** Node index by `col,row`. */
  readonly indexOf: (col: number, row: number) => number
}

/** Build the lattice: nodes tile the bbox at the spacing, clamped to the node cap. */
function buildLattice(config: { bbox: ExtentBox; spacingDeg?: number }): Lattice {
  const [west, south, east, north] = config.bbox
  const spanLon = east - west
  const spanLat = north - south
  const requested = config.spacingDeg ?? 0.005
  let spacing = Math.max(requested, MIN_SPACING_DEG)
  let cols = Math.max(2, Math.floor(spanLon / spacing) + 1)
  let rows = Math.max(2, Math.floor(spanLat / spacing) + 1)
  if (cols * rows > MAX_LATTICE_NODES) {
    // Clamp by growing the spacing so the lattice stays bounded; the growth
    // is part of the deterministic network digest.
    const scale = Math.sqrt((cols * rows) / MAX_LATTICE_NODES)
    spacing = spacing * scale
    cols = Math.max(2, Math.floor(spanLon / spacing) + 1)
    rows = Math.max(2, Math.floor(spanLat / spacing) + 1)
  }
  const nodes: NetworkNode[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      nodes.push({
        id: `n-${col}-${row}`,
        lon: Math.min(west + col * spacing, east),
        lat: Math.min(south + row * spacing, north),
      })
    }
  }
  return {
    bbox: config.bbox,
    cols,
    rows,
    spacingDeg: spacing,
    nodes,
    indexOf: (col, row) => row * cols + col,
  }
}

/** Nearest lattice node to one point. */
function snapToLattice(lattice: Lattice, point: LonLat): { node: NetworkNode; snapKm: number } {
  const col = Math.round((point[0] - lattice.bbox[0]) / lattice.spacingDeg)
  const row = Math.round((point[1] - lattice.bbox[1]) / lattice.spacingDeg)
  const clampedCol = Math.min(Math.max(col, 0), lattice.cols - 1)
  const clampedRow = Math.min(Math.max(row, 0), lattice.rows - 1)
  const node = lattice.nodes[lattice.indexOf(clampedCol, clampedRow)]
  if (node === undefined) throw new AccessibilityError('ACCESS_STATE', 'lattice node missing at a clamped grid position')
  return { node, snapKm: distanceKm(point, [node.lon, node.lat]) }
}

/**
 * Whether one barrier segment covers the lattice edge between two adjacent
 * nodes: the edge midpoint must lie within 1.5× half the edge length of the
 * barrier segment (both sides of the comparison in kilometres).
 */
function barrierBlocks(barrier: { from: LonLat; to: LonLat; kind: 'blocked' | 'delay' }, a: NetworkNode, b: NetworkNode): boolean {
  // Midpoint of the lattice edge.
  const mid: LonLat = [(a.lon + b.lon) / 2, (a.lat + b.lat) / 2]
  const segLon = barrier.to[0] - barrier.from[0]
  const segLat = barrier.to[1] - barrier.from[1]
  const segLengthSq = segLon * segLon + segLat * segLat
  if (segLengthSq === 0) return false
  // Project the midpoint onto the barrier segment (planar over these spans).
  const t = Math.min(1, Math.max(0, ((mid[0] - barrier.from[0]) * segLon + (mid[1] - barrier.from[1]) * segLat) / segLengthSq))
  const foot: LonLat = [barrier.from[0] + t * segLon, barrier.from[1] + t * segLat]
  const reachKm = distanceKm([a.lon, a.lat], [b.lon, b.lat]) / 2 * 1.5
  return distanceKm(mid, foot) <= reachKm
}

/** A minimal binary min-heap over string ids with numeric priorities. */
class MinHeap {
  private readonly items: { id: string; priority: number }[] = []

  /** Current element count. */
  get size(): number {
    return this.items.length
  }

  /** Push one element. */
  push(id: string, priority: number): void {
    this.items.push({ id, priority })
    let index = this.items.length - 1
    while (index > 0) {
      const parent = (index - 1) >> 1
      if ((this.items[parent]?.priority ?? Infinity) <= (this.items[index]?.priority ?? Infinity)) break
      const a = this.items[parent]
      const b = this.items[index]
      if (a === undefined || b === undefined) break
      this.items[parent] = b
      this.items[index] = a
      index = parent
    }
  }

  /** Pop the lowest-priority element, or `undefined` when empty. */
  pop(): { id: string; priority: number } | undefined {
    const top = this.items[0]
    const last = this.items.pop()
    if (top === undefined || last === undefined) return top
    if (this.items.length === 0) return top
    this.items[0] = last
    let index = 0
    for (;;) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index
      if (left < this.items.length && (this.items[left]?.priority ?? Infinity) < (this.items[smallest]?.priority ?? Infinity)) smallest = left
      if (right < this.items.length && (this.items[right]?.priority ?? Infinity) < (this.items[smallest]?.priority ?? Infinity)) smallest = right
      if (smallest === index) break
      const a = this.items[smallest]
      const b = this.items[index]
      if (a === undefined || b === undefined) break
      this.items[smallest] = b
      this.items[index] = a
      index = smallest
    }
    return top
  }
}

/** Deterministic synthetic POI count inside a bbox: ~4 POIs per 0.01°² cell; a tiny bbox has none. */
function poiTotalFor(bbox: ExtentBox): number {
  const cells = Math.round(((bbox[2] - bbox[0]) * (bbox[3] - bbox[1])) / 0.0001)
  return Math.min(Math.max(cells, 0) * 4, 4096)
}

/** The deterministic synthetic POI directory of one bbox, generated lazily per page. */
function poiPageFor(bbox: ExtentBox, page: number, pageSize: number): PoiPage {
  const total = poiTotalFor(bbox)
  const start = page * pageSize
  const count = Math.min(pageSize, Math.max(0, total - start))
  const items: { id: string; coordinates: LonLat }[] = []
  for (let index = 0; index < count; index++) {
    const ordinal = start + index
    const x = (ordinal * 37) % 1000 / 1000
    const y = (ordinal * 73) % 1000 / 1000
    items.push({
      id: `poi-${sha256Hex(`${bbox.join(',')}:${ordinal}`).slice(0, 12)}`,
      coordinates: [
        Math.round((bbox[0] + x * (bbox[2] - bbox[0])) * 1e6) / 1e6,
        Math.round((bbox[1] + y * (bbox[3] - bbox[1])) * 1e6) / 1e6,
      ],
    })
  }
  return { items, page, total, hasMore: start + count < total }
}

/**
 * Create the controlled network provider over one lattice extent.
 * @param config - the lattice extent, speeds, slice factors, and test fault rules.
 * @returns the provider.
 * @throws {AccessibilityError} `ACCESS_INVALID_INPUT` when the extent or spacing is unusable.
 */
export function createControlledNetworkProvider(config: NetworkProviderConfig): NetworkProvider {
  if (config.bbox.some(v => !Number.isFinite(v))) {
    throw new AccessibilityError('ACCESS_INVALID_INPUT', 'provider bbox must be finite numbers')
  }
  const lattice = buildLattice(config)
  const speeds: Record<TravelMode, number> = { ...DEFAULT_MODE_SPEED_KMH, ...config.speedKmhPerMode }
  const slices: Record<TimeSliceId, number> = { ...DEFAULT_SLICE_FACTOR, ...config.sliceFactor }
  const faults = config.faults ?? []
  const callCounts = new Map<string, number>()

  /** Raise the injected fault for one operation call when a rule matches. */
  function faultFor(op: ProviderFaultRule['op']): AccessibilityError | undefined {
    const key = op
    const ordinal = (callCounts.get(key) ?? 0) + 1
    callCounts.set(key, ordinal)
    for (const rule of faults) {
      if (rule.op !== op) continue
      const hit = rule.repeat === true ? ordinal >= rule.nth && (ordinal - rule.nth) % rule.nth === 0 : ordinal === rule.nth
      if (hit) {
        if (rule.code === 'RATE_LIMITED') {
          return new AccessibilityError('RATE_LIMITED', `provider rate limited ${op} (retry after ${rule.retryAfterSeconds ?? 1}s)`)
        }
        if (rule.code === 'PERMISSION_DENIED') {
          return new AccessibilityError('PERMISSION_DENIED', `provider refuses ${op}: the credential lacks this region`)
        }
        return new AccessibilityError('TEMPORARILY_UNAVAILABLE', `provider ${op} is temporarily unavailable`)
      }
    }
    return undefined
  }

  /** Effective edge minutes between two adjacent nodes under mode/slice/barriers. */
  function edgeMinutes(a: NetworkNode, b: NetworkNode, mode: TravelMode, slice: TimeSliceId, barriers: readonly { from: LonLat; to: LonLat; kind: 'blocked' | 'delay'; delayMinutes?: number }[] | undefined): number {
    const km = distanceKm([a.lon, a.lat], [b.lon, b.lat])
    const base = (km / speeds[mode]) * 60 * slices[slice]
    if (barriers === undefined) return base
    let minutes = base
    for (const barrier of barriers) {
      if (barrierBlocks(barrier, a, b)) {
        if (barrier.kind === 'blocked') return Number.POSITIVE_INFINITY
        minutes += barrier.delayMinutes ?? 0
      }
    }
    return minutes
  }

  /** Bounded Dijkstra from the snapped origin; the expansion hook and signal land between expansions. */
  function expand(origin: NetworkNode, budgetMinutes: number, mode: TravelMode, slice: TimeSliceId, barriers: readonly { from: LonLat; to: LonLat; kind: 'blocked' | 'delay'; delayMinutes?: number }[] | undefined, signal: AbortSignal | undefined): Map<string, { minutes: number; node: NetworkNode }> {
    if (signal?.aborted) signal.throwIfAborted()
    if (speeds[mode] === undefined) {
      throw new AccessibilityError('METHOD_NOT_APPLICABLE', `the network does not price mode ${mode}`)
    }
    const distances = new Map<string, number>()
    const nodes = new Map<string, NetworkNode>()
    distances.set(origin.id, 0)
    nodes.set(origin.id, origin)
    const frontier = new MinHeap()
    frontier.push(origin.id, 0)
    while (frontier.size > 0) {
      config.beforeExpand?.()
      if (signal?.aborted) signal.throwIfAborted()
      const current = frontier.pop()
      if (current === undefined) break
      const currentMinutes = distances.get(current.id) ?? Infinity
      if (currentMinutes < current.priority) continue
      const currentNode = nodes.get(current.id)
      if (currentNode === undefined) continue
      const col = Number(currentNode.id.slice(2).split('-')[0])
      const row = Number(currentNode.id.split('-')[2])
      for (const [dCol, dRow] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nextCol = col + dCol
        const nextRow = row + dRow
        if (nextCol < 0 || nextCol >= lattice.cols || nextRow < 0 || nextRow >= lattice.rows) continue
        const next = lattice.nodes[lattice.indexOf(nextCol, nextRow)]
        if (next === undefined) continue
        const step = edgeMinutes(currentNode, next, mode, slice, barriers)
        if (!Number.isFinite(step)) continue
        const candidate = currentMinutes + step
        if (candidate > budgetMinutes) continue
        const known = distances.get(next.id)
        if (known !== undefined && known <= candidate) continue
        distances.set(next.id, candidate)
        nodes.set(next.id, next)
        frontier.push(next.id, candidate)
      }
    }
    const reached = new Map<string, { minutes: number; node: NetworkNode }>()
    for (const [id, minutes] of distances) {
      const node = nodes.get(id)
      if (node !== undefined) reached.set(id, { minutes, node })
    }
    return reached
  }

  const digest = sha256Hex(JSON.stringify({
    bbox: config.bbox,
    spacing: lattice.spacingDeg,
    speeds,
    slices,
  })).slice(0, 16)

  return {
    networkId: CONTROLLED_NETWORK_ID,
    networkRef: `${CONTROLLED_NETWORK_ID}-${digest}@1`,
    pricesMode(mode) {
      return speeds[mode] !== undefined && Number.isFinite(speeds[mode])
    },
    snapPoint(point) {
      return snapToLattice(lattice, point)
    },
    async serviceArea(origin, budgetMinutes, options) {
      const fault = faultFor('serviceArea')
      if (fault !== undefined) throw fault
      const snapped = snapToLattice(lattice, origin)
      const reached = expand(snapped.node, budgetMinutes, options.mode, options.slice, options.barriers, options.signal)
      return {
        origin,
        budgetMinutes,
        nodes: [...reached.values()].map(entry => ({ id: entry.node.id, lon: entry.node.lon, lat: entry.node.lat, minutes: entry.minutes })),
      }
    },
    async route(origin, destination, options) {
      const fault = faultFor('route')
      if (fault !== undefined) throw fault
      const start = snapToLattice(lattice, origin).node
      const goal = snapToLattice(lattice, destination).node
      // Route = service area expanded to the destination's cost; the path is
      // recovered by walking minutes downwards through stored predecessors.
      const reached = expand(start, Number.MAX_SAFE_INTEGER / 2, options.mode, options.slice, options.barriers, options.signal)
      const goalEntry = reached.get(goal.id)
      if (goalEntry === undefined) {
        throw new AccessibilityError('ACCESS_NOT_FOUND', 'no connected network path exists between the routed points')
      }
      // Reconstruct the path by decreasing minutes through the lattice.
      const path: string[] = [goal.id]
      let cursor: NetworkNode = goal
      let cursorMinutes = goalEntry.minutes
      const byId = new Map<string, { minutes: number; node: NetworkNode }>()
      for (const entry of reached.values()) byId.set(entry.node.id, entry)
      while (cursor.id !== start.id) {
        const col = Number(cursor.id.slice(2).split('-')[0])
        const row = Number(cursor.id.split('-')[2])
        let stepped = false
        for (const [dCol, dRow] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const prevCol = col + dCol
          const prevRow = row + dRow
          if (prevCol < 0 || prevCol >= lattice.cols || prevRow < 0 || prevRow >= lattice.rows) continue
          const prev = lattice.nodes[lattice.indexOf(prevCol, prevRow)]
          if (prev === undefined) continue
          const prevEntry = byId.get(prev.id)
          if (prevEntry === undefined || prevEntry.minutes >= cursorMinutes) continue
          const step = edgeMinutes(prevEntry.node, cursor, options.mode, options.slice, options.barriers)
          if (Math.abs(prevEntry.minutes + step - cursorMinutes) < 1e-9) {
            path.unshift(prev.id)
            cursor = prev
            cursorMinutes = prevEntry.minutes
            stepped = true
            break
          }
        }
        if (!stepped) throw new AccessibilityError('ACCESS_STATE', 'route path reconstruction failed')
      }
      return {
        minutes: goalEntry.minutes,
        distanceKm: distanceKm(origin, destination),
        nodes: path,
      }
    },
    async readPois(bbox, options) {
      const fault = faultFor('pois')
      if (fault !== undefined) throw fault
      options.signal?.throwIfAborted()
      return poiPageFor(bbox, options.page, options.pageSize)
    },
  }
}

/**
 * Collect the full paginated POI directory of one bbox. A provider fault or
 * an abort stops the collection and reports `partial` coverage with the items
 * gathered so far — a partial read is never reshaped into a complete one.
 * @param provider - the network provider to read from.
 * @param bbox - the retrieval bbox.
 * @param options - page size, page cap, and cancellation signal.
 * @returns the collection with its coverage state.
 */
export async function collectPois(
  provider: NetworkProvider,
  bbox: ExtentBox,
  options: { readonly pageSize: number; readonly maxPages?: number; readonly signal?: AbortSignal },
): Promise<PoiCollection> {
  const items: { id: string; coordinates: LonLat }[] = []
  let page = 0
  let total = 0
  let hasMore = true
  while (hasMore) {
    if (options.maxPages !== undefined && page >= options.maxPages) {
      // A page-cap stop is a caller budget, not a provider fault: partial
      // coverage without an interruption code.
      return { items, pages: page, total, coverage: 'partial' }
    }
    try {
      const result = await provider.readPois(bbox, {
        page,
        pageSize: options.pageSize,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      items.push(...result.items)
      total = result.total
      hasMore = result.hasMore
      page += 1
    } catch (error: unknown) {
      if (error instanceof AccessibilityError && error.code === 'RATE_LIMITED') {
        return { items, pages: page, total, coverage: 'partial', interruptedBy: 'RATE_LIMITED' }
      }
      if (error instanceof AccessibilityError && error.code === 'PERMISSION_DENIED') {
        return { items, pages: page, total, coverage: 'partial', interruptedBy: 'PERMISSION_DENIED' }
      }
      if (error instanceof AccessibilityError && error.code === 'TEMPORARILY_UNAVAILABLE') {
        return { items, pages: page, total, coverage: 'partial', interruptedBy: 'TEMPORARILY_UNAVAILABLE' }
      }
      throw error
    }
  }
  return { items, pages: page, total, coverage: total === 0 ? 'empty' : 'complete' }
}
