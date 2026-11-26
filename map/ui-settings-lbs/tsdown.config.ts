import { defineConfig } from 'tsdown'
import { mapCssModules } from '../bin/map-css-modules.ts'
import { mapBrowserDefines } from '../bin/browser-defines.ts'

/** Plugin id stamped into the browser loader handoff — must equal the package name. */
const ID = '@map-harness/ui-settings-lbs'

/** Injected loader module-table rows stay external. */
const REQUESTED = new Set([
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-api-remotes',
  '@deepseek-ai/dsh-client-ui-primitives',
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'clsx',
])

export default defineConfig([
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
    plugins: [mapCssModules(ID)],
    outputOptions: {
      entryFileNames: 'client.js',
      chunkFileNames: 'client.[name].js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
    define: mapBrowserDefines(process.env),
  },
])
