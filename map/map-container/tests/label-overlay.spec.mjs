/**
 * Label overlay: placed labels draw as pointer-transparent HTML text in the
 * Microsoft YaHei stack and the layer color; dispose removes the element.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLabelOverlay } from '../src/client/label-overlay.ts'

/** Minimal element double: style text, attributes, children, and click capture. */
function element() {
  return {
    style: { cssText: '' }, textContent: null, attributes: new Map(), children: [], removed: false, onclick: null,
    setAttribute(name, value) { this.attributes.set(name, value) },
    appendChild(child) { this.children.push(child) },
    replaceChildren(...children) { this.children = children },
    remove() { this.removed = true },
  }
}

test('labels draw as HTML text in the layer color and font stack', () => {
  const holder = { ...element(), ownerDocument: { createElement: () => element() } }
  const overlay = createLabelOverlay(holder)
  overlay.render([{ key: 'a', text: '北京站', x: 10, y: 20, anchor: 'top', color: '#2f6fb0' }])
  const root = holder.children[0]
  assert.equal(root.attributes.get('data-map-labels'), '')
  assert.match(root.style.cssText, /pointer-events:none/)
  const item = root.children[0]
  assert.equal(item.textContent, '北京站')
  assert.match(item.style.cssText, /color:#2f6fb0/)
  assert.match(item.style.cssText, /10\.5px\/1\.2 "Microsoft YaHei"/)
  assert.match(item.style.cssText, /translate3d\(10px,20px,0\)/)
  overlay.render([])
  assert.equal(root.children.length, 0, 'an empty placement clears the overlay')
  overlay.dispose()
  assert.equal(root.removed, true)
})

test('cluster badges draw as clickable localized pills and report to the click callback', () => {
  const holder = { ...element(), ownerDocument: { createElement: () => element() } }
  const clicked = []
  const overlay = createLabelOverlay(holder, {
    clusterCopy: count => ({ text: `+${count}`, title: `Zoom in to reveal ${count} more names` }),
    onClusterClick: badge => clicked.push(badge),
  })
  const badge = { key: '3:2', x: 300, y: 200, count: 12, bbox: { west: 116.3, south: 39.8, east: 116.5, north: 40.0 } }
  overlay.render([], [badge])
  const root = holder.children[0]
  const pill = root.children[0]
  assert.equal(pill.textContent, '+12')
  assert.equal(pill.attributes.get('data-map-label-cluster'), '')
  assert.equal(pill.attributes.get('title'), 'Zoom in to reveal 12 more names')
  assert.match(pill.style.cssText, /pointer-events:auto/)
  assert.match(pill.style.cssText, /cursor:pointer/)
  assert.match(pill.style.cssText, /translate3d\(300px,200px,0\)/)
  assert.match(pill.style.cssText, /background:var\(--map-accent, #3370ff\)/)
  pill.onclick()
  assert.deepEqual(clicked, [badge])
  assert.deepEqual(overlay.clusters, [badge])
  overlay.render([{ key: 'a', text: 'A', x: 1, y: 2, anchor: 'top', color: '#000000' }], [])
  assert.equal(root.children.some(child => child.attributes.get('data-map-label-cluster') === ''), false,
    'a placement without clusters clears the badges')
  overlay.dispose()
})

test('cluster badges default their copy when no hooks arrive and hide with the overlay', () => {
  const holder = { ...element(), ownerDocument: { createElement: () => element() } }
  const overlay = createLabelOverlay(holder)
  overlay.setSuspended(true)
  overlay.render([], [{ key: '0:0', x: 40, y: 40, count: 3, bbox: null }])
  const root = holder.children[0]
  assert.equal(root.style.visibility, 'hidden')
  const pill = root.children[0]
  assert.equal(pill.textContent, '+3')
  assert.equal(pill.attributes.has('title'), false)
  assert.equal(overlay.clusters.length, 1)
  const bare = { ...element(), ownerDocument: null }
  const bareOverlay = createLabelOverlay(bare)
  bareOverlay.render([], [{ key: '0:0', x: 1, y: 1, count: 1, bbox: null }])
  assert.equal(bareOverlay.clusters.length, 1, 'a holder without a document still records badges')
})

test('a holder without a document only records labels', () => {
  const overlay = createLabelOverlay({ ...element(), ownerDocument: null })
  overlay.render([{ key: 'a', text: 'x', x: 0, y: 0, anchor: 'center', color: '#000000' }])
  assert.equal(overlay.labels.length, 1)
})

test('a persisting label keeps its element and moves; a new label fades in', () => {
  const holder = { ...element(), ownerDocument: { createElement: () => element() } }
  const overlay = createLabelOverlay(holder)
  overlay.render([{ key: 'a', text: 'A', x: 1, y: 2, anchor: 'top', color: '#000000' }])
  const first = holder.children[0].children[0]
  overlay.render([
    { key: 'a', text: 'A', x: 5, y: 6, anchor: 'top', color: '#000000' },
    { key: 'b', text: 'B', x: 7, y: 8, anchor: 'top', color: '#000000' },
  ])
  const [kept, added] = holder.children[0].children
  assert.equal(kept, first, 'the same key reuses its element, so it does not re-fade')
  assert.match(kept.style.transform, /translate3d\(5px,6px,0\)/)
  assert.match(added.style.cssText, /transition:opacity 300ms/)
})

test('labels carry a solid white stroke and hide while the map is operated', () => {
  const holder = { ...element(), ownerDocument: { createElement: () => element() } }
  const overlay = createLabelOverlay(holder)
  overlay.render([{ key: 'a', text: 'A', x: 1, y: 2, anchor: 'top', color: '#000000' }])
  const root = holder.children[0]
  assert.match(root.children[0].style.cssText, /-webkit-text-stroke:3px #ffffff/)
  assert.doesNotMatch(root.children[0].style.cssText, /blur|rgba/)
  overlay.setSuspended(true)
  assert.equal(root.style.visibility, 'hidden')
  overlay.setSuspended(false)
  assert.equal(root.style.visibility, 'visible')

  const late = { ...element(), ownerDocument: { createElement: () => element() } }
  const lateOverlay = createLabelOverlay(late)
  lateOverlay.setSuspended(true)
  lateOverlay.render([{ key: 'a', text: 'A', x: 1, y: 2, anchor: 'top', color: '#000000' }])
  assert.equal(late.children[0].style.visibility, 'hidden', 'a render during an operation stays hidden')
})
