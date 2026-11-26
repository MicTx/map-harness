// @vitest-environment jsdom
/** Workspace view preferences preserve stock bytes while switching application instances. */
import { afterEach, expect, it } from 'vitest'
import { createBrowserStorage } from '@deepseek-ai/dsh-client-store'
import { createWorkspaceViewStore } from '../src/client/stores.ts'

afterEach(() => { localStorage.clear() })

it('restores DSH → Map A → Map B → Map A view preferences without importing stock state', () => {
  const key = 'dsh.workspace.view.v5'
  const values = [
    { namespace: '', orderBy: 'manual' },
    { namespace: 'map-harness:A', orderBy: 'updated' },
    { namespace: 'map-harness:B', orderBy: 'manual' },
  ] as const
  const saved = []
  for (const { namespace, orderBy } of values) {
    const storage = createBrowserStorage(namespace, window)
    const instance = createWorkspaceViewStore().create(undefined, storage)
    expect(storage.getItem(key)).toBeNull()
    instance.actions.setOrderBy(orderBy, {})
    saved.push(instance.getSnapshot())
  }
  const stockBytes = localStorage.getItem(key)
  expect(createWorkspaceViewStore().create(undefined, createBrowserStorage('map-harness:A', window)).getSnapshot()).toEqual(saved[1])
  expect(createWorkspaceViewStore().create(undefined, createBrowserStorage('map-harness:B', window)).getSnapshot()).toEqual(saved[2])
  expect(createWorkspaceViewStore().create().getSnapshot()).toEqual(saved[0])
  expect(localStorage.getItem(key)).toBe(stockBytes)
})
