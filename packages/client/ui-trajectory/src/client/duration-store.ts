import {
  createBrowserStorage, createSnapshotStore, type BrowserStorage, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'

/**
 * Create the browser-wide trajectory duration preference source.
 * @param storage - Instance adapter; omission preserves stock keys.
 * @returns a persisted source shared by every session view in one plugin lifecycle.
 */
export function createTrajectoryDurationStore(storage: BrowserStorage = createBrowserStorage()): SnapshotStore<boolean> {
  return createSnapshotStore(false, {
    persist: { name: 'dsh.trajectory.duration', storage },
  })
}
