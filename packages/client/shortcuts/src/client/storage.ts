/** Explicit browser and Desktop preference adapters; Desktop never falls back to browser storage. */
import { ShortcutPersistence } from '../protocol.ts'
import { createBrowserStorage, type BrowserStorage } from '@deepseek-ai/dsh-client-store'
import type { DesktopShortcutsApi, ShortcutConfigSnapshot, ShortcutDefinition, ShortcutPlatform } from '../protocol.ts'

/** Browser-profile and origin-local preference key. */
export const SHORTCUT_STORAGE_KEY = 'dsh.keybindings.v1'

/**
 * Connect localStorage and same-origin external updates to the shared transaction coordinator.
 * @param window - owning browser window.
 * @param platform - visiting device platform.
 * @param publish - accepts complete configuration snapshots.
 * @param storage - Instance adapter; omission uses the owning window's stock keys.
 * @returns adapter and lifecycle disposal.
 */
export function webShortcutStorage(window: Window, platform: ShortcutPlatform,
  publish: (snapshot: ShortcutConfigSnapshot) => void,
  storage: BrowserStorage = createBrowserStorage('', window)): DesktopShortcutsApi & { dispose(): void } {
  const persistence = new ShortcutPersistence({
    read: () => storage.getItem(SHORTCUT_STORAGE_KEY),
    write: (raw) => { storage.setItem(SHORTCUT_STORAGE_KEY, raw) },
  }, 'web', platform, true, publish)
  const unsubscribe = storage.subscribe((key) => {
    if (key === null || key === SHORTCUT_STORAGE_KEY) void persistence.readCurrent()
  })
  return {
    get: (definitions: readonly ShortcutDefinition[]) => { persistence.setDefinitions(definitions); return persistence.readCurrent() },
    edit: (edit, revision) => persistence.edit(edit, revision),
    subscribe: () => () => {}, recording: async () => {},
    dispose: () => { unsubscribe(); persistence.dispose() },
  }
}

/**
 * Read the origin-scoped preload capability; a missing bridge is an explicit configuration failure.
 * @param window - product window.
 * @returns the restricted Desktop API, or undefined while the preload is unavailable.
 */
export function desktopShortcutStorage(window: Window): DesktopShortcutsApi | undefined {
  return (window as Window & { dshDesktop?: { shortcuts?: DesktopShortcutsApi } }).dshDesktop?.shortcuts
}
