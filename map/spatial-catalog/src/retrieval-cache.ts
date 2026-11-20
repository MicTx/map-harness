/**
 * The bounded authorization-scoped retrieval cache over resolved resource
 * versions. Keys pair the tenant and authorization domain with the exact ref
 * and every entry pins the grant version it was filled under, so a
 * revocation or tombstone (which bumps the grant version) invalidates the
 * cached answer: a cached resolution can never outlive the grant it was
 * admitted under, and two tenants or domains never share an entry. Bounds
 * and discipline follow the catalog's other fixed budgets — a
 * protocol-sized constant, not a tunable.
 *
 * @module @map-harness/spatial-catalog/retrieval-cache
 */
import { TENANT_DEFAULT } from './governance.ts'
import type { ResolvedResource } from './types.ts'

/** Maximum entries one cache holds; insertion order is the eviction order. */
export const RETRIEVAL_CACHE_CAPACITY = 32

/** One cached resolution with the grant version it was admitted under. */
export interface RetrievalCacheEntry {
  readonly resolved: ResolvedResource
  readonly grantVersion: number
}

/** Hit/miss counters one cache reports for diagnostics. */
export interface RetrievalCacheStats {
  readonly entries: number
  readonly hits: number
  readonly misses: number
}

/** The authorization-scoped resolution cache one open store owns. */
export class RetrievalCache {
  private readonly entries = new Map<string, RetrievalCacheEntry>()
  private hits = 0
  private misses = 0

  /**
   * Read the cached resolution for one tenant/domain/ref pair when its
   * grant version still matches; a version bump reads as a miss.
   * @param tenant - the reader's tenant; defaults to the single-tenant
   *   default so `@1` call shapes keep their exact behavior.
   * @param domain - the reader's authorization domain.
   * @param ref - the exact resource ref.
   * @param grantVersion - the grant version the authorization check admitted.
   * @returns the cached resolution, or `undefined`.
   */
  get(
    tenant: string,
    domain: string,
    ref: string,
    grantVersion: number,
    semanticRef?: string,
  ): ResolvedResource | undefined {
    const effectiveTenant = tenant ?? TENANT_DEFAULT
    const key = semanticRef === undefined ? undefined : cacheKey(effectiveTenant, domain, ref, semanticRef)
    const entryRecord = key === undefined
      // A bound resolution must supply its semantic identity; the legacy
      // un-keyed call is safe only for resources without a binding.
      ? [...this.entries.entries()].find(([candidate, value]) => candidate === `${effectiveTenant}\u0000${domain}\u0000${ref}\u0000` && value.grantVersion === grantVersion)
      : (() => {
          const value = this.entries.get(key)
          return value === undefined ? undefined : [key, value] as const
        })()
    const entry = entryRecord?.[1]
    if (entry === undefined || entry.grantVersion !== grantVersion) {
      this.misses += 1
      return undefined
    }
    this.hits += 1
    // Refresh insertion order so a hot entry is not evicted while cold ones age.
    const actualKey = entryRecord?.[0]
    if (actualKey !== undefined) {
      this.entries.delete(actualKey)
      this.entries.set(actualKey, entry)
    }
    return entry.resolved
  }

  /**
   * Store one resolution under its tenant/domain/ref pair, evicting the
   * oldest entry when at capacity.
   * @param tenant - the reader's tenant; defaults to the single-tenant
   *   default so `@1` call shapes keep their exact behavior.
   * @param domain - the reader's authorization domain.
   * @param ref - the exact resource ref.
   * @param grantVersion - the grant version the resolution was admitted under.
   * @param resolved - the frozen resolution.
   */
  put(
    tenant: string,
    domain: string,
    ref: string,
    grantVersion: number,
    resolved: ResolvedResource,
    identity?: string,
  ): void {
    const effectiveTenant = tenant ?? TENANT_DEFAULT
    const semanticRef = identity ?? (resolved.bundle.semanticDefinition === null
      ? undefined
      : `def-${resolved.bundle.semanticDefinition.definitionId}@v${resolved.bundle.semanticDefinition.version}`)
    const key = cacheKey(effectiveTenant, domain, ref, semanticRef)
    this.entries.delete(key)
    while (this.entries.size >= RETRIEVAL_CACHE_CAPACITY) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    this.entries.set(key, { resolved, grantVersion })
  }

  /**
   * Drop one tenant/domain/ref pair (a governance transition invalidates the
   * exact entry immediately, in addition to the grant-version guard).
   * @param tenant - the reader's tenant; defaults to the single-tenant
   *   default so `@1` call shapes keep their exact behavior.
   * @param domain - the authorization domain.
   * @param ref - the exact resource ref.
   */
  invalidate(tenant: string, domain: string, ref: string): void {
    const prefix = `${tenant ?? TENANT_DEFAULT}\u0000${domain}\u0000${ref}\u0000`
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key)
  }

  /**
   * Drop every entry for one ref across tenants, domains, and semantic
   * identities — the recall path (a recall does not bump the grant version,
   * so the version guard alone would let a cached resolution outlive it).
   * @param ref - the exact resource ref.
   */
  invalidateRef(ref: string): void {
    for (const key of this.entries.keys()) {
      const parts = key.split('\u0000')
      if (parts[2] === ref) this.entries.delete(key)
    }
  }

  /** Hit/miss counters and the live entry count. */
  stats(): RetrievalCacheStats {
    return { entries: this.entries.size, hits: this.hits, misses: this.misses }
  }
}

/** The cache key pairs the tenant, domain, and the ref — never the ref alone. */
function cacheKey(tenant: string, domain: string, ref: string, semanticRef?: string): string {
  return `${tenant}\u0000${domain}\u0000${ref}\u0000${semanticRef ?? ''}`
}
