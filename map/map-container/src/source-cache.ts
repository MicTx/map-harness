/**
 * Source-local size-bounded in-memory LRU storage. The caller owns cache keys,
 * expiry, policy, validation, epochs, digests, and the immutability of values.
 * @module @map-harness/map-container/source-cache
 */

/** Opaque-value cache operations with current entry and byte accounting. */
export interface SourceCache<Value> {
  /** Return and promote a hit; return `undefined` for a miss. */
  get(key: string): Value | undefined
  /** Insert or replace a value with its caller-measured content byte count. */
  set(key: string, value: Value, valueBytes: number): void
  /** Remove one entry if present. */
  delete(key: string): void
  /** Drop every entry and reset accounting. */
  clear(): void
  /** Return a fresh accounting record. */
  stats(): { readonly entries: number; readonly bytes: number }
}

interface CacheEntry<Value> {
  readonly value: Value
  readonly bytes: number
}

/**
 * Create one closure-owned LRU bounded by entry count and key-plus-value bytes.
 * @param maxEntries - validated positive entry limit.
 * @param maxBytes - validated positive byte limit.
 * @returns an isolated cache with no shared global state.
 */
export function createSourceCache<Value>(maxEntries: number, maxBytes: number): SourceCache<Value> {
  const entries = new Map<string, CacheEntry<Value>>()
  let totalBytes = 0

  const remove = (key: string): void => {
    const entry = entries.get(key)
    if (entry === undefined) return
    totalBytes -= entry.bytes
    entries.delete(key)
  }

  return {
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return undefined
      entries.delete(key)
      entries.set(key, entry)
      return entry.value
    },
    set(key, value, valueBytes) {
      remove(key)
      const bytes = Buffer.byteLength(key, 'utf8') + valueBytes
      if (bytes > maxBytes) return
      while (entries.size + 1 > maxEntries || totalBytes + bytes > maxBytes) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        remove(oldest)
      }
      entries.set(key, { value, bytes })
      totalBytes += bytes
    },
    delete(key) {
      remove(key)
    },
    clear() {
      entries.clear()
      totalBytes = 0
    },
    stats() {
      return { entries: entries.size, bytes: totalBytes }
    },
  }
}
