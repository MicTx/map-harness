import {
  createBrowserStorage, createSnapshotStore, type BrowserStorage, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'

/**
 * Create the browser-wide default for expanded JSON strings.
 * @param storage - Instance adapter; omission preserves stock keys.
 * @returns A persisted preference sampled only when a string is expanded.
 */
export function createTrajectoryStringWrappingStore(storage: BrowserStorage = createBrowserStorage()): SnapshotStore<boolean> {
  return createSnapshotStore(false, {
    persist: { name: 'dsh.trajectory.jsonStringWrapping', storage },
  })
}
