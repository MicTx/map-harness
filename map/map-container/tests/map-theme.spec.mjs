import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAP_THEME_CSS, MAP_THEME_TAG, installMapTheme } from '../src/client/map-theme.ts'

test('overlay colors read host design tokens', () => {
  for (const token of ['--dsw-alias-bg-layer-1', '--dsw-alias-label-primary', '--dsw-alias-border-l2', '--dsw-focus-ring-color']) {
    assert.ok(MAP_THEME_CSS.includes(`var(${token}`), token)
  }
  assert.match(MAP_THEME_CSS, /button:focus-visible/)
  assert.match(MAP_THEME_CSS, /prefers-reduced-motion/)
})

test('panel and workbench inline styles carry no hardcoded surface colors', () => {
  for (const file of ['LayerPanel.tsx', 'Workbench.tsx', 'MapTabBody.tsx']) {
    const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /rgba\(255,\s*255,\s*255|#d0d0d0|#eee'/, file)
  }
})

test('the stylesheet installs once per document', () => {
  const appended = []
  const doc = {
    querySelector: () => (appended.length > 0 ? appended[0] : null),
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: node => appended.push(node) },
  }
  installMapTheme(doc)
  installMapTheme(doc)
  assert.equal(appended.length, 1)
  assert.equal(appended[0].dataset.pluginCss, MAP_THEME_TAG)
  installMapTheme(undefined)
})
