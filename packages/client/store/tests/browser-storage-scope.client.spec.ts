// @vitest-environment jsdom
/** Same-origin persistence scopes retain the stock key contract without global interception. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserStorage, createSnapshotStore, defineStore, resolveBrowserStorage } from '../src/index.ts'

const sessionId = 'shared-session'
const key = 'dsh.conversation'
const snapshotKey = 'dsh.sessions.current'
const handle = () => defineStore({
  init: () => ({ draft: '' }), persist: key,
  actions: { setDraft: (draft, text: string) => { draft.draft = text } },
})

function bytes(): Record<string, string | null> {
  return Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!
    return [key, localStorage.getItem(key)]
  }))
}

afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

describe('browser storage scope', () => {
  it('restores DSH → Map A → Map B → Map A on one origin with every other scope byte unchanged', () => {
    const methods = Object.getOwnPropertyDescriptors(Storage.prototype)
    const dsh = createBrowserStorage('', window)
    const mapA = createBrowserStorage('map-harness:A', window)
    const mapB = createBrowserStorage('map-harness:B', window)
    handle().create(sessionId, dsh).actions.setDraft('stock')
    createSnapshotStore({}, { persist: { name: snapshotKey, storage: dsh } }).set({ sessionId: 'stock' })
    const stockBytes = bytes()
    expect(Object.keys(stockBytes).sort()).toEqual([`${key}.${sessionId}`, snapshotKey].sort())

    for (const [storage, value] of [[mapA, 'map-a'], [mapB, 'map-b']] as const) {
      const previous = bytes()
      const instance = handle().create(sessionId, storage)
      expect(instance.getSnapshot().draft).toBe('')
      expect(createSnapshotStore({}, { persist: { name: snapshotKey, storage } }).getSnapshot()).toEqual({})
      instance.actions.setDraft(value)
      createSnapshotStore({}, { persist: { name: snapshotKey, storage } }).set({ sessionId: value })
      expect(bytes()).toMatchObject(previous)
    }

    const reopenedA = createBrowserStorage('map-harness:A', window)
    expect(handle().create(sessionId, reopenedA).getSnapshot().draft).toBe('map-a')
    expect(createSnapshotStore({}, { persist: { name: snapshotKey, storage: reopenedA } }).getSnapshot()).toEqual({ sessionId: 'map-a' })
    expect(handle().create(sessionId, mapB).getSnapshot().draft).toBe('map-b')
    expect(handle().create(sessionId).getSnapshot().draft).toBe('stock')
    expect(bytes()).toMatchObject(stockBytes)
    expect(Object.getOwnPropertyDescriptors(Storage.prototype)).toEqual(methods)
    expect(mapA.keys().toSorted()).toEqual([`${key}.${sessionId}`, snapshotKey].sort())
    expect(dsh.keys().toSorted()).toEqual([`${key}.${sessionId}`, snapshotKey].sort())
    handle().create(sessionId, reopenedA).clearPersisted()
    expect(mapA.getItem(`${key}.${sessionId}`)).toBeNull()
    expect(handle().create(sessionId, mapB).getSnapshot().draft).toBe('map-b')
    expect(bytes()).toMatchObject(stockBytes)
  })

  it('does not overlap nested namespace spellings or suffix-like session keys', () => {
    const outer = createBrowserStorage('map-harness:A', window)
    const inner = createBrowserStorage('map-harness:A:child', window)
    outer.setItem('child:dsh.conversation.s1', 'outer')
    inner.setItem('dsh.conversation.s1', 'inner')
    expect(outer.keys()).toEqual(['child:dsh.conversation.s1'])
    expect(inner.keys()).toEqual(['dsh.conversation.s1'])
    inner.removeItem('child:dsh.conversation.s1')
    expect(outer.getItem('child:dsh.conversation.s1')).toBe('outer')
  })

  it('routes storage events only from the matching namespace and storage area and disposes listeners', () => {
    const a = createBrowserStorage('map-harness:A', window)
    const b = createBrowserStorage('map-harness:B', window)
    const seen = vi.fn()
    const off = a.subscribe(seen)
    try {
      a.setItem(key, 'a')
      b.setItem(key, 'b')
      const keys = Object.keys(bytes())
      const own = keys.find(candidate => localStorage.getItem(candidate) === 'a')!
      const other = keys.find(candidate => localStorage.getItem(candidate) === 'b')!
      window.dispatchEvent(new StorageEvent('storage', { key: other, storageArea: localStorage }))
      window.dispatchEvent(new StorageEvent('storage', { key: own, storageArea: sessionStorage }))
      expect(seen).not.toHaveBeenCalled()
      window.dispatchEvent(new StorageEvent('storage', { key: own, storageArea: localStorage }))
      expect(seen).toHaveBeenLastCalledWith(key)
      window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }))
      expect(seen).toHaveBeenLastCalledWith(null)
      expect(seen).toHaveBeenCalledTimes(2)
      off(); off()
      window.dispatchEvent(new StorageEvent('storage', { key: own, storageArea: localStorage }))
      expect(seen).toHaveBeenCalledTimes(2)
    } finally { off() }
  })

  it('ignores namespaced events in a stock subscription while preserving stock event keys', () => {
    const stock = createBrowserStorage('', window)
    const a = createBrowserStorage('map-harness:A', window)
    const seen = vi.fn()
    const off = stock.subscribe(seen)
    try {
      a.setItem('stock-key', 'map')
      const namespacedKey = Object.keys(bytes())[0]!
      window.dispatchEvent(new StorageEvent('storage', { key: namespacedKey, storageArea: localStorage }))
      expect(seen).not.toHaveBeenCalled()
      window.dispatchEvent(new StorageEvent('storage', { key: 'stock-key', storageArea: localStorage }))
      expect(seen).toHaveBeenCalledExactlyOnceWith('stock-key')
    } finally { off() }
  })

  it('keeps Context ownership separate and provides a stock adapter for an unconfigured tree', async () => {
    const a = new Context()
    const b = new Context()
    try {
      const storage = createBrowserStorage('map-harness:A', window)
      a.provide('browserStorage', storage)
      expect(resolveBrowserStorage(a)).toBe(storage)
      expect(resolveBrowserStorage(b).namespace).toBe('')
      expect(resolveBrowserStorage(b)).not.toBe(resolveBrowserStorage(b))
    } finally { await Promise.all([a.fiber.dispose(), b.fiber.dispose()]) }
  })

  it('disables absent storage and leaves denial reporting with each operation owner', () => {
    const absent = createBrowserStorage('map-harness:A', {})
    absent.setItem('k', 'v'); absent.removeItem('k'); absent.subscribe(() => {})()
    expect(absent.getItem('k')).toBeNull()
    expect(absent.keys()).toEqual([])
    const denied = createBrowserStorage('map-harness:A', {
      get localStorage(): Storage { throw new Error('storage denied') },
    })
    expect(() => denied.getItem('k')).toThrow('storage denied')
    expect(() => { denied.setItem('k', 'v') }).toThrow('storage denied')
    expect(() => { denied.removeItem('k') }).toThrow('storage denied')
    expect(() => denied.keys()).toThrow('storage denied')
  })

  it('contains an event observer failure without retaining it after disposal', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const storage = createBrowserStorage('', window)
    const off = storage.subscribe(() => { throw new Error('observer failed') })
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: 'stock' }))
      expect(error).toHaveBeenCalledExactlyOnceWith('[browser-storage] subscriber failed:', expect.any(Error))
    } finally { off() }
  })
})
