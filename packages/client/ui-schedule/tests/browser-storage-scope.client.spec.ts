// @vitest-environment jsdom
/** Schedule's recent zones and task-tab recovery follow the application instance. */
import { afterEach, expect, it } from 'vitest'
import { createBrowserStorage } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import { loadRecentTimeZones, rememberTimeZone } from '../src/client/recent-time-zones.ts'
import { TaskTabBindings, type TaskTabPage } from '../src/client/task-tab-bindings.ts'

const session = 'same-session' as SessionId
const page: TaskTabPage = { id: 'tab1', kind: 'scheduleTask', contentId: 'sidebar://scheduleTask' }
afterEach(() => { localStorage.clear() })

it('restores DSH → Map A → Map B → Map A zones and task bindings', () => {
  const scopes = ['', 'map-harness:A', 'map-harness:B'].map(namespace => createBrowserStorage(namespace, window))
  for (const [index, storage] of scopes.entries()) {
    expect(loadRecentTimeZones('UTC', storage)).toEqual(['UTC'])
    rememberTimeZone(['UTC'], `Etc/GMT${index === 0 ? '' : index}`, storage)
    const bindings = new TaskTabBindings(undefined, storage)
    expect(bindings.read(session, page)).toBeUndefined()
    bindings.write(session, page, { sessionId: session, id: `task-${index}` as ScheduleId })
  }
  const stockBytes = Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!
    return [key, localStorage.getItem(key)]
  }))
  const a = createBrowserStorage('map-harness:A', window)
  expect(loadRecentTimeZones('UTC', a)).toEqual(['Etc/GMT1', 'UTC'])
  expect(new TaskTabBindings(undefined, a).read(session, page)).toEqual({ sessionId: session, id: 'task-1' })
  const b = createBrowserStorage('map-harness:B', window)
  expect(loadRecentTimeZones('UTC', b)).toEqual(['Etc/GMT2', 'UTC'])
  expect(new TaskTabBindings(undefined, b).read(session, page)).toEqual({ sessionId: session, id: 'task-2' })
  expect(loadRecentTimeZones('UTC')).toEqual(['Etc/GMT', 'UTC'])
  expect(new TaskTabBindings().read(session, page)).toEqual({ sessionId: session, id: 'task-0' })
  expect(Object.fromEntries(Array.from({ length: localStorage.length }, (_, index) => {
    const key = localStorage.key(index)!
    return [key, localStorage.getItem(key)]
  }))).toMatchObject(stockBytes)
  new TaskTabBindings(undefined, a).forget(session, page)
  expect(new TaskTabBindings(undefined, a).read(session, page)).toBeUndefined()
  expect(new TaskTabBindings(undefined, b).read(session, page)).toEqual({ sessionId: session, id: 'task-2' })
  expect(new TaskTabBindings().read(session, page)).toEqual({ sessionId: session, id: 'task-0' })
})
