import { defineConfig } from 'tsdown'
import { typertPlugin } from '../../packages/typert/generator/lib/types/tsdown-plugin.js'

/** One Node plugin entry: the stream-providers contract, readers, fusion, and the host service. */
export default defineConfig([
  {
    name: '@map-harness/stream-providers',
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
