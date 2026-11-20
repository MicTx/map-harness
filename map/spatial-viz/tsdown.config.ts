import { defineConfig } from 'tsdown'
import { typertPlugin } from '../../packages/typert/generator/lib/types/tsdown-plugin.js'

/** Separate host computation and browser display entries. */
export default defineConfig([
  {
    name: '@map-harness/spatial-viz',
    entry: { index: 'lib/types/index.js' },
    deps: {
      alwaysBundle: () => true,
      neverBundle: () => false,
    },
    plugins: [typertPlugin({ mode: 'package', faces: ['host'] })],
    outDir: 'lib',
    clean: false,
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
  },
  {
    name: '@map-harness/spatial-viz/browser',
    entry: { browser: 'lib/types/browser.js' },
    deps: {
      alwaysBundle: () => true,
      neverBundle: () => false,
    },
    outDir: 'lib',
    clean: false,
    format: ['esm'],
    platform: 'neutral',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
  },
])
