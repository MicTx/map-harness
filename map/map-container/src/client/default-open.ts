/** Session-owned map navigation and singleton tab reconciliation over the Sidebar's layout store. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MAP_TAB_KIND } from './definition.ts'

type Sidebar = Pick<Context['sidebarRight'], 'mounted' | 'openTabs' | 'tabsIn' | 'openTabIn' | 'closeIn' | 'focus' | 'isExpanded' | 'toggleExpanded'>

/** Navigation always names the owning Session; no action falls back to another on-screen Session. */
export interface MapSessionBinding {
  /** Sidebar membership notifications; the layout remains the only persisted tab inventory. */
  readonly tabs: Sidebar['openTabs']
  /**
   * Test whether this tab may mount the Session's only map renderer.
   * @param sessionId - owning Session.
   * @param tabId - candidate map tab.
   * @returns whether it is the first surviving map tab of that Session.
   */
  owns(sessionId: SessionId, tabId: TabId): boolean
  /**
   * Enable default opening for a nonblank Session after Sidebar adoption; saved tabs and manual closes are respected.
   * @param sessionId - Session whose header has mounted.
   */
  ensure(sessionId: SessionId): void
  /**
   * Reveal the existing map, or create it when absent.
   * @param sessionId - originating Session, never inferred from current focus.
   * @returns false when that Session is not on screen, not adopted, or the binding is disposed.
   */
  open(sessionId: SessionId): boolean
  /** Release subscriptions and invalidate retained callbacks; idempotent. */
  dispose(): void
}

/**
 * Bind one map tab to each adopted Session and remove duplicate map pages without changing other tabs.
 * @param sidebar - Sidebar inventory and session-addressed navigation.
 * @returns the binding owned by this client plugin's lifetime.
 */
export function createMapSessionBinding(sidebar: Sidebar): MapSessionBinding {
  const opened = new Set<SessionId>()
  const eligible = new Set<SessionId>()
  let disposed = false
  let scheduled = false
  const mapTab = (sessionId: SessionId) => sidebar.tabsIn(sessionId).find(tab => tab.kind === MAP_TAB_KIND)
  const ready = (sessionId: SessionId): boolean => !disposed
    && sidebar.mounted.getSnapshot() === sessionId

  const open = (sessionId: SessionId): boolean => {
    if (!ready(sessionId)) return false
    const tab = mapTab(sessionId)
    if (tab === undefined) sidebar.openTabIn(sessionId, MAP_TAB_KIND)
    else {
      if (!sidebar.isExpanded()) sidebar.toggleExpanded()
      sidebar.focus(tab.id)
    }
    if (mapTab(sessionId) === undefined) return false
    opened.add(sessionId)
    return true
  }
  const ensure = (sessionId: SessionId): void => {
    if (!eligible.has(sessionId) || !ready(sessionId) || opened.has(sessionId)) return
    if (mapTab(sessionId) !== undefined) opened.add(sessionId)
    else open(sessionId)
  }
  const reconcile = (): void => {
    if (disposed) return
    const sessions = new Set(sidebar.openTabs.getSnapshot().map(tab => tab.sessionId))
    for (const sessionId of sessions) {
      const [, ...duplicates] = sidebar.tabsIn(sessionId).filter(tab => tab.kind === MAP_TAB_KIND)
      for (const tab of duplicates) sidebar.closeIn(sessionId, tab.id)
    }
    const current = sidebar.mounted.getSnapshot()
    if (current !== undefined) ensure(current)
  }
  // The inventory publishes before TabDomain.sync commits the same layout.
  // A nested open/close here would let that older sync discard the new occurrence.
  const schedule = (): void => {
    if (disposed || scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; reconcile() })
  }
  const unsubscribeTabs = sidebar.openTabs.subscribe(schedule)
  const unsubscribeCurrent = sidebar.mounted.subscribe(schedule)
  schedule()
  return {
    tabs: sidebar.openTabs,
    owns: (sessionId, tabId) => !disposed && mapTab(sessionId)?.id === tabId,
    ensure: sessionId => {
      if (disposed) return
      eligible.add(sessionId)
      schedule()
    },
    open,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribeTabs()
      unsubscribeCurrent()
      opened.clear()
      eligible.clear()
    },
  }
}
