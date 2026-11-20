/**
 * Contract test for the Mapbox GL JS v3 control geometry. The vendor
 * stylesheet is kept as a repository fixture, so the 1:1 claim is checked
 * against vendor bytes instead of a paraphrase and survives package archiving.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAPBOX_CTRL_CSS,
  MAPBOX_CTRL_GEOMETRY,
  MAPBOX_CTRL_ICONS,
  MAP_THEME_CSS,
  MAP_TOOL_CARD_CSS,
  installMapTheme,
} from '../src/client/map-theme.ts'

const OFFICIAL_CSS = readFileSync(new URL('./fixtures/mapbox-gl-v3-official.txt', import.meta.url), 'utf8')

const official = OFFICIAL_CSS.replace(/\s+/gu, '')

test('control geometry matches the vendor declarations', () => {
  assert.equal(MAPBOX_CTRL_GEOMETRY.buttonSize, '32px')
  assert.equal(MAPBOX_CTRL_GEOMETRY.radius, '4px')
  assert.equal(MAPBOX_CTRL_GEOMETRY.background, '#fff')
  assert.equal(MAPBOX_CTRL_GEOMETRY.ring, '0 0 0 2px rgba(0, 0, 0, 0.1)')
  assert.equal(MAPBOX_CTRL_GEOMETRY.separator, '#ddd')
  assert.equal(MAPBOX_CTRL_GEOMETRY.hover, '#eee')
  assert.equal(MAPBOX_CTRL_GEOMETRY.focus, '0 0 2px 2px #0096ff')
  assert.equal(MAPBOX_CTRL_GEOMETRY.font, `12px/20px "Helvetica Neue", Arial, Helvetica, sans-serif`)
  assert.equal(MAPBOX_CTRL_GEOMETRY.scaleBackground, 'rgba(255, 255, 255, 0.75)')
  assert.equal(MAPBOX_CTRL_GEOMETRY.attributionBackground, 'rgba(255, 255, 255, 0.5)')
  assert.ok(official.includes('border-radius:4px;background:#fff'), 'vendor group radius/background')
  assert.ok(official.includes('width:32px;height:32px'), 'vendor button size')
  assert.ok(official.includes('box-shadow:0002px#0000001a'), 'vendor 2px ring')
  assert.ok(official.includes('border-top:1pxsolid#ddd'), 'vendor separator')
  assert.ok(official.includes('background-color:#eee'), 'vendor hover')
  assert.ok(official.includes('box-shadow:002px2px#0096ff'), 'vendor focus ring')
  assert.ok(official.includes('font:12px/20pxHelveticaNeue,Arial,Helvetica,sans-serif'), 'vendor font')
  assert.ok(official.includes('border-width:medium2px2px'), 'vendor scale border')
})

test('the control stylesheet transcribes each vendor declaration', () => {
  for (const declaration of [
    'width: 32px; height: 32px;',
    `border-radius: ${MAPBOX_CTRL_GEOMETRY.radius};`,
    `box-shadow: ${MAPBOX_CTRL_GEOMETRY.ring};`,
    `border-top: 1px solid ${MAPBOX_CTRL_GEOMETRY.separator};`,
    `background-color: ${MAPBOX_CTRL_GEOMETRY.hover};`,
    `box-shadow: ${MAPBOX_CTRL_GEOMETRY.focus};`,
    'border-style: none solid solid; border-width: medium 2px 2px;',
    'border-radius: 12px;',
    'opacity: .25;',
  ]) {
    assert.ok(MAPBOX_CTRL_CSS.includes(declaration), declaration)
  }
  assert.ok(MAPBOX_CTRL_CSS.includes('[data-mapbox-ctrl-group] button + button'))
  assert.ok(MAPBOX_CTRL_CSS.includes('button:first-of-type'))
  assert.ok(MAPBOX_CTRL_CSS.includes('button:last-child'))
  assert.ok(MAPBOX_CTRL_CSS.includes('button:only-child'))
  assert.ok(MAPBOX_CTRL_CSS.includes('[data-mapbox-ctrl-scale]'))
  assert.ok(MAPBOX_CTRL_CSS.includes('[data-mapbox-ctrl-attrib][data-mapbox-compact]'))
})

test('every icon is the vendor data URI verbatim', () => {
  for (const [name, icon] of Object.entries(MAPBOX_CTRL_ICONS)) {
    assert.ok(icon.startsWith('url("data:image/svg+xml;charset=utf-8,'), name)
    assert.ok(OFFICIAL_CSS.includes(icon), `${name} must appear in mapbox-gl.css byte-for-byte`)
    assert.ok(MAPBOX_CTRL_CSS.includes(icon), `${name} must be installed`)
  }
  assert.equal(Object.keys(MAPBOX_CTRL_ICONS).length, 5)
})

test('the Mapbox stylesheet joins the existing theme installation', () => {
  const appended = []
  const doc = {
    querySelector: () => (appended.length > 0 ? appended[0] : null),
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: node => appended.push(node) },
  }
  installMapTheme(doc)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].textContent, MAP_THEME_CSS + MAP_TOOL_CARD_CSS + MAPBOX_CTRL_CSS)
})
