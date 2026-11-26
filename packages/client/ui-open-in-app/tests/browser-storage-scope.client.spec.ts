// @vitest-environment jsdom
/** Open-in-app's remembered choice follows the explicit instance adapter. */
import { afterEach, expect, it } from 'vitest'
import { createBrowserStorage } from '@deepseek-ai/dsh-client-store'
import { OpenInAppController } from '../src/client/controller.ts'

afterEach(() => { localStorage.clear() })

it('restores DSH → Map A → Map B → Map A choices without importing another scope', () => {
  const scopes = ['', 'map-harness:A', 'map-harness:B'].map(namespace => createBrowserStorage(namespace, window))
  for (const [index, storage] of scopes.entries()) {
    const controller = new OpenInAppController(undefined, storage)
    expect(controller.choice.getSnapshot()).toBe('')
    controller.apps.set(['finder', 'cursor'])
    controller.choose(index === 1 ? 'cursor' : 'finder')
  }
  const stockBytes = localStorage.getItem('dsh.open-in-app.choice')
  expect(new OpenInAppController(undefined, createBrowserStorage('map-harness:A', window)).choice.getSnapshot()).toBe('cursor')
  expect(new OpenInAppController(undefined, createBrowserStorage('map-harness:B', window)).choice.getSnapshot()).toBe('finder')
  expect(new OpenInAppController().choice.getSnapshot()).toBe('finder')
  expect(localStorage.getItem('dsh.open-in-app.choice')).toBe(stockBytes)
})
