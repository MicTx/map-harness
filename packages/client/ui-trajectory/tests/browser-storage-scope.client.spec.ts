// @vitest-environment jsdom
/** Persisted trajectory preferences belong to one application instance. */
import { afterEach, expect, it } from 'vitest'
import { createBrowserStorage } from '@deepseek-ai/dsh-client-store'
import { createTrajectoryDurationStore } from '../src/client/duration-store.ts'
import { createTrajectoryStringWrappingStore } from '../src/client/string-wrapping-store.ts'

afterEach(() => { localStorage.clear() })

it('restores DSH → Map A → Map B → Map A duration and wrapping choices', () => {
  const scopes = ['', 'map-harness:A', 'map-harness:B'].map(namespace => createBrowserStorage(namespace, window))
  for (const [index, storage] of scopes.entries()) {
    expect(createTrajectoryDurationStore(storage).getSnapshot()).toBe(false)
    expect(createTrajectoryStringWrappingStore(storage).getSnapshot()).toBe(false)
    createTrajectoryDurationStore(storage).set(index !== 1)
    createTrajectoryStringWrappingStore(storage).set(index === 2)
  }
  const stock = localStorage.getItem('dsh.trajectory.duration')
  expect(createTrajectoryDurationStore(createBrowserStorage('map-harness:A', window)).getSnapshot()).toBe(false)
  expect(createTrajectoryStringWrappingStore(createBrowserStorage('map-harness:A', window)).getSnapshot()).toBe(false)
  expect(createTrajectoryDurationStore(createBrowserStorage('map-harness:B', window)).getSnapshot()).toBe(true)
  expect(createTrajectoryStringWrappingStore(createBrowserStorage('map-harness:B', window)).getSnapshot()).toBe(true)
  expect(createTrajectoryDurationStore().getSnapshot()).toBe(true)
  expect(localStorage.getItem('dsh.trajectory.duration')).toBe(stock)
})
