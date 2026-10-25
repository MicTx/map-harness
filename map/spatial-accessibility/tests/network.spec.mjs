/**
 * Controlled network/LBS provider gates: the route and service-area network
 * semantics over the deterministic lattice (mode/slice pricing, barriers),
 * the paginated POI directory, the fault ladder (rate limit, permission,
 * unavailable), and cancellation that lands at real provider checkpoints
 * instead of a Promise timeout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AccessibilityError,
  CONTROLLED_NETWORK_ID,
  collectPois,
  createControlledNetworkProvider,
} from '../src/index.ts'

const BBOX = [116.3, 39.9, 116.36, 39.94]

/** A clean 0.06°×0.04° lattice at 0.01° spacing (7×5 nodes). */
function provider(overrides = {}) {
  return createControlledNetworkProvider({ bbox: BBOX, ...overrides })
}

test('the provider serves a fixed network identity and refuses nothing at construction', () => {
  const network = provider()
  assert.equal(network.networkId, CONTROLLED_NETWORK_ID)
  assert.match(network.networkRef, /^controlled-lattice-[0-9a-f]{16}@1$/)
  // Same extent and spacing build the same network version: the digest is deterministic.
  assert.equal(provider().networkRef, network.networkRef)
  assert.notEqual(provider({ spacingDeg: 0.02 }).networkRef, network.networkRef)
})

test('routing prices the same trip by mode and time slice', async () => {
  const network = provider()
  const origin = [116.305, 39.905]
  const destination = [116.355, 39.935]
  const walk = await network.route(origin, destination, { mode: 'walk', slice: 'midday' })
  const drive = await network.route(origin, destination, { mode: 'drive', slice: 'midday' })
  const night = await network.route(origin, destination, { mode: 'walk', slice: 'night' })
  const peak = await network.route(origin, destination, { mode: 'walk', slice: 'morning-peak' })
  assert.ok(walk.minutes > drive.minutes, 'walking the same trip must cost more minutes than driving')
  assert.ok(night.minutes < walk.minutes, 'night walking is faster than midday at the default factors')
  assert.ok(peak.minutes > walk.minutes, 'the morning peak slows walking further')
  assert.ok(walk.nodes.length >= 2, 'the routed path carries at least its two endpoints')
})

test('a blocked barrier severs the route; a delay barrier adds minutes', async () => {
  const network = provider({ spacingDeg: 0.02 })
  const origin = [116.305, 39.905]
  const destination = [116.355, 39.905]
  const clean = await network.route(origin, destination, { mode: 'walk', slice: 'midday' })
  // A vertical wall across the middle of the lattice.
  const wall = { from: [116.33, 39.9] , to: [116.33, 39.94], kind: 'blocked' }
  await assert.rejects(
    () => network.route(origin, destination, { mode: 'walk', slice: 'midday', barriers: [wall] }),
    (error) => error instanceof AccessibilityError && error.code === 'ACCESS_NOT_FOUND',
    'a full wall must disconnect origin from destination',
  )
  const slow = { from: [116.33, 39.9], to: [116.33, 39.94], kind: 'delay', delayMinutes: 30 }
  const delayed = await network.route(origin, destination, { mode: 'walk', slice: 'midday', barriers: [slow] })
  assert.ok(delayed.minutes > clean.minutes, 'a crossing delay must add minutes')
})

test('service areas shrink under a smaller budget and under peak pricing', async () => {
  const network = provider()
  const origin = [116.33, 39.92]
  const small = await network.serviceArea(origin, 2, { mode: 'walk', slice: 'midday' })
  const large = await network.serviceArea(origin, 30, { mode: 'walk', slice: 'midday' })
  assert.ok(small.nodes.length < large.nodes.length, 'a larger budget must reach more nodes')
  assert.ok(large.nodes.every(node => node.minutes <= 30))
  // Monotone pricing: every midday node at T minutes has its peak counterpart at ≥ T minutes.
  const peak = await network.serviceArea(origin, 30, { mode: 'walk', slice: 'morning-peak' })
  const middayById = new Map(small.nodes.concat(large.nodes).map(node => [node.id, node.minutes]))
  const peakById = new Map(peak.nodes.map(node => [node.id, node.minutes]))
  for (const [id, minutes] of peakById) {
    const midday = middayById.get(id)
    if (midday !== undefined) assert.ok(minutes >= midday, `peak minutes for ${id} must not undercut midday`)
  }
})

