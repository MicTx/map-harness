import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mapRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const docPath = join(mapRoot, 'docs', 'directory-layout.md')
const doc = readFileSync(docPath, 'utf8')

function sourceFiles(dir, extension) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(path, extension))
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(path)
  }
  return files
}

function productFiles() {
  const files = []
  for (const entry of readdirSync(join(mapRoot, 'bin'), { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.spec.mjs')) files.push(join(mapRoot, 'bin', entry.name))
  }
  for (const pkg of readdirSync(mapRoot, { withFileTypes: true })) {
    if (!pkg.isDirectory() || pkg.name === 'node_modules' || pkg.name === 'docs' || pkg.name === 'tests') continue
    const bin = join(mapRoot, pkg.name, 'bin')
    if (!statSync(bin, { throwIfNoEntry: false })?.isDirectory()) continue
    for (const entry of readdirSync(bin, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.mjs') && !entry.name.endsWith('.spec.mjs')) files.push(join(bin, entry.name))
    }
  }
  return files
}

function registeredHomeSegments(text) {
  return new Set([...text.matchAll(/^\| home \| `([a-z0-9-]+)\/`\s*\|/gm)].map(match => match[1]))
}

function profileHomeSegments(text) {
  return new Set([...text.matchAll(/dshHomePath\('([a-z0-9-]+)'\)/g)].map(match => match[1]))
}

function assertHomeSegments(documentText, profileText) {
  const registered = registeredHomeSegments(documentText)
  const used = profileHomeSegments(profileText)
  assert.deepEqual([...used].sort(), [...registered].sort(), 'home segments and the profile dshHomePath registry must match in both directions')
}

function temporaryPrefixes(files) {
  const prefixes = new Set()
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/mkdtempSync\(join\(tmpdir\(\),\s*(['"`])([^'"`]+)\1/g)) prefixes.add(match[2].replace(/-$/u, ''))
  }
  return prefixes
}

function registeredTemporaryPrefixes(text) {
  return new Set([...text.matchAll(/^\| temp \| `([a-z0-9-]+)`\s*\|/gm)].map(match => match[1]))
}

function assertTemporaryPrefixes(actual, registered) {
  const unregistered = [...actual].filter(prefix => !registered.has(prefix))
  const missing = [...registered].filter(prefix => !actual.has(prefix))
  assert.deepEqual(unregistered, [], 'temporary prefixes must be registered in directory-layout.md')
  assert.deepEqual(missing, [], 'registered temporary prefixes must exist in product sources')
  assert.deepEqual([...actual].filter(prefix => !prefix.startsWith('map-')), [], 'map temporary prefixes must start with map-')
}

function callExpressions(text, name) {
  const calls = []
  for (let at = text.indexOf(`${name}(`); at !== -1; at = text.indexOf(`${name}(`, at + name.length)) {
    const open = at + name.length
    let depth = 0
    let quote
    let end = open
    for (; end < text.length; end++) {
      const char = text[end]
      if (quote !== undefined) {
        if (char === '\\') end++
        else if (char === quote) quote = undefined
        continue
      }
      if (char === '"' || char === "'" || char === '`') quote = char
      else if (char === '(') depth++
      else if (char === ')') {
        depth--
        if (depth === 0) break
      }
    }
    if (end === text.length) throw new Error(`unclosed call to ${name} at offset ${at}`)
    calls.push({ text: text.slice(open + 1, end), offset: at })
    at = end
  }
  return calls
}

function assertStorageDirectories(files) {
  const violations = []
  for (const file of files) {
    const path = typeof file === 'string' ? relative(mapRoot, file) : 'sample.ts'
    const text = typeof file === 'string' ? readFileSync(file, 'utf8') : file.text
    for (const call of callExpressions(text, 'mkdirSync')) {
      if (!call.text.includes('recursive: true') || !call.text.includes('mode: 0o700')) {
        violations.push(`${path}:${text.slice(0, call.offset).split('\n').length}`)
      }
    }
  }
  assert.deepEqual(violations, [], 'storage directories must be created recursively with owner-only mode')
}

function assertNoEnvironmentHomeInPlugins(files) {
  const violations = []
  for (const file of files) {
    const path = typeof file === 'string' ? relative(mapRoot, file) : 'sample.ts'
    const text = typeof file === 'string' ? readFileSync(file, 'utf8') : file.text
    if (/\bprocess\.env\.(?:MAPHARNESS_HOME|DSH_HOME)\b/u.test(text)) violations.push(path)
  }
  assert.deepEqual(violations, [], 'plugin source must receive roots through validated Config, not environment variables')
}

test('registered home roots match the profile registry', () => {
  assertHomeSegments(doc, readFileSync(join(mapRoot, 'profiles', 'map-web', 'cordis.patch.yml'), 'utf8'))
})

test('product temporary directories use registered map- prefixes', () => {
  assertTemporaryPrefixes(temporaryPrefixes(productFiles()), registeredTemporaryPrefixes(doc))
})

test('storage package directories are owner-only', () => {
  const packages = ['spatial-accessibility', 'spatial-catalog', 'spatial-scale', 'spatial-storage']
  assertStorageDirectories(packages.flatMap(pkg => sourceFiles(join(mapRoot, pkg, 'src'), '.ts')))
})

test('plugin source does not resolve the environment home root', () => {
  const packages = readdirSync(mapRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
    .map(entry => join(mapRoot, entry.name, 'src'))
    .filter(path => statSync(path, { throwIfNoEntry: false })?.isDirectory())
  assertNoEnvironmentHomeInPlugins(packages.flatMap(path => sourceFiles(path, '.ts')))
})

test('directory-layout gate is wired into aggregate, matrix, and engineering docs', () => {
  assert.match(readFileSync(join(mapRoot, 'bin', 'test.mjs'), 'utf8'), /directory-layout\.spec\.mjs/u)
  assert.match(readFileSync(join(mapRoot, 'docs', 'verification-matrix.md'), 'utf8'), /`map\/tests\/directory-layout\.spec\.mjs`/u)
  assert.match(readFileSync(join(mapRoot, 'docs', 'engineering.md'), 'utf8'), /\[目录与路径规范\]\(directory-layout\.md\)/u)
  assert.match(readFileSync(join(mapRoot, 'docs', 'storage-lifecycle.md'), 'utf8'), /\[目录与路径规范\]\(directory-layout\.md\)/u)
})

test('layout validators reject each documented violation class', () => {
  const homeDoc = '# doc\n\n| home | `other-store/` | owner | use |\n'
  assert.throws(() => assertHomeSegments(homeDoc, "root: dshHomePath('spatial-store')"), /must match in both directions/u)
  assert.throws(() => assertTemporaryPrefixes(new Set(['spatial-store']), new Set(['spatial-store'])), /must start with map-/u)
  assert.throws(() => assertTemporaryPrefixes(new Set(['map-new']), new Set()), /must be registered/u)
  assert.throws(() => assertStorageDirectories([{ text: "mkdirSync(join(root, 'x'), { recursive: true })" }]), /owner-only mode/u)
  assert.throws(() => assertNoEnvironmentHomeInPlugins([{ text: 'process.env.DSH_HOME' }]), /validated Config/u)
})
