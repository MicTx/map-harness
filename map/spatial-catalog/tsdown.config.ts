import { defineConfig } from 'tsdown'
import { typertPlugin } from '../../packages/typert/generator/lib/types/tsdown-plugin.js'

/** One Node plugin entry: the spatial-catalog host service and projection. */
export default defineConfig([
  {
    name: '@map-harness/spatial-catalog',
    entry: { index: 'lib/types/index.js' },
    deps: {
      alwaysBundle: (specifier: string) => specifier !== '@deepseek-ai/cordis',
      neverBundle: (specifier: string) => specifier === '@deepseek-ai/cordis',
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
