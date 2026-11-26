// @vitest-environment jsdom
/** Shortcut preferences follow the explicit application namespace and its storage events. */
import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserStorage } from '@deepseek-ai/dsh-client-store'
import { SHORTCUT_STORAGE_KEY, webShortcutStorage } from '../src/client/storage.ts'
import type { ShortcutCommandId, ShortcutConfigSnapshot } from '../src/protocol.ts'

const id = 'shortcuts.open' as ShortcutCommandId
const definitions = [{ id, defaults: {
  'web:macos': { code: 'Slash', modifiers: ['primary'] as const },
  'web:windows': { code: 'Slash', modifiers: ['primary'] as const },
  'web:linux': { code: 'Slash', modifiers: ['primary'] as const },
} }]

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

it('restores DSH → Map A → Map B → Map A bindings without touching another scope', async () => {
  const latest: ShortcutConfigSnapshot[] = []
  const adapters = ['', 'map-harness:A', 'map-harness:B'].map(namespace =>
    webShortcutStorage(window, 'macos', (snapshot) => { latest.push(snapshot) }, createBrowserStorage(namespace, window)))
  const savedKeys = new Set<string>()
  try {
    const initial = await adapters[0]!.get(definitions)
    expect((await adapters[0]!.edit({ type: 'reset', id }, initial.revision)).status).toBe('saved')
    const stockBytes = localStorage.getItem(SHORTCUT_STORAGE_KEY)
    expect((await adapters[1]!.get(definitions)).document).toEqual(initial.document)
    expect((await adapters[1]!.edit({ type: 'set', id, binding: null }, latest.at(-1)!.revision)).status).toBe('saved')
    expect((await adapters[2]!.get(definitions)).document).toEqual(initial.document)
    createBrowserStorage('map-harness:B', window).setItem(SHORTCUT_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, profiles: { 'web:macos': { [id]: { code: 'KeyK', modifiers: ['meta', 'shift'] } } } }))
    expect(localStorage.getItem(SHORTCUT_STORAGE_KEY)).toBe(stockBytes)
    for (let index = 0; index < localStorage.length; index++) savedKeys.add(localStorage.key(index)!)
    expect(savedKeys.size).toBe(3)

    const reopenedA = webShortcutStorage(window, 'macos', (snapshot) => { latest.push(snapshot) }, createBrowserStorage('map-harness:A', window))
    try {
      const a = await reopenedA.get(definitions)
      expect(a.status).toBe('ready')
      expect(a.usingDefaults).toBe(false)
      expect(a.document.profiles['web:macos']?.[id]).toBeNull()
    } finally { reopenedA.dispose() }
    const reopenedB = webShortcutStorage(window, 'macos', (snapshot) => { latest.push(snapshot) }, createBrowserStorage('map-harness:B', window))
    try {
      const b = await reopenedB.get(definitions)
      expect(b.status).toBe('ready')
      expect(b.usingDefaults).toBe(false)
      expect(b.document.profiles['web:macos']?.[id]).toEqual({ code: 'KeyK', modifiers: ['meta', 'shift'] })
    } finally { reopenedB.dispose() }
  } finally { for (const adapter of adapters) adapter.dispose() }
})

it('ignores another namespace event and still reacts to its own namespaced event', async () => {
  const published = vi.fn()
  const a = createBrowserStorage('map-harness:A', window)
  const b = createBrowserStorage('map-harness:B', window)
  const adapter = webShortcutStorage(window, 'macos', published, a)
  try {
    expect((await adapter.get(definitions)).usingDefaults).toBe(true)
    published.mockClear()
    b.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, profiles: {} }))
    const bPhysical = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
      .find(key => localStorage.getItem(key) === JSON.stringify({ schemaVersion: 1, profiles: {} }))!
    window.dispatchEvent(new StorageEvent('storage', { key: bPhysical }))
    await Promise.resolve()
    expect(published).not.toHaveBeenCalled()
    a.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, profiles: { 'web:macos': { [id]: null } } }))
    const aPhysical = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!)
      .find(key => localStorage.getItem(key)!.includes('"web:macos"'))!
    window.dispatchEvent(new StorageEvent('storage', { key: aPhysical }))
    await vi.waitFor(() => { expect(published).toHaveBeenCalled() })
  } finally { adapter.dispose() }
})
