/**
 * Default-open policy for the map-only right Sidebar: the first time a session
 * becomes the main view, expand the column and seat the map tab once. Later
 * manual collapse or tab removal is the user's decision and is never reverted.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Decide whether a session still needs the one-time default open.
 * @param openedSessions - sessions this policy already acted on.
 * @param sessionId - the session becoming the main view; `undefined` when no session is bound.
 * @returns the session to open the map tab for, or `undefined` when the binding is absent or already handled.
 */
export function nextDefaultOpenTarget(openedSessions: ReadonlySet<string>, sessionId: string | undefined): string | undefined {
  if (sessionId === undefined || sessionId === '' || openedSessions.has(sessionId)) return undefined
  return sessionId
}

/**
 * Watch the main session binding and open the map tab once per session.
 *
 * The right-Sidebar seat mounts and adopts its session store during the same
 * React commit that publishes the new main binding, so the open runs one
 * animation frame later; `openTabIn` on a not-yet-adopted store is a no-op and
 * that session falls back to the default-seeded map page on first expansion.
 *
 * @param ctx - client root context carrying `uiSession` and `sidebarRight`.
 * @returns the disposer that stops watching.
 */
export function installDefaultMapOpen(ctx: Context): () => void {
  const opened = new Set<string>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const retryOpen = (target: string, remaining: number): void => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      const current = ctx.uiSession.adapter.current.getSnapshot().key as string | undefined
      if (current !== target) return
      const openTabs = (ctx.sidebarRight as unknown as {
        openTabs?: { getSnapshot: () => readonly { sessionId: string; kind: string }[] }
      }).openTabs?.getSnapshot()
      if (openTabs?.some(tab => tab.sessionId === target && tab.kind === 'map') === true) return
      ctx.sidebarRight.openTabIn(target as SessionId, 'map')
      // Upstream 0.2 adopts the sidebar session store after the main-session
      // binding. Repeat only through that short handoff window.
      if (remaining > 0) retryOpen(target, remaining - 1)
    }, 50)
    timers.add(timer)
  }
  const attempt = (): void => {
    const key = ctx.uiSession.adapter.current.getSnapshot().key as string | undefined
    const target = nextDefaultOpenTarget(opened, key)
    if (target === undefined) return
    opened.add(target)
    retryOpen(target, 20)
  }
  const dispose = ctx.uiSession.adapter.current.subscribe(attempt)
  attempt()
  return () => {
    dispose()
    for (const timer of timers) clearTimeout(timer)
    timers.clear()
  }
}
