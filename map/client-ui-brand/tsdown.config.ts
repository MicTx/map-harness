import { defineConfig } from 'tsdown'

/** Plugin id stamped into the browser loader handoff — must equal the package name. */
const ID = '@map-harness/client-ui-brand'

/**
 * The two specifiers this package's `dsh.client.inject` requests stay external
 * (resolved through the loader module table in the browser); everything else
 * inlines.
 */
const REQUESTED = new Set([
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-sidebar',
])

export default defineConfig([
  // Node half: the no-op host plugin body.
  {
    name: ID,
    entry: ['lib/types/index.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  // Browser half: the closure-factory artifact the client module system loads.
  {
    name: `${ID}/client`,
    entry: { client: 'lib/types/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => REQUESTED.has(specifier),
      alwaysBundle: (specifier: string) => !REQUESTED.has(specifier),
    },
    inputOptions: {
      resolve: {
        conditionNames: ['production', 'browser', 'import', 'module', 'default'],
      },
    },
    outputOptions: {
      entryFileNames: 'client.js',
      chunkFileNames: 'client.[name].js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
  },
])
