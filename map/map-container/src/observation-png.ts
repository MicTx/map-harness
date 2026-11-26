/**
 * Host-side PNG admission for map observations: strict base64/byte bounds,
 * then an actual pixel decode through the workspace's maintained sharp
 * (0.35.x) with a bounded `limitInputPixels`. A signature or header alone
 * never validates a capture — the decoded dimensions must also match the
 * capture's attested image size including the footer.
 * @module @map-harness/map-container/observation-png
 */
import { createHash } from 'node:crypto'
import sharp, { type Metadata } from 'sharp'
import type { MapObservationLimits } from './observation.ts'

/** The decoded-and-verified PNG facts. */
export interface ObservationPngVerdict {
  readonly ok: true
  readonly width: number
  readonly height: number
  /** Lowercase hex sha256 over the actual PNG bytes. */
  readonly sha256: string
}

/** Why one PNG was refused. */
export type ObservationPngRefusal = 'invalid' | 'oversized' | 'decode-failed' | 'dimension-mismatch'

/**
 * Strictly admit and decode one PNG.
 * @param png - the actual PNG bytes (base64 already decoded by the service).
 * @param limits - byte/pixel/dimension bounds.
 * @param expected - the capture-attested output size the decode must match, or `undefined` to skip the check.
 * @returns the verdict, or a refusal code.
 */
export async function admitObservationPng(
  png: Uint8Array,
  limits: Pick<MapObservationLimits, 'maxBytes' | 'maxPixels' | 'maxDimension'>,
  expected?: { width: number; height: number },
): Promise<ObservationPngVerdict | { readonly ok: false; readonly code: ObservationPngRefusal }> {
  if (png.length === 0 || png.length > limits.maxBytes) return { ok: false, code: 'oversized' }
  let metadata: Metadata
  try {
    // Metadata reads only the encoded header; use it to classify bounds
    // before the single full pixel decode enforces `limitInputPixels`.
    metadata = await sharp(Buffer.from(png)).metadata()
  } catch {
    return { ok: false, code: 'invalid' }
  }
  if (metadata.format !== 'png' || metadata.width === undefined || metadata.height === undefined) {
    return { ok: false, code: 'invalid' }
  }
  if (metadata.width > limits.maxDimension || metadata.height > limits.maxDimension
    || metadata.width * metadata.height > limits.maxPixels) {
    return { ok: false, code: 'oversized' }
  }
  // Force actual pixel decoding; a corrupt IDAT passes metadata but fails here.
  try {
    await sharp(Buffer.from(png), { limitInputPixels: limits.maxPixels }).raw().toBuffer({ resolveWithObject: true })
  } catch {
    return { ok: false, code: 'decode-failed' }
  }
  if (expected !== undefined && (metadata.width !== expected.width || metadata.height !== expected.height)) {
    return { ok: false, code: 'dimension-mismatch' }
  }
  return { ok: true, width: metadata.width, height: metadata.height, sha256: createHash('sha256').update(png).digest('hex') }
}
