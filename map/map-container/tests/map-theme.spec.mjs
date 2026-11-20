import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAP_THEME_CSS, MAP_TOOL_CARD_CSS, MAP_THEME_TAG, installMapTheme } from '../src/client/map-theme.ts'

test('overlay colors read host design tokens', () => {
  for (const token of ['--dsw-alias-bg-layer-1', '--dsw-alias-label-primary', '--dsw-alias-border-l2', '--dsw-focus-ring-color']) {
    assert.ok(MAP_THEME_CSS.includes(`var(${token}`), token)
  }
  assert.match(MAP_THEME_CSS, /button:focus-visible/)
  assert.match(MAP_THEME_CSS, /prefers-reduced-motion/)
  assert.match(MAP_THEME_CSS, /\[data-map-container\] \{ position: fixed; inset: 0; z-index: 20; \}/)
  assert.match(MAP_THEME_CSS, /background: var\(--dsw-static-neutral-00/)
  assert.match(MAP_THEME_CSS, /\[data-map-use-status\]/)
  assert.match(MAP_THEME_CSS, /\[data-map-use-status\] > button \{ margin-left: auto; min-height: 26px;/)
  assert.match(MAP_THEME_CSS, /\[data-map-overlay-content\] \{ position: relative; flex: 1;/)
  assert.match(MAP_THEME_CSS, /\[data-map-panel-header\] \{ position: sticky; top: 0; z-index: 1;/)
  assert.match(MAP_THEME_CSS, /\[data-map-canvas\] \.esri-view-root \{\n  height: 100%; min-height: 0;\n  display: grid; grid-template-rows: minmax\(0, 1fr\) auto;\n\}/)
  assert.match(MAP_THEME_CSS, /\[data-map-canvas\] \.esri-view-attribution \{\n  grid-row: 2;/)
  assert.match(MAP_THEME_CSS, /\[data-map-canvas\] \.esri-overlay-surface,\n\[data-map-canvas\] \.esri-ui \{[^}]*pointer-events: none;/)
  assert.match(MAP_THEME_CSS, /\[data-map-panel\]\[data-map-panel-surface="imagery"\] \{ bottom: 38px; \}/)
  assert.match(MAP_THEME_CSS, /\[data-map-overlay-content\] > \* \{ pointer-events: auto; \}/)
  assert.match(MAP_THEME_CSS, /\[data-map-panel\]\[data-map-panel-surface="unified"\] \{ top: 10px; left: 10px; right: auto; \}/)
  assert.match(MAP_THEME_CSS, /\[data-map-panel\] > \[data-map-panel-header\] \{ cursor: grab; user-select: none; touch-action: none; \}/)
  assert.match(MAP_THEME_CSS, /\[data-map-panel\]\[data-map-panel-collapsed\] > \[data-map-panel-header\] \{ border-bottom: 0; padding-bottom: 10px; \}/)
  assert.match(MAP_THEME_CSS, /\[data-map-panel\] > \[data-map-panel-body\] \{ flex: 0 1 auto; min-height: 0; overflow-y: auto;/)
  assert.match(MAP_THEME_CSS, /\[data-map-panel-section-body\] \[data-map-panel-search\],/)
  assert.doesNotMatch(MAP_THEME_CSS, /data-map-rail-panels/)
  assert.doesNotMatch(MAP_THEME_CSS, /data-map-panel-toggle/)
  assert.doesNotMatch(MAP_THEME_CSS, /data-map-panel-tabs/)
  assert.doesNotMatch(MAP_THEME_CSS, /\[data-map-panel\] > \[role="tabpanel"\]/)
  assert.match(MAP_THEME_CSS, /\[data-map-rail="wide"\] > \[data-map-workbench\] \{ left: 318px; \}/)
  assert.doesNotMatch(MAP_THEME_CSS, /data-map-imagery-tabs/)
  assert.doesNotMatch(MAP_THEME_CSS, /data-map-annotation-editor/)
  assert.doesNotMatch(MAP_THEME_CSS, /data-map-annotation-select/)
  assert.match(MAP_THEME_CSS, /\[data-map-imagery-row\] \{ display: contents; \}/)
  assert.match(MAP_THEME_CSS, /\[data-map-annotation-dialog\] \{ display: flex; flex-direction: column; gap: 8px; \}/)
  assert.match(MAP_THEME_CSS, /\[data-map-imagery-dialog\] \{ display: flex; flex-direction: column; gap: 8px; \}/)
  assert.match(MAP_THEME_CSS, /\[data-map-panel-annotations\] > \[data-map-panel-list\] \{ flex: 1 1 auto;/)
  assert.match(MAP_THEME_CSS, /position: absolute; top: 0; left: 0;/)
  assert.doesNotMatch(MAP_THEME_CSS, /top: 60px; left: 12px/)
  assert.doesNotMatch(MAP_THEME_CSS, /\[data-map-rail="wide"\] > \[data-map-feature-card\]/)
  assert.doesNotMatch(MAP_THEME_CSS, /\[data-map-feature-card\] \{\n    top: 50%; left: 50%; transform:/)
  assert.match(MAP_THEME_CSS, /\[data-map-panel-proposal-editor\] label, \[data-map-panel-change-editor\] label \{\n  display: flex; flex-direction: row; align-items: center; gap: 8px;\n\}/)
  assert.equal((MAP_THEME_CSS.match(/display: flex; flex-direction: row; align-items: center; gap: 8px;/g) ?? []).length, 1)
  assert.match(MAP_THEME_CSS, /\[data-map-workbench\] \{\n  position: absolute; left: 0; right: 0; bottom: 32px; z-index: 1;/)
  assert.match(MAP_THEME_CSS, /display: block;/)
  assert.match(MAP_THEME_CSS, /\[data-map-overlay-content\] > \[data-map-panel\] \{/)
  assert.match(MAP_THEME_CSS, /\[data-map-overlay-content\] > \[data-map-workbench\] \{\n    position: relative; order: -1; flex: 0 0 100%; left: auto; right: auto; bottom: auto;/)
  assert.match(MAP_THEME_CSS, /max-height: min\(32%, calc\(44% - 92px\)\); overflow-y: auto;/)
  assert.match(MAP_THEME_CSS, /\[data-map-overlay-content\] \{\n    display: flex; flex-flow: row wrap; justify-content: flex-end;/)
  assert.match(MAP_THEME_CSS, /align-content: flex-end;[\s\S]*padding: 10px 10px 32px;/)
  assert.doesNotMatch(MAP_THEME_CSS, /right: 142px/)
  assert.doesNotMatch(MAP_THEME_CSS, /inset: 38px 0 0/)
  assert.doesNotMatch(MAP_THEME_CSS, /grid-template-rows: repeat\(3, minmax\(0, 1fr\)\) minmax\(0, 32%\)/)
  assert.match(MAP_TOOL_CARD_CSS, /\[data-map-tool-card-row\]\[aria-expanded\]::after/)
  assert.match(MAP_TOOL_CARD_CSS, /\[data-map-session-action\] \{/)
})

test('fit-content: the resident card height adapts to its content', () => {
  const panelRule = MAP_THEME_CSS.match(/\[data-map-panel\] \{[^}]*\}/)?.[0] ?? ''
  assert.ok(panelRule.includes('max-height'), 'the card caps its height instead of pinning it')
  assert.doesNotMatch(panelRule, /(^|[;{\s])height:/, 'the card keeps no fixed height')
  assert.match(MAP_THEME_CSS, /\[data-map-panel\] > \[data-map-panel-body\] \{ flex: 0 1 auto; min-height: 0; overflow-y: auto;/,
    'one body shrinks to content and scrolls past the cap')
  assert.match(MAP_THEME_CSS, /\[data-map-panel-section-body\]\[hidden\] \{ display: none; \}/,
    'collapsed sections contribute no height')
  assert.match(MAP_THEME_CSS, /\[data-map-panel\]\[data-map-panel-collapsed\] > \[data-map-panel-header\] \{ border-bottom: 0;/,
    'the collapsed card is the title bar only')
  assert.match(MAP_THEME_CSS, /\[data-map-overlay-content\] > \[data-map-panel\] \{[\s\S]*?height: auto;/,
    'narrow containers keep the card content-hugging')
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