test('POI reads paginate to completion and report empty distinctly', async () => {
  const network = provider()
  const full = await collectPois(network, BBOX, { pageSize: 7 })
  assert.equal(full.coverage, 'complete')
  assert.equal(full.items.length, full.total)
  assert.ok(full.pages >= 2, 'the fixture bbox paginates over more than one page')
  const emptyBbox = [116.3, 39.9, 116.3001, 39.9001]
  const empty = await collectPois(network, emptyBbox, { pageSize: 7 })
  assert.equal(empty.coverage, 'empty')
  assert.equal(empty.total, 0)
})

test('a mid-pagination rate limit reports partial coverage, never a complete read', async () => {
  // The 2nd pois call fails with a rate limit: page 0 succeeds, page 1 throws.
  const network = provider({ faults: [{ op: 'pois', nth: 2, code: 'RATE_LIMITED', retryAfterSeconds: 5 }] })
  const partial = await collectPois(network, BBOX, { pageSize: 7 })
  assert.equal(partial.coverage, 'partial')
  assert.equal(partial.interruptedBy, 'RATE_LIMITED')
  assert.ok(partial.items.length < partial.total, 'a partial read must not pretend to be the full directory')
  assert.ok(partial.pages < await fullPaginationPages(BBOX), 'the collection stopped before the final page')
})

/** Full page count of one bbox at page size 7 on a clean provider. */
async function fullPaginationPages(bbox) {
  let page = 0
  for (;;) {
    const result = await provider().readPois(bbox, { page, pageSize: 7 })
    if (!result.hasMore) return page + 1
    page += 1
  }
}

test('permission denied and unavailable faults surface with their own codes', async () => {
  const forbidden = provider({ faults: [{ op: 'serviceArea', nth: 1, code: 'PERMISSION_DENIED' }] })
  await assert.rejects(
    () => forbidden.serviceArea([116.33, 39.92], 10, { mode: 'walk', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'PERMISSION_DENIED',
  )
  const down = provider({ faults: [{ op: 'route', nth: 1, code: 'TEMPORARILY_UNAVAILABLE' }] })
  await assert.rejects(
    () => down.route([116.305, 39.905], [116.355, 39.935], { mode: 'walk', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'TEMPORARILY_UNAVAILABLE',
  )
})

test('a repeated rate limit marks every later collection partial', async () => {
  const network = provider({ faults: [{ op: 'pois', nth: 2, repeat: true, code: 'RATE_LIMITED' }] })
  for (let attempt = 0; attempt < 3; attempt++) {
    const partial = await collectPois(network, BBOX, { pageSize: 7 })
    assert.equal(partial.coverage, 'partial', `attempt ${attempt} must stop at the fault`)
    assert.equal(partial.interruptedBy, 'RATE_LIMITED')
  }
})

test('cancellation lands inside the provider expansion, not after the work finished', async () => {
  // The expansion hook aborts the signal deterministically at the second
  // expansion; the provider checkpoint must stop the search there instead of
  // finishing the whole lattice.
  let expansions = 0
  const controller = new AbortController()
  const network = provider({
    bbox: [116.0, 39.6, 117.6, 40.8],
    spacingDeg: 0.008,
    beforeExpand: () => {
      expansions += 1
      if (expansions === 2) controller.abort()
    },
  })
  await assert.rejects(
    () => network.serviceArea([116.8, 40.2], 120, { mode: 'walk', slice: 'midday', signal: controller.signal }),
    (error) => error instanceof Error && error.name === 'AbortError',
    'the abort must surface as an AbortError from the provider checkpoint',
  )
  assert.ok(expansions < 100, `the expansion stopped at the checkpoint (after ${expansions} expansions), not after the full lattice`)
})

test('a mode the network does not price is method_not_applicable', async () => {
  const driveOnly = provider({ speedKmhPerMode: { walk: undefined } })
  await assert.rejects(
    () => driveOnly.serviceArea([116.33, 39.92], 10, { mode: 'walk', slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'METHOD_NOT_APPLICABLE',
    'a walk target without a priced walk network must fail loud, not fall back to a buffer',
  )
})
