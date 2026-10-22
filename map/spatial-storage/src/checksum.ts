/**
 * Digest helpers for the storage layer: sha256 over bytes and over bounded
 * store files. Store entries are admitted under upstream size bounds, so the
 * synchronous whole-file read is the honest cost model for P0's local
 * single-writer store.
 *
 * @module @map-harness/spatial-storage/checksum
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * Compute the sha256 hex digest of one byte sequence.
 * @param data - the bytes to digest.
 * @returns the lowercase hex digest.
 */
export function sha256Bytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Compute the sha256 hex digest of one file's full content.
 * @param path - the file to read; callers own the size bound (store entries
 *   are admitted bounded bytes, and database snapshots are bounded likewise).
 * @returns the lowercase hex digest.
 */
export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path))
}
