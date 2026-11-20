/** Cancellable SDK loading for one session-bound map body. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MapContainerState } from '../registry.ts'
import type { MapOccurrence } from './face.ts'
import type { createMapOccurrence } from './occurrence.ts'

/** The component's captured Session and callbacks for one load attempt. */
export interface MapOccurrenceMount {
  readonly sessionId: SessionId
  readonly occurrenceKey: string
  readonly holder: HTMLDivElement
  /** @returns the latest projection of this Session, including updates during SDK loading. */
  readonly getState: () => MapContainerState | undefined
  /** @returns the lazy SDK module. */
  readonly load: () => Promise<{ createMapOccurrence: typeof createMapOccurrence }>
  readonly options?: Parameters<typeof createMapOccurrence>[3]
  /** @param occurrence - mounted instance, owned until the returned disposer runs. */
  readonly onReady: (occurrence: MapOccurrence) => void
  /** Report an SDK load or mount failure while the component remains mounted. */
  readonly onError: () => void
}

/**
 * Load and mount a Session's map; cancellation before import completion creates no instance.
 * @param input - captured identity and component-owned callbacks.
 * @returns an idempotent disposer, including partial initialization cleanup.
 */
export function mountMapOccurrence(input: MapOccurrenceMount): () => void {
  let cancelled = false
  let occurrence: MapOccurrence | undefined
  const release = (): void => {
    const owned = occurrence
    occurrence = undefined
    owned?.dispose()
  }
  void input.load().then(({ createMapOccurrence }) => {
    if (cancelled) return
    occurrence = createMapOccurrence(input.getState, input.sessionId, input.occurrenceKey, input.options)
    occurrence.mount(input.holder)
    input.onReady(occurrence)
  }).catch((_loadOrMountError: unknown) => {
    release()
    if (!cancelled) input.onError()
  })
  return () => {
    if (cancelled) return
    cancelled = true
    release()
  }
}
