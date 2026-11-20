/**
 * Shared provider-contract assertions: the vendor-agnostic statement of the
 * NetworkProvider contract that the controlled lattice and every vendor
 * adapter must satisfy within their mappable capability face. Each vendor
 * unit suite runs these against a fixture-transport adapter and against the
 * controlled provider (double-run equivalence), and the key-activated vendor
 * gate runs the same four ledger classes (cross-region, pagination, cancel,
 * invalid key) against the real vendor API when its credential is present.
 *
 * Not a spec file itself (no `.spec.mjs` suffix): the package test glob picks
 * up only the suites that compose these helpers.
 */
import assert from 'node:assert/strict'
import { AccessibilityError, collectPois } from '../src/index.ts'

/**
 * Identity contract: stable network id, ref pattern, and ref determinism.
 * @param provider - the provider under test.
 * @param makeProvider - factory for additional instances of the same shape.
 * @param networkId - the expected network id.
 * @param refPattern - the expected `networkRef` pattern.
 */
export async function assertIdentityContract(provider, makeProvider, { networkId, refPattern }) {
  assert.equal(provider.networkId, networkId)
  assert.match(provider.networkRef, refPattern)
  assert.equal(makeProvider().networkRef, provider.networkRef, 'the same shape must rebuild the same network version')
}

/**
 * Route pricing contract: walking the same trip costs more minutes than
 * driving, and the path carries at least its two endpoints.
 * @param provider - the provider under test (must price walk and drive).
 * @param origin - WGS84 origin inside the served extent.
 * @param destination - WGS84 destination inside the served extent.
 */
export async function assertRouteModePricing(provider, origin, destination) {
  const walk = await provider.route(origin, destination, { mode: 'walk', slice: 'midday' })
  const drive = await provider.route(origin, destination, { mode: 'drive', slice: 'midday' })
  assert.ok(walk.minutes > drive.minutes, `walking (${walk.minutes} min) must cost more than driving (${drive.minutes} min)`)
  assert.ok(walk.distanceKm > 0 && drive.distanceKm > 0, 'both routes carry a positive network distance')
  assert.ok(walk.nodes.length >= 2 && drive.nodes.length >= 2, 'the routed path carries at least its two endpoints')
}

/**
 * Service-area budget contract: a larger budget reaches a superset of the
 * smaller budget's nodes, and no node exceeds its budget in minutes.
 * @param provider - the provider under test.
 * @param origin - WGS84 origin inside the served extent.
 * @param smallMinutes - the smaller budget.
 * @param largeMinutes - the larger budget.
 */
export async function assertServiceAreaBudgetContract(provider, origin, smallMinutes, largeMinutes) {
  const small = await provider.serviceArea(origin, smallMinutes, { mode: 'walk', slice: 'midday' })
  const large = await provider.serviceArea(origin, largeMinutes, { mode: 'walk', slice: 'midday' })
  assert.ok(small.nodes.length < large.nodes.length, 'a larger budget must reach more nodes')
  assert.ok(large.nodes.every(node => node.minutes <= largeMinutes), 'no node may exceed the budget minutes')
  const smallIds = new Set(small.nodes.map(node => node.id))
  for (const node of large.nodes) {
    if (smallIds.has(node.id)) assert.ok(node.minutes <= smallMinutes, `node ${node.id} was inside the smaller budget`)
  }
}

/**
 * Pagination contract: a directory with rows paginates to completion with
 * every row accounted for, an empty extent reports empty distinctly, and a
 * page beyond the total carries no items and no more-rows flag.
 * @param provider - the provider under test.
 * @param bbox - an extent known to carry rows.
 * @param emptyBbox - an extent known to carry none.
 * @param pageSize - page size at or below the provider's page-size limit.
 */
