/**
 * Header-only native image admission; SDK pixel decoding is verified separately.
 * @module @map-harness/map-container/source-image
 */
import sharp, { type Metadata } from 'sharp'
import { SourceCatalogError } from './source-error.ts'
import { MAX_SOURCE_IMAGE_PIXELS, type SourceImageMime } from './source-render-protocol.ts'
import type { SourceImagePlan } from './source-resource.ts'

/**
 * Check MIME, native dimensions and orientation without re-encoding provider bytes.
 * A valid header does not establish complete pixel decoding or rendered success.
 * @param body - bounded provider image bytes from the controlled transport.
 * @param contentType - transport-admitted media type.
 * @param plan - exact dimensions already admitted by native resource compilation.
 * @returns actual allowed media type; invalid headers/geometry throw safe SOURCE_UNAVAILABLE.
 */
export async function admitSourceImage(body: Buffer, contentType: string | null, plan: SourceImagePlan): Promise<SourceImageMime> {
  let metadata: Metadata
  try {
    metadata = await sharp(body, { limitInputPixels: MAX_SOURCE_IMAGE_PIXELS, failOn: 'warning' }).metadata()
  } catch (error) {
    // Only the library call is contained; its diagnostics may include private data.
    if (error instanceof Error) throw new SourceCatalogError('SOURCE_UNAVAILABLE')
    throw error
  }
  const mime = metadata.format === 'png' ? 'image/png' : metadata.format === 'jpeg' ? 'image/jpeg' : null
  if (mime === null || contentType !== mime
    || metadata.width !== plan.width || metadata.height !== plan.height
    || (metadata.pages !== undefined && metadata.pages !== 1)
    || (metadata.orientation !== undefined && metadata.orientation !== 1)) {
    throw new SourceCatalogError('SOURCE_UNAVAILABLE')
  }
  return mime
}
