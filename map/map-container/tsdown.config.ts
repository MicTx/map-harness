import { defineConfig } from 'tsdown'

/** Plugin id stamped into the browser loader handoff — must equal the package name. */
const ID = '@map-harness/map-container'

/** Injected loader module-table rows stay external. */
const REQUESTED = new Set([
  '@deepseek-ai/dsh-client-ui-sidebar-right',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-locale',
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
      alwaysBundle: (specifier: string) =>
        specifier === 'zod' || specifier === '@map-harness/spatial-viz' || specifier.startsWith('@deepseek-ai/'),
      neverBundle: (specifier: string) => specifier === '@deepseek-ai/cordis',
    },
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
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
  },
])
