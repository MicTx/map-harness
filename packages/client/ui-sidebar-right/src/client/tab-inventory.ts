/** Metadata inventory of saved and adopted layouts without mounting their content. */
import { createBrowserStorage, createSnapshotStore, type BrowserStorage, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import { readSidebarLayout, sidebarPersistence } from './persistence.ts'

/** One open occurrence; resource recovery belongs to its kind's provider. */
export interface SidebarRightOpenTab {
  readonly sessionId: SessionId
  readonly tabId: TabId
  readonly kind: string
  readonly contentId: string
}

/** Derived membership only; layout stores remain the persisted authority. */
export class SidebarTabInventory {
  private readonly sessions = new Map<SessionId, readonly SidebarRightOpenTab[]>()
  private readonly snapshot = createSnapshotStore<readonly SidebarRightOpenTab[]>([])
  /** Read-only metadata observable shared with content providers. */
  readonly source: ObservableSnapshot<readonly SidebarRightOpenTab[]> = this.snapshot

  /** @param storage - Instance adapter; omitted in standalone callers to preserve stock keys. */
  constructor(storage: BrowserStorage = createBrowserStorage()) {
    try {
      for (const key of storage.keys()) {
        if (!key.startsWith(`${sidebarPersistence}.`)) continue
        const sessionId = key.slice(sidebarPersistence.length + 1) as SessionId
        const saved = readSidebarLayout(sessionId, storage)
        if (saved !== undefined) this.sessions.set(sessionId, Object.values(saved.layout.tabs).map(tab => ({
          sessionId, tabId: tab.id, kind: tab.kind, contentId: tab.contentId,
        })))
      }
      this.publish()
    } catch (_storageUnavailable) { /* Adopted in-memory layouts still publish their open tabs. */ }
  }

  /**
   * Replace membership from the authoritative in-window store.
   * @param sessionId - adopted Session.
   * @param tabs - current committed records.
   */
  update(sessionId: SessionId, tabs: readonly TabRecord[]): void {
    this.sessions.set(sessionId, tabs.map(tab => ({ sessionId, tabId: tab.id, kind: tab.kind, contentId: tab.contentId })))
    this.publish()
  }

  /**
   * Forget a permanently cleared scope.
   * @param sessionId - removed Session scope.
   */
  remove(sessionId: SessionId): void { this.sessions.delete(sessionId); this.publish() }

  private publish(): void {
    const next = [...this.sessions.values()].flat()
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot.getSnapshot())) this.snapshot.set(next)
  }
}
