/** Occurrence-local render observations, persisted independently of session acceptance. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { z } from 'zod'

const failureSchema = z.object({
  layerId: z.string().nullable(),
  code: z.enum(['VIEW_FAILED', 'LAYER_FAILED', 'AOI_FAILED']),
}).readonly()

const receiptSchema = z.object({
  sessionId: z.string(),
  occurrenceKey: z.string(),
  status: z.enum(['unavailable', 'applied', 'rendered', 'failed']),
  revision: z.number().int().nonnegative().nullable(),
  renderedRevision: z.number().int().nonnegative().nullable(),
  generation: z.number().int().nonnegative(),
  viewId: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  layerVersions: z.array(z.object({ id: z.string(), token: z.string() }).readonly()).readonly(),
  failedLayers: z.array(failureSchema).readonly(),
  reason: z.enum(['not-mounted', 'no-projection', 'disposed']).nullable(),
  at: z.string().datetime(),
}).refine(value => value.status === 'rendered'
  ? value.revision !== null && value.renderedRevision === value.revision && value.viewId !== null && value.failedLayers.length === 0
  : value.renderedRevision === null).readonly()

/** Latest observation of one revision on one concrete view; historical records do not attest a new view. */
export type MapRenderReceipt = z.infer<typeof receiptSchema>

/** A fixed render failure code and the affected layer, or null for a view/AOI failure. */
export type MapRenderFailure = z.infer<typeof failureSchema>

/**
 * Create the existing client-store carrier for one occurrence's last observation.
 * Invalid stored JSON values are discarded; absent or failing localStorage leaves memory working.
 * @param sessionId - owning session identity.
 * @param occurrenceKey - independent UI occurrence identity.
 * @returns typed read/write access to the last persisted observation.
 */
export function createRenderReceiptStore(sessionId: string, occurrenceKey: string): {
  get(): MapRenderReceipt | null
  set(receipt: MapRenderReceipt): void
} {
  const store = createSnapshotStore<unknown>(null, {
    persist: { name: `map-render-receipt:${JSON.stringify([sessionId, occurrenceKey])}` },
  })
  const parsed = receiptSchema.safeParse(store.getSnapshot())
  let last = parsed.success && parsed.data.sessionId === sessionId && parsed.data.occurrenceKey === occurrenceKey
    ? parsed.data : null
  return {
    get: () => last,
    set(receipt) {
      last = receiptSchema.parse(receipt)
      store.set(last)
    },
  }
}
