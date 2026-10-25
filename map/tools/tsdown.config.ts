import { defineConfig } from 'tsdown'
import { typertPlugin } from '../../packages/typert/generator/lib/types/tsdown-plugin.js'

/** Two Node plugin entries: the compatible direct tools and MCP-backed map tools. */
export default defineConfig([
  {
    name: '@map-harness/map-tools',
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
    name: '@map-harness/map-tools/mcp',
    entry: { mcp: 'lib/types/mcp.js' },
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
