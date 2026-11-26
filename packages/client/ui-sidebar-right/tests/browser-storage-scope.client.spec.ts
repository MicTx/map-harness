// @vitest-environment jsdom
/** Saved layout discovery, malformed-value removal and explicit clearing stay in one instance. */
import { afterEach, expect, it } from 'vitest'
import { createBrowserStorage } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSidebarRightStore } from '../src/client/stores.ts'
import { readSidebarLayout, sidebarPersistence } from '../src/client/persistence.ts'
import { SidebarTabInventory } from '../src/client/tab-inventory.ts'

const session = 'same-session' as SessionId
const seed = () => ({ kind: 'guide', title: 'Start' })
afterEach(() => { localStorage.clear() })

it('restores DSH → Map A → Map B → Map A layouts and inventories without reading or deleting another scope', () => {
  const scopes = ['', 'map-harness:A', 'map-harness:B'].map(namespace => createBrowserStorage(namespace, window))
  const key = `${sidebarPersistence}.${session}`
  const snapshots: Array<string | null> = []
  for (const [index, storage] of scopes.entries()) {
    const store = createSidebarRightStore(seed).create(session, storage)
    expect(store.getSnapshot()).toEqual({ bySession: {} })
    let tab = ''
    store.actions.openContent(session, { kind: 'text', contentId: `file:${index}`, title: String(index) }, (id) => { tab = id })
    expect(tab).not.toBe('')
    snapshots.push(storage.getItem(key))
  }
  expect(localStorage.getItem(key)).toBe(snapshots[0])
  const a = createBrowserStorage('map-harness:A', window)
  expect(new SidebarTabInventory(a).source.getSnapshot()).toEqual([
    expect.objectContaining({ sessionId: session, contentId: 'file:1' }),
  ])
  expect(Object.values(readSidebarLayout(session, a)?.layout.tabs ?? {}).map(tab => tab.contentId)).toContain('file:1')
  a.setItem(key, '{malformed')
  expect(readSidebarLayout(session, a)).toBeUndefined()
  expect(a.getItem(key)).toBeNull()
  expect(scopes[0]!.getItem(key)).toBe(snapshots[0])
  expect(scopes[2]!.getItem(key)).toBe(snapshots[2])
  createSidebarRightStore(seed).create(session, scopes[2]).clearPersisted()
  expect(scopes[2]!.getItem(key)).toBeNull()
  expect(scopes[0]!.getItem(key)).toBe(snapshots[0])
})
