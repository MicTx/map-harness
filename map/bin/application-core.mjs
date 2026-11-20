/** Compile map Node implementations to V8 code; retain only interface facades and browser assets. */
import { createHash } from 'node:crypto'
import Module, { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import v8 from 'node:v8'
import { build } from 'tsdown'
import { isDependencyRuntimeSource, isDevelopmentFile } from './release-content.mjs'

const require = createRequire(new URL('../tools/package.json', import.meta.url))
const bytenode = require('bytenode')
const ts = require('typescript')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const FACADE_HEADER = '// Map application interface; implementation is compiled.\n'
const ONBOARDING_HEADER = FACADE_HEADER
/** Upstream ESM evaluated by the harness before plugin activation. */
const PRELOADED_ESM_PACKAGES = new Set(['@deepseek-ai/cordis'])

/**
 * Produce a loader containing public export bindings and no implementation body.
 * @param {string} binary - sibling bytecode filename.
 * @param {string[]} names - public module export names.
 * @returns {string} CommonJS facade with statically discoverable named exports.
 */
export function coreFacade(binary, names) {
  return FACADE_HEADER + "'use strict';\nrequire('bytenode');\nif(false){\n"
    + names.map(name => `exports[${JSON.stringify(name)}]=undefined;`).join('\n')
    + `\n}\nconst file=require('node:path').join(__dirname,${JSON.stringify(binary)});\n`
    + "require('bytenode').runBytecode(require('node:fs').readFileSync(file)).call(module.exports,module.exports,require,module,file,__dirname);\n"
}

/** Compile the internal launcher under the exact target runtime. */
export async function compileOnboarding(root, file, engine = process.execPath) {
  const temp = join(root, '.onboarding-compiler')
  mkdirSync(temp, { recursive: true })
  try {
    const result = await build({ config: false, tsconfig: false, inputOptions: { tsconfig: false, external: id => id !== file && !id.startsWith('\0') },
      entry: { onboarding: file }, outDir: temp, clean: false, format: 'cjs', platform: 'node', target: 'es2024', dts: false,
      shims: true, outputOptions: { entryFileNames: 'onboarding.cjs', dynamicImportInCjs: false }, logLevel: 'silent' })
    const code = join(temp, 'onboarding.cjs')
    const compile = spawnSync(engine, ['--eval', `const fs=require('node:fs'),Module=require('node:module'),bytenode=require(${JSON.stringify(require.resolve('bytenode'))});fs.writeFileSync(process.argv[1],bytenode.compileCode(Module.wrap(fs.readFileSync(process.argv[2],'utf8'))))`, join(root, 'web-onboarding.jsc'), code], { encoding: 'utf8' })
    if (compile.status !== 0) throw new Error(`Web onboarding compilation failed: ${compile.stderr}`)
    const bytes = readFileSync(join(root, 'web-onboarding.jsc'))
    const binary = join(root, 'web-onboarding.jsc')
    writeFileSync(binary, bytes)
    const loader = ONBOARDING_HEADER + "'use strict';\nrequire('bytenode');\n"
      + "const file=require('node:path').join(__dirname,'web-onboarding.jsc');\n"
      + "const worker={exports:{}};require('bytenode').runBytecode(require('node:fs').readFileSync(file)).call(worker.exports,worker.exports,require,worker,file,__dirname);\n"
      + 'module.exports=worker.exports;\n'
    const compiled = join(root, 'web-onboarding.cjs')
    writeFileSync(compiled, loader)
    rmSync(file, { force: true })
    for (const bundle of result) await bundle[Symbol.asyncDispose]()
    return { binary, compiled, loader }
  } finally { rmSync(temp, { recursive: true, force: true }) }
}

function replaceWorkerProgram(file, code, program) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const result = ts.transform(source, [context => node => {
    const visit = child => ts.isStringLiteralLike(child) && child.text === program
      ? ts.factory.createStringLiteral('Compiled worker is selected by the application runtime.')
      : ts.visitEachChild(child, visit, context)
    return ts.visitNode(node, visit)
  }])
  try { return ts.createPrinter().printFile(result.transformed[0]) } finally { result.dispose() }
}

function exportNames(file) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const names = new Set()
  for (const node of source.statements) {
    if (ts.isExportDeclaration(node)) {
      if (!node.exportClause) throw new Error(`Map compilation requires explicit exports: ${file}`)
      if (ts.isNamedExports(node.exportClause)) for (const item of node.exportClause.elements) names.add(item.name.text)
      else names.add(node.exportClause.name.text)
    } else if (ts.isExportAssignment(node)) names.add('default')
    else if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      if (node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) names.add('default')
      else if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name)) throw new Error(`Map export requires a named binding: ${file}`)
          names.add(declaration.name.text)
        }
      } else if (node.name) names.add(node.name.text)
    }
  }
  return [...names]
}