export async function assertPaginationContract(provider, bbox, emptyBbox, pageSize) {
  const full = await collectPois(provider, bbox, { pageSize })
  assert.equal(full.coverage, 'complete')
  assert.equal(full.items.length, full.total, 'a complete read must account for every row')
  assert.ok(full.pages >= 1)
  const empty = await collectPois(provider, emptyBbox, { pageSize })
  assert.equal(empty.coverage, 'empty')
  assert.equal(empty.total, 0)
  const beyond = await provider.readPois(bbox, { page: Math.ceil(full.total / pageSize) + 3, pageSize })
  assert.equal(beyond.items.length, 0, 'a page beyond the total must not fabricate items')
  assert.equal(beyond.hasMore, false, 'a page beyond the total must end pagination')
}

/**
 * Partial-read contract: a mid-pagination rate limit reports partial coverage
 * with the interruption code, never a complete read.
 * @param makeProvider - factory whose second pois call fails RATE_LIMITED.
 * @param bbox - an extent that paginates over more than one page.
 * @param pageSize - page size splitting the directory into multiple pages.
 */
export async function assertPartialReadNeverComplete(makeProvider, bbox, pageSize) {
  const partial = await collectPois(makeProvider(), bbox, { pageSize })
  assert.equal(partial.coverage, 'partial')
  assert.equal(partial.interruptedBy, 'RATE_LIMITED')
  assert.ok(partial.items.length < partial.total, 'a partial read must not pretend to be the full directory')
}

/**
 * Cancellation contract: an aborted signal surfaces as an AbortError from a
 * real provider checkpoint, before any further work.
 * @param callWithAbortedSignal - runs one provider call with a pre-aborted signal.
 */
export async function assertCancellationContract(callWithAbortedSignal) {
  await assert.rejects(
    callWithAbortedSignal,
    (error) => error instanceof Error && error.name === 'AbortError',
    'the abort must surface as an AbortError from the provider checkpoint',
  )
}

/**
 * Unreachable/cross-region contract: a network that cannot connect or serve
 * the requested pair fails loud with a code from the provider's declared
 * mapping instead of fabricating a route.
 * @param callUnreachable - runs one route call whose pair has no connected path.
 * @param acceptedCodes - the provider's declared loud codes for this class
 *   (the controlled provider: `ACCESS_NOT_FOUND`; the Amap mapping set adds
 *   the vendor's no-abroad-permission and out-of-range verdicts).
 */
export async function assertUnreachableLoud(callUnreachable, acceptedCodes = ['ACCESS_NOT_FOUND']) {
  await assert.rejects(
    callUnreachable,
    (error) => error instanceof AccessibilityError && acceptedCodes.includes(error.code),
    `an unconnectable pair must fail loud with one of ${acceptedCodes.join(', ')}, never fabricate`,
  )
}

/**
 * Denied contract: a credential the vendor refuses surfaces as
 * `PERMISSION_DENIED` with no key material in the text.
 * @param callDenied - runs one provider call the credential cannot serve.
 * @param secret - the key value that must never appear in the failure text.
 */
export async function assertDeniedLoud(callDenied, secret) {
  await assert.rejects(
    callDenied,
    (error) => {
      assert.ok(error instanceof AccessibilityError && error.code === 'PERMISSION_DENIED', `expected PERMISSION_DENIED, got ${error?.code}`)
      assert.equal(error.message.includes(secret), false, 'the failure text must never carry the key value')
      return true
    },
    'a refused credential must fail PERMISSION_DENIED',
  )
}

/**
 * Unpriced-mode contract: a mode the network does not price is
 * `METHOD_NOT_APPLICABLE` — loud, never a geometry fallback.
 * @param provider - the provider under test.
 * @param mode - the unpriced mode.
 * @param origin - WGS84 origin inside the served extent.
 */
export async function assertUnpricedModeContract(provider, mode, origin) {
  assert.equal(provider.pricesMode(mode), false)
  await assert.rejects(
    () => provider.serviceArea(origin, 10, { mode, slice: 'midday' }),
    (error) => error instanceof AccessibilityError && error.code === 'METHOD_NOT_APPLICABLE',
    'an unpriced mode must fail METHOD_NOT_APPLICABLE, not fall back to a buffer',
  )
}
