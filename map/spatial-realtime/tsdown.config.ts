import { defineConfig } from 'tsdown'
import { typertPlugin } from '../../packages/typert/generator/lib/types/tsdown-plugin.js'

/** One Node library entry: the spatial-realtime contracts, runtime, and checkpoint plane. */
export default defineConfig([
  {
    name: '@map-harness/spatial-realtime',
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
])
