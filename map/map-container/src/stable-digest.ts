/**
 * Stable 32-bit content digest shared by protocol modules. Canonical JSON
 * keeps the identity independent of object insertion order at the call site.
 * @module @map-harness/map-container/stable-digest
 */

/**
 * Digest one JSON value with FNV-1a over its canonical serialization.
 * @param value - the JSON value to digest.
 * @returns a zero-padded 32-bit hex digest.
 */
export function stableDigestOf(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null'
  let hash = 0x811c9dc5
  for (let at = 0; at < json.length; at += 1) {
    hash ^= json.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
