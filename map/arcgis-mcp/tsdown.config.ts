import { defineConfig } from 'tsdown'
import { typertPlugin } from '../../packages/typert/generator/lib/types/tsdown-plugin.js'

/** Node-only host provider; every value dependency is bundled beside the profile link. */
export default defineConfig({
  entry: ['lib/types/index.js'],
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
})
