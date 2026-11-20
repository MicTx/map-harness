/**
 * Mount contract: the control groups live on the map instance's overlay, keep
 * the overlay's pointer-transparent sweep from creating a dead hit-test zone,
 * and leave the existing coarse-pointer touch targets intact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { MAPBOX_CTRL_CSS, MAP_THEME_CSS } from '../src/client/map-theme.ts'

const source = readFileSync(new URL('../src/client/MapTabBody.tsx', import.meta.url), 'utf8')

test('MapTabBody mounts MapboxControls under the map overlay content', () => {
  assert.match(source, /import \{ MapboxControls \} from '\.\/mapbox-controls\.tsx'/)
  assert.match(source, /data-map-overlay-content=""[\s\S]*?<MapboxControls occurrence=\{occurrenceOf\} t=\{t\} \/>[\s\S]*?<\/div>/)
  assert.match(source, /data-map-container=""/)
})

test('the controls wrapper stays pointer-transparent while controls stay clickable', () => {
  assert.match(MAP_THEME_CSS, /\[data-map-overlay-content\] > \* \{ pointer-events: auto; \}/)
  assert.match(MAPBOX_CTRL_CSS, /\[data-mapbox-controls\] \{ position: absolute; inset: 0; pointer-events: none; z-index: 2; \}/)
  assert.match(MAPBOX_CTRL_CSS, /\[data-map-overlay-content\] > \[data-mapbox-controls\] \{ pointer-events: none; \}/)
  assert.match(MAPBOX_CTRL_CSS, /\[data-mapbox-ctrl\] \{ clear: both; pointer-events: auto; \}/)
  const overrideAt = MAPBOX_CTRL_CSS.indexOf('[data-map-overlay-content] > [data-mapbox-controls]')
  const groupAt = MAPBOX_CTRL_CSS.indexOf('[data-mapbox-ctrl-group]')
  assert.ok(overrideAt >= 0 && groupAt > overrideAt)
})

test('the existing 390px coarse-pointer touch rule survives', () => {
  assert.match(MAP_THEME_CSS, /@media \(pointer: coarse\) \{ \[data-map-container\] \[data-map-panel\]\[data-map-panel-surface\] button \{ min-height: 44px; min-width: 44px; \} \}/)
})
