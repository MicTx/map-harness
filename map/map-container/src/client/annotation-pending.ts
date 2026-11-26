import type { AnnotationUserChange } from '../protocol.ts'

/** One reusable id only while the same payload retries at the same revision. */
export interface PendingAnnotationOperation {
  readonly operationId: string
  readonly revision: number
  readonly change: AnnotationUserChange
}

/**
 * Resolve the operation id for one annotation intent.
 * @param pending - the previous ambiguous submission, when any.
 * @param revision - the browser's current accepted revision.
 * @param change - the complete annotation change being submitted.
 * @param nextOperationId - source of newly allocated ids.
 * @returns the id and retained pending record.
 */
export function annotationOperationOf(
  pending: PendingAnnotationOperation | null,
  revision: number,
  change: AnnotationUserChange,
  nextOperationId: () => string,
): PendingAnnotationOperation {
  if (pending !== null && pending.revision === revision && JSON.stringify(pending.change) === JSON.stringify(change)) {
    return pending
  }
  return { operationId: nextOperationId(), revision, change }
}
