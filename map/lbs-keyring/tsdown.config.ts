import { defineConfig } from 'tsdown'

/** Node host entry: the keyring service. The pure contract ships as a second entry. */
export default defineConfig([
  {
    name: '@map-harness/lbs-keyring',
    entry: { index: 'lib/types/index.js', contract: 'lib/types/contract.js', policy: 'lib/types/policy.js' },
    deps: {
      alwaysBundle: (specifier: string) => specifier !== '@deepseek-ai/cordis',
      neverBundle: (specifier: string) => specifier === '@deepseek-ai/cordis',
    },
    outDir: 'lib',
    clean: false,
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
  },
])
