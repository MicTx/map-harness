/**
 * Shared image-evidence helpers for visual comparison and change candidates.
 * Only a persisted observation's attachment descriptor may be read back.
 * @module @map-harness/map-tools/visual-change-evidence
 */
import { createHash } from 'node:crypto'
import { AttachmentId, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { MapObservationRecord } from '@map-harness/map-container'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'

/** One exact stored PNG with its re-admitted bytes. */
export interface StoredObservationImage {
  readonly ref: ImageAttachmentRef
  readonly data: Uint8Array
}

/** Rebuild a durable attachment reference without accepting a model-supplied id. */
export function attachmentRefOf(observation: MapObservationRecord): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(observation.attachment.attachmentId),
    mediaType: 'image/png',
    bytes: observation.attachment.bytes,
    width: observation.attachment.width,
    height: observation.attachment.height,
    ...(observation.attachment.name === undefined ? {} : { name: observation.attachment.name }),
  }
}

/** Read one observation's PNG and prove it still matches the persisted digest. */
export async function readObservationImage(
  observation: MapObservationRecord,
  serviceName: string,
  attachments: Pick<AttachmentStore, 'readImage'> | undefined,
  signal: AbortSignal,
): Promise<StoredObservationImage> {
  if (attachments === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', `${serviceName} requires the session attachment store.`)
  let stored: StoredObservationImage
  try {
    stored = await attachments.readImage(attachmentRefOf(observation), signal) as StoredObservationImage
  } catch (error) {
    if (signal.aborted) throw new SpatialError('CANCELLED', `${serviceName} was cancelled before its source images were verified.`)
    throw new SpatialError('UNKNOWN_OBSERVATION', 'A cited observation image is missing or unreadable.', { cause: error })
  }
  const digest = createHash('sha256').update(stored.data).digest('hex')
  if (digest !== observation.attachment.sha256 || stored.data.byteLength !== observation.attachment.bytes
    || stored.ref.attachmentId !== observation.attachment.attachmentId) {
    throw new SpatialError('UNKNOWN_OBSERVATION', 'A cited observation image no longer matches its recorded digest.')
  }
  return stored
}

/** Resolve the session attachment store through the shared Cordis service helper. */
export function attachmentStoreOf(exec: Parameters<typeof serviceOf>[0]): Pick<AttachmentStore, 'readImage'> | undefined {
  return serviceOf<Pick<AttachmentStore, 'readImage'>>(exec, 'attachments')
}
