// @vitest-environment jsdom
/** The production Client Loader binds persistent Slot stores to each Connection instance. */
import { act, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import { createBrowserStorage, defineStore } from '@deepseek-ai/dsh-client-store'
import type { PropsRuntime, PropsStore, StandardSourceBinding } from '@deepseek-ai/dsh-client-ui-slots'
import { RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { loadPluginModules } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/modules.ts'

const CONNECTION = '@deepseek-ai/dsh-client-connection'
const RENDERER = '@deepseek-ai/dsh-client-ui-renderer'
const KEY = 'scope-fixture.counter'
const roster = webApp.pick([RENDERER, '@deepseek-ai/dsh-client-modules', CONNECTION])

function counter() {
  return defineStore({
    init: () => ({ count: 0 }), persist: KEY,
    actions: { increment: (state) => { state.count++ } },
  })
}

type CounterProps = PropsRuntime<'root'> & PropsStore<ReturnType<typeof counter>>
function Counter(props: CounterProps) {
  return <button onClick={props.actions.increment}>{props.useStore(state => state.count)}</button>
}

async function start(namespace: string) {
  const modules = await loadPluginModules({ roster })
  const connection = modules.get(CONNECTION)
  if (connection === undefined) throw new Error('fixture roster omitted Connection')
  vi.stubGlobal('__DSH_BROWSER_STORAGE_NAMESPACE__', namespace)
  const client = await TestClient.start({ roster, provide: { [CONNECTION]: connection } }, RemoteMock.create(), { awaitConnected: false })
  onTestFinished(() => client.dispose())
  for (const entry of client.ctx.loader.entries()) expect(entry.fiber?.state).toBe(FiberState.ACTIVE)
  expect(client.ctx.browserStorage.namespace).toBe(namespace)
  await client.ctx.plugin({ inject: ['slots'], apply(ctx: Context) {
    const absent: StandardSourceBinding = { key: undefined, hooks: {}, keyedHooks: {}, props: {} }
    const current = { getSnapshot: () => absent, subscribe: () => () => {} }
    ctx.slots.installScope('session', { current, bindingSource: () => current })
    ctx.slots.register({ name: 'root', store: counter() }, Counter)
  } })
  return client
}

function mount(client: TestClient) {
  const el = document.createElement('div')
  document.body.append(el)
  let unmount: (() => void) | undefined
  act(() => { unmount = client.ctx.uiRenderer.mount(el) })
  const dispose = () => { act(() => { unmount?.(); unmount = undefined }); el.remove() }
  onTestFinished(dispose)
  return { el, dispose }
}

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

it('boots stock and two independent namespaced Client trees and rehydrates the same registered store', async () => {
  const stock = await start('')
  const stockView = mount(stock)
  fireEvent.click(stockView.el.querySelector('button')!)
  const stockBytes = localStorage.getItem(KEY)
  expect(stockBytes).toBe('{"count":1}')
  stockView.dispose()
  await stock.dispose()

  const a = await start('map-harness:A')
  const aView = mount(a)
  const b = await start('map-harness:B')
  const bView = mount(b)
  expect(aView.el.textContent).toBe('0')
  expect(bView.el.textContent).toBe('0')
  fireEvent.click(aView.el.querySelector('button')!)
  fireEvent.click(aView.el.querySelector('button')!)
  fireEvent.click(bView.el.querySelector('button')!)
  expect(aView.el.textContent).toBe('2')
  expect(bView.el.textContent).toBe('1')
  aView.dispose()
  await a.dispose()

  const reopenedA = await start('map-harness:A')
  const reopenedView = mount(reopenedA)
  expect(reopenedView.el.textContent).toBe('2')
  expect(bView.el.textContent).toBe('1')
  expect(localStorage.getItem(KEY)).toBe(stockBytes)
})

it('withdraws the renderer and listeners before replacing its Connection storage provider', async () => {
  const client = await start('map-harness:A')
  const oldSlots = client.ctx.slots
  const seen = vi.fn()
  await client.ctx.plugin({ inject: ['browserStorage'], apply(ctx: Context) {
    ctx.effect(() => ctx.browserStorage.subscribe(seen))
  } })
  const first = mount(client)
  fireEvent.click(first.el.querySelector('button')!)
  first.dispose()
  // An explicit bootstrap change affects only the newly installed Connection tree.
  vi.stubGlobal('__DSH_BROWSER_STORAGE_NAMESPACE__', 'map-harness:B')
  await client.reload(CONNECTION)
  expect(client.ctx.slots).not.toBe(oldSlots)
  expect(() => oldSlots.renderSlot('root', {})).toThrow('not installed')
  expect(client.ctx.browserStorage.namespace).toBe('map-harness:B')
  const second = mount(client)
  expect(second.el.textContent).toBe('0')
  expect(createBrowserStorage('map-harness:A', window).getItem(KEY)).toBe('{"count":1}')
  const oldKey = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)!).find(key => key.endsWith(KEY))!
  window.dispatchEvent(new StorageEvent('storage', { key: oldKey, storageArea: localStorage }))
  expect(seen).not.toHaveBeenCalled()
  window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }))
  expect(seen).toHaveBeenCalledTimes(1)
  second.dispose()
  await client.dispose()
  window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }))
  expect(seen).toHaveBeenCalledTimes(1)
})
