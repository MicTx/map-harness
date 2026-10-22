/**
 * Label overlay: placed labels draw as pointer-transparent HTML text in the
 * Microsoft YaHei stack and the layer color; dispose removes the element.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLabelOverlay } from '../src/client/label-overlay.ts'

/** Minimal element double: style text, attributes, children. */
function element() {
  return {
    style: { cssText: '' }, textContent: null, attributes: new Map(), children: [], removed: false,
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
  assert.match(item.style.cssText, /left:10px;top:20px/)
  overlay.render([])
  assert.equal(root.children.length, 0, 'an empty placement clears the overlay')
  overlay.dispose()
  assert.equal(root.removed, true)
})

test('a holder without a document only records labels', () => {
  const overlay = createLabelOverlay({ ...element(), ownerDocument: null })
  overlay.render([{ key: 'a', text: 'x', x: 0, y: 0, anchor: 'center', color: '#000000' }])
  assert.equal(overlay.labels.length, 1)
})
