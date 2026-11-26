import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMapSessionBinding } from '../src/client/default-open.ts'

function source(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) },
    set(next) { value = next; for (const listener of [...listeners]) listener() },
    get listeners() { return listeners.size },
  }
}

function rig() {
  const mounted = source(undefined)
  const openTabs = source([])
  const adopted = new Map()
  const calls = []
  let expanded = false
  let serial = 0
  const publish = () => openTabs.set([...adopted].flatMap(([sessionId, tabs]) => tabs.map(tab => ({ ...tab, sessionId, tabId: tab.id }))))
  const sidebar = {
    mounted, openTabs,
    tabsIn: id => adopted.get(id) ?? [],
    openTabIn(id, kind) {
      if (!adopted.has(id)) return
      calls.push(['open', id])
      adopted.get(id).push({ id: `tab-${++serial}`, kind, contentId: `sidebar://${kind}` })
      expanded = true
      publish()
    },
    closeIn(id, tabId) {
      calls.push(['close', id, tabId])
      adopted.set(id, adopted.get(id).filter(tab => tab.id !== tabId))
      publish()
    },
    focus(id) { calls.push(['focus', mounted.getSnapshot(), id]) },
    isExpanded: () => expanded,
    toggleExpanded() { expanded = !expanded },
  }
  const binding = createMapSessionBinding(sidebar)
  return {
    sidebar, binding, calls, publish,
    adopt(id, tabs = [{ id: `guide-${id}`, kind: 'guide' }]) { adopted.set(id, tabs); publish() },
    maps: id => sidebar.tabsIn(id).filter(tab => tab.kind === 'map'),
  }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('default open waits for adoption and opens exactly once without timers', async t => {
  const r = rig(); t.after(() => r.binding.dispose())
  r.sidebar.mounted.set('a')
  r.binding.ensure('a')
  assert.deepEqual(r.calls, [])
  r.adopt('a')
  assert.deepEqual(r.calls, [], 'inventory notification cannot reenter the layout commit')
  await settle()
  assert.equal(r.maps('a').length, 1)
  r.publish(); r.binding.ensure('a')
  assert.deepEqual(r.calls, [['open', 'a']])
  r.sidebar.closeIn('a', r.maps('a')[0].id)
  r.binding.ensure('a'); r.publish()
  assert.equal(r.maps('a').length, 0, 'manual close is not undone')
  assert.equal(r.binding.open('a'), true)
  assert.equal(r.maps('a').length, 1, 'explicit action reopens the bound map')
})

test('restored and newly duplicated map tabs converge without touching other content', async t => {
  const r = rig(); t.after(() => r.binding.dispose())
  r.adopt('a', [
    { id: 'map-a', kind: 'map' }, { id: 'file-a', kind: 'file' }, { id: 'duplicate-a', kind: 'map' },
  ])
  r.adopt('b', [{ id: 'map-b', kind: 'map' }, { id: 'duplicate-b', kind: 'map' }])
  assert.equal(r.binding.owns('a', 'duplicate-a'), false, 'duplicate cannot render while reconciliation is queued')
  await settle()
  assert.deepEqual(r.maps('a').map(tab => tab.id), ['map-a'])
  assert.deepEqual(r.maps('b').map(tab => tab.id), ['map-b'])
  assert.equal(r.sidebar.tabsIn('a').some(tab => tab.id === 'file-a'), true)
  assert.equal(r.binding.owns('a', 'map-a'), true)
  assert.equal(r.binding.owns('a', 'map-b'), false)
  assert.equal(r.binding.owns('a', 'duplicate-a'), false)
  r.sidebar.openTabIn('a', 'map')
  await settle()
  assert.deepEqual(r.maps('a').map(tab => tab.id), ['map-a'])
})

test('session-bound navigation rejects stale actions and restores the existing map', t => {
  const r = rig(); t.after(() => r.binding.dispose())
  r.adopt('a', [{ id: 'map-a', kind: 'map' }])
  r.adopt('b', [{ id: 'map-b', kind: 'map' }])
  r.sidebar.mounted.set('a')
  r.binding.ensure('a')
  assert.equal(r.sidebar.isExpanded(), false, 'restored collapsed state is respected')
  assert.equal(r.binding.open('a'), true)
  assert.equal(r.sidebar.isExpanded(), true)
  r.sidebar.mounted.set('b')
  assert.equal(r.binding.open('a'), false)
  assert.equal(r.binding.open('b'), true)
  assert.deepEqual(r.calls, [['focus', 'a', 'map-a'], ['focus', 'b', 'map-b']])
})

test('an adopted empty layout is ready even though its inventory has no tabs', async t => {
  const r = rig(); t.after(() => r.binding.dispose())
  r.sidebar.mounted.set('a'); r.adopt('a', [])
  await settle()
  assert.equal(r.maps('a').length, 0, 'blank sessions do not allocate a map')
  r.binding.ensure('a')
  await settle()
  assert.equal(r.maps('a').length, 1)
})

test('unadopted saved tabs wait for the session header readiness signal', async t => {
  const r = rig(); t.after(() => r.binding.dispose())
  r.sidebar.openTabs.set([{ sessionId: 'a', tabId: 'saved', kind: 'guide' }])
  r.sidebar.mounted.set('a')
  assert.equal(r.binding.open('a'), false)
  r.adopt('a')
  r.binding.ensure('a')
  await settle()
  assert.equal(r.maps('a').length, 1)
})

test('dispose removes subscriptions and makes old callbacks inert', () => {
  const r = rig()
  r.binding.dispose(); r.binding.dispose()
  assert.equal(r.sidebar.mounted.listeners, 0)
  assert.equal(r.sidebar.openTabs.listeners, 0)
  r.adopt('a'); r.sidebar.mounted.set('a'); r.binding.ensure('a')
  assert.equal(r.binding.open('a'), false)
  assert.deepEqual(r.calls, [])
})
