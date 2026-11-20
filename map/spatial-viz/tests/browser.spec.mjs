/** The browser entry exposes display functions without importing host computations. */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import * as browser from '../src/browser.ts'
import * as host from '../src/index.ts'

const root = fileURLToPath(new URL('../src/', import.meta.url))
const expected = [
  'MAX_ATTRIBUTE_ROWS', 'TimelineError', 'attributeRowsOf', 'axisAdvance', 'axisGoto',
  'axisPause', 'axisPlay', 'axisStep', 'classifyValue', 'createTimeAxis', 'currentFrame',
  'dataRefOf', 'exportManifestOf', 'featureIdOf', 'filterRevisionOf', 'formatFrameLabel',
  'framesOf', 'histogramOf', 'isHexColor', 'legendOf', 'measureValueOf', 'selectFeatureIds',
  'selectionFilterOf', 'sizeForClass', 'vizDigestOf',
].sort()

function valueDependencies(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const dependencies = []
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      if (clause?.isTypeOnly) return
      if (clause?.name === undefined && clause?.namedBindings && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(element => element.isTypeOnly)) return
    } else if (ts.isExportDeclaration(node)) {
      if (node.isTypeOnly) return
      if (node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every(element => element.isTypeOnly)) return
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      assert.ok(node.arguments[0] && ts.isStringLiteral(node.arguments[0]), 'browser runtime imports must be static')
      dependencies.push(node.arguments[0].text)
    }
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      dependencies.push(node.moduleSpecifier.text)
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return dependencies
}

function browserModules(overrides = new Map()) {
  const visited = new Set()
  const visit = file => {
    if (visited.has(file)) return
    visited.add(file)
    const source = overrides.get(file) ?? readFileSync(file, 'utf8')
    for (const specifier of valueDependencies(file, source)) {
      assert.ok(specifier.startsWith('./'), `browser entry imports external runtime module ${specifier}`)
      const dependency = resolve(dirname(file), specifier)
      assert.ok(dependency.startsWith(root), `browser runtime import leaves its package: ${specifier}`)
      visit(dependency)
    }
  }
  visit(join(root, 'browser.ts'))
  const hostModules = ['index.ts', 'classify.ts', 'aggregate.ts', 'stream.ts', 'profile.ts', 'routing.ts', 'catalog.ts', 'schema.ts']
  for (const file of hostModules) assert.ok(!visited.has(join(root, file)), `browser entry imports host computation ${file}`)
  return visited
}

test('browser exports preserve the display functions available from the host entry', () => {
  assert.deepEqual(Object.keys(browser).sort(), expected)
  for (const name of expected) assert.equal(browser[name], host[name], name)
  for (const name of ['computeBreaks', 'buildStyle', 'unifyDomains', 'createGridAggregator', 'routeVisualization']) {
    assert.equal(typeof host[name], 'function', name)
    assert.ok(!(name in browser), name)
  }
})

test('browser runtime graph excludes host classification, aggregation, scanning, and routing', () => {
  const modules = browserModules()
  assert.ok(modules.has(join(root, 'display.ts')))
  assert.ok(modules.has(join(root, 'linked.ts')))
  const linked = join(root, 'linked.ts')
  const changed = readFileSync(linked, 'utf8').replace("from './display.ts'", "from './classify.ts'")
  assert.throws(() => browserModules(new Map([[linked, changed]])), /host computation classify\.ts/u)
  const entry = join(root, 'browser.ts')
  const entryText = readFileSync(entry, 'utf8')
  for (const statement of ["import {} from './classify.ts'", "export const loadCore = () => import('./classify.ts')"]) {
    assert.throws(() => browserModules(new Map([[entry, `${statement}\n${entryText}`]])), /host computation classify\.ts/u)
  }
})

test('map browser clients and layer presentation helpers use the browser entry', () => {
  const directories = [join(root, '../../map-container/src/client'), join(root, '../../layers/src')]
  for (const directory of directories) {
    for (const entry of readdirSync(directory)) {
      if (!/\.tsx?$/u.test(entry)) continue
      const file = join(directory, entry)
      const imports = valueDependencies(file, readFileSync(file, 'utf8'))
      assert.ok(!imports.includes('@map-harness/spatial-viz'), `${file} imports the host entry`)
    }
  }
})
