import { defineConfig } from 'tsdown'
import { mapBrowserDefines } from '../bin/browser-defines.ts'

/** Plugin id stamped into the browser loader handoff — must equal the package name. */
const ID = '@map-harness/map-container'

/** Injected loader module-table rows stay external. */
const REQUESTED = new Set([
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-tool',
  '@deepseek-ai/dsh-client-ui-primitives',
  // Platform module rows: the single React copy lives in the UI tree.
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'clsx',
])

/**
 * Platform module rows (the UI tree's single React copy) match by resolved
 * path: deps hooks receive the absolute module id, so bare-specifier matching
 * alone would inline a second React and split the hooks dispatcher.
 */
export default defineConfig([
  // Node half: `ctx.map` service plugin; value deps inline (single-file lib).
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
    deps: {
      // These upstream modules are duplicate-install-safe value primitives and
      // are inlined here: a compiled SEA facade must not require() a
      // late-loading ESM module concurrently with the loader graph.
      alwaysBundle: (specifier: string) =>
        specifier === 'zod' || specifier === '@map-harness/spatial-viz'
        || specifier === '@deepseek-ai/dsh-brand' || specifier === '@deepseek-ai/dsh-util-values'
        || specifier === '@deepseek-ai/dsh-session/types' || specifier === '@deepseek-ai/dsh-credentials',
      neverBundle: (specifier: string) =>
        specifier.startsWith('@deepseek-ai/')
        && !['@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-util-values', '@deepseek-ai/dsh-session/types',
          '@deepseek-ai/dsh-credentials'].includes(specifier),
    },
  },
  {
    name: `${ID}/wayback-worker`,
    entry: { 'wayback-worker': 'lib/types/wayback-worker.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: { neverBundle: () => true },
  },
  // Browser half: closure-factory artifact; ArcGIS inlines lazily, React and
  // the three injected services stay loader-table externals.
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
      resolve: { conditionNames: ['production', 'browser', 'import', 'module', 'default'] },
    },
    outputOptions: {
      inlineDynamicImports: true,
      entryFileNames: 'client.js',
      chunkFileNames: 'client.[name].js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
    define: mapBrowserDefines(process.env),
  },
])