/**
 * Reject a compiled map facade that require()s an upstream ESM package. The
 * SEA loader can evaluate that require while the package is still importing.
 * @param {string} root - isolated deployed runtime root.
 * @param {string} file - source module being compiled.
 * @param {string} code - generated CommonJS core.
 */
function assertNoLateEsmRequires(root, file, code) {
  for (const match of code.matchAll(/(?:__)?require\(\s*["'](@deepseek-ai\/[^"']+)["']\s*\)/gu)) {
    const name = match[1].split('/').slice(0, 2).join('/')
    if (PRELOADED_ESM_PACKAGES.has(name)) continue
    const manifestPath = join(root, 'node_modules', name, 'package.json')
    if (!existsSync(manifestPath)) throw new Error(`Compiled map module ${file} requires missing package ${name}.`)
    if (JSON.parse(readFileSync(manifestPath, 'utf8')).type === 'module') {
      throw new Error(`Compiled map module ${file} requires ESM package ${name}; inline it to avoid a compiled-SEA loader race.`)
    }
  }
}

/**
 * Compile the deployed map package tree under the exact engine used by the application.
 * @param {string} root - isolated deployed runtime root.
 * @returns {Promise<object>} engine identity and binary integrity inventory.
 */
export async function compileApplicationCore(root) {
  const scope = join(root, 'node_modules/@map-harness')
  const entries = [], unused = []
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Application core must use materialized packages.')
    return entry.isDirectory() ? walk(path) : [path]
  })
  for (const entry of readdirSync(scope, { withFileTypes: true })) {
    if (!entry.isDirectory()) throw new Error('Application map packages must be materialized.')
    const dir = join(scope, entry.name)
    if (!existsSync(join(dir, 'lib'))) continue
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json')))
    const candidates = []
    for (const file of walk(join(dir, 'lib'))) {
      const local = relative(dir, file).replaceAll('\\', '/')
      const browser = manifest.dsh?.client && (local === 'lib/client.js' || local.startsWith('lib/assets/'))
      if (local.startsWith('lib/types/client/')) { rmSync(file); continue }
      if (!browser && file.endsWith('.js')) candidates.push(file)
    }
    const candidateSet = new Set(candidates), needed = new Set()
    const exportPaths = value => typeof value === 'string' ? [value]
      : value && typeof value === 'object' ? Object.values(value).flatMap(exportPaths) : []
    const pending = [manifest.main, ...exportPaths(manifest.exports)].filter(value => typeof value === 'string')
      .map(value => join(dir, value)).filter(file => candidateSet.has(file))
    while (pending.length) {
      const file = pending.pop()
      if (needed.has(file)) continue
      needed.add(file)
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      const visit = node => {
        const reference = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
          : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined
        if (reference && ts.isStringLiteralLike(reference) && reference.text.startsWith('.')) {
          const dependency = join(dirname(file), reference.text)
          if (candidateSet.has(dependency)) pending.push(dependency)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
    for (const file of candidates) {
      if (needed.has(file)) entries.push({ file, dir, manifest })
      else unused.push(file)
    }
  }
  const workerEntry = entries.find(({ dir, file }) => dir.replaceAll('\\', '/').endsWith('/spatial-scale') && exportNames(file).includes('SCALE_WORKER_ENTRY'))
  if (!workerEntry) throw new Error('The compiled application needs its fixed scale worker.')
  const worker = (await import(pathToFileURL(workerEntry.file).href)).SCALE_WORKER_ENTRY
  const namespace = new Map()
  for (const { file } of entries) namespace.set(file, exportNames(file))
  const notices = entries.flatMap(({ file }) => (readFileSync(file, 'utf8').match(/\/\*![\s\S]*?\*\//gu) ?? [])
    .map(notice => `${relative(root, file).replaceAll('\\', '/')}\n${notice}`))
  writeFileSync(join(root, 'MAP-BUNDLE-NOTICES.txt'), [...new Set(notices)].join('\n\n') + '\n')
  for (const file of unused) rmSync(file)
  const binaries = {}, facades = {}
  const workerFile = 'map-worker.jsc'
  const workerBytes = bytenode.compileCode(Module.wrap(worker))
  writeFileSync(join(root, workerFile), workerBytes)
  binaries[workerFile] = hash(workerBytes)
  const temp = join(root, '.core-compiler')
  mkdirSync(temp, { recursive: true })
  try {
    for (const { file } of entries) {
      const input = join(temp, 'input.mjs')
      writeFileSync(input, replaceWorkerProgram(file, readFileSync(file, 'utf8'), worker))
      const result = await build({ config: false, tsconfig: false, inputOptions: { tsconfig: false, external: id => id !== input && !id.startsWith('\0') && !id.startsWith('virtual:') },
        entry: { core: input }, outDir: temp, clean: false, format: 'cjs', platform: 'node', target: 'es2024', dts: false,
        shims: true, outputOptions: { entryFileNames: 'core.cjs', dynamicImportInCjs: false }, logLevel: 'silent' })
      const code = readFileSync(join(temp, 'core.cjs'), 'utf8')
      assertNoLateEsmRequires(root, file, code)
      const bytes = bytenode.compileCode(Module.wrap(code))
      const binary = file.replace(/\.js$/u, '.jsc')
      writeFileSync(binary, bytes)
      binaries[relative(root, binary).replaceAll('\\', '/')] = hash(bytes)
      const facade = coreFacade(relative(dirname(file), binary).replaceAll('\\', '/'), namespace.get(file))
      writeFileSync(file, facade)
      facades[relative(root, file).replaceAll('\\', '/')] = hash(facade)
      for (const bundle of result) await bundle[Symbol.asyncDispose]()
    }
    const dirs = new Set(entries.map(entry => entry.dir))
    for (const dir of dirs) {
      const path = join(dir, 'package.json'), manifest = JSON.parse(readFileSync(path))
      manifest.type = 'commonjs'
      writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
    }
  } finally { rmSync(temp, { recursive: true, force: true }) }
  return { format: 1, node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    cachedDataVersionTag: v8.cachedDataVersionTag(), binaries, facades, coreModules: entries.length }
}

/**
 * Reject any map implementation JS left behind after compilation.
 * @param {string} root - deployed runtime root.
 * @param {object} manifest - compiler inventory of allowed binary loaders.
 */
export function auditApplicationCore(root, manifest) {
  const scope = join(root, 'node_modules/@map-harness')
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error('Application packages must not contain links.')
      if (entry.isDirectory()) { walk(file); continue }
      const mapFile = file.replaceAll('\\', '/').includes('/node_modules/@map-harness/')
      if (!mapFile) continue
      if (/\.(?:map|[cm]?tsx?|jsx)$/u.test(file) || /(?:^|\/)src\//u.test(relative(root, file).replaceAll('\\', '/'))) {
        throw new Error('Application contains map development source.')
      }
      if (!/\.[cm]?js$/u.test(file)) continue
      const path = relative(scope, file).replaceAll('\\', '/')
      const packageName = path.split('/')[0]
      if (path.startsWith('..')) throw new Error('Nested map package copies cannot be released.')
      const pkg = JSON.parse(readFileSync(join(scope, packageName, 'package.json')))
      if (pkg.dsh?.client && /^[^/]+\/lib\/(?:client\.js|assets\/)/u.test(path)) continue
      const relativePath = relative(root, file).replaceAll('\\', '/')
      if (!readFileSync(file, 'utf8').startsWith(FACADE_HEADER)
        || !manifest?.facades[relativePath] || hash(readFileSync(file)) !== manifest.facades[relativePath]) {
        throw new Error(`Editable map implementation remains: ${path}`)
      }
    }
  }
  walk(root)
}

/**
 * Audit the logical SEA inventory before it is embedded in the native executable.
 * @param {string} root - deployed runtime root before sealing.
 * @param {string[]} files - complete staged inventory.
 * @param {object} manifest - compiler inventory of map bytecode and facades.
 * @throws If the embedding plan contains development source or an unregistered map loader.
 */
export function auditApplicationSeal(root, files, manifest) {
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/')
    if (isDevelopmentFile(normalized) && !isDependencyRuntimeSource(normalized)) {
      throw new Error(`Application seal contains development source: ${normalized}`)
    }
    if (normalized.startsWith('node_modules/@map-harness/') && /\.[cm]?js$/u.test(normalized)) {
      const [, , packageName, ...rest] = normalized.split('/')
      const pkgPath = join(root, 'node_modules', '@map-harness', packageName, 'package.json')
      const pkg = existsSync(pkgPath) ? JSON.parse(readFileSync(pkgPath)) : {}
      const local = rest.join('/')
      const browser = pkg.dsh?.client && (local === 'lib/client.js' || local.startsWith('lib/assets/'))
      if (!browser && !manifest?.facades?.[normalized]) throw new Error(`Application seal contains an unregistered map loader: ${normalized}`)
    }
  }
  for (const facade of Object.keys(manifest?.facades ?? {})) {
    const bytes = readFileSync(join(root, facade))
    if (!bytes.toString('utf8').startsWith(FACADE_HEADER) || hash(bytes) !== manifest.facades[facade]) {
      throw new Error(`Application seal contains an editable map loader: ${facade}`)
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  const root = process.argv[2]
  const manifest = await compileApplicationCore(root)
  auditApplicationCore(root, manifest)
  writeFileSync(join(root, 'map-application.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Compiled ${manifest.coreModules} map core modules for ${manifest.node}/${manifest.arch}`)
}
