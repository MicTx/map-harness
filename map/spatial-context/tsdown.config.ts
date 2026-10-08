import { defineConfig } from 'tsdown'
import { typertPlugin } from '../../packages/typert/generator/lib/types/tsdown-plugin.js'

/** Two Node plugin entries: the host projection/service face and the agent-plane pre-step listener. */
export default defineConfig([
  {
    name: '@map-harness/spatial-context',
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
  {
    name: '@map-harness/spatial-context/agent',
    entry: { agent: 'lib/types/agent.js' },
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
