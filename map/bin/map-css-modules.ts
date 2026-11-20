/**
 * CSS Modules compilation for the map layer's browser bundles: the same
 * mechanism `packages/client/tsdown.client.ts` gives its own plugin packages —
 * a real `*.module.css` file compiles through lightningcss into a hashed class
 * map plus a build-time-inlined stylesheet that installs one
 * `<style data-plugin-css>` tag per document at bundle load.
 *
 * Map plugin bundles differ from the packages/client ones in two ways this
 * helper absorbs: they enter from emitted `lib/types/` JavaScript, so a CSS
 * import id must be mapped back to its `src/` physical file, and they carry a
 * custom loader banner/footer instead of the clientBundle preset.
 *
 * @module map/bin/map-css-modules
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import type { TsdownPlugin } from 'tsdown'
import { transform } from 'lightningcss'

/** Virtual-id prefix keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0map-css:'
/** Virtual-id suffix; tsdown's css guard matches ids ending in `.css`. */
const CSS_VIRTUAL_SUFFIX = '.mjs'
/** Path segment identifying an emitted types module. */
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

/**
 * Resolve one stylesheet import to its physical file.
 *
 * An import seen from an emitted `lib/types/` module names the mirrored
 * `src/` location (tsc emits JavaScript only); anything else resolves
 * relative to its importer.
 * @param source - import specifier as written.
 * @param importer - absolute id of the importing module, when known.
 * @returns the physical stylesheet path.
 */
function moduleAssetPath(source: string, importer: string | undefined): string {
  if (importer === undefined || (source.startsWith('/') || isAbsolute(source))) return source
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const boundary = emitted.indexOf(TYPES_MARKER)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + TYPES_MARKER.length))
}

/**
 * Emit the style-injector module for one stylesheet.
 * @param id - owning plugin id, stamped into the injected tag.
 * @param fileId - physical stylesheet path.
 * @param css - JavaScript expression yielding the stylesheet text.
 * @param classMap - hashed class names keyed by their local name.
 * @returns the module source installing the tag and exporting the map.
 */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const tagId = `${id}/${basename(fileId)}`
  return [
    `const css = ${css};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/**
 * Create the CSS Modules plugin for one map browser bundle.
 *
 * Every `.module.css` import resolves to a virtual id; loading it transforms
 * the physical stylesheet with lightningcss (`[hash]_[local]` class names,
 * minified) and returns a module that installs the stylesheet once per
 * document and default-exports the hashed class map.
 * @param id - owning plugin id, used for the injected tag and diagnostics.
 * @returns the tsdown plugin.
 */
export function mapCssModules(id: string): TsdownPlugin {
  return {
    name: 'map-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      // The virtual id lands in emitted region comments and sourcemap sources,
      // so it must stay checkout-relative even though `load` resolves the
      // physical file through the absolute path below.
      const physical = moduleAssetPath(source, importer)
      const relativePhysical = relative(process.cwd(), physical)
      return CSS_VIRTUAL_PREFIX + (relativePhysical.startsWith('..') ? physical : relativePhysical) + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      let fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      if (!isAbsolute(fileId)) fileId = resolvePath(process.cwd(), fileId)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '_lbs-[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      const entries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exported] of entries) classMap[local] = exported.name
      // The virtual id embeds the absolute stylesheet path; hand rolldown a
      // checkout-relative id so emitted region comments and sourcemap sources
      // stay portable and never carry the checkout location.
      const relativeFileId = relative(process.cwd(), fileId)
      return styleInjectionModule(id, relativeFileId, JSON.stringify(code.toString()), classMap)
    },
  }
}
